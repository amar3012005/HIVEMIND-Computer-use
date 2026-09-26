import assert from 'node:assert/strict'
import test from 'node:test'
import { verifySemanticEvidence } from '../src/operator/semantic-verifier.mjs'

const plan = {
  completion: { kind: 'visible_text', selector: '#result', expected_text: 'Followers' },
  target: { name: 'Acme Corp', aliases: ['Acme'] },
}

test('semantic verifier rejects a page that has text but the wrong entity', async () => {
  const result = await verifySemanticEvidence({ plan, observation: { url: 'https://example.com' }, readText: async () => 'Followers for Other Corp: 12' })
  assert.equal(result.complete, false)
  assert.equal(result.reason, 'entity_not_disambiguated')
})

test('semantic verifier returns source-backed evidence for the intended entity', async () => {
  const result = await verifySemanticEvidence({ plan, observation: { url: 'https://example.com/profile' }, readText: async () => 'Acme Corp Followers: 12' })
  assert.equal(result.complete, true)
  assert.equal(result.result.semantic_match, true)
  assert.equal(result.evidence.at(-1).kind, 'semantic_entity_match')
})
