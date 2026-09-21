const assert = require('node:assert/strict');
const { reference, schools, listSchools } = require('../server');

assert.equal(reference.version, '0.5.0');
assert.ok(Array.isArray(reference.locations) && reference.locations.length >= 3);
assert.ok(Array.isArray(reference.curriculumFamilies) && reference.curriculumFamilies.length >= 5);
assert.equal(schools.length, 20);
assert.ok(schools.every((s) => s.isDemo === true));
assert.ok(schools.every((s) => s.verifiedStatus === 'demo'));

const singapore = listSchools({ country: 'Singapore' });
assert.equal(singapore.length, 8);

const ib = listSchools({ curriculum: 'IB' });
assert.ok(ib.length >= 3);

const shanghaiPrimary = listSchools({ city: 'Shanghai', stage: 'primary' });
assert.ok(shanghaiPrimary.length >= 1);

const boarding = listSchools({ boarding: 'true' });
assert.ok(boarding.length >= 1);

const combined = listSchools({
  country: 'Singapore',
  district: 'Bukit Timah',
  stage: 'primary',
  curriculum: 'IB'
});
assert.equal(combined.length, 1);
assert.equal(combined[0].id, 'SG-DEMO-001');

console.log('V0.5 smoke tests passed');
