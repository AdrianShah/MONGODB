/**
 * npm run precedents:learn (A7)
 *
 * Turns every paid refund (ledger status succeeded) into a precedent, embedded with Voyage when
 * VOYAGE_API_KEY is set (else the local embedding), so later tickets are checked against it.
 * Idempotent. Admin connection. Note: `npm run seed` / `reset` restore the seed precedents only.
 */
import { connectAdmin, embeddingConfig, learnResolvedDisputes, loadConfigOrExit } from '@escrowops/shared';

const config = loadConfigOrExit();
const client = await connectAdmin(config);
try {
  const { learned } = await learnResolvedDisputes(client.db(config.dbName));
  console.log(`Learned ${learned} new precedent(s) from resolved disputes (${embeddingConfig().model}).`);
} finally {
  await client.close();
}
