/**
 * `npm run db`: a throwaway MongoDB for local development without Docker.
 *
 * Starts the same in-memory replica set (auth on) that the tests use and
 * prints the admin connection string to put in `.env` as MONGODB_URI.
 * Data lives only as long as this process; stop it with Ctrl+C.
 */
import { startTestServer } from '../tests/helpers/server.js';

const env = { ...process.env };
delete env['MONGODB_URI'];

const server = await startTestServer(env);

console.log('In-memory MongoDB replica set is running (data is lost when this stops).');
console.log('');
console.log('Put this in .env, then run `npm run setup` and `npm run seed` in another terminal:');
console.log('');
console.log(`MONGODB_URI=${server.uri}`);
console.log('');
console.log('Ctrl+C to stop.');

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await server.stop();
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

// Keep the event loop alive until a signal arrives.
setInterval(() => undefined, 1 << 30);
