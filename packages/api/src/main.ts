/**
 * Approval service: `npm run api`. Connects as the approver database user
 * (APPROVER_DB_USER). Listens on API_HOST:API_PORT (default 127.0.0.1:4000).
 *
 * Kill switch: POST /api/freeze and /api/unfreeze open a short-lived admin connection
 * (MONGODB_URI) for the one updateRole + rollback, then close it. KILL_SWITCH=off disables them.
 */
import { connectAdmin, connectAs, loadConfigOrExit } from '@escrowops/shared';
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
const killSwitchOff = ['0', 'off', 'false', 'no'].includes((process.env['KILL_SWITCH'] ?? '').toLowerCase());
const { app } = await buildApiServer({
  client,
  db: client.db(config.dbName),
  approvers,
  ...(killSwitchOff ? {} : { killSwitch: { connectAdmin: () => connectAdmin(config, { serverSelectionTimeoutMS: 10_000 }), dbName: config.dbName } }),
});

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
