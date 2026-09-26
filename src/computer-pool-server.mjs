import http from 'node:http'

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

async function readJson(request) {
  let payload = ''
  for await (const chunk of request) {
    payload += chunk
    if (payload.length > 64 * 1024) throw new Error('request_too_large')
  }
  return JSON.parse(payload || '{}')
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'released', 'expired'])

function publicRun(run) {
  return {
    computer_run_id: run.computer_run_id,
    client_id: run.client_id,
    client_run_id: run.client_run_id ?? null,
    agent_run_id: run.agent_run_id ?? null,
    status: run.status,
    lease_expires_at: run.lease_expires_at,
    created_at: run.created_at,
    updated_at: run.updated_at,
    result: run.result,
    evidence: run.evidence ?? [],
  }
}

function writeRunEvent(response, run, event) {
  const data = {
    computer_run_id: run.computer_run_id,
    event_id: event.event_id,
    type: event.type,
    status: event.status,
    created_at: event.created_at,
  }
  response.write(`id: ${event.event_id}\nevent: computer.run.status\ndata: ${JSON.stringify(data)}\n\n`)
}

async function streamRunEvents(request, response, pool, computerRunId, initialRun, afterEventId) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  response.write('retry: 2000\n\n')
  let run = initialRun
  let cursor = afterEventId
  while (!request.destroyed && !response.destroyed) {
    run ??= await pool.get(computerRunId)
    if (!run) break
    for (const event of run.events ?? []) {
      if (Number(event.event_id) <= cursor) continue
      writeRunEvent(response, run, event)
      cursor = Number(event.event_id)
    }
    if (TERMINAL.has(run.status)) break
    response.write(': keep-alive\n\n')
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); response.off('close', done); resolve() }
      const timer = setTimeout(done, 400)
      timer.unref?.()
      response.once('close', done)
    })
    run = null
  }
  if (!response.destroyed) response.end()
}

/**
 * Internal control-plane HTTP boundary. `authorize` is mandatory so a pool
 * cannot become an unauthenticated desktop launcher when it is deployed.
 */
export function createComputerPoolServer({ pool, authorize, executeRun = null, getHumanSession = null }) {
  if (!pool?.submit || !pool?.get) throw new TypeError('pool with submit/get is required')
  if (typeof authorize !== 'function') throw new TypeError('authorize(request, body) is required')
  if (executeRun !== null && typeof executeRun !== 'function') throw new TypeError('executeRun must be a function')
  const executing = new Set()

  const schedule = run => {
    if (!executeRun || !run || !['starting', 'agent'].includes(run.status) || executing.has(run.computer_run_id)) return
    executing.add(run.computer_run_id)
    void Promise.resolve().then(async () => {
      if (run.status === 'starting') await pool.provision(run.computer_run_id)
      const current = await pool.get(run.computer_run_id)
      if (current?.status === 'agent') await executeRun(current)
    }).catch(async () => {
      const current = await pool.get(run.computer_run_id).catch(() => null)
      if (['starting', 'agent'].includes(current?.status)) {
        await pool.transition(run.computer_run_id, 'failed', { result: { status: 'failed', reason: 'computer_executor_failed' } }).catch(() => {})
      }
    }).finally(() => executing.delete(run.computer_run_id))
  }

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://computer-pool.internal')
      if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { status: 'ok' })
      const body = request.method === 'POST' ? await readJson(request) : null
      const principal = await authorize(request, body)
      if (!principal) return json(response, 401, { status: 'blocked', reason: 'computer_pool_unauthorized' })
      if (request.method === 'POST' && url.pathname === '/v1/computer-runs') {
        const idempotencyKey = String(request.headers['idempotency-key'] || '').trim()
        if (idempotencyKey) body.idempotency_key = idempotencyKey
        if (principal.organization_id && principal.organization_id !== body.organization_id) return json(response, 403, { status: 'blocked', reason: 'organization_scope_mismatch' })
        const run = await pool.submit(body, { deferProvision: Boolean(executeRun) })
        schedule(run)
        return json(response, 202, run)
      }
      const match = url.pathname.match(/^\/v1\/computer-runs\/([0-9a-f-]{36})(?:\/(events|human-takeover|human-session|resume|cancel))?$/i)
      if (!match) return json(response, 404, { status: 'not_found' })
      const run = await pool.get(match[1])
      if (!run) return json(response, 404, { status: 'not_found' })
      if (principal.organization_id && principal.organization_id !== run.organization_id) return json(response, 403, { status: 'blocked', reason: 'organization_scope_mismatch' })
      if (request.method === 'GET' && !match[2]) return json(response, 200, publicRun(run))
      if (request.method === 'GET' && match[2] === 'events') {
        const headerCursor = Number(request.headers['last-event-id'])
        const queryCursor = Number(url.searchParams.get('after') || 0)
        const cursor = Number.isSafeInteger(headerCursor) && headerCursor > 0
          ? headerCursor
          : Number.isSafeInteger(queryCursor) && queryCursor > 0 ? queryCursor : 0
        return await streamRunEvents(request, response, pool, match[1], run, cursor)
      }
      if (request.method === 'GET' && match[2] === 'human-session' && typeof getHumanSession === 'function') {
        const session = await getHumanSession(match[1])
        return session ? json(response, 200, { computer_run_id: match[1], url: session }) : json(response, 404, { status: 'not_available' })
      }
      if (request.method === 'POST' && match[2] === 'human-takeover') return json(response, 200, await pool.requestHumanTakeover(match[1]))
      if (request.method === 'POST' && match[2] === 'resume') return json(response, 200, await pool.resumeAgent(match[1]))
      if (request.method === 'POST' && match[2] === 'cancel') return json(response, 200, await pool.cancel(match[1]))
      return json(response, 405, { status: 'method_not_allowed' })
    } catch (error) {
      const message = String(error?.message || error)
      const status = /required|allowed_domains|limits|objective|browser_plan|completion|client_id|client_run_id/.test(message) ? 400 : 500
      return json(response, status, { status: 'failed_closed', reason: status === 400 ? 'invalid_computer_subgoal' : 'computer_pool_request_failed' })
    }
  })
}
