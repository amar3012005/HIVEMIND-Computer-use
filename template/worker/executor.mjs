import { readFile } from 'node:fs/promises'
import { ComputerOperator } from './operator/operator.mjs'
import { createJevDecisionEngine } from './operator/jev-decision.mjs'
import { PlaywrightDriver } from './operator/playwright-driver.mjs'
import { verifySemanticEvidence } from './operator/semantic-verifier.mjs'

const inputPath = process.env.HM_COMPUTER_RUN_INPUT_PATH
if (!inputPath) throw new Error('computer_run_input_path_required')
console.log(JSON.stringify({ phase: 'worker_start' }))
const input = JSON.parse(await readFile(inputPath, 'utf8'))
const endpoint = process.env.HM_CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const plan = input.browser_plan
if (!plan || typeof plan !== 'object') throw new Error('computer_run_missing_browser_plan')

const completion = plan.completion
if (!completion || completion.kind !== 'visible_text' || typeof completion.selector !== 'string' || completion.selector.length > 200) {
  throw new Error('computer_run_completion_contract_invalid')
}

const configuredDecisionEngine = process.env.HM_JEV_ENABLED !== '1' ? null
  : process.env.HM_JEV_DEV_DIRECT === '1'
    ? createJevDecisionEngine({
        decisionsUrl: process.env.HM_JEV_DECISIONS_URL,
        apiKey: process.env.HM_JEV_API_KEY,
        httpReferer: process.env.HM_JEV_HTTP_REFERER,
        title: process.env.HM_JEV_TITLE,
        model: process.env.HM_JEV_MODEL,
      })
    : createJevDecisionEngine({
        decisionsUrl: process.env.HM_JEV_DECISIONS_URL,
        gatewayToken: process.env.HM_JEV_GATEWAY_TOKEN,
        byokAlias: process.env.HM_JEV_BYOK_ALIAS,
        model: process.env.HM_JEV_MODEL,
      })
let decisionCalls = 0
const decisionEngine = configuredDecisionEngine ? { choose: async input => {
  decisionCalls += 1
  return configuredDecisionEngine.choose(input)
} } : null

console.log(JSON.stringify({ phase: 'browser_connect_start' }))
const driver = await PlaywrightDriver.connect(endpoint, { allowedDomains: input.allowed_domains })
console.log(JSON.stringify({ phase: 'browser_connected' }))
const trace = []
const operator = new ComputerOperator({
  planner: { compile: async () => plan },
  driver,
  decisionEngine,
  receiptStore: { record: async event => {
    trace.push({
      type: event.type,
      step: event.step ?? null,
      action: event.action ?? null,
      candidate_id: event.candidate_id ?? null,
      source: event.source ?? null,
      confidence: Number.isFinite(event.confidence) ? event.confidence : null,
      url: event.url ?? null,
      candidate_count: Number.isInteger(event.candidate_count) ? event.candidate_count : null,
      status: event.status ?? null,
      reason: event.reason ?? null,
    })
  } },
  verifier: {
    check: async (compiled, observation) => {
      const locator = driver.page.locator(compiled.completion.selector).first()
      if (!await locator.isVisible().catch(() => false)) return { complete: false, reason: 'completion_text_not_visible' }
      const verified = await verifySemanticEvidence({ plan: compiled, observation, readText: async selector => driver.page.locator(selector).first().textContent() })
      if (verified.complete && compiled.completion.independent_http_url) {
        let independentUrl
        try { independentUrl = new URL(compiled.completion.independent_http_url) }
        catch { return { complete: false, reason: 'independent_http_url_invalid' } }
        const allowed = input.allowed_domains.some(domain => independentUrl.hostname === domain || independentUrl.hostname.endsWith(`.${domain}`))
        if (independentUrl.protocol !== 'https:' || !allowed) return { complete: false, reason: 'independent_http_domain_not_allowed' }
        const response = await fetch(independentUrl, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
        const body = await response.text()
        const expected = String(compiled.completion.expected_text ?? '').trim()
        if (!response.ok || !expected || !body.includes(expected)) return { complete: false, reason: 'independent_http_fact_mismatch' }
        verified.result.independent_http = true
        verified.evidence.push({ kind: 'independent_http_match', source_url: independentUrl.toString(), status: response.status, expected_text: expected })
      }
      if (verified.complete) verified.result.decision_calls = decisionCalls
      return verified
    },
  },
})

const result = await operator.run({
  id: input.computer_run_id,
  objective: input.objective,
  permissions: ['navigate', 'read'],
  limits: input.limits,
})
console.log(JSON.stringify({ phase: 'operator_finished', status: result.status }))
result.trace = trace
await new Promise(resolve => process.stdout.write(`${JSON.stringify(result)}\n`, resolve))
// Do not close Chromium after a run. The sandbox desktop may be handed to a
// human operator, and process exit releases the CDP connection without ending
// that visible browser session.
process.exit(0)
