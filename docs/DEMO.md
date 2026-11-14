# EscrowOps — Demo Script

Companion to [PRD.md](PRD.md) and [TEST_PLAN.md](TEST_PLAN.md). Target length: 3 minutes 30 seconds. A 2-minute cut is at the end.

## The one sentence judges should remember

> "We gave the attacker the agent's own database password, and MongoDB still said no."

## Screen layout

| Where | What |
|---|---|
| Left half | Dashboard as **Approver A**: pipeline on top, review queue below |
| Right top | Terminal 1: batch runner and red-team output, large font |
| Right bottom | Terminal 2: executor logs |
| Second device or window | Dashboard as **Approver B** (a teammate's phone works best) |
| Background tab | Stripe test dashboard, Refunds page |

## Before going on

1. `npm run reset`
2. All four processes running; executor logs visible.
3. Both approvers logged in.
4. Stripe Refunds tab loaded and empty for today.
5. Commands pre-typed in shell history: `npm run batch`, `npm run redteam`, `npm run demo:kill`.

## Script

### 0:00 — Hook (20 s)

> "Everyone wants AI agents that can issue refunds. Nobody ships them, because the guardrails live in the same process as the model. Fool the model and you've fooled the guardrail. EscrowOps moves the guardrail into MongoDB, where the agent can't reach it."

### 0:20 — Small refunds clear on their own (35 s)

Run `npm run batch`.

- Cards flow across the pipeline: proposed, paid.
- Terminal prints one line per ticket with the amount and a green tick.

> "Twelve real dispute tickets. Claude reads each one, checks the order and the customer's history, and proposes a refund by writing a document to MongoDB. A separate worker watches a Change Stream and pays out through Stripe. Eight small refunds, no human involved."

Flick to the Stripe tab for two seconds to show real test refunds.

### 0:55 — The $5,000 refund is stopped by the database (40 s)

The batch reaches the large ticket. Terminal shows the raw server error:

```
MongoServerError: Document failed validation (code 121)
  amount_cents: 500000 — maximum 50000
→ routed to review_queue
```

A card appears in the review queue on both devices.

> "This one is five thousand dollars. The agent tried to write it and MongoDB rejected the write. That's a schema validator on the collection, not our code. The agent's only other option is a review queue, which authorizes nothing."

Click the card. Show the agent's reason, the evidence, and the rule it broke.

Optional, if ElevenLabs is set up (skip in the 2-minute cut): click **Listen**. The card reads itself aloud, ending with "Listening approves nothing." Stop it after a sentence or two.

> "Approvers can listen to a card hands-free. Voice reads; it can't approve. That still takes a signed-in click."

Approver A clicks **Approve**. Card shows **1 of 2**.

> "Over two thousand dollars needs two different people. I've approved. Watch what happens if I try again."

Click again. Refused.

> "A unique index. One person, one approval."

### 1:35 — Second key turns (20 s)

Teammate taps **Approve** on the phone.

Card moves to paid within a second. Executor log prints the Stripe refund ID.

> "Second approver, different device. The approval service writes to a collection the agent has no access to, the Change Stream fires, and the refund pays out."

### 1:55 — Red team: assume the agent is compromised (45 s)

> "So far the agent behaved. Let's assume it doesn't. This script logs in with the agent's exact database credentials and tries everything."

Run `npm run redteam`. Output appears one line at a time:

```
1. Insert $50,000 refund ....................... DENIED  121 Document failed validation
2. Forge two approvals, write to `approved` .... DENIED  13  not authorized
3. Edit an earlier refund's amount ............. DENIED  13  not authorized
4. Remove the validator (collMod) .............. DENIED  13  not authorized
5. Insert with bypassDocumentValidation ........ DENIED  13  not authorized

Payouts caused: 0
```

> "Five attacks, five refusals, all from the MongoDB server. No prompt, no jailbreak, no bug in our agent can get past this, because none of it runs in the agent."

If the injection ticket in the batch was caught earlier, point at it: "One of those twelve tickets also contained a prompt injection asking for fifty thousand dollars. It's sitting in the review queue."

### 2:40 — Kill the worker mid-payout (30 s)

Run `npm run demo:kill`. This queues one approved refund and sends SIGKILL to the executor after Stripe has been called but before the ledger is updated.

Executor terminal shows `Killed`. Restart it with the up arrow.

```
resuming from saved token
reconciling 1 pending payout … already refunded (re_…), marking succeeded
```

Show the Stripe tab: one refund, not two.

> "We just killed the worker at the worst possible moment: money sent, ledger not updated. On restart it reads its checkpoint from MongoDB and reconciles. One refund. We ran this fifty times in a row with random crash points: zero duplicates."

### 3:10 — Audit trail and close (20 s)

Click the $5,000 card, open the timeline.

> "And every dollar is reconstructable: the ticket, each tool call the model made, the validator rejection, both approvers, the Stripe refund ID. One aggregation over one trace ID."

Optional: click **Narrate audit trail** and let the first sentences play under the closing line. It is spoken from the same aggregation, by ElevenLabs.

> "EscrowOps: the agent proposes, MongoDB decides."

## If something breaks

| Problem | Do this |
|---|---|
| Wifi or Atlas unreachable | Switch `.env` to the local Docker database and `PAYMENTS=fake`; restart; carry on. Skip the Stripe tab. |
| Stripe slow or erroring | `PAYMENTS=fake`; say "we're on the mock provider, the Stripe path is identical". |
| Model call slow | Run `npm run batch -- --replay`, which replays recorded proposals from the last good run through the real database path. Say so. |
| Dashboard not updating | Reload; state comes from the database. |
| Phone approver not working | Use the second browser window logged in as Approver B. |
| ElevenLabs slow, out of credits or no key | Nothing to do: the buttons fall back to the browser's voice. Or skip the voice beat. |
| Everything is on fire | Play the backup recording and narrate over it. |

Decide the fallback within five seconds and keep talking. Do not debug on stage.

## Two-minute cut

Keep the hook (shortened to one sentence), the $5,000 stop with the second approval, and the red team. Drop the Stripe tab, the kill and restart, and the timeline walkthrough; mention them in one closing line: "It also survives a kill -9 mid-payout with exactly one refund, and every decision has a full audit trail."

## Likely questions

**"Isn't this just an if-statement moved into the database?"**
The rule is the same; where it runs is the point. An if-statement in the agent process shares its fate. Here the agent's credentials cannot change the rule, skip it, or write to the collection that satisfies it. The red-team script is the proof.

**"What stops the agent writing approvals into its own request?"**
Approvals aren't a field on the request. They're a separate collection the agent role cannot write to, and the request collection rejects unknown fields.

**"Why not Temporal or a workflow engine?"**
Those make a workflow durable. They don't stop a compromised worker from calling the payment API. EscrowOps is the authorization layer; it would sit happily in front of a Temporal activity.

**"What can't the validator do?"**
Anything that needs another document: checking the refund against the order total, or cumulative spend per customer. Those run in the executor, which has no LLM, and the daily budget is a validator on a single counter document.

**"What if the approval service is compromised?"**
Then approvals can be forged; it is the trusted component. It's small, has no model in it, and is still capped at $10,000 by the validator. The next step is approvals signed with a passkey and verified by the executor.

**"Could the agent split a large refund into many small ones?"**
Not for the same ticket and order: the idempotency key is unique. Across tickets, the daily auto-refund budget caps total exposure.

**"Why MongoDB specifically?"**
Four features carry the design: schema validators with expressions, collection-level custom roles, Change Streams with resume tokens, and multi-document transactions for promotion. The audit timeline is one `$unionWith` aggregation.

**"Does it work with a database admin acting maliciously?"**
No, and we don't claim it. The trust boundary is the agent. A hash chain on audit events would make admin edits detectable; that's on the roadmap.

**"How do you change the policy?"**
Edit the policy document and run `apply-policy` as admin. It regenerates the validators and bumps the policy version, so proposals built against the old policy are rejected.
