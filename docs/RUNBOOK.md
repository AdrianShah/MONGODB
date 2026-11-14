# EscrowOps — Demo Runbook

The commands behind [DEMO.md](DEMO.md). Read that for the script; this file covers setup, fallbacks and rehearsal.

## Once per machine

```sh
npm install
cp .env.example .env        # set MONGODB_URI (Atlas or `npm run db` for local Docker)
npm run setup               # collections, validators, indexes, roles, users
npm run web:build           # dashboard UI
```

For the live agent, set `ANTHROPIC_API_KEY`. For real Stripe refunds, set `PAYMENTS=stripe` and `STRIPE_SECRET_KEY=sk_test_...`; `npm run seed` then creates a fresh test payment for every ticket's order.

## Before going on (about 2 minutes)

| Terminal | Command | Stays open for |
|---|---|---|
| 1 (small) | `npm run services` | Approval service, dashboard, and the fake provider when `PAYMENTS=fake-http` |
| 2 (right bottom) | `npm run executor` | Executor logs; killed and restarted on stage |
| 3 (right top, large font) | `npm run reset`, then the commands below | Batch, red team, demo:kill |

Open http://127.0.0.1:4100 twice: as `approver-a` on the laptop and `approver-b` on the second device (same network: set `DASHBOARD_HOST=0.0.0.0`). Default passwords: `approver-a-dev-password`, `approver-b-dev-password`.

Pre-type in terminal 3's history: `npm run batch`, `npm run redteam`, `npm run demo:kill`.

## On stage

| Beat | Command | What appears |
|---|---|---|
| 0:20 small refunds | `npm run batch` | One line per ticket: `✔ $89.00 auto-approved -> intents`; cards move to Paid |
| 0:55 $5,000 stopped | (same batch) | `MongoServerError: Document failed validation (code 121)` / `amount_cents: 500000 — maximum 50000` / `→ routed to review_queue (human_required, needs 2 approvals)`; card in Held on both screens |
| 1:35 second key | Approve on both devices | `1 of 2`, then Paid within a second; executor logs the refund ID |
| 1:55 red team | `npm run redteam` | Five attacks, five denials, `Payouts caused: 0` |
| 2:40 kill | `npm run demo:kill` | Terminal 2 shows `Killed`. Press up and Enter to restart: `resuming from saved token`, `reconciling pending payout ...`, `reconciled ...: provider returned re_... for the same key (no second refund)` |
| 3:10 audit | Click the $5,000 card, then **Audit timeline** | Tool calls, validator rejection, both approvals, promotion, ledger, refund ID |

`demo:kill` signals the running executor (it registers its PID in `executor_state`) to SIGKILL itself after its next provider call and before the ledger update, then queues one approved $25 refund (`DEMO-KILL-...`) so that payout happens.

## Fallbacks (decide in five seconds)

| Problem | Do this |
|---|---|
| Model slow or no API key | `npm run batch -- --replay`. Replays the last live run (saved to `.escrowops/last-run.json`), or the seed data's expected outcomes, through the real agent code and database. Say "this is a replay of the model's decisions; every database write is live". |
| Stripe slow | Set `PAYMENTS=fake-http` in `.env`, restart terminals 1 and 2 |
| Atlas or wifi down | Point `MONGODB_URI` at the local Docker database (`npm run db`), `npm run setup`, `npm run reset` |
| Dashboard stale | Reload; state comes from the database |
| Second device fails | Second browser window as approver-b |

## Rehearse

```sh
MONGODB_DB=escrowops_rehearsal npm run demo:rehearse          # 3 runs
```

This runs the whole script with real processes (its own fake provider, approval service, dashboard and executor) and checks the invariants after each run: 9 auto refunds and the $5,000 paid, the same approver refused twice, all red-team attacks denied, the executor SIGKILLed mid-payout and reconciled, and every refund paid exactly once at the provider and in the ledger. It **resets** the database it points at, so use a separate one. About 3 seconds per run.

Also before each rehearsal (TEST_PLAN section 8): `npm run test:chaos` and `npm run test:e2e`.
