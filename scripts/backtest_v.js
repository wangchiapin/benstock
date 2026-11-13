#!/usr/bin/env node
// 組合 V：台股版 VCP（Ben 2026-11-13 確認的規格）。
// 選股：基本門檻 ＋ M 的趨勢條件與 RS 前 30%（backtest_minervini.js）
//       ＋ 兩段收縮：前段（t-42～t-23）、後段（t-22～t-3）各 20 天，後段幅度 < 前段 且 後段 ≤ 12%
//       ＋ 近 3 天內（t-2～t）有一天「收盤創 20 日新高（高於前 20 日最高價）且量 > 前 50 日均量 ×1.3」
//       ＋ B 過濾：近 20 日法人買賣超 ≥ 0、月營收年增率 ≥ 0（沒資料不排除）
// 先用 --count-only 只數筆數（不看賺賠）；不到 300 筆就不往下測。
// 用法：node scripts/backtest_v.js 歷史檔.json index.html data [--count-only]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { loadDay } = require('./backtest_exp2.js');
const M = require('./backtest_minervini.js');
const G = require('./backtest_g.js');

const SEG = 20, GAP = 3, MAX_LAST = 12, NEWHIGH = 20, VOLMA = 50, VOLX = 1.3, COOLDOWN = 30;
const WARM = 125, WIN = 130, MINIDX = 250, INST_DAYS = 20, INST_MIN = 15, REV_MAX_AGE = 75, MARGIN_DAYS = 20;

const maxOf = (a, from, to) => { let m = -Infinity; for (let k = from; k <= to; k++) m = Math.max(m, a[k]); return m; };
const minOf = (a, from, to) => { let m = Infinity; for (let k = from; k <= to; k++) m = Math.min(m, a[k]); return m; };
const meanOf = (a, from, to) => { let s = 0; for (let k = from; k <= to; k++) s += a[k]; return s / (to - from + 1); };

// 兩段收縮。t = 全域日序號。後段 = t-22～t-3，前段 = t-42～t-23（避開最近 3 天的突破日）
function contraction(st, t) {
  const i = t - st.s;
  if (i - GAP - 2 * SEG + 1 < 0 || t > st.e) return { pass: false };
  const lastTo = i - GAP, lastFrom = lastTo - SEG + 1, prevTo = lastFrom - 1, prevFrom = prevTo - SEG + 1;
  if (prevFrom < 0) return { pass: false };
  const hP = maxOf(st.highs, prevFrom, prevTo), lP = minOf(st.lows, prevFrom, prevTo);
  const hL = maxOf(st.highs, lastFrom, lastTo), lL = minOf(st.lows, lastFrom, lastTo);
  if (!(hP > 0) || !(hL > 0) || !(lP > 0) || !(lL > 0)) return { pass: false };
  const dP = (hP - lP) / hP * 100, dL = (hL - lL) / hL * 100;
  return { pass: dL < dP && dL <= MAX_LAST, dPrev: dP, dLast: dL };
}
// 第 j 天（區域索引）是否為「放量創新高日」：收盤 > 前 20 日最高價，且量 > 前 50 日均量 ×1.3
function breakoutDay(st, j) {
  if (j - VOLMA < 0 || j > st.e - st.s) return false;
  const c = st.closes[j];
  if (!(c > 0)) return false;
  if (!(c > maxOf(st.highs, j - NEWHIGH, j - 1))) return false;
  const av = meanOf(st.vols, j - VOLMA, j - 1);
  return av > 0 && st.vols[j] > av * VOLX;
}
// 近 3 天內（t-2～t）有放量創新高日
function breakout3(st, t) {
  const i = t - st.s;
  for (let j = i - 2; j <= i; j++) if (breakoutDay(st, j)) return true;
  return false;
}

function main() {
  const args = process.argv.slice(2), pos = args.filter(a => !a.startsWith('--'));
  const countOnly = args.includes('--count-only');
  const [histPath, htmlPath, dataDir] = pos;
  if (!histPath || !htmlPath || !dataDir) { console.error('用法：node scripts/backtest_v.js 歷史檔.json index.html data [--count-only]'); process.exit(2); }
  if (!countOnly) { console.error('目前只開放 --count-only（先數筆數，不到 300 筆不往下測）'); process.exit(2); }

  const html = fs.readFileSync(htmlPath, 'utf8');
  const mm = html.match(/\/\/<core>([\s\S]*?)\/\/<\/core>/);
  const { runAll, DEFAULT_CFG, DEFAULT_ON } = new Function(mm[1] + ';return {runAll,DEFAULT_CFG,DEFAULT_ON};')();
  const H = JSON.parse(fs.readFileSync(histPath, 'utf8'));
  const dates = H.dates, mk = H.market.closes, stocks = H.stocks, N = dates.length, T = N;

  // 三大法人、月營收（與 backtest_g.js 同算法）
  const hasInst = new Array(N).fill(false), instTot = new Map();
  for (let t = 0; t < T; t++) {
    const p = path.join(dataDir, 'inst', dates[t] + '.json.gz');
    if (!fs.existsSync(p)) continue;
    const js = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
    hasInst[t] = true;
    for (const [code, row] of Object.entries(js.d)) { let a = instTot.get(code); if (!a) instTot.set(code, a = new Float64Array(N)); a[t] = row[3]; }
  }
  function instRatio(st, t) {
    let have = 0, sum = 0, vol = 0; const a = instTot.get(st.code);
    for (let j = t - INST_DAYS + 1; j <= t; j++) { if (j < st.s || !hasInst[j]) continue; have++; if (a) sum += a[j]; vol += st.vols[j - st.s] * 1000; }
    return have < INST_MIN || !(vol > 0) ? null : sum / vol;
  }
  const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
  const nm11 = ym => { let y = +ym.slice(0, 4), m = +ym.slice(5, 7) + 1; if (m > 12) { m = 1; y++; } return `${y}-${String(m).padStart(2, '0')}-11`; };
  const revBy = new Map();
  for (const src of [readJson(path.join(dataDir, 'revenue_hist.json')), readJson(path.join(dataDir, 'revenue.json'))]) {
    if (!src || !src.months) continue;
    for (const [ym, rows] of Object.entries(src.months)) for (const [code, r] of Object.entries(rows)) {
      const cur = r[0], ly = r[1], seen = r[2] || null;
      if (!(cur > 0) || !(ly > 0)) continue;
      let avail = nm11(ym); if (seen && seen < avail) avail = seen;
      let a = revBy.get(code); if (!a) revBy.set(code, a = []);
      const k = a.findIndex(x => x.ym === ym), rec = { ym, avail, yoy: cur / ly - 1 };
      if (k >= 0) { if (avail < a[k].avail) a[k] = rec; } else a.push(rec);
    }
  }
  for (const a of revBy.values()) a.sort((x, y) => x.avail < y.avail ? -1 : x.avail > y.avail ? 1 : 0);
  function revYoy(code, date) {
    const a = revBy.get(code); if (!a) return null;
    let best = null; for (const x of a) { if (x.avail <= date) best = x; else break; }
    return !best || (Date.parse(date) - Date.parse(best.avail)) / 864e5 > REV_MAX_AGE ? null : best.yoy;
  }

  // 與 G 同樣：只看資料齊全的日子
  const hasMargin = new Array(N).fill(false), hasVal = new Array(N).fill(false);
  for (let t = 0; t < T; t++) { hasMargin[t] = !!loadDay(path.join(dataDir, 'margin'), dates[t]); hasVal[t] = fs.existsSync(path.join(dataDir, 'val', dates[t] + '.json.gz')); }
  const funnel = { gate: 0, rs: 0, contraction: 0, breakout3: 0, bFilter: 0 };
  const lastEntry = new Map(), entries = [], byMonth = {};
  let evalDays = 0, first = null, last = null;
  for (let t = MINIDX; t < T - 1; t++) {
    let k = 0; for (let j = t - INST_DAYS + 1; j <= t; j++) if (hasInst[j]) k++;
    if (!(k >= INST_MIN && hasVal[t] && hasMargin[t] && hasMargin[t - MARGIN_DAYS])) continue;
    const list = [];
    for (const st of stocks) {
      if (st.t || st.s > t || st.e < t) continue;
      const idx = t - st.s; if (idx < WARM) continue;
      const a = Math.max(0, idx - WIN + 1), b = idx + 1;
      list.push({ code: st.code, name: st.name, full: st, closes: st.closes.slice(a, b), highs: st.highs.slice(a, b), lows: st.lows.slice(a, b), vols: st.vols.slice(a, b) });
    }
    const res = runAll({ market: { closes: mk.slice(0, t + 1) }, stocks: list }, DEFAULT_CFG, Object.assign({}, DEFAULT_ON, { div: false }));
    if (!res.market) continue;
    evalDays++; first = first || dates[t]; last = dates[t];
    const gate = res.rows.filter(x => x.ev.chk.liq && x.ev.chk.price && x.ev.chk.safe);
    funnel.gate += gate.length;
    const info = gate.map(x => ({ x, code: x.s.code, tp: M.template(x.s.full, t) }));
    const pct = M.pctRanks(info.filter(o => o.tp.ret250 !== null).map(o => ({ code: o.code, ret250: o.tp.ret250 })));
    for (const o of info) {
      if (!(o.tp.pass && pct.get(o.code) >= M.RS_MIN)) continue; funnel.rs++;
      const st = o.x.s.full;
      if (!contraction(st, t).pass) continue; funnel.contraction++;
      if (!breakout3(st, t)) continue; funnel.breakout3++;
      const rev = revYoy(o.code, dates[t]), inst = instRatio(st, t);
      if (!G.passB({ rev, inst })) continue; funnel.bFilter++;
      if (lastEntry.has(o.code) && t < lastEntry.get(o.code)) continue;       // 30 天內同一檔不重複算
      lastEntry.set(o.code, t + COOLDOWN);
      entries.push({ date: dates[t], code: o.code }); const m = dates[t].slice(0, 7); byMonth[m] = (byMonth[m] || 0) + 1;
    }
  }
  console.log(`期間 ${first} ~ ${last}，${evalDays} 個交易日`);
  console.log('漏斗（累計股票日）：', JSON.stringify(funnel));
  console.log(`可進場筆數（同一檔 30 天內不重複）：${entries.length}；涉及 ${new Set(entries.map(e => e.code)).size} 檔`);
  console.log('每月：', Object.keys(byMonth).sort().map(m => m + ':' + byMonth[m]).join('  '));
  console.log('2026/6~9：', entries.filter(e => e.date >= '2026-06' && e.date < '2026-10').length, '筆；門檻：總數 ≥', 300, '且 2026/6~9 ≥', 30);
}

module.exports = { contraction, breakoutDay, breakout3, SEG, GAP, MAX_LAST, NEWHIGH, VOLMA, VOLX };
if (require.main === module) main();
