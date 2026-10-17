'use strict';
// Shared primitives: ids, timestamps, money, labels. Every module depends on
// these so that naming and formatting stay consistent across all five clients.

const crypto = require('crypto');

const PREFIXES = {
  user: 'USR', org: 'ORG', membership: 'MBR', b_profile: 'BPF', c_profile: 'CPF',
  supplier: 'SUP', supplier_profile: 'SPF', dbc_profile: 'DBP', service_scope: 'SCP',
  recommendation: 'REC', recommendation_score: 'RSC', recommendation_rotation: 'ROT',
  binding: 'BND', binding_history: 'BNDH',
  agreement: 'AGR', agreement_version: 'AGV', signature: 'SIG', contract_evidence: 'CEV',
  institution: 'INS', campus: 'CMP', program: 'PRG', scholarship: 'SCH',
  accommodation: 'ACC', room: 'ROM', bed: 'BED', guardian_service: 'GRD', booking: 'BKG',
  medical_service: 'MED', medical_order: 'MDO', certification_service: 'CRT', certification_order: 'CRO',
  visa_service: 'VSR', visa_order: 'VOR', finance_product: 'FNP', finance_referral: 'FNR',
  student_profile: 'STP', family_document: 'FMD', document_version: 'DMV', document_authorization: 'DAU',
  application: 'APP', application_stage: 'APS', application_timeline: 'ATL', application_todo: 'ATD',
  visa_case: 'VCS', visa_result: 'VRS', payment_intent: 'PIN', payment_route: 'PRT', payment_provider: 'PPR',
  payment_receipt: 'PRC', refund: 'RFD', fee_breakdown: 'FBD', commission_trigger: 'CMT',
  commission_rule: 'CMR', commission_ledger: 'CML', settlement: 'STL', invoice: 'INV',
  review: 'RVW', message: 'MSG', notification: 'NTF', daily_brief: 'DBF',
  dispute: 'DSP', dispute_evidence: 'DSE',
  ad_product: 'ADP', ad_inventory: 'ADI', ad_order: 'ADO', ad_creative: 'ADC', ad_schedule: 'ADS', ad_report: 'ADR',
  audit_log: 'LOG', source_evidence: 'SRC', session: 'SES'
};

const now = () => new Date();
const iso = (d) => (d instanceof Date ? d : new Date(d || Date.now())).toISOString();
const today = () => iso().slice(0, 10);

function randomId() {
  return crypto.randomBytes(9).toString('base64url').slice(0, 12).toUpperCase();
}

function id(kind) {
  const prefix = PREFIXES[kind] || 'GEN';
  return prefix + '-' + Date.now().toString(36).toUpperCase() + '-' + randomId();
}

function idPrefix(kind) {
  return PREFIXES[kind] || 'GEN';
}

function shortId(kind, seq) {
  const prefix = PREFIXES[kind] || 'GEN';
  return prefix + '-' + String(seq).padStart(6, '0');
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------
const lower = (v) => String(v == null ? '' : v).toLowerCase();
const upper = (v) => String(v == null ? '' : v).toUpperCase();
const trim = (v) => String(v == null ? '' : v).trim();

function truthy(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  return ['true', '1', 'yes', 'y', 'on'].includes(lower(value));
}

function asNumber(value, fallback = null) {
  if (value === true || value === false || value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function includesCI(value, needle) {
  return lower(value).includes(lower(needle));
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------
function addDays(date, days) {
  const d = date instanceof Date ? new Date(date.getTime()) : new Date(date || Date.now());
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d;
}

function addMonths(date, months) {
  const d = date instanceof Date ? new Date(date.getTime()) : new Date(date || Date.now());
  d.setUTCMonth(d.getUTCMonth() + Number(months || 0));
  return d;
}

function daysBetween(from, to) {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

function isPast(value) {
  if (!value) return false;
  const t = new Date(value).getTime();
  return Number.isFinite(t) && t < Date.now();
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (Number(d) * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(a))));
}

function distanceLabel(meters) {
  if (meters == null || !Number.isFinite(Number(meters))) return null;
  const m = Number(meters);
  if (m < 1000) return Math.round(m) + ' m';
  return (m / 1000).toFixed(1) + ' km';
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------
// No FX engine. Amounts are stored as { amount, currency } and comparisons use
// reference_rate snapshots only when a record provides one.
function money(amount, currency = 'SGD') {
  return { amount: asNumber(amount, 0) || 0, currency: upper(currency) || 'SGD' };
}

function moneyString(value) {
  if (value == null) return '—';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    const amt = asNumber(value.amount);
    if (amt == null) return '—';
    return amt + ' ' + (value.currency || '');
  }
  return String(value);
}

function round2(value) {
  const n = asNumber(value, 0) || 0;
  return Math.round(n * 100) / 100;
}

// Deterministic pseudo-random helper for fair rotation. Seedable so tests can
// assert stable ordering.
function hashString(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function seededUnit(seed) {
  // Map the first 8 hex chars of the hash into [0,1).
  const h = hashString(seed).slice(0, 8);
  return parseInt(h, 16) / 0x100000000;
}

module.exports = {
  id, shortId, idPrefix, PREFIXES, randomId,
  now, iso, today,
  lower, upper, trim, truthy, asNumber, pick, clone, includesCI,
  addDays, addMonths, daysBetween, isPast,
  haversineMeters, distanceLabel,
  money, moneyString, round2,
  hashString, seededUnit
};
