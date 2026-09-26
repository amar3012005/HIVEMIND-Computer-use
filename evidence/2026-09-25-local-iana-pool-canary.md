# Local AgentScope-to-E2B read-only canary

- Date: 2026-09-25 (Europe/Berlin)
- Scope: local E2B pool only; no production or Singulance server access.
- E2B template: `hm-computer-operator-canary-v5`
- Template build: `450a74d2-7fa6-4e9b-b0d2-186c1390fd80`
- Computer run: `7f575e76-1d4b-41fa-b917-03c7aa3ce5ec`
- Request accepted: HTTP 202 in 38 ms (`starting` returned before provisioning).
- Final status: `completed` in 17,605 ms.
- Visible browser evidence: `h1` = `IANA-managed Reserved Domains` at `https://www.iana.org/domains/reserved`.
- Independent verification: HTTPS fetch of the same allowlisted page returned HTTP 200 and contained the expected heading.
- Decision calls: 0 (the deterministic DOM plan was unambiguous).
- The pool's durable run record contains the result and both evidence items; no desktop credentials or API keys are included here.

This proves the local pool's E2B provision → browser DOM observation → semantic check → independent HTTP verification → durable result path. It does not prove the active preview UI is running the candidate AgentScope runtime, a live Jev provider request, or production readiness.

## Two-slot queue/concurrency run

Submitted three independent read-only runs to the local pool configured with two active slots. The first two were accepted as `starting`; the third was `queued`. All three later reached `completed`, each returned the same browser-visible heading plus an independent HTTP 200 match, and no Jev call was needed. The three runs finished in 46,984 ms total.

- `da46e7ba-4f6f-4b42-b78c-1187278f857f`
- `21d9bcca-70b8-42d9-a4e9-e6634e0355b0`
- `c8a8be4a-e69a-4a9c-93bc-36e99a818257` (initially queued)

This confirms real E2B capacity queueing and reassignment, not just the in-memory queue unit test.

## Agent-independent HTTP client canary

- Client: `standalone-public-readonly-canary` (no AgentScope session, WorkRun, Redis, or AgentScope-owned run ID).
- Client correlation ID: `b184907d-fcc0-45f0-82b5-d1dc3a9861b3`.
- Durable computer run: `af217b58-e13e-4fff-ae06-189a0e0b0d82`.
- Status stream replay: `starting` (event 1) → `agent` (event 2) → `completed` (event 3); cursor replay after event 1 returned only events 2 and 3.
- Result: `completed`; browser-visible `h1` = `IANA-managed Reserved Domains`; independent HTTPS verification returned HTTP 200 and matched the expected heading.
- Evidence receipt includes the browser selector/value/source URL and independent HTTP match. The run needed zero Jev decisions because the DOM plan was deterministic.
- Verification: `npm test` — 35/35 passed; syntax checks passed for the standalone client, pool API server, and live-canary script.

This demonstrates the computer-run lifecycle is exposed through a generic authenticated HTTP contract and is usable without AgentScope. It is still a local evaluation service: the checked-in JSON store and shared local bearer token are not production-grade multi-controller persistence/authentication, and the optional AgentScope-to-model end-to-end route was not proved in this run.

## BCCI / Virat Kohli public-site canary

- Client: `standalone-bcci-readonly-canary`; no AgentScope session or WorkRun.
- Client correlation ID: `a71daf3b-76b8-43a7-a9db-7056da22459c`.
- Durable computer run: `3a9a61b0-41cf-4edf-a169-dd9731731d78`.
- Status events: `starting` (event 1) → `agent` (event 2) → `completed` (event 3).
- Browser-visible result from BCCI's official article: Kohli finished his Test career with 9,230 runs in 123 matches, averaging 46.85, with 30 centuries and 31 fifties.
- Independent verification: the worker fetched the same allowlisted BCCI article over HTTPS; HTTP 200 and exact expected sentence matched.
- Evidence kinds: `browser_visible_text`, `semantic_entity_match`, `independent_http_match`; decision calls: 0.
- The BCCI player-profile URL redirected to the site homepage in the public fetch, so the canary used BCCI's official article titled “BCCI congratulates Virat Kohli on a legendary Test career.”

This is a second live E2B browser execution using only the agent-neutral HTTP contract and a public read-only goal.
