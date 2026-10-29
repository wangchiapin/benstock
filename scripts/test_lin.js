#!/usr/bin/env node
// backtest_lin.js 的單元測試（人造股價，不連網）。用法：node scripts/test_lin.js
const L = require('./backtest_lin.js');
const { makeNet } = require('./backtest_zhu.js');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg}（實際 ${a}，預期 ${b}）`); }
function near(a, b, msg, tol = 1e-9) { ok(a !== null && Math.abs(a - b) < tol, `${msg}（實際 ${a}，預期 ${b}）`); }

const net = makeNet(1);

// 產生交易日：從 2024-01-01（週一）起，每週 5 天；skip 裡的日期不開市
function mkDates(nWeeks, skip = []) {
  const out = [];
  const d = new Date(Date.UTC(2024, 0, 1));
  while (out.length < nWeeks * 5 - skip.length) {
    const wd = d.getUTCDay();
    const s = d.toISOString().slice(0, 10);
    if (wd >= 1 && wd <= 5 && !skip.includes(s)) out.push(s);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
// 每週 5 天，同一週的收盤價相同；開盤 = 前一天收盤（沒有跳空）
function mkStock(weekCloses, o = {}) {
  const T = weekCloses.length * 5;
  const closes = [], opens = [], highs = [], lows = [], vols = [];
  for (let d = 0; d < T; d++) {
    const c = weekCloses[Math.floor(d / 5)];
    closes.push(c);
    opens.push(d === 0 ? c : closes[d - 1]);
    vols.push(1000);
  }
  for (const [d, v] of Object.entries(o.opens || {})) opens[+d] = v;
  for (const [d, v] of Object.entries(o.closes || {})) closes[+d] = v;
  for (const d of (o.zeroVol || [])) vols[d] = 0;
  for (let d = 0; d < T; d++) { highs.push(Math.max(opens[d], closes[d])); lows.push(Math.min(opens[d], closes[d])); }
  for (const [d, v] of Object.entries(o.lows || {})) lows[d] = v;
  return { code: 'TEST', name: 't', s: 0, e: o.e === undefined ? T - 1 : o.e, opens, highs, lows, closes, vols };
}
const flat = (n, v) => new Array(n).fill(v);

// ---------- 週別 ----------
{
  eq(L.mondayKey('2024-01-01'), '2024-01-01', '週一就是自己');
  eq(L.mondayKey('2024-01-05'), '2024-01-01', '週五歸同一週');
  eq(L.mondayKey('2024-01-07'), '2024-01-01', '週日歸前一個週一');
  eq(L.mondayKey('2024-01-08'), '2024-01-08', '下週一');
  eq(L.mondayKey('2024-03-01'), '2024-02-26', '跨月');

  // 第 2 週的週五（2024-01-12）不開市：週末是週四
  const dates = mkDates(4, ['2024-01-12']);
  const W = L.buildWeeks(dates, dates.length);
  eq(W.n, 4, '共 4 週');
  eq(W.ends[1] - W.starts[1], 3, '放假的那週只有 4 天');
  ok(W.isEnd[W.ends[0]] && W.isEnd[W.ends[1]] && W.isEnd[W.ends[2]], '週五、週四都是週末');
  ok(!W.isEnd[W.ends[3]], '資料最後一天不算週末（不確定有沒有收週）');
  ok(!W.isEnd[0] && !W.isEnd[1], '週中不是週末');
  eq(W.wpos[W.starts[2]], 2, '第三週的位置');

  // --until：只看前 T 天
  const W2 = L.buildWeeks(dates, 8);
  eq(W2.n, 2, '只看前 8 天 = 2 週（第二週只到週三）');
  ok(!W2.isEnd[7], '截斷後最後一天不算週末');
}

// ---------- 週收盤、20 週均線 ----------
{
  const nW = 25, dates = mkDates(nW), T = dates.length, W = L.buildWeeks(dates, T);
  const wcs = Array.from({ length: nW }, (_, i) => i + 1);          // 1, 2, ..., 25
  const st = mkStock(wcs);
  const X = L.weekly(st, W);
  eq(X.wc[0], 1, '第一週收盤');
  eq(X.wc[24], 25, '最後一週收盤');
  eq(X.ma[18], null, '不到 20 週沒有均線');
  near(X.ma[19], 10.5, '前 20 週平均 = 10.5');
  near(X.ma[24], 15.5, '第 6～25 週平均 = 15.5');

  // 週五停牌：用週四收盤
  const st2 = mkStock(wcs, { closes: { 4: 99 }, zeroVol: [4] });     // 第 1 週：週五停牌，週四收盤 = 1
  const X2 = L.weekly(st2, W);
  eq(X2.wc[0], 1, '週五停牌時用該週最後一個有成交的日子（週四收盤 1）');
  // 整週停牌：沒有週收盤，這 20 週的均線就算不出來
  const st3 = mkStock(wcs, { zeroVol: [5, 6, 7, 8, 9] });
  const X3 = L.weekly(st3, W);
  eq(X3.wc[1], null, '整週都停牌 = 沒有週收盤');
  eq(X3.ma[19], null, '涵蓋到那週的 20 週均線算不出來');
  near(X3.ma[21], (3 + 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11 + 12 + 13 + 14 + 15 + 16 + 17 + 18 + 19 + 20 + 21 + 22) / 20, '離開那週後均線又恢復');

  // 股票中途才上市：e/s 範圍外的天不算
  const st4 = mkStock(wcs); st4.s = 50;
  const X4 = L.weekly(st4, W);
  eq(X4.wc[5], null, '上市前沒有週收盤');
}

// ---------- 剛突破訊號 ----------
{
  const nW = 28, dates = mkDates(nW), T = dates.length, W = L.buildWeeks(dates, T);
  // 0～19 週 100；第 20 週 100（= 均線，不算突破）；第 21 週 105（剛突破）；第 22 週 106（已經在上面，不算剛突破）
  const wcs = [...flat(21, 100), 105, 106, 107, 108, 109, 110, 111];
  const st = mkStock(wcs);
  const wend = w => 5 * w + 4;
  eq(L.linSignal(st, wend(20), W), false, '收盤等於均線不算突破');
  eq(L.linSignal(st, wend(21), W), true, '第 21 週剛突破');
  eq(L.linSignal(st, wend(22), W), false, '已經在均線上面，不是剛突破');
  eq(L.linSignal(st, wend(21) - 1, W), false, '不是週末就不看');
  eq(L.linSignal(st, wend(10), W), false, '資料不足 20 週');

  // 缺資料：上週停牌整週 → 沒有上週收盤，不給訊號
  const stGap = mkStock(wcs, { zeroVol: [100, 101, 102, 103, 104] });   // 第 20 週整週停牌
  eq(L.linSignal(stGap, wend(21), W), false, '上週沒有收盤就不算剛突破');

  // 不偷看未來：把訊號日之後的價格全部改掉，訊號不變
  const wcs2 = wcs.map((v, i) => (i > 21 ? 1 : v));
  const stFuture = mkStock(wcs2);
  eq(L.linSignal(stFuture, wend(21), W), true, '改掉未來價格，當天訊號不變');
  const stFuture2 = mkStock(wcs2);
  const Xf = L.weekly(stFuture2, W);
  eq(Xf.ma[21], L.weekly(st, W).ma[21], '第 21 週均線不受之後價格影響');

  // 向下跌破不算訊號
  const wcsDown = [...flat(21, 100), 90, 80, 70, 60, 50, 40, 30];
  eq(L.linSignal(mkStock(wcsDown), wend(21), W), false, '跌破不是突破');
}

// ---------- 買賣模擬 ----------
{
  const nW = 30, dates = mkDates(nW), T = dates.length, W = L.buildWeeks(dates, T);
  const wend = w => 5 * w + 4;
  // 第 21 週末訊號，第 22 週一（第 110 天）開盤買 105。第 22、23 週都在均線上。第 24 週收盤 90 < 均線 → 第 25 週一（第 125 天）開盤賣
  const base = [...flat(21, 100), 105, 106, 107, 90, 95, 96, 97, 98, 99];
  {
    const st = mkStock(base, { opens: { 125: 88 } });
    ok(L.linSignal(st, wend(21), W), '前提：第 21 週有訊號');
    const r = L.simLin(st, wend(21), T, net, W, null);
    eq(r.type, 'ma', '跌破 20 週均線賣');
    eq(r.x, 125, '週末跌破，下一個交易日賣');
    eq(r.px, 'open', '賣在開盤');
    eq(r.ep, 105, '買在隔天開盤 105');
    eq(r.xp, 88, '賣價是賣出那天的開盤價');
    near(r.r, net(105, 88), '報酬有扣手續費和證交稅');
  }
  {
    // 賣出那天停牌 → 等到下一個有成交的日子
    const st = mkStock(base, { opens: { 126: 85 }, zeroVol: [125] });
    const r = L.simLin(st, wend(21), T, net, W, null);
    eq(r.x, 126, '賣出那天停牌，順延到下一個有成交的日子');
    eq(r.xp, 85, '用順延那天的開盤價');
  }
  {
    // 固定停損 −10%：買價 105 → 停損價 94.5。第 111 天盤中最低 90，開盤 105 → 賣 94.5
    const st = mkStock(base, { lows: { 111: 90 } });
    const r = L.simLin(st, wend(21), T, net, W, 0.10);
    eq(r.type, 'stop', '碰到停損價');
    eq(r.x, 111, '碰到的那天賣');
    near(r.xp, 94.5, '賣在停損價');
    eq(r.px, 'close', '對照組用當天收盤（跟朱家泓回測一致）');
    // 開盤就跳空低於停損價 → 賣開盤價
    const st2 = mkStock(base, { opens: { 111: 92 }, lows: { 111: 90 } });
    const r2 = L.simLin(st2, wend(21), T, net, W, 0.10);
    eq(r2.xp, 92, '開盤就低於停損價，賣開盤價');
    // 沒設停損不會被停損
    const r3 = L.simLin(st, wend(21), T, net, W, null);
    eq(r3.type, 'ma', '不設停損就照均線規則');
  }
  {
    // 買不到：開盤漲停（開盤價 ≥ 前一天收盤 × 1.095）
    const st = mkStock(base, { opens: { 110: 105 * 1.1 } });
    eq(L.simLin(st, wend(21), T, net, W, null), null, '開盤漲停買不到');
    const st2 = mkStock(base, { zeroVol: [110] });
    eq(L.simLin(st2, wend(21), T, net, W, null), null, '隔天停牌買不到');
  }
  {
    // 一直沒跌破 → 資料到頭未了結，用最後一天收盤
    const up = [...flat(21, 100), 105, 106, 107, 108, 109, 110, 111, 112, 113];
    const st = mkStock(up);
    const r = L.simLin(st, wend(21), T, net, W, null);
    eq(r.type, 'unfinished', '到資料最後一天還在持有');
    eq(r.x, T - 1, '以最後一天計算');
    eq(r.xp, 113, '用最後一天收盤');
    // 最後一個不完整的週不會觸發賣出：最後一週收盤 90，但資料最後一天不算週末
    const up2 = [...flat(21, 100), 105, 106, 107, 108, 109, 110, 111, 112, 90];
    const st2 = mkStock(up2);
    const r2 = L.simLin(st2, wend(21), T, net, W, null);
    eq(r2.type, 'unfinished', '最後那個不確定收週的週，不當成跌破訊號');
  }
  {
    // 下市：股票資料在 T-1 之前結束
    const up = [...flat(21, 100), 105, 106, 107, 108, 109, 110, 111, 112, 113];
    const st = mkStock(up, { e: 140 });
    const r = L.simLin(st, wend(21), T, net, W, null);
    eq(r.type, 'delist', '下市');
    eq(r.x, 140, '最後一天');
    eq(r.xp, st.closes[140], '用最後一天收盤');
  }
  {
    // 買進當週的週末就開始看：第 22 週收盤跌破 → 第 23 週一賣
    const w = [...flat(21, 100), 105, 80, 80, 80, 80, 80, 80, 80, 80];   // 第 21 週突破；第 22 週 80 < 均線
    const st = mkStock(w, { opens: { 115: 79 } });
    const r = L.simLin(st, wend(21), T, net, W, null);
    // 第 22 週在第 110～114 天；週末 114；隔天 115 賣
    eq(r.type, 'ma', '買進當週就開始看均線');
    eq(r.x, 115, '買進當週週末跌破，下週一賣');
  }
}

// ---------- 參考：固定持有 20 天 ----------
{
  const nW = 30, dates = mkDates(nW), T = dates.length, W = L.buildWeeks(dates, T);
  const base = [...flat(21, 100), 105, 106, 107, 90, 95, 96, 97, 98, 99];
  const st = mkStock(base);
  const r = L.simHold(st, 109, T, 20, net);
  near(r, net(105, st.closes[129]), '隔天開盤買、第 20 個交易日收盤賣');
  eq(L.simHold(st, 140, T, 20, net), null, '資料不夠 20 天不算');
  eq(L.simHold(mkStock(base, { opens: { 110: 105 * 1.1 } }), 109, T, 20, net), null, '開盤漲停買不到');
}

// ---------- 過關標準邊界 ----------
{
  const mk = (excess, parts, recent, months, n = 500) => ({
    n, excess, parts: parts.map(e => ({ excess: e })), recent: { excess: recent }, byMonth: months.map((e, i) => ({ m: '2025-' + (i + 1), n: 10, excess: e }))
  });
  const good = mk(0.5, [0.1, 0.2, 0.3], 0, [1, 1, -1]);
  const p = L.evalPass(good);
  ok(p.c1_excess, '剛好 0.5 算過（≥）');
  ok(p.c4_recent, '6～9 月剛好 0 算過（≥ 0）');
  ok(p.c3_months, '3 個月贏 2 個，超過一半');
  ok(p.ok, '四條都過');
  ok(!L.evalPass(mk(0.49, [0.1, 0.2, 0.3], 0, [1, 1, -1])).c1_excess, '0.49 沒過');
  ok(!L.evalPass(mk(0.6, [0.1, 0, 0.3], 0, [1, 1, -1])).c2_parts, '有一段剛好 0 沒過（要 > 0）');
  ok(!L.evalPass(mk(0.6, [0.1, 0.2, 0.3], 0, [1, -1])).c3_months, '剛好一半沒過（要超過一半）');
  ok(!L.evalPass(mk(0.6, [0.1, 0.2, 0.3], -0.01, [1, 1])).c4_recent, '6～9 月 −0.01 沒過');
  ok(!L.evalPass(mk(null, [0.1, 0.2, 0.3], 0, [1, 1])).c1_excess, '沒有對照資料不算過');
  ok(L.evalPass(mk(0.6, [0.1, 0.2, 0.3], 0, [1, 1], 99)).smallSample, '少於 100 筆標示樣本太少');
  ok(!L.evalPass(mk(0.6, [0.1, 0.2, 0.3], 0, [null, null])).c3_months, '沒有任何月份可比不算過');
}

// ---------- 統計 ----------
{
  const s = L.stats([0.1, -0.05, 0.2, -0.1]);
  eq(s.n, 4, '筆數');
  eq(s.win, 50, '勝率 50%');
  near(s.avg, 3.75, '平均', 1e-6);
  eq(s.worst, -10, '最慘單筆');
  near(L.exc([{ r: 0.1, c: 0.04 }, { r: 0.0, c: null }, { r: 0.02, c: 0.0 }]), 4, '多賺：略過沒有對照組的那筆', 1e-6);
  eq(L.exc([{ r: 0.1, c: null }]), null, '全部沒有對照組 = null');
  const r1 = L.rng(7), r2 = L.rng(7);
  eq(r1(), r2(), '同種子同結果');
  const a = L.rng(1)(), b = L.rng(2)();
  ok(a !== b && a >= 0 && a < 1, '不同種子不同結果，且在 0～1');
}

console.log(`\n${pass} 項通過${fail ? '，' + fail + ' 項失敗' : ''}`);
process.exit(fail ? 1 : 0);
