import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 10000);
const APP_TOKEN = (process.env.APP_TOKEN || '').trim();
const TZ = Number(process.env.DEFAULT_TIMEZONE_OFFSET_MINUTES || 480);
const pending = new Map();
const sessions = new Map();
const followups = [];

const merchants = Array.from({ length: 50 }, (_, i) => {
  const prev = 60000 + ((i * 7919) % 260000);
  const decline = i % 3 === 0 ? 0.31 + ((i % 7) * 0.035) : 0.04 + ((i % 6) * 0.03);
  const cur = Math.round(prev * (1 - decline));
  return {
    merchantId: `M${String(i + 1).padStart(4, '0')}`,
    merchantName: ['鑫源超市','鸿运便利店','万佳商行','新世纪餐饮','金海百货','青禾茶馆','星光酒店','天天生鲜','山城便利','宏达商贸'][i % 10] + (Math.floor(i / 10) + 1),
    manager: ['王经理','李经理','张经理','陈经理','刘经理'][i % 5],
    region: ['重庆','成都','深圳','广州','佛山'][i % 5],
    currentMonthVolume: cur,
    previousMonthVolume: prev,
    changeRate: Number((((cur - prev) / prev) * 100).toFixed(1))
  };
});

function send(res, status, obj, contentType = 'application/json; charset=utf-8') {
  const body = contentType.startsWith('application/json') ? JSON.stringify(obj) : String(obj);
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

async function readBody(req) {
  let s = '';
  for await (const c of req) {
    s += c;
    if (s.length > 262144) throw new Error('body too large');
  }
  return s ? JSON.parse(s) : {};
}

function auth(req) {
  return !APP_TOKEN || req.headers.authorization === `Bearer ${APP_TOKEN}`;
}

function reqId() {
  return 'req_' + crypto.randomUUID().replaceAll('-', '').slice(0, 16);
}

function money(n) {
  return `¥${Number(n).toLocaleString('zh-CN')}`;
}

function formatMerchants(ds, threshold = 30) {
  if (!ds.length) return `📊 商户经营分析\n\n没有发现流水下降 ${threshold}% 以上的商户。`;
  const show = ds.slice(0, 8);
  const avg = Math.abs(ds.reduce((s, m) => s + m.changeRate, 0) / ds.length).toFixed(1);
  const top = ds[0];
  const lines = show.map((m, i) => [
    `${i + 1}. ${m.merchantName}  ↓ ${Math.abs(m.changeRate)}%`,
    `   ${m.region} · ${m.manager}`,
    `   本月 ${money(m.currentMonthVolume)}  ｜  上月 ${money(m.previousMonthVolume)}`
  ].join('\n'));
  const more = ds.length > show.length ? `\n\n…另有 ${ds.length - show.length} 家未展开` : '';
  return [
    '📊 商户经营分析',
    '',
    `⚠️ 流水下降 ≥ ${threshold}%：${ds.length} 家`,
    `📉 平均降幅：${avg}%`,
    `🔻 最大降幅：${top.merchantName} ${Math.abs(top.changeRate)}%`,
    '',
    '重点商户',
    '────────────',
    lines.join('\n\n'),
    more,
    '',
    '💬 下一步可说：给前三家建立跟进任务'
  ].join('\n');
}

function isoLocal(base, dayOffset, hour, minute = 0) {
  const ms = base.getTime() + dayOffset * 86400000;
  const local = new Date(ms + TZ * 60000);
  const y = local.getUTCFullYear();
  const mo = String(local.getUTCMonth() + 1).padStart(2, '0');
  const d = String(local.getUTCDate()).padStart(2, '0');
  const sign = TZ >= 0 ? '+' : '-';
  const a = Math.abs(TZ);
  const oh = String(Math.floor(a / 60)).padStart(2, '0');
  const om = String(a % 60).padStart(2, '0');
  return `${y}-${mo}-${d}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00${sign}${oh}:${om}`;
}

function parseTime(text) {
  const now = new Date();
  let day = /后天/.test(text) ? 2 : /明天/.test(text) ? 1 : 0;
  let h = 9, m = 0;
  const mm = text.match(/(\d{1,2})\s*点(?:\s*(\d{1,2})\s*分)?/);
  if (mm) { h = Number(mm[1]); m = Number(mm[2] || 0); }
  if (/下午|晚上/.test(text) && h < 12) h += 12;
  return isoLocal(now, day, h, m);
}

function titleAfter(text, marker) {
  const t = text.split(marker).pop()?.trim() || text;
  return t.replace(/[。！!]+$/, '').replace(/^我/, '').trim();
}

function createFollowups(ids) {
  const ms = merchants.filter(x => ids.includes(x.merchantId));
  const created = [];
  for (const m of ms) {
    const row = { id: 'fu_' + crypto.randomUUID().slice(0, 8), merchantId: m.merchantId, merchantName: m.merchantName, manager: m.manager, status: 'todo', createdAt: new Date().toISOString() };
    followups.push(row);
    created.push(row);
  }
  return { ms, created };
}

function plan(text, sid) {
  const session = sessions.get(sid) || {};

  if (/^(确认|确认执行|执行|确定|同意|可以执行)[。！!]?$/i.test(text) && session.pendingFollowupIds?.length) {
    const { ms } = createFollowups(session.pendingFollowupIds);
    sessions.set(sid, { ...session, pendingFollowupIds: [] });
    return {
      message: `✅ 已执行\n\n已创建 ${ms.length} 条商户跟进任务：\n\n${ms.map((x,i)=>`${i+1}. ${x.merchantName} · ${x.manager}`).join('\n')}\n\n任务状态：待跟进`,
      action: { type: 'followup.executed', payload: { merchantIds: ms.map(x=>x.merchantId) }, requiresConfirmation: false, executionTarget: 'server' }
    };
  }

  if (/^(取消|取消执行|不用了|不执行)[。！!]?$/i.test(text) && session.pendingFollowupIds?.length) {
    sessions.set(sid, { ...session, pendingFollowupIds: [] });
    return { message: '已取消本次跟进任务创建。', action: { type: 'followup.cancelled', payload: {}, requiresConfirmation: false, executionTarget: 'server' } };
  }

  if (/流水|交易额|商户/.test(text) && /下降|降低|下滑/.test(text)) {
    const n = Number((text.match(/(\d+)\s*%/) || [])[1] || 30);
    const ds = merchants.filter(m => m.changeRate <= -n).sort((a, b) => a.changeRate - b.changeRate).slice(0, 20);
    sessions.set(sid, { ...session, ids: ds.map(x => x.merchantId), pendingFollowupIds: [] });
    return { message: formatMerchants(ds, n), action: { type: 'business.query', payload: { thresholdPct: n, merchants: ds }, requiresConfirmation: false, executionTarget: 'server' } };
  }

  if (/跟进任务|建立跟进|创建跟进|安排.*跟进/.test(text)) {
    const count = Number((text.match(/前\s*(\d+)\s*家?/) || [])[1] || 3);
    const ids = (session.ids || []).slice(0, count);
    if (!ids.length) return { message: '请先查询目标商户，例如：找出最近一个月流水下降30%以上的商户。', action: { type: 'ai.answer', payload: {}, requiresConfirmation: false, executionTarget: 'display' } };
    const ms = merchants.filter(x => ids.includes(x.merchantId));
    sessions.set(sid, { ...session, pendingFollowupIds: ids });
    return {
      message: `📌 准备创建跟进任务\n\n共 ${ms.length} 家：\n\n${ms.map((x,i)=>`${i+1}. ${x.merchantName}\n   ${x.region} · ${x.manager}`).join('\n\n')}\n\n⚠️ 这是写入操作，尚未执行。\n\n💬 请再说：确认执行\n或说：取消`,
      action: { type: 'followup.create', payload: { merchantIds: ids, merchants: ms }, requiresConfirmation: true, executionTarget: 'server' }
    };
  }

  if (/提醒/.test(text)) {
    const title = titleAfter(text, '提醒我');
    return { message: `⏰ 准备创建提醒\n\n${title}\n${parseTime(text)}`, action: { type: 'reminder.create', payload: { title, datetime: parseTime(text) }, requiresConfirmation: true, executionTarget: 'iphone' } };
  }

  if (/日历|会议|安排.*会/.test(text)) {
    const title = (text.match(/安排(.+?)(?:会议|$)/)?.[1] || '客户').trim() + '会议';
    return { message: `📅 准备创建日历\n\n${title}\n${parseTime(text)}`, action: { type: 'calendar.create', payload: { title, start: parseTime(text), durationMinutes: 60 }, requiresConfirmation: true, executionTarget: 'iphone' } };
  }

  if (/记一下|备忘|记住/.test(text)) {
    const content = text.replace(/^.*?(记一下|备忘|记住)[:：]?/, '').trim();
    return { message: `📝 备忘\n\n${content}`, action: { type: 'note.create', payload: { content }, requiresConfirmation: true, executionTarget: 'iphone' } };
  }

  const u = text.match(/https?:\/\/\S+/);
  if (u) return { message: `🔗 准备打开网址\n${u[0]}`, action: { type: 'url.open', payload: { url: u[0] }, requiresConfirmation: false, executionTarget: 'iphone' } };

  return { message: 'AI Action Mini 已收到。\n\n当前 MVP 支持：\n• 商户经营查询\n• 跟进任务\n• 提醒\n• 日历\n• 备忘\n• 网址识别', action: { type: 'ai.answer', payload: { answer: text }, requiresConfirmation: false, executionTarget: 'display' } };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return send(res, 200, { ok: true, name: 'AI Action Mini', version: '0.3.2', mode: 'iphone-mvp', time: new Date().toISOString() });
    }

    if (req.method === 'GET' && url.pathname === '/shortcut') {
      const text = String(url.searchParams.get('text') || '').trim();
      if (!text) return send(res, 400, '请提供 text 参数。', 'text/plain; charset=utf-8');
      const sid = `iphone:${url.searchParams.get('conversationId') || 'iphone13'}`;
      const p = plan(text, sid);
      return send(res, 200, p.message, 'text/plain; charset=utf-8');
    }

    if (url.pathname.startsWith('/api/v1/') && !auth(req)) return send(res, 401, { error: 'unauthorized' });

    if (req.method === 'POST' && url.pathname === '/api/v1/command') {
      const b = await readBody(req);
      const text = String(b.text || '').trim();
      if (!text) throw new Error('text is required');
      const id = reqId();
      const sid = `${b.user || 'owner'}:${b.conversationId || 'iphone13'}`;
      const p = plan(text, sid);
      if (p.action.requiresConfirmation && p.action.executionTarget === 'server') pending.set(id, p.action);
      return send(res, 200, { requestId: id, ...p });
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/execute') {
      const b = await readBody(req);
      if (!b.approved) {
        pending.delete(b.requestId);
        return send(res, 200, { status: 'cancelled', message: '已取消。' });
      }
      const a = pending.get(b.requestId);
      if (!a) throw new Error('pending request not found');
      pending.delete(b.requestId);
      if (a.type === 'followup.create') {
        const { ms, created } = createFollowups(a.payload.merchantIds);
        return send(res, 200, { status: 'executed', message: `已创建 ${ms.length} 条商户跟进任务。`, result: { followups: created } });
      }
      throw new Error('unsupported action');
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/followups') return send(res, 200, { followups });

    if (req.method === 'GET') {
      const html = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
      return send(res, 200, html, 'text/html; charset=utf-8');
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 400, { error: e?.message || 'unknown error' });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`AI Action Mini v0.3.2 listening on ${PORT}`));
