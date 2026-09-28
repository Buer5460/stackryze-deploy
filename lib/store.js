// Minimal JSON-file persistence for V1.0 admin/review/import data.
// In-memory fallback if the file is missing (e.g. fresh clone before migration).
const fs = require('fs');
const path = require('path');

const STORE_DIR = path.join(__dirname, '..', 'data', 'store');
fs.mkdirSync(STORE_DIR, { recursive: true });

const EMPTY = {
  agreements: { version: '1.0.0', agreements: [] },
  queue: { version: '1.0.0', items: [] },
  imports: { version: '1.0.0', schools: [], history: [] },
  corrections: { version: '1.0.1', items: [] },
  config: { version: '1.0.1', review_cycles_months: { tuition: 6, deadlines: 4, scholarships: 4, basics: 12 } }
};

function load(name) {
  const file = path.join(STORE_DIR, name + '.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    // Top-level known stores fall back to their seed; growth sub-stores fall
    // back to an empty object (growth.js seeds them explicitly on load).
    if (name in EMPTY) return JSON.parse(JSON.stringify(EMPTY[name]));
    return {};
  }
}

function save(name, data) {
  const file = path.join(STORE_DIR, name + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

module.exports = { load, save, STORE_DIR };
