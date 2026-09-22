// V0.5 smoke tests — HTTP-level against a real server instance on an ephemeral port.
// Run: npm test
const assert = require('node:assert/strict');
const { app, reference, schools } = require('../server');

const passed = [];
const failed = [];
async function test(name, fn) {
  try {
    await fn();
    passed.push(name);
    console.log('  ok  ' + name);
  } catch (err) {
    failed.push(name + ' :: ' + (err && err.message));
    console.error('FAIL  ' + name + ' :: ' + (err && err.message));
  }
}

async function main() {
  // --- app start smoke test ---
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = async (path) => {
    const r = await fetch(base + path);
    let body = null;
    try { body = await r.json(); } catch (_) { body = null; }
    return { status: r.status, body };
  };
  const getText = async (path) => {
    const r = await fetch(base + path);
    return { status: r.status, text: await r.text(), type: r.headers.get('content-type') || '' };
  };

  console.log('V0.5 smoke tests');

  await test('data integrity: 20 demo schools, all is_demo + verified_status demo + no source_url', () => {
    assert.equal(schools.length, 20);
    assert.ok(schools.every((s) => s.is_demo === true));
    assert.ok(schools.every((s) => s.verified_status === 'demo'));
    assert.ok(schools.every((s) => s.source_url === null));
    assert.ok(schools.every((s) => Array.isArray(s.campuses) && s.campuses.length >= 1));
    assert.ok(schools.some((s) => s.country_id === 'SG'));
    assert.ok(schools.some((s) => s.city_id === 'CN-SHA'));
    assert.ok(schools.some((s) => s.city_id === 'CN-BJS'));
  });

  await test('reference dictionary: 3 cities, Shanghai 16 + Beijing 16 + SG 45 planning areas in 5 regions', () => {
    assert.equal(reference.cities.length, 3);
    const byCity = (id) => reference.districts.filter((d) => d.city_id === id).length;
    assert.equal(byCity('CN-SHA'), 16);
    assert.equal(byCity('CN-BJS'), 16);
    assert.equal(byCity('SG-SIN'), 45);
    const sgRegions = new Set(reference.districts.filter((d) => d.city_id === 'SG-SIN').map((d) => d.region_group));
    assert.equal(sgRegions.size, 5);
  });

  await test('reference dictionary: stages 10, curricula 50+, languages 15, transit seeded', () => {
    assert.equal(reference.educationStages.length, 10);
    assert.ok(reference.curricula.length >= 50);
    assert.equal(reference.languages.length, 15);
    assert.ok(reference.transitLines.length >= 20);
    assert.ok(reference.transitStations.length >= 100);
    assert.ok(reference.institutionTypes.length >= 5);
  });

  await test('GET /api/health', async () => {
    const { status, body } = await get('/api/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.status, 'ok');
    assert.equal(body.data.demoSchools, 20);
    assert.ok(body.data.reference.districts >= 55);
  });

  await test('GET /api/reference returns all dictionaries', async () => {
    const { status, body } = await get('/api/reference');
    assert.equal(status, 200);
    const d = body.data;
    for (const key of ['countries', 'cities', 'districts', 'educationStages', 'curriculumFamilies', 'curricula', 'languages', 'transitLines', 'transitStations', 'institutionTypes']) {
      assert.ok(Array.isArray(d[key]) && d[key].length > 0, 'missing ' + key);
    }
  });

  await test('GET /api/schools basic: no params returns paginated list with meta', async () => {
    const { status, body } = await get('/api/schools');
    assert.equal(status, 200);
    assert.equal(body.meta.total, 20);
    assert.equal(body.meta.page, 1);
    assert.ok(body.meta.pageSize >= 1);
    assert.equal(body.data.length, Math.min(20, body.meta.pageSize));
  });

  await test('GET /api/schools pagination: page=2&pageSize=5', async () => {
    const { body } = await get('/api/schools?page=2&pageSize=5');
    assert.equal(body.meta.page, 2);
    assert.equal(body.meta.pageSize, 5);
    assert.equal(body.data.length, 5);
  });

  await test('GET /api/schools combined filters: SG + Bukit Timah + primary + IB -> SG-DEMO-001', async () => {
    const { body } = await get('/api/schools?country=SG&city=SG-SIN&district=SG-SIN-BUKIT-TIMAH&stage=primary&curriculum=ib-pyp');
    assert.equal(body.meta.total, 1);
    assert.equal(body.data[0].id, 'SG-DEMO-001');
    assert.equal(body.data[0].location.district_en, 'Bukit Timah');
    assert.ok(body.data[0].station.name_en.includes('Sixth Avenue'));
  });

  await test('GET /api/schools combined: Chinese free-text country + curriculum family text', async () => {
    const { body } = await get('/api/schools?country=%E4%B8%AD%E5%9B%BD&curriculum=IB&boarding=true');
    assert.ok(body.meta.total >= 2);
    assert.ok(body.data.every((s) => s.country_id === 'CN' && s.boarding === true));
    assert.ok(body.data.every((s) => (s.curricula || []).some((c) => c.includes('IB'))));
  });

  await test('GET /api/schools city+stage: Shanghai primary', async () => {
    const { body } = await get('/api/schools?city=CN-SHA&stage=primary');
    assert.ok(body.meta.total >= 1);
    assert.ok(body.data.every((s) => s.city_id === 'CN-SHA' && s.stages.includes('primary')));
  });

  await test('GET /api/schools fee filters: minFee/maxFee + sort=fee_asc', async () => {
    const { body } = await get('/api/schools?minFee=15000&maxFee=40000&sort=fee_asc&pageSize=50');
    assert.ok(body.meta.total >= 1);
    const fees = body.data.map((s) => s.tuition_min);
    for (let i = 1; i < fees.length; i++) assert.ok(fees[i] >= fees[i - 1], 'not ascending');
    assert.ok(body.data.every((s) => s.tuition_max >= 15000 && s.tuition_min <= 40000));
  });

  await test('GET /api/schools booleans: scholarship=true / boarding=true', async () => {
    const a = await get('/api/schools?scholarship=true&pageSize=100');
    assert.ok(a.body.meta.total >= 1);
    assert.ok(a.body.data.every((s) => s.scholarships === true));
    const b = await get('/api/schools?boarding=true&pageSize=100');
    assert.ok(b.body.meta.total >= 1);
    assert.ok(b.body.data.every((s) => s.boarding === true));
  });

  await test('GET /api/schools language + institutionType filters', async () => {
    const { body } = await get('/api/schools?language=chinese&institutionType=international-school&pageSize=100');
    assert.ok(body.meta.total >= 1);
    assert.ok(body.data.every((s) =>
      [s.main_language, ...(s.additional_languages || [])].some((l) => String(l).toLowerCase().includes('chinese')) &&
      s.institution_type === 'International School'));
  });

  await test('GET /api/schools transitStation filter: Tampines -> SG-DEMO-004', async () => {
    const { body } = await get('/api/schools?transitStation=SG-SIN-ST-TAMPINES');
    assert.equal(body.meta.total, 1);
    assert.equal(body.data[0].id, 'SG-DEMO-004');
    const zh = await get('/api/schools?transitStation=' + encodeURIComponent('淡滨尼'));
    assert.equal(zh.body.meta.total, 1);
  });

  await test('GET /api/schools q search hits names, curricula, stations', async () => {
    const zh = await get('/api/schools?q=' + encodeURIComponent('榜鹅'));
    assert.equal(zh.body.meta.total, 1);
    const en = await get('/api/schools?q=montessori&pageSize=100');
    assert.ok(en.body.meta.total >= 3);
  });

  await test('GET /api/schools invalid params never crash: ignored garbage + unknown stage = empty 200', async () => {
    const { status, body } = await get('/api/schools?page=abc&pageSize=-9&minFee=zzz&boarding=maybe&scholarship=nope');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.meta.total, 20);
    const unknown = await get('/api/schools?stage=%3F%21');
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.meta.total, 0);
  });

  await test('GET /api/schools/:id detail aggregates campuses/programs/scholarships/source', async () => {
    const { status, body } = await get('/api/schools/SG-DEMO-001');
    assert.equal(status, 200);
    const d = body.data;
    assert.equal(d.id, 'SG-DEMO-001');
    assert.equal(d.campuses.length, 1);
    assert.equal(d.programs.length, 2);
    assert.equal(d.scholarships.length, 1);
    assert.equal(d.source.is_demo, true);
    assert.equal(d.source.source_url, null);
    assert.equal(d.source.verified_status, 'demo');
  });

  await test('GET /api/schools/:id 404 for unknown id', async () => {
    const { status, body } = await get('/api/schools/XX-NOPE-999');
    assert.equal(status, 404);
    assert.equal(body.ok, false);
  });

  await test('GET /api/programs filters: institution / stage / curriculum / maxFee', async () => {
    const all = await get('/api/programs?pageSize=100');
    assert.ok(all.body.meta.total >= 30);
    assert.equal(all.body.data.length, all.body.meta.total);
    const byInst = await get('/api/programs?institution=SG-DEMO-001');
    assert.equal(byInst.body.meta.total, 2);
    const byStage = await get('/api/programs?stage=upper-secondary&pageSize=100');
    assert.ok(byStage.body.meta.total >= 10);
    const byCurr = await get('/api/programs?curriculum=ib-dp');
    assert.ok(byCurr.body.meta.total >= 3);
    const byFee = await get('/api/programs?maxFee=20000&pageSize=100');
    assert.ok(byFee.body.meta.total >= 1);
    assert.ok(byFee.body.data.every((p) => p.tuition <= 20000));
    const byQ = await get('/api/programs?q=' + encodeURIComponent('蒙台梭利'));
    assert.ok(byQ.body.meta.total >= 4);
  });

  await test('GET /api/bootstrap keeps C/B/S/Admin demo payload intact', async () => {
    const { status, body } = await get('/api/bootstrap');
    assert.equal(status, 200);
    const d = body.data;
    for (const key of ['profile', 'programs', 'clients', 'applications', 'audits', 'reference', 'schools']) {
      assert.ok(d[key] !== undefined, 'bootstrap missing ' + key);
    }
    assert.equal(d.schools.length, 20);
  });

  await test('POST /api/applications rejects bad payload with 400', async () => {
    const r = await fetch(base + '/api/applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ programId: 999 })
    });
    assert.equal(r.status, 400);
    const r2 = await fetch(base + '/api/applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{'
    });
    assert.equal(r2.status, 400);
  });

  await test('unknown /api path returns JSON 404 (not SPA html)', async () => {
    const { status, body } = await get('/api/definitely-not-a-route');
    assert.equal(status, 404);
    assert.equal(body.ok, false);
  });

  await test('app start smoke: GET / serves the H5 with C/B/S/Admin roles', async () => {
    const { status, text, type } = await getText('/');
    assert.equal(status, 200);
    assert.ok(type.includes('text/html'));
    for (const marker of ['student', 'agency', 'supplier', 'admin', 'GLOBALSTUDY']) {
      assert.ok(text.includes(marker), 'index.html missing ' + marker);
    }
  });

  await new Promise((resolve) => server.close(resolve));

  console.log('\n' + passed.length + ' passed, ' + failed.length + ' failed');
  if (failed.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('test runner crashed:', err);
  process.exitCode = 1;
});
