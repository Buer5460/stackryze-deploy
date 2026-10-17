'use strict';
// ---------------------------------------------------------------------------
// Organizations, memberships and B profiles.
// One Organization per real party (B agency, S supplier, DBC, or the platform).
// Membership carries the tier + expiry that Rule 13 depends on.
// ---------------------------------------------------------------------------
const db = require('./db');
const auth = require('./auth');
const { id, iso, today, addMonths, addDays, daysBetween, isPast, lower, clone, asNumber, truthy } = require('./util');
const audit = require('./audit');

const orgs = () => db.stores.organizations;
const memberships = () => db.stores.memberships;
const bProfiles = () => db.stores.b_profiles;

function createOrganization(input, actor) {
  const record = {
    id: id('org'),
    kind: String(input.kind || 'B').toUpperCase(),   // B | S | DBC | PLATFORM
    name: input.name,
    name_en: input.name_en || null,
    legal_name: input.legal_name || null,
    country: input.country || null,
    city: input.city || null,
    contact_name: input.contact_name || null,
    contact_email: input.contact_email || null,
    contact_phone: input.contact_phone || null,
    website: input.website || null,
    // KYC / KYB (Rule 4 hard admission)
    kyc_status: input.kyc_status || 'pending',        // pending | approved | rejected
    kyb_status: input.kyb_status || 'pending',
    kyc_provider: 'sandbox',
    aml_status: input.aml_status || 'pending',
    financial_docs_complete: Boolean(input.financial_docs_complete),
    verified: Boolean(input.verified),
    verified_at: input.verified_at || null,
    is_demo: Boolean(input.is_demo),
    status: input.status || 'active',                 // active | frozen | suspended
    frozen_reason: input.frozen_reason || null,
    created_at: iso(),
    updated_at: iso()
  };
  const saved = orgs().insert(record);
  audit.record({ actor, action: 'organization:create', entity: 'organization', entity_id: saved.id, to: saved });
  return saved;
}

function updateOrganization(orgId, patch, actor) {
  const org = orgs().byId(orgId);
  if (!org) return null;
  const before = clone(org);
  const allowed = ['name', 'name_en', 'legal_name', 'country', 'city', 'contact_name', 'contact_email',
    'contact_phone', 'website', 'kyc_status', 'kyb_status', 'aml_status', 'financial_docs_complete',
    'verified', 'verified_at', 'status', 'frozen_reason'];
  for (const key of allowed) if (patch[key] !== undefined) org[key] = patch[key];
  org.updated_at = iso();
  audit.record({ actor, action: 'organization:update', entity: 'organization', entity_id: org.id, from: before, to: org });
  return org;
}

function findOrganization(orgId) { return orgs().byId(orgId); }

function organizationsOfKind(kind) {
  return orgs().filter((o) => lower(o.kind) === lower(kind));
}

// --- Memberships (Rule 13: expiry + grace) ----------------------------------
const GRACE_DAYS = () => asNumber(require('./config').get('membership_grace_days', 30), 30);

function createMembership(input, actor) {
  const level = String(input.level || 'FREE').toUpperCase();
  if (!auth.B_LEVELS[level]) throw new Error('未知会员等级: ' + input.level);
  const record = {
    id: id('membership'),
    organization_id: input.organization_id,
    level,
    status: input.status || 'active',            // active | grace | expired | cancelled
    starts_at: input.starts_at || iso(),
    expires_at: input.expires_at || addMonths(new Date(), 12).toISOString(),
    grace_until: null,
    auto_renew: truthy(input.auto_renew),
    price: input.price === undefined ? null : asNumber(input.price, 0),
    currency: input.currency || 'SGD',
    source: input.source || 'admin',
    created_at: iso(),
    updated_at: iso()
  };
  const saved = memberships().insert(record);
  audit.record({ actor, action: 'membership:create', entity: 'membership', entity_id: saved.id, to: saved });
  return saved;
}

function activeMembership(organizationId) {
  // Newest first by insertion sequence, falling back to start time.
  const list = memberships()
    .filter((m) => String(m.organization_id) === String(organizationId))
    .sort((a, b) => {
      const sa = Number(a._seq || 0);
      const sb = Number(b._seq || 0);
      if (sa !== sb) return sb - sa;
      return String(b.starts_at || '') < String(a.starts_at || '') ? -1 : 1;
    });
  return list[0] || null;
}

// Membership validity for Rule 4: "会员有效". A membership in grace still
// counts as valid, an expired one does not.
function membershipValid(organizationId, at = new Date()) {
  const m = activeMembership(organizationId);
  if (!m) return { valid: false, reason: 'no_membership', membership: null };
  const when = at instanceof Date ? at : new Date(at);
  if (lower(m.status) === 'cancelled') return { valid: false, reason: 'cancelled', membership: m };
  if (m.expires_at && new Date(m.expires_at).getTime() >= when.getTime()) {
    return { valid: true, reason: 'active', membership: m };
  }
  if (m.grace_until && new Date(m.grace_until).getTime() >= when.getTime()) {
    return { valid: true, reason: 'grace', membership: m };
  }
  return { valid: false, reason: 'expired', membership: m };
}

function membershipExpiryInfo(organizationId) {
  const m = activeMembership(organizationId);
  if (!m) return null;
  const days = m.expires_at ? daysBetween(new Date(), m.expires_at) : null;
  const reminders = require('./config').get('membership_expiry_reminder_days', [60, 30, 7, 1]);
  return {
    membership_id: m.id,
    level: m.level,
    status: m.status,
    expires_at: m.expires_at,
    grace_until: m.grace_until,
    days_to_expiry: days,
    due_reminders: Array.isArray(reminders) ? reminders.filter((d) => days !== null && days <= d && days >= 0) : [],
    expired: Boolean(days !== null && days < 0 && !(m.grace_until && new Date(m.grace_until).getTime() >= Date.now()))
  };
}

// Rule 13: expiry → 30 day grace. During grace the B may renew and existing
// commission keeps flowing to them.
function expireMembership(organizationId, actor) {
  const m = activeMembership(organizationId);
  if (!m) return null;
  const grace = asNumber(require('./config').get('membership_grace_days', 30), 30);
  m.status = 'expired';
  m.grace_until = addDays(new Date(), grace).toISOString();
  m.updated_at = iso();
  audit.record({ actor, action: 'membership:expire', entity: 'membership', entity_id: m.id, from: null, to: m });
  return m;
}

function renewMembership(organizationId, input, actor) {
  const m = activeMembership(organizationId);
  const months = asNumber(input && input.months, 12);
  const record = createMembership({
    organization_id: organizationId,
    level: (input && input.level) || (m ? m.level : 'FREE'),
    expires_at: addMonths(new Date(), months).toISOString(),
    auto_renew: input && input.auto_renew,
    price: input && input.price,
    currency: input && input.currency,
    source: (input && input.source) || 'renewal'
  }, actor);
  if (m) {
    m.status = 'superseded';
    m.updated_at = iso();
  }
  return record;
}

// --- B profiles -------------------------------------------------------------
function createBProfile(input, actor) {
  const record = {
    id: id('b_profile'),
    organization_id: input.organization_id,
    level: String(input.level || 'FREE').toUpperCase(),
    service_countries: input.service_countries || [],
    service_courses: input.service_courses || [],
    service_stages: input.service_stages || [],
    service_types: input.service_types || [],
    languages: input.languages || [],
    daily_order_cap: asNumber(input.daily_order_cap, 10),
    monthly_order_cap: asNumber(input.monthly_order_cap, 100),
    // Rule 4 admission flags
    accepts_platform_recommendation: input.accepts_platform_recommendation === undefined ? true : truthy(input.accepts_platform_recommendation),
    recommendation_paused: Boolean(input.recommendation_paused),
    verified: Boolean(input.verified),
    contract_valid: Boolean(input.contract_valid),
    unresolved_serious_disputes: asNumber(input.unresolved_serious_disputes, 0),
    operational_status: input.operational_status || 'normal',   // normal | limited | paused
    status_a: input.status_a === undefined ? true : truthy(input.status_a), // A = 可执行
    status_b: input.status_b === undefined ? true : truthy(input.status_b),
    avg_response_minutes: asNumber(input.avg_response_minutes, 60),
    rating_avg: asNumber(input.rating_avg, 4.5),
    rating_count: asNumber(input.rating_count, 0),
    active_c_students: asNumber(input.active_c_students, 0),
    commission_agreements_count: asNumber(input.commission_agreements_count, 0),
    created_at: iso(),
    updated_at: iso()
  };
  const saved = bProfiles().insert(record);
  audit.record({ actor, action: 'b_profile:create', entity: 'b_profile', entity_id: saved.id, to: saved });
  return saved;
}

function updateBProfile(profileId, patch, actor) {
  const p = bProfiles().byId(profileId);
  if (!p) return null;
  const before = clone(p);
  Object.assign(p, patch);
  p.updated_at = iso();
  audit.record({ actor, action: 'b_profile:update', entity: 'b_profile', entity_id: p.id, from: before, to: p });
  return p;
}

function bProfileOf(organizationId) {
  return bProfiles().find((p) => String(p.organization_id) === String(organizationId)) || null;
}

function bProfileById(profileId) { return bProfiles().byId(profileId); }

module.exports = {
  createOrganization, updateOrganization, findOrganization, organizationsOfKind,
  createMembership, activeMembership, membershipValid, membershipExpiryInfo,
  expireMembership, renewMembership,
  createBProfile, updateBProfile, bProfileOf, bProfileById,
  GRACE_DAYS
};
