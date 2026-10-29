#!/usr/bin/env node
// backtest_zhu_check.js 的單元測試（人造資料，不連網）。用法：node scripts/test_zhu_check.js
const C = require('./backtest_zhu_check.js');
const B = require('./backtest_lin.js');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg}（實際 ${a}，預期 ${b}）`); }

const mk = codes => codes.map(c => ({ s: { code: c } }));

// ---------- 持有中不重複買 ----------
{
  const list = mk(['A', 'B', 'C']);
  const held = new Map([['A', 10], ['B', 5]]);
  eq(C.freshOf(list, held, 7).map(x => x.s.code).join(), 'B,C', '第 7 天：A 還在持有（到第 10 天）不能買，B 已在第 5 天賣掉可以買');
  eq(C.freshOf(list, held, 3).map(x => x.s.code).join(), 'C', '第 3 天：A、B 都還在持有，只剩 C 可以買');
  eq(C.freshOf(list, held, 10).map(x => x.s.code).join(), 'A,B,C', '賣出那天就可以再買（t < 賣出日 才算持有中）');
  eq(C.freshOf(list, new Map(), 1).length, 3, '沒有持有中就全部都可以');
  eq(C.freshOf([], held, 1).length, 0, '空清單');
}

// ---------- 隨機挑選 ----------
{
  const avail = mk(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  const r1 = C.samplePicks(avail, 3, B.rng(1)), r1b = C.samplePicks(avail, 3, B.rng(1));
  eq(r1.length, 3, '挑 3 檔');
  eq(new Set(r1.map(x => x.s.code)).size, 3, '不重複');
  eq(r1.map(x => x.s.code).join(), r1b.map(x => x.s.code).join(), '同種子同結果');
  ok(r1.every(x => avail.includes(x)), '挑出來的都在候選裡');
  eq(avail.map(x => x.s.code).join(''), 'ABCDEFGH', '不改動原本的清單');
  eq(C.samplePicks(avail, 20, B.rng(1)).length, 8, '要的比候選多就全部（不報錯）');
  eq(C.samplePicks(avail, 0, B.rng(1)).length, 0, '挑 0 檔');
  eq(C.samplePicks([], 3, B.rng(1)).length, 0, '沒有候選');
  // 不同種子大多不同；多抽幾次，每一檔都有機會被挑到（不是永遠挑前面幾檔）
  const seen = new Set();
  for (let s = 1; s <= 200; s++) for (const x of C.samplePicks(avail, 2, B.rng(s))) seen.add(x.s.code);
  eq(seen.size, 8, '200 組亂數下，8 檔每一檔都有被挑到');
  // 大致均勻：每檔被挑到的次數不會差太多（200 組 × 2 檔 / 8 檔 = 平均 50 次）
  const cnt = {};
  for (let s = 1; s <= 2000; s++) for (const x of C.samplePicks(avail, 2, B.rng(s))) cnt[x.s.code] = (cnt[x.s.code] || 0) + 1;
  const vals = Object.values(cnt);
  ok(Math.min(...vals) > 400 && Math.max(...vals) < 600, `2000 組亂數下每檔約被挑 500 次（實際 ${Math.min(...vals)}～${Math.max(...vals)}）`);
}

// ---------- 原本的過關判定（不能被改動）----------
{
  const z = (excess, parts) => ({ excess, parts: parts.map(e => ({ excess: e })) });
  ok(C.zhuPass(z(0.5, [0.01, 0.01, 0.01])), '剛好 0.5 且三段都 > 0 算過');
  ok(!C.zhuPass(z(0.49, [1, 1, 1])), '0.49 沒過');
  ok(!C.zhuPass(z(1, [1, 0, 1])), '有一段剛好 0 沒過');
  ok(!C.zhuPass(z(null, [1, 1, 1])), '沒有對照資料沒過');
  ok(!C.zhuPass(z(0.22, [-0.03, 0.66, 0.04])), 'HANDOFF 7.2 的舊結果仍然是沒過關');
}

// ---------- 重現用的舊數字沒有被改 ----------
{
  eq(C.EXPECTED_1020.n, 2497, 'HANDOFF 7.2：2497 筆');
  eq(C.EXPECTED_1020.excess, 0.22, 'HANDOFF 7.2：多賺 +0.22');
  eq(C.EXPECTED_1020.parts.join(), '-0.03,0.66,0.04', 'HANDOFF 7.2：三段');
  eq(C.EXPECTED_1020.recent, -0.11, 'HANDOFF 7.2：2026/6～9 月 −0.11');
}

console.log(`\n${pass} 項通過${fail ? '，' + fail + ' 項失敗' : ''}`);
process.exit(fail ? 1 : 0);
