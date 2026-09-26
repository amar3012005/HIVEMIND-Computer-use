# HIVEMIND Computer Use

Standalone, agent-neutral computer-use service for bounded E2B Linux desktop jobs. A client submits an objective, allowed domains, and a browser plan. The service leases an E2B desktop, runs a DOM-first worker inside it, and returns a durable run ID, status events, result, and evidence. AgentScope is an optional client; the pool runs without it.

This repository is a local evaluation package. It is not a production deployment or a general natural-language planner. Current browser jobs require a caller-supplied `browser_plan` with a start URL and visible-text completion selector. Read and navigation run automatically; sensitive actions require human authority.

## Start here

- [Setup](docs/SETUP.md): prerequisites, E2B template, host and Docker launch, canary, cleanup.
- [API](docs/API.md): authenticated requests, sub-goal schema, status/SSE, cancellation and human handoff.
- [Development](docs/DEVELOPMENT.md): components, tests, evidence, current limits.
- [Agent instructions](AGENTS.md): safe scope for another coding agent.

## Local quick start

Requires Node 22, an E2B API key, and the E2B template named `hm-computer-operator-canary-v5`. Build the template once with `npm run build:dom-template` if your E2B account does not have it.

```sh
npm ci
npm test

# Supply E2B_API_KEY from your local secret manager. Never commit or print it.
export HIVEMIND_COMPUTER_POOL_CONTROL_TOKEN="$(openssl rand -hex 32)"
export HIVEMIND_COMPUTER_POOL_PORT=8789
npm run pool-server
```

In another terminal, provide the **same** local control token:

```sh
export HIVEMIND_COMPUTER_POOL_CONTROL_TOKEN='same-local-token'
export HIVEMIND_COMPUTER_POOL_URL=http://127.0.0.1:8789
export HIVEMIND_COMPUTER_POOL_ORGANIZATION_ID=local-canary
npm run pool-client-canary
```

The client canary creates a real, short-lived E2B desktop; visits IANA's public reserved-domains page; reads its visible heading; verifies it through a separate HTTPS request; prints status events and a durable evidence receipt; then releases the desktop. See [setup](docs/SETUP.md) for port conflicts, Docker, and template build details.

## Contract

| Endpoint | Result |
| --- | --- |
| `POST /v1/computer-runs` | Accept bounded job; return `computer_run_id` immediately. |
| `GET /v1/computer-runs/{id}` | Current status, result, evidence. |
| `GET /v1/computer-runs/{id}/events` | Ordered SSE status events; replay with `Last-Event-ID` or `?after=`. |
| `POST /v1/computer-runs/{id}/cancel` | Cancel and release lease. |
| `POST /v1/computer-runs/{id}/human-takeover` | Move run to human ownership. |
| `GET /v1/computer-runs/{id}/human-session` | Authorized live desktop URL when stream is available. |
| `POST /v1/computer-runs/{id}/resume` | Change a human/paused run back to agent state. |

Every run has a caller-chosen `client_id`, optional `client_run_id`, and organization-scoped idempotency key. A bearer token protects the local API. The desktop URL and credentials never appear in ordinary status receipts. Full examples: [API](docs/API.md).

## Verified scope

Local tests cover capacity queueing, idempotent submissions, organization checks, status replay, cancel, authority policy, DOM selection, and desktop lifecycle. A real E2B BCCI canary completed through this independent API: run `3a9a61b0-41cf-4edf-a169-dd9731731d78` visited BCCI's Virat Kohli article and independently verified a browser-visible Test-career fact. See [recorded evidence](evidence/2026-09-25-local-iana-pool-canary.md).

Fresh standalone canary: [2026-09-26 IANA record](evidence/2026-09-26-standalone-iana-canary.md). The local JSON store supports one controller process. Shared-token authentication, in-process E2B handles, and manual browser plans must be replaced or strengthened before multi-node production use. Jev is optional and called only when deterministic DOM selection is ambiguous. Neither the IANA nor BCCI canary needed a Jev call.

## Source

Extracted from tracked files under `experiments/e2b-desktop-canary` in `amar3012005/HIVEMIND`, source commit `d88be1d146ad0e1436f906d0d7426205cd7d4eb3`. Snapshot extraction excluded ignored keys, local state, screenshots, and `receipts/`. This repository starts a separate Git history so computer-use development can proceed independently.
