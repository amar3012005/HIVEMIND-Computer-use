const AUTOMATIC_CAPABILITIES = new Set(['navigate', 'read'])
const HUMAN_REQUIRED_CAPABILITIES = new Set([
  'authenticate',
  'credential_entry',
  'mfa',
  'external_write',
  'send',
  'publish',
  'delete',
  'payment',
])

function normalizedCapabilities(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new TypeError('computer authority capabilities must be a string array')
  }
  return [...new Set(value.map(item => item.trim().toLowerCase()))]
}

/**
 * Capability-only authority boundary. A planner must declare effects as data;
 * this deliberately never infers authority from natural-language task text or
 * site-specific labels. Read/navigation are the only autonomous capabilities.
 */
export function assessComputerAuthority({ job, plan } = {}) {
  const jobCapabilities = normalizedCapabilities(job?.permissions)
  const planCapabilities = normalizedCapabilities(plan?.authority?.capabilities)
  const capabilities = [...new Set([...jobCapabilities, ...planCapabilities])]
  const humanRequired = capabilities.filter(capability => HUMAN_REQUIRED_CAPABILITIES.has(capability))
  const unknown = capabilities.filter(capability => !AUTOMATIC_CAPABILITIES.has(capability) && !HUMAN_REQUIRED_CAPABILITIES.has(capability))

  if (humanRequired.length || unknown.length || plan?.authority?.requires_human === true) {
    return {
      automatic: false,
      reason: humanRequired.length ? 'human_authority_required' : 'unrecognized_or_explicit_human_authority',
      capabilities: [...humanRequired, ...unknown],
    }
  }
  return { automatic: true, capabilities }
}

export const computerAuthorityPolicy = Object.freeze({ assess: assessComputerAuthority })
