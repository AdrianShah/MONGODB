/**
 * Every collection in the EscrowOps database (PRD section 7).
 *
 * Keys equal values on purpose, so `COLLECTIONS.review_queue` reads the same
 * as the name the server sees. Always go through this map instead of
 * typing a collection name as a string literal.
 */
export const COLLECTIONS = {
  tickets: 'tickets',
  orders: 'orders',
  customers: 'customers',
  policies: 'policies',
  agent_traces: 'agent_traces',
  intents: 'intents',
  review_queue: 'review_queue',
  approvals: 'approvals',
  approved: 'approved',
  ledger: 'ledger',
  budgets: 'budgets',
  executor_state: 'executor_state',
  /** A7: past resolved disputes the agent can search (seed data, with embeddings). */
  precedents: 'precedents',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

/** All collection names, in PRD order. */
export const ALL_COLLECTIONS: readonly CollectionName[] = Object.values(COLLECTIONS);
