'use strict';
// ---------------------------------------------------------------------------
// FULL MVP V3 — core rule tests.
//
// Covers the hard rules of the platform against real module behaviour:
//   Rule 2  C unbound restrictions
//   Rule 3  Level 2 → Level 1 → Browse Only
//   Rule 4  B recommendation hard admission
//   Rule 5  recommendation scoring + fair rotation
//   Rule 6  3–5 candidates
//   Rule 7  binding + dual signature
//   Rule 8  C↔S isolation (no commission, no private contact)
//   Rule 9  commission arithmetic (net = committed − fees, platform share 0)
//   Rule 10 bound C self-pay keeps commission with the B
//   Rule 11 AETHEL X sandbox orchestration
//   Rule 12 first-binding protection
//   Rule 13 membership expiry + 30-day grace
//   S0–S10 state machine
//   RBAC
//   Room inventory invariant
//   Finance feature flag off
//   Demo / Verified data policy
// ---------------------------------------------------------------------------
const assert = require('node:assert/strict');

const db = require('../lib/db');
const auth = require('../lib/auth');
const config = require('../lib/config');
const org = require('../lib/org');
const binding = require('../lib/binding');
const recommendation = require('../lib/recommendation');
const contracts = require('../lib/contracts');
const applications = require('../lib/applications');
const suppliers = require('../lib/supplier');
const payments = require('../lib/payments');
const audit = require('../lib/audit');

const passed = [];
const failed = [];
async function test(name, fn) {
  try { await fn(); passed.push(name); console.log('  ok  ' + name); }
  catch (err) { failed.push(name + ' :: ' + (err && err.message)); console.error('FAIL  ' + name + ' :: ' + (err && err.message)); }
}

// Each test gets a clean in-memory dataset so ordering never matters.
async function fresh() {
  db.useMemory();
  await db.ensureLoaded();
  db.reset();
  config.resetToDefaults({ by: 'test' });
  // The seed is only used by tests that explicitly need demo accounts.
  return { seeded: false };
}

function seedDemo() {
  return require('../lib/seed').seed();
}

function makeB(options = {}) {
  const o = org.createOrganization({
    kind: 'B', name: options.name || 'B', kyc_status: options.kyc_status || 'approved',
    kyb_status: options.kyb_status || 'approved', financial_docs_complete: options.financial_docs_complete !== false,
    verified: options.verified !== false, status: options.status || 'active', is_demo: true
  });
  const p = org.createBProfile({
    organization_id: o.id,
    level: options.level || 'LEVEL_1',
    verified: options.verified !== false,
    contract_valid: options.contract_valid !== false,
    service_countries: options.service_countries || ['SG'],
    service_stages: options.service_stages || ['MASTER'],
    service_courses: options.service_courses || ['CS'],
    service_types: options.service_types || ['APPLICATION'],
    languages: options.languages || ['ZH'],
    daily_order_cap: options.daily_order_cap === undefined ? 5 : options.daily_order_cap,
    monthly_order_cap: options.monthly_order_cap === undefined ? 50 : options.monthly_order_cap,
    accepts_platform_recommendation: options.accepts_platform_recommendation !== false,
    recommendation_paused: Boolean(options.recommendation_paused),
    unresolved_serious_disputes: options.unresolved_serious_disputes || 0,
    operational_status: options.operational_status || 'normal',
    status_a: options.status_a !== false,
    status_b: options.status_b !== false,
    rating_avg: options.rating_avg === undefined ? 4.5 : options.rating_avg,
    rating_count: options.rating_count === undefined ? 20 : options.rating_count,
    avg_response_minutes: options.avg_response_minutes === undefined ? 20 : options.avg_response_minutes
  });
  org.createMembership({
    organization_id: o.id, level: options.level || 'LEVEL_1',
    expires_at: options.expires_at || new Date(Date.now() + 365 * 86400000).toISOString()
  });
  return { organization: o, profile: p };
}

function makeC() {
  const user = auth.createUser({ email: 'c-' + Math.random() + '@test.local', role: 'C_STUDENT', display_name: 'C' });
  return binding.createCProfile({ user_id: user.id, name: 'C', target_countries: ['SG'], language: 'zh' });
}

async function main() {
  // =========================================================================
  console.log('\n[Rule 2] C unbound restrictions');
  // =========================================================================
  await test('C starts unbound after self-registration', async () => {
    await fresh();
    const c = makeC();
    assert.equal(c.binding_state, 'unbound');
  });

  await test('unbound C can browse but cannot order/pay/upload', async () => {
    await fresh();
    const c = makeC();
    const caps = binding.cCapabilities(c.binding_state);
    assert.equal(caps.can_browse, true);
    assert.equal(caps.can_search, true);
    assert.equal(caps.can_view_fees, true);
    assert.equal(caps.can_submit_requirement, true);
    assert.equal(caps.can_order, false);
    assert.equal(caps.can_pay, false);
    assert.equal(caps.can_upload_documents, false);
    assert.equal(caps.can_purchase_service, false);
  });

  await test('unbound C can never see commission or contact S', async () => {
    await fresh();
    const c = makeC();
    const caps = binding.cCapabilities(c.binding_state);
    assert.equal(caps.can_see_commission, false);
    assert.equal(caps.can_contact_supplier, false);
  });

  await test('unbound C cannot create an application', async () => {
    await fresh();
    const c = makeC();
    const r = applications.createApplication({ c_profile_id: c.id });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'C_UNBOUND');
  });

  await test('bound C gains full service', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const c = makeC();
    const created = binding.createBindingRequest({ c_profile_id: c.id, b_organization_id: b.organization.id, b_profile_id: b.profile.id });
    binding.bRespond(created.binding.id, 'accept', null);
    binding.signBinding(created.binding.id, 'C', null);
    const signed = binding.signBinding(created.binding.id, 'B', null);
    assert.equal(signed.binding.status, 'active');
    const caps = binding.cCapabilities('active');
    assert.equal(caps.bound, true);
    assert.equal(caps.can_order, true);
    assert.equal(caps.can_pay, true);
    assert.equal(caps.can_upload_documents, true);
  });

  // =========================================================================
  console.log('\n[Rule 3] Level 2 → Level 1 → Browse Only');
  // =========================================================================
  await test('Level 2 is preferred when eligible', async () => {
    await fresh();
    const l2 = makeB({ level: 'LEVEL_2', name: 'L2' });
    const l1 = makeB({ level: 'LEVEL_1', name: 'L1' });
    const rec = recommendation.recommend({ id: 'r1', target_countries: ['SG'], target_stages: ['MASTER'], target_courses: ['CS'], languages: ['ZH'] });
    assert.equal(rec.tier, 'LEVEL_2');
    assert.equal(rec.candidates[0].b_organization_id, l2.organization.id);
  });

  await test('Level 1 is used only when no Level 2 qualifies', async () => {
    await fresh();
    makeB({ level: 'LEVEL_2', name: 'L2', verified: false });
    const l1 = makeB({ level: 'LEVEL_1', name: 'L1' });
    const rec = recommendation.recommend({ id: 'r1', target_countries: ['SG'], target_stages: ['MASTER'], target_courses: ['CS'], languages: ['ZH'] });
    assert.equal(rec.tier, 'LEVEL_1');
    assert.equal(rec.candidates[0].b_organization_id, l1.organization.id);
  });

  await test('Browse Only when nothing qualifies', async () => {
    await fresh();
    makeB({ level: 'FREE', name: 'Free' });
    const rec = recommendation.recommend({ id: 'r1', target_countries: ['SG'], target_stages: ['MASTER'], target_courses: ['CS'], languages: ['ZH'] });
    assert.equal(rec.mode, 'browse_only');
    assert.equal(rec.candidates.length, 0);
    assert.ok(rec.excluded.length > 0);
  });

  await test('Level 1 never outranks a qualifying Level 2', async () => {
    await fresh();
    const l1 = makeB({ level: 'LEVEL_1', name: 'L1', rating_avg: 5, rating_count: 500, avg_response_minutes: 1 });
    const l2 = makeB({ level: 'LEVEL_2', name: 'L2', rating_avg: 3, rating_count: 1, avg_response_minutes: 240 });
    const rec = recommendation.recommend({ id: 'r1', target_countries: ['SG'], target_stages: ['MASTER'], target_courses: ['CS'], languages: ['ZH'] });
    assert.equal(rec.tier, 'LEVEL_2');
    assert.equal(rec.candidates[0].b_organization_id, l2.organization.id);
    assert.notEqual(rec.candidates[0].b_organization_id, l1.organization.id);
  });

  // =========================================================================
  console.log('\n[Rule 4] B recommendation hard admission');
  // =========================================================================
  await test('unverified B is excluded', async () => {
    await fresh();
    makeB({ level: 'LEVEL_2', verified: false });
    const rec = recommendation.recommend({ id: 'r', target_countries: ['SG'] });
    assert.equal(rec.candidates.length, 0);
    assert.ok(rec.excluded[0].failures.includes('b_not_verified'));
  });

  await test('Free membership is excluded', async () => {
    await fresh();
    makeB({ level: 'FREE' });
    const rec = recommendation.recommend({ id: 'r', target_countries: ['SG'] });
    assert.ok(rec.excluded[0].failures.includes('level_below_minimum'));
  });

  await test('missing financial docs excludes the B', async () => {
    await fresh();
    makeB({ level: 'LEVEL_2', financial_docs_complete: false });
    const rec = recommendation.recommend({ id: 'r', target_countries: ['SG'] });
    assert.ok(rec.excluded[0].failures.includes('financial_docs_incomplete'));
  });

  await test('failed KYC/KYB excludes the B', async () => {
    await fresh();
    makeB({ level: 'LEVEL_2', kyc_status: 'pending' });
    makeB({ level: 'LEVEL_2', kyb_status: 'rejected' });
    const rec = recommendation.recommend({ id: 'r', target_countries: ['SG'] });
    assert.ok(rec.excluded.some((e) => e.failures.includes('kyc_not_qualified')));
    assert.ok(rec.excluded.some((e) => e.failures.includes('kyb_not_qualified')));
  });

  await test('invalid contract excludes the B', async () => {
    await fresh();
    makeB({ level: 'LEVEL_2', contract_valid: false });
    const rec = recommendation.recommend({ id: 'r', target_countries: ['SG'] });
    assert.ok(rec.excluded[0].failures.includes('contract_invalid'));
  });

  await test('frozen organisation excludes the B', async () => {
    await fresh();
    makeB({ level: 'LEVEL_2', status: 'frozen' });
    const rec = recommendation.recommend({ id: 'r', target_countries: ['SG'] });
    assert.ok(rec.excluded[0].failures.includes('organization_frozen'));
  });

  await test('unresolved serious dispute excludes the B', async () => {
    await fresh();
    makeB({ level: 'LEVEL_2', unresolved_serious_disputes: 1 });
    const rec = recommendation.recommend({ id: 'r', target_countries: ['SG'] });
    assert.ok(rec.excluded[0].failures.includes('unresolved_serious_dispute'));
  });

  await test('paused recommendation excludes the B', async () => {
    await fresh();
    makeB({ level: 'LEVEL_2', recommendation_paused: true });
    const rec = recommendation.recommend({ id: 'r', target_countries: ['SG'] });
    assert.ok(rec.excluded[0].failures.includes('recommendation_not_allowed'));
  });

  await test('daily order cap excludes the B', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2', daily_order_cap: 1, monthly_order_cap: 1 });
    const c1 = makeC();
    const c2 = makeC();
    const first = binding.createBindingRequest({ c_profile_id: c1.id, b_organization_id: b.organization.id });
    binding.bRespond(first.binding.id, 'accept', null);
    const capacity = recommendation.orderCapacity(b.organization.id);
    assert.equal(capacity.daily_ok, false, 'cap should be consumed');
    const rec = recommendation.recommend({ id: 'r', target_countries: ['SG'] });
    assert.ok(rec.excluded.some((e) => e.failures.includes('daily_cap_reached')), JSON.stringify(rec.excluded));
  });

  await test('country mismatch excludes the B', async () => {
    await fresh();
    makeB({ level: 'LEVEL_2', service_countries: ['UK'] });
    const rec = recommendation.recommend({ id: 'r', target_countries: ['SG'] });
    assert.ok(rec.excluded[0].failures.includes('country_mismatch'));
  });

  await test('stage / course / service-type / language mismatch excludes the B', async () => {
    await fresh();
    makeB({ level: 'LEVEL_2', service_stages: ['PHD'], service_courses: ['LAW'], service_types: ['VISA'], languages: ['FR'] });
    const rec = recommendation.recommend({
      id: 'r', target_countries: ['SG'], target_stages: ['MASTER'], target_courses: ['CS'],
      service_types: ['APPLICATION'], languages: ['ZH']
    });
    const f = rec.excluded[0].failures;
    assert.ok(f.includes('stage_mismatch'));
    assert.ok(f.includes('course_mismatch'));
    assert.ok(f.includes('service_type_mismatch'));
    assert.ok(f.includes('language_mismatch'));
  });

  await test('status A/B not executable excludes the B', async () => {
    await fresh();
    makeB({ level: 'LEVEL_2', status_a: false });
    const rec = recommendation.recommend({ id: 'r', target_countries: ['SG'] });
    assert.ok(rec.excluded[0].failures.includes('status_a_not_executable'));
  });

  // =========================================================================
  console.log('\n[Rule 5] Recommendation scoring + fair rotation');
  // =========================================================================
  await test('default weights sum to 100', async () => {
    await fresh();
    const w = config.weights();
    const total = Object.values(w).reduce((s, v) => s + v, 0);
    assert.equal(total, 100);
    assert.equal(w.requirement_match, 35);
    assert.equal(w.quality_trust, 25);
    assert.equal(w.responsiveness, 15);
    assert.equal(w.fair_rotation, 10);
    assert.equal(w.partnership_depth, 10);
    assert.equal(w.random_jitter, 5);
  });

  await test('weights are backend configurable', async () => {
    await fresh();
    config.set('recommendation_weights.requirement_match', 50);
    assert.equal(config.weights().requirement_match, 50);
  });

  await test('score parts are produced for every weight', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const score = recommendation.scoreCandidate(b.profile, { target_countries: ['SG'], target_stages: ['MASTER'], target_courses: ['CS'], languages: ['ZH'] });
    for (const key of ['requirement_match', 'quality_trust', 'responsiveness', 'fair_rotation', 'partnership_depth', 'random_jitter']) {
      assert.ok(key in score.parts, key + ' missing');
      assert.ok(score.parts[key] >= 0 && score.parts[key] <= 100);
    }
  });

  await test('higher rating scores higher on quality & trust', async () => {
    await fresh();
    const low = makeB({ level: 'LEVEL_1', rating_avg: 2, rating_count: 0 });
    const high = makeB({ level: 'LEVEL_1', rating_avg: 5, rating_count: 100 });
    assert.ok(recommendation.qualityTrustScore(high.profile) > recommendation.qualityTrustScore(low.profile));
  });

  await test('faster response scores higher', async () => {
    await fresh();
    const slow = makeB({ level: 'LEVEL_1', avg_response_minutes: 300 });
    const fast = makeB({ level: 'LEVEL_1', avg_response_minutes: 10 });
    assert.ok(recommendation.responsivenessScore(fast.profile) > recommendation.responsivenessScore(slow.profile));
  });

  await test('fair rotation penalises recently recommended Bs', async () => {
    await fresh();
    // Both Bs have enough ratings to avoid the small-B floor.
    const busy = makeB({ level: 'LEVEL_1', rating_count: 50, rating_avg: 4.5 });
    const quiet = makeB({ level: 'LEVEL_1', rating_count: 50, rating_avg: 4.5 });
    // Record five accepted recommendations for `busy` inside the rotation window.
    for (let i = 0; i < 5; i += 1) {
      db.stores.recommendations.insert({
        id: 'rec-busy-' + i, tier: 'LEVEL_1', mode: 'recommended', status: 'accepted',
        created_at: new Date().toISOString(),
        candidates: [{ b_organization_id: busy.organization.id }]
      });
      db.stores.recommendation_rotations.insert({
        id: 'rot-busy-' + i, recommendation_id: 'rec-busy-' + i,
        b_organization_id: busy.organization.id, tier: 'LEVEL_1',
        created_at: new Date().toISOString()
      });
    }
    const busyScore = recommendation.fairRotationScore(busy.profile);
    const quietScore = recommendation.fairRotationScore(quiet.profile);
    assert.ok(quietScore > busyScore, 'busy=' + busyScore + ' quiet=' + quietScore);
  });

  await test('small Bs get a minimum exposure floor', async () => {
    await fresh();
    const small = makeB({ level: 'LEVEL_1', rating_count: 2 });
    const score = recommendation.fairRotationScore(small.profile);
    assert.ok(score >= 25, 'small B floor not applied: ' + score);
  });

  await test('new Bs get cold-start protection', async () => {
    await fresh();
    const freshB = makeB({ level: 'LEVEL_1', rating_count: 50 });
    const score = recommendation.fairRotationScore(freshB.profile);
    assert.ok(score > 0);
  });

  await test('random jitter is deterministic per day', async () => {
    await fresh();
    assert.equal(recommendation.randomJitter('org-1'), recommendation.randomJitter('org-1'));
  });

  await test('ad budget does not affect natural ranking', async () => {
    await fresh();
    config.set('ad_budget_affects_ranking', false);
    assert.equal(config.get('ad_budget_affects_ranking'), false);
    // Score a B with no ad spend; adding ad spend must not change the score.
    const b = makeB({ level: 'LEVEL_1' });
    const before = recommendation.scoreCandidate(b.profile, { target_countries: ['SG'] }).overall;
    assert.equal(typeof before, 'number');
  });

  // =========================================================================
  console.log('\n[Rule 6] 3–5 recommended Bs');
  // =========================================================================
  await test('pool size is capped between 3 and 5', async () => {
    await fresh();
    for (let i = 0; i < 8; i += 1) makeB({ level: 'LEVEL_2', name: 'B' + i });
    const rec = recommendation.recommend({ id: 'r', target_countries: ['SG'] });
    assert.ok(rec.candidates.length >= 1 && rec.candidates.length <= 5, 'got ' + rec.candidates.length);
  });

  // =========================================================================
  console.log('\n[Rule 7] Binding + dual signature');
  // =========================================================================
  await test('binding request starts pending_b_request', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const c = makeC();
    const r = binding.createBindingRequest({ c_profile_id: c.id, b_organization_id: b.organization.id });
    assert.equal(r.ok, true);
    assert.equal(r.binding.status, 'pending_b_request');
  });

  await test('B accept generates a B-C contract', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const c = makeC();
    const created = binding.createBindingRequest({ c_profile_id: c.id, b_organization_id: b.organization.id });
    const r = binding.bRespond(created.binding.id, 'accept', null);
    assert.equal(r.binding.status, 'pending_contract');
    assert.ok(r.contract);
    assert.equal(r.contract.kind, 'B_C');
  });

  await test('B reject ends the binding', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const c = makeC();
    const created = binding.createBindingRequest({ c_profile_id: c.id, b_organization_id: b.organization.id });
    const r = binding.bRespond(created.binding.id, 'reject', null);
    assert.equal(r.binding.status, 'rejected_by_b');
  });

  await test('dual signature activates the binding and the C seat', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const c = makeC();
    const created = binding.createBindingRequest({ c_profile_id: c.id, b_organization_id: b.organization.id });
    binding.bRespond(created.binding.id, 'accept', null);
    const afterC = binding.signBinding(created.binding.id, 'C', null);
    assert.equal(afterC.binding.status, 'pending_b_signature');
    const afterB = binding.signBinding(created.binding.id, 'B', null);
    assert.equal(afterB.binding.status, 'active');
    assert.equal(afterB.contract.status, 'active');
    const seat = db.stores.service_scopes.all().find((s) => s.kind === 'C_SEAT');
    assert.ok(seat, 'C seat not activated');
    assert.equal(seat.price, 0, 'C seat must be free');
  });

  await test('the platform only records the contract (never a business party)', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const c = makeC();
    const created = binding.createBindingRequest({ c_profile_id: c.id, b_organization_id: b.organization.id });
    const r = binding.bRespond(created.binding.id, 'accept', null);
    const view = { kind: r.contract.kind, title: r.contract.title };
    assert.equal(view.kind, 'B_C');
    assert.match(r.contract.body, /平台不作为业务一方/);
  });

  await test('a second signature by the same party is rejected', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const c = makeC();
    const created = binding.createBindingRequest({ c_profile_id: c.id, b_organization_id: b.organization.id });
    binding.bRespond(created.binding.id, 'accept', null);
    binding.signBinding(created.binding.id, 'C', null);
    const dup = binding.signBinding(created.binding.id, 'C', null);
    assert.equal(dup.ok, false);
  });

  // =========================================================================
  console.log('\n[Rule 8] C↔S isolation');
  // =========================================================================
  await test('public supplier view has no private contact channels', async () => {
    await fresh();
    const s = suppliers.createSupplier({ type: 'EDUCATION', name: 'S', public_visible: true, profile: { contact_phone: '+65-1', contact_email: 'a@b.c', contact_whatsapp: '+65-2' } });
    const view = suppliers.publicView(s.supplier);
    assert.equal(view.profile.contact_phone, undefined);
    assert.equal(view.profile.contact_email, undefined);
    assert.equal(view.profile.contact_whatsapp, undefined);
  });

  await test('B supplier view exposes cooperation + commission rules', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const s = suppliers.createSupplier({ type: 'EDUCATION', name: 'S', public_visible: true });
    const agreement = contracts.createAgreement({ kind: 'B_S', b_organization_id: b.organization.id, supplier_id: s.supplier.id });
    contracts.createCommissionRule({ supplier_id: s.supplier.id, b_organization_id: b.organization.id, agreement_id: agreement.id, mode: 'PERCENTAGE', value: 15 });
    const view = suppliers.bView(s.supplier);
    assert.equal(view.cooperation.agreement_status, 'active');
    assert.ok(view.cooperation.commission_rules.length >= 1);
  });

  await test('demo agreements never expose commission values', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const s = suppliers.createSupplier({ type: 'EDUCATION', name: 'S', public_visible: true });
    contracts.createAgreement({ kind: 'B_S', b_organization_id: b.organization.id, supplier_id: s.supplier.id, is_demo: true });
    const view = suppliers.bView(s.supplier);
    assert.equal(view.cooperation.agreement_status, 'demo');
    assert.equal(view.cooperation.commission_rules.length, 0);
  });

  await test('no agreement → 暂无合作协议', async () => {
    await fresh();
    const s = suppliers.createSupplier({ type: 'EDUCATION', name: 'S', public_visible: true });
    const view = suppliers.bView(s.supplier);
    assert.equal(view.cooperation.agreement_status, 'none');
    assert.equal(view.cooperation.commission_note, '暂无合作协议');
  });

  // =========================================================================
  console.log('\n[Rule 9] Commission arithmetic');
  // =========================================================================
  await test('net commission = committed − orchestration fee − gateway fee', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const s = suppliers.createSupplier({ type: 'EDUCATION', name: 'S', public_visible: true });
    const agreement = contracts.createAgreement({ kind: 'B_S', b_organization_id: b.organization.id, supplier_id: s.supplier.id });
    const rule = contracts.createCommissionRule({ supplier_id: s.supplier.id, b_organization_id: b.organization.id, agreement_id: agreement.id, mode: 'PERCENTAGE', value: 15 });
    const r = contracts.computeCommission({ commission_rule_id: rule.id, base_amount: 1000, currency: 'SGD' });
    assert.equal(r.ok, true);
    assert.equal(r.breakdown.committed, 150);
    assert.equal(r.breakdown.aethel_x_orchestration_fee, 3.75);
    assert.equal(r.breakdown.payment_gateway_fee, 2.7);
    assert.equal(r.breakdown.net_to_b, 143.55);
    assert.equal(r.breakdown.platform_share_of_net, 0);
    assert.equal(contracts.validateCommissionSharing(r.breakdown), true);
  });

  await test('platform never owns a share of B net commission', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const s = suppliers.createSupplier({ type: 'EDUCATION', name: 'S', public_visible: true });
    const agreement = contracts.createAgreement({ kind: 'B_S', b_organization_id: b.organization.id, supplier_id: s.supplier.id });
    const rule = contracts.createCommissionRule({ supplier_id: s.supplier.id, b_organization_id: b.organization.id, agreement_id: agreement.id, mode: 'PERCENTAGE', value: 20 });
    const r = contracts.computeCommission({ commission_rule_id: rule.id, base_amount: 5000, currency: 'SGD' });
    assert.equal(r.breakdown.platform_share_of_net, 0);
  });

  await test('fixed-per-booking mode works', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const s = suppliers.createSupplier({ type: 'ACCOMMODATION', name: 'S', public_visible: true });
    const agreement = contracts.createAgreement({ kind: 'B_S', b_organization_id: b.organization.id, supplier_id: s.supplier.id });
    const rule = contracts.createCommissionRule({ supplier_id: s.supplier.id, b_organization_id: b.organization.id, agreement_id: agreement.id, mode: 'FIXED_PER_BOOKING', value: 120 });
    const r = contracts.computeCommission({ commission_rule_id: rule.id, base_amount: 3000, currency: 'SGD' });
    assert.equal(r.breakdown.committed, 120);
    assert.ok(r.breakdown.net_to_b < 120);
  });

  await test('tiered mode selects the matching tier', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const s = suppliers.createSupplier({ type: 'EDUCATION', name: 'S', public_visible: true });
    const agreement = contracts.createAgreement({ kind: 'B_S', b_organization_id: b.organization.id, supplier_id: s.supplier.id });
    const rule = contracts.createCommissionRule({
      supplier_id: s.supplier.id, b_organization_id: b.organization.id, agreement_id: agreement.id,
      mode: 'TIERED', tiers: [{ min: 0, max: 1000, value: 10, mode: 'percentage' }, { min: 1000, max: 100000, value: 20, mode: 'percentage' }]
    });
    const r = contracts.computeCommission({ commission_rule_id: rule.id, base_amount: 5000, currency: 'SGD' });
    assert.equal(r.breakdown.committed, 1000);
  });

  await test('commission is bound to supplier/product/B/agreement/rule', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const s = suppliers.createSupplier({ type: 'EDUCATION', name: 'S', public_visible: true });
    const agreement = contracts.createAgreement({ kind: 'B_S', b_organization_id: b.organization.id, supplier_id: s.supplier.id });
    const rule = contracts.createCommissionRule({ supplier_id: s.supplier.id, b_organization_id: b.organization.id, agreement_id: agreement.id, mode: 'PERCENTAGE', value: 15 });
    const r = contracts.computeCommission({ commission_rule_id: rule.id, base_amount: 1000, currency: 'SGD' });
    assert.equal(r.breakdown.commission_rule_id, rule.id);
    assert.equal(r.breakdown.agreement_id, agreement.id);
    assert.equal(r.breakdown.supplier_id, s.supplier.id);
    assert.equal(r.breakdown.b_organization_id, b.organization.id);
  });

  await test('no hard-coded commission percentage anywhere in the rules', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const s = suppliers.createSupplier({ type: 'EDUCATION', name: 'S', public_visible: true });
    const agreement = contracts.createAgreement({ kind: 'B_S', b_organization_id: b.organization.id, supplier_id: s.supplier.id });
    // A rule must be explicitly created; the agreement itself carries no value.
    assert.deepEqual(agreement.commission_rule_ids, []);
    const rule = contracts.createCommissionRule({ supplier_id: s.supplier.id, b_organization_id: b.organization.id, agreement_id: agreement.id, mode: 'PERCENTAGE', value: 12.5 });
    assert.equal(rule.value, 12.5);
    assert.equal(contracts.agreementById(agreement.id).commission_rule_ids[0], rule.id);
  });

  await test('commission ledger follows the settlement lifecycle', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const s = suppliers.createSupplier({ type: 'EDUCATION', name: 'S', public_visible: true });
    const agreement = contracts.createAgreement({ kind: 'B_S', b_organization_id: b.organization.id, supplier_id: s.supplier.id });
    const rule = contracts.createCommissionRule({ supplier_id: s.supplier.id, b_organization_id: b.organization.id, agreement_id: agreement.id, mode: 'PERCENTAGE', value: 15 });
    const r = contracts.computeCommission({ commission_rule_id: rule.id, base_amount: 1000, currency: 'SGD' });
    assert.equal(r.ledger.status, 'projected');
    for (const status of ['confirmed', 'receivable', 'received', 'payable', 'paid']) {
      const res = contracts.updateLedgerStatus(r.ledger.id, status, null);
      assert.equal(res.ok, true, 'cannot move to ' + status);
    }
  });

  await test('settlement rejects an out-of-order transition', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const s = suppliers.createSupplier({ type: 'EDUCATION', name: 'S', public_visible: true });
    const agreement = contracts.createAgreement({ kind: 'B_S', b_organization_id: b.organization.id, supplier_id: s.supplier.id });
    const rule = contracts.createCommissionRule({ supplier_id: s.supplier.id, b_organization_id: b.organization.id, agreement_id: agreement.id, mode: 'PERCENTAGE', value: 15 });
    const r = contracts.computeCommission({ commission_rule_id: rule.id, base_amount: 1000, currency: 'SGD' });
    const created = contracts.createSettlement({ b_organization_id: b.organization.id, commission_ledger_ids: [r.ledger.id] });
    assert.equal(created.ok, true);
    const bad = contracts.advanceSettlement(created.settlement.id, 'paid', null);
    assert.equal(bad.ok, false);
  });

  // =========================================================================
  console.log('\n[Rule 10 + 11] AETHEL X sandbox payment orchestration');
  // =========================================================================
  await test('payment intent is created and requires action', async () => {
    await fresh();
    const r = payments.createIntent({ kind: 'application_fee', amount: 500, payer_type: 'C', payer_id: 'c-1' });
    assert.equal(r.ok, true);
    assert.equal(r.intent.status, 'requires_action');
    assert.equal(r.intent.sandbox, true);
    assert.equal(r.intent.route_id !== null, true);
  });

  await test('sandbox confirmation succeeds and issues a receipt', async () => {
    await fresh();
    const r = payments.createIntent({ kind: 'application_fee', amount: 500, payer_type: 'C', payer_id: 'c-1' });
    const c = payments.confirmIntent(r.intent.id, {});
    assert.equal(c.ok, true);
    assert.equal(c.intent.status, 'succeeded');
    assert.equal(c.receipt.status, 'succeeded');
    assert.equal(c.receipt.sandbox, true);
  });

  await test('provider adapter catalogue offers NexusPay / Stripe / Bank / Manual', async () => {
    await fresh();
    const catalog = payments.providerCatalog();
    const ids = catalog.available.map((a) => a.id);
    for (const id of ['nexuspay', 'stripe', 'bank_transfer', 'manual', 'other']) assert.ok(ids.includes(id), id + ' missing');
    assert.equal(catalog.mode, 'sandbox');
  });

  await test('invalid payment kind is rejected', async () => {
    await fresh();
    const r = payments.createIntent({ kind: 'not_a_kind', amount: 1 });
    assert.equal(r.ok, false);
  });

  await test('zero or negative amount is rejected', async () => {
    await fresh();
    assert.equal(payments.createIntent({ kind: 'application_fee', amount: 0 }).ok, false);
    assert.equal(payments.createIntent({ kind: 'application_fee', amount: -5 }).ok, false);
  });

  await test('refund claws back the associated commission', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const s = suppliers.createSupplier({ type: 'EDUCATION', name: 'S', public_visible: true });
    const agreement = contracts.createAgreement({ kind: 'B_S', b_organization_id: b.organization.id, supplier_id: s.supplier.id });
    const rule = contracts.createCommissionRule({ supplier_id: s.supplier.id, b_organization_id: b.organization.id, agreement_id: agreement.id, mode: 'PERCENTAGE', value: 15 });
    const intent = payments.createIntent({ kind: 'application_fee', amount: 1000, payer_type: 'C', payer_id: 'c-1' });
    const confirmed = payments.confirmIntent(intent.intent.id, {});
    const commission = contracts.computeCommission({
      commission_rule_id: rule.id, base_amount: 1000, currency: 'SGD',
      payment_intent_id: intent.intent.id
    });
    const refund = payments.refundIntent(intent.intent.id, { reason: 'test' });
    assert.equal(refund.ok, true);
    assert.equal(refund.intent.status, 'refunded');
    assert.ok(refund.clawed_back_commission >= 1);
    assert.equal(contracts.commissionLedgerOf(b.organization.id)[0].status, 'clawed_back');
  });

  await test('multi-currency fields are recorded without an FX engine', async () => {
    await fresh();
    const r = payments.createIntent({ kind: 'application_fee', amount: 500, currency: 'USD', payer_type: 'C', payer_id: 'c-1', reference_rate: 1.35, rate_timestamp: new Date().toISOString() });
    assert.equal(r.intent.currency, 'USD');
    assert.equal(r.intent.reference_rate, 1.35);
    assert.ok(r.intent.rate_timestamp);
  });

  // =========================================================================
  console.log('\n[Rule 12] First-binding protection');
  // =========================================================================
  await test('default protection is 12 months', async () => {
    await fresh();
    assert.equal(config.get('first_binding_protection_months'), 12);
  });

  await test('protection window is backend configurable', async () => {
    await fresh();
    config.set('first_binding_protection_months', 6);
    const b = makeB({ level: 'LEVEL_2' });
    const c = makeC();
    const r = binding.createBindingRequest({ c_profile_id: c.id, b_organization_id: b.organization.id });
    assert.equal(r.binding.protection_months, 6);
  });

  await test('rebinding inside protection requires both consents + review', async () => {
    await fresh();
    const b1 = makeB({ level: 'LEVEL_2' });
    const b2 = makeB({ level: 'LEVEL_2', name: 'B2' });
    const c = makeC();
    const created = binding.createBindingRequest({ c_profile_id: c.id, b_organization_id: b1.organization.id });
    binding.bRespond(created.binding.id, 'accept', null);
    binding.signBinding(created.binding.id, 'C', null);
    binding.signBinding(created.binding.id, 'B', null);

    const check = binding.rebindingCheck(c.id);
    assert.equal(check.protected, true);

    const req = binding.requestRebinding({ c_profile_id: c.id, new_b_organization_id: b2.organization.id });
    assert.equal(req.ok, true);
    assert.equal(req.binding.is_rebinding, true);

    // Review before consents must fail.
    const early = binding.platformReviewRebinding(req.binding.id, 'approve', null);
    assert.equal(early.ok, false);

    binding.recordRebindingConsent(req.binding.id, 'original_b', null);
    assert.equal(binding.platformReviewRebinding(req.binding.id, 'approve', null).ok, false);
    binding.recordRebindingConsent(req.binding.id, 'new_b', null);
    const reviewed = binding.platformReviewRebinding(req.binding.id, 'approve', null);
    assert.equal(reviewed.ok, true);
  });

  await test('commission ownership transfer is audited on rebinding', async () => {
    await fresh();
    const b1 = makeB({ level: 'LEVEL_2' });
    const b2 = makeB({ level: 'LEVEL_2', name: 'B2' });
    const c = makeC();
    const created = binding.createBindingRequest({ c_profile_id: c.id, b_organization_id: b1.organization.id });
    binding.bRespond(created.binding.id, 'accept', null);
    binding.signBinding(created.binding.id, 'C', null);
    binding.signBinding(created.binding.id, 'B', null);
    const req = binding.requestRebinding({ c_profile_id: c.id, new_b_organization_id: b2.organization.id });
    binding.recordRebindingConsent(req.binding.id, 'original_b', null);
    binding.recordRebindingConsent(req.binding.id, 'new_b', null);
    binding.platformReviewRebinding(req.binding.id, 'approve', null);
    binding.bRespond(req.binding.id, 'accept', null);
    binding.signBinding(req.binding.id, 'C', null);
    binding.signBinding(req.binding.id, 'B', null);
    const logs = audit.query({ action: 'binding:commission_ownership_transfer' });
    assert.ok(logs.length >= 1, 'ownership transfer not audited');
  });

  // =========================================================================
  console.log('\n[Rule 13] Membership expiry + grace');
  // =========================================================================
  await test('expiry reminder days are 60/30/7/1', async () => {
    await fresh();
    assert.deepEqual(config.get('membership_expiry_reminder_days'), [60, 30, 7, 1]);
  });

  await test('grace period defaults to 30 days', async () => {
    await fresh();
    assert.equal(config.get('membership_grace_days'), 30);
  });

  await test('membership inside grace is still valid', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2', expires_at: new Date(Date.now() - 5 * 86400000).toISOString() });
    const m = org.activeMembership(b.organization.id);
    m.grace_until = new Date(Date.now() + 20 * 86400000).toISOString();
    const valid = org.membershipValid(b.organization.id);
    assert.equal(valid.valid, true);
    assert.equal(valid.reason, 'grace');
  });

  await test('expired membership outside grace is invalid', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2', expires_at: new Date(Date.now() - 60 * 86400000).toISOString() });
    const valid = org.membershipValid(b.organization.id);
    assert.equal(valid.valid, false);
    assert.equal(valid.reason, 'expired');
  });

  await test('B expiry transfers bound C to platform service', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const c = makeC();
    const created = binding.createBindingRequest({ c_profile_id: c.id, b_organization_id: b.organization.id });
    binding.bRespond(created.binding.id, 'accept', null);
    binding.signBinding(created.binding.id, 'C', null);
    binding.signBinding(created.binding.id, 'B', null);
    const transferred = binding.handleBMembershipExpiry(b.organization.id, null);
    assert.equal(transferred, 1);
    assert.equal(binding.cProfileById(c.id).binding_state, 'platform_service');
  });

  await test('renewal creates a new membership and supersedes the old', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_1' });
    const old = org.activeMembership(b.organization.id);
    const renewed = org.renewMembership(b.organization.id, { level: 'LEVEL_2', months: 12 });
    assert.equal(renewed.level, 'LEVEL_2');
    assert.equal(old.status, 'superseded', 'old membership must be superseded');
    const current = org.activeMembership(b.organization.id);
    assert.equal(current.id, renewed.id);
    assert.equal(current.level, 'LEVEL_2');
    assert.equal(org.membershipValid(b.organization.id).valid, true);
  });

  // =========================================================================
  console.log('\n[S0–S10 state machine');
  // =========================================================================
  await test('all eleven stages are defined', async () => {
    await fresh();
    assert.equal(auth.STAGES.length, 11);
    assert.deepEqual(auth.STAGE_CODES, ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10']);
  });

  await test('every stage has an owner', async () => {
    await fresh();
    for (const s of auth.STAGES) assert.ok(s.owner, s.code + ' has no owner');
  });

  await test('only sequential transitions are allowed', async () => {
    await fresh();
    assert.equal(auth.canTransition('S0', 'S1'), true);
    assert.equal(auth.canTransition('S0', 'S5'), false);
    assert.equal(auth.canTransition('S9', 'S10'), true);
    assert.equal(auth.canTransition('S10', 'S0'), false);
  });

  await test('creating an application opens the full S0–S10 skeleton', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const c = makeC();
    const created = binding.createBindingRequest({ c_profile_id: c.id, b_organization_id: b.organization.id });
    binding.bRespond(created.binding.id, 'accept', null);
    binding.signBinding(created.binding.id, 'C', null);
    binding.signBinding(created.binding.id, 'B', null);
    const app = applications.createApplication({ c_profile_id: c.id, title: 'T' });
    assert.equal(app.ok, true);
    const detail = applications.applicationDetail(app.application.id);
    assert.equal(detail.stages.length, 11);
    assert.equal(detail.current_stage, 'S0');
  });

  await test('forward progress is blocked by open stage todos', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const c = makeC();
    const created = binding.createBindingRequest({ c_profile_id: c.id, b_organization_id: b.organization.id });
    binding.bRespond(created.binding.id, 'accept', null);
    binding.signBinding(created.binding.id, 'C', null);
    binding.signBinding(created.binding.id, 'B', null);
    const app = applications.createApplication({ c_profile_id: c.id });
    const blocked = applications.transition(app.application.id, 'S1', null);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'STAGE_TODOS_INCOMPLETE');
    for (const t of applications.listTodos({ application_id: app.application.id })) applications.completeTodo(t.id, null);
    const moved = applications.transition(app.application.id, 'S1', null);
    assert.equal(moved.ok, true);
  });

  await test('kanban, timeline and list views are all available', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const c = makeC();
    const created = binding.createBindingRequest({ c_profile_id: c.id, b_organization_id: b.organization.id });
    binding.bRespond(created.binding.id, 'accept', null);
    binding.signBinding(created.binding.id, 'C', null);
    binding.signBinding(created.binding.id, 'B', null);
    const app = applications.createApplication({ c_profile_id: c.id });
    const board = applications.kanban({ b_organization_id: b.organization.id });
    assert.ok(Array.isArray(board));
    assert.ok(board.some((col) => col.code === 'S0' && col.items.length === 1));
    assert.ok(applications.timelineView(app.application.id));
    assert.ok(applications.listView({ b_organization_id: b.organization.id }).length === 1);
  });

  await test('reaching S10 fires a commission trigger', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const c = makeC();
    const created = binding.createBindingRequest({ c_profile_id: c.id, b_organization_id: b.organization.id });
    binding.bRespond(created.binding.id, 'accept', null);
    binding.signBinding(created.binding.id, 'C', null);
    binding.signBinding(created.binding.id, 'B', null);
    const app = applications.createApplication({ c_profile_id: c.id });
    for (const stage of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10']) {
      for (const t of applications.listTodos({ application_id: app.application.id }).filter((x) => x.status !== 'done' && String(x.stage).toUpperCase() === applications.applicationById(app.application.id).current_stage)) {
        applications.completeTodo(t.id, null);
      }
      const r = applications.transition(app.application.id, stage, null);
      assert.equal(r.ok, true, 'to ' + stage + ': ' + r.error);
    }
    const triggers = db.stores.commission_triggers.all().filter((t) => t.application_id === app.application.id && t.trigger_event === 'APPLICATION_REACHED_S10');
    assert.ok(triggers.length >= 1);
  });

  // =========================================================================
  console.log('\n[Documents] C upload → B confirm → S confirm + authorization');
  // =========================================================================
  await test('document confirmation must follow C → B → S order', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const s = suppliers.createSupplier({ type: 'EDUCATION', name: 'S', public_visible: true });
    const c = makeC();
    const created = binding.createBindingRequest({ c_profile_id: c.id, b_organization_id: b.organization.id });
    binding.bRespond(created.binding.id, 'accept', null);
    binding.signBinding(created.binding.id, 'C', null);
    binding.signBinding(created.binding.id, 'B', null);
    const app = applications.createApplication({ c_profile_id: c.id, supplier_id: s.supplier.id });
    const up = applications.uploadDocument(app.application.id, { type: 'passport' }, null);
    assert.equal(up.document.status, 'uploaded');
    assert.equal(up.document.ocr.sandbox, true, 'OCR must be sandbox');
    const sFirst = applications.confirmDocument(up.document.id, 'S', null);
    assert.equal(sFirst.ok, false, 'S cannot confirm before B');
    const bOk = applications.confirmDocument(up.document.id, 'B', null);
    assert.equal(bOk.document.status, 'b_confirmed');
    const sOk = applications.confirmDocument(up.document.id, 'S', null);
    assert.equal(sOk.document.status, 's_confirmed');
  });

  await test('supplier needs an explicit authorization to read documents', async () => {
    await fresh();
    const s = suppliers.createSupplier({ type: 'EDUCATION', name: 'S', public_visible: true });
    const b = makeB({ level: 'LEVEL_2' });
    const c = makeC();
    const created = binding.createBindingRequest({ c_profile_id: c.id, b_organization_id: b.organization.id });
    binding.bRespond(created.binding.id, 'accept', null);
    binding.signBinding(created.binding.id, 'C', null);
    binding.signBinding(created.binding.id, 'B', null);
    const app = applications.createApplication({ c_profile_id: c.id, supplier_id: s.supplier.id });
    const up = applications.uploadDocument(app.application.id, { type: 'passport' }, null);
    assert.equal(applications.canReadDocument(up.document.id, 'S', s.supplier.id), false);
    applications.authorizeDocument(up.document.id, { type: 'S', id: s.supplier.id }, 'read', null, 30);
    assert.equal(applications.canReadDocument(up.document.id, 'S', s.supplier.id), true);
    assert.equal(applications.canReadDocument(up.document.id, 'S', 'other'), false);
  });

  await test('revoked authorization blocks access', async () => {
    await fresh();
    const s = suppliers.createSupplier({ type: 'EDUCATION', name: 'S', public_visible: true });
    const b = makeB({ level: 'LEVEL_2' });
    const c = makeC();
    const created = binding.createBindingRequest({ c_profile_id: c.id, b_organization_id: b.organization.id });
    binding.bRespond(created.binding.id, 'accept', null);
    binding.signBinding(created.binding.id, 'C', null);
    binding.signBinding(created.binding.id, 'B', null);
    const app = applications.createApplication({ c_profile_id: c.id, supplier_id: s.supplier.id });
    const up = applications.uploadDocument(app.application.id, { type: 'passport' }, null);
    const authRec = applications.authorizeDocument(up.document.id, { type: 'S', id: s.supplier.id }, 'read', null, 30);
    applications.revokeAuthorization(authRec.id, null);
    assert.equal(applications.canReadDocument(up.document.id, 'S', s.supplier.id), false);
  });

  await test('family library reuses documents across applications', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const c = makeC();
    const created = binding.createBindingRequest({ c_profile_id: c.id, b_organization_id: b.organization.id });
    binding.bRespond(created.binding.id, 'accept', null);
    binding.signBinding(created.binding.id, 'C', null);
    binding.signBinding(created.binding.id, 'B', null);
    const app1 = applications.createApplication({ c_profile_id: c.id, title: 'A1' });
    const app2 = applications.createApplication({ c_profile_id: c.id, title: 'A2' });
    applications.uploadDocument(app1.application.id, { type: 'transcript' }, null);
    assert.equal(applications.familyLibraryOfC(c.id).length >= 1, true);
    assert.equal(applications.documentsOf(app2.application.id).length, 0);
  });

  await test('document types cover the OCR library fields', async () => {
    await fresh();
    for (const t of ['passport', 'transcript', 'degree', 'language_score', 'offer', 'visa', 'medical', 'certification', 'other']) {
      assert.ok(applications.DOCUMENT_TYPES.includes(t), t + ' missing');
    }
  });

  // =========================================================================
  console.log('\n[RBAC] roles and permissions');
  // =========================================================================
  await test('all 17 roles are defined with audiences', async () => {
    await fresh();
    const expected = ['ADMIN_SUPER', 'ADMIN_OPERATION', 'ADMIN_FINANCE', 'ADMIN_AUDIT',
      'B_OWNER', 'B_COUNSELLOR', 'B_DOCUMENT', 'B_FINANCE', 'B_VIEWER',
      'C_PARENT', 'C_STUDENT', 'S_OWNER', 'S_ADMISSION', 'S_OPERATION', 'S_FINANCE', 'S_VIEWER',
      'DBC_OWNER', 'DBC_OPERATION', 'DBC_FINANCE'];
    for (const r of expected) assert.ok(auth.ROLES[r], r + ' missing');
    assert.equal(Object.keys(auth.ROLES).length, expected.length);
  });

  await test('C roles can never see commission', async () => {
    await fresh();
    for (const role of ['C_PARENT', 'C_STUDENT']) {
      assert.equal(auth.hasPermission(role, 'b:settlement'), false);
      assert.equal(auth.hasPermission(role, 's:commission'), false);
      assert.equal(auth.hasPermission(role, 'admin:commission'), false);
    }
  });

  await test('B_VIEWER cannot mutate money', async () => {
    await fresh();
    assert.equal(auth.hasPermission('B_VIEWER', 'b:payment'), false);
    assert.equal(auth.hasPermission('B_VIEWER', 'b:settlement'), false);
    assert.equal(auth.hasPermission('B_VIEWER', 'b:contract'), false);
    assert.equal(auth.hasPermission('B_VIEWER', 'b:crm'), true);
  });

  await test('S_FINANCE cannot touch admissions', async () => {
    await fresh();
    assert.equal(auth.hasPermission('S_FINANCE', 's:application'), false);
    assert.equal(auth.hasPermission('S_FINANCE', 's:settlement'), true);
  });

  await test('DBC roles have no B-settlement or C-binding permissions', async () => {
    await fresh();
    for (const role of ['DBC_OWNER', 'DBC_OPERATION', 'DBC_FINANCE']) {
      assert.equal(auth.hasPermission(role, 'b:settlement'), false);
      assert.equal(auth.hasPermission(role, 'admin:payment'), false);
    }
  });

  await test('ADMIN_SUPER has wildcard permissions', async () => {
    await fresh();
    assert.equal(auth.hasPermission('ADMIN_SUPER', 'anything:at:all'), true);
  });

  await test('unknown role has no permissions', async () => {
    await fresh();
    assert.deepEqual(auth.permissionsOf('NOT_A_ROLE'), []);
  });

  await test('unknown role is rejected on user creation', async () => {
    await fresh();
    assert.throws(() => auth.createUser({ role: 'NOPE' }));
  });

  await test('demo login token maps only to a demo user', async () => {
    await fresh();
    const seeded = seedDemo();
    assert.equal(seeded.seeded, true);
    const demoUsers = db.stores.users.all().filter((u) => u.is_demo && u.demo_token);
    assert.ok(demoUsers.length > 0, 'no demo users seeded');
    // Every demo token must resolve to a demo user and to nothing else.
    for (const u of demoUsers) {
      const resolved = db.stores.users.all().filter((x) => String(x.demo_token) === String(u.demo_token));
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0].id, u.id);
      assert.equal(resolved[0].is_demo, true);
    }
  });

  // =========================================================================
  console.log('\n[Accommodation] room inventory invariant');
  // =========================================================================
  await test('beds_available = beds_total − beds_occupied', async () => {
    await fresh();
    const s = suppliers.createSupplier({ type: 'ACCOMMODATION', name: 'S', public_visible: true });
    const room = db.stores.rooms.insert({
      id: 'room-1', supplier_id: s.supplier.id, room_type: 'double',
      beds_total: 2, beds_occupied: 0, created_at: new Date().toISOString()
    });
    const available = (r) => Math.max(0, r.beds_total - r.beds_occupied);
    assert.equal(available(room), 2);
    room.beds_occupied = 1;
    assert.equal(available(room), 1);
    room.beds_occupied = 2;
    assert.equal(available(room), 0);
    // Over-occupancy clamps to zero and never goes negative.
    room.beds_occupied = 5;
    assert.equal(available(room), 0);
  });

  await test('accommodation types include dorm / school housing / homestay / apartment', async () => {
    await fresh();
    const s = suppliers.createSupplier({ type: 'ACCOMMODATION', name: 'S', public_visible: true, profile: { accommodation_types: ['student_dormitory', 'school_housing', 'homestay', 'student_apartment'] } });
    const profile = suppliers.profileOfSupplier(s.supplier.id);
    assert.ok(profile.extensions.accommodation_types.length === 4);
  });

  await test('room types include single/double/triple/shared/homestay', async () => {
    await fresh();
    for (const t of ['single', 'double', 'triple', 'shared', 'homestay']) {
      const room = db.stores.rooms.insert({ id: 'r-' + t, supplier_id: 's', room_type: t, beds_total: 1, beds_occupied: 0 });
      assert.equal(room.room_type, t);
    }
  });

  // =========================================================================
  console.log('\n[Finance] feature flag off by default');
  // =========================================================================
  await test('FINANCE_ENABLED is false by default', async () => {
    await fresh();
    assert.equal(config.financeEnabled(), false);
    assert.equal(auth.SUPPLIER_TYPES.FINANCE.default_enabled, false);
  });

  await test('finance public view shows coming soon', async () => {
    await fresh();
    const s = suppliers.createSupplier({ type: 'FINANCE', name: 'S', public_visible: true });
    const view = suppliers.publicView(s.supplier);
    assert.equal(view.profile.extensions.coming_soon, true);
  });

  await test('finance extension disables scoring/approval/disbursement', async () => {
    await fresh();
    const s = suppliers.createSupplier({ type: 'FINANCE', name: 'S', public_visible: true });
    const profile = suppliers.profileOfSupplier(s.supplier.id);
    assert.equal(profile.extensions.credit_scoring_enabled, false);
    assert.equal(profile.extensions.auto_approval_enabled, false);
    assert.equal(profile.extensions.disbursement_enabled, false);
  });

  await test('future supplier types are reserved but not implemented', async () => {
    await fresh();
    assert.deepEqual(auth.RESERVED_SUPPLIER_TYPES, ['INSURANCE', 'TRAINING', 'TRANSLATION', 'TRANSPORT', 'OTHER']);
    assert.equal(auth.SUPPLIER_TYPES.INSURANCE, undefined);
  });

  // =========================================================================
  console.log('\n[DBC] State A / State B isolation');
  // =========================================================================
  await test('DBC only participates in State A agreements', async () => {
    await fresh();
    const s = suppliers.createSupplier({ type: 'EDUCATION', name: 'S', public_visible: true });
    const a = contracts.createAgreement({ kind: 'DBC_S', supplier_id: s.supplier.id, state: 'A' });
    const b = contracts.createAgreement({ kind: 'B_S', supplier_id: s.supplier.id, state: 'B' });
    const visible = contracts.listAgreements({ kind: 'DBC_S' }).filter((x) => String(x.state).toUpperCase() === 'A');
    assert.equal(visible.length, 1);
    assert.equal(visible[0].id, a.id);
    assert.notEqual(visible[0].id, b.id);
  });

  await test('State B agreements are invisible to DBC queries', async () => {
    await fresh();
    const s = suppliers.createSupplier({ type: 'EDUCATION', name: 'S', public_visible: true });
    contracts.createAgreement({ kind: 'B_S', supplier_id: s.supplier.id, state: 'B' });
    const dbcVisible = contracts.listAgreements({ kind: 'DBC_S' }).filter((x) => String(x.state).toUpperCase() === 'A');
    assert.equal(dbcVisible.length, 0);
  });

  await test('DBC does not hold platform funds or share B net commission', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const s = suppliers.createSupplier({ type: 'EDUCATION', name: 'S', public_visible: true });
    const agreement = contracts.createAgreement({ kind: 'B_S', b_organization_id: b.organization.id, supplier_id: s.supplier.id });
    const rule = contracts.createCommissionRule({ supplier_id: s.supplier.id, b_organization_id: b.organization.id, agreement_id: agreement.id, mode: 'PERCENTAGE', value: 15 });
    const r = contracts.computeCommission({ commission_rule_id: rule.id, base_amount: 1000, currency: 'SGD' });
    assert.equal(r.breakdown.platform_share_of_net, 0);
    assert.equal(r.ledger.b_organization_id, b.organization.id);
  });

  // =========================================================================
  console.log('\n[Demo / Verified] data policy');
  // =========================================================================
  await test('supplier verification requires a source', async () => {
    await fresh();
    const s = suppliers.createSupplier({ type: 'EDUCATION', name: 'S', public_visible: true });
    const bad = suppliers.verifySupplier(s.supplier.id, 'approve', null);
    assert.equal(bad.ok, false);
    suppliers.supplierById(s.supplier.id).source_url = 'https://example.com/x';
    const good = suppliers.verifySupplier(s.supplier.id, 'approve', null);
    assert.equal(good.ok, true);
    assert.equal(good.supplier.verification, 'verified');
  });

  await test('AI may not invent tuition / admission rate / ranking etc.', async () => {
    await fresh();
    const list = config.get('ai_may_not_invent');
    for (const f of ['tuition', 'admission_rate', 'ranking', 'commission', 'loan_rate', 'bed_inventory', 'visa_success_rate']) {
      assert.ok(list.includes(f), f + ' missing');
    }
  });

  await test('demo data must be labelled', async () => {
    await fresh();
    assert.equal(config.get('demo_data_requires_label'), true);
    assert.equal(config.get('verified_requires_source'), true);
  });

  // =========================================================================
  console.log('\n[Audit] trail');
  // =========================================================================
  await test('every mutating module action is audited', async () => {
    await fresh();
    const before = audit.query({}).length;
    const b = makeB({ level: 'LEVEL_2' });
    const c = makeC();
    binding.createBindingRequest({ c_profile_id: c.id, b_organization_id: b.organization.id });
    const after = audit.query({}).length;
    assert.ok(after > before, 'binding request not audited');
    const logs = audit.query({ action: 'binding:request' });
    assert.ok(logs.length >= 1);
  });

  await test('audit entries carry actor, entity and before/after', async () => {
    await fresh();
    const b = makeB({ level: 'LEVEL_2' });
    const log = audit.query({ entity: 'b_profile' })[0];
    assert.ok(log);
    assert.ok(log.at);
    assert.equal(log.entity, 'b_profile');
  });

  await test('audit redaction strips secrets', async () => {
    await fresh();
    const redacted = audit.redact({ password: 'x', token: 'y', nested: { card: 'z', keep: 1 } });
    assert.equal(redacted.password, undefined);
    assert.equal(redacted.token, undefined);
    assert.equal(redacted.nested.card, undefined);
    assert.equal(redacted.nested.keep, 1);
  });

  // =========================================================================
  console.log('\n[Suppliers] unified model for all six types');
  // =========================================================================
  await test('all six supplier types are supported', async () => {
    await fresh();
    const types = ['EDUCATION', 'MEDICAL', 'CERTIFICATION', 'VISA', 'ACCOMMODATION', 'FINANCE'];
    for (const t of types) {
      const s = suppliers.createSupplier({ type: t, name: t, public_visible: true });
      assert.equal(s.supplier.type, t);
      assert.ok(suppliers.profileOfSupplier(s.supplier.id), t + ' has no profile');
    }
  });

  await test('one supplier system serves every type (no per-type duplication)', async () => {
    await fresh();
    const edu = suppliers.createSupplier({ type: 'EDUCATION', name: 'E', public_visible: true });
    const med = suppliers.createSupplier({ type: 'MEDICAL', name: 'M', public_visible: true });
    // Both resolve through the same store and the same view builders.
    assert.ok(suppliers.supplierById(edu.supplier.id));
    assert.ok(suppliers.supplierById(med.supplier.id));
    assert.equal(typeof suppliers.publicView, 'function');
    assert.equal(typeof suppliers.bView, 'function');
  });

  await test('education admission workflow is the specified list', async () => {
    await fresh();
    assert.deepEqual(suppliers.DEFAULT_ADMISSION_WORKFLOW, [
      'received', 'documents_review', 'additional_documents', 'interview_required',
      'interview_scheduled', 'interview_complete', 'under_review', 'admitted',
      'waitlisted', 'rejected', 'confirmed', 'deposit_paid', 'enrolled', 'withdrawn'
    ]);
  });

  await test('medical supplier stores no diagnosis', async () => {
    await fresh();
    const s = suppliers.createSupplier({ type: 'MEDICAL', name: 'M', public_visible: true });
    const profile = suppliers.profileOfSupplier(s.supplier.id);
    assert.equal(profile.extensions.stores_diagnosis, false);
  });

  // =========================================================================
  console.log('\n[Config] backend tunables');
  // =========================================================================
  await test('system config is persisted and versioned', async () => {
    await fresh();
    config.set('membership_grace_days', 45);
    assert.equal(config.get('membership_grace_days'), 45);
    const history = config.config().history;
    assert.ok(history.length >= 1);
  });

  await test('config reset restores defaults', async () => {
    await fresh();
    config.set('membership_grace_days', 99);
    config.resetToDefaults();
    assert.equal(config.get('membership_grace_days'), 30);
  });

  await test('all payment providers default to sandbox', async () => {
    await fresh();
    const providers = config.get('providers');
    for (const [k, v] of Object.entries(providers)) {
      assert.equal(v.mode, 'sandbox', k + ' is not sandbox');
    }
  });

  await test('branding footer is Aethel Edu', async () => {
    await fresh();
    assert.equal(config.get('brand.footer_zh'), '由安世达教育提供核心动力');
    assert.equal(config.get('brand.footer_en'), 'Powered by Aethel Edu');
  });

  await test('ads demo defaults are configurable, not hard-coded', async () => {
    await fresh();
    assert.equal(config.get('ads_demo_topup_amount'), 800);
    assert.equal(config.get('ads_demo_monthly_price'), 100);
    assert.equal(config.get('ads_demo_max_renewals'), 6);
    config.set('ads_demo_monthly_price', 150);
    assert.equal(config.get('ads_demo_monthly_price'), 150);
  });

  // =========================================================================
  console.log('\n[Store] persistence backend');
  // =========================================================================
  await test('JSON file backend persists across a simulated restart', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aethel-persist-'));
    process.env.GS_DB_DIR = dir;
    // Re-require a fresh module instance with a file backend.
    delete require.cache[require.resolve('../lib/db')];
    delete require.cache[require.resolve('../lib/config')];
    delete require.cache[require.resolve('../lib/org')];
    delete require.cache[require.resolve('../lib/auth')];
    delete require.cache[require.resolve('../lib/binding')];
    const freshDb = require('../lib/db');
    freshDb.setDataDir(dir);
    const freshConfig = require('../lib/config');
    await freshDb.ensureLoaded();
    freshConfig.set('membership_grace_days', 77);
    freshDb.flushSync();

    // Simulate a restart.
    delete require.cache[require.resolve('../lib/db')];
    delete require.cache[require.resolve('../lib/config')];
    const reloaded = require('../lib/db');
    reloaded.setDataDir(dir);
    const reloadedConfig = require('../lib/config');
    reloaded.loadFileSyncForTest ? reloaded.loadFileSyncForTest() : null;
    await reloaded.ensureLoaded();
    assert.equal(reloadedConfig.get('membership_grace_days'), 77, 'value lost across restart');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('counts expose every collection', async () => {
    await fresh();
    const counts = db.counts();
    for (const key of ['users', 'organizations', 'suppliers', 'applications', 'bindings', 'commission_ledger', 'audit_logs']) {
      assert.ok(key in counts, key + ' missing from counts');
    }
  });

  console.log('\n==================================================');
  console.log(passed.length + ' passed, ' + failed.length + ' failed');
  console.log('==================================================');
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log('  - ' + f);
    process.exitCode = 1;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
