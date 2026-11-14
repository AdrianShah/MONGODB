# Phase 0 + 1 — Orchestration

How the foundation work in [PRD.md](PRD.md) section 11 is split across parallel agents. Branch: `feat/phase-0-1-foundation`.

## Ground rules (every agent, human or AI)

1. **Stay in your lane.** Create and edit only the files in your ownership row below. Read anything.
2. **Edit through the editor tools, not the shell.** Hivelane sees `Edit` / `Write` tool calls. It does not see `sed -i`, `>` redirects, or `mv`.
3. **If Hivelane blocks an edit,** run `hivelane wait <file>` and retry. If it is still blocked, stop and report.
4. **Do not touch `package.json`, the lockfile, or `tsconfig*.json`** after Wave 0. Every dependency Phase 1 needs is declared up front. A missing dependency is reported, not installed.
5. **No git operations** by agents: no commit, push, switch, stash, or reset. The orchestrator integrates.
6. **Tests run against a real MongoDB.** With `MONGODB_URI` unset, the test harness starts an in-memory replica set with auth. No Docker or Atlas needed.

## Waves

### Wave 0 — one agent, alone

Spike and scaffold. Nothing else starts until this is done, because everything imports from it.

| Owns | Delivers |
|---|---|
| `package.json`, lockfile, `tsconfig*.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `docker-compose.yml` | Workspace that installs and runs with no build step |
| `packages/shared/src/{index,config,collections,types,db}.ts` | Collection names, document types, per-role connection helper |
| `packages/shared/src/{policy,schema,roles}.ts` as **signature-only stubs** | The contracts Wave 1 fills in |
| `tests/helpers/**` | Harness: in-memory replica set with auth, or `MONGODB_URI` |
| `scripts/spike.ts`, `tests/spike/**`, `docs/SPIKE.md` | Phase 0 answers: collection-level custom roles, error 121 `errInfo` details, Change Streams, transactions |

### Wave 1 — three agents in parallel

| Agent | Owns | Delivers | Test plan |
|---|---|---|---|
| **A. Schema** | `packages/shared/src/policy.ts`, `packages/shared/src/schema.ts`, `tests/validators/**` | Policy → validator builder for `intents`, `approved`, `budgets`; unique indexes; `applySchema()` | V1 to V53 |
| **B. Access** | `packages/shared/src/roles.ts`, `scripts/setup.ts`, `scripts/redteam.ts`, `scripts/atlas-roles.ts`, `tests/roles/**`, `docs/ATLAS_SETUP.md` | Five roles and users, idempotent setup, red-team script, Atlas role definitions | R1 to R26, O1 |
| **C. Data** | `scripts/seed.ts`, `scripts/reset.ts`, `data/seed/**`, `tests/ops/**` | Customers, orders, 12 tickets (8 small, 2 mid, 1 large, 1 prompt injection); fast reset | O2, O5 |

Cross-lane dependencies: B and C call A's `applySchema()`. Wave 0 ships a working no-validator version so they are never blocked. Tests in B that need A's validators or indexes (R1, R10) go green at integration.

### Integration — orchestrator

Run the full suite, route failures back to the owning agent, check the result against the Phase 1 exit criteria (TEST_PLAN sections 1 and 2 pass), then write the README setup section.

## Phase 2 — executor integration

The executor lives on `feat/executor` (owner: Hossein). It was reviewed against the foundation by merging the two in a scratch copy: the merge is clean, 21 of 21 unit tests and 9 of 9 chaos tests pass (50 randomized crash runs, zero duplicate or lost payouts), and it runs correctly as the real `executor_role` user against the real validators and seed data.

**Merge order:** `feat/phase-0-1-foundation` merges to `main` first. `feat/executor` then rebases onto `main`.

The plan changed in four places as a result of the review (PRD section 7 "Orders", "Ledger entry", "Two idempotency keys"; requirements E2, E3, E5, E7, E9, T2, T4). The checklist below brings the code in line. All of it is in the executor's lane unless marked.

| # | Change | Where | Plan ref |
|---|---|---|---|
| 1 | Read the order's `payment_id`, not `payment_ref`. Refuse the payout when it is missing. | `packages/executor` | E5, I12a |
| 2 | Send the ledger entry's `source_id` to the provider as the idempotency key, instead of the proposal's `idempotency_key`. | `packages/executor` | E2, I12c, O2a |
| 3 | Refuse a payout when another `pending` or `succeeded` ledger entry exists for the same `ticket_id`. | `packages/executor` | E5, I12b |
| 4 | Reconcile each pending entry in its own try/catch, so one bad entry cannot block the rest or crash startup. | `packages/executor` | E3, I12d |
| 5 | Wait before reopening a Change Stream that ended without an error, so a dropped collection cannot cause a tight loop. | `packages/executor` | E1 |
| 6 | Replace the local document types with imports from `@escrowops/shared`, and update `LedgerDoc` there to the shape in PRD section 7. | `packages/executor`, `packages/shared/src/types.ts` | E9 |
| 7 | Connect with `connectAs('executor')` from the shared config instead of `EXECUTOR_MONGODB_URI`. | `packages/executor` | E9 |
| 8 | Move the tests onto the shared harness (`tests/helpers`), so they use `applySchema`, `applyRoles` and the in-memory replica set instead of a private fixture and Docker. Add the executor's unit tests to the root Vitest `include`; keep chaos as `npm run test:chaos`. | `packages/executor`, root `vitest.config.ts`, root `package.json` | O2b |
| 9 | `npm run seed` with `PAYMENTS=stripe` creates a fresh test payment per ticket order; `npm run reset` clears the fake provider when `FAKE_PROVIDER_URL` is set. | `scripts/lib/seed-data.ts`, `scripts/reset.ts` | T2, T4 |
| 10 | Run `npm install` at the root after rebasing and commit the lockfile (the package adds `stripe`). | root | — |
| 11 | Run the Stripe provider once against a test key and note the result; it has never been exercised. | manual | TEST_PLAN section 4 |

Items 6, 8, 9 and 10 touch files outside `packages/executor`. They are assigned to the executor's owner for this phase so one person makes each change; nobody else should edit those files until `feat/executor` merges.

Not in this phase: the daily budget (E6). When it is built, `executor_role` needs `insert` on `review_queue`.

## Decisions

| Decision | Why |
|---|---|
| The provider idempotency key is the ledger `source_id`, not the proposal's `idempotency_key` | The proposal key is the same on every run of a ticket, so after a reset the provider replayed the previous run's refund. A source document's `_id` is stable across retries and new after a reset. |
| One payout per ticket is checked by the executor | With separate keys, the provider no longer rejects a second payout for the same ticket, so the executor must |
| `orders.payment_id` and the executor's ledger shape are canonical | Seed data and shared types already use `payment_id`; the ledger shape is the one in working, tested code |
| In-memory replica set as the default test database | Docker is not running on every machine; this needs zero setup and still gives real validators, roles, Change Streams, and transactions |
| One shared working tree, no per-agent worktrees | Hivelane coordinates files in this checkout; worktrees would reintroduce merges |
| Seed uses fake payment IDs | Stripe seeding needs the `PaymentProvider` from Phase 2 and a test key |
| Atlas role creation is generated, not executed | No Atlas credentials yet; `scripts/atlas-roles.ts` emits the definitions and `docs/ATLAS_SETUP.md` says how to apply them |

## Still needed from humans

- Atlas connection string and, for custom roles, an Atlas API key or someone to click through the UI.
- Stripe test secret key (Phase 2).
