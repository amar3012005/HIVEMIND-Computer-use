import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { AgentScopeComputerBridge } from './agentscope-bridge.mjs'
import { ComputerPoolManager } from './computer-pool-manager.mjs'
import { FileComputerRunStore } from './computer-run-store.mjs'
import { E2BComputer } from './e2b-computer.mjs'
import { ComputerLeaseManager } from './lease-manager.mjs'
import { ReceiptStore } from './receipt-store.mjs'

if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY is required in this process environment; never commit or log it.')

const { Sandbox } = await import('@e2b/desktop')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.join(root, 'evidence', new Date().toISOString().replaceAll(':', '-'))
const phase = name => console.log(JSON.stringify({ phase: name }))
await mkdir(outputDir, { recursive: true })

const desktopLeases = new ComputerLeaseManager({ maxActive: 2 })
const receipts = new ReceiptStore(outputDir)
const computers = []
const pool = new ComputerPoolManager({
  store: new FileComputerRunStore(outputDir), maxActive: 2, leaseMs: 5 * 60_000,
  createComputer: async run => {
    const computer = await E2BComputer.create({
      Sandbox, leaseManager: desktopLeases, owner: run.agent_run_id, receipts,
      evidenceDir: path.join(outputDir, 'artifacts', run.computer_run_id), allowInternetAccess: false,
      timeoutMs: 5 * 60_000, metadata: { app: 'hivemind', test: 'e2b-computer-pool-v1', computer_run_id: run.computer_run_id },
    })
    computer.sandboxId = computer.desktop.sandboxId
    computers.push(computer)
    return computer
  },
})
const bridge = new AgentScopeComputerBridge({ pool })
const task = agentRunId => ({ organization_id: 'e2b-canary-org', agent_run_id: agentRunId, objective: 'Read the public Example Domain heading.', browser_plan: { startUrl: 'https://example.com', completion: { kind: 'visible_text', selector: 'h1', expected_text: 'Example Domain' } }, allowed_domains: ['example.com'], max_steps: 2, timeout_ms: 30_000 })

let receipt
try {
  phase('acquire_two_e2b_desktops')
  const [first, second] = await Promise.all([bridge.runComputerTask(task('pool-agent-a')), bridge.runComputerTask(task('pool-agent-b'))])
  if (first.status !== 'accepted' || second.status !== 'accepted') throw new Error('E2B pool did not acquire two active desktops')
  phase('queue_third_task')
  const third = await bridge.runComputerTask(task('pool-agent-c'))
  if (third.status !== 'queued') throw new Error('Pool capacity did not queue the third task')
  phase('release_and_reassign')
  await pool.complete(first.computer_run_id, { status: 'workspace_ready' })
  await pool.transition(first.computer_run_id, 'released')
  const reassigned = await pool.get(third.computer_run_id)
  if (reassigned?.status !== 'agent' || !reassigned.sandbox_id) throw new Error('Queued task was not assigned a released pool slot')
  receipt = {
    contract: 'hivemind.e2b-computer-pool-canary.v1', status: 'completed',
    active_runs: [first.computer_run_id, second.computer_run_id, third.computer_run_id],
    reassign: { released_run_id: first.computer_run_id, assigned_run_id: third.computer_run_id, assigned_sandbox: reassigned.sandbox_id },
    assertions: { two_concurrent_e2b_desktops: true, third_task_queued: true, durable_computer_run_id: true, released_slot_reassigned: true },
  }
  await writeFile(path.join(outputDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(JSON.stringify({ status: receipt.status, receipt_path: path.join(outputDir, 'receipt.json') }))
} catch (error) {
  receipt = { contract: 'hivemind.e2b-computer-pool-canary.v1', status: 'failed_closed', error: { code: 'computer_pool_canary_failed', message: String(error?.message || error).slice(0, 300) } }
  await writeFile(path.join(outputDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  console.error(JSON.stringify({ status: receipt.status, receipt_path: path.join(outputDir, 'receipt.json'), error: receipt.error.code }))
  throw error
} finally {
  for (const computer of computers) await computer.kill().catch(() => {})
}
