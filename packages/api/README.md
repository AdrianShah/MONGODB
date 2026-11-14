# @escrowops/api

The approval service (PRD S1 to S5, S8). It has no LLM in it and connects as `escrow_approver`, which can read, watch and update `review_queue`, read and insert `approvals`, and insert into `approved`. It cannot read or change `approved`, `ledger` or `intents`.

## Run

```sh
npm run api     # http://127.0.0.1:4000
```

Approver logins come from `APPROVERS` (`id:password,id:password`). The dev defaults are `approver-a` / `approver-a-dev-password` and `approver-b` / `approver-b-dev-password`. `API_HOST` and `API_PORT` set the address.

## API

| Route | Does |
|---|---|
| `POST /api/login` `{ approver_id, password }` | Sets an HttpOnly, SameSite=Strict session cookie and also returns the token (for `Authorization: Bearer`) |
| `POST /api/logout`, `GET /api/me` | |
| `GET /api/reviews?status=pending` | Review cards: amount, tier, reason, evidence, the validator rules the proposal broke, and approvals so far (`approved_count` of `required_approvals`). Status: `pending` (default), `approved`, `rejected`, `blocked`, `all` |
| `GET /api/reviews/:id` | One card |
| `POST /api/reviews/:id/approve` `{ note? }` | Records the approval; promotes when enough approvers have approved |
| `POST /api/reviews/:id/reject` `{ note? }` | Records the rejection; the review can no longer be approved |
| `GET /ws` (WebSocket) | A `snapshot` of pending cards, then a `review` message for every change |

The approver is always the session's owner. An `approver_id` in a request body is dropped. Errors: `401 unauthenticated`, `404 not_found`, `409 already_decided`, and `409 review_<status>` when the review is no longer pending.

## How a decision is made

Each decision is one transaction. For an approval, it reads the review (it must be `pending`) and inserts into `approvals`; the unique `(review_id, approver_id)` index stops one person deciding twice. When the approvals reach the review's `required_approvals`, the same transaction inserts the `approved` document and marks the review `approved`. The executor picks it up from there.

- **Every decision also updates the review document.** Two approvals racing on one review therefore write-conflict; the driver retries the loser, which then sees the winner's approval. Exactly one `approved` document results (I8).
- **The service does not enforce the tier rules itself.** The `approved` validator does: distinct approvers, a second approver above $2,000, nothing above $10,000. When it refuses the promotion (121), the approval is still recorded, the review is marked `blocked` with `promotion_error`, and nothing can pay (I9).
- A crash inside the transaction leaves neither the approval nor the promotion behind, so a retry promotes exactly once (C10).

## Tests

`tests/api/` (part of `npm test`): I3 to I9, I17, I18, C10, the WebSocket feed, and an approval-to-payout run with the executor (I6, under 2 s).
