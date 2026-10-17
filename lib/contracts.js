'use strict';
// ---------------------------------------------------------------------------
// Contracts + Commission engine.
//
// Rules implemented:
//   7.  The platform only records the B-C contract; it is never a business
//       party that confirms business results.
//   9.  Commission is never visible to C. Net commission =
//       S_committed − AETHEL X orchestration fee − gateway fee.
//       The platform owns no funds and takes none of B's net commission.
//       Commission is bound to Supplier + Product + B + Agreement +
//       AgreementVersion + CommissionRule + TriggerEvent.
// ---------------------------------------------------------------------------
const db = require('./db');
const config = require('./config');
const { id, iso, today, lower, clone, asNumber, truthy, round2 } = require('./util');
const audit = require('./audit');

const agreements = () => db.stores.agreements;
const versions = () => db.stores.agreement_versions;
const signatures = () => db.stores.signatures;
const evidence = () => db.stores.contract_evidence;
const rules = () => db.stores.commission_rules;
const ledger = () => db.stores.commission_ledger;

// ---------------------------------------------------------------------------
// Agreements
// ---------------------------------------------------------------------------
const AGREEMENT_KINDS = ['B_C', 'B_S', 'DBC_B', 'DBC_S', 'S_PLATFORM'];

function createAgreement(input, actor) {
  const kind = String(input.kind || 'B_C').toUpperCase();
  if (!AGREEMENT_KINDS.includes(kind)) throw new Error('未知合同类型: ' + input.kind);
  const record = {
    id: id('agreement'),
    kind,
    title: input.title || defaultTitle(kind),
    b_organization_id: input.b_organization_id || null,
    c_profile_id: input.c_profile_id || null,
    supplier_id: input.supplier_id || null,
    dbc_organization_id: input.dbc_organization_id || null,
    binding_id: input.binding_id || null,
    state: input.state || 'A',             // A: DBC-routed, B: direct B↔S
    product_id: input.product_id || null,
    status: 'draft',                        // draft → pending_c_signature → pending_b_signature → active → terminated
    currency: input.currency || config.get('commission_default_currency', 'SGD'),
    current_version_id: null,
    is_demo: Boolean(input.is_demo),
    // Rule 9: never hard-code commission values on the agreement; they always
    // come from a CommissionRule.
    commission_rule_ids: [],
    created_at: iso(),
    updated_at: iso()
  };
  const saved = agreements().insert(record);
  const version = createVersion(saved.id, {
    body: input.body || defaultBody(kind),
    effective_from: input.effective_from || iso(),
    effective_to: input.effective_to || null
  }, actor);
  saved.current_version_id = version.id;
  // Mirror the version body onto the agreement so readers do not have to join.
  saved.body = version.body;
  audit.record({ actor, action: 'agreement:create', entity: 'agreement', entity_id: saved.id, to: { id: saved.id, kind: saved.kind } });
  return saved;
}

function defaultTitle(kind) {
  return {
    B_C: 'B-C 服务合作合同',
    B_S: 'B-S 合作协议',
    DBC_B: 'DBC-B 合作协议',
    DBC_S: 'DBC-S 合作协议',
    S_PLATFORM: 'S-平台合作协议'
  }[kind] || '合作协议';
}

function defaultBody(kind) {
  const base = '本合同由平台记录并存证。平台不作为业务一方确认业务结果。';
  if (kind === 'B_C') return 'B 端为 C 端提供留学服务，佣金归属按平台规则执行。' + base;
  if (kind === 'B_S') return 'B 端与 S 端就该供应商服务达成合作，佣金以 CommissionRule 为准。' + base;
  return base;
}

function createVersion(agreementId, input, actor) {
  const record = {
    id: id('agreement_version'),
    agreement_id: agreementId,
    version: nextVersionNumber(agreementId),
    body: input.body || '',
    effective_from: input.effective_from || iso(),
    effective_to: input.effective_to || null,
    status: 'current',
    created_at: iso()
  };
  // Supersede the previous current version.
  for (const v of versions()) {
    if (String(v.agreement_id) === String(agreementId) && lower(v.status) === 'current') v.status = 'superseded';
  }
  const saved = versions().insert(record);
  // Keep the agreement's mirrored body in sync with the newest version.
  const agreement = agreements().byId(agreementId);
  if (agreement) agreement.body = saved.body;
  audit.record({ actor, action: 'agreement_version:create', entity: 'agreement', entity_id: agreementId, to: { version: saved.version } });
  return saved;
}

function nextVersionNumber(agreementId) {
  const existing = versions().filter((v) => String(v.agreement_id) === String(agreementId));
  return existing.length + 1;
}

function agreementById(agreementId) { return agreements().byId(agreementId); }

function listAgreements(filters = {}) {
  let items = agreements().all();
  if (filters.kind) items = items.filter((a) => lower(a.kind) === lower(filters.kind));
  if (filters.b_organization_id) items = items.filter((a) => String(a.b_organization_id) === String(filters.b_organization_id));
  if (filters.c_profile_id) items = items.filter((a) => String(a.c_profile_id) === String(filters.c_profile_id));
  if (filters.supplier_id) items = items.filter((a) => String(a.supplier_id) === String(filters.supplier_id));
  if (filters.state) items = items.filter((a) => lower(a.state) === lower(filters.state));
  if (filters.status) items = items.filter((a) => lower(a.status) === lower(filters.status));
  return items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

// ---------------------------------------------------------------------------
// Dual e-signature (sandbox provider unless a real one is configured)
// ---------------------------------------------------------------------------
function sign(agreementId, signer, actor) {
  const agreement = agreements().byId(agreementId);
  if (!agreement) return { ok: false, error: '合同不存在' };
  if (lower(agreement.status) === 'active') return { ok: false, error: '合同已生效' };
  if (lower(agreement.status) === 'terminated') return { ok: false, error: '合同已终止' };
  if (signer !== 'C' && signer !== 'B') return { ok: false, error: '签署方必须为 C 或 B' };

  const existing = signatures().find((s) => String(s.agreement_id) === String(agreementId) && lower(s.signer) === lower(signer));
  if (existing) return { ok: false, error: '该方已签署' };

  const provider = config.get('providers.signature', { adapter: 'sandbox', mode: 'sandbox' });
  const signature = signatures().insert({
    id: id('signature'),
    agreement_id: agreementId,
    version_id: agreement.current_version_id,
    signer: signer.toUpperCase(),
    signed_by_user_id: (actor && actor.id) || null,
    signed_at: iso(),
    provider: provider.adapter,
    provider_mode: provider.mode,
    evidence_ref: 'sig-' + id('contract_evidence'),
    ip: null
  });

  const cSigned = signatures().all().some((s) => String(s.agreement_id) === String(agreementId) && lower(s.signer) === 'c');
  const bSigned = signatures().all().some((s) => String(s.agreement_id) === String(agreementId) && lower(s.signer) === 'b');

  if (cSigned && bSigned) {
    agreement.status = 'active';
    agreement.effective_at = iso();
  } else {
    agreement.status = cSigned ? 'pending_b_signature' : 'pending_c_signature';
  }
  agreement.updated_at = iso();

  audit.record({ actor, action: 'agreement:sign', entity: 'agreement', entity_id: agreementId, to: { signer, status: agreement.status } });
  return { ok: true, agreement, signature };
}

function attachEvidence(agreementId, input, actor) {
  const agreement = agreements().byId(agreementId);
  if (!agreement) return { ok: false, error: '合同不存在' };
  const record = evidence().insert({
    id: id('contract_evidence'),
    agreement_id: agreementId,
    kind: input.kind || 'document',      // document | screenshot | hash | timestamp
    source_url: input.source_url || null,
    content_hash: input.content_hash || null,
    note: input.note || null,
    uploaded_by: (actor && actor.id) || null,
    created_at: iso()
  });
  audit.record({ actor, action: 'agreement:evidence', entity: 'agreement', entity_id: agreementId, to: record });
  return { ok: true, evidence: record };
}

// ---------------------------------------------------------------------------
// Commission rules (Rule 9: never hard-coded)
// ---------------------------------------------------------------------------
const COMMISSION_MODES = ['PERCENTAGE', 'FIXED_PER_STUDENT', 'FIXED_PER_BOOKING', 'TIERED', 'BONUS', 'RENEWAL', 'MULTI_PERIOD'];

function createCommissionRule(input, actor) {
  const mode = String(input.mode || 'PERCENTAGE').toUpperCase();
  if (!COMMISSION_MODES.includes(mode)) throw new Error('未知佣金模式: ' + input.mode);
  const record = {
    id: id('commission_rule'),
    supplier_id: input.supplier_id || null,
    product_id: input.product_id || null,
    b_organization_id: input.b_organization_id || null,
    agreement_id: input.agreement_id || null,
    agreement_version_id: input.agreement_version_id || null,
    mode,
    value: asNumber(input.value, 0),
    currency: input.currency || config.get('commission_default_currency', 'SGD'),
    tiers: input.tiers || null,             // for TIERED: [{min,max,value}]
    bonus_value: asNumber(input.bonus_value, 0),
    renewal_value: asNumber(input.renewal_value, 0),
    periods: input.periods || null,
    trigger_event: input.trigger_event || 'PAYMENT_SUCCEEDED',
    settlement_cycle_days: asNumber(input.settlement_cycle_days, config.get('commission_settlement_cycle_days', 30)),
    status: lower(input.status || 'active'),
    is_demo: Boolean(input.is_demo),
    effective_from: input.effective_from || iso(),
    effective_to: input.effective_to || null,
    source_document: input.source_document || null,
    created_at: iso(),
    updated_at: iso()
  };
  const saved = rules().insert(record);
  if (record.agreement_id) {
    const agreement = agreements().byId(record.agreement_id);
    if (agreement && !agreement.commission_rule_ids.includes(saved.id)) agreement.commission_rule_ids.push(saved.id);
  }
  audit.record({ actor, action: 'commission_rule:create', entity: 'commission_rule', entity_id: saved.id, to: { mode, value: saved.value, product_id: saved.product_id } });
  return saved;
}

function rulesFor(supplierId, productId, bOrganizationId) {
  const now = new Date();
  return rules().filter((r) => {
    if (lower(r.status) !== 'active') return false;
    if (supplierId && String(r.supplier_id) !== String(supplierId)) return false;
    if (productId && String(r.product_id) !== String(productId)) return false;
    if (bOrganizationId && String(r.b_organization_id) !== String(bOrganizationId)) return false;
    if (r.effective_from && new Date(r.effective_from) > now) return false;
    if (r.effective_to && new Date(r.effective_to) < now) return false;
    return true;
  });
}

function listCommissionRules(filters = {}) {
  let items = rules().all();
  if (filters.supplier_id) items = items.filter((r) => String(r.supplier_id) === String(filters.supplier_id));
  if (filters.product_id) items = items.filter((r) => String(r.product_id) === String(filters.product_id));
  if (filters.b_organization_id) items = items.filter((r) => String(r.b_organization_id) === String(filters.b_organization_id));
  if (filters.agreement_id) items = items.filter((r) => String(r.agreement_id) === String(filters.agreement_id));
  return items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

// ---------------------------------------------------------------------------
// Commission calculation (Rule 9)
// ---------------------------------------------------------------------------
// net = committed − platform_orchestration_fee − gateway_fee
// The platform's share of the net commission is always zero.
function computeCommission(input) {
  const rule = rules().byId(input.commission_rule_id);
  if (!rule) return { ok: false, error: '佣金规则不存在' };
  const currency = input.currency || rule.currency;
  const base = asNumber(input.base_amount, 0);

  let committed = 0;
  switch (lower(rule.mode)) {
    case 'percentage':
      committed = base * (asNumber(rule.value, 0) / 100);
      break;
    case 'fixed_per_student':
    case 'fixed_per_booking':
      committed = asNumber(rule.value, 0);
      break;
    case 'tiered': {
      const tier = (rule.tiers || []).find((t) => base >= asNumber(t.min, 0) && base <= asNumber(t.max, Infinity));
      if (!tier) return { ok: false, error: '没有匹配的佣金阶梯' };
      committed = lower(tier.mode) === 'percentage' ? base * (asNumber(tier.value, 0) / 100) : asNumber(tier.value, 0);
      break;
    }
    case 'bonus':
      committed = asNumber(rule.bonus_value, 0);
      break;
    case 'renewal':
      committed = asNumber(rule.renewal_value, 0);
      break;
    case 'multi_period':
      committed = (rule.periods || []).reduce((sum, p) => sum + asNumber(p.value, 0), 0);
      break;
    default:
      return { ok: false, error: '未知佣金模式' };
  }

  const orchestrationBps = asNumber(config.get('commission_platform_orchestration_fee_bps', 250), 250);
  const gatewayBps = asNumber(config.get('commission_gateway_fee_bps', 180), 180);
  const orchestrationFee = round2(committed * (orchestrationBps / 10000));
  const gatewayFee = round2(committed * (gatewayBps / 10000));
  const net = round2(committed - orchestrationFee - gatewayFee);
  const platformShare = round2(asNumber(config.get('commission_net_share_to_platform', 0), 0) * net / 100);

  const breakdown = {
    commission_rule_id: rule.id,
    agreement_id: rule.agreement_id,
    agreement_version_id: rule.agreement_version_id,
    mode: rule.mode,
    trigger_event: input.trigger_event || rule.trigger_event,
    base_amount: round2(base),
    committed: round2(committed),
    aethel_x_orchestration_fee: orchestrationFee,
    payment_gateway_fee: gatewayFee,
    net_to_b: round2(net - platformShare),
    platform_share_of_net: platformShare,
    currency,
    supplier_id: rule.supplier_id,
    product_id: rule.product_id,
    b_organization_id: rule.b_organization_id,
    computed_at: iso()
  };

  const fee = db.stores.fee_breakdowns.insert({
    id: id('fee_breakdown'),
    payment_intent_id: input.payment_intent_id || null,
    application_id: input.application_id || null,
    ...breakdown
  });

  const entry = {
    id: id('commission_ledger'),
    fee_breakdown_id: fee.id,
    commission_rule_id: rule.id,
    b_organization_id: rule.b_organization_id,
    supplier_id: rule.supplier_id,
    product_id: rule.product_id,
    application_id: input.application_id || null,
    payment_intent_id: input.payment_intent_id || null,
    trigger_event: breakdown.trigger_event,
    amount: breakdown.net_to_b,
    currency,
    status: 'projected',     // projected → confirmed → receivable → received → payable → paid
    created_at: iso()
  };
  const saved = ledger().insert(entry);

  db.stores.commission_triggers.insert({
    id: id('commission_trigger'),
    commission_rule_id: rule.id,
    fee_breakdown_id: fee.id,
    commission_ledger_id: saved.id,
    trigger_event: breakdown.trigger_event,
    payment_intent_id: input.payment_intent_id || null,
    fired_at: iso()
  });

  audit.record({
    action: 'commission:compute',
    entity: 'commission_ledger',
    entity_id: saved.id,
    to: { committed: breakdown.committed, net_to_b: breakdown.net_to_b, mode: breakdown.mode }
  });

  return { ok: true, ledger: saved, breakdown, fee };
}

// Rule 9: the platform never owns the funds and never splits B's net commission.
function validateCommissionSharing(breakdown) {
  return round2(breakdown.net_to_b + breakdown.platform_share_of_net) === round2(breakdown.committed - breakdown.aethel_x_orchestration_fee - breakdown.payment_gateway_fee)
    && asNumber(breakdown.platform_share_of_net, 0) === 0;
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------
const SETTLEMENT_STATES = ['projected', 'confirmed', 'receivable', 'received', 'payable', 'paid', 'clawed_back'];

function createSettlement(input, actor) {
  const entries = (input.commission_ledger_ids || []).map((lid) => ledger().byId(lid)).filter(Boolean);
  if (!entries.length) return { ok: false, error: '没有可结算的佣金记录' };
  for (const e of entries) {
    if (!SETTLEMENT_STATES.includes(lower(e.status))) return { ok: false, error: '佣金状态异常：' + e.status };
  }
  const total = entries.reduce((sum, e) => sum + asNumber(e.amount, 0), 0);
  const record = {
    id: id('settlement'),
    b_organization_id: input.b_organization_id || entries[0].b_organization_id,
    supplier_id: input.supplier_id || entries[0].supplier_id,
    commission_ledger_ids: entries.map((e) => e.id),
    total_amount: round2(total),
    currency: input.currency || entries[0].currency,
    status: 'projected',
    cycle_days: asNumber(input.cycle_days, config.get('commission_settlement_cycle_days', 30)),
    due_date: null,
    created_at: iso(),
    updated_at: iso()
  };
  record.due_date = new Date(Date.now() + record.cycle_days * 86400000).toISOString();
  for (const e of entries) e.settlement_id = record.id;
  const saved = db.stores.settlements.insert(record);
  for (const e of entries) db.touch('commission_ledger', e.id, e);
  audit.record({ actor, action: 'settlement:create', entity: 'settlement', entity_id: saved.id, to: saved });
  return { ok: true, settlement: saved };
}

const SETTLEMENT_FLOW = ['projected', 'confirmed', 'receivable', 'received', 'payable', 'paid'];

function advanceSettlement(settlementId, target, actor) {
  const settlement = db.stores.settlements.byId(settlementId);
  if (!settlement) return { ok: false, error: '结算单不存在' };
  if (!SETTLEMENT_STATES.includes(lower(target))) return { ok: false, error: '未知结算状态' };
  const from = settlement.status;
  const idx = SETTLEMENT_FLOW.indexOf(lower(from));
  const toIdx = SETTLEMENT_FLOW.indexOf(lower(target));
  // Clawback is allowed from any non-clawed state.
  if (lower(target) === 'clawed_back' && lower(from) !== 'clawed_back') {
    // fall through to the state write below
  } else if (idx < 0 || toIdx !== idx + 1) {
    // Only the next state in the flow may be entered.
    return { ok: false, error: '非法的结算状态流转：' + from + ' → ' + target };
  }
  settlement.status = lower(target);
  settlement.updated_at = iso();
  if (lower(target) === 'clawed_back') settlement.clawed_back_at = iso();
  // Mirror the state onto the linked commission ledger entries.
  for (const ledgerId of settlement.commission_ledger_ids || []) {
    const entry = ledger().byId(ledgerId);
    if (entry) entry.status = lower(target);
  }
  audit.record({ actor, action: 'settlement:advance', entity: 'settlement', entity_id: settlement.id, from, to: settlement.status });
  return { ok: true, settlement };
}

function settlementById(settlementId) { return db.stores.settlements.byId(settlementId); }

function listSettlements(filters = {}) {
  let items = db.stores.settlements.all();
  if (filters.b_organization_id) items = items.filter((s) => String(s.b_organization_id) === String(filters.b_organization_id));
  if (filters.supplier_id) items = items.filter((s) => String(s.supplier_id) === String(filters.supplier_id));
  if (filters.status) items = items.filter((s) => lower(s.status) === lower(filters.status));
  return items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

function commissionLedgerOf(bOrganizationId) {
  let items = ledger().all();
  if (bOrganizationId) items = items.filter((e) => String(e.b_organization_id) === String(bOrganizationId));
  return items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

function updateLedgerStatus(ledgerId, status, actor) {
  if (!SETTLEMENT_STATES.includes(lower(status))) return { ok: false, error: '未知佣金状态' };
  const entry = ledger().byId(ledgerId);
  if (!entry) return { ok: false, error: '佣金记录不存在' };
  const from = entry.status;
  entry.status = lower(status);
  entry.updated_at = iso();
  audit.record({ actor, action: 'commission_ledger:status', entity: 'commission_ledger', entity_id: entry.id, from, to: entry.status });
  return { ok: true, ledger: entry };
}

module.exports = {
  AGREEMENT_KINDS, COMMISSION_MODES, SETTLEMENT_STATES,
  createAgreement, createVersion, agreementById, listAgreements,
  sign, attachEvidence,
  createCommissionRule, rulesFor, listCommissionRules,
  computeCommission, validateCommissionSharing,
  createSettlement, advanceSettlement, settlementById, listSettlements,
  commissionLedgerOf, updateLedgerStatus
};
