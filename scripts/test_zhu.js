#!/usr/bin/env node
// 朱家泓回測的單元測試：用人造股價驗證每條規則（node scripts/test_zhu.js）
const assert = require('assert');
const Z = require('./backtest_zhu.js');
const net = Z.makeNet(1);
let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

// 建一檔股票：每天給 [開, 高, 低, 收]，量預設 1000
function mk(bars, s = 0) {
  return { code: 'T', s, e: s + bars.length - 1, opens: bars.map(b => b[0]), highs: bars.map(b => b[1]),
    lows: bars.map(b => b[2]), closes: bars.map(b => b[3]), vols: bars.map(() => 1000) };
}
const flat = (p, n) => Array.from({ length: n }, () => [p, p, p, p]);

console.log('均線與轉折點');
test('sma 前面不足的天數是 null，之後是平均', () => {
  const m = Z.sma([1, 2, 3, 4, 5, 6], 3);
  assert.deepStrictEqual(m, [null, null, 2, 3, 4, 5]);
});
test('轉折高點：要比前後各 3 天都高（相等不算）', () => {
  const h = [1, 2, 3, 9, 3, 2, 1];
  assert.strictEqual(Z.isHigh(h, 3), true);
  assert.strictEqual(Z.isHigh([1, 2, 3, 9, 9, 2, 1], 3), false);
  assert.strictEqual(Z.isHigh(h, 2), false);
});
test('轉折低點：要比前後各 3 天都低', () => {
  const l = [9, 8, 7, 1, 7, 8, 9];
  assert.strictEqual(Z.isLow(l, 3), true);
  assert.strictEqual(Z.isLow([9, 8, 7, 1, 1, 8, 9], 3), false);
});
test('轉折點要等後面 3 天走完才算（不偷看未來）', () => {
  const bars = flat(10, 70);
  // 在第 66 天做一個高點，今天是第 68 天，後面只有 2 天 → 還不能算
  const st = mk(bars);
  st.highs[66] = 50;
  assert.strictEqual(Z.swings(st, 68).H.includes(66), false);
  assert.strictEqual(Z.swings(st, 69).H.includes(66), true);
});

// 造一檔「多頭＋拉回再上漲」的股票：
// 先一路墊高（有明顯的高低轉折），再拉回 2 天、今天收長紅
function uptrend() {
  const bars = [];
  let p = 100;
  for (let i = 0; i < 60; i++) {
    // 週期 10 天：上漲 6 天、小回 4 天，整體向上 → 高點墊高、低點墊高
    const up = (i % 10) < 6;
    const o = p;
    p = up ? p * 1.012 : p * 0.995;
    // 上漲日：高點 +0.3%、低點 −0.1%；下跌日：高點 +0.1%、低點 −0.3%（避免峰頂和隔天高低價剛好相等）
    bars.push(up ? [o, p * 1.003, o * 0.999, p] : [o, o * 1.001, p * 0.997, p]);
  }
  return bars;
}
test('人造多頭走勢確實有 ≥2 個高點、≥2 個低點，且墊高', () => {
  const st = mk(uptrend());
  const { H, L } = Z.swings(st, 59);
  assert.ok(H.length >= 2 && L.length >= 2, `H=${H} L=${L}`);
  assert.ok(st.highs[H[H.length - 1]] > st.highs[H[H.length - 2]]);
  assert.ok(st.lows[L[L.length - 1]] > st.lows[L[L.length - 2]]);
});

console.log('選股訊號（人造週期走勢：每 10 天上漲 6 天、拉回 4 天，整體墊高）');
function cycle(n) {
  const bars = []; let p = 100;
  for (let i = 0; i < n; i++) {
    const up = (i % 10) < 6, o = p;
    p = up ? p * 1.012 : p * 0.995;
    bars.push(up ? [o, p * 1.003, o * 0.999, p] : [o, o * 1.001, p * 0.997, p]);
  }
  return bars;
}
const clone = st => ({ ...st, opens: [...st.opens], highs: [...st.highs], lows: [...st.lows], closes: [...st.closes], vols: [...st.vols], _p: undefined });
const sig = (st, t) => Z.zhuSignal(clone(st), t);   // clone：均線快取要跟著改過的價格重算
test('拉回後第 2 個上漲日：全部條件都過，出訊號', () => {
  const st = mk(cycle(200));
  const days = []; for (let t = 70; t < 190; t++) if (t % 10 === 1) days.push(t);
  const ok = days.filter(t => sig(st, t).pass);
  assert.ok(ok.length >= days.length - 1, `只有 ${ok.length}/${days.length} 天出訊號`);
});
test('走勢最高點（沒有拉回）不出訊號，卡在「拉回」這關', () => {
  const st = mk(cycle(200)), r = sig(st, 125);   // 125 % 10 = 5：連漲 5 天，近 5 天沒收在 5 日線下
  assert.strictEqual(r.pass, false); assert.strictEqual(r.step, 'pullback');
});
test('拉回後第 1 個上漲日：5 日線還在往下，不出訊號（卡在「轉向」）', () => {
  const st = mk(cycle(200)), r = sig(st, 120);   // 120 % 10 = 0
  assert.strictEqual(r.pass, false); assert.strictEqual(r.step, 'turn');
});
test('今天不是實體紅 K（十字線）→ 不出訊號', () => {
  const st = mk(cycle(200)), t = 121;
  st.opens[t] = st.closes[t];
  assert.strictEqual(sig(st, t).step, 'candle');
});
test('今天是黑 K（收 < 開）→ 不出訊號', () => {
  const st = mk(cycle(200)), t = 121;
  st.opens[t] = st.closes[t] * 1.01;
  assert.strictEqual(sig(st, t).step, 'candle');
});
test('實體不到全日振幅一半 → 不出訊號', () => {
  const st = mk(cycle(200)), t = 121;
  st.highs[t] = st.closes[t] * 1.05;   // 上影線拉很長，實體變小
  assert.strictEqual(sig(st, t).step, 'candle');
});
test('拉回期間最低價跌破 20 日線 → 不出訊號', () => {
  const st = mk(cycle(200)), t = 121;
  st.lows[t - 2] = 1;
  assert.strictEqual(sig(st, t).step, 'pullback');
});
test('今天收盤沒站上 5 日線 → 不出訊號', () => {
  const st = mk(cycle(200)), t = 121;
  st.closes[t] = st.closes[t - 1] * 0.99; st.opens[t] = st.closes[t] * 0.995; st.highs[t] = st.opens[t] * 1.001;
  assert.strictEqual(sig(st, t).pass, false);
});
test('空頭走勢（一路下跌）→ 卡在「多頭」這關', () => {
  const bars = []; let p = 200;
  for (let i = 0; i < 120; i++) { const o = p; p *= 0.995; bars.push([o, o * 1.001, p * 0.997, p]); }
  assert.strictEqual(sig(mk(bars), 100).step, 'trend');
});
test('資料太短（不到 65 天）→ 不出訊號', () => {
  assert.strictEqual(sig(mk(cycle(200)), 40).step, 'data');
});
test('高點沒有墊高（頭頭低）→ 不出訊號', () => {
  const st = mk(cycle(200)), t = 121;
  // 把最近一個已確定的轉折高點壓低到比前一個還低
  const { H } = Z.swings(st, t), last = H[H.length - 1], prev = H[H.length - 2];
  st.highs[last] = st.highs[prev] * 0.99;
  st.closes[last] = Math.min(st.closes[last], st.highs[last]); st.opens[last] = Math.min(st.opens[last], st.highs[last]);
  const r = sig(st, t);
  assert.strictEqual(r.pass, false);
});

console.log('進場與買不到');
test('隔天開盤買進，回傳開盤價', () => {
  const st = mk(flat(100, 10));
  st.opens[6] = 101;
  assert.strictEqual(Z.enter(st, 5, 10), 101);
});
test('開盤漲停（≥ 前收 × 1.095）買不到', () => {
  const st = mk(flat(100, 10));
  st.opens[6] = 109.5;
  assert.strictEqual(Z.enter(st, 5, 10), null);
});
test('隔天停牌（量 0）買不到', () => {
  const st = mk(flat(100, 10));
  st.vols[6] = 0;
  assert.strictEqual(Z.enter(st, 5, 10), null);
});
test('沒有隔天資料（最後一天）買不到', () => {
  const st = mk(flat(100, 10));
  assert.strictEqual(Z.enter(st, 9, 10), null);
});

console.log('買賣規則');
// 第 0~29 天 100 元；t=10 買（第 11 天開盤 100）
const base = () => flat(100, 40);
test('停損：當天最低價碰到 −5% 就賣在停損價（95）', () => {
  const b = base(); b[13] = [100, 100, 94, 96];
  const r = Z.simZhu(mk(b), 10, 40, net);
  assert.strictEqual(r.type, 'stop'); assert.strictEqual(r.x, 13);
  assert.ok(Math.abs(r.r - net(100, 95)) < 1e-12);
});
test('停損：開盤就低於停損價 → 賣開盤價（跳空）', () => {
  const b = base(); b[13] = [90, 92, 88, 91];
  const r = Z.simZhu(mk(b), 10, 40, net);
  assert.strictEqual(r.type, 'stop');
  assert.ok(Math.abs(r.r - net(100, 90)) < 1e-12);
});
test('買進當天最低價碰到停損也算', () => {
  const b = base(); b[11] = [100, 100, 94, 99];
  const r = Z.simZhu(mk(b), 10, 40, net);
  assert.strictEqual(r.type, 'stop'); assert.strictEqual(r.x, 11);
});
test('停利：收盤跌破 5 日線，隔天開盤賣', () => {
  const b = base();
  // 買進後連漲幾天，第 15 天收盤大跌破 5 日線（但沒碰到停損）
  b[11] = [100, 103, 100, 103]; b[12] = [103, 106, 103, 106]; b[13] = [106, 109, 106, 109];
  b[14] = [109, 112, 109, 112]; b[15] = [110, 110, 107, 107]; b[16] = [108, 109, 106, 107];
  const r = Z.simZhu(mk(b), 10, 40, net);
  assert.strictEqual(r.type, 'ma5'); assert.strictEqual(r.x, 16); assert.strictEqual(r.px, 'open');
  assert.ok(Math.abs(r.r - net(100, 108)) < 1e-12);
});
test('停利：買進當天收盤就跌破 5 日線也會被看到（隔天開盤賣）', () => {
  const b = base();
  b[11] = [100, 100, 98, 98]; b[12] = [98, 99, 97, 98];
  const r = Z.simZhu(mk(b), 10, 40, net);
  assert.strictEqual(r.type, 'ma5'); assert.strictEqual(r.x, 12);
});
test('到期：沒觸發任何條件，持有滿 20 天收盤賣', () => {
  const b = []; let p = 100;
  for (let i = 0; i < 40; i++) { const o = p; p *= 1.002; b.push([o, p, o, p]); }
  const r = Z.simZhu(mk(b), 10, 40, net);
  assert.strictEqual(r.type, 'expire'); assert.strictEqual(r.x, 30);
});
test('資料到頭但還沒到期、也沒觸發賣出 → 不算（null）', () => {
  const b = []; let p = 100;
  for (let i = 0; i < 20; i++) { const o = p; p *= 1.002; b.push([o, p, o, p]); }
  assert.strictEqual(Z.simZhu(mk(b), 10, 20, net), null);
});
test('同一天又破停損又破 5 日線，以停損為準', () => {
  const b = base(); b[12] = [100, 100, 90, 92];
  const r = Z.simZhu(mk(b), 10, 40, net);
  assert.strictEqual(r.type, 'stop');
});

console.log('對照組');
test('對照組：同一天買、同一時間賣，取平均', () => {
  const a = mk(base()), c = mk(base());
  a.opens[12] = 110; c.opens[12] = 90; a.closes[12] = 110; c.closes[12] = 90;
  const gate = [{ s: { full: a } }, { s: { full: c } }];
  const want = (net(100, 110) + net(100, 90)) / 2;
  assert.ok(Math.abs(Z.ctrl(gate, 10, 12, 'open', 40, net, new Map()) - want) < 1e-12);
  assert.ok(Math.abs(Z.ctrl(gate, 10, 12, 'close', 40, net, new Map()) - want) < 1e-12);
});
test('對照組：買不到的股票（隔天停牌）不算進去', () => {
  const a = mk(base()), c = mk(base());
  c.vols[11] = 0; a.closes[12] = 110;
  const gate = [{ s: { full: a } }, { s: { full: c } }];
  assert.ok(Math.abs(Z.ctrl(gate, 10, 12, 'close', 40, net, new Map()) - net(100, 110)) < 1e-12);
});

console.log('費用');
test('買賣各 0.1425% + 賣出證交稅 0.3%', () => {
  assert.ok(Math.abs(net(100, 100) - ((100 * (1 - 0.001425 - 0.003)) / (100 * 1.001425) - 1)) < 1e-12);
  assert.ok(net(100, 100) < -0.0057 && net(100, 100) > -0.0059);
});

console.log(`\n全部通過：${pass} 項`);
