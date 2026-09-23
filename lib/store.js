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
};

function load(name) {
  const file = path.join(STORE_DIR, name + '.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return JSON.parse(JSON.stringify(EMPTY[name]));
  }
}

function save(name, data) {
  const file = path.join(STORE_DIR, name + '.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

module.exports = { load, save, STORE_DIR };
