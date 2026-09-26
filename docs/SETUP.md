# Local setup

## Requirements

- Node.js 22, npm, Docker Compose only if using the container launch.
- E2B account/API key with capacity for a short-lived Linux desktop. Store key in a local secret manager or ignored `.env` file; never commit or paste it into logs.
- Outbound access to E2B and the read-only canary site.

```sh
git clone https://github.com/amar3012005/HIVEMIND-Computer-use.git
cd HIVEMIND-Computer-use
npm ci
npm test
```

Set `E2B_API_KEY` in your shell. `.env.example` lists configuration names but is not automatically loaded. Existing E2B accounts may already have template `hm-computer-operator-canary-v5`. Otherwise build it once:

```sh
npm run build:dom-template
```

Template build uses E2B and may incur usage. Set `E2B_TEMPLATE_NAME` to the resulting template name if different. It packages the browser worker; local `npm test` does not require E2B.

## Start pool on host

Use one private control token in both server and client shells. Choose an unused local port (default 8789). Keep token out of shell history where possible.

```sh
export HIVEMIND_COMPUTER_POOL_CONTROL_TOKEN="$(openssl rand -hex 32)"
export HIVEMIND_COMPUTER_POOL_PORT=8789
npm run pool-server
```

In a second terminal, set the **same** token securely, then:

```sh
export HIVEMIND_COMPUTER_POOL_URL=http://127.0.0.1:8789
export HIVEMIND_COMPUTER_POOL_ORGANIZATION_ID=local-canary
npm run pool-client-canary
```

Canary creates a real E2B desktop, reads IANA's heading, independently fetches the same public page, checks both results, and releases the desktop. Preserve its printed run ID and evidence receipt, not any token or stream URL. Stop host server with Ctrl-C; wait for its shutdown before reusing port. `HIVEMIND_COMPUTER_POOL_STATE_DIR` defaults to ignored `pool-state/`. Use separate state directories for separate local pool processes.

## Docker alternative

Template must already exist. From repository root, export `E2B_API_KEY` and `HIVEMIND_COMPUTER_POOL_CONTROL_TOKEN` in invoking shell. Compose binds only loopback and keeps state in named volume.

```sh
HIVEMIND_COMPUTER_POOL_HOST_PORT=8792 docker compose -f docker-compose.pool.local.yml up --build
```

Point client at `http://127.0.0.1:8792`. To stop, use `docker compose -f docker-compose.pool.local.yml down`. Do not add `-v` unless intentionally deleting durable local pool records. Avoid ports used by other local previews.

## Troubleshooting

- `E2B_API_KEY is required`: export it into server environment; `.env.example` alone has no values.
- Template not found: run `npm run build:dom-template` under same E2B account or set `E2B_TEMPLATE_NAME`.
- Connection refused: confirm pool process, URL/port, and loopback binding. `curl http://127.0.0.1:8789/healthz` checks listener only, not E2B readiness.
- 401/403: client and server tokens must match; organization header must match the run.
- Port occupied: change `HIVEMIND_COMPUTER_POOL_PORT` on host or `HIVEMIND_COMPUTER_POOL_HOST_PORT` in Compose and update client URL.
- Browser site unavailable: distinguish page/network failure from pool failure via run status and evidence. Do not treat an HTTP listener or unit tests as a successful real-desktop canary.
