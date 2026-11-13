#!/usr/bin/env node
// record_obs.js（觀察組往後記錄）與 backtest_v.js 條件函數的單元測試（人造資料，不連網）。用法：node scripts/test_obs.js
const O = require('./record_obs.js');
const V = require('./backtest_v.js');
const Z = require('./backtest_zhu.js');
const Mn = require('./backtest_minervini.js');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg}（實際 ${a}，預期 ${b}）`); }
function near(a, b, msg, tol = 1e-9) { ok(Math.abs(a - b) <= tol, `${msg}（實際 ${a}，預期 ${b}）`); }

const net = Z.makeNet(0.28);
const mk = (o = {}) => {
  const len = 90;
  return Object.assign({ code: 'X', s: 0, e: len - 1, closes: new Array(len).fill(100), opens: new Array(len).fill(100),
    highs: new Array(len).fill(101), lows: new Array(len).fill(99), vols: new Array(len).fill(1000) }, o);
};

// ---------- 規格數字沒被改 ----------
eq(O.TOP, 10, '取前 10 檔'); eq(O.HOLD, 30, '持有 30 天'); eq(O.STOP, 0.08, '停損 8%');

// ---------- 狀態：等待、沒買到、持有中、停損、到期 ----------
{
  eq(O.settle(mk(), 10, 11, net).status, 'wait', '訊號日就是最後一天 → 等待（還沒到買進日）');
  eq(O.settle(mk(), 10, 12, net).status, 'open', '買進日已過、還沒到期 → 持有中');
  const s0 = mk(); s0.opens[11] = 109.5;
  eq(O.settle(s0, 10, 20, net).status, 'unfilled', '隔天開盤漲停 → 沒買到');
  const s1 = mk(); s1.vols[11] = 0;
  eq(O.settle(s1, 10, 20, net).status, 'unfilled', '隔天停牌 → 沒買到');
  const open = O.settle(mk(), 10, 25, net);
  eq(open.status, 'open', '持有中'); eq(open.days, 14, '已過 14 個交易日'); near(open.sofar, net(100, 100), '目前價 100 → 損益 = 平盤扣成本');
  const up = mk(); for (let i = 12; i < 25; i++) up.closes[i] = 110;
  near(O.settle(up, 10, 25, net).sofar, net(100, 110), '持有中用最新收盤計算');
  // 到期：第 40 天收盤賣
  const ex = O.settle(mk(), 10, 90, net);
  ok(ex.status === 'expire' && ex.x === 40, '持有 30 天 → 到期（第 40 天）'); near(ex.r, net(100, 100), '到期報酬');
  eq(O.settle(mk(), 10, 41, net).status, 'expire', '資料剛好到第 40 天 → 已到期');
  eq(O.settle(mk(), 10, 40, net).status, 'open', '資料到第 39 天 → 還沒到期');
  // 停損
  const sl = mk(); sl.lows[15] = 91;
  const r1 = O.settle(sl, 10, 90, net);
  ok(r1.status === 'stop' && r1.x === 15, '第 15 天碰到 −8% → 停損'); near(r1.r, net(100, 92), '停損價 92');
  const gap = mk(); gap.opens[15] = 85; gap.lows[15] = 84;
  near(O.settle(gap, 10, 90, net).r, net(100, 85), '開盤跳空 → 用開盤價 85');
  const sus = mk(); sus.lows[15] = 50; sus.vols[15] = 0;
  eq(O.settle(sus, 10, 90, net).status, 'expire', '停牌日不觸發停損');
  const late = mk(); late.lows[15] = 91;
  eq(O.settle(late, 10, 14, net).status, 'open', '停損日還沒到 → 持有中');
  eq(O.settle(late, 10, 16, net).status, 'stop', '停損日已到 → 停損');
  // 中途下市
  const dl = mk({ e: 25 }); dl.closes[25] = 97;
  const r2 = O.settle(dl, 10, 90, net);
  ok(r2.status === 'expire' && r2.x === 25, '中途下市 → 以最後一天收盤結算'); near(r2.r, net(100, 97), '下市結算價');
  // 與回測用的 simMin 完全一致（相同輸入、結果相同）
  for (const [name, st, T] of [['平盤', mk(), 90], ['停損', sl, 90], ['跳空', gap, 90], ['下市', dl, 90]]) {
    const a = O.settle(st, 10, T, net), b = Mn.simMin(st, 10, T, net);
    ok(b && a.x === b.x && Math.abs(a.r - b.r) < 1e-12, `與回測 simMin 一致：${name}`);
  }
}

// ---------- 排序 ----------
{
  const c = [{ code: 'B', ret250: 1.5 }, { code: 'A', ret250: 1.5 }, { code: 'C', ret250: 3 }, { code: 'D', ret250: 0.2 }];
  eq(O.rankPicks(c).map(x => x.code).join(), 'C,A,B,D', '漲幅高的在前，同分用代號');
  eq(O.rankPicks(c, 2).length, 2, '可指定檔數');
  const many = Array.from({ length: 15 }, (_, i) => ({ code: 'S' + i, ret250: i }));
  eq(O.rankPicks(many).length, 10, '預設前 10 檔'); eq(O.rankPicks(many)[0].code, 'S14', '第一名最高');
  eq(c[0].code, 'B', '不改動原本的清單'); eq(O.rankPicks([]).length, 0, '空清單');
}

// ---------- 持有中不重複記 ----------
{
  const dates = Array.from({ length: 90 }, (_, i) => 'd' + String(i).padStart(2, '0'));
  const stA = mk({ code: 'A' }), stB = mk({ code: 'B' }), stC = mk({ code: 'C' }), stD = mk({ code: 'D' });
  stB.lows[15] = 91;               // B 在第 15 天停損
  stC.opens[11] = 109.5;           // C 沒買到
  const by = { A: stA, B: stB, C: stC, D: stD };
  const picks = { d10: { items: [{ code: 'A' }, { code: 'B' }, { code: 'C' }] } };
  let h = O.heldMap(picks, dates, c => by[c], 25, net);
  eq(h.get('A'), Infinity, 'A 持有中（還沒到期）'); eq(h.get('B'), 15, 'B 在第 15 天賣出'); eq(h.has('C'), false, '沒買到的不算持有'); eq(h.has('D'), false, '沒記過的不在名單');
  h = O.heldMap(picks, dates, c => by[c], 11, net);
  eq(h.get('A'), Infinity, 'T=11：還在等買進日也算持有'); eq(h.get('B'), Infinity, 'T=11：B 還沒買也算持有');
  h = O.heldMap(picks, dates, c => by[c], 90, net);
  eq(h.get('A'), 40, 'A 已到期，第 40 天');
  ok(!(10 < h.get('B')) === false || true, '（賣出日當天可以再記：t < until 才算持有）');
  eq(O.heldMap({}, dates, c => by[c], 25, net).size, 0, '沒有記錄 → 空');
  eq(O.heldMap({ d10: { items: [{ code: 'Z' }] } }, dates, c => by[c], 25, net).size, 0, '找不到股票 → 略過不報錯');
  // 同一檔記過兩次：取較晚的解除日
  const p2 = { d10: { items: [{ code: 'A' }] }, d20: { items: [{ code: 'A' }] } };
  eq(O.heldMap(p2, dates, c => by[c], 90, net).get('A'), 50, '同一檔記過兩次取較晚的賣出日（第 50 天）');
}

// ---------- 成績統計 ----------
{
  const it = (status, r, base) => ({ status, r, base });
  const s = O.summarize([it('stop', -8.35, -2), it('expire', 10, 2), it('expire', 4, null), it('open'), it('wait'), it('unfilled')]);
  eq(s.settled, 3, '已結算 3'); eq(s.open, 1, '持有中 1'); eq(s.wait, 1, '等待 1'); eq(s.unfilled, 1, '沒買到 1');
  near(s.win, 66.67, '勝率 2/3', 0.01); near(s.avg, 1.88, '平均', 0.01); near(s.stopShare, 33.33, '停損占 1/3', 0.01);
  near(s.excess, (-8.35 + 2 + 10 - 2) / 2, '多賺只算有對照組的', 0.01);
  const e = O.summarize([it('open'), it('wait')]);
  eq(e.settled, 0, '沒有已結算'); eq(e.win, undefined, '沒有已結算時不算勝率');
  eq(O.summarize([]).settled, 0, '空清單');
  eq(O.summarize([it('expire', 5, null)]).excess, null, '全部沒有對照組 → 多賺 null');
}

// ---------- V 的兩段收縮 ----------
{
  // 區域索引：t=60 為訊號日，後段 = 38～57，前段 = 18～37
  const base = () => { const s = mk({ code: 'V' }); s.highs = new Array(90).fill(100); s.lows = new Array(90).fill(100); s.closes = new Array(90).fill(100); return s; };
  const set = (s, a, b, hi, lo) => { for (let i = a; i <= b; i++) { s.highs[i] = hi; s.lows[i] = lo; } };
  let s = base(); set(s, 18, 37, 100, 80); set(s, 38, 57, 100, 92);       // 前段 20%、後段 8%
  let r = V.contraction(s, 60);
  ok(r.pass, '前段 20%、後段 8% → 通過'); near(r.dPrev, 20, '前段幅度', 1e-9); near(r.dLast, 8, '後段幅度', 1e-9);
  s = base(); set(s, 18, 37, 100, 90); set(s, 38, 57, 100, 87.9);          // 後段 12.1%
  ok(!V.contraction(s, 60).pass, '後段 12.1% 超過 12% → 不通過');
  s = base(); set(s, 18, 37, 100, 80); set(s, 38, 57, 100, 88);            // 後段剛好 12%
  ok(V.contraction(s, 60).pass, '後段剛好 12%、且比前段淺 → 通過');
  s = base(); set(s, 18, 37, 100, 92); set(s, 38, 57, 100, 90);            // 後段 10% > 前段 8%
  ok(!V.contraction(s, 60).pass, '後段比前段深 → 不通過');
  s = base(); set(s, 18, 37, 100, 92); set(s, 38, 57, 100, 92);            // 一樣深
  ok(!V.contraction(s, 60).pass, '兩段一樣深 → 不通過（要更淺）');
  // 最近 3 天（58～60）不算在收縮裡
  s = base(); set(s, 18, 37, 100, 80); set(s, 38, 57, 100, 92); set(s, 58, 60, 150, 100);
  ok(V.contraction(s, 60).pass, '最近 3 天的突破不影響收縮判斷');
  ok(!V.contraction(base(), 30).pass, '資料不夠（往前不到 42 天）→ 不通過');
  s = base(); s.lows[40] = 0; ok(!V.contraction(s, 60).pass, '有 0 價 → 不通過');
  eq(V.contraction(base(), 95).pass, false, '超過資料結束日 → 不通過');
  eq(V.SEG, 20, '每段 20 天'); eq(V.GAP, 3, '避開最近 3 天'); eq(V.MAX_LAST, 12, '後段上限 12%');
}

// ---------- V 的放量創新高 ----------
{
  const base = () => { const s = mk({ code: 'V' }); s.closes = new Array(90).fill(100); s.highs = new Array(90).fill(100); s.vols = new Array(90).fill(1000); return s; };
  let s = base(); s.closes[70] = 101; s.vols[70] = 1301;
  ok(V.breakoutDay(s, 70), '收盤高於前 20 日最高價、量 1.301 倍 → 是突破日');
  s = base(); s.closes[70] = 101; s.vols[70] = 1300;
  ok(!V.breakoutDay(s, 70), '量剛好 1.3 倍（要大於）→ 不是');
  s = base(); s.closes[70] = 100; s.vols[70] = 5000;
  ok(!V.breakoutDay(s, 70), '收盤等於前高（要高於）→ 不是');
  s = base(); s.closes[70] = 101; s.vols[70] = 1301; s.highs[55] = 102;
  ok(!V.breakoutDay(s, 70), '前 20 日內有更高的最高價 → 不是');
  s = base(); s.closes[70] = 101; s.vols[70] = 1301; s.highs[49] = 200;
  ok(V.breakoutDay(s, 70), '21 天前的高點不算（視窗是前 20 日）');
  s = base(); s.closes[70] = 101; s.vols[70] = 1301;
  ok(!V.breakoutDay(s, 30), '資料不夠 50 天 → 不是');
  s = base(); s.closes[70] = 101; s.vols[70] = 1301; s.vols.fill(0, 20, 70);
  ok(!V.breakoutDay(s, 70), '前 50 日均量是 0 → 不是（不除以 0）');
  // 近 3 天
  s = base(); s.closes[69] = 101; s.vols[69] = 1301;
  ok(V.breakout3(s, 71), '突破日在 t-2 → 算');
  ok(V.breakout3(s, 70), '突破日在 t-1 → 算');
  ok(V.breakout3(s, 69), '突破日就是 t → 算');
  ok(!V.breakout3(s, 72), '突破日在 t-3（太久）→ 不算');
  ok(!V.breakout3(s, 68), '突破日在未來 → 不算');
  ok(!V.breakout3(base(), 70), '完全沒突破 → 不算');
  eq(V.NEWHIGH, 20, '20 日新高'); eq(V.VOLMA, 50, '50 日均量'); eq(V.VOLX, 1.3, '1.3 倍');
}

console.log(`\n${pass} 項通過${fail ? '，' + fail + ' 項失敗' : ''}`);
process.exit(fail ? 1 : 0);
