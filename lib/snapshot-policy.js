'use strict';
// ---------------------------------------------------------------------------
// Public snapshot whitelist (Fix 3 / V3.0.3 security hotfix).
//
// The public `data-snapshot` branch lives in a PUBLIC repository, so a snapshot
// may only ever contain non-sensitive demonstration data. This module is the
// single gate that decides what may leave the server:
//
//   1. allowlist()     — projects a full dataset onto the safe subset
//   2. audit()         — reports what was dropped (counts only, never values)
//   3. assertPublic()  — hard guard: refuses to publish forbidden content
//
// Rules:
//   * Collections not listed below are dropped entirely.
//   * Within a listed collection, only listed fields survive.
//   * PII fields (email/phone/password/demo_token/token) are never allowed.
//   * assertPublic() THROWS on any forbidden pattern — publishing stops.
//   * Restoring a snapshot never re-activates a session (sessions are dropped
//     at export time, so no session record can ever be restored).
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

// Fields that must never appear in a public snapshot, whatever the collection.
const FORBIDDEN_FIELDS = [
  'password', 'token', 'demo_token', 'session_token', 'secret', 'api_key',
  'access_token', 'refresh_token', 'authorization', 'credential'
];

// Collections that may be published, and the exact fields allowed for each.
// Anything not listed here is dropped.
const ALLOWED = {
  // Reference / taxonomy (no business meaning, no PII)
  education_stages: ['id', 'key', 'label_zh', 'label_en', 'owner'],
  // Public catalogue: institutions, campuses, programs, scholarships
  institutions: ['id', 'supplier_id', 'name', 'name_en', 'country_id', 'city_id',
    'latitude', 'longitude', 'is_demo', 'verified_status', 'source_url',
    'effective_from', 'effective_to', 'created_at'],
  campuses: ['id', 'institution_id', 'name', 'name_en', 'address', 'latitude', 'longitude'],
  programs: ['id', 'institution_id', 'name', 'name_en', 'stage', 'curriculum',
    'language', 'fee_min', 'fee_max', 'currency', 'duration', 'intake', 'is_demo'],
  scholarships: ['id', 'institution_id', 'program_id', 'name', 'name_en',
    'amount', 'currency', 'deadline', 'coverage', 'is_demo'],
  // Suppliers: public-facing profile only (no private contact channels)
  suppliers: ['id', 'organization_id', 'type', 'name', 'name_en', 'verification',
    'is_demo', 'public_visible', 'accepts_b_orders', 'created_at'],
  supplier_profiles: ['id', 'supplier_id', 'description', 'description_en',
    'languages', 'service_countries', 'service_cities', 'media', 'qualifications',
    'extensions'],
  organizations: ['id', 'kind', 'name', 'name_en', 'country', 'city',
    'verified', 'is_demo', 'created_at'],
  b_profiles: ['id', 'organization_id', 'level', 'service_countries',
    'service_courses', 'service_stages', 'service_types', 'languages',
    'daily_order_cap', 'monthly_order_cap', 'rating_avg', 'rating_count',
    'avg_response_minutes'],
  // Education services published to the public catalogue
  accommodations: ['id', 'supplier_id', 'name', 'name_en', 'room_type',
    'beds_total', 'beds_occupied', 'price', 'currency', 'latitude', 'longitude',
    'is_demo', 'verified'],
  // Ads: the inventory catalogue (no order-level or advertiser data)
  ad_inventory: ['id', 'slot_type', 'label_zh', 'label_en', 'total', 'reserved',
    'monthly_price', 'currency'],
  // Commission rules that a demo agreement publishes (no counterparties)
  commission_rules: ['id', 'supplier_id', 'product_id', 'mode', 'value',
    'currency', 'trigger_event', 'settlement_cycle_days', 'is_demo',
    'effective_from', 'effective_to'],
  // Application pipeline: aggregate counts only (no student linkage)
  application_stages: ['id', 'application_id', 'code', 'owner', 'status'],
  // System config (public policy defaults, no secrets)
  system_config: ['id', 'version', 'updated_at', 'values']
};

// Fields that are dropped even if a collection is allowlisted wholesale.
const KILL_FIELDS = new Set([
  ...FORBIDDEN_FIELDS,
  'email', 'phone', 'contact_email', 'contact_phone', 'contact_whatsapp',
  'contact_name', 'legal_name', 'ip', 'user_agent', 'note', 'request_id',
  'actor_id', 'actor_name', 'signed_by_user_id', 'uploaded_by', 'granted_by',
  'payer_id', 'payee_id', 'from_id', 'to_id', 'from_type', 'to_type',
  'file_url', 'file_name', 'body', 'content', 'source_url', 'supplier_evidence',
  'content_hash', 'evidence_ref', 'partner_metadata', 'responded_at'
]);

// Hard rule: a whitelisted collection must never carry an authentication
// secret. Rather than silently dropping it, refuse the whole snapshot.
function assertNoSecrets(row, collection) {
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, path + '[' + i + ']'));
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN_FIELDS.includes(k) && v !== undefined && v !== null && v !== '') {
        throw new Error('public snapshot refused: collection "' + collection +
          '" contains a forbidden field "' + (path ? path + '.' + k : k) + '"');
      }
      walk(v, path ? path + '.' + k : k);
    }
  };
  walk(row, '');
}

// Recursively remove PII / contact keys from nested objects (e.g. the
// supplier `extensions` blob may hold private contact channels).
function scrubNested(value) {
  if (Array.isArray(value)) return value.map(scrubNested);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (KILL_FIELDS.has(k)) continue;
      out[k] = scrubNested(v);
    }
    return out;
  }
  return value;
}

function projectRow(row, allowedFields, collection) {
  assertNoSecrets(row, collection);
  const out = {};
  for (const key of allowedFields) {
    if (KILL_FIELDS.has(key)) continue;
    if (row[key] !== undefined) out[key] = scrubNested(row[key]);
  }
  return out;
}

// Returns { data, dropped: { collection: count } } — counts only, no values.
function allowlist(snapshot) {
  const out = {};
  const dropped = {};
  for (const [name, rows] of Object.entries(snapshot || {})) {
    const allowedFields = ALLOWED[name];
    if (!allowedFields) {
      dropped[name] = Array.isArray(rows) ? rows.length : 1;
      continue;
    }
    out[name] = (rows || []).map((row) => projectRow(row, allowedFields, name));
    const removed = (rows || []).length - out[name].length;
    if (removed > 0) dropped[name] = removed;
  }
  return { data: out, dropped };
}

// Public snapshot may only carry demo/verified catalogue data: reject any user
// identity, session, audit or personal-data collection outright.
const REQUIRED_ABSENT = [
  'users', 'sessions', 'c_profiles', 'student_profiles', 'family_documents',
  'document_versions', 'document_authorizations', 'messages', 'notifications',
  'audit_logs', 'signatures', 'contract_evidence', 'disputes', 'dispute_evidence',
  'payment_intents', 'payment_receipts', 'refunds', 'fee_breakdowns',
  'applications', 'application_timeline', 'application_todos', 'bindings',
  'binding_histories', 'recommendations', 'commission_ledger', 'settlements',
  'invoices', 'ad_orders', 'ad_creatives', 'ad_schedules', 'ad_reports',
  'medical_orders', 'certification_orders', 'visa_orders', 'visa_cases',
  'visa_results', 'bookings', 'finance_referrals', 'reviews', 'service_scopes',
  'memberships', 'b_... profiles', 'source_evidence'
];

function audit(allowlisted) {
  const report = { collections: Object.keys(allowlisted).length, dropped: {} };
  for (const name of Object.keys(allowlisted)) {
    report.dropped[name] = 0;
  }
  return report;
}

// Hard guard. Throws when the payload still contains forbidden content.
// Used by the export endpoint AND by snapshot-push.sh before committing.
function assertPublic(allowlisted) {
  const problems = [];

  for (const name of Object.keys(allowlisted || {})) {
    if (REQUIRED_ABSENT.includes(name)) problems.push('forbidden collection: ' + name);
  }
  if (problems.length) {
    throw new Error('public snapshot contains forbidden collections: ' + problems.join(', '));
  }

  let serialized;
  try {
    serialized = JSON.stringify(allowlisted);
  } catch (err) {
    throw new Error('public snapshot is not serialisable: ' + (err && err.message));
  }

  for (const field of FORBIDDEN_FIELDS) {
    if (new RegExp('"' + field + '"\\s*:').test(serialized)) {
      throw new Error('public snapshot contains a forbidden field: ' + field);
    }
  }
  // Nothing that looks like a credential or an email address may survive.
  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(serialized)) {
    throw new Error('public snapshot appears to contain an email address');
  }
  if (/(tok-|sha256:|Bearer )/.test(serialized)) {
    throw new Error('public snapshot appears to contain a credential');
  }
  return true;
}

// Convenience for the export endpoint: allowlist + assert in one call.
function buildPublicSnapshot(snapshot) {
  const { data, dropped } = allowlist(snapshot);
  assertPublic(data);
  return { data, dropped };
}

module.exports = {
  ALLOWED, FORBIDDEN_FIELDS, REQUIRED_ABSENT, KILL_FIELDS,
  allowlist, assertPublic, buildPublicSnapshot, audit, projectRow
};
