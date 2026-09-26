import assert from 'node:assert/strict'
import test from 'node:test'
import { cloudflareJevDecisionConfig, createJevDecisionEngine, directDevelopmentJevDecisionConfig } from '../src/operator/jev-decision.mjs'

const candidates = [
  { id: 'following', role: 'link', name: '243 Following', text: '243 Following' },
  { id: 'followers', role: 'link', name: '18,402 Followers', text: '18,402 Followers' },
]

test('Jev decision adapter uses the configured Cloudflare custom-provider decision endpoint', async () => {
  const calls = []
  const engine = createJevDecisionEngine({
    decisionsUrl: 'https://gateway.example/v1/account/gateway/openrouter/api/alpha/decisions',
    gatewayToken: 'gateway-secret',
    byokAlias: 'openrouter-production',
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({
        answers: { target: { choice: 'followers', probabilities: { following: 0.02, followers: 0.98 } } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  const decision = await engine.choose({ plan: { decisionInstruction: 'Open followers.' }, candidates })
  assert.deepEqual(decision, { candidateId: 'followers', confidence: 0.98, source: 'cloudflare-custom-openrouter-jev' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://gateway.example/v1/account/gateway/openrouter/api/alpha/decisions')
  assert.equal(calls[0].init.headers['cf-aig-authorization'], 'Bearer gateway-secret')
  assert.equal(calls[0].init.headers['cf-aig-byok-alias'], 'openrouter-production')
  assert.equal(calls[0].init.headers.Authorization, undefined)
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, '~typesafe/jev-latest')
  assert.equal(typeof body.state, 'object')
  assert.deepEqual(Object.keys(body.questions.target.criteria), ['following', 'followers'])
})

test('Jev production configuration is Gateway-only and uses a dedicated BYOK alias', () => {
  const config = cloudflareJevDecisionConfig({
    CLOUDFLARE_AI_GATEWAY_ENABLED: 'true',
    CLOUDFLARE_ACCOUNT_ID: 'account',
    CLOUDFLARE_AI_GATEWAY_ID: 'gateway',
    CLOUDFLARE_AI_GATEWAY_TOKEN: 'gateway-token',
    CLOUDFLARE_AI_GATEWAY_JEV_BYOK_ALIAS: 'jev-openrouter',
    CLOUDFLARE_AI_GATEWAY_JEV_PROVIDER: 'decision-jev',
  })
  assert.deepEqual(config, {
    decisionsUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway/custom-decision-jev/api/alpha/decisions',
    gatewayToken: 'gateway-token', byokAlias: 'jev-openrouter', model: '~typesafe/jev-latest',
  })
  const defaultAlias = cloudflareJevDecisionConfig({
    CLOUDFLARE_AI_GATEWAY_ENABLED: 'true', CLOUDFLARE_ACCOUNT_ID: 'account',
    CLOUDFLARE_AI_GATEWAY_ID: 'gateway', CLOUDFLARE_AI_GATEWAY_TOKEN: 'gateway-token',
  })
  assert.equal(defaultAlias.byokAlias, 'default')
  assert.equal(cloudflareJevDecisionConfig({ CLOUDFLARE_AI_GATEWAY_ENABLED: 'true' }), null)
})

test('direct Jev is a local-only explicit diagnostic mode', () => {
  const config = directDevelopmentJevDecisionConfig({ HM_JEV_DEV_DIRECT: '1', HM_JEV_API_KEY: 'test-key' })
  assert.equal(config.mode, 'direct-development')
  assert.equal(config.decisionsUrl, 'https://openrouter.ai/api/alpha/decisions')
  assert.throws(
    () => directDevelopmentJevDecisionConfig({ HM_JEV_DEV_DIRECT: '1', HM_JEV_API_KEY: 'test-key', NODE_ENV: 'production' }),
    /forbidden_in_production/,
  )
  assert.throws(
    () => directDevelopmentJevDecisionConfig({ HM_JEV_DEV_DIRECT: '1', HM_JEV_API_KEY: 'test-key', HM_JEV_DECISIONS_URL: 'https://other.example/decisions' }),
    /not_allowed/,
  )
})

test('Jev adapter does not disclose provider errors or credentials', async () => {
  const engine = createJevDecisionEngine({
    decisionsUrl: 'https://gateway.example/decisions',
    gatewayToken: 'never-disclose-this',
    byokAlias: 'openrouter-production',
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'upstream failure' } }), { status: 401 }),
  })
  await assert.rejects(() => engine.choose({ plan: {}, candidates }), error => {
    assert.match(error.message, /HTTP 401/)
    assert.doesNotMatch(error.message, /never-disclose-this|upstream failure/)
    return true
  })
})

test('Jev adapter can be explicitly configured for a one-off direct OpenRouter canary', async () => {
  let request
  const engine = createJevDecisionEngine({
    decisionsUrl: 'https://openrouter.example/api/alpha/decisions',
    apiKey: 'direct-secret',
    httpReferer: 'https://next.singulancelabs.com',
    title: 'HIVE-MIND JEV canary',
    fetchImpl: async (_url, init) => {
      request = init
      return new Response(JSON.stringify({
        answers: { target: { choice: 'followers', probabilities: { followers: 0.9 } } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  const decision = await engine.choose({ plan: {}, candidates })
  assert.equal(decision.source, 'openrouter-jev')
  assert.equal(request.headers.Authorization, 'Bearer direct-secret')
  assert.equal(request.headers['HTTP-Referer'], 'https://next.singulancelabs.com')
  assert.equal(request.headers['cf-aig-authorization'], undefined)
})
