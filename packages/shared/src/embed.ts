/**
 * A7: a small, deterministic text embedding, so precedent search works offline and in tests
 * with no embedding API. Feature hashing of words and word pairs into 256 signed buckets,
 * L2-normalised; cosine similarity then ranks texts by shared vocabulary. It is a stand-in:
 * swapping in a hosted embedding model changes only this file and the index dimension.
 */
import type { Db, Document } from 'mongodb';
import { COLLECTIONS } from './collections.js';
import type { PrecedentDoc } from './types.js';

export const EMBEDDING_DIMENSIONS = 256;
export const VECTOR_INDEX = 'precedents_vector';

const STOP = new Set('a an and are as at be but by for from has have i in is it its my of on or so that the this to was we were with you your me our please'.split(' '));

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function embed(text: string): number[] {
  const words = text.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => !STOP.has(w) && w.length > 1) ?? [];
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const add = (feature: string, weight: number) => {
    const h = fnv1a(feature);
    v[h % EMBEDDING_DIMENSIONS]! += (h & 0x80000000 ? -1 : 1) * weight;
  };
  words.forEach((w, i) => {
    add(w, 1);
    if (w.length > 5) add(w.slice(0, 5), 0.5); // crude stemming: "refunded" ~ "refund"
    if (i > 0) add(`${words[i - 1]} ${w}`, 0.7);
  });
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => Math.round((x / norm) * 1e6) / 1e6);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * (b[i] ?? 0);
  return dot; // both are unit vectors
}

/** The text a precedent is embedded from. */
export const precedentText = (p: Pick<PrecedentDoc, 'category' | 'summary' | 'rationale'>) => `${p.category} ${p.summary} ${p.rationale}`;

/**
 * Creates the Atlas Vector Search index on precedents, if the server supports search indexes
 * (Atlas, or the mongodb-atlas-local image). Admin connection.
 */
export async function ensureVectorIndex(db: Db): Promise<'created' | 'exists' | 'unavailable'> {
  const coll = db.collection(COLLECTIONS.precedents);
  try {
    const existing = await coll.listSearchIndexes(VECTOR_INDEX).toArray();
    if (existing.length) return 'exists';
    await coll.createSearchIndex({
      name: VECTOR_INDEX,
      type: 'vectorSearch',
      definition: { fields: [{ type: 'vector', path: 'embedding', numDimensions: EMBEDDING_DIMENSIONS, similarity: 'cosine' }] },
    });
    return 'created';
  } catch {
    return 'unavailable';
  }
}

export interface PrecedentHit {
  precedent_id: string;
  category: string;
  summary: string;
  outcome: PrecedentDoc['outcome'];
  refund_cents: number;
  rationale: string;
  score: number;
}

/**
 * The closest past disputes to `query`. Uses Atlas Vector Search ($vectorSearch) when the index
 * is available, otherwise the same cosine ranking computed here. Needs `find` on precedents.
 */
export async function searchPrecedents(
  db: Db,
  query: string,
  limit = 3,
): Promise<{ method: 'atlas_vector_search' | 'local_cosine'; hits: PrecedentHit[] }> {
  const coll = db.collection<PrecedentDoc>(COLLECTIONS.precedents);
  const queryVector = embed(query);
  const shape = (d: Document, score: number): PrecedentHit => ({
    precedent_id: d['_id'],
    category: d['category'],
    summary: d['summary'],
    outcome: d['outcome'],
    refund_cents: d['refund_cents'],
    rationale: d['rationale'],
    score: Math.round(score * 1000) / 1000,
  });
  try {
    const rows = await coll
      .aggregate([
        { $vectorSearch: { index: VECTOR_INDEX, path: 'embedding', queryVector, numCandidates: 100, limit } },
        { $project: { embedding: 0, score: { $meta: 'vectorSearchScore' } } },
      ])
      .toArray();
    if (rows.length) return { method: 'atlas_vector_search', hits: rows.map((r) => shape(r, r['score'] as number)) };
  } catch {
    // No search index on this server (e.g. the in-memory test server): rank locally.
  }
  const all = await coll.find().toArray();
  const ranked = all
    .map((d) => ({ d, score: cosine(queryVector, d.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { method: 'local_cosine', hits: ranked.map(({ d, score }) => shape(d, score)) };
}
