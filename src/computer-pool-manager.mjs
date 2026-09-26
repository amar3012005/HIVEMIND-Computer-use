import { randomUUID } from 'node:crypto'

const ACTIVE = new Set(['starting', 'agent', 'human', 'paused'])
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'released', 'expired'])
const TRANSITIONS = {
  queued: new Set(['starting', 'cancelled', 'expired']),
  starting: new Set(['agent', 'failed', 'cancelled', 'expired']),
  agent: new Set(['human', 'paused', 'completed', 'failed', 'cancelled', 'expired']),
  human: new Set(['agent', 'paused', 'cancelled', 'expired']),
  paused: new Set(['agent', 'completed', 'failed', 'cancelled', 'expired']),
  completed: new Set(['released']), failed: new Set(['released']), cancelled: new Set(['released']), expired: new Set(['released']), released: new Set(),
}

function iso(clock) { return new Date(clock()).toISOString() }
function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`)
  return value.trim()
}

function optionalIdempotencyKey(value) {
  if (value == null || value === '') return null
  return requireText(value, 'idempotency_key').slice(0, 200)
}

function appendStatusEvent(run, clock) {
  run.events ??= []
  run.events.push({
    event_id: run.events.length + 1,
    type: 'status',
    status: run.status,
    created_at: iso(clock),
  })
}

export function validateComputerSubgoal(input) {
  if (!input || typeof input !== 'object') throw new TypeError('computer sub-goal must be an object')
  const objective = requireText(input.objective, 'objective')
  const organizationId = requireText(input.organization_id, 'organization_id')
  const clientId = requireText(input.client_id ?? (input.agent_run_id ? 'agentscope' : ''), 'client_id')
  const agentRunId = input.agent_run_id == null ? null : requireText(input.agent_run_id, 'agent_run_id')
  const clientRunId = input.client_run_id == null ? null : requireText(input.client_run_id, 'client_run_id')
  const idempotencyKey = optionalIdempotencyKey(input.idempotency_key)
  if (!input.browser_plan || typeof input.browser_plan !== 'object' || Array.isArray(input.browser_plan)) throw new TypeError('browser_plan is required')
  const completion = input.browser_plan.completion
  if (!requireText(input.browser_plan.startUrl, 'browser_plan.startUrl') || !completion || completion.kind !== 'visible_text' || !requireText(completion.selector, 'browser_plan.completion.selector')) {
    throw new TypeError('browser_plan completion must be visible_text with selector')
  }
  if (!Array.isArray(input.allowed_domains) || !input.allowed_domains.length) throw new TypeError('allowed_domains must be a non-empty array')
  const allowedDomains = [...new Set(input.allowed_domains.map(domain => String(domain).trim().toLowerCase()).filter(Boolean))]
  if (allowedDomains.some(domain => !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(domain))) throw new TypeError('allowed_domains must contain host names only')
  const limits = {
    max_steps: Math.min(Math.max(Number(input.limits?.max_steps ?? 12), 1), 50),
    timeout_ms: Math.min(Math.max(Number(input.limits?.timeout_ms ?? 120_000), 1_000), 15 * 60_000),
  }
  if (!Number.isInteger(limits.max_steps) || !Number.isInteger(limits.timeout_ms)) throw new TypeError('limits must be integers')
  return { objective, organization_id: organizationId, client_id: clientId, client_run_id: clientRunId, agent_run_id: agentRunId, idempotency_key: idempotencyKey, browser_plan: input.browser_plan, allowed_domains: allowedDomains, limits }
}

/**
 * Lease coordinator. It owns capacity, expiry, handoff state and durable IDs;
 * it deliberately does not know any website or business workflow.
 */
export class ComputerPoolManager {
  constructor({ store, createComputer, maxActive = 2, leaseMs = 15 * 60_000, clock = Date.now } = {}) {
    if (!store?.transaction) throw new TypeError('store.transaction is required')
    if (typeof createComputer !== 'function') throw new TypeError('createComputer is required')
    this.store = store; this.createComputer = createComputer; this.maxActive = maxActive; this.leaseMs = leaseMs; this.clock = clock
    this.live = new Map()
    this.provisioning = new Map()
    this.closed = false
  }

  async submit(input, { deferProvision = false } = {}) {
    if (this.closed) throw new Error('computer_pool_closed')
    const job = validateComputerSubgoal(input)
    const created = await this.store.transaction(runs => {
      const idempotencyKey = job.idempotency_key
      if (idempotencyKey) {
        const existing = runs.find(run => run.organization_id === job.organization_id && run.idempotency_key === idempotencyKey)
        if (existing) return { existing: true, run: existing }
      }
      const now = this.clock()
      const active = runs.filter(run => ACTIVE.has(run.status) && Date.parse(run.lease_expires_at) > now).length
      const run = {
        computer_run_id: randomUUID(), ...job, status: active >= this.maxActive ? 'queued' : 'starting', sandbox_id: null,
        lease_expires_at: new Date(now + this.leaseMs).toISOString(), created_at: iso(this.clock), updated_at: iso(this.clock), result: null, evidence: [], events: [],
      }
      appendStatusEvent(run, this.clock)
      runs.push(run); return { existing: false, run }
    })
    if (created.existing) return this.get(created.run.computer_run_id)
    const run = created.run
    if (run.status === 'starting' && !deferProvision) await this.provision(run.computer_run_id)
    return this.get(run.computer_run_id)
  }

  async get(computerRunId) { return this.store.get(computerRunId) }
  async list() { return this.store.list() }

  async provision(computerRunId) {
    if (this.provisioning.has(computerRunId)) return this.provisioning.get(computerRunId)
    const work = this.#provision(computerRunId)
    this.provisioning.set(computerRunId, work)
    try { await work } finally { this.provisioning.delete(computerRunId) }
    return this.get(computerRunId)
  }

  // The HTTP control plane may start the operator after the lease is
  // provisioned. Keep the sandbox handle private to the pool process; never
  // serialize it into the durable run receipt.
  getComputer(computerRunId) { return this.live.get(computerRunId) ?? null }

  async startNext() {
    if (this.closed) return null
    const next = await this.store.transaction(runs => {
      const now = this.clock()
      const active = runs.filter(run => ACTIVE.has(run.status) && Date.parse(run.lease_expires_at) > now).length
      if (active >= this.maxActive) return null
      const run = runs.find(item => item.status === 'queued')
      if (!run) return null
      run.status = 'starting'; run.updated_at = iso(this.clock); run.lease_expires_at = new Date(now + this.leaseMs).toISOString(); appendStatusEvent(run, this.clock); return run
    })
    if (!next) return null
    await this.provision(next.computer_run_id)
    return this.get(next.computer_run_id)
  }

  async transition(computerRunId, status, patch = {}) {
    const updated = await this.store.transaction(runs => {
      const run = runs.find(item => item.computer_run_id === computerRunId)
      if (!run) throw new Error(`unknown computer_run_id: ${computerRunId}`)
      if (!TRANSITIONS[run.status]?.has(status)) throw new Error(`invalid computer run transition: ${run.status} -> ${status}`)
      run.status = status; run.updated_at = iso(this.clock)
      if (patch.result !== undefined) run.result = patch.result
      if (patch.evidence) run.evidence = [...run.evidence, ...patch.evidence]
      appendStatusEvent(run, this.clock)
      return run
    })
    if (TERMINAL.has(status)) await this.#destroy(computerRunId)
    if (status === 'released') await this.startNext()
    return updated
  }

  async requestHumanTakeover(computerRunId) { return this.transition(computerRunId, 'human') }
  async resumeAgent(computerRunId) { return this.transition(computerRunId, 'agent') }
  async complete(computerRunId, result, evidence = []) { return this.transition(computerRunId, 'completed', { result, evidence }) }
  async cancel(computerRunId) { return this.transition(computerRunId, 'cancelled') }

  async reclaimExpired() {
    const expired = await this.store.transaction(runs => {
      const now = this.clock(); const selected = []
      for (const run of runs) if (ACTIVE.has(run.status) && Date.parse(run.lease_expires_at) <= now) {
        run.status = 'expired'; run.updated_at = iso(this.clock); appendStatusEvent(run, this.clock); selected.push({ ...run })
      }
      return selected
    })
    for (const run of expired) await this.#destroy(run.computer_run_id)
    for (const run of expired) await this.transition(run.computer_run_id, 'released')
    return expired
  }

  async shutdown() {
    this.closed = true
    const active = await this.store.transaction(runs => {
      const selected = []
      for (const run of runs) if (ACTIVE.has(run.status)) {
        run.status = 'cancelled'; run.updated_at = iso(this.clock); appendStatusEvent(run, this.clock); selected.push({ ...run })
      }
      return selected
    })
    for (const run of active) await this.#destroy(run.computer_run_id)
    return active
  }

  async #provision(computerRunId) {
    const run = await this.get(computerRunId)
    try {
      const computer = await this.createComputer(run)
      this.live.set(computerRunId, computer)
      await this.store.transaction(runs => {
        const item = runs.find(candidate => candidate.computer_run_id === computerRunId)
        item.sandbox_id = computer.sandboxId ?? null; item.status = 'agent'; item.updated_at = iso(this.clock)
        appendStatusEvent(item, this.clock)
        return item
      })
    } catch (error) {
      await this.store.transaction(runs => {
        const item = runs.find(candidate => candidate.computer_run_id === computerRunId)
        item.status = 'failed'; item.result = { code: 'computer_provision_failed', message: String(error?.message || error).slice(0, 240) }; item.updated_at = iso(this.clock)
        appendStatusEvent(item, this.clock)
        return item
      })
    }
  }

  async #destroy(computerRunId) {
    const computer = this.live.get(computerRunId)
    this.live.delete(computerRunId)
    await computer?.kill?.().catch(() => {})
  }
}
