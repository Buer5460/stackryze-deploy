const express = require('express');
const path = require('path');
const base = require('./server');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

const ok = (data, meta) => (meta ? { ok: true, data, meta } : { ok: true, data });

const indexBy = (list, key = 'id') => {
  const map = new Map();
  for (const item of list || []) map.set(String(item[key] || '').toLowerCase(), item);
  return map;
};

const countryById = indexBy(base.reference.countries);
const cityById = indexBy(base.reference.cities);
const districtById = indexBy(base.reference.districts);
const stageById = indexBy(base.reference.educationStages);
const curriculumById = indexBy(base.reference.curricula);

function displayStage(id) {
  const x = stageById.get(String(id || '').toLowerCase());
  return x ? { id: x.id, en: x.name_en || x.en || x.id, zh: x.name_zh || x.zh || x.id } : { id, en: id, zh: id };
}

function displayCurriculum(value) {
  const x = curriculumById.get(String(value || '').toLowerCase());
  return x ? { id: x.id, en: x.name_en || value, zh: x.name_zh || x.name_en || value } : { id: value, en: value, zh: value };
}

function publicSchool(raw, detail = false) {
  const s = base.enrichSchool(raw);
  const country = countryById.get(String(s.country_id || '').toLowerCase());
  const city = cityById.get(String(s.city_id || '').toLowerCase());
  const district = districtById.get(String(s.district_id || '').toLowerCase());

  const out = {
    id: s.id,
    name: {
      en: s.name_en || s.name || s.name_zh || s.id,
      zh: s.name_zh || s.name || s.name_en || s.id
    },
    verification: {
      status: s.verified_status || 'draft',
      is_demo: Boolean(s.is_demo),
      verified_at: s.verified_at || null,
      effective_from: s.effective_from || null,
      effective_to: s.effective_to || null,
      freshness: s.freshness || null,
      updated_at: s.updated_at || null
    },
    location: {
      country_id: s.country_id,
      country_en: country ? country.name_en : (s.location && s.location.country_en) || null,
      country_zh: country ? country.name_zh : (s.location && s.location.country_zh) || null,
      city_id: s.city_id,
      city_en: city ? city.name_en : (s.location && s.location.city_en) || null,
      city_zh: city ? city.name_zh : (s.location && s.location.city_zh) || null,
      district_id: s.district_id,
      district_en: district ? district.name_en : (s.location && s.location.district_en) || null,
      district_zh: district ? district.name_zh : (s.location && s.location.district_zh) || null,
      region_group: district ? district.region_group : (s.location && s.location.region_group) || null,
      latitude: Number.isFinite(Number(s.latitude)) ? Number(s.latitude) : null,
      longitude: Number.isFinite(Number(s.longitude)) ? Number(s.longitude) : null
    },
    institution_type: s.institution_type || null,
    stages: (s.stages || []).map(displayStage),
    curricula: (s.curricula || []).map(displayCurriculum),
    languages: {
      primary: s.main_language || null,
      additional: s.additional_languages || []
    },
    fees: {
      tuition_min: s.tuition_min ?? null,
      tuition_max: s.tuition_max ?? null,
      first_year_cost_min: s.first_year_cost_min ?? null,
      first_year_cost_max: s.first_year_cost_max ?? null,
      currency: s.currency || null
    },
    boarding: Boolean(s.boarding),
    scholarships: Boolean(s.scholarships),
    transit: s.station
      ? {
          name_en: s.station.name_en || null,
          name_zh: s.station.name_zh || null,
          line_code: s.station.line_code || null,
          line_name_en: s.station.line_name_en || null,
          distance_m: s.distance_m ?? null,
          distance_label: s.distance_label || null
        }
      : null
  };

  if (detail) {
    out.source = {
      source_url: s.source_url || null,
      source_type: s.source_type || null,
      supplier_evidence: s.supplier_evidence ? true : false
    };
    out.campuses = (s.campuses || []).map((c) => ({
      id: c.id,
      name: c.name || c.name_en || c.name_zh || 'Campus',
      name_zh: c.name_zh || null,
      address: c.address || null
    }));
    out.programs = (base.catalogPrograms || [])
      .filter((p) => String(p.institution_id) === String(s.id))
      .map((p) => ({
        id: p.id,
        name: p.name || p.name_en || p.name_zh || p.id,
        name_zh: p.name_zh || null,
        stage: p.stage || null,
        curriculum: p.curriculum || null,
        duration: p.duration || null,
        tuition: p.tuition ?? null,
        currency: p.currency || s.currency || null,
        start_date: p.start_date || null,
        deadline: p.deadline || null,
        language_requirement: p.language_requirement || null,
        scholarship_available: Boolean(p.scholarship_available),
        is_demo: Boolean(p.is_demo ?? s.is_demo)
      }));
    out.scholarship_items = (base.scholarships || [])
      .filter((x) => String(x.institution_id) === String(s.id))
      .map((x) => ({
        id: x.id,
        name: x.name || x.name_en || x.name_zh || x.id,
        amount: x.amount ?? null,
        percentage: x.percentage ?? null,
        currency: x.currency || s.currency || null,
        eligibility: x.eligibility || null,
        deadline: x.deadline || null,
        certainty: x.certainty || null,
        is_demo: Boolean(x.is_demo ?? s.is_demo)
      }));
  }

  return out;
}

function publicReference() {
  return {
    countries: (base.reference.countries || []).map((x) => ({ id: x.id, en: x.name_en, zh: x.name_zh, currency: x.currency })),
    cities: (base.reference.cities || []).map((x) => ({ id: x.id, country_id: x.country_id, en: x.name_en, zh: x.name_zh })),
    districts: (base.reference.districts || []).map((x) => ({ id: x.id, city_id: x.city_id, en: x.name_en, zh: x.name_zh, region_group: x.region_group })),
    stages: (base.reference.educationStages || []).map((x) => ({ id: x.id, en: x.name_en || x.en || x.id, zh: x.name_zh || x.zh || x.id })),
    curriculum_families: (base.reference.curriculumFamilies || []).map((x) => ({ id: x.id, en: x.name_en || x.name || x.id, zh: x.name_zh || x.name_en || x.name || x.id })),
    curricula: (base.reference.curricula || []).map((x) => ({ id: x.id, family: x.family || x.family_id || null, en: x.name_en || x.id, zh: x.name_zh || x.name_en || x.id })),
    languages: (base.reference.languages || []).map((x) => typeof x === 'string' ? { id: x, en: x, zh: x } : ({ id: x.id || x.name_en, en: x.name_en || x.id, zh: x.name_zh || x.name_en || x.id })),
    institution_types: (base.reference.institutionTypes || []).map((x) => ({ id: x.id, en: x.name_en || x.id, zh: x.name_zh || x.name_en || x.id }))
  };
}

app.get('/api/health', (req, res) => {
  const publicSchools = base.listSchools({});
  res.json(ok({
    status: 'ok',
    service: 'globalstudy-world-mvp',
    version: '1.0-public',
    audience: 'public',
    schools: publicSchools.length,
    demo_schools: publicSchools.filter((s) => s.is_demo).length,
    verified_schools: publicSchools.filter((s) => !s.is_demo && s.verified_status === 'verified').length
  }));
});

app.get('/api/meta', (req, res) => {
  const list = base.listSchools({});
  res.json(ok({
    product: 'GlobalStudy',
    positioning: 'Global school discovery and education collaboration platform',
    languages: ['en', 'zh'],
    public_features: ['school-search', 'filters', 'school-detail', 'compare', 'shortlist'],
    excluded_internal_features: ['growth-center', 'admin-import', 'b2b-commission', 'internal-crm'],
    data_policy: {
      demo_data_is_labeled: true,
      verified_data_requires_source: true,
      no_admission_probability_claims: true,
      no_financial_products_in_public_mvp: true
    },
    counts: {
      schools: list.length,
      demo: list.filter((s) => s.is_demo).length,
      verified: list.filter((s) => !s.is_demo && s.verified_status === 'verified').length
    }
  }));
});

app.get('/api/reference', (req, res) => res.json(ok(publicReference())));

app.get('/api/schools', (req, res) => {
  const allowed = ['q','country','city','district','stage','curriculum','language','institutionType','minFee','maxFee','scholarship','boarding','transitStation','transitNear','maxDistance','sort'];
  const query = {};
  for (const key of allowed) if (req.query[key] !== undefined) query[key] = req.query[key];

  let list = base.listSchools(query).map((s) => publicSchool(s, false));
  const page = Math.max(1, Number.parseInt(req.query.page || '1', 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(req.query.pageSize || '12', 10) || 12));
  const start = (page - 1) * pageSize;

  res.json(ok(list.slice(start, start + pageSize), {
    total: list.length,
    page,
    pageSize,
    demoOnly: list.length > 0 && list.every((x) => x.verification.is_demo)
  }));
});

app.get('/api/schools/:id', (req, res) => {
  const raw = base.allKnownSchools().find((s) => String(s.id).toLowerCase() === String(req.params.id).toLowerCase());
  if (!raw) return res.status(404).json({ ok: false, error: 'School not found' });
  if (!raw.is_demo && String(raw.verified_status).toLowerCase() !== 'verified') {
    return res.status(404).json({ ok: false, error: 'School not available' });
  }
  res.json(ok(publicSchool(raw, true)));
});

app.get('/api/compare', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 4);
  if (!ids.length) return res.status(400).json({ ok: false, error: 'ids is required' });
  const all = base.allKnownSchools();
  const picked = ids
    .map((id) => all.find((s) => String(s.id).toLowerCase() === id.toLowerCase()))
    .filter(Boolean)
    .filter((s) => s.is_demo || String(s.verified_status).toLowerCase() === 'verified')
    .map((s) => publicSchool(s, false));
  res.json(ok(picked, { total: picked.length, max: 4 }));
});

// Public service intentionally exposes NO Growth/Admin/B2B endpoints.
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Public API endpoint not found' }));

const publicDir = path.join(__dirname, 'public-world');
app.use(express.static(publicDir, { maxAge: '5m' }));
app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.use((err, req, res, next) => {
  res.status(err && err.status ? err.status : 500).json({ ok: false, error: 'Public MVP server error' });
});

if (require.main === module) {
  app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('GlobalStudy World MVP running'));
}

module.exports = { app, publicSchool, publicReference };
