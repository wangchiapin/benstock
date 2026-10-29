#!/usr/bin/env node
// backtest_g.js 的單元測試（人造資料，不連網）。用法：node scripts/test_g.js
const G = require('./backtest_g.js');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg}（實際 ${a}，預期 ${b}）`); }
function near(a, b, msg, tol = 1e-9) { ok(Math.abs(a - b) <= tol, `${msg}（實際 ${a}，預期 ${b}）`); }

// ---------- 大盤強勢判定 ----------
{
  const flat = n => new Array(n).fill(100);
  eq(G.isStrong(flat(19)), false, '資料不到 20 天不算強勢');
  eq(G.isStrong(null), false, '沒資料不算強勢');
  eq(G.isStrong(flat(30)), false, '收盤剛好等於均線不算在均線上（要 >）');
  // 緩漲：收盤在均線上、均線向上
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  eq(G.isStrong(up), true, '緩漲 → 強勢');
  // 緩跌：收盤在均線下
  const down = Array.from({ length: 30 }, (_, i) => 130 - i);
  eq(G.isStrong(down), false, '緩跌 → 不強勢');
  // 月線上但月線往下（weakening）：先高後回檔，收盤仍高於 20 日均線，但均線比 5 天前低
  const weak = [...new Array(10).fill(200), ...new Array(15).fill(100), 105, 110, 115, 120, 125];
  const n = weak.length, ma = (a, b) => weak.slice(a, b).reduce((s, x) => s + x, 0) / (b - a);
  ok(weak[n - 1] > ma(n - 20, n) && ma(n - 20, n) < ma(n - 25, n - 5), '測試資料本身：收盤在均線上、均線往下');
  eq(G.isStrong(weak), false, '月線上但月線往下 → 不強勢');
  // 剛好 20 天（不到 25 天）：ma20prev 取 ma20 → 只看收盤是否 > 均線
  eq(G.isStrong(Array.from({ length: 20 }, (_, i) => 100 + i)), true, '剛好 20 天且在均線上 → 強勢');
  eq(G.isStrong(Array.from({ length: 24 }, (_, i) => 100 + i)), true, '24 天（還沒 25 天）緩漲 → 強勢');
  // 均線 5 天前剛好相等（≥ 成立）：前面 5 天高低互相抵消
  const eqCase = [...new Array(20).fill(100), 100, 100, 100, 100, 101];
  // ma20 = (15*100 + 100*4 +101)/20... 這裡只檢查 ≥ 的邊界：n=25，ma20=(…)≥ma20prev=100
  eq(G.isStrong(eqCase), true, '均線 ≥ 5 天前均線（略高）且收盤在均線上 → 強勢');
}

// ---------- 2.8 折成本 ----------
{
  const n28 = G.makeNet(0.28), n1 = G.makeNet(1);
  near(n1(100, 100), 100 * (1 - 0.001425 - 0.003) / (100 * 1.001425) - 1, '全額成本：平盤賣出的淨報酬');
  near(n28(100, 100), 100 * (1 - 0.001425 * 0.28 - 0.003) / (100 * (1 + 0.001425 * 0.28)) - 1, '2.8 折成本：買賣手續費各打 2.8 折，稅不打折');
  ok(n28(100, 100) > n1(100, 100), '2.8 折比全額便宜');
  // 稅沒打折：fd 趨近 0 時平盤損失 ≈ 0.3%
  near(G.makeNet(1e-9)(100, 100), -0.003, '手續費趨近 0 時只剩 0.3% 證交稅', 1e-6);
  // 買賣各一次：手續費差 = 2 × 0.001425 × (1-0.28) ≈ 0.2052%
  near(n28(100, 100) - n1(100, 100), 0.001425 * 0.72 * 2, '兩種費率差約 0.205%', 2e-5);
}

// ---------- 持有 30 天、買不到 ----------
{
  const len = 60, base = (o) => Object.assign({ code: 'X', s: 0, e: len - 1,
    closes: Array.from({ length: len }, (_, i) => 100 + i), opens: Array.from({ length: len }, (_, i) => 100 + i),
    vols: new Array(len).fill(1000) }, o);
  const net = G.makeNet(0.28);
  ok(G.sim(base(), 10, 30, 41, net) !== null, '資料到第 40 天（T=41），t=10 持有 30 天剛好結算');
  eq(G.sim(base(), 11, 30, 41, net), null, 't=11 要第 41 天才賣，資料不夠 → 不算');
  // 開盤漲停買不到（開盤 ≥ 前收 × 1.095）
  const lim = base(); lim.opens[11] = lim.closes[10] * 1.095;
  eq(G.sim(lim, 10, 30, 60, net), null, '隔天開盤漲停（≥ 前收×1.095）→ 買不到');
  const almost = base(); almost.opens[11] = almost.closes[10] * 1.094;
  ok(G.sim(almost, 10, 30, 60, net) !== null, '開盤 +9.4% 還買得到');
  // 停牌（成交量 0）
  const sus = base(); sus.vols[11] = 0;
  eq(G.sim(sus, 10, 30, 60, net), null, '隔天停牌 → 買不到');
  // 隔天已下市
  const gone = base(); gone.e = 10;
  eq(G.sim(gone, 10, 30, 60, net), null, '隔天已沒有資料 → 買不到');
  // 持有中途下市：用最後一天收盤賣
  const delist = base(); delist.e = 25;
  near(G.sim(delist, 10, 30, 60, net), net(111, 125), '持有中途下市：以最後有資料那天收盤結算');
  // 不設停損：中途大跌也要抱到第 30 天
  const crash = base(); for (let i = 15; i < 40; i++) crash.closes[i] = 50; crash.closes[40] = 130;
  near(G.sim(crash, 10, 30, 60, net), net(111, 130), '不設停損：中途跌到 50 仍抱到第 30 天收盤 130');
  // s 偏移（股票晚上市）
  const late = base({ s: 5, e: 64, closes: Array.from({ length: 60 }, (_, i) => 200 + i), opens: Array.from({ length: 60 }, (_, i) => 200 + i), vols: new Array(60).fill(1000) });
  near(G.sim(late, 10, 30, 70, net), net(late.opens[6], late.closes[35]), '有 s 偏移時索引正確（開盤 k=6、收盤 k=35）');
}

// ---------- B 過濾 ----------
{
  const row = (rev, inst) => ({ rev, inst });
  eq(G.passB(row(0.1, 0.01)), true, '營收成長、法人買超 → 留');
  eq(G.passB(row(-0.01, 0.01)), false, '營收年增率 < 0 → 排除');
  eq(G.passB(row(0.1, -0.01)), false, '法人賣超 → 排除');
  eq(G.passB(row(null, null)), true, '兩者都沒資料 → 不排除');
  eq(G.passB(row(null, 0.01)), true, '營收沒資料、法人買超 → 留');
  eq(G.passB(row(0.1, null)), true, '法人沒資料 → 不排除');
  eq(G.passB(row(0, 0)), true, '剛好 0 不算 < 0 → 留');
  eq(G.passB(row(null, -0.5)), false, '營收沒資料但法人賣超 → 排除');
}

// ---------- 排名取前 10 ----------
{
  const pool = Array.from({ length: 15 }, (_, i) => ({ id: i, ev: { rank: i } }));
  const top = G.topPicks(pool);
  eq(top.length, 10, '取前 10 檔');
  eq(top[0].id, 14, '第一名是 rank 最高');
  eq(top[9].id, 5, '第十名是 rank=5');
  eq(pool[0].id, 0, '不改動原本的清單');
  eq(G.topPicks(pool.slice(0, 3)).length, 3, '不到 10 檔就全部');
}

// ---------- 統計與三段、近期 ----------
{
  const dates = []; for (let i = 0; i < 90; i++) dates.push(i < 60 ? '2025-01-01' : '2026-07-01');
  const base = new Map(); for (let t = 0; t < 90; t++) base.set(t, 0.01);
  const trades = [];
  for (let t = 0; t < 90; t++) trades.push({ t, r: t % 2 ? 0.05 : -0.02 });
  const s = G.summarize(trades, base, dates);
  eq(s.n, 90, '90 筆');
  eq(s.win, 50, '勝率 50');
  near(s.avg, 1.5, '平均 1.5%');
  near(s.excess, 0.5, '多賺 = 平均 1.5 − 對照 1 = 0.5', 0.01);
  eq(s.parts.length, 3, '三段');
  eq(s.parts[0].n + s.parts[1].n + s.parts[2].n, 90, '三段筆數相加 = 全部');
  eq(s.recent.n, 30, '2026/6～9 的筆數（t=60..89）');
  eq(G.summarize([], base, dates).n, 0, '空資料不報錯');
  // 對照組缺的日子不算進多賺
  const base2 = new Map([[0, 0.01]]);
  near(G.summarize([{ t: 0, r: 0.03 }, { t: 1, r: 0.99 }], base2, dates).excess, 2, '沒有對照組的那天不算進多賺');
}

// ---------- 過關判斷 ----------
{
  const g = (win, excess, pw, rn, rex, n = 400) => ({ n, win, excess, parts: pw.map(w => ({ win: w })), recent: { n: rn, excess: rex } });
  const b = { excess: 1.0 };
  let j = G.judgeG(g(50, 1.0, [48, 48, 48], 30, 0), b);
  ok(j.pass, '全部剛好在門檻上 → 過關（勝率 50.00、多賺 = B、三段 48、近期 30 筆 0）');
  ok(!G.judgeG(g(49.99, 5, [60, 60, 60], 100, 5), b).pass, '勝率 49.99 → 沒過');
  ok(!G.judgeG(g(55, 0.99, [60, 60, 60], 100, 5), b).pass, '多賺比 B 少 0.01 → 沒過');
  ok(!G.judgeG(g(55, 2, [60, 47.99, 60], 100, 5), b).pass, '有一段勝率 47.99 → 沒過');
  ok(!G.judgeG(g(55, 2, [60, 60, 60], 100, -0.01), b).pass, '近期多賺 −0.01 → 沒過');
  ok(!G.judgeG(g(55, 2, [60, 60, 60], 29, 5), b).pass, '近期只有 29 筆 → 沒過');
  j = G.judgeG(g(55, 2, [60, 60, 60], 100, 5, 299), b);
  ok(!j.pass && j.smallSample && j.passIgnoringSample, '299 筆：條件都過但樣本不足 → 只當參考，不算過關');
  ok(G.judgeG(g(55, 2, [60, 60, 60], 100, 5, 300), b).pass, '剛好 300 筆可以算');
  ok(!G.judgeG({ n: 0, excess: null, parts: [{}, {}, {}], recent: { n: 0, excess: null } }, b).pass, '沒有交易 → 沒過，不報錯');
  ok(!G.judgeG(g(55, null, [60, 60, 60], 100, 5), b).pass, 'G 沒有多賺資料 → 沒過');
  ok(!G.judgeG(g(55, 2, [60, 60, 60], 100, 5), { excess: null }).pass, 'B 沒有多賺資料 → 沒過');
  eq(G.CRIT.win, 50, '門檻：勝率 50');
  eq(G.CRIT.partWin, 48, '門檻：三段勝率 48');
  eq(G.CRIT.recentMinN, 30, '門檻：近期至少 30 筆');
  eq(G.CRIT.minN, 300, '門檻：至少 300 筆');
}

console.log(`\n${pass} 項通過${fail ? '，' + fail + ' 項失敗' : ''}`);
process.exit(fail ? 1 : 0);
