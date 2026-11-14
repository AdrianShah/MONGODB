# EscrowOps

An AI agent resolves refund disputes, and MongoDB decides which of its decisions are allowed to move money.

> Assume the agent is fully compromised. It still cannot move more than $500 per refund, cannot forge an approval, cannot edit its own history, and cannot cause a double payout.

Each part of that claim is enforced by the database (schema validators, collection-level roles, unique indexes), not by agent code.

## Docs

| Doc | What it covers |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Problem, policy tiers, architecture, data model, requirements, build plan |
| [docs/TEST_PLAN.md](docs/TEST_PLAN.md) | Every test case, by ID |
| [docs/DEMO.md](docs/DEMO.md) | Timed demo script, fallbacks, judge Q&A |
| [docs/SPIKE.md](docs/SPIKE.md) | Phase 0 findings: real error codes and shapes |
| [docs/ATLAS_SETUP.md](docs/ATLAS_SETUP.md) | Creating the roles and users on Atlas |
| [docs/ORCHESTRATION.md](docs/ORCHESTRATION.md) | How work is split into lanes so parallel agents do not collide |

## Status

| Phase | State |
|---|---|
| 0. Spike | Done locally. Atlas-specific checks still open (see docs/SPIKE.md). |
| 1. Foundation | Done: validators, indexes, roles, setup, seed, reset, red team. |
| 2. Executor | Built on `feat/executor` and reviewed. Integration checklist in [docs/ORCHESTRATION.md](docs/ORCHESTRATION.md). |
| 3. Agent | Not started |
| 4. Approval service | Not started |
| 5. Dashboard | Not started |

## Quick start

Needs Node 22 or newer. No Docker or Atlas account required for tests.

```bash
npm install
```

```bash
npm test
```

Tests start their own in-memory MongoDB replica set with auth. The first run downloads a MongoDB binary (about 80 MB).

## Running the scripts

The scripts need a real server in `MONGODB_URI`. Pick one:

| Option | How |
|---|---|
| In-memory (no install) | `npm run db` in one terminal, copy the printed `MONGODB_URI` into `.env` |
| Docker | `docker compose up -d`, then use the Docker URI from `.env.example` |
| Atlas | Put the Atlas URI in `.env` and follow [docs/ATLAS_SETUP.md](docs/ATLAS_SETUP.md) for roles |

Copy `.env.example` to `.env` first. Then:

| Command | What it does |
|---|---|
| `npm run setup` | Creates collections, validators, indexes, the five roles and their users. Safe to re-run. |
| `npm run seed` | Loads 12 customers, 25 orders, 12 dispute tickets and the active policy |
| `npm run redteam` | Logs in as the agent and attacks the database five ways; every attack must be denied |
| `npm run reset` | Clears run data and re-seeds, keeping validators, indexes, roles and users |
| `npm run spike` | Re-runs the Phase 0 checks against whatever `MONGODB_URI` points at |
| `npm run typecheck` | TypeScript, no emit |

## Layout

```
packages/shared/   collection names, types, policy, validators, indexes, roles, connections
scripts/           setup, seed, reset, redteam, spike, dev database
data/seed/         demo dataset and expected outcomes per ticket
tests/             validators, roles, ops, spike, shared harness
docs/
```

## Working in parallel

This repo uses [Hivelane](.hivelane.toml) so several people and their coding agents can edit one checkout safely. Before starting, read the ground rules in [docs/ORCHESTRATION.md](docs/ORCHESTRATION.md): stay in your lane, edit through your agent's editor tools, and leave `package.json` and the lockfile to one owner.
