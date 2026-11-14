/**
 * Batch runner: `npm run batch` works every open ticket; `npm run batch -- T-1001 T-1011`
 * works just those. Connects as the agent database user (AGENT_DB_USER) and nothing else.
 */
import Anthropic from '@anthropic-ai/sdk';
import { COLLECTIONS, connectAs, loadConfigOrExit, type TicketDoc } from '@escrowops/shared';
import { anthropicCreateMessage } from './agent.js';
import { runBatch, statusLine } from './batch.js';
import { loadAgentSettings, type AgentSettings } from './config.js';

const config = loadConfigOrExit(); // Loads .env; exits naming any missing variable.
let settings: AgentSettings;
try {
  settings = loadAgentSettings();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const client = await connectAs('agent', config);
const db = client.db(config.dbName);
try {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const ticketIds = requested.length
    ? requested
    : (await db.collection<TicketDoc>(COLLECTIONS.tickets).find({ status: 'open' }, { projection: { _id: 1 } }).sort({ _id: 1 }).toArray()).map(
        (t) => t._id,
      );
  if (ticketIds.length === 0) {
    console.log('[agent] no open tickets. Run `npm run seed` first.');
  } else {
    console.log(`[agent] ${ticketIds.length} tickets, model ${settings.model}, effort ${settings.effort}, ${settings.concurrency} at a time`);
    const started = Date.now();
    const results = await runBatch(ticketIds, {
      db,
      createMessage: anthropicCreateMessage(new Anthropic()),
      model: settings.model,
      effort: settings.effort,
      fallbacks: settings.fallbacks,
      concurrency: settings.concurrency,
      onResult: (r) => console.log(statusLine(r)),
    });
    const count = (s: string) => results.filter((r) => r.status === s).length;
    console.log(
      `[agent] done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${count('proposed')} auto, ${count('held')} held, ` +
        `${count('declined')} declined, ${count('already_proposed')} already proposed, ` +
        `${results.length - count('proposed') - count('held') - count('declined') - count('already_proposed')} other`,
    );
    if (results.some((r) => r.status === 'error')) process.exitCode = 1;
  }
} finally {
  await client.close();
}
