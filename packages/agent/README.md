# @escrowops/agent

Claude resolves refund tickets by proposing a refund or declining (PRD A1 to A6). It connects as `escrow_agent`, which can read tickets, orders, customers and policies and insert into `agent_traces`, `intents` and `review_queue`. Nothing else.

## Run

```sh
npm run batch                    # every open ticket
npm run batch -- T-1001 T-1011   # just these
```

Prints one line per ticket, for example:

```
T-1001   proposed $89.00 -> intents (auto, pays out)
T-1011   proposed $5000.00 -> review_queue (human_required; validator: maximum)
```

Model provider: with `GROQ_API_KEY` set (free tier works) the agent runs on Groq through an OpenAI-compatible adapter (`src/groq.ts`) that maps the tool-use loop onto chat completions; otherwise it uses Claude via `ANTHROPIC_API_KEY` (or an `ant auth login` profile). `AGENT_PROVIDER=groq|anthropic` forces one. Settings: `AGENT_MODEL` (default `openai/gpt-oss-120b` on Groq, `claude-sonnet-5-5` on Anthropic), `AGENT_EFFORT` (default `medium`; on Groq it maps to gpt-oss `reasoning_effort`), `AGENT_CONCURRENCY` (default 1 on Groq to stay within free-tier tokens per minute, 4 on Anthropic), `GROQ_MAX_TOKENS` (default 2048), `AGENT_FALLBACKS=off` to disable the Anthropic server-side refusal fallback. Groq 429s are retried after the server's `retry-after`, and a malformed tool call (`tool_use_failed`) is resampled.

## How a ticket is worked

A manual tool loop (`src/agent.ts`) with five strict tools (`src/tools.ts`):

| Tool | Does |
|---|---|
| `get_ticket`, `get_order`, `get_customer_history` | Read source data |
| `propose_refund` | Insert into `intents`. On error 121 (over the auto cap, or any other validator rule), insert the same proposal into `review_queue` with the server's `errInfo`, the tier and the approvals it needs |
| `decline_refund` | Record the decision and reason |

- `customer_id` and `ticket_id` come from the ticket document, not from the model.
- `idempotency_key` is `sha256("<ticket>|<order>")` (A4), the same as the red-team script, so a re-run or split refund hits the unique index.
- One decision per run. Every tool call, result, reasoning summary and the decision are written to `agent_traces` under one `trace_id` with increasing `seq` (A3).
- The ticket body only reaches the model through `get_ticket`, and the system prompt treats it as customer data. The defence that matters is still the database: a fooled agent's $50,000 proposal lands in `review_queue` as `blocked`.

## Tests

`tests/agent/` runs the loop against the real schema, roles and seed data with a scripted fake model, so it needs no API key. `tests/integration/agent-to-payout.test.ts` checks that agent proposals are paid by the executor (or not, when held). Section 6 evals against the real model are not written yet.
