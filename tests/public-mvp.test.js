const assert = require('node:assert/strict');
const { app } = require('../server-public');

async function run() {
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
      assert.equal(body.data.service, 'globalstudy-world-mvp');
      assert.equal(body.data.audience, 'public');
    }

    {
      const { res, body } = await get('/api/reference');
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.ok(Array.isArray(body.data.countries));
      assert.ok(Array.isArray(body.data.stages));
      assert.ok(Array.isArray(body.data.curricula));
    }

    {
      const { res, body } = await get('/api/schools?pageSize=5');
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
    }

    {
      const { body } = await get('/api/schools?pageSize=2');
      const id = body.data[0].id;
      const detail = await get('/api/schools/' + encodeURIComponent(id));
      assert.equal(detail.res.status, 200);
      assert.equal(detail.body.ok, true);
      assert.ok(detail.body.data.source);
      assert.ok(Array.isArray(detail.body.data.programs));
      assert.ok(Array.isArray(detail.body.data.campuses));
    }

    {
      const { body } = await get('/api/schools?pageSize=4');
      const ids = body.data.map((x) => x.id).join(',');
      const cmp = await get('/api/compare?ids=' + encodeURIComponent(ids));
      assert.equal(cmp.res.status, 200);
      assert.equal(cmp.body.ok, true);
      assert.ok(cmp.body.data.length <= 4);
    }

    for (const path of ['/api/growth/leads', '/api/admin/import/preview', '/api/b2b/schools']) {
      const { res, body } = await get(path);
      assert.equal(res.status, 404);
      assert.equal(body.ok, false);
    }

    {
      const { res, body } = await get('/');
      assert.equal(res.status, 200);
      assert.match(body, /请选择要打开的客户端/);
      assert.match(body, /English/);
      assert.match(body, /<html lang="zh-CN">/);
      assert.match(body, /student\.html/);
      assert.match(body, /agent\.html/);
      assert.match(body, /institution\.html/);
      assert.doesNotMatch(body, /Growth Center/);
      assert.doesNotMatch(body, /线索池/);
    }

    for (const [path, marker] of [
      ['/student.html', /学生 \/ 家长端/],
      ['/agent.html', /留学机构端/],
      ['/institution.html', /院校 \/ 供应商端/]
    ]) {
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

    console.log('Public MVP tests passed');
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
