/**
 * A7: precedent memory. Past resolved disputes are embedded and searched with Atlas Vector Search.
 *
 * Embeddings come from Voyage AI when VOYAGE_API_KEY is set (model VOYAGE_MODEL, default
 * voyage-3.5, at VOYAGE_DIMENSIONS, default 1024). Without a key (tests, offline demo) a small
 * deterministic local embedding is used instead: feature hashing of words and word pairs into
 * 256 signed buckets, L2-normalised. The vector index dimension follows whichever is active
 * (`embeddingConfig()`), and `ensureVectorIndex` updates the index when it changes.
 */
import type { Db, Document } from 'mongodb';
import { COLLECTIONS } from './collections.js';
import type { PrecedentDoc } from './types.js';

/** Dimension of the local fallback embedding. */
export const EMBEDDING_DIMENSIONS = 256;
export const VECTOR_INDEX = 'precedents_vector';

export type EmbeddingProvider = 'voyage' | 'local';

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  /** e.g. "voyage-3.5" or "local-hash-256". Stored on each precedent so mixed vectors are detectable. */
  model: string;
  dimensions: number;
  apiKey?: string;
}

/**
 * Which embedding is active. Voyage when VOYAGE_API_KEY is set and EMBEDDING_PROVIDER is not
 * "local"; otherwise the local hash embedding.
 */
export function embeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  const apiKey = env['VOYAGE_API_KEY']?.trim();
  if (apiKey && env['EMBEDDING_PROVIDER'] !== 'local') {
    const dimensions = Number(env['VOYAGE_DIMENSIONS'] ?? 1024);
    if (![256, 512, 1024, 2048].includes(dimensions)) throw new Error(`VOYAGE_DIMENSIONS must be 256, 512, 1024 or 2048, got ${dimensions}`);
    return { provider: 'voyage', model: env['VOYAGE_MODEL']?.trim() || 'voyage-3.5', dimensions, apiKey };
  }
  return { provider: 'local', model: `local-hash-${EMBEDDING_DIMENSIONS}`, dimensions: EMBEDDING_DIMENSIONS };
}

const STOP = new Set('a an and are as at be but by for from has have i in is it its my of on or so that the this to was we were with you your me our please'.split(' '));

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The local, deterministic embedding (no network). */
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

/**
 * Embeds texts with the active provider. `inputType` is Voyage's retrieval hint: "document" for
 * what is stored, "query" for what is searched with.
 */
export async function embedTexts(
  texts: string[],
  inputType: 'document' | 'query',
  cfg: EmbeddingConfig = embeddingConfig(),
): Promise<number[][]> {
  if (cfg.provider === 'local' || texts.length === 0) return texts.map(embed);
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ input: texts, model: cfg.model, input_type: inputType, output_dimension: cfg.dimensions }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Voyage embeddings failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> };
  return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * (b[i] ?? 0);
    na += a[i]! * a[i]!;
    nb += (b[i] ?? 0) * (b[i] ?? 0);
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** The text a precedent is embedded from. */
export const precedentText = (p: Pick<PrecedentDoc, 'category' | 'summary' | 'rationale'>) => `${p.category} ${p.summary} ${p.rationale}`;

function vectorIndexDefinition(dimensions: number): Document {
  return { fields: [{ type: 'vector', path: 'embedding', numDimensions: dimensions, similarity: 'cosine' }] };
}

/**
 * Creates (or, when the embedding dimension changed, updates) the Atlas Vector Search index on
 * precedents, if the server supports search indexes (Atlas, or mongodb-atlas-local). Admin connection.
 */
export async function ensureVectorIndex(
  db: Db,
  dimensions: number = embeddingConfig().dimensions,
): Promise<'created' | 'updated' | 'exists' | 'unavailable'> {
  const coll = db.collection(COLLECTIONS.precedents);
  try {
    const existing = await coll.listSearchIndexes(VECTOR_INDEX).toArray();
    const definition = vectorIndexDefinition(dimensions);
    if (existing.length) {
      const current = (existing[0] as Document)['latestDefinition'] as Document | undefined;
      const currentDims = (current?.['fields'] as Document[] | undefined)?.[0]?.['numDimensions'];
      if (currentDims === dimensions) return 'exists';
      await coll.updateSearchIndex(VECTOR_INDEX, definition);
      return 'updated';
    }
    await coll.createSearchIndex({ name: VECTOR_INDEX, type: 'vectorSearch', definition });
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
  /** Similarity in [0, 1]: Atlas `vectorSearchScore` for cosine, i.e. (1 + cos) / 2. */
  score: number;
}

export interface PrecedentSearch {
  method: 'atlas_vector_search' | 'local_cosine';
  model: string;
  hits: PrecedentHit[];
}

/**
 * The closest past disputes to `query`. Uses Atlas Vector Search ($vectorSearch) when the index
 * is available, otherwise the same cosine ranking computed here (the in-memory test server has
 * no search). Needs `find` on precedents.
 */
export interface SearchOptions {
  /** Embedding to search with; default `embeddingConfig()` from the environment. */
  embedding?: EmbeddingConfig;
  /** Called when Voyage fails and search falls back to the local embedding. */
  warn?: (line: string) => void;
}

export async function searchPrecedents(db: Db, query: string, limit = 3, opts: SearchOptions = {}): Promise<PrecedentSearch> {
  const cfg = opts.embedding ?? embeddingConfig();
  const coll = db.collection<PrecedentDoc>(COLLECTIONS.precedents);
  let active = cfg;
  let queryVector: number[];
  try {
    [queryVector] = (await embedTexts([query], 'query', cfg)) as [number[]];
  } catch (err) {
    // Voyage unreachable: rank locally rather than fail the ticket.
    opts.warn?.(`[precedents] ${err instanceof Error ? err.message : String(err)}; falling back to local embedding`);
    active = embeddingConfig({});
    queryVector = embed(query);
  }
  const shape = (d: Document, score: number): PrecedentHit => ({
    precedent_id: d['_id'],
    category: d['category'],
    summary: d['summary'],
    outcome: d['outcome'],
    refund_cents: d['refund_cents'],
    rationale: d['rationale'],
    score: Math.round(score * 1000) / 1000,
  });
  if (active === cfg) {
    try {
      const rows = await coll
        .aggregate([
          { $vectorSearch: { index: VECTOR_INDEX, path: 'embedding', queryVector, numCandidates: 100, limit } },
          { $project: { embedding: 0, score: { $meta: 'vectorSearchScore' } } },
        ])
        .toArray();
      if (rows.length) return { method: 'atlas_vector_search', model: active.model, hits: rows.map((r) => shape(r, r['score'] as number)) };
    } catch {
      // No search index on this server (e.g. the in-memory test server): rank locally.
    }
  }
  const all = await coll.find().toArray();
  const ranked = all
    .map((d) => {
      // A stored vector from another model is not comparable; re-embed that precedent locally.
      const vec = d.embedding?.length === queryVector.length && active.provider === cfg.provider ? d.embedding : embed(precedentText(d));
      const q = vec === d.embedding ? queryVector : embed(query);
      return { d, score: (1 + cosine(q, vec)) / 2 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { method: 'local_cosine', model: active.model, hits: ranked.map(({ d, score }) => shape(d, score)) };
}

// ---------------------------------------------------------------------------
// Learning: resolved disputes become precedents
// ---------------------------------------------------------------------------

/** Embeds and upserts precedents (by `_id`). Sets `embedding` and `embedding_model`. */
export async function embedPrecedents<T extends Omit<PrecedentDoc, 'embedding'>>(
  docs: T[],
  cfg: EmbeddingConfig = embeddingConfig(),
): Promise<Array<T & { embedding: number[]; embedding_model: string }>> {
  const vectors = await embedTexts(docs.map(precedentText), 'document', cfg);
  return docs.map((d, i) => ({ ...d, embedding: vectors[i]!, embedding_model: cfg.model }));
}

/**
 * Turns every paid refund (ledger status succeeded) into a precedent `L-<ticket_id>`, so the
 * agent's memory grows with each resolved dispute. Idempotent. Needs find on ledger, tickets,
 * intents and approved, and insert/update on precedents (admin connection).
 */
export async function learnResolvedDisputes(db: Db, cfg: EmbeddingConfig = embeddingConfig()): Promise<{ learned: number }> {
  const ledger = await db.collection(COLLECTIONS.ledger).find({ status: 'succeeded' }).toArray();
  if (!ledger.length) return { learned: 0 };
  const known = new Set((await db.collection(COLLECTIONS.precedents).find({}, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id)));
  const fresh: Array<Omit<PrecedentDoc, 'embedding'>> = [];
  for (const entry of ledger) {
    const id = `L-${entry['ticket_id']}`;
    if (known.has(id)) continue;
    known.add(id);
    const ticket = await db.collection(COLLECTIONS.tickets).findOne({ _id: entry['ticket_id'] });
    const source = await db.collection(entry['source_collection'] as string).findOne({ _id: entry['source_doc_id'] });
    const order = await db.collection(COLLECTIONS.orders).findOne({ _id: entry['order_id'] });
    const full = order ? entry['amount_cents'] >= (order['amount_cents'] as number) : false;
    fresh.push({
      _id: id,
      category: 'resolved_ticket',
      summary: ticket ? `${ticket['subject']}. ${String(ticket['body']).slice(0, 400)}` : `Refund on order ${entry['order_id']}`,
      outcome: full ? 'refunded' : 'partial',
      refund_cents: entry['amount_cents'],
      rationale: (source?.['reason'] as string | undefined) ?? 'Refund paid.',
      decided_at: entry['updated_at'] ?? new Date(),
    });
  }
  if (!fresh.length) return { learned: 0 };
  const docs = await embedPrecedents(fresh, cfg);
  await db.collection<PrecedentDoc>(COLLECTIONS.precedents).bulkWrite(
    docs.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })),
    { ordered: false },
  );
  return { learned: docs.length };
}
