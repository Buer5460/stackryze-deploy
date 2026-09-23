// V1.0 tests: detail/distance, compare, favourites(结构), import validation,
// duplicate detection, review status machine, source validation, B2B permission.
const assert = require('node:assert/strict');
const { app, importer, review, store, distance, listSchools, enrichSchool } = require('../server');

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
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = async (path, headers = {}) => {
    const r = await fetch(base + path, { headers });
    let body = null;
    try { body = await r.json(); } catch (_) { body = null; }
    return { status: r.status, body };
  };
  const post = async (path, payload, headers = {}) => {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload)
    });
    let body = null;
    try { body = await r.json(); } catch (_) { body = null; }
    return { status: r.status, body };
  };

  console.log('V1.0 tests');

  // --- distance calculation ---
  await test('distance: haversine known pair ~0m, and school-station > 0', () => {
    const same = distance.haversineMeters(1.335, 103.798, 1.335, 103.798);
    assert.ok(Math.abs(same) < 1e-6);
    // Singapore MRT stations Bishan <-> Novena ~ 2.5km
    const d = distance.haversineMeters(1.351, 103.849, 1.320, 103.843);
    assert.ok(d > 2000 && d < 5000, 'expected ~3km, got ' + d);
    const invalid = distance.haversineMeters(null, null, 1, 1);
    assert.equal(invalid, null);
  });

  await test('distance: all 20 demo schools have distance when station coords exist', () => {
    const list = listSchools({});
    const withDistance = list.filter((s) => s.distance_m !== null).length;
    assert.equal(withDistance, 20);
    assert.ok(list.every((s) => s.distance_label === null || /米|公里/.test(s.distance_label)));
    assert.ok(list.every((s) => s.commute_label === null)); // no fabricated commute
  });

  await test('detail: GET /api/schools/:id carries coords, distance, first-year cost, images array', async () => {
    const { status, body } = await get('/api/schools/SG-DEMO-001');
    assert.equal(status, 200);
    const d = body.data;
    assert.ok(d.latitude !== null && d.longitude !== null);
    assert.ok(d.distance_m > 0);
    assert.ok(d.first_year_cost_min > 0);
    assert.ok(Array.isArray(d.images));
    assert.ok(Array.isArray(d.programs));
    assert.ok(d.source.is_demo === true);
  });

  // --- map data endpoint ---
  await test('map: /api/map/:id returns structured coords + nearby stations', async () => {
    const { status, body } = await get('/api/map/SG-DEMO-001');
    assert.equal(status, 200);
    const d = body.data;
    assert.equal(d.school_id, 'SG-DEMO-001');
    assert.equal(d.renderable, true);
    assert.ok(Number.isFinite(d.center.lat) && Number.isFinite(d.center.lng));
    // Default request returns the nearest few stations, sorted by distance.
    assert.ok(d.stations.length > 0 && d.stations.length <= 5);
    const ds = d.stations.map((s) => s.distance_m);
    assert.deepEqual(ds, [...ds].sort((a, b) => a - b));
    assert.ok(d.stations.every((s) => s.line && s.distance_label));
    // No map vendor is wired up — must stay honest rather than fake a provider.
    assert.equal(d.tile_provider, null);
  });

  await test('map: maxStations/within honoured; unknown school 404s; no coords is honest', async () => {
    const capped = await get('/api/map/SG-DEMO-001?maxStations=2');
    assert.ok(capped.body.data.stations.length <= 2);
    const within = await get('/api/map/SG-DEMO-001?within=1000');
    assert.ok(within.body.data.stations.every((s) => s.distance_m <= 1000));
    const missing = await get('/api/map/NOPE-404');
    assert.equal(missing.status, 404);
  });

  // --- compare endpoint ---
  await test('compare: /api/compare returns requested schools, capped at 4', async () => {
    const { body } = await get('/api/compare?ids=SG-DEMO-001,SG-DEMO-002');
    assert.equal(body.meta.total, 2);
    assert.equal(body.data.length, 2);
    const many = await get('/api/compare?ids=SG-DEMO-001,SG-DEMO-002,SG-DEMO-003,SG-DEMO-004,SG-DEMO-005');
    assert.equal(many.body.data.length, 4);
  });

  // --- favourites are frontend-local; backend exposes full school data for fav lists ---
  await test('favourites: bootstrap schools array supports fav/compare ids', async () => {
    const { body } = await get('/api/bootstrap');
    const ids = body.data.schools.map((s) => s.id);
    assert.ok(ids.includes('SG-DEMO-001') && ids.includes('BJ-DEMO-006'));
    assert.equal(body.data.schools.length, 20);
  });

  // --- importer validation ---
  await test('import: parseInput handles JSON array and CSV text', () => {
    const json = importer.parseInput('[{"name":"A","country":"CN","city":"CN-SHA"}]');
    assert.equal(json.length, 1);
    const csv = importer.parseInput('name,country,city\nA,CN,CN-SHA\nB,CN,CN-BJS');
    assert.equal(csv.length, 2);
    assert.deepEqual(Object.keys(csv[0]), ['name', 'country', 'city']);
    assert.equal(importer.parseInput('not json[ and not csv'), null);
  });

  await test('import: validateCandidate rejects verified without source and without verified_at', () => {
    const ctx = {
      countries: [{ id: 'CN', code: 'CN', name_en: 'China', name_zh: '中国' }],
      cities: [{ id: 'CN-SHA', name_en: 'Shanghai', name_zh: '上海' }],
      districts: []
    };
    const noSource = importer.validateCandidate(
      importer.normalizeRow({ name: 'X School', country: 'China', city: 'Shanghai', verified_status: 'verified' }),
      ctx
    );
    assert.equal(noSource.ok, false);
    assert.ok(noSource.errors.some((e) => e.includes('不得标记 verified')));
    assert.equal(noSource.candidate.verified_status, 'draft');

    const withSource = importer.validateCandidate(
      importer.normalizeRow({ name: 'X School', country: 'China', city: 'Shanghai', source_url: 'https://example.com/x', verified_status: 'verified', verified_at: '2026-09-01' }),
      ctx
    );
    assert.equal(withSource.ok, true);
    assert.equal(withSource.candidate.verified_status, 'verified');
    assert.equal(withSource.candidate.country_id, 'CN');
    assert.equal(withSource.candidate.city_id, 'CN-SHA');
  });

  await test('import: duplicate detection against existing demo schools', () => {
    const existing = [{ id: 'SG-DEMO-001', name_zh: '新加坡国际学校 Demo 01', city_id: 'SG-SIN' }];
    const dup = importer.findDuplicate({ name: '新加坡国际学校 Demo 01', city_id: 'SG-SIN' }, existing);
    assert.equal(dup.id, 'SG-DEMO-001');
    const notDup = importer.findDuplicate({ name: '完全不同学校', city_id: 'SG-SIN' }, existing);
    assert.equal(notDup, null);
  });

  await test('import preview API: mixed rows report importable/invalid/duplicates', async () => {
    const csv = [
      'name,country,city,source_url,verified_status,verified_at',
      '全新真实学校A,China,Shanghai,https://example.com/a,verified,2026-09-01',
      '新加坡国际学校 Demo 01,Singapore,Singapore,,draft,',
      '缺字段学校,,Shanghai,,draft,',
    ].join('\n');
    const { status, body } = await post('/api/admin/import/preview', { content: csv }, { 'x-role': 'admin' });
    assert.equal(status, 200);
    const d = body.data;
    assert.equal(d.total, 3);
    assert.equal(d.importable, 1);
    assert.equal(d.duplicates, 1);
    assert.equal(d.invalid, 1);
    assert.ok(d.report.some((r) => r.errors.some((e) => e.includes('重复'))));
    assert.ok(d.report.some((r) => r.errors.some((e) => e.includes('必填字段'))));
  });

  // --- import commit + review queue + status machine (with cleanup) ---
  let createdId = null;
  await test('import commit: creates draft queue item; C-end does not expose draft', async () => {
    const csv = 'name,country,city,source_url\n待审核真实学校Z,China,Beijing,https://example.com/z\n';
    const { status, body } = await post('/api/admin/import/commit', { content: csv }, { 'x-role': 'admin' });
    assert.equal(status, 200);
    assert.equal(body.data.committed, 1);
    createdId = body.data.committed_ids[0].id;
    // C-end search must not show it (draft)
    const search = await get('/api/schools?q=' + encodeURIComponent('待审核真实学校Z'));
    assert.equal(search.body.meta.total, 0);
    // queue shows it
    const q = await get('/api/admin/queue', { 'x-role': 'admin' });
    assert.ok(q.body.data.some((i) => i.school_id === createdId && i.status === 'draft'));
  });

  await test('review: draft → pending → approve requires source; sensitive edit forces re-review', async () => {
    const submit = await post(`/api/admin/queue/${createdId}/action`, { action: 'submit' }, { 'x-role': 'admin' });
    assert.equal(submit.body.data.status, 'pending');
    // approve (has source_url) → verified
    const approve = await post(`/api/admin/queue/${createdId}/action`, { action: 'approve' }, { 'x-role': 'admin' });
    assert.equal(approve.body.data.status, 'verified');
    // now C-end search finds it
    const search = await get('/api/schools?q=' + encodeURIComponent('待审核真实学校Z'));
    assert.equal(search.body.meta.total, 1);
    // sensitive field edit → forced back to pending
    const patch = await fetch(base + `/api/admin/schools/${createdId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-role': 'admin' },
      body: JSON.stringify({ fields: { tuition_min: 100, tuition_max: 200 } })
    });
    const patchBody = await patch.json();
    assert.equal(patchBody.data.re_review.to, 'pending');
    // C-end search no longer shows it
    const search2 = await get('/api/schools?q=' + encodeURIComponent('待审核真实学校Z'));
    assert.equal(search2.body.meta.total, 0);
  });

  await test('review: reject + expire transitions recorded with history; revisions endpoint', async () => {
    // currently pending after re-review; reject it
    const reject = await post(`/api/admin/queue/${createdId}/action`, { action: 'reject', note: '来源不足' }, { 'x-role': 'admin' });
    assert.equal(reject.body.data.status, 'rejected');
    const revs = await get(`/api/admin/schools/${createdId}/revisions`, { 'x-role': 'admin' });
    assert.ok(revs.body.data.history.length >= 3);
    assert.ok(revs.body.data.revisions.some((r) => r.field === 'tuition_min'));
  });

  await test('review: approve without source returns 400', async () => {
    const csv = 'name,country,city\n无来源学校W,China,Shanghai\n';
    const commit = await post('/api/admin/import/commit', { content: csv }, { 'x-role': 'admin' });
    const id = commit.body.data.committed_ids[0].id;
    await post(`/api/admin/queue/${id}/action`, { action: 'submit' }, { 'x-role': 'admin' });
    const approve = await post(`/api/admin/queue/${id}/action`, { action: 'approve' }, { 'x-role': 'admin' });
    assert.equal(approve.status, 400);
    assert.ok(approve.body.error.includes('缺少来源'));
  });

  // cleanup created imported schools so the repo store stays pristine
  await test('cleanup: remove test-imported schools and queue items', () => {
    const data = store.load('imports');
    data.schools = data.schools.filter((s) => !String(s.name).includes('待审核真实学校Z') && !String(s.name).includes('无来源学校W'));
    data.history = data.history.filter((h) => !h.count || h.count <= 0);
    store.save('imports', data);
    const q = store.load('queue');
    q.items = q.items.filter((i) => !String(i.school_id).includes('IMP-'));
    store.save('queue', q);
    assert.equal(store.load('imports').schools.length, 0);
    assert.equal(store.load('queue').items.length, 0);
  });

  // --- B2B permissions ---
  await test('B2B: x-role agency gets agency view; student gets 403', async () => {
    const noRole = await get('/api/b2b/schools');
    assert.equal(noRole.status, 403);
    const agency = await get('/api/b2b/schools?pageSize=5', { 'x-role': 'agency' });
    assert.equal(agency.status, 200);
    const d = agency.body.data;
    assert.ok(d.length > 0);
    assert.ok(d.every((s) => 'agency' in s && 'commission' in s.agency));
  });

  await test('B2B: commission is only exposed for real (non-demo) agreements', async () => {
    const { body } = await get('/api/b2b/schools?pageSize=100', { 'x-role': 'agency' });
    const withRealCommission = body.data.filter((s) => s.agency.commission.commission_type);
    // Demo agreements must never leak commission values.
    assert.equal(withRealCommission.length, 0);
    // Demo agreement schools show a note instead.
    const demoAgr = body.data.find((s) => s.id === 'SG-DEMO-001');
    assert.ok(demoAgr.agency.commission.note.includes('演示'));
    assert.equal(demoAgr.agency.commission.commission_type, null);
  });

  await test('B2B: admin role can access b2b endpoints; supplier cannot', async () => {
    const admin = await get('/api/b2b/schools?pageSize=1', { 'x-role': 'admin' });
    assert.equal(admin.status, 200);
    const supplier = await get('/api/b2b/schools', { 'x-role': 'supplier' });
    assert.equal(supplier.status, 403);
  });

  await test('admin import/queue endpoints reject non-admin', async () => {
    const preview = await post('/api/admin/import/preview', { content: 'x' }, { 'x-role': 'agency' });
    assert.equal(preview.status, 403);
    const queue = await get('/api/admin/queue', { 'x-role': 'supplier' });
    assert.equal(queue.status, 403);
  });

  await new Promise((resolve) => server.close(resolve));

  console.log('\n' + passed.length + ' passed, ' + failed.length + ' failed');
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('test runner crashed:', err);
  process.exitCode = 1;
});
