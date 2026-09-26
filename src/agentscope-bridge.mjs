import { validateComputerSubgoal } from './computer-pool-manager.mjs'

/**
 * The only contract AgentScope needs. A model supplies a bounded sub-goal;
 * this bridge returns a durable ID and never exposes E2B credentials or a VNC
 * URL. The service can later stream lifecycle events by computer_run_id.
 */
export class AgentScopeComputerBridge {
  constructor({ pool }) { if (!pool?.submit) throw new TypeError('pool.submit is required'); this.pool = pool }

  async runComputerTask({ organization_id, agent_run_id, objective, allowed_domains, browser_plan, max_steps = 12, timeout_ms = 120_000 }) {
    const accepted = await this.pool.submit(validateComputerSubgoal({
      organization_id, agent_run_id, objective, allowed_domains,
      browser_plan,
      limits: { max_steps, timeout_ms },
    }))
    return {
      status: accepted.status === 'queued' ? 'queued' : 'accepted', computer_run_id: accepted.computer_run_id,
      lifecycle: accepted.status, allowed_domains: accepted.allowed_domains, limits: accepted.limits,
      message: accepted.status === 'queued' ? 'No computer is idle; task is queued.' : 'Computer task accepted; poll computer_run_id for evidence or takeover.',
    }
  }

  async inspectComputerTask(computerRunId) {
    const run = await this.pool.get(computerRunId)
    if (!run) throw new Error(`unknown computer_run_id: ${computerRunId}`)
    return { computer_run_id: run.computer_run_id, status: run.status, result: run.result, evidence: run.evidence }
  }
}
