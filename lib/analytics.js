'use strict';

const crypto = require('crypto');
const net = require('net');
const express = require('express');
const db = require('./db');

const CONSENT_COOKIE = 'gs_analytics_consent';
const CONSENT_VERSION = '2026-10-v1';
const CONSENT_DAYS = 30;
const EVENT_DAYS = 30;
const TRACKABLE_PAGES = new Set([
  '/', '/student', '/agent', '/dbc', '/ads', '/institution',
  '/supplier/education', '/supplier/certification', '/supplier/visa', '/supplier/accommodation'
]);
const EVENT_NAMES = new Set([
  'page_view', 'content_clicked', 'cta_clicked', 'form_submitted',
  'search_submitted', 'signup_completed', 'demo_requested', 'feature_used'
]);
const TARGET_TYPES = new Set(['link', 'button', 'card', 'form', 'search', 'feature']);
const publicRouter = express.Router();

function privacyConfig() {
  const controllerName = String(process.env.ANALYTICS_CONTROLLER_NAME || '').trim().slice(0, 160);
  const contact = String(process.env.ANALYTICS_PRIVACY_CONTACT || '').trim().slice(0, 200);
  const configured = Boolean(controllerName && contact);
  return {
    enabled: process.env.ANALYTICS_ENABLED === 'true' && configured,
    configured,
    controller_name: controllerName,
    privacy_contact: contact,
    retention_days: EVENT_DAYS,
    consent_version: CONSENT_VERSION
  };
}

function normalizedIp(value) {
  let ip = String(value || '').trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return net.isIP(ip) ? ip : null;
}

function clientIp(req) {
  const remote = normalizedIp(req.socket && req.socket.remoteAddress);
  const clientIpHeader = String(process.env.ANALYTICS_CLIENT_IP_HEADER || '').trim().toLowerCase();
  if (/^[a-z0-9-]+$/.test(clientIpHeader)) {
    return normalizedIp(req.headers[clientIpHeader]) || remote;
  }
  const hops = Math.max(0, Math.min(10, Number.parseInt(process.env.ANALYTICS_TRUST_PROXY_HOPS || '0', 10) || 0));
  const rawForwarded = hops > 0 ? String(req.headers['x-forwarded-for'] || '') : '';
  const forwarded = rawForwarded.split(',').map(normalizedIp);
  if (remote && hops > 0 && forwarded.length && forwarded.every(Boolean)) {
    return forwarded[Math.max(0, forwarded.length - hops)] || remote;
  }
  return remote;
}

function cookieValue(req) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const split = cookie.trim().split('=');
    if (split.shift() === CONSENT_COOKIE) {
      try { return decodeURIComponent(split.join('=')); } catch (_) { return ''; }
    }
  }
  return '';
}

function consentFor(req) {
  const token = cookieValue(req);
  if (!/^[A-Za-z0-9_-]{40,80}$/.test(token)) return null;
  const digest = crypto.createHash('sha256').update(token).digest('hex');
  const record = db.stores.analytics_consents.byId(digest);
  if (!record || record.consent_version !== CONSENT_VERSION || Date.parse(record.expires_at) <= Date.now()) return null;
  return record;
}

function setConsentCookie(res, token) {
  const parts = [
    CONSENT_COOKIE + '=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=' + String(CONSENT_DAYS * 24 * 60 * 60)
  ];
  if (process.env.ANALYTICS_COOKIE_SECURE !== 'false') parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearConsentCookie(res) {
  const parts = [CONSENT_COOKIE + '=', 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (process.env.ANALYTICS_COOKIE_SECURE !== 'false') parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearVisitorData(visitorId) {
  for (const event of db.stores.analytics_events.filter((item) => item.visitor_id === visitorId)) {
    db.stores.analytics_events.remove(event.id);
  }
  for (const consent of db.stores.analytics_consents.filter((item) => item.visitor_id === visitorId)) {
    db.stores.analytics_consents.remove(consent.id);
  }
}

function pruneAnalytics() {
  const eventCutoff = Date.now() - EVENT_DAYS * 24 * 60 * 60 * 1000;
  for (const event of db.stores.analytics_events.all().slice()) {
    if (!Number.isFinite(Date.parse(event.created_at)) || Date.parse(event.created_at) < eventCutoff) {
      db.stores.analytics_events.remove(event.id);
    }
  }
  const consentCutoff = Date.now();
  for (const consent of db.stores.analytics_consents.all().slice()) {
    if (!Number.isFinite(Date.parse(consent.expires_at)) || Date.parse(consent.expires_at) <= consentCutoff) {
      clearVisitorData(consent.visitor_id);
    }
  }
}

setInterval(pruneAnalytics, 60 * 60 * 1000).unref();

function safeKey(value) {
  const key = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._:-]{0,79}$/.test(key) ? key : null;
}

function safeCampaign(value) {
  const campaign = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(campaign) ? campaign : null;
}

const rateWindows = new Map();
function rateLimit(req, res, next) {
  const key = clientIp(req) || 'unknown';
  const now = Date.now();
  const window = rateWindows.get(key);
  if (window && window.until > now && window.count >= 180) {
    return res.status(429).json({ ok: false, error: '请求过于频繁' });
  }
  if (!window || window.until <= now) rateWindows.set(key, { until: now + 60_000, count: 1 });
  else window.count += 1;
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [key, window] of rateWindows) if (window.until <= now) rateWindows.delete(key);
}, 60_000).unref();

publicRouter.get('/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const config = privacyConfig();
  const consent = config.enabled ? consentFor(req) : null;
  res.json({
    ok: true,
    data: {
      enabled: config.enabled,
      configured: config.configured,
      consented: Boolean(consent),
      controller_name: config.controller_name,
      privacy_contact: config.privacy_contact,
      retention_days: config.retention_days,
      policy_path: '/privacy'
    }
  });
});

publicRouter.post('/consent', rateLimit, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const accepted = req.body && req.body.consent === true;
  const existing = consentFor(req);
  if (!accepted) {
    if (existing) clearVisitorData(existing.visitor_id);
    clearConsentCookie(res);
    return res.json({ ok: true, data: { consented: false, deleted: Boolean(existing) } });
  }
  if (!privacyConfig().enabled) return res.status(503).json({ ok: false, error: '统计功能未配置运营主体和隐私联系渠道' });
  if (existing) return res.json({ ok: true, data: { consented: true } });

  const token = crypto.randomBytes(36).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + CONSENT_DAYS * 24 * 60 * 60 * 1000);
  const digest = crypto.createHash('sha256').update(token).digest('hex');
  db.stores.analytics_consents.insert({
    id: digest,
    visitor_id: crypto.randomUUID(),
    consent_version: CONSENT_VERSION,
    consented_at: now.toISOString(),
    expires_at: expires.toISOString()
  });
  setConsentCookie(res, token);
  res.json({ ok: true, data: { consented: true } });
});

publicRouter.post('/events', rateLimit, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!privacyConfig().enabled) return res.status(503).json({ ok: false, error: '统计功能未启用' });
  const consent = consentFor(req);
  if (!consent) return res.status(403).json({ ok: false, error: '未同意统计或授权已失效' });

  const body = req.body || {};
  const eventName = String(body.event || '');
  const page = String(body.page || '');
  if (!EVENT_NAMES.has(eventName) || !TRACKABLE_PAGES.has(page)) {
    return res.status(400).json({ ok: false, error: '统计事件不在允许范围内' });
  }
  const targetType = TARGET_TYPES.has(body.target_type) ? body.target_type : null;
  const targetKey = safeKey(body.target_key);
  const contentId = /^[A-Z0-9_-]{3,80}$/.test(String(body.content_id || '')) ? String(body.content_id) : null;
  const campaign = {};
  for (const key of ['source', 'medium', 'campaign', 'content']) {
    const value = safeCampaign(body.campaign && body.campaign[key]);
    if (value) campaign[key] = value;
  }

  const createdAt = new Date().toISOString();
  db.stores.analytics_events.insert({
    id: crypto.randomUUID(),
    visitor_id: consent.visitor_id,
    event: eventName,
    page,
    target_type: targetType,
    target_key: targetKey,
    content_id: contentId,
    campaign,
    ip_address: clientIp(req),
    created_at: createdAt
  });
  res.status(202).json({ ok: true, data: { accepted: true } });
});

function getEvents(days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return db.stores.analytics_events.all()
    .filter((event) => Date.parse(event.created_at) >= cutoff)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

function summarize(days) {
  const events = getEvents(days);
  const visitors = new Map();
  const pages = new Map();
  const content = new Map();
  const sources = new Map();
  const daily = new Map();
  for (const event of events) {
    const date = String(event.created_at).slice(0, 10);
    if (!daily.has(date)) daily.set(date, { date, visitors: new Set(), page_views: 0, clicks: 0, searches: 0, form_submissions: 0 });
    const day = daily.get(date);
    day.visitors.add(event.visitor_id);
    if (!visitors.has(event.visitor_id)) {
      visitors.set(event.visitor_id, {
        visitor_id: event.visitor_id,
        ip_address: event.ip_address,
        first_seen: event.created_at,
        last_seen: event.created_at,
        page_views: 0,
        clicks: 0,
        events: 0
      });
    }
    const visitor = visitors.get(event.visitor_id);
    visitor.events += 1;
    if (Date.parse(event.created_at) < Date.parse(visitor.first_seen)) visitor.first_seen = event.created_at;
    if (Date.parse(event.created_at) > Date.parse(visitor.last_seen)) {
      visitor.last_seen = event.created_at;
      visitor.ip_address = event.ip_address;
    }
    if (event.event === 'page_view') {
      visitor.page_views += 1;
      day.page_views += 1;
      if (!pages.has(event.page)) pages.set(event.page, { page: event.page, views: 0, visitors: new Set() });
      const page = pages.get(event.page);
      page.views += 1;
      page.visitors.add(event.visitor_id);
      const campaign = event.campaign || {};
      const sourceKey = [campaign.source || 'direct', campaign.medium, campaign.campaign].filter(Boolean).join(' / ');
      if (!sources.has(sourceKey)) sources.set(sourceKey, { source: sourceKey, visits: 0, visitors: new Set() });
      const source = sources.get(sourceKey);
      source.visits += 1;
      source.visitors.add(event.visitor_id);
    }
    if (event.event === 'content_clicked' || event.event === 'cta_clicked') {
      visitor.clicks += 1;
      day.clicks += 1;
      const key = (event.target_key || 'unlabelled') + (event.content_id ? ':' + event.content_id : '');
      if (!content.has(key)) content.set(key, { target_key: event.target_key || 'unlabelled', content_id: event.content_id, clicks: 0, visitors: new Set() });
      const item = content.get(key);
      item.clicks += 1;
      item.visitors.add(event.visitor_id);
    }
    if (event.event === 'search_submitted') day.searches += 1;
    if (event.event === 'form_submitted') day.form_submissions += 1;
  }
  const dayList = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const item = daily.get(date) || { date, visitors: new Set(), page_views: 0, clicks: 0, searches: 0, form_submissions: 0 };
    dayList.push({ date, visitors: item.visitors.size, page_views: item.page_views, clicks: item.clicks, searches: item.searches, form_submissions: item.form_submissions });
  }
  const config = privacyConfig();
  return {
    enabled: config.enabled,
    configured: config.configured,
    retention_days: EVENT_DAYS,
    controller_name: config.controller_name,
    privacy_contact: config.privacy_contact,
    days,
    totals: {
      visitors: visitors.size,
      page_views: events.filter((event) => event.event === 'page_view').length,
      clicks: events.filter((event) => event.event === 'content_clicked' || event.event === 'cta_clicked').length,
      searches: events.filter((event) => event.event === 'search_submitted').length,
      form_submissions: events.filter((event) => event.event === 'form_submitted').length
    },
    daily: dayList,
    pages: Array.from(pages.values()).map((item) => ({ page: item.page, views: item.views, visitors: item.visitors.size })).sort((a, b) => b.views - a.views).slice(0, 12),
    content: Array.from(content.values()).map((item) => ({ target_key: item.target_key, content_id: item.content_id, clicks: item.clicks, visitors: item.visitors.size })).sort((a, b) => b.clicks - a.clicks).slice(0, 20),
    sources: Array.from(sources.values()).map((item) => ({ source: item.source, visits: item.visits, visitors: item.visitors.size })).sort((a, b) => b.visits - a.visits).slice(0, 12),
    visitors: Array.from(visitors.values()).sort((a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen)).slice(0, 100)
  };
}

function adminSummary(req, res) {
  const days = Math.max(1, Math.min(EVENT_DAYS, Number.parseInt(req.query.days || '7', 10) || 7));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, data: summarize(days) });
}

function adminEvents(req, res) {
  const days = Math.max(1, Math.min(EVENT_DAYS, Number.parseInt(req.query.days || '7', 10) || 7));
  const limit = Math.max(1, Math.min(200, Number.parseInt(req.query.limit || '50', 10) || 50));
  const ip = String(req.query.ip || '').trim().slice(0, 64);
  const page = TRACKABLE_PAGES.has(String(req.query.page || '')) ? String(req.query.page) : '';
  const visitorId = /^[a-f0-9-]{36}$/i.test(String(req.query.visitor_id || '')) ? String(req.query.visitor_id) : '';
  const events = getEvents(days).filter((event) =>
    (!ip || String(event.ip_address || '').includes(ip)) &&
    (!page || event.page === page) &&
    (!visitorId || event.visitor_id === visitorId)
  ).slice(0, limit);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, data: events });
}

function adminDeleteVisitor(req, res) {
  const visitorId = String(req.params.visitorId || '');
  if (!/^[a-f0-9-]{36}$/i.test(visitorId)) return res.status(400).json({ ok: false, error: '访客编号格式错误' });
  const before = db.stores.analytics_events.size;
  clearVisitorData(visitorId);
  const deleted = before - db.stores.analytics_events.size;
  require('./audit').record({
    actor: req.actor && req.actor.user,
    action: 'analytics:visitor_delete',
    entity: 'analytics_visitor',
    entity_id: visitorId,
    to: { deleted_events: deleted }
  });
  res.json({ ok: true, data: { deleted_events: deleted } });
}

module.exports = {
  publicRouter,
  pruneAnalytics,
  clientIp,
  adminSummary,
  adminEvents,
  adminDeleteVisitor
};
