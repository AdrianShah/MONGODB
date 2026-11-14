# @escrowops/executor

Watches `intents` and `approved` through Change Streams and pays each refund exactly once (PRD E1 to E5, E7, E8). It connects as `escrow_executor` (`executor_role`) and has no LLM in it.

## Run

From the repo root, after `npm run setup` and `npm run seed`:

```sh
npm run fake-provider   # terminal 1, only for PAYMENTS=fake-http
npm run executor        # terminal 2
```

The database connection uses the shared config (`MONGODB_URI`, `MONGODB_DB`, `EXECUTOR_DB_USER`, `EXECUTOR_DB_PASSWORD`). Executor-only settings:

| Variable | Meaning |
|---|---|
| `PAYMENTS` | `stripe` (default), `fake-http`, or `fake` (in memory, lost on restart) |
| `STRIPE_SECRET_KEY` | Required for `stripe`; live keys are refused |
| `FAKE_PROVIDER_URL` | Required for `fake-http` (`npm run fake-provider` listens on `http://127.0.0.1:4700`) |
| `CRASH_AT`, `CRASH_ON_HIT` | Chaos: SIGKILL at point 1 to 4, on the n-th time it is reached |

## How a payout runs

1. Insert a `ledger` entry `pending` with `source_id` = the intent's or approved document's `_id`. The unique index on `source_id` means a replayed event, the startup sweep, or a second executor gets E11000 and stops.
2. Check the order exists, belongs to the customer, and has enough refundable amount left, counting `refunded_cents` and other ledger entries (E5). On failure the entry becomes `failed` with a reason and the provider is never called. On success, `checks_passed: true` is recorded **before** the provider call.
3. Refund the order's `payment_id` with the source's `idempotency_key`. Transient errors retry with the same key; permanent errors mark the entry `failed`.
4. Mark the entry `succeeded` with the refund ID, then save the stream's resume token in `executor_state`.

On startup it reconciles every `pending` entry (retry with the same key if checks passed, re-check otherwise), sweeps sources with no ledger entry (E4), and resumes the streams. Crash points 1 to 4 sit between those steps.

Ledger entries are the shared `LedgerDoc` plus `ticket_id`, `checks_passed`, `owner` and `attempts` (see `ExecutorLedgerDoc` in `src/types.ts`).

## Tests

- `tests/executor/`: in-process with `FakeProvider` (I1, I11 to I14, E3, E4, O5). Part of `npm test`.
- `tests/chaos/`: `npm run test:chaos`. C1 to C9 with real executor processes killed by SIGKILL; `CHAOS_RUNS` sets C5's repeat count (default 50). C10 (approval service) and C11 (needs a proxy) are not covered here.

Both use the shared harness and the real schema, roles and users from `setUpAccess`.
