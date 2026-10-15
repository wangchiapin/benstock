#!/usr/bin/env node
// 回測：用網頁（index.html）同一套篩選規則，對過去每一天重新篩一次，模擬買賣，算成績。
// 用法：node scripts/backtest.js 歷史檔.json index.html 輸出.json [--fee-discount 1]
//
// 模擬規則（照網頁預設）：
//   - 收盤後篩選，隔天開盤買進（開盤已漲停買不到就跳過、停牌也跳過）
//   - 持有 3 / 5 / 10 / 20 個交易日後，用收盤價賣出
//   - 中途最低價碰到停損價就先賣（停損價用網頁算出來的「近 10 日低點再低 1%」；開盤直接跳空跌破就用開盤價賣）
//   - 手續費 0.1425%（買賣各一次，可乘上折扣），證交稅 0.3%（賣出）
//   - 「照網頁規則」只在大盤站上月線時進場；「不看大盤」每天都進場，用來看大盤過濾有沒有用
//   - 對照組：當天基本門檻（成交金額夠大、股價夠高）合格的所有股票平均，同樣買賣規則但不設停損
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
const HOLDS = [3, 5, 10, 20], TOPS = [1, 3, 5, 10, 'all'];
const BUY_FEE = 0.001425 * feeDiscount, SELL_FEE = 0.001425 * feeDiscount, TAX = 0.003;
const WARM = 64, WIN = 130;
const OK_STATES = new Set(['strong', 'weakening']);   // 月線上方

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const round2 = x => Math.round(x * 100) / 100;
const net = (entry, exit) => (exit * (1 - SELL_FEE - TAX)) / (entry * (1 + BUY_FEE)) - 1;

// 模擬一筆：第 t 天收盤後選到，隔天開盤買，持有 h 天。回傳扣成本後的報酬（小數），無法成交或還沒到期回傳 null
function sim(st, t, h, stop) {
  if (t + h > T - 1) return null;
  const k1 = t + 1 - st.s;
  if (k1 < 0 || t + 1 > st.e) return null;
  if (st.vols[k1] === 0) return null;                         // 停牌
  const prevClose = st.closes[t - st.s], entry = st.opens[k1];
  if (!(entry > 0) || entry >= prevClose * 1.095) return null; // 開盤漲停，買不到
  const last = Math.min(t + h, st.e);
  for (let j = t + 1; j <= last; j++) {
    const k = j - st.s;
    if (stop > 0 && st.lows[k] <= stop) return net(entry, Math.min(stop, st.opens[k]));
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

const trades = {};   // `${top}|${h}` -> [{t, r, rn, state, ok}]
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

  // 對照組：基本門檻合格的全部股票，持有 h 天、不設停損
  for (const h of HOLDS) {
    const rs = [];
    for (const x of res.rows) {
      if (!(x.ev.chk.liq && x.ev.chk.price && x.ev.chk.safe)) continue;
      const r = sim(x.s.full, t, h, 0);
      if (r !== null) rs.push(r);
    }
    if (rs.length) baseDay[h].set(t, mean(rs));
  }

  const picks = res.rows.filter(x => x.ev.pass && x.ev.entry).sort((a, b) => b.ev.score - a.ev.score);
  if (picks.length) { signalDays++; pickSum += picks.length; }
  for (const top of TOPS) {
    const chosen = top === 'all' ? picks : picks.slice(0, top);
    for (const x of chosen) {
      for (const h of HOLDS) {
        const r = sim(x.s.full, t, h, x.m.stop), rn = sim(x.s.full, t, h, 0);
        if (r !== null) trades[top + '|' + h].push({ t, r, rn, state, ok });
      }
    }
  }
}

const mid = Math.floor((WARM + T - 1) / 2);
const results = {};
for (const top of TOPS) {
  results[top] = {};
  for (const h of HOLDS) {
    const all = trades[top + '|' + h], rule = all.filter(x => x.ok);
    const ruleDays = [...new Set(rule.map(x => x.t))];
    const baseVals = ruleDays.map(t => baseDay[h].get(t)).filter(v => v !== undefined);
    const byState = {};
    for (const s of ['strong', 'weakening', 'pullback', 'bear']) {
      const a = all.filter(x => x.state === s).map(x => x.r);
      byState[s] = a.length ? (({ n, win, avg }) => ({ n, win, avg }))(stats(a)) : { n: 0 };
    }
    results[top][h] = {
      rule: stats(rule.map(x => x.r)),
      first: stats(rule.filter(x => x.t < mid).map(x => x.r)),
      second: stats(rule.filter(x => x.t >= mid).map(x => x.r)),
      noFilter: stats(all.map(x => x.r)),
      noStopAvg: rule.length ? round2(mean(rule.map(x => x.rn)) * 100) : null,
      base: baseVals.length ? round2(mean(baseVals) * 100) : null,
      byState
    };
  }
}

const out = {
  generatedAt: new Date().toISOString(),
  range: { from: dates[WARM], to: dates[T - 1], days: evalDays, totalDays: T },
  adjustedExDiv: !!H.adjusted,
  params: { feeDiscount, buyFeePct: round2(BUY_FEE * 100 * 1000) / 1000, taxPct: 0.3, stopDays: DEFAULT_CFG.stopDays,
            entry: '隔天開盤買進', exit: '持有到期收盤賣出，碰到停損先賣', marketFilter: '月線上方才進場' },
  indexReturnPct: round2((mk[T - 1] / mk[WARM] - 1) * 100),
  stateDays, signalDays, avgPicksPerSignalDay: signalDays ? round2(pickSum / signalDays) : 0,
  tops: TOPS, holds: HOLDS, results
};
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`回測完成：${out.range.from} ~ ${out.range.to}，${evalDays} 個交易日，有訊號的 ${signalDays} 天，` +
  `用時 ${Math.round((Date.now() - t0) / 1000)} 秒，已還原除權息：${out.adjustedExDiv}`);
