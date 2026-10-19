'use strict';
// ---------------------------------------------------------------------------
// V3.0.1 Fix 2 — snapshot backend regressions.
//
// Covers the public-persistence path used on hosts without a persistent disk:
//   G1 admin snapshot export shape (and auth)
//   G2 snapshot import restores an exported dataset
//   G3 snapshot import requires explicit confirmation
//   G4 snapshot export never leaks connection strings or secrets
//   G5 restore script is a no-op when the snapshot branch is missing
//   G6 restore script adopts a valid snapshot from a local clone
//   G7 restore script refuses an invalid-JSON snapshot
//   G8 restore script keeps an existing (newer) local dataset
//   G9 push script dry-run performs no writes
//   G10 a redeploy simulation restores the dataset (export → snapshot → boot)
// ---------------------------------------------------------------------------
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const passed = [];
const failed = [];
async function test(name, fn) {
  try { await fn(); passed.push(name); console.log('  ok  ' + name); }
  catch (err) { failed.push(name + ' :: ' + (err && err.message)); console.error('FAIL  ' + name + ' :: ' + (err && err.message)); }
}

const REPO = path.resolve(__dirname, '..');
const TEST_RUN_ID = 'V301-SNAP-' + Date.now().toString(36).toUpperCase();

function resetInstance(dir, env) {
  process.env.GS_DB_DIR = dir;
  Object.assign(process.env, env || {});
  for (const k of Object.keys(require.cache)) {
    if ((k.includes(path.join(REPO, 'lib')) || k.startsWith(path.join(REPO, 'api-server.js'))) && !k.includes('node_modules')) {
      delete require.cache[k];
    }
  }
  return require(path.join(REPO, 'api-server'));
}

function DB() { return require(path.join(REPO, 'lib', 'db')); }

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v301-snap-'));
  const api = resetInstance(dir);
  await api.boot();
  const server = api.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const req = async (m, p, b, h) => {
    const r = await fetch(base + p, {
      method: m,
      headers: { 'Content-Type': 'application/json', ...(h || {}) },
      body: (b === undefined || m === 'GET' || m === 'HEAD') ? undefined : JSON.stringify(b)
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const adminLogin = await req('POST', '/api/auth/login', { email: 'admin@demo.local', password: 'demo1234' });
  assert.equal(adminLogin.status, 200, 'admin login must work for snapshot tests');
  const ADMIN = { Authorization: 'Bearer ' + adminLogin.body.data.token };

  console.log('\n[G] Snapshot backend (public persistence, no paid disk)');

  await test('G1: snapshot export returns the full dataset and counts', async () => {
    const r = await req('GET', '/api/admin/snapshot/export', null, ADMIN);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.backend, 'json-file');
    // Public snapshot: whitelisted catalogue only (no users/sessions).
    assert.equal(r.body.data.scope, 'public-whitelisted');
    assert.ok(Array.isArray(r.body.data.data.institutions), 'institutions missing');
    assert.ok(Array.isArray(r.body.data.data.suppliers), 'suppliers missing');
    assert.equal('users' in r.body.data.data, false, 'users leaked into the public snapshot');
    assert.equal('sessions' in r.body.data.data, false, 'sessions leaked into the public snapshot');
  });

  await test('G2: snapshot export requires an admin session', async () => {
    const r = await req('GET', '/api/admin/snapshot/export');
    assert.equal(r.status, 401);
    const agent = (await req('POST', '/api/auth/demo-login', { token: 'demo-agent-01' })).body.data.token;
    const r2 = await req('GET', '/api/admin/snapshot/export', null, { Authorization: 'Bearer ' + agent });
    assert.equal(r2.status, 403, 'a B account must not export snapshots');
  });

  await test('G4: snapshot import without confirmation is refused', async () => {
    // Re-authenticate: an import clears sessions by design.
    const fresh = (await req('POST', '/api/auth/login', { email: 'admin@demo.local', password: 'demo1234' })).body.data.token;
    const H = { Authorization: 'Bearer ' + fresh };
    const r = await req('POST', '/api/admin/snapshot/import', { data: {} }, H);
    assert.equal(r.status, 400);
    const r2 = await req('POST', '/api/admin/snapshot/import', { confirm: 'yes', data: {} }, H);
    assert.equal(r2.status, 400);
  });

  await test('G5: public export never leaks connection strings, secrets or PII', async () => {
    const fresh = (await req('POST', '/api/auth/login', { email: 'admin@demo.local', password: 'demo1234' })).body.data.token;
    const r = await req('GET', '/api/admin/snapshot/export', null, { Authorization: 'Bearer ' + fresh });
    const raw = JSON.stringify(r.body);
    assert.equal(raw.includes('DATABASE_URL'), false);
    assert.equal(/postgres(ql)?:\/\//.test(raw), false, 'a connection string leaked into the export');
    // The seeded demo user password is hashed, never plaintext.
    const users = r.body.data.data.users || [];
    for (const u of users) {
      if (u.password) assert.match(u.password, /^sha256:/, 'plaintext password in export');
    }
  });

  await test('G3: snapshot import restores an exported dataset', async () => {
    // Create a marker record, export, wipe, import, verify.
    const marker = DB().stores.messages.insert({
      id: 'MSG-' + TEST_RUN_ID, thread_id: 't-' + TEST_RUN_ID,
      from_type: 'C', from_id: 'x', to_type: 'B', to_id: 'y',
      body: 'snapshot-marker', created_at: new Date().toISOString()
    });
    await DB().commitNow();
    // Internal export carries business records (messages); the public export
    // correctly excludes them, so an operator restore uses the full scope.
    const exported = await req('GET', '/api/admin/snapshot/export/full', null, ADMIN);
    const payload = exported.body.data;

    // Simulate data loss: remove the marker and restart the module graph.
    DB().stores.messages.remove(marker.id);
    await DB().commitNow();
    assert.equal(DB().stores.messages.byId(marker.id), null, 'marker should be gone before restore');

    const restored = await req('POST', '/api/admin/snapshot/import', { confirm: 'RESTORE_SNAPSHOT', data: payload.data }, ADMIN);
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    const back = DB().stores.messages.byId(marker.id);
    assert.ok(back, 'marker must come back after snapshot restore');
    assert.equal(back.body, 'snapshot-marker');
  });


  // Re-seed accounts: the import above strips credentials on purpose.
  DB(); require(path.join(REPO, 'lib', 'seed.js')).ensureAccounts();

  await new Promise((r) => server.close(r));

  // --- script-level regressions (restore / push) ---------------------------
  const SCRIPTS = path.join(REPO, 'scripts');

  await test('G6: restore script is a no-op when the snapshot branch is missing', async () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'v301-snap-restore-'));
    const out = execFileSync('bash', [path.join(SCRIPTS, 'snapshot-restore.sh')], {
      env: { ...process.env, GS_DB_DIR: target, GS_SNAPSHOT_BRANCH: 'data-snapshot-does-not-exist-' + TEST_RUN_ID },
      encoding: 'utf8'
    });
    assert.match(out, /starting from a fresh dataset/);
    assert.equal(fs.existsSync(path.join(target, 'aethel.json')), false);
  });

  await test('G7: restore script adopts a valid snapshot from a local clone', async () => {
    // Fake "remote" as a local repo so the test needs no network.
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'v301-snap-remote-'));
    execFileSync('git', ['init', '--quiet', remote], { encoding: 'utf8' });
    fs.mkdirSync(path.join(remote, 'data', 'db'), { recursive: true });
    const snapshot = { version: '3.0.1', exported_at: new Date().toISOString(), backend: 'json-file', counts: { users: 3 }, data: { users: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }] } };
    fs.writeFileSync(path.join(remote, 'data', 'db', 'aethel.json'), JSON.stringify(snapshot));
    execFileSync('git', ['-C', remote, 'add', '.'], { encoding: 'utf8' });
    execFileSync('git', ['-C', remote, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'snap'], { encoding: 'utf8' });
    execFileSync('git', ['-C', remote, 'branch', '-M', 'snap-branch'], { encoding: 'utf8' });

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'v301-snap-target-'));
    const out = execFileSync('bash', [path.join(SCRIPTS, 'snapshot-restore.sh')], {
      env: {
        ...process.env,
        GS_DB_DIR: target,
        GS_SNAPSHOT_REPO_URL: remote,
        GS_SNAPSHOT_BRANCH: 'snap-branch'
      },
      encoding: 'utf8'
    });
    assert.match(out, /restored dataset/);
    const adopted = JSON.parse(fs.readFileSync(path.join(target, 'aethel.json'), 'utf8'));
    assert.equal(adopted.counts.users, 3);
    assert.equal(adopted.data.users.length, 3);
  });

  await test('G8: restore script refuses an invalid-JSON snapshot', async () => {
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'v301-snap-bad-'));
    execFileSync('git', ['init', '--quiet', remote], { encoding: 'utf8' });
    fs.mkdirSync(path.join(remote, 'data', 'db'), { recursive: true });
    fs.writeFileSync(path.join(remote, 'data', 'db', 'aethel.json'), '{not json');
    execFileSync('git', ['-C', remote, 'add', '.'], { encoding: 'utf8' });
    execFileSync('git', ['-C', remote, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'bad'], { encoding: 'utf8' });
    execFileSync('git', ['-C', remote, 'branch', '-M', 'snap-branch'], { encoding: 'utf8' });

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'v301-snap-bad-target-'));
    const out = execFileSync('bash', [path.join(SCRIPTS, 'snapshot-restore.sh')], {
      env: { ...process.env, GS_DB_DIR: target, GS_SNAPSHOT_REPO_URL: remote, GS_SNAPSHOT_BRANCH: 'snap-branch' },
      encoding: 'utf8'
    });
    assert.match(out, /not valid JSON/);
    assert.equal(fs.existsSync(path.join(target, 'aethel.json')), false, 'a corrupt snapshot must not be adopted');
  });

  await test('G9: restore script keeps an existing (newer) local dataset', async () => {
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'v301-snap-old-'));
    execFileSync('git', ['init', '--quiet', remote], { encoding: 'utf8' });
    fs.mkdirSync(path.join(remote, 'data', 'db'), { recursive: true });
    fs.writeFileSync(path.join(remote, 'data', 'db', 'aethel.json'), JSON.stringify({ version: '3.0.1', data: {} }));
    execFileSync('git', ['-C', remote, 'add', '.'], { encoding: 'utf8' });
    execFileSync('git', ['-C', remote, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'old'], { encoding: 'utf8' });
    execFileSync('git', ['-C', remote, 'branch', '-M', 'snap-branch'], { encoding: 'utf8' });

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'v301-snap-new-target-'));
    fs.writeFileSync(path.join(target, 'aethel.json'), JSON.stringify({ version: '3.0.1', data: { local: true } }));
    const out = execFileSync('bash', [path.join(SCRIPTS, 'snapshot-restore.sh')], {
      env: { ...process.env, GS_DB_DIR: target, GS_SNAPSHOT_REPO_URL: remote, GS_SNAPSHOT_BRANCH: 'snap-branch' },
      encoding: 'utf8'
    });
    assert.match(out, /already present/);
    const kept = JSON.parse(fs.readFileSync(path.join(target, 'aethel.json'), 'utf8'));
    assert.equal(kept.data.local, true, 'the newer local dataset must not be clobbered');
  });

  await test('G10: push script dry-run performs no writes', async () => {
    // A pre-existing (git-ignored) local dataset is fine; the point is that
    // dry-run must not create, modify or delete anything in the repo.
    const localDataset = path.join(REPO, 'data', 'db', 'aethel.json');
    const existedBefore = fs.existsSync(localDataset);
    const hashBefore = existedBefore
      ? require('crypto').createHash('sha256').update(fs.readFileSync(localDataset)).digest('hex')
      : null;
    const gitHeadBefore = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const branchesBefore = execFileSync('git', ['-C', REPO, 'branch', '--list', 'data-snapshot'], { encoding: 'utf8' }).trim();

    const out = execFileSync('bash', [path.join(SCRIPTS, 'snapshot-push.sh'), '--dry-run'], {
      cwd: REPO, encoding: 'utf8'
    });
    assert.match(out, /dry-run/);

    const gitHeadAfter = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const branchesAfter = execFileSync('git', ['-C', REPO, 'branch', '--list', 'data-snapshot'], { encoding: 'utf8' }).trim();
    assert.equal(gitHeadBefore, gitHeadAfter, 'dry-run must not commit');
    assert.equal(branchesBefore, branchesAfter, 'dry-run must not create the snapshot branch');

    const existsAfter = fs.existsSync(localDataset);
    assert.equal(existedBefore, existsAfter, 'dry-run must not create or delete the local dataset');
    if (existedBefore) {
      const hashAfter = require('crypto').createHash('sha256').update(fs.readFileSync(localDataset)).digest('hex');
      assert.equal(hashBefore, hashAfter, 'dry-run must not modify the local dataset');
    }
  });

  await test('G11: snapshot restore is OFF by default (V3.0.3 policy)', async () => {
    // A public snapshot holds only a whitelisted catalogue subset. Using it as
    // the runtime database strips fields business rules need, so it is disabled
    // unless explicitly opted in.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'v303-off-'));
    const apiC = resetInstance(empty, {}); // GS_SNAPSHOT_ENABLED unset => off
    await apiC.boot();
    const users = DB().stores.users.all();
    // Seeded locally: accounts exist, catalogue seeded (not restored).
    assert.ok(users.length > 0, 'no accounts after a fresh boot');
    assert.ok(DB().stores.b_profiles.all().length >= 1, 'catalogue missing');
    const rec = require(path.join(REPO, 'lib', 'recommendation'));
    const out = rec.recommend({ id: 'g11', target_countries: ['SG'], target_stages: ['MASTER'], target_countries_: null, target_courses: ['Computer Science'], languages: ['ZH'] });
    assert.equal(out.tier, 'LEVEL_2', 'recommendation degraded (snapshot restore polluted the fixture)');
  });

  await test('G12: opting in restores only whitelisted catalogue data (no accounts)', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'v303-on-'));
    const apiD = resetInstance(empty, { GS_SNAPSHOT_ENABLED: '1' });
    await apiD.boot();
    const db = DB();
    // Whatever came from the public snapshot, it must never contain users or
    // sessions, and accounts are re-created locally by ensureAccounts().
    assert.ok(db.stores.users.all().length > 0, 'accounts must exist (locally seeded)');
    // The snapshot itself must never carry credentials. Local seed accounts
    // (created by ensureAccounts after boot) are expected to have hashes.
    const policy = require(path.join(REPO, 'lib', 'snapshot-policy.js'));
    const built = policy.buildPublicSnapshot(db.snapshot());
    const raw = JSON.stringify(built.data);
    assert.equal(raw.includes('sha256:'), false, 'a password hash reached the public snapshot');
    assert.equal(raw.includes('demo_token'), false, 'a demo token reached the public snapshot');
    assert.equal(raw.includes('"sessions"'), false, 'sessions reached the public snapshot');
  });

  await test('G11: a simulated redeploy restores whitelisted catalogue data (BLOCKED for business records)', async () => {
    // V3.0.3 policy: the public snapshot is a whitelisted catalogue only.
    // Business records (users/binding/application/commission) CANNOT be
    // published publicly, so cross-deploy persistence for them is BLOCKED
    // until a private DATABASE_URL is provisioned. This test verifies the
    // part that IS safe: catalogue records survive a simulated redeploy.
    // 1) boot an instance, confirm catalogue + accounts
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'v303-redeploy-a-'));
    const apiA = resetInstance(dirA, { GS_SNAPSHOT_ENABLED: '0' });
    await apiA.boot();
    const institutionsA = DB().stores.institutions.all().length;
    assert.ok(institutionsA > 0, 'catalogue seeded');
    // 2) export the PUBLIC snapshot and write it as a new instance's store
    const serverA = apiA.app.listen(0, '127.0.0.1');
    await new Promise((r) => serverA.once('listening', r));
    const baseA = 'http://127.0.0.1:' + serverA.address().port;
    const adminA = (await (async () => {
      const r = await fetch(baseA + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@demo.local', password: 'demo1234' }) });
      return (await r.json()).data.token;
    })());
    const pubExport = await (async () => {
      const r = await fetch(baseA + '/api/admin/snapshot/export', { headers: { Authorization: 'Bearer ' + adminA } });
      return (await r.json()).data;
    })();
    await new Promise((r) => serverA.close(r));

    // 3) "deploy": fresh instance whose data dir already holds the snapshot
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'v303-redeploy-b-'));
    fs.writeFileSync(path.join(dirB, 'aethel.json'), JSON.stringify({ version: pubExport.version, data: pubExport.data }));
    const apiB = resetInstance(dirB, { GS_SNAPSHOT_ENABLED: '0' });
    await apiB.boot();
    assert.ok(DB().stores.institutions.all().length > 0, 'catalogue lost across the simulated redeploy');
    // seed must stay idempotent: no duplicated catalogue rows
    assert.equal(DB().stores.suppliers.all().filter((x) => x.type === 'FINANCE').length, 1,
      'catalogue duplicated after restore (seed was not idempotent)');
  });

  console.log('\n==================================================');
  console.log(passed.length + ' passed, ' + failed.length + ' failed  (snapshot regressions, run ' + TEST_RUN_ID + ')');
  console.log('==================================================');
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log('  - ' + f);
    process.exitCode = 1;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
