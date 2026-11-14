/**
 * Batch runner (A5). Connects as the agent database user (AGENT_DB_USER) and nothing else.
 *
 *   npm run batch                     every open ticket, with Claude
 *   npm run batch -- T-1001 T-1011    just these
 *   npm run batch -- --replay [file]  no model call: replay recorded responses through the real
 *                                     agent loop (DEMO.md fallback). Uses the file given, else the
 *                                     last live run (.escrowops/last-run.json), else the seed
 *                                     data's expected outcomes.
 *
 * A live run that decides every ticket is saved to .escrowops/last-run.json for replay.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { COLLECTIONS, connectAs, loadConfigOrExit, type TicketDoc } from '@escrowops/shared';
import { anthropicCreateMessage, type CreateMessage } from './agent.js';
import { runBatch, statusLine } from './batch.js';
import { loadAgentSettings, type AgentSettings } from './config.js';
import { buildExpectedRecording, emptyRecording, recordingCreateMessage, replayCreateMessage, type Recording } from './replay.js';

const LAST_RUN = resolve('.escrowops/last-run.json');
const SEED_DIR = resolve('data/seed');

const config = loadConfigOrExit(); // Loads .env; exits naming any missing variable.
let settings: AgentSettings;
try {
  settings = loadAgentSettings();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const args = process.argv.slice(2);
const replayAt = args.indexOf('--replay');
const replay = replayAt >= 0;
const replayFile = replay && args[replayAt + 1] && !args[replayAt + 1]!.startsWith('-') && !/^T-/.test(args[replayAt + 1]!) ? args[replayAt + 1] : undefined;
const requested = args.filter((a, i) => /^T-/.test(a) && a !== replayFile && i !== replayAt);

function loadRecording(): { rec: Recording; from: string } {
  if (replayFile) return { rec: JSON.parse(readFileSync(replayFile, 'utf8')) as Recording, from: replayFile };
  if (existsSync(LAST_RUN)) return { rec: JSON.parse(readFileSync(LAST_RUN, 'utf8')) as Recording, from: 'last live run' };
  const read = (f: string) => JSON.parse(readFileSync(resolve(SEED_DIR, f), 'utf8'));
  return {
    rec: buildExpectedRecording(read('tickets.json'), read('orders.json'), read('expected.json').tickets),
    from: 'expected outcomes in data/seed',
  };
}

const client = await connectAs('agent', config);
const db = client.db(config.dbName);
try {
  const ticketIds = requested.length
    ? requested
    : (await db.collection<TicketDoc>(COLLECTIONS.tickets).find({ status: 'open' }, { projection: { _id: 1 } }).sort({ _id: 1 }).toArray()).map(
        (t) => t._id,
      );
  if (ticketIds.length === 0) {
    console.log('[agent] no open tickets. Run `npm run seed` first.');
  } else {
    let createMessage: CreateMessage;
    let recording: Recording | undefined;
    if (replay) {
      const { rec, from } = loadRecording();
      createMessage = replayCreateMessage(rec);
      console.log(`[agent] REPLAY of ${from}: no model calls; every database write is real`);
    } else {
      recording = emptyRecording(settings.model);
      createMessage = recordingCreateMessage(anthropicCreateMessage(new Anthropic()), recording);
    }
    console.log(
      `[agent] ${ticketIds.length} tickets, ${replay ? 'replayed' : `model ${settings.model}, effort ${settings.effort}`}, ${settings.concurrency} at a time\n`,
    );
    const started = Date.now();
    const color = Boolean(process.stdout.isTTY) && !process.env['NO_COLOR'];
    const results = await runBatch(ticketIds, {
      db,
      createMessage,
      model: settings.model,
      effort: settings.effort,
      fallbacks: settings.fallbacks,
      concurrency: settings.concurrency,
      onResult: (r) => console.log(statusLine(r, { color })),
      onFrozen: (skipped) =>
        console.log(
          `\n[agent] FROZEN by the kill switch: MongoDB revoked this user's insert on intents and review_queue. ` +
            `Stopping the batch; ${skipped.length} ticket(s) not started.\n`,
        ),
    });
    const count = (s: string) => results.filter((r) => r.status === s).length;
    const other = results.length - count('proposed') - count('held') - count('declined') - count('already_proposed') - count('frozen');
    console.log(
      `\n[agent] done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${count('proposed')} auto, ${count('held')} held, ` +
        `${count('declined')} declined, ${count('already_proposed')} already proposed, ${count('frozen')} frozen, ${other} other`,
    );
    if (recording && other === 0 && count('frozen') === 0) {
      mkdirSync(dirname(LAST_RUN), { recursive: true });
      writeFileSync(LAST_RUN, JSON.stringify(recording));
      console.log(`[agent] saved for replay: ${LAST_RUN}`);
    }
    if (results.some((r) => r.status === 'error')) process.exitCode = 1;
    else if (results.some((r) => r.status === 'frozen')) process.exitCode = 3; // stopped by the kill switch
  }
} finally {
  await client.close();
}
