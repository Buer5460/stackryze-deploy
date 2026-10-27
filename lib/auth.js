'use strict';
// ---------------------------------------------------------------------------
// Roles, permissions and the demo authentication surface.
//
// This is a real RBAC implementation (not a header check): a session carries
// the actor, and every route resolves the actor's permissions from the role
// catalogue below. Demo accounts exist so the MVP can be operated without a
// real identity provider; real registration creates the same role records.
// ---------------------------------------------------------------------------
const db = require('./db');
const { id, iso, now, lower, clone, hashString } = require('./util');

// ---------------------------------------------------------------------------
// Role catalogue (hard rules of the platform)
// ---------------------------------------------------------------------------
const ROLES = {
  ADMIN_SUPER: {
    id: 'ADMIN_SUPER', audience: 'ADMIN', label_zh: '平台超级管理员', label_en: 'Platform super admin',
    permissions: ['*']
  },
  ADMIN_OPERATION: {
    id: 'ADMIN_OPERATION', audience: 'ADMIN', label_zh: '平台运营', label_en: 'Platform operations',
    permissions: [
      'admin:dashboard', 'admin:users', 'admin:verify', 'admin:b', 'admin:c', 'admin:s', 'admin:dbc',
      'admin:recommendation', 'admin:binding', 'admin:contract', 'admin:application', 'admin:document',
      'admin:visa', 'admin:review', 'admin:dispute', 'admin:message', 'admin:brief', 'admin:config', 'admin:analytics', 'admin:analytics:delete',
      'admin:membership', 'admin:ads', 'admin:report'
    ]
  },
  ADMIN_ANALYTICS: {
    id: 'ADMIN_ANALYTICS', audience: 'ADMIN', label_zh: '统计只读', label_en: 'Analytics viewer',
    permissions: ['admin:analytics']
  },
  ADMIN_FINANCE: {
    id: 'ADMIN_FINANCE', audience: 'ADMIN', label_zh: '平台财务', label_en: 'Platform finance',
    permissions: [
      'admin:dashboard', 'admin:commission', 'admin:payment', 'admin:settlement', 'admin:report',
      'admin:dispute', 'admin:membership'
    ]
  },
  ADMIN_AUDIT: {
    id: 'ADMIN_AUDIT', audience: 'ADMIN', label_zh: '平台审计', label_en: 'Platform auditor',
    permissions: ['admin:dashboard', 'admin:audit', 'admin:report', 'admin:binding', 'admin:contract']
  },

  B_OWNER: {
    id: 'B_OWNER', audience: 'B', label_zh: '机构负责人', label_en: 'Agency owner',
    permissions: [
      'b:profile', 'b:membership', 'b:kyc', 'b:client', 'b:binding', 'b:crm', 'b:resource', 'b:application',
      'b:document', 'b:visa', 'b:payment', 'b:contract', 'b:settlement', 'b:performance', 'b:dispute',
      'b:message', 'b:brief', 'b:todo', 'b:team', 'b:assistant', 'b:multicurrency', 'b:ads'
    ]
  },
  B_COUNSELLOR: {
    id: 'B_COUNSELLOR', audience: 'B', label_zh: '顾问', label_en: 'Counsellor',
    permissions: [
      'b:profile', 'b:client', 'b:binding', 'b:crm', 'b:resource', 'b:application', 'b:document',
      'b:visa', 'b:payment', 'b:message', 'b:brief', 'b:todo', 'b:assistant'
    ]
  },
  B_DOCUMENT: {
    id: 'B_DOCUMENT', audience: 'B', label_zh: '材料专员', label_en: 'Document specialist',
    permissions: ['b:profile', 'b:crm', 'b:document', 'b:application', 'b:message', 'b:todo', 'b:visa']
  },
  B_FINANCE: {
    id: 'B_FINANCE', audience: 'B', label_zh: '机构财务', label_en: 'Agency finance',
    permissions: ['b:profile', 'b:settlement', 'b:payment', 'b:contract', 'b:multicurrency', 'b:performance', 'b:report']
  },
  B_VIEWER: {
    id: 'B_VIEWER', audience: 'B', label_zh: '只读成员', label_en: 'Viewer',
    permissions: ['b:profile', 'b:crm', 'b:application', 'b:resource']
  },

  C_PARENT: {
    id: 'C_PARENT', audience: 'C', label_zh: '家长', label_en: 'Parent',
    permissions: [
      'c:profile', 'c:discover', 'c:requirement', 'c:recommendation', 'c:binding', 'c:application',
      'c:document', 'c:visa_view', 'c:payment', 'c:review', 'c:message', 'c:brief', 'c:todo', 'c:unbind'
    ]
  },
  C_STUDENT: {
    id: 'C_STUDENT', audience: 'C', label_zh: '学生', label_en: 'Student',
    permissions: [
      'c:profile', 'c:discover', 'c:requirement', 'c:recommendation', 'c:binding', 'c:application',
      'c:document', 'c:visa_view', 'c:payment', 'c:review', 'c:message', 'c:brief', 'c:todo', 'c:unbind'
    ]
  },

  S_OWNER: {
    id: 'S_OWNER', audience: 'S', label_zh: '供应商负责人', label_en: 'Supplier owner',
    permissions: [
      's:profile', 's:kyc', 's:product', 's:application', 's:document', 's:visa', 's:commission',
      's:agreement', 's:settlement', 's:message', 's:todo', 's:audit', 's:ads', 's:review'
    ]
  },
  S_ADMISSION: {
    id: 'S_ADMISSION', audience: 'S', label_zh: '招生专员', label_en: 'Admissions officer',
    permissions: ['s:profile', 's:application', 's:document', 's:message', 's:todo', 's:product']
  },
  S_OPERATION: {
    id: 'S_OPERATION', audience: 'S', label_zh: '运营', label_en: 'Operations',
    permissions: ['s:profile', 's:product', 's:application', 's:document', 's:message', 's:todo', 's:ads']
  },
  S_FINANCE: {
    id: 'S_FINANCE', audience: 'S', label_zh: '供应商财务', label_en: 'Supplier finance',
    permissions: ['s:profile', 's:commission', 's:agreement', 's:settlement', 's:report']
  },
  S_VIEWER: {
    id: 'S_VIEWER', audience: 'S', label_zh: '只读成员', label_en: 'Viewer',
    permissions: ['s:profile', 's:application']
  },

  DBC_OWNER: {
    id: 'DBC_OWNER', audience: 'DBC', label_zh: 'DBC 负责人', label_en: 'DBC owner',
    permissions: [
      'dbc:profile', 'dbc:agreement', 'dbc:supplier', 'dbc:b', 'dbc:application', 'dbc:student',
      'dbc:document', 'dbc:visa', 'dbc:settlement', 'dbc:dispute', 'dbc:message', 'dbc:brief',
      'dbc:todo', 'dbc:report', 'dbc:audit'
    ]
  },
  DBC_OPERATION: {
    id: 'DBC_OPERATION', audience: 'DBC', label_zh: 'DBC 运营', label_en: 'DBC operations',
    permissions: [
      'dbc:profile', 'dbc:supplier', 'dbc:b', 'dbc:application', 'dbc:student', 'dbc:document',
      'dbc:visa', 'dbc:message', 'dbc:todo'
    ]
  },
  DBC_FINANCE: {
    id: 'DBC_FINANCE', audience: 'DBC', label_zh: 'DBC 财务', label_en: 'DBC finance',
    permissions: ['dbc:profile', 'dbc:settlement', 'dbc:report']
  }
};

// Which audience each role serves — used for cross-audience isolation.
const ROLE_AUDIENCE = {};
for (const [key, role] of Object.entries(ROLES)) ROLE_AUDIENCE[key] = role.audience;

const AUDIENCE_ROUTES = {
  ADMIN: '/admin',
  B: '/agent',
  C: '/student',
  S: '/supplier',
  DBC: '/dbc'
};

// ---------------------------------------------------------------------------
// Supplier types (S1–S6 this round; future types are reserved only)
// ---------------------------------------------------------------------------
const SUPPLIER_TYPES = {
  EDUCATION: { id: 'EDUCATION', label_zh: '教育机构 / 学校', label_en: 'Education / School', route: '/supplier/education', order: 1 },
  MEDICAL: { id: 'MEDICAL', label_zh: '体检机构', label_en: 'Medical check-up', route: '/supplier/medical', order: 2 },
  CERTIFICATION: { id: 'CERTIFICATION', label_zh: '文件认证机构', label_en: 'Document certification', route: '/supplier/certification', order: 3 },
  VISA: { id: 'VISA', label_zh: '签证代办机构', label_en: 'Visa agency', route: '/supplier/visa', order: 4 },
  ACCOMMODATION: { id: 'ACCOMMODATION', label_zh: '学生住宿机构', label_en: 'Student accommodation', route: '/supplier/accommodation', order: 5 },
  FINANCE: { id: 'FINANCE', label_zh: '留学贷款 / 教育金融', label_en: 'Education finance', route: '/supplier/finance', order: 6, default_enabled: false }
};

const RESERVED_SUPPLIER_TYPES = ['INSURANCE', 'TRAINING', 'TRANSLATION', 'TRANSPORT', 'OTHER'];

// ---------------------------------------------------------------------------
// B membership tiers
// ---------------------------------------------------------------------------
const B_LEVELS = {
  FREE: { id: 'FREE', rank: 0, label_zh: '免费会员', label_en: 'Free' },
  LEVEL_1: { id: 'LEVEL_1', rank: 1, label_zh: 'Level 1 Premium', label_en: 'Level 1 Premium' },
  LEVEL_2: { id: 'LEVEL_2', rank: 2, label_zh: 'Level 2 Executive', label_en: 'Level 2 Executive' }
};

// ---------------------------------------------------------------------------
// S0–S10 unified application state machine
// ---------------------------------------------------------------------------
const STAGES = [
  { code: 'S0', key: 'LEAD', label_zh: '意向', label_en: 'Lead', owner: 'B' },
  { code: 'S1', key: 'MATCHING', label_zh: '匹配', label_en: 'Matching', owner: 'B' },
  { code: 'S2', key: 'APPLICATION', label_zh: '申请', label_en: 'Application', owner: 'B' },
  { code: 'S3', key: 'DOCUMENTS', label_zh: '材料', label_en: 'Documents', owner: 'C' },
  { code: 'S4', key: 'INTERVIEW', label_zh: '面试 / 测试', label_en: 'Interview / Test', owner: 'S' },
  { code: 'S5', key: 'ADMISSION', label_zh: '录取', label_en: 'Admission', owner: 'S' },
  { code: 'S6', key: 'CONTRACT', label_zh: '合同', label_en: 'Contract', owner: 'S' },
  { code: 'S7', key: 'VISA', label_zh: '签证', label_en: 'Visa', owner: 'B' },
  { code: 'S8', key: 'PRE_DEPARTURE', label_zh: '行前', label_en: 'Pre-departure', owner: 'B' },
  { code: 'S9', key: 'ENROLLMENT', label_zh: '入学', label_en: 'Enrollment', owner: 'S' },
  { code: 'S10', key: 'COMMISSION', label_zh: '佣金结算', label_en: 'Commission settlement', owner: 'ADMIN' }
];

const STAGE_CODES = STAGES.map((s) => s.code);

// Legal transitions. `*` allows the next sequential stage only.
const STAGE_TRANSITIONS = {
  S0: ['S1', 'CANCELLED'],
  S1: ['S2', 'CANCELLED'],
  S2: ['S3', 'REJECTED', 'CANCELLED'],
  S3: ['S4', 'CANCELLED'],
  S4: ['S5', 'REJECTED', 'CANCELLED'],
  S5: ['S6', 'REJECTED', 'CANCELLED'],
  S6: ['S7', 'CANCELLED'],
  S7: ['S8', 'REJECTED', 'CANCELLED'],
  S8: ['S9', 'CANCELLED'],
  S9: ['S10', 'CANCELLED'],
  S10: []
};

const TERMINAL_STAGES = ['S10', 'REJECTED', 'CANCELLED', 'WITHDRAWN'];

function stageMeta(code) {
  return STAGES.find((s) => s.code === String(code).toUpperCase()) || null;
}

function nextStage(code) {
  const i = STAGE_CODES.indexOf(String(code).toUpperCase());
  if (i < 0 || i >= STAGE_CODES.length - 1) return null;
  return STAGE_CODES[i + 1];
}

function canTransition(from, to) {
  const allowed = STAGE_TRANSITIONS[String(from).toUpperCase()];
  return Boolean(allowed && allowed.includes(String(to).toUpperCase()));
}

// ---------------------------------------------------------------------------
// Users / sessions
// ---------------------------------------------------------------------------
const users = () => db.stores.users;
const sessions = () => db.stores.sessions;

function userPublic(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email || null,
    phone: user.phone || null,
    display_name: user.display_name || null,
    audience: user.audience,
    role: user.role,
    permissions: permissionsOf(user.role),
    organization_id: user.organization_id || null,
    org_role: user.org_role || null,
    language: user.language || 'zh',
    status: user.status || 'active',
    is_demo: Boolean(user.is_demo),
    created_at: user.created_at
  };
}

function permissionsOf(roleId) {
  const role = ROLES[String(roleId).toUpperCase()];
  return role ? role.permissions.slice() : [];
}

function hasPermission(roleId, permission) {
  const perms = permissionsOf(roleId);
  if (perms.includes('*')) return true;
  if (perms.includes(permission)) return true;
  // namespace wildcard, e.g. `b:*`
  const ns = permission.split(':')[0] + ':*';
  return perms.includes(ns);
}

function findUserByEmail(email) {
  return users().find((u) => lower(u.email) === lower(email)) || null;
}

function createUser(input) {
  const roleId = String((input && input.role) || 'C_STUDENT').toUpperCase();
  if (!ROLES[roleId]) throw new Error('未知角色: ' + input.role);
  // Privilege-assignment guard: public registration can never mint an ADMIN
  // audience account. Admin users are created through the authorized flow
  // (seed or an authenticated admin action), never from a request body.
  if (input.from_public_registration === true && ROLES[roleId].audience === 'ADMIN') {
    throw new Error('公开注册不能创建管理员账号');
  }
  const record = {
    id: id('user'),
    email: (input.email || '').toLowerCase() || null,
    phone: input.phone || null,
    password: input.password || null, // demo only; hashed below when present
    display_name: input.display_name || input.name || null,
    audience: ROLES[roleId].audience,
    role: roleId,
    organization_id: input.organization_id || null,
    org_role: input.org_role || null,
    language: input.language || 'zh',
    status: input.status || 'active',
    is_demo: Boolean(input.is_demo),
    invited_by: input.invited_by || null,
    created_at: iso()
  };
  if (record.password) record.password = 'sha256:' + hashString(record.password + '::' + record.id);
  return users().insert(record);
}

function verifyPassword(user, password) {
  if (!user || !user.password) return false;
  return user.password === 'sha256:' + hashString(String(password) + '::' + user.id);
}

function createSession(userId, meta) {
  const record = {
    id: id('session'),
    user_id: userId,
    token: 'tok-' + hashString(userId + ':' + Date.now() + ':' + Math.random()).slice(0, 32),
    created_at: iso(),
    last_seen_at: iso(),
    expires_at: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString(),
    ip: (meta && meta.ip) || null,
    user_agent: (meta && meta.user_agent) || null,
    is_demo: Boolean(meta && meta.is_demo)
  };
  return sessions().insert(record);
}

function resolveSession(token) {
  if (!token) return null;
  const session = sessions().find((s) => s.token === String(token));
  if (!session) return null;
  if (session.expires_at && new Date(session.expires_at).getTime() < Date.now()) return null;
  const user = users().byId(session.user_id);
  if (!user || lower(user.status) !== 'active') return null;
  return { session, user };
}

function destroySession(token) {
  const session = sessions().find((s) => s.token === String(token));
  if (!session) return false;
  return sessions().remove(session.id);
}

// ---------------------------------------------------------------------------
// Actor resolution + permission guards
// ---------------------------------------------------------------------------
function actorFromRequest(req) {
  const header = req.headers['authorization'] || '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
  const token = bearer || req.headers['x-session-token'] || null;
  const resolved = resolveSession(token);
  if (resolved) {
    resolved.session.last_seen_at = iso();
    return { user: resolved.user, session: resolved.session, mode: 'session' };
  }
  // Demo one-click login: token maps to a seeded demo user.
  const demoToken = req.headers['x-demo-token'] || req.query.demo_token || null;
  if (demoToken) {
    const user = users().find((u) => lower(u.demo_token) === lower(demoToken) && u.is_demo);
    if (user) {
      // Admin demo identity is gated: on the public surface (default) an admin
      // demo token must never resolve to an actor, even via a raw header.
      const adminDemoAllowed = String(process.env.PUBLIC_ADMIN_DEMO || 'false').toLowerCase() === 'true';
      const role = ROLES[String(user.role || '').toUpperCase()];
      const isAdmin = Boolean(role && role.audience === 'ADMIN');
      if (isAdmin && !adminDemoAllowed) return null;
      return { user, session: null, mode: 'demo' };
    }
  }
  return null;
}

function requirePermission(...permissions) {
  return (req, res, next) => {
    const actor = req.actor || actorFromRequest(req);
    if (!actor) return res.status(401).json({ ok: false, error: '未登录' });
    const allowed = permissions.some((p) => hasPermission(actor.user.role, p));
    if (!allowed) return res.status(403).json({ ok: false, error: '权限不足' });
    next();
  };
}

function requireRole(...roleIds) {
  const set = roleIds.map((r) => String(r).toUpperCase());
  return (req, res, next) => {
    const actor = req.actor || actorFromRequest(req);
    if (!actor) return res.status(401).json({ ok: false, error: '未登录' });
    if (!set.includes(String(actor.user.role).toUpperCase())) {
      return res.status(403).json({ ok: false, error: '角色不匹配：需要 ' + set.join(' / ') });
    }
    next();
  };
}

function requireAudience(audience) {
  return (req, res, next) => {
    const actor = req.actor || actorFromRequest(req);
    if (!actor) return res.status(401).json({ ok: false, error: '未登录' });
    const roleAudience = ROLES[String(actor.user.role).toUpperCase()];
    if (!roleAudience || roleAudience.audience !== audience) {
      return res.status(403).json({ ok: false, error: '客户端不匹配：本入口仅面向 ' + audience + ' 端' });
    }
    next();
  };
}

module.exports = {
  ROLES, ROLE_AUDIENCE, AUDIENCE_ROUTES, SUPPLIER_TYPES, RESERVED_SUPPLIER_TYPES, B_LEVELS,
  STAGES, STAGE_CODES, STAGE_TRANSITIONS, TERMINAL_STAGES,
  stageMeta, nextStage, canTransition,
  users, sessions, userPublic, permissionsOf, hasPermission, findUserByEmail, createUser,
  verifyPassword, createSession, resolveSession, destroySession,
  actorFromRequest, requirePermission, requireRole, requireAudience,
  clone
};
