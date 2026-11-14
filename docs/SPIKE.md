# Phase 0 Spike Findings

Answers to PRD section 11 "Verify first", plus two extra checks (transactions under validators, the budget cap under concurrency).

- **Where it ran:** `mongodb-memory-server` 11.3.0, a `MongoMemoryReplSet` with one node, auth on (keyfile plus root user), wiredTiger, **MongoDB 8.0.38** (pinned in `package.json` under `config.mongodbMemoryServer.version`). I also ran it against a separately started server through `MONGODB_URI`, and it passed there too.
- **Driver and tooling:** `mongodb` 7.9.0 Node driver, Node 26.9.0, Vitest 5.1.0, TypeScript 7.0.2.
- **Source:** the checks are in `tests/spike/checks.ts`. `tests/spike/spike.test.ts` runs them under `npm test`, and `npm run spike` runs them against `MONGODB_URI`. With `MONGODB_URI` unset, `npm run spike` starts its own in-memory server. Add `-- --json` to print the raw findings that this document quotes.

| Check | Result |
|---|---|
| a. Collection-level custom role | PASS |
| b. Error 121 with `errInfo.details` | PASS |
| c. Change Stream: filtered inserts, resume after close | PASS |
| d. Multi-document transaction | PASS |
| e. `$expr` cap under `$inc`, 20 concurrent | PASS |

## a. Custom role with collection-level privileges

The role is created with `createRole` in the application database. It grants only `insert` on `{db, collection: "spike_a_allowed"}`, and a user created in the same database holds it.

- `insertOne` into the granted collection succeeds.
- These attempts all fail with **code 13, codeName `Unauthorized`**:
  - `updateOne` on the granted collection
  - `deleteOne` on the granted collection
  - `insertOne` into another collection
  - `collMod` on the granted collection
  - `insertOne(..., { bypassDocumentValidation: true })` on the granted collection
  - `findOne` on the granted collection (insert does not imply find)
- None of the denied writes changed any data.
- The `errmsg` looks like `not authorized on <db> to execute command { update: "spike_a_allowed", ... }`. It echoes the whole command, including `lsid` and `$clusterTime`. **Assert on `code === 13`, never on the message.**
- `bypassDocumentValidation` is denied as an authorization failure (13) before validation runs. The over-cap document would have failed with 121, but 13 comes back instead. This is what R6 expects.

## b. Validator rejection shape

- `insertOne` throws `MongoServerError` with `code: 121`, `errmsg: "Document failed validation"`, and `errInfo: { failingDocumentId, details }`.
- **`codeName` is `undefined` on these write errors.** The driver builds them from the write error, which has no codeName. Command errors such as 13 do carry `codeName`. Assert on `code`.
- `insertMany` throws `MongoBulkWriteError` with `code: 121`. Each `writeErrors[i]` has its own `index`, `code` 121 and `errInfo`.
- Inside `withTransaction`, a validator failure surfaces as 121 with no `TransientTransactionError` label, so the transaction is not retried. See d.

When the validator mixes `$jsonSchema` with a top-level `$expr` (`{ $jsonSchema: {...}, $expr: {...} }`), the server reports it as an implicit `$and`. `details` is `{ operatorName: "$and", clausesNotSatisfied: [{ index, details }] }`, and `index` is 0 for `$jsonSchema` and 1 for `$expr`. A validator that is only `$jsonSchema` has no wrapper: `details` is the `$jsonSchema` node itself.

Observed `details` in each case (inside the `$and` wrapper):

```js
// maximum
{ operatorName: "$jsonSchema", schemaRulesNotSatisfied: [
  { operatorName: "properties", propertiesNotSatisfied: [
    { propertyName: "amount_cents", details: [
      { operatorName: "maximum", specifiedAs: { maximum: 50000 },
        reason: "comparison failed", consideredValue: 50001 } ] } ] } ] }

// required
{ operatorName: "$jsonSchema", schemaRulesNotSatisfied: [
  { operatorName: "required", specifiedAs: { required: [/* full list */] },
    missingProperties: ["high", "low"] } ] }

// additionalProperties
{ operatorName: "$jsonSchema", schemaRulesNotSatisfied: [
  { operatorName: "additionalProperties", specifiedAs: { additionalProperties: false },
    additionalProperties: ["approvals"] } ] }

// $expr (clause index 1)
{ operatorName: "$expr", specifiedAs: { $expr: { $lte: ["$low", "$high"] } },
  reason: "expression did not match", expressionResult: false }
```

`tests/helpers/errors.ts` has `validatorOperatorNames(errInfo)`, which collects every `operatorName` in the tree, for example `["$and", "$jsonSchema", "properties", "maximum"]`. Use it to assert that a rejection names the expected rule.

**`additionalProperties: false` needs `_id` in `properties`.** Without it, every insert fails, because the server adds `_id` before validating. Observed: `additionalProperties: ["_id"]`. The PRD's `intents` validator already lists `_id`; the `approved` validator must list it too.

## c. Change Streams

- `collection.watch([{ $match: { operationType: "insert" } }])` delivers inserts and skips updates and deletes.
- The resume token has the shape `{ _data: "<hex string>" }`. It is available as `stream.resumeToken` after an event.
- Resume after close works. I saved the token after event 1 and closed the stream. Then I inserted 2, deleted 1 and inserted 3. A new stream opened with `{ resumeAfter: token }` delivered exactly 2 and then 3, with nothing further. `startAfter` behaves the same for this pipeline.
- **The watching user needs both `find` and `changeStream`** on the collection. With `changeStream` alone, or `find` alone, the `aggregate` fails with code 13. This matches the PRD role table.
- The error only appears on the first `next()`, `tryNext()` or `hasNext()`, not on `watch()`. `watch()` is lazy. A process that watches should call `tryNext()` once at startup, so a missing privilege fails fast.
- Each `tryNext()` with no events waits for the server's `maxAwaitTimeMS`, about 1 s. This is why check c takes about 3 s.

## d. Transactions

- `session.withTransaction` inserting into two collections: neither document is visible outside the session before commit, and both are visible after.
- An explicit `startTransaction` followed by `abortTransaction` writes neither document.
- A 121 on the second insert inside `withTransaction` rolls back the first, and the error propagates as 121. This is the S3/I9 promotion path: if the `approved` insert fails validation, the review update in the same transaction is undone.
- The transactions ran as the root user. I did not separately check the privileges a role user needs in order to use transactions. Running a transaction only needs the CRUD privileges of the operations inside it, so B's R26 positive tests should include one approver transaction.

## e. Budget cap under `$inc`

The validator is `{ $expr: { $lte: ["$spent_cents", "$cap_cents"] } }`, with `validationLevel: "strict"` and `validationAction: "error"`.

- Sequential test, cap 10000:
  - `$inc` 4000 is accepted, then `$inc` 6000 is accepted (exactly at the cap).
  - `$inc` 1 is rejected with code 121. Its `details` is the `$expr` node, with `failingDocumentId` set to the budget `_id`.
  - The stored value stays 10000.
- Concurrent test: 20 parallel `$inc` of 700 against a cap of 10000.
  - Exactly 14 were accepted and 6 were rejected, all with 121.
  - The final `spent_cents` is 9800, which equals accepted × 700.
  - Updates to one document are serialized, so the validator sees each post-image and no increment is lost or double counted.

## Contradictions with or additions to the PRD

1. **Error 121 has no `codeName` on write errors** (b). The PRD and the test plan only say "121", so nothing contradicts them, but any code that matches on `codeName: "DocumentValidationFailure"` will break.
2. **The `errInfo.details` root depends on how the validator is written.** Validators that combine `$jsonSchema` with `$expr` or `$or` (the PRD's `approved` validator uses an explicit `$and`) put the failing rule under `clausesNotSatisfied[i].details`. To find the rule name, walk the whole tree; do not read a fixed path.
3. **A Change Stream user needs `find`, not just `changeStream`** (c). The PRD role table already says "`find` + `changeStream`". Note that `dashboard_role` "find + changeStream on everything" therefore gives the dashboard read access to `executor_state`.
4. **ESM interop:** `EJSON` is not a named ESM export of `mongodb` under plain Node or tsx, though it is under Vitest. Use `BSON.EJSON`. `ObjectId`, `Int32`, `Long`, `MongoServerError` and the other main exports import fine.
5. **Where roles and users live** (harness decision, not in the PRD): locally, roles and users are created in the application database, so each test database is isolated. On Atlas, every user lives in `admin`, so set `MONGODB_ROLE_AUTH_SOURCE=admin`.

## Not yet verified on Atlas

- **Custom roles and users.** Atlas rejects `createRole` and `createUser` from a database connection. They are created through the Atlas UI, `atlas customDbRoles create`, or the Admin API, and live in `admin` at project scope. Check a of `npm run spike` is therefore expected to FAIL on Atlas. That failure is the signal to apply the roles through `scripts/atlas-roles.ts` and `docs/ATLAS_SETUP.md` (Agent B), and then rerun the R tests against Atlas with pre-created users.
- **Whether the cluster tier allows collection-level custom role actions.** On free and shared tiers (M0, Flex), the supported actions for custom roles are restricted. `collMod`, `bypassDocumentValidation` and `changeStream` at collection scope need to be confirmed on the tier we get. If they are not allowed, the PRD fallback applies: the local `mongodb/mongodb-atlas-local` image (`docker-compose.yml`), where `createRole` works.
- **Change Streams and transactions on the chosen tier**, including the free tier's operation limits and connection caps for 5 role users plus the dashboard's streams.
- **`errInfo.details` on Atlas.** It should match, since it is the same server version family, but confirm on the cluster's actual MongoDB version, which may be 7.0 or 8.x.
- **Resume-token lifetime against the Atlas oplog window**, for E3/E4 and C8.
- **The `mongodb/mongodb-atlas-local` image** was not run, because the Docker daemon was not running. `docker-compose.yml` is untested.
