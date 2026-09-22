const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));

const readJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, relativePath), 'utf8'));

// ---------------------------------------------------------------------------
// Data: split reference dictionaries + demo entities (V0.5 file layout)
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

const schools = readJson('data/demo/schools.json').schools;
const catalogPrograms = readJson('data/demo/programs.json').programs;
const scholarships = readJson('data/demo/scholarships.json').scholarships;

// ---------------------------------------------------------------------------
// Lookup indexes (built once at boot)
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
const schoolById = indexBy(schools, 'id');

// ---------------------------------------------------------------------------
// Application demo data (C/B/S/Admin flows, unchanged from previous version)
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
    {
      id: 1,
      school: '南洋国际学院（演示）',
      country: '新加坡',
      program: '数据科学硕士',
      degree: '硕士',
      lang: 'IELTS 6.5',
      fee: 188000,
      scholarship: 30000,
      deadline: '2026-11-30',
      fit: '符合已知条件'
    },
    {
      id: 2,
      school: '海峡商学院（演示）',
      country: '新加坡',
      program: '国际商务本科',
      degree: '本科',
      lang: 'IELTS 6.0',
      fee: 128000,
      scholarship: 20000,
      deadline: '2026-12-15',
      fit: '资料不足'
    },
    {
      id: 3,
      school: '英伦创新大学（演示）',
      country: '英国',
      program: '金融科技硕士',
      degree: '硕士',
      lang: 'IELTS 6.5',
      fee: 236000,
      scholarship: 25000,
      deadline: '2027-01-20',
      fit: '符合已知条件'
    }
  ],
  clients: [
    { id: 101, name: '陈小雨', source: '机构专属二维码', owner: '王老师', stage: '材料准备', completion: 82 },
    { id: 102, name: '李晨', source: '自然注册后授权', owner: '周老师', stage: '院校受理', completion: 91 }
  ],
  applications: [
    {
      id: 'APP-260901',
      student: '陈小雨',
      programId: 1,
      agency: '环球学桥（演示）',
      school: '南洋国际学院（演示）',
      status: '材料准备',
      progress: 42,
      commission: 9800
    },
    {
      id: 'APP-260823',
      student: '李晨',
      programId: 3,
      agency: '环球学桥（演示）',
      school: '英伦创新大学（演示）',
      status: '院校受理',
      progress: 68,
      commission: 12500
    }
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

// Query params can arrive as strings or arrays (?stage=a&stage=b) — always take all values.
function paramValues(query, name) {
  const raw = query[name];
  if (raw === undefined) return [];
  return (Array.isArray(raw) ? raw : [raw]).map((v) => String(v)).filter((v) => v.length > 0);
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

// Resolve ids like "ib-pyp" / "international-school" / "primary" to canonical names
// so filters accept both dictionary ids and free text.
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
// Enrichment: resolve reference ids into display names for the frontend
// ---------------------------------------------------------------------------
function enrichSchool(school) {
  const country = countryById.get(String(school.country_id).toLowerCase());
  const city = cityById.get(String(school.city_id).toLowerCase());
  const district = districtById.get(String(school.district_id).toLowerCase());
  const station = stationById.get(String(school.nearest_station_id || '').toLowerCase());
  const line = station ? lineById.get(String(station.line_id).toLowerCase()) : undefined;
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
          type: line ? line.type : null
        }
      : null
  };
}

const enrichedSchools = schools.map(enrichSchool);
const enrichedPrograms = catalogPrograms.map((p) => {
  const school = schoolById.get(String(p.institution_id).toLowerCase());
  const district = school ? districtById.get(String(school.district_id).toLowerCase()) : undefined;
  return {
    ...p,
    institution_name_zh: school ? school.name_zh : null,
    institution_name_en: school ? school.name_en : null,
    city_id: school ? school.city_id : null,
    district_en: district ? district.name_en : null
  };
});

// ---------------------------------------------------------------------------
// School search (V0.5_SPEC section 5)
// ---------------------------------------------------------------------------
function listSchools(query) {
  let list = [...enrichedSchools];

  const q = param(query, 'q');
  if (q) {
    list = list.filter((s) =>
      [
        s.name_zh,
        s.name_en,
        s.institution_type,
        s.main_language,
        s.location.country_en,
        s.location.city_en,
        s.location.district_en,
        s.location.district_zh,
        s.location.region_group,
        ...(s.curricula || []),
        ...(s.stages || []),
        ...(s.additional_languages || [])
      ].some((v) => includesCI(v, q))
    );
  }

  list = list.filter((s) => matchLocation(s, query, 'country'));
  list = list.filter((s) => matchLocation(s, query, 'city'));
  list = list.filter((s) => matchLocation(s, query, 'district'));

  const stages = paramValues(query, 'stage').flatMap(stageQueryIds);
  if (stages.length) {
    list = list.filter((s) => someCI(s.stages, (v) => stages.some((st) => includesCI(v, st))));
  }

  const curricula = paramValues(query, 'curriculum').flatMap(curriculumQueryNames);
  if (curricula.length) {
    list = list.filter((s) => someCI(s.curricula, (v) => curricula.some((c) => includesCI(v, c))));
  }

  const languages = paramValues(query, 'language');
  if (languages.length) {
    list = list.filter((s) =>
      [s.main_language, ...(s.additional_languages || [])].some((v) =>
        languages.some((l) => includesCI(v, l))
      )
    );
  }

  const types = paramValues(query, 'institutionType').flatMap(institutionTypeQueryNames);
  if (types.length) {
    list = list.filter((s) => types.some((t) => includesCI(s.institution_type, t)));
  }

  const minFee = numberQuery(param(query, 'minFee'));
  if (minFee !== undefined) {
    list = list.filter((s) => Number(s.tuition_max || s.tuition_min || 0) >= minFee);
  }

  const maxFee = numberQuery(param(query, 'maxFee'));
  if (maxFee !== undefined) {
    list = list.filter((s) => Number(s.tuition_min || s.tuition_max || 0) <= maxFee);
  }

  const scholarship = boolQuery(param(query, 'scholarship'));
  if (scholarship !== undefined) list = list.filter((s) => Boolean(s.scholarships) === scholarship);

  const boarding = boolQuery(param(query, 'boarding'));
  if (boarding !== undefined) list = list.filter((s) => Boolean(s.boarding) === boarding);

  const stations = paramValues(query, 'transitStation');
  if (stations.length) {
    list = list.filter((s) => {
      if (!s.station) return false;
      return stations.some(
        (needle) =>
          String(s.station.id).toLowerCase() === needle.toLowerCase() ||
          includesCI(s.station.name_en, needle) ||
          includesCI(s.station.name_zh, needle)
      );
    });
  }

  const transitNear = boolQuery(param(query, 'transitNear'));
  if (transitNear !== undefined) {
    list = list.filter((s) => Boolean(s.nearest_station_id) === transitNear);
  }

  if (param(query, 'verifiedOnly') === 'true') {
    list = list.filter((s) => s.verified_status === 'verified');
  }

  const sort = param(query, 'sort');
  if (sort === 'fee_asc') {
    list.sort((a, b) => Number(a.tuition_min || 0) - Number(b.tuition_min || 0));
  } else if (sort === 'fee_desc') {
    list.sort((a, b) => Number(b.tuition_max || 0) - Number(a.tuition_max || 0));
  }

  return list;
}

function paginate(list, query) {
  const page = Math.max(1, Number.parseInt(param(query, 'page') || '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(param(query, 'pageSize') || '20', 10) || 20));
  const start = (page - 1) * pageSize;
  return {
    data: list.slice(start, start + pageSize),
    meta: { total: list.length, page, pageSize }
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) =>
  res.json(ok({
    status: 'ok',
    service: 'global-study-mobile-mvp',
    version: '0.5.0',
    dataFoundation: true,
    demoSchools: schools.length,
    demoPrograms: catalogPrograms.length,
    demoScholarships: scholarships.length,
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
    schools: enrichedSchools,
    catalogPrograms: enrichedPrograms,
    scholarships
  }))
);

app.get('/api/schools', (req, res) => {
  const { data, meta } = paginate(listSchools(req.query), req.query);
  res.json(ok(data, { ...meta, demoOnly: data.every((s) => s.is_demo === true) }));
});

app.get('/api/schools/:id', (req, res) => {
  const school = schoolById.get(String(req.params.id).toLowerCase());
  if (!school) return res.status(404).json({ ok: false, error: '学校不存在' });
  res.json(ok({
    ...enrichSchool(school),
    campuses: school.campuses || [],
    programs: enrichedPrograms.filter((p) => p.institution_id === school.id),
    scholarships: scholarships.filter((x) => x.institution_id === school.id),
    source: {
      source_url: school.source_url,
      source_type: school.source_type,
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
  let list = [...enrichedPrograms];

  const q = param(querySafe(req), 'q');
  if (q) {
    list = list.filter((p) =>
      [p.name, p.name_zh, p.institution_name_zh, p.institution_name_en, p.curriculum].some((v) => includesCI(v, q))
    );
  }

  const institution = param(querySafe(req), 'institution');
  if (institution) {
    list = list.filter(
      (p) =>
        String(p.institution_id).toLowerCase() === institution.toLowerCase() ||
        includesCI(p.institution_name_zh, institution) ||
        includesCI(p.institution_name_en, institution)
    );
  }

  const stages = paramValues(req.query, 'stage').flatMap(stageQueryIds);
  if (stages.length) list = list.filter((p) => stages.some((st) => includesCI(p.stage, st)));

  const curricula = paramValues(req.query, 'curriculum').flatMap(curriculumQueryNames);
  if (curricula.length) list = list.filter((p) => curricula.some((c) => includesCI(p.curriculum, c)));

  const languages = paramValues(req.query, 'language');
  if (languages.length) {
    list = list.filter((p) => {
      const school = schoolById.get(String(p.institution_id).toLowerCase());
      const langs = [p.language_requirement, school ? school.main_language : null]
        .concat(school ? school.additional_languages || [] : []);
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

// querySafe: req.query is always an object for GET, but keep a guard so odd
// middleware setups cannot crash the handlers above.
function querySafe(req) {
  return req && req.query ? req.query : {};
}

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
  app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('GlobalStudy MVP V0.5 running'));
}

module.exports = { app, reference, schools, catalogPrograms, scholarships, listSchools, enrichSchool };
