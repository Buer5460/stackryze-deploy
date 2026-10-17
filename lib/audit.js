'use strict';
// ---------------------------------------------------------------------------
// AuditLog — every state-changing action across all five clients is recorded
// with actor, before/after payload and an evidence link. Read-only for
// everyone except ADMIN_AUDIT / ADMIN_SUPER.
// ---------------------------------------------------------------------------
const db = require('./db');
const { id, iso, clone, lower } = require('./util');
const auth = require('./auth');

const logs = () => db.stores.audit_logs;

function record(entry) {
  const actor = entry.actor || null;
  const record_ = {
    id: id('audit_log'),
    at: iso(),
    actor_id: actor ? actor.id : null,
    actor_role: actor ? actor.role : null,
    actor_name: actor ? (actor.display_name || actor.email || actor.id) : 'system',
    audience: entry.audience || (actor ? auth.ROLES[actor.role].audience : 'ADMIN'),
    action: String(entry.action || 'unknown'),
    entity: entry.entity || null,
    entity_id: entry.entity_id || null,
    from: entry.from === undefined ? null : clone(entry.from),
    to: entry.to === undefined ? null : clone(entry.to),
    note: entry.note || null,
    request_id: entry.request_id || null,
    ip: entry.ip || null,
    // Cross-client access attempts are recorded even when they are denied.
    denied: Boolean(entry.denied),
    evidence_id: entry.evidence_id || null
  };
  return logs().insert(record_);
}

function query(filters = {}) {
  let items = logs().all();
  if (filters.audience) items = items.filter((l) => lower(l.audience) === lower(filters.audience));
  if (filters.action) items = items.filter((l) => lower(l.action).includes(lower(filters.action)));
  if (filters.entity) items = items.filter((l) => lower(l.entity) === lower(filters.entity));
  if (filters.entity_id) items = items.filter((l) => lower(l.entity_id) === lower(filters.entity_id));
  if (filters.actor_id) items = items.filter((l) => lower(l.actor_id) === lower(filters.actor_id));
  if (filters.denied !== undefined) items = items.filter((l) => Boolean(l.denied) === Boolean(filters.denied));
  if (filters.since) items = items.filter((l) => l.at >= filters.since);
  return items.sort((a, b) => (a.at < b.at ? 1 : -1));
}

// Express middleware that logs every mutating request automatically.
function autoLog(req, res, next) {
  const method = String(req.method || '').toUpperCase();
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) && req.path.startsWith('/api')) {
    const original = res.json.bind(res);
    res.json = (payload) => {
      try {
        if (payload && payload.ok !== false) {
          record({
            actor: req.actor ? req.actor.user : null,
            action: req.baseUrl + req.path + ':' + method.toLowerCase(),
            entity: req.params && Object.keys(req.params).length ? Object.keys(req.params)[0] : null,
            entity_id: req.params ? Object.values(req.params)[0] : null,
            to: payload && payload.data ? redact(payload.data) : null,
            request_id: req.headers['x-request-id'] || null,
            ip: req.ip
          });
        }
      } catch (_) { /* auditing must never break a request */ }
      return original(payload);
    };
  }
  next();
}

// Never write secrets into the audit trail.
function redact(value) {
  if (value == null) return null;
  try {
    const copy = clone(value);
    if (Array.isArray(copy)) return copy.map(redact);
    if (typeof copy !== 'object') return copy;
    for (const key of Object.keys(copy)) {
      if (['password', 'token', 'secret', 'card', 'cvv', 'authorization'].includes(lower(key))) delete copy[key];
      else copy[key] = redact(copy[key]);
    }
    return copy;
  } catch (_) {
    return null;
  }
}

module.exports = { record, query, autoLog, redact };
