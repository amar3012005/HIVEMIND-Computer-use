import assert from 'node:assert/strict'
import test from 'node:test'
import { createE2BOperatorFactories } from '../src/e2b-operator-factory.mjs'

const run = {
  computer_run_id: 'run-1', objective: 'Read a public heading', allowed_domains: ['example.com'],
  browser_plan: { startUrl: 'https://example.com/', completion: { kind: 'visible_text', selector: 'h1' } },
  limits: { max_steps: 3, timeout_ms: 1000 },
}

test('E2B factory runs the generic ComputerOperator worker inside the desktop', async () => {
  const writes = []
  const commands = []
  let killed = 0
  const desktop = {
    sandboxId: 'sandbox-safe-id',
    files: { write: async (path, content) => { writes.push({ path, content: JSON.parse(content) }) } },
    commands: { run: async (command, options) => {
      commands.push({ command, options })
      if (options?.background) return { kill: async () => { killed += 1 } }
      return { exitCode: 0, stdout: JSON.stringify({ status: 'completed', steps: 1, evidence: [] }) }
    } },
    waitAndVerify: async () => true,
    kill: async () => { killed += 1 },
  }
  const { computerFactory, operatorFactory } = createE2BOperatorFactories({ Sandbox: { create: async () => desktop }, template: 'template-id' })
  const computer = await computerFactory({ run })
  const operator = await operatorFactory({ run, computer })
  const result = await operator.run()
  assert.equal(result.status, 'completed')
  assert.equal(writes[0].content.browser_plan.startUrl, 'https://example.com/')
  assert.match(commands.at(-1).command, /node executor\.mjs/)
  await computer.destroy()
  assert.equal(killed, 2)
})
