'use strict';
// ---------------------------------------------------------------------------
// V3.0.1 stabilization regression suite (Fixes 1–6).
//
// A. clean install + lockfile      → covered by CI + clean-copy run (documented)
// B. persistence (restart/redeploy, delete-no-resurrect, commit-then-ack)
// C. cross-client identity (audience isolation, no swallowed errors)
// D. binding UI closure server-side (idempotency, admission recheck, strict gate)
// E. admin demo protection (no public minting, revocation, no self-elevation)
// F. demo/verified separation
// ---------------------------------------------------------------------------
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const passed = [];
const failed = [];
async function test(name, fn) {
  try { await fn(); passed.push(name); console.log('  ok  ' + name); }
  catch (err) { failed.push(name + ' :: ' + (err && err.message)); console.error('FAIL  ' + name + ' :: ' + (err && err.message)); }
}

const TEST_RUN_ID = 'V301-' + Date.now().toString(36).toUpperCase();
let SHARED_DIR = null;

// Reset to a fresh isolated instance. Env is set before the (re)require so the
// db module binds to the right directory; the previous instance is dropped
// from the cache so there is exactly one module instance per phase.
function resetInstance(dir) {
  SHARED_DIR = dir;
  process.env.GS_DB_DIR = dir;
  for (const k of Object.keys(require.cache)) {
    if ((k.includes('/lib/') || k.endsWith('api-server.js')) && k.includes('留学项目')) delete require.cache[k];
  }
  return require('../api-server');
}

// Always resolve the db lazily so we read the CURRENT instance's stores.
function DB() { return require('../lib/db'); }

function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  return new Promise((resolve) => server.once('listening', () => resolve(server)));
}

function client(base) {
  return async function req(method, p, body, headers) {
    const r = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: (body === undefined || method === 'GET' || method === 'HEAD') ? undefined : JSON.stringify(body)
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}

async function main() {
  console.log('test_run_id:', TEST_RUN_ID);

  // =========================================================================
  console.log('\n[B] Persistence — restart + delete-no-resurrect + commit-then-ack');
  // =========================================================================
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'v301-persist-'));
  {
    const api = resetInstance(dirB);
    await api.boot();
    const server = await listen(api.app);
    const req = client('http://127.0.0.1:' + server.address().port);

    await test('B1: binding write commits to disk before the response resolves', async () => {
      const login = (await req('POST', '/api/auth/demo-login', { token: 'demo-student-01' })).body.data;
      const H = { Authorization: 'Bearer ' + login.token };
      const rr = await req('POST', '/api/c/requirements', { target_countries: ['SG'], target_stages: ['MASTER'], target_courses: ['Computer Science'], languages: ['ZH'] }, H);
      const bOrg = rr.body.data.recommendation.candidates[0].b_organization_id;
      const created = await req('POST', '/api/c/bindings', { b_organization_id: bOrg }, H);
      assert.equal(created.status, 201);
      // The store file must already contain the binding when the call returns.
      const raw = JSON.parse(fs.readFileSync(path.join(dirB, 'aethel.json'), 'utf8'));
      const found = raw.data.bindings.some((b) => b.id === created.body.data.id);
      assert.equal(found, true, 'binding not durable at response time');
      global.__persistBindingId = created.body.data.id;
      global.__persistBOrg = bOrg;
    });

    await new Promise((r) => server.close(r));
    // Simulate a restart against the same dir (fresh module instance).
    const api2 = resetInstance(dirB);
    await api2.boot();
    const server2 = await listen(api2.app);
    const req2 = client('http://127.0.0.1:' + server2.address().port);

    await test('B2: binding survives a normal restart', async () => {
      const b = DB().stores.bindings.byId(global.__persistBindingId);
      assert.ok(b, 'binding lost across restart');
      assert.equal(b.b_organization_id, global.__persistBOrg);
    });

    await test('B3: deleted record does not resurrect after restart', async () => {
      const db = DB();
      const msg = db.stores.messages.insert({
        id: 'MSG-' + TEST_RUN_ID, thread_id: 't-' + TEST_RUN_ID,
        from_type: 'C', from_id: 'x', to_type: 'B', to_id: 'y', body: 'temp',
        created_at: new Date().toISOString()
      });
      await db.commitNow();
      db.stores.messages.remove(msg.id);
      await db.commitNow();
      const api3 = resetInstance(dirB);
      await api3.boot();
      const db2 = DB();
      assert.equal(db2.stores.messages.byId('MSG-' + TEST_RUN_ID), null, 'deleted record resurrected');
    });

    await test('B4: corrupt store file aborts instead of wiping data', async () => {
      const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v301-corrupt-'));
      fs.writeFileSync(path.join(corruptDir, 'aethel.json'), '{not json');
      const freshApi = resetInstance(corruptDir);
      await assert.rejects(() => freshApi.boot(), /corrupt|unreadable/i);
    });

    await test('B5: health reports honest durability backend', async () => {
      const r = await req2('GET', '/api/health');
      assert.equal(r.body.ok, true);
      assert.ok(['postgresql', 'json-file', 'memory'].includes(r.body.data.backend));
      assert.equal(typeof r.body.data.persistence, 'string');
      assert.ok(!JSON.stringify(r.body).includes('DATABASE_URL'), 'connection string leaked in health');
    });

    await new Promise((r) => server2.close(r));
  }

  // =========================================================================
  console.log('\n[C] Cross-client identity');
  // =========================================================================
  {
    const api = resetInstance(dirB);
    await api.boot();
    const server = await listen(api.app);
    const req = client('http://127.0.0.1:' + server.address().port);

    await test('C1: C token on B client routes → 403 audience mismatch (not 404/200)', async () => {
      const login = (await req('POST', '/api/auth/demo-login', { token: 'demo-student-01' })).body.data;
      const H = { Authorization: 'Bearer ' + login.token };
      const r = await req('GET', '/api/b/me', null, H);
      assert.equal(r.status, 403);
      assert.equal(r.body.ok, false);
    });

    await test('C2: education S token on accommodation routes → 403', async () => {
      const edu = (await req('POST', '/api/auth/demo-login', { token: 'demo-supplier-education-01' })).body.data;
      const r = await req('GET', '/api/s/accommodation/me', null, { Authorization: 'Bearer ' + edu.token });
      assert.equal(r.status, 403);
    });

    await test('C3: invalid token → 401 on every client surface', async () => {
      for (const p of ['/api/c/me', '/api/b/me', '/api/s/education/me', '/api/dbc/me', '/api/admin/dashboard']) {
        const r = await req('GET', p, null, { Authorization: 'Bearer tok-invalid-' + TEST_RUN_ID });
        assert.equal(r.status, 401, p);
      }
    });

    await test('C4: demo-accounts list is audience-consistent (no admin, includes supplier_type)', async () => {
      const r = await req('GET', '/api/auth/demo-accounts');
      const accounts = r.body.data;
      assert.equal(accounts.some((a) => a.audience === 'ADMIN'), false, 'admin account exposed');
      const edu = accounts.find((a) => a.supplier_type === 'EDUCATION');
      assert.ok(edu, 'education supplier account missing supplier_type');
    });

    await new Promise((r) => server.close(r));
  }

  // =========================================================================
  console.log('\n[D] Binding closure — idempotency, admission recheck, strict gate');
  // =========================================================================
  {
    const api = resetInstance(dirB);
    await api.boot();
    const server = await listen(api.app);
    const req = client('http://127.0.0.1:' + server.address().port);

    const login = (await req('POST', '/api/auth/demo-login', { token: 'demo-student-01' })).body.data;
    const H = { Authorization: 'Bearer ' + login.token };
    const rr = await req('POST', '/api/c/requirements', { target_countries: ['SG'], target_stages: ['MASTER'], target_courses: ['Computer Science'], languages: ['ZH'] }, H);
    const bOrg = rr.body.data.recommendation.candidates[0].b_organization_id;

    await test('D1: duplicate binding request is idempotent (same id, no second binding)', async () => {
      // Use a fresh C so the demo C's earlier bindings in this run don't leak in.
      const reg = await req('POST', '/api/auth/register', { email: 'd1-' + TEST_RUN_ID + '@t.local', password: 'x123456', role: 'C_STUDENT' });
      const d1H = { Authorization: 'Bearer ' + reg.body.data.token };
      const first = await req('POST', '/api/c/bindings', { b_organization_id: bOrg }, d1H);
      assert.equal(first.status, 201);
      const second = await req('POST', '/api/c/bindings', { b_organization_id: bOrg }, d1H);
      assert.equal(second.status, 200, 'duplicate should return 200 with existing');
      assert.equal(second.body.data.duplicate, true);
      assert.equal(second.body.data.id, first.body.data.id, 'different binding id for duplicate submit');
      const db = DB();
      const meNow = await req('GET', '/api/auth/me', null, d1H);
      const mine = db.stores.bindings.all().filter((b) => String(b.c_profile_id) === String(meNow.body.data.c_profile.id));
      const pending = mine.filter((b) => ['pending_b_request', 'pending_contract', 'pending_c_signature', 'pending_b_signature'].includes(String(b.status).toLowerCase()));
      assert.equal(pending.length, 1, 'more than one pending binding created');
    });

    await test('D2: binding a frozen/unqualified B is rejected server-side (bypass guard)', async () => {
      // Craft an unqualified B directly in the store (frozen org).
      const db = DB();
      const orgMod = require('../lib/org');
      const frozen = orgMod.createOrganization({
        kind: 'B', name: 'FROZEN-' + TEST_RUN_ID, kyc_status: 'approved', kyb_status: 'approved',
        financial_docs_complete: true, verified: true, status: 'frozen', frozen_reason: 'test'
      });
      const profile = orgMod.createBProfile({ organization_id: frozen.id, level: 'LEVEL_2', verified: true, contract_valid: true });
      orgMod.createMembership({ organization_id: frozen.id, level: 'LEVEL_2', expires_at: new Date(Date.now() + 365 * 86400000).toISOString() });
      const me = await req('GET', '/api/auth/me', null, H);
      const db2 = DB();
      db2.stores.bindings.remove(global.__persistBindingId);
      const attempt = await req('POST', '/api/c/bindings', { b_organization_id: frozen.id, b_profile_id: profile.id }, H);
      assert.equal(attempt.status, 409, 'frozen B accepted: ' + JSON.stringify(attempt.body));
      assert.equal(attempt.body.code, 'B_NOT_ELIGIBLE');
      assert.ok(attempt.body.failures.includes('organization_frozen'));
    });

    await test('D3: half-signed contract does not open trading (strict gate)', async () => {
      // Fresh C: demo C is already fully bound from earlier phases of this run.
      const reg = await req('POST', '/api/auth/register', { email: 'd3-' + TEST_RUN_ID + '@t.local', password: 'x123456', role: 'C_STUDENT' });
      const d3H = { Authorization: 'Bearer ' + reg.body.data.token };
      const me = await req('GET', '/api/auth/me', null, d3H);
      const cId = me.body.data.c_profile.id;
      // Fresh recommendation — the agent's capacity may have been consumed by
      // earlier phases of this run, so pick the currently recommended B.
      const rr3 = await req('POST', '/api/c/requirements', { target_countries: ['SG'], target_stages: ['MASTER'], target_courses: ['Computer Science'], languages: ['ZH'] }, d3H);
      const bOrg3 = rr3.body.data.recommendation.candidates[0].b_organization_id;
      const created = await req('POST', '/api/c/bindings', { b_organization_id: bOrg3 }, d3H);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const AGENT = { Authorization: 'Bearer ' + (await req('POST', '/api/auth/demo-login', { token: 'demo-agent-01' })).body.data.token };
      const acc3 = await req('POST', '/api/b/binding-requests/' + created.body.data.id + '/respond', { response: 'accept' }, AGENT);
      assert.equal(acc3.status, 200, JSON.stringify(acc3.body));
      // Only C signs — no B signature yet.
      await req('POST', '/api/c/bindings/' + created.body.data.id + '/sign', {}, d3H);
      const attempt = await req('POST', '/api/c/applications', { title: 'premature' }, d3H);
      // Single-signature state must never open trading: 403 with a blocking code.
      assert.equal(attempt.status, 403, 'trading opened with a half-signed contract');
      assert.ok(['C_UNBOUND', 'C_BINDING_INCOMPLETE'].includes(attempt.body.code), 'unexpected code: ' + attempt.body.code);
      // Complete the signature.
      const done = await req('POST', '/api/b/binding-requests/' + created.body.data.id + '/sign', {}, AGENT);
      assert.equal(done.body.data.binding.status, 'active');
      // Now trading opens and exactly one seat exists.
      const okApp = await req('POST', '/api/c/applications', { title: TEST_RUN_ID }, d3H);
      assert.equal(okApp.status, 201);
      const db = DB();
      const seats = db.stores.service_scopes.all().filter((sc) => sc.kind === 'C_SEAT' && String(sc.c_profile_id) === String(cId));
      assert.equal(seats.length, 1, 'seat duplicated: ' + seats.length);
    });

    await new Promise((r) => server.close(r));
  }

  // =========================================================================
  console.log('\n[E] Admin demo protection');
  // =========================================================================
  {
    const api = resetInstance(dirB);
    await api.boot();
    const server = await listen(api.app);
    const req = client('http://127.0.0.1:' + server.address().port);

    await test('E1: demo-accounts never returns an admin identity', async () => {
      const r = await req('GET', '/api/auth/demo-accounts');
      assert.equal(r.body.data.some((a) => a.audience === 'ADMIN'), false);
    });

    await test('E2: demo-login rejects the admin token server-side', async () => {
      const r = await req('POST', '/api/auth/demo-login', { token: 'demo-admin-01' });
      assert.equal(r.status, 403);
    });

    await test('E3: raw x-demo-token admin bypass is dead', async () => {
      const r = await req('GET', '/api/admin/dashboard', null, { 'x-demo-token': 'demo-admin-01' });
      assert.equal(r.status, 401);
    });

    await test('E4: registration cannot mint an ADMIN account', async () => {
      const r = await req('POST', '/api/auth/register', { email: 'evil-' + TEST_RUN_ID + '@t.local', password: 'x123456', role: 'ADMIN_SUPER' });
      assert.equal(r.status, 403);
    });

    await test('E5: previously issued admin demo sessions are revoked at boot', async () => {
      // Forge a session for the admin demo user (as the old build would have), then boot-check.
      const db = DB();
      const admin = db.stores.users.all().find((u) => u.role === 'ADMIN_SUPER' && u.is_demo);
      db.stores.sessions.insert({ id: 'SES-OLD-' + TEST_RUN_ID, user_id: admin.id, token: 'tok-old-admin-' + TEST_RUN_ID, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString() });
      await db.commitNow();
      // boot() revokes on start; simulate by re-requiring boot logic:
      await api.boot();
      assert.equal(db.stores.sessions.byId('SES-OLD-' + TEST_RUN_ID), null, 'old admin demo session survived');
      const r = await req('GET', '/api/admin/dashboard', null, { Authorization: 'Bearer tok-old-admin-' + TEST_RUN_ID });
      assert.equal(r.status, 401);
    });

    await test('E6: legitimate real admin login still works', async () => {
      const r = await req('POST', '/api/auth/login', { email: 'admin@demo.local', password: 'demo1234' });
      assert.equal(r.status, 200);
      const me = await req('GET', '/api/auth/me', null, { Authorization: 'Bearer ' + r.body.data.token });
      assert.equal(me.body.data.user.audience, 'ADMIN');
      const dash = await req('GET', '/api/admin/dashboard', null, { Authorization: 'Bearer ' + r.body.data.token });
      assert.equal(dash.status, 200);
    });

    await new Promise((r) => server.close(r));
  }

  // =========================================================================
  console.log('\n[F] Demo/Verified separation');
  // =========================================================================
  {
    const api = resetInstance(dirB);
    await api.boot();
    const server = await listen(api.app);
    const req = client('http://127.0.0.1:' + server.address().port);

    await test('F1: every demo supplier presents verification.status=demo externally', async () => {
      const r = await req('GET', '/api/public/suppliers');
      for (const s of r.body.data) {
        if (s.verification.is_demo) {
          assert.equal(s.verification.status, 'demo', s.name + ' is demo but shows ' + s.verification.status);
          assert.equal(s.verification.verified_at, null, 'demo record carries a verified_at timestamp');
        }
      }
    });

    await test('F2: Level-2 demo recommendation still works (sandbox admission preserved)', async () => {
      const login = (await req('POST', '/api/auth/demo-login', { token: 'demo-student-01' })).body.data;
      const H = { Authorization: 'Bearer ' + login.token };
      const r = await req('POST', '/api/c/requirements', { target_countries: ['SG'], target_stages: ['MASTER'], target_courses: ['Computer Science'], languages: ['ZH'] }, H);
      assert.equal(r.body.data.recommendation.tier, 'LEVEL_2');
    });

    await test('F3: a real (non-demo) supplier cannot verify without a source', async () => {
      const ADMIN = { Authorization: 'Bearer ' + (await req('POST', '/api/auth/login', { email: 'admin@demo.local', password: 'demo1234' })).body.data.token };
      const db = DB();
      const supMod = require('../lib/supplier');
      const real = supMod.createSupplier({ type: 'EDUCATION', name: 'REAL-' + TEST_RUN_ID, public_visible: true, is_demo: false, verification: 'pending' });
      const bad = await req('POST', '/api/admin/verifications/suppliers/' + real.supplier.id, { decision: 'approve' }, ADMIN);
      assert.equal(bad.status, 400, 'verified without source');
      real.supplier.source_url = 'https://example.com/not-a-proof';
      const stillBad = await req('POST', '/api/admin/verifications/suppliers/' + real.supplier.id, { decision: 'approve' }, ADMIN);
      // example.com placeholder is not acceptable evidence for a REAL record.
      assert.equal(stillBad.status, 400, 'placeholder URL accepted as evidence');
      // Clean up this isolated-instance test record (owned by this run).
      db.stores.suppliers.remove(real.supplier.id);
      await db.commitNow();
    });

    await test('F4: finance/insurance stay disabled', async () => {
      const r = await req('GET', '/api/health');
      assert.equal(r.body.data.feature_flags.finance_enabled, false);
      assert.equal(r.body.data.feature_flags.insurance_enabled, false);
    });

    await new Promise((r) => server.close(r));
  }

  console.log('\n==================================================');
  console.log(passed.length + ' passed, ' + failed.length + ' failed  (V3.0.1 stabilization regressions, run ' + TEST_RUN_ID + ')');
  console.log('==================================================');
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log('  - ' + f);
    process.exitCode = 1;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
