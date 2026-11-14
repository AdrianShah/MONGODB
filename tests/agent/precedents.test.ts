/**
 * A7: precedent search. On Atlas or the mongodb-atlas-local image it uses $vectorSearch; on the
 * in-memory test server it falls back to the same cosine ranking. Either way the agent can cite
 * the result as evidence.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS, cosine, embed, searchPrecedents, type IntentDoc } from '@escrowops/shared';
import { resolveTicket } from '@escrowops/agent';
import { useTestDb } from '../helpers/index.js';
import { setUpAccess } from '../roles/role-helpers.js';
import { seedDatabase } from '../../scripts/lib/seed-data.js';
import { message, scriptedModel, text, toolUse } from './fake-model.js';

const t = useTestDb('precedents');
let vectorIndex: string;

beforeAll(async () => {
  await setUpAccess(t());
  vectorIndex = (await seedDatabase(t().db)).precedents.vectorIndex;
});

describe('embedding', () => {
  it('is deterministic, unit length, and ranks related text above unrelated text', () => {
    const a = embed('two of six wine glasses arrived broken, kept the rest');
    expect(embed('two of six wine glasses arrived broken, kept the rest')).toEqual(a);
    expect(Math.abs(cosine(a, a) - 1)).toBeLessThan(1e-3);
    const near = embed('some glasses broken in transit, customer kept the intact ones');
    const far = embed('charged twice for one checkout on my credit card');
    expect(cosine(a, near)).toBeGreaterThan(cosine(a, far));
  });
});

describe('search_precedents', () => {
  it('finds the closest past disputes, as the agent user', async () => {
    const agentDb = (await t().connectAsRole('agent')).db(t().dbName);
    const query = 'customer charged twice for a single order';
    // A freshly created Atlas search index needs a moment before it serves queries.
    let result = await searchPrecedents(agentDb, query);
    for (let i = 0; vectorIndex !== 'unavailable' && result.method !== 'atlas_vector_search' && i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      result = await searchPrecedents(agentDb, query);
    }
    expect(result.hits).toHaveLength(3);
    expect(result.hits[0]).toMatchObject({ precedent_id: 'P-003', category: 'duplicate_charge', outcome: 'refunded' });
    expect(result.method).toBe(vectorIndex === 'unavailable' ? 'local_cosine' : 'atlas_vector_search');
    console.log(`[precedents] method=${result.method}, top=${result.hits.map((h) => `${h.precedent_id}:${h.score}`).join(' ')}`);
  });

  it('the agent can search and cite a precedent as evidence', async () => {
    const agentDb = (await t().connectAsRole('agent')).db(t().dbName);
    const { createMessage, requests } = scriptedModel([
      message([toolUse('get_ticket', { ticket_id: 'T-1002' })]),
      message([toolUse('search_precedents', { query: 'charged twice for one order' })]),
      message([
        toolUse('propose_refund', {
          order_id: 'O-5102',
          amount_cents: 13450,
          reason: 'Duplicate charge for a single checkout; precedent P-003 reverses the duplicate once.',
          evidence: [{ kind: 'precedent', ref: 'P-003', note: 'Duplicate charge reversed once.' }],
        }),
      ]),
      message([text('Done.')]),
    ]);
    const r = await resolveTicket('T-1002', { db: agentDb, model: 'm', createMessage });
    expect(r.status).toBe('proposed');
    const toolResult = JSON.parse((requests[2]!.messages.at(-1)!.content as Array<{ content: string }>)[0]!.content);
    expect(toolResult.hits[0].precedent_id).toBe('P-003');
    expect(await t().db.collection<IntentDoc>(COLLECTIONS.intents).findOne({ ticket_id: 'T-1002' })).toMatchObject({
      evidence: [{ kind: 'precedent', ref: 'P-003' }],
    });
  });
});
