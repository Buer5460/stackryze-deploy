'use strict';
// ---------------------------------------------------------------------------
// System configuration — every tunable policy lives here, not in code.
// Rules that the task marks as "后台可配置" are read from this store.
// ---------------------------------------------------------------------------
const db = require('./db');
const { iso, asNumber, lower, clone } = require('./util');

const DEFAULTS = {
  // --- Recommendation engine (Rule 5) ---
  recommendation_weights: {
    requirement_match: 35,
    quality_trust: 25,
    responsiveness: 15,
    fair_rotation: 10,
    partnership_depth: 10,
    random_jitter: 5
  },
  recommendation_pool_size: 5,          // Rule 6: 3–5 recommended Bs
  recommendation_min_pool_size: 3,
  level2_priority_enabled: true,         // Rule 3
  level1_fallback_enabled: true,
  browse_only_enabled: true,
  min_exposure_share: 0.08,              // smallest Bs get a floor of visibility
  cold_start_bonus: 6,                   // new Bs get a score bonus
  cold_start_days: 45,
  head_b_penalty: 0.6,                   // decay applied to霸榜 Bs
  no_response_switch_minutes: 30,        // timeout → auto switch to next B
  ad_budget_affects_ranking: false,      // Rule 5: ad money never affects ranking

  // --- Binding (Rules 7, 12) ---
  first_binding_protection_months: 12,   // Rule 12
  rebinding_requires_platform_review: true,
  contract_signature_mode: 'sandbox',    // sandbox | manual

  // --- Membership / expiry (Rule 13) ---
  membership_expiry_reminder_days: [60, 30, 7, 1],
  membership_grace_days: 30,
  membership_renewal_url: null,

  // --- C-end restrictions (Rule 2) ---
  c_unbound_can_browse: true,
  c_unbound_can_view_fees: true,
  c_unbound_can_review: true,
  c_unbound_can_search: true,
  c_unbound_can_order: false,
  c_unbound_can_pay: false,
  c_unbound_can_upload: false,
  c_unbound_can_contact_supplier: false,

  // --- Supplier contact isolation (Rule 8) ---
  c_can_see_supplier_phone: false,
  c_can_see_supplier_private_email: false,
  c_can_see_supplier_private_whatsapp: false,
  c_can_see_commission: false,

  // --- Commission (Rule 9) ---
  commission_platform_orchestration_fee_bps: 250,  // 2.5% AETHEL X orchestration fee
  commission_gateway_fee_bps: 180,                 // 1.8% payment channel fee
  commission_net_share_to_platform: 0,             // platform takes none of B's net commission
  commission_default_currency: 'SGD',
  commission_settlement_cycle_days: 30,

  // --- Feature flags ---
  finance_enabled: false,                  // Rule: FINANCE disabled this round
  insurance_enabled: false,
  ads_enabled: true,
  demo_login_enabled: true,
  real_registration_enabled: true,

  // --- Ads (Configurable demo defaults only) ---
  ads_demo_topup_amount: 800,
  ads_demo_monthly_price: 100,
  ads_demo_max_renewals: 6,
  ads_default_currency: 'SGD',

  // --- Demo / Verified data policy ---
  demo_data_requires_label: true,
  verified_requires_source: true,
  ai_may_not_invent: ['tuition', 'admission_rate', 'ranking', 'commission', 'loan_rate', 'bed_inventory', 'visa_success_rate'],

  // --- Providers (all sandbox unless a real key is supplied) ---
  providers: {
    payment: { adapter: 'nexuspay', mode: 'sandbox' },
    ocr: { adapter: 'sandbox', mode: 'sandbox' },
    kyc: { adapter: 'sandbox', mode: 'sandbox' },
    aml: { adapter: 'sandbox', mode: 'sandbox' },
    sms: { adapter: 'sandbox', mode: 'sandbox' },
    email: { adapter: 'sandbox', mode: 'sandbox' },
    whatsapp: { adapter: 'sandbox', mode: 'sandbox' },
    wechat: { adapter: 'sandbox', mode: 'sandbox' },
    signature: { adapter: 'sandbox', mode: 'sandbox' },
    blockchain_evidence: { adapter: 'sandbox', mode: 'sandbox' }
  },

  // --- Branding ---
  brand: {
    product: 'GlobalStudy',
    operator: 'AETHEL EDU 安世达教育',
    footer_zh: '由安世达教育提供核心动力',
    footer_en: 'Powered by Aethel Edu'
  }
};

const config = () => {
  let store = db.stores.system_config.byId('SYSTEM');
  if (!store) {
    store = db.stores.system_config.insert({
      id: 'SYSTEM', version: '3.0.0', updated_at: iso(), values: clone(DEFAULTS)
    });
  }
  return store;
};

function get(path, fallback) {
  const values = config().values;
  if (!path) return values;
  const parts = String(path).split('.');
  let cur = values;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object' || !(p in cur)) return fallback;
    cur = cur[p];
  }
  return cur === undefined ? fallback : cur;
}

function all() {
  return clone(config().values);
}

function set(path, value, meta) {
  const store = config();
  const parts = String(path).split('.');
  let cur = store.values;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  const before = cur[parts[parts.length - 1]];
  cur[parts[parts.length - 1]] = value;
  store.updated_at = iso();
  store.history = store.history || [];
  store.history.push({ at: iso(), path, from: before, to: value, by: (meta && meta.by) || 'admin' });
  if (store.history.length > 200) store.history = store.history.slice(-200);
  db.touch('system_config', store.id, store);
  return clone(value);
}

function patch(patchObject, meta) {
  const store = config();
  const before = clone(store.values);
  Object.assign(store.values, patchObject || {});
  store.updated_at = iso();
  store.history = store.history || [];
  store.history.push({ at: iso(), path: '*', from: before, to: clone(store.values), by: (meta && meta.by) || 'admin' });
  if (store.history.length > 200) store.history = sliceHistory(store.history);
  db.touch('system_config', store.id, store);
  return clone(store.values);
}

function sliceHistory(history) { return history.slice(-200); }

function resetToDefaults(meta) {
  const store = config();
  const before = clone(store.values);
  store.values = clone(DEFAULTS);
  store.updated_at = iso();
  store.history = store.history || [];
  store.history.push({ at: iso(), path: 'reset', from: before, to: clone(DEFAULTS), by: (meta && meta.by) || 'admin' });
  db.touch('system_config', store.id, store);
  return clone(store.values);
}

// --- Convenience readers used across modules --------------------------------
const weights = () => get('recommendation_weights', DEFAULTS.recommendation_weights);
const financeEnabled = () => Boolean(get('finance_enabled', false));
const adsEnabled = () => Boolean(get('ads_enabled', true));

module.exports = {
  DEFAULTS, config, get, all, set, patch, resetToDefaults,
  weights, financeEnabled, adsEnabled,
  asNumber
};
