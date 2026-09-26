import assert from 'node:assert/strict'
import test from 'node:test'
import { ComputerRunExecutor, browserPlanPlanner } from '../src/computer-run-executor.mjs'
import { RemoteComputerControlClient } from '../src/remote-computer-control-client.mjs'

const owner = { organizationId: '00000000-0000-4000-8000-000000000001', userId: '00000000-0000-4000-8000-000000000002' }
const run = {
  computer_run_id: '00000000-0000-4000-8000-000000000003', org_id: owner.organizationId, user_id: owner.userId,
  objective: 'Read the Example Domain heading.', allowed_domains: ['example.com'],
  browser_plan: { startUrl: 'https://example.com/', completion: { kind: 'visible-heading' } },
  limits: { max_steps: 3, timeout_ms: 10_000 },
}

test('remote control signs the exact request bytes and refuses insecure production URLs', async () => {
  let captured
  const client = new RemoteComputerControlClient({
    baseUrl: 'https://control.example', hmacSecret: 'test-secret', clock: () => 1_700_000_000_000,
    fetchImpl: async (url, init) => {
      captured = { url, init }
      return new Response(JSON.stringify({ computer_run_id: 'run-1' }), { status: 202 })
    },
  })
  await client.submit({ objective: 'read' })
  assert.equal(captured.url, 'https://control.example/internal/computer-runs')
  assert.equal(captured.init.headers['x-hm-computer-timestamp'], '1700000000')
  assert.match(captured.init.headers['x-hm-computer-signature'], /^[a-f0-9]{64}$/)
  assert.throws(() => new RemoteComputerControlClient({ baseUrl: 'http://localhost:8060', hmacSecret: 'x' }), /requires_https/)
})

test('persisted browser plan permits only the run allow-list', async () => {
  const plan = await browserPlanPlanner(run).compile({ objective: run.objective })
  assert.equal(plan.startUrl, 'https://example.com/')
  await assert.rejects(
    () => browserPlanPlanner({ ...run, browser_plan: { startUrl: 'https://untrusted.example/' } }).compile({ objective: 'x' }),
    /not_allowed/,
  )
})

test('executor binds an AgentScope-owned run to ComputerOperator and releases terminal computers', async () => {
  const events = []
  let destroyed = 0
  const control = {
    claim: async payload => { events.push(['claim', payload]); return run },
    transition: async (id, payload) => { events.push(['transition', id, payload]); return { computer_run_id: id, status: payload.status } },
    heartbeat: async () => { events.push(['heartbeat']) },
  }
  const executor = new ComputerRunExecutor({
    control, workerId: 'worker-a', heartbeatMs: 1_000_000,
    computerFactory: async () => ({ sandboxId: 'sandbox-safe-id', destroy: async () => { destroyed += 1 } }),
    operatorFactory: async ({ planner }) => ({ run: async input => {
      const plan = await planner.compile(input)
      assert.equal(plan.startUrl, 'https://example.com/')
      return { status: 'completed', steps: 1, evidence: [{ kind: 'visible_fact', value: 'Example Domain' }] }
    } }),
  })
  const result = await executor.runNext(owner)
  assert.equal(result.status, 'completed')
  assert.equal(destroyed, 1)
  assert.deepEqual(events.filter(event => event[0] === 'transition').map(event => event[2].status), ['agent', 'completed'])
})

test('executor retains the lease for an explicit human takeover', async () => {
  let destroyed = 0
  const control = {
    claim: async () => run,
    transition: async (id, payload) => ({ computer_run_id: id, status: payload.status }),
    heartbeat: async () => ({}),
  }
  const executor = new ComputerRunExecutor({
    control, workerId: 'worker-a', heartbeatMs: 1_000_000,
    computerFactory: async () => ({ sandboxId: 'sandbox-safe-id', destroy: async () => { destroyed += 1 } }),
    operatorFactory: async () => ({ run: async () => ({ status: 'needs_human', steps: 0, reason: 'login_required' }) }),
  })
  const result = await executor.runNext(owner)
  assert.equal(result.status, 'human')
  assert.equal(destroyed, 0)
})
