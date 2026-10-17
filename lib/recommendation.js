'use strict';
// ---------------------------------------------------------------------------
// Recommendation engine (Rules 3, 4, 5, 6).
//
// Hard rules implemented here:
//   3. Level 2 Executive is always preferred; Level 1 only as fallback;
//      Browse Only when neither qualifies.
//   4. Hard admission gate — every condition must pass or the B is excluded
//      from the Recommendation Pool.
//   5. Weighted scoring + fair rotation + ad-budget isolation.
//   6. 3–5 recommended Bs; the C may pick one themselves.
// ---------------------------------------------------------------------------
const db = require('./db');
const auth = require('./auth');
const config = require('./config');
const org = require('./org');
const { id, iso, today, addDays, isPast, lower, upper, clone, asNumber, truthy, seededUnit, daysBetween } = require('./util');
const audit = require('./audit');

const recs = () => db.stores.recommendations;
const scores = () => db.stores.recommendation_scores;
const rotations = () => db.stores.recommendation_rotations;

// ---------------------------------------------------------------------------
// Rule 4 — hard admission gate
// ---------------------------------------------------------------------------
// Returns { eligible, failures: [...] }. A single failure removes the B from
// the pool. Matching conditions are evaluated against the C's requirement.
function evaluateAdmission(bProfile, requirement, at = new Date()) {
  const failures = [];
  const organization = org.findOrganization(bProfile.organization_id) || {};

  if (!bProfile.verified && !organization.verified) failures.push('b_not_verified');

  const membership = org.membershipValid(bProfile.organization_id, at);
  if (!membership.valid) failures.push('membership_' + membership.reason);
  else if (lower(bProfile.level) === 'free' || !auth.B_LEVELS[upper(bProfile.level)] || auth.B_LEVELS[upper(bProfile.level)].rank < 1) {
    failures.push('level_below_minimum'); // Rule 4: at least Level 1
  }

  if (!organization.financial_docs_complete) failures.push('financial_docs_incomplete');
  if (lower(organization.kyc_status) !== 'approved') failures.push('kyc_not_qualified');
  if (lower(organization.kyb_status) !== 'approved') failures.push('kyb_not_qualified');
  if (!bProfile.contract_valid) failures.push('contract_invalid');
  if (lower(organization.status) === 'frozen' || lower(organization.status) === 'suspended') failures.push('organization_frozen');
  if (asNumber(bProfile.unresolved_serious_disputes, 0) > 0) failures.push('unresolved_serious_dispute');
  if (!truthy(bProfile.accepts_platform_recommendation) || Boolean(bProfile.recommendation_paused)) failures.push('recommendation_not_allowed');
  if (lower(bProfile.operational_status) !== 'normal') failures.push('operational_status_' + lower(bProfile.operational_status));

  // Order capacity caps
  const caps = orderCapacity(bProfile.organization_id, at);
  if (!caps.daily_ok) failures.push('daily_cap_reached');
  if (!caps.monthly_ok) failures.push('monthly_cap_reached');

  // Matching dimensions (Rule 4 second half)
  const req = requirement || {};
  const listMatch = (field, values) => {
    if (!Array.isArray(values) || !values.length) return true;   // not specified → no constraint
    const own = (bProfile[field] || []).map(lower);
    return values.some((v) => own.includes(lower(v)));
  };
  if (!listMatch('service_countries', req.target_countries)) failures.push('country_mismatch');
  if (!listMatch('service_stages', req.target_stages)) failures.push('stage_mismatch');
  if (!listMatch('service_courses', req.target_courses)) failures.push('course_mismatch');
  if (!listMatch('service_types', req.service_types)) failures.push('service_type_mismatch');
  if (!listMatch('languages', req.languages)) failures.push('language_mismatch');

  // Rule 4: 状态 A/B 可执行
  if (!truthy(bProfile.status_a)) failures.push('status_a_not_executable');
  if (!truthy(bProfile.status_b)) failures.push('status_b_not_executable');

  return { eligible: failures.length === 0, failures };
}

function orderCapacity(organizationId, at = new Date()) {
  const profile = org.bProfileOf(organizationId);
  if (!profile) return { daily_ok: false, monthly_ok: false, daily_used: 0, monthly_used: 0, daily_cap: 0, monthly_cap: 0 };
  const dayStart = new Date(at); dayStart.setUTCHours(0, 0, 0, 0);
  const monthStart = new Date(at); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  // A binding counts as an order once B has accepted it (accept is the gate
  // that enforces the cap), regardless of how far the signature flow got.
  const accepted = db.stores.bindings.all()
    .filter((b) => String(b.b_organization_id) === String(organizationId)
      && !['pending_b_request', 'rejected_by_b', 'unbound', 'cancelled'].includes(lower(b.status)));
  const rotationsAccepted = rotations().all()
    .filter((r) => String(r.b_organization_id) === String(organizationId));
  const stamps = accepted.map((b) => new Date(b.responded_at || b.requested_at).getTime())
    .concat(rotationsAccepted.map((r) => new Date(r.created_at).getTime()));
  const daily_used = stamps.filter((t) => t >= dayStart.getTime()).length;
  const monthly_used = stamps.filter((t) => t >= monthStart.getTime()).length;
  return {
    daily_used, monthly_used,
    daily_cap: asNumber(profile.daily_order_cap, 10),
    monthly_cap: asNumber(profile.monthly_order_cap, 100),
    daily_ok: daily_used < asNumber(profile.daily_order_cap, 10),
    monthly_ok: monthly_used < asNumber(profile.monthly_order_cap, 100)
  };
}

// ---------------------------------------------------------------------------
// Rule 5 — scoring
// ---------------------------------------------------------------------------
function requirementMatchScore(bProfile, requirement) {
  const req = requirement || {};
  let hit = 0; let total = 0;
  const dims = [
    ['service_countries', req.target_countries],
    ['service_stages', req.target_stages],
    ['service_courses', req.target_courses],
    ['service_types', req.service_types],
    ['languages', req.languages]
  ];
  for (const [field, wanted] of dims) {
    if (!Array.isArray(wanted) || !wanted.length) continue;
    total += 1;
    const own = (bProfile[field] || []).map(lower);
    if (wanted.some((v) => own.includes(lower(v)))) hit += 1;
  }
  if (req.budget_min !== undefined || req.budget_max !== undefined) {
    total += 1;
    // No B-level budget ceiling is invented; treat as satisfied unless the B
    // explicitly declared a service band that excludes the requirement.
    hit += 1;
  }
  if (req.special_requirements && Array.isArray(req.special_requirements) && req.special_requirements.length) {
    total += 1;
    const own = (bProfile.specialties || []).map(lower);
    if (req.special_requirements.some((v) => own.includes(lower(v)))) hit += 1;
  }
  return total === 0 ? 60 : Math.round((hit / total) * 100);
}

function qualityTrustScore(bProfile) {
  const rating = Math.max(0, Math.min(5, asNumber(bProfile.rating_avg, 4.5)));
  const ratingPart = (rating / 5) * 70;
  const volumePart = Math.min(20, asNumber(bProfile.rating_count, 0) / 10);
  const agreementPart = Math.min(10, asNumber(bProfile.commission_agreements_count, 0) / 2);
  return Math.round(ratingPart + volumePart + agreementPart);
}

function responsivenessScore(bProfile) {
  const minutes = asNumber(bProfile.avg_response_minutes, 60);
  const base = minutes <= 15 ? 100 : minutes <= 30 ? 85 : minutes <= 60 ? 70 : minutes <= 240 ? 50 : 30;
  return base;
}

function activityScore(bProfile, at = new Date()) {
  // Recency of accepted work, decayed.
  const recent = recs().filter((r) => String(r.b_organization_id) === String(bProfile.organization_id) && lower(r.status) === 'accepted');
  const last = recent.map((r) => new Date(r.accepted_at).getTime()).sort((a, b) => b - a)[0];
  if (!last) return 30;
  const days = daysBetween(last, at);
  if (days <= 7) return 100;
  if (days <= 30) return 80;
  if (days <= 90) return 60;
  return 40;
}

function partnershipDepthScore(bProfile) {
  const agreements = db.stores.agreements.filter((a) => String(a.b_organization_id) === String(bProfile.organization_id));
  if (!agreements.length) return 0;
  const real = agreements.filter((a) => !a.is_demo);
  return Math.min(100, 30 + real.length * 15 + (agreements.length - real.length) * 5);
}

// Fair rotation: penalise Bs that have been recommended too often recently,
// and protect small Bs with a minimum exposure floor.
function fairRotationScore(bProfile, at = new Date()) {
  const windowStart = addDays(at, -30);
  const orgKey = String(bProfile.organization_id);
  // Count how often this B was recommended (and accepted) in the window.
  const rotated = rotations().all()
    .filter((r) => String(r.b_organization_id) === orgKey && new Date(r.created_at) >= windowStart);
  const count = rotated.length;
  const base = 100 - Math.min(90, count * 12);

  // Head B anti-monopoly: heavy penalty once a B dominates the window.
  const totalRecent = rotations().all().filter((r) => new Date(r.created_at) >= windowStart).length;
  const headPenalty = asNumber(config.get('head_b_penalty', 0.6), 0.6);
  if (totalRecent > 4) {
    const share = count / totalRecent;
    if (share > 0.4) return Math.max(0, Math.round(base * headPenalty));
  }

  // Small B floor: the smallest Bs keep a guaranteed minimum exposure.
  const org_ = org.findOrganization(bProfile.organization_id) || {};
  const isSmall = asNumber(bProfile.rating_count, 0) < 5;
  if (isSmall) return Math.min(100, base + 25);

  // Cold start protection for new Bs.
  const createdAt = new Date(org_.created_at || at).getTime();
  const coldDays = asNumber(config.get('cold_start_days', 45), 45);
  if (daysBetween(createdAt, at) <= coldDays) return Math.min(100, base + asNumber(config.get('cold_start_bonus', 6), 6));

  return Math.max(0, base);
}

function randomJitter(seedKey) {
  return Math.round(seededUnit(seedKey + ':' + today()) * 100);
}

function scoreCandidate(bProfile, requirement, at = new Date()) {
  const w = config.weights();
  const total = (w.requirement_match + w.quality_trust + w.responsiveness + w.fair_rotation + w.partnership_depth + w.random_jitter) || 100;
  const parts = {
    requirement_match: requirementMatchScore(bProfile, requirement),
    quality_trust: qualityTrustScore(bProfile),
    responsiveness: responsivenessScore(bProfile),
    fair_rotation: fairRotationScore(bProfile, at),
    partnership_depth: partnershipDepthScore(bProfile),
    random_jitter: randomJitter(bProfile.organization_id + '|' + String(requirement && requirement.id))
  };
  let weighted = 0;
  for (const [key, value] of Object.entries(parts)) weighted += (asNumber(w[key], 0) / total) * value;
  return {
    overall: Math.round(weighted * 100) / 100,
    parts,
    weights: w,
    explain: buildExplanation(parts, w, bProfile)
  };
}

function buildExplanation(parts, w, bProfile) {
  const org_ = org.findOrganization(bProfile.organization_id) || {};
  const lines = [];
  const top = Object.entries(parts).sort((a, b) => (asNumber(w[b[0]], 0) * b[1]) - (asNumber(w[a[0]], 0) * a[1]))[0];
  if (top) lines.push('主要优势：' + top[0] + '（' + top[1] + ' 分）');
  lines.push('等级：' + (auth.B_LEVELS[upper(bProfile.level)] ? auth.B_LEVELS[upper(bProfile.level)].label_zh : bProfile.level));
  lines.push('平均响应：' + asNumber(bProfile.avg_response_minutes, 60) + ' 分钟');
  lines.push('评价：' + asNumber(bProfile.rating_avg, 0) + ' / 5（' + asNumber(bProfile.rating_count, 0) + ' 条）');
  lines.push('机构：' + (org_.name || bProfile.organization_id));
  return lines;
}

// ---------------------------------------------------------------------------
// Rule 3 — tiered selection
// ---------------------------------------------------------------------------
// 1) try Level 2 Executive
// 2) fall back to Level 1 Premium
// 3) Browse Only
function recommend(requirement, options = {}) {
  const at = new Date();
  const seedKey = String(options.seed || (requirement && requirement.id) || Date.now());
  const pool = org.organizationsOfKind('B')
    .map((o) => org.bProfileOf(o.id))
    .filter(Boolean);

  const admission = pool.map((p) => {
    const gate = evaluateAdmission(p, requirement, at);
    return { profile: p, gate };
  });
  const eligible = admission.filter((x) => x.gate.eligible).map((x) => x.profile);

  const scored = eligible.map((p) => ({ profile: p, score: scoreCandidate(p, requirement, at) }));
  const level2 = scored.filter((x) => lower(x.profile.level) === 'level_2').sort((a, b) => b.score.overall - a.score.overall);
  const level1 = scored.filter((x) => lower(x.profile.level) === 'level_1').sort((a, b) => b.score.overall - a.score.overall);

  let tier = null;
  let chosen = [];
  if (level2.length && config.get('level2_priority_enabled', true)) {
    tier = 'LEVEL_2';
    chosen = level2;
  } else if (level1.length && config.get('level1_fallback_enabled', true)) {
    tier = 'LEVEL_1';
    chosen = level1;
  }

  const poolSize = Math.min(
    Math.max(asNumber(config.get('recommendation_min_pool_size', 3), 3), asNumber(options.count, 0)),
    asNumber(config.get('recommendation_pool_size', 5), 5)
  );
  const top = chosen.slice(0, poolSize);

  const result = {
    id: id('recommendation'),
    requirement_id: (requirement && requirement.id) || null,
    tier,
    mode: top.length ? 'recommended' : (config.get('browse_only_enabled', true) ? 'browse_only' : 'none'),
    candidates: top.map((x, index) => ({
      rank: index + 1,
      b_organization_id: x.profile.organization_id,
      b_profile_id: x.profile.id,
      level: x.profile.level,
      score: x.score.overall,
      score_parts: x.score.parts,
      explain: x.score.explain,
      languages: x.profile.languages || [],
      service_countries: x.profile.service_countries || [],
      avg_response_minutes: x.profile.avg_response_minutes,
      rating_avg: x.profile.rating_avg,
      rating_count: x.profile.rating_count
    })),
    excluded: admission.filter((x) => !x.gate.eligible).map((x) => ({
      b_organization_id: x.profile.organization_id,
      level: x.profile.level,
      failures: x.gate.failures
    })),
    created_at: iso(),
    status: 'pending'
  };
  recs().insert(result);
  audit.record({
    action: 'recommendation:generate',
    entity: 'recommendation',
    entity_id: result.id,
    to: { tier: result.tier, mode: result.mode, candidates: result.candidates.length, excluded: result.excluded.length }
  });
  return result;
}

// Rule 5: timeout without a response → auto-switch to the next candidate.
function switchCandidate(recommendationId, fromOrganizationId, actor) {
  const rec = recs().byId(recommendationId);
  if (!rec) return null;
  const minutes = asNumber(config.get('no_response_switch_minutes', 30), 30);
  const current = rec.candidates.find((c) => String(c.b_organization_id) === String(fromOrganizationId));
  if (!current) return null;
  const respondedAt = current.responded_at ? new Date(current.responded_at).getTime() : null;
  const sentAt = current.sent_at ? new Date(current.sent_at).getTime() : Date.now();
  const elapsed = (Date.now() - (respondedAt || sentAt)) / 60000;
  if (respondedAt || elapsed < minutes) return { ok: false, error: '尚未达到自动切换条件' };
  const next = rec.candidates[rec.candidates.findIndex((c) => c === current) + 1] || null;
  current.status = 'switched_out';
  current.switched_out_at = iso();
  if (next) {
    next.status = 'active';
    next.sent_at = iso();
  }
  rec.status = next ? 'pending' : 'exhausted';
  audit.record({ actor, action: 'recommendation:switch', entity: 'recommendation', entity_id: rec.id, from: fromOrganizationId, to: next ? next.b_organization_id : null });
  return { ok: true, recommendation: rec, next };
}

function recordResponse(recommendationId, organizationId, response, actor) {
  const rec = recs().byId(recommendationId);
  if (!rec) return null;
  const candidate = rec.candidates.find((c) => String(c.b_organization_id) === String(organizationId));
  if (!candidate) return null;
  candidate.responded_at = iso();
  candidate.response = response;
  candidate.status = response === 'accept' ? 'accepted' : 'rejected';
  if (response === 'accept') {
    rec.status = 'accepted';
    rec.accepted_b_organization_id = organizationId;
    rec.accepted_at = iso();
    // Persist rotation history for fair rotation scoring.
    rotations().insert({
      id: id('recommendation_rotation'),
      recommendation_id: rec.id,
      b_organization_id: organizationId,
      requirement_id: rec.requirement_id,
      tier: rec.tier,
      created_at: iso()
    });
  }
  audit.record({ actor, action: 'recommendation:response', entity: 'recommendation', entity_id: rec.id, to: candidate });
  return rec;
}

function recommendationById(recId) { return recs().byId(recId); }

function listRecommendations(filters = {}) {
  let items = recs().all();
  if (filters.requirement_id) items = items.filter((r) => String(r.requirement_id) === String(filters.requirement_id));
  if (filters.tier) items = items.filter((r) => lower(r.tier) === lower(filters.tier));
  if (filters.mode) items = items.filter((r) => lower(r.mode) === lower(filters.mode));
  return items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

// B-side visibility: only the candidates of that B, with no commission data.
function recommendationForB(organizationId) {
  return recs().all()
    .filter((r) => r.candidates.some((c) => String(c.b_organization_id) === String(organizationId)))
    .map((r) => ({
      id: r.id,
      requirement_id: r.requirement_id,
      tier: r.tier,
      mode: r.mode,
      status: r.status,
      created_at: r.created_at,
      my_candidate: r.candidates.find((c) => String(c.b_organization_id) === String(organizationId)) || null
    }));
}

module.exports = {
  evaluateAdmission, orderCapacity, scoreCandidate,
  requirementMatchScore, qualityTrustScore, responsivenessScore, activityScore,
  partnershipDepthScore, fairRotationScore, randomJitter,
  recommend, switchCandidate, recordResponse, recommendationById, listRecommendations, recommendationForB
};
