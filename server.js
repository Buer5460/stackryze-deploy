const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));

const readJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, relativePath), 'utf8'));

const reference = readJson('data/reference.json');
const schools = readJson('data/schools.demo.json');

const seed = {
  profile: {
    name: '陈小雨',
    education: '本科大三',
    gpa: '3.5/4.0',
    english: 'IELTS 6.5',
    budget: '25万/年',
    country: '新加坡 / 英国',
    completion: 72
  },
  programs: [
    {
      id: 1,
      school: '南洋国际学院（演示）',
      country: '新加坡',
      program: '数据科学硕士',
      degree: '硕士',
      lang: 'IELTS 6.5',
      fee: 188000,
      scholarship: 30000,
      deadline: '2026-11-30',
      fit: '符合已知条件'
    },
    {
      id: 2,
      school: '海峡商学院（演示）',
      country: '新加坡',
      program: '国际商务本科',
      degree: '本科',
      lang: 'IELTS 6.0',
      fee: 128000,
      scholarship: 20000,
      deadline: '2026-12-15',
      fit: '资料不足'
    },
    {
      id: 3,
      school: '英伦创新大学（演示）',
      country: '英国',
      program: '金融科技硕士',
      degree: '硕士',
      lang: 'IELTS 6.5',
      fee: 236000,
      scholarship: 25000,
      deadline: '2027-01-20',
      fit: '符合已知条件'
    }
  ],
  clients: [
    { id: 101, name: '陈小雨', source: '机构专属二维码', owner: '王老师', stage: '材料准备', completion: 82 },
    { id: 102, name: '李晨', source: '自然注册后授权', owner: '周老师', stage: '院校受理', completion: 91 }
  ],
  applications: [
    {
      id: 'APP-260901',
      student: '陈小雨',
      programId: 1,
      agency: '环球学桥（演示）',
      school: '南洋国际学院（演示）',
      status: '材料准备',
      progress: 42,
      commission: 9800
    },
    {
      id: 'APP-260823',
      student: '李晨',
      programId: 3,
      agency: '环球学桥（演示）',
      school: '英伦创新大学（演示）',
      status: '院校受理',
      progress: 68,
      commission: 12500
    }
  ],
  audits: [
    { id: 1, type: '奖学金', name: '2027春季优秀新生减免', org: '海峡商学院（演示）', status: '待审核' },
    { id: 2, type: '机构认证', name: '新加坡启航教育（演示）', org: 'B端机构', status: '待审核' }
  ]
};

let db = JSON.parse(JSON.stringify(seed));
const ok = (data, meta) => (meta ? { ok: true, data, meta } : { ok: true, data });

function boolQuery(value) {
  if (value === undefined) return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

function includesCI(value, query) {
  return String(value || '').toLowerCase().includes(String(query || '').toLowerCase());
}

function listSchools(query) {
  let list = [...schools];

  if (query.q) {
    list = list.filter((s) =>
      [s.name, s.country, s.city, s.district, s.institutionType, ...(s.curricula || []), ...(s.stages || [])]
        .some((v) => includesCI(v, query.q))
    );
  }
  if (query.country) list = list.filter((s) => includesCI(s.country, query.country));
  if (query.city) list = list.filter((s) => includesCI(s.city, query.city));
  if (query.district) list = list.filter((s) => includesCI(s.district, query.district));
  if (query.stage) list = list.filter((s) => (s.stages || []).some((v) => includesCI(v, query.stage)));
  if (query.curriculum) list = list.filter((s) => (s.curricula || []).some((v) => includesCI(v, query.curriculum)));
  if (query.language) list = list.filter((s) => includesCI(s.mainLanguage, query.language));
  if (query.institutionType) list = list.filter((s) => includesCI(s.institutionType, query.institutionType));

  const minFee = Number(query.minFee);
  if (query.minFee !== undefined && Number.isFinite(minFee)) {
    list = list.filter((s) => Number(s.tuitionMax || s.tuitionMin || 0) >= minFee);
  }

  const maxFee = Number(query.maxFee);
  if (query.maxFee !== undefined && Number.isFinite(maxFee)) {
    list = list.filter((s) => Number(s.tuitionMin || s.tuitionMax || 0) <= maxFee);
  }

  const scholarship = boolQuery(query.scholarship);
  if (scholarship !== undefined) list = list.filter((s) => Boolean(s.scholarship) === scholarship);

  const boarding = boolQuery(query.boarding);
  if (boarding !== undefined) list = list.filter((s) => Boolean(s.boarding) === boarding);

  if (query.verifiedOnly === 'true') list = list.filter((s) => s.verifiedStatus === 'verified');

  return list;
}

app.get('/api/health', (req, res) =>
  res.json(ok({
    status: 'ok',
    service: 'global-study-mobile-mvp',
    version: '0.5.0',
    dataFoundation: true,
    demoSchools: schools.length
  }))
);

app.get('/api/reference', (req, res) => res.json(ok(reference)));

app.get('/api/bootstrap', (req, res) =>
  res.json(ok({
    ...db,
    reference,
    schools
  }))
);

app.get('/api/schools', (req, res) => {
  const filtered = listSchools(req.query);
  const page = Math.max(1, Number.parseInt(req.query.page || '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.pageSize || '20', 10) || 20));
  const start = (page - 1) * pageSize;
  const data = filtered.slice(start, start + pageSize);

  res.json(ok(data, {
    total: filtered.length,
    page,
    pageSize,
    demoOnly: data.every((s) => s.isDemo === true)
  }));
});

app.get('/api/schools/:id', (req, res) => {
  const school = schools.find((s) => s.id === req.params.id);
  if (!school) return res.status(404).json({ ok: false, error: '学校不存在' });
  res.json(ok(school));
});

app.get('/api/programs', (req, res) => {
  let list = [...db.programs];
  if (req.query.q) list = list.filter((p) => [p.school, p.program, p.country].some((v) => includesCI(v, req.query.q)));
  if (req.query.country) list = list.filter((p) => includesCI(p.country, req.query.country));
  if (req.query.degree) list = list.filter((p) => includesCI(p.degree, req.query.degree));
  res.json(ok(list));
});

app.post('/api/applications', (req, res) => {
  const p = db.programs.find((x) => x.id === Number(req.body.programId));
  if (!p) return res.status(400).json({ ok: false, error: '项目不存在' });
  if (!req.body.student) return res.status(400).json({ ok: false, error: '学生姓名必填' });

  if (db.applications.some((a) => a.student === req.body.student && a.programId === p.id)) {
    return res.status(409).json({ ok: false, error: '该项目已申请' });
  }

  const x = {
    id: 'APP-' + Date.now().toString().slice(-6),
    student: req.body.student,
    programId: p.id,
    agency: req.body.agency || '待授权机构',
    school: p.school,
    status: '材料准备',
    progress: 18,
    commission: Math.round(p.fee * 0.05)
  };
  db.applications.unshift(x);
  res.status(201).json(ok(x));
});

app.patch('/api/applications/:id', (req, res) => {
  const x = db.applications.find((a) => a.id === req.params.id);
  if (!x) return res.status(404).json({ ok: false, error: '申请不存在' });
  Object.assign(x, req.body);
  res.json(ok(x));
});

app.post('/api/clients', (req, res) => {
  if (!req.body.name) return res.status(400).json({ ok: false, error: '姓名必填' });
  const x = {
    id: Date.now(),
    name: req.body.name,
    source: '机构专属邀请',
    owner: req.body.owner || '王老师',
    stage: '待建档',
    completion: 10
  };
  db.clients.unshift(x);
  res.status(201).json(ok(x));
});

app.patch('/api/audits/:id', (req, res) => {
  const x = db.audits.find((a) => a.id === Number(req.params.id));
  if (!x) return res.status(404).json({ ok: false, error: '审核事项不存在' });
  x.status = req.body.status || x.status;
  res.json(ok(x));
});

app.post('/api/reset', (req, res) => {
  db = JSON.parse(JSON.stringify(seed));
  res.json(ok({ reset: true }));
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (require.main === module) {
  app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('GlobalStudy MVP V0.5 running'));
}

module.exports = { app, reference, schools, listSchools };
