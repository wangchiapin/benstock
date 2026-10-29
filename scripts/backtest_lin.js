#!/usr/bin/env node
// 林恩如「20 週均線」規則（簡化版）回測。規格由 Ben 2026-10-29 確認。只測試，不改網頁。
// 用法：node scripts/backtest_lin.js 歷史檔.json index.html 輸出.json [--fee-discount 1] [--until 日期] [--noise 30] [--dump-trades 檔案]
//
// 規則（來源：書介、書摘整理，不是全書，所以是簡化版，不等於作者本人的操作）：
//   週 K：每週最後一個交易日的收盤價當週收盤價（週末不開市的股票，用該週最後一個有成交的日子）
//   20 週均線：最近 20 根週收盤價的平均（20 根都要有資料才算）
//   進場訊號（週末收盤後）：本週收盤 > 本週 20 週均線，且上週收盤 ≤ 上週 20 週均線（剛突破）
//   買進：下一個交易日開盤（開盤漲停、停牌 = 沒買到）
//   出場：週末收盤 < 20 週均線，下一個有成交的交易日開盤賣；買進那一週的週末就開始看
//   主規則不設固定停損；另附「−10% 固定停損」當參考（不納入過關判斷）
//   同一天訊號超過 10 檔，依近 20 日漲幅取前 10 檔；持有中的同一檔不重複買
//   資料到頭還在持有：用最後一天收盤計算，標明「未了結」；下市：用最後一天收盤
//   母體：基本門檻合格（成交金額、股價、資料正常），不開穩定配息、不排除暴衝
//   成本：手續費 0.1425% × 2、證交稅 0.3%
//   對照組：同一天買、同一時間賣的全部基本門檻合格股票平均
// 過關標準（看結果前定好，四條都要過；筆數少於 100 只當參考）：
//   1. 每筆比對照組多賺 ≥ 0.5 個百分點
//   2. 前、中、後三段都 > 0
//   3. 逐月比較，多賺 > 0 的月份超過一半
//   4. 2026 年 6～9 月多賺 ≥ 0
const fs = require('fs');
const { enter, ctrl, makeNet } = require('./backtest_zhu.js');

const MAW = 20, TOP = 10, WARM = 125, WIN = 130, GOAL = 0.5, STOP_REF = 0.10, MAXHOLD = 20;

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const round2 = x => Math.round(x * 100) / 100;

// ---------- 週別 ----------
function mondayKey(s) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const wd = (dt.getUTCDay() + 6) % 7;            // 週一 = 0
  dt.setUTCDate(dt.getUTCDate() - wd);
  return dt.toISOString().slice(0, 10);
}
// 只看前 T 天。isEnd[i] = 第 i 天是那一週最後一個交易日（資料最後一天不確定是不是收週，一律不算）
function buildWeeks(dates, T) {
  const wpos = new Array(T), starts = [], ends = [];
  let prev = null;
  for (let i = 0; i < T; i++) {
    const k = mondayKey(dates[i]);
    if (k !== prev) { starts.push(i); ends.push(i); prev = k; } else ends[ends.length - 1] = i;
    wpos[i] = starts.length - 1;
  }
  const isEnd = new Array(T).fill(false);
  for (let i = 0; i < T - 1; i++) isEnd[i] = wpos[i + 1] !== wpos[i];
  return { wpos, starts, ends, isEnd, n: starts.length };
}

// 每檔股票的週收盤與 20 週均線（依全域週別對齊）
function weekly(st, W) {
  if (st._lw && st._lw.W === W) return st._lw;
  const n = W.n, wc = new Array(n).fill(null);
  for (let w = 0; w < n; w++) {
    for (let d = W.ends[w]; d >= W.starts[w]; d--) {
      if (d < st.s || d > st.e) continue;
      const k = d - st.s;
      if (st.vols[k] > 0 && st.closes[k] > 0) { wc[w] = st.closes[k]; break; }
    }
  }
  const ma = new Array(n).fill(null);
  for (let w = MAW - 1; w < n; w++) {
    let s = 0, ok = true;
    for (let q = w - MAW + 1; q <= w; q++) { if (wc[q] === null) { ok = false; break; } s += wc[q]; }
    if (ok) ma[w] = s / MAW;
  }
  return (st._lw = { W, wc, ma });
}

// 第 t 天（週末）收盤後有沒有「剛突破 20 週均線」
function linSignal(st, t, W) {
  if (!W.isEnd[t]) return false;
  const w = W.wpos[t], L = weekly(st, W);
  if (w < 1 || L.wc[w] === null || L.ma[w] === null || L.wc[w - 1] === null || L.ma[w - 1] === null) return false;
  return L.wc[w] > L.ma[w] && L.wc[w - 1] <= L.ma[w - 1];
}

// 買賣模擬。回傳 { r, x, type, px, ep, xp }：報酬、賣出那天序號、原因、賣價種類（open / close）、買價、賣價；買不到回傳 null
// type：ma（跌破 20 週均線）、stop（固定停損）、delist（下市）、unfinished（資料到頭還在持有）
function simLin(st, t, T, net, W, stopPct) {
  const entry = enter(st, t, T);
  if (entry === null) return null;
  const L = weekly(st, W), sp = stopPct ? entry * (1 - stopPct) : null;
  const last = Math.min(T - 1, st.e);
  let pending = false;
  for (let d = t + 1; d <= last; d++) {
    const k = d - st.s, tradable = st.vols[k] > 0;
    if (pending && tradable) return { r: net(entry, st.opens[k]), x: d, type: 'ma', px: 'open', ep: entry, xp: st.opens[k] };
    if (sp !== null && tradable && st.lows[k] <= sp) {
      const p = Math.min(sp, st.opens[k]);
      return { r: net(entry, p), x: d, type: 'stop', px: 'close', ep: entry, xp: p };
    }
    if (W.isEnd[d] && !pending) {
      const w = W.wpos[d];
      if (L.wc[w] !== null && L.ma[w] !== null && L.wc[w] < L.ma[w]) pending = true;
    }
  }
  if (st.e < T - 1) {
    const p = st.closes[st.e - st.s];
    return { r: net(entry, p), x: st.e, type: 'delist', px: 'close', ep: entry, xp: p };
  }
  const p = st.closes[T - 1 - st.s];
  return { r: net(entry, p), x: T - 1, type: 'unfinished', px: 'close', ep: entry, xp: p };
}

// 參考：原版，買進後持有 h 天收盤賣，不設停損
function simHold(st, t, T, h, net) {
  if (t + h > T - 1) return null;
  const entry = enter(st, t, T);
  if (entry === null) return null;
  const last = Math.min(t + h, st.e);
  return net(entry, st.closes[last - st.s]);
}

// ---------- 統計 ----------
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
  if (!trades.length) return { n: 0, excess: null, parts: [0, 1, 2].map(() => ({ n: 0, excess: null })), recent: { n: 0, excess: null }, byMonth: [] };
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

// 過關標準（四條都要過）
function evalPass(z) {
  const months = (z.byMonth || []).filter(m => m.excess !== null);
  const win = months.filter(m => m.excess > 0).length;
  const c1 = z.excess !== null && z.excess >= GOAL;
  const c2 = z.parts.every(p => p.excess !== null && p.excess > 0);
  const c3 = months.length > 0 && win * 2 > months.length;
  const c4 = z.recent.excess !== null && z.recent.excess >= 0;
  return { goal: GOAL, c1_excess: c1, c2_parts: c2, c3_months: c3, c4_recent: c4, monthsWin: win, monthsTotal: months.length, smallSample: z.n < 100, ok: c1 && c2 && c3 && c4 };
}

// 固定亂數（雜訊尺用，同樣的種子永遠同樣的結果）
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function exitInfo(trades) {
  const types = {};
  for (const x of trades) (types[x.type] = types[x.type] || []).push(x);
  const out = {};
  for (const k of Object.keys(types)) out[k] = { n: types[k].length, share: round2(types[k].length / trades.length * 100), avg: round2(mean(types[k].map(x => x.r)) * 100) };
  return out;
}
function fullSummary(trades, dates) {
  const z = summarize(trades, dates);
  if (trades.length) {
    z.avgHoldDays = round2(mean(trades.map(x => x.hold)));
    z.exits = exitInfo(trades);
    z.unfinished = trades.filter(x => x.type === 'unfinished').length;
  }
  z.pass = evalPass(z);
  return z;
}

function main() {
  const [, , histPath, htmlPath, outPath, ...rest] = process.argv;
  if (!histPath || !htmlPath || !outPath) {
    console.error('用法：node scripts/backtest_lin.js 歷史檔.json index.html 輸出.json [--fee-discount 1] [--until 日期] [--noise 30] [--dump-trades 檔案]');
    process.exit(2);
  }
  let fd = 1, dumpPath = null, gatePath = null, until = null, noiseN = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--fee-discount') fd = parseFloat(rest[++i]);
    else if (rest[i] === '--dump-trades') dumpPath = rest[++i];
    else if (rest[i] === '--until') until = rest[++i];      // 只用到這一天（含）的資料，重現舊結果用
    else if (rest[i] === '--noise') noiseN = parseInt(rest[++i], 10);
    else if (rest[i] === '--dump-gate') gatePath = rest[++i];
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
  const W = buildWeeks(dates, T);
  const on = Object.assign({}, DEFAULT_ON, { div: false });
  const cache = new Map();

  const mkVar = (name, stop, peek, fixed) => ({ name, stop, peek: !!peek, fixed: fixed || 0, held: new Map(), trades: [], pickCount: new Map() });
  // fixed20 是看結果後才加的參考：同樣的突破訊號，但固定持有 20 個交易日收盤賣（不看均線出場），用來分開「訊號本身」和「出場方式」的貢獻
  const V = { main: mkVar('main', null), stop10: mkVar('stop10', STOP_REF), peek: mkVar('peek', null, true), fixed20: mkVar('fixed20', null, false, MAXHOLD) };
  const ref = [], gateByDay = new Map();
  const funnel = { gateOnWeekEnds: 0, signals: 0, skippedHeld: 0 };
  let evalDays = 0, weekEndDays = 0, signalDays = 0, pickSum = 0;
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

    // 參考：原版前 10 檔持有 20 天（用來確認對照組和成本算法跟舊結果一致）
    const rp = res.rows.filter(x => x.ev.pass).sort((p, q) => q.ev.rank - p.ev.rank).slice(0, TOP);
    for (const x of rp) {
      const r = simHold(x.s.full, t, T, MAXHOLD, net);
      if (r !== null) ref.push({ t, r, c: ctrl(gate, t, t + MAXHOLD, 'close', T, net, cache) });
    }

    if (!W.isEnd[t]) continue;           // 20 週均線只在週末收盤後才看
    weekEndDays++;
    funnel.gateOnWeekEnds += gate.length;
    gateByDay.set(t, gate.map(x => ({ s: { full: x.s.full } })));
    const cand = gate.filter(x => linSignal(x.s.full, t, W)).sort((p, q) => q.m.ret20 - p.m.ret20);
    funnel.signals += cand.length;

    for (const v of Object.values(V)) {
      let fresh = cand.filter(x => !(v.held.has(x.s.code) && t < v.held.get(x.s.code)));
      if (v === V.main) funnel.skippedHeld += cand.length - fresh.length;
      if (v.peek) {                       // 偷看未來的假過濾：只留 20 天後收盤比現在高的（應該大贏，證明過濾有被算進去）
        fresh = fresh.filter(x => { const st = x.s.full; return t + MAXHOLD <= T - 1 && st.e >= t + MAXHOLD && st.closes[t + MAXHOLD - st.s] > st.closes[t - st.s]; });
      }
      const picks = fresh.slice(0, TOP);
      v.pickCount.set(t, picks.length);
      if (v === V.main && picks.length) { signalDays++; pickSum += picks.length; }
      for (const x of picks) {
        let r;
        if (v.fixed) {
          const rr = simHold(x.s.full, t, T, v.fixed, net);
          r = rr === null ? null : { r: rr, x: t + v.fixed, type: 'fixed', px: 'close', ep: 0, xp: 0 };
        } else r = simLin(x.s.full, t, T, net, W, v.stop);
        if (!r) continue;
        v.held.set(x.s.code, r.x);
        v.trades.push({ code: x.s.code, t, x: r.x, r: r.r, c: ctrl(gate, t, r.x, r.px, T, net, cache), hold: r.x - t, type: r.type, ep: r.ep, xp: r.xp });
      }
    }
  }

  // 雜訊尺：訊號日隨機挑同樣數量的合格股票，用同樣的出場規則，看「隨便買」能多賺多少
  const noise = [];
  if (noiseN > 0) {
    const wdays = [...gateByDay.keys()].sort((a, b) => a - b);
    for (let seed = 1; seed <= noiseN; seed++) {
      const rnd = rng(seed), held = new Map(), tr = [];
      for (const t of wdays) {
        const k = V.main.pickCount.get(t) || 0;
        if (!k) continue;
        const avail = gateByDay.get(t).filter(x => !(held.has(x.s.full.code) && t < held.get(x.s.full.code)));
        for (let i = 0; i < Math.min(k, avail.length); i++) {
          const j = i + Math.floor(rnd() * (avail.length - i));
          [avail[i], avail[j]] = [avail[j], avail[i]];
          const st = avail[i].s.full;
          const r = simLin(st, t, T, net, W, null);
          if (!r) continue;
          held.set(st.code, r.x);
          tr.push({ t, r: r.r, c: ctrl(gateByDay.get(t), t, r.x, r.px, T, net, cache) });
        }
      }
      noise.push({ seed, n: tr.length, excess: exc(tr), avg: tr.length ? round2(mean(tr.map(x => x.r)) * 100) : null });
    }
  }

  const sum = {};
  for (const [k, v] of Object.entries(V)) sum[k] = fullSummary(v.trades, dates);
  const nz = noise.map(x => x.excess).filter(x => x !== null);
  const out = {
    generatedAt: new Date().toISOString(),
    range: { from: dates[WARM], to: dates[T - 1], days: evalDays, totalDays: T, weekEnds: weekEndDays },
    adjustedExDiv: !!H.adjusted,
    params: { feeDiscount: fd, ma: MAW + ' 週均線', top: TOP, taxPct: 0.3,
      entry: '週末收盤剛突破 20 週均線，下一個交易日開盤買（漲停、停牌買不到）',
      exit: '週末收盤跌破 20 週均線，下一個有成交的交易日開盤賣；資料到頭未了結用最後收盤；下市用最後收盤',
      control: '同一天買、同一時間賣的基本門檻合格股票平均', stableDividend: '不開', heldRule: '持有中的同一檔不重複買' },
    signalDays, avgPicksPerSignalDay: signalDays ? round2(pickSum / signalDays) : 0,
    funnel,
    main: sum.main,
    stop10Reference: sum.stop10,
    peekFuture: sum.peek,
    fixed20Reference: sum.fixed20,
    noise: noise.length ? { runs: noise, mean: round2(mean(nz)), sd: round2(Math.sqrt(mean(nz.map(x => (x - mean(nz)) ** 2)))), min: Math.min(...nz), max: Math.max(...nz) } : null,
    reference: Object.assign({ label: '原版前 10 檔持有 20 天（不設停損，有開不暴衝）' }, summarize(ref, dates))
  };
  fs.writeFileSync(outPath, JSON.stringify(out));
  if (dumpPath) fs.writeFileSync(dumpPath, JSON.stringify(V.main.trades.map(x => Object.assign({}, x, { date: dates[x.t], exitDate: dates[x.x] }))));
  if (gatePath) {      // 除錯用：每個週末的合格股票代號，給別的程式獨立驗算對照組
    const g = {};
    for (const [t, rows] of gateByDay) g[dates[t]] = rows.map(x => x.s.full.code);
    fs.writeFileSync(gatePath, JSON.stringify(g));
  }
  const m = sum.main;
  console.log(`回測完成：${out.range.from} ~ ${out.range.to}，${evalDays} 個交易日、${weekEndDays} 個週末，有訊號 ${signalDays} 週，交易 ${m.n} 筆，` +
    `每筆多賺 ${m.excess}%，過關：${m.pass.ok}，用時 ${Math.round((Date.now() - t0) / 1000)} 秒`);
}

module.exports = { mondayKey, buildWeeks, weekly, linSignal, simLin, simHold, stats, exc, summarize, evalPass, rng, fullSummary };
if (require.main === module) main();
