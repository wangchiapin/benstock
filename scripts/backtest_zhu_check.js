#!/usr/bin/env node
// 朱家泓回測的「對照組偏差」檢查。不改 backtest_zhu.js，直接用它現成的訊號、買賣、對照組函式。
// 用法：node scripts/backtest_zhu_check.js 歷史檔.json index.html 輸出.json [--until 日期] [--noise 30] [--fee-discount 1]
//
// 為什麼要做：朱家泓回測的出場日是看每檔股票自己的走勢決定的（停損、跌破 5 日線），
// 而對照組是「同一天買、同一時間賣」的全部合格股票平均。能抱得久的股票通常是一直在漲的，
// 所以這種比法對「走勢決定出場」的規則偏有利。林恩如回測的雜訊尺顯示，隨機買 + 同樣出場規則就能多賺 +2.17%。
// 這裡對朱家泓做同樣的檢查（Ben 2026-10-29 確認的做法）：
//   1. 主規則：照原樣重算，要能重現 HANDOFF 7.2 的數字（用 --until 2026-10-20）
//   2. 雜訊尺：訊號日隨機挑同樣數量的合格股票，用同樣的出場規則（−5% 停損、跌破 5 日線賣、最長 20 天），30 組亂數
//   3. 固定持有 10 天、20 天（看結果後才加，不納入過關判斷）：同樣的訊號，不看出場規則
//   4. 比較：主規則的多賺 減 雜訊尺平均，剩下多少
// 不改原本的過關判定（多賺 ≥ 0.5 且前中後三段都 > 0），不再加新規則或組合。
const fs = require('fs');
const Z = require('./backtest_zhu.js');
const B = require('./backtest_lin.js');
const { zhuSignal, simZhu, ctrl, makeNet } = Z;
const { summarize, exc, rng, simHold } = B;

const TOP = 10, WARM = 125, WIN = 130, MAXHOLD = 20, GOAL = 0.5;
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const round2 = x => Math.round(x * 100) / 100;

// 持有中（還沒賣出）的同一檔不重複買
function freshOf(list, held, t) {
  return list.filter(x => !(held.has(x.s.code) && t < held.get(x.s.code)));
}
// 從 avail 隨機挑 k 檔（不重複；不夠就全部），同樣的亂數函式 → 同樣的結果
function samplePicks(avail, k, rnd) {
  const a = avail.slice(), n = Math.min(k, a.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rnd() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}
// 朱家泓原本的過關判定：每筆多賺 ≥ 0.5，且前、中、後三段都 > 0
const zhuPass = z => z.excess !== null && z.excess >= GOAL && z.parts.every(p => p.excess !== null && p.excess > 0);

// HANDOFF 7.2 記的數字（用 --until 2026-10-20 才能對照）
const EXPECTED_1020 = { n: 2497, excess: 0.22, parts: [-0.03, 0.66, 0.04], recent: -0.11 };

function main() {
  const [, , histPath, htmlPath, outPath, ...rest] = process.argv;
  if (!histPath || !htmlPath || !outPath) {
    console.error('用法：node scripts/backtest_zhu_check.js 歷史檔.json index.html 輸出.json [--until 日期] [--noise 30] [--fee-discount 1]');
    process.exit(2);
  }
  let fd = 1, until = null, noiseN = 30;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--fee-discount') fd = parseFloat(rest[++i]);
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
  if (until) { T = dates.filter(d => d <= until).length; if (T < WARM + 2) { console.error('--until 太早，資料不夠'); process.exit(2); } }
  const on = Object.assign({}, DEFAULT_ON, { div: false });
  const cache = new Map();

  const mkVar = fixed => ({ fixed: fixed || 0, held: new Map(), trades: [], pickCount: new Map() });
  const V = { main: mkVar(0), fixed10: mkVar(10), fixed20: mkVar(MAXHOLD) };
  const gateByDay = new Map();
  let evalDays = 0, signalDays = 0;
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
    const gate = res.rows.filter(x => x.ev.chk.liq && x.ev.chk.price && x.ev.chk.safe);
    const cand = gate.filter(x => zhuSignal(x.s.full, t).pass).sort((p, q) => q.m.ret20 - p.m.ret20);
    if (!cand.length) continue;
    gateByDay.set(t, gate.map(x => ({ s: { code: x.s.code, full: x.s.full } })));

    for (const [name, v] of Object.entries(V)) {
      const picks = freshOf(cand, v.held, t).slice(0, TOP);
      v.pickCount.set(t, picks.length);
      if (name === 'main' && picks.length) signalDays++;
      for (const x of picks) {
        const st = x.s.full;
        let r;
        if (v.fixed) {
          const rr = simHold(st, t, T, v.fixed, net);
          r = rr === null ? null : { r: rr, x: t + v.fixed, type: 'fixed', px: 'close' };
        } else r = simZhu(st, t, T, net);
        if (!r) continue;
        v.held.set(x.s.code, r.x);
        v.trades.push({ code: x.s.code, t, r: r.r, c: ctrl(gate, t, r.x, r.px, T, net, cache), hold: r.x - t, type: r.type });
      }
    }
  }

  // 雜訊尺：訊號日隨機挑同樣數量的合格股票，用同樣的出場規則
  const noise = [];
  const days = [...gateByDay.keys()].filter(t => (V.main.pickCount.get(t) || 0) > 0).sort((a, b) => a - b);
  for (let seed = 1; seed <= noiseN; seed++) {
    const rnd = rng(seed), held = new Map(), tr = [];
    for (const t of days) {
      const g = gateByDay.get(t);
      for (const x of samplePicks(freshOf(g, held, t), V.main.pickCount.get(t), rnd)) {
        const r = simZhu(x.s.full, t, T, net);
        if (!r) continue;
        held.set(x.s.code, r.x);
        tr.push({ t, r: r.r, c: ctrl(g, t, r.x, r.px, T, net, cache) });
      }
    }
    noise.push({ seed, n: tr.length, excess: exc(tr), avg: tr.length ? round2(mean(tr.map(x => x.r)) * 100) : null });
  }

  const sm = {};
  for (const [k, v] of Object.entries(V)) {
    sm[k] = summarize(v.trades, dates);
    sm[k].passOriginal = zhuPass(sm[k]);
    if (v.trades.length) sm[k].avgHoldDays = round2(mean(v.trades.map(x => x.hold)));
  }
  const nz = noise.map(x => x.excess).filter(x => x !== null);
  const nzMean = nz.length ? mean(nz) : null;
  const nzSd = nz.length ? Math.sqrt(mean(nz.map(x => (x - nzMean) ** 2))) : null;
  const m = sm.main;
  const out = {
    generatedAt: new Date().toISOString(),
    range: { from: dates[WARM], to: dates[T - 1], days: evalDays, totalDays: T },
    note: '檢查對照組偏差用，不改變原本朱家泓回測的過關判定。固定持有 10／20 天是看結果後才加的參考。',
    params: { feeDiscount: fd, stopPct: 5, maxHold: MAXHOLD, top: TOP, taxPct: 0.3, noiseRuns: noiseN },
    signalDays,
    main: m,
    noise: noise.length ? { runs: noise, mean: round2(nzMean), sd: round2(nzSd), min: Math.min(...nz), max: Math.max(...nz) } : null,
    mainMinusNoise: nz.length && m.excess !== null ? { diff: round2(m.excess - nzMean), sdUnits: nzSd ? round2((m.excess - nzMean) / nzSd) : null } : null,
    fixed10Reference: sm.fixed10,
    fixed20Reference: sm.fixed20
  };
  if (until === '2026-10-20') {
    const actual = { n: m.n, excess: m.excess, parts: m.parts.map(p => p.excess), recent: m.recent.excess };
    const same = actual.n === EXPECTED_1020.n && actual.excess === EXPECTED_1020.excess && actual.recent === EXPECTED_1020.recent &&
      actual.parts.every((v, i) => v === EXPECTED_1020.parts[i]);
    out.reproduce = { expected: EXPECTED_1020, actual, match: same };
  }
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`檢查完成：${out.range.from} ~ ${out.range.to}，主規則 ${m.n} 筆，多賺 ${m.excess}%，雜訊尺平均 ${out.noise ? out.noise.mean : '-'}%，` +
    `固定持有 10／20 天多賺 ${sm.fixed10.excess}／${sm.fixed20.excess}%` + (out.reproduce ? `，重現舊結果：${out.reproduce.match}` : '') +
    `，用時 ${Math.round((Date.now() - t0) / 1000)} 秒`);
}

module.exports = { freshOf, samplePicks, zhuPass, EXPECTED_1020 };
if (require.main === module) main();
