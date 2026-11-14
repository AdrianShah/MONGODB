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

## Decisions

| Decision | Why |
|---|---|
| In-memory replica set as the default test database | Docker is not running on every machine; this needs zero setup and still gives real validators, roles, Change Streams, and transactions |
| One shared working tree, no per-agent worktrees | Hivelane coordinates files in this checkout; worktrees would reintroduce merges |
| Seed uses fake payment IDs | Stripe seeding needs the `PaymentProvider` from Phase 2 and a test key |
| Atlas role creation is generated, not executed | No Atlas credentials yet; `scripts/atlas-roles.ts` emits the definitions and `docs/ATLAS_SETUP.md` says how to apply them |

## Still needed from humans

- Atlas connection string and, for custom roles, an Atlas API key or someone to click through the UI.
- Stripe test secret key (Phase 2).
