# Development and evidence

## Components

- `src/computer-pool-client.mjs`: agent-neutral authenticated client.
- `src/computer-pool-server.mjs`: HTTP/SSE API and organization checks.
- `src/computer-pool-manager.mjs`: queue, lease, idempotency, lifecycle.
- `src/computer-run-store.mjs`: local JSON records; one controller process only.
- `src/run-pool-server.mjs`: local server and E2B executor.
- `src/e2b-operator-factory.mjs`, `src/operator/`: desktop worker, DOM-first observe/decide/act, authority gates, optional Jev adapter.
- `template/`, `src/build-dom-template.mjs`: E2B image inputs.
- `test/`: offline contract/regression tests.

AgentScope is a consumer, not a required runtime dependency. Other agents can use HTTP or `ComputerPoolClient` with same bounded contract.

## Checks

```sh
npm ci
npm test
E2B_API_KEY=placeholder HIVEMIND_COMPUTER_POOL_CONTROL_TOKEN=placeholder \
  docker compose -f docker-compose.pool.local.yml config --quiet
```

Unit tests do not provision E2B. For changes to E2B provisioning, browser execution, or lease lifecycle, run `npm run pool-client-canary` against an isolated local pool. Record source SHA, `computer_run_id`, status, observed fact, independent verification, and evidence path. Omit keys, bearer tokens, sandbox access URLs, and personal data. Existing historical record: `evidence/2026-09-25-local-iana-pool-canary.md`.

## Limits before production

This is a local evaluation package, not production control plane. JSON state assumes one controller; desktop handles and human stream URLs are process-local. Shared bearer token and loopback binding are not service-to-service auth/TLS. Browser plans are caller-authored, not generated from arbitrary user language. Human takeover exists, but full pause/continue across process restart is not proven. Optional Jev helps ambiguous element choice; deterministic DOM matching remains preferred. Add durable multi-node storage, per-service credentials, restart recovery, and a separate natural-language planner only when integration needs them.

Source package came from `amar3012005/HIVEMIND`, commit `d88be1d146ad0e1436f906d0d7426205cd7d4eb3`, path `experiments/e2b-desktop-canary`. This repository has independent history. Do not merge it back into HIVE-MIND or deploy it as part of unrelated runtime work without explicit integration review.
