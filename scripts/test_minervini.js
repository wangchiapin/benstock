#!/usr/bin/env node
// backtest_minervini.js 的單元測試（人造資料，不連網）。用法：node scripts/test_minervini.js
const M = require('./backtest_minervini.js');
const Z = require('./backtest_zhu.js');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg}（實際 ${a}，預期 ${b}）`); }
function near(a, b, msg, tol = 1e-9) { ok(Math.abs(a - b) <= tol, `${msg}（實際 ${a}，預期 ${b}）`); }

// 人造股票：s=0、300 天，穩定上漲，最高 = 收盤×1.01、最低 = 收盤×0.99
function mkStock(len = 300, rate = 0.002, over = {}) {
  const closes = Array.from({ length: len }, (_, i) => 100 * Math.pow(1 + rate, i));
  const st = { code: 'X', s: 0, e: len - 1, closes, opens: closes.slice(), highs: closes.map(c => c * 1.01), lows: closes.map(c => c * 0.99), vols: new Array(len).fill(1000) };
  return Object.assign(st, over);
}
const T0 = 280;

// ---------- 趨勢條件 ----------
{
  const st = mkStock();
  const r = M.template(st, T0);
  ok(r.pass, '穩定上漲的股票通過全部趨勢條件：' + r.why);
  near(r.ret250, st.closes[T0] / st.closes[T0 - 250] - 1, '近 250 日漲幅');
  eq(M.template(mkStock(300), 249).pass, false, '不到 250 天資料不通過');
  eq(M.template(mkStock(300), 249).ret250, null, '不到 250 天沒有漲幅');
  eq(M.template(st, 300).pass, false, '日期超過資料結束日不通過');

  // 逐條破壞，每次只破壞一條，看對應的條件失敗
  const brk = (fn, key) => {
    const s = mkStock(); fn(s);
    const x = M.template(s, T0);
    ok(!x.pass && x.why.split(',').includes(key), `破壞「${key}」→ 不通過且原因包含它（實際 ${x.why}）`);
  };
  // 股價掉到 150／200 日線下：最後一天收盤砍很低
  brk(s => { s.closes[T0] = 120; s.highs[T0] = 121; s.lows[T0] = 119; delete s._mm; }, 'above150');
  brk(s => { s.closes[T0] = 120; s.highs[T0] = 121; s.lows[T0] = 119; delete s._mm; }, 'above200');
  // 50 日線跌破 150 日線：近 60 天價格壓低到 150 日線以下附近，保持股價高於 200 日線
  {
    const s = mkStock(); const n = T0;
    for (let i = n - 59; i <= n; i++) { s.closes[i] = s.closes[n - 60] * 0.8; s.highs[i] = s.closes[i] * 1.01; s.lows[i] = s.closes[i] * 0.99; }
    delete s._mm;
    const x = M.template(s, n);
    ok(!x.pass, '近期大跌 → 不通過（' + x.why + '）');
  }
  // 離 52 週高點超過 25%：把一個月前塞進一個高點
  brk(s => { s.highs[T0 - 40] = s.closes[T0] * 1.5; }, 'high25');
  // 離 52 週低點不到 30%：把低點壓到接近現價
  {
    const x = M.template(mkStock(300, 0.0005), T0);
    ok(!x.pass && x.why === 'low30', '漲太慢（250 天只漲 13%）→ 只有「高於低點 30%」不符（實際 ' + x.why + '）');
  }
  // 150／200 日均線向下：先漲後跌的長期下跌股
  {
    const s = mkStock(300, -0.002);
    const x = M.template(s, T0);
    ok(!x.pass && x.why.includes('above150') && x.why.includes('up150') && x.why.includes('up200'), '長期下跌股：在均線下且均線向下（' + x.why + '）');
  }
  // 150 日線在 200 日線下：長期下跌後最後一天突然拉高到兩條線之上
  {
    const s = mkStock(300, -0.002); const c = 250;
    s.closes[T0] = c; s.highs[T0] = c * 1.01; s.lows[T0] = c * 0.99; delete s._mm;
    const x = M.template(s, T0);
    ok(!x.pass && x.why.includes('m150gt200') && !x.why.includes('above150') && !x.why.includes('above200'), '股價在兩條線上但 150 日線 < 200 日線 → 不通過（' + x.why + '）');
  }
  // 邊界：剛好 +30%、剛好 −25%
  {
    const s = mkStock();
    const i = T0, lo = Math.min(...s.lows.slice(i - 249, i + 1)), hi = Math.max(...s.highs.slice(i - 249, i + 1));
    // 把現價調到剛好 low×1.3：用另一個低點拉高現價以外的條件不易，改直接測比較式的邊界：用手算
    ok(s.closes[i] >= lo * 1.3, '測試股票現價 ≥ 52 週低點 ×1.3');
    ok(s.closes[i] >= hi * 0.75, '測試股票現價 ≥ 52 週高點 ×0.75');
  }
  // 52 週視窗是「含今天的 250 天」：250 天前的高點不算，249 天前的高點算
  {
    const s = mkStock(); const i = T0;
    s.highs[i - 250] = 1e6; delete s._mm;
    ok(M.template(s, i).pass, '視窗外（250 天前）的極高點不影響');
    const s2 = mkStock(); s2.highs[i - 249] = 1e6;
    ok(!M.template(s2, i).pass && M.template(s2, i).why === 'high25', '視窗內（249 天前）的極高點 → 離高點太遠');
  }
  // 壞資料：價格 0 或缺值 → 不通過，不丟錯
  {
    const s = mkStock(); s.lows[T0 - 5] = 0;
    ok(!M.template(s, T0).pass, '視窗內有 0 價 → 不通過');
    const s2 = mkStock(); s2.closes[T0 - 250] = 0;
    eq(M.template(s2, T0).pass, false, '250 天前收盤為 0 → 不通過');
  }
  // 不偷看未來：砍掉 T0 之後的資料，結果不變
  {
    const full = mkStock(300), cut = mkStock(T0 + 1);
    const a = M.template(full, T0), b = M.template(cut, T0);
    eq(a.pass, b.pass, '砍掉未來資料，通過與否不變');
    near(a.ret250, b.ret250, '砍掉未來資料，漲幅不變');
    // 就算未來暴跌也不影響
    const crash = mkStock(300); for (let i = T0 + 1; i < 300; i++) crash.closes[i] = 1;
    eq(M.template(crash, T0).pass, a.pass, '未來暴跌不影響今天的判斷');
  }
  // 股票晚上市（s>0）索引正確
  {
    const s = mkStock(300); s.s = 20; s.e = 319;
    ok(M.template(s, T0 + 20).pass, '有 s 偏移時索引正確');
  }
}

// ---------- 百分位 ----------
{
  const rows = [{ code: 'A', ret250: 0.5 }, { code: 'B', ret250: 0.1 }, { code: 'C', ret250: 0.9 }, { code: 'D', ret250: 0.3 }, { code: 'E', ret250: 0.7 }];
  const p = M.pctRanks(rows);
  near(p.get('B'), 0, '最低 = 0'); near(p.get('D'), 0.25, '第二低 = 0.25'); near(p.get('A'), 0.5, '中間 = 0.5');
  near(p.get('E'), 0.75, '0.75'); near(p.get('C'), 1, '最高 = 1');
  eq(M.pctRanks([{ code: 'A', ret250: 1 }]).get('A'), 0.5, '只有一檔 → 0.5');
  eq(M.pctRanks([]).size, 0, '空資料');
  const t = M.pctRanks([{ code: 'B', ret250: 1 }, { code: 'A', ret250: 1 }, { code: 'C', ret250: 1 }]);
  ok(t.get('A') < t.get('B') && t.get('B') < t.get('C'), '同分用代號排，結果固定');
  eq(rows[0].code, 'A', '不改動原本的清單');
  // 排前 30%：10 檔裡，百分位 ≥ 0.70 的有 4 檔（第 7、8、9、10 名 → 6/9=0.667 不算，7/9=0.778 算）
  const ten = M.pctRanks(Array.from({ length: 10 }, (_, i) => ({ code: 'S' + i, ret250: i })));
  eq([...ten.values()].filter(v => v >= M.RS_MIN).length, 3, '10 檔裡 RS ≥ 0.70 的有 3 檔（7/9、8/9、9/9）');
}

// ---------- 買賣：停損 −8%、持有 30 天 ----------
{
  const net = Z.makeNet(0.28);
  const mk = (o = {}) => {
    const len = 80;
    return Object.assign({ code: 'X', s: 0, e: len - 1, closes: new Array(len).fill(100), opens: new Array(len).fill(100),
      highs: new Array(len).fill(101), lows: new Array(len).fill(99), vols: new Array(len).fill(1000) }, o);
  };
  // 平盤：t=10，隔天(11)開盤 100 買，第 40 天收盤 100 賣
  let r = M.simMin(mk(), 10, 80, net);
  ok(r && r.type === 'expire' && r.x === 40, '沒碰到停損：持有 30 天到第 40 天收盤賣');
  near(r.r, net(100, 100), '報酬 = 平盤扣成本');
  // 停損價 92：第 15 天最低 91 → 以 92 賣
  const s1 = mk(); s1.lows[15] = 91;
  r = M.simMin(s1, 10, 80, net);
  ok(r && r.type === 'stop' && r.x === 15, '第 15 天盤中碰到 −8% → 停損');
  near(r.r, net(100, 92), '停損價 = 買進價 ×0.92');
  // 剛好等於 92 也算碰到
  const s2 = mk(); s2.lows[15] = 92;
  eq(M.simMin(s2, 10, 80, net).type, 'stop', '最低剛好 = 停損價 → 停損');
  const s3 = mk(); s3.lows[15] = 92.01;
  eq(M.simMin(s3, 10, 80, net).type, 'expire', '最低 92.01 沒碰到');
  // 開盤跳空低於停損價 → 用開盤價賣
  const s4 = mk(); s4.opens[15] = 85; s4.lows[15] = 84; s4.closes[15] = 86;
  r = M.simMin(s4, 10, 80, net);
  near(r.r, net(100, 85), '開盤跳空 85 < 92 → 用開盤價 85 賣（不是 92）');
  // 買進當天（t+1）就碰到停損
  const s5 = mk(); s5.lows[11] = 90;
  r = M.simMin(s5, 10, 80, net);
  ok(r && r.x === 11 && r.type === 'stop', '買進當天盤中就碰到停損也算');
  // 停牌那天（成交量 0）的最低價不算
  const s6 = mk(); s6.lows[15] = 50; s6.vols[15] = 0;
  eq(M.simMin(s6, 10, 80, net).type, 'expire', '停牌日的價格不觸發停損');
  // 買不到：開盤漲停、停牌、隔天沒資料
  const s7 = mk(); s7.opens[11] = 109.5;
  eq(M.simMin(s7, 10, 80, net), null, '開盤漲停買不到');
  const s8 = mk(); s8.vols[11] = 0;
  eq(M.simMin(s8, 10, 80, net), null, '隔天停牌買不到');
  // 資料到頭還沒滿 30 天 → 不算
  eq(M.simMin(mk(), 10, 35, net), null, '資料只到第 34 天，還沒到期 → 不算');
  // 剛好滿 30 天
  ok(M.simMin(mk(), 10, 41, net) !== null, '資料到第 40 天剛好到期 → 算');
  // 中途下市：用最後有資料那天收盤
  const s9 = mk({ e: 25 }); s9.closes[25] = 97;
  r = M.simMin(s9, 10, 80, net);
  ok(r && r.type === 'expire' && r.x === 25, '中途下市：以最後一天收盤結算');
  near(r.r, net(100, 97), '下市結算價');
  // 停損先於到期：第 40 天（到期日）最低價碰停損，視為停損
  const s10 = mk(); s10.lows[40] = 90;
  eq(M.simMin(s10, 10, 80, net).type, 'stop', '到期日盤中碰停損 → 算停損');
  // 參數：預設值就是規格
  eq(M.STOP, 0.08, '停損 8%'); eq(M.HOLD, 30, '持有 30 天'); eq(M.YEAR, 250, '52 週 = 250 個交易日');
  eq(M.SLOPE_LAG, 21, '均線向上 = 比 21 天前高'); eq(M.RS_MIN, 0.7, 'RS ≥ 0.70');
}

// ---------- 過關判斷 ----------
{
  const z = (o = {}) => Object.assign({ n: 400, excess: 1.5,
    parts: [{ excess: 0.5 }, { excess: 1 }, { excess: 2 }],
    recent: { n: 40, excess: 0 },
    byMonth: [{ excess: 1 }, { excess: 2 }, { excess: -1 }] }, o);
  let j = M.evalMin(z(), 0.9);
  ok(j.ok, '全部剛好達標：多賺 1.5 ≥ 0.5、比雜訊 0.9 多 0.6 ≥ 0.5、三段 > 0、逐月 2/3、近期 40 筆 = 0');
  ok(M.evalMin(z({ excess: 1.4 }), 0.9).c1_excessAndNoise, '1.4 − 0.9 = 0.5 剛好算過');
  ok(!M.evalMin(z({ excess: 1.39 }), 0.9).c1_excessAndNoise, '1.39 − 0.9 < 0.5 沒過');
  ok(!M.evalMin(z({ excess: 0.49 }), -5).c1_excessAndNoise, '多賺 0.49 < 0.5 沒過');
  ok(!M.evalMin(z(), null).c1_excessAndNoise, '沒有雜訊尺 → 沒過（不能略過）');
  ok(!M.evalMin(z({ parts: [{ excess: 0 }, { excess: 1 }, { excess: 2 }] }), 0).c2_parts, '有一段剛好 0 → 沒過');
  ok(!M.evalMin(z({ parts: [{ excess: null }, { excess: 1 }, { excess: 2 }] }), 0).c2_parts, '有一段沒資料 → 沒過');
  ok(!M.evalMin(z({ byMonth: [{ excess: 1 }, { excess: -1 }] }), 0).c3_months, '逐月 1/2 沒超過一半 → 沒過');
  ok(M.evalMin(z({ byMonth: [{ excess: 1 }, { excess: 1 }, { excess: null }] }), 0).c3_months, '沒資料的月份不算，2/2 → 過');
  ok(!M.evalMin(z({ byMonth: [] }), 0).c3_months, '沒有月份 → 沒過');
  ok(!M.evalMin(z({ recent: { n: 40, excess: -0.01 } }), 0).c4_recent, '近期 −0.01 → 沒過');
  ok(!M.evalMin(z({ recent: { n: 29, excess: 5 } }), 0).c4_recent, '近期只有 29 筆 → 沒過');
  ok(M.evalMin(z({ recent: { n: 30, excess: 0 } }), 0).c4_recent, '近期 30 筆且 0 → 過');
  j = M.evalMin(z({ n: 299 }), 0.9);
  ok(!j.ok && j.smallSample && j.passIgnoringSample, '299 筆：條件過但樣本不足 → 只當參考');
  ok(M.evalMin(z({ n: 300 }), 0.9).ok, '剛好 300 筆可以算');
  ok(!M.evalMin(z({ excess: null }), 0.9).ok, '沒有多賺資料 → 沒過，不報錯');
}

console.log(`\n${pass} 項通過${fail ? '，' + fail + ' 項失敗' : ''}`);
process.exit(fail ? 1 : 0);
