#!/usr/bin/env node
// 朱家泓規則（簡化版）回測。規格見 HANDOFF.md 第 7.1 節。只測試，不改網頁。
// 用法：node scripts/backtest_zhu.js 歷史檔.json index.html 輸出.json [--fee-discount 1]
//
// 選股（每天收盤後）：
//   1. 基本門檻同原版（成交金額、股價、資料正常），不開穩定配息、不排除暴衝
//   2. 多頭：收盤 > 20 日線、20 日線 > 5 天前的 20 日線、5 > 10 > 20 日線、頭頭高底底高（最近 60 天，轉折點要前後各 3 天都比它低／高）
//   3. 拉回再上漲：近 5 天內有收盤跌破 5 日線；拉回期間最低價沒跌破當天 20 日線、也沒跌破拉回前最近一個轉折低點；
//      今天 5 日線比昨天高、今天是實體紅 K（實體 ≥ 全日振幅一半）、收盤 > 5 日線
//   4. 超過 10 檔，依近 20 日漲幅排序取前 10；已經持有的同一檔不重複買
// 買賣：
//   - 隔天開盤買（開盤漲停、停牌 = 沒買到）
//   - 停損：買進價 −5%，當天最低價碰到就賣停損價；開盤就低於停損價則賣開盤價
//   - 停利：收盤跌破 5 日線，隔天開盤賣（從買進當天收盤就開始看）
//   - 最長持有 20 個交易日，到期收盤賣
//   - 手續費 0.1425% × 2、證交稅 0.3%
// 對照組：同一天買、同一時間賣（賣在開盤就用開盤價，其他用收盤價）的全部基本門檻合格股票平均
// 另附：原版前 10 檔持有 20 天（不設停損）當參考
// 過關標準（看結果前定好）：每筆比對照組多賺 ≥ 0.5 個百分點，且前、中、後三段都 > 0
const fs = require('fs');

const STOP = 0.05, MAXHOLD = 20, TOP = 10;
const WARM = 125, WIN = 130, TREND_LOOK = 60, SW = 3, GOAL = 0.5;
const BUY_FEE0 = 0.001425, SELL_FEE0 = 0.001425, TAX = 0.003;

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const round2 = x => Math.round(x * 100) / 100;
const makeNet = fd => (entry, exit) => (exit * (1 - SELL_FEE0 * fd - TAX)) / (entry * (1 + BUY_FEE0 * fd)) - 1;

function sma(arr, n) {
  const out = new Array(arr.length).fill(null);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    s += arr[i];
    if (i >= n) s -= arr[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}
function prep(st) {
  if (!st._p) st._p = { m5: sma(st.closes, 5), m10: sma(st.closes, 10), m20: sma(st.closes, 20) };
  return st._p;
}

// 轉折高點：比前後各 SW 天的最高價都高；轉折低點同理。只看到「今天 k」往前 SW 天為止，避免偷看未來
function isHigh(h, i) {
  if (i < SW || i + SW >= h.length) return false;
  for (let j = 1; j <= SW; j++) if (!(h[i] > h[i - j] && h[i] > h[i + j])) return false;
  return true;
}
function isLow(l, i) {
  if (i < SW || i + SW >= l.length) return false;
  for (let j = 1; j <= SW; j++) if (!(l[i] < l[i - j] && l[i] < l[i + j])) return false;
  return true;
}
function swings(st, k) {
  const lo = Math.max(SW, k - TREND_LOOK + 1), hi = k - SW, H = [], L = [];
  for (let i = lo; i <= hi; i++) {
    if (isHigh(st.highs, i)) H.push(i);
    if (isLow(st.lows, i)) L.push(i);
  }
  return { H, L };
}

// 第 t 天收盤後，這檔有沒有朱家泓訊號。回傳 { pass, step }，step 是沒過的那一關
function zhuSignal(st, t) {
  const k = t - st.s;
  if (k < 65) return { pass: false, step: 'data' };
  const c = st.closes, o = st.opens, h = st.highs, l = st.lows, P = prep(st);
  if (!(c[k] > P.m20[k] && P.m20[k] > P.m20[k - 5] && P.m5[k] > P.m10[k] && P.m10[k] > P.m20[k])) return { pass: false, step: 'trend' };
  const { H, L } = swings(st, k);
  if (H.length < 2 || L.length < 2) return { pass: false, step: 'swing' };
  if (!(h[H[H.length - 1]] > h[H[H.length - 2]] && l[L[L.length - 1]] > l[L[L.length - 2]])) return { pass: false, step: 'hhhl' };
  let f = -1;
  for (let d = k - 4; d <= k; d++) if (c[d] < P.m5[d]) { f = d; break; }
  if (f < 0 || f > k - 1) return { pass: false, step: 'pullback' };
  let prior = -1;
  for (let q = L.length - 1; q >= 0; q--) if (L[q] < f) { prior = L[q]; break; }
  if (prior < 0) return { pass: false, step: 'pullback' };
  for (let d = f; d <= k - 1; d++) if (l[d] < P.m20[d] || l[d] < l[prior]) return { pass: false, step: 'pullback' };
  if (!(P.m5[k] > P.m5[k - 1])) return { pass: false, step: 'turn' };
  const body = c[k] - o[k], rng = h[k] - l[k];
  if (!(body > 0 && rng > 0 && body >= rng * 0.5 && c[k] > P.m5[k])) return { pass: false, step: 'candle' };
  return { pass: true, step: 'ok' };
}

// 第 t 天收盤後選到，隔天開盤買。買得到回傳買進價，買不到（停牌、開盤漲停、沒資料）回傳 null
function enter(st, t, T) {
  const k1 = t + 1 - st.s;
  if (t + 1 > T - 1 || k1 < 0 || t + 1 > st.e) return null;
  if (st.vols[k1] === 0) return null;
  const prevClose = st.closes[t - st.s], entry = st.opens[k1];
  if (!(entry > 0) || entry >= prevClose * 1.095) return null;
  return entry;
}

// 朱家泓買賣規則。回傳 { r, x, type, px }：報酬（小數）、賣出那天的序號、原因、賣價種類；還沒結束或買不到回傳 null
function simZhu(st, t, T, net) {
  const entry = enter(st, t, T);
  if (entry === null) return null;
  const P = prep(st), sp = entry * (1 - STOP), lastDay = Math.min(t + MAXHOLD, st.e, T - 1);
  for (let j = t + 1; j <= lastDay; j++) {
    const k = j - st.s;
    if (st.vols[k] > 0 && st.lows[k] <= sp) return { r: net(entry, Math.min(sp, st.opens[k])), x: j, type: 'stop', px: 'close' };
    if (j === t + MAXHOLD || (j === lastDay && st.e < T - 1)) return { r: net(entry, st.closes[k]), x: j, type: 'expire', px: 'close' };
    if (j === lastDay) return null;                       // 資料到頭但還沒到期，不算
    if (st.closes[k] < P.m5[k] && st.vols[k + 1] > 0) return { r: net(entry, st.opens[k + 1]), x: j + 1, type: 'ma5', px: 'open' };
  }
  return null;
}

// 參考：原版，買進後持有 h 天收盤賣，不設停損
function simHold(st, t, T, h, net) {
  if (t + h > T - 1) return null;
  const entry = enter(st, t, T);
  if (entry === null) return null;
  const last = Math.min(t + h, st.e);
  return net(entry, st.closes[last - st.s]);
}

// 對照組：同一天買、第 x 天賣（open 用開盤價、close 用收盤價）的全部基本門檻合格股票平均
function ctrl(gate, t, x, px, T, net, cache) {
  const key = t + '|' + x + '|' + px;
  if (cache.has(key)) return cache.get(key);
  const rs = [];
  for (const g of gate) {
    const st = g.s.full, entry = enter(st, t, T);
    if (entry === null) continue;
    const k = x - st.s;
    if (k < 0 || x > st.e || st.vols[k] === 0) continue;
    rs.push(net(entry, px === 'open' ? st.opens[k] : st.closes[k]));
  }
  const v = rs.length ? mean(rs) : null;
  cache.set(key, v);
  return v;
}

function stats(a) {
  const n = a.length;
  if (!n) return { n: 0 };
  const w = a.filter(x => x > 0), l = a.filter(x => x <= 0), s = [...a].sort((x, y) => x - y);
  const med = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  return {
    n, win: round2(w.length / n * 100), avg: round2(mean(a) * 100), median: round2(med * 100),
    avgWin: w.length ? round2(mean(w) * 100) : 0, avgLoss: l.length ? round2(mean(l) * 100) : 0,
    worst: round2(s[0] * 100)
  };
}
const exc = a => { const e = a.filter(x => x.c !== null); return e.length ? round2(mean(e.map(x => x.r - x.c)) * 100) : null; };

function summarize(trades, dates) {
  const days = [...new Set(trades.map(x => x.t))].sort((a, b) => a - b);
  const cuts = [days[0], days[Math.floor(days.length / 3)], days[Math.floor(days.length * 2 / 3)], Infinity];
  const part = i => trades.filter(x => x.t >= cuts[i] && x.t < cuts[i + 1]);
  const group = a => Object.assign({ excess: exc(a) }, stats(a.map(x => x.r)));
  const months = {};
  for (const x of trades) { const m = dates[x.t].slice(0, 7); (months[m] = months[m] || []).push(x); }
  const recent = trades.filter(x => { const m = dates[x.t].slice(0, 7); return m >= '2026-06' && m <= '2026-09'; });
  return Object.assign(group(trades), {
    parts: [0, 1, 2].map(i => group(part(i))),
    recent: group(recent),
    byMonth: Object.keys(months).sort().map(m => ({ m, n: months[m].length, avg: round2(mean(months[m].map(x => x.r)) * 100), excess: exc(months[m]) }))
  });
}

function main() {
  const [, , histPath, htmlPath, outPath, ...rest] = process.argv;
  if (!histPath || !htmlPath || !outPath) {
    console.error('用法：node scripts/backtest_zhu.js 歷史檔.json index.html 輸出.json [--fee-discount 1]');
    process.exit(2);
  }
  let fd = 1, dumpPath = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--fee-discount') fd = parseFloat(rest[++i]);
    else if (rest[i] === '--dump-trades') dumpPath = rest[++i];   // 除錯用：把每筆交易存成檔案
  }
  if (!(fd > 0 && fd <= 1)) { console.error('--fee-discount 要在 0 到 1 之間'); process.exit(2); }
  const net = makeNet(fd);

  // 基本門檻、大盤判斷直接取用網頁裡的程式，確保和原版同一套
  const html = fs.readFileSync(htmlPath, 'utf8');
  const mm = html.match(/\/\/<core>([\s\S]*?)\/\/<\/core>/);
  if (!mm) { console.error('index.html 裡找不到 //<core> 區塊'); process.exit(2); }
  const { runAll, DEFAULT_CFG, DEFAULT_ON } = new Function(mm[1] + ';return {runAll,DEFAULT_CFG,DEFAULT_ON};')();

  const H = JSON.parse(fs.readFileSync(histPath, 'utf8'));
  const dates = H.dates, mk = H.market.closes, stocks = H.stocks, T = dates.length;
  const on = Object.assign({}, DEFAULT_ON, { div: false });
  const zhu = [], ref = [], cache = new Map(), heldUntil = new Map();
  const funnel = { gate: 0, trend: 0, swing: 0, hhhl: 0, pullback: 0, turn: 0, candle: 0, ok: 0, skippedHeld: 0 };
  let evalDays = 0, signalDays = 0, pickSum = 0;
  const t0 = Date.now();

  for (let t = WARM; t < T - 1; t++) {
    const list = [];
    for (const st of stocks) {
      if (st.t || st.s > t || st.e < t) continue;
      const idx = t - st.s;
      if (idx < WARM) continue;
      const a = Math.max(0, idx - WIN + 1), b = idx + 1;
      list.push({ code: st.code, name: st.name, full: st,
        closes: st.closes.slice(a, b), highs: st.highs.slice(a, b), lows: st.lows.slice(a, b), vols: st.vols.slice(a, b) });
    }
    const res = runAll({ market: { closes: mk.slice(0, t + 1) }, stocks: list }, DEFAULT_CFG, on);
    if (!res.market) continue;
    evalDays++;
    const mOk = res.market.ok;
    const gate = res.rows.filter(x => x.ev.chk.liq && x.ev.chk.price && x.ev.chk.safe);
    funnel.gate += gate.length;

    // 朱家泓
    const cand = [];
    for (const x of gate) {
      const sg = zhuSignal(x.s.full, t);
      funnel[sg.step] = (funnel[sg.step] || 0) + 1;
      if (sg.pass) cand.push(x);
    }
    cand.sort((p, q) => q.m.ret20 - p.m.ret20);
    const fresh = cand.filter(x => !(heldUntil.has(x.s.code) && t < heldUntil.get(x.s.code)));
    funnel.skippedHeld += cand.length - fresh.length;
    const picks = fresh.slice(0, TOP);
    if (picks.length) { signalDays++; pickSum += picks.length; }
    for (const x of picks) {
      const r = simZhu(x.s.full, t, T, net);
      if (!r) continue;
      heldUntil.set(x.s.code, r.x);
      zhu.push({ code: x.s.code, t, r: r.r, c: ctrl(gate, t, r.x, r.px, T, net, cache), hold: r.x - t, type: r.type, ok: mOk });
    }

    // 參考：原版前 10 檔持有 20 天
    const rp = res.rows.filter(x => x.ev.pass).sort((p, q) => q.ev.rank - p.ev.rank).slice(0, TOP);
    for (const x of rp) {
      const r = simHold(x.s.full, t, T, MAXHOLD, net);
      if (r !== null) ref.push({ t, r, c: ctrl(gate, t, t + MAXHOLD, 'close', T, net, cache) });
    }
  }

  const z = summarize(zhu, dates);
  const types = {};
  for (const x of zhu) (types[x.type] = types[x.type] || []).push(x.r);
  const exits = {};
  for (const k of Object.keys(types)) exits[k] = { n: types[k].length, share: round2(types[k].length / zhu.length * 100), avg: round2(mean(types[k]) * 100) };
  const up = zhu.filter(x => x.ok), dn = zhu.filter(x => !x.ok);
  const grp = a => Object.assign({ excess: exc(a) }, stats(a.map(x => x.r)));
  z.avgHoldDays = zhu.length ? round2(mean(zhu.map(x => x.hold))) : null;
  z.perHeldDayPct = zhu.length ? round2(mean(zhu.map(x => x.r)) / mean(zhu.map(x => x.hold)) * 100) : null;   // 平均報酬 ÷ 平均持有天數
  z.exits = exits;
  z.byMarket = { above: grp(up), below: grp(dn) };
  z.pass = {
    goal: GOAL,
    excessOk: z.excess !== null && z.excess >= GOAL,
    partsOk: z.parts.every(p => p.excess !== null && p.excess > 0),
    ok: z.excess !== null && z.excess >= GOAL && z.parts.every(p => p.excess !== null && p.excess > 0)
  };

  const out = {
    generatedAt: new Date().toISOString(),
    range: { from: dates[WARM], to: dates[T - 1], days: evalDays, totalDays: T },
    adjustedExDiv: !!H.adjusted,
    params: { feeDiscount: fd, stopPct: STOP * 100, maxHold: MAXHOLD, top: TOP, taxPct: 0.3,
      entry: '隔天開盤買進（漲停、停牌買不到）', exit: '停損 −5%；收盤跌破 5 日線隔天開盤賣；最長 20 天收盤賣',
      control: '同一天買、同一時間賣的基本門檻合格股票平均', stableDividend: '不開', heldRule: '持有中的同一檔不重複買',
      holdDaysNote: '持有天數從買進當天算起，到賣出那天' },
    signalDays, avgPicksPerSignalDay: signalDays ? round2(pickSum / signalDays) : 0,
    funnel,
    zhu: z,
    reference: Object.assign({ label: '原版前 10 檔持有 20 天（不設停損，有開不暴衝）' }, summarize(ref, dates))
  };
  fs.writeFileSync(outPath, JSON.stringify(out));
  if (dumpPath) fs.writeFileSync(dumpPath, JSON.stringify(zhu.map(x => Object.assign({}, x, { date: dates[x.t] }))));
  console.log(`回測完成：${out.range.from} ~ ${out.range.to}，${evalDays} 個交易日，有訊號 ${signalDays} 天，交易 ${zhu.length} 筆，` +
    `每筆多賺 ${z.excess}%，過關：${z.pass.ok}，用時 ${Math.round((Date.now() - t0) / 1000)} 秒`);
}

module.exports = { sma, isHigh, isLow, swings, zhuSignal, enter, simZhu, ctrl, makeNet, prep };
if (require.main === module) main();
