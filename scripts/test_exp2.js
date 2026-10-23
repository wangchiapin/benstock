#!/usr/bin/env node
// backtest_exp2.js 的單元測試（node scripts/test_exp2.js）：切點、波動、產業強弱、過關標準的邊界、讀檔
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const E = require('./backtest_exp2.js');
let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };
const close = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

console.log('最高 20% 的切點');
test('100 筆：剛好排除 20 筆（大於切點的）', () => {
  const v = Array.from({ length: 100 }, (_, i) => i + 1);
  const cut = E.quantileCut(v);
  assert.strictEqual(v.filter(x => x > cut).length, 20);
});
test('順序不影響結果', () => {
  const v = Array.from({ length: 100 }, (_, i) => (i * 37) % 100);
  assert.strictEqual(E.quantileCut(v), E.quantileCut([...v].reverse()));
});
test('null、NaN 不算進去', () => {
  const v = [...Array.from({ length: 100 }, (_, i) => i + 1), null, NaN, undefined];
  assert.strictEqual(v.filter(x => typeof x === 'number' && x > E.quantileCut(v)).length, 20);
});
test('有效資料少於 5 筆 → 不排除（Infinity）', () => {
  assert.strictEqual(E.quantileCut([1, 2, 3, 4]), Infinity);
  assert.strictEqual(E.quantileCut([null, null, 1, 2, 3, 4, null]), Infinity);
});
test('大量同值：不會排除到同值的股票（大於才算）', () => {
  const v = new Array(100).fill(1.5);
  assert.strictEqual(v.filter(x => x > E.quantileCut(v)).length, 0);
});
test('偷看未來用的 20% 最差：q=0.2 時取到最低端', () => {
  const v = Array.from({ length: 101 }, (_, i) => i);
  assert.strictEqual(E.quantileCut(v, 0.2), 20);
});

console.log('近 60 日波動');
test('價格不動 → 0', () => close(E.dailyVol(new Array(100).fill(10), 80), 0));
test('每天 ±1% 交替 → 樣本標準差（手算）', () => {
  const c = [100]; for (let i = 1; i <= 100; i++) c.push(c[i - 1] * (i % 2 ? 1.01 : 1 / 1.01));
  const r = []; for (let i = 41; i <= 100; i++) r.push(c[i] / c[i - 1] - 1);
  const m = r.reduce((a, b) => a + b, 0) / 60, sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / 59);
  close(E.dailyVol(c, 100), sd);
});
test('只看最近 60 天：更早的暴漲暴跌不影響', () => {
  const calm = new Array(200).fill(0).map((_, i) => 100 + (i % 2) * 0.1);
  const wild = calm.map((x, i) => (i < 100 ? x * (1 + (i % 2 ? 0.2 : -0.2)) : x));
  close(E.dailyVol(calm, 199), E.dailyVol(wild, 199), 1e-9);
});
test('資料不夠 60 天、或有 0 以下價格 → null', () => {
  assert.strictEqual(E.dailyVol(new Array(100).fill(10), 59), null);
  const c = new Array(100).fill(10); c[70] = 0;
  assert.strictEqual(E.dailyVol(c, 80), null);
});
test('用的是「當天」往前算，不是往後（不偷看未來）', () => {
  const c = new Array(200).fill(10);
  const base = E.dailyVol(c, 100);
  for (let i = 101; i < 200; i++) c[i] = 10 * (1 + (i % 2 ? 0.3 : -0.3));
  close(E.dailyVol(c, 100), base);
});

console.log('產業強弱');
const rowsFor = (spec) => {   // spec: {產業: [各檔漲幅]}
  const rows = [], ind = {};
  let n = 1000;
  for (const [s, rs] of Object.entries(spec)) for (const r of rs) { const code = String(n++); rows.push({ code, ret20: r }); ind[code] = s; }
  return { rows, ind };
};
test('強的一半可選、弱的一半不可選', () => {
  const { rows, ind } = rowsFor({ A: [0.10, 0.11, 0.12, 0.13, 0.14], B: [0.05, 0.06, 0.07, 0.08, 0.09], C: [0.00, 0.01, 0.02, 0.03, 0.04], D: [-0.10, -0.09, -0.08, -0.07, -0.06] });
  const ok = E.sectorFilter(rows, ind);
  const by = s => rows.filter(r => ind[r.code] === s).map(r => ok(r.code));
  assert.deepStrictEqual([by('A'), by('B'), by('C'), by('D')].map(a => a.every(Boolean)), [true, true, false, false]);
});
test('成員少於 5 檔的產業、查不到產業的股票：不排除', () => {
  const { rows, ind } = rowsFor({ A: [0.10, 0.11, 0.12, 0.13, 0.14], B: [0.05, 0.06, 0.07, 0.08, 0.09], C: [0.00, 0.01, 0.02, 0.03, 0.04], D: [-0.10, -0.09, -0.08, -0.07, -0.06], E: [-0.5, -0.5] });
  const ok = E.sectorFilter(rows, ind);
  rows.filter(r => ind[r.code] === 'E').forEach(r => assert.strictEqual(ok(r.code), true));
  assert.strictEqual(ok('9999'), true);
});
test('合格產業不到 4 個 → 全部可選', () => {
  const { rows, ind } = rowsFor({ A: [0.1, 0.1, 0.1, 0.1, 0.1], B: [-0.1, -0.1, -0.1, -0.1, -0.1] });
  const ok = E.sectorFilter(rows, ind);
  assert.ok(rows.every(r => ok(r.code)));
});
test('漲幅是 NaN 的股票不算進產業中位數', () => {
  const { rows, ind } = rowsFor({ A: [0.10, 0.11, 0.12, 0.13, NaN], B: [0.05, 0.06, 0.07, 0.08, 0.09], C: [0.00, 0.01, 0.02, 0.03, 0.04], D: [-0.10, -0.09, -0.08, -0.07, -0.06] });
  assert.strictEqual(E.sectorFilter(rows, ind)(rows[0].code), true);   // A 只剩 4 檔 < 5 → 不排除
});

console.log('過關標準的邊界');
const mk = (excess, parts, months) => ({ excess, parts: parts.map(e => ({ excess: e })), byMonth: months.map(([m, e]) => ({ m, excess: e })) });
const MONTHS = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
const base = () => mk(1.0, [0.1, 1.0, 1.8], MONTHS.map(m => [m, ['2026-06', '2026-07', '2026-08', '2026-09'].includes(m) ? -2 : 1]));
const arm = (over = {}) => {
  const a = mk(1.5, [0.2, 1.1, 1.9], MONTHS.map(m => [m, ['2026-06', '2026-07', '2026-08', '2026-09'].includes(m) ? -1 : 2]));
  return Object.assign(a, over);
};
test('四條都過 → 過關', () => assert.strictEqual(E.judge(arm(), base()).pass, true));
test('多賺剛好 +0.5 → 算過（≥）', () => assert.strictEqual(E.judge(arm({ excess: 1.5 }), base()).criteria.diff, true));
test('多賺 +0.49 → 不過', () => { const j = E.judge(arm({ excess: 1.49 }), base()); assert.strictEqual(j.criteria.diff, false); assert.strictEqual(j.pass, false); });
test('三段：有一段只是「一樣」→ 不過（要嚴格比較好）', () => {
  assert.strictEqual(E.judge(arm({ parts: [{ excess: 0.1 }, { excess: 1.1 }, { excess: 1.9 }] }), base()).criteria.parts, false);
});
test('三段：有一段較差 → 不過', () => {
  assert.strictEqual(E.judge(arm({ parts: [{ excess: 0.2 }, { excess: 0.9 }, { excess: 1.9 }] }), base()).pass, false);
});
test('逐月：6 個月贏 3 個（剛好一半）→ 不過；贏 4 個 → 過', () => {
  const m3 = arm({ byMonth: MONTHS.map((m, i) => ({ m, excess: i < 3 ? 5 : -9 })) });
  const m4 = arm({ byMonth: MONTHS.map((m, i) => ({ m, excess: i < 4 ? 5 : -9 })) });
  assert.strictEqual(E.judge(m3, base()).criteria.months, false);
  assert.strictEqual(E.judge(m4, base()).criteria.months, true);
  assert.deepStrictEqual(E.judge(m3, base()).months, { won: 3, of: 6 });
});
test('逐月：月份只有一邊有資料的不算進去', () => {
  const a = arm({ byMonth: [{ m: '2026-05', excess: 9 }, { m: '2030-01', excess: 9 }] });
  assert.deepStrictEqual(E.judge(a, base()).months, { won: 1, of: 1 });
});
test('2026/6～9 月：跟原版一樣 → 算過；比較差 → 不過', () => {
  const same = arm({ byMonth: MONTHS.map(m => ({ m, excess: ['2026-06', '2026-07', '2026-08', '2026-09'].includes(m) ? -2 : 2 })) });
  assert.strictEqual(E.judge(same, base()).criteria.summer, true);
  const worse = arm({ byMonth: MONTHS.map(m => ({ m, excess: ['2026-06', '2026-07', '2026-08', '2026-09'].includes(m) ? -2.01 : 2 })) });
  assert.strictEqual(E.judge(worse, base()).criteria.summer, false);
});
test('2026/6～9 月沒有資料 → 不過（不會默默放行）', () => {
  const a = arm({ byMonth: [{ m: '2026-05', excess: 5 }] });
  assert.strictEqual(E.judge(a, base()).criteria.summer, false);
});
test('多賺是 null 的時候不會當成 0 放行（就算原版是負的）', () => {
  assert.strictEqual(E.judge(arm({ excess: null }), base()).pass, false);
  const negBase = Object.assign(base(), { excess: -1 });
  assert.strictEqual(E.judge(arm({ excess: null }), negBase).criteria.diff, false);
});

console.log('成績整理');
test('多賺 = 每筆減掉當天對照組；沒有對照組的那天當 0', () => {
  const dates = ['2026-01-05', '2026-01-06', '2026-02-02'];
  const bd = new Map([[0, 0.01], [1, 0.02]]);
  const tr = [{ t: 0, r: 0.05 }, { t: 1, r: 0.04 }, { t: 2, r: 0.03 }];
  const s = E.summarize(tr, bd, [0, 1, 2, Infinity], dates);
  close(s.excess, ((0.04 + 0.02 + 0.03) / 3) * 100, 1e-9);
  assert.strictEqual(s.n, 3);
  assert.deepStrictEqual(s.parts.map(p => p.n), [1, 1, 1]);
  assert.deepStrictEqual(s.byMonth.map(m => [m.m, m.n]), [['2026-01', 2], ['2026-02', 1]]);
});
test('沒有交易 → excess 是 null', () => assert.strictEqual(E.summarize([], new Map(), [0, 1, 2, Infinity], []).excess, null));

console.log('讀檔與亂數');
test('讀某天的檔案：正常、沒有檔案、空檔、日期對不上', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp2-'));
  const w = (name, obj) => fs.writeFileSync(path.join(dir, name + '.json.gz'), zlib.gzipSync(JSON.stringify(obj)));
  w('2026-01-05', { date: '2026-01-05', d: { 1101: [10, 1, 3] } });
  w('2026-01-06', { date: '2026-01-06', empty: true, d: {} });
  w('2026-01-07', { date: '2026-01-05', d: { 1101: [10, 1, 3] } });
  assert.deepStrictEqual(E.loadDay(dir, '2026-01-05'), { 1101: [10, 1, 3] });
  assert.strictEqual(E.loadDay(dir, '2026-01-06'), null);
  assert.strictEqual(E.loadDay(dir, '2026-01-09'), null);
  assert.throws(() => E.loadDay(dir, '2026-01-07'), /日期/);
  fs.rmSync(dir, { recursive: true });
});
test('亂數：同一個種子每次一樣，不同種子不一樣', () => {
  const a = E.mulberry32(5), b = E.mulberry32(5), c = E.mulberry32(6);
  const xs = [a(), a(), a()], ys = [b(), b(), b()];
  assert.deepStrictEqual(xs, ys);
  assert.notStrictEqual(xs[0], c());
  assert.ok(xs.every(x => x >= 0 && x < 1));
});
test('中位數：奇數、偶數', () => { assert.strictEqual(E.median([3, 1, 2]), 2); assert.strictEqual(E.median([4, 1, 2, 3]), 2.5); });

console.log(`\n全部通過：${pass} 項`);
