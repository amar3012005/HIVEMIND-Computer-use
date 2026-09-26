import { createHash } from 'node:crypto'

const CANDIDATE_SELECTOR = 'a,button,input,textarea,select,[role="button"],[role="link"],[role="textbox"]'

function stateHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function closedError() {
  return new Error('CDP connection is closed')
}

/**
 * Minimal Chromium DevTools Protocol driver used where a browser exposes CDP
 * targets but does not support Playwright's browser-context enumeration (the
 * local Selenium desktop canary is one such environment). It attaches to one
 * existing page and never closes Chromium, so a human can keep using the VNC
 * desktop after an agent run ends.
 */
export class CdpDriver {
  static async connect(endpoint, { allowedDomains = [] } = {}) {
    const base = new URL(endpoint)
    const version = await fetch(new URL('/json/version', base)).then(response => {
      if (!response.ok) throw new Error(`CDP version endpoint failed with HTTP ${response.status}`)
      return response.json()
    })
    const targets = await fetch(new URL('/json/list', base)).then(response => {
      if (!response.ok) throw new Error(`CDP target endpoint failed with HTTP ${response.status}`)
      return response.json()
    })
    let target = targets.find(item => item.type === 'page' && item.url !== 'chrome://newtab/') ?? targets.find(item => item.type === 'page')
    if (!target) throw new Error('CDP browser has no page target')
    if (!version?.webSocketDebuggerUrl) throw new Error('CDP browser WebSocket endpoint is missing')

    const connection = await CdpConnection.open(version.webSocketDebuggerUrl)
    const attached = await connection.send('Target.attachToTarget', { targetId: target.id, flatten: true })
    if (!attached?.sessionId) {
      connection.close()
      throw new Error('CDP page attach failed')
    }
    return new CdpDriver({ connection, sessionId: attached.sessionId, allowedDomains })
  }

  constructor({ connection, sessionId, allowedDomains = [] }) {
    this.connection = connection
    this.sessionId = sessionId
    this.allowedDomains = allowedDomains.map(domain => String(domain).toLowerCase()).filter(Boolean)
    this.candidates = new Map()
  }

  #assertAllowed(url) {
    if (!this.allowedDomains.length) return
    const parsed = new URL(url)
    if (!this.allowedDomains.some(domain => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))) {
      throw new Error('browser_navigation_domain_not_allowed')
    }
  }

  async #send(method, params = {}) {
    return this.connection.send(method, params, this.sessionId)
  }

  async #evaluate(expression) {
    const response = await this.#send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (response.exceptionDetails) throw new Error(`CDP page evaluation failed: ${response.exceptionDetails.text ?? 'unknown error'}`)
    return response.result?.value
  }

  async navigate(url) {
    this.#assertAllowed(url)
    await this.#send('Page.navigate', { url })
    await this.waitForStable()
    this.#assertAllowed(await this.#evaluate('location.href'))
  }

  async observe() {
    const raw = await this.#evaluate(`(() => {
      const selector = ${JSON.stringify(CANDIDATE_SELECTOR)}
      return Array.from(document.querySelectorAll(selector))
        .filter(element => {
          const style = getComputedStyle(element)
          return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0 && !element.disabled
        })
        .slice(0, 100)
        .map((element, index) => ({
          id: \`dom-\${index}\`,
          role: element.getAttribute('role') ?? element.tagName.toLowerCase(),
          name: element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent?.trim() ?? '',
          text: element.textContent?.trim() ?? '',
          href: element.getAttribute('href') ?? undefined,
          editable: element.matches('input,textarea,[contenteditable="true"]'),
          disabled: Boolean(element.disabled),
        }))
    })()`)
    const candidates = Array.isArray(raw) ? raw : []
    this.candidates = new Map(candidates.map(candidate => [candidate.id, candidate]))
    const snapshot = {
      url: await this.#evaluate('location.href'),
      title: await this.#evaluate('document.title'),
      candidates,
    }
    return { ...snapshot, stateHash: stateHash(snapshot) }
  }

  async click(candidate) {
    const observed = this.candidates.get(candidate?.id)
    if (!observed) throw new Error(`unknown DOM candidate: ${candidate?.id ?? 'none'}`)
    if (observed.href) this.#assertAllowed(new URL(observed.href, await this.#evaluate('location.href')).toString())
    const index = Number(String(observed.id).replace(/^dom-/, ''))
    if (!Number.isInteger(index) || index < 0) throw new Error('invalid DOM candidate id')
    const clicked = await this.#evaluate(`(() => {
      const selector = ${JSON.stringify(CANDIDATE_SELECTOR)}
      const candidates = Array.from(document.querySelectorAll(selector)).filter(element => {
        const style = getComputedStyle(element)
        return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0 && !element.disabled
      })
      const element = candidates[${index}]
      if (!element) return false
      const role = element.getAttribute('role') ?? element.tagName.toLowerCase()
      const name = element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent?.trim() ?? ''
      if (role !== ${JSON.stringify(observed.role)} || name !== ${JSON.stringify(observed.name)}) return false
      element.click()
      return true
    })()`)
    if (clicked !== true) throw new Error('stale_or_changed_DOM_candidate')
  }

  async waitForStable({ timeoutMs = 10_000 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.#evaluate("document.readyState === 'interactive' || document.readyState === 'complete'")) {
        this.#assertAllowed(await this.#evaluate('location.href'))
        return
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('CDP page did not reach a stable DOM state')
  }

  async textContent(selector) {
    if (typeof selector !== 'string' || !selector || selector.length > 500) throw new Error('invalid text selector')
    return String(await this.#evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`)).trim()
  }

  async close() {
    await this.connection.send('Target.detachFromTarget', { sessionId: this.sessionId }).catch(() => {})
    this.connection.close()
  }
}

class CdpConnection {
  static async open(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    return new CdpConnection(socket)
  }

  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (!message.id || !this.pending.has(message.id)) return
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`))
      else pending.resolve(message.result)
    })
    socket.addEventListener('close', () => this.#rejectAll(closedError()))
    socket.addEventListener('error', () => this.#rejectAll(closedError()))
  }

  send(method, params = {}, sessionId) {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(closedError())
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  close() {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close()
    this.#rejectAll(closedError())
  }

  #rejectAll(error) {
    for (const { reject } of this.pending.values()) reject(error)
    this.pending.clear()
  }
}
