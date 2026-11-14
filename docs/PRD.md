# EscrowOps — Product Requirements

**One line:** An AI agent resolves refund disputes, and MongoDB decides which of its decisions are allowed to move money.

**Track:** Agents You Can Audit (primary), with a crash-recovery moment from Finish the Job.

Companion docs: [TEST_PLAN.md](TEST_PLAN.md), [DEMO.md](DEMO.md).

---

## 1. Problem

Support teams want agents to resolve disputes end to end, including issuing the refund. Nobody lets them, because the guardrails live in the same process as the model. If the agent is confused, buggy, or prompt-injected, the guardrail goes with it.

The missing piece is a control point the agent cannot talk its way past, plus a record good enough that a reviewer can reconstruct why any dollar moved.

## 2. Core claim

> Assume the agent is fully compromised. It still cannot move more than $500 per refund, cannot forge an approval, cannot edit its own history, and cannot cause a double payout.

Every part of that sentence is enforced by MongoDB (validators, role privileges, unique indexes), not by agent code. The demo proves it by attacking the database with the agent's own credentials.

## 3. Goals and non-goals

**Goals**

1. Small refunds clear with no human in the loop.
2. Larger refunds are held and released only by the required number of distinct humans.
3. The agent's database user is unable to bypass either rule.
4. Each refund pays out exactly once, including across process crashes.
5. Any payout can be traced from ticket to model reasoning to approvals to the Stripe refund ID.

**Non-goals**

- Real money. Stripe test mode only.
- Production authentication. Two seeded approver accounts with session cookies.
- Multi-currency, partial captures, chargebacks.
- Protection against a malicious database admin. The trust boundary is the agent, not the DBA.

## 4. Users

| User | Needs |
|---|---|
| Support ops lead | Refunds resolved fast, without reading every ticket |
| Approver (finance / senior support) | A short queue of held refunds with the evidence attached |
| Auditor / reviewer | A complete, tamper-resistant trail per refund |
| Hackathon judge | To see the guardrail hold under attack in under four minutes |

## 5. Policy

Amounts are stored as integer cents (`amount_cents`).

| Tier | Amount | Requirement | Path |
|---|---|---|---|
| `single_agent` | up to $500 | none | agent → `intents` → executor |
| `peer_review` | $500.01 to $2,000 | 1 approver | agent → `review_queue` → `approved` → executor |
| `human_required` | $2,000.01 to $10,000 | 2 distinct approvers | same as above |
| blocked | over $10,000 | not possible in this pipeline | rejected by the `approved` validator |

Thresholds live in a `policies` document. An admin script turns the active policy into validators with `collMod`. Only the admin role can run it.

## 6. Architecture

```
tickets ──> AGENT (Claude + tools) ──insert──> intents ──────────────┐
                    │                          (validator: ≤ $500)   │
                    │ on error 121                                   ▼
                    └──insert──> review_queue                    EXECUTOR ──> Stripe (test)
                                      │ change stream                ▲   │
                                      ▼                              │   └──> ledger
                              APPROVAL SERVICE ──insert──> approved ─┘
                              (humans, no LLM)   (validator: approver count,
                                                  distinct, ≤ $10,000)
```

Four processes, each with its own database user:

| Process | What it does | Contains an LLM |
|---|---|---|
| **Agent** | Reads a ticket, pulls order and customer history, proposes a refund | Yes |
| **Executor** | Watches `intents` and `approved` through Change Streams, pays out, writes the ledger | No |
| **Approval service** | HTTP + WebSocket API behind the dashboard; records approvals; promotes fully approved reviews into `approved` | No |
| **Dashboard** | Live pipeline, approval queue, audit timeline | No |

The executor trusts exactly two collections. Each is guarded by something the agent cannot change:

- `intents`: the agent can write here, but the validator caps every document at $500.
- `approved`: the validator allows larger amounts, but the agent has no write privilege.

### Why approvals are not a field on the intent

A validator checks a document's shape, not who wrote it, and MongoDB roles cannot restrict individual fields. If approvals lived inside the intent, the agent could insert an intent with approvals already filled in. Separating the collections turns "who approved" into a privilege check the server enforces.

## 7. Data model

### Collections

| Collection | Written by | Purpose |
|---|---|---|
| `tickets`, `orders`, `customers` | seed script | Source data the agent reads |
| `policies` | admin | Versioned thresholds |
| `agent_traces` | agent (insert only) | Every tool call and the model's stated reasoning, per `trace_id` |
| `intents` | agent (insert only) | Auto-approvable refund proposals |
| `review_queue` | agent (insert), approval service (status updates) | Proposals the validator rejected, with the server's error attached |
| `approvals` | approval service | One document per approver decision |
| `approved` | approval service (insert only) | Fully approved refunds, ready to execute |
| `ledger` | executor | One entry per payout, `pending` then `succeeded` or `failed` |
| `budgets` | executor | Daily auto-refund spend against a cap |
| `executor_state` | executor | Change Stream resume tokens |

### `intents` validator

```js
{
  $jsonSchema: {
    bsonType: "object",
    additionalProperties: false,
    required: ["_id", "trace_id", "ticket_id", "order_id", "customer_id",
               "amount_cents", "currency", "reason", "evidence",
               "policy_version", "idempotency_key", "created_at"],
    properties: {
      _id: { bsonType: "objectId" },
      trace_id: { bsonType: "string" },
      ticket_id: { bsonType: "string" },
      order_id: { bsonType: "string" },
      customer_id: { bsonType: "string" },
      amount_cents: { bsonType: ["int", "long"], minimum: 1, maximum: 50000 },
      currency: { enum: ["usd"] },
      reason: { bsonType: "string", minLength: 20, maxLength: 2000 },
      evidence: { bsonType: "array", minItems: 1, items: { bsonType: "object" } },
      policy_version: { enum: [1] },
      idempotency_key: { bsonType: "string" },
      created_at: { bsonType: "date" }
    }
  }
}
```

`validationLevel: "strict"`, `validationAction: "error"`.

### `approved` validator

```js
{
  $and: [
    { $jsonSchema: { /* same core fields, plus review_id and approvals[];
                        amount_cents maximum: 1000000; approvals minItems: 1 */ } },
    // approvers are distinct
    { $expr: { $eq: [
        { $size: "$approvals.approver_id" },
        { $size: { $setUnion: ["$approvals.approver_id", []] } }
    ] } },
    // over $2,000 needs a second approver
    { $or: [
        { amount_cents: { $lte: 200000 } },
        { "approvals.1": { $exists: true } }
    ] }
  ]
}
```

### `budgets` validator

```js
{ $expr: { $lte: ["$spent_cents", "$cap_cents"] } }
```

The executor reserves budget with an atomic `$inc`. If the increment would exceed the cap, the server rejects the update, so even a buggy executor cannot overspend the daily auto-refund budget.

### Unique indexes

| Index | Prevents |
|---|---|
| `intents.idempotency_key` | Two proposals for the same ticket and order |
| `review_queue.idempotency_key` | Same, on the held path |
| `approvals (review_id, approver_id)` | One person approving twice |
| `approved.review_id` | A review being promoted twice |
| `ledger.source_id` | Two payouts for one intent or approval |

### Orders

The executor issues refunds against `orders.payment_id` (a Stripe PaymentIntent or charge ID, or a `pi_fake_...` ID with the fake provider). It reads `amount_cents` and `refunded_cents` for the refundable check and never writes to `orders`; refunds made through EscrowOps are counted from the ledger.

### Ledger entry

One document per source document, written only by the executor. This shape is the contract the dashboard's audit timeline reads; `LedgerDoc` in `@escrowops/shared` must match it.

| Field | Meaning |
|---|---|
| `source_id` | `"<collection>:<source _id as hex>"`, for example `intents:66f0...`. Unique. Also the idempotency key sent to the payment provider. |
| `source_collection` | `intents` or `approved` |
| `source_doc_id` | The source document's `_id` |
| `trace_id`, `ticket_id`, `order_id`, `customer_id`, `amount_cents`, `currency` | Copied from the source document |
| `status` | `pending`, then `succeeded` or `failed` |
| `checks_passed` | Set once the pre-payout checks pass. A `pending` entry with this set may already have been paid, so recovery retries it and never re-checks. |
| `owner`, `attempts` | Which executor instance holds it, and how many provider calls were made |
| `provider`, `provider_refund_id`, `failure_reason` | Outcome |
| `created_at`, `updated_at` | Timestamps |

### Two idempotency keys, two jobs

| Key | Where | Job |
|---|---|---|
| `idempotency_key` = hash of ticket ID and order ID | On every proposal (`intents`, `review_queue`, `approved`) | Stops the agent proposing the same ticket twice, through the unique indexes |
| `source_id` | Ledger, and sent to the provider | Stops one source document being paid twice, across retries and crashes |

They are separate on purpose. The provider key must be stable across retries of one source document but new after `npm run reset`, otherwise a second rehearsal replays the first run's refunds instead of creating new ones. A source document's `_id` has exactly that lifetime.

### Roles

| Role | Privileges |
|---|---|
| `agent_role` | `find` on tickets, orders, customers, policies. `insert` on agent_traces, intents, review_queue. Nothing else. |
| `approver_role` | `find` + `changeStream` on review_queue. `update` on review_queue. `find` + `insert` on approvals. `insert` on approved. |
| `executor_role` | `find` + `changeStream` on intents, approved. `find`, `insert`, `update` on ledger, budgets, executor_state. `find` on orders. |
| `dashboard_role` | `find` + `changeStream` on everything. No writes. |
| `admin_role` | `collMod`, index management, policies. Used only by setup scripts. |

No runtime role has `update` or `remove` on `intents`, `approved`, `approvals`, or `agent_traces`, so those are append-only. No runtime role has `collMod` or `bypassDocumentValidation`.

## 8. Functional requirements

Priority: **P0** must ship for the demo, **P1** should ship, **P2** stretch.

### Agent

| ID | Requirement | Pri |
|---|---|---|
| A1 | Tools: `get_ticket`, `get_order`, `get_customer_history`, `propose_refund`. | P0 |
| A2 | `propose_refund` inserts into `intents`. On server error 121 it inserts the same proposal into `review_queue` with the server's `errInfo` attached. | P0 |
| A3 | Every tool call and the final reasoning are written to `agent_traces` under one `trace_id`. | P0 |
| A4 | `idempotency_key` is a hash of ticket ID and order ID, so re-running a ticket cannot create a second proposal. | P0 |
| A5 | Batch runner processes a queue of tickets and prints one status line per ticket. | P0 |
| A6 | The agent may also decline a refund and record why. | P1 |
| A7 | Precedent search: Atlas Vector Search over past resolved disputes; cited precedents are stored as evidence. | P2 |

### Executor

| ID | Requirement | Pri |
|---|---|---|
| E1 | Watches inserts on `intents` and `approved` through Change Streams. | P0 |
| E2 | Two-phase payout: insert `ledger` entry as `pending`, call the provider with the entry's `source_id` as the idempotency key, update the entry to `succeeded` with the refund ID. | P0 |
| E3 | Saves the resume token after each event. On startup, resumes from the token and reconciles any `pending` ledger entries by repeating the provider call with the same key. Each entry is reconciled independently: one that throws is logged and skipped, and never blocks the others or stops the process from starting. | P0 |
| E4 | Startup sweep: any document in `intents` or `approved` with no ledger entry is processed. Covers a lost or expired resume token. | P0 |
| E5 | Pre-payout checks that a validator cannot do: the order exists, belongs to the customer, and has a `payment_id`; the refund does not exceed the order's remaining refundable amount; no other `pending` or `succeeded` ledger entry exists for the same `ticket_id` (one payout per ticket). Failures are written to the ledger as `failed` with a reason, and the provider is not called. | P0 |
| E6 | Daily auto-refund budget enforced through the `budgets` validator. When exhausted, auto refunds are diverted to review. | P1 |
| E7 | `PaymentProvider` interface with `StripeProvider` (test mode only; live keys refused), `FakeProvider` (in memory, for tests), and the fake behind HTTP (survives an executor kill; used by chaos tests and as the demo fallback). | P0 |
| E9 | Connects as the `executor` database user through the shared config (`MONGODB_URI`, `EXECUTOR_DB_USER`, `EXECUTOR_DB_PASSWORD`), and imports document types from `@escrowops/shared`. | P0 |
| E8 | `CRASH_AT=<1..4>` environment variable kills the process with SIGKILL at a named point, for chaos tests and the demo. | P0 |

### Approval service and dashboard

| ID | Requirement | Pri |
|---|---|---|
| S1 | Login for two seeded approvers. The approver ID comes from the session, never from the request body. | P0 |
| S2 | Review queue updates live through a Change Stream pushed over WebSocket. | P0 |
| S3 | Approve: insert into `approvals`. When the tier's count is met, insert into `approved` and mark the review `approved`, in one transaction. | P0 |
| S4 | Reject: record the decision and mark the review `rejected`. | P0 |
| S5 | Review card shows amount, tier, the agent's reason and evidence, and the validator rule that was broken. | P0 |
| S6 | Pipeline view: tickets flowing through proposed, held, approved, paid, updating live. | P0 |
| S7 | Audit timeline for a `trace_id`: one `$unionWith` aggregation across agent_traces, intents, review_queue, approvals, approved, ledger, ordered by time. | P0 |
| S8 | Approval progress indicator ("1 of 2") on held items. | P1 |
| S9 | Hash chain on audit events so edits by a privileged user are detectable. | P2 |

### Setup and tooling

| ID | Requirement | Pri |
|---|---|---|
| T1 | `npm run setup`: creates collections, validators, indexes, roles, users. Safe to re-run. | P0 |
| T2 | `npm run seed`: customers, orders, 12 tickets (8 small, 2 mid, 1 large, 1 containing a prompt injection). Orders carry fake `payment_id`s by default. With `PAYMENTS=stripe` it creates a fresh Stripe test payment for each ticket order and stores the real ID. | P0 |
| T3 | `npm run redteam`: connects as the agent user and attempts five attacks, printing each server error. | P0 |
| T4 | `npm run reset`: clears run data and re-seeds so the demo can be repeated in seconds. A repeat run must create new refunds, not replay old ones: with `PAYMENTS=stripe` the re-seed makes fresh test payments, and when `FAKE_PROVIDER_URL` is set the fake provider's log is cleared. | P0 |
| T5 | `npm run apply-policy`: regenerates validators from the active `policies` document. | P1 |

## 9. Non-functional requirements

| Area | Target |
|---|---|
| Payout correctness | Zero duplicate and zero lost payouts across 50 consecutive chaos runs |
| Approval to payout latency | Under 2 seconds at p95 |
| Auto refund latency after proposal | Under 2 seconds at p95 |
| Recovery time after executor restart | Under 5 seconds |
| Demo reset | Under 10 seconds |
| Secrets | `.env` only, never committed; `.env.example` checked in |

## 10. Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript on Node 22, npm workspaces |
| Database | MongoDB Atlas; `mongodb/mongodb-atlas-local` Docker image for local work and CI |
| Driver | Official `mongodb` Node driver (no ODM, so validators stay the single source of truth) |
| Model | Claude through the Anthropic SDK with tool use; `claude-sonnet-5-5` by default |
| Payments | Stripe test mode |
| API | Fastify + `ws` |
| UI | React + Vite |
| Tests | Vitest, Playwright |

### Repo layout

```
packages/
  shared/      types, policy → validator builder, db helpers
  agent/       tools, prompt, batch runner
  executor/    change stream loop, payment providers, reconciliation
  api/         approval service
  web/         dashboard
scripts/       setup, seed, reset, redteam, apply-policy
tests/         validator, roles, integration, chaos, evals, e2e
docs/
```

## 11. Build plan

Sized for a 2 to 4 person team over roughly 24 to 30 working hours. Adjust once the actual deadline is known.

| Phase | Hours | Deliverable | Exit check |
|---|---|---|---|
| 0. Spike | 2 | Validators, custom roles, and a Change Stream working on the real Atlas cluster | The three "verify first" items below are answered |
| 1. Foundation | 4 | `setup`, `seed`, `reset`; validator and role tests green | TEST_PLAN sections 1 and 2 pass |
| 2. Executor | 5 | Payouts through FakeProvider then Stripe; resume and reconciliation | Chaos suite passes |
| 3. Agent | 4 | Tools, batch runner, fallback to review on error 121 | Batch of 12 tickets lands in the right collections |
| 4. Approval service | 4 | Login, approve, reject, promotion transaction | Integration suite passes |
| 5. Dashboard | 5 | Pipeline, review queue, audit timeline | Playwright flow passes |
| 6. Red team + demo polish | 3 | `redteam` script, timing, fallback recording | Three clean full rehearsals |
| 7. Stretch | rest | Budgets (E6), precedent search (A7), hash chain (S9) | — |

**Cut order if time runs short:** S9, A7, E6, T5, A6, S8. Never cut T3 (red team) or E3 (resume); they carry the demo.

**Parallel split for three people:** one on executor and chaos tests, one on agent and seed data, one on approval service and dashboard. Phase 1 is done together first because everything depends on the collections and roles.

### Verify first (Phase 0)

1. Custom roles with collection-level actions can be created on the cluster tier in use. On Atlas they are created through the Atlas UI, CLI, or Admin API rather than `db.createRole`.
2. Error 121 from the Node driver includes `errInfo.details` naming the failed rule.
3. Change Streams and multi-document transactions work on the cluster tier in use.

If item 1 fails on a free-tier cluster, fall back to the local Atlas Docker image for the demo, where `db.createRole` works.

## 12. Risks

| Risk | Mitigation |
|---|---|
| The model refuses the prompt injection, so the "fooled agent" moment never happens | The demo does not depend on it. The red-team script attacks with the agent's credentials directly, which is deterministic and a stronger claim. |
| Venue wifi fails | Local Atlas Docker image plus FakeProvider; recorded backup video |
| Stripe test-mode rate limits or outage | FakeProvider switch through one environment variable |
| "This is just an if-statement" | Show the role table and run the red team; the rule holds without any agent cooperation |
| "Why not Temporal?" | Temporal makes workflows durable; it does not stop a compromised worker from issuing a payment. The two are complementary. |
| Approval service is itself trusted | State it plainly. It is small and has no LLM. Next step would be approvals signed with WebAuthn and verified by the executor. |
| Validators cannot express cross-document rules | Stated in section 6 and E5; those checks live in the executor and are listed in the audit trail |

## 13. Definition of done

- Every P0 requirement is implemented and covered by a passing test.
- `npm run reset && npm run demo` works three times in a row without manual fixes.
- All five red-team attacks are denied by the server.
- 50 chaos runs produce exactly one payout per approved refund.
- README explains setup in under ten commands.

## 14. Open questions

1. Hackathon deadline, team size, and judging criteria. The build plan assumes 24 to 30 hours and 2 to 4 people.
2. Is using Atlas Vector Search scored? If so, promote A7 to P1.
3. Which Atlas tier is available (free tier or credits)?
