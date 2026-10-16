#!/usr/bin/env node
// 實驗版往後記錄：原版排名，但排除「營收衰退」或「法人賣超」的股票。
// 用法：node scripts/record_exp.js 歷史檔.json index.html data data/forward-exp.json [--asof 2026-10-15]
//   --asof：假裝資料只到那一天（用來補記開始那天，或測試）。
//
// 規則（2026-10-16 定案，開始記錄後不再改；改了前面的記錄就作廢）：
//   1. 用原版排名（近 20 日漲幅 + 離 120 日高點的距離），不開「穩定配息」篩選（跟實驗回測一樣）
//   2. 排除：最新月營收年增率 < 0，或近 20 日三大法人買賣超 < 0。資料缺的不排除
//   3. 剩下的取前 10 檔
// 營收、法人的算法跟 scripts/backtest_exp.js 的 filter 組完全一樣。
// 買賣方式跟 scripts/record.js 一樣：隔天開盤買（漲停或停牌標「沒買到」），持有 10 / 20 個交易日收盤賣，
// 扣手續費和證交稅；對照組 = 同一天基本門檻合格的全部股票。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const args = process.argv.slice(2);
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--asof'));
const [histPath, htmlPath, dataDir, outPath] = pos;
if (!histPath || !htmlPath || !dataDir || !outPath) {
  console.error('用法：node scripts/record_exp.js 歷史檔.json index.html data 輸出.json [--asof 日期]');
  process.exit(2);
}
const asofIdx = args.indexOf('--asof');
const asof = asofIdx >= 0 ? args[asofIdx + 1] : null;

const html = fs.readFileSync(htmlPath, 'utf8');
const mm = html.match(/\/\/<core>([\s\S]*?)\/\/<\/core>/);
if (!mm) { console.error('index.html 裡找不到 //<core> 區塊'); process.exit(2); }
const { runAll, DEFAULT_CFG, DEFAULT_ON } = new Function(mm[1] + ';return {runAll,DEFAULT_CFG,DEFAULT_ON};')();
const ON = Object.assign({}, DEFAULT_ON, { div: false });   // 不開穩定配息篩選

const H = JSON.parse(fs.readFileSync(histPath, 'utf8'));
const dates = H.dates, mk = H.market.closes, stocks = H.stocks;
let T = dates.length;
if (asof) {
  const i = dates.indexOf(asof);
  if (i < 0) { console.error('--asof 的日期不在資料裡：' + asof); process.exit(2); }
  T = i + 1;
}
const TOP = 10, HOLDS = [10, 20];
const BUY_FEE = 0.001425, SELL_FEE = 0.001425, TAX = 0.003;
const WARM = 125, WIN = 130, INST_DAYS = 20, INST_MIN = 15, REV_MAX_AGE = 75;

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const round2 = x => Math.round(x * 100) / 100;
const net = (entry, exit) => (exit * (1 - SELL_FEE - TAX)) / (entry * (1 + BUY_FEE)) - 1;
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const byCode = new Map(stocks.map(s => [s.code, s]));

// ── 三大法人（同 backtest_exp.js）：只讀記錄日附近 60 天就夠（舊記錄的名單已凍結，不需要再算法人）
const hasInst = new Array(dates.length).fill(false);
const instTot = new Map();
for (let t = Math.max(0, T - 60); t < T; t++) {
  const p = path.join(dataDir, 'inst', dates[t] + '.json.gz');
  if (!fs.existsSync(p)) continue;
  const js = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
  hasInst[t] = true;
  for (const [code, row] of Object.entries(js.d)) {
    let a = instTot.get(code);
    if (!a) instTot.set(code, a = new Float64Array(dates.length));
    a[t] = row[3];
  }
}
// 近 20 日法人買賣超 ÷ 同期成交股數。資料天數不夠回傳 null
function instRatio(st, t) {
  let have = 0, sum = 0, vol = 0;
  const a = instTot.get(st.code);
  for (let j = t - INST_DAYS + 1; j <= t; j++) {
    if (j < st.s || j > st.e || !hasInst[j]) continue;
    have++;
    if (a) sum += a[j];
    vol += st.vols[j - st.s] * 1000;
  }
  if (have < INST_MIN || !(vol > 0)) return null;
  return sum / vol;
}

// ── 月營收（同 backtest_exp.js）：某月營收當作次月 11 日可用；每日抓取有記下更早看到的日期就用那天
const nextMonth11 = ym => { let y = +ym.slice(0, 4), m = +ym.slice(5, 7) + 1; if (m > 12) { m = 1; y++; } return `${y}-${String(m).padStart(2, '0')}-11`; };
const revByCode = new Map();
function addRev(ym, code, cur, ly, seen) {
  if (!(cur > 0) || !(ly > 0)) return;
  let avail = nextMonth11(ym);
  if (seen && seen < avail) avail = seen;
  let a = revByCode.get(code);
  if (!a) revByCode.set(code, a = []);
  const i = a.findIndex(x => x.ym === ym);
  const rec = { ym, avail, yoy: cur / ly - 1 };
  if (i >= 0) { if (avail < a[i].avail) a[i] = rec; } else a.push(rec);
}
for (const src of [readJson(path.join(dataDir, 'revenue_hist.json')), readJson(path.join(dataDir, 'revenue.json'))]) {
  if (!src || !src.months) continue;
  for (const [ym, rows] of Object.entries(src.months)) for (const [code, r] of Object.entries(rows)) addRev(ym, code, r[0], r[1], r[2] || null);
}
for (const a of revByCode.values()) a.sort((x, y) => x.avail < y.avail ? -1 : x.avail > y.avail ? 1 : 0);
function revOf(code, date) {   // 回傳 {ym, yoy}，沒有就 null
  const a = revByCode.get(code);
  if (!a) return null;
  let best = null;
  for (const x of a) { if (x.avail <= date) best = x; else break; }
  if (!best || (Date.parse(date) - Date.parse(best.avail)) / 864e5 > REV_MAX_AGE) return null;
  return best;
}

function evalAt(t) {
  const list = [];
  for (const st of stocks) {
    if (st.t || st.s > t || st.e < t) continue;
    const idx = t - st.s;
    if (idx < WARM) continue;
    const a = Math.max(0, idx - WIN + 1), b = idx + 1;
    list.push({ code: st.code, name: st.name, full: st, div: st.div, divDate: st.divDate,
      closes: st.closes.slice(a, b), highs: st.highs.slice(a, b), lows: st.lows.slice(a, b), vols: st.vols.slice(a, b) });
  }
  return runAll({ market: { closes: mk.slice(0, t + 1) }, stocks: list }, DEFAULT_CFG, ON);
}
function entryOf(st, t) {
  if (!st || t + 1 > T - 1) return null;
  const k1 = t + 1 - st.s;
  if (k1 < 0 || t + 1 > st.e || st.vols[k1] === 0 || t - st.s < 0) return null;
  const prevClose = st.closes[t - st.s], entry = st.opens[k1];
  if (!(entry > 0) || entry >= prevClose * 1.095) return null;
  return entry;
}
function retAt(st, t, h) {
  const entry = entryOf(st, t);
  if (entry === null || t + h > T - 1) return null;
  const j = Math.min(t + h, st.e);
  return net(entry, st.closes[j - st.s]);
}

let prev = {};
try { prev = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (e) { prev = {}; }
const picks = prev.picks || {};

// ── 今天的名單：只在還沒記錄過時才記，記下就不改
const lastDate = dates[T - 1];
let newToday = false, note = '';
if (!picks[lastDate]) {
  const t = T - 1;
  let k = 0;
  for (let j = t - INST_DAYS + 1; j <= t; j++) if (j >= 0 && hasInst[j]) k++;
  const res = evalAt(t);
  if (k < INST_MIN) note = `法人資料只有 ${k} 天（要 ${INST_MIN} 天），今天不記錄`;
  else if (res.market) {
    const ranked = res.rows.filter(x => x.ev.pass).sort((a, b) => b.ev.rank - a.ev.rank);
    const items = [], skipped = [];
    for (const x of ranked) {
      if (items.length >= TOP) break;
      const r = revOf(x.s.code, lastDate), ins = instRatio(x.s.full, t);
      const why = [];
      if (r && r.yoy < 0) why.push('營收衰退');
      if (ins !== null && ins < 0) why.push('法人賣超');
      const info = {
        code: x.s.code, name: x.s.name, orig: ranked.indexOf(x) + 1,
        rev: r ? round2(r.yoy * 100) : null, revMonth: r ? r.ym : null,
        inst: ins === null ? null : round2(ins * 100)
      };
      if (why.length) skipped.push(Object.assign(info, { why }));
      else items.push(Object.assign(info, { rank: items.length + 1 }));
    }
    if (items.length) {
      picks[lastDate] = { state: res.market.state, items, skipped };
      newToday = true;
    }
  }
}

// ── 用最新價格算每一天的成績
const days = [];
for (const date of Object.keys(picks).sort()) {
  const t = dates.indexOf(date);
  const rec = picks[date];
  if (t < 0 || t >= T) {
    const old = (prev.days || []).find(d => d.date === date);
    if (old) days.push(old);
    continue;
  }
  const avail = T - 1 - t;
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
    const out = Object.assign({}, it);
    if (avail < 1) return Object.assign(out, { status: 'wait' });
    const entry = entryOf(st, t);
    if (entry === null) return Object.assign(out, { status: 'unfilled' });
    out.entry = round2(entry);
    out.entryDate = dates[t + 1];
    out.days = avail;
    const sofar = retAt(st, t, avail);
    out.sofar = sofar === null ? null : round2(sofar * 100);
    for (const h of HOLDS) { const r = retAt(st, t, h); out['r' + h] = r === null ? null : round2(r * 100); }
    out.status = avail >= 20 ? 'done' : 'open';
    return out;
  });
  const filled = items.filter(x => x.sofar !== null && x.sofar !== undefined);
  days.push({ date, state: rec.state, avail, items, skipped: rec.skipped || [], base,
    sofarAvg: filled.length ? round2(mean(filled.map(x => x.sofar))) : null });
}

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
  lastDate, topN: TOP, startDate: Object.keys(picks).sort()[0] || null,
  rule: '原版排名（不開穩定配息篩選），排除最新月營收年增率小於 0、或近 20 日三大法人賣超的股票，取前 10 檔；隔天開盤買進，持有 10 或 20 個交易日後收盤賣出，已扣手續費和證交稅',
  picks, days, summary
};
const text = JSON.stringify(out);
let same = false;
try { const o = JSON.parse(fs.readFileSync(outPath, 'utf8')); delete o.generatedAt; const c = JSON.parse(text); delete c.generatedAt; same = JSON.stringify(o) === JSON.stringify(c); } catch (e) { }
if (!same) fs.writeFileSync(outPath, text);
console.log(`實驗版 ${lastDate}：${newToday ? '已記錄今天的前 ' + TOP + ' 檔（排除 ' + picks[lastDate].skipped.length + ' 檔）' : (note || '今天已記錄過或沒有合格股票')}；` +
  `共 ${days.length} 天記錄；滿 20 天的 ${summary[20].n} 筆；${same ? '沒有變動' : '已寫入'}`);
