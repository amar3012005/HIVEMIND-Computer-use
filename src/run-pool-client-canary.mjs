import { randomUUID } from 'node:crypto'
import { ComputerPoolClient } from './computer-pool-client.mjs'

const expectedHeading = 'IANA-managed Reserved Domains'
const client = new ComputerPoolClient({
  baseUrl: process.env.HIVEMIND_COMPUTER_POOL_URL || 'http://127.0.0.1:8789',
  token: process.env.HIVEMIND_COMPUTER_POOL_CONTROL_TOKEN,
  organizationId: process.env.HIVEMIND_COMPUTER_POOL_ORGANIZATION_ID || 'local-canary',
})
const clientRunId = randomUUID()
const accepted = await client.submit({
  client_id: 'standalone-public-readonly-canary',
  client_run_id: clientRunId,
  objective: 'Read the visible main heading on IANA Reserved Domains and independently verify it over HTTPS.',
  allowed_domains: ['www.iana.org'],
  capabilities: ['navigate', 'read'],
  browser_plan: {
    startUrl: 'https://www.iana.org/domains/reserved',
    completion: {
      kind: 'visible_text',
      selector: 'h1',
      expected_text: expectedHeading,
      independent_http_url: 'https://www.iana.org/domains/reserved',
    },
  },
  limits: { max_steps: 8, timeout_ms: 120_000 },
}, { idempotencyKey: `standalone-${clientRunId}` })

console.log(JSON.stringify({
  event: 'submitted',
  client_id: accepted.client_id,
  client_run_id: accepted.client_run_id,
  computer_run_id: accepted.computer_run_id,
  status: accepted.status,
}))

for await (const event of client.events(accepted.computer_run_id)) {
  console.log(JSON.stringify({
    event: event.type,
    computer_run_id: event.computer_run_id,
    event_id: event.event_id,
    status: event.status,
  }))
}

const result = await client.get(accepted.computer_run_id)
if (result.status !== 'completed'
  || result.result?.result?.value !== expectedHeading
  || result.result?.result?.independent_http !== true) {
  throw new Error(`standalone_computer_canary_failed:${result.status}`)
}

console.log(JSON.stringify({
  event: 'verified',
  computer_run_id: result.computer_run_id,
  status: result.status,
  result: result.result.result,
  evidence: result.evidence,
}))
