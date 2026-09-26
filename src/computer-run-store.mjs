import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const EMPTY = Object.freeze({ version: 1, runs: [] })

function clone(value) { return structuredClone(value) }

/**
 * Durable run-record port. Production must implement this against PostgreSQL
 * with a row lock; this JSON implementation is deliberately only for the
 * single-controller E2E canary.
 */
export class FileComputerRunStore {
  constructor(root) {
    this.root = root
    this.file = path.join(root, 'computer-runs.json')
    this.queue = Promise.resolve()
  }

  async #read() {
    try { return JSON.parse(await readFile(this.file, 'utf8')) }
    catch (error) {
      if (error.code === 'ENOENT') return clone(EMPTY)
      throw error
    }
  }

  async #write(data) {
    await mkdir(this.root, { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`)
    await rename(temporary, this.file)
  }

  async transaction(callback) {
    const work = this.queue.then(async () => {
      const data = await this.#read()
      const result = await callback(data.runs)
      await this.#write(data)
      return clone(result)
    })
    this.queue = work.catch(() => {})
    return work
  }

  async list() { return this.transaction(runs => runs) }
  async get(computerRunId) { return this.transaction(runs => runs.find(run => run.computer_run_id === computerRunId) ?? null) }
}

export const POSTGRES_COMPUTER_POOL_SCHEMA = `
CREATE TABLE computer_runs (
  computer_run_id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  client_id TEXT NOT NULL,
  client_run_id TEXT,
  agent_run_id TEXT,
  idempotency_key TEXT,
  objective TEXT NOT NULL,
  browser_plan JSONB NOT NULL,
  allowed_domains JSONB NOT NULL,
  limits JSONB NOT NULL,
  status TEXT NOT NULL,
  sandbox_id TEXT,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  result JSONB,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE TABLE computer_run_events (
  computer_run_id UUID NOT NULL REFERENCES computer_runs(computer_run_id) ON DELETE CASCADE,
  event_id BIGINT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (computer_run_id, event_id)
);
CREATE UNIQUE INDEX computer_runs_org_idempotency_idx
  ON computer_runs (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX computer_runs_active_lease_idx
  ON computer_runs (status, lease_expires_at)
  WHERE status IN ('queued', 'starting', 'agent', 'human', 'paused');
`
