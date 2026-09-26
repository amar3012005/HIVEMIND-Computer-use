const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'expired', 'released'])

function allowedHost(host, allowedDomains) {
  return allowedDomains.some(domain => host === domain || host.endsWith(`.${domain}`))
}

/** Build a non-site-specific plan adapter from a persisted bounded plan. */
export function browserPlanPlanner(run) {
  return {
    async compile(job) {
      const plan = run.browser_plan ?? run.browserPlan
      if (!plan || typeof plan !== 'object') throw new Error('computer_run_missing_browser_plan')
      const startUrl = String(plan.startUrl ?? plan.start_url ?? '')
      let parsed
      try { parsed = new URL(startUrl) } catch { throw new Error('computer_run_plan_start_url_invalid') }
      if (!['https:', 'http:'].includes(parsed.protocol) || !allowedHost(parsed.hostname, run.allowed_domains ?? [])) {
        throw new Error('computer_run_plan_start_url_not_allowed')
      }
      return { ...plan, startUrl, objective: job.objective }
    },
  }
}

function outcomeStatus(result) {
  if (result?.status === 'completed') return 'completed'
  if (result?.status === 'needs_human') return 'human'
  return 'failed'
}

/**
 * Claims durable work, assigns an isolated computer, and runs the generic
 * ComputerOperator. The injected factories keep provider lifecycle and browser
 * mechanics out of AgentScope and make the scheduler testable without E2B.
 */
export class ComputerRunExecutor {
  constructor({ control, workerId, computerFactory, operatorFactory, heartbeatMs = 30_000, timers = globalThis } = {}) {
    if (!control?.claim || !control?.transition || !control?.heartbeat) throw new TypeError('durable computer control client is required')
    if (!workerId) throw new TypeError('computer executor workerId is required')
    if (typeof computerFactory !== 'function' || typeof operatorFactory !== 'function') throw new TypeError('computer/operator factories are required')
    this.control = control
    this.workerId = workerId
    this.computerFactory = computerFactory
    this.operatorFactory = operatorFactory
    this.heartbeatMs = heartbeatMs
    this.timers = timers
  }

  async runNext({ organizationId, userId }) {
    const run = await this.control.claim({ worker_id: this.workerId, organization_id: organizationId, user_id: userId })
    return run ? this.run(run) : null
  }

  async run(run) {
    const rawOrganizationId = run.org_id ?? run.organization_id
    const rawUserId = run.user_id ?? run.userId
    const rawId = run.computer_run_id ?? run.id
    if (!rawId || !rawOrganizationId || !rawUserId) throw new Error('computer_run_owner_required')
    const owner = { organizationId: String(rawOrganizationId), userId: String(rawUserId) }
    const id = String(rawId)
    let computer
    let heartbeat
    let finalStatus = 'failed'
    try {
      computer = await this.computerFactory({ run })
      const sandboxId = computer?.sandboxId ?? computer?.sandbox_id ?? null
      await this.control.transition(id, {
        organization_id: owner.organizationId, user_id: owner.userId, status: 'agent', sandbox_id: sandboxId,
      })
      heartbeat = this.timers.setInterval(() => {
        void this.control.heartbeat(id, owner).catch(() => undefined)
      }, this.heartbeatMs)

      const operator = await this.operatorFactory({ run, computer, planner: browserPlanPlanner(run) })
      const result = await operator.run({
        id,
        objective: run.objective,
        permissions: ['navigate', 'read'],
        limits: run.limits,
      })
      finalStatus = outcomeStatus(result)
      const persisted = await this.control.transition(id, {
        organization_id: owner.organizationId,
        user_id: owner.userId,
        status: finalStatus,
        sandbox_id: sandboxId,
        result: { status: result.status, steps: result.steps ?? 0, reason: result.reason ?? null },
        evidence: Array.isArray(result.evidence) ? result.evidence : [],
      })
      return persisted
    } catch (error) {
      const safeResult = { status: 'failed', reason: 'computer_executor_failed' }
      try {
        await this.control.transition(id, {
          organization_id: owner.organizationId, user_id: owner.userId, status: 'failed', result: safeResult, evidence: [],
        })
      } catch { /* durable control outage: original error still fails the worker */ }
      throw error
    } finally {
      if (heartbeat) this.timers.clearInterval(heartbeat)
      // Human takeover intentionally retains the E2B lease; all terminal
      // execution paths destroy their ephemeral computer.
      if (computer && finalStatus !== 'human' && TERMINAL.has(finalStatus)) {
        await computer.destroy?.()
      }
    }
  }
}
