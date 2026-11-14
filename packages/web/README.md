# @escrowops/web

The dashboard (PRD S6, S7, plus the approver UI for S5 and S8). There are two parts:

- **Server** (`src/`): reads as `escrow_dashboard`, which can find and watch every collection and write none. It serves the pipeline, the audit timeline, a live WebSocket, and the built UI. Approve, reject and login are forwarded to the approval service, so the browser talks to one origin and the dashboard itself never writes.
- **UI** (`ui/`): React + Vite.

## Run

```sh
npm run api              # approval service, :4000
npm run executor         # pays approved refunds
npm run web:build        # once, or after UI changes
npm run dashboard        # http://127.0.0.1:4100
```

For UI work with hot reload, run `npm run dashboard` and `npm run web:dev` (Vite on :5173, proxying `/api` and `/ws` to the dashboard). Settings: `DASHBOARD_PORT` (4100), `APPROVAL_URL` (default `http://127.0.0.1:$API_PORT`).

## What it shows

- **Pipeline (S6).** One card per ticket at the stage of its latest run: Intake, Auto-approved, Held for review, Approved, Paid, and Stopped (declined, rejected, blocked, failed). One database-wide Change Stream drives it. After any change the server recomputes the pipeline (a dozen tickets) and pushes it to every browser. Each (re)connect starts with the full pipeline, so a dropped socket catches up.
- **Review cards (S5, S8).** Amount, tier, the agent's reason and evidence, the validator rule the proposal broke, and "1 of 2" progress. Approve and Reject are disabled until you sign in, and after you have decided.
- **Audit timeline (S7).** `timelinePipeline()` in `src/timeline.ts` is a single aggregation: `agent_traces` `$unionWith` `intents`, `review_queue` (held, and its decision), `approvals` (joined to their review by `$lookup`), `approved`, and `ledger` (pending, then the outcome), sorted by time.

## Tests

- `tests/web/` (in `npm test`): pipeline stages, live push, forwarded login and approve, and I16 (the full timeline of a $5,000 refund).
- `tests/e2e/` (`npm run test:e2e`, Playwright): U1 to U9 with two browser contexts, one per approver, against the full stack. Global setup builds the UI and starts everything in one process (in-memory MongoDB unless `MONGODB_URI` is set). Needs `npx playwright install chromium` once.
