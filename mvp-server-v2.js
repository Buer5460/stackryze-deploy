import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 10000);
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

function send(res,status,data,type='text/plain; charset=utf-8'){
  const body = type.startsWith('application/json') ? JSON.stringify(data) : String(data);
  res.writeHead(status,{'content-type':type,'cache-control':'no-store','access-control-allow-origin':'*','content-length':Buffer.byteLength(body)});
  res.end(body);
}
const money=n=>`¥${Number(n).toLocaleString('zh-CN')}`;
const sidOf=url=>`iphone:${url.searchParams.get('conversationId')||'iphone13'}`;

function formatMerchants(ds,threshold=30){
  if(!ds.length) return `📊 商户经营分析\n\n没有发现流水下降 ${threshold}% 以上的商户。`;
  const show=ds.slice(0,8);
  const avg=Math.abs(ds.reduce((s,m)=>s+m.changeRate,0)/ds.length).toFixed(1);
  return [
    '📊 商户经营分析','',
    `⚠️ 流水下降 ≥ ${threshold}%：${ds.length} 家`,
    `📉 平均降幅：${avg}%`,
    `🔻 最大降幅：${ds[0].merchantName} ${Math.abs(ds[0].changeRate)}%`,'',
    '重点商户','────────────',
    show.map((m,i)=>`${i+1}. ${m.merchantName}  ↓ ${Math.abs(m.changeRate)}%\n   ${m.region} · ${m.manager}\n   本月 ${money(m.currentMonthVolume)} ｜ 上月 ${money(m.previousMonthVolume)}`).join('\n\n'),
    ds.length>show.length?`\n…另有 ${ds.length-show.length} 家未展开`:'','',
    '💬 下一步可说：给前三家建立跟进任务'
  ].join('\n');
}

function createFollowups(ids){
  const ms=merchants.filter(x=>ids.includes(x.merchantId));
  for(const m of ms){
    followups.push({id:'fu_'+crypto.randomUUID().slice(0,8),merchantId:m.merchantId,merchantName:m.merchantName,manager:m.manager,region:m.region,status:'todo',createdAt:new Date().toISOString()});
  }
  return ms;
}

function plan(text,sid){
  const session=sessions.get(sid)||{};
  if(/流水|交易额|商户/.test(text)&&/下降|降低|下滑/.test(text)){
    const n=Number((text.match(/(\d+)\s*%/)||[])[1]||30);
    const ds=merchants.filter(m=>m.changeRate<=-n).sort((a,b)=>a.changeRate-b.changeRate).slice(0,20);
    sessions.set(sid,{...session,ids:ds.map(x=>x.merchantId),pendingFollowupIds:[]});
    return {message:formatMerchants(ds,n),requiresConfirmation:false};
  }
  if(/跟进任务|建立跟进|创建跟进|安排.*跟进/.test(text)){
    const count=Number((text.match(/前\s*(\d+)\s*家?/)||[])[1]||3);
    const ids=(session.ids||[]).slice(0,count);
    if(!ids.length) return {message:'请先查询目标商户，例如：找出最近一个月流水下降30%以上的商户。',requiresConfirmation:false};
    const ms=merchants.filter(x=>ids.includes(x.merchantId));
    sessions.set(sid,{...session,pendingFollowupIds:ids});
    return {message:`📌 准备创建跟进任务\n\n共 ${ms.length} 家：\n\n${ms.map((x,i)=>`${i+1}. ${x.merchantName}\n   ${x.region} · ${x.manager}`).join('\n\n')}\n\n⚠️ 这是写入操作，尚未执行。`,requiresConfirmation:true};
  }
  if(/提醒/.test(text)) return {message:`⏰ 已识别提醒请求\n\n${text}\n\n下一阶段接入 iPhone 原生提醒事项。`,requiresConfirmation:false};
  if(/日历|会议/.test(text)) return {message:`📅 已识别日历请求\n\n${text}`,requiresConfirmation:false};
  if(/记一下|备忘|记住/.test(text)) return {message:`📝 已识别备忘请求\n\n${text}`,requiresConfirmation:false};
  return {message:'AI Action Mini 已收到。\n\n当前支持：商户经营查询、跟进任务、提醒、日历、备忘、网址识别。',requiresConfirmation:false};
}

const server=http.createServer((req,res)=>{
  try{
    const url=new URL(req.url||'/','http://localhost');
    if(req.method==='GET'&&url.pathname==='/api/health') return send(res,200,{ok:true,name:'AI Action Mini',version:'0.4.0',mode:'iphone-mvp'},'application/json; charset=utf-8');

    if(req.method==='GET'&&url.pathname==='/shortcut'){
      const text=String(url.searchParams.get('text')||'').trim();
      if(!text) return send(res,400,'请提供 text 参数。');
      const p=plan(text,sidOf(url));
      return send(res,200,p.message);
    }

    // Fixed endpoints used by iOS “Choose from Menu”. No second voice command needed.
    if(req.method==='GET'&&url.pathname==='/shortcut-confirm'){
      const sid=sidOf(url); const session=sessions.get(sid)||{};
      const ids=session.pendingFollowupIds||[];
      if(!ids.length) return send(res,200,'没有待确认的跟进任务，请先执行“给前三家建立跟进任务”。');
      const ms=createFollowups(ids);
      sessions.set(sid,{...session,pendingFollowupIds:[]});
      return send(res,200,`✅ 已执行\n\n已创建 ${ms.length} 条商户跟进任务：\n\n${ms.map((x,i)=>`${i+1}. ${x.merchantName} · ${x.manager}`).join('\n')}\n\n任务状态：待跟进`);
    }

    if(req.method==='GET'&&url.pathname==='/shortcut-cancel'){
      const sid=sidOf(url); const session=sessions.get(sid)||{};
      sessions.set(sid,{...session,pendingFollowupIds:[]});
      return send(res,200,'已取消本次跟进任务创建。');
    }

    if(req.method==='GET'&&url.pathname==='/api/v1/followups') return send(res,200,{followups},'application/json; charset=utf-8');

    if(req.method==='GET'){
      const html=fs.readFileSync(path.resolve('public/index.html'),'utf8');
      return send(res,200,html,'text/html; charset=utf-8');
    }
    return send(res,404,'not found');
  }catch(e){return send(res,400,e?.message||'unknown error');}
});

server.listen(PORT,'0.0.0.0',()=>console.log(`AI Action Mini v0.4.0 listening on ${PORT}`));
