function normalize(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function requiredTerms(plan) {
  const target = plan?.target ?? plan?.semantic_target ?? {}
  const terms = [target.name, ...(Array.isArray(target.aliases) ? target.aliases : []), ...(Array.isArray(target.required_terms) ? target.required_terms : [])]
    .filter(value => typeof value === 'string' && value.trim())
    .map(normalize)
  return [...new Set(terms)]
}

/**
 * Generic evidence verifier. A loaded page is never completion evidence by
 * itself: the declared completion selector must be visible and the declared
 * entity/evidence terms must be present in the observed value.
 */
export async function verifySemanticEvidence({ plan, observation, readText }) {
  const completion = plan?.completion
  if (!completion || completion.kind !== 'visible_text' || typeof completion.selector !== 'string') {
    return { complete: false, reason: 'completion_contract_invalid' }
  }
  const value = String(await readText(completion.selector) ?? '').trim()
  if (!value) return { complete: false, reason: 'completion_text_missing' }
  if (completion.expected_text && !normalize(value).includes(normalize(completion.expected_text))) {
    return { complete: false, reason: 'completion_text_mismatch', observed: value }
  }
  const observed = normalize(value)
  const missing = requiredTerms(plan).filter(term => !observed.includes(term))
  if (missing.length) return { complete: false, reason: 'entity_not_disambiguated', missing, observed: value }
  const sourceUrl = String(observation?.url ?? '')
  return {
    complete: true,
    result: {
      value,
      source_url: sourceUrl,
      completion_kind: 'visible_text',
      semantic_match: true,
    },
    evidence: [
      { kind: 'browser_visible_text', selector: completion.selector, value, source_url: sourceUrl },
      ...(requiredTerms(plan).length ? [{ kind: 'semantic_entity_match', terms: requiredTerms(plan), source_url: sourceUrl }] : []),
    ],
  }
}

export const semanticVerifier = Object.freeze({ check: verifySemanticEvidence })
