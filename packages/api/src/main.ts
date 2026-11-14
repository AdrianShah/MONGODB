/**
 * Approval service: `npm run api`. Connects as the approver database user
 * (APPROVER_DB_USER) and nothing else. Listens on API_HOST:API_PORT (default 127.0.0.1:4000).
 */
import { connectAs, loadConfigOrExit } from '@escrowops/shared';
import { checkApproverSafety, loadApprovers } from './approvers.js';
import { buildApiServer } from './server.js';

const config = loadConfigOrExit(); // Loads .env; exits naming any missing variable.
let approvers;
try {
  approvers = loadApprovers();
  for (const w of checkApproverSafety(process.env, config.mongodbUri)) console.warn(`[api] warning: ${w}`);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const port = Number(process.env['API_PORT'] ?? 4000);
const host = process.env['API_HOST'] ?? '127.0.0.1';

const client = await connectAs('approver', config);
const { app } = await buildApiServer({ client, db: client.db(config.dbName), approvers });

const shutdown = async (signal: string) => {
  console.log(`[api] ${signal}, stopping`);
  await app.close();
  await client.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port, host });
console.log(`[api] approval service on http://${host}:${port} (approvers: ${approvers.map((a) => a.id).join(', ')})`);
