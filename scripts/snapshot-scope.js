'use strict';
// Prints the scope of a snapshot export payload (for shell-side validation).
const fs = require('fs');
const file = process.argv[2];
if (!file) process.exit(2);
try {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  process.stdout.write((d.data && d.data.scope) || '');
} catch (_) {
  process.exit(1);
}
