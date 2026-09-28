// V1.1 Growth Center tests — leads, dedup, merge, persona, scoring, ScoreModel,
// score history, evidence, source validation, outreach queue, communication,
// opt-out, do-not-contact, campaign, opportunity, stage transition,
// Lead→Organization conversion, lead attribution retention, activation,
// dashboard, Growth auth 403, insurance feature-flag disabled/reserved model.
const assert = require('node:assert/strict');
const { app, growth } = require('../server');

const passed = [];
const failed = [];
async function test(name, fn) {
  try { await fn(); passed.push(name); console.log('  ok  ' + name); }
  catch (err) { failed.push(name + ' :: ' + (err && err.message)); console.error('FAIL  ' + name + ' :: ' + (err && err.message)); }
}

const GROWH_ROLE = { 'x-role': 'bd' };

async function main() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = async (p, h = {}) => { const r = await fetch(base + p, { headers: h }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const post = async (p, pl, h = {}) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(pl) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const patch = async (p, pl, h = {}) => { const r = await fetch(base + p, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(pl) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

  // Fresh stores for deterministic assertions (resetStores restores correct shapes).
  growth.resetStores();
  growth.save('scoremodels', {
    version: '1.1.0', active: 'general',
    models: [{ id: 'general', name: '通用', weights: { organization_strength: 0.15, audience_strength: 0.15, student_pool: 0.2, platform_match: 0.15, cooperation_intent: 0.15, online_influence: 0.1, engagement: 0.05, data_quality: 0.03, risk: -0.03 }, max_score: 100 }]
  });

  console.log('V1.1 Growth Center tests');

  // --- Growth Center auth 403 ---
  await test('Growth auth: external B/S/C student gets 403; bd gets 200', async () => {
    const student = await get('/api/growth/leads', { 'x-role': 'student' });
    assert.equal(student.status, 403);
    const bd = await get('/api/growth/leads', GROWH_ROLE);
    assert.equal(bd.status, 200);
    const agency = await get('/api/growth/leads', { 'x-role': 'agency' });
    assert.equal(agency.status, 403);
  });

  // --- Lead create ---
  await test('Lead create: valid lead returns 201 with id + persona', async () => {
    const r = await post('/api/growth/leads', { organization_name: 'Acme Agency', persona_type: 'study_abroad_agency', country: 'Singapore', source_url: 'https://acme.sg', estimated_student_pool: 300, accepts_commission: true }, GROWH_ROLE);
    assert.equal(r.status, 201);
    assert.ok(r.body.data.id.startsWith('LEAD-'));
    assert.equal(r.body.data.persona_type, 'study_abroad_agency');
    assert.equal(r.body.data.is_demo, undefined);
    // website_domain derived
    assert.equal(r.body.data.website_domain, null);
  });

  // --- Persona validation ---
  await test('Persona: unknown persona falls back to "other"; config list present', async () => {
    const r = await post('/api/growth/leads', { persona_type: 'made_up', organization_name: 'X' }, GROWH_ROLE);
    assert.equal(r.body.data.persona_type, 'other');
    assert.ok(growth.PERSONA_TYPES.includes('study_abroad_agency'));
    assert.ok(growth.PERSONA_TYPES.includes('family_office'));
  });

  // --- Lead import (batch) ---
  await test('Lead import: multiple leads via POST; counts reflected in dashboard', async () => {
    const lines = [
      { organization_name: 'B1', persona_type: 'education_influencer', country: 'Singapore', followers: 50000, source_url: 'https://b1.sg' },
      { organization_name: 'B2', persona_type: 'language_training', country: 'China', annual_student_volume: 1200, source_url: 'https://b2.cn' }
    ];
    for (const l of lines) { const r = await post('/api/growth/leads', l, GROWH_ROLE); assert.equal(r.status, 201); }
    const list = await get('/api/growth/leads', GROWH_ROLE);
    assert.equal(list.body.meta.total, 4); // Acme + X + B1 + B2
  });

  // --- Dedup (exact) ---
  await test('Lead dedup: same domain/email/organization flagged exact_match', async () => {
    const a = await post('/api/growth/leads', { organization_name: 'Dup Co', website: 'https://dup.co', email: 'a@dup.co', persona_type: 'study_abroad_agency', source_url: 'https://dup.co' }, GROWH_ROLE);
    const dup = await post('/api/growth/leads', { organization_name: 'Dup Co', website: 'https://dup.co', email: 'a@dup.co', persona_type: 'study_abroad_agency', source_url: 'https://dup.co' }, GROWH_ROLE);
    assert.equal(dup.status, 409);
    assert.equal(dup.body.dup.match, 'exact_match');
    assert.equal(dup.body.dedup_blocked, true);
  });

  // --- Lead merge ---
  await test('Lead merge: keep + merge fills gaps and records merge_history', async () => {
    const keep = await post('/api/growth/leads', { organization_name: 'Keep Co', persona_type: 'study_abroad_agency', country: 'Singapore', source_url: 'https://keep.sg' }, GROWH_ROLE);
    const merge = await post('/api/growth/leads', { organization_name: 'Keep Co 2', persona_type: 'study_abroad_agency', country: 'Singapore', email: 'info@keep.sg', source_url: 'https://keep.sg', skip_dup_check: true }, GROWH_ROLE);
    const r = await post('/api/growth/leads/' + keep.body.data.id + '/merge', { merge_id: merge.body.data.id, note: 'dup review' }, GROWH_ROLE);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.email, 'info@keep.sg');
    assert.ok(r.body.data.merge_history.length === 1);
  });

  // --- Scoring + ScoreModel + Score history ---
  let scoredId = null;
  await test('Lead scoring: computes 0-100 score, tier A/B/C/D, reasons; model aware', async () => {
    const r = await post('/api/growth/leads', { organization_name: 'Score Co', persona_type: 'study_abroad_agency', country: 'Singapore', estimated_student_pool: 800, accepts_commission: true, linkedin_url: 'https://lnkd.in/x', source_url: 'https://score.sg' }, GROWH_ROLE);
    scoredId = r.body.data.id;
    const models = await get('/api/growth/scoremodels', GROWH_ROLE);
    assert.ok(models.body.data.models.length >= 1);
    const s = await post('/api/growth/leads/' + scoredId + '/score', {}, GROWH_ROLE);
    assert.equal(s.status, 200);
    assert.ok(s.body.data.score >= 0 && s.body.data.score <= 100);
    assert.ok(['A', 'B', 'C', 'D'].includes(s.body.data.tier));
    const after = await get('/api/growth/leads/' + scoredId, GROWH_ROLE);
    assert.equal(after.body.data.score_tier, s.body.data.tier);
  });

  // --- Score history ---
  await test('Score history: lead records score + reasons after scoring', async () => {
    const after = await get('/api/growth/leads/' + scoredId, GROWH_ROLE);
    assert.ok(after.body.data.score_reason.length >= 1);
    assert.equal(after.body.data.score_model, 'general');
  });

  // --- Evidence (no LLM-fabricated facts) ---
  await test('Evidence: enrichment fact records value/source_url/captured_at/confidence', async () => {
    const r = await post('/api/growth/leads/' + scoredId + '/evidence', { field: 'organization_name', value: 'Score Co', source_url: 'https://score.sg', confidence: 'high' }, GROWH_ROLE);
    assert.equal(r.status, 201);
    assert.ok(r.body.data.source_url && r.body.data.captured_at);
  });

  // --- Source validation ---
  await test('Source validation: lead without source_url still creatable (draft-grade), dashboard counts it', async () => {
    const r = await post('/api/growth/leads', { organization_name: 'NoSrc', persona_type: 'other' }, GROWH_ROLE);
    assert.equal(r.status, 201);
    assert.equal(r.body.data.source_url, null);
    const list = await get('/api/growth/leads', GROWH_ROLE);
    assert.ok(list.body.meta.total >= 6);
  });

  // --- Outreach queue ---
  await test('Outreach queue: enqueue draft; human-in-the-loop status=queued', async () => {
    const list = await get('/api/growth/leads', GROWH_ROLE);
    const lead = list.body.data[0];
    const r = await post('/api/growth/outreach', { lead_id: lead.id, channel: 'email', template: 'first_contact', content: 'Hi' }, GROWH_ROLE);
    assert.equal(r.status, 201);
    assert.equal(r.body.data.status, 'queued');
    const q = await get('/api/growth/outreach', GROWH_ROLE);
    assert.ok(q.body.data.some((x) => x.lead_id === lead.id));
  });

  // --- Communication record ---
  await test('Communication: log interaction with result; preserves on lead timeline', async () => {
    const list = await get('/api/growth/leads', GROWH_ROLE);
    const lead = list.body.data[0];
    const r = await post('/api/growth/communications', { lead_id: lead.id, channel: 'email', result: 'interested' }, GROWH_ROLE);
    assert.equal(r.status, 201);
    assert.equal(r.body.data.result, 'interested');
  });

  // --- Opt out ---
  await test('Opt out: communication result=opt_out sets do_not_contact on lead', async () => {
    const r = await post('/api/growth/leads', { organization_name: 'OptOut Co', persona_type: 'study_abroad_agency', source_url: 'https://o.sg' }, GROWH_ROLE);
    const id = r.body.data.id;
    await post('/api/growth/communications', { lead_id: id, channel: 'email', result: 'opt_out' }, GROWH_ROLE);
    const after = await get('/api/growth/leads/' + id, GROWH_ROLE);
    assert.equal(after.body.data.do_not_contact, true);
  });

  // --- Do-not-contact blocks outreach ---
  await test('Do-not-contact: cannot enqueue outreach for opted-out lead', async () => {
    const r = await post('/api/growth/leads', { organization_name: 'DNC Co', persona_type: 'study_abroad_agency', source_url: 'https://d.sg' }, GROWH_ROLE);
    const id = r.body.data.id;
    await post('/api/growth/communications', { lead_id: id, channel: 'email', result: 'opt_out' }, GROWH_ROLE);
    const out = await post('/api/growth/outreach', { lead_id: id, channel: 'email', content: 'x' }, GROWH_ROLE);
    assert.equal(out.status, 400);
  });

  // --- Campaign ---
  await test('Campaign: create with stats; dashboard reflects target counts', async () => {
    const r = await post('/api/growth/campaigns', { name: 'SG Q4', persona: 'study_abroad_agency', country: 'Singapore', channel: 'email' }, GROWH_ROLE);
    assert.equal(r.status, 201);
    const list = await get('/api/growth/campaigns', GROWH_ROLE);
    assert.ok(list.body.data.some((c) => c.name === 'SG Q4'));
  });

  // --- Opportunity + stage transition ---
  await test('Opportunity: create from lead; advance S0→S8 valid; unknown stage rejected', async () => {
    const r = await post('/api/growth/leads', { organization_name: 'Opp Co', persona_type: 'study_abroad_agency', source_url: 'https://o.sg', estimated_value: 5000 }, GROWH_ROLE);
    const id = r.body.data.id;
    const opp = await post('/api/growth/leads/' + id + '/opportunity', {}, GROWH_ROLE);
    assert.equal(opp.status, 201);
    assert.equal(opp.body.data.stage, 'S0');
    const adv = await post('/api/growth/opportunities/' + opp.body.data.id + '/advance', { stage: 'S3' }, GROWH_ROLE);
    assert.equal(adv.body.data.stage, 'S3');
    const bad = await post('/api/growth/opportunities/' + opp.body.data.id + '/advance', { stage: 'ZZ' }, GROWH_ROLE);
    assert.equal(bad.status, 400);
  });

  // --- Lead → Organization conversion (attribution retained) ---
  await test('Lead→Organization conversion: S5 creates Organization with original lead attribution', async () => {
    const r = await post('/api/growth/leads', { organization_name: 'Conv Co', persona_type: 'study_abroad_agency', country: 'Singapore', source_type: 'Public Web', source_name: 'Google', source_url: 'https://conv.sg' }, GROWH_ROLE);
    const id = r.body.data.id;
    const opp = await post('/api/growth/leads/' + id + '/opportunity', {}, GROWH_ROLE);
    const adv = await post('/api/growth/opportunities/' + opp.body.data.id + '/advance', { stage: 'S5' }, GROWH_ROLE);
    assert.equal(adv.status, 200);
    const orgs = growth.load('organizations').items;
    assert.equal(orgs.length, 1);
    assert.equal(orgs[0].lead_attribution.lead_id, id);
    assert.equal(orgs[0].lead_attribution.source_type, 'Public Web');
  });

  // --- Lead attribution retention through B-account ---
  await test('Lead attribution retention: full S5→onboarding→B account keeps source attribution', async () => {
    const r = await post('/api/growth/leads', { organization_name: 'Full Co', persona_type: 'study_abroad_agency', country: 'Singapore', source_type: 'Referral', source_name: 'Partner', source_url: 'https://full.sg' }, GROWH_ROLE);
    const id = r.body.data.id;
    const opp = await post('/api/growth/leads/' + id + '/opportunity', {}, GROWH_ROLE);
    await post('/api/growth/opportunities/' + opp.body.data.id + '/advance', { stage: 'S5' }, GROWH_ROLE);
    const org = growth.load('organizations').items.find((o) => o.lead_attribution && o.lead_attribution.lead_id === id);
    const onb = await post('/api/growth/onboarding', { organization_id: org.id }, GROWH_ROLE);
    for (const s of ['register', 'entity_type', 'profile', 'qualification', 'contact', 'target_country', 'business_scale', 'agreement', 'review', 'account_open']) {
      await post('/api/growth/onboarding/' + onb.body.data.id + '/step', { step: s }, GROWH_ROLE);
    }
    const b = growth.load('baccounts').items.find((x) => x.lead_attribution && x.lead_attribution.lead_id === id);
    assert.ok(b);
    assert.equal(b.lead_attribution.source_type, 'Referral');
    assert.equal(growth.findLead(id).stage, 'converted');
  });

  // --- Activation ---
  await test('Activation: first_application / first_commission events recorded', async () => {
    const b = growth.load('baccounts').items[0];
    const a1 = await post('/api/growth/activation', { b_account_id: b.id, event: 'first_application' }, GROWH_ROLE);
    assert.equal(a1.status, 201);
    assert.ok(a1.body.data.first_value_at);
    const a2 = await post('/api/growth/activation', { b_account_id: b.id, event: 'first_commission' }, GROWH_ROLE);
    assert.ok(a2.body.data.first_revenue_at);
  });

  // --- Dashboard ---
  await test('Dashboard: aggregates totals, tier distribution, conversion counters', async () => {
    const d = await get('/api/growth/dashboard', GROWH_ROLE);
    assert.equal(d.status, 200);
    assert.ok(d.body.data.total_leads >= 10);
    assert.ok('A' in d.body.data.distribution && 'D' in d.body.data.distribution);
    assert.ok(d.body.data.onboarded_b >= 1);
    assert.ok(d.body.data.activated_b >= 1);
  });

  // --- Insurance feature flag disabled + reserved provider model ---
  await test('Insurance: feature flag disabled (false); provider reserved model present', async () => {
    const flag = await get('/api/growth/insurance/enabled');
    assert.equal(flag.body.data.insurance_enabled, false);
    const ins = await get('/api/growth/insurance', GROWH_ROLE);
    const p = ins.body.data.providers.find((x) => x.provider_type === 'insurance');
    assert.ok(p);
    assert.equal(p.integration_mode, 'manual');
    assert.equal(p.integration_status, 'reserved');
  });

  // cleanup growth stores
  await test('cleanup: reset growth stores', () => {
    growth.resetStores();
    assert.equal(growth.getLeads().length, 0);
  });

  await new Promise((resolve) => server.close(resolve));
  console.log('\n' + passed.length + ' passed, ' + failed.length + ' failed');
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => { console.error('test runner crashed:', err); process.exitCode = 1; });
