import { createHmac } from 'node:crypto'

function safeBaseUrl(value, { allowHttpDev = false } = {}) {
  const url = new URL(String(value || ''))
  if (url.username || url.password) throw new Error('computer_control_url_must_not_embed_credentials')
  if (url.protocol !== 'https:' && !(allowHttpDev && url.protocol === 'http:')) {
    throw new Error('computer_control_requires_https')
  }
  return url.toString().replace(/\/+$/, '')
}

function canonical(timestamp, method, path, body) {
  return `${timestamp}\n${method}\n${path}\n${body}`
}

/**
 * Small authenticated client for the durable Python control plane. It carries
 * neither E2B credentials nor desktop stream URLs, and it fails closed on
 * non-JSON/non-2xx responses.
 */
export class RemoteComputerControlClient {
  constructor({ baseUrl, hmacSecret, allowHttpDev = false, fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
    this.baseUrl = safeBaseUrl(baseUrl, { allowHttpDev })
    if (!hmacSecret) throw new Error('computer_control_hmac_secret_required')
    if (typeof fetchImpl !== 'function') throw new Error('computer_control_fetch_required')
    this.hmacSecret = hmacSecret
    this.fetch = fetchImpl
    this.clock = clock
  }

  async submit(payload) { return this.#request('POST', '/internal/computer-runs', payload) }
  async claim(payload) { return (await this.#request('POST', '/internal/computer-runs/claim', payload)).run }
  async get(computerRunId, { organizationId, userId }) {
    const query = new URLSearchParams({ organization_id: organizationId, user_id: userId })
    return this.#request('GET', `/internal/computer-runs/${encodeURIComponent(computerRunId)}?${query}`, null)
  }
  async transition(computerRunId, payload) {
    return this.#request('POST', `/internal/computer-runs/${encodeURIComponent(computerRunId)}/transition`, payload)
  }
  async heartbeat(computerRunId, { organizationId, userId }) {
    const query = new URLSearchParams({ organization_id: organizationId, user_id: userId })
    return this.#request('POST', `/internal/computer-runs/${encodeURIComponent(computerRunId)}/heartbeat?${query}`, null)
  }

  async #request(method, requestPath, payload) {
    const path = requestPath.split('?')[0]
    const body = payload == null ? '' : JSON.stringify(payload)
    const timestamp = String(Math.floor(this.clock() / 1000))
    const signature = createHmac('sha256', this.hmacSecret).update(canonical(timestamp, method, path, body)).digest('hex')
    const response = await this.fetch(`${this.baseUrl}${requestPath}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-hm-computer-timestamp': timestamp,
        'x-hm-computer-signature': signature,
      },
      ...(body ? { body } : {}),
    })
    let result
    try { result = await response.json() } catch { result = null }
    if (!response.ok || !result || typeof result !== 'object') {
      throw new Error(`computer_control_request_failed_http_${response.status}`)
    }
    return result
  }
}

export { canonical }
