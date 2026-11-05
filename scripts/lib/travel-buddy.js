/**
 * Travel Buddy "Visa Requirement" API (visa-requirement.p.rapidapi.com) helpers.
 *
 * Shared by pro-tier-refresh.js and smart-update.js.
 *
 * WHY THIS EXISTS (repair of 2026-11-05):
 * The old scripts read `body.requirement || body.visa_requirement` from the
 * response. The v2 endpoint (/v2/visa/check) does not return those fields: the
 * rule lives at `body.data.visa_rules.primary_rule.name`. Every successful call
 * therefore normalised to "unknown", and pro-tier-refresh.js wrote that
 * "unknown" over good data (about 120 pairs per monthly run, Mar-Nov 2026).
 *
 * Contract of parseVisaCheckResponse():
 *   - returns { ok: true, requirement, duration, notes } ONLY when the response
 *     has the documented v2 shape and maps to a known requirement type;
 *   - otherwise returns { ok: false, reason } and the caller must SKIP the pair
 *     (never write "unknown", never overwrite existing data).
 */

const VALID_REQUIREMENTS = ['visa-free', 'visa-on-arrival', 'e-visa', 'eta', 'visa-required'];

/**
 * Map a Travel Buddy rule name ("Visa-free", "Visa on arrival", "eVisa", "eTA",
 * "Visa required", ...) to our requirement types. Returns null when unsure.
 */
function normalizeRuleName(name) {
  if (typeof name !== 'string') return null;
  const n = name.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!n) return null;

  // Order matters: "visa required" contains "visa", "evisa" contains "visa", etc.
  if (/\bvisa[- ]?free\b/.test(n) || n === 'free' || n.includes('visa not required') || n.includes('freedom of movement')) {
    return 'visa-free';
  }
  if (n.includes('on arrival') || /\bvoa\b/.test(n)) return 'visa-on-arrival';
  if (/\be-?visa\b/.test(n) || n.includes('electronic visa')) return 'e-visa';
  if (/\be-?ta\b/.test(n) || n.includes('electronic travel') || n.includes('visa waiver') || /\besta\b/.test(n)) {
    return 'eta';
  }
  if (n.includes('visa required') || n === 'required' || n.includes('embassy visa')) return 'visa-required';
  return null;
}

/** "90 days" -> 90, "30" -> 30, 90 -> 90; anything else -> null */
function parseDurationDays(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== 'string') return null;
  const m = value.match(/(\d+)\s*(day|days|d)?\b/i);
  if (!m) return null;
  const days = parseInt(m[1], 10);
  if (!Number.isInteger(days) || days <= 0) return null;
  if (/month/i.test(value)) return days * 30; // "6 months" -> 180
  return days;
}

/**
 * Parse a /v2/visa/check JSON body. Never throws.
 */
function parseVisaCheckResponse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'body is not a JSON object' };
  }
  if (body.error === true || body.error === 'true') {
    return { ok: false, reason: `API error flag: ${String(body.message || body.error_message || 'no message').slice(0, 120)}` };
  }
  if (typeof body.message === 'string' && /quota|exceeded|not subscribed|invalid api key|unauthori[sz]ed/i.test(body.message)) {
    return { ok: false, reason: `API message: ${body.message.slice(0, 120)}`, fatal: true };
  }
  if (body.meta && body.meta.is_demo === true) {
    return { ok: false, reason: 'demo data (meta.is_demo=true) - not real, refusing to store' };
  }
  if (body.is_demo === true || (body.data && body.data.is_demo === true)) {
    return { ok: false, reason: 'demo data (is_demo=true) - not real, refusing to store' };
  }

  const rules = body.data && body.data.visa_rules;
  const primary = rules && rules.primary_rule;
  if (!primary || typeof primary !== 'object') {
    return { ok: false, reason: `unexpected shape: no data.visa_rules.primary_rule (top-level keys: ${Object.keys(body).slice(0, 8).join(',')})` };
  }

  const requirement = normalizeRuleName(primary.name);
  if (!requirement || !VALID_REQUIREMENTS.includes(requirement)) {
    return { ok: false, reason: `unrecognised primary_rule.name: ${JSON.stringify(primary.name)}` };
  }

  const secondary = rules.secondary_rule && typeof rules.secondary_rule === 'object' ? rules.secondary_rule : null;
  let duration = parseDurationDays(primary.duration);
  if (duration === null && secondary) duration = parseDurationDays(secondary.duration);

  const noteParts = [];
  if (secondary && typeof secondary.name === 'string' && secondary.name.trim()) {
    noteParts.push(`Also: ${secondary.name.trim()}`);
  }
  const reg = body.data.mandatory_registration;
  if (reg && typeof reg.name === 'string' && reg.name.trim()) {
    noteParts.push(`Registration: ${reg.name.trim()}`);
  }

  return {
    ok: true,
    requirement,
    duration,
    notes: noteParts.length ? noteParts.join('. ') : null,
  };
}

module.exports = { VALID_REQUIREMENTS, normalizeRuleName, parseDurationDays, parseVisaCheckResponse };
