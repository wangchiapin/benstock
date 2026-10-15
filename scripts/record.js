#!/usr/bin/env node
// 往後記錄：每天收盤後，把網頁排名的前 N 檔記下來（記下之後不再更改），
// 之後每次執行就用最新的價格，自動算這些股票買進後的實際賺賠。
// 用法：node scripts/record.js 歷史檔.json index.html data/forward.json [--asof 2026-10-15]
//   --asof 只用來測試：假裝資料只到那一天。
//
// 算法跟回測一樣：
//   - 當天收盤後記錄，隔天開盤買進（開盤漲停買不到、停牌就標「沒買到」）
//   - 持有 10 / 20 個交易日後收盤賣出，扣手續費 0.1425%×2 和證交稅 0.3%
//   - 對照組：同一天基本門檻合格的全部股票，同樣買賣
const fs = require('fs');

const args = process.argv.slice(2);
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--asof'));
const [histPath, htmlPath, outPath] = pos;
if (!histPath || !htmlPath || !outPath) {
  console.error('用法：node scripts/record.js 歷史檔.json index.html 輸出.json [--asof 日期]');
  process.exit(2);
}
const asofIdx = args.indexOf('--asof');
const asof = asofIdx >= 0 ? args[asofIdx + 1] : null;

const html = fs.readFileSync(htmlPath, 'utf8');
const mm = html.match(/\/\/<core>([\s\S]*?)\/\/<\/core>/);
if (!mm) { console.error('index.html 裡找不到 //<core> 區塊'); process.exit(2); }
const { runAll, DEFAULT_CFG, DEFAULT_ON } = new Function(mm[1] + ';return {runAll,DEFAULT_CFG,DEFAULT_ON};')();

const H = JSON.parse(fs.readFileSync(histPath, 'utf8'));
const dates = H.dates, mk = H.market.closes, stocks = H.stocks;
let T = dates.length;
if (asof) {
  const i = dates.indexOf(asof);
  if (i < 0) { console.error('--asof 的日期不在資料裡：' + asof); process.exit(2); }
  T = i + 1;
}
const HOLDS = [10, 20];
const BUY_FEE = 0.001425, SELL_FEE = 0.001425, TAX = 0.003;
const WARM = 125, WIN = 130;
const OK_STATES = new Set(['strong', 'weakening']);

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const round2 = x => Math.round(x * 100) / 100;
const net = (entry, exit) => (exit * (1 - SELL_FEE - TAX)) / (entry * (1 + BUY_FEE)) - 1;
const byCode = new Map(stocks.map(s => [s.code, s]));

function evalAt(t) {
  const list = [];
  for (const st of stocks) {
    if (st.t || st.s > t || st.e < t) continue;   // t=1：只供自選追蹤的 ETF，不進排名
    const idx = t - st.s;
    if (idx < WARM) continue;
    const a = Math.max(0, idx - WIN + 1), b = idx + 1;
    list.push({ code: st.code, name: st.name, full: st, div: st.div, divDate: st.divDate,
      closes: st.closes.slice(a, b), highs: st.highs.slice(a, b), lows: st.lows.slice(a, b), vols: st.vols.slice(a, b) });
  }
  return runAll({ market: { closes: mk.slice(0, t + 1) }, stocks: list }, DEFAULT_CFG, DEFAULT_ON);
}

// 第 t 天收盤後選到，隔天開盤買。回傳買進資訊，買不到回傳 null
function entryOf(st, t) {
  if (!st || t + 1 > T - 1) return null;
  const k1 = t + 1 - st.s;
  if (k1 < 0 || t + 1 > st.e || st.vols[k1] === 0 || t - st.s < 0) return null;
  const prevClose = st.closes[t - st.s], entry = st.opens[k1];
  if (!(entry > 0) || entry >= prevClose * 1.095) return null;
  return entry;
}
// 買進後持有 h 天，用第 t+h 天收盤賣（h 要在資料範圍內）
function retAt(st, t, h) {
  const entry = entryOf(st, t);
  if (entry === null || t + h > T - 1) return null;
  const j = Math.min(t + h, st.e);
  return net(entry, st.closes[j - st.s]);
}

let prev = {};
try { prev = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (e) { prev = {}; }
const picks = prev.picks || {};

// 今天的前 N 檔：只在還沒記錄過時才記，記下就不改
const lastDate = dates[T - 1];
let newToday = false;
if (!picks[lastDate]) {
  const res = evalAt(T - 1);
  if (res.market) {
    const N = Math.max(1, Math.round(DEFAULT_CFG.topN));
    const ranked = res.rows.filter(x => x.ev.pass).sort((a, b) => b.ev.rank - a.ev.rank).slice(0, N);
    if (ranked.length) {
      picks[lastDate] = { state: res.market.state, items: ranked.map((x, i) => ({ code: x.s.code, name: x.s.name, rank: i + 1 })) };
      newToday = true;
    }
  }
}

// 把每一天的記錄，用最新價格算出成績
const days = [];
for (const date of Object.keys(picks).sort()) {
  const t = dates.indexOf(date);
  const rec = picks[date];
  if (t < 0 || t >= T) {
    const old = (prev.days || []).find(d => d.date === date);
    if (old) days.push(old);
    continue;
  }
  const avail = T - 1 - t;   // 買進後已經過幾個交易日（買進日算第 0 天）
  const res = avail >= 1 ? evalAt(t) : null;
  const gate = res ? res.rows.filter(x => x.ev.chk.liq && x.ev.chk.price && x.ev.chk.safe) : [];
  const base = {};
  for (const h of [...HOLDS, 'sofar']) {
    const hh = h === 'sofar' ? avail : h;
    if (hh < 1 || hh > avail) { base[h] = null; continue; }
    const rs = [];
    for (const x of gate) { const r = retAt(x.s.full, t, hh); if (r !== null) rs.push(r); }
    base[h] = rs.length ? round2(mean(rs) * 100) : null;
  }
  const items = rec.items.map(it => {
    const st = byCode.get(it.code);
    const out = { code: it.code, name: it.name, rank: it.rank };
    if (avail < 1) return Object.assign(out, { status: 'wait' });
    const entry = entryOf(st, t);
    if (entry === null) return Object.assign(out, { status: 'unfilled' });
    const k1 = t + 1 - st.s;
    out.entry = round2(entry);
    out.entryDate = dates[t + 1];
    out.days = avail;
    const sofar = retAt(st, t, avail);
    out.sofar = sofar === null ? null : round2(sofar * 100);
    for (const h of HOLDS) {
      const r = retAt(st, t, h);
      out['r' + h] = r === null ? null : round2(r * 100);
    }
    out.status = avail >= 20 ? 'done' : 'open';
    return out;
  });
  const filled = items.filter(x => x.sofar !== null && x.sofar !== undefined);
  days.push({
    date, state: rec.state, avail, items, base,
    sofarAvg: filled.length ? round2(mean(filled.map(x => x.sofar))) : null
  });
}

// 總成績：滿 10 天、滿 20 天各一份
const summary = {};
for (const h of HOLDS) {
  const rs = [], exs = [], bases = [];
  let nd = 0;
  for (const d of days) {
    if (d.avail < h) continue;
    const got = d.items.map(x => x['r' + h]).filter(v => v !== null && v !== undefined);
    if (!got.length) continue;
    nd++;
    for (const v of got) { rs.push(v); if (d.base[h] !== null) exs.push(v - d.base[h]); }
    if (d.base[h] !== null) bases.push(d.base[h]);
  }
  summary[h] = rs.length ? {
    days: nd, n: rs.length, win: round2(rs.filter(x => x > 0).length / rs.length * 100),
    avg: round2(mean(rs)), base: bases.length ? round2(mean(bases)) : null,
    excess: exs.length ? round2(mean(exs)) : null
  } : { days: 0, n: 0 };
}

const out = {
  generatedAt: new Date().toISOString(),
  lastDate, topN: Math.round(DEFAULT_CFG.topN),
  rule: '每天收盤後記錄排名前幾檔，隔天開盤買進，持有 10 或 20 個交易日後收盤賣出，已扣手續費和證交稅',
  picks, days, summary
};
const text = JSON.stringify(out);
// 沒有新記錄、也沒有新價格時不要重寫（避免每天產生沒意義的變動）
let same = false;
try { const o = JSON.parse(fs.readFileSync(outPath, 'utf8')); delete o.generatedAt; const c = JSON.parse(text); delete c.generatedAt; same = JSON.stringify(o) === JSON.stringify(c); } catch (e) { }
if (!same) fs.writeFileSync(outPath, text);
console.log(`${lastDate}：${newToday ? '已記錄今天的前 ' + out.topN + ' 檔' : '今天已記錄過或沒有合格股票'}；` +
  `共 ${days.length} 天記錄；滿 20 天的 ${summary[20].n} 筆；${same ? '沒有變動' : '已寫入'}`);
