import { randomUUID } from 'node:crypto'
import { RemoteComputerControlClient } from './remote-computer-control-client.mjs'
import { ComputerRunExecutor } from './computer-run-executor.mjs'
import { createE2BOperatorFactories } from './e2b-operator-factory.mjs'
import { cloudflareJevDecisionConfig, directDevelopmentJevDecisionConfig } from './operator/jev-decision.mjs'

const baseUrl = process.env.HIVEMIND_COMPUTER_POOL_URL
const hmacSecret = process.env.HIVEMIND_COMPUTER_POOL_HMAC_SECRET
const organizationId = process.env.HIVEMIND_COMPUTER_POOL_ORGANIZATION_ID
const userId = process.env.HIVEMIND_COMPUTER_POOL_USER_ID
const template = process.env.E2B_TEMPLATE_NAME
if (!process.env.E2B_API_KEY || !baseUrl || !hmacSecret || !organizationId || !userId || !template) {
  throw new Error('computer_executor_requires_e2b_and_tenant_control_configuration')
}
const { Sandbox } = await import('@e2b/desktop')
const control = new RemoteComputerControlClient({ baseUrl, hmacSecret })
const directJev = directDevelopmentJevDecisionConfig()
const gatewayJev = directJev ? null : process.env.HM_JEV_ENABLED === '1' ? cloudflareJevDecisionConfig() : null
const { computerFactory, operatorFactory } = createE2BOperatorFactories({
  Sandbox, template, jevConfig: directJev ?? gatewayJev,
})
const executor = new ComputerRunExecutor({ control, workerId: process.env.HIVEMIND_COMPUTER_POOL_WORKER_ID || `e2b-worker-${randomUUID()}`, computerFactory, operatorFactory })
const result = await executor.runNext({ organizationId, userId })
console.log(JSON.stringify({ status: result?.status ?? 'idle', computer_run_id: result?.computer_run_id ?? null }))
