#!/usr/bin/env node
// Minervini 趨勢條件（簡化版，組合 M）回測。規格是 Ben 2026-10-30 確認的（看結果前定死），過關標準不能事後改。
// 用法：node scripts/backtest_minervini.js 歷史檔.json index.html 輸出.json [--fee-discount 0.28] [--until 日期] [--noise 30] [--dump-trades 檔案] [--dump-gate 檔案]
//
// 選股（每天收盤後，先過基本門檻：成交金額、股價、不暴衝，和其他回測的對照組同一批）：
//   股價 > 150 日、200 日均線；150 日均線 > 200 日均線；150、200 日均線都比 21 個交易日前高；
//   50 日均線 > 150 日、200 日均線；股價 ≥ 52 週（250 個交易日）最低點 ×1.3；股價 ≥ 52 週最高點 ×0.75；
//   近 250 日漲幅在當天合格股票裡排前 30%（百分位 ≥ 0.70，算法同網頁排名：排序後第 i 名 / (n−1)）
// 排序：通過的依近 250 日漲幅由高到低取前 10 檔；持有中的同一檔不重複買。
// 買賣：隔天開盤買（漲停、停牌買不到）；停損 −8%（盤中碰到就賣，開盤跳空用開盤價）；沒碰到持有 30 個交易日收盤賣。
// 對照組：同一天買、同一個賣出日的全部基本門檻合格股票平均（同樣手續費）。
// 過關（四條都要過；筆數 < 300 只當參考）：
//   ① 每筆多賺 ≥ 0.5，且比雜訊尺平均再多 ≥ 0.5  ② 前中後三段多賺都 > 0
//   ③ 逐月多賺為正的月份超過一半  ④ 2026/6～9 多賺 ≥ 0 且至少 30 筆
// 參考組（不納入過關）：fixed30（同樣訊號，固定持有 30 天不設停損，看結果後才加）、peek（偷看未來的假訊號）。
const fs = require('fs');
const Z = require('./backtest_zhu.js');
const B = require('./backtest_lin.js');
const { enter, ctrl, makeNet, sma } = Z;
const { summarize, exc, rng, simHold } = B;

const TOP = 10, WARM = 125, WIN = 130, MINIDX = 250, HOLD = 30, STOP = 0.08, YEAR = 250, SLOPE_LAG = 21;
const RS_MIN = 0.70, LOW_MULT = 1.3, HIGH_MULT = 0.75, MIN_N = 300, RECENT_MIN_N = 30, GOAL = 0.5;
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const round2 = x => Math.round(x * 100) / 100;

// 每檔股票的均線只算一次
function mas(st) {
  if (!st._mm) st._mm = { m50: sma(st.closes, 50), m150: sma(st.closes, 150), m200: sma(st.closes, 200) };
  return st._mm;
}
// 趨勢條件（不含 RS）。t = 全域日序號。回傳 { pass, ret250, why }；資料不夠回傳 pass=false、ret250=null
function template(st, t) {
  const i = t - st.s;
  if (i < YEAR || t > st.e) return { pass: false, ret250: null, why: 'short' };
  const c = st.closes[i], c0 = st.closes[i - YEAR];
  if (!(c > 0) || !(c0 > 0)) return { pass: false, ret250: null, why: 'bad' };
  const ret250 = c / c0 - 1;
  const M = mas(st), m50 = M.m50[i], m150 = M.m150[i], m200 = M.m200[i], p150 = M.m150[i - SLOPE_LAG], p200 = M.m200[i - SLOPE_LAG];
  if ([m50, m150, m200, p150, p200].some(v => v === null || !Number.isFinite(v))) return { pass: false, ret250, why: 'ma' };
  let hi = -Infinity, lo = Infinity;
  for (let j = i - YEAR + 1; j <= i; j++) {
    const h = st.highs[j], l = st.lows[j];
    if (!(h > 0) || !(l > 0)) return { pass: false, ret250, why: 'bad' };
    if (h > hi) hi = h;
    if (l < lo) lo = l;
  }
  const checks = {
    above150: c > m150, above200: c > m200, m150gt200: m150 > m200,
    up150: m150 > p150, up200: m200 > p200,
    m50gt150: m50 > m150, m50gt200: m50 > m200,
    low30: c >= lo * LOW_MULT, high25: c >= hi * HIGH_MULT
  };
  const failed = Object.keys(checks).filter(k => !checks[k]);
  return { pass: failed.length === 0, ret250, why: failed.join(',') || 'ok', checks };
}
// 百分位：rows = [{code, ret250}]，回傳 Map(code → 0～1)。排序後第 i 名 / (n−1)；n=1 為 0.5；同分用代號排，結果固定
function pctRanks(rows) {
  const a = [...rows].sort((p, q) => p.ret250 - q.ret250 || (p.code < q.code ? -1 : p.code > q.code ? 1 : 0));
  const n = a.length, m = new Map();
  a.forEach((x, i) => m.set(x.code, n > 1 ? i / (n - 1) : 0.5));
  return m;
}
// Minervini 簡化買賣：隔天開盤買，停損 −8%（盤中碰到就賣；開盤跳空用開盤價），否則持有 HOLD 天收盤賣。
// 回傳 { r, x, type, px }；買不到或資料到頭還沒了結回傳 null
function simMin(st, t, T, net, stopPct = STOP, hold = HOLD) {
  const entry = enter(st, t, T);
  if (entry === null) return null;
  const sp = entry * (1 - stopPct), lastDay = Math.min(t + hold, st.e, T - 1);
  for (let j = t + 1; j <= lastDay; j++) {
    const k = j - st.s;
    if (st.vols[k] > 0 && st.lows[k] <= sp) return { r: net(entry, Math.min(sp, st.opens[k])), x: j, type: 'stop', px: 'close' };
    if (j === t + hold || (j === lastDay && st.e < T - 1)) return { r: net(entry, st.closes[k]), x: j, type: 'expire', px: 'close' };
    if (j === lastDay) return null;
  }
  return null;
}
// 過關判斷。z = fullSummary 的結果，noiseMean = 雜訊尺平均多賺
function evalMin(z, noiseMean) {
  const months = (z.byMonth || []).filter(m => m.excess !== null);
  const won = months.filter(m => m.excess > 0).length;
  const c1 = z.excess !== null && z.excess >= GOAL && noiseMean !== null && noiseMean !== undefined && round2(z.excess - noiseMean) >= GOAL;
  const c2 = z.parts.every(p => p.excess !== null && p.excess > 0);
  const c3 = months.length > 0 && won * 2 > months.length;
  const c4 = z.recent.excess !== null && z.recent.excess >= 0 && z.recent.n >= RECENT_MIN_N;
  const all = c1 && c2 && c3 && c4;
  return { c1_excessAndNoise: c1, c2_parts: c2, c3_months: c3, c4_recent: c4, monthsWin: won, monthsTotal: months.length,
    smallSample: z.n < MIN_N, passIgnoringSample: all, ok: all && z.n >= MIN_N };
}

function main() {
  const [, , histPath, htmlPath, outPath, ...rest] = process.argv;
  if (!histPath || !htmlPath || !outPath) {
    console.error('用法：node scripts/backtest_minervini.js 歷史檔.json index.html 輸出.json [--fee-discount 0.28] [--until 日期] [--noise 30]');
    process.exit(2);
  }
  let fd = 0.28, dumpPath = null, gatePath = null, until = null, noiseN = 30;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--fee-discount') fd = parseFloat(rest[++i]);
    else if (rest[i] === '--dump-trades') dumpPath = rest[++i];
    else if (rest[i] === '--dump-gate') gatePath = rest[++i];
    else if (rest[i] === '--until') until = rest[++i];
    else if (rest[i] === '--noise') noiseN = parseInt(rest[++i], 10);
  }
  if (!(fd > 0 && fd <= 1)) { console.error('--fee-discount 要在 0 到 1 之間'); process.exit(2); }
  const net = makeNet(fd);

  const html = fs.readFileSync(htmlPath, 'utf8');
  const mm = html.match(/\/\/<core>([\s\S]*?)\/\/<\/core>/);
  if (!mm) { console.error('index.html 裡找不到 //<core> 區塊'); process.exit(2); }
  const { runAll, DEFAULT_CFG, DEFAULT_ON } = new Function(mm[1] + ';return {runAll,DEFAULT_CFG,DEFAULT_ON};')();

  const H = JSON.parse(fs.readFileSync(histPath, 'utf8'));
  const dates = H.dates, mk = H.market.closes, stocks = H.stocks;
  let T = dates.length;
  if (until) { T = dates.filter(d => d <= until).length; if (T < MINIDX + 2) { console.error('--until 太早，資料不夠'); process.exit(2); } }
  const on = Object.assign({}, DEFAULT_ON, { div: false });
  const cache = new Map();

  const mkVar = (stop, peek, fixed) => ({ stop, peek: !!peek, fixed: fixed || 0, held: new Map(), trades: [], pickCount: new Map() });
  const V = { main: mkVar(true), fixed30: mkVar(false, false, HOLD), peek: mkVar(true, true) };
  const gateByDay = new Map(), gateDump = {};
  const funnel = { gate: 0, withRet: 0, template: 0, rs: 0, skippedHeld: 0 };
  let evalDays = 0, signalDays = 0, pickSum = 0;
  const t0 = Date.now();

  for (let t = MINIDX; t < T - 1; t++) {
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
    const gate = res.rows.filter(x => x.ev.chk.liq && x.ev.chk.price && x.ev.chk.safe);
    funnel.gate += gate.length;
    const info = gate.map(x => ({ x, code: x.s.code, tp: template(x.s.full, t) }));
    const withRet = info.filter(o => o.tp.ret250 !== null);
    funnel.withRet += withRet.length;
    const pct = pctRanks(withRet.map(o => ({ code: o.code, ret250: o.tp.ret250 })));
    const tpass = info.filter(o => o.tp.pass);
    funnel.template += tpass.length;
    const cand = tpass.filter(o => pct.get(o.code) >= RS_MIN).sort((p, q) => q.tp.ret250 - p.tp.ret250 || (p.code < q.code ? -1 : 1));
    funnel.rs += cand.length;
    if (!cand.length) continue;
    const gateObj = gate.map(x => ({ s: { full: x.s.full } }));
    gateByDay.set(t, gateObj);
    if (gatePath) gateDump[dates[t]] = gate.map(x => x.s.code);

    for (const [name, v] of Object.entries(V)) {
      let fresh = cand.filter(o => !(v.held.has(o.code) && t < v.held.get(o.code)));
      if (name === 'main') funnel.skippedHeld += cand.length - fresh.length;
      if (v.peek) {       // 偷看未來的假過濾：只留 30 天後收盤比現在高的（應該大贏，證明過濾有被算進去）
        fresh = fresh.filter(o => { const st = o.x.s.full; return t + HOLD <= T - 1 && st.e >= t + HOLD && st.closes[t + HOLD - st.s] > st.closes[t - st.s]; });
      }
      const picks = fresh.slice(0, TOP);
      v.pickCount.set(t, picks.length);
      if (name === 'main' && picks.length) { signalDays++; pickSum += picks.length; }
      for (const o of picks) {
        const st = o.x.s.full;
        let r;
        if (v.fixed) {
          const rr = simHold(st, t, T, v.fixed, net);
          r = rr === null ? null : { r: rr, x: t + v.fixed, type: 'fixed', px: 'close' };
        } else r = simMin(st, t, T, net);
        if (!r) continue;
        v.held.set(o.code, r.x);
        v.trades.push({ code: o.code, t, x: r.x, r: r.r, c: ctrl(gateObj, t, r.x, r.px, T, net, cache), hold: r.x - t, type: r.type, ret250: o.tp.ret250, rs: pct.get(o.code) });
      }
    }
  }

  // 雜訊尺：同樣的日子隨機挑同樣數量的合格股票，用同樣的出場規則
  const noise = [];
  const days = [...gateByDay.keys()].filter(t => (V.main.pickCount.get(t) || 0) > 0).sort((a, b) => a - b);
  for (let seed = 1; seed <= noiseN; seed++) {
    const rnd = rng(seed), held = new Map(), tr = [];
    for (const t of days) {
      const g = gateByDay.get(t);
      const avail = g.filter(x => !(held.has(x.s.full.code) && t < held.get(x.s.full.code)));
      const k = Math.min(V.main.pickCount.get(t), avail.length);
      for (let i = 0; i < k; i++) {
        const j = i + Math.floor(rnd() * (avail.length - i));
        [avail[i], avail[j]] = [avail[j], avail[i]];
        const st = avail[i].s.full, r = simMin(st, t, T, net);
        if (!r) continue;
        held.set(st.code, r.x);
        tr.push({ t, r: r.r, c: ctrl(g, t, r.x, r.px, T, net, cache) });
      }
    }
    noise.push({ seed, n: tr.length, excess: exc(tr), avg: tr.length ? round2(mean(tr.map(x => x.r)) * 100) : null, win: tr.length ? round2(tr.filter(x => x.r > 0).length / tr.length * 100) : null });
  }

  const full = (trades) => {
    const z = summarize(trades, dates);
    if (trades.length) {
      z.avgHoldDays = round2(mean(trades.map(x => x.hold)));
      const ty = {};
      for (const x of trades) (ty[x.type] = ty[x.type] || []).push(x);
      z.exits = Object.fromEntries(Object.entries(ty).map(([k, a]) => [k, { n: a.length, share: round2(a.length / trades.length * 100), avg: round2(mean(a.map(x => x.r)) * 100) }]));
    }
    return z;
  };
  const sum = {};
  for (const [k, v] of Object.entries(V)) sum[k] = full(v.trades);
  const nz = noise.map(x => x.excess).filter(x => x !== null), nw = noise.map(x => x.win).filter(x => x !== null);
  const sd = a => a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)) : null;
  const noiseSum = noise.length ? { runs: noise, mean: round2(mean(nz)), sd: round2(sd(nz)), min: Math.min(...nz), max: Math.max(...nz), winMean: round2(mean(nw)) } : null;
  const verdict = evalMin(sum.main, noiseSum ? noiseSum.mean : null);
  const out = {
    generatedAt: new Date().toISOString(),
    range: { from: dates[MINIDX], to: dates[T - 1], days: evalDays, totalDays: T },
    adjustedExDiv: !!H.adjusted,
    params: { feeDiscount: fd, top: TOP, hold: HOLD, stopPct: STOP * 100, taxPct: 0.3, rsMin: RS_MIN, year: YEAR, slopeLag: SLOPE_LAG, low: '≥ 52 週低點 ×' + LOW_MULT, high: '≥ 52 週高點 ×' + HIGH_MULT,
      control: '同一天買、同一個賣出日的基本門檻合格股票平均', stableDividend: '不開', heldRule: '持有中的同一檔不重複買' },
    note: '簡化版：只用趨勢條件，沒有 VCP／突破量能。RS 用近 250 日漲幅排名代替。fixed30 與 peek 是參考，不納入過關。',
    signalDays, avgPicksPerSignalDay: signalDays ? round2(pickSum / signalDays) : 0,
    funnel, verdict, main: sum.main, fixed30Reference: sum.fixed30, peekFuture: sum.peek, noise: noiseSum
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  if (dumpPath) fs.writeFileSync(dumpPath, JSON.stringify(V.main.trades.map(x => Object.assign({}, x, { date: dates[x.t], exitDate: dates[x.x] }))));
  if (gatePath) fs.writeFileSync(gatePath, JSON.stringify(gateDump));

  const m = sum.main, line = (n, r) => `${n.padEnd(8)} ${String(r.n).padStart(5)} 筆，平均 ${r.avg}%，勝率 ${r.win}%，多賺 ${r.excess}%；三段 ${r.parts.map(p => p.excess).join('/')}；2026/6~9 ${r.recent.n} 筆多賺 ${r.recent.excess}`;
  console.log(`回測完成：${out.range.from} ~ ${out.range.to}，${evalDays} 天，有訊號 ${signalDays} 天（平均 ${out.avgPicksPerSignalDay} 檔），手續費 ${fd} 折，用時 ${Math.round((Date.now() - t0) / 1000)} 秒`);
  console.log(`漏斗（累計股票日）：合格 ${funnel.gate} → 有 250 日資料 ${funnel.withRet} → 趨勢條件 ${funnel.template} → RS≥70 ${funnel.rs}（持有中跳過 ${funnel.skippedHeld}）`);
  console.log(line('main', m));
  console.log(line('fixed30', sum.fixed30));
  console.log(line('peek', sum.peek));
  if (m.exits) console.log('出場：' + Object.entries(m.exits).map(([k, e]) => `${k} ${e.share}%（平均 ${e.avg}%）`).join('，') + `；平均持有 ${m.avgHoldDays} 天`);
  if (noiseSum) console.log(`雜訊尺 ${noiseN} 組：多賺 平均 ${noiseSum.mean}（${noiseSum.min}~${noiseSum.max}），勝率平均 ${noiseSum.winMean}%；主規則比雜訊 ${round2(m.excess - noiseSum.mean)}`);
  const mk2 = b => b ? '✓' : '✗';
  console.log(`判定：①多賺且勝過雜訊 ${mk2(verdict.c1_excessAndNoise)} ②三段 ${mk2(verdict.c2_parts)} ③逐月 ${mk2(verdict.c3_months)}(${verdict.monthsWin}/${verdict.monthsTotal}) ④近期 ${mk2(verdict.c4_recent)}(${m.recent.n} 筆) → ${verdict.ok ? '過關（候選）' : verdict.smallSample ? '樣本不足，只當參考' : '沒過關'}`);
}

module.exports = { template, pctRanks, simMin, evalMin, mas, TOP, HOLD, STOP, YEAR, SLOPE_LAG, RS_MIN, MIN_N, RECENT_MIN_N };
if (require.main === module) main();
