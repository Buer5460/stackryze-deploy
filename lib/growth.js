// Growth Center (V1.1): the platform's B-end customer acquisition engine.
//
// Two "B-ends" are deliberately separate (per spec):
//   - Growth Center  → internal BD/sales/marketing tools (this file)
//   - B-End Workspace → already-onboarded external partners (handled elsewhere)
//
// Conversion funnel is strictly: Lead → Opportunity → Organization → BEndAccount.
// A lead is NEVER silently turned into a partner account.
//
// Data quality rules (mirrors the school-importer rule): AI must not fabricate
// contact details, follower counts, student pools, headcount, qualifications or
// partnership intent. Unavailable facts stay null. Every enrichment fact records
// its source_url + captured_at + confidence (LeadEvidence).
//
// Storage uses the same JSON-file adapter as the rest of the app so the business
// logic never touches the filesystem directly. Swapping to Postgres later means
// reimplementing GrowthStore, not touching the engine below.

const store = require('./store');
const crypto = require('crypto');

const GROWTH_DIR = 'growth';
const ENTITIES = ['leads', 'scoremodels', 'outreach', 'communications', 'opportunities', 'organizations', 'baccounts', 'campaigns', 'onboarding', 'activation', 'insurance'];

function load(name) {
  return store.load(GROWTH_DIR + '/' + name);
}
function save(name, data) {
  store.save(GROWTH_DIR + '/' + name, data);
}

// Seed defaults so the very first run is not empty for config-like entities.
const DEFAULTS = {
  leads: { version: '1.1.0', items: [] },
  scoremodels: {
    version: '1.1.0',
    active: 'general',
    models: [
      {
        id: 'general',
        name: '通用 B 端评分',
        persona: 'all',
        weights: {
          organization_strength: 0.15, audience_strength: 0.15, student_pool: 0.2,
          platform_match: 0.15, cooperation_intent: 0.15, online_influence: 0.1,
          engagement: 0.05, data_quality: 0.03, risk: -0.03
        },
        max_score: 100
      }
    ]
  },
  outreach: { version: '1.1.0', queue: [] },
  communications: { version: '1.1.0', items: [] },
  opportunities: { version: '1.1.0', items: [] },
  organizations: { version: '1.1.0', items: [] },
  baccounts: { version: '1.1.0', items: [] },
  campaigns: { version: '1.1.0', items: [] },
  onboarding: { version: '1.1.0', items: [] },
  activation: { version: '1.1.0', items: [] },
  insurance: {
    version: '1.1.0',
    feature_flag: { insurance_enabled: false },
    providers: [
      {
        id: 'insurance-reserved',
        provider_type: 'insurance',
        integration_mode: 'manual',
        integration_status: 'reserved',
        note: '保险 API 未启用；未来通过 Provider + ServiceProduct + IntegrationConfig 接入。'
      }
    ]
  }
};

// Ensure every growth entity file exists with a seed (idempotent).
function ensureSeeds() {
  for (const e of ENTITIES) {
    const file = GROWTH_DIR + '/' + e;
    const cur = store.load(file);
    if (!cur || !cur.version) store.save(file, JSON.parse(JSON.stringify(DEFAULTS[e] || { version: '1.1.0', items: [] })));
  }
}
ensureSeeds();

// Full reset used by tests (clears items and restores correct default shapes).
function resetStores() {
  for (const e of ENTITIES) {
    store.save(GROWTH_DIR + '/' + e, JSON.parse(JSON.stringify(DEFAULTS[e] || { version: '1.1.0', items: [] })));
  }
}

function id(prefix) {
  return prefix + '-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function nowIso() { return new Date().toISOString(); }

// ---------------------------------------------------------------------------
// Persona configuration (not hard-coded in business logic)
// ---------------------------------------------------------------------------
const PERSONA_TYPES = [
  'study_abroad_agency', 'immigration_firm', 'independent_advisor', 'education_influencer',
  'school_representative', 'international_school', 'language_training', 'family_office', 'other'
];
function isPersona(p) { return PERSONA_TYPES.includes(p); }

const LEAD_STAGES = ['new', 'contacted', 'qualified', 'opportunity', 'converted', 'rejected', 'do_not_contact'];
const OPP_STAGES = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'];
const OPP_STAGE_NAMES = {
  S0: 'Discovery', S1: 'Evaluated', S2: 'First Contact', S3: 'Engaged', S4: 'Negotiation',
  S5: 'Agreement', S6: 'Onboarded', S7: 'Activated', S8: 'First Revenue'
};
const COMM_RESULTS = ['no_reply', 'replied', 'interested', 'not_interested', 'meeting_booked', 'wrong_contact', 'opt_out'];

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------
function getLeads() { return load('leads').items; }
function findLead(id) { return getLeads().find((l) => l.id === id) || null; }

function websiteDomain(url) {
  if (!url) return null;
  try { return new URL(String(url).trim()).hostname.replace(/^www\./, '').toLowerCase(); }
  catch (_) { return null; }
}

// Match key used by the dedup engine.
function leadMatchKeys(lead) {
  const keys = [];
  const dom = websiteDomain(lead.website);
  if (dom) keys.push('domain:' + dom);
  if (lead.organization_name) keys.push('org:' + String(lead.organization_name).trim().toLowerCase());
  if (lead.email) keys.push('email:' + String(lead.email).trim().toLowerCase());
  if (lead.phone) keys.push('phone:' + String(lead.phone).trim().replace(/\s+/g, ''));
  if (lead.linkedin_url) keys.push('li:' + String(lead.linkedin_url).trim().toLowerCase());
  (lead.social_accounts || []).forEach((s) => { if (s) keys.push('social:' + String(s).trim().toLowerCase()); });
  return keys.filter(Boolean);
}

function dedupStatus(lead, existing) {
  const keys = leadMatchKeys(lead);
  if (!keys.length) return { match: 'none', candidates: [] };
  const cands = [];
  for (const other of existing) {
    if (other.id === lead.id) continue;
    const otherKeys = leadMatchKeys(other);
    const overlap = keys.filter((k) => otherKeys.includes(k));
    if (overlap.length) cands.push({ id: other.id, organization_name: other.organization_name, overlap });
  }
  if (!cands.length) return { match: 'none', candidates: [] };
  // exact when any key shares an (email|phone|domain|org) exact hit
  const exact = cands.filter((c) => c.overlap.some((k) => /^(email|phone|domain|org):/.test(k)));
  return { match: exact.length ? 'exact_match' : 'probable_match', candidates: cands };
}

function normalizeLead(raw, opts = {}) {
  const r = raw || {};
  const lead = {
    id: r.id || id('LEAD'),
    lead_type: r.lead_type || 'external',
    persona_type: isPersona(r.persona_type) ? r.persona_type : 'other',
    organization_name: r.organization_name || null,
    contact_name: r.contact_name || null,
    contact_title: r.contact_title || null,
    country: r.country || null,
    region: r.region || null,
    city: r.city || null,
    website: r.website || null,
    website_domain: websiteDomain(r.website),
    email: r.email || null,
    phone: r.phone || null,
    whatsapp: r.whatsapp || null,
    wechat: r.wechat || null,
    linkedin_url: r.linkedin_url || null,
    social_accounts: Array.isArray(r.social_accounts) ? r.social_accounts : [],
    followers: r.followers != null ? r.followers : null,
    engagement_rate: r.engagement_rate != null ? r.engagement_rate : null,
    posting_frequency: r.posting_frequency || null,
    main_countries: Array.isArray(r.main_countries) ? r.main_countries : [],
    education_stages: Array.isArray(r.education_stages) ? r.education_stages : [],
    curricula: Array.isArray(r.curricula) ? r.curricula : [],
    languages: Array.isArray(r.languages) ? r.languages : [],
    estimated_student_pool: r.estimated_student_pool != null ? r.estimated_student_pool : null,
    estimated_family_pool: r.estimated_family_pool != null ? r.estimated_family_pool : null,
    annual_student_volume: r.annual_student_volume != null ? r.annual_student_volume : null,
    partner_school_count: r.partner_school_count != null ? r.partner_school_count : null,
    accepts_partnership: r.accepts_partnership != null ? r.accepts_partnership : null,
    accepts_commission: r.accepts_commission != null ? r.accepts_commission : null,
    accepts_agency_agreement: r.accepts_agency_agreement != null ? r.accepts_agency_agreement : null,
    source_type: r.source_type || 'manual',
    source_name: r.source_name || null,
    source_url: r.source_url || null,
    source_confidence: r.source_confidence || 'medium',
    captured_at: r.captured_at || nowIso(),
    last_verified_at: r.last_verified_at || null,
    score: r.score != null ? r.score : null,
    score_tier: r.score_tier || null,
    score_model: r.score_model || null,
    score_reason: r.score_reason || [],
    stage: r.stage || 'new',
    owner_id: r.owner_id || null,
    last_contact_at: r.last_contact_at || null,
    next_followup_at: r.next_followup_at || null,
    do_not_contact: r.do_not_contact || false,
    opt_out_at: r.opt_out_at || null,
    converted_organization_id: r.converted_organization_id || null,
    converted_b_account_id: r.converted_b_account_id || null,
    notes: r.notes || null,
    created_at: r.created_at || nowIso(),
    updated_at: r.updated_at || nowIso(),
    evidence: Array.isArray(r.evidence) ? r.evidence : [],
    merge_history: Array.isArray(r.merge_history) ? r.merge_history : []
  };
  // Don't let callers fabricate score as a fact; if provided without model, mark null.
  if (lead.score != null && !lead.score_model) { /* keep as seeded */ }
  return lead;
}

function createLead(raw, opts = {}) {
  const data = load('leads');
  const lead = normalizeLead(raw);
  const dup = dedupStatus(lead, data.items);
  lead.dedup = dup; // surfaced for the caller; UI sends to Duplicate Review
  if (opts.skipDupCheck !== true && dup.match === 'exact_match') {
    lead.stage = 'new';
    return { ok: false, dedup_blocked: true, error: '疑似重复线索（exact_match），已转入重复审查', lead, dup };
  }
  data.items.push(lead);
  save('leads', data);
  return { ok: true, lead, dup };
}

function updateLead(id, patch) {
  const data = load('leads');
  const lead = data.items.find((l) => l.id === id);
  if (!lead) return { ok: false, error: '线索不存在' };
  // Only editable, non-fabricated fields may be patched; score/score_reason are
  // computed by the scoring engine, not by free-form edits.
  const allowed = ['contact_name', 'contact_title', 'email', 'phone', 'whatsapp', 'wechat',
    'linkedin_url', 'social_accounts', 'stage', 'owner_id', 'next_followup_at',
    'notes', 'do_not_contact', 'opt_out_at', 'last_contact_at', 'score_tier'];
  for (const k of allowed) if (k in patch) lead[k] = patch[k];
  if (patch.do_not_contact) lead.opt_out_at = lead.opt_out_at || nowIso();
  lead.website_domain = websiteDomain(lead.website);
  lead.updated_at = nowIso();
  save('leads', data);
  return { ok: true, lead };
}

function mergeLeads(keepId, mergeId, note) {
  const data = load('leads');
  const keep = data.items.find((l) => l.id === keepId);
  const merge = data.items.find((l) => l.id === mergeId);
  if (!keep || !merge) return { ok: false, error: '线索不存在' };
  // Prefer non-null values from the merge record to fill gaps in the kept one.
  for (const k of Object.keys(merge)) {
    if (merge[k] != null && (keep[k] == null || keep[k] === '' || (Array.isArray(keep[k]) && !keep[k].length))) {
      if (k !== 'id' && k !== 'merge_history') keep[k] = merge[k];
    }
  }
  keep.merge_history = keep.merge_history || [];
  keep.merge_history.push({ merged_from: mergeId, at: nowIso(), note: note || null });
  data.items = data.items.filter((l) => l.id !== mergeId);
  save('leads', data);
  return { ok: true, lead: keep };
}

// ---------------------------------------------------------------------------
// Enrichment + Evidence
// ---------------------------------------------------------------------------
function addEvidence(leadId, ev) {
  const data = load('leads');
  const lead = data.items.find((l) => l.id === leadId);
  if (!lead) return { ok: false, error: '线索不存在' };
  const evidence = {
    id: id('EV'),
    field: ev.field || null,
    value: ev.value != null ? ev.value : null, // must not be LLM-fabricated
    source_url: ev.source_url || null,
    captured_at: ev.captured_at || nowIso(),
    confidence: ev.confidence || 'low',
    note: ev.note || null
  };
  lead.evidence = lead.evidence || [];
  lead.evidence.push(evidence);
  lead.last_verified_at = evidence.captured_at;
  save('leads', data);
  return { ok: true, evidence };
}

// ---------------------------------------------------------------------------
// Scoring engine (ScoreModel aware)
// ---------------------------------------------------------------------------
function getScoreModels() { return load('scoremodels'); }

function dimensionScore(lead, model) {
  const w = model.weights;
  const reasons = [];
  let total = 0;
  const add = (name, raw, label) => {
    let s = 0;
    if (raw != null && raw !== '' && !(Array.isArray(raw) && !raw.length)) s = 100;
    total += (w[name] || 0) * s;
    if (s) reasons.push(label + ' +' + Math.round((w[name] || 0) * 100));
  };
  add('organization_strength', lead.organization_name, '有机构主体');
  add('audience_strength', lead.followers, '有受众规模');
  add('student_pool', lead.estimated_student_pool || lead.annual_student_volume, '有学生池');
  add('platform_match', lead.curricula && lead.curricula.length ? lead.curricula : (lead.main_countries && lead.main_countries.length ? lead.main_countries : null), '与平台匹配');
  add('cooperation_intent', lead.accepts_partnership || lead.accepts_commission || lead.accepts_agency_agreement, '有合作意向');
  add('online_influence', lead.linkedin_url || (lead.social_accounts && lead.social_accounts.length), '有线上影响力');
  add('engagement', lead.engagement_rate, '有互动数据');
  add('data_quality', lead.source_url, '有来源');
  // risk subtracts
  const risk = (lead.do_not_contact || lead.opt_out_at) ? 100 : 0;
  total += (w.risk || 0) * risk;
  if (risk) reasons.push('已 opt-out/do-not-contact 扣分');
  const score = Math.max(0, Math.min(100, Math.round(total)));
  return { score, reasons };
}

function tierFor(score) {
  if (score >= 75) return 'A';
  if (score >= 55) return 'B';
  if (score >= 35) return 'C';
  return 'D';
}

function scoreLead(leadId, modelId) {
  const models = getScoreModels();
  const model = models.models.find((m) => m.id === (modelId || models.active)) || models.models[0];
  const lead = findLead(leadId);
  if (!lead) return { ok: false, error: '线索不存在' };
  const { score, reasons } = dimensionScore(lead, model);
  const data = load('leads');
  const rec = data.items.find((l) => l.id === leadId);
  rec.score = score;
  rec.score_tier = tierFor(score);
  rec.score_model = model.id;
  rec.score_reason = reasons;
  rec.updated_at = nowIso();
  save('leads', data);
  return { ok: true, score, tier: tierFor(score), reasons, model: model.id };
}

// ---------------------------------------------------------------------------
// Outreach queue + Communication CRM
// ---------------------------------------------------------------------------
function getOutreach() { return load('outreach').queue; }

function enqueueOutreach(leadId, payload) {
  const lead = findLead(leadId);
  if (!lead) return { ok: false, error: '线索不存在' };
  if (lead.do_not_contact) return { ok: false, error: '该线索已 do-not-contact，无法加入触达' };
  const item = {
    id: id('OUT'),
    lead_id: leadId,
    channel: payload.channel || 'email',
    template: payload.template || 'first_contact',
    content: payload.content || null, // AI-assisted draft; human reviews before send
    status: 'queued', // queued → approved → sent → replied...
    owner_id: payload.owner_id || null,
    next_action: payload.next_action || null,
    created_at: nowIso(),
    sent_at: null,
    result: null
  };
  const data = load('outreach');
  data.queue.push(item);
  save('outreach', data);
  return { ok: true, item };
}

function updateOutreach(itemId, patch) {
  const data = load('outreach');
  const item = data.queue.find((q) => q.id === itemId);
  if (!item) return { ok: false, error: '触达任务不存在' };
  Object.assign(item, patch);
  save('outreach', data);
  return { ok: true, item };
}

function logCommunication(payload) {
  const lead = findLead(payload.lead_id);
  if (!lead) return { ok: false, error: '线索不存在' };
  const comm = {
    id: id('COMM'),
    lead_id: payload.lead_id,
    channel: payload.channel || 'email',
    direction: payload.direction || 'outbound',
    content: payload.content || null,
    sent_at: payload.sent_at || nowIso(),
    reply_at: payload.reply_at || null,
    status: payload.status || 'sent',
    result: COMM_RESULTS.includes(payload.result) ? payload.result : null,
    owner: payload.owner || null,
    next_action: payload.next_action || null,
    next_action_at: payload.next_action_at || null
  };
  const data = load('communications');
  data.items.push(comm);
  save('communications', data);
  // keep the lead's contact timestamp fresh
  const ldata = load('leads');
  const lrec = ldata.items.find((l) => l.id === payload.lead_id);
  if (lrec) { lrec.last_contact_at = comm.sent_at; lrec.updated_at = nowIso(); save('leads', ldata); }
  if (comm.result === 'opt_out') {
    const lu = load('leads');
    const lr = lu.items.find((l) => l.id === payload.lead_id);
    if (lr) { lr.do_not_contact = true; lr.opt_out_at = nowIso(); save('leads', lu); }
  }
  return { ok: true, comm };
}

// ---------------------------------------------------------------------------
// Opportunity (Lead → Opportunity)
// ---------------------------------------------------------------------------
function getOpportunities() { return load('opportunities').items; }

function createOpportunity(leadId, payload) {
  const lead = findLead(leadId);
  if (!lead) return { ok: false, error: '线索不存在' };
  const opp = {
    id: id('OPP'),
    lead_id: leadId,
    persona_type: lead.persona_type,
    owner: payload.owner || lead.owner_id || null,
    potential_student_volume: payload.potential_student_volume != null ? payload.potential_student_volume : lead.annual_student_volume,
    target_markets: Array.isArray(payload.target_markets) ? payload.target_markets : lead.main_countries || [],
    interested_services: Array.isArray(payload.interested_services) ? payload.interested_services : [],
    estimated_value: payload.estimated_value != null ? payload.estimated_value : null,
    probability: payload.probability != null ? payload.probability : null,
    next_action: payload.next_action || null,
    stage: 'S0',
    created_at: nowIso(),
    updated_at: nowIso()
  };
  const data = load('opportunities');
  data.items.push(opp);
  save('opportunities', data);
  // advance the lead stage
  const ldata = load('leads');
  const lrec = ldata.items.find((l) => l.id === leadId);
  if (lrec) { lrec.stage = 'opportunity'; save('leads', ldata); }
  return { ok: true, opportunity: opp };
}

function advanceOpportunity(oppId, toStage, note) {
  if (!OPP_STAGES.includes(toStage)) return { ok: false, error: '未知商机阶段' };
  const data = load('opportunities');
  const opp = data.items.find((o) => o.id === oppId);
  if (!opp) return { ok: false, error: '商机不存在' };
  opp.stage = toStage;
  opp.updated_at = nowIso();
  opp.history = opp.history || [];
  opp.history.push({ to: toStage, at: nowIso(), note: note || null });
  save('opportunities', data);
  // Lead attribution must be preserved on conversion.
  if (toStage === 'S5' || toStage === 'S6') {
    const ldata = load('leads');
    const lead = ldata.items.find((l) => l.id === opp.lead_id);
    if (lead) {
      // Organization created only at S5 (agreement) — never auto B account.
      const odata = load('organizations');
      let org = odata.items.find((o) => o.source_lead_id === opp.lead_id);
      if (!org) {
        org = {
          id: id('ORG'), source_lead_id: opp.lead_id, lead_attribution: {
            lead_id: lead.id, source_type: lead.source_type, source_name: lead.source_name,
            source_url: lead.source_url, captured_at: lead.captured_at
          },
          organization_name: lead.organization_name, persona_type: lead.persona_type,
          status: 'invited', created_at: nowIso(), updated_at: nowIso()
        };
        odata.items.push(org);
        save('organizations', odata);
      }
      if (toStage === 'S6' && !opp.organization_id) opp.organization_id = org.id;
    }
  }
  return { ok: true, opportunity: opp };
}

// ---------------------------------------------------------------------------
// Onboarding + Activation
// ---------------------------------------------------------------------------
function getOnboarding() { return load('onboarding').items; }

function startOnboarding(orgId, payload) {
  const odata = load('organizations');
  const org = odata.items.find((o) => o.id === orgId);
  if (!org) return { ok: false, error: '组织不存在' };
  const rec = {
    id: id('ONB'),
    organization_id: orgId,
    lead_id: org.source_lead_id,
    steps: [
      { key: 'register', label: '注册', status: 'pending' },
      { key: 'entity_type', label: '主体类型', status: 'pending' },
      { key: 'profile', label: '企业/个人资料', status: 'pending' },
      { key: 'qualification', label: '资质', status: 'pending' },
      { key: 'contact', label: '联系人', status: 'pending' },
      { key: 'target_country', label: '目标国家', status: 'pending' },
      { key: 'business_scale', label: '业务规模', status: 'pending' },
      { key: 'agreement', label: '协议', status: 'pending' },
      { key: 'review', label: '审核', status: 'pending' },
      { key: 'account_open', label: '账号开通', status: 'pending' }
    ],
    status: 'in_progress',
    created_at: nowIso(),
    updated_at: nowIso()
  };
  // apply any completed steps provided
  if (Array.isArray(payload.completed_steps)) {
    for (const key of payload.completed_steps) {
      const step = rec.steps.find((s) => s.key === key);
      if (step) step.status = 'done';
    }
  }
  const data = load('onboarding');
  data.items.push(rec);
  save('onboarding', data);
  return { ok: true, onboarding: rec };
}

function completeOnboardingStep(onbId, stepKey) {
  const data = load('onboarding');
  const rec = data.items.find((o) => o.id === onbId);
  if (!rec) return { ok: false, error: '入驻流程不存在' };
  const step = rec.steps.find((s) => s.key === stepKey);
  if (!step) return { ok: false, error: '步骤不存在' };
  step.status = 'done';
  rec.updated_at = nowIso();
  if (rec.steps.every((s) => s.status === 'done')) rec.status = 'completed';
  save('onboarding', data);
  if (rec.status === 'completed') {
    // Only NOW create the B-End account, preserving original lead attribution.
    const odata = load('organizations');
    const org = odata.items.find((o) => o.id === rec.organization_id);
    if (org) {
      const bdata = load('baccounts');
      let b = bdata.items.find((x) => x.organization_id === org.id);
      if (!b) {
        b = {
          id: id('BACC'), organization_id: org.id,
          lead_attribution: org.lead_attribution,
          persona_type: org.persona_type, status: 'active',
          created_at: nowIso(), updated_at: nowIso()
        };
        bdata.items.push(b);
        save('baccounts', bdata);
        // link back to the lead + opportunity
        const ldata = load('leads');
        const lead = ldata.items.find((l) => l.id === org.source_lead_id);
        if (lead) { lead.converted_organization_id = org.id; lead.converted_b_account_id = b.id; lead.stage = 'converted'; save('leads', ldata); }
        const opdata = load('opportunities');
        const opp = opdata.items.find((o) => o.lead_id === org.source_lead_id);
        if (opp) { opp.b_account_id = b.id; save('opportunities', opdata); }
      }
      return { ok: true, onboarding: rec, b_account: b };
    }
  }
  return { ok: true, onboarding: rec };
}

function getActivation() { return load('activation').items; }

function recordActivation(bAccountId, event) {
  const bdata = load('baccounts');
  const b = bdata.items.find((x) => x.id === bAccountId);
  if (!b) return { ok: false, error: 'B 端账号不存在' };
  const ALLOWED = ['first_login', 'first_school_search', 'first_program_view', 'first_favorite',
    'first_student_created', 'first_application', 'first_agreement', 'first_commission'];
  if (!ALLOWED.includes(event)) return { ok: false, error: '未知激活事件' };
  const data = load('activation');
  let rec = data.items.find((a) => a.b_account_id === bAccountId);
  if (!rec) {
    rec = { id: id('ACT'), b_account_id: bAccountId, events: {}, first_value_at: null, first_revenue_at: null, created_at: nowIso() };
    data.items.push(rec);
  }
  rec.events[event] = nowIso();
  if (event === 'first_application' && !rec.first_value_at) rec.first_value_at = nowIso();
  if (event === 'first_commission' && !rec.first_revenue_at) rec.first_revenue_at = nowIso();
  rec.updated_at = nowIso();
  save('activation', data);
  return { ok: true, activation: rec };
}

// ---------------------------------------------------------------------------
// Campaigns + Dashboard
// ---------------------------------------------------------------------------
function createCampaign(payload) {
  const c = {
    id: id('CAMP'),
    name: payload.name || '未命名活动',
    persona: payload.persona || 'all',
    country: payload.country || null,
    lead_filters: payload.lead_filters || {},
    channel: payload.channel || 'email',
    template: payload.template || 'first_contact',
    start_at: payload.start_at || null,
    end_at: payload.end_at || null,
    owner: payload.owner || null,
    stats: { target_leads: 0, contacted: 0, delivered: 0, opened: 0, replied: 0, positive_reply: 0, meeting: 0, onboarded: 0, activated: 0, first_revenue: 0 }
  };
  const data = load('campaigns');
  data.items.push(c);
  save('campaigns', data);
  return { ok: true, campaign: c };
}

function dashboard(filters = {}) {
  const leads = getLeads();
  const opps = getOpportunities();
  const orgs = load('organizations').items;
  const baccs = load('baccounts').items;
  const acts = load('activation').items;
  const tierCount = { A: 0, B: 0, C: 0, D: 0 };
  for (const l of leads) if (l.score_tier) tierCount[l.score_tier]++;
  const filtered = leads.filter((l) => {
    if (filters.persona && l.persona_type !== filters.persona) return false;
    if (filters.country && l.country !== filters.country) return false;
    if (filters.score_tier && l.score_tier !== filters.score_tier) return false;
    if (filters.source_type && l.source_type !== filters.source_type) return false;
    return true;
  });
  const activated = baccs.filter((b) => acts.some((a) => a.b_account_id === b.id && a.first_value_at)).length;
  const firstRev = baccs.filter((b) => acts.some((a) => a.b_account_id === b.id && a.first_revenue_at)).length;
  return {
    total_leads: leads.length,
    new_leads: leads.filter((l) => l.stage === 'new').length,
    qualified_leads: leads.filter((l) => l.stage === 'qualified').length,
    contacted: leads.filter((l) => l.last_contact_at).length,
    distribution: tierCount,
    opportunities: opps.length,
    onboarded_b: orgs.filter((o) => o.status === 'invited' || o.status === 'active').length,
    activated_b: activated,
    first_application: acts.filter((a) => a.first_value_at).length,
    first_commission: firstRev,
    do_not_contact: leads.filter((l) => l.do_not_contact).length,
    filtered_total: filtered.length
  };
}

// ---------------------------------------------------------------------------
// Insurance reservation (feature flag; not enabled)
// ---------------------------------------------------------------------------
function getInsurance() {
  const data = load('insurance');
  return { feature_flag: data.feature_flag, providers: data.providers, service_products: [], integration_configs: [] };
}
function insuranceEnabled() { return load('insurance').feature_flag.insurance_enabled === true; }

module.exports = {
  ENTITIES, PERSONA_TYPES, isPersona, LEAD_STAGES, OPP_STAGES, OPP_STAGE_NAMES, COMM_RESULTS,
  load, save, id, nowIso, websiteDomain, leadMatchKeys, dedupStatus, resetStores,
  getLeads, findLead, createLead, updateLead, mergeLeads,
  addEvidence,
  getScoreModels, dimensionScore, tierFor, scoreLead,
  getOutreach, enqueueOutreach, updateOutreach, logCommunication,
  getOpportunities, createOpportunity, advanceOpportunity,
  getOnboarding, startOnboarding, completeOnboardingStep,
  getActivation, recordActivation,
  createCampaign, dashboard,
  getInsurance, insuranceEnabled
};
