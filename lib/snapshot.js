'use strict';
// ---------------------------------------------------------------------------
// Snapshot restore (Fix 2 — public persistence without a paid disk).
//
// Downloads the `data-snapshot` branch as a tarball from GitHub's codeload
// endpoint and extracts data/db/aethel.json into the runtime data directory.
// Pure Node (https + zlib): no git, no external dependencies — works on hosts
// whose build image ships neither (e.g. Render's Node image).
//
// Safety:
//   * Only a public repository and a public branch are ever read.
//   * The payload is validated as JSON before adoption.
//   * An existing local dataset is never clobbered (it is newer).
//   * Any failure is non-fatal: the caller boots and re-seeds.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');

const DEFAULTS = {
  repo: 'Buer5460/stackryze-deploy',
  branch: 'data-snapshot',
  file: 'data/db/aethel.json'
};

// Disabled by default (V3.0.3): a public snapshot carries only a whitelisted
// subset of the catalogue. Restoring it at boot silently strips the fields
// business rules depend on (organization KYC flags, memberships, verification),
// which makes every recommendation fall back to browse-only. The public
// snapshot must never act as the runtime database — real persistence requires a
// private PostgreSQL (DATABASE_URL). Opt in explicitly only for demo seeding.
function enabled() {
  return String(process.env.GS_SNAPSHOT_ENABLED || '0') === '1';
}

function config() {
  const repo = process.env.GS_SNAPSHOT_REPO || DEFAULTS.repo;
  const branch = process.env.GS_SNAPSHOT_BRANCH || DEFAULTS.branch;
  return { repo, branch, file: DEFAULTS.file };
}

function download(url, redirects) {
  const hops = redirects || 0;
  if (hops > 5) return Promise.reject(new Error('too many redirects'));
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, hops + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Minimal tar reader: walk 512-byte headers, return the contents of `want`.
function readTarEntry(buffer, want) {
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.slice(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end of archive
    const name = header.slice(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeField = header.slice(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    offset += 512;
    const body = buffer.slice(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    // Archives are prefixed with "<repo>-<branch>/".
    if (name.endsWith(want) || name === want) return body;
  }
  return null;
}

async function fetchSnapshot() {
  const { repo, branch, file } = config();
  const url = `https://codeload.github.com/${repo}/tar.gz/refs/heads/${branch}`;
  const gz = await download(url);
  const tar = zlib.gunzipSync(gz);
  const entry = readTarEntry(tar, file);
  if (!entry) return null;
  const text = entry.toString('utf8');
  JSON.parse(text); // throws on invalid JSON — caller treats as "no snapshot"
  return text;
}

// Returns { restored: boolean, reason?: string }
async function restoreInto(targetDir) {
  if (!enabled()) return { restored: false, reason: 'disabled' };
  const target = path.join(targetDir, 'aethel.json');
  try {
    if (fs.existsSync(target) && fs.statSync(target).size > 2) {
      return { restored: false, reason: 'local dataset already present' };
    }
  } catch (_) { /* fall through and try */ }

  let text;
  try {
    text = await fetchSnapshot();
  } catch (err) {
    return { restored: false, reason: 'snapshot branch unavailable: ' + (err && err.message) };
  }
  if (!text) return { restored: false, reason: 'snapshot file not found in branch' };

  fs.mkdirSync(targetDir, { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, target); // atomic adopt
  return { restored: true };
}

module.exports = { enabled, config, fetchSnapshot, restoreInto, DEFAULTS };
