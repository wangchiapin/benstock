#!/usr/bin/env node
// 回測：用網頁（index.html）同一套篩選規則，對過去每一天重新篩一次，模擬買賣，算成績。
// 用法：node scripts/backtest.js 歷史檔.json index.html 輸出.json [--fee-discount 1]
//
// 模擬規則：
//   - 每天收盤後，照網頁的排名（近 20 日漲幅 + 離 120 日高點的距離）選前 K 檔，隔天開盤買進
//     （開盤已漲停買不到就跳過、停牌也跳過）
//   - 持有 10 / 20 / 30 個交易日後，用收盤價賣出（主要結果不設停損；另外算「買進價往下 20%」停損的結果當對照）
//   - 選股前先排除已暴衝的股票（近 20 日漲超過 40% 或 RSI 超過 80）；對照組則不排除
//   - 手續費 0.1425%（買賣各一次，可乘上折扣），證交稅 0.3%（賣出）
//   - 對照組：同一天基本門檻（成交金額夠大、股價夠高）合格的所有股票平均，同樣買賣
//   - 同一天買的股票持有期間會重疊，所以筆數看起來很多，實際獨立的樣本比筆數少
const fs = require('fs');

const [, , histPath, htmlPath, outPath, ...rest] = process.argv;
if (!histPath || !htmlPath || !outPath) {
  console.error('用法：node scripts/backtest.js 歷史檔.json index.html 輸出.json [--fee-discount 1]');
  process.exit(2);
}
let feeDiscount = 1;
for (let i = 0; i < rest.length; i++) if (rest[i] === '--fee-discount') feeDiscount = parseFloat(rest[++i]);
if (!(feeDiscount > 0 && feeDiscount <= 1)) { console.error('--fee-discount 要在 0 到 1 之間'); process.exit(2); }

// 直接取用網頁裡的篩選程式，確保回測和網頁用的是同一套規則
const html = fs.readFileSync(htmlPath, 'utf8');
const mm = html.match(/\/\/<core>([\s\S]*?)\/\/<\/core>/);
if (!mm) { console.error('index.html 裡找不到 //<core> 區塊'); process.exit(2); }
const { runAll, DEFAULT_CFG, DEFAULT_ON } = new Function(mm[1] + ';return {runAll,DEFAULT_CFG,DEFAULT_ON};')();

const H = JSON.parse(fs.readFileSync(histPath, 'utf8'));
const dates = H.dates, mk = H.market.closes, stocks = H.stocks, T = dates.length;
const HOLDS = [10, 20, 30], TOPS = [3, 5, 10, 20];
const BUY_FEE = 0.001425 * feeDiscount, SELL_FEE = 0.001425 * feeDiscount, TAX = 0.003;
const WARM = 125, WIN = 130;
const OK_STATES = new Set(['strong', 'weakening']);   // 月線上方（只用來對照，不影響選股）

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const round2 = x => Math.round(x * 100) / 100;
const net = (entry, exit) => (exit * (1 - SELL_FEE - TAX)) / (entry * (1 + BUY_FEE)) - 1;

// 模擬一筆：第 t 天收盤後選到，隔天開盤買，持有 h 天。回傳扣成本後的報酬（小數），無法成交或還沒到期回傳 null
function sim(st, t, h, stopPct) {
  if (t + h > T - 1) return null;
  const k1 = t + 1 - st.s;
  if (k1 < 0 || t + 1 > st.e) return null;
  if (st.vols[k1] === 0) return null;                         // 停牌
  const prevClose = st.closes[t - st.s], entry = st.opens[k1];
  if (!(entry > 0) || entry >= prevClose * 1.095) return null; // 開盤漲停，買不到
  const last = Math.min(t + h, st.e);
  for (let j = t + 1; j <= last; j++) {
    const k = j - st.s;
    const sp = stopPct > 0 ? entry * (1 - stopPct) : 0;
    if (sp > 0 && st.lows[k] <= sp) return net(entry, Math.min(sp, st.opens[k]));
    if (j === last) return net(entry, st.closes[k]);
  }
  return null;
}

function stats(a) {
  const n = a.length;
  if (!n) return { n: 0 };
  const w = a.filter(x => x > 0), l = a.filter(x => x <= 0), s = [...a].sort((x, y) => x - y);
  const med = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  return {
    n, win: round2(w.length / n * 100), avg: round2(mean(a) * 100), median: round2(med * 100),
    avgWin: w.length ? round2(mean(w) * 100) : 0, avgLoss: l.length ? round2(mean(l) * 100) : 0
  };
}

const trades = {};   // `${top}|${h}` -> [{t, r, rs, state, ok}]
const baseDay = {};  // h -> Map(t -> 當天基本門檻合格股票的平均報酬)
for (const top of TOPS) for (const h of HOLDS) trades[top + '|' + h] = [];
for (const h of HOLDS) baseDay[h] = new Map();
const stateDays = {}, t0 = Date.now();
let evalDays = 0, signalDays = 0, pickSum = 0;

for (let t = WARM; t < T - 1; t++) {
  const list = [];
  for (const st of stocks) {
    if (st.s > t || st.e < t) continue;
    const idx = t - st.s;
    if (idx < WARM) continue;
    const a = Math.max(0, idx - WIN + 1), b = idx + 1;
    list.push({ code: st.code, name: st.name, full: st,
      closes: st.closes.slice(a, b), highs: st.highs.slice(a, b), lows: st.lows.slice(a, b), vols: st.vols.slice(a, b) });
  }
  const res = runAll({ market: { closes: mk.slice(0, t + 1) }, stocks: list }, DEFAULT_CFG, DEFAULT_ON);
  if (!res.market) continue;
  evalDays++;
  const state = res.market.state, ok = OK_STATES.has(state);
  stateDays[state] = (stateDays[state] || 0) + 1;

  const picks = res.rows.filter(x => x.ev.pass).sort((a, b) => b.ev.rank - a.ev.rank);
  const gate = res.rows.filter(x => x.ev.chk.liq && x.ev.chk.price && x.ev.chk.safe);   // 對照組：只看基本門檻，不排除暴衝股
  if (picks.length) { signalDays++; pickSum += picks.length; }
  // 對照組：基本門檻合格的全部股票，不設停損
  for (const h of HOLDS) {
    const rs = [];
    for (const x of gate) {
      const r = sim(x.s.full, t, h, 0);
      if (r !== null) rs.push(r);
    }
    if (rs.length) baseDay[h].set(t, mean(rs));
  }
  for (const top of TOPS) {
    for (const x of picks.slice(0, top)) {
      for (const h of HOLDS) {
        const r = sim(x.s.full, t, h, 0), rs = sim(x.s.full, t, h, DEFAULT_CFG.stopPct / 100);
        if (r !== null) trades[top + '|' + h].push({ t, r, rs, state, ok });
      }
    }
  }
}

const results = {};
for (const top of TOPS) {
  results[top] = {};
  for (const h of HOLDS) {
    const all = trades[top + '|' + h];
    const bd = baseDay[h];
    // 每筆減掉「同一天對照組平均」，看選股本身多賺多少
    const ex = a => a.length ? round2(mean(a.map(x => (x.r - (bd.get(x.t) ?? 0)))) * 100) : null;
    const days = [...bd.keys()].sort((a, b) => a - b);
    const cuts = [days[0], days[Math.floor(days.length / 3)], days[Math.floor(days.length * 2 / 3)], Infinity];
    const part = i => all.filter(x => x.t >= cuts[i] && x.t < cuts[i + 1]);
    const baseVals = days.map(t => bd.get(t));
    const byState = {};
    for (const st of ['strong', 'weakening', 'pullback', 'bear']) {
      const a = all.filter(x => x.state === st);
      byState[st] = a.length ? { n: a.length, win: stats(a.map(x => x.r)).win, avg: stats(a.map(x => x.r)).avg, excess: ex(a) } : { n: 0 };
    }
    const months = {};
    for (const x of all) { const m = dates[x.t].slice(0, 7); (months[m] = months[m] || []).push(x); }
    const byMonth = Object.keys(months).sort().map(m => ({ m, days: new Set(months[m].map(x => x.t)).size, n: months[m].length,
      avg: round2(mean(months[m].map(x => x.r)) * 100), excess: ex(months[m]) }));
    const okOnly = all.filter(x => x.ok);
    results[top][h] = {
      rule: stats(all.map(x => x.r)),
      excess: ex(all),
      parts: [0, 1, 2].map(i => { const a = part(i); return Object.assign({ excess: ex(a) }, stats(a.map(x => x.r))); }),
      byMonth,
      okOnly: Object.assign({ excess: ex(okOnly) }, stats(okOnly.map(x => x.r))),
      withStopAvg: all.length ? round2(mean(all.map(x => x.rs)) * 100) : null,
      base: baseVals.length ? round2(mean(baseVals) * 100) : null,
      byState
    };
  }
}

const out = {
  generatedAt: new Date().toISOString(),
  range: { from: dates[WARM], to: dates[T - 1], days: evalDays, totalDays: T },
  adjustedExDiv: !!H.adjusted,
  params: { feeDiscount, buyFeePct: round2(BUY_FEE * 100 * 1000) / 1000, taxPct: 0.3, stopPct: DEFAULT_CFG.stopPct, maxR20: DEFAULT_CFG.maxR20, maxRsi: DEFAULT_CFG.maxRsi,
            entry: '隔天開盤買進', rank: '近 20 日漲幅 + 離 120 日高點的距離', exit: '持有到期收盤賣出，主要結果不設停損', marketFilter: '不看大盤' },
  indexReturnPct: round2((mk[T - 1] / mk[WARM] - 1) * 100),
  stateDays, signalDays, avgPicksPerSignalDay: signalDays ? round2(pickSum / signalDays) : 0,
  tops: TOPS, holds: HOLDS, results
};
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`回測完成：${out.range.from} ~ ${out.range.to}，${evalDays} 個交易日，有訊號的 ${signalDays} 天，` +
  `用時 ${Math.round((Date.now() - t0) / 1000)} 秒，已還原除權息：${out.adjustedExDiv}`);
