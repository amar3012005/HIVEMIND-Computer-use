import { ComputerOperator } from './operator/operator.mjs'
import { directDevelopmentJevDecisionConfig, createJevDecisionEngine } from './operator/jev-decision.mjs'
import { CdpDriver } from './operator/cdp-driver.mjs'

const config = directDevelopmentJevDecisionConfig()
if (!config) throw new Error('local_direct_jev_configuration_required')
const endpoint = process.env.HM_LOCAL_CDP_ENDPOINT || 'http://127.0.0.1:9221'
const fixture = `data:text/html,${encodeURIComponent(`<!doctype html><title>Local Jev profile</title>
<main><h1>Local browser fixture</h1><button id="following">243 Following</button><button id="followers">18,402 Followers</button></main>
<script>document.querySelector('#followers').addEventListener('click',()=>{document.title='Local Jev followers';document.querySelector('main').innerHTML='<h1>Followers</h1><p id="follower-count">18,402</p>'})</script>`)}`

let decisionCalls = 0
const configured = createJevDecisionEngine(config)
const decisionEngine = { choose: async input => {
  decisionCalls += 1
  return configured.choose(input)
} }
const driver = await CdpDriver.connect(endpoint)
try {
  const operator = new ComputerOperator({
    planner: { compile: async () => ({
      startUrl: fixture,
      decisionInstruction: 'Open the observed Followers control, not Following, to read the current follower count. Choose only an observed enabled control.',
      completion: { kind: 'local-visible-follower-count' },
    }) },
    driver,
    decisionEngine,
    verifier: { check: async (_plan, observation) => {
      if (observation.title !== 'Local Jev followers') return { complete: false }
      const value = await driver.textContent('#follower-count')
      if (value !== '18,402') return { complete: false }
      return {
        complete: true,
        result: { visible_follower_count: value, decision_calls: decisionCalls, source_url: observation.url },
        evidence: [{ kind: 'browser_visible_text', selector: '#follower-count', value }],
      }
    } },
  })
  const result = await operator.run({
    objective: 'Use the local browser fixture to read its follower count.',
    permissions: ['read', 'navigate'],
    limits: { maxSteps: 3, timeoutMs: 30_000, minimumConfidence: 0.6 },
  })
  if (result.status !== 'completed' || result.result?.decision_calls !== 1) {
    throw new Error(`local_direct_jev_browser_canary_failed_${result.status}`)
  }
  console.log(JSON.stringify({
    status: result.status,
    decision_calls: result.result.decision_calls,
    visible_follower_count: result.result.visible_follower_count,
    evidence_count: result.evidence.length,
  }))
} finally {
  // This detaches only the agent connection. Chromium and the visible VNC
  // desktop remain open for an operator to inspect or take over.
  await driver.close().catch(() => {})
}
