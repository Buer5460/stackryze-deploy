'use strict';
// ---------------------------------------------------------------------------
// AETHEL EDU — persistence layer
//
// One data model for every client (Admin / B / C / S / DBC). Collections are
// plain document arrays; every record carries an `id`.
//
// Backends (selected automatically, no code change required):
//   1. PostgreSQL  — when DATABASE_URL is set AND the `pg` driver is installed.
//                    Table: aethel_kv(collection, id, doc jsonb, updated_at)
//   2. JSON file   — durable across process restarts (default for dev / Render
//                    free tier). This is real persistence, not memory-only.
//   3. Memory      — only when GS_DB_MEMORY=1 (used by isolated unit tests).
//
// The backend is intentionally generic (collection → documents) so that adding
// a new entity never requires a new migration file.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', 'data', 'db');

const COLLECTIONS = [
  // identity & access
  'users', 'sessions', 'organizations', 'memberships',
  'b_profiles', 'c_profiles', 'suppliers', 'supplier_profiles', 'dbc_profiles', 'service_scopes',
  // recommendation & binding
  'recommendations', 'recommendation_scores', 'recommendation_rotations',
  'bindings', 'binding_histories',
  // contracts
  'agreements', 'agreement_versions', 'signatures', 'contract_evidence',
  // catalogue
  'institutions', 'campuses', 'programs', 'scholarships',
  'accommodations', 'rooms', 'beds', 'guardian_services', 'bookings',
  'medical_services', 'medical_orders',
  'certification_services', 'certification_orders',
  'visa_services', 'visa_orders',
  'finance_products', 'finance_referrals',
  // student artefacts
  'student_profiles', 'family_documents', 'document_versions', 'document_authorizations',
  // applications & state machine
  'applications', 'application_stages', 'application_timeline', 'application_todos',
  'visa_cases', 'visa_results',
  // money
  'payment_intents', 'payment_routes', 'payment_providers', 'payment_receipts',
  'refunds', 'fee_breakdowns', 'commission_triggers',
  'commission_rules', 'commission_ledger', 'settlements', 'invoices',
  // engagement
  'reviews', 'messages', 'notifications', 'daily_briefs',
  'disputes', 'dispute_evidence',
  // advertising
  'ad_products', 'ad_inventory', 'ad_orders', 'ad_creatives', 'ad_schedules', 'ad_reports',
  // governance
  'audit_logs', 'source_evidence', 'system_config'
];

class Store {
  constructor(name) {
    this.name = name;
    this.items = [];
  }
  all() { return this.items; }
  get size() { return this.items.length; }
  [Symbol.iterator]() { return this.items[Symbol.iterator](); }
  find(predicate) { return this.items.find(predicate) || null; }
  filter(predicate) { return this.items.filter(predicate); }
  byId(id) {
    const key = String(id == null ? '' : id).toLowerCase();
    if (!key) return null;
    return this.items.find((x) => String(x.id).toLowerCase() === key) || null;
  }
  insert(record) {
    const copy = { ...record, _seq: nextSeq() };
    this.items.push(copy);
    db.touch(this.name, copy.id, copy);
    return copy;
  }
  update(id, patch) {
    const rec = this.byId(id);
    if (!rec) return null;
    Object.assign(rec, patch);
    db.touch(this.name, rec.id, rec);
    return rec;
  }
  upsert(record) {
    const existing = record && record.id ? this.byId(record.id) : null;
    if (existing) return this.update(existing.id, record);
    return this.insert(record);
  }
  remove(id) {
    const idx = this.items.findIndex((x) => String(x.id).toLowerCase() === String(id).toLowerCase());
    if (idx < 0) return false;
    const [gone] = this.items.splice(idx, 1);
    db.touch(this.name, gone.id, null);
    return true;
  }
  clear() {
    for (const item of this.items.slice()) db.touch(this.name, item.id, null);
    this.items.length = 0;
  }
}

const stores = Object.create(null);
for (const name of COLLECTIONS) stores[name] = new Store(name);

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------
let dataDir = null;
let filePath = null;
let memoryOnly = false;
let pg = null; // { pool, ready }
let persistTimer = null;
let dirty = false;
let loading = null;
let seq = 0;

// Monotonic insertion sequence — lets callers order records deterministically
// even when two records are created inside the same millisecond.
function nextSeq() { seq += 1; return seq; }

function resolveDataDir() {
  if (process.env.GS_DB_MEMORY === '1') return null;
  if (dataDir) return dataDir;
  const dir = process.env.GS_DB_DIR || DEFAULT_DIR;
  dataDir = dir;
  return dir;
}

function resolveFilePath() {
  if (filePath) return filePath;
  const dir = resolveDataDir();
  if (!dir) return null;
  filePath = process.env.GS_DB_FILE || path.join(dir, 'aethel.json');
  return filePath;
}

function byRecentFirst(a, b) {
  const sa = Number(a._seq || 0);
  const sb = Number(b._seq || 0);
  if (sa !== sb) return sb - sa;
  return String(a.created_at || a.at || '') < String(b.created_at || b.at || '') ? 1 : -1;
}

function snapshot() {
  const out = {};
  for (const name of COLLECTIONS) out[name] = stores[name].items;
  return out;
}

function restore(snap) {
  let maxSeq = 0;
  for (const name of COLLECTIONS) {
    stores[name].items = Array.isArray(snap[name]) ? snap[name].map((x) => ({ ...x })) : [];
    for (const item of stores[name].items) {
      const n = Number(item._seq || 0);
      if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
    }
  }
  seq = maxSeq;
}

function loadFileSync() {
  const file = resolveFilePath();
  if (!file) return;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return; // genuine first boot
    // An existing store that cannot be READ is a data-loss hazard: abort
    // instead of starting from an empty (re-seeded) dataset.
    throw new Error('[db] existing store ' + file + ' is unreadable: ' + (err && err.message));
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error('[db] existing store ' + file + ' is corrupt (invalid JSON): ' + (err && err.message));
  }
  restore(parsed.data || parsed);
}

function writeFileSync() {
  const file = resolveFilePath();
  if (!file) return;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: DB_VERSION, saved_at: new Date().toISOString(), data: snapshot() }), 'utf8');
  fs.renameSync(tmp, file);
}

const DB_VERSION = '3.0.3';

// --- PostgreSQL backend (optional) -----------------------------------------
async function initPostgres() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  // Fix 2: when DATABASE_URL is configured, PostgreSQL is the required backend.
  // A missing driver or failed connection/init is fatal — silently falling back
  // to the JSON file backend would report "database normal" while writes go to
  // an ephemeral file. Let the error propagate; boot() aborts the process.
  let Client;
  try {
    // eslint-disable-next-line global-require
    Client = require('pg').Pool;
  } catch (err) {
    throw new Error('[db] DATABASE_URL is set but the `pg` driver is not installed: ' + (err && err.message));
  }
  const pool = new Client({ connectionString: url, max: 4, ssl: /sslmode=require/i.test(url) ? { rejectUnauthorized: false } : undefined });
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    throw new Error('[db] cannot connect to PostgreSQL (check DATABASE_URL): ' + (err && err.message));
  }
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS aethel_kv (
      collection text NOT NULL,
      id text NOT NULL,
      doc jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (collection, id)
    )`);
    const res = await client.query('SELECT collection, doc FROM aethel_kv');
    const snap = {};
    for (const name of COLLECTIONS) snap[name] = [];
    for (const row of res.rows) {
      if (!snap[row.collection]) snap[row.collection] = [];
      snap[row.collection].push(row.doc);
    }
    restore(snap);
    // eslint-disable-next-line no-console
    console.log('[db] PostgreSQL backend active (' + res.rowCount + ' records loaded)');
  } finally {
    client.release();
  }
  pg = { pool };
  return pg;
}

async function ensureLoaded() {
  if (loading) return loading;
  loading = (async () => {
    const backend = await initPostgres();
    if (!backend) loadFileSync();
    // Snapshot self-heal (Fix 2): on hosts without a persistent disk the data
    // dir is empty after every redeploy. When the snapshot backend is enabled
    // and no local dataset exists yet, restore it from the public
    // `data-snapshot` branch before the app starts serving. A missing or
    // unreachable snapshot is not fatal — the service boots and re-seeds.
    if (!backend && snapshotEnabled() && !hasLocalData()) {
      try {
        const outcome = await snapshotClient.restoreInto(path.dirname(resolveFilePath()));
        if (outcome.restored) {
          // The restore wrote the dataset after the initial (empty) load;
          // reload so the in-memory stores reflect the restored data.
          loadFileSync();
          // eslint-disable-next-line no-console
          console.log('[db] dataset restored from the snapshot branch');
        } else if (outcome.reason && outcome.reason !== 'disabled') {
          // eslint-disable-next-line no-console
          console.warn('[db] snapshot restore skipped:', outcome.reason);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[db] snapshot restore skipped:', err && err.message);
      }
    }
    return backend;
  })();
  return loading;
}

// --- Snapshot backend (public, zero-cost persistence) ----------------------
// Pure-Node implementation (lib/snapshot.js): no git, no shell, no deps.
const snapshotClient = require('./snapshot');

function snapshotEnabled() {
  return snapshotClient.enabled();
}

function hasLocalData() {
  const file = resolveFilePath();
  if (!file) return false;
  try {
    return fs.existsSync(file) && fs.statSync(file).size > 2;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Write-through persistence
// ---------------------------------------------------------------------------
function scheduleFlush() {
  if (memoryOnly || (pg && !pg.pool)) return;
  dirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; flush(); }, 20);
  if (persistTimer.unref) persistTimer.unref();
}

async function flush() {
  if (!dirty) return;
  dirty = false;
  const snap = snapshot();
  if (pg && pg.pool) {
    const client = await pg.pool.connect();
    try {
      await client.query('BEGIN');
      for (const name of COLLECTIONS) {
        for (const rec of snap[name]) {
          await client.query(
            'INSERT INTO aethel_kv (collection, id, doc, updated_at) VALUES ($1,$2,$3,now()) ' +
            'ON CONFLICT (collection, id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()',
            [name, String(rec.id), rec]
          );
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return;
  }
  writeFileSync();
}

function flushSync() {
  if (!dirty) return;
  dirty = false;
  writeFileSync();
}

// Honest durability report (Fix 2). The JSON file backend is only durable when
// the directory is writable AND is not the repo checkout's ephemeral default on
// a disposable container. Render Free has no persistent disk, so /opt/render/
// project paths are NOT durable across deploys. Callers surface this verbatim.
function isDurable() {
  if (pg && pg.pool) return true;
  const file = resolveFilePath();
  if (!file) return false; // memory
  const dir = path.dirname(file);
  try { fs.accessSync(dir, fs.constants.W_OK); } catch (_) { return false; }
  return true;
}

const db = {
  stores,
  collections: COLLECTIONS,
  get backend() { return pg && pg.pool ? 'postgresql' : (resolveFilePath() ? 'json-file' : 'memory'); },
  get durable() { return isDurable(); },
  setDataDir(dir) {
    dataDir = dir || null;
    filePath = dir ? path.join(dir, process.env.GS_DB_FILE || 'aethel.json') : null;
    memoryOnly = !dir;
  },
  useMemory() {
    memoryOnly = true;
    dataDir = null;
    filePath = null;
  },
  ensureLoaded,
  touch() { scheduleFlush(); },
  flush,
  flushSync,
  snapshot,
  restore,
  reset() {
    for (const name of COLLECTIONS) stores[name].clear();
    dirty = true;
    flushSync();
  },
  counts() {
    const out = {};
    for (const name of COLLECTIONS) out[name] = stores[name].size;
    return out;
  },
  byRecentFirst,
  // Durability: force a synchronous flush right now. Use before responding
  // success to state-changing requests whose loss on crash would break the
  // business promise (binding, signature, seat activation, payment).
  async commitNow() {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    dirty = true;
    if (memoryOnly) return;
    await flush();
  },
  // Test hook: force a synchronous reload from the data file.
  reloadFromFile() { loadFileSync(); }
};

process.on('exit', () => { try { flushSync(); } catch (_) { /* never block shutdown */ } });
process.on('SIGINT', () => { try { flushSync(); } catch (_) {} process.exit(130); });
process.on('SIGTERM', () => { try { flushSync(); } catch (_) {} process.exit(143); });

module.exports = db;
