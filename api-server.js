'use strict';
// ---------------------------------------------------------------------------
// AETHEL EDU / GlobalStudy — FULL MVP V3 API server.
//
// One data model, one state machine, one contract/commission/payment/audit
// system shared by Admin / B / C / S / DBC.
//
// Layout:
//   /api/public/*   unauthenticated discovery (schools, suppliers, reference)
//   /api/auth/*     registration, demo login, session
//   /api/c/*        C-end (requires a C session)
//   /api/b/*        B-end (requires a B session)
//   /api/s/*        S-end (requires an S session, type-scoped)
//   /api/dbc/*      DBC-end (requires a DBC session, State A only)
//   /api/admin/*    Admin (requires an ADMIN session)
//   /api/ads/*      Advertising centre
// ---------------------------------------------------------------------------
const express = require('express');
const path = require('path');

const db = require('./lib/db');
const auth = require('./lib/auth');
const config = require('./lib/config');
const org = require('./lib/org');
const binding = require('./lib/binding');
const recommendation = require('./lib/recommendation');
const contracts = require('./lib/contracts');
const applications = require('./lib/applications');
const suppliers = require('./lib/supplier');
const payments = require('./lib/payments');
const seed = require('./lib/seed');
const audit = require('./lib/audit');
const { lower, upper, asNumber, round2, id: makeId } = require('./lib/util');

const VERSION = '3.0.2';
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ok = (data, meta) => (meta === undefined ? { ok: true, data } : { ok: true, data, meta });
const fail = (res, status, error, extra) => res.status(status).json({ ok: false, error, ...(extra || {}) });

// Resolve the actor once per request and attach it. Demo tokens are accepted
// only for seeded demo users.
app.use((req, res, next) => {
  const actor = auth.actorFromRequest(req);
  if (actor) {
    req.actor = actor;
    res.locals.actor = actor.user;
  }
  next();
});

function actorOf(req) { return req.actor ? req.actor.user : null; }
function requireActor(req, res) {
  const actor = actorOf(req);
  if (!actor) { fail(res, 401, '未登录'); return null; }
  return actor;
}

// Organization of the current actor (B / S / DBC).
function orgOf(actor) {
  if (!actor || !actor.organization_id) return null;
  return org.findOrganization(actor.organization_id);
}

// C profile of the current actor.
function cProfileOf(actor) {
  if (!actor) return null;
  return binding.cProfileOfUser(actor.id);
}

function requireC(req, res) {
  const actor = requireActor(req, res);
  if (!actor) return null;
  const profile = cProfileOf(actor);
  if (!profile) { fail(res, 404, '学生档案不存在'); return null; }
  req.cProfile = profile;
  return { actor, profile };
}

function requireB(req, res) {
  const actor = requireActor(req, res);
  if (!actor) return null;
  const organization = orgOf(actor);
  if (!organization || String(organization.kind).toUpperCase() !== 'B') {
    fail(res, 403, '本入口仅面向 B 端（留学机构）'); return null;
  }
  req.bOrg = organization;
  req.bProfile = org.bProfileOf(organization.id);
  return { actor, organization, profile: req.bProfile };
}

function requireS(req, res, expectedType) {
  const actor = requireActor(req, res);
  if (!actor) return null;
  const organization = orgOf(actor);
  if (!organization || String(organization.kind).toUpperCase() !== 'S') {
    fail(res, 403, '本入口仅面向 S 端（供应商）'); return null;
  }
  const supplier = suppliers.listSuppliers({}).find((s) => String(s.organization_id) === String(organization.id));
  if (!supplier) { fail(res, 404, '供应商档案不存在'); return null; }
  if (expectedType && String(supplier.type).toUpperCase() !== String(expectedType).toUpperCase()) {
    fail(res, 403, '供应商类型不匹配：本入口仅面向 ' + expectedType); return null;
  }
  req.sOrg = organization;
  req.supplier = supplier;
  return { actor, organization, supplier };
}

function requireDBC(req, res) {
  const actor = requireActor(req, res);
  if (!actor) return null;
  const organization = orgOf(actor);
  if (!organization || String(organization.kind).toUpperCase() !== 'DBC') {
    fail(res, 403, '本入口仅面向 DBC 端'); return null;
  }
  req.dbcOrg = organization;
  return { actor, organization };
}

function requireAdmin(req, res) {
  const actor = requireActor(req, res);
  if (!actor) return null;
  const role = auth.ROLES[String(actor.role).toUpperCase()];
  if (!role || role.audience !== 'ADMIN') { fail(res, 403, '本入口仅面向平台管理端'); return null; }
  return { actor };
}

// Rule 8: never leak supplier private contact channels or commission to C.
function stripForC(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(stripForC);
  if (typeof value !== 'object') return value;
  const banned = ['commission', 'commission_value', 'commission_rule', 'commission_rules',
    'net_commission', 'contact_phone', 'contact_email', 'contact_whatsapp', 'private_phone', 'private_email'];
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (banned.includes(k)) continue;
    out[k] = stripForC(v);
  }
  return out;
}

// ===========================================================================
// PUBLIC API (no auth)
// ===========================================================================
app.get('/api/health', (req, res) => {
  res.json(ok({
    status: 'ok',
    service: 'aethel-edu-globalstudy',
    version: VERSION,
    audience: 'public',
    backend: db.backend,
    persistence: db.backend === 'postgresql' ? 'PostgreSQL (DATABASE_URL)' : db.backend === 'json-file' ? 'JSON file store (durable across restarts)' : 'memory (test mode)',
    counts: db.counts(),
    clients: ['/', '/student', '/agent', '/dbc', '/supplier/education', '/supplier/medical',
      '/supplier/certification', '/supplier/visa', '/supplier/accommodation', '/supplier/finance', '/ads', '/admin'],
    feature_flags: {
      finance_enabled: config.financeEnabled(),
      insurance_enabled: Boolean(config.get('insurance_enabled', false)),
      ads_enabled: config.adsEnabled()
    },
    sandbox: {
      payment: config.get('providers.payment', {}),
      ocr: config.get('providers.ocr', {}),
      kyc: config.get('providers.kyc', {}),
      signature: config.get('providers.signature', {})
    }
  }));
});

app.get('/api/meta', (req, res) => res.json(ok({
  product: 'GlobalStudy',
  operator: config.get('brand.operator'),
  footer_zh: config.get('brand.footer_zh'),
  footer_en: config.get('brand.footer_en'),
  languages: ['zh', 'en'],
  clients: [
    { route: '/', audience: 'ALL', label_zh: '选择客户端', label_en: 'Choose a client' },
    { route: '/student', audience: 'C', label_zh: '学生 / 家长', label_en: 'Student / Parent' },
    { route: '/agent', audience: 'B', label_zh: '留学机构', label_en: 'Education agent' },
    { route: '/dbc', audience: 'DBC', label_zh: '招生牌照合作', label_en: 'DBC' },
    { route: '/supplier/education', audience: 'S', label_zh: '教育机构', label_en: 'Education' },
    { route: '/supplier/medical', audience: 'S', label_zh: '体检机构', label_en: 'Medical' },
    { route: '/supplier/certification', audience: 'S', label_zh: '文件认证', label_en: 'Certification' },
    { route: '/supplier/visa', audience: 'S', label_zh: '签证代办', label_en: 'Visa' },
    { route: '/supplier/accommodation', audience: 'S', label_zh: '学生住宿', label_en: 'Accommodation' },
    { route: '/supplier/finance', audience: 'S', label_zh: '教育金融（默认关闭）', label_en: 'Education finance (off)' },
    { route: '/ads', audience: 'S', label_zh: '广告中心', label_en: 'Ads centre' },
    { route: '/admin', audience: 'ADMIN', label_zh: '平台管理（需登录）', label_en: 'Admin (login required)' }
  ],
  data_policy: {
    demo_data_is_labeled: config.get('demo_data_requires_label', true),
    verified_data_requires_source: config.get('verified_requires_source', true),
    no_admission_probability_claims: true,
    no_financial_products_in_public_mvp: !config.financeEnabled(),
    ai_may_not_invent: config.get('ai_may_not_invent', [])
  },
  payment: payments.providerCatalog()
})));

app.get('/api/reference', (req, res) => {
  res.json(ok({
    stages: auth.STAGES,
    supplier_types: Object.values(auth.SUPPLIER_TYPES),
    reserved_supplier_types: auth.RESERVED_SUPPLIER_TYPES,
    b_levels: Object.values(auth.B_LEVELS),
    roles: Object.values(auth.ROLES).map((r) => ({ id: r.id, audience: r.audience, label_zh: r.label_zh, label_en: r.label_en, permissions: r.permissions })),
    document_types: applications.DOCUMENT_TYPES,
    payment_kinds: payments.PAYMENT_KINDS,
    commission_modes: contracts.COMMISSION_MODES
  }));
});

// Public supplier catalogue (Rule 8/20: no private contact, no commission).
app.get('/api/public/suppliers', (req, res) => {
  const type = req.query.type ? String(req.query.type).toUpperCase() : null;
  let list = suppliers.listSuppliers({ type: type || undefined, public_visible: true });
  if (req.query.q) {
    const q = String(req.query.q).toLowerCase();
    list = list.filter((s) => String(s.name).toLowerCase().includes(q) || String(s.name_en || '').toLowerCase().includes(q));
  }
  res.json(ok(list.map((s) => stripForC(suppliers.publicView(s))), { total: list.length }));
});

app.get('/api/public/suppliers/:id', (req, res) => {
  const supplier = suppliers.supplierById(req.params.id);
  if (!supplier) return fail(res, 404, '供应商不存在');
  if (!supplier.public_visible) return fail(res, 404, '供应商未公开');
  res.json(ok(stripForC(suppliers.publicView(supplier))));
});

// Public school search — the V1.0 search engine, preserved.
app.get('/api/public/schools', (req, res) => {
  const legacy = require('./server');
  const page = Math.max(1, Number.parseInt(req.query.page || '1', 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(req.query.pageSize || '12', 10) || 12));
  const list = legacy.listSchools(req.query);
  const start = (page - 1) * pageSize;
  const slice = list.slice(start, start + pageSize);
  res.json(ok(slice.map((s) => ({
    id: s.id,
    name: { en: s.name_en || s.name_zh, zh: s.name_zh || s.name_en },
    verification: {
      status: s.verified_status || 'draft', is_demo: Boolean(s.is_demo),
      verified_at: s.verified_at || null, source_url: s.source_url || null
    },
    location: s.location,
    stages: s.stages, curricula: s.curricula,
    fees: { tuition_min: s.tuition_min, tuition_max: s.tuition_max, currency: s.currency },
    transit: s.distance_label ? { distance_label: s.distance_label } : null
  })), { total: list.length, page, pageSize }));
});

// Accommodation near a school — by straight-line distance only.
app.get('/api/public/accommodation', (req, res) => {
  const { haversineMeters, distanceLabel } = require('./lib/util');
  const legacy = require('./server');
  const school = legacy.allKnownSchools().find((s) => String(s.id).toLowerCase() === String(req.query.school_id || '').toLowerCase());
  let items = db.stores.accommodations.all().filter((a) => a.is_demo || a.verified);
  if (school && Number.isFinite(Number(school.latitude)) && Number.isFinite(Number(school.longitude))) {
    items = items.map((a) => {
      const meters = Number.isFinite(Number(a.latitude)) && Number.isFinite(Number(a.longitude))
        ? haversineMeters(Number(school.latitude), Number(school.longitude), Number(a.latitude), Number(a.longitude))
        : null;
      return { ...a, distance_m: meters, distance_label: distanceLabel(meters) };
    }).filter((a) => a.distance_m !== null).sort((a, b) => a.distance_m - b.distance_m);
  }
  res.json(ok(stripForC(items), {
    total: items.length,
    note: '仅按经纬度直线距离排序；不虚构通勤时间。'
  }));
});

// ===========================================================================
// AUTH
// ===========================================================================
// Admin demo accounts are never public (Fix 5). PUBLIC_ADMIN_DEMO=false keeps
// the platform-admin role off the public demo surface entirely; the only
// legitimate admin path is the real login on /admin.
const PUBLIC_ADMIN_DEMO = () => String(process.env.PUBLIC_ADMIN_DEMO || 'false').toLowerCase() === 'true';
const isAdminRole = (roleId) => {
  const role = auth.ROLES[String(roleId || '').toUpperCase()];
  return Boolean(role && role.audience === 'ADMIN');
};

app.get('/api/auth/demo-accounts', (req, res) => {
  if (!config.get('demo_login_enabled', true)) return fail(res, 404, 'Demo 登录已关闭');
  const accounts = db.stores.users.all()
    .filter((u) => u.is_demo && u.demo_token)
    .filter((u) => PUBLIC_ADMIN_DEMO() || !isAdminRole(u.role))
    .map((u) => ({
      token: u.demo_token,
      route: auth.AUDIENCE_ROUTES[auth.ROLES[u.role].audience],
      audience: auth.ROLES[u.role].audience,
      role: u.role,
      display_name: u.display_name,
      organization_id: u.organization_id || null,
      supplier_type: (() => {
        const s = suppliers.listSuppliers({}).find((x) => String(x.organization_id) === String(u.organization_id || ''));
        return s ? s.type : null;
      })()
    }));
  res.json(ok(accounts, { note: 'Demo 一键体验账号；真实注册入口同样开放。管理员不提供公开 Demo 凭证。' }));
});

app.post('/api/auth/demo-login', (req, res) => {
  if (!config.get('demo_login_enabled', true)) return fail(res, 404, 'Demo 登录已关闭');
  const token = req.body && req.body.token;
  if (!token) return fail(res, 400, 'token 必填');
  const user = db.stores.users.all().find((u) => u.is_demo && String(u.demo_token) === String(token));
  if (!user) return fail(res, 404, 'Demo 账号不存在');
  // Server-side admin demo gate (Fix 5): not just a hidden button.
  if (isAdminRole(user.role) && !PUBLIC_ADMIN_DEMO()) {
    return fail(res, 403, '管理员不提供公开 Demo 登录');
  }
  const session = auth.createSession(user.id, { is_demo: true, ip: req.ip });
  res.status(201).json(ok({ token: session.token, user: auth.userPublic(user) }));
});

app.post('/api/auth/register', (req, res) => {
  if (!config.get('real_registration_enabled', true)) return fail(res, 403, '真实注册暂未开放');
  const body = req.body || {};
  if (!body.email && !body.phone) return fail(res, 400, '邮箱或手机号必填');
  if (body.email && auth.findUserByEmail(body.email)) return fail(res, 409, '该邮箱已注册');
  const role = String(body.role || 'C_STUDENT').toUpperCase();
  if (!auth.ROLES[role]) return fail(res, 400, '未知角色');
  if (auth.ROLES[role].audience === 'ADMIN') {
    return fail(res, 403, '公开注册不能创建管理员账号');
  }

  const user = auth.createUser({
    email: body.email, phone: body.phone, password: body.password,
    display_name: body.display_name || body.name || body.email || body.phone,
    role, language: body.language || 'zh', status: 'active',
    from_public_registration: true
  });

  // Rule 2: a self-registered C starts Unbound.
  if (role === 'C_PARENT' || role === 'C_STUDENT') {
    binding.createCProfile({
      user_id: user.id, name: body.display_name || body.name, name_en: body.name_en,
      email: body.email, phone: body.phone, nationality: body.nationality,
      education_stage: body.education_stage,
      target_countries: body.target_countries || [], target_courses: body.target_courses || [],
      language: body.language || 'zh', source: body.invite_code ? 'invite' : 'self_registration',
      invited_by: body.invite_code || null
    });
  }

  const session = auth.createSession(user.id, { ip: req.ip });
  audit.record({ actor: user, action: 'auth:register', entity: 'user', entity_id: user.id, to: { role, audience: user.audience } });
  res.status(201).json(ok({ token: session.token, user: auth.userPublic(user) }));
});

app.post('/api/auth/login', (req, res) => {
  const body = req.body || {};
  const identifier = body.email || body.phone;
  if (!identifier) return fail(res, 400, '邮箱或手机号必填');
  const user = db.stores.users.all().find((u) =>
    String(u.email || '').toLowerCase() === String(identifier).toLowerCase() ||
    String(u.phone || '') === String(identifier));
  if (!user || !auth.verifyPassword(user, body.password)) return fail(res, 401, '账号或密码错误');
  const session = auth.createSession(user.id, { ip: req.ip });
  res.json(ok({ token: session.token, user: auth.userPublic(user) }));
});

app.post('/api/auth/logout', (req, res) => {
  const header = String(req.headers['authorization'] || '');
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : req.headers['x-session-token'];
  auth.destroySession(token);
  res.json(ok({ logged_out: true }));
});

app.get('/api/auth/me', (req, res) => {
  const actor = requireActor(req, res);
  if (!actor) return;
  const payload = { user: auth.userPublic(actor) };
  if (String(actor.audience).toUpperCase() === 'C') {
    const profile = binding.cProfileOfUser(actor.id);
    if (profile) {
      payload.c_profile = profile;
      payload.capabilities = binding.cCapabilities(profile.binding_state);
    }
  }
  if (actor.organization_id) {
    const organization = org.findOrganization(actor.organization_id);
    if (organization) {
      payload.organization = organization;
      if (String(organization.kind).toUpperCase() === 'B') {
        payload.membership = org.membershipExpiryInfo(organization.id);
      }
    }
  }
  res.json(ok(payload));
});

// ===========================================================================
// C END
// ===========================================================================
const cRouter = express.Router();
// Audience gate runs BEFORE the C-profile lookup so a non-C actor gets a clean
// 403 instead of a 404 from the profile lookup.
cRouter.use((req, res, next) => {
  const actor = requireActor(req, res);
  if (!actor) return;
  const role = auth.ROLES[String(actor.role).toUpperCase()];
  if (!role || role.audience !== 'C') {
    return fail(res, 403, '本入口仅面向 C 端（学生 / 家长）');
  }
  const ctx = requireC(req, res);
  if (!ctx) return;
  next();
});

// Rule 2: what an unbound C may see/do.
cRouter.get('/capabilities', (req, res) => res.json(ok(binding.cCapabilities(req.cProfile.binding_state))));

cRouter.patch('/profile', (req, res) => {
  const profile = binding.updateCProfile(req.cProfile.id, req.body || {}, actorOf(req));
  res.json(ok(profile));
});

// Rule: C submits a requirement and gets a recommendation (3–5 Bs).
cRouter.post('/requirements', (req, res) => {
  const requirement = binding.submitRequirement(req.cProfile.id, req.body || {}, actorOf(req));
  const rec = recommendation.recommend({ ...(req.body || {}), id: requirement.id });
  res.status(201).json(ok({ requirement, recommendation: publicRecommendation(rec) }));
});

cRouter.get('/recommendations', (req, res) => {
  const list = recommendation.listRecommendations({ requirement_id: req.query.requirement_id });
  res.json(ok(list.map(publicRecommendation)));
});

// C picks a B → binding request.
cRouter.post('/bindings', async (req, res) => {
  const result = await binding.createBindingRequest({
    c_profile_id: req.cProfile.id,
    b_organization_id: req.body && req.body.b_organization_id,
    b_profile_id: req.body && req.body.b_profile_id,
    recommendation_id: req.body && req.body.recommendation_id
  }, actorOf(req));
  if (!result.ok) {
    const statusByCode = { B_NOT_ELIGIBLE: 409, B_NOT_FOUND: 404, BINDING_CONFLICT: 409 };
    const status = statusByCode[result.code] || 400;
    return fail(res, status, result.error, {
      code: result.code,
      failures: result.failures,
      binding: result.binding
    });
  }
  res.status(result.duplicate ? 200 : 201).json(ok({
    ...result.binding,
    duplicate: Boolean(result.duplicate),
    binding_id: result.binding.id
  }));
});

cRouter.get('/bindings', (req, res) => {
  const list = binding.listBindings({ c_profile_id: req.cProfile.id });
  res.json(ok(list.map((b) => bindingView(b))));
});

cRouter.get('/bindings/:id', (req, res) => {
  const b = binding.bindingById(req.params.id);
  if (!b || String(b.c_profile_id) !== String(req.cProfile.id)) return fail(res, 404, '绑定不存在');
  res.json(ok(bindingView(b)));
});

cRouter.post('/bindings/:id/sign', async (req, res) => {
  const result = await binding.signBinding(req.params.id, 'C', actorOf(req));
  if (!result.ok) return fail(res, 400, result.error);
  res.json(ok({ binding: bindingView(result.binding), contract: contractView(result.contract) }));
});

// Rule 2: an unbound C may still browse PUBLIC supplier information (the
// public catalogue has no private channels and no commission). The bound-only
// gate starts after these read-only endpoints.
cRouter.get('/suppliers', (req, res) => {
  const type = req.query.type ? String(req.query.type).toUpperCase() : null;
  const list = suppliers.listSuppliers({ type: type || undefined, public_visible: true });
  res.json(ok(list.map((s) => stripForC(suppliers.publicView(s)))));
});

cRouter.get('/suppliers/:id', (req, res) => {
  const supplier = suppliers.supplierById(req.params.id);
  if (!supplier) return fail(res, 404, '供应商不存在');
  res.json(ok(stripForC(suppliers.publicView(supplier))));
});

// Rule 2 gate: an unbound C cannot go past this point.
cRouter.use((req, res, next) => binding.requireBoundC(req, res, next));

cRouter.get('/me', (req, res) => {
  const active = binding.currentBinding(req.cProfile.id);
  const caps = binding.cCapabilities(req.cProfile.binding_state);
  res.json(ok({
    profile: req.cProfile,
    binding_state: req.cProfile.binding_state,
    capabilities: caps,
    binding: active ? bindingView(active) : null,
    contract: active && active.contract_id ? contractView(contracts.agreementById(active.contract_id)) : null
  }));
});

// My B (Rule: C 可见服务机构 / 顾问 / 合同 / 绑定时间 / 状态 / 服务范围)
cRouter.get('/my-b', (req, res) => {
  const active = binding.currentBinding(req.cProfile.id);
  if (!active) return fail(res, 404, '尚未绑定服务机构');
  const organization = org.findOrganization(active.b_organization_id);
  const profile = org.bProfileOf(active.b_organization_id);
  res.json(ok({
    binding: bindingView(active),
    organization: {
      id: organization.id, name: organization.name, name_en: organization.name_en,
      country: organization.country, city: organization.city, verified: organization.verified
    },
    service_scope: profile ? {
      service_countries: profile.service_countries, service_courses: profile.service_courses,
      service_types: profile.service_types, languages: profile.languages
    } : null,
    contract: active.contract_id ? contractView(contracts.agreementById(active.contract_id)) : null
  }));
});

// Applications (S0–S10)
cRouter.post('/applications', (req, res) => {
  const result = applications.createApplication({
    c_profile_id: req.cProfile.id,
    supplier_id: req.body && req.body.supplier_id,
    product_id: req.body && req.body.product_id,
    institution_id: req.body && req.body.institution_id,
    program_id: req.body && req.body.program_id,
    title: req.body && req.body.title
  }, actorOf(req));
  if (!result.ok) return fail(res, 403, result.error, { code: result.code });
  res.status(201).json(ok(applications.applicationDetail(result.application.id)));
});

cRouter.get('/applications', (req, res) => {
  const list = applications.listApplications({ c_profile_id: req.cProfile.id });
  res.json(ok(list.map((a) => applications.applicationDetail(a.id))));
});

cRouter.get('/applications/:id', (req, res) => {
  const app = applications.applicationById(req.params.id);
  if (!app || String(app.c_profile_id) !== String(req.cProfile.id)) return fail(res, 404, '申请不存在');
  res.json(ok(applications.applicationDetail(app.id)));
});

cRouter.get('/applications/:id/timeline', (req, res) => {
  const app = applications.applicationById(req.params.id);
  if (!app || String(app.c_profile_id) !== String(req.cProfile.id)) return fail(res, 404, '申请不存在');
  res.json(ok(applications.timelineView(app.id)));
});

// Material centre
cRouter.post('/applications/:id/documents', (req, res) => {
  const app = applications.applicationById(req.params.id);
  if (!app || String(app.c_profile_id) !== String(req.cProfile.id)) return fail(res, 404, '申请不存在');
  const result = applications.uploadDocument(app.id, req.body || {}, actorOf(req));
  if (!result.ok) return fail(res, 400, result.error);
  res.status(201).json(ok(result));
});

cRouter.get('/documents', (req, res) => res.json(ok(applications.familyLibraryOfC(req.cProfile.id))));

cRouter.get('/applications/:id/documents', (req, res) => {
  const app = applications.applicationById(req.params.id);
  if (!app || String(app.c_profile_id) !== String(req.cProfile.id)) return fail(res, 404, '申请不存在');
  res.json(ok(applications.documentsOf(app.id)));
});

// OCR family library: one upload, reused across applications.
cRouter.post('/documents/:id/authorize', (req, res) => {
  const doc = db.stores.family_documents.byId(req.params.id);
  if (!doc || String(doc.c_profile_id) !== String(req.cProfile.id)) return fail(res, 404, '材料不存在');
  const result = applications.authorizeDocument(doc.id, {
    type: req.body && req.body.grantee_type, id: req.body && req.body.grantee_id
  }, req.body && req.body.scope, actorOf(req), req.body && req.body.expires_in_days);
  res.status(201).json(ok(result));
});

// Visa centre — C only reads steps/progress/todos/result.
cRouter.get('/applications/:id/visa', (req, res) => {
  const app = applications.applicationById(req.params.id);
  if (!app || String(app.c_profile_id) !== String(req.cProfile.id)) return fail(res, 404, '申请不存在');
  const visaCase = db.stores.visa_cases.find((v) => String(v.application_id) === String(app.id));
  if (!visaCase) return res.json(ok({ status: 'not_started', steps: [], todos: [], result: null }));
  res.json(ok({
    status: visaCase.status,
    steps: visaCase.steps || [],
    todos: applications.listTodos({ application_id: app.id }).filter((t) => String(t.stage) === 'S7'),
    result: db.stores.visa_results.filter((r) => String(r.visa_case_id) === String(visaCase.id))
  }));
});

// Payments (Rule 10: C may self-pay; commission still belongs to the bound B)
cRouter.post('/payments', (req, res) => {
  const body = req.body || {};
  const result = payments.createIntent({
    kind: body.kind,
    amount: body.amount,
    currency: body.currency,
    payer_type: 'C', payer_id: req.cProfile.id,
    application_id: body.application_id,
    reference_rate: body.reference_rate,
    rate_timestamp: body.rate_timestamp,
    description: body.description
  }, actorOf(req));
  if (!result.ok) return fail(res, 400, result.error);
  res.status(201).json(ok(paymentView(result.intent)));
});

cRouter.post('/payments/:id/confirm', (req, res) => {
  const intent = payments.intentById(req.params.id);
  if (!intent || String(intent.payer_id) !== String(req.cProfile.id)) return fail(res, 404, '支付单不存在');
  const result = payments.confirmIntent(intent.id, req.body, actorOf(req));
  if (!result.ok) return fail(res, 400, result.error);
  res.json(ok({
    payment: paymentView(result.intent),
    receipt: result.receipt,
    sandbox: result.receipt.sandbox
  }));
});

// Refund — allowed for the paying C and for platform finance roles.
cRouter.post('/payments/:id/refund', (req, res) => {
  const intent = payments.intentById(req.params.id);
  if (!intent || String(intent.payer_id) !== String(req.cProfile.id)) return fail(res, 404, '支付单不存在');
  const result = payments.refundIntent(intent.id, req.body, actorOf(req));
  if (!result.ok) return fail(res, 400, result.error);
  res.json(ok({
    payment: paymentView(result.intent),
    refund: result.refund,
    clawed_back_commission: result.clawed_back_commission,
    sandbox: Boolean(result.refund.sandbox)
  }));
});

cRouter.get('/payments', (req, res) => {
  const list = payments.listIntents({ payer_id: req.cProfile.id });
  res.json(ok(list.map((i) => paymentView(i))));
});

// Reviews (only after admission; never about commission)
cRouter.post('/reviews', (req, res) => {
  const supplier = suppliers.supplierById(req.body && req.body.supplier_id);
  if (!supplier) return fail(res, 404, '供应商不存在');
  const review = db.stores.reviews.insert({
    id: require('./lib/util').id('review'),
    supplier_id: supplier.id,
    c_profile_id: req.cProfile.id,
    application_id: (req.body && req.body.application_id) || null,
    rating: Number(req.body && req.body.rating) || 5,
    content: req.body && req.body.content || null,
    status: 'published',
    created_at: new Date().toISOString()
  });
  audit.record({ actor: actorOf(req), action: 'review:create', entity: 'review', entity_id: review.id, to: review });
  res.status(201).json(ok(review));
});

// Messages — real in-app messaging.
cRouter.get('/messages', (req, res) => res.json(ok(messagesFor('C', req.cProfile.id))));
cRouter.post('/messages', (req, res) => {
  const msg = db.stores.messages.insert({
    id: require('./lib/util').id('message'),
    thread_id: req.body && req.body.thread_id,
    from_type: 'C', from_id: req.cProfile.id,
    to_type: req.body && req.body.to_type, to_id: req.body && req.body.to_id,
    body: req.body && req.body.body || '',
    created_at: new Date().toISOString(),
    read_at: null
  });
  audit.record({ actor: actorOf(req), action: 'message:create', entity: 'message', entity_id: msg.id, to: { to_type: msg.to_type } });
  res.status(201).json(ok(msg));
});

// Todos + daily brief
cRouter.get('/todos', (req, res) => res.json(ok(applications.listTodos({ c_profile_id: req.cProfile.id }))));
cRouter.get('/brief', (req, res) => res.json(ok(buildBrief('C', req.cProfile.id))));

// Unbind / rebinding (Rules 12, 13)
cRouter.post('/unbind', (req, res) => {
  const result = binding.unbind(req.cProfile.id, req.body && req.body.reason, actorOf(req));
  if (!result.ok) return fail(res, 400, result.error);
  res.json(ok(result.binding));
});

cRouter.get('/rebinding/check', (req, res) => res.json(ok(binding.rebindingCheck(req.cProfile.id))));

cRouter.post('/rebinding', (req, res) => {
  const result = binding.requestRebinding({
    c_profile_id: req.cProfile.id,
    new_b_organization_id: req.body && req.body.new_b_organization_id,
    new_b_profile_id: req.body && req.body.new_b_profile_id,
    recommendation_id: req.body && req.body.recommendation_id
  }, actorOf(req));
  if (!result.ok) return fail(res, 400, result.error, { protection: result.check });
  res.status(201).json(ok({ binding: result.binding, protection: result.protection }));
});

app.use('/api/c', cRouter);

// ===========================================================================
// B END
// ===========================================================================
const bRouter = express.Router();
bRouter.use((req, res, next) => {
  const ctx = requireB(req, res);
  if (!ctx) return;
  next();
});

bRouter.get('/me', (req, res) => {
  const profile = req.bProfile;
  res.json(ok({
    organization: req.bOrg,
    profile,
    membership: org.membershipExpiryInfo(req.bOrg.id),
    membership_valid: org.membershipValid(req.bOrg.id),
    order_capacity: recommendation.orderCapacity(req.bOrg.id),
    capabilities: binding.cCapabilities('active')
  }));
});

bRouter.patch('/profile', (req, res) => {
  const body = req.body || {};
  const organization = org.updateOrganization(req.bOrg.id, {
    name: body.name, name_en: body.name_en, contact_email: body.contact_email,
    contact_phone: body.contact_phone, website: body.website
  }, actorOf(req));
  const profile = org.updateBProfile(req.bProfile.id, body, actorOf(req));
  res.json(ok({ organization, profile }));
});

// Rule 4/5: the C-recommendation switch lives on the B profile.
bRouter.post('/recommendation-switch', (req, res) => {
  const paused = Boolean(req.body && req.body.paused);
  const accepts = req.body && req.body.accepts_platform_recommendation !== undefined
    ? Boolean(req.body.accepts_platform_recommendation) : undefined;
  const patch = { recommendation_paused: paused };
  if (accepts !== undefined) patch.accepts_platform_recommendation = accepts;
  const profile = org.updateBProfile(req.bProfile.id, patch, actorOf(req));
  audit.record({ actor: actorOf(req), action: 'b:recommendation_switch', entity: 'b_profile', entity_id: profile.id, to: patch });
  res.json(ok(profile));
});

bRouter.get('/admission', (req, res) => {
  const gate = recommendation.evaluateAdmission(req.bProfile, req.query.requirement_id ? { id: req.query.requirement_id } : {});
  res.json(ok({
    b_profile_id: req.bProfile.id,
    eligible: gate.eligible,
    failures: gate.failures,
    membership: org.membershipExpiryInfo(req.bOrg.id),
    order_capacity: recommendation.orderCapacity(req.bOrg.id)
  }));
});

// Binding requests addressed to this B.
bRouter.get('/binding-requests', (req, res) => {
  const list = binding.listBindings({ b_organization_id: req.bOrg.id, status: 'pending_b_request' });
  res.json(ok(list.map((b) => bindingRequestViewForB(b))));
});

bRouter.post('/binding-requests/:id/respond', async (req, res) => {
  const result = await binding.bRespond(req.params.id, req.body && req.body.response, actorOf(req), { note: req.body && req.body.note });
  if (!result.ok) return fail(res, 400, result.error, result.capacity ? { capacity: result.capacity } : undefined);
  res.json(ok({ binding: bindingView(result.binding), contract: result.contract ? contractView(result.contract) : null }));
});

bRouter.post('/binding-requests/:id/sign', async (req, res) => {
  const result = await binding.signBinding(req.params.id, 'B', actorOf(req));
  if (!result.ok) return fail(res, 400, result.error);
  res.json(ok({ binding: bindingView(result.binding), contract: contractView(result.contract) }));
});

// Rebinding consents (Rule 12).
bRouter.post('/binding-requests/:id/consent', (req, res) => {
  const result = binding.recordRebindingConsent(req.params.id, req.body && req.body.party, actorOf(req));
  if (!result.ok) return fail(res, 400, result.error);
  res.json(ok(result.binding));
});

// C client pool: platform-recommended + B-invited + natural registrations.
bRouter.get('/clients', (req, res) => {
  const bindings = binding.listBindings({ b_organization_id: req.bOrg.id });
  const active = bindings.filter((b) => String(b.status).toLowerCase() === 'active');
  res.json(ok({
    active: active.map((b) => {
      const c = binding.cProfileById(b.c_profile_id);
      return { binding: bindingView(b), c_profile: c };
    }),
    pending: bindings.filter((b) => ['pending_b_request', 'pending_contract', 'pending_c_signature', 'pending_b_signature'].includes(String(b.status).toLowerCase()))
      .map((b) => ({ binding: bindingView(b), c_profile: binding.cProfileById(b.c_profile_id) })),
    historical: bindings.filter((b) => ['unbound', 'rejected_by_b', 'superseded_by_platform'].includes(String(b.status).toLowerCase()))
      .map((b) => bindingView(b))
  }));
});

bRouter.get('/clients/:cProfileId', (req, res) => {
  const b = binding.listBindings({ b_organization_id: req.bOrg.id }).find((x) => String(x.c_profile_id) === String(req.params.cProfileId));
  if (!b) return fail(res, 404, '客户不存在');
  const c = binding.cProfileById(b.c_profile_id);
  const apps = applications.listApplications({ b_organization_id: req.bOrg.id }).filter((a) => String(a.c_profile_id) === String(req.params.cProfileId));
  res.json(ok({
    binding: bindingView(b),
    c_profile: c,
    applications: apps.map((a) => applications.applicationDetail(a.id)),
    documents: applications.familyLibraryOfC(c.id).map((d) => documentView(d))
  }));
});

// S resource centre (B-side view includes cooperation + commission rules).
bRouter.get('/suppliers', (req, res) => {
  const type = req.query.type ? String(req.query.type).toUpperCase() : null;
  const list = suppliers.listSuppliers({ type: type || undefined, public_visible: true });
  res.json(ok(list.map((s) => suppliers.bView(s))));
});

bRouter.get('/suppliers/:id', (req, res) => {
  const supplier = suppliers.supplierById(req.params.id);
  if (!supplier) return fail(res, 404, '供应商不存在');
  res.json(ok(suppliers.bView(supplier)));
});

// Applications (S0–S10)
bRouter.get('/applications', (req, res) => {
  const list = applications.listApplications({ b_organization_id: req.bOrg.id });
  res.json(ok(list.map((a) => applications.applicationDetail(a.id))));
});

bRouter.post('/applications', (req, res) => {
  const result = applications.createApplication({
    c_profile_id: req.body && req.body.c_profile_id,
    supplier_id: req.body && req.body.supplier_id,
    product_id: req.body && req.body.product_id,
    institution_id: req.body && req.body.institution_id,
    program_id: req.body && req.body.program_id,
    title: req.body && req.body.title
  }, actorOf(req));
  if (!result.ok) return fail(res, 403, result.error, { code: result.code });
  res.status(201).json(ok(applications.applicationDetail(result.application.id)));
});

bRouter.post('/applications/:id/transition', (req, res) => {
  const app = applications.applicationById(req.params.id);
  if (!app || String(app.b_organization_id) !== String(req.bOrg.id)) return fail(res, 404, '申请不存在');
  const result = applications.transition(app.id, req.body && req.body.target, actorOf(req), { force: Boolean(req.body && req.body.force), note: req.body && req.body.note });
  if (!result.ok) return fail(res, 400, result.error, { blocking: result.blocking, code: result.code });
  res.json(ok(applications.applicationDetail(app.id)));
});

bRouter.get('/kanban', (req, res) => res.json(ok(applications.kanban({ b_organization_id: req.bOrg.id }))));

// Documents: B confirms C uploads.
bRouter.post('/documents/:id/confirm', (req, res) => {
  const doc = db.stores.family_documents.byId(req.params.id);
  if (!doc) return fail(res, 404, '材料不存在');
  const app = applications.applicationById(doc.application_id);
  if (!app || String(app.b_organization_id) !== String(req.bOrg.id)) return fail(res, 403, '无权确认该材料');
  const result = applications.confirmDocument(doc.id, 'B', actorOf(req), req.body && req.body.note);
  if (!result.ok) return fail(res, 400, result.error);
  res.json(ok(documentView(result.document)));
});

bRouter.post('/applications/:id/todos', (req, res) => {
  const app = applications.applicationById(req.params.id);
  if (!app || String(app.b_organization_id) !== String(req.bOrg.id)) return fail(res, 404, '申请不存在');
  const todo = applications.addTodo(app.id, req.body || {}, actorOf(req));
  res.status(201).json(ok(todo));
});

bRouter.post('/todos/:id/complete', (req, res) => {
  const result = applications.completeTodo(req.params.id, actorOf(req));
  if (!result.ok) return fail(res, 400, result.error);
  res.json(ok(result.todo));
});

bRouter.get('/todos', (req, res) => res.json(ok(applications.listTodos({ b_organization_id: req.bOrg.id }))));

// Visa — B enters the real visa outcome.
bRouter.put('/applications/:id/visa', (req, res) => {
  const app = applications.applicationById(req.params.id);
  if (!app || String(app.b_organization_id) !== String(req.bOrg.id)) return fail(res, 404, '申请不存在');
  const result = upsertVisaCase(app.id, req.body || {}, actorOf(req));
  res.json(ok(result));
});

// Payments (application fee / registration fee / service fee).
bRouter.get('/payments', (req, res) => {
  const myApps = new Set(applications.listApplications({ b_organization_id: req.bOrg.id }).map((a) => a.id));
  const list = payments.listIntents({}).filter((i) => myApps.has(String(i.related.application_id)));
  res.json(ok(list.map((i) => paymentView(i))));
});

bRouter.post('/payments', (req, res) => {
  const result = payments.createIntent({
    kind: req.body && req.body.kind,
    amount: req.body && req.body.amount,
    currency: req.body && req.body.currency,
    payer_type: 'B', payer_id: req.bOrg.id,
    application_id: req.body && req.body.application_id,
    reference_rate: req.body && req.body.reference_rate,
    rate_timestamp: req.body && req.body.rate_timestamp
  }, actorOf(req));
  if (!result.ok) return fail(res, 400, result.error);
  res.status(201).json(ok(paymentView(result.intent)));
});

bRouter.post('/payments/:id/confirm', (req, res) => {
  const result = payments.confirmIntent(req.params.id, req.body, actorOf(req));
  if (!result.ok) return fail(res, 400, result.error);
  res.json(ok({ payment: paymentView(result.intent), receipt: result.receipt }));
});

// Contracts (B-C / B-S / DBC-B)
bRouter.get('/contracts', (req, res) => {
  const list = contracts.listAgreements({ b_organization_id: req.bOrg.id });
  res.json(ok(list.map(contractView)));
});

bRouter.get('/contracts/:id', (req, res) => {
  const agreement = contracts.agreementById(req.params.id);
  if (!agreement || String(agreement.b_organization_id) !== String(req.bOrg.id)) return fail(res, 404, '合同不存在');
  res.json(ok(contractView(agreement)));
});

// Settlement centre
bRouter.get('/settlements', (req, res) => res.json(ok(contracts.listSettlements({ b_organization_id: req.bOrg.id }))));
bRouter.get('/commission', (req, res) => {
  const ledger = contracts.commissionLedgerOf(req.bOrg.id);
  res.json(ok({
    ledger,
    summary: {
      projected: sumOf(ledger, 'projected'), confirmed: sumOf(ledger, 'confirmed'),
      receivable: sumOf(ledger, 'receivable'), received: sumOf(ledger, 'received'),
      payable: sumOf(ledger, 'payable'), paid: sumOf(ledger, 'paid'),
      clawed_back: sumOf(ledger, 'clawed_back')
    },
    currency: config.get('commission_default_currency', 'SGD')
  }));
});

bRouter.post('/settlements/:id/advance', (req, res) => {
  const settlement = contracts.settlementById(req.params.id);
  if (!settlement || String(settlement.b_organization_id) !== String(req.bOrg.id)) return fail(res, 404, '结算单不存在');
  const result = contracts.advanceSettlement(settlement.id, req.body && req.body.target, actorOf(req));
  if (!result.ok) return fail(res, 400, result.error);
  res.json(ok(result.settlement));
});

// Performance / health / assistant / team / disputes
bRouter.get('/performance', (req, res) => {
  const apps = applications.listApplications({ b_organization_id: req.bOrg.id });
  const ledger = contracts.commissionLedgerOf(req.bOrg.id);
  res.json(ok({
    applications: apps.length,
    admitted: apps.filter((a) => auth.STAGE_CODES.indexOf(a.current_stage) >= auth.STAGE_CODES.indexOf('S5')).length,
    enrolled: apps.filter((a) => a.current_stage === 'S9' || a.current_stage === 'S10').length,
    commission_total: ledger.reduce((s, e) => s + Number(e.amount || 0), 0),
    targets: config.get('b_targets', { monthly_applications: 20, monthly_admissions: 8 }),
    warnings: buildTargetWarnings(apps)
  }));
});

bRouter.get('/health', (req, res) => res.json(ok(explainableHealth(req.bProfile, req.bOrg.id))));

bRouter.post('/assistant', (req, res) => {
  // Query / explain / match / missing documents / contract summary / todo
  // summary only. No fund mutation, no signing, no visa submission.
  const answer = assistantAnswer(req.body || {}, req.bOrg.id, actorOf(req));
  res.json(ok(answer));
});

bRouter.get('/team', (req, res) => {
  const members = db.stores.users.all().filter((u) => String(u.organization_id) === String(req.bOrg.id));
  res.json(ok(members.map((u) => ({ id: u.id, display_name: u.display_name, role: u.role, org_role: u.org_role, status: u.status }))));
});

bRouter.post('/team', (req, res) => {
  const body = req.body || {};
  const user = auth.createUser({
    email: body.email, phone: body.phone, password: body.password,
    display_name: body.display_name, role: body.role || 'B_COUNSELLOR',
    organization_id: req.bOrg.id, org_role: body.org_role || 'Member', language: body.language || 'zh'
  });
  res.status(201).json(ok({ id: user.id, role: user.role, org_role: user.org_role, permissions: auth.permissionsOf(user.role) }));
});

bRouter.get('/disputes', (req, res) => {
  const list = db.stores.disputes.all().filter((d) => String(d.b_organization_id) === String(req.bOrg.id));
  res.json(ok(list));
});

bRouter.post('/disputes', (req, res) => {
  const body = req.body || {};
  const dispute = db.stores.disputes.insert({
    id: require('./lib/util').id('dispute'),
    b_organization_id: req.bOrg.id,
    supplier_id: body.supplier_id || null,
    application_id: body.application_id || null,
    subject: body.subject || '',
    description: body.description || '',
    status: 'open',
    created_at: new Date().toISOString()
  });
  audit.record({ actor: actorOf(req), action: 'dispute:create', entity: 'dispute', entity_id: dispute.id, to: dispute });
  res.status(201).json(ok(dispute));
});

bRouter.post('/disputes/:id/evidence', (req, res) => {
  const dispute = db.stores.disputes.byId(req.params.id);
  if (!dispute || String(dispute.b_organization_id) !== String(req.bOrg.id)) return fail(res, 404, '争议不存在');
  const evidence = db.stores.dispute_evidence.insert({
    id: require('./lib/util').id('dispute_evidence'),
    dispute_id: dispute.id,
    kind: req.body && req.body.kind || 'document',
    source_url: req.body && req.body.source_url || null,
    note: req.body && req.body.note || null,
    uploaded_by: actorOf(req) ? actorOf(req).id : null,
    created_at: new Date().toISOString()
  });
  audit.record({ actor: actorOf(req), action: 'dispute:evidence', entity: 'dispute', entity_id: dispute.id, to: evidence });
  res.status(201).json(ok(evidence));
});

bRouter.get('/messages', (req, res) => res.json(ok(messagesFor('B', req.bOrg.id))));
bRouter.post('/messages', (req, res) => {
  const msg = db.stores.messages.insert({
    id: require('./lib/util').id('message'),
    thread_id: req.body && req.body.thread_id,
    from_type: 'B', from_id: req.bOrg.id,
    to_type: req.body && req.body.to_type, to_id: req.body && req.body.to_id,
    body: req.body && req.body.body || '',
    created_at: new Date().toISOString(), read_at: null
  });
  res.status(201).json(ok(msg));
});

bRouter.get('/brief', (req, res) => res.json(ok(buildBrief('B', req.bOrg.id))));
bRouter.get('/recommendations', (req, res) => res.json(ok(recommendation.recommendationForB(req.bOrg.id))));

app.use('/api/b', bRouter);

// ===========================================================================
// S END — one router, type-scoped (no six copies of the system)
// ===========================================================================
function sRouterFor(type) {
  const router = express.Router();
  router.use((req, res, next) => {
    const ctx = requireS(req, res, type);
    if (!ctx) return;
    next();
  });

  router.get('/me', (req, res) => {
    res.json(ok({
      supplier: req.supplier,
      organization: req.sOrg,
      profile: suppliers.profileOfSupplier(req.supplier.id),
      type: req.supplier.type,
      finance_enabled: config.financeEnabled()
    }));
  });

  router.patch('/profile', (req, res) => {
    const body = req.body || {};
    if (body.name) { req.supplier.name = body.name; req.supplier.updated_at = new Date().toISOString(); }
    const profile = suppliers.updateProfile(req.supplier.id, body, actorOf(req));
    res.json(ok({ supplier: req.supplier, profile }));
  });

  // Applications routed to this supplier.
  router.get('/applications', (req, res) => {
    const list = applications.listApplications({ supplier_id: req.supplier.id });
    res.json(ok(list.map((a) => applications.applicationDetail(a.id))));
  });

  router.get('/kanban', (req, res) => res.json(ok(applications.kanban({ supplier_id: req.supplier.id }))));

  router.post('/applications/:id/transition', (req, res) => {
    const app = applications.applicationById(req.params.id);
    if (!app || String(app.supplier_id) !== String(req.supplier.id)) return fail(res, 404, '申请不存在');
    const result = applications.transition(app.id, req.body && req.body.target, actorOf(req), { force: Boolean(req.body && req.body.force) });
    if (!result.ok) return fail(res, 400, result.error, { blocking: result.blocking, code: result.code });
    res.json(ok(applications.applicationDetail(app.id)));
  });

  // Education admission workflow (S1)
  router.get('/admissions', (req, res) => {
    if (String(req.supplier.type).toUpperCase() !== 'EDUCATION') return fail(res, 400, '仅教育机构供应商可用');
    res.json(ok(db.stores.applications.all().filter((a) => String(a.supplier_id) === String(req.supplier.id)).map((a) => ({
      application_id: a.id, status: a.status, workflow: suppliers.DEFAULT_ADMISSION_WORKFLOW
    }))));
  });

  router.put('/admissions/:applicationId', (req, res) => {
    if (String(req.supplier.type).toUpperCase() !== 'EDUCATION') return fail(res, 400, '仅教育机构供应商可用');
    const app = applications.applicationById(req.params.applicationId);
    if (!app || String(app.supplier_id) !== String(req.supplier.id)) return fail(res, 404, '申请不存在');
    const status = String(req.body && req.body.status || '').toLowerCase();
    if (!suppliers.DEFAULT_ADMISSION_WORKFLOW.includes(status)) return fail(res, 400, '未知录取状态');
    app.admission_status = status;
    app.updated_at = new Date().toISOString();
    audit.record({ actor: actorOf(req), action: 's:admission_status', entity: 'application', entity_id: app.id, to: { status } });
    res.json(ok(app));
  });

  // Documents: S confirms after B (three-way).
  router.get('/documents', (req, res) => {
    const appIds = new Set(applications.listApplications({ supplier_id: req.supplier.id }).map((a) => a.id));
    const list = db.stores.family_documents.all().filter((d) => appIds.has(String(d.application_id)));
    res.json(ok(list.map((d) => documentView(d))));
  });

  router.post('/documents/:id/confirm', (req, res) => {
    const doc = db.stores.family_documents.byId(req.params.id);
    if (!doc) return fail(res, 404, '材料不存在');
    const app = applications.applicationById(doc.application_id);
    if (!app || String(app.supplier_id) !== String(req.supplier.id)) return fail(res, 403, '无权确认该材料');
    const result = applications.confirmDocument(doc.id, 'S', actorOf(req), req.body && req.body.note);
    if (!result.ok) return fail(res, 400, result.error);
    res.json(ok(documentView(result.document)));
  });

  // Family document library — read-only, authorization-gated.
  router.get('/family-documents', (req, res) => {
    const appIds = new Set(applications.listApplications({ supplier_id: req.supplier.id }).map((a) => a.id));
    const docs = db.stores.family_documents.all().filter((d) => appIds.has(String(d.application_id)));
    const readable = docs.filter((d) => applications.canReadDocument(d.id, 'S', req.supplier.id));
    res.json(ok({
      authorized: readable.map((d) => documentView(d)),
      pending_authorization: docs.filter((d) => !readable.includes(d)).map((d) => ({
        id: d.id, type: d.type, file_name: d.file_name, status: d.status,
        authorization_required: true
      }))
    }));
  });

  router.get('/visa', (req, res) => {
    // S visa agencies see only authorised students (S4 rule).
    const appIds = new Set(applications.listApplications({ supplier_id: req.supplier.id }).map((a) => a.id));
    const cases = db.stores.visa_cases.all().filter((v) => appIds.has(String(v.application_id)));
    res.json(ok(cases.map((v) => ({
      id: v.id, application_id: v.application_id, status: v.status,
      steps: v.steps || [], result: db.stores.visa_results.filter((r) => String(r.visa_case_id) === String(v.id))
    }))));
  });

  // Commission rules + settlement.
  router.get('/commission', (req, res) => {
    const rules = contracts.listCommissionRules({ supplier_id: req.supplier.id });
    res.json(ok({
      rules: rules.map((r) => ({ ...r, is_demo: Boolean(r.is_demo) })),
      ledger: db.stores.commission_ledger.all().filter((l) => String(l.supplier_id) === String(req.supplier.id)),
      note: '演示规则仅用于验证计算逻辑，不代表真实商业条款。'
    }));
  });

  router.post('/commission/rules', (req, res) => {
    const body = req.body || {};
    const rule = contracts.createCommissionRule({
      supplier_id: req.supplier.id,
      b_organization_id: body.b_organization_id,
      agreement_id: body.agreement_id,
      product_id: body.product_id,
      mode: body.mode, value: body.value, currency: body.currency,
      tiers: body.tiers, bonus_value: body.bonus_value, renewal_value: body.renewal_value,
      periods: body.periods, trigger_event: body.trigger_event,
      is_demo: body.is_demo !== undefined ? Boolean(body.is_demo) : true,
      source_document: body.source_document
    }, actorOf(req));
    res.status(201).json(ok(rule));
  });

  router.get('/settlements', (req, res) => res.json(ok(contracts.listSettlements({ supplier_id: req.supplier.id }))));

  router.get('/agreements', (req, res) => res.json(ok(contracts.listAgreements({ supplier_id: req.supplier.id }).map(contractView))));

  router.get('/messages', (req, res) => res.json(ok(messagesFor('S', req.supplier.id))));
  router.post('/messages', (req, res) => {
    const msg = db.stores.messages.insert({
      id: require('./lib/util').id('message'),
      thread_id: req.body && req.body.thread_id,
      from_type: 'S', from_id: req.supplier.id,
      to_type: req.body && req.body.to_type, to_id: req.body && req.body.to_id,
      body: req.body && req.body.body || '',
      created_at: new Date().toISOString(), read_at: null
    });
    res.status(201).json(ok(msg));
  });

  router.get('/todos', (req, res) => res.json(ok(applications.listTodos({ supplier_id: req.supplier.id }))));
  router.get('/brief', (req, res) => res.json(ok(buildBrief('S', req.supplier.id))));
  router.get('/audit', (req, res) => res.json(ok(audit.query({ entity: 'supplier', entity_id: req.supplier.id }).slice(0, 50))));

  return router;
}

// Type-specific extras -------------------------------------------------------
function medicalRouter() {
  const router = sRouterFor('MEDICAL');
  router.get('/orders', (req, res) => {
    const list = db.stores.medical_orders.all().filter((o) => String(o.supplier_id) === String(req.supplier.id));
    res.json(ok(list));
  });
  router.post('/orders', (req, res) => {
    const body = req.body || {};
    // MVP stores no medical diagnosis.
    const order = db.stores.medical_orders.insert({
      id: require('./lib/util').id('medical_order'),
      supplier_id: req.supplier.id,
      application_id: body.application_id || null,
      c_profile_id: body.c_profile_id || null,
      service_id: body.service_id || null,
      status: 'requested',
      appointment_at: body.appointment_at || null,
      completed_at: null,
      report_file: null,
      meets_study_requirement: null,
      created_at: new Date().toISOString()
    });
    res.status(201).json(ok(order));
  });
  router.post('/orders/:id/status', (req, res) => {
    const order = db.stores.medical_orders.byId(req.params.id);
    if (!order || String(order.supplier_id) !== String(req.supplier.id)) return fail(res, 404, '体检委托不存在');
    const status = String(req.body && req.body.status || '').toLowerCase();
    if (!['requested', 'scheduled', 'completed', 'cancelled'].includes(status)) return fail(res, 400, '未知体检状态');
    order.status = status;
    if (status === 'completed') {
      order.completed_at = new Date().toISOString();
      order.report_file = (req.body && req.body.report_file) || null;
      order.meets_study_requirement = req.body && req.body.meets_study_requirement !== undefined
        ? Boolean(req.body.meets_study_requirement) : null;
    }
    audit.record({ actor: actorOf(req), action: 's:medical_status', entity: 'medical_order', entity_id: order.id, to: { status } });
    res.json(ok(order));
  });
  return router;
}

function certificationRouter() {
  const router = sRouterFor('CERTIFICATION');
  router.get('/orders', (req, res) => {
    const list = db.stores.certification_orders.all().filter((o) => String(o.supplier_id) === String(req.supplier.id));
    res.json(ok(list));
  });
  router.post('/orders', (req, res) => {
    const body = req.body || {};
    const order = db.stores.certification_orders.insert({
      id: require('./lib/util').id('certification_order'),
      supplier_id: req.supplier.id,
      application_id: body.application_id || null,
      c_profile_id: body.c_profile_id || null,
      service_id: body.service_id || null,
      certification_type: body.certification_type || 'degree',
      status: 'requested',
      additional_documents_required: null,
      report_file: null,
      created_at: new Date().toISOString()
    });
    res.status(201).json(ok(order));
  });
  router.post('/orders/:id/status', (req, res) => {
    const order = db.stores.certification_orders.byId(req.params.id);
    if (!order || String(order.supplier_id) !== String(req.supplier.id)) return fail(res, 404, '认证委托不存在');
    const status = String(req.body && req.body.status || '').toLowerCase();
    if (!['requested', 'documents_review', 'additional_documents', 'processing', 'completed', 'cancelled'].includes(status)) {
      return fail(res, 400, '未知认证状态');
    }
    order.status = status;
    if (status === 'completed') order.report_file = (req.body && req.body.report_file) || null;
    if (status === 'additional_documents') order.additional_documents_required = (req.body && req.body.required) || null;
    audit.record({ actor: actorOf(req), action: 's:certification_status', entity: 'certification_order', entity_id: order.id, to: { status } });
    res.json(ok(order));
  });
  return router;
}

function visaRouter() {
  const router = sRouterFor('VISA');
  router.get('/orders', (req, res) => {
    const list = db.stores.visa_orders.all().filter((o) => String(o.supplier_id) === String(req.supplier.id));
    res.json(ok(list));
  });
  router.post('/orders', (req, res) => {
    const body = req.body || {};
    const order = db.stores.visa_orders.insert({
      id: require('./lib/util').id('visa_order'),
      supplier_id: req.supplier.id,
      application_id: body.application_id || null,
      c_profile_id: body.c_profile_id || null,
      service_id: body.service_id || null,
      visa_type: body.visa_type || 'student_visa',
      target_country: body.target_country || null,
      status: 'requested',
      appointment_at: null, submitted_at: null, additional_documents_required: null,
      result: null, created_at: new Date().toISOString()
    });
    res.status(201).json(ok(order));
  });
  router.post('/orders/:id/status', (req, res) => {
    const order = db.stores.visa_orders.byId(req.params.id);
    if (!order || String(order.supplier_id) !== String(req.supplier.id)) return fail(res, 404, '签证委托不存在');
    const status = String(req.body && req.body.status || '').toLowerCase();
    if (!['requested', 'materials', 'appointment', 'submitted', 'additional_documents', 'result', 'cancelled'].includes(status)) {
      return fail(res, 400, '未知签证状态');
    }
    order.status = status;
    if (status === 'appointment') order.appointment_at = (req.body && req.body.appointment_at) || null;
    if (status === 'submitted') order.submitted_at = new Date().toISOString();
    if (status === 'additional_documents') order.additional_documents_required = (req.body && req.body.required) || null;
    if (status === 'result') {
      const outcome = String(req.body && req.body.result || '').toLowerCase();
      if (!['approved', 'rejected', 'pending', 'additional_docs'].includes(outcome)) return fail(res, 400, '未知签证结果');
      order.result = outcome;
      const app = order.application_id ? applications.applicationById(order.application_id) : null;
      if (app) upsertVisaCase(app.id, { status: outcome === 'approved' ? 'approved' : outcome, note: req.body && req.body.note }, actorOf(req));
    }
    audit.record({ actor: actorOf(req), action: 's:visa_status', entity: 'visa_order', entity_id: order.id, to: { status, result: order.result } });
    res.json(ok(order));
  });
  return router;
}

function accommodationRouter() {
  const router = sRouterFor('ACCOMMODATION');
  router.get('/rooms', (req, res) => {
    const list = db.stores.rooms.all().filter((r) => String(r.supplier_id) === String(req.supplier.id));
    res.json(ok(list.map(roomView)));
  });
  router.post('/rooms', (req, res) => {
    const body = req.body || {};
    const bedsTotal = Number(body.beds_total) || 0;
    const room = db.stores.rooms.insert({
      id: require('./lib/util').id('room'),
      supplier_id: req.supplier.id,
      accommodation_id: body.accommodation_id || null,
      name: body.name || null,
      room_type: body.room_type || 'single',
      beds_total: bedsTotal,
      beds_occupied: 0,
      price: body.price === undefined ? null : Number(body.price),
      currency: body.currency || 'SGD',
      available_from: body.available_from || null,
      available_to: body.available_to || null,
      created_at: new Date().toISOString()
    });
    res.status(201).json(ok(roomView(room)));
  });
  router.get('/bookings', (req, res) => {
    const list = db.stores.bookings.all().filter((b) => String(b.supplier_id) === String(req.supplier.id));
    res.json(ok(list));
  });
  // Create a booking (a B places it on behalf of a bound C, or the supplier
  // records a direct reservation). Occupancy changes only on check-in/out.
  router.post('/bookings', (req, res) => {
    const body = req.body || {};
    const room = db.stores.rooms.byId(body.room_id);
    if (!room || String(room.supplier_id) !== String(req.supplier.id)) return fail(res, 404, '房间不存在');
    const bedsAvailable = Math.max(0, (Number(room.beds_total) || 0) - (Number(room.beds_occupied) || 0));
    if (bedsAvailable <= 0) return fail(res, 409, '该房间已无可用床位');

    const booking = db.stores.bookings.insert({
      id: require('./lib/util').id('booking'),
      supplier_id: req.supplier.id,
      room_id: room.id,
      c_profile_id: body.c_profile_id || null,
      application_id: body.application_id || null,
      check_in: body.check_in || null,
      check_out: body.check_out || null,
      status: 'reserved',
      price: body.price === undefined ? room.price : Number(body.price),
      currency: body.currency || room.currency || 'SGD',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    audit.record({ actor: actorOf(req), action: 's:booking_create', entity: 'booking', entity_id: booking.id, to: booking });
    res.status(201).json(ok({ ...booking, room: roomView(room) }));
  });
  router.post('/bookings/:id/status', (req, res) => {
    const booking = db.stores.bookings.byId(req.params.id);
    if (!booking || String(booking.supplier_id) !== String(req.supplier.id)) return fail(res, 404, '预订不存在');
    const status = String(req.body && req.body.status || '').toLowerCase();
    if (!['reserved', 'checked_in', 'checked_out', 'renewed', 'cancelled'].includes(status)) return fail(res, 400, '未知预订状态');
    const room = db.stores.rooms.byId(booking.room_id);
    const before = room ? { beds_occupied: room.beds_occupied, beds_available: room.beds_total - room.beds_occupied } : null;
    if (room) {
      if (status === 'checked_in' && lower(booking.status) === 'reserved') room.beds_occupied = (room.beds_occupied || 0) + 1;
      if (status === 'checked_out' && ['checked_in', 'renewed'].includes(lower(booking.status))) {
        room.beds_occupied = Math.max(0, (room.beds_occupied || 0) - 1);
      }
      if (status === 'cancelled' && ['reserved', 'checked_in'].includes(lower(booking.status))) {
        room.beds_occupied = Math.max(0, (room.beds_occupied || 0) - 1);
      }
    }
    booking.status = status;
    booking.updated_at = new Date().toISOString();
    audit.record({
      actor: actorOf(req), action: 's:booking_status', entity: 'booking', entity_id: booking.id,
      from: before, to: { status, beds_occupied: room ? room.beds_occupied : null }
    });
    res.json(ok({ booking, room: room ? roomView(room) : null }));
  });
  router.get('/guardian-services', (req, res) => {
    const list = db.stores.guardian_services.all().filter((g) => String(g.supplier_id) === String(req.supplier.id));
    res.json(ok(list));
  });
  return router;
}

function financeRouter() {
  const router = express.Router();
  // S6: the route exists but the feature is off by default.
  router.use((req, res, next) => {
    if (!config.financeEnabled()) {
      return res.status(403).json({
        ok: false,
        error: '功能暂未开放 / Coming soon',
        code: 'FINANCE_DISABLED',
        note: '本轮为 Full MVP 合规边界：不实现信用评分、自动审批、放款、还款、逾期催收或实际金融交易。'
      });
    }
    next();
  });
  router.use((req, res, next) => {
    const ctx = requireS(req, res, 'FINANCE');
    if (!ctx) return;
    next();
  });
  router.get('/me', (req, res) => res.json(ok({ supplier: req.supplier, enabled: true })));
  router.get('/products', (req, res) => res.json(ok(contracts.listCommissionRules({ supplier_id: req.supplier.id }))));
  router.get('/referrals', (req, res) => res.json(ok(db.stores.finance_referrals.all().filter((r) => String(r.supplier_id) === String(req.supplier.id)))));
  return router;
}

app.use('/api/s/education', sRouterFor('EDUCATION'));
app.use('/api/s/medical', medicalRouter());
app.use('/api/s/certification', certificationRouter());
app.use('/api/s/visa', visaRouter());
app.use('/api/s/accommodation', accommodationRouter());
app.use('/api/s/finance', financeRouter());

// ===========================================================================
// DBC END — State A only
// ===========================================================================
const dbcRouter = express.Router();
dbcRouter.use((req, res, next) => {
  const ctx = requireDBC(req, res);
  if (!ctx) return;
  next();
});

dbcRouter.get('/me', (req, res) => {
  const profile = db.stores.dbc_profiles.find((p) => String(p.organization_id) === String(req.dbcOrg.id));
  res.json(ok({ organization: req.dbcOrg, profile, state_a_only: true }));
});

// Rule: DBC only sees State A (DBC-routed) agreements and never State B.
dbcRouter.get('/suppliers', (req, res) => {
  const agreements = contracts.listAgreements({ kind: 'DBC_S' }).filter((a) => String(a.state).toUpperCase() === 'A');
  const supplierIds = agreements.map((a) => a.supplier_id);
  const list = suppliers.listSuppliers({}).filter((s) => supplierIds.includes(s.id));
  res.json(ok(list.map((s) => suppliers.bView(s)), { state: 'A' }));
});

dbcRouter.get('/agreements', (req, res) => {
  const list = contracts.listAgreements({ kind: 'DBC_S' }).filter((a) => String(a.state).toUpperCase() === 'A');
  res.json(ok(list.map(contractView), { state: 'A', note: 'DBC 只参与状态 A；状态 B（B 与 S 直接合作）完全不可见。' }));
});

dbcRouter.post('/agreements', (req, res) => {
  const agreement = contracts.createAgreement({
    kind: 'DBC_S', supplier_id: req.body && req.body.supplier_id,
    dbc_organization_id: req.dbcOrg.id, state: 'A',
    title: 'DBC-S 合作协议（状态 A）', is_demo: Boolean(req.body && req.body.is_demo)
  }, actorOf(req));
  res.status(201).json(ok(contractView(agreement)));
});

dbcRouter.get('/bs', (req, res) => {
  // B partners DBC has agreements with (State A).
  const agreements = contracts.listAgreements({ kind: 'DBC_B' }).filter((a) => String(a.state).toUpperCase() === 'A');
  res.json(ok(agreements.map(contractView)));
});

dbcRouter.get('/applications', (req, res) => {
  // Only State A applications are visible.
  const stateAAgreements = new Set(contracts.listAgreements({ kind: 'DBC_S' }).filter((a) => String(a.state).toUpperCase() === 'A').map((a) => String(a.supplier_id)));
  const list = applications.listApplications({}).filter((a) => stateAAgreements.has(String(a.supplier_id)));
  res.json(ok(list.map((a) => applications.applicationDetail(a.id)), { state: 'A' }));
});

dbcRouter.get('/students', (req, res) => {
  const stateAAgreements = new Set(contracts.listAgreements({ kind: 'DBC_S' }).filter((a) => String(a.state).toUpperCase() === 'A').map((a) => String(a.supplier_id)));
  const apps = applications.listApplications({}).filter((a) => stateAAgreements.has(String(a.supplier_id)));
  const cIds = new Set(apps.map((a) => a.c_profile_id));
  res.json(ok(db.stores.c_profiles.all().filter((c) => cIds.has(String(c.id))), { state: 'A' }));
});

dbcRouter.get('/visa', (req, res) => {
  const stateAAgreements = new Set(contracts.listAgreements({ kind: 'DBC_S' }).filter((a) => String(a.state).toUpperCase() === 'A').map((a) => String(a.supplier_id)));
  const appIds = new Set(applications.listApplications({}).filter((a) => stateAAgreements.has(String(a.supplier_id))).map((a) => a.id));
  res.json(ok(db.stores.visa_cases.all().filter((v) => appIds.has(String(v.application_id))).map((v) => ({
    id: v.id, application_id: v.application_id, status: v.status, steps: v.steps || []
  }))));
});

dbcRouter.get('/settlements', (req, res) => {
  const list = contracts.listSettlements({}).filter((s) => String(s.state || 'A').toUpperCase() === 'A');
  res.json(ok(list));
});

dbcRouter.get('/messages', (req, res) => res.json(ok(messagesFor('DBC', req.dbcOrg.id))));
dbcRouter.post('/messages', (req, res) => {
  const msg = db.stores.messages.insert({
    id: require('./lib/util').id('message'),
    thread_id: req.body && req.body.thread_id,
    from_type: 'DBC', from_id: req.dbcOrg.id,
    to_type: req.body && req.body.to_type, to_id: req.body && req.body.to_id,
    body: req.body && req.body.body || '',
    created_at: new Date().toISOString(), read_at: null
  });
  res.status(201).json(ok(msg));
});

dbcRouter.get('/todos', (req, res) => res.json(ok(buildBrief('DBC', req.dbcOrg.id).todos)));
dbcRouter.get('/brief', (req, res) => res.json(ok(buildBrief('DBC', req.dbcOrg.id))));

app.use('/api/dbc', dbcRouter);

// ===========================================================================
// ADS CENTRE
// ===========================================================================
const adsRouter = express.Router();
adsRouter.use((req, res, next) => {
  if (!config.adsEnabled()) return fail(res, 403, '广告中心暂未开放');
  next();
});

adsRouter.get('/products', (req, res) => {
  const products = db.stores.ad_products.all();
  res.json(ok(products, {
    demo_defaults: {
      topup_amount: config.get('ads_demo_topup_amount', 800),
      monthly_price: config.get('ads_demo_monthly_price', 100),
      max_renewals: config.get('ads_demo_max_renewals', 6),
      currency: config.get('ads_default_currency', 'SGD')
    },
    note: '金额与续费上限均为可配置演示默认值，不是写死的商业条款。'
  }));
});

adsRouter.get('/inventory', (req, res) => {
  const inventory = db.stores.ad_inventory.all().filter((i) => i.reserved < i.total);
  res.json(ok(inventory));
});

// Top-up → cart → order → AETHEL X Sandbox → creative → review → schedule.
adsRouter.post('/orders', (req, res) => {
  const actor = requireActor(req, res);
  if (!actor) return;
  const body = req.body || {};
  const slot = db.stores.ad_inventory.byId(body.inventory_id);
  if (!slot) return fail(res, 404, '广告位不存在');
  if (slot.reserved >= slot.total) return fail(res, 409, '广告位库存不足');

  const price = Number(body.amount) || Number(config.get('ads_demo_monthly_price', 100));
  const order = db.stores.ad_orders.insert({
    id: require('./lib/util').id('ad_order'),
    inventory_id: slot.id,
    slot_type: slot.slot_type,
    advertiser_type: body.advertiser_type || (auth.ROLES[actor.role] ? auth.ROLES[actor.role].audience : 'S'),
    advertiser_id: body.advertiser_id || actor.organization_id || actor.id,
    amount: price,
    currency: body.currency || config.get('ads_default_currency', 'SGD'),
    renewals: 0,
    max_renewals: Number(config.get('ads_demo_max_renewals', 6)),
    status: 'cart',
    payment_intent_id: null,
    creative_id: null,
    schedule_id: null,
    created_at: new Date().toISOString()
  });
  audit.record({ actor, action: 'ads:order_create', entity: 'ad_order', entity_id: order.id, to: order });
  res.status(201).json(ok(order));
});

adsRouter.post('/orders/:id/pay', (req, res) => {
  const actor = requireActor(req, res);
  if (!actor) return;
  const order = db.stores.ad_orders.byId(req.params.id);
  if (!order) return fail(res, 404, '广告订单不存在');
  if (String(order.status).toLowerCase() !== 'cart') return fail(res, 400, '订单状态不可支付');

  const payment = payments.createIntent({
    kind: 'ad_order', amount: order.amount, currency: order.currency,
    payer_type: order.advertiser_type, payer_id: order.advertiser_id,
    ad_order_id: order.id, description: '广告投放（Sandbox）'
  }, actor);
  if (!payment.ok) return fail(res, 400, payment.error);
  const confirmed = payments.confirmIntent(payment.intent.id, {}, actor);
  order.payment_intent_id = payment.intent.id;
  order.status = confirmed.ok ? 'paid' : 'payment_failed';
  if (confirmed.ok) {
    const slot = db.stores.ad_inventory.byId(order.inventory_id);
    if (slot) slot.reserved = (slot.reserved || 0) + 1;
  }
  audit.record({ actor, action: 'ads:order_pay', entity: 'ad_order', entity_id: order.id, to: { status: order.status, sandbox: confirmed.receipt ? confirmed.receipt.sandbox : true } });
  res.json(ok({ order, payment: paymentView(payment.intent), receipt: confirmed.receipt, sandbox: true }));
});

adsRouter.post('/orders/:id/creative', (req, res) => {
  const actor = requireActor(req, res);
  if (!actor) return;
  const order = db.stores.ad_orders.byId(req.params.id);
  if (!order) return fail(res, 404, '广告订单不存在');
  if (String(order.status).toLowerCase() !== 'paid') return fail(res, 400, '请先完成付款');
  const creative = db.stores.ad_creatives.insert({
    id: require('./lib/util').id('ad_creative'),
    ad_order_id: order.id,
    title: (req.body && req.body.title) || null,
    body: (req.body && req.body.body) || null,
    asset_url: (req.body && req.body.asset_url) || null,
    landing_url: (req.body && req.body.landing_url) || null,
    status: 'pending_review',
    created_at: new Date().toISOString()
  });
  order.creative_id = creative.id;
  order.status = 'creative_uploaded';
  audit.record({ actor, action: 'ads:creative_upload', entity: 'ad_creative', entity_id: creative.id, to: creative });
  res.status(201).json(ok({ order, creative }));
});

adsRouter.post('/orders/:id/review', (req, res) => {
  const actor = requireActor(req, res);
  if (!actor) return;
  if (!auth.hasPermission(actor.role, 'admin:ads') && !auth.hasPermission(actor.role, '*')) {
    return fail(res, 403, '仅平台可审核广告素材');
  }
  const order = db.stores.ad_orders.byId(req.params.id);
  if (!order) return fail(res, 404, '广告订单不存在');
  const decision = String(req.body && req.body.decision || '').toLowerCase();
  if (!['approve', 'reject'].includes(decision)) return fail(res, 400, 'decision 应为 approve / reject');
  order.status = decision === 'approve' ? 'approved' : 'rejected';
  if (order.creative_id) {
    const creative = db.stores.ad_creatives.byId(order.creative_id);
    if (creative) creative.status = decision === 'approve' ? 'approved' : 'rejected';
  }
  audit.record({ actor, action: 'ads:creative_review', entity: 'ad_order', entity_id: order.id, to: { decision } });
  res.json(ok(order));
});

adsRouter.post('/orders/:id/schedule', (req, res) => {
  const actor = requireActor(req, res);
  if (!actor) return;
  const order = db.stores.ad_orders.byId(req.params.id);
  if (!order) return fail(res, 404, '广告订单不存在');
  if (String(order.status).toLowerCase() !== 'approved') return fail(res, 400, '订单尚未审核通过');
  const schedule = db.stores.ad_schedules.insert({
    id: require('./lib/util').id('ad_schedule'),
    ad_order_id: order.id,
    starts_at: (req.body && req.body.starts_at) || new Date().toISOString(),
    ends_at: (req.body && req.body.ends_at) || new Date(Date.now() + 30 * 86400000).toISOString(),
    status: 'scheduled',
    created_at: new Date().toISOString()
  });
  order.schedule_id = schedule.id;
  order.status = 'scheduled';
  audit.record({ actor, action: 'ads:schedule', entity: 'ad_schedule', entity_id: schedule.id, to: schedule });
  res.status(201).json(ok({ order, schedule }));
});

adsRouter.post('/orders/:id/renew', (req, res) => {
  const actor = requireActor(req, res);
  if (!actor) return;
  const order = db.stores.ad_orders.byId(req.params.id);
  if (!order) return fail(res, 404, '广告订单不存在');
  if (order.renewals >= order.max_renewals) return fail(res, 409, '已达到最大续费次数');
  order.renewals += 1;
  audit.record({ actor, action: 'ads:renew', entity: 'ad_order', entity_id: order.id, to: { renewals: order.renewals } });
  res.json(ok(order));
});

// Impression / click / conversion recording.
adsRouter.post('/events', (req, res) => {
  const body = req.body || {};
  const order = db.stores.ad_orders.byId(body.ad_order_id);
  if (!order) return fail(res, 404, '广告订单不存在');
  const report = db.stores.ad_reports.insert({
    id: require('./lib/util').id('ad_report'),
    ad_order_id: order.id,
    event: String(body.event || '').toLowerCase(),
    at: new Date().toISOString(),
    session_ref: body.session_ref || null
  });
  res.status(201).json(ok(report));
});

adsRouter.get('/orders/:id/report', (req, res) => {
  const order = db.stores.ad_orders.byId(req.params.id);
  if (!order) return fail(res, 404, '广告订单不存在');
  const events = db.stores.ad_reports.all().filter((r) => String(r.ad_order_id) === String(order.id));
  const count = (name) => events.filter((e) => e.event === name).length;
  const impressions = count('impression');
  const clicks = count('click');
  const conversions = count('conversion');
  res.json(ok({
    order,
    impressions, clicks, conversions,
    ctr: impressions ? Math.round((clicks / impressions) * 10000) / 100 : 0,
    cvr: clicks ? Math.round((conversions / clicks) * 10000) / 100 : 0,
    roi: conversions ? Math.round((conversions * Number(order.amount || 0)) / Number(order.amount || 1) * 100) / 100 : 0,
    sponsored_label: '广告 / 推广',
    ranking_impact: '广告预算不影响自然搜索、自然推荐 B 与自然 S 排名'
  }));
});

adsRouter.get('/my-orders', (req, res) => {
  const actor = requireActor(req, res);
  if (!actor) return;
  const list = db.stores.ad_orders.all().filter((o) => String(o.advertiser_id) === String(actor.organization_id || actor.id));
  res.json(ok(list));
});

app.use('/api/ads', adsRouter);

// ===========================================================================
// ADMIN
// ===========================================================================
const adminRouter = express.Router();
adminRouter.use((req, res, next) => {
  const ctx = requireAdmin(req, res);
  if (!ctx) return;
  next();
});

adminRouter.get('/dashboard', (req, res) => {
  const counts = db.counts();
  res.json(ok({
    counts,
    users_by_role: db.stores.users.all().reduce((acc, u) => { acc[u.role] = (acc[u.role] || 0) + 1; return acc; }, {}),
    applications_by_stage: auth.STAGE_CODES.reduce((acc, code) => {
      acc[code] = db.stores.applications.all().filter((a) => a.current_stage === code).length;
      return acc;
    }, {}),
    payments: db.stores.payment_intents.all().reduce((acc, p) => { acc[p.status] = (acc[p.status] || 0) + 1; return acc; }, {}),
    finance_enabled: config.financeEnabled(),
    payment_mode: config.get('providers.payment.mode', 'sandbox'),
    persistence: db.backend
  }));
});

// Unified user management.
adminRouter.get('/users', (req, res) => {
  let list = db.stores.users.all();
  if (req.query.audience) {
    const roles = Object.values(auth.ROLES).filter((r) => r.audience === String(req.query.audience).toUpperCase()).map((r) => r.id);
    list = list.filter((u) => roles.includes(u.role));
  }
  if (req.query.role) list = list.filter((u) => String(u.role).toUpperCase() === String(req.query.role).toUpperCase());
  res.json(ok(list.map(auth.userPublic), { total: list.length }));
});

adminRouter.post('/users', (req, res) => {
  const body = req.body || {};
  const user = auth.createUser({
    email: body.email, phone: body.phone, password: body.password,
    display_name: body.display_name, role: body.role,
    organization_id: body.organization_id, org_role: body.org_role, language: body.language
  });
  res.status(201).json(ok(auth.userPublic(user)));
});

adminRouter.patch('/users/:id', (req, res) => {
  const user = db.stores.users.byId(req.params.id);
  if (!user) return fail(res, 404, '用户不存在');
  const before = { status: user.status, role: user.role };
  if (req.body && req.body.status) user.status = req.body.status;
  if (req.body && req.body.role) {
    const nextRole = auth.ROLES[String(req.body.role).toUpperCase()];
    if (!nextRole) return fail(res, 400, '未知角色');
    // Role changes stay within the same audience unless performed by an
    // ADMIN_SUPER — a lower admin role cannot mint cross-audience identities.
    const actor = actorOf(req);
    const isSuper = actor && String(actor.role).toUpperCase() === 'ADMIN_SUPER';
    if (!isSuper) {
      const currentAud = auth.ROLES[String(user.role).toUpperCase()].audience;
      if (nextRole.audience !== currentAud) {
        return fail(res, 403, '跨端角色变更仅限 ADMIN_SUPER');
      }
    }
    user.role = nextRole.id;
  }
  if (req.body && req.body.organization_id) user.organization_id = req.body.organization_id;
  audit.record({ actor: actorOf(req), action: 'admin:user_update', entity: 'user', entity_id: user.id, from: before, to: { status: user.status, role: user.role } });
  res.json(ok(auth.userPublic(user)));
});

// Unified verification queue (B / S / DBC).
adminRouter.get('/verifications', (req, res) => {
  const organizations = db.stores.organizations.all();
  const suppliers = db.stores.suppliers.all();
  res.json(ok({
    organizations: organizations.map((o) => ({
      id: o.id, kind: o.kind, name: o.name, kyc_status: o.kyc_status, kyb_status: o.kyb_status,
      aml_status: o.aml_status, verified: o.verified, status: o.status
    })),
    suppliers: suppliers.map((s) => ({
      id: s.id, type: s.type, name: s.name, verification: s.verification,
      source_url: s.source_url, is_demo: s.is_demo, verified_at: s.verified_at
    }))
  }));
});

adminRouter.post('/verifications/organizations/:id', (req, res) => {
  const organization = org.findOrganization(req.params.id);
  if (!organization) return fail(res, 404, '机构不存在');
  const decision = String(req.body && req.body.decision || '').toLowerCase();
  const patch = {};
  if (decision === 'approve') {
    patch.kyc_status = 'approved'; patch.kyb_status = 'approved'; patch.verified = true;
    patch.verified_at = new Date().toISOString();
  } else if (decision === 'reject') {
    patch.kyc_status = 'rejected'; patch.kyb_status = 'rejected'; patch.verified = false;
  } else if (decision === 'freeze') {
    patch.status = 'frozen'; patch.frozen_reason = (req.body && req.body.reason) || '平台冻结';
  } else if (decision === 'unfreeze') {
    patch.status = 'active'; patch.frozen_reason = null;
  } else {
    return fail(res, 400, 'decision 应为 approve / reject / freeze / unfreeze');
  }
  const updated = org.updateOrganization(organization.id, patch, actorOf(req));
  res.json(ok(updated));
});

adminRouter.post('/verifications/suppliers/:id', (req, res) => {
  const result = suppliers.verifySupplier(req.params.id, req.body && req.body.decision, actorOf(req));
  if (!result.ok) return fail(res, 400, result.error);
  res.json(ok(result.supplier));
});

// B management.
adminRouter.get('/bs', (req, res) => {
  const list = org.organizationsOfKind('B').map((o) => ({
    organization: o,
    profile: org.bProfileOf(o.id),
    membership: org.membershipExpiryInfo(o.id),
    admission: recommendation.evaluateAdmission(org.bProfileOf(o.id) || {}, {})
  }));
  res.json(ok(list));
});

adminRouter.post('/bs/:id/membership', (req, res) => {
  const organization = org.findOrganization(req.params.id);
  if (!organization || String(organization.kind).toUpperCase() !== 'B') return fail(res, 404, 'B 端机构不存在');
  const membership = org.renewMembership(organization.id, req.body || {}, actorOf(req));
  res.status(201).json(ok(membership));
});

adminRouter.post('/bs/:id/expire', (req, res) => {
  const organization = org.findOrganization(req.params.id);
  if (!organization) return fail(res, 404, 'B 端机构不存在');
  const membership = org.expireMembership(organization.id, actorOf(req));
  const transferred = binding.handleBMembershipExpiry(organization.id, actorOf(req));
  res.json(ok({ membership, transferred_bindings: transferred }));
});

// C management.
adminRouter.get('/cs', (req, res) => {
  const list = db.stores.c_profiles.all().map((c) => {
    const active = binding.currentBinding(c.id);
    return { c_profile: c, binding: active ? bindingView(active) : null, binding_state: c.binding_state };
  });
  res.json(ok(list));
});

adminRouter.get('/ss', (req, res) => res.json(ok(suppliers.listSuppliers({}))));
adminRouter.get('/dbcs', (req, res) => {
  const list = org.organizationsOfKind('DBC').map((o) => ({
    organization: o, profile: db.stores.dbc_profiles.find((p) => String(p.organization_id) === String(o.id)) || null
  }));
  res.json(ok(list));
});

// Recommendation pool + weights.
adminRouter.get('/recommendation/pool', (req, res) => {
  const list = org.organizationsOfKind('B').map((o) => {
    const profile = org.bProfileOf(o.id);
    const gate = profile ? recommendation.evaluateAdmission(profile, {}) : { eligible: false, failures: ['no_profile'] };
    return {
      organization_id: o.id, name: o.name,
      level: profile ? profile.level : null,
      eligible: gate.eligible, failures: gate.failures,
      in_pool: gate.eligible,
      order_capacity: profile ? recommendation.orderCapacity(o.id) : null
    };
  });
  res.json(ok(list));
});

adminRouter.get('/config/recommendation-weights', (req, res) => res.json(ok(config.get('recommendation_weights'))));
adminRouter.put('/config/recommendation-weights', (req, res) => {
  const incoming = req.body || {};
  const current = config.get('recommendation_weights');
  const next = { ...current };
  for (const [k, v] of Object.entries(incoming)) {
    if (!(k in current)) return fail(res, 400, '未知权重项: ' + k);
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) return fail(res, 400, k + ' 权重必须是 0–100');
    next[k] = n;
  }
  config.set('recommendation_weights', next, { by: actorOf(req) ? actorOf(req).id : 'admin' });
  res.json(ok(next));
});

adminRouter.get('/recommendation/logs', (req, res) => {
  res.json(ok(recommendation.listRecommendations({}).map((r) => ({
    id: r.id, tier: r.tier, mode: r.mode, candidates: r.candidates.length,
    excluded: r.excluded.length, created_at: r.created_at, status: r.status
  }))));
});

// Binding management.
adminRouter.get('/bindings', (req, res) => {
  const list = binding.listBindings({}).map((b) => bindingView(b));
  res.json(ok(list));
});

adminRouter.post('/bindings/:id/rebinding-review', (req, res) => {
  const result = binding.platformReviewRebinding(req.params.id, req.body && req.body.decision, actorOf(req));
  if (!result.ok) return fail(res, 400, result.error);
  res.json(ok(result.binding));
});

// Contracts.
adminRouter.get('/contracts', (req, res) => res.json(ok(contracts.listAgreements({}).map(contractView))));

// The platform records every agreement kind, including a State B (direct B↔S)
// agreement. Recording is not participating: the platform never confirms
// business results, and State B stays invisible to the DBC client.
adminRouter.post('/contracts', (req, res) => {
  const agreement = contracts.createAgreement({
    kind: req.body && req.body.kind,
    title: req.body && req.body.title,
    b_organization_id: req.body && req.body.b_organization_id,
    supplier_id: req.body && req.body.supplier_id,
    dbc_organization_id: req.body && req.body.dbc_organization_id,
    state: req.body && req.body.state || 'A',
    is_demo: Boolean(req.body && req.body.is_demo)
  }, actorOf(req));
  res.status(201).json(ok(contractView(agreement)));
});

// Commission engine.
adminRouter.get('/commission/rules', (req, res) => res.json(ok(contracts.listCommissionRules({}))));
adminRouter.post('/commission/rules', (req, res) => {
  const rule = contracts.createCommissionRule(req.body || {}, actorOf(req));
  res.status(201).json(ok(rule));
});
adminRouter.get('/commission/ledger', (req, res) => res.json(ok(contracts.commissionLedgerOf(null))));
adminRouter.patch('/commission/ledger/:id', (req, res) => {
  const result = contracts.updateLedgerStatus(req.params.id, req.body && req.body.status, actorOf(req));
  if (!result.ok) return fail(res, 400, result.error);
  res.json(ok(result.ledger));
});

// Payments.
adminRouter.get('/payments', (req, res) => res.json(ok(payments.listIntents({}).map((i) => paymentView(i)))));
adminRouter.get('/payments/providers', (req, res) => res.json(ok(payments.providerCatalog())));
adminRouter.post('/payments', (req, res) => {
  const result = payments.createIntent(req.body || {}, actorOf(req));
  if (!result.ok) return fail(res, 400, result.error);
  res.status(201).json(ok(paymentView(result.intent)));
});

// Settlements.
adminRouter.get('/settlements', (req, res) => res.json(ok(contracts.listSettlements({}))));
adminRouter.post('/settlements', (req, res) => {
  const result = contracts.createSettlement(req.body || {}, actorOf(req));
  if (!result.ok) return fail(res, 400, result.error);
  res.status(201).json(ok(result.settlement));
});
adminRouter.post('/settlements/:id/advance', (req, res) => {
  const result = contracts.advanceSettlement(req.params.id, req.body && req.body.target, actorOf(req));
  if (!result.ok) return fail(res, 400, result.error);
  res.json(ok(result.settlement));
});

// Applications.
adminRouter.get('/applications', (req, res) => res.json(ok(applications.listApplications({}).map((a) => applications.applicationDetail(a.id)))));
adminRouter.get('/kanban', (req, res) => res.json(ok(applications.kanban({}))));
adminRouter.get('/todos', (req, res) => res.json(ok(applications.listTodos({}))));
adminRouter.post('/todos/:id/complete', (req, res) => {
  const result = applications.completeTodo(req.params.id, actorOf(req));
  if (!result.ok) return fail(res, 400, result.error);
  res.json(ok(result.todo));
});
adminRouter.get('/documents', (req, res) => res.json(ok(db.stores.family_documents.all().map((d) => documentView(d)))));
adminRouter.get('/visa', (req, res) => res.json(ok(db.stores.visa_cases.all())));

// Reviews, disputes, messages, briefs.
adminRouter.get('/reviews', (req, res) => res.json(ok(db.stores.reviews.all())));
adminRouter.get('/disputes', (req, res) => res.json(ok(db.stores.disputes.all())));
adminRouter.post('/disputes/:id/resolve', (req, res) => {
  const dispute = db.stores.disputes.byId(req.params.id);
  if (!dispute) return fail(res, 404, '争议不存在');
  dispute.status = String(req.body && req.body.decision || 'resolved').toLowerCase();
  dispute.resolution = (req.body && req.body.resolution) || null;
  dispute.resolved_at = new Date().toISOString();
  audit.record({ actor: actorOf(req), action: 'admin:dispute_resolve', entity: 'dispute', entity_id: dispute.id, to: dispute });
  res.json(ok(dispute));
});
adminRouter.get('/messages', (req, res) => res.json(ok(db.stores.messages.all())));
adminRouter.get('/brief', (req, res) => res.json(ok(buildBrief('ADMIN', null))));

// Ads oversight.
adminRouter.get('/ads/orders', (req, res) => res.json(ok(db.stores.ad_orders.all())));
adminRouter.get('/ads/reports', (req, res) => {
  const reports = db.stores.ad_reports.all();
  const count = (id, name) => reports.filter((r) => String(r.ad_order_id) === String(id) && r.event === name).length;
  res.json(ok(db.stores.ad_orders.all().map((o) => {
    const impressions = count(o.id, 'impression');
    const clicks = count(o.id, 'click');
    const conversions = count(o.id, 'conversion');
    return {
      order_id: o.id, slot_type: o.slot_type, status: o.status,
      impressions, clicks, conversions,
      ctr: impressions ? Math.round((clicks / impressions) * 10000) / 100 : 0,
      cvr: clicks ? Math.round((conversions / clicks) * 10000) / 100 : 0
    };
  })));
});

// Audit log.
adminRouter.get('/audit', (req, res) => {
  const entries = audit.query({ audience: req.query.audience, action: req.query.action, entity: req.query.entity, entity_id: req.query.entity_id });
  const limit = Math.min(500, Number(req.query.limit) || 200);
  res.json(ok(entries.slice(0, limit), { total: entries.length }));
});

// Data snapshot (Fix 2): export the current dataset so a maintenance script can
// commit it to the `data-snapshot` branch, which the build checks out before
// `npm start`. This is what makes data survive a *redeploy* on hosts without a
// persistent disk (Render free tier). Export is admin-only.
adminRouter.get('/snapshot/export', (req, res) => {
  const payload = {
    version: VERSION,
    exported_at: new Date().toISOString(),
    backend: db.backend,
    counts: db.counts(),
    data: db.snapshot()
  };
  res.json(ok(payload));
});

// Import a previously exported snapshot. Guarded by a confirmation body so it
// can never be triggered accidentally; used only by the documented maintenance
// flow (or an operator restoring a known-good snapshot).
adminRouter.post('/snapshot/import', (req, res) => {
  const body = req.body || {};
  if (body.confirm !== 'RESTORE_SNAPSHOT') {
    return fail(res, 400, '需要 confirm=RESTORE_SNAPSHOT 才会执行快照恢复');
  }
  if (!body.data || typeof body.data !== 'object') return fail(res, 400, '缺少 data');
  db.restore(body.data);
  db.flushSync();
  audit.record({ actor: actorOf(req), action: 'admin:snapshot_import', entity: 'system', to: { counts: db.counts() } });
  res.json(ok({ restored: true, counts: db.counts() }));
});

// System config.
adminRouter.get('/config', (req, res) => res.json(ok(config.all())));
adminRouter.put('/config', (req, res) => {
  const next = config.patch(req.body || {}, { by: actorOf(req) ? actorOf(req).id : 'admin' });
  res.json(ok(next));
});
adminRouter.post('/config/reset', (req, res) => res.json(ok(config.resetToDefaults({ by: actorOf(req) ? actorOf(req).id : 'admin' }))));

app.use('/api/admin', adminRouter);

// ===========================================================================
// Shared view builders
// ===========================================================================
function publicRecommendation(rec) {
  return {
    id: rec.id,
    tier: rec.tier,
    mode: rec.mode,
    candidates: rec.candidates.map((c) => ({
      rank: c.rank,
      b_organization_id: c.b_organization_id,
      level: c.level,
      match_score: c.score,
      reasons: c.explain,
      languages: c.languages,
      service_countries: c.service_countries,
      avg_response_minutes: c.avg_response_minutes,
      rating_avg: c.rating_avg,
      rating_count: c.rating_count
      // No commission field (Rule 9).
    })),
    browse_only: rec.mode === 'browse_only'
  };
}

function bindingView(binding_) {
  const organization = org.findOrganization(binding_.b_organization_id);
  return {
    id: binding_.id,
    c_profile_id: binding_.c_profile_id,
    b_organization_id: binding_.b_organization_id,
    b_name: organization ? organization.name : null,
    status: binding_.status,
    contract_id: binding_.contract_id,
    requested_at: binding_.requested_at,
    responded_at: binding_.responded_at,
    contract_effective_at: binding_.contract_effective_at,
    first_binding_protected_until: binding_.first_binding_protected_until,
    is_rebinding: Boolean(binding_.is_rebinding),
    rebinding: binding_.rebinding || null
  };
}

function bindingRequestViewForB(binding_) {
  const c = binding.cProfileById(binding_.c_profile_id);
  return {
    id: binding_.id,
    status: binding_.status,
    requested_at: binding_.requested_at,
    is_rebinding: Boolean(binding_.is_rebinding),
    rebinding: binding_.rebinding || null,
    c_profile: c ? {
      id: c.id, name: c.name, name_en: c.name_en, nationality: c.nationality,
      education_stage: c.education_stage, target_countries: c.target_countries,
      target_courses: c.target_courses
    } : null
  };
}

function contractView(agreement) {
  if (!agreement) return null;
  return {
    id: agreement.id,
    kind: agreement.kind,
    title: agreement.title,
    status: agreement.status,
    state: agreement.state,
    current_version_id: agreement.current_version_id,
    b_organization_id: agreement.b_organization_id,
    c_profile_id: agreement.c_profile_id,
    supplier_id: agreement.supplier_id,
    dbc_organization_id: agreement.dbc_organization_id,
    currency: agreement.currency,
    is_demo: Boolean(agreement.is_demo),
    effective_at: agreement.effective_at || null,
    signatures: db.stores.signatures.all()
      .filter((s) => String(s.agreement_id) === String(agreement.id))
      .map((s) => ({ signer: s.signer, signed_at: s.signed_at, provider: s.provider, provider_mode: s.provider_mode })),
    commission_rule_ids: agreement.commission_rule_ids || [],
    note: '平台仅记录合同，不作为业务一方确认业务结果。'
  };
}

function documentView(doc) {
  return {
    id: doc.id,
    type: doc.type,
    file_name: doc.file_name,
    file_url: doc.file_url,
    status: doc.status,
    version: doc.version,
    application_id: doc.application_id,
    ocr: { mode: 'sandbox', classified_as: doc.ocr ? doc.ocr.classified_as : doc.type, sandbox: true },
    b_confirmed_at: doc.b_confirmed_at || null,
    s_confirmed_at: doc.s_confirmed_at || null,
    created_at: doc.created_at
  };
}

function paymentView(intent) {
  return {
    id: intent.id,
    kind: intent.kind,
    amount: intent.amount,
    currency: intent.currency,
    status: intent.status,
    payer_type: intent.payer_type,
    payer_id: intent.payer_id,
    related: intent.related,
    receipt_id: intent.receipt_id,
    refund_ids: intent.refund_ids || [],
    sandbox: Boolean(intent.sandbox),
    reference_rate: intent.reference_rate,
    rate_timestamp: intent.rate_timestamp,
    created_at: intent.created_at
  };
}

function roomView(room) {
  const bedsTotal = Number(room.beds_total) || 0;
  const bedsOccupied = Number(room.beds_occupied) || 0;
  return {
    id: room.id,
    supplier_id: room.supplier_id,
    accommodation_id: room.accommodation_id,
    name: room.name,
    room_type: room.room_type,
    beds_total: bedsTotal,
    beds_occupied: bedsOccupied,
    beds_available: Math.max(0, bedsTotal - bedsOccupied),
    price: room.price,
    currency: room.currency,
    available_from: room.available_from,
    available_to: room.available_to
  };
}

function messagesFor(type, id_) {
  return db.stores.messages.all().filter((m) =>
    (String(m.from_type).toUpperCase() === String(type).toUpperCase() && String(m.from_id) === String(id_)) ||
    (String(m.to_type).toUpperCase() === String(type).toUpperCase() && String(m.to_id) === String(id_))
  ).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}

function sumOf(list, status) {
  return list.filter((e) => String(e.status).toLowerCase() === status).reduce((s, e) => s + Number(e.amount || 0), 0);
}

function buildBrief(scope, id_) {
  const todos = scope === 'C'
    ? applications.listTodos({ c_profile_id: id_ }).filter((t) => t.status !== 'done')
    : scope === 'B'
      ? applications.listTodos({ b_organization_id: id_ }).filter((t) => t.status !== 'done')
      : scope === 'S'
        ? applications.listTodos({ supplier_id: id_ }).filter((t) => t.status !== 'done')
        : applications.listTodos({ status: 'pending' });

  const apps = scope === 'C' ? applications.listApplications({ c_profile_id: id_ })
    : scope === 'B' ? applications.listApplications({ b_organization_id: id_ })
      : scope === 'S' ? applications.listApplications({ supplier_id: id_ })
        : applications.listApplications({});

  const now = Date.now();
  const deadlines = [];
  for (const app of apps) {
    for (const stage of (applications.applicationDetail(app.id).stages || [])) {
      if (stage.deadline) deadlines.push({ application_id: app.id, stage: stage.code, deadline: stage.deadline, days_left: Math.round((new Date(stage.deadline).getTime() - now) / 86400000) });
    }
  }
  const missingDocuments = apps.flatMap((a) => applications.documentsOf(a.id).filter((d) => d.status === 'uploaded').map((d) => ({ application_id: a.id, document_id: d.id, type: d.type })));
  const statusUpdates = db.stores.audit_logs.all()
    .filter((l) => l.action === 'application:transition')
    .slice(0, 10);

  return {
    generated_at: new Date().toISOString(),
    scope,
    today_todos: todos,
    upcoming_deadlines: deadlines.filter((d) => d.days_left <= 14).sort((a, b) => a.days_left - b.days_left),
    missing_documents: missingDocuments,
    status_updates: statusUpdates.map((l) => ({ application_id: l.entity_id, to: l.to, at: l.at }))
  };
}

function buildTargetWarnings(apps) {
  const warnings = [];
  const stageIndex = (code) => auth.STAGE_CODES.indexOf(code);
  const admitted = apps.filter((a) => stageIndex(a.current_stage) >= stageIndex('S5')).length;
  const targets = config.get('b_targets', { monthly_applications: 20, monthly_admissions: 8 });
  for (const threshold of [5, 3, 1]) {
    if (targets.monthly_admissions - admitted === threshold) {
      warnings.push({ level: 'warning', message: '距离本月录取目标还差 ' + threshold + ' 个', remaining: threshold });
    }
  }
  return warnings;
}

function explainableHealth(bProfile, organizationId) {
  const organization = org.findOrganization(organizationId) || {};
  const factors = [
    { key: 'kyc', label_zh: 'KYC 状态', score: String(organization.kyc_status).toLowerCase() === 'approved' ? 100 : 0 },
    { key: 'kyb', label_zh: 'KYB 状态', score: String(organization.kyb_status).toLowerCase() === 'approved' ? 100 : 0 },
    { key: 'membership', label_zh: '会员有效', score: org.membershipValid(organizationId).valid ? 100 : 0 },
    { key: 'contract', label_zh: '合同有效', score: bProfile && bProfile.contract_valid ? 100 : 0 },
    { key: 'rating', label_zh: '评价', score: bProfile ? Math.round((Number(bProfile.rating_avg || 0) / 5) * 100) : 0 },
    { key: 'response', label_zh: '响应速度', score: bProfile ? Math.max(0, 100 - Number(bProfile.avg_response_minutes || 0) / 3) : 0 },
    { key: 'disputes', label_zh: '未解决严重争议', score: bProfile && Number(bProfile.unresolved_serious_disputes || 0) > 0 ? 0 : 100 }
  ];
  const total = Math.round(factors.reduce((s, f) => s + f.score, 0) / factors.length);
  return { score: total, factors, explain: '分数为上述因子的算术平均，可在后台调整。' };
}

function assistantAnswer(body, organizationId, actor) {
  const question = String(body.question || body.query || '').toLowerCase();
  const allowed = ['查询', '解释', '匹配', '材料缺失', '合同摘要', '待办摘要'];
  const intent = detectIntent(question);

  // Rule: the assistant may never mutate funds, sign contracts or submit visas.
  const guard = '智能助手仅支持查询 / 解释 / 匹配 / 材料缺失 / 合同摘要 / 待办摘要；不能修改资金、签署合同或提交正式签证。';

  if (intent === 'missing_documents') {
    const docs = db.stores.family_documents.all().filter((d) => d.status === 'uploaded');
    return { answer: '当前有 ' + docs.length + ' 份材料等待确认。', documents: docs.map((d) => ({ id: d.id, type: d.type, status: d.status })), guard };
  }
  if (intent === 'todo_summary') {
    const todos = applications.listTodos({ b_organization_id: organizationId }).filter((t) => t.status !== 'done');
    return { answer: '待办共 ' + todos.length + ' 项。', todos, guard };
  }
  if (intent === 'contract_summary') {
    const list = contracts.listAgreements({ b_organization_id: organizationId });
    return { answer: '合同共 ' + list.length + ' 份。', contracts: list.map(contractView), guard };
  }
  if (intent === 'match') {
    const rec = recommendation.recommend({ id: 'assistant-' + Date.now(), target_countries: body.target_countries || [], target_stages: body.target_stages || [], target_courses: body.target_courses || [], languages: body.languages || [] });
    return { answer: '已按规则生成推荐（Level 2 优先）。', recommendation: publicRecommendation(rec), guard };
  }
  if (intent === 'explain') {
    return { answer: '推荐评分权重：' + JSON.stringify(config.get('recommendation_weights')) + '；首绑保护 ' + config.get('first_binding_protection_months') + ' 个月。', guard };
  }
  const apps = applications.listApplications({ b_organization_id: organizationId });
  return {
    answer: '共 ' + apps.length + ' 个申请。可用意图：' + allowed.join(' / '),
    applications: apps.map((a) => ({ id: a.id, current_stage: a.current_stage, status: a.status })),
    guard
  };
}

function detectIntent(question) {
  if (/材料|文档|缺失/.test(question)) return 'missing_documents';
  if (/待办|todo/.test(question)) return 'todo_summary';
  if (/合同|协议/.test(question)) return 'contract_summary';
  if (/匹配|推荐|match|recommend/.test(question)) return 'match';
  if (/权重|规则|为什么|解释|explain/.test(question)) return 'explain';
  return 'query';
}

function upsertVisaCase(applicationId, body, actor) {
  const existing = db.stores.visa_cases.find((v) => String(v.application_id) === String(applicationId));
  const now = new Date().toISOString();
  const status = String(body.status || (existing && existing.status) || 'not_started').toLowerCase();
  const valid = ['not_started', 'documents', 'appointment', 'submitted', 'additional_docs', 'approved', 'rejected', 'pending', 'cancelled'];
  if (!valid.includes(status)) { return { ok: false, error: '未知签证状态' }; }

  if (existing) {
    existing.status = status;
    existing.updated_at = now;
    existing.steps = existing.steps || [];
    existing.steps.push({ status, at: now, note: body.note || null });
    if (['approved', 'rejected', 'pending', 'additional_docs'].includes(status)) {
      const result = db.stores.visa_results.insert({
        id: require('./lib/util').id('visa_result'),
        visa_case_id: existing.id,
        outcome: status,
        note: body.note || null,
        created_at: now
      });
      existing.result = status;
      audit.record({ actor, action: 'visa:result', entity: 'visa_case', entity_id: existing.id, to: { outcome: status } });
      return { ...existing, result };
    }
    audit.record({ actor, action: 'visa:status', entity: 'visa_case', entity_id: existing.id, to: { status } });
    return existing;
  }

  const record = db.stores.visa_cases.insert({
    id: require('./lib/util').id('visa_case'),
    application_id: applicationId,
    status,
    steps: [{ status, at: now, note: body.note || null }],
    result: ['approved', 'rejected', 'pending', 'additional_docs'].includes(status) ? status : null,
    created_at: now,
    updated_at: now
  });
  audit.record({ actor, action: 'visa:case_create', entity: 'visa_case', entity_id: record.id, to: { status } });
  return record;
}

// ===========================================================================
// Static clients + SPA fallback
// ===========================================================================
const publicDir = path.join(__dirname, 'public-world');
app.use(express.static(publicDir, { maxAge: '5m' }));

// Unknown API paths return JSON, never the SPA shell.
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: '接口不存在' }));

// Extensionless client routes must serve the right shell, not the selector.
const CLIENT_FILES = {
  '/student': 'student.html',
  '/agent': 'agent.html',
  '/dbc': 'dbc.html',
  '/ads': 'ads.html',
  '/admin': 'admin.html',
  '/institution': 'institution.html',
  '/supplier/education': 'supplier/education.html',
  '/supplier/medical': 'supplier/medical.html',
  '/supplier/certification': 'supplier/certification.html',
  '/supplier/visa': 'supplier/visa.html',
  '/supplier/accommodation': 'supplier/accommodation.html',
  '/supplier/finance': 'supplier/finance.html'
};
for (const [route, file] of Object.entries(CLIENT_FILES)) {
  app.get(route, (req, res) => res.sendFile(path.join(publicDir, file)));
}

app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.use((err, req, res, next) => {
  const status = err && err.status ? err.status : 500;
  res.status(status).json({ ok: false, error: status === 400 ? '请求格式错误' : '服务器内部错误' });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  await db.ensureLoaded();
  const result = seed.seed();
  // Fix 5: revoke sessions issued earlier to admin demo accounts so old
  // public admin-demo tokens stop working after this deploy.
  if (String(process.env.PUBLIC_ADMIN_DEMO || 'false').toLowerCase() !== 'true') {
    const adminDemoIds = new Set(db.stores.users.all()
      .filter((u) => u.is_demo)
      .filter((u) => { const r = auth.ROLES[String(u.role).toUpperCase()]; return r && r.audience === 'ADMIN'; })
      .map((u) => u.id));
    let revoked = 0;
    for (const session of db.stores.sessions.all()) {
      if (adminDemoIds.has(String(session.user_id))) {
        db.stores.sessions.remove(session.id);
        revoked += 1;
      }
    }
    if (revoked) {
      await db.flush();
      // eslint-disable-next-line no-console
      console.log('[boot] revoked ' + revoked + ' admin demo session(s)');
    }
  }
  if (result.seeded) {
    // eslint-disable-next-line no-console
    console.log('[boot] demo data seeded (' + Object.keys(result.suppliers || {}).length + ' supplier types)');
  }
  await db.flush();
  return { db: db.backend, seeded: result.seeded };
}

if (require.main === module) {
  boot().then(() => {
    app.listen(process.env.PORT || 3000, '0.0.0.0', () => {
      // eslint-disable-next-line no-console
      console.log('AETHEL EDU / GlobalStudy FULL MVP V' + VERSION + ' running on ' + (process.env.PORT || 3000));
    });
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[boot] failed', err);
    process.exit(1);
  });
}

module.exports = { app, VERSION, boot };
