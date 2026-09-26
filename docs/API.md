# Computer run API

Service accepts bounded sub-goals from any caller. It is not a general free-form natural-language agent. Caller supplies start URL, allowed domains, completion selector, capabilities, and limits. The pool owns leasing, status, evidence, cancellation, and lifecycle.

## Submit and inspect

Use installed `ComputerPoolClient` (`src/computer-pool-client.mjs`):

```js
import { ComputerPoolClient } from './src/computer-pool-client.mjs'

const client = new ComputerPoolClient({
  baseUrl: process.env.HIVEMIND_COMPUTER_POOL_URL,
  token: process.env.HIVEMIND_COMPUTER_POOL_CONTROL_TOKEN,
  organizationId: 'local-canary',
})
const submitted = await client.submit({
  client_id: 'my-agent',
  client_run_id: 'my-turn-001',
  objective: 'Read IANA reserved-domains heading',
  allowed_domains: ['www.iana.org'],
  capabilities: ['navigate', 'read'],
  browser_plan: {
    startUrl: 'https://www.iana.org/domains/reserved',
    completion: { kind: 'visible_text', selector: 'h1' },
  },
  limits: { max_steps: 8, timeout_ms: 120_000 },
}, { idempotencyKey: 'my-agent:my-turn-001:call-1' })

console.log(submitted.computer_run_id)
for await (const event of client.events(submitted.computer_run_id)) {
  console.log(event.event_id, event.type, event.status)
}
console.log(await client.get(submitted.computer_run_id))
```

`ComputerPoolClient` sends bearer token and `X-Hivemind-Organization-Id`. Raw HTTP clients must send those headers and `Content-Type: application/json`; POST body must include matching `organization_id`. Send stable `Idempotency-Key` for retries. Replaying the same key in the same organization returns the existing run ID rather than provisioning another desktop. A different organization cannot read that run. Run IDs are durable within configured local store; in-process E2B handles are not durable across process restarts.

## Routes

| Route | Purpose |
| --- | --- |
| `POST /v1/computer-runs` | Submit bounded job, receive run ID/status. |
| `GET /v1/computer-runs/:id` | Read current status, result, evidence. |
| `GET /v1/computer-runs/:id/events?after=N` | SSE event replay and live updates. `Last-Event-ID` also supported. |
| `POST /v1/computer-runs/:id/cancel` | Cancel and release leased desktop. |
| `POST /v1/computer-runs/:id/human-takeover` | Transfer ownership to human. |
| `GET /v1/computer-runs/:id/human-session` | Get authorized desktop URL only when stream is available. Treat URL as credential. |
| `POST /v1/computer-runs/:id/resume` | Change paused/human ownership back to agent status. |

Pool statuses include queued, agent, human, completed, failed, cancelled, and expired. A `needs_human` operator outcome becomes `human` with evidence and `human_session_available` flag. `resume` does not by itself guarantee operator execution restarts; verify an event and status before claiming continuation. Do not log or persist a human-session URL in chat or evidence.

## Authority

Only read/navigation are auto-authorized. Login, MFA, CAPTCHA, credentials, send/publish, delete, payment, and other irreversible actions need explicit human handling. Any caller requesting broader capabilities remains subject to `src/operator/authority-policy.mjs`; a model decision is never authority. Jev/Cloudflare decision routing is optional and used for ambiguous DOM choice, not as a policy bypass.
