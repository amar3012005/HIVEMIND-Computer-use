import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { ComputerPoolManager } from './computer-pool-manager.mjs'
import { FileComputerRunStore } from './computer-run-store.mjs'
import { createComputerPoolServer } from './computer-pool-server.mjs'
import { createE2BOperatorFactories } from './e2b-operator-factory.mjs'
import { cloudflareJevDecisionConfig } from './operator/jev-decision.mjs'

if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY is required; never commit or log it.')
if (!process.env.HIVEMIND_COMPUTER_POOL_CONTROL_TOKEN) throw new Error('HIVEMIND_COMPUTER_POOL_CONTROL_TOKEN is required; never commit or log it.')

const { Sandbox } = await import('@e2b/desktop')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stateDir = process.env.HIVEMIND_COMPUTER_POOL_STATE_DIR ?? path.join(root, 'pool-state')
const port = Number(process.env.HIVEMIND_COMPUTER_POOL_PORT ?? 8789)
const host = process.env.HIVEMIND_COMPUTER_POOL_HOST ?? '127.0.0.1'
const maxActive = Number(process.env.HIVEMIND_COMPUTER_POOL_MAX_ACTIVE ?? 2)
const template = process.env.E2B_TEMPLATE_NAME ?? 'hm-computer-operator-canary-v5'
const jevConfig = process.env.HM_JEV_CANARY === '1' ? cloudflareJevDecisionConfig() : null
if (process.env.HM_JEV_CANARY === '1' && !jevConfig) throw new Error('HM_JEV_CANARY requires Cloudflare custom-provider credentials; never commit or log values.')

await mkdir(stateDir, { recursive: true })
const { computerFactory, operatorFactory } = createE2BOperatorFactories({ Sandbox, template, jevConfig })
const humanSessions = new Map()
function safeFailureCode(error) {
  const message = String(error?.message || error || '')
    .replace(/Bearer\s+[^\s]+/ig, 'Bearer [redacted]')
    .replace(/e2b_[a-z0-9_-]+/ig, '[redacted-e2b-key]')
    .replace(/[a-f0-9]{48,}/ig, '[redacted-token]')
    .replace(/https?:\/\/[^\s]+/ig, '[redacted-url]')
    .replace(/\s+/g, ' ').trim().slice(0, 180)
  return message || 'unknown_error'
}
const pool = new ComputerPoolManager({
  store: new FileComputerRunStore(stateDir), maxActive,
  createComputer: async run => {
    const computer = await computerFactory({ run })
    // Pool owns lifecycle and destroys terminal runs. The E2B factory uses the
    // more explicit `destroy` name; adapt it to the pool's private handle API.
    computer.kill = computer.destroy
    return computer
  },
})

async function executeRun(submitted) {
  const run = await pool.get(submitted.computer_run_id)
  const computer = pool.getComputer(submitted.computer_run_id)
  if (!run || !computer || run.status !== 'agent') return
  try {
    const operator = await operatorFactory({ run, computer })
    const result = await operator.run()
    const safeResult = {
      status: String(result?.status || 'failed').slice(0, 40),
      steps: Number.isFinite(Number(result?.steps)) ? Number(result.steps) : 0,
      reason: result?.reason ? String(result.reason).slice(0, 240) : null,
      result: result?.result ?? null,
    }
    const evidence = Array.isArray(result?.evidence) ? result.evidence.slice(0, 100) : []
    if (result?.status === 'completed') {
      await pool.complete(run.computer_run_id, safeResult, evidence)
      return
    }
    if (result?.status === 'needs_human' || result?.status === 'human') {
      let humanSessionAvailable = false
      try {
        if (computer.desktop?.stream?.start && computer.desktop?.stream?.getAuthKey && computer.desktop?.stream?.getUrl) {
          await computer.desktop.stream.start({ requireAuth: true })
          const authKey = await computer.desktop.stream.getAuthKey()
          humanSessions.set(run.computer_run_id, computer.desktop.stream.getUrl({ authKey, autoConnect: true }))
          humanSessionAvailable = true
        }
      } catch { /* Keep the durable human handoff even if streaming is unavailable. */ }
      await pool.transition(run.computer_run_id, 'human', {
        result: { ...safeResult, status: 'needs_human', human_session_available: humanSessionAvailable }, evidence,
      })
      return
    }
    await pool.transition(run.computer_run_id, 'failed', { result: safeResult, evidence })
  } catch (error) {
    console.error(JSON.stringify({ event: 'computer_run_failed', computer_run_id: run.computer_run_id, error: safeFailureCode(error) }))
    const current = await pool.get(run.computer_run_id)
    if (current?.status === 'agent') {
      await pool.transition(run.computer_run_id, 'failed', { result: { status: 'failed', reason: 'computer_executor_failed' } })
    }
  }
}

const controlToken = process.env.HIVEMIND_COMPUTER_POOL_CONTROL_TOKEN
const server = createComputerPoolServer({
  pool,
  executeRun,
  getHumanSession: async id => humanSessions.get(id) ?? null,
  authorize: async request => request.headers.authorization === `Bearer ${controlToken}`
    ? { organization_id: request.headers['x-hivemind-organization-id'] || null }
    : null,
})
server.listen(port, host, () => console.log(`HIVE-MIND computer pool listening on ${host}:${port}`))

// Drain queued work and expire abandoned leases without tying up a request.
const maintenance = setInterval(async () => {
  try {
    await pool.reclaimExpired()
    while (true) {
      const next = await pool.startNext()
      if (!next) break
      if (next.status === 'agent') executeRun(next)
    }
  } catch { /* A later maintenance tick retries; durable status remains inspectable. */ }
}, 15_000)
maintenance.unref()

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  clearInterval(maintenance)
  pool.shutdown().finally(() => server.close(() => process.exit(0)))
})
