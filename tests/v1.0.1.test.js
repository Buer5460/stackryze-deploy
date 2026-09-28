// V1.0.1 tests: real-school data import pilot — source rule, dedup, CSV/JSON
// errors, demo/real isolation, status machine, expiry, sensitive re-review,
// freshness config, and public correction entry.
const assert = require('node:assert/strict');
const { app, importer, freshness, store } = require('../server');

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

const CTX = {
  countries: [
    { id: 'SG', code: 'SG', name_en: 'Singapore', name_zh: '新加坡' },
    { id: 'CN', code: 'CN', name_en: 'China', name_zh: '中国' },
  ],
  cities: [
    { id: 'SG-SIN', country_id: 'SG', name_en: 'Singapore', name_zh: '新加坡' },
    { id: 'CN-SHA', country_id: 'CN', name_en: 'Shanghai', name_zh: '上海' },
    { id: 'CN-BJS', country_id: 'CN', name_en: 'Beijing', name_zh: '北京' },
  ],
  districts: [],
};

function adminPost(base, path, payload) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-role': 'admin' },
    body: JSON.stringify(payload),
  });
}

async function main() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = async (path, headers = {}) => {
    const r = await fetch(base + path, { headers });
    let body = null; try { body = await r.json(); } catch (_) {}
    return { status: r.status, body };
  };
  const post = async (path, payload, headers = {}) => {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });
    let body = null; try { body = await r.json(); } catch (_) {}
    return { status: r.status, body };
  };
  const put = async (path, payload, headers = {}) => {
    const r = await fetch(base + path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });
    let body = null; try { body = await r.json(); } catch (_) {}
    return { status: r.status, body };
  };

  console.log('V1.0.1 tests');

  // --- source rule: no source_url/supplier_evidence ⇒ never verified ---
  await test('source rule: verified without source is rejected by importer', () => {
    const r = importer.validateCandidate(
      importer.normalizeRow({ name: 'X', country: 'Singapore', city: 'Singapore', verified_status: 'verified' }),
      CTX
    );
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('不得标记 verified')));
    assert.equal(r.candidate.verified_status, 'draft');
  });

  // --- duplicate detection (name + city) ---
  await test('dedup: name+city match flagged as duplicate', () => {
    const existing = [{ id: 'SG-REAL-1', name_zh: '新加坡国立示范中学', city_id: 'SG-SIN' }];
    const dup = importer.findDuplicate({ name: '新加坡国立示范中学', city_id: 'SG-SIN' }, existing);
    assert.equal(dup.id, 'SG-REAL-1');
    const ok = importer.findDuplicate({ name: '别校', city_id: 'SG-SIN' }, existing);
    assert.equal(ok, null);
  });

  // --- CSV field error: missing required -> row invalid ---
  await test('CSV field error: missing country/city -> importable counts exclude it', async () => {
    const csv = [
      'name,country,city,source_url',
      '完整真实校A,Singapore,Singapore,https://x.com/a',
      '缺字段校,,Shanghai,https://x.com/b',
    ].join('\n');
    const { status, body } = await post('/api/admin/import/preview', { content: csv }, { 'x-role': 'admin' });
    assert.equal(status, 200);
    assert.equal(body.data.total, 2);
    assert.equal(body.data.importable, 1);
    assert.equal(body.data.invalid, 1);
    assert.ok(body.data.report.some((r) => r.errors.some((e) => e.includes('必填'))));
  });

  // --- JSON import error: malformed -> parse error ---
  await test('JSON import error: garbage input -> parse error 400', async () => {
    const { status, body } = await post('/api/admin/import/preview', { content: 'this is not json {' }, { 'x-role': 'admin' });
    assert.equal(status, 400);
    assert.ok(!body.ok);
  });

  // --- Demo / real isolation ---
  await test('Demo/real isolation: import forces is_demo=false; demo stays separate', () => {
    const c = importer.validateCandidate(
      importer.normalizeRow({ name: 'R', country: 'Singapore', city: 'Singapore', source_url: 'https://x.com/r', verified_status: 'draft' }),
      CTX
    );
    assert.equal(c.candidate.is_demo, false);
    const demo = require('../data/demo/schools.json').schools[0];
    assert.equal(demo.is_demo, true);
    assert.equal(demo.source_url, null);
  });

  // --- status transitions via review queue ---
  let createdId = null;
  await test('status transitions: draft->pending->verified visible on C-end; reject from pending works', async () => {
    const csv = 'name,country,city,source_url\n迁移测试真实校,Singapore,Singapore,https://x.com/t\n';
    const commit = await post('/api/admin/import/commit', { content: csv }, { 'x-role': 'admin' });
    assert.equal(commit.body.data.committed, 1);
    createdId = commit.body.data.committed_ids[0].id;
    const submit = await post(`/api/admin/queue/${createdId}/action`, { action: 'submit' }, { 'x-role': 'admin' });
    assert.equal(submit.body.data.status, 'pending');
    // reject is only valid from pending (verified must be expired first)
    const reject = await post(`/api/admin/queue/${createdId}/action`, { action: 'reject', note: '否决' }, { 'x-role': 'admin' });
    assert.equal(reject.body.data.status, 'rejected');
    // a fresh verified school surfaces on the C-end
    const csv2 = 'name,country,city,source_url\n迁移校B,Singapore,Singapore,https://x.com/tb\n';
    const c2 = await post('/api/admin/import/commit', { content: csv2 }, { 'x-role': 'admin' });
    const id2 = c2.body.data.committed_ids[0].id;
    await post(`/api/admin/queue/${id2}/action`, { action: 'submit' }, { 'x-role': 'admin' });
    const approve = await post(`/api/admin/queue/${id2}/action`, { action: 'approve' }, { 'x-role': 'admin' });
    assert.equal(approve.body.data.status, 'verified');
    const search = await get('/api/schools?q=' + encodeURIComponent('迁移校B'));
    assert.equal(search.body.meta.total, 1);
  });

  // --- expired status ---
  await test('expired status: admin expire from verified moves to expired', async () => {
    const csv = 'name,country,city,source_url\n过期测试校,Singapore,Singapore,https://x.com/e\n';
    const commit = await post('/api/admin/import/commit', { content: csv }, { 'x-role': 'admin' });
    const id = commit.body.data.committed_ids[0].id;
    await post(`/api/admin/queue/${id}/action`, { action: 'submit' }, { 'x-role': 'admin' });
    await post(`/api/admin/queue/${id}/action`, { action: 'approve' }, { 'x-role': 'admin' });
    const expire = await post(`/api/admin/queue/${id}/action`, { action: 'expire' }, { 'x-role': 'admin' });
    assert.equal(expire.body.data.status, 'expired');
    // C-end must not surface expired
    const data = store.load('imports');
    const rec = data.schools.find((s) => s.id === id);
    rec.verified_status = 'expired';
    store.save('imports', data);
    const search = await get('/api/schools?q=' + encodeURIComponent('过期测试校'));
    assert.equal(search.body.meta.total, 0);
  });

  // --- sensitive field re-review ---
  await test('sensitive re-review: editing tuition forces verified back to pending', async () => {
    const csv = 'name,country,city,source_url,tuition_min,tuition_max\n敏感测试校,Singapore,Singapore,https://x.com/s,100,200\n';
    const commit = await post('/api/admin/import/commit', { content: csv }, { 'x-role': 'admin' });
    const id = commit.body.data.committed_ids[0].id;
    await post(`/api/admin/queue/${id}/action`, { action: 'submit' }, { 'x-role': 'admin' });
    await post(`/api/admin/queue/${id}/action`, { action: 'approve' }, { 'x-role': 'admin' });
    const patch = await fetch(base + `/api/admin/schools/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-role': 'admin' },
      body: JSON.stringify({ fields: { tuition_min: 500 } }),
    });
    const pb = await patch.json();
    assert.equal(pb.data.re_review.to, 'pending');
  });

  // --- freshness config backend-configurable ---
  await test('freshness: review cycles configurable via admin API; no hardcode', async () => {
    const before = await get('/api/admin/config/review-cycles', { 'x-role': 'admin' });
    assert.ok(before.body.data.review_cycles_months.tuition);
    const putRes = await put('/api/admin/config/review-cycles', { review_cycles_months: { tuition: 3, deadlines: 2, scholarships: 2, basics: 6 } }, { 'x-role': 'admin' });
    assert.equal(putRes.body.data.review_cycles_months.tuition, 3);
    // invalid category rejected
    const bad = await put('/api/admin/config/review-cycles', { review_cycles_months: { nope: 5 } }, { 'x-role': 'admin' });
    assert.equal(bad.status, 400);
    // restore defaults
    await put('/api/admin/config/review-cycles', { review_cycles_months: { tuition: 6, deadlines: 4, scholarships: 4, basics: 12 } }, { 'x-role': 'admin' });
  });

  // --- freshness engine computes expired via effective_to ---
  await test('freshness engine: effective_to past => expired', () => {
    const school = { verified_status: 'verified', effective_to: '2020-01-01' };
    const f = freshness.computeFreshness(school, freshness.loadConfig());
    assert.equal(f.freshness, 'expired');
    const draft = freshness.computeFreshness({ verified_status: 'draft' }, freshness.loadConfig());
    assert.equal(draft, null);
  });

  // --- public correction entry ---
  await test('correction: public POST creates report; admin can list', async () => {
    const { status, body } = await post('/api/corrections', { school_id: 'SG-DEMO-001', type: 'wrong_fact', message: '学费有误' });
    assert.equal(status, 201);
    assert.equal(body.data.status, 'open');
    const list = await get('/api/admin/corrections', { 'x-role': 'admin' });
    assert.ok(list.body.data.some((c) => c.id === body.data.id));
    // missing message rejected
    const bad = await post('/api/corrections', { school_id: 'SG-DEMO-001', type: 'other' });
    assert.equal(bad.status, 400);
  });

  // cleanup imported test schools + corrections so the repo store stays pristine
  await test('cleanup: remove V1.0.1 test fixtures from store', () => {
    const data = store.load('imports');
    data.schools = data.schools.filter((s) => !['迁移测试真实校', '迁移校B', '过期测试校', '敏感测试校'].includes(s.name));
    store.save('imports', data);
    const q = store.load('queue');
    q.items = q.items.filter((i) => {
      const s = data.schools.find((x) => x.id === i.school_id);
      return Boolean(s);
    });
    store.save('queue', q);
    const corr = store.load('corrections');
    corr.items = [];
    store.save('corrections', corr);
    assert.ok(true);
  });

  await new Promise((resolve) => server.close(resolve));
  console.log('\n' + passed.length + ' passed, ' + failed.length + ' failed');
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('test runner crashed:', err);
  process.exitCode = 1;
});
