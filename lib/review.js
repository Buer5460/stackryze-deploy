// Review queue + status state machine for imported/real school data (V1.0).
//
// Draft → Pending Review → Verified → Expired / Rejected
// - Draft → Pending Review: submit
// - Pending → Verified: approve (requires verified_at)
// - Pending → Rejected: reject(reason)
// - Pending → Draft: requestInfo(note)
// - Verified → Expired: expire (effective_to passed)
// Field changes on tuition / scholarships / deadlines / admission requirements
// of a pending-or-verified school force it back to Pending Review.

const store = require('./store');

const TRANSITIONS = {
  draft: ['pending', 'rejected'],
  pending: ['verified', 'rejected', 'draft'],
  verified: ['expired', 'pending', 'draft'],
  expired: ['pending', 'draft'],
  rejected: ['draft'],
};

function allowedTransition(from, to) {
  const allowed = TRANSITIONS[from] || [];
  return allowed.includes(to);
}

// Fields whose change triggers re-review (per task: tuition, scholarships,
// deadlines, admission requirements).
const REVIEW_SENSITIVE_FIELDS = [
  'tuition_min', 'tuition_max', 'tuition_fee', 'first_year_cost_min', 'first_year_cost_max',
  'boarding_fee', 'one_time_fees', 'scholarships', 'programs',
];

function computeStatusChange(school, changedFields) {
  const sensitiveChanged = (changedFields || []).some((f) => REVIEW_SENSITIVE_FIELDS.includes(f));
  if (!sensitiveChanged) return null;
  const current = String(school.verified_status || 'draft').toLowerCase();
  if (current === 'verified' || current === 'pending') {
    return { from: current, to: 'pending', reason: '敏感字段变更，需重新审核' };
  }
  return null;
}

function nowIso() {
  return new Date().toISOString();
}

function queueRecord(schoolId, status, extra = {}) {
  return {
    school_id: schoolId,
    status,
    history: [{ status, at: nowIso(), by: extra.by || 'admin', note: extra.note || null }],
    revisions: extra.revisions || [],
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

function getQueue() {
  return store.load('queue');
}

function saveQueue(data) {
  store.save('queue', data);
}

function findQueueItem(schoolId) {
  const q = getQueue();
  return q.items.find((i) => i.school_id === schoolId) || null;
}

function upsertQueueItem(schoolId, nextStatus, extra = {}) {
  const q = getQueue();
  let item = q.items.find((i) => i.school_id === schoolId);
  if (!item) {
    item = queueRecord(schoolId, nextStatus, extra);
    q.items.push(item);
  } else {
    if (!allowedTransition(item.status, nextStatus) && !extra.force) {
      return { ok: false, error: `非法状态流转: ${item.status} → ${nextStatus}` };
    }
    item.status = nextStatus;
    item.history.push({ status: nextStatus, at: nowIso(), by: extra.by || 'admin', note: extra.note || null });
    if (extra.revisions && extra.revisions.length) {
      item.revisions.push(...extra.revisions);
    }
    item.updated_at = nowIso();
  }
  saveQueue(q);
  return { ok: true, item };
}

function recordRevision(schoolId, changedFields, oldSchool, newSchool) {
  const q = getQueue();
  let item = q.items.find((i) => i.school_id === schoolId);
  const revs = (changedFields || []).map((f) => ({
    field: f,
    old: oldSchool ? oldSchool[f] : undefined,
    new: newSchool ? newSchool[f] : undefined,
    at: nowIso(),
  }));
  if (!item) {
    item = queueRecord(schoolId, String(newSchool.verified_status || 'draft'), { revisions: revs });
    q.items.push(item);
  } else {
    item.revisions.push(...revs);
    item.updated_at = nowIso();
  }
  saveQueue(q);
  return revs;
}

module.exports = {
  allowedTransition,
  computeStatusChange,
  REVIEW_SENSITIVE_FIELDS,
  getQueue,
  findQueueItem,
  upsertQueueItem,
  recordRevision,
};
