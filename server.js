const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '5mb' }));

const readJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, relativePath), 'utf8'));

// ---------------------------------------------------------------------------
// Data: reference dictionaries + demo entities (V0.5 layout, V1.0 store)
// ---------------------------------------------------------------------------
const locationsRef = readJson('data/reference/locations.json');
const curriculaRef = readJson('data/reference/curricula.json');
const languagesRef = readJson('data/reference/languages.json');
const stagesRef = readJson('data/reference/education-stages.json');

const reference = {
  version: stagesRef.version,
  source_note: 'Reference dictionaries assembled from data/reference/*.json. Taxonomy only — not school data and not proof of any partnership.',
  countries: locationsRef.countries,
  cities: locationsRef.cities,
  districts: locationsRef.districts,
  transitLines: locationsRef.transitLines,
  transitStations: locationsRef.transitStations,
  educationStages: stagesRef.educationStages,
  curriculumFamilies: curriculaRef.curriculumFamilies,
  curricula: curriculaRef.curricula,
  languages: languagesRef.languages,
  institutionTypes: languagesRef.institutionTypes
};

const demoSchools = readJson('data/demo/schools.json').schools;
const catalogPrograms = readJson('data/demo/programs.json').programs;
const scholarships = readJson('data/demo/scholarships.json').scholarships;

const store = require('./lib/store');
const review = require('./lib/review');
const importer = require('./lib/importer');
const { schoolStationDistance, distanceLabel, haversineMeters } = require('./lib/distance');

function importedSchools() {
  return store.load('imports').schools || [];
}

// Real (imported) schools visible on the C-end: verified and not expired.
function isExpired(school) {
  if (!school.effective_to) return false;
  const today = new Date().toISOString().slice(0, 10);
  return String(school.effective_to) < today;
}

function searchableImported() {
  return importedSchools().filter(
    (s) => String(s.verified_status).toLowerCase() === 'verified' && !isExpired(s)
  );
}

// All known schools (demo + imported) for detail lookup & duplicate detection.
function allKnownSchools() {
  return [...demoSchools, ...importedSchools()];
}

// ---------------------------------------------------------------------------
// Lookup indexes
// ---------------------------------------------------------------------------
const indexBy = (list, key) => {
  const map = new Map();
  for (const item of list || []) map.set(String(item[key]).toLowerCase(), item);
  return map;
};
const countryById = indexBy(reference.countries, 'id');
const cityById = indexBy(reference.cities, 'id');
const districtById = indexBy(reference.districts, 'id');
const stationById = indexBy(reference.transitStations, 'id');
const lineById = indexBy(reference.transitLines, 'id');
const stageById = indexBy(reference.educationStages, 'id');
const curriculumById = indexBy(reference.curricula, 'id');
const institutionTypeById = indexBy(reference.institutionTypes, 'id');
const catalogProgramById = indexBy(catalogPrograms, 'id');

// ---------------------------------------------------------------------------
// Application demo data (C/B/S/Admin flows, unchanged)
// ---------------------------------------------------------------------------
const seed = {
  profile: {
    name: '陈小雨',
    education: '本科大三',
    gpa: '3.5/4.0',
    english: 'IELTS 6.5',
    budget: '25万/年',
    country: '新加坡 / 英国',
    completion: 72
  },
  programs: [
    { id: 1, school: '南洋国际学院（演示）', country: '新加坡', program: '数据科学硕士', degree: '硕士', lang: 'IELTS 6.5', fee: 188000, scholarship: 30000, deadline: '2026-11-30', fit: '符合已知条件' },
    { id: 2, school: '海峡商学院（演示）', country: '新加坡', program: '国际商务本科', degree: '本科', lang: 'IELTS 6.0', fee: 128000, scholarship: 20000, deadline: '2026-12-15', fit: '资料不足' },
    { id: 3, school: '英伦创新大学（演示）', country: '英国', program: '金融科技硕士', degree: '硕士', lang: 'IELTS 6.5', fee: 236000, scholarship: 25000, deadline: '2027-01-20', fit: '符合已知条件' }
  ],
  clients: [
    { id: 101, name: '陈小雨', source: '机构专属二维码', owner: '王老师', stage: '材料准备', completion: 82 },
    { id: 102, name: '李晨', source: '自然注册后授权', owner: '周老师', stage: '院校受理', completion: 91 }
  ],
  applications: [
    { id: 'APP-260901', student: '陈小雨', programId: 1, agency: '环球学桥（演示）', school: '南洋国际学院（演示）', status: '材料准备', progress: 42, commission: 9800 },
    { id: 'APP-260823', student: '李晨', programId: 3, agency: '环球学桥（演示）', school: '英伦创新大学（演示）', status: '院校受理', progress: 68, commission: 12500 }
  ],
  audits: [
    { id: 1, type: '奖学金', name: '2027春季优秀新生减免', org: '海峡商学院（演示）', status: '待审核' },
    { id: 2, type: '机构认证', name: '新加坡启航教育（演示）', org: 'B端机构', status: '待审核' }
  ]
};

let db = JSON.parse(JSON.stringify(seed));
const ok = (data, meta) => (meta ? { ok: true, data, meta } : { ok: true, data });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function boolQuery(value) {
  if (value === undefined) return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

function numberQuery(value) {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function paramValues(query, name) {
  const raw = query ? query[name] : undefined;
  if (raw === undefined) return [];
  const values = (Array.isArray(raw) ? raw : [raw])
    .map((v) => String(v))
    .filter((v) => v.length > 0);
  // Support comma-separated lists (e.g. /api/compare?ids=a,b,c).
  return values.flatMap((v) => v.split(',')).map((v) => v.trim()).filter((v) => v.length > 0);
}

function param(query, name) {
  const values = paramValues(query, name);
  return values.length ? values[0] : undefined;
}

function includesCI(value, query) {
  return String(value || '').toLowerCase().includes(String(query || '').toLowerCase());
}

function someCI(values, predicate) {
  return (values || []).some((v) => predicate(v));
}

function curriculumQueryNames(raw) {
  const entry = curriculumById.get(String(raw).toLowerCase());
  if (entry) return [entry.name_en, ...(entry.aliases || [])];
  return [String(raw)];
}

function stageQueryIds(raw) {
  const entry = stageById.get(String(raw).toLowerCase());
  return entry ? [entry.id] : [String(raw)];
}

function institutionTypeQueryNames(raw) {
  const entry = institutionTypeById.get(String(raw).toLowerCase());
  if (entry) return [entry.name_en, entry.name_zh];
  return [String(raw)];
}

function matchLocation(school, query, key) {
  const raw = param(query, key);
  if (!raw) return true;
  const needle = String(raw).toLowerCase();
  const location = school.location || {};
  const ids = { country: location.country_id, city: location.city_id, district: location.district_id };
  if (String(ids[key] || '').toLowerCase() === needle) return true;
  const names = {
    country: [location.country_en, location.country_zh],
    city: [location.city_en, location.city_zh],
    district: [location.district_en, location.district_zh]
  };
  return (names[key] || []).some((v) => includesCI(v, needle));
}

// ---------------------------------------------------------------------------
// Enrichment: reference ids → display names + distance/transit (V1.0)
// ---------------------------------------------------------------------------
function enrichSchool(school) {
  const country = countryById.get(String(school.country_id).toLowerCase());
  const city = cityById.get(String(school.city_id).toLowerCase());
  const district = districtById.get(String(school.district_id).toLowerCase());
  const station = stationById.get(String(school.nearest_station_id || '').toLowerCase());
  const line = station ? lineById.get(String(station.line_id).toLowerCase()) : undefined;
  const distanceMeters = schoolStationDistance(school, station);
  return {
    ...school,
    location: {
      country_id: school.country_id,
      country_en: country ? country.name_en : null,
      country_zh: country ? country.name_zh : null,
      city_id: school.city_id,
      city_en: city ? city.name_en : null,
      city_zh: city ? city.name_zh : null,
      district_id: school.district_id,
      district_en: district ? district.name_en : null,
      district_zh: district ? district.name_zh : null,
      region_group: district ? district.region_group : null
    },
    station: station
      ? {
          id: station.id,
          name_en: station.name_en,
          name_zh: station.name_zh,
          line_code: line ? line.code : null,
          line_name_en: line ? line.name_en : null,
          type: line ? line.type : null,
          latitude: station.latitude,
          longitude: station.longitude
        }
      : null,
    distance_m: distanceMeters,
    distance_label: distanceLabel(distanceMeters),
    commute_label: null // honest placeholder; UI shows 暂无可靠通勤数据
  };
}

// ---------------------------------------------------------------------------
// School search
// ---------------------------------------------------------------------------
function schoolBaseList() {
  return [...demoSchools, ...searchableImported()].map(enrichSchool);
}

function listSchools(query) {
  let list = schoolBaseList();

  const q = param(query, 'q');
  if (q) {
    list = list.filter((s) =>
      [
        s.name_zh, s.name_en, s.institution_type, s.main_language,
        s.location.country_en, s.location.city_en, s.location.district_en,
        s.location.district_zh, s.location.region_group,
        ...(s.curricula || []), ...(s.stages || []), ...(s.additional_languages || [])
      ].some((v) => includesCI(v, q))
    );
  }

  list = list.filter((s) => matchLocation(s, query, 'country'));
  list = list.filter((s) => matchLocation(s, query, 'city'));
  list = list.filter((s) => matchLocation(s, query, 'district'));

  const stages = paramValues(query, 'stage').flatMap(stageQueryIds);
  if (stages.length) list = list.filter((s) => someCI(s.stages, (v) => stages.some((st) => includesCI(v, st))));

  const curricula = paramValues(query, 'curriculum').flatMap(curriculumQueryNames);
  if (curricula.length) list = list.filter((s) => someCI(s.curricula, (v) => curricula.some((c) => includesCI(v, c))));

  const languages = paramValues(query, 'language');
  if (languages.length) list = list.filter((s) => [s.main_language, ...(s.additional_languages || [])].some((v) => languages.some((l) => includesCI(v, l))));

  const types = paramValues(query, 'institutionType').flatMap(institutionTypeQueryNames);
  if (types.length) list = list.filter((s) => types.some((t) => includesCI(s.institution_type, t)));

  const minFee = numberQuery(param(query, 'minFee'));
  if (minFee !== undefined) list = list.filter((s) => Number(s.tuition_max || s.tuition_min || 0) >= minFee);

  const maxFee = numberQuery(param(query, 'maxFee'));
  if (maxFee !== undefined) list = list.filter((s) => Number(s.tuition_min || s.tuition_max || 0) <= maxFee);

  const scholarship = boolQuery(param(query, 'scholarship'));
  if (scholarship !== undefined) list = list.filter((s) => Boolean(s.scholarships) === scholarship);

  const boarding = boolQuery(param(query, 'boarding'));
  if (boarding !== undefined) list = list.filter((s) => Boolean(s.boarding) === boarding);

  const stations = paramValues(query, 'transitStation');
  if (stations.length) {
    list = list.filter((s) => {
      if (!s.station) return false;
      return stations.some((needle) =>
        String(s.station.id).toLowerCase() === needle.toLowerCase() ||
        includesCI(s.station.name_en, needle) ||
        includesCI(s.station.name_zh, needle)
      );
    });
  }

  const transitNear = boolQuery(param(query, 'transitNear'));
  if (transitNear !== undefined) list = list.filter((s) => Boolean(s.nearest_station_id) === transitNear);

  const maxDistance = numberQuery(param(query, 'maxDistance'));
  if (maxDistance !== undefined) list = list.filter((s) => s.distance_m !== null && s.distance_m <= maxDistance);

  if (param(query, 'verifiedOnly') === 'true') {
    list = list.filter((s) => s.verified_status === 'verified');
  }

  const sort = param(query, 'sort');
  if (sort === 'fee_asc') list.sort((a, b) => Number(a.tuition_min || 0) - Number(b.tuition_min || 0));
  else if (sort === 'fee_desc') list.sort((a, b) => Number(b.tuition_max || 0) - Number(a.tuition_max || 0));
  else if (sort === 'distance_asc') list.sort((a, b) => (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity));

  return list;
}

function paginate(list, query) {
  const page = Math.max(1, Number.parseInt(param(query, 'page') || '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(param(query, 'pageSize') || '20', 10) || 20));
  const start = (page - 1) * pageSize;
  return { data: list.slice(start, start + pageSize), meta: { total: list.length, page, pageSize } };
}

// ---------------------------------------------------------------------------
// B2B (agency) helpers — commission only from real agreements
// ---------------------------------------------------------------------------
function agreementsByInstitution() {
  const data = store.load('agreements');
  const map = new Map();
  for (const a of data.agreements || []) {
    const key = String(a.institution_id).toLowerCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(a);
  }
  return map;
}

function agencyView(school) {
  const agreements = agreementsByInstitution().get(String(school.id).toLowerCase()) || [];
  const real = agreements.filter((a) => !a.is_demo);
  const anyAgreement = agreements.length > 0;
  const acceptsAgents = anyAgreement && agreements.every((a) => a.accepts_agents);
  return {
    ...school,
    agency: {
      accepts_agents: acceptsAgents,
      cooperation_status: real.length
        ? real[0].cooperation_status
        : anyAgreement
          ? 'demo'
          : 'none',
      // Only real (backend-recorded) agreements expose commission data.
      commission:
        real.length > 0
          ? {
              commission_type: real[0].commission_type,
              commission_value: real[0].commission_value,
              currency: real[0].currency,
              settlement_cycle: real[0].settlement_cycle,
              source_document: real[0].source_document,
              effective_from: real[0].effective_from,
              effective_to: real[0].effective_to,
              agreement_id: real[0].id
            }
          : {
              commission_type: null,
              commission_value: null,
              currency: null,
              settlement_cycle: null,
              source_document: null,
              effective_from: null,
              effective_to: null,
              note: anyAgreement ? '该记录为演示数据，无真实佣金信息' : '暂无代理协议记录'
            }
    }
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) =>
  res.json(ok({
    status: 'ok',
    service: 'global-study-mobile-mvp',
    version: '1.0.0',
    dataFoundation: true,
    demoSchools: demoSchools.length,
    demoPrograms: catalogPrograms.length,
    demoScholarships: scholarships.length,
    importedSchools: importedSchools().length,
    reviewQueue: store.load('queue').items.length,
    b2bEnabled: true,
    reference: {
      countries: reference.countries.length,
      cities: reference.cities.length,
      districts: reference.districts.length,
      transitLines: reference.transitLines.length,
      transitStations: reference.transitStations.length,
      educationStages: reference.educationStages.length,
      curricula: reference.curricula.length
    }
  }))
);

app.get('/api/reference', (req, res) => res.json(ok(reference)));

app.get('/api/bootstrap', (req, res) =>
  res.json(ok({
    ...db,
    reference,
    schools: schoolBaseList(),
    catalogPrograms: catalogPrograms,
    scholarships
  }))
);

app.get('/api/schools', (req, res) => {
  const { data, meta } = paginate(listSchools(req.query), req.query);
  res.json(ok(data, { ...meta, demoOnly: data.every((s) => s.is_demo === true) }));
});

app.get('/api/schools/:id', (req, res) => {
  const school = allKnownSchools().find((s) => String(s.id).toLowerCase() === String(req.params.id).toLowerCase());
  if (!school) return res.status(404).json({ ok: false, error: '学校不存在' });
  const enriched = enrichSchool(school);
  res.json(ok({
    ...enriched,
    campuses: school.campuses || [],
    programs: catalogPrograms.filter((p) => p.institution_id === school.id),
    scholarships: scholarships.filter((x) => x.institution_id === school.id),
    source: {
      source_url: school.source_url,
      source_type: school.source_type,
      supplier_evidence: school.supplier_evidence || null,
      verified_status: school.verified_status,
      verified_at: school.verified_at,
      effective_from: school.effective_from,
      effective_to: school.effective_to,
      is_demo: school.is_demo,
      updated_at: school.updated_at
    }
  }));
});

app.get('/api/programs', (req, res) => {
  let list = [...catalogPrograms];

  const q = param(req.query, 'q');
  if (q) {
    list = list.filter((p) =>
      [p.name, p.name_zh, p.curriculum].some((v) => includesCI(v, q)) ||
      includesCI(p.institution_name_zh || p.institution_id, q)
    );
  }

  const institution = param(req.query, 'institution');
  if (institution) list = list.filter((p) => String(p.institution_id).toLowerCase() === institution.toLowerCase() || includesCI(p.institution_name_zh, institution));

  const stages = paramValues(req.query, 'stage').flatMap(stageQueryIds);
  if (stages.length) list = list.filter((p) => stages.some((st) => includesCI(p.stage, st)));

  const curricula = paramValues(req.query, 'curriculum').flatMap(curriculumQueryNames);
  if (curricula.length) list = list.filter((p) => curricula.some((c) => includesCI(p.curriculum, c)));

  const languages = paramValues(req.query, 'language');
  if (languages.length) {
    list = list.filter((p) => {
      const school = demoSchools.find((s) => s.id === p.institution_id);
      const langs = [p.language_requirement, school ? school.main_language : null].concat(school ? school.additional_languages || [] : []);
      return langs.some((v) => languages.some((l) => includesCI(v, l)));
    });
  }

  const minFee = numberQuery(param(req.query, 'minFee'));
  if (minFee !== undefined) list = list.filter((p) => Number(p.tuition || 0) >= minFee);
  const maxFee = numberQuery(param(req.query, 'maxFee'));
  if (maxFee !== undefined) list = list.filter((p) => Number(p.tuition || 0) <= maxFee);

  const { data, meta } = paginate(list, req.query);
  res.json(ok(data, meta));
});

// ---------------------------------------------------------------------------
// Map data endpoint (V1.0): structured coordinates for a school plus its
// nearest transit stations. No map vendor is wired up; `tile_provider` stays
// null so the frontend shows an honest placeholder instead of a broken map.
// ---------------------------------------------------------------------------
app.get('/api/map/:id', (req, res) => {
  const school = allKnownSchools().find((s) => String(s.id).toLowerCase() === String(req.params.id).toLowerCase());
  if (!school) return res.status(404).json({ ok: false, error: '学校不存在' });
  const enriched = enrichSchool(school);

  const center = enriched.latitude !== null && enriched.longitude !== null
    ? { lat: Number(enriched.latitude), lng: Number(enriched.longitude) }
    : null;
  if (!center) {
    return res.json(ok({
      school_id: school.id,
      center: null,
      stations: [],
      renderable: false,
      tile_provider: null,
      note: '该校暂无坐标数据，无法渲染地图'
    }));
  }

  const maxStations = Math.min(100, Number(param(req.query, 'maxStations')) || 5);
  const within = numberQuery(param(req.query, 'within'));

  const lineOf = (st) => {
    const l = lineById.get(String(st.line_id).toLowerCase());
    return l ? { id: l.id, code: l.code, name_en: l.name_en, name_zh: l.name_zh, type: l.type } : null;
  };

  let stations = reference.transitStations
    .filter((st) => Number.isFinite(Number(st.latitude)) && Number.isFinite(Number(st.longitude)))
    .map((st) => {
      const meters = haversineMeters(center.lat, center.lng, Number(st.latitude), Number(st.longitude));
      return meters === null ? null : {
        id: st.id,
        name_en: st.name_en,
        name_zh: st.name_zh,
        line: lineOf(st),
        latitude: Number(st.latitude),
        longitude: Number(st.longitude),
        distance_m: Math.round(meters),
        distance_label: distanceLabel(meters)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distance_m - b.distance_m);

  if (within !== undefined) stations = stations.filter((s) => s.distance_m <= within);

  res.json(ok({
    school_id: school.id,
    school_name_zh: school.name_zh || null,
    center,
    nearest_station_id: school.nearest_station_id || null,
    stations: stations.slice(0, maxStations),
    renderable: true,
    // Deliberately no map vendor configured for V1.0.
    tile_provider: null,
    note: '已提供结构化坐标与临近站点，地图瓦片组件待后续版本接入'
  }));
});

// ---------------------------------------------------------------------------
// Compare endpoint (V1.0): server-side aggregation for the compare page.
// ---------------------------------------------------------------------------
app.get('/api/compare', (req, res) => {
  const ids = paramValues(req.query, 'ids');
  if (!ids.length) return res.status(400).json({ ok: false, error: '请提供 ids 参数' });
  const picked = [];
  for (const id of ids) {
    const school = allKnownSchools().find((s) => String(s.id).toLowerCase() === String(id).toLowerCase());
    if (school) picked.push(enrichSchool(school));
  }
  res.json(ok(picked.slice(0, 4), { total: picked.length, max: 4 }));
});

// ---------------------------------------------------------------------------
// B2B endpoints (V1.0). Requires x-role: agency | admin. Commission fields
// only ever come from real, backend-recorded agreements.
// ---------------------------------------------------------------------------
function requireB2B(req, res, next) {
  const role = String(req.headers['x-role'] || '').toLowerCase();
  if (role !== 'agency' && role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'B端权限不足：需要 agency 或 admin 角色' });
  }
  next();
}

app.get('/api/b2b/schools', requireB2B, (req, res) => {
  let list = listSchools({ ...req.query, verifiedOnly: undefined });
  const acceptsAgents = boolQuery(param(req.query, 'acceptsAgents'));
  if (acceptsAgents !== undefined) {
    list = list.filter((s) => {
      const agrs = agreementsByInstitution().get(String(s.id).toLowerCase()) || [];
      return Boolean(agrs.length) && agrs.every((a) => a.accepts_agents) === acceptsAgents;
    });
  }
  const hasCommission = boolQuery(param(req.query, 'hasCommission'));
  if (hasCommission !== undefined) {
    list = list.filter((s) => {
      const agrs = agreementsByInstitution().get(String(s.id).toLowerCase()) || [];
      const real = agrs.filter((a) => !a.is_demo);
      return Boolean(real.length) === hasCommission;
    });
  }
  const { data, meta } = paginate(list.map(agencyView), req.query);
  res.json(ok(data, meta));
});

app.get('/api/b2b/schools/:id', requireB2B, (req, res) => {
  const school = allKnownSchools().find((s) => String(s.id).toLowerCase() === String(req.params.id).toLowerCase());
  if (!school) return res.status(404).json({ ok: false, error: '学校不存在' });
  res.json(ok(agencyView(enrichSchool(school))));
});

// ---------------------------------------------------------------------------
// Admin: import pipeline (V1.0)
// ---------------------------------------------------------------------------
function requireAdmin(req, res, next) {
  const role = String(req.headers['x-role'] || '').toLowerCase();
  if (role !== 'admin') return res.status(403).json({ ok: false, error: '仅平台管理员可执行此操作' });
  next();
}

app.post('/api/admin/import/preview', requireAdmin, (req, res) => {
  const content = req.body && req.body.content;
  if (!content || !String(content).trim()) return res.status(400).json({ ok: false, error: 'content 必填' });
  const report = importer.buildImportReport(content, allKnownSchools(), {
    countries: reference.countries,
    cities: reference.cities,
    districts: reference.districts
  });
  if (!report.ok) return res.status(400).json(report);
  res.json(ok({
    total: report.total,
    importable: report.importable,
    invalid: report.invalid,
    duplicates: report.duplicates,
    preview: report.preview,
    report: report.report
  }));
});

app.post('/api/admin/import/commit', requireAdmin, (req, res) => {
  const content = req.body && req.body.content;
  if (!content || !String(content).trim()) return res.status(400).json({ ok: false, error: 'content 必填' });
  const report = importer.buildImportReport(content, allKnownSchools(), {
    countries: reference.countries,
    cities: reference.cities,
    districts: reference.districts
  });
  if (!report.ok) return res.status(400).json(report);

  const data = store.load('imports');
  const committed = [];
  for (const r of report.rows) {
    if (!r.ok) continue;
    const candidate = r.candidate;
    candidate.id = 'IMP-' + Date.now().toString(36).toUpperCase() + '-' + String(committed.length + 1).padStart(3, '0');
    candidate.verified_status = 'draft';
    data.schools.push(candidate);
    review.upsertQueueItem(candidate.id, 'draft', { note: '批量导入', by: 'admin' });
    committed.push({ id: candidate.id, name: candidate.name });
  }
  data.history = data.history || [];
  data.history.push({ at: new Date().toISOString(), count: committed.length, by: 'admin' });
  store.save('imports', data);
  res.json(ok({
    committed: committed.length,
    skipped: report.rows.length - committed.length,
    committed_ids: committed,
    report: report.report
  }));
});

// ---------------------------------------------------------------------------
// Admin: review queue + state machine + revisions
// ---------------------------------------------------------------------------
app.get('/api/admin/queue', requireAdmin, (req, res) => {
  const q = store.load('queue');
  const items = q.items.map((item) => {
    const school = allKnownSchools().find((s) => String(s.id).toLowerCase() === String(item.school_id).toLowerCase());
    return {
      ...item,
      school: school ? enrichSchool(school) : null
    };
  });
  res.json(ok(items, { total: items.length }));
});

app.post('/api/admin/queue/:schoolId/action', requireAdmin, (req, res) => {
  const schoolId = req.params.schoolId;
  const school = allKnownSchools().find((s) => String(s.id).toLowerCase() === String(schoolId).toLowerCase());
  if (!school) return res.status(404).json({ ok: false, error: '学校不存在' });
  const action = req.body && req.body.action;
  const note = (req.body && req.body.note) || null;

  const current = review.findQueueItem(schoolId);
  const from = current ? current.status : String(school.verified_status || 'draft').toLowerCase();
  const targetMap = {
    approve: 'verified',
    reject: 'rejected',
    'request-info': 'draft',
    expire: 'expired',
    submit: 'pending'
  };
  const target = targetMap[action];
  if (!target) return res.status(400).json({ ok: false, error: '未知操作：action 应为 approve / reject / request-info / expire / submit' });

  if (action === 'approve') {
    const hasSource = Boolean(school.source_url) || Boolean(school.supplier_evidence);
    if (!hasSource) return res.status(400).json({ ok: false, error: '缺少来源(source_url/supplier_evidence)的学校不能审核通过' });
  }
  if (action === 'expire') {
    // allow expire from pending/verified regardless of effective_to, admin-triggered
    const allowed = ['pending', 'verified'].includes(from);
    if (!allowed) return res.status(400).json({ ok: false, error: `当前状态 ${from} 不能标记过期` });
  }

  const result = review.upsertQueueItem(schoolId, target, {
    note: note || (action === 'request-info' ? '要求补充资料' : action === 'reject' ? '驳回' : action === 'approve' ? '审核通过' : '标记过期'),
    by: 'admin',
    force: action === 'expire'
  });
  if (!result.ok) return res.status(400).json({ ok: false, error: result.error });

  // Sync status onto the school record (imported store).
  if (!school.is_demo) {
    const data = store.load('imports');
    const rec = data.schools.find((s) => String(s.id).toLowerCase() === String(schoolId).toLowerCase());
    if (rec) {
      rec.verified_status = target;
      if (action === 'approve') rec.verified_at = rec.verified_at || new Date().toISOString().slice(0, 10);
      rec.updated_at = new Date().toISOString().slice(0, 10);
      store.save('imports', data);
    }
  }

  res.json(ok(result.item));
});

// Edit imported school fields; sensitive changes force re-review.
app.patch('/api/admin/schools/:id', requireAdmin, (req, res) => {
  const school = allKnownSchools().find((s) => String(s.id).toLowerCase() === String(req.params.id).toLowerCase());
  if (!school) return res.status(404).json({ ok: false, error: '学校不存在' });
  if (school.is_demo) return res.status(400).json({ ok: false, error: '演示数据不可编辑' });

  const fields = req.body && req.body.fields;
  if (!fields || typeof fields !== 'object') return res.status(400).json({ ok: false, error: 'fields 必填' });
  const data = store.load('imports');
  const rec = data.schools.find((s) => String(s.id).toLowerCase() === String(req.params.id).toLowerCase());
  if (!rec) return res.status(404).json({ ok: false, error: '学校不存在' });

  const changedFields = Object.keys(fields).filter((f) => JSON.stringify(rec[f]) !== JSON.stringify(fields[f]));
  const oldSnapshot = { ...rec };
  Object.assign(rec, fields);
  rec.updated_at = new Date().toISOString().slice(0, 10);

  const revs = review.recordRevision(rec.id, changedFields, oldSnapshot, rec);
  const change = review.computeStatusChange(rec, changedFields);
  if (change) {
    rec.verified_status = change.to;
    review.upsertQueueItem(rec.id, change.to, { note: change.reason, by: 'admin', force: true });
  }
  store.save('imports', data);

  res.json(ok({ school: rec, changed_fields: changedFields, revisions: revs, re_review: change }));
});

app.get('/api/admin/schools/:id/revisions', requireAdmin, (req, res) => {
  const item = review.findQueueItem(req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: '没有该学校的修订历史' });
  res.json(ok({ history: item.history || [], revisions: item.revisions || [] }));
});

// ---------------------------------------------------------------------------
// C/B/S/Admin legacy demo flows (unchanged)
// ---------------------------------------------------------------------------
app.post('/api/applications', (req, res) => {
  const p = db.programs.find((x) => x.id === Number(req.body && req.body.programId));
  if (!p) return res.status(400).json({ ok: false, error: '项目不存在' });
  if (!req.body || !req.body.student) return res.status(400).json({ ok: false, error: '学生姓名必填' });

  if (db.applications.some((a) => a.student === req.body.student && a.programId === p.id)) {
    return res.status(409).json({ ok: false, error: '该项目已申请' });
  }

  const x = {
    id: 'APP-' + Date.now().toString().slice(-6),
    student: req.body.student,
    programId: p.id,
    agency: req.body.agency || '待授权机构',
    school: p.school,
    status: '材料准备',
    progress: 18,
    commission: Math.round(p.fee * 0.05)
  };
  db.applications.unshift(x);
  res.status(201).json(ok(x));
});

app.patch('/api/applications/:id', (req, res) => {
  const x = db.applications.find((a) => a.id === req.params.id);
  if (!x) return res.status(404).json({ ok: false, error: '申请不存在' });
  Object.assign(x, req.body || {});
  res.json(ok(x));
});

app.post('/api/clients', (req, res) => {
  if (!req.body || !req.body.name) return res.status(400).json({ ok: false, error: '姓名必填' });
  const x = {
    id: Date.now(),
    name: req.body.name,
    source: '机构专属邀请',
    owner: req.body.owner || '王老师',
    stage: '待建档',
    completion: 10
  };
  db.clients.unshift(x);
  res.status(201).json(ok(x));
});

app.patch('/api/audits/:id', (req, res) => {
  const x = db.audits.find((a) => a.id === Number(req.params.id));
  if (!x) return res.status(404).json({ ok: false, error: '审核事项不存在' });
  x.status = (req.body && req.body.status) || x.status;
  res.json(ok(x));
});

app.post('/api/reset', (req, res) => {
  db = JSON.parse(JSON.stringify(seed));
  res.json(ok({ reset: true }));
});

// Unknown API paths must return JSON 404 instead of the SPA HTML.
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: '接口不存在' }));

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Final error handler: malformed JSON bodies and unexpected failures must
// surface as JSON, never crash the process.
app.use((err, req, res, next) => {
  const status = err && err.status ? err.status : 500;
  res.status(status).json({ ok: false, error: status === 400 ? '请求格式错误' : '服务器内部错误' });
});

if (require.main === module) {
  app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('GlobalStudy MVP V1.0 running'));
}

module.exports = {
  app, reference, schools: demoSchools, demoSchools, catalogPrograms, scholarships, listSchools, enrichSchool,
  allKnownSchools, importedSchools, searchableImported, schoolBaseList,
  importer, review, store,
  distance: { haversineMeters, schoolStationDistance, distanceLabel }
};
