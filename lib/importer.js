// Real-school data importer (V1.0): CSV/JSON parsing, validation, duplicate
// detection, preview and batch import. No external dependencies.
//
// Hard rule (task + data-quality spec): a record without `source_url` OR
// `supplier_evidence` must never be marked verified. It can still be staged
// as draft for later completion.

const path = require('path');

// Fields required to even attempt validation (missing => row error).
const REQUIRED_FIELDS = ['name', 'country', 'city'];

// Value sets accepted for normalized fields.
const VALID_STATUSES = ['draft', 'pending', 'verified', 'expired', 'rejected'];
const VALID_TYPES = [
  'International School', 'Bilingual School', 'Private School', 'Public School',
  'University', 'College/Diploma Institution', 'Language School', 'Vocational Institution'
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const URL_RE = /^https?:\/\/.+/i;

function normalizeKey(k) {
  return String(k || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function isSameDate(a, b) {
  if (!a && !b) return true;
  return Boolean(a) && Boolean(b) && String(a).slice(0, 10) === String(b).slice(0, 10);
}

function parseDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim().slice(0, 10);
  if (!DATE_RE.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) ? null : s;
}

// Map a raw row (arbitrary casing) to a normalized school candidate.
function normalizeRow(raw) {
  const row = {};
  for (const [k, v] of Object.entries(raw || {})) row[normalizeKey(k)] = v;
  const pick = (...keys) => {
    for (const k of keys) if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') return row[k];
    return null;
  };
  const name = pick('name', 'school', 'school_name', 'name_zh');
  const explicitZh = pick('name_zh', 'chinese_name');
  const explicitEn = pick('name_en', 'english_name');
  // Imported rows are stored with the same shape as demo records so the C-end
  // search (which reads name_zh / name_en) can find them. When only one name is
  // supplied, route it to the language it is actually written in rather than
  // leaving both blank.
  const hasCJK = /[\u4e00-\u9fff]/.test(String(name || ''));
  return {
    name,
    name_zh: explicitZh || (hasCJK ? name : null),
    name_en: explicitEn || (hasCJK ? null : name),
    country: pick('country', 'country_id', 'country_code'),
    city: pick('city', 'city_id'),
    district: pick('district', 'district_id'),
    institution_type: pick('institution_type', 'institutiontype', 'school_type', 'type'),
    stages: pick('stages', 'stage', 'education_stages'),
    curricula: pick('curricula', 'curriculum', 'curriculum_1'),
    main_language: pick('main_language', 'language', 'teaching_language'),
    additional_languages: pick('additional_languages', 'other_languages'),
    tuition_min: pick('tuition_min', 'min_fee', 'fee_min'),
    tuition_max: pick('tuition_max', 'max_fee', 'fee_max'),
    currency: pick('currency', 'fee_currency'),
    boarding: pick('boarding', 'has_boarding'),
    scholarships: pick('scholarships', 'scholarship', 'has_scholarship'),
    nearest_station_id: pick('nearest_station_id', 'nearest_station', 'station_id'),
    latitude: pick('latitude', 'lat'),
    longitude: pick('longitude', 'lng', 'lon'),
    source_url: pick('source_url', 'source', 'url'),
    supplier_evidence: pick('supplier_evidence', 'supplier_proof', 'evidence'),
    verified_status: pick('verified_status', 'status'),
    verified_at: pick('verified_at', 'verified_date'),
    effective_from: pick('effective_from', 'valid_from'),
    effective_to: pick('effective_to', 'valid_to'),
    // programs (optional embedded rows)
    programs: raw.programs,
  };
}

function parseListField(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value).split(/[,;|]/).map((v) => v.trim()).filter(Boolean);
}

function parseBool(value) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', '有', '是'].includes(s)) return true;
  if (['false', '0', 'no', 'n', '无', '否'].includes(s)) return false;
  return null;
}

function parseNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Validate one candidate. Returns { ok, errors[], warnings[], candidate }.
function validateCandidate(candidate, ctx = {}) {
  const errors = [];
  const warnings = [];
  const out = JSON.parse(JSON.stringify(candidate));

  for (const f of REQUIRED_FIELDS) {
    if (!out[f] || !String(out[f]).trim()) errors.push(`缺少必填字段: ${f}`);
  }

  // country / city normalized to ids via reference dictionaries when possible
  const byName = (dict, name) => {
    if (!name) return null;
    const n = String(name).toLowerCase();
    const hit =
      dict.find((x) => x.id === n || String(x.code || '').toLowerCase() === n) ||
      dict.find((x) => String(x.name_en || '').toLowerCase() === n) ||
      dict.find((x) => String(x.name_zh || '').toLowerCase() === n);
    return hit || null;
  };
  if (ctx.countries && ctx.cities) {
    const country = byName(ctx.countries, out.country);
    if (country) out.country_id = country.id;
    else errors.push(`国家无法识别: ${out.country}`);
    // Resolve the city within the resolved country first: a country name is
    // often reused as the city (e.g. Singapore, Singapore), and the country
    // dictionary would otherwise win and produce a wrong city_id.
    const scopedCities = country
      ? ctx.cities.filter((c) => !c.country_id || String(c.country_id) === String(country.id))
      : ctx.cities;
    const city = byName(scopedCities, out.city) || byName(ctx.cities, out.city);
    if (city) out.city_id = city.id;
    else errors.push(`城市无法识别: ${out.city}`);
    if (out.district && ctx.districts) {
      const district = byName(ctx.districts, out.district);
      if (district) out.district_id = district.id;
      else warnings.push(`区域未匹配到字典，将保留原文: ${out.district}`);
    }
  } else {
    out.country_id = String(out.country || '');
    out.city_id = String(out.city || '');
  }

  const type = String(out.institution_type || '').trim();
  if (type && !VALID_TYPES.includes(type)) {
    warnings.push(`学校类型不在标准字典中: ${out.institution_type}`);
  }

  out.stages = parseListField(out.stages);
  out.curricula = parseListField(out.curricula);
  out.additional_languages = parseListField(out.additional_languages);

  out.tuition_min = parseNumber(out.tuition_min);
  out.tuition_max = parseNumber(out.tuition_max);
  if (out.tuition_min !== null && out.tuition_max !== null && out.tuition_min > out.tuition_max) {
    errors.push(`学费区间无效: min(${out.tuition_min}) > max(${out.tuition_max})`);
  }
  out.currency = (String(out.currency || '').trim().toUpperCase()) || 'CNY';

  out.boarding = parseBool(out.boarding);
  out.scholarships = parseBool(out.scholarships);

  out.latitude = parseNumber(out.latitude);
  out.longitude = parseNumber(out.longitude);
  if ((out.latitude !== null && out.longitude === null) || (out.latitude === null && out.longitude !== null)) {
    errors.push('经纬度必须成对提供');
  }

  // Source validation — the core data-quality rule.
  const hasSourceUrl = Boolean(out.source_url) && URL_RE.test(String(out.source_url));
  const hasEvidence = Boolean(out.supplier_evidence) && String(out.supplier_evidence).trim().length >= 3;
  if (out.source_url && !hasSourceUrl) warnings.push(`source_url 格式无效: ${out.source_url}`);
  if (out.source_url && !hasSourceUrl && !hasEvidence) out.source_url = null;

  const requestedStatus = String(out.verified_status || 'draft').trim().toLowerCase();
  out.verified_status = VALID_STATUSES.includes(requestedStatus) ? requestedStatus : 'draft';
  if (requestedStatus === 'verified' && !(hasSourceUrl || hasEvidence)) {
    // Never mark verified without a source.
    errors.push('缺少来源(source_url 或 supplier_evidence)的数据不得标记 verified，已降级为 draft');
    out.verified_status = 'draft';
  }
  if (out.verified_status === 'verified' && !out.verified_at) {
    errors.push('verified 状态必须提供 verified_at');
  }
  out.verified_at = parseDate(out.verified_at);
  if (out.verified_at === null && out.verified_status === 'verified') {
    errors.push('verified_at 格式无效(YYYY-MM-DD)');
  }

  out.effective_from = parseDate(out.effective_from);
  out.effective_to = parseDate(out.effective_to);
  if (out.effective_from && out.effective_to && out.effective_from > out.effective_to) {
    errors.push('有效期无效: effective_from > effective_to');
  }

  out.is_demo = false; // importer only handles real data; demo stays in demo files
  out.source_type = 'import';
  out.imported_at = new Date().toISOString().slice(0, 10);

  return { ok: errors.length === 0, errors, warnings, candidate: out };
}

// Duplicate detection against existing schools.
// id-based match: city_id + normalized name (zh or en).
function normalizeNameForMatch(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

function findDuplicate(candidate, existing) {
  const name = normalizeNameForMatch(candidate.name);
  if (!name) return null;
  const city = String(candidate.city_id || '').toLowerCase();
  for (const s of existing) {
    const cityMatch = String(s.city_id || s.city || '').toLowerCase() === city;
    const names = [s.name_zh, s.name_en, s.name].map(normalizeNameForMatch);
    if (cityMatch && names.includes(name)) return s;
  }
  return null;
}

// --- CSV parsing (RFC4180-ish, no deps) ---
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

function csvToObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h).trim()).filter(Boolean);
  if (!header.length) return [];
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = r[i] !== undefined ? r[i] : ''; });
    return obj;
  });
}

// Parse arbitrary input (CSV string or JSON array/object) into rows.
function parseInput(input) {
  const body = String(input || '').trim();
  if (!body) return [];
  if (body.startsWith('[') || body.startsWith('{')) {
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) { return null; }
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.schools)) return parsed.schools;
    if (parsed && typeof parsed === 'object') return [parsed];
    return null;
  }
  const rows = csvToObjects(body);
  // A single header-less token (e.g. "not json[ and not csv") parses as one row
  // with an empty-object body. That is garbage input, not a valid one-column CSV.
  const usable = rows.filter((r) => Object.values(r).some((v) => String(v).trim() !== ''));
  return usable.length ? usable : null;
}

// Full import pipeline. Returns report with preview/rows/errors.
function buildImportReport(input, existingSchools, ctx = {}) {
  const rows = parseInput(input);
  if (rows === null) {
    return { ok: false, parseError: '无法解析输入：需要 JSON 数组/对象 或 CSV 文本', rows: [], preview: [], duplicates: [], report: [] };
  }
  const results = rows.map((raw, index) => {
    const { ok: rowOk, errors, warnings, candidate } = validateCandidate(normalizeRow(raw), ctx);
    const dup = candidate.name ? findDuplicate(candidate, existingSchools) : null;
    return {
      row: index + 1,
      ok: rowOk && !dup,
      errors: dup ? [...errors, `疑似重复学校: ${dup.id} ${dup.name_zh || dup.name_en || ''}`] : errors,
      warnings,
      duplicate_of: dup ? dup.id : null,
      candidate,
    };
  });
  const okRows = results.filter((r) => r.ok);
  const importable = okRows.length;
  // A duplicate is reported in its own bucket, so it must not also be counted
  // as invalid — otherwise the three counters no longer sum to `total`.
  const invalid = results.filter((r) => !r.ok && !r.duplicate_of).length;
  return {
    ok: true,
    total: results.length,
    importable,
    invalid,
    duplicates: results.filter((r) => r.duplicate_of).length,
    rows: results,
    preview: okRows.map((r) => r.candidate),
    report: results.map((r) => ({ row: r.row, ok: r.ok, errors: r.errors, warnings: r.warnings })),
  };
}

module.exports = {
  normalizeRow,
  validateCandidate,
  findDuplicate,
  parseCsv,
  csvToObjects,
  parseInput,
  buildImportReport,
  VALID_STATUSES,
  VALID_TYPES,
};
