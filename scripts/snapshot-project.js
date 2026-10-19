'use strict';
// Projects an admin snapshot export onto the public whitelist and writes the
// publishable payload. Exits non-zero (refusing to write) when the payload is
// not publishable. Usage: node snapshot-project.js <export.json> <out.json>
const fs = require('fs');
const path = require('path');
const policy = require(path.join(__dirname, '..', 'lib', 'snapshot-policy.js'));

const [exportFile, outFile] = process.argv.slice(2);
if (!exportFile || !outFile) {
  console.error('usage: snapshot-project.js <export.json> <out.json>');
  process.exit(2);
}

const payload = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
if (!payload.ok || !payload.data) {
  console.error('unexpected export shape');
  process.exit(1);
}

// The export endpoint already whitelists; if it ever returned the internal
// scope, the policy below still refuses to publish it.
if (payload.data.scope && payload.data.scope !== 'public-whitelisted') {
  console.error('REFUSING TO COMMIT: export scope "' + payload.data.scope + '" is not publishable');
  process.exit(1);
}

let publicSnapshot;
try {
  publicSnapshot = policy.buildPublicSnapshot(payload.data.data || {});
} catch (err) {
  console.error('REFUSING TO COMMIT: ' + err.message);
  process.exit(1);
}

const out = {
  version: payload.data.version,
  exported_at: payload.data.exported_at,
  backend: payload.data.backend,
  scope: 'public-whitelisted',
  counts: payload.data.counts,
  dropped_collections: publicSnapshot.dropped,
  data: publicSnapshot.data
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');

const records = Object.values(out.data).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0);
console.log('[snapshot-project] public snapshot: ' + records + ' records across ' +
  Object.keys(out.data).length + ' whitelisted collections');
console.log('[snapshot-project] dropped ' + Object.keys(publicSnapshot.dropped).length + ' non-public collections');
