'use strict';
// ---------------------------------------------------------------------------
// AETHEL X — unified payment orchestration (Rule 11).
//
// All payments across all clients enter through one orchestration layer:
//   PaymentIntent → PaymentRoute → PaymentProvider → PaymentReceipt / Refund
//
// The platform never holds funds. When no real third-party provider is
// configured, the Sandbox provider is used and every response is labelled
// `mode: "sandbox"`. Nothing here claims a real cross-border payment.
// ---------------------------------------------------------------------------
const db = require('./db');
const config = require('./config');
const contracts = require('./contracts');
const { id, iso, lower, clone, asNumber, truthy, round2, hashString } = require('./util');
const audit = require('./audit');

const intents = () => db.stores.payment_intents;
const routes = () => db.stores.payment_routes;
const providers = () => db.stores.payment_providers;
const receipts = () => db.stores.payment_receipts;
const refunds = () => db.stores.refunds;

// ---------------------------------------------------------------------------
// Provider adapters (Rule 11): NexusPay / Stripe / BankTransfer / Manual / Other
// ---------------------------------------------------------------------------
const ADAPTERS = {
  nexuspay: { id: 'nexuspay', label: 'NexusPay', supports: ['card', 'wallet', 'bank_transfer'], default: true },
  stripe: { id: 'stripe', label: 'Stripe', supports: ['card'] },
  bank_transfer: { id: 'bank_transfer', label: 'Bank Transfer', supports: ['bank_transfer'] },
  manual: { id: 'manual', label: 'Manual / Offline', supports: ['bank_transfer', 'cash'] },
  other: { id: 'other', label: 'Other', supports: ['other'] }
};

function providerCatalog() {
  const configured = config.get('providers.payment', { adapter: 'nexuspay', mode: 'sandbox' });
  const adapter = ADAPTERS[lower(configured.adapter)] || ADAPTERS.nexuspay;
  return {
    configured_adapter: adapter.id,
    mode: lower(configured.mode) === 'live' ? 'live' : 'sandbox',
    available: Object.values(ADAPTERS).map((a) => ({
      id: a.id, label: a.label, supports: a.supports,
      is_configured: a.id === adapter.id
    })),
    note: '当前未接入真实第三方支付，全部流程走 Sandbox Provider；不得视为已完成真实跨境支付。'
  };
}

// ---------------------------------------------------------------------------
// PaymentIntent — the single entry point for every client
// ---------------------------------------------------------------------------
const INTENT_STATUSES = ['created', 'requires_action', 'processing', 'succeeded', 'failed', 'cancelled', 'refunded'];

const PAYMENT_KINDS = [
  'application_fee', 'registration_fee', 'service_fee', 'ad_order', 'membership', 'commission_settlement'
];

function createIntent(input, actor) {
  const kind = lower(input.kind);
  if (!PAYMENT_KINDS.includes(kind)) return { ok: false, error: '未知支付类型: ' + input.kind };
  const amount = round2(asNumber(input.amount, 0));
  if (!(amount > 0)) return { ok: false, error: '金额必须大于 0' };

  const provider = providers().find((p) => lower(p.status) === 'active' && lower(p.adapter) === lower(config.get('providers.payment.adapter', 'nexuspay')))
    || providers().insert({
      id: id('payment_provider'),
      adapter: lower(config.get('providers.payment.adapter', 'nexuspay')),
      mode: lower(config.get('providers.payment.mode', 'sandbox')),
      status: 'active',
      label: ADAPTERS[lower(config.get('providers.payment.adapter', 'nexuspay'))] ? ADAPTERS[lower(config.get('providers.payment.adapter', 'nexuspay'))].label : 'NexusPay',
      created_at: iso()
    });

  const record = {
    id: id('payment_intent'),
    kind,
    amount,
    currency: String(input.currency || 'SGD').toUpperCase(),
    payer_type: String(input.payer_type || 'C').toUpperCase(),   // C | B | S | DBC
    payer_id: input.payer_id || null,
    payee_type: String(input.payee_type || 'PLATFORM').toUpperCase(),
    payee_id: input.payee_id || null,
    related: {
      application_id: input.application_id || null,
      order_id: input.order_id || null,
      ad_order_id: input.ad_order_id || null,
      settlement_id: input.settlement_id || null
    },
    status: 'created',
    provider_id: provider.id,
    route_id: null,
    receipt_id: null,
    refund_ids: [],
    description: input.description || null,
    // Multi-currency fields only — no FX trading is performed.
    reference_rate: asNumber(input.reference_rate, null),
    rate_timestamp: input.rate_timestamp || null,
    sandbox: lower(provider.mode) !== 'live',
    created_at: iso(),
    updated_at: iso()
  };
  const saved = intents().insert(record);

  const route = routes().insert({
    id: id('payment_route'),
    payment_intent_id: saved.id,
    provider_id: provider.id,
    adapter: provider.adapter,
    mode: provider.mode,
    strategy: 'single_provider',
    created_at: iso()
  });
  saved.route_id = route.id;
  saved.status = 'requires_action';

  audit.record({ actor, action: 'payment:intent_create', entity: 'payment_intent', entity_id: saved.id, to: { kind, amount, currency: saved.currency, mode: provider.mode } });
  return { ok: true, intent: saved, route, provider };
}

// ---------------------------------------------------------------------------
// Confirm — the sandbox provider settles deterministically.
// A live provider would return an asynchronous status; we never fake one.
// ---------------------------------------------------------------------------
function confirmIntent(intentId, input, actor) {
  const intent = intents().byId(intentId);
  if (!intent) return { ok: false, error: '支付单不存在' };
  if (lower(intent.status) !== 'requires_action' && lower(intent.status) !== 'processing') {
    return { ok: false, error: '当前状态无法确认：' + intent.status };
  }
  const provider = providers().byId(intent.provider_id) || { adapter: 'nexuspay', mode: 'sandbox' };
  intent.status = 'processing';

  const outcome = lower(provider.mode) === 'live' ? 'pending_external' : 'succeeded';
  const reference = 'NXS-' + hashString(intent.id).slice(0, 16).toUpperCase();

  const receipt = receipts().insert({
    id: id('payment_receipt'),
    payment_intent_id: intent.id,
    amount: intent.amount,
    currency: intent.currency,
    provider_id: provider.id,
    adapter: provider.adapter,
    mode: provider.mode,
    reference,
    status: outcome === 'succeeded' ? 'succeeded' : 'pending',
    method: (input && input.method) || 'card',
    sandbox: lower(provider.mode) !== 'live',
    paid_at: outcome === 'succeeded' ? iso() : null,
    created_at: iso()
  });
  intent.receipt_id = receipt.id;
  intent.status = outcome === 'succeeded' ? 'succeeded' : 'processing';
  intent.updated_at = iso();

  audit.record({
    actor,
    action: 'payment:confirm',
    entity: 'payment_intent',
    entity_id: intent.id,
    to: { status: intent.status, reference, mode: provider.mode, sandbox: receipt.sandbox }
  });

  const result = { ok: true, intent, receipt, provider };

  // Rule 9/11: a successful payment is the commission trigger event.
  if (outcome === 'succeeded' && intent.kind === 'application_fee') {
    result.commission = triggerCommissionForPayment(intent, actor);
  }
  return result;
}

function triggerCommissionForPayment(intent, actor) {
  const rules = contracts.rulesFor(null, intent.related.application_id ? null : null, null);
  const app = intent.related.application_id ? require('./applications').applicationById(intent.related.application_id) : null;
  const binding = app ? require('./binding').currentBinding(app.c_profile_id) : null;
  const matched = contracts.listCommissionRules({}).find((r) =>
    String(r.supplier_id || '') === String(app ? app.supplier_id || '' : '') && lower(r.status) === 'active');

  if (!matched || !binding) return null;
  const computed = contracts.computeCommission({
    commission_rule_id: matched.id,
    base_amount: intent.amount,
    currency: intent.currency,
    application_id: intent.related.application_id,
    payment_intent_id: intent.id,
    trigger_event: 'PAYMENT_SUCCEEDED'
  });
  // Rule 9/10: the commission belongs to the bound B, even when C self-serves.
  if (computed.ok) computed.ledger.b_organization_id = binding.b_organization_id;
  return computed;
}

function refundIntent(intentId, input, actor) {
  const intent = intents().byId(intentId);
  if (!intent) return { ok: false, error: '支付单不存在' };
  if (lower(intent.status) !== 'succeeded') return { ok: false, error: '只有成功的支付可以退款' };
  const receipt = receipts().byId(intent.receipt_id);
  const amount = round2(asNumber(input && input.amount, intent.amount));
  if (amount > intent.amount) return { ok: false, error: '退款金额不能大于原金额' };

  const refund = refunds().insert({
    id: id('refund'),
    payment_intent_id: intent.id,
    receipt_id: receipt ? receipt.id : null,
    amount,
    currency: intent.currency,
    reason: (input && input.reason) || null,
    status: 'succeeded',
    provider_id: intent.provider_id,
    mode: receipt ? receipt.mode : 'sandbox',
    sandbox: receipt ? receipt.sandbox : true,
    refunded_at: iso(),
    created_at: iso()
  });
  intent.refund_ids = intent.refund_ids || [];
  intent.refund_ids.push(refund.id);
  intent.status = 'refunded';
  intent.updated_at = iso();

  // A refund claws back the associated commission.
  const ledgerEntries = db.stores.commission_ledger.filter((l) => String(l.payment_intent_id) === String(intent.id));
  for (const entry of ledgerEntries) contracts.updateLedgerStatus(entry.id, 'clawed_back', actor);

  audit.record({ actor, action: 'payment:refund', entity: 'payment_intent', entity_id: intent.id, to: refund });
  return { ok: true, intent, refund, clawed_back_commission: ledgerEntries.length };
}

function intentById(intentId) { return intents().byId(intentId); }

function listIntents(filters = {}) {
  let items = intents().all();
  if (filters.payer_id) items = items.filter((i) => String(i.payer_id) === String(filters.payer_id));
  if (filters.kind) items = items.filter((i) => lower(i.kind) === lower(filters.kind));
  if (filters.status) items = items.filter((i) => lower(i.status) === lower(filters.status));
  if (filters.application_id) items = items.filter((i) => String(i.related.application_id) === String(filters.application_id));
  if (filters.ad_order_id) items = items.filter((i) => String(i.related.ad_order_id) === String(filters.ad_order_id));
  return items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

function feeBreakdownOf(intentId) {
  return db.stores.fee_breakdowns.filter((f) => String(f.payment_intent_id) === String(intentId));
}

module.exports = {
  ADAPTERS, INTENT_STATUSES, PAYMENT_KINDS,
  providerCatalog, createIntent, confirmIntent, refundIntent,
  intentById, listIntents, feeBreakdownOf
};
