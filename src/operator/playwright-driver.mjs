import { createHash } from 'node:crypto'

const CANDIDATE_SELECTOR = 'a,button,input,textarea,select,[role="button"],[role="link"],[role="textbox"]'

function stateHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * Adapter for a Chromium instance whose CDP endpoint is reachable from the
 * worker process. For E2B this process belongs inside the microVM; no
 * per-click E2B API hop is part of the execution path.
 */
export class PlaywrightDriver {
  static async connect(endpoint, { allowedDomains = [] } = {}) {
    const { chromium } = await import('playwright-core')
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 })
    const context = browser.contexts()[0]
    const page = context?.pages()[0] ?? await context?.newPage()
    if (!page) throw new Error('CDP browser has no usable page')
    page.setDefaultTimeout(10_000)
    page.setDefaultNavigationTimeout(20_000)
    return new PlaywrightDriver({ browser, page, allowedDomains })
  }

  constructor({ browser, page, allowedDomains = [] }) {
    this.browser = browser
    this.page = page
    this.locators = new Map()
    this.allowedDomains = allowedDomains.map(domain => String(domain).toLowerCase()).filter(Boolean)
  }

  #assertAllowed(url) {
    if (!this.allowedDomains.length) return
    const parsed = new URL(url)
    if (!this.allowedDomains.some(domain => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))) {
      throw new Error('browser_navigation_domain_not_allowed')
    }
  }

  async navigate(url) { this.#assertAllowed(url); await this.page.goto(url, { waitUntil: 'domcontentloaded' }); this.#assertAllowed(this.page.url()) }

  async observe() {
    const raw = await this.page.locator(CANDIDATE_SELECTOR).evaluateAll(elements => elements
      .filter(element => {
        const style = getComputedStyle(element)
        return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0
      })
      .slice(0, 100)
      .map((element, index) => ({
        id: `dom-${index}`,
        role: element.getAttribute('role') ?? element.tagName.toLowerCase(),
        name: element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent?.trim() ?? '',
        text: element.textContent?.trim() ?? '',
        href: element.getAttribute('href') ?? undefined,
        editable: element.matches('input,textarea,[contenteditable="true"]'),
        disabled: 'disabled' in element && Boolean(element.disabled),
      })))
    const candidates = raw.filter(candidate => !candidate.disabled)
    this.locators = new Map(candidates.map(candidate => [candidate.id, this.page.locator(CANDIDATE_SELECTOR).nth(Number(candidate.id.slice(4)))]))
    const snapshot = { url: this.page.url(), title: await this.page.title(), candidates }
    return { ...snapshot, stateHash: stateHash(snapshot) }
  }

  async click(candidate) {
    const locator = this.locators.get(candidate.id)
    if (!locator) throw new Error(`unknown DOM candidate: ${candidate.id}`)
    if (candidate.href) this.#assertAllowed(new URL(candidate.href, this.page.url()).toString())
    await locator.click()
  }

  async waitForStable() { await this.page.waitForLoadState('domcontentloaded').catch(() => {}); this.#assertAllowed(this.page.url()) }
  async close() { await this.browser.close() }
}
