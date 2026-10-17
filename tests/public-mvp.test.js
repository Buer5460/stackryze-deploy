const assert = require('node:assert/strict');
// V3: the public MVP surface is served by api-server.js. server-public.js is
// kept as the legacy V1 public shell and is still smoke-tested by the CI job.
const { app, boot } = require('../api-server');

async function run() {
  // Seed the demo dataset exactly as production boot does.
  await boot();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;

  async function get(path, opts) {
    const res = await fetch(base + path, opts);
    let body;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) body = await res.json();
    else body = await res.text();
    return { res, body };
  }

  try {
    {
      const { res, body } = await get('/api/health');
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.data.service, 'aethel-edu-globalstudy');
      assert.equal(body.data.audience, 'public');
    }

    {
      const { res, body } = await get('/api/reference');
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      // V3 reference exposes the state machine, roles, supplier types and the
      // document taxonomy instead of the V1 location dictionaries.
      assert.ok(Array.isArray(body.data.stages));
      assert.equal(body.data.stages.length, 11);
      assert.ok(Array.isArray(body.data.supplier_types));
      assert.ok(Array.isArray(body.data.roles));
      assert.ok(Array.isArray(body.data.document_types));
      // Legacy location dictionaries are still reachable through the V1 server.
    }

    // V3 public school search lives under /api/public/schools and keeps the
    // same payload contract (name/verification, no B2B or internal fields).
    {
      const { res, body } = await get('/api/public/schools?pageSize=5');
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.ok(body.data.length > 0);
      assert.ok(body.data.length <= 5);
      const school = body.data[0];
      assert.ok(school.name && school.name.en);
      assert.ok(school.verification);
      assert.equal('agency' in school, false);
      assert.equal('commission' in school, false);
      assert.equal('lead_attribution' in school, false);
      // No private supplier channels ever reach the public payload.
      assert.equal('contact_phone' in school, false);
    }

    {
      const { body } = await get('/api/public/schools?pageSize=2');
      const id = body.data[0].id;
      const detail = await get('/api/public/suppliers/' + encodeURIComponent(id));
      // A school id is not a supplier id; the supplier route must 404 cleanly.
      assert.equal(detail.res.status, 404);
      assert.equal(detail.body.ok, false);
    }

    {
      const { body } = await get('/api/public/suppliers?pageSize=4');
      assert.equal(body.ok, true);
      assert.ok(body.data.length > 0);
      const first = body.data[0];
      assert.equal('commission' in first, false);
      assert.equal('contact_phone' in (first.profile || {}), false);
      assert.equal('contact_email' in (first.profile || {}), false);
      assert.equal('contact_whatsapp' in (first.profile || {}), false);
    }

    // Removed V1/V1.1 routes must be gone entirely (404), while internal V3
    // routes exist but require authentication (401) — never publicly readable.
    for (const path of ['/api/growth/leads', '/api/growth/dashboard']) {
      const { res, body } = await get(path);
      assert.equal(res.status, 404, path);
      assert.equal(body.ok, false);
    }
    for (const path of ['/api/admin/import/preview', '/api/admin/dashboard', '/api/b/me', '/api/c/me']) {
      const { res, body } = await get(path);
      assert.equal(res.status, 401, path);
      assert.equal(body.ok, false);
    }
    // V1 B2B routes were removed with the V1 server.
    for (const path of ['/api/b2b/schools', '/api/b2b/programs']) {
      const { res, body } = await get(path);
      assert.equal(res.status, 404, path);
      assert.equal(body.ok, false);
    }

    {
      const { res, body } = await get('/');
      assert.equal(res.status, 200);
      assert.match(body, /请选择要打开的客户端/);
      assert.match(body, /English/);
      assert.match(body, /<html lang="zh-CN">/);
      // V3 links clean client routes; the legacy .html aliases still resolve.
      assert.match(body, /\/student/);
      assert.match(body, /\/agent/);
      assert.match(body, /\/institution/);
      assert.doesNotMatch(body, /Growth Center/);
      assert.doesNotMatch(body, /线索池/);
    }

    for (const [path, marker] of [
      ['/student.html', /学生 \/ 家长端/],
      ['/agent.html', /留学机构端/],
      ['/institution.html', /院校 \/ 供应商端/]
    ]) {
      // Both the legacy .html alias and the clean route must serve the shell.
      const { res, body } = await get(path);
      assert.equal(res.status, 200);
      assert.match(body, marker);
      assert.match(body, /app\.css/);
      assert.match(body, /English/);
      assert.match(body, /<html lang="zh-CN">/);
      assert.doesNotMatch(body, /Growth Center/);
      assert.doesNotMatch(body, /线索池/);
      const scripts = [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)];
      assert.ok(scripts.length > 0, path + ' inline script must exist');
      for (const s of scripts) assert.doesNotThrow(() => new Function(s[1]), path + ' inline script must parse');
    }

    // V3 clean routes serve the same shells as the .html aliases.
    for (const [path, marker] of [
      ['/student', /学生 \/ 家长端/],
      ['/agent', /留学机构端/],
      ['/institution', /院校 \/ 供应商端/],
      ['/dbc', /DBC/],
      ['/supplier/education', /教育机构/],
      ['/supplier/medical', /体检机构/],
      ['/supplier/certification', /文件认证/],
      ['/supplier/visa', /签证代办/],
      ['/supplier/accommodation', /学生住宿/],
      ['/supplier/finance', /功能暂未开放/],
      ['/ads', /广告中心/],
      ['/admin', /平台管理端/]
    ]) {
      const { res, body } = await get(path);
      assert.equal(res.status, 200, path);
      assert.match(body, marker, path);
      assert.match(body, /Powered by Aethel Edu|由安世达教育提供核心动力/, path + ' must carry the operator credit');
    }

    console.log('Public MVP tests passed');
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
