import { randomUUID } from 'node:crypto'

/** Agent-neutral HTTP client for bounded computer runs and durable status. */
export class ComputerPoolClient {
  constructor({ baseUrl, token, organizationId, fetchImpl = fetch } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '')
    this.token = String(token || '')
    this.organizationId = String(organizationId || '')
    this.fetch = fetchImpl
    if (!this.baseUrl || !this.token || !this.organizationId) {
      throw new TypeError('baseUrl, token, and organizationId are required')
    }
  }

  headers(extra = {}) {
    return {
      accept: 'application/json',
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
      'x-hivemind-organization-id': this.organizationId,
      ...extra,
    }
  }

  async #json(url, init = {}) {
    const response = await this.fetch(`${this.baseUrl}${url}`, {
      ...init,
      headers: this.headers(init.headers),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error = new Error(body.reason || `computer_pool_http_${response.status}`)
      error.status = response.status
      throw error
    }
    return body
  }

  submit(subgoal, { idempotencyKey = randomUUID() } = {}) {
    return this.#json('/v1/computer-runs', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ ...subgoal, organization_id: this.organizationId }),
    })
  }

  get(computerRunId) {
    return this.#json(`/v1/computer-runs/${encodeURIComponent(computerRunId)}`)
  }

  cancel(computerRunId) {
    return this.#json(`/v1/computer-runs/${encodeURIComponent(computerRunId)}/cancel`, { method: 'POST' })
  }

  requestHumanTakeover(computerRunId) {
    return this.#json(`/v1/computer-runs/${encodeURIComponent(computerRunId)}/human-takeover`, { method: 'POST' })
  }

  resume(computerRunId) {
    return this.#json(`/v1/computer-runs/${encodeURIComponent(computerRunId)}/resume`, { method: 'POST' })
  }

  humanSession(computerRunId) {
    return this.#json(`/v1/computer-runs/${encodeURIComponent(computerRunId)}/human-session`)
  }

  async *events(computerRunId, { afterEventId = 0, signal } = {}) {
    const response = await this.fetch(
      `${this.baseUrl}/v1/computer-runs/${encodeURIComponent(computerRunId)}/events?after=${encodeURIComponent(afterEventId)}`,
      { headers: this.headers({ accept: 'text/event-stream' }), signal },
    )
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.reason || `computer_pool_http_${response.status}`)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        const blocks = buffer.replaceAll('\r\n', '\n').split('\n\n')
        buffer = blocks.pop() || ''
        for (const block of blocks) {
          if (!block || block.startsWith(':')) continue
          const fields = Object.fromEntries(block.split('\n').map(line => {
            const separator = line.indexOf(':')
            return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1).trimStart()]
          }))
          if (fields.data) yield {
            event_id: Number(fields.id || 0),
            type: fields.event || 'message',
            ...JSON.parse(fields.data),
          }
        }
        if (done) break
      }
    } finally {
      reader.releaseLock()
    }
  }
}
