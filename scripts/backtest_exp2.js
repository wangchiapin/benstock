#!/usr/bin/env node
// 多組合比較實驗（A～F）。規格見 HANDOFF.md 第 7.3 節（看結果前定好）。只測試，不改網頁。
// 用法：node scripts/backtest_exp2.js 歷史檔.json index.html data 輸出.json [--until 2026-10-15] [--noise-drop 0.2] [--dump-factors 檔案]
//   --noise-drop：雜訊尺隨機排除的比例，預設 0.2；想公平看 B（排除約三分之二）可設 0.67
//   --dump-factors：檢查用，存幾天的各因子數值，拿來用別的程式獨立驗算
//   --until：只用到這一天的資料，拿來重現 data/backtest-exp.json 的舊結果，確認 A、B 沒算錯
//
// 共同做法（跟 backtest_exp.js 完全一樣）：每天收盤後用原版排名選前 10 檔（不開穩定配息），隔天開盤買
// （開盤漲停、停牌買不到），持有 10 / 20 個交易日收盤賣，扣手續費和證交稅，不設停損。
// 對照組 = 同一天基本門檻合格的全部股票平均；「多賺」= 每筆減掉當天對照組平均。
//
// 組合（A、B 的算法從 backtest_exp.js 照搬）：
//   base    A 原版
//   filter  B 排除營收年增率 < 0 或近 20 日法人買賣超 < 0（資料缺的不排除）
//   pe      C 本益比或淨值比在「當天合格股票」裡最高的 20% 不選（沒有的不排除）
//   margin  D 近 20 個交易日融資餘額增加比例最高的 20% 不選（20 天前餘額 ≤ 0 的不排除）
//   sector  E 只選「所屬產業近 20 日漲幅中位數」排前一半的產業；中位數用該產業在「基本門檻合格」股票裡算，
//           成員少於 5 檔的產業、查不到產業的股票不排除
//   vol     F 近 60 日每天漲跌幅標準差最高的 20% 不選
// 「最高 20%」= 排序後第 floor(0.8×(n−1)) 名的值當切點，大於切點的排除。C、D、F 都在當天合格股票（過原版全部門檻）裡算。
//
// 另外兩個只當檢查、不參與過關：
//   noise   隨機排除 20%（30 組不同亂數，比例可用 --noise-drop 調），看「純運氣」能比原版多賺或少賺多少 → 當雜訊尺
//   leak    偷看未來：排除未來 20 天漲幅最差的 20%。應該大贏，證明過濾有確實被算進去
//
// 過關（C～F 都跟 A 比，四條都要過）：
//   1. 持有 20 天，每筆比原版多賺 ≥ 0.5 個百分點
//   2. 前、中、後三段都比原版好
//   3. 逐月比較，贏原版的月份超過一半
//   4. 2026 年 6～9 月（四個月多賺的平均）不比原版差
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TOP = 10, HOLDS = [10, 20], GOAL = 0.5;
const BUY_FEE = 0.001425, SELL_FEE = 0.001425, TAX = 0.003;
const WARM = 125, WIN = 130, INST_DAYS = 20, INST_MIN = 15, REV_MAX_AGE = 75;
const CUT = 0.8, MARGIN_DAYS = 20, VOL_DAYS = 60, SECTOR_MIN = 5, NOISE_SEEDS = 30, LEAK_DROP = 0.2;
const ARMS = ['base', 'filter', 'pe', 'margin', 'sector', 'vol'];
const CANDIDATES = ['pe', 'margin', 'sector', 'vol'];
const LABEL = {
  base: 'A 原版', filter: 'B 排除營收衰退或法人賣超（參考）', pe: 'C 本益比／淨值比太貴不選', margin: 'D 融資暴增不選',
  sector: 'E 只選強勢產業', vol: 'F 太不穩的不選'
};
const SUMMER = ['2026-06', '2026-07', '2026-08', '2026-09'];

// ───────────── 小工具（也給單元測試用） ─────────────
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const round2 = x => Math.round(x * 100) / 100;
const net = (entry, exit) => (exit * (1 - SELL_FEE - TAX)) / (entry * (1 + BUY_FEE)) - 1;
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const isNum = v => typeof v === 'number' && Number.isFinite(v);
function median(a) {
  const s = [...a].sort((x, y) => x - y), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
// 「最高 20%」的切點：排序後第 floor(q×(n−1)) 名的值。大於切點的算最高。有效資料少於 5 筆就不排除（回傳 Infinity）
function quantileCut(vals, q = CUT) {
  const a = vals.filter(isNum).sort((x, y) => x - y);
  if (a.length < 5) return Infinity;
  return a[Math.floor(q * (a.length - 1))];
}
// 近 n 天每天漲跌幅的標準差（樣本標準差）。closes[idx] 是當天，資料不夠或有 0 以下的價格回傳 null
function dailyVol(closes, idx, n = VOL_DAYS) {
  if (idx < n || idx >= closes.length) return null;
  const r = [];
  for (let i = idx - n + 1; i <= idx; i++) {
    if (!(closes[i] > 0) || !(closes[i - 1] > 0)) return null;
    r.push(closes[i] / closes[i - 1] - 1);
  }
  const m = mean(r);
  return Math.sqrt(r.reduce((s, x) => s + (x - m) * (x - m), 0) / (r.length - 1));
}
// 產業強弱：rows = [{code, ret20}]（基本門檻合格的股票），ind = {代號: 產業代碼}
// 回傳 (code) => 這檔可不可以選。成員 < SECTOR_MIN 的產業、沒有產業的股票一律可以選；強勢 = 產業中位數 ≥ 所有產業中位數的中位數
function sectorFilter(rows, ind) {
  const by = new Map();
  for (const r of rows) {
    const s = ind[r.code];
    if (!s || !isNum(r.ret20)) continue;
    if (!by.has(s)) by.set(s, []);
    by.get(s).push(r.ret20);
  }
  const med = new Map();
  for (const [s, a] of by) if (a.length >= SECTOR_MIN) med.set(s, median(a));
  if (med.size < 4) return () => true;
  const bar = median([...med.values()]);
  return code => {
    const s = ind[code];
    return !s || !med.has(s) || med.get(s) >= bar;
  };
}
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
// 讀某天的檔案（data/val 或 data/margin）。沒有檔案或是空檔回傳 null；檔案裡的日期跟檔名不同直接報錯
function loadDay(dir, date) {
  const p = path.join(dir, date + '.json.gz');
  if (!fs.existsSync(p)) return null;
  const js = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
  if (js.date !== date) throw new Error(`${p} 裡面的日期是 ${js.date}，跟檔名不一樣`);
  return js.empty ? null : js.d;
}
function stats(a) {
  const n = a.length;
  if (!n) return { n: 0 };
  return { n, win: round2(a.filter(x => x > 0).length / n * 100), avg: round2(mean(a) * 100) };
}
// 把某組的成績整理成固定格式。trades：[{t, r}]；baseDay：Map(t → 當天對照組平均)；cuts：前中後三段的切點
function summarize(trades, baseDay, cuts, dates) {
  const ex = a => a.length ? round2(mean(a.map(x => x.r - (baseDay.get(x.t) ?? 0))) * 100) : null;
  const part = i => trades.filter(x => x.t >= cuts[i] && x.t < cuts[i + 1]);
  const months = {};
  for (const x of trades) { const m = dates[x.t].slice(0, 7); (months[m] = months[m] || []).push(x); }
  return Object.assign({ excess: ex(trades) }, stats(trades.map(x => x.r)), {
    parts: [0, 1, 2].map(i => { const a = part(i); return Object.assign({ excess: ex(a) }, stats(a.map(x => x.r))); }),
    byMonth: Object.keys(months).sort().map(m => ({ m, n: months[m].length, avg: round2(mean(months[m].map(x => x.r)) * 100), excess: ex(months[m]) }))
  });
}
// 套用四條過關標準。arm、base 是 summarize 的結果（持有 20 天）
function judge(arm, base) {
  const diff = round2((arm.excess ?? 0) - (base.excess ?? 0));
  const partsBetter = arm.parts.map((p, i) => p.excess !== null && base.parts[i].excess !== null && p.excess > base.parts[i].excess);
  const bm = new Map(base.byMonth.map(x => [x.m, x.excess]));
  let compared = 0, won = 0;
  for (const x of arm.byMonth) {
    const b = bm.get(x.m);
    if (x.excess === null || b === undefined || b === null) continue;
    compared++;
    if (x.excess > b) won++;
  }
  const summer = r => { const v = SUMMER.map(k => (r.byMonth.find(x => x.m === k) || {}).excess).filter(x => x != null); return v.length ? round2(mean(v)) : null; };
  const sa = summer(arm), sb = summer(base);
  const c = {
    diff: arm.excess !== null && base.excess !== null && diff >= GOAL,
    parts: partsBetter.every(Boolean),
    months: compared > 0 && won > compared / 2,
    summer: sa !== null && sb !== null && sa >= sb
  };
  return { diff, partsBetter, months: { won, of: compared }, summer2026: { arm: sa, base: sb }, criteria: c, pass: Object.values(c).every(Boolean) };
}

// ───────────── 主程式 ─────────────
function main() {
  const args = process.argv.slice(2), pos = [];
  let until = null, noiseDrop = 0.2, dumpPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--until') until = args[++i];
    else if (args[i] === '--noise-drop') noiseDrop = parseFloat(args[++i]);       // 雜訊尺隨機排除的比例（預設 0.2）
    else if (args[i] === '--dump-factors') dumpPath = args[++i];                  // 檢查用：存幾天的各因子數值
    else pos.push(args[i]);
  }
  if (!(noiseDrop > 0 && noiseDrop < 1)) { console.error('--noise-drop 要在 0 到 1 之間'); process.exit(2); }
  const [histPath, htmlPath, dataDir, outPath] = pos;
  if (!histPath || !htmlPath || !dataDir || !outPath) {
    console.error('用法：node scripts/backtest_exp2.js 歷史檔.json index.html data 輸出.json [--until 2026-10-15]');
    process.exit(2);
  }
  const html = fs.readFileSync(htmlPath, 'utf8');
  const mm = html.match(/\/\/<core>([\s\S]*?)\/\/<\/core>/);
  if (!mm) { console.error('index.html 裡找不到 //<core> 區塊'); process.exit(2); }
  const { runAll, DEFAULT_CFG, DEFAULT_ON } = new Function(mm[1] + ';return {runAll,DEFAULT_CFG,DEFAULT_ON};')();

  const H = JSON.parse(fs.readFileSync(histPath, 'utf8'));
  const dates = H.dates, mk = H.market.closes, stocks = H.stocks, N = dates.length;
  let T = N;
  if (until) { let c = -1; for (let i = 0; i < N; i++) if (dates[i] <= until) c = i; T = c + 1; }

  // ── 三大法人（B 用，照搬 backtest_exp.js）
  const instDir = path.join(dataDir, 'inst');
  const hasInst = new Array(N).fill(false);
  const instTot = new Map();
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
  // ── 月營收（B 用，照搬 backtest_exp.js）
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
  const hist = readJson(path.join(dataDir, 'revenue_hist.json'));
  const live = readJson(path.join(dataDir, 'revenue.json'));
  for (const src of [hist, live]) {
    if (!src || !src.months) continue;
    for (const [ym, rows] of Object.entries(src.months)) for (const [code, r] of Object.entries(rows)) addRev(ym, code, r[0], r[1], r[2] || null);
  }
  for (const a of revByCode.values()) a.sort((x, y) => x.avail < y.avail ? -1 : x.avail > y.avail ? 1 : 0);
  const dayMs = 864e5;
  function revYoy(code, date) {
    const a = revByCode.get(code);
    if (!a) return null;
    let best = null;
    for (const x of a) { if (x.avail <= date) best = x; else break; }
    if (!best || (Date.parse(date) - Date.parse(best.avail)) / dayMs > REV_MAX_AGE) return null;
    return best.yoy;
  }

  // ── 融資餘額、本益比、產業（C、D、E 用）
  const marginDir = path.join(dataDir, 'margin'), valDir = path.join(dataDir, 'val');
  const hasMargin = new Array(N).fill(false), hasVal = new Array(N).fill(false);
  const marginBal = new Map();
  for (let t = 0; t < T; t++) {
    const d = loadDay(marginDir, dates[t]);
    if (d) {
      hasMargin[t] = true;
      for (const [code, row] of Object.entries(d)) {
        if (!isNum(row[1])) continue;
        let a = marginBal.get(code);
        if (!a) marginBal.set(code, a = new Float64Array(N).fill(NaN));
        a[t] = row[1];
      }
    }
    hasVal[t] = fs.existsSync(path.join(valDir, dates[t] + '.json.gz'));
  }
  function marginChange(code, t) {
    const a = marginBal.get(code);
    if (!a || t < MARGIN_DAYS) return null;
    const cur = a[t], prev = a[t - MARGIN_DAYS];
    if (!isNum(cur) || !isNum(prev) || !(prev > 0)) return null;
    return cur / prev - 1;
  }
  const indFile = readJson(path.join(dataDir, 'industry.json'));
  const industry = indFile && indFile.d ? indFile.d : {};

  // ── 模擬一筆（照搬）
  function sim(st, t, h) {
    if (t + h > T - 1) return null;
    const k1 = t + 1 - st.s;
    if (k1 < 0 || t + 1 > st.e || st.vols[k1] === 0) return null;
    const prevClose = st.closes[t - st.s], entry = st.opens[k1];
    if (!(entry > 0) || entry >= prevClose * 1.095) return null;
    return net(entry, st.closes[Math.min(t + h, st.e) - st.s]);
  }

  // ── 只在資料都齊的日子比較：法人 ≥ 15/20 天、當天有本益比和融資、20 天前也有融資
  const evalDays = [];
  for (let t = WARM; t < T - 1; t++) {
    let k = 0;
    for (let j = t - INST_DAYS + 1; j <= t; j++) if (j >= 0 && hasInst[j]) k++;
    if (k >= INST_MIN && hasVal[t] && hasMargin[t] && hasMargin[t - MARGIN_DAYS]) evalDays.push(t);
  }
  if (!evalDays.length) { console.error('沒有資料齊全的日子，請先補抓三大法人、本益比、融資'); process.exit(2); }

  const trades = {}, baseDay = {};
  const names = [...ARMS, 'leak', ...Array.from({ length: NOISE_SEEDS }, (_, i) => 'noise' + i)];
  for (const v of names) for (const h of HOLDS) trades[v + '|' + h] = [];
  for (const h of HOLDS) baseDay[h] = new Map();
  const drop = {}, changed = {};
  for (const v of ARMS) { drop[v] = []; changed[v] = []; }
  const cover = { ok: 0, pe: 0, pb: 0, margin: 0, vol: 0, sector: 0 };
  const t0 = Date.now();
  let usedDays = 0, noValDays = 0;
  const dump = [];

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
    const ok = res.rows.filter(x => x.ev.pass);
    const gate = res.rows.filter(x => x.ev.chk.liq && x.ev.chk.price && x.ev.chk.safe);
    for (const h of HOLDS) {
      const rs = [];
      for (const x of gate) { const r = sim(x.s.full, t, h); if (r !== null) rs.push(r); }
      if (rs.length) baseDay[h].set(t, mean(rs));
    }
    if (!ok.length) continue;

    // 各組要用的數字
    const vday = loadDay(valDir, dates[t]);
    if (!vday) noValDays++;
    for (const x of ok) {
      const st = x.s.full, v = vday && vday[x.s.code];
      x.rev = revYoy(x.s.code, dates[t]);
      x.inst = instRatio(st, t);
      x.pe = v ? v[0] : null; x.pb = v ? v[1] : null;
      x.mg = marginChange(x.s.code, t);
      x.vv = dailyVol(st.closes, t - st.s);
    }
    const cuts = {
      pe: quantileCut(ok.map(x => x.pe)), pb: quantileCut(ok.map(x => x.pb)),
      mg: quantileCut(ok.map(x => x.mg)), vv: quantileCut(ok.map(x => x.vv))
    };
    if (dumpPath && usedDays % 60 === 1) {
      dump.push({ t, date: dates[t], cuts, rows: ok.map(x => ({ code: x.s.code, pe: x.pe, pb: x.pb, mg: x.mg, vv: x.vv, ind: industry[x.s.code] || null })) });
    }
    const secOk = sectorFilter(gate.map(x => ({ code: x.s.code, ret20: x.m.ret20 })), industry);
    cover.ok += ok.length;
    for (const x of ok) {
      if (x.pe !== null) cover.pe++; if (x.pb !== null) cover.pb++; if (x.mg !== null) cover.margin++;
      if (x.vv !== null) cover.vol++; if (industry[x.s.code]) cover.sector++;
    }
    const pools = {
      base: ok,
      filter: ok.filter(x => !(x.rev !== null && x.rev < 0) && !(x.inst !== null && x.inst < 0)),
      pe: ok.filter(x => !(x.pe !== null && x.pe > cuts.pe) && !(x.pb !== null && x.pb > cuts.pb)),
      margin: ok.filter(x => !(x.mg !== null && x.mg > cuts.mg)),
      sector: ok.filter(x => secOk(x.s.code)),
      vol: ok.filter(x => !(x.vv !== null && x.vv > cuts.vv))
    };
    // 檢查用：偷看未來（排除未來 20 天最差的 20%）
    const fwd = ok.map(x => ({ x, r: sim(x.s.full, t, 20) }));
    pools.leak = (() => {
      const valid = fwd.filter(o => o.r !== null).map(o => o.r).sort((p, q) => p - q);
      if (valid.length < 5) return ok;
      const bar = valid[Math.floor(LEAK_DROP * (valid.length - 1))];  // 最差 20% 的切點
      return fwd.filter(o => o.r === null || o.r > bar).map(o => o.x);
    })();
    // 檢查用：隨機排除 20%
    for (let s = 0; s < NOISE_SEEDS; s++) {
      const rng = mulberry32(s * 100003 + t);
      pools['noise' + s] = ok.filter(() => rng() >= noiseDrop);
    }

    const baseCodes = new Set();
    for (const v of Object.keys(pools)) {
      const picks = [...pools[v]].sort((p, q) => q.ev.rank - p.ev.rank).slice(0, TOP);
      if (v === 'base') picks.forEach(x => baseCodes.add(x.s.code));
      if (ARMS.includes(v)) {
        drop[v].push((ok.length - pools[v].length) / ok.length);
        changed[v].push(picks.filter(x => !baseCodes.has(x.s.code)).length);
      }
      for (const x of picks) {
        for (const h of HOLDS) {
          const r = sim(x.s.full, t, h);
          if (r !== null) trades[v + '|' + h].push({ t, r, code: x.s.code });
        }
      }
    }
  }

  // ── 整理成績
  const daysAll = evalDays.filter(t => baseDay[20].has(t));
  const cutT = [daysAll[0], daysAll[Math.floor(daysAll.length / 3)], daysAll[Math.floor(daysAll.length * 2 / 3)], Infinity];
  const partName = i => `${dates[cutT[i]]} ~ ${dates[Math.min(cutT[i + 1] === Infinity ? T - 1 : cutT[i + 1] - 1, T - 1)]}`;
  const results = {};
  for (const v of [...ARMS, 'leak']) {
    results[v] = { label: LABEL[v] || '檢查：偷看未來，排除未來 20 天最差的 20%' };
    for (const h of HOLDS) {
      const s = summarize(trades[v + '|' + h], baseDay[h], cutT, dates);
      s.parts.forEach((p, i) => { p.range = partName(i); });
      results[v][h] = s;
    }
  }
  const verdict = {};
  for (const v of ARMS.filter(x => x !== 'base')) {
    const j = judge(results[v][20], results.base[20]);
    j.label = LABEL[v];
    j.vsB = v === 'filter' ? null : round2((results[v][20].excess ?? 0) - (results.filter[20].excess ?? 0));
    j.avgDropPct = round2(mean(drop[v]) * 100);
    j.avgPicksChanged = round2(mean(changed[v]));
    verdict[v] = j;
  }
  // 雜訊尺：隨機排除 20% 比原版多賺多少
  const noiseDiffs = [];
  for (let s = 0; s < NOISE_SEEDS; s++) {
    const r = summarize(trades['noise' + s + '|20'], baseDay[20], cutT, dates);
    noiseDiffs.push(round2((r.excess ?? 0) - (results.base[20].excess ?? 0)));
  }
  const nd = [...noiseDiffs].sort((a, b) => a - b);
  const sdv = Math.sqrt(noiseDiffs.reduce((s, x) => s + Math.pow(x - mean(noiseDiffs), 2), 0) / (noiseDiffs.length - 1));
  const noise = { seeds: NOISE_SEEDS, drop: noiseDrop, mean: round2(mean(noiseDiffs)), sd: round2(sdv), min: nd[0], max: nd[nd.length - 1],
    over05: noiseDiffs.filter(x => x >= GOAL).length, diffs: noiseDiffs };

  // 重現舊結果
  let repro = null;
  const old = readJson(path.join(dataDir, 'backtest-exp.json'));
  if (until && old && old.results) {
    repro = {
      until, oldRange: old.range,
      base: { old: old.results.base[20].excess, now: results.base[20].excess },
      filter: { old: old.results.filter[20].excess, now: results.filter[20].excess },
      baseN: { old: old.results.base[20].n, now: results.base[20].n }
    };
  }

  const out = {
    generatedAt: new Date().toISOString(),
    range: { from: dates[evalDays[0]], to: dates[T - 1], days: usedDays },
    until: until || null,
    rule: `每天前 ${TOP} 檔，隔天開盤買，持有 10 / 20 天收盤賣，扣手續費和證交稅，不設停損；對照組是同一天基本門檻合格的全部股票`,
    goal: '持有 20 天：①每筆比原版多賺 ≥ 0.5 個百分點 ②前中後三段都比原版好 ③逐月贏原版的月份超過一半 ④2026/6～9 月不比原版差',
    coverage: {
      okWithPe: round2(cover.pe / cover.ok * 100), okWithPb: round2(cover.pb / cover.ok * 100), okWithMargin: round2(cover.margin / cover.ok * 100),
      okWithVol: round2(cover.vol / cover.ok * 100), okWithIndustry: round2(cover.sector / cover.ok * 100), noValDays
    },
    verdict, noise, repro, results
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  if (dumpPath) fs.writeFileSync(dumpPath, JSON.stringify(dump));

  console.log(`多組合回測完成：${out.range.from} ~ ${out.range.to}，${usedDays} 天，用時 ${Math.round((Date.now() - t0) / 1000)} 秒`);
  if (repro) console.log(`重現檢查（用到 ${until}）：A 多賺 ${repro.base.now}（舊 ${repro.base.old}）、B ${repro.filter.now}（舊 ${repro.filter.old}）；A 筆數 ${repro.baseN.now}（舊 ${repro.baseN.old}）`);
  for (const v of [...ARMS, 'leak']) {
    const r = results[v][20];
    console.log(`${(LABEL[v] || '檢查：偷看未來').padEnd(24)} 20 天 ${r.n} 筆，平均 ${r.avg}%，勝率 ${r.win}%，多賺 ${r.excess}%；三段 ${r.parts.map(p => p.excess).join(' / ')}`);
  }
  for (const [v, x] of Object.entries(verdict)) {
    const c = x.criteria;
    console.log(`${x.label}：比原版 ${x.diff >= 0 ? '+' : ''}${x.diff}｜①${c.diff ? '✓' : '✗'} ②${c.parts ? '✓' : '✗'}(${x.partsBetter.map(b => b ? '好' : '差').join('')}) ③${c.months ? '✓' : '✗'}(${x.months.won}/${x.months.of}) ④${c.summer ? '✓' : '✗'}(${x.summer2026.arm} vs ${x.summer2026.base}) → ${x.pass ? '過關' : '沒過關'}`);
  }
  console.log(`雜訊尺（隨機排除 ${round2(noiseDrop * 100)}%，${NOISE_SEEDS} 組）：比原版多賺 平均 ${noise.mean}，標準差 ${noise.sd}，範圍 ${noise.min} ~ ${noise.max}，達 ${GOAL} 以上的有 ${noise.over05} 組`);
}

module.exports = { quantileCut, dailyVol, sectorFilter, judge, summarize, loadDay, median, mulberry32, net };
if (require.main === module) main();
