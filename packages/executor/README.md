# @escrowops/executor

Watches `intents` and `approved` through Change Streams and pays each refund exactly once (PRD E1 to E5, E7, E8). It runs as the `executor` database user and has no LLM in it.

## Run

```sh
EXECUTOR_MONGODB_URI=... PAYMENTS=fake-http FAKE_PROVIDER_URL=http://127.0.0.1:4700 npm start
```

| Variable | Meaning |
|---|---|
| `EXECUTOR_MONGODB_URI` | Connection string for the executor user (required) |
| `MONGODB_DB` | Database name, default `escrowops` |
| `PAYMENTS` | `stripe` (default), `fake-http`, or `fake` (in memory, lost on restart) |
| `STRIPE_SECRET_KEY` | Required for `stripe`; live keys are refused |
| `FAKE_PROVIDER_URL` | Required for `fake-http`; start one with `npm run fake-provider` |
| `CRASH_AT`, `CRASH_ON_HIT` | Chaos: SIGKILL at point 1 to 4, on the n-th time it is reached |

The `.env` at the repo root is loaded if present.

## How a payout runs

1. Insert a `ledger` entry `pending`. The unique index on `source_id` means a replayed event, the startup sweep, or a second executor gets E11000 and stops.
2. Check the order exists, belongs to the customer, and has enough refundable amount left (E5). On failure the entry becomes `failed` with a reason, and the provider is never called. On success, `checks_passed: true` is recorded **before** the provider call.
3. Call the provider with the source's `idempotency_key`. Transient errors retry with the same key; permanent errors mark the entry `failed`.
4. Mark the entry `succeeded` with the refund ID, then save the stream's resume token.

On startup it reconciles every `pending` entry (retry with the same key if checks passed, re-check otherwise), sweeps sources with no ledger entry (E4), and resumes the streams from `executor_state`. Crash points 1 to 4 sit between those steps.

## Data it expects

Orders: `{ _id: <order_id>, customer_id, amount_cents, payment_ref, refunded_cents? }`, where `payment_ref` is the Stripe PaymentIntent (`pi_...`) or charge (`ch_...`). The seed script needs to write orders in this shape.

## Tests

Needs a replica set. Locally: `docker run -d --name escrowops-mongo -p 27017:27017 -e MONGODB_INITDB_ROOT_USERNAME=admin -e MONGODB_INITDB_ROOT_PASSWORD=admin mongodb/mongodb-atlas-local:8.0`, or point `MONGODB_TEST_URI` at an admin connection.

- `npm test`: 21 in-process tests with `FakeProvider` (I1, I11 to I14, E3, E4, O5)
- `npm run test:chaos`: C1 to C9 except C10 and C11, with real processes killed by SIGKILL. `CHAOS_RUNS` sets C5's repeat count (default 50).

The test fixture creates its own collections, indexes and a scoped `executor_role`. Swap it for Phase 1's `npm run setup` once that exists.
