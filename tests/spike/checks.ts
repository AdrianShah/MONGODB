/**
 * Phase 0 spike checks (PRD section 11, "Verify first").
 *
 * Each check runs against a TestDb, asserts with node:assert (so it works in
 * Vitest and in scripts/spike.ts alike), and returns the raw observations
 * (error codes, errInfo shapes) that docs/SPIKE.md records.
 *
 * Every check uses its own collection names, so all of them can share one
 * database.
 */
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ChangeStream, ChangeStreamInsertDocument, Document, MongoClient, ResumeToken } from 'mongodb';
import type { TestDb } from '../helpers/test-db.js';
import { ERROR_CODES, captureServerError, summarizeServerError, validatorOperatorNames } from '../helpers/errors.js';

export interface CheckResult {
  findings: Record<string, unknown>;
}

export interface SpikeCheck {
  id: 'a' | 'b' | 'c' | 'd' | 'e';
  title: string;
  run(t: TestDb): Promise<CheckResult>;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// a. Collection-level custom role
// ---------------------------------------------------------------------------

export const checkCustomRole: SpikeCheck = {
  id: 'a',
  title: 'Custom role with collection-level privileges (insert only on one collection)',
  async run(t) {
    const allowed = 'spike_a_allowed';
    const other = 'spike_a_other';
    // A validator on the allowed collection makes the bypassDocumentValidation attempt meaningful.
    await t.db.createCollection(allowed, {
      validator: { $jsonSchema: { bsonType: 'object', properties: { amount_cents: { bsonType: 'int', maximum: 100 } } } },
      validationLevel: 'strict',
      validationAction: 'error',
    });
    await t.db.createCollection(other);
    await t.db.collection(allowed).insertOne({ seeded: true, amount_cents: 1 });

    const role = 'spike_insert_only_role';
    await t.db.command({
      createRole: role,
      privileges: [{ resource: { db: t.dbName, collection: allowed }, actions: ['insert'] }],
      roles: [],
    });
    const creds = await t.createUser('spike_inserter', [role]);
    const client = await t.clientAs(creds.username, creds.password);
    const db = client.db(t.dbName);

    const inserted = await db.collection(allowed).insertOne({ by: 'inserter', amount_cents: 5 });
    assert.ok(inserted.insertedId, 'insert into the granted collection should succeed');

    const attempts: Record<string, () => Promise<unknown>> = {
      update: () => db.collection(allowed).updateOne({ seeded: true }, { $set: { amount_cents: 99 } }),
      remove: () => db.collection(allowed).deleteOne({ seeded: true }),
      insertOtherCollection: () => db.collection(other).insertOne({ by: 'inserter' }),
      collMod: () => db.command({ collMod: allowed, validator: {} }),
      insertWithBypassDocumentValidation: () =>
        db.collection(allowed).insertOne({ amount_cents: 5_000 }, { bypassDocumentValidation: true }),
      find: () => db.collection(allowed).findOne({}),
    };

    const denied: Record<string, Document> = {};
    for (const [name, attempt] of Object.entries(attempts)) {
      const err = await captureServerError(attempt);
      assert.equal(err.code, ERROR_CODES.UNAUTHORIZED, `${name}: expected code 13, got ${err.code} ${err.message}`);
      denied[name] = { code: err.code, codeName: err.codeName, errmsg: err.errmsg };
    }

    // Nothing the denied attempts tried actually happened.
    const seeded = await t.db.collection(allowed).findOne({ seeded: true });
    assert.equal(seeded?.['amount_cents'], 1);
    assert.equal(await t.db.collection(other).countDocuments(), 0);
    assert.equal(await t.db.collection(allowed).countDocuments({ amount_cents: 5_000 }), 0);

    return { findings: { role, granted: ['insert'], insertSucceeded: true, denied } };
  },
};

// ---------------------------------------------------------------------------
// b. $jsonSchema rejection shape (error 121, errInfo.details)
// ---------------------------------------------------------------------------

export const checkValidatorErrorShape: SpikeCheck = {
  id: 'b',
  title: 'Validator rejection surfaces as code 121 with errInfo.details',
  async run(t) {
    const coll = 'spike_b_validated';
    await t.db.createCollection(coll, {
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          additionalProperties: false,
          required: ['_id', 'amount_cents', 'reason', 'low', 'high'],
          properties: {
            _id: { bsonType: 'objectId' },
            amount_cents: { bsonType: ['int', 'long'], minimum: 1, maximum: 50_000 },
            reason: { bsonType: 'string', minLength: 5 },
            low: { bsonType: 'int' },
            high: { bsonType: 'int' },
          },
        },
        $expr: { $lte: ['$low', '$high'] },
      },
      validationLevel: 'strict',
      validationAction: 'error',
    });
    const c = t.db.collection(coll);
    const valid = { amount_cents: 4_200, reason: 'damaged item', low: 1, high: 2 };
    await c.insertOne({ ...valid });

    const cases: Record<string, Document> = {
      maximum: { ...valid, amount_cents: 50_001 },
      required: { amount_cents: 100, reason: 'missing low and high' },
      additionalProperties: { ...valid, approvals: [{ approver_id: 'forged' }] },
      expr: { ...valid, low: 5, high: 1 },
    };
    const expectedOperator: Record<string, string> = {
      maximum: 'maximum',
      required: 'required',
      additionalProperties: 'additionalProperties',
      expr: '$expr',
    };

    const shapes: Record<string, Document> = {};
    for (const [name, doc] of Object.entries(cases)) {
      const err = await captureServerError(() => c.insertOne(doc));
      assert.equal(err.code, ERROR_CODES.DOCUMENT_VALIDATION_FAILURE, `${name}: expected 121, got ${err.code}`);
      assert.ok(err.errInfo, `${name}: errInfo missing`);
      const details = (err.errInfo as Document)['details'];
      assert.ok(details, `${name}: errInfo.details missing`);
      const operators = validatorOperatorNames(details);
      assert.ok(
        operators.includes(expectedOperator[name] ?? name),
        `${name}: expected errInfo.details to name ${expectedOperator[name]}, saw ${operators.join(', ')}`,
      );
      shapes[name] = { ...summarizeServerError(err), operatorNames: operators };
    }

    // additionalProperties: false without _id in `properties` rejects every document,
    // because the server adds _id before validating.
    const noIdColl = 'spike_b_no_id_listed';
    await t.db.createCollection(noIdColl, {
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          additionalProperties: false,
          properties: { name: { bsonType: 'string' } },
        },
      },
    });
    const noIdErr = await captureServerError(() => t.db.collection(noIdColl).insertOne({ name: 'ok' }));
    assert.equal(noIdErr.code, ERROR_CODES.DOCUMENT_VALIDATION_FAILURE);
    assert.match(JSON.stringify(noIdErr.errInfo), /_id/);

    // insertMany wraps the same details in a bulk write error.
    let bulkShape: Document | undefined;
    try {
      await c.insertMany([{ ...valid }, { ...valid, amount_cents: 999_999 }], { ordered: true });
      assert.fail('insertMany with an invalid document should fail');
    } catch (err) {
      const e = err as Document;
      const writeError = (e['writeErrors'] as Document[] | undefined)?.[0];
      bulkShape = {
        errorClass: (err as Error).constructor.name,
        code: e['code'],
        writeErrors0: writeError
          ? { index: writeError['index'], code: writeError['code'], hasErrInfo: Boolean(writeError['errInfo']) }
          : null,
      };
      assert.equal(writeError?.['code'], ERROR_CODES.DOCUMENT_VALIDATION_FAILURE);
    }

    return {
      findings: {
        errorClass: 'MongoServerError',
        shapes,
        additionalPropertiesWithoutIdListed: summarizeServerError(noIdErr),
        insertMany: bulkShape,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// c. Change Streams: filtered inserts, resume after close, required actions
// ---------------------------------------------------------------------------

async function watcherClient(t: TestDb, user: string, actions: string[], collection: string): Promise<MongoClient> {
  const role = `${user}_role`;
  await t.db.command({
    createRole: role,
    privileges: [{ resource: { db: t.dbName, collection }, actions }],
    roles: [],
  });
  const creds = await t.createUser(user, [role]);
  return t.clientAs(creds.username, creds.password);
}

type InsertEvent = ChangeStreamInsertDocument<Document>;

async function nextInsert(stream: ChangeStream<Document, InsertEvent>): Promise<InsertEvent> {
  return withTimeout(stream.next(), 15_000, 'a change stream event');
}

export const checkChangeStreams: SpikeCheck = {
  id: 'c',
  title: 'Change Stream on inserts delivers events and resumes from a saved token',
  async run(t) {
    const coll = 'spike_c_events';
    await t.db.createCollection(coll);
    const pipeline = [{ $match: { operationType: 'insert' } }];
    const writer = t.db.collection(coll);

    // Which actions does a watching user need?
    const actionMatrix: Record<string, Document> = {};
    for (const [label, actions] of [
      ['changeStream_only', ['changeStream']],
      ['find_only', ['find']],
      ['find_and_changeStream', ['find', 'changeStream']],
    ] as const) {
      const client = await watcherClient(t, `spike_watch_${label}`, [...actions], coll);
      const stream = client.db(t.dbName).collection(coll).watch<Document, InsertEvent>(pipeline);
      try {
        await stream.tryNext();
        actionMatrix[label] = { actions, allowed: true };
      } catch (err) {
        const e = err as Document;
        actionMatrix[label] = { actions, allowed: false, code: e['code'], codeName: e['codeName'], errmsg: e['errmsg'] };
      } finally {
        await stream.close();
      }
    }
    assert.equal(actionMatrix['find_and_changeStream']?.['allowed'], true);

    const client = await watcherClient(t, 'spike_watcher', ['find', 'changeStream'], coll);
    const watched = client.db(t.dbName).collection(coll);

    // 1. Live delivery, filtered to inserts.
    const first = watched.watch<Document, InsertEvent>(pipeline);
    await first.tryNext(); // opens the cursor so later writes are captured
    await writer.insertOne({ n: 1 });
    await writer.updateOne({ n: 1 }, { $set: { touched: true } }); // filtered out
    const e1 = await nextInsert(first);
    assert.equal(e1.operationType, 'insert');
    assert.equal(e1.fullDocument['n'], 1);
    const savedToken: ResumeToken = first.resumeToken;
    assert.ok(savedToken, 'resume token should be available after an event');
    await first.close();

    // 2. Writes while nobody is watching.
    await writer.insertOne({ n: 2 });
    await writer.deleteOne({ n: 1 }); // filtered out
    await writer.insertOne({ n: 3 });

    // 3. Resume from the saved token: gets exactly the missed inserts, in order.
    const resumed = watched.watch<Document, InsertEvent>(pipeline, { resumeAfter: savedToken });
    const e2 = await nextInsert(resumed);
    const e3 = await nextInsert(resumed);
    assert.deepEqual([e2.fullDocument['n'], e3.fullDocument['n']], [2, 3]);
    assert.equal(await resumed.tryNext(), null, 'no further events expected');
    await resumed.close();

    // 4. startAfter behaves the same for insert-only streams.
    const startAfter = watched.watch<Document, InsertEvent>(pipeline, { startAfter: savedToken });
    const s2 = await nextInsert(startAfter);
    assert.equal(s2.fullDocument['n'], 2);
    await startAfter.close();

    return {
      findings: {
        actionMatrix,
        resumeTokenShape: Object.keys(savedToken as Document),
        resumedEvents: [e2.fullDocument['n'], e3.fullDocument['n']],
        updatesAndDeletesFiltered: true,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// d. Multi-document transactions
// ---------------------------------------------------------------------------

export const checkTransactions: SpikeCheck = {
  id: 'd',
  title: 'Multi-document transaction commits atomically and aborts cleanly',
  async run(t) {
    const left = 'spike_d_left';
    const right = 'spike_d_right';
    await t.db.createCollection(left);
    await t.db.createCollection(right, {
      validator: { $jsonSchema: { bsonType: 'object', required: ['amount_cents'], properties: { amount_cents: { bsonType: 'int', maximum: 100 } } } },
      validationLevel: 'strict',
      validationAction: 'error',
    });

    // Commit.
    const session = t.admin.startSession();
    try {
      await session.withTransaction(async () => {
        await t.db.collection(left).insertOne({ tx: 'commit' }, { session });
        await t.db.collection(right).insertOne({ tx: 'commit', amount_cents: 10 }, { session });
        // Not visible outside the transaction before commit.
        assert.equal(await t.db.collection(left).countDocuments({ tx: 'commit' }), 0);
      });
    } finally {
      await session.endSession();
    }
    assert.equal(await t.db.collection(left).countDocuments({ tx: 'commit' }), 1);
    assert.equal(await t.db.collection(right).countDocuments({ tx: 'commit' }), 1);

    // Explicit abort.
    const s2 = t.admin.startSession();
    try {
      s2.startTransaction();
      await t.db.collection(left).insertOne({ tx: 'abort' }, { session: s2 });
      await t.db.collection(right).insertOne({ tx: 'abort', amount_cents: 10 }, { session: s2 });
      await s2.abortTransaction();
    } finally {
      await s2.endSession();
    }
    assert.equal(await t.db.collection(left).countDocuments({ tx: 'abort' }), 0);
    assert.equal(await t.db.collection(right).countDocuments({ tx: 'abort' }), 0);

    // A validator failure on the second write rolls back the first.
    const s3 = t.admin.startSession();
    let validatorAbort: Document | undefined;
    try {
      const err = await captureServerError(() =>
        s3.withTransaction(async () => {
          await t.db.collection(left).insertOne({ tx: 'validator' }, { session: s3 });
          await t.db.collection(right).insertOne({ tx: 'validator', amount_cents: 1_000 }, { session: s3 });
        }),
      );
      assert.equal(err.code, ERROR_CODES.DOCUMENT_VALIDATION_FAILURE);
      validatorAbort = { code: err.code, codeName: err.codeName, errorLabels: [...(err.errorLabels ?? [])] };
    } finally {
      await s3.endSession();
    }
    assert.equal(await t.db.collection(left).countDocuments({ tx: 'validator' }), 0);

    return { findings: { commit: 'both documents visible after commit, neither before', abort: 'neither written', validatorAbort } };
  },
};

// ---------------------------------------------------------------------------
// e. $expr budget cap under $inc, including concurrency
// ---------------------------------------------------------------------------

export const checkBudgetCap: SpikeCheck = {
  id: 'e',
  title: '$expr cap rejects an over-cap $inc, also under 20 concurrent increments',
  async run(t) {
    const coll = 'spike_e_budgets';
    await t.db.createCollection(coll, {
      validator: { $expr: { $lte: ['$spent_cents', '$cap_cents'] } },
      validationLevel: 'strict',
      validationAction: 'error',
    });
    const budgets = t.db.collection<{ _id: string; cap_cents: number; spent_cents: number }>(coll);

    // Sequential.
    await budgets.insertOne({ _id: 'seq', cap_cents: 10_000, spent_cents: 0 });
    await budgets.updateOne({ _id: 'seq' }, { $inc: { spent_cents: 4_000 } });
    await budgets.updateOne({ _id: 'seq' }, { $inc: { spent_cents: 6_000 } }); // exactly at cap
    const overErr = await captureServerError(() => budgets.updateOne({ _id: 'seq' }, { $inc: { spent_cents: 1 } }));
    assert.equal(overErr.code, ERROR_CODES.DOCUMENT_VALIDATION_FAILURE);
    assert.equal((await budgets.findOne({ _id: 'seq' }))?.spent_cents, 10_000);

    // Concurrent: 20 x 700 = 14,000 against a 10,000 cap.
    const cap = 10_000;
    const step = 700;
    const workers = 20;
    await budgets.insertOne({ _id: 'concurrent', cap_cents: cap, spent_cents: 0 });
    const results = await Promise.allSettled(
      Array.from({ length: workers }, () => budgets.updateOne({ _id: 'concurrent' }, { $inc: { spent_cents: step } })),
    );
    const accepted = results.filter((r) => r.status === 'fulfilled').length;
    const rejectedCodes = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason as Document)['code']);
    const final = (await budgets.findOne({ _id: 'concurrent' }))?.spent_cents;

    assert.ok(final !== undefined && final <= cap, `final spent ${final} exceeds cap ${cap}`);
    assert.equal(final, accepted * step, 'every accepted $inc is reflected exactly once');
    assert.equal(accepted, Math.floor(cap / step));
    assert.ok(rejectedCodes.every((code) => code === ERROR_CODES.DOCUMENT_VALIDATION_FAILURE));

    // Give the server a moment, then re-read: nothing changes afterwards.
    await sleep(50);
    assert.equal((await budgets.findOne({ _id: 'concurrent' }))?.spent_cents, final);

    return {
      findings: {
        overCapError: summarizeServerError(overErr),
        concurrent: { workers, step, cap, accepted, rejected: rejectedCodes.length, rejectedCodes: [...new Set(rejectedCodes)], final },
      },
    };
  },
};

export const SPIKE_CHECKS: readonly SpikeCheck[] = [
  checkCustomRole,
  checkValidatorErrorShape,
  checkChangeStreams,
  checkTransactions,
  checkBudgetCap,
];
