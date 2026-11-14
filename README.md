# EscrowOps

An AI agent resolves refund disputes. **MongoDB decides which of its decisions are allowed to move money.**

> Assume the agent is fully compromised. It still cannot move more than $500 per refund, cannot forge an approval, cannot edit its own history, and cannot cause a double payout.

Each part of that claim is enforced by the database — schema validators, collection-level roles, unique indexes — not by agent code. The demo proves it by logging in with the agent's own credentials and attacking the database.

**Track:** Agents You Can Audit (with a crash-recovery beat from Finish the Job)

## Why this exists

Support teams want agents that issue refunds end to end. Nobody ships them, because the guardrails live in the same process as the model. Fool the model and you've fooled the guardrail.

EscrowOps moves the guardrail into MongoDB, where the agent cannot reach it.

## How it works

```
tickets ──> AGENT (Claude) ──insert──> intents ──────────────┐
                  │                    (validator: ≤ $500)   │
                  │ on rejection                             ▼
                  └──insert──> review_queue              EXECUTOR ──> Stripe
                                    │                         ▲
                                    ▼                         │
                            humans approve ──insert──> approved
                                               (validator: N distinct
                                                approvers, ≤ $10k)
```

| Process | Role | LLM? |
|---|---|---|
| **Agent** | Proposes refunds into `intents` or `review_queue` | Yes |
| **Approval service** | Humans write to `approved` — a collection the agent cannot touch | No |
| **Executor** | Change Streams → Stripe; ledger + unique index = exactly-once | No |

**Policy tiers** (amounts in the active `policies` document):

| Tier | Amount | Requirement |
|---|---|---|
| Auto | ≤ $500 | Agent write alone |
| Peer review | $500.01 – $2,000 | 1 approver |
| Dual control | $2,000.01 – $10,000 | 2 distinct approvers |
| Blocked | > $10,000 | Rejected by validator |

## What MongoDB enforces

| Attack | Defense |
|---|---|
| Insert a $50,000 refund | Schema validator (error 121) |
| Forge approvals into `approved` | Role has no write privilege |
| Edit an earlier refund's amount | Role cannot update that collection |
| Drop or bypass the validator | Role cannot run `collMod` / `bypassDocumentValidation` |
| Double payout after a crash | Unique index on ledger `source_id` + Change Stream resume tokens |
| Agent goes rogue mid-run | Kill switch: an unsatisfiable `$jsonSchema` validator on `intents`/`review_queue` (its next write gets code 121, works on Atlas), plus `updateRole` where allowed (code 13); unpaid intents are voided by ledger tombstones the unique index protects |

Run the attacks yourself:

```bash
npm run redteam
```

Five attempts, five denials, zero payouts — all from the MongoDB server.

### Prompt injection: the model is fooled, the database is not

Ticket T-1012 hides a fake "internal support note" ordering a $50,000 refund. The honest agent ignores it, but that only proves the prompt. So:

```bash
npm run demo:jailbreak     # alias: npm run jailbreak
```

runs the agent in **compromised mode**: guardrails stripped from the system prompt, a scripted model that obeys the injection (no `ANTHROPIC_API_KEY` needed; `-- --live` uses Claude instead), extra hijack tools, and the agent's own database user. It asks for $50,000 (**121**, validator), writes forged approvals to `approved`, forces a payout with `bypassDocumentValidation` and tries to rewrite its own trace (all **13**, roles). Every refusal is a `rejected_write` event in `agent_traces` under the run's trace id; the dashboard card shows **Injection attempt blocked** and the audit timeline lists each one. Nothing reaches `intents`, `approved` or `ledger`.

### Stopping an agent mid-run

**Freeze agent** on the dashboard (or `npm run agent:freeze`) asks the approval service, as a signed-in approver (`POST /api/agent/freeze`), to freeze the agent over a short-lived admin connection. `collMod` puts an unsatisfiable `$jsonSchema` (titled "EscrowOps kill switch: agent frozen") on `intents` and `review_queue`, so the agent's already-open connection gets `MongoServerError` code 121 on its next proposal and the batch stops. This works on Atlas. Where the server allows role management (local mongod), `updateRole agent_role` also drops its insert privilege, and the agent gets code 13 first; on Atlas that step is skipped and recorded. Every intent not yet paid is voided: a `failed` ledger tombstone takes its `source_id`, so the unique index stops the executor from ever claiming it; pending reviews are marked rejected. A payout already past its checks is left to finish, never paid twice. Who froze, when, why and what was voided goes into the append-only `kill_switch` collection and shows on the audit timeline. Re-running setup or apply-policy does not unfreeze. `npm run agent:unfreeze` restores the validators from the active policy and the role from `roles.ts`.

## Quick start

Needs **Node 22+**. Tests need no Docker or Atlas account.

```bash
npm install
npm test
```

Tests spin up an in-memory MongoDB replica set with auth. The first run downloads a MongoDB binary (~80 MB).

### Run against a real database

1. Copy `.env.example` → `.env`
2. Set `MONGODB_URI` (pick one):

| Option | How |
|---|---|
| In-memory | `npm run db` in another terminal; paste the printed URI into `.env` |
| Docker | `docker compose up -d`; use the Docker URI from `.env.example` |
| Atlas | Atlas URI + [docs/ATLAS_SETUP.md](docs/ATLAS_SETUP.md) for roles |

3. Then:

```bash
npm run setup      # collections, validators, indexes, roles, users
npm run seed       # demo customers, orders, dispute tickets, policy
npm run redteam    # attack with the agent's credentials — all denied
```

| Command | What it does |
|---|---|
| `npm run batch` | Agent works every open ticket (needs `ANTHROPIC_API_KEY`) |
| `npm run demo:jailbreak` | Compromised agent obeys T-1012's injected $50,000 refund; MongoDB refuses every write (no API key) |
| `npm run executor` | Pays approved refunds via Stripe test mode or fake provider |
| `npm run reset` | Clear run data and re-seed; keep schema and roles |
| `npm run test:chaos` | Kill the executor mid-payout; assert exactly one refund |
| `npm run agent:freeze -- "reason"` | Kill switch: MongoDB rejects the agent's writes (validator, + role where allowed), void unpaid refunds, audit it (`npm run freeze` is an alias) |
| `npm run agent:unfreeze` | Restore the validators and the agent role (`npm run unfreeze` is an alias) |

## Voice for approvers (ElevenLabs)

Held refunds have a **Listen** button: the dashboard reads the card aloud (amount, tier, the agent's reason and evidence, the validator rule it broke, and "1 of 2" progress). The audit timeline has **Narrate audit trail**: a short spoken reconstruction of the ticket, the agent's tool calls, the validator decision, the approvers and the payout ID.

- Scripts are deterministic templates over data the dashboard already shows; no LLM.
- Audio comes from ElevenLabs text-to-speech, called by the dashboard server with `ELEVENLABS_API_KEY` (and optional `ELEVENLABS_VOICE_ID`). The key never leaves the server; the dashboard's database access stays read-only.
- Audio is cached per card version, so each version costs credits once.
- Approvers only, even with `DASHBOARD_PUBLIC=1`.
- No key, or ElevenLabs down: the same script is spoken by the browser's `speechSynthesis`, so the demo never breaks.
- **Voice never approves.** Approving still takes the signed-in Approve click, which goes to the approval service and the `approved` validator.

## Demo

Timed script, fallbacks, and likely judge Q&A: **[docs/DEMO.md](docs/DEMO.md)**

The line we want judges to remember:

> We gave the attacker the agent's own database password, and MongoDB still said no.

## Repo layout

```
packages/shared/     types, policy, validators, indexes, roles, connections
packages/agent/      Claude batch runner (proposes refunds)
packages/executor/   Change Stream worker → Stripe / fake provider
scripts/             setup, seed, reset, redteam, spike, dev database
data/seed/           demo dataset and expected outcomes per ticket
tests/               validators, roles, agent, executor, chaos, integration
docs/                PRD, test plan, demo script, Atlas setup
```

## Docs

| Doc | Covers |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Problem, policy, architecture, requirements |
| [docs/TEST_PLAN.md](docs/TEST_PLAN.md) | Every test case by ID |
| [docs/DEMO.md](docs/DEMO.md) | 3.5-minute demo script + judge Q&A |
| [docs/ATLAS_SETUP.md](docs/ATLAS_SETUP.md) | Roles and users on Atlas |
| [packages/agent/README.md](packages/agent/README.md) | Agent tools, traces, env |
| [packages/executor/README.md](packages/executor/README.md) | Payout flow, crash recovery, env |
