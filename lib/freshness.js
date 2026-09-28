// Freshness / review-cycle engine (V1.0.1).
//
// Every verified record decays: tuition numbers go stale faster than an
// address, deadlines reset each admission season. Cycles live in
// data/store/config.json so admins can tune them without a code change —
// the numbers below are only the seed defaults.
//
// freshness values:
//   'fresh'      — all tracked categories are within their review cycle
//   'review_due' — at least one category passed its cycle (data stays visible,
//                  flagged for re-verification)
//   'expired'    — effective_to has passed, or a category is overdue by 2x its
//                  cycle. Hard-expired records must not be presented as
//                  current facts.

const store = require('./store');

const DEFAULT_REVIEW_CYCLES_MONTHS = {
  tuition: 6,        // 学费：6 个月复核
  deadlines: 4,      // 申请截止日期：每招生季复核（新加坡两个招生季，≈4 个月）
  scholarships: 4,   // 奖学金：每招生季复核
  basics: 12         // 地址 / 学校基础资料：12 个月复核
};

const MS_PER_MONTH = 30.44 * 24 * 3600 * 1000;

function monthSuffix(dateStr, months) {
  const d = new Date(String(dateStr) + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function loadConfig() {
  const data = store.load('config');
  return data.review_cycles_months || JSON.parse(JSON.stringify(DEFAULT_REVIEW_CYCLES_MONTHS));
}

function saveReviewCycles(cycles) {
  const data = store.load('config');
  data.review_cycles_months = cycles;
  store.save('config', data);
}

// Which tracked categories apply to a given school record.
function applicableCategories(school) {
  const cats = ['basics']; // address/name/type always tracked
  if (school.tuition_min !== null && school.tuition_min !== undefined) cats.push('tuition');
  if (school.tuition_max !== null && school.tuition_max !== undefined) cats.push('tuition');
  if (school.scholarships) cats.push('scholarships');
  return [...new Set(cats)];
}

function categoryDue(school, category, cycles) {
  const months = Number(cycles[category]);
  if (!Number.isFinite(months) || months <= 0) return null;
  const anchor = school.verified_at || school.updated_at || school.imported_at || null;
  if (!anchor) return null;
  return monthSuffix(String(anchor).slice(0, 10), months);
}

// Compute freshness for one school record. Returns null when the record is
// not verified (freshness only describes verified data).
function computeFreshness(school, cycles) {
  const conf = cycles || loadConfig();
  const status = String(school.verified_status || '').toLowerCase();
  if (status !== 'verified') return null;

  const today = new Date().toISOString().slice(0, 10);

  // Hard expiry from the record's own validity window.
  if (school.effective_to && String(school.effective_to) < today) {
    return { freshness: 'expired', reason: 'effective_to 已过期', due: school.effective_to, categories: {} };
  }

  const cats = {};
  let worst = 'fresh';
  for (const cat of applicableCategories(school)) {
    const due = categoryDue(school, cat, conf);
    if (!due) continue;
    const overdue = due < today;
    // 2x cycle past due = treat as expired (stale beyond tolerance).
    const hardDue = monthSuffix(due, Number(conf[cat]) || 0) || due;
    const hard = hardDue < today;
    cats[cat] = { review_due_on: due, state: hard ? 'expired' : overdue ? 'review_due' : 'fresh' };
    if (hard) worst = 'expired';
    else if (overdue && worst !== 'expired') worst = 'review_due';
  }
  return { freshness: worst, due: null, categories: cats };
}

module.exports = {
  DEFAULT_REVIEW_CYCLES_MONTHS,
  loadConfig,
  saveReviewCycles,
  computeFreshness,
  applicableCategories,
  monthSuffix
};
