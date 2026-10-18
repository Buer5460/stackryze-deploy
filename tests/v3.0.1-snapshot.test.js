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
    assert.ok(r.body.data.counts.users > 0);
    assert.ok(Array.isArray(r.body.data.data.users));
    assert.ok(r.body.data.data.bindings !== undefined);
  });

  await test('G2: snapshot export requires an admin session', async () => {
    const r = await req('GET', '/api/admin/snapshot/export');
    assert.equal(r.status, 401);
    const agent = (await req('POST', '/api/auth/demo-login', { token: 'demo-agent-01' })).body.data.token;
    const r2 = await req('GET', '/api/admin/snapshot/export', null, { Authorization: 'Bearer ' + agent });
    assert.equal(r2.status, 403, 'a B account must not export snapshots');
  });

  await test('G3: snapshot import restores an exported dataset', async () => {
    // Create a marker record, export, wipe, import, verify.
    const marker = DB().stores.messages.insert({
      id: 'MSG-' + TEST_RUN_ID, thread_id: 't-' + TEST_RUN_ID,
      from_type: 'C', from_id: 'x', to_type: 'B', to_id: 'y',
      body: 'snapshot-marker', created_at: new Date().toISOString()
    });
    await DB().commitNow();
    const exported = await req('GET', '/api/admin/snapshot/export', null, ADMIN);
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

  await test('G4: snapshot import without confirmation is refused', async () => {
    const r = await req('POST', '/api/admin/snapshot/import', { data: {} }, ADMIN);
    assert.equal(r.status, 400);
    const r2 = await req('POST', '/api/admin/snapshot/import', { confirm: 'yes', data: {} }, ADMIN);
    assert.equal(r2.status, 400);
  });

  await test('G5: export never leaks connection strings or secrets', async () => {
    const r = await req('GET', '/api/admin/snapshot/export', null, ADMIN);
    const raw = JSON.stringify(r.body);
    assert.equal(raw.includes('DATABASE_URL'), false);
    assert.equal(/postgres(ql)?:\/\//.test(raw), false, 'a connection string leaked into the export');
    // The seeded demo user password is hashed, never plaintext.
    const users = r.body.data.data.users || [];
    for (const u of users) {
      if (u.password) assert.match(u.password, /^sha256:/, 'plaintext password in export');
    }
  });

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

  await test('G11: redeploy simulation restores the dataset (export → snapshot → boot)', async () => {
    // 1) boot an instance and write a marker
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'v301-redeploy-a-'));
    const apiA = resetInstance(dirA);
    await apiA.boot();
    const serverA = apiA.app.listen(0, '127.0.0.1');
    await new Promise((r) => serverA.once('listening', r));
    const baseA = 'http://127.0.0.1:' + serverA.address().port;
    const reqA = async (m, p, b, h) => {
      const r = await fetch(baseA + p, {
        method: m, headers: { 'Content-Type': 'application/json', ...(h || {}) },
        body: (b === undefined || m === 'GET') ? undefined : JSON.stringify(b)
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const adminA = (await reqA('POST', '/api/auth/login', { email: 'admin@demo.local', password: 'demo1234' })).body.data.token;
    const HA = { Authorization: 'Bearer ' + adminA };
    DB().stores.messages.insert({
      id: 'MSG-' + TEST_RUN_ID + '-redeploy', thread_id: 't', from_type: 'C', from_id: 'x',
      to_type: 'B', to_id: 'y', body: 'survives-redeploy', created_at: new Date().toISOString()
    });
    await DB().commitNow();
    const exported = (await reqA('GET', '/api/admin/snapshot/export', null, HA)).body.data;

    // 2) "deploy": a fresh instance with an empty data dir, seeded from the snapshot
    await new Promise((r) => serverA.close(r));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'v301-redeploy-b-'));
    fs.writeFileSync(path.join(dirB, 'aethel.json'), JSON.stringify({ version: exported.version, data: exported.data }));
    const apiB = resetInstance(dirB);
    await apiB.boot();
    const serverB = apiB.app.listen(0, '127.0.0.1');
    await new Promise((r) => serverB.once('listening', r));

    // 3) the marker is present in the "redeployed" instance
    const marker = DB().stores.messages.byId('MSG-' + TEST_RUN_ID + '-redeploy');
    assert.ok(marker, 'the marker must survive the simulated redeploy');
    assert.equal(marker.body, 'survives-redeploy');
    // 4) and the seed did not duplicate the demo dataset
    const users = DB().stores.users.all().filter((u) => u.email === 'admin@demo.local');
    assert.equal(users.length, 1, 'seed must be idempotent across a snapshot restore');
    await new Promise((r) => serverB.close(r));
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
