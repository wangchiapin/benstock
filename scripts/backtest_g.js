#!/usr/bin/env node
// 組合 G 回測：B 過濾 ＋ 持有 30 天 ＋ 只在大盤強勢日買 ＋ 手續費 2.8 折。
// 規格是 Ben 2026-10-29 確認的（看結果前定死），過關標準不能事後改。
// 用法：node scripts/backtest_g.js 歷史檔.json index.html data 輸出.json [--until 日期] [--hold 30] [--fee-discount 0.28] [--noise 30] [--dump-trades 檔案]
//
// 做法（B 的選股、買賣、對照組算法和 backtest_exp2.js 完全一樣，只多了大盤強勢日和 30 天、手續費折扣）：
//   每天收盤後原版排名（不開穩定配息）→ 排除營收年增率 < 0 或近 20 日法人買賣超 < 0（資料缺的不排除）→ 取前 10 檔
//   隔天開盤買（開盤漲停、停牌買不到），持有 N 個交易日收盤賣，不設停損
//   對照組 = 同一天基本門檻合格的全部股票平均（同樣手續費）；「多賺」= 每筆減掉當天對照組平均
//   大盤強勢 = index.html 的 market.state === 'strong'（大盤收盤 > 20 日均線，且 20 日均線 ≥ 5 天前的 20 日均線）
// 組別：
//   A_all／B_all／A_strong／B_strong（= G）
//   檢查：leak（偷看未來，排除未來 N 天最差 20%，強勢日）、noise0～29（強勢日隨機排除與 B 同比例）
// 過關（G 用 --fee-discount 的手續費，四條都要過，n < 300 只當參考）：
//   ① 勝率 ≥ 50.00%  ② 每筆多賺 ≥ B_all 的多賺  ③ 前中後三段勝率都 ≥ 48%  ④ 2026/6～9 多賺 ≥ 0 且該期間 ≥ 30 筆
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { loadDay, mulberry32 } = require('./backtest_exp2.js');

const TOP = 10, WARM = 125, WIN = 130, INST_DAYS = 20, INST_MIN = 15, REV_MAX_AGE = 75, MARGIN_DAYS = 20;
const BUY_FEE0 = 0.001425, SELL_FEE0 = 0.001425, TAX = 0.003;
const LEAK_DROP = 0.2;
const CRIT = { win: 50, partWin: 48, recentMinN: 30, minN: 300 };

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const round2 = x => Math.round(x * 100) / 100;
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
// 淨報酬（小數）：買進手續費、賣出手續費各打 fd 折，證交稅不打折
const makeNet = fd => (entry, exit) => (exit * (1 - SELL_FEE0 * fd - TAX)) / (entry * (1 + BUY_FEE0 * fd)) - 1;

// 大盤強勢：跟 index.html 的 runAll 一模一樣的算法（用來測試和核對）
function isStrong(closes) {
  if (!Array.isArray(closes) || closes.length < 20) return false;
  const m = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += closes[i]; return s / (b - a); };
  const n = closes.length, price = closes[n - 1], ma20 = m(n - 20, n);
  const ma20prev = n >= 25 ? m(n - 25, n - 5) : ma20;
  return price > ma20 && ma20 >= ma20prev;
}
// B 過濾：營收年增率 < 0 或法人買賣超 < 0 的排除，沒資料（null）的不排除
const passB = x => !(x.rev !== null && x.rev < 0) && !(x.inst !== null && x.inst < 0);
const topPicks = (pool, n = TOP) => [...pool].sort((p, q) => q.ev.rank - p.ev.rank).slice(0, n);
// 模擬一筆：第 t 天收盤選到，隔天開盤買，第 t+h 天收盤賣（跟 backtest_exp2.js 的 sim 一樣，只是手續費可調）
function sim(st, t, h, T, net) {
  if (t + h > T - 1) return null;
  const k1 = t + 1 - st.s;
  if (k1 < 0 || t + 1 > st.e || st.vols[k1] === 0) return null;
  const prevClose = st.closes[t - st.s], entry = st.opens[k1];
  if (!(entry > 0) || entry >= prevClose * 1.095) return null;
  return net(entry, st.closes[Math.min(t + h, st.e) - st.s]);
}
function stats(a) {
  const n = a.length;
  if (!n) return { n: 0 };
  return { n, win: round2(a.filter(x => x > 0).length / n * 100), avg: round2(mean(a) * 100) };
}
// trades：[{t, r}]；baseDay：Map(t → 當天對照組平均)。前中後三段 = 依有交易的買進日三等分
function summarize(trades, baseDay, dates) {
  if (!trades.length) return { n: 0, excess: null, parts: [0, 1, 2].map(() => ({ n: 0, excess: null })), recent: { n: 0, excess: null }, byMonth: [] };
  const ex = a => { const e = a.filter(x => baseDay.has(x.t)); return e.length ? round2(mean(e.map(x => x.r - baseDay.get(x.t))) * 100) : null; };
  const days = [...new Set(trades.map(x => x.t))].sort((a, b) => a - b);
  const cuts = [days[0], days[Math.floor(days.length / 3)], days[Math.floor(days.length * 2 / 3)], Infinity];
  const grp = a => Object.assign({ excess: ex(a) }, stats(a.map(x => x.r)));
  const months = {};
  for (const x of trades) { const m = dates[x.t].slice(0, 7); (months[m] = months[m] || []).push(x); }
  const recent = trades.filter(x => { const m = dates[x.t].slice(0, 7); return m >= '2026-06' && m <= '2026-09'; });
  return Object.assign(grp(trades), {
    parts: [0, 1, 2].map(i => grp(trades.filter(x => x.t >= cuts[i] && x.t < cuts[i + 1]))),
    recent: grp(recent),
    byMonth: Object.keys(months).sort().map(m => ({ m, n: months[m].length, avg: round2(mean(months[m].map(x => x.r)) * 100), excess: ex(months[m]) }))
  });
}
// 過關判斷：g = G 的成績（summarize），b = B_all 的成績（同手續費、同持有天數）
function judgeG(g, b) {
  const c = {
    win: g.win !== undefined && g.win >= CRIT.win,
    excess: g.excess !== null && b.excess !== null && g.excess >= b.excess,
    parts: g.parts.every(p => p.win !== undefined && p.win >= CRIT.partWin),
    recent: g.recent.excess !== null && g.recent.excess >= 0 && g.recent.n >= CRIT.recentMinN
  };
  const ok = Object.values(c).every(Boolean);
  return { criteria: c, smallSample: g.n < CRIT.minN, pass: ok && g.n >= CRIT.minN, passIgnoringSample: ok };
}

function main() {
  const args = process.argv.slice(2), pos = [];
  let until = null, hold = 30, fd = 0.28, noiseN = 30, dumpPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--until') until = args[++i];
    else if (args[i] === '--hold') hold = parseInt(args[++i], 10);
    else if (args[i] === '--fee-discount') fd = parseFloat(args[++i]);
    else if (args[i] === '--noise') noiseN = parseInt(args[++i], 10);
    else if (args[i] === '--dump-trades') dumpPath = args[++i];
    else pos.push(args[i]);
  }
  const [histPath, htmlPath, dataDir, outPath] = pos;
  if (!histPath || !htmlPath || !dataDir || !outPath) {
    console.error('用法：node scripts/backtest_g.js 歷史檔.json index.html data 輸出.json [--until 日期] [--hold 30] [--fee-discount 0.28]');
    process.exit(2);
  }
  if (!(fd > 0 && fd <= 1) || !(hold >= 1)) { console.error('--fee-discount 要在 0 到 1 之間，--hold 要 ≥ 1'); process.exit(2); }
  const netD = makeNet(fd), net1 = makeNet(1);

  const html = fs.readFileSync(htmlPath, 'utf8');
  const mm = html.match(/\/\/<core>([\s\S]*?)\/\/<\/core>/);
  if (!mm) { console.error('index.html 裡找不到 //<core> 區塊'); process.exit(2); }
  const { runAll, DEFAULT_CFG, DEFAULT_ON } = new Function(mm[1] + ';return {runAll,DEFAULT_CFG,DEFAULT_ON};')();

  const H = JSON.parse(fs.readFileSync(histPath, 'utf8'));
  const dates = H.dates, mk = H.market.closes, stocks = H.stocks, N = dates.length;
  let T = N;
  if (until) { let c = -1; for (let i = 0; i < N; i++) if (dates[i] <= until) c = i; T = c + 1; }

  // ── 三大法人（跟 backtest_exp2.js 一樣）
  const instDir = path.join(dataDir, 'inst');
  const hasInst = new Array(N).fill(false), instTot = new Map();
  for (let t = 0; t < T; t++) {
    const p = path.join(instDir, dates[t] + '.json.gz');
    if (!fs.existsSync(p)) continue;
    const js = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
    hasInst[t] = true;
    for (const [code, row] of Object.entries(js.d)) {
      let a = instTot.get(code);
      if (!a) instTot.set(code, a = new Float64Array(N));
      a[t] = row[3];
    }
  }
  function instRatio(st, t) {
    let have = 0, sum = 0, vol = 0;
    const a = instTot.get(st.code);
    for (let j = t - INST_DAYS + 1; j <= t; j++) {
      if (j < st.s || !hasInst[j]) continue;
      have++;
      if (a) sum += a[j];
      vol += st.vols[j - st.s] * 1000;
    }
    if (have < INST_MIN || !(vol > 0)) return null;
    return sum / vol;
  }
  // ── 月營收（跟 backtest_exp2.js 一樣：隔月 11 日才算公布）
  const nextMonth11 = ym => { let y = +ym.slice(0, 4), m = +ym.slice(5, 7) + 1; if (m > 12) { m = 1; y++; } return `${y}-${String(m).padStart(2, '0')}-11`; };
  const revByCode = new Map();
  function addRev(ym, code, cur, ly, seen) {
    if (!(cur > 0) || !(ly > 0)) return;
    let avail = nextMonth11(ym);
    if (seen && seen < avail) avail = seen;
    let a = revByCode.get(code);
    if (!a) revByCode.set(code, a = []);
    const i = a.findIndex(x => x.ym === ym);
    const rec = { ym, avail, yoy: cur / ly - 1 };
    if (i >= 0) { if (avail < a[i].avail) a[i] = rec; } else a.push(rec);
  }
  for (const src of [readJson(path.join(dataDir, 'revenue_hist.json')), readJson(path.join(dataDir, 'revenue.json'))]) {
    if (!src || !src.months) continue;
    for (const [ym, rows] of Object.entries(src.months)) for (const [code, r] of Object.entries(rows)) addRev(ym, code, r[0], r[1], r[2] || null);
  }
  for (const a of revByCode.values()) a.sort((x, y) => x.avail < y.avail ? -1 : x.avail > y.avail ? 1 : 0);
  function revYoy(code, date) {
    const a = revByCode.get(code);
    if (!a) return null;
    let best = null;
    for (const x of a) { if (x.avail <= date) best = x; else break; }
    if (!best || (Date.parse(date) - Date.parse(best.avail)) / 864e5 > REV_MAX_AGE) return null;
    return best.yoy;
  }

  // ── 只比較資料都齊的日子（和 backtest_exp2.js 同條件，才能重現舊結果）
  const marginDir = path.join(dataDir, 'margin'), valDir = path.join(dataDir, 'val');
  const hasMargin = new Array(N).fill(false), hasVal = new Array(N).fill(false);
  for (let t = 0; t < T; t++) {
    hasMargin[t] = !!loadDay(marginDir, dates[t]);
    hasVal[t] = fs.existsSync(path.join(valDir, dates[t] + '.json.gz'));
  }
  const evalDays = [];
  for (let t = WARM; t < T - 1; t++) {
    let k = 0;
    for (let j = t - INST_DAYS + 1; j <= t; j++) if (j >= 0 && hasInst[j]) k++;
    if (k >= INST_MIN && hasVal[t] && hasMargin[t] && hasMargin[t - MARGIN_DAYS]) evalDays.push(t);
  }
  if (!evalDays.length) { console.error('沒有資料齊全的日子'); process.exit(2); }

  const VARS = ['A_all', 'B_all', 'A_strong', 'B_strong', 'leak', ...Array.from({ length: noiseN }, (_, i) => 'noise' + i)];
  const tr = {};      // tr[v] = { d: [], f: [] }（d = 指定手續費，f = 全額手續費）
  for (const v of VARS) tr[v] = { d: [], f: [] };
  const baseD = new Map(), baseF = new Map();
  const dump = [];
  let usedDays = 0, strongDays = 0, mismatch = 0, dropSum = 0, dropDays = 0;
  const t0 = Date.now();

  // 第一輪：每天算 A、B、leak 並記下 B 平均排除比例（雜訊尺要用）
  const dayInfo = [];
  for (const t of evalDays) {
    const list = [];
    for (const st of stocks) {
      if (st.t || st.s > t || st.e < t) continue;
      const idx = t - st.s;
      if (idx < WARM) continue;
      const a = Math.max(0, idx - WIN + 1), b = idx + 1;
      list.push({ code: st.code, name: st.name, full: st,
        closes: st.closes.slice(a, b), highs: st.highs.slice(a, b), lows: st.lows.slice(a, b), vols: st.vols.slice(a, b) });
    }
    const res = runAll({ market: { closes: mk.slice(0, t + 1) }, stocks: list }, DEFAULT_CFG, Object.assign({}, DEFAULT_ON, { div: false }));
    if (!res.market) continue;
    usedDays++;
    const strong = res.market.state === 'strong';
    if (strong !== isStrong(mk.slice(0, t + 1))) mismatch++;      // 自己的算法要跟網頁一致
    if (strong) strongDays++;
    const gate = res.rows.filter(x => x.ev.chk.liq && x.ev.chk.price && x.ev.chk.safe);
    const rd = [], rf = [];
    for (const x of gate) {
      const a = sim(x.s.full, t, hold, T, netD), b = sim(x.s.full, t, hold, T, net1);
      if (a !== null) rd.push(a);
      if (b !== null) rf.push(b);
    }
    if (rd.length) baseD.set(t, mean(rd));
    if (rf.length) baseF.set(t, mean(rf));
    const ok = res.rows.filter(x => x.ev.pass);
    if (!ok.length) continue;
    for (const x of ok) { x.rev = revYoy(x.s.code, dates[t]); x.inst = instRatio(x.s.full, t); }
    const pools = { A: ok, B: ok.filter(passB) };
    if (strong) { dropSum += (ok.length - pools.B.length) / ok.length; dropDays++; }
    const add = (v, picks) => {
      for (const x of picks) {
        const a = sim(x.s.full, t, hold, T, netD), b = sim(x.s.full, t, hold, T, net1);
        if (a === null || b === null) continue;
        tr[v].d.push({ t, r: a, code: x.s.code }); tr[v].f.push({ t, r: b, code: x.s.code });
      }
    };
    add('A_all', topPicks(pools.A)); add('B_all', topPicks(pools.B));
    if (strong) {
      add('A_strong', topPicks(pools.A)); add('B_strong', topPicks(pools.B));
      if (dumpPath) {
        for (const x of topPicks(pools.B)) {
          const r = sim(x.s.full, t, hold, T, netD);
          if (r !== null) dump.push({ t, date: dates[t], code: x.s.code, rev: x.rev, inst: x.inst, rank: x.ev.rank, r });
        }
      }
      // 偷看未來：排除未來 hold 天（扣成本後）最差的 20%
      const fwd = ok.map(x => ({ x, r: sim(x.s.full, t, hold, T, netD) }));
      const valid = fwd.filter(o => o.r !== null).map(o => o.r).sort((p, q) => p - q);
      const leakPool = valid.length < 5 ? ok : (bar => fwd.filter(o => o.r === null || o.r > bar).map(o => o.x))(valid[Math.floor(LEAK_DROP * (valid.length - 1))]);
      add('leak', topPicks(leakPool));
    }
    dayInfo.push({ t, strong, ok });
  }
  const bDrop = dropDays ? dropSum / dropDays : 0;

  // 第二輪：雜訊尺 —— 強勢日隨機排除與 B 同比例的股票（每組不同亂數）
  for (const { t, strong, ok } of dayInfo) {
    if (!strong) continue;
    for (let s = 0; s < noiseN; s++) {
      const rnd = mulberry32(s * 100003 + t);
      const pool = ok.filter(() => rnd() >= bDrop);
      for (const x of topPicks(pool)) {
        const a = sim(x.s.full, t, hold, T, netD);
        if (a !== null) tr['noise' + s].d.push({ t, r: a, code: x.s.code });
      }
    }
  }

  const results = {};
  for (const v of ['A_all', 'B_all', 'A_strong', 'B_strong', 'leak']) {
    results[v] = { d: summarize(tr[v].d, baseD, dates), full: summarize(tr[v].f, baseF, dates) };
  }
  const G = results.B_strong.d, Bd = results.B_all.d;
  const verdict = judgeG(G, Bd);
  const nz = [];
  for (let s = 0; s < noiseN; s++) {
    const r = summarize(tr['noise' + s].d, baseD, dates);
    nz.push({ seed: s, n: r.n, win: r.win, excess: r.excess });
  }
  const nw = nz.map(x => x.win).filter(x => x !== undefined), ne = nz.map(x => x.excess).filter(x => x !== null);
  const sd = a => a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)) : null;
  const noise = noiseN ? {
    runs: noiseN, dropRate: round2(bDrop * 100),
    win: { mean: round2(mean(nw)), sd: round2(sd(nw)), min: Math.min(...nw), max: Math.max(...nw) },
    excess: { mean: round2(mean(ne)), sd: round2(sd(ne)), min: Math.min(...ne), max: Math.max(...ne) },
    gVsNoise: { winDiff: round2(G.win - mean(nw)), excessDiff: round2(G.excess - mean(ne)) }
  } : null;

  // 重現舊結果（只有持有 20 天、全額手續費時可對照）
  let repro = null;
  const old = readJson(path.join(dataDir, 'backtest-exp2.json'));
  if (hold === 20 && old && old.results) {
    repro = {
      until, oldRange: old.range,
      A: { old: old.results.base[20].excess, now: results.A_all.full.excess, oldN: old.results.base[20].n, nowN: results.A_all.full.n },
      B: { old: old.results.filter[20].excess, now: results.B_all.full.excess, oldN: old.results.filter[20].n, nowN: results.B_all.full.n }
    };
  }

  const out = {
    generatedAt: new Date().toISOString(),
    range: { from: dates[evalDays[0]], to: dates[T - 1], days: usedDays, strongDays, marketStateMismatch: mismatch },
    params: { hold, feeDiscount: fd, top: TOP, taxPct: 0.3, noiseRuns: noiseN },
    criteria: CRIT,
    note: '三個方法是看過原版資料後挑的，有事後挑選的偏差；過關只算候選，要靠往後記錄驗證。leak 是檢查（偷看未來，應該大贏）。',
    verdict, results, noise, repro
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  if (dumpPath) fs.writeFileSync(dumpPath, JSON.stringify(dump));

  const line = (name, r) => `${name.padEnd(12)} ${String(r.n).padStart(5)} 筆，平均 ${r.avg}%，勝率 ${r.win}%，多賺 ${r.excess}%；三段勝率 ${r.parts.map(p => p.win).join('/')}；2026/6~9 ${r.recent.n} 筆多賺 ${r.recent.excess}`;
  console.log(`G 回測完成：${out.range.from} ~ ${out.range.to}，${usedDays} 天（強勢日 ${strongDays}），持有 ${hold} 天，手續費 ${fd} 折，用時 ${Math.round((Date.now() - t0) / 1000)} 秒；大盤強勢判定與網頁不一致 ${mismatch} 天`);
  for (const v of ['A_all', 'B_all', 'A_strong', 'B_strong', 'leak']) console.log(line(v, results[v].d));
  console.log('--- 全額手續費 ---');
  for (const v of ['A_all', 'B_all', 'A_strong', 'B_strong']) console.log(line(v, results[v].full));
  if (noise) console.log(`雜訊尺（強勢日隨機排除 ${noise.dropRate}%，${noiseN} 組）：勝率 ${noise.win.mean}（${noise.win.min}~${noise.win.max}），多賺 ${noise.excess.mean}（${noise.excess.min}~${noise.excess.max}）；G 比雜訊 勝率 ${noise.gVsNoise.winDiff >= 0 ? '+' : ''}${noise.gVsNoise.winDiff}、多賺 ${noise.gVsNoise.excessDiff >= 0 ? '+' : ''}${noise.gVsNoise.excessDiff}`);
  if (repro) console.log(`重現檢查：A 多賺 ${repro.A.now}（舊 ${repro.A.old}），B ${repro.B.now}（舊 ${repro.B.old}）；筆數 A ${repro.A.nowN}/${repro.A.oldN}，B ${repro.B.nowN}/${repro.B.oldN}`);
  const c = verdict.criteria, mark = b => b ? '✓' : '✗';
  console.log(`G 判定：①勝率≥50 ${mark(c.win)}(${G.win}) ②多賺≥B ${mark(c.excess)}(${G.excess} vs ${Bd.excess}) ③三段勝率≥48 ${mark(c.parts)}(${G.parts.map(p => p.win).join('/')}) ④近期 ${mark(c.recent)}(${G.recent.n} 筆, ${G.recent.excess}) → ${verdict.pass ? '過關（候選）' : verdict.smallSample ? '樣本太少，只當參考' : '沒過關'}`);
}

module.exports = { isStrong, passB, topPicks, sim, makeNet, summarize, judgeG, stats, CRIT };
if (require.main === module) main();
