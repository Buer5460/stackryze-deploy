'use strict';
// ---------------------------------------------------------------------------
// Seed data — demo records for every client.
//
// Everything here is explicitly `is_demo: true` and labelled in the UI.
// No school facts, tuition, admission rates, rankings, commission rates, loan
// rates, bed inventory or visa success rates are invented by AI: only the
// fields an operator explicitly supplied as demo defaults are present.
// ---------------------------------------------------------------------------
const db = require('./db');
const auth = require('./auth');
const org = require('./org');
const configModule = require('./config');
const { iso, addMonths, addDays } = require('./util');

const DEMO_TOKENS = {
  student: 'demo-student-01',
  agent: 'demo-agent-01',
  agent2: 'demo-agent-02',
  education: 'demo-supplier-education-01',
  medical: 'demo-supplier-medical-01',
  certification: 'demo-supplier-certification-01',
  visa: 'demo-supplier-visa-01',
  accommodation: 'demo-supplier-accommodation-01',
  dbc: 'demo-dbc-01',
  admin: 'demo-admin-01'
};

// Idempotency marker must be a record that SURVIVES the public snapshot
// whitelist: `users` is deliberately excluded from public snapshots, so a
// restored dataset would look unseeded and seed again (duplicating every
// catalogue record). `institutions` is whitelisted and seeded, so it is a
// reliable marker in both fresh and restored datasets.
function alreadySeeded() {
  // The catalogue is only "present" when the full demo fixture is there.
  // A public snapshot restores only the whitelisted subset (institutions,
  // suppliers, organizations, b_profiles ...) so b_profiles may be missing
  // while institutions exist — in that case we must still seed, otherwise
  // there is no eligible agency and every recommendation falls back to
  // browse-only. Accounts are excluded: ensureAccounts() tops them up.
  if (db.stores.b_profiles.all().length === 0) return false;
  if (db.stores.organizations.all().length === 0) return false;
  if (db.stores.suppliers.all().length === 0) return false;
  return true;
}

// Accounts are deliberately EXCLUDED from public snapshots (they carry
// password hashes and demo tokens). After a snapshot restore the catalogue is
// present but accounts are gone, so they must be re-created by email. This is
// idempotent per address and never duplicates catalogue data.
function ensureAccounts() {
  const byEmail = (email) => db.stores.users.all().find((u) => String(u.email).toLowerCase() === String(email).toLowerCase());
  const created = [];

  const student = byEmail('student@demo.local');
  if (!student) {
    const u = auth.createUser({ email: 'student@demo.local', password: 'demo1234',
      display_name: '陈小雨（演示）', role: 'C_STUDENT', language: 'zh', is_demo: true });
    u.demo_token = DEMO_TOKENS.student;
    const bMod = require('./binding');
    bMod.createCProfile({ user_id: u.id, name: '陈小雨', name_en: 'Chen Xiaoyu',
      email: 'student@demo.local', nationality: 'CN', education_stage: 'BACHELOR',
      target_countries: ['SG', 'UK'], target_courses: ['Computer Science'], language: 'zh' });
    created.push('student@demo.local');
  }
  if (!byEmail('admin@demo.local')) {
    const u = auth.createUser({ email: 'admin@demo.local', password: 'demo1234',
      display_name: '平台管理员（演示）', role: 'ADMIN_SUPER', language: 'zh', is_demo: true });
    u.demo_token = DEMO_TOKENS.admin;
    created.push('admin@demo.local');
  }
  if (!byEmail('dbc@demo.local')) {
    const u = auth.createUser({ email: 'dbc@demo.local', password: 'demo1234',
      display_name: 'DBC 演示账号', role: 'DBC_OWNER', language: 'zh', is_demo: true });
    u.demo_token = DEMO_TOKENS.dbc;
    created.push('dbc@demo.local');
  }
  // Supplier demo logins: one per seeded supplier type.
  const supplierMod = require('./supplier');
  for (const sup of supplierMod.listSuppliers({})) {
    const email = String(sup.type).toLowerCase() + '@supplier.demo';
    if (byEmail(email)) continue;
    const u = auth.createUser({ email: email, password: 'demo1234',
      display_name: String(sup.name), role: 'S_OWNER',
      organization_id: sup.organization_id, language: 'zh', is_demo: true });
    u.demo_token = 'demo-supplier-' + String(sup.type).toLowerCase() + '-01';
    created.push(email);
  }
  // B demo logins: one per seeded B organisation.
  const orgMod = require('./org');
  const bOrgs = orgMod.organizationsOfKind('B');
  let idx = 0;
  for (const o of bOrgs) {
    idx += 1;
    const email = idx === 1 ? 'agent@demo.local' : ('agent' + idx + '@demo.local');
    if (byEmail(email)) continue;
    const u = auth.createUser({ email: email, password: 'demo1234',
      display_name: '机构管理员（演示）', role: 'B_OWNER',
      organization_id: o.id, org_role: 'Owner', language: 'zh', is_demo: true });
    u.demo_token = idx === 1 ? DEMO_TOKENS.agent : ('demo-agent-' + String(idx).padStart(2, '0'));
    created.push(email);
  }
  if (created.length) db.flushSync();
  return created;
}

function seed() {
  // A restored snapshot carries no accounts, so they must be re-created. When
  // the catalogue is already present we ONLY top up accounts (never re-seed
  // catalogue rows). When nothing exists we run the full seed below, which
  // creates both catalogue and accounts exactly once.
  if (alreadySeeded()) {
    const accountsCreated = String(process.env.GS_SEED_ACCOUNTS || '1') === '0'
      ? [] : ensureAccounts();
    return { seeded: false, reason: 'demo data already present',
      accounts_created: accountsCreated };
  }

  // --- B agencies ---------------------------------------------------------
  const agencyA = org.createOrganization({
    kind: 'B', name: '环球学桥（演示）', name_en: 'GlobalBridge Education (Demo)',
    country: 'SG', city: 'Singapore', contact_name: '王老师', contact_email: 'owner@globalbridge.demo',
    contact_phone: '+65-0000-0001', kyc_status: 'approved', kyb_status: 'approved',
    financial_docs_complete: true, verified: true, is_demo: true
  });
  const agencyB = org.createOrganization({
    kind: 'B', name: '启航留学（演示）', name_en: 'Qihang Study (Demo)',
    country: 'SG', city: 'Singapore', contact_name: '周老师', contact_email: 'owner@qihang.demo',
    contact_phone: '+65-0000-0002', kyc_status: 'approved', kyb_status: 'approved',
    financial_docs_complete: true, verified: true, is_demo: true
  });
  const agencyC = org.createOrganization({
    kind: 'B', name: '新锐国际教育（演示）', name_en: 'NewEdge Global (Demo)',
    country: 'CN', city: 'Shanghai', contact_name: '李老师', contact_email: 'owner@newedge.demo',
    contact_phone: '+86-0000-0003', kyc_status: 'pending', kyb_status: 'pending',
    financial_docs_complete: false, verified: false, is_demo: true
  });

  // A second Level 2 agency so the Level-2 pool has more than one member and
  // fair rotation has something to rotate between.
  const agencyA2 = org.createOrganization({
    kind: 'B', name: '远帆留学（演示）', name_en: 'YuanFan Study (Demo)',
    country: 'SG', city: 'Singapore', contact_name: '赵老师', contact_email: 'owner@yuanfan.demo',
    contact_phone: '+65-0000-0004', kyc_status: 'approved', kyb_status: 'approved',
    financial_docs_complete: true, verified: true, is_demo: true
  });
  org.createBProfile({
    organization_id: agencyA2.id, level: 'LEVEL_2',
    verified: true, contract_valid: true,
    service_countries: ['SG', 'UK'], service_courses: ['Computer Science', 'Data Science'],
    service_stages: ['MASTER'], service_types: ['APPLICATION', 'VISA'],
    languages: ['ZH', 'EN'], daily_order_cap: 4, monthly_order_cap: 30,
    rating_avg: 4.6, rating_count: 18, avg_response_minutes: 30, commission_agreements_count: 2
  });
  org.createMembership({ organization_id: agencyA2.id, level: 'LEVEL_2', expires_at: addMonths(new Date(), 12).toISOString(), auto_renew: true });

  const bProfileA = org.createBProfile({
    organization_id: agencyA.id, level: 'LEVEL_2',
    verified: true, contract_valid: true,
    service_countries: ['SG', 'UK', 'AU'], service_courses: ['Computer Science', 'Business', 'Engineering'],
    service_stages: ['BACHELOR', 'MASTER'], service_types: ['APPLICATION', 'VISA', 'ACCOMMODATION'],
    languages: ['ZH', 'EN'], daily_order_cap: 5, monthly_order_cap: 40,
    contract_valid: true, rating_avg: 4.8, rating_count: 46, avg_response_minutes: 12,
    commission_agreements_count: 3
  });
  org.createBProfile({
    organization_id: agencyB.id, level: 'LEVEL_1',
    verified: true, contract_valid: true,
    service_countries: ['SG', 'CN'], service_courses: ['Business', 'Arts'],
    service_stages: ['BACHELOR', 'DIPLOMA'], service_types: ['APPLICATION'],
    languages: ['ZH', 'EN'], daily_order_cap: 3, monthly_order_cap: 20,
    contract_valid: true, rating_avg: 4.4, rating_count: 12, avg_response_minutes: 45,
    commission_agreements_count: 1
  });
  org.createBProfile({
    organization_id: agencyC.id, level: 'FREE',
    verified: false, contract_valid: false,
    service_countries: ['CN'], service_courses: ['Language'], service_stages: ['LANGUAGE'],
    service_types: ['APPLICATION'], languages: ['ZH'], daily_order_cap: 2, monthly_order_cap: 10,
    contract_valid: false, rating_avg: 0, rating_count: 0, avg_response_minutes: 240
  });

  for (const [organization, level] of [[agencyA, 'LEVEL_2'], [agencyB, 'LEVEL_1'], [agencyC, 'FREE']]) {
    org.createMembership({ organization_id: organization.id, level, expires_at: addMonths(new Date(), 12).toISOString(), auto_renew: true });
  }

  // --- C students / parents ----------------------------------------------
  const studentUser = auth.createUser({
    email: 'student@demo.local', password: 'demo1234', display_name: '陈小雨（演示）',
    role: 'C_STUDENT', language: 'zh', is_demo: true
  });
  studentUser.demo_token = DEMO_TOKENS.student;

  const cProfile = require('./binding').createCProfile({
    user_id: studentUser.id, name: '陈小雨', name_en: 'Chen Xiaoyu', email: 'student@demo.local',
    phone: '+65-0000-1000', nationality: 'CN', education_stage: 'BACHELOR',
    target_countries: ['SG', 'UK'], target_courses: ['Computer Science'], language: 'zh', is_demo: true
  });

  // --- S suppliers (all six types, all demo) ------------------------------
  const supplierSeeds = [
    {
      type: 'EDUCATION', name: '南洋国际学院（演示）', name_en: 'Nanyang International College (Demo)',
      country: 'SG', city: 'Singapore', contact_email: 'admission@nanyang.demo',
      profile: {
        description: '演示教育机构，用于验证申请、看板与材料流程。',
        description_en: 'Demo education institution for application and board validation.',
        languages: ['EN'], service_countries: ['SG'], service_cities: ['Singapore'],
        institution_type: 'Private college',
        campuses: [{ id: 'campus-1', name: '主校区', address: 'Demo address, Singapore' }],
        virtual_tour_url: null, video_url: null
      }
    },
    {
      type: 'MEDICAL', name: '康桥体检中心（演示）', name_en: 'HealthBridge Medical (Demo)',
      country: 'SG', city: 'Singapore', contact_email: 'booking@healthbridge.demo',
      profile: {
        description: '演示体检机构：只保存预约、状态、完成与报告文件。',
        description_en: 'Demo medical provider: appointment, status, completion and report files only.',
        languages: ['EN', 'ZH'], service_countries: ['SG'], service_cities: ['Singapore'],
        medical_capabilities: ['study_abroad_medical_check']
      }
    },
    {
      type: 'CERTIFICATION', name: '正衡文件认证（演示）', name_en: 'CertifyPro Documents (Demo)',
      country: 'SG', city: 'Singapore', contact_email: 'file@certifypro.demo',
      profile: {
        description: '演示文件认证机构：学历、成绩、公证、翻译认证。',
        description_en: 'Demo certification body: degree, transcript, notarisation and translation.',
        languages: ['EN', 'ZH'], service_countries: ['SG'], service_cities: ['Singapore'],
        certification_types: ['degree', 'transcript', 'notarisation', 'translation']
      }
    },
    {
      type: 'VISA', name: '通行签证代办（演示）', name_en: 'Passport Visa Service (Demo)',
      country: 'SG', city: 'Singapore', contact_email: 'visa@passport.demo',
      profile: {
        description: '演示签证代办机构。',
        description_en: 'Demo visa agency.',
        languages: ['EN', 'ZH'], service_countries: ['SG'], service_cities: ['Singapore'],
        visa_types: ['student_visa', 'dependent_visa'], target_countries: ['SG', 'UK']
      }
    },
    {
      type: 'ACCOMMODATION', name: '安寓学生住宿（演示）', name_en: 'AnYu Student Living (Demo)',
      country: 'SG', city: 'Singapore', contact_email: 'stay@anyu.demo',
      profile: {
        description: '演示学生住宿机构。',
        description_en: 'Demo student accommodation provider.',
        languages: ['EN', 'ZH'], service_countries: ['SG'], service_cities: ['Singapore'],
        accommodation_types: ['student_dormitory', 'student_apartment'],
        room_types: ['single', 'double', 'shared'],
        guardian_services: ['airport_pickup', 'guardianship']
      }
    },
    {
      type: 'FINANCE', name: '学融教育金融（演示）', name_en: 'EduFinance (Demo)',
      country: 'SG', city: 'Singapore', contact_email: 'finance@edufinance.demo',
      profile: {
        description: '功能暂未开放 / Coming soon。',
        description_en: 'Feature not open yet / Coming soon.',
        languages: ['EN', 'ZH'], service_countries: ['SG'], service_cities: ['Singapore']
      }
    }
  ];

  const supplierModule = require('./supplier');
  const suppliers = {};
  for (const s of supplierSeeds) {
    const result = supplierModule.createSupplier({
      ...s,
      // Internal pipeline state 'verified' keeps sandbox admission/recommend
      // flows working; the external label is forced to 'demo' by publicView()
      // because is_demo=true (Fix 6). Do not replace this with real evidence.
      verification: 'verified',
      public_visible: true,
      accepts_b_orders: true,
      source_url: s.type === 'FINANCE' ? null : 'https://example.com/demo-evidence',
      is_demo: true
    });
    suppliers[s.type] = result.supplier;
  }

  // Demo commission rules — clearly demo, never presented as real terms.
  const contracts = require('./contracts');
  const agreement = contracts.createAgreement({
    kind: 'B_S', b_organization_id: agencyA.id, supplier_id: suppliers.EDUCATION.id,
    title: 'B-S 演示合作协议', is_demo: true, state: 'A'
  });
  contracts.createCommissionRule({
    supplier_id: suppliers.EDUCATION.id, b_organization_id: agencyA.id, agreement_id: agreement.id,
    mode: 'PERCENTAGE', value: 15, currency: 'SGD', trigger_event: 'PAYMENT_SUCCEEDED',
    is_demo: true, source_document: 'demo-default'
  });
  const accommodationAgreement = contracts.createAgreement({
    kind: 'B_S', b_organization_id: agencyA.id, supplier_id: suppliers.ACCOMMODATION.id,
    title: 'B-S 住宿演示合作协议', is_demo: true, state: 'A'
  });
  contracts.createCommissionRule({
    supplier_id: suppliers.ACCOMMODATION.id, b_organization_id: agencyA.id,
    agreement_id: accommodationAgreement.id, mode: 'FIXED_PER_BOOKING', value: 120,
    currency: 'SGD', trigger_event: 'BOOKING_CONFIRMED', is_demo: true, source_document: 'demo-default'
  });

  // --- S users (one per type) --------------------------------------------
  const sRoleByType = {
    EDUCATION: 'S_OWNER', MEDICAL: 'S_OWNER', CERTIFICATION: 'S_OWNER',
    VISA: 'S_OWNER', ACCOMMODATION: 'S_OWNER', FINANCE: 'S_OWNER'
  };
  const sTokens = {
    EDUCATION: DEMO_TOKENS.education, MEDICAL: DEMO_TOKENS.medical,
    CERTIFICATION: DEMO_TOKENS.certification, VISA: DEMO_TOKENS.visa,
    ACCOMMODATION: DEMO_TOKENS.accommodation, FINANCE: 'demo-supplier-finance-01'
  };
  const sUsers = {};
  for (const s of supplierSeeds) {
    const user = auth.createUser({
      email: s.type.toLowerCase() + '@supplier.demo', password: 'demo1234',
      display_name: s.name, role: sRoleByType[s.type], organization_id: suppliers[s.type].organization_id,
      language: 'zh', is_demo: true
    });
    user.demo_token = sTokens[s.type];
    sUsers[s.type] = user;
  }

  // --- DBC ---------------------------------------------------------------
  const dbcOrg = org.createOrganization({
    kind: 'DBC', name: '安途招生牌照合作（演示）', name_en: 'AnTu DBC (Demo)',
    country: 'SG', city: 'Singapore', contact_name: 'DBC Owner', contact_email: 'owner@antu-dbc.demo',
    kyc_status: 'approved', kyb_status: 'approved', financial_docs_complete: true, verified: true, is_demo: true
  });
  const dbcUser = auth.createUser({
    email: 'dbc@demo.local', password: 'demo1234', display_name: 'DBC 演示账号',
    role: 'DBC_OWNER', organization_id: dbcOrg.id, language: 'zh', is_demo: true
  });
  dbcUser.demo_token = DEMO_TOKENS.dbc;
  db.stores.dbc_profiles.insert({
    id: 'DBP-SEED-0001',
    organization_id: dbcOrg.id,
    licence_number: 'DBC-DEMO-0001',
    licence_status: 'active',
    agreement_files: [{ id: 'agr-file-1', name: 'DBC 牌照文件（演示）', url: null, is_demo: true }],
    state_a_only: true,
    created_at: iso()
  });

  // --- Admin -------------------------------------------------------------
  const adminUser = auth.createUser({
    email: 'admin@demo.local', password: 'demo1234', display_name: '平台管理员（演示）',
    role: 'ADMIN_SUPER', language: 'zh', is_demo: true
  });
  adminUser.demo_token = DEMO_TOKENS.admin;

  // --- B demo logins (one per seeded L2 agency so the UI flow can complete
  // whichever agency fair rotation selects) -------------------------------
  const bUser = auth.createUser({
    email: 'agent@demo.local', password: 'demo1234', display_name: '王老师（演示）',
    role: 'B_OWNER', organization_id: agencyA.id, org_role: 'Owner', language: 'zh', is_demo: true
  });
  bUser.demo_token = DEMO_TOKENS.agent;
  const bUser2 = auth.createUser({
    email: 'agent2@demo.local', password: 'demo1234', display_name: '赵老师（演示）',
    role: 'B_OWNER', organization_id: agencyA2.id, org_role: 'Owner', language: 'zh', is_demo: true
  });
  bUser2.demo_token = DEMO_TOKENS.agent2;

  // --- Ad inventory (Configurable demo defaults) --------------------------
  // Four slot types. Prices come from system config, never hard-coded here.
  const adSlots = [
    { id: 'ADI-SEARCH-SPONSORED', slot_type: 'search_ranking_sponsored', label_zh: '搜索排名赞助位', label_en: 'Search ranking sponsored slot', total: 20 },
    { id: 'ADI-BANNER-HOME', slot_type: 'banner', label_zh: '横幅广告位', label_en: 'Banner', total: 10 },
    { id: 'ADI-RECOMMENDED-SLOT', slot_type: 'recommended_slot', label_zh: '推荐位', label_en: 'Recommended slot', total: 8 },
    { id: 'ADI-SPLASH', slot_type: 'splash', label_zh: '开屏广告', label_en: 'Splash', total: 4 }
  ];
  for (const slot of adSlots) {
    db.stores.ad_inventory.insert({
      id: slot.id,
      slot_type: slot.slot_type,
      label_zh: slot.label_zh,
      label_en: slot.label_en,
      total: slot.total,
      reserved: 0,
      monthly_price: configModule.get('ads_demo_monthly_price', 100),
      currency: configModule.get('ads_default_currency', 'SGD'),
      created_at: iso()
    });
  }

  // --- Demo education institution catalogue (explicit demo defaults) -----
  db.stores.institutions.insert({
    id: 'INS-DEMO-0001',
    supplier_id: suppliers.EDUCATION.id,
    name: '南洋国际学院（演示）',
    name_en: 'Nanyang International College (Demo)',
    country_id: 'SG', city_id: 'SG-CITY-SINGAPORE',
    latitude: 1.3521, longitude: 103.8198,
    is_demo: true, verified_status: 'demo', source_url: null,
    created_at: iso()
  });

  return { seeded: true, suppliers, cProfileId: cProfile.id, agencyA: agencyA.id, agencyB: agencyB.id };
}

module.exports = { seed, ensureAccounts, DEMO_TOKENS };
