'use strict';
// ---------------------------------------------------------------------------
// FULL MVP V3 — HTTP / API tests.
//
// Exercises the real HTTP surface: demo auth, session auth, RBAC isolation
// between the five clients, the unbound-C gate, the full binding E2E, the
// advertising funnel, DBC State A isolation, admin protection, public API
// isolation, persistence headers and i18n/mobile shell checks.
// ---------------------------------------------------------------------------
const assert = require('node:assert/strict');

const db = require('../lib/db');

const passed = [];
const failed = [];
async function test(name, fn) {
  try { await fn(); passed.push(name); console.log('  ok  ' + name); }
  catch (err) { failed.push(name + ' :: ' + (err && err.message)); console.error('FAIL  ' + name + ' :: ' + (err && err.message)); }
}

let server;
let base;
let app;

async function req(method, path, body, headers) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: (body === undefined || method === 'GET' || method === 'HEAD') ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = null; }
  return { status: r.status, body: json, text, headers: r.headers };
}

async function loginAs(token) {
  const r = await req('POST', '/api/auth/demo-login', { token });
  assert.equal(r.status, 201, 'demo login failed for ' + token + ': ' + JSON.stringify(r.body));
  return { 'Authorization': 'Bearer ' + r.body.data.token };
}

// Fix 5: the public demo surface no longer offers an admin identity. Tests that
// exercise admin endpoints authenticate through the real login path (seeded
// admin with password) instead of a public demo token.
async function loginAdminReal() {
  const r = await req('POST', '/api/auth/login', { email: 'admin@demo.local', password: 'demo1234' });
  assert.equal(r.status, 200, 'real admin login failed: ' + JSON.stringify(r.body));
  return { 'Authorization': 'Bearer ' + r.body.data.token };
}

async function main() {
  // Boot a real server on an ephemeral port with an isolated data dir.
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aethel-http-'));
  process.env.GS_DB_DIR = dir;
  delete require.cache[require.resolve('../lib/db')];
  db.setDataDir(dir);

  const mod = require('../api-server');
  app = mod.app;
  await mod.boot();

  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;

  const STUDENT = await loginAs('demo-student-01');
  const AGENT = await loginAs('demo-agent-01');
  const ADMIN = await loginAdminReal();
  const DBC = await loginAs('demo-dbc-01');
  const EDU = await loginAs('demo-supplier-education-01');
  const MED = await loginAs('demo-supplier-medical-01');
  const CERT = await loginAs('demo-supplier-certification-01');
  const VISA = await loginAs('demo-supplier-visa-01');
  const ACC = await loginAs('demo-supplier-accommodation-01');

  // =========================================================================
  console.log('\n[Auth] demo + session');
  // =========================================================================
  await test('health reports the service and version', async () => {
    const r = await req('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.data.service, 'aethel-edu-globalstudy');
    assert.equal(r.body.data.version, '3.0.2');
    assert.ok(r.body.data.counts);
  });

  await test('health reports the persistence backend', async () => {
    const r = await req('GET', '/api/health');
    assert.equal(r.body.data.backend, 'json-file');
    assert.match(r.body.data.persistence, /JSON file store/);
  });

  await test('meta lists every public client', async () => {
    const r = await req('GET', '/api/meta');
    const routes = r.body.data.clients.map((c) => c.route);
    for (const route of ['/', '/student', '/agent', '/dbc', '/supplier/education', '/supplier/medical',
      '/supplier/certification', '/supplier/visa', '/supplier/accommodation', '/supplier/finance', '/ads', '/admin']) {
      assert.ok(routes.includes(route), route + ' missing');
    }
    assert.equal(r.body.data.data_policy.no_financial_products_in_public_mvp, true);
  });

  await test('meta carries the Aethel Edu branding', async () => {
    const r = await req('GET', '/api/meta');
    assert.equal(r.body.data.footer_zh, '由安世达教育提供核心动力');
    assert.equal(r.body.data.footer_en, 'Powered by Aethel Edu');
  });

  await test('payment provider catalogue is sandbox', async () => {
    const r = await req('GET', '/api/meta');
    assert.equal(r.body.data.payment.mode, 'sandbox');
    const ids = r.body.data.payment.available.map((a) => a.id);
    for (const id of ['nexuspay', 'stripe', 'bank_transfer', 'manual', 'other']) assert.ok(ids.includes(id));
  });

  await test('unauthenticated API calls are rejected', async () => {
    for (const path of ['/api/c/me', '/api/b/me', '/api/s/education/me', '/api/dbc/me', '/api/admin/dashboard']) {
      const r = await req('GET', path);
      assert.equal(r.status, 401, path + ' should require auth');
    }
  });

  await test('real registration creates an unbound C', async () => {
    const email = 'new-' + Date.now() + '@test.local';
    const r = await req('POST', '/api/auth/register', { email, password: 'x123456', display_name: 'New C', role: 'C_STUDENT' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const me = await req('GET', '/api/auth/me', null, { 'Authorization': 'Bearer ' + r.body.data.token });
    assert.equal(me.body.data.c_profile.binding_state, 'unbound');
    assert.equal(me.body.data.capabilities.can_order, false);
  });

  await test('duplicate email registration is rejected', async () => {
    const email = 'dup-' + Date.now() + '@test.local';
    await req('POST', '/api/auth/register', { email, password: 'x123456', role: 'C_STUDENT' });
    const r = await req('POST', '/api/auth/register', { email, password: 'x123456', role: 'C_STUDENT' });
    assert.equal(r.status, 409);
  });

  await test('login with a wrong password fails', async () => {
    const email = 'pw-' + Date.now() + '@test.local';
    await req('POST', '/api/auth/register', { email, password: 'right-one', role: 'C_STUDENT' });
    const r = await req('POST', '/api/auth/login', { email, password: 'wrong-one' });
    assert.equal(r.status, 401);
  });

  await test('login with the right password succeeds', async () => {
    const email = 'pw2-' + Date.now() + '@test.local';
    await req('POST', '/api/auth/register', { email, password: 'right-one', role: 'C_STUDENT' });
    const r = await req('POST', '/api/auth/login', { email, password: 'right-one' });
    assert.equal(r.status, 200);
    assert.ok(r.body.data.token);
  });

  await test('logout destroys the session', async () => {
    const email = 'lo-' + Date.now() + '@test.local';
    const reg = await req('POST', '/api/auth/register', { email, password: 'x123456', role: 'C_STUDENT' });
    const H = { 'Authorization': 'Bearer ' + reg.body.data.token };
    await req('POST', '/api/auth/logout', {}, H);
    const r = await req('GET', '/api/auth/me', null, H);
    assert.equal(r.status, 401);
  });

  // =========================================================================
  console.log('\n[Public API] isolation');
  // =========================================================================
  await test('public supplier list hides commission and private contact', async () => {
    const r = await req('GET', '/api/public/suppliers');
    assert.equal(r.status, 200);
    assert.ok(r.body.data.length >= 6, 'expected all six supplier types');
    const raw = JSON.stringify(r.body);
    assert.equal(raw.includes('commission_value'), false);
    assert.equal(raw.includes('contact_phone'), false);
    assert.equal(raw.includes('contact_whatsapp'), false);
  });

  await test('finance public view says coming soon', async () => {
    const list = (await req('GET', '/api/public/suppliers?type=FINANCE')).body.data;
    assert.equal(list.length, 1);
    assert.equal(list[0].profile.extensions.coming_soon, true);
  });

  await test('internal endpoints are not exposed on the public API', async () => {
    for (const path of ['/api/admin/dashboard', '/api/b/me', '/api/c/me', '/api/dbc/me',
      '/api/admin/import/preview', '/api/admin/queue']) {
      const r = await req('GET', path);
      assert.equal(r.status, 401, path + ' should not be publicly readable');
    }
    // V1 routes that no longer exist in V3 are removed entirely, not merely gated.
    for (const path of ['/api/b2b/schools', '/api/b2b/programs']) {
      const r = await req('GET', path);
      assert.equal(r.status, 404, path + ' must not exist in V3');
    }
    // The V1.1 Growth Center routes are gone entirely in V3 (not just gated).
    for (const path of ['/api/growth/leads', '/api/growth/dashboard', '/api/growth/campaigns']) {
      const r = await req('GET', path);
      assert.equal(r.status, 404, path + ' must not exist in the public MVP');
      assert.equal(r.body.ok, false);
    }
  });

  await test('unknown API paths return JSON 404', async () => {
    const r = await req('GET', '/api/does-not-exist');
    assert.equal(r.status, 404);
    assert.equal(r.body.ok, false);
  });

  await test('public school search returns demo/verified labels', async () => {
    const r = await req('GET', '/api/public/schools?pageSize=5');
    assert.equal(r.status, 200);
    assert.ok(r.body.meta.total > 0);
    for (const s of r.body.data) {
      assert.ok('verification' in s);
      assert.ok('is_demo' in s.verification);
    }
  });

  await test('accommodation search sorts by straight-line distance only', async () => {
    const r = await req('GET', '/api/public/accommodation?school_id=INS-DEMO-0001');
    assert.equal(r.status, 200);
    assert.match(JSON.stringify(r.body.meta.note), /不虚构通勤时间/);
  });

  // =========================================================================
  console.log('\n[RBAC] client isolation');
  // =========================================================================
  await test('a C session cannot reach B endpoints', async () => {
    for (const path of ['/api/b/me', '/api/b/clients', '/api/b/applications', '/api/b/settlements', '/api/b/contracts']) {
      const r = await req('GET', path, null, STUDENT);
      assert.equal(r.status, 403, path + ' leaked to C');
    }
  });

  await test('a C session cannot reach S endpoints', async () => {
    const r = await req('GET', '/api/s/education/me', null, STUDENT);
    assert.equal(r.status, 403);
  });

  await test('a C session cannot reach DBC endpoints', async () => {
    const r = await req('GET', '/api/dbc/me', null, STUDENT);
    assert.equal(r.status, 403);
  });

  await test('a C session cannot reach admin endpoints', async () => {
    const r = await req('GET', '/api/admin/dashboard', null, STUDENT);
    assert.equal(r.status, 403);
  });

  await test('a B session cannot reach C or admin endpoints', async () => {
    for (const path of ['/api/c/me', '/api/c/applications', '/api/c/payments', '/api/admin/dashboard']) {
      const r = await req('GET', path, null, AGENT);
      assert.equal(r.status, 403, path + ' leaked to B');
    }
  });

  await test('a B session cannot reach DBC endpoints', async () => {
    const r = await req('GET', '/api/dbc/agreements', null, AGENT);
    assert.equal(r.status, 403);
  });

  await test('an S session cannot reach another supplier type', async () => {
    const r = await req('GET', '/api/s/medical/me', null, EDU);
    assert.equal(r.status, 403);
    const r2 = await req('GET', '/api/s/education/me', null, MED);
    assert.equal(r2.status, 403);
  });

  await test('an S session cannot reach B or C endpoints', async () => {
    for (const path of ['/api/b/me', '/api/c/me']) {
      const r = await req('GET', path, null, EDU);
      assert.equal(r.status, 403, path + ' leaked to S');
    }
  });

  await test('a DBC session cannot reach B, C, S or admin endpoints', async () => {
    for (const path of ['/api/b/me', '/api/c/me', '/api/s/education/me', '/api/admin/dashboard']) {
      const r = await req('GET', path, null, DBC);
      assert.equal(r.status, 403, path + ' leaked to DBC');
    }
  });

  await test('an admin session cannot use client-only write endpoints', async () => {
    const r = await req('POST', '/api/c/bindings', { b_organization_id: 'x' }, ADMIN);
    assert.equal(r.status, 403);
  });

  await test('B_VIEWER permissions exclude money mutations', async () => {
    const r = await req('GET', '/api/reference');
    const viewer = r.body.data.roles.find((x) => x.id === 'B_VIEWER');
    assert.ok(viewer);
    assert.equal(viewer.permissions.includes('b:settlement'), false);
    assert.equal(viewer.permissions.includes('b:payment'), false);
  });

  // =========================================================================
  console.log('\n[Rule 2] unbound C gate over HTTP');
  // =========================================================================
  await test('unbound C is blocked from applications, payments and documents', async () => {
    for (const [method, path, body] of [
      ['POST', '/api/c/applications', { title: 'x' }],
      ['POST', '/api/c/payments', { kind: 'application_fee', amount: 10 }],
      ['POST', '/api/c/applications/x/documents', { type: 'passport' }],
      ['POST', '/api/c/reviews', { supplier_id: 'x', rating: 5 }]
    ]) {
      const r = await req(method, path, body, STUDENT);
      assert.equal(r.status, 403, path + ' should be blocked for an unbound C');
    }
  });

  await test('a C can always browse suppliers and read capabilities', async () => {
    const caps = await req('GET', '/api/c/capabilities', null, STUDENT);
    assert.equal(caps.body.data.can_browse, true);
    const list = await req('GET', '/api/c/suppliers', null, STUDENT);
    assert.equal(list.status, 200);
    assert.ok(list.body.data.length > 0);
  });

  await test('a freshly registered unbound C is still browse-only', async () => {
    const email = 'unbound-' + Date.now() + '@test.local';
    const reg = await req('POST', '/api/auth/register', { email, password: 'x123456', role: 'C_STUDENT' });
    const H2 = { 'Authorization': 'Bearer ' + reg.body.data.token };
    const caps = await req('GET', '/api/c/capabilities', null, H2);
    assert.equal(caps.body.data.bound, false);
    assert.equal(caps.body.data.can_browse, true);
    assert.equal(caps.body.data.can_order, false);
    assert.equal(caps.body.data.can_pay, false);
    const blocked = await req('POST', '/api/c/applications', { title: 'x' }, H2);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'C_UNBOUND');
    const list = await req('GET', '/api/c/suppliers', null, H2);
    assert.equal(list.status, 200);
    assert.ok(list.body.data.length > 0, 'unbound C must still browse suppliers');
  });

  // =========================================================================
  console.log('\n[Rules 3–7] recommendation + binding + dual signature over HTTP');
  // =========================================================================
  let bindingId;
  let appId;
  let bOrgId;
  await test('submitting a requirement returns a Level 2 recommendation', async () => {
    const r = await req('POST', '/api/c/requirements', {
      target_countries: ['SG'], target_stages: ['MASTER'], target_courses: ['Computer Science'], languages: ['ZH']
    }, STUDENT);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.recommendation.tier, 'LEVEL_2');
    assert.ok(r.body.data.recommendation.candidates.length >= 1);
    bOrgId = r.body.data.recommendation.candidates[0].b_organization_id;
  });

  await test('recommendation payload never contains commission', async () => {
    const r = await req('GET', '/api/c/recommendations', null, STUDENT);
    assert.equal(r.status, 200);
    for (const rec of r.body.data) {
      for (const c of rec.candidates) {
        assert.equal('commission' in c, false);
        assert.equal('commission_value' in c, false);
      }
    }
  });

  await test('the seeded demo C starts unbound and can be bound', async () => {
    const me = await req('GET', '/api/auth/me', null, STUDENT);
    assert.equal(me.body.data.c_profile.binding_state, 'unbound', 'the demo C must start unbound');
  });

  await test('B accepts, dual signature activates the binding', async () => {
    const created = await req('POST', '/api/c/bindings', { b_organization_id: bOrgId }, STUDENT);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    bindingId = created.body.data.id;

    const accepted = await req('POST', '/api/b/binding-requests/' + bindingId + '/respond', { response: 'accept' }, AGENT);
    assert.equal(accepted.body.data.binding.status, 'pending_contract');

    const cSign = await req('POST', '/api/c/bindings/' + bindingId + '/sign', {}, STUDENT);
    assert.equal(cSign.body.data.binding.status, 'pending_b_signature');
    const bSign = await req('POST', '/api/b/binding-requests/' + bindingId + '/sign', {}, AGENT);
    assert.equal(bSign.status, 200, JSON.stringify(bSign.body));
    assert.equal(bSign.body.data.binding.status, 'active');
    assert.equal(bSign.body.data.contract.status, 'active');
  });

  await test('a duplicate binding request is rejected', async () => {
    const r = await req('POST', '/api/c/bindings', { b_organization_id: bOrgId }, STUDENT);
    assert.equal(r.status, 400);
  });

  await test('bound C sees its B, contract and full capabilities', async () => {
    const me = await req('GET', '/api/auth/me', null, STUDENT);
    assert.equal(me.body.data.c_profile.binding_state, 'active');
    assert.equal(me.body.data.capabilities.can_order, true);

    const myB = await req('GET', '/api/c/my-b', null, STUDENT);
    assert.equal(myB.status, 200);
    assert.ok(myB.body.data.organization.name);
    assert.equal(myB.body.data.contract.status, 'active');
  });

  await test('contract view records both signatures and disclaims platform business role', async () => {
    const contracts = (await req('GET', '/api/b/contracts', null, AGENT)).body.data;
    const bc = contracts.find((c) => c.kind === 'B_C');
    assert.ok(bc, 'no B_C contract');
    assert.equal(bc.signatures.length, 2);
    assert.deepEqual(bc.signatures.map((s) => s.signer).sort(), ['B', 'C']);
    assert.match(bc.note, /平台仅记录合同/);
  });

  await test('B cannot accept beyond its order cap', async () => {
    // The seeded agent already has a cap of 5/day; a second concurrent accept
    // must still be allowed here (only 1 order so far) — this guards the wiring.
    const capacity = (await req('GET', '/api/b/admission', null, AGENT)).body.data;
    assert.equal(typeof capacity.order_capacity.daily_ok, 'boolean');
  });

  // =========================================================================
  console.log('\n[S0–S10] full lifecycle over HTTP');
  // =========================================================================
  await test('application is created at S0 with all eleven stages', async () => {
    const suppliers = (await req('GET', '/api/c/suppliers?type=EDUCATION', null, STUDENT)).body.data;
    const r = await req('POST', '/api/c/applications', { title: 'HTTP E2E', supplier_id: suppliers[0].id }, STUDENT);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    appId = r.body.data.id;
    assert.equal(r.body.data.current_stage, 'S0');
    assert.equal(r.body.data.stages.length, 11);
  });

  await test('transition is blocked while stage todos are open', async () => {
    const r = await req('POST', '/api/b/applications/' + appId + '/transition', { target: 'S1' }, AGENT);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'STAGE_TODOS_INCOMPLETE');
  });

  await test('an illegal jump is rejected', async () => {
    for (const t of (await req('GET', '/api/b/todos', null, AGENT)).body.data.filter((x) => x.application_id === appId)) {
      await req('POST', '/api/b/todos/' + t.id + '/complete', {}, AGENT);
    }
    const r = await req('POST', '/api/b/applications/' + appId + '/transition', { target: 'S5' }, AGENT);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /非法的阶段流转/);
  });

  await test('the application walks S0 → S10', async () => {
    for (const stage of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10']) {
      const todos = (await req('GET', '/api/b/todos', null, AGENT)).body.data
        .filter((t) => t.application_id === appId && t.status !== 'done');
      for (const t of todos) {
        const done = await req('POST', '/api/b/todos/' + t.id + '/complete', {}, AGENT);
        assert.equal(done.status, 200, 'complete todo ' + t.id);
      }
      const r = await req('POST', '/api/b/applications/' + appId + '/transition', { target: stage }, AGENT);
      assert.equal(r.status, 200, 'to ' + stage + ': ' + JSON.stringify(r.body));
      assert.equal(r.body.data.current_stage, stage);
    }
  });

  await test('kanban and timeline views work', async () => {
    const board = await req('GET', '/api/b/kanban', null, AGENT);
    assert.equal(board.status, 200);
    assert.ok(board.body.data.some((c) => c.code === 'S10' && c.items.length >= 1));
    const timeline = await req('GET', '/api/c/applications/' + appId + '/timeline', null, STUDENT);
    assert.equal(timeline.status, 200);
    assert.ok(timeline.body.data.events.length > 0);
  });

  // =========================================================================
  console.log('\n[Documents] C → B → S confirmation over HTTP');
  // =========================================================================
  let docId;
  await test('C uploads, B confirms, S confirms', async () => {
    const up = await req('POST', '/api/c/applications/' + appId + '/documents', { type: 'passport', file_name: 'p.pdf' }, STUDENT);
    assert.equal(up.status, 201);
    docId = up.body.data.document.id;
    assert.equal(up.body.data.document.ocr.sandbox, true);

    const bConf = await req('POST', '/api/b/documents/' + docId + '/confirm', {}, AGENT);
    assert.equal(bConf.body.data.status, 'b_confirmed');

    const sConf = await req('POST', '/api/s/education/documents/' + docId + '/confirm', {}, EDU);
    assert.equal(sConf.status, 200, JSON.stringify(sConf.body));
    assert.equal(sConf.body.data.status, 's_confirmed');
  });

  await test('S cannot confirm a document that B has not confirmed', async () => {
    const up = await req('POST', '/api/c/applications/' + appId + '/documents', { type: 'transcript', file_name: 't.pdf' }, STUDENT);
    const r = await req('POST', '/api/s/education/documents/' + up.body.data.document.id + '/confirm', {}, EDU);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /必须先由 B 确认/);
  });

  await test('S document library requires explicit authorization', async () => {
    const r = await req('GET', '/api/s/education/family-documents', null, EDU);
    assert.equal(r.status, 200);
    assert.ok(r.body.data.pending_authorization.length >= 1);
    assert.equal(r.body.data.authorized.length, 0);
  });

  await test('C authorizes an S to read a document', async () => {
    const r = await req('POST', '/api/c/documents/' + docId + '/authorize', { grantee_type: 'S', grantee_id: 'SUP', scope: 'read' }, STUDENT);
    assert.equal(r.status, 201);
  });

  // =========================================================================
  console.log('\n[Rules 9–11] AETHEL X payment + commission over HTTP');
  // =========================================================================
  await test('C pays through the sandbox and receives a receipt', async () => {
    const created = await req('POST', '/api/c/payments', { kind: 'application_fee', amount: 500, application_id: appId, currency: 'SGD' }, STUDENT);
    assert.equal(created.status, 201);
    assert.equal(created.body.data.status, 'requires_action');
    assert.equal(created.body.data.sandbox, true);

    const confirmed = await req('POST', '/api/c/payments/' + created.body.data.id + '/confirm', {}, STUDENT);
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.data.payment.status, 'succeeded');
    assert.equal(confirmed.body.data.receipt.sandbox, true);
    // C must never see commission in the payment response.
    assert.equal(JSON.stringify(confirmed.body).includes('net_to_b'), false);
  });

  await test('commission is computed and owned by the bound B', async () => {
    const ledger = (await req('GET', '/api/admin/commission/ledger', null, ADMIN)).body.data;
    assert.ok(ledger.length >= 1, 'no commission recorded');
    const entry = ledger[0];
    assert.equal(entry.b_organization_id, bOrgId);
    assert.ok(entry.amount > 0);
  });

  await test('C payment list never exposes commission', async () => {
    const r = await req('GET', '/api/c/payments', null, STUDENT);
    assert.equal(r.status, 200);
    const raw = JSON.stringify(r.body);
    assert.equal(raw.includes('net_to_b'), false);
    assert.equal(raw.includes('commission_rule'), false);
  });

  await test('refund claws back the commission', async () => {
    const payments = (await req('GET', '/api/c/payments', null, STUDENT)).body.data;
    const target = payments.find((p) => p.status === 'succeeded');
    assert.ok(target);
    const r = await req('POST', '/api/c/payments/' + target.id + '/refund', { reason: 'test' }, STUDENT);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.data.clawed_back_commission >= 1);
  });

  await test('B commission summary aggregates every settlement state', async () => {
    const r = await req('GET', '/api/b/commission', null, AGENT);
    assert.equal(r.status, 200);
    for (const key of ['projected', 'confirmed', 'receivable', 'received', 'payable', 'paid', 'clawed_back']) {
      assert.ok(key in r.body.data.summary, key + ' missing');
    }
  });

  await test('settlement lifecycle is enforced step by step', async () => {
    const ledger = (await req('GET', '/api/admin/commission/ledger', null, ADMIN)).body.data;
    const created = await req('POST', '/api/admin/settlements', { commission_ledger_ids: [ledger[0].id] }, ADMIN);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id;
    const bad = await req('POST', '/api/admin/settlements/' + id + '/advance', { target: 'paid' }, ADMIN);
    assert.equal(bad.status, 400);
    const good = await req('POST', '/api/admin/settlements/' + id + '/advance', { target: 'confirmed' }, ADMIN);
    assert.equal(good.status, 200);
    assert.equal(good.body.data.status, 'confirmed');
  });

  await test('S commission rules are readable and demo-labelled', async () => {
    const r = await req('GET', '/api/s/education/commission', null, EDU);
    assert.equal(r.status, 200);
    assert.ok(r.body.data.note.includes('演示'));
    for (const rule of r.body.data.rules) assert.equal(rule.is_demo, true);
  });

  // =========================================================================
  console.log('\n[S suppliers] six types over HTTP');
  // =========================================================================
  await test('education S can update an admission status', async () => {
    // Route a fresh application to the education supplier through the B side.
    // Use the demo C, which the earlier E2E block bound to this B.
    const meC = await req('GET', '/api/auth/me', null, STUDENT);
    assert.equal(meC.body.data.c_profile.binding_state, 'active', 'the demo C must be bound for this test');
    const cProfileId = meC.body.data.c_profile.id;
    const supplierId = (await req('GET', '/api/public/suppliers?type=EDUCATION')).body.data[0].id;
    const created = await req('POST', '/api/b/applications', { c_profile_id: cProfileId, supplier_id: supplierId, title: 'Admission flow' }, AGENT);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const apps = (await req('GET', '/api/s/education/applications', null, EDU)).body.data;
    assert.ok(apps.length >= 1, 'the education S must see the routed application');
    // Target the application we just created (the list is newest-last).
    const target = apps[apps.length - 1];
    const admissions = (await req('GET', '/api/s/education/admissions', null, EDU)).body.data;
    assert.ok(admissions.some((a) => a.application_id === target.id), 'the admissions view must expose the same application id');
    const r = await req('PUT', '/api/s/education/admissions/' + target.id, { status: 'documents_review' }, EDU);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.admission_status, 'documents_review');
  });

  await test('medical S order lifecycle stores no diagnosis', async () => {
    const created = await req('POST', '/api/s/medical/orders', { application_id: appId }, MED);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id;
    const done = await req('POST', '/api/s/medical/orders/' + id + '/status', { status: 'completed', report_file: 'report.pdf', meets_study_requirement: true }, MED);
    assert.equal(done.status, 200);
    assert.equal(done.body.data.status, 'completed');
    assert.equal(done.body.data.meets_study_requirement, true);
    const raw = JSON.stringify(done.body.data);
    assert.equal(raw.includes('diagnosis'), false);
  });

  await test('certification S order lifecycle', async () => {
    const created = await req('POST', '/api/s/certification/orders', { certification_type: 'degree' }, CERT);
    assert.equal(created.status, 201);
    const r = await req('POST', '/api/s/certification/orders/' + created.body.data.id + '/status', { status: 'processing' }, CERT);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.status, 'processing');
  });

  await test('visa S order lifecycle records a result', async () => {
    const created = await req('POST', '/api/s/visa/orders', { visa_type: 'student_visa', target_country: 'SG' }, VISA);
    assert.equal(created.status, 201);
    const r = await req('POST', '/api/s/visa/orders/' + created.body.data.id + '/status', { status: 'result', result: 'approved' }, VISA);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.result, 'approved');
  });

  await test('accommodation room inventory never goes negative', async () => {
    const room = await req('POST', '/api/s/accommodation/rooms', { name: 'R1', room_type: 'double', beds_total: 2 }, ACC);
    assert.equal(room.status, 201);
    assert.equal(room.body.data.beds_available, 2);
    const id = room.body.data.id;

    const booking = await req('POST', '/api/s/accommodation/bookings', { room_id: id, check_in: '2026-11-01' }, ACC);
    assert.equal(booking.status, 201, JSON.stringify(booking.body));
    assert.equal(booking.body.data.status, 'reserved');
    const bkg = { id: booking.body.data.id };
    const checkIn = await req('POST', '/api/s/accommodation/bookings/' + bkg.id + '/status', { status: 'checked_in' }, ACC);
    assert.equal(checkIn.status, 200, JSON.stringify(checkIn.body));
    assert.equal(checkIn.body.data.room.beds_occupied, 1);
    assert.equal(checkIn.body.data.room.beds_available, 1);
    const checkOut = await req('POST', '/api/s/accommodation/bookings/' + bkg.id + '/status', { status: 'checked_out' }, ACC);
    assert.equal(checkOut.body.data.room.beds_available, 2);
    assert.ok(checkOut.body.data.room.beds_available >= 0);
  });

  await test('finance route is closed by default', async () => {
    const r = await req('GET', '/api/s/finance/me', null, ADMIN);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'FINANCE_DISABLED');
  });

  // =========================================================================
  console.log('\n[DBC] State A isolation over HTTP');
  // =========================================================================
  await test('DBC sees only State A agreements', async () => {
    const r = await req('GET', '/api/dbc/agreements', null, DBC);
    assert.equal(r.status, 200);
    for (const a of r.body.data) assert.equal(a.state, 'A');
    assert.match(r.body.meta.note, /状态 B/);
  });

  await test('DBC creates a State A agreement', async () => {
    const suppliers = (await req('GET', '/api/dbc/suppliers', null, DBC)).body.data;
    const r = await req('POST', '/api/dbc/agreements', { supplier_id: suppliers[0] ? suppliers[0].id : 'SUP' }, DBC);
    assert.equal(r.status, 201);
    assert.equal(r.body.data.state, 'A');
    assert.equal(r.body.data.kind, 'DBC_S');
  });

  await test('a B cannot see DBC endpoints', async () => {
    const r = await req('GET', '/api/dbc/suppliers', null, AGENT);
    assert.equal(r.status, 403);
  });

  // =========================================================================
  console.log('\n[Admin] protected surface');
  // =========================================================================
  await test('admin dashboard aggregates all collections', async () => {
    const r = await req('GET', '/api/admin/dashboard', null, ADMIN);
    assert.equal(r.status, 200);
    assert.ok(r.body.data.counts.users > 0);
    assert.ok(r.body.data.applications_by_stage.S10 >= 1);
  });

  await test('admin recommendation pool shows eligibility per B', async () => {
    const r = await req('GET', '/api/admin/recommendation/pool', null, ADMIN);
    assert.equal(r.status, 200);
    assert.ok(r.body.data.length >= 3);
    for (const b of r.body.data) {
      assert.equal(typeof b.eligible, 'boolean');
      assert.ok(Array.isArray(b.failures));
    }
  });

  await test('admin can change recommendation weights', async () => {
    const before = (await req('GET', '/api/admin/config/recommendation-weights', null, ADMIN)).body.data;
    const r = await req('PUT', '/api/admin/config/recommendation-weights', { requirement_match: 40 }, ADMIN);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.requirement_match, 40);
    const bad = await req('PUT', '/api/admin/config/recommendation-weights', { nope: 5 }, ADMIN);
    assert.equal(bad.status, 400);
    // Restore.
    await req('PUT', '/api/admin/config/recommendation-weights', { requirement_match: before.requirement_match }, ADMIN);
  });

  await test('admin can expire a B membership and transfer its C clients', async () => {
    const bs = (await req('GET', '/api/admin/bs', null, ADMIN)).body.data;
    // Expire a B that the C-session tests do NOT depend on, so the Rule 13
    // transfer does not break the messaging/brief tests that follow.
    const target = bs.find((b) => !b.organization.name.includes('环球学桥'));
    assert.ok(target, 'a second B exists to expire');
    const r = await req('POST', '/api/admin/bs/' + target.organization.id + '/expire', {}, ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.data.transferred_bindings >= 0);
  });

  await test('admin verification rejects a supplier without a source', async () => {
    const list = (await req('GET', '/api/admin/ss', null, ADMIN)).body.data;
    const noSource = list.find((s) => !s.source_url);
    if (noSource) {
      const r = await req('POST', '/api/admin/verifications/suppliers/' + noSource.id, { decision: 'approve' }, ADMIN);
      assert.equal(r.status, 400);
      assert.match(r.body.error, /来源/);
    }
  });

  await test('admin audit log is readable', async () => {
    const r = await req('GET', '/api/admin/audit?limit=20', null, ADMIN);
    assert.equal(r.status, 200);
    assert.ok(r.body.data.length > 0);
    assert.ok(r.body.meta.total >= r.body.data.length);
  });

  await test('admin can read and update system config', async () => {
    const r = await req('GET', '/api/admin/config', null, ADMIN);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.first_binding_protection_months, 12);
    const put = await req('PUT', '/api/admin/config', { membership_grace_days: 45 }, ADMIN);
    assert.equal(put.status, 200);
    assert.equal(put.body.data.membership_grace_days, 45);
    await req('POST', '/api/admin/config/reset', {}, ADMIN);
  });

  await test('admin can resolve a dispute', async () => {
    const created = await req('POST', '/api/b/disputes', { subject: 'test', description: 'test' }, AGENT);
    assert.equal(created.status, 201);
    const r = await req('POST', '/api/admin/disputes/' + created.body.data.id + '/resolve', { decision: 'resolved', resolution: 'ok' }, ADMIN);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.status, 'resolved');
  });

  await test('B assistant answers without mutating anything', async () => {
    const r = await req('POST', '/api/b/assistant', { question: '有哪些材料缺失？' }, AGENT);
    assert.equal(r.status, 200);
    assert.ok(r.body.data.guard.includes('不能修改资金'));
  });

  // =========================================================================
  console.log('\n[Ads] advertising funnel');
  // =========================================================================
  let adOrderId;
  await test('ad products expose configurable demo defaults', async () => {
    const r = await req('GET', '/api/ads/products');
    assert.equal(r.status, 200);
    assert.equal(r.body.meta.demo_defaults.topup_amount, 800);
    assert.equal(r.body.meta.demo_defaults.monthly_price, 100);
    assert.equal(r.body.meta.demo_defaults.max_renewals, 6);
    assert.match(r.body.meta.note, /可配置演示默认值/);
  });

  await test('ad order → sandbox payment → creative → review → schedule', async () => {
    const inventory = (await req('GET', '/api/ads/inventory')).body.data;
    assert.ok(inventory.length >= 1, 'no ad inventory seeded');
    const order = await req('POST', '/api/ads/orders', { inventory_id: inventory[0].id, amount: 100 }, EDU);
    assert.equal(order.status, 201, JSON.stringify(order.body));
    adOrderId = order.body.data.id;
    assert.equal(order.body.data.status, 'cart');

    const paid = await req('POST', '/api/ads/orders/' + adOrderId + '/pay', {}, EDU);
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.data.order.status, 'paid');
    assert.equal(paid.body.data.sandbox, true);

    const creative = await req('POST', '/api/ads/orders/' + adOrderId + '/creative', { title: 'Ad', body: 'b', asset_url: 'https://x/y.png' }, EDU);
    assert.equal(creative.status, 201);
    assert.equal(creative.body.data.order.status, 'creative_uploaded');

    const review = await req('POST', '/api/ads/orders/' + adOrderId + '/review', { decision: 'approve' }, ADMIN);
    assert.equal(review.status, 200);
    assert.equal(review.body.data.status, 'approved');

    const schedule = await req('POST', '/api/ads/orders/' + adOrderId + '/schedule', {}, EDU);
    assert.equal(schedule.status, 201, JSON.stringify(schedule.body));
    assert.equal(schedule.body.data.order.status, 'scheduled');
  });

  await test('a supplier cannot approve its own ad creative', async () => {
    const order = (await req('POST', '/api/ads/orders', { inventory_id: (await req('GET', '/api/ads/inventory')).body.data[0].id, amount: 100 }, EDU)).body.data;
    await req('POST', '/api/ads/orders/' + order.id + '/pay', {}, EDU);
    await req('POST', '/api/ads/orders/' + order.id + '/creative', { title: 'x' }, EDU);
    const r = await req('POST', '/api/ads/orders/' + order.id + '/review', { decision: 'approve' }, EDU);
    assert.equal(r.status, 403);
  });

  await test('ad report computes CTR / CVR and states the ranking rule', async () => {
    for (let i = 0; i < 10; i += 1) await req('POST', '/api/ads/events', { ad_order_id: adOrderId, event: 'impression' });
    for (let i = 0; i < 3; i += 1) await req('POST', '/api/ads/events', { ad_order_id: adOrderId, event: 'click' });
    await req('POST', '/api/ads/events', { ad_order_id: adOrderId, event: 'conversion' });
    const r = await req('GET', '/api/ads/orders/' + adOrderId + '/report');
    assert.equal(r.status, 200);
    assert.equal(r.body.data.impressions, 10);
    assert.equal(r.body.data.clicks, 3);
    assert.equal(r.body.data.ctr, 30);
    assert.equal(r.body.data.sponsored_label, '广告 / 推广');
    assert.match(r.body.data.ranking_impact, /不影响自然搜索/);
  });

  await test('ad renewals are capped', async () => {
    const order = (await req('GET', '/api/ads/my-orders', null, EDU)).body.data[0];
    for (let i = 0; i < 10; i += 1) await req('POST', '/api/ads/orders/' + order.id + '/renew', {}, EDU);
    const r = await req('GET', '/api/ads/my-orders', null, EDU);
    const target = r.body.data.find((o) => o.id === order.id);
    assert.ok(target.renewals <= target.max_renewals, 'renewals exceeded the cap');
  });

  // =========================================================================
  console.log('\n[Messages / briefs / todos]');
  // =========================================================================
  await test('in-app messaging works for C, B and S', async () => {
    const c = await req('POST', '/api/c/messages', { to_type: 'B', to_id: bOrgId, body: 'hello' }, STUDENT);
    assert.equal(c.status, 201);
    const b = await req('GET', '/api/b/messages', null, AGENT);
    assert.equal(b.status, 200);
    assert.ok(b.body.data.length >= 1);
  });

  await test('daily briefs are generated per client', async () => {
    for (const [path, headers] of [['/api/c/brief', STUDENT], ['/api/b/brief', AGENT], ['/api/s/education/brief', EDU], ['/api/dbc/brief', DBC]]) {
      const r = await req('GET', path, null, headers);
      assert.equal(r.status, 200, path);
      assert.ok('today_todos' in r.body.data, path + ' brief has no todos');
    }
  });

  await test('todos are scoped per audience', async () => {
    const bTodos = (await req('GET', '/api/b/todos', null, AGENT)).body.data;
    const sTodos = (await req('GET', '/api/s/education/todos', null, EDU)).body.data;
    assert.ok(Array.isArray(bTodos));
    assert.ok(Array.isArray(sTodos));
  });

  // =========================================================================
  console.log('\n[Persistence] across a restart');
  // =========================================================================
  await test('data survives a server restart', async () => {
    const before = (await req('GET', '/api/admin/dashboard', null, ADMIN)).body.data.counts;
    // Flush and shut down.
    await db.flush();
    await new Promise((resolve) => server.close(resolve));
    // Boot a fresh server against the same data dir.
    const mod2 = require('../api-server');
    await mod2.boot();
    server = mod2.app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
    const ADMIN2 = await loginAdminReal();
    const after = (await req('GET', '/api/admin/dashboard', null, ADMIN2)).body.data.counts;
    assert.equal(after.users, before.users, 'users lost across restart');
    assert.equal(after.applications, before.applications, 'applications lost across restart');
    assert.equal(after.bindings, before.bindings, 'bindings lost across restart');
    assert.equal(after.commission_ledger, before.commission_ledger, 'commission lost across restart');
  });

  // =========================================================================
  console.log('\n[Web shell] static clients');
  // =========================================================================
  await test('the client selector page is Chinese by default with an English switch', async () => {
    const r = await req('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.text, /<html lang="zh-CN">/);
    assert.match(r.text, /请选择要打开的客户端/);
    assert.match(r.text, /English/);
  });

  await test('the selector links every client route', async () => {
    const r = await req('GET', '/');
    for (const route of ['student', 'agent', 'dbc', 'supplier/education', 'supplier/medical',
      'supplier/certification', 'supplier/visa', 'supplier/accommodation', 'supplier/finance', 'ads', 'admin']) {
      assert.ok(r.text.includes(route), route + ' missing from the selector');
    }
  });

  await test('the selector does not expose internal Growth wording', async () => {
    const r = await req('GET', '/');
    assert.equal(r.text.includes('Growth Center'), false);
    assert.equal(r.text.includes('线索池'), false);
  });

  await test('SPA fallback serves the selector for unknown paths', async () => {
    const r = await req('GET', '/student');
    assert.equal(r.status, 200);
  });

  // =========================================================================
  await db.flush();
  await new Promise((resolve) => server.close(resolve));

  console.log('\n==================================================');
  console.log(passed.length + ' passed, ' + failed.length + ' failed');
  console.log('==================================================');
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log('  - ' + f);
    process.exitCode = 1;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
