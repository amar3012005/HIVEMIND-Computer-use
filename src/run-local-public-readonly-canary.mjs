import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComputerOperator } from './operator/operator.mjs'
import { CdpDriver } from './operator/cdp-driver.mjs'

const endpoint = process.env.HM_LOCAL_CDP_ENDPOINT || 'http://127.0.0.1:9221'
const sourceUrl = 'https://www.iana.org/domains/reserved'
const expectedHeading = 'IANA-managed Reserved Domains'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.join(root, 'evidence', new Date().toISOString().replaceAll(':', '-'))
const receipts = []

await mkdir(outputDir, { recursive: true })
const driver = await CdpDriver.connect(endpoint, { allowedDomains: ['iana.org'] })
try {
  const operator = new ComputerOperator({
    planner: { compile: async () => ({
      startUrl: sourceUrl,
      completion: { kind: 'visible_public_heading', expected_text: expectedHeading },
    }) },
    driver,
    receiptStore: { record: async event => receipts.push(event) },
    verifier: { check: async (_plan, observation) => {
      const heading = await driver.textContent('h1')
      if (heading !== expectedHeading) return { complete: false }
      const response = await fetch(observation.url, { signal: AbortSignal.timeout(10_000) })
      const body = await response.text()
      const independentlyVerified = response.ok && body.includes(expectedHeading)
      if (!independentlyVerified) return { complete: false }
      return {
        complete: true,
        result: {
          visible_heading: heading,
          source_url: observation.url,
          independent_http: true,
          decision_calls: 0,
        },
        evidence: [{ kind: 'browser_visible_text', selector: 'h1', value: heading, source_url: observation.url }],
      }
    } },
  })

  const result = await operator.run({
    objective: 'Read the title of IANA’s Reserved Domains page and independently verify the visible fact.',
    permissions: ['navigate', 'read'],
    limits: { maxSteps: 1, timeoutMs: 30_000, minimumConfidence: 0.6 },
  })
  if (result.status !== 'completed' || result.result?.independent_http !== true || result.result?.decision_calls !== 0) {
    throw new Error(`local_public_readonly_canary_failed_${result.status}`)
  }
  const tracePath = path.join(outputDir, 'receipt.json')
  await writeFile(tracePath, `${JSON.stringify({
    contract: 'hivemind.local-public-readonly-browser-canary.v1',
    status: result.status,
    result,
    trace: receipts,
  }, null, 2)}\n`)
  console.log(JSON.stringify({
    status: result.status,
    visible_heading: result.result.visible_heading,
    independent_http: true,
    decision_calls: 0,
    receipt_path: tracePath,
  }))
} finally {
  // Detach only; leave Chromium and its VNC desktop ready for human takeover.
  await driver.close().catch(() => {})
}
