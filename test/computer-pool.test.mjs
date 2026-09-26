import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AgentScopeComputerBridge } from '../src/agentscope-bridge.mjs'
import { ComputerPoolManager, validateComputerSubgoal } from '../src/computer-pool-manager.mjs'
import { FileComputerRunStore } from '../src/computer-run-store.mjs'
import { WholeDesktopDriver } from '../src/whole-desktop-driver.mjs'
import { createComputerPoolServer } from '../src/computer-pool-server.mjs'
import { ComputerPoolClient } from '../src/computer-pool-client.mjs'

async function setup({ maxActive = 2, clock = () => Date.UTC(2026, 8, 22) } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hm-computer-pool-'))
  const created = []
  const pool = new ComputerPoolManager({ store: new FileComputerRunStore(root), maxActive, clock, createComputer: async run => {
    const computer = { sandboxId: `sandbox-${created.length + 1}`, killed: false, kill: async () => { computer.killed = true } }
    created.push({ run, computer }); return computer
  } })
  return { root, pool, created }
}

const browserPlan = { startUrl: 'https://example.com', completion: { kind: 'visible_text', selector: 'h1', expected_text: 'Example Domain' } }
const job = (suffix = '1') => ({ organization_id: 'org-1', agent_run_id: `agent-${suffix}`, objective: 'Read the public example site.', browser_plan: browserPlan, allowed_domains: ['example.com'], limits: { max_steps: 3, timeout_ms: 10_000 } })

test('pool persists durable IDs, enforces capacity, and starts queued work after release', async () => {
  const { root, pool, created } = await setup()
  const first = await pool.submit(job('1')); const second = await pool.submit(job('2')); const third = await pool.submit(job('3'))
  assert.equal(first.status, 'agent'); assert.equal(second.status, 'agent'); assert.equal(third.status, 'queued'); assert.equal(created.length, 2)
  await pool.complete(first.computer_run_id, { fact: 'Example Domain' }, [{ kind: 'dom', value: 'Example Domain' }])
  await pool.transition(first.computer_run_id, 'released')
  const started = await pool.get(third.computer_run_id)
  assert.equal(started.status, 'agent'); assert.equal(created.length, 3); assert.equal(created[0].computer.killed, true)
  const stored = JSON.parse(await readFile(path.join(root, 'computer-runs.json'), 'utf8'))
  assert.equal(stored.runs.length, 3); assert.equal(stored.runs[0].result.fact, 'Example Domain')
})

test('AgentScope bridge accepts only bounded computer sub-goals and keeps VNC details out', async () => {
  const { pool } = await setup({ maxActive: 1 })
  const bridge = new AgentScopeComputerBridge({ pool })
  const result = await bridge.runComputerTask({ organization_id: 'org-1', agent_run_id: 'room-turn-1', objective: 'Read a public page.', browser_plan: browserPlan, allowed_domains: ['example.com'], max_steps: 2, timeout_ms: 5_000 })
  assert.equal(result.status, 'accepted'); assert.match(result.computer_run_id, /^[0-9a-f-]{36}$/); assert.doesNotMatch(JSON.stringify(result), /vnc|password|token/i)
  await assert.rejects(() => bridge.runComputerTask({ organization_id: 'org-1', agent_run_id: 'room-turn-2', objective: 'anything', browser_plan: browserPlan, allowed_domains: ['https://bad.example'] }), /host names only/)
})

test('reclaim transitions expired leases to released and kills the live computer', async () => {
  let now = Date.UTC(2026, 8, 22)
  const { pool, created } = await setup({ maxActive: 1, clock: () => now })
  const active = await pool.submit(job('expire'))
  now += 16 * 60_000
  const expired = await pool.reclaimExpired()
  assert.equal(expired.length, 1); assert.equal((await pool.get(active.computer_run_id)).status, 'released'); assert.equal(created[0].computer.killed, true)
})

test('shutdown cancels active computers and rejects a later task', async () => {
  const { pool, created } = await setup({ maxActive: 1 })
  await pool.submit(job('shutdown'))
  const stopped = await pool.shutdown()
  assert.equal(stopped.length, 1); assert.equal(created[0].computer.killed, true)
  await assert.rejects(() => pool.submit(job('late')), /computer_pool_closed/)
})

test('whole-desktop adapter only exposes concrete screen actions', async () => {
  const calls = []
  const driver = new WholeDesktopDriver({ desktop: {
    commands: { run: async command => { calls.push(command); return { stdout: command.includes('getactive') ? '42\nChrome\n' : '42\n43\n' } } },
    screenshot: async () => Buffer.from('screen'), leftClick: async (x, y) => calls.push(`click:${x},${y}`), write: async text => calls.push(`type:${text}`), press: async key => calls.push(`key:${key}`),
  } })
  const observation = await driver.observe(); await driver.click({ x: 10, y: 12 }); await driver.type({ text: 'hello' }); await driver.key({ key: 'enter' }); await driver.focusWindow({ window_id: '42' })
  assert.equal(observation.focused_window, '42\nChrome'); assert.deepEqual(observation.visible_window_ids, ['42', '43']); assert.deepEqual(calls.slice(-4), ['click:10,12', 'type:hello', 'key:enter', 'xdotool windowactivate --sync 42'])
})

test('whole-desktop OCR reads a screenshot through a fixed local command', async () => {
  const writes = []; const commands = []
  const driver = new WholeDesktopDriver({ desktop: {
    screenshot: async () => Buffer.from('screen'),
    files: { write: async (path, bytes) => writes.push({ path, bytes: Buffer.from(bytes).toString() }) },
    commands: { run: async command => { commands.push(command); return { stdout: 'Visible fact 40218\n' } } },
  } })
  const result = await driver.readScreenText()
  assert.deepEqual(result, { text: 'Visible fact 40218', engine: 'tesseract', source: 'desktop_screenshot' })
  assert.deepEqual(writes, [{ path: '/tmp/hm-computer-screen.png', bytes: 'screen' }])
  assert.deepEqual(commands, ['tesseract /tmp/hm-computer-screen.png stdout --psm 6 2>/dev/null'])
})

test('sub-goal validation caps worker limits before provisioning', () => {
  const valid = validateComputerSubgoal({ ...job(), limits: { max_steps: 999, timeout_ms: 99_999_999 } })
  assert.deepEqual(valid.limits, { max_steps: 50, timeout_ms: 900_000 })
})

test('internal pool HTTP boundary scopes AgentScope requests and exposes no desktop credential', async () => {
  const { pool } = await setup({ maxActive: 1 })
  const server = createComputerPoolServer({ pool, authorize: async request => request.headers.authorization === 'Bearer test-control-token' ? { organization_id: 'org-1' } : null })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address(); const base = `http://127.0.0.1:${address.port}`
    const health = await fetch(`${base}/healthz`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { status: 'ok' })
    const denied = await fetch(`${base}/v1/computer-runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(job()) })
    assert.equal(denied.status, 401)
    const accepted = await fetch(`${base}/v1/computer-runs`, { method: 'POST', headers: { authorization: 'Bearer test-control-token', 'content-type': 'application/json' }, body: JSON.stringify(job()) })
    assert.equal(accepted.status, 202)
    const body = await accepted.json(); assert.equal(body.status, 'agent'); assert.doesNotMatch(JSON.stringify(body), /vnc|password|token/i)
    const invalidPlan = await fetch(`${base}/v1/computer-runs`, {
      method: 'POST', headers: { authorization: 'Bearer test-control-token', 'content-type': 'application/json' },
      body: JSON.stringify({ ...job('invalid'), browser_plan: { startUrl: 'https://example.com', completion_selector: 'h1' } }),
    })
    assert.equal(invalidPlan.status, 400)
    assert.deepEqual(await invalidPlan.json(), { status: 'failed_closed', reason: 'invalid_computer_subgoal' })
    const wrongOrg = await fetch(`${base}/v1/computer-runs`, { method: 'POST', headers: { authorization: 'Bearer test-control-token', 'content-type': 'application/json' }, body: JSON.stringify({ ...job('other'), organization_id: 'org-other' }) })
    assert.equal(wrongOrg.status, 403)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('agent-neutral HTTP client submits, resumes status events, and reads verified evidence without AgentScope fields', async () => {
  const { pool, created } = await setup({ maxActive: 1 })
  const server = createComputerPoolServer({
    pool,
    authorize: async request => request.headers.authorization === 'Bearer test-control-token'
      ? { organization_id: request.headers['x-hivemind-organization-id'] || 'org-1' } : null,
    executeRun: async run => pool.complete(run.computer_run_id, {
      status: 'completed',
      result: { value: 'Example Domain', independent_http: true },
    }, [{ kind: 'browser_visible_text', selector: 'h1', value: 'Example Domain', source_url: 'https://example.com/' }]),
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    const client = new ComputerPoolClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: 'test-control-token',
      organizationId: 'org-1',
    })
    const subgoal = {
      client_id: 'standalone-test-agent',
      client_run_id: 'test-run-1',
      objective: 'Read the public Example Domain heading.',
      browser_plan: browserPlan,
      allowed_domains: ['example.com'],
      limits: { max_steps: 2, timeout_ms: 5_000 },
    }
    const accepted = await client.submit(subgoal, { idempotencyKey: 'standalone-test-idem-1' })
    assert.ok(accepted.computer_run_id)
    assert.equal(accepted.client_id, 'standalone-test-agent')
    assert.equal(accepted.agent_run_id, null)
    const replay = await client.submit(subgoal, { idempotencyKey: 'standalone-test-idem-1' })
    assert.equal(replay.computer_run_id, accepted.computer_run_id)
    const events = []
    for await (const event of client.events(accepted.computer_run_id)) events.push(event)
    assert.deepEqual(events.map(event => event.status), ['starting', 'agent', 'completed'])
    const resumedEvents = []
    for await (const event of client.events(accepted.computer_run_id, { afterEventId: events[0].event_id })) resumedEvents.push(event)
    assert.deepEqual(resumedEvents.map(event => event.status), ['agent', 'completed'], 'SSE cursor should replay only events after the acknowledged ID')
    const final = await client.get(accepted.computer_run_id)
    assert.equal(final.status, 'completed')
    assert.equal(final.result.result.value, 'Example Domain')
    assert.equal(final.evidence[0].source_url, 'https://example.com/')
    assert.equal(created.length, 1, 'idempotent replay must not provision a second computer')
    const wrongOrgClient = new ComputerPoolClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: 'test-control-token',
      organizationId: 'org-other',
    })
    await assert.rejects(wrongOrgClient.get(accepted.computer_run_id), error => error.status === 403)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('standalone HTTP client can cancel a run and replay its terminal status event', async () => {
  const { pool } = await setup({ maxActive: 1 })
  const server = createComputerPoolServer({
    pool,
    authorize: async request => request.headers.authorization === 'Bearer test-control-token'
      ? { organization_id: 'org-1' } : null,
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const client = new ComputerPoolClient({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      token: 'test-control-token',
      organizationId: 'org-1',
    })
    const accepted = await client.submit({
      client_id: 'standalone-test-agent',
      objective: 'Read the public Example Domain heading.',
      browser_plan: browserPlan,
      allowed_domains: ['example.com'],
    })
    const cancelled = await client.cancel(accepted.computer_run_id)
    assert.equal(cancelled.status, 'cancelled')
    const events = []
    for await (const event of client.events(accepted.computer_run_id)) events.push(event)
    assert.equal(events.at(-1).status, 'cancelled')
    assert.equal((await client.get(accepted.computer_run_id)).status, 'cancelled')
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('pool honors organization-scoped Idempotency-Key without provisioning twice', async () => {
  const { pool, created } = await setup({ maxActive: 1 })
  const server = createComputerPoolServer({ pool, authorize: async request => request.headers.authorization === 'Bearer test-control-token' ? { organization_id: 'org-1' } : null })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address(); const base = `http://127.0.0.1:${address.port}`
    const headers = { authorization: 'Bearer test-control-token', 'content-type': 'application/json', 'idempotency-key': 'reply-1:call-1' }
    const first = await fetch(`${base}/v1/computer-runs`, { method: 'POST', headers, body: JSON.stringify(job('idem')) })
    const firstBody = await first.json()
    const second = await fetch(`${base}/v1/computer-runs`, { method: 'POST', headers, body: JSON.stringify(job('idem-different-agent')) })
    const secondBody = await second.json()
    assert.equal(first.status, 202); assert.equal(second.status, 202)
    assert.equal(secondBody.computer_run_id, firstBody.computer_run_id)
    assert.equal(created.length, 1)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('pool HTTP submission executes once and persists the operator result', async () => {
  const { pool } = await setup({ maxActive: 1 })
  let calls = 0
  const server = createComputerPoolServer({
    pool,
    authorize: async request => request.headers.authorization === 'Bearer test-control-token' ? { organization_id: 'org-1' } : null,
    executeRun: async run => {
      calls += 1
      await pool.complete(run.computer_run_id, { status: 'completed', value: 'Example Domain' }, [{ kind: 'browser_visible_text', value: 'Example Domain' }])
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    const headers = { authorization: 'Bearer test-control-token', 'content-type': 'application/json', 'idempotency-key': 'execution-once' }
    const submitted = await fetch(`${base}/v1/computer-runs`, { method: 'POST', headers, body: JSON.stringify(job('execute')) })
    const accepted = await submitted.json()
    assert.equal(submitted.status, 202)
    assert.equal(accepted.status, 'starting', 'HTTP submit should return before E2B provisioning finishes')
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const current = await fetch(`${base}/v1/computer-runs/${accepted.computer_run_id}`, { headers })
      const body = await current.json()
      if (body.status === 'completed') {
        assert.equal(body.result.value, 'Example Domain')
        assert.equal(body.evidence[0].value, 'Example Domain')
        break
      }
      await new Promise(resolve => setTimeout(resolve, 5))
      if (attempt === 29) assert.fail('operator result was not persisted')
    }
    await fetch(`${base}/v1/computer-runs`, { method: 'POST', headers, body: JSON.stringify(job('execute-replay')) })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(calls, 1)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('human session URL is available only through the explicit authorized endpoint', async () => {
  const { pool } = await setup({ maxActive: 1 })
  const sessions = new Map()
  const server = createComputerPoolServer({
    pool,
    authorize: async request => request.headers.authorization === 'Bearer test-control-token' ? { organization_id: 'org-1' } : null,
    executeRun: async run => {
      sessions.set(run.computer_run_id, 'https://desktop.example/vnc.html?password=secret')
      await pool.transition(run.computer_run_id, 'human', { result: { status: 'needs_human', human_session_available: true } })
    },
    getHumanSession: async id => sessions.get(id),
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    const headers = { authorization: 'Bearer test-control-token', 'content-type': 'application/json' }
    const submitted = await fetch(`${base}/v1/computer-runs`, { method: 'POST', headers, body: JSON.stringify(job('human')) })
    const accepted = await submitted.json()
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const current = await fetch(`${base}/v1/computer-runs/${accepted.computer_run_id}`, { headers })
      if ((await current.json()).status === 'human') break
      await new Promise(resolve => setTimeout(resolve, 5))
      if (attempt === 29) assert.fail('human state was not persisted')
    }
    const denied = await fetch(`${base}/v1/computer-runs/${accepted.computer_run_id}/human-session`)
    assert.equal(denied.status, 401)
    const response = await fetch(`${base}/v1/computer-runs/${accepted.computer_run_id}/human-session`, { headers })
    assert.deepEqual(await response.json(), { computer_run_id: accepted.computer_run_id, url: 'https://desktop.example/vnc.html?password=secret' })
    const runResponse = await fetch(`${base}/v1/computer-runs/${accepted.computer_run_id}`, { headers })
    assert.doesNotMatch(await runResponse.text(), /password=secret/)
  } finally { await new Promise(resolve => server.close(resolve)) }
})
