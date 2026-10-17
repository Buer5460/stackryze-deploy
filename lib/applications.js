'use strict';
// ---------------------------------------------------------------------------
// Unified S0–S10 application engine used by every client and every supplier
// type. One state machine, one timeline, one todo generator.
//
// Every stage carries: owner, status, started_at, completed_at, deadline,
// todos, documents, messages, audit_logs. Views: kanban / timeline / list.
// ---------------------------------------------------------------------------
const db = require('./db');
const auth = require('./auth');
const config = require('./config');
const binding = require('./binding');
const { id, iso, today, addDays, isPast, lower, clone, asNumber, truthy, daysBetween } = require('./util');
const audit = require('./audit');

const apps = () => db.stores.applications;
const stages = () => db.stores.application_stages;
const timelines = () => db.stores.application_timeline;
const todos = () => db.stores.application_todos;

// ---------------------------------------------------------------------------
// Stage template: what each stage expects, and who owns it
// ---------------------------------------------------------------------------
const STAGE_TODOS = {
  S0: [
    { key: 'collect_contact', label_zh: '收集学生联系方式', label_en: 'Collect student contact' },
    { key: 'confirm_requirement', label_zh: '确认留学需求', label_en: 'Confirm requirement' }
  ],
  S1: [
    { key: 'match_supplier', label_zh: '匹配学校 / 供应商', label_en: 'Match school / supplier' },
    { key: 'confirm_program', label_zh: '确认课程', label_en: 'Confirm program' }
  ],
  S2: [
    { key: 'prepare_application_form', label_zh: '准备申请表', label_en: 'Prepare application form' },
    { key: 'submit_application', label_zh: '提交申请', label_en: 'Submit application' }
  ],
  S3: [
    { key: 'upload_transcript', label_zh: '上传成绩单', label_en: 'Upload transcript' },
    { key: 'upload_passport', label_zh: '上传护照', label_en: 'Upload passport' },
    { key: 'upload_language_score', label_zh: '上传语言成绩', label_en: 'Upload language score' }
  ],
  S4: [
    { key: 'schedule_interview', label_zh: '预约面试 / 测试', label_en: 'Schedule interview / test' },
    { key: 'attend_interview', label_zh: '完成面试 / 测试', label_en: 'Attend interview / test' }
  ],
  S5: [
    { key: 'await_admission', label_zh: '等待录取结果', label_en: 'Await admission result' },
    { key: 'accept_offer', label_zh: '接受 Offer', label_en: 'Accept offer' }
  ],
  S6: [
    { key: 'review_offer_contract', label_zh: '确认录取合同条款', label_en: 'Review offer terms' },
    { key: 'pay_deposit', label_zh: '支付押金 / 留位费', label_en: 'Pay deposit' }
  ],
  S7: [
    { key: 'prepare_visa_documents', label_zh: '准备签证材料', label_en: 'Prepare visa documents' },
    { key: 'submit_visa', label_zh: '递交签证', label_en: 'Submit visa' }
  ],
  S8: [
    { key: 'arrange_accommodation', label_zh: '安排住宿', label_en: 'Arrange accommodation' },
    { key: 'pre_departure_briefing', label_zh: '行前说明', label_en: 'Pre-departure briefing' }
  ],
  S9: [
    { key: 'confirm_enrollment', label_zh: '确认入学', label_en: 'Confirm enrollment' },
    { key: 'complete_registration', label_zh: '完成注册', label_en: 'Complete registration' }
  ],
  S10: [
    { key: 'settle_commission', label_zh: '结算佣金', label_en: 'Settle commission' }
  ]
};

function createApplication(input, actor) {
  // Rule 2: only a bound C can create an application (the B does it on their
  // behalf through the binding).
  const b = binding.currentBinding(input.c_profile_id);
  if (!b) return { ok: false, error: 'C 尚未绑定服务机构，无法创建申请', code: 'C_UNBOUND' };

  const record = {
    id: id('application'),
    c_profile_id: input.c_profile_id,
    b_organization_id: b.b_organization_id,
    supplier_id: input.supplier_id || null,
    product_id: input.product_id || null,
    institution_id: input.institution_id || null,
    program_id: input.program_id || null,
    title: input.title || null,
    current_stage: 'S0',
    status: 'active',
    priority: asNumber(input.priority, 0),
    created_at: iso(),
    updated_at: iso()
  };
  const saved = apps().insert(record);

  // Open S0 and seed the whole stage skeleton so the kanban/timeline always
  // show the full S0–S10 arc.
  for (const stage of auth.STAGES) openStage(saved.id, stage.code, actor, { silent: true });

  audit.record({ actor, action: 'application:create', entity: 'application', entity_id: saved.id, to: { stage: saved.current_stage } });
  return { ok: true, application: saved };
}

function openStage(applicationId, stageCode, actor, options = {}) {
  const meta = auth.stageMeta(stageCode);
  if (!meta) return null;
  const existing = stages().find((s) => String(s.application_id) === String(applicationId) && s.code === meta.code);
  if (existing) return existing;
  const stageTodos = (STAGE_TODOS[meta.code] || []).map((t) => ({ ...t, status: 'pending' }));
  const record = stages().insert({
    id: id('application_stage'),
    application_id: applicationId,
    code: meta.code,
    key: meta.key,
    owner: meta.owner,                              // ADMIN | B | C | S
    status: meta.code === 'S0' ? 'in_progress' : 'pending',
    started_at: meta.code === 'S0' ? iso() : null,
    completed_at: null,
    deadline: options.deadline || null,
    todos: stageTodos,
    documents: [],
    messages: [],
    audit_log_ids: [],
    note: null
  });
  // Materialise each stage todo as a real record so every client can complete,
  // reassign and audit it. The stage mirror is kept in sync by add/complete.
  for (const t of stageTodos) {
    todos().insert({
      id: id('application_todo'),
      application_id: applicationId,
      stage: meta.code,
      title: t.label_zh,
      title_en: t.label_en,
      owner: meta.owner,
      due_at: options.deadline || null,
      status: 'pending',
      created_at: iso()
    });
  }
  const entry = timelines().insert({
    id: id('application_timeline'),
    application_id: applicationId,
    stage: meta.code,
    event: 'opened',
    at: iso(),
    by: (actor && actor.id) || 'system'
  });
  if (!options.silent) {
    audit.record({ actor, action: 'application:stage_open', entity: 'application', entity_id: applicationId, to: { stage: meta.code } });
  }
  return { stage: record, timeline: entry };
}

function applicationById(appId) { return apps().byId(appId); }

function stageOf(applicationId, stageCode) {
  return stages().find((s) => String(s.application_id) === String(applicationId) && s.code === String(stageCode).toUpperCase()) || null;
}

function currentStage(applicationId) {
  const app = apps().byId(applicationId);
  if (!app) return null;
  return stageOf(applicationId, app.current_stage);
}

// ---------------------------------------------------------------------------
// Transition — the only way an application moves between stages
// ---------------------------------------------------------------------------
function transition(applicationId, target, actor, options = {}) {
  const app = apps().byId(applicationId);
  if (!app) return { ok: false, error: '申请不存在' };
  const targetCode = String(target).toUpperCase();
  const from = app.current_stage;
  if (targetCode === from) return { ok: false, error: '已在目标阶段' };
  if (!auth.canTransition(from, targetCode)) {
    return { ok: false, error: '非法的阶段流转：' + from + ' → ' + targetCode };
  }

  // Stage-entry gate: outstanding todos on the current stage block forward
  // progress unless the caller forces it (e.g. an admin override).
  if (!options.force) {
    const blocking = listTodos({ application_id: applicationId })
      .filter((t) => String(t.stage).toUpperCase() === from && t.status !== 'done');
    if (blocking.length && targetCode !== 'CANCELLED') {
      return {
        ok: false,
        error: '当前阶段存在未完成的待办',
        code: 'STAGE_TODOS_INCOMPLETE',
        blocking: blocking.map((t) => t.title)
      };
    }
  }

  const currentStageRecord = stageOf(applicationId, from);
  if (currentStageRecord && currentStageRecord.status !== 'completed') {
    currentStageRecord.status = 'completed';
    currentStageRecord.completed_at = iso();
    for (const t of currentStageRecord.todos || []) if (t.status !== 'done') t.status = 'done';
    timelines().insert({
      id: id('application_timeline'),
      application_id: applicationId,
      stage: from,
      event: 'completed',
      at: iso(),
      by: (actor && actor.id) || 'system'
    });
  }

  const nextRecord = stageOf(applicationId, targetCode);
  if (nextRecord) {
    nextRecord.status = 'in_progress';
    nextRecord.started_at = iso();
    nextRecord.owner = actor ? auth.ROLES[actor.role].audience : nextRecord.owner;
  }

  app.current_stage = targetCode;
  app.updated_at = iso();
  if (auth.TERMINAL_STAGES.includes(targetCode)) {
    app.status = lower(targetCode) === 's10' ? 'completed' : lower(targetCode);
    app.closed_at = iso();
  }

  timelines().insert({
    id: id('application_timeline'),
    application_id: applicationId,
    stage: targetCode,
    event: 'entered',
    at: iso(),
    by: (actor && actor.id) || 'system',
    note: options.note || null
  });

  audit.record({
    actor,
    action: 'application:transition',
    entity: 'application',
    entity_id: applicationId,
    from: { stage: from },
    to: { stage: targetCode }
  });

  // Reaching S10 is the commission trigger event.
  if (targetCode === 'S10') {
    db.stores.commission_triggers.insert({
      id: id('commission_trigger'),
      application_id: applicationId,
      trigger_event: 'APPLICATION_REACHED_S10',
      fired_at: iso()
    });
  }

  return { ok: true, application: app };
}

// ---------------------------------------------------------------------------
// Todos
// ---------------------------------------------------------------------------
function addTodo(applicationId, input, actor) {
  const record = todos().insert({
    id: id('application_todo'),
    application_id: applicationId,
    stage: input.stage || null,
    title: input.title,
    title_en: input.title_en || null,
    owner: input.owner || 'B',
    due_at: input.due_at || null,
    status: 'pending',
    created_at: iso()
  });
  const stage = input.stage ? stageOf(applicationId, input.stage) : null;
  if (stage) {
    stage.todos = stage.todos || [];
    stage.todos.push({ key: record.id, label_zh: record.title, label_en: record.title_en || record.title, status: 'pending', owner: record.owner });
  }
  audit.record({ actor, action: 'todo:add', entity: 'application', entity_id: applicationId, to: record });
  return record;
}

function completeTodo(todoId, actor) {
  const todo = todos().byId(todoId);
  if (!todo) return { ok: false, error: '待办不存在' };
  todo.status = 'done';
  todo.completed_at = iso();
  // Keep the stage mirror in sync: the mirror stores the todo record id in `key`.
  const stage = todo.stage ? stageOf(todo.application_id, todo.stage) : null;
  if (stage && Array.isArray(stage.todos)) {
    const item = stage.todos.find((t) => t.key === todo.id);
    if (item) item.status = 'done';
  }
  audit.record({ actor, action: 'todo:complete', entity: 'application_todo', entity_id: todo.id, to: todo });
  return { ok: true, todo };
}

function listTodos(filters = {}) {
  let items = todos().all();
  if (filters.application_id) items = items.filter((t) => String(t.application_id) === String(filters.application_id));
  if (filters.owner) items = items.filter((t) => lower(t.owner) === lower(filters.owner));
  if (filters.status) items = items.filter((t) => lower(t.status) === lower(filters.status));
  if (filters.b_organization_id) {
    const mine = new Set(apps().filter((a) => String(a.b_organization_id) === String(filters.b_organization_id)).map((a) => a.id));
    items = items.filter((t) => mine.has(t.application_id));
  }
  if (filters.c_profile_id) {
    const mine = new Set(apps().filter((a) => String(a.c_profile_id) === String(filters.c_profile_id)).map((a) => a.id));
    items = items.filter((t) => mine.has(t.application_id));
  }
  if (filters.supplier_id) {
    const mine = new Set(apps().filter((a) => String(a.supplier_id) === String(filters.supplier_id)).map((a) => a.id));
    items = items.filter((t) => mine.has(t.application_id));
  }
  return items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

// ---------------------------------------------------------------------------
// Documents (C upload → B confirm → S confirm) and OCR family library
// ---------------------------------------------------------------------------
const DOCUMENT_TYPES = ['passport', 'transcript', 'degree', 'language_score', 'offer', 'visa', 'medical', 'certification', 'other'];

function uploadDocument(applicationId, input, actor) {
  const app = apps().byId(applicationId);
  if (!app) return { ok: false, error: '申请不存在' };
  const doc = db.stores.family_documents.insert({
    id: id('family_document'),
    c_profile_id: app.c_profile_id,
    application_id: applicationId,
    type: input.type || 'other',
    file_name: input.file_name || null,
    file_url: input.file_url || null,
    mime_type: input.mime_type || null,
    size_bytes: asNumber(input.size_bytes, null),
    // Sandbox OCR (Rule 25): classification is a mock, clearly labelled.
    ocr: {
      provider: config.get('providers.ocr.provider', 'sandbox'),
      mode: 'sandbox',
      classified_as: input.type || 'other',
      extracted_fields: input.ocr_fields || {},
      sandbox: true,
      run_at: iso()
    },
    status: 'uploaded',     // uploaded → b_confirmed → s_confirmed | rejected
    version: 1,
    created_at: iso(),
    updated_at: iso()
  });
  const version = db.stores.document_versions.insert({
    id: id('document_version'),
    document_id: doc.id,
    version: 1,
    file_name: doc.file_name,
    file_url: doc.file_url,
    uploaded_by: (actor && actor.id) || null,
    created_at: iso()
  });
  attachToStage(applicationId, 'S3', 'document', doc.id);
  audit.record({ actor, action: 'document:upload', entity: 'application', entity_id: applicationId, to: { document_id: doc.id, type: doc.type, ocr: 'sandbox' } });
  return { ok: true, document: doc, version };
}

// Two-way (actually three-way) confirmation: C upload → B confirm → S confirm.
function confirmDocument(documentId, confirmer, actor, note) {
  const doc = db.stores.family_documents.byId(documentId);
  if (!doc) return { ok: false, error: '材料不存在' };
  const party = String(confirmer).toUpperCase();
  if (party === 'B') {
    doc.status = 'b_confirmed';
    doc.b_confirmed_at = iso();
    doc.b_confirmed_by = (actor && actor.id) || null;
  } else if (party === 'S') {
    if (lower(doc.status) !== 'b_confirmed') {
      return { ok: false, error: '必须先由 B 确认' };
    }
    doc.status = 's_confirmed';
    doc.s_confirmed_at = iso();
    doc.s_confirmed_by = (actor && actor.id) || null;
  } else {
    return { ok: false, error: '确认方必须为 B 或 S' };
  }
  doc.updated_at = iso();
  if (note) doc.note = note;
  audit.record({ actor, action: 'document:confirm', entity: 'family_document', entity_id: doc.id, to: { party, status: doc.status } });
  return { ok: true, document: doc };
}

function rejectDocument(documentId, actor, reason) {
  const doc = db.stores.family_documents.byId(documentId);
  if (!doc) return { ok: false, error: '材料不存在' };
  doc.status = 'rejected';
  doc.rejected_reason = reason || null;
  doc.updated_at = iso();
  audit.record({ actor, action: 'document:reject', entity: 'family_document', entity_id: doc.id, to: { reason } });
  return { ok: true, document: doc };
}

function attachToStage(applicationId, stageCode, kind, refId) {
  const stage = stageOf(applicationId, stageCode);
  if (!stage) return null;
  stage[kind === 'document' ? 'documents' : kind === 'message' ? 'messages' : 'documents'] =
    stage[kind === 'document' ? 'documents' : 'documents'] || [];
  stage[kind === 'document' ? 'documents' : 'documents'].push(refId);
  return stage;
}

// Rule: student sensitive data is only readable with an explicit authorization.
function authorizeDocument(documentId, grantee, scope, actor, expiresInDays = 30) {
  const record = db.stores.document_authorizations.insert({
    id: id('document_authorization'),
    document_id: documentId,
    granted_to_type: String(grantee.type || 'S').toUpperCase(),   // S | DBC
    granted_to_id: grantee.id,
    scope: scope || 'read',
    granted_by: (actor && actor.id) || null,
    granted_at: iso(),
    expires_at: addDays(new Date(), expiresInDays).toISOString(),
    revoked_at: null,
    status: 'active'
  });
  audit.record({ actor, action: 'document:authorize', entity: 'family_document', entity_id: documentId, to: record });
  return record;
}

function revokeAuthorization(authorizationId, actor) {
  const auth = db.stores.document_authorizations.byId(authorizationId);
  if (!auth) return { ok: false, error: '授权不存在' };
  auth.status = 'revoked';
  auth.revoked_at = iso();
  audit.record({ actor, action: 'document:authorize_revoke', entity: 'document_authorization', entity_id: auth.id, to: auth });
  return { ok: true, authorization: auth };
}

function activeAuthorizations(documentId) {
  const now = new Date();
  return db.stores.document_authorizations.filter((a) =>
    String(a.document_id) === String(documentId) &&
    lower(a.status) === 'active' &&
    (!a.expires_at || new Date(a.expires_at) >= now));
}

function canReadDocument(documentId, granteeType, granteeId) {
  return activeAuthorizations(documentId).some((a) =>
    lower(a.granted_to_type) === lower(granteeType) && String(a.granted_to_id) === String(granteeId));
}

function documentsOf(applicationId) {
  return db.stores.family_documents.filter((d) => String(d.application_id) === String(applicationId));
}

// Family library: one upload, reused across applications.
function familyLibraryOfC(cProfileId) {
  return db.stores.family_documents
    .filter((d) => String(d.c_profile_id) === String(cProfileId))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

// ---------------------------------------------------------------------------
// Views: kanban / timeline / list
// ---------------------------------------------------------------------------
function applicationDetail(applicationId) {
  const app = apps().byId(applicationId);
  if (!app) return null;
  const stageRecords = stages().filter((s) => String(s.application_id) === String(applicationId))
    .sort((a, b) => auth.STAGE_CODES.indexOf(a.code) - auth.STAGE_CODES.indexOf(b.code));
  return {
    ...app,
    stages: stageRecords,
    timeline: timelines().filter((t) => String(t.application_id) === String(applicationId))
      .sort((a, b) => (a.at < b.at ? 1 : -1)),
    documents: documentsOf(applicationId),
    todos: listTodos({ application_id: applicationId })
  };
}

function kanban(organizationScope) {
  const appsList = scopedApplications(organizationScope);
  const columns = auth.STAGES.map((s) => ({
    code: s.code,
    label_zh: s.label_zh,
    label_en: s.label_en,
    owner: s.owner,
    items: appsList.filter((a) => a.current_stage === s.code).map((a) => summary(a))
  }));
  const terminal = ['REJECTED', 'CANCELLED', 'WITHDRAWN'].map((code) => ({
    code,
    label_zh: code,
    label_en: code,
    owner: 'SYSTEM',
    items: appsList.filter((a) => a.current_stage === code).map((a) => summary(a))
  }));
  return [...columns, ...terminal];
}

function timelineView(applicationId) {
  const app = applicationDetail(applicationId);
  if (!app) return null;
  return {
    application_id: app.id,
    current_stage: app.current_stage,
    events: app.timeline,
    stages: app.stages.map((s) => ({
      code: s.code, owner: s.owner, status: s.status,
      started_at: s.started_at, completed_at: s.completed_at, deadline: s.deadline,
      todos: s.todos
    }))
  };
}

function listView(organizationScope) {
  return scopedApplications(organizationScope).map((a) => ({
    id: a.id,
    title: a.title,
    current_stage: a.current_stage,
    status: a.status,
    c_profile_id: a.c_profile_id,
    b_organization_id: a.b_organization_id,
    supplier_id: a.supplier_id,
    updated_at: a.updated_at
  }));
}

function scopedApplications(scope) {
  let items = apps().all();
  if (scope && scope.b_organization_id) items = items.filter((a) => String(a.b_organization_id) === String(scope.b_organization_id));
  if (scope && scope.c_profile_id) items = items.filter((a) => String(a.c_profile_id) === String(scope.c_profile_id));
  if (scope && scope.supplier_id) items = items.filter((a) => String(a.supplier_id) === String(scope.supplier_id));
  return items.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
}

function summary(app) {
  return {
    id: app.id,
    title: app.title,
    current_stage: app.current_stage,
    status: app.status,
    c_profile_id: app.c_profile_id,
    supplier_id: app.supplier_id,
    updated_at: app.updated_at
  };
}

function listApplications(filters = {}) {
  return scopedApplications(filters);
}

module.exports = {
  STAGE_TODOS, DOCUMENT_TYPES,
  createApplication, applicationById, stageOf, currentStage, transition,
  addTodo, completeTodo, listTodos,
  uploadDocument, confirmDocument, rejectDocument,
  authorizeDocument, revokeAuthorization, activeAuthorizations, canReadDocument,
  documentsOf, familyLibraryOfC,
  applicationDetail, kanban, timelineView, listView, listApplications,
  openStage
};
