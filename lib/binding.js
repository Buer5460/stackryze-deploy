'use strict';
// ---------------------------------------------------------------------------
// C profiles, requirements and the C↔B binding state machine.
//
// Rules implemented:
//   2.  An unbound C is "无主": browse-only, no ordering / payment / upload.
//   7.  Binding: C picks B → Binding Request → B accepts → B-C contract →
//       dual e-signature → platform records → seat activated → full service.
//   10. A bound C may self-serve purchases; commission still belongs to the B.
//   12. First-binding protection (default 12 months, backend-configurable).
// ---------------------------------------------------------------------------
const db = require('./db');
const auth = require('./auth');
const config = require('./config');
const org = require('./org');
const contracts = require('./contracts');
const { id, iso, today, addMonths, addDays, daysBetween, isPast, lower, clone, asNumber, truthy } = require('./util');
const audit = require('./audit');

const cProfiles = () => db.stores.c_profiles;
const bindings = () => db.stores.bindings;
const bindingHistories = () => db.stores.binding_histories;

const BINDING_STATES = {
  UNBOUND: 'unbound',                 // 待绑定
  PENDING_B_REQUEST: 'pending_b_request',
  PENDING_CONTRACT: 'pending_contract',
  PENDING_C_SIGNATURE: 'pending_c_signature',
  PENDING_B_SIGNATURE: 'pending_b_signature',
  ACTIVE: 'active',                   // Bound — full service enabled
  PROTECTED: 'protected',             // within first-binding protection
  GRACE: 'grace',
  TRANSFERRED_TO_PLATFORM: 'platform_service'
};

// ---------------------------------------------------------------------------
// C profile
// ---------------------------------------------------------------------------
function createCProfile(input, actor) {
  const record = {
    id: id('c_profile'),
    user_id: input.user_id || null,
    name: input.name || null,
    name_en: input.name_en || null,
    email: input.email || null,
    phone: input.phone || null,
    nationality: input.nationality || null,
    education_stage: input.education_stage || null,
    target_countries: input.target_countries || [],
    target_courses: input.target_courses || [],
    guardian_name: input.guardian_name || null,
    guardian_relation: input.guardian_relation || null,
    language: input.language || 'zh',
    binding_state: BINDING_STATES.UNBOUND,
    source: input.source || 'self_registration',  // self | invite | share | ad | referral
    invited_by: input.invited_by || null,
    created_at: iso(),
    updated_at: iso()
  };
  const saved = cProfiles().insert(record);
  audit.record({ actor, action: 'c_profile:create', entity: 'c_profile', entity_id: saved.id, to: { id: saved.id, binding_state: saved.binding_state } });
  return saved;
}

function cProfileById(profileId) { return cProfiles().byId(profileId); }

function cProfileOfUser(userId) {
  return cProfiles().find((p) => String(p.user_id) === String(userId)) || null;
}

function updateCProfile(profileId, patch, actor) {
  const p = cProfiles().byId(profileId);
  if (!p) return null;
  const before = clone(p);
  const allowed = ['name', 'name_en', 'email', 'phone', 'nationality', 'education_stage',
    'target_countries', 'target_courses', 'guardian_name', 'guardian_relation', 'language'];
  for (const k of allowed) if (patch[k] !== undefined) p[k] = patch[k];
  p.updated_at = iso();
  audit.record({ actor, action: 'c_profile:update', entity: 'c_profile', entity_id: p.id, from: before, to: p });
  return p;
}

// ---------------------------------------------------------------------------
// Requirements (Rule: C 提交需求)
// ---------------------------------------------------------------------------
function submitRequirement(cProfileId, input, actor) {
  const record = {
    id: id('application_todo') && id('student_profile'),
    c_profile_id: cProfileId,
    target_countries: input.target_countries || [],
    target_stages: input.target_stages || [],
    target_courses: input.target_courses || [],
    languages: input.languages || [],
    budget_min: asNumber(input.budget_min, null),
    budget_max: asNumber(input.budget_max, null),
    budget_currency: input.budget_currency || 'SGD',
    special_requirements: input.special_requirements || [],
    service_types: input.service_types || [],
    status: 'open',
    created_at: iso(),
    updated_at: iso()
  };
  const saved = db.stores.student_profiles.insert(record);
  audit.record({ actor, action: 'requirement:submit', entity: 'student_profile', entity_id: saved.id, to: saved });
  return saved;
}

function requirementById(reqId) { return db.stores.student_profiles.byId(reqId); }

function requirementsOfC(cProfileId) {
  return db.stores.student_profiles.filter((r) => String(r.c_profile_id) === String(cProfileId));
}

// ---------------------------------------------------------------------------
// Rule 2 — what an unbound C may do
// ---------------------------------------------------------------------------
// Single source of truth so both the API guard and the UI read the same rules.
function cCapabilities(bindingState) {
  const unbound = lower(bindingState) === BINDING_STATES.UNBOUND;
  const cfg = config.all();
  return {
    binding_state: bindingState,
    bound: !unbound,
    can_browse: !unbound || truthy(cfg.c_unbound_can_browse),
    can_search: !unbound || truthy(cfg.c_unbound_can_search),
    can_view_fees: !unbound || truthy(cfg.c_unbound_can_view_fees),
    can_view_reviews: !unbound || truthy(cfg.c_unbound_can_review),
    can_submit_requirement: true,
    can_request_binding: true,
    can_order: !unbound && truthy(cfg.c_unbound_can_order) === false ? true : !unbound,
    can_pay: !unbound,
    can_upload_documents: !unbound,
    can_manage_visa: !unbound,
    can_contact_supplier: false,   // Rule 8: never, even when bound
    can_see_commission: false,     // Rule 9: never
    can_purchase_service: !unbound,
    can_review_supplier: !unbound
  };
}

function requireBoundC(req, res, next) {
  const c = req.cProfile;
  if (!c) return res.status(404).json({ ok: false, error: '学生档案不存在' });
  const caps = cCapabilities(c.binding_state);
  if (!caps.bound) {
    return res.status(403).json({
      ok: false,
      error: '请先绑定服务机构以激活完整服务',
      code: 'C_UNBOUND',
      capabilities: caps
    });
  }
  next();
}

// ---------------------------------------------------------------------------
// Rule 7 — binding flow
// ---------------------------------------------------------------------------
function createBindingRequest(input, actor) {
  const c = cProfileById(input.c_profile_id);
  if (!c) return { ok: false, error: '学生档案不存在' };
  if (c.binding_state !== BINDING_STATES.UNBOUND && c.binding_state !== BINDING_STATES.PROTECTED) {
    return { ok: false, error: '当前状态不允许发起绑定：' + c.binding_state };
  }

  const existing = bindings().find((b) => String(b.c_profile_id) === String(c.id) && ['pending_b_request', 'pending_contract', 'pending_c_signature', 'pending_b_signature'].includes(lower(b.status)));
  if (existing) return { ok: false, error: '已存在进行中的绑定申请', binding: existing };

  const protectionMonths = asNumber(config.get('first_binding_protection_months', 12), 12);
  const binding = {
    id: id('binding'),
    c_profile_id: c.id,
    b_organization_id: input.b_organization_id,
    b_profile_id: input.b_profile_id || (org.bProfileOf(input.b_organization_id) || {}).id || null,
    recommendation_id: input.recommendation_id || null,
    status: 'pending_b_request',
    initiated_by: (actor && actor.audience) || 'C',
    contract_id: null,
    requested_at: iso(),
    responded_at: null,
    contract_effective_at: null,
    first_binding_protected_until: addMonths(new Date(), protectionMonths).toISOString(),
    protection_months: protectionMonths,
    history: []
  };
  bindings().insert(binding);
  pushHistory(binding, 'created', 'C 发起绑定申请');
  audit.record({ actor, action: 'binding:request', entity: 'binding', entity_id: binding.id, to: binding });
  return { ok: true, binding };
}

function pushHistory(binding, event, note) {
  bindingHistories().insert({
    id: id('binding_history'),
    binding_id: binding.id,
    event,
    note: note || null,
    at: iso()
  });
}

// B accepts → generate the B-C contract.
function bRespond(bindingId, response, actor, options = {}) {
  const binding = bindings().byId(bindingId);
  if (!binding) return { ok: false, error: '绑定申请不存在' };
  if (lower(binding.status) !== 'pending_b_request') return { ok: false, error: '当前状态无法响应：' + binding.status };

  if (response !== 'accept') {
    binding.status = 'rejected_by_b';
    binding.responded_at = iso();
    pushHistory(binding, 'rejected_by_b', options.note || 'B 拒绝绑定');
    audit.record({ actor, action: 'binding:reject', entity: 'binding', entity_id: binding.id, to: binding });
    return { ok: true, binding };
  }

  // Order capacity guard: exceeding the cap blocks acceptance.
  const capacity = require('./recommendation').orderCapacity(binding.b_organization_id);
  if (!capacity.daily_ok || !capacity.monthly_ok) return { ok: false, error: '已达到接单上限', code: 'ORDER_CAP_REACHED', capacity };

  const contract = contracts.createAgreement({
    kind: 'B_C',
    b_organization_id: binding.b_organization_id,
    c_profile_id: binding.c_profile_id,
    binding_id: binding.id,
    title: 'B-C 服务合作合同'
  }, actor);

  binding.status = 'pending_contract';
  binding.contract_id = contract.id;
  binding.responded_at = iso();
  pushHistory(binding, 'accepted_by_b', 'B 接受绑定，已生成合同');
  audit.record({ actor, action: 'binding:accept', entity: 'binding', entity_id: binding.id, to: binding });
  return { ok: true, binding, contract };
}

// Dual signature. The platform only records the contract (Rule 7).
function signBinding(bindingId, signer, actor) {
  const binding = bindings().byId(bindingId);
  if (!binding) return { ok: false, error: '绑定申请不存在' };
  if (!binding.contract_id) return { ok: false, error: '尚未生成合同' };
  if (['active', 'rejected_by_b', 'cancelled'].includes(lower(binding.status))) {
    return { ok: false, error: '合同已终结：' + binding.status };
  }

  const result = contracts.sign(binding.contract_id, signer, actor);
  if (!result.ok) return result;
  const contract = result.agreement;

  if (lower(contract.status) === 'active') {
    binding.status = 'active';
    binding.contract_effective_at = iso();
    activateBinding(binding, actor);
  } else if (lower(contract.status) === 'pending_b_signature') {
    binding.status = 'pending_b_signature';
  } else {
    binding.status = 'pending_c_signature';
  }
  audit.record({ actor, action: 'binding:sign', entity: 'binding', entity_id: binding.id, to: binding });
  return { ok: true, binding, contract };
}

function activateBinding(binding, actor) {
  const c = cProfileById(binding.c_profile_id);
  if (!c) return;
  const previousB = c.binding_state === BINDING_STATES.ACTIVE ? currentBinding(c.id) : null;
  c.binding_state = BINDING_STATES.ACTIVE;
  c.bound_b_organization_id = binding.b_organization_id;
  c.bound_at = iso();
  c.updated_at = iso();
  pushHistory(binding, 'activated', '合同生效，C 席位已激活');

  // Rule 12: record the commission ownership transfer on rebinding.
  if (previousB && String(previousB.b_organization_id) !== String(binding.b_organization_id)) {
    audit.record({
      actor,
      action: 'binding:commission_ownership_transfer',
      entity: 'binding',
      entity_id: binding.id,
      from: { b_organization_id: previousB.b_organization_id },
      to: { b_organization_id: binding.b_organization_id }
    });
  }

  // Open the C seat (free of charge per spec).
  const seat = db.stores.service_scopes.insert({
    id: id('service_scope'),
    kind: 'C_SEAT',
    c_profile_id: c.id,
    b_organization_id: binding.b_organization_id,
    status: 'active',
    activated_at: iso(),
    price: 0,
    currency: config.get('commission_default_currency', 'SGD')
  });
  audit.record({ actor, action: 'c_seat:activate', entity: 'service_scope', entity_id: seat.id, to: seat });
}

function currentBinding(cProfileId) {
  return bindings().find((b) => String(b.c_profile_id) === String(cProfileId) && lower(b.status) === 'active') || null;
}

function bindingById(bindingId) { return bindings().byId(bindingId); }

function listBindings(filters = {}) {
  let items = bindings().all();
  if (filters.c_profile_id) items = items.filter((b) => String(b.c_profile_id) === String(filters.c_profile_id));
  if (filters.b_organization_id) items = items.filter((b) => String(b.b_organization_id) === String(filters.b_organization_id));
  if (filters.status) items = items.filter((b) => lower(b.status) === lower(filters.status));
  return items.sort((a, b) => (a.requested_at < b.requested_at ? 1 : -1));
}

// ---------------------------------------------------------------------------
// Rule 12 — first-binding protection & rebinding
// ---------------------------------------------------------------------------
function rebindingCheck(cProfileId) {
  const c = cProfileById(cProfileId);
  const active = currentBinding(cProfileId);
  if (!c || !active) return { protected: false, reason: 'no_active_binding' };
  const until = active.first_binding_protected_until;
  if (!until || isPast(until)) return { protected: false, reason: 'protection_expired', until };
  return {
    protected: true,
    until,
    days_remaining: daysBetween(new Date(), until),
    requires: ['original_b_consent', 'new_b_consent', 'platform_review', 'new_contract', 'commission_ownership_change', 'audit_log']
  };
}

// Full rebinding: needs both B consents + platform review (Rule 12).
function requestRebinding(input, actor) {
  const check = rebindingCheck(input.c_profile_id);
  if (!check.protected) return { ok: false, error: '不在首绑保护期内', check };

  const c = cProfileById(input.c_profile_id);
  const active = currentBinding(input.c_profile_id);
  const record = {
    id: id('binding'),
    c_profile_id: c.id,
    b_organization_id: input.new_b_organization_id,
    b_profile_id: input.new_b_profile_id || (org.bProfileOf(input.new_b_organization_id) || {}).id || null,
    previous_b_organization_id: active.b_organization_id,
    recommendation_id: input.recommendation_id || null,
    status: 'pending_b_request',
    initiated_by: (actor && actor.audience) || 'C',
    is_rebinding: true,
    rebinding: {
      original_b_consent: false,
      new_b_consent: false,
      platform_review: 'pending'
    },
    contract_id: null,
    requested_at: iso(),
    first_binding_protected_until: active.first_binding_protected_until,
    protection_months: active.protection_months,
    history: []
  };
  bindings().insert(record);
  pushHistory(record, 'rebinding_requested', '保护期内申请换绑');
  audit.record({
    actor,
    action: 'binding:rebinding_request',
    entity: 'binding',
    entity_id: record.id,
    from: { b_organization_id: active.b_organization_id },
    to: { b_organization_id: record.b_organization_id },
    note: '首绑保护期内换绑'
  });
  return { ok: true, binding: record, protection: check };
}

function recordRebindingConsent(bindingId, party, actor) {
  const binding = bindings().byId(bindingId);
  if (!binding || !binding.is_rebinding) return { ok: false, error: '不是换绑申请' };
  const key = party === 'original_b' ? 'original_b_consent' : party === 'new_b' ? 'new_b_consent' : null;
  if (!key) return { ok: false, error: '未知同意方' };
  binding.rebinding[key] = true;
  audit.record({ actor, action: 'binding:rebinding_consent', entity: 'binding', entity_id: binding.id, to: { party, consent: true } });
  return { ok: true, binding };
}

function platformReviewRebinding(bindingId, decision, actor) {
  const binding = bindings().byId(bindingId);
  if (!binding || !binding.is_rebinding) return { ok: false, error: '不是换绑申请' };
  // Consents are booleans; compare them as booleans (lower() returns a string).
  if (binding.rebinding.original_b_consent !== true || binding.rebinding.new_b_consent !== true) {
    return { ok: false, error: '双方 B 尚未全部同意' };
  }
  binding.rebinding.platform_review = decision === 'approve' ? 'approved' : 'rejected';
  audit.record({ actor, action: 'binding:rebinding_review', entity: 'binding', entity_id: binding.id, to: { decision } });
  return { ok: true, binding };
}

// ---------------------------------------------------------------------------
// Rule 13 — B membership expiry: C moves to platform service
// ---------------------------------------------------------------------------
function handleBMembershipExpiry(organizationId, actor) {
  const affected = bindings().filter((b) => String(b.b_organization_id) === String(organizationId) && lower(b.status) === 'active');
  for (const binding of affected) {
    const c = cProfileById(binding.c_profile_id);
    if (!c) continue;
    c.binding_state = BINDING_STATES.TRANSFERRED_TO_PLATFORM;
    c.updated_at = iso();
    binding.status = 'superseded_by_platform';
    pushHistory(binding, 'membership_expired', 'B 会员超期，C 转平台服务');
    audit.record({
      actor,
      action: 'binding:membership_expiry_transfer',
      entity: 'binding',
      entity_id: binding.id,
      from: { b_organization_id: organizationId },
      to: { owner: 'platform' }
    });
  }
  return affected.length;
}

function unbind(cProfileId, reason, actor) {
  const active = currentBinding(cProfileId);
  if (!active) return { ok: false, error: '没有生效中的绑定' };
  active.status = 'unbound';
  active.unbound_at = iso();
  active.unbind_reason = reason || null;
  pushHistory(active, 'unbound', reason || '解绑');
  const c = cProfileById(cProfileId);
  c.binding_state = BINDING_STATES.UNBOUND;
  c.bound_b_organization_id = null;
  c.updated_at = iso();
  audit.record({ actor, action: 'binding:unbind', entity: 'binding', entity_id: active.id, from: { b_organization_id: active.b_organization_id }, to: { binding_state: 'unbound' } });
  return { ok: true, binding: active };
}

module.exports = {
  BINDING_STATES, cCapabilities, requireBoundC,
  createCProfile, cProfileById, cProfileOfUser, updateCProfile,
  submitRequirement, requirementById, requirementsOfC,
  createBindingRequest, bRespond, signBinding, activateBinding, currentBinding,
  bindingById, listBindings, rebindingCheck, requestRebinding, recordRebindingConsent,
  platformReviewRebinding, handleBMembershipExpiry, unbind
};
