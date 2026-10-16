#!/usr/bin/env node
// 實驗回測：在現行排名上加「月營收年增率」和「三大法人買賣超」，看有沒有明顯改善。只測試，不改網頁。
// 用法：node scripts/backtest_exp.js 歷史檔.json index.html data 輸出.json
//
// 跟 backtest.js 一樣的買賣方式：每天收盤後選前 10 檔，隔天開盤買（開盤漲停、停牌買不到），
// 持有 10 / 20 個交易日收盤賣，扣手續費和證交稅，不設停損。對照組 = 同一天基本門檻合格的全部股票。
//
// 避免偷看未來：
//   - 三大法人：第 t 天收盤後公布，第 t 天收盤選股可以用（隔天才買）
//   - 月營收：某月的營收，一律當作「次月 11 日」才知道；每日抓取時有記下更早看到的日期，就用那天
//
// 測的組合（事先定好，不再加）：
//   base   原版：近 20 日漲幅 + 離 120 日高點的距離
//   rev    原版 + 營收年增率
//   inst   原版 + 近 20 日三大法人買賣超（除以同期成交量）
//   both   原版 + 兩個都加
//   filter 原版排名，但營收衰退或法人賣超的不選
// 資料缺的股票：排名時給中間值（不加分不扣分）；過濾時不排除。
//
// 「明顯改善」的標準（看結果前定的）：前 10 檔持有 20 天，平均每筆比原版多賺 0.5 個百分點以上，
// 而且前、中、後三段時間都比原版好。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const [, , histPath, htmlPath, dataDir, outPath] = process.argv;
if (!histPath || !htmlPath || !dataDir || !outPath) {
  console.error('用法：node scripts/backtest_exp.js 歷史檔.json index.html data 輸出.json');
  process.exit(2);
}
const html = fs.readFileSync(htmlPath, 'utf8');
const mm = html.match(/\/\/<core>([\s\S]*?)\/\/<\/core>/);
if (!mm) { console.error('index.html 裡找不到 //<core> 區塊'); process.exit(2); }
const { runAll, DEFAULT_CFG, DEFAULT_ON } = new Function(mm[1] + ';return {runAll,DEFAULT_CFG,DEFAULT_ON};')();

const H = JSON.parse(fs.readFileSync(histPath, 'utf8'));
const dates = H.dates, mk = H.market.closes, stocks = H.stocks, T = dates.length;
const TOP = 10, HOLDS = [10, 20];
const BUY_FEE = 0.001425, SELL_FEE = 0.001425, TAX = 0.003;
const WARM = 125, WIN = 130, INST_DAYS = 20, INST_MIN = 15, REV_MAX_AGE = 75;  // 營收超過 75 天沒更新就當沒資料
const VARIANTS = ['base', 'rev', 'inst', 'both', 'filter'];
const LABEL = { base: '原版', rev: '+營收年增率', inst: '+法人買賣超', both: '+營收+法人', filter: '原版但排除營收衰退或法人賣超' };
const GOAL = 0.5;

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const round2 = x => Math.round(x * 100) / 100;
const net = (entry, exit) => (exit * (1 - SELL_FEE - TAX)) / (entry * (1 + BUY_FEE)) - 1;
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };

// ── 三大法人：instTot[code][t] = 合計買賣超（股），那天沒檔案是 undefined
const instDir = path.join(dataDir, 'inst');
const hasInst = new Array(T).fill(false);
const instTot = new Map();
for (let t = 0; t < T; t++) {
  const p = path.join(instDir, dates[t] + '.json.gz');
  if (!fs.existsSync(p)) continue;
  const js = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
  hasInst[t] = true;
  for (const [code, row] of Object.entries(js.d)) {
    let a = instTot.get(code);
    if (!a) instTot.set(code, a = new Float64Array(T));
    a[t] = row[3];
  }
}
// 近 20 日法人買賣超 ÷ 同期成交股數。資料天數不夠回傳 null
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

// ── 月營收：每家公司依「可以使用的日期」排好
const nextMonth11 = ym => { let y = +ym.slice(0, 4), m = +ym.slice(5, 7) + 1; if (m > 12) { m = 1; y++; } return `${y}-${String(m).padStart(2, '0')}-11`; };
const revByCode = new Map();   // code -> [{avail, yoy}]，依 avail 排序
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

// ── 模擬一筆
function sim(st, t, h) {
  if (t + h > T - 1) return null;
  const k1 = t + 1 - st.s;
  if (k1 < 0 || t + 1 > st.e || st.vols[k1] === 0) return null;
  const prevClose = st.closes[t - st.s], entry = st.opens[k1];
  if (!(entry > 0) || entry >= prevClose * 1.095) return null;
  return net(entry, st.closes[Math.min(t + h, st.e) - st.s]);
}
function pctRank(rows, key, out) {   // 有資料的排百分位，沒資料給 0.5
  const has = rows.filter(x => x[key] !== null).sort((p, q) => p[key] - q[key]);
  const n = has.length;
  for (const x of rows) x[out] = 0.5;
  has.forEach((x, i) => { x[out] = n > 1 ? i / (n - 1) : 0.5; });
}

// ── 只在法人和營收資料都齊的日子比較
const evalDays = [];
for (let t = WARM; t < T - 1; t++) {
  let k = 0;
  for (let j = t - INST_DAYS + 1; j <= t; j++) if (j >= 0 && hasInst[j]) k++;
  if (k >= INST_MIN) evalDays.push(t);
}
if (!evalDays.length) { console.error('沒有法人資料夠多的日子，請先補抓三大法人'); process.exit(2); }

const trades = {}; for (const v of VARIANTS) for (const h of HOLDS) trades[v + '|' + h] = [];
const baseDay = {}; for (const h of HOLDS) baseDay[h] = new Map();
const cover = { picksRev: 0, picksInst: 0, picks: 0, okRev: 0, okInst: 0, ok: 0 };
const t0 = Date.now();
let usedDays = 0;

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
  // 跟 backtest.js 一樣不用穩定配息篩選（沒有每天的歷史除權息資料）
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
  for (const x of ok) {
    x.rev = revYoy(x.s.code, dates[t]);
    x.inst = instRatio(x.s.full, t);
    cover.ok++; if (x.rev !== null) cover.okRev++; if (x.inst !== null) cover.okInst++;
  }
  pctRank(ok, 'rev', 'revp'); pctRank(ok, 'inst', 'instp');
  const score = {
    base: x => x.ev.rank,
    rev: x => x.ev.rank + x.revp,
    inst: x => x.ev.rank + x.instp,
    both: x => x.ev.rank + x.revp + x.instp,
    filter: x => x.ev.rank
  };
  for (const v of VARIANTS) {
    let pool = ok;
    if (v === 'filter') pool = ok.filter(x => !(x.rev !== null && x.rev < 0) && !(x.inst !== null && x.inst < 0));
    const picks = [...pool].sort((p, q) => score[v](q) - score[v](p)).slice(0, TOP);
    for (const x of picks) {
      if (v === 'base') { cover.picks++; if (x.rev !== null) cover.picksRev++; if (x.inst !== null) cover.picksInst++; }
      for (const h of HOLDS) {
        const r = sim(x.s.full, t, h);
        if (r !== null) trades[v + '|' + h].push({ t, r, code: x.s.code });
      }
    }
  }
}

// ── 整理成績
function stats(a) {
  const n = a.length;
  if (!n) return { n: 0 };
  return { n, win: round2(a.filter(x => x > 0).length / n * 100), avg: round2(mean(a) * 100) };
}
const results = {};
const daysAll = evalDays.filter(t => baseDay[20].has(t));
const cuts = [daysAll[0], daysAll[Math.floor(daysAll.length / 3)], daysAll[Math.floor(daysAll.length * 2 / 3)], Infinity];
const partName = i => `${dates[cuts[i]]} ~ ${dates[Math.min(cuts[i + 1] === Infinity ? T - 1 : cuts[i + 1] - 1, T - 1)]}`;
for (const v of VARIANTS) {
  results[v] = { label: LABEL[v] };
  for (const h of HOLDS) {
    const all = trades[v + '|' + h], bd = baseDay[h];
    const ex = a => a.length ? round2(mean(a.map(x => x.r - (bd.get(x.t) ?? 0))) * 100) : null;
    const part = i => all.filter(x => x.t >= cuts[i] && x.t < cuts[i + 1]);
    const months = {};
    for (const x of all) { const m = dates[x.t].slice(0, 7); (months[m] = months[m] || []).push(x); }
    results[v][h] = Object.assign({ excess: ex(all) }, stats(all.map(x => x.r)), {
      parts: [0, 1, 2].map(i => { const a = part(i); return Object.assign({ range: partName(i), excess: ex(a) }, stats(a.map(x => x.r))); }),
      byMonth: Object.keys(months).sort().map(m => ({ m, n: months[m].length, avg: round2(mean(months[m].map(x => x.r)) * 100), excess: ex(months[m]) }))
    });
  }
}
// 跟原版比，套用事先定好的標準
const verdict = {};
for (const v of VARIANTS.filter(v => v !== 'base')) {
  const a = results[v][20], b = results.base[20];
  const diff = (a.excess ?? 0) - (b.excess ?? 0);
  const partsBetter = a.parts.map((p, i) => (p.excess ?? -1e9) > (b.parts[i].excess ?? 1e9));
  const summer = m => ['2026-06', '2026-07', '2026-08', '2026-09'].map(k => (m.find(x => x.m === k) || {}).excess).filter(x => x != null);
  const sa = summer(a.byMonth), sb = summer(b.byMonth);
  verdict[v] = {
    label: LABEL[v], diff: round2(diff), partsBetter,
    summer2026: { exp: sa.length ? round2(mean(sa)) : null, base: sb.length ? round2(mean(sb)) : null },
    pass: diff >= GOAL && partsBetter.every(Boolean)
  };
}

const out = {
  generatedAt: new Date().toISOString(),
  range: { from: dates[evalDays[0]], to: dates[T - 1], days: usedDays },
  rule: `每天前 ${TOP} 檔，隔天開盤買，持有 10 / 20 天收盤賣，扣手續費和證交稅，不設停損；對照組是同一天基本門檻合格的全部股票`,
  goal: `前 ${TOP} 檔持有 20 天，平均每筆比原版多賺 ${GOAL} 個百分點以上，而且前、中、後三段都比原版好`,
  coverage: {
    picksWithRev: cover.picks ? round2(cover.picksRev / cover.picks * 100) : 0,
    picksWithInst: cover.picks ? round2(cover.picksInst / cover.picks * 100) : 0,
    okWithRev: cover.ok ? round2(cover.okRev / cover.ok * 100) : 0,
    okWithInst: cover.ok ? round2(cover.okInst / cover.ok * 100) : 0,
    revMonths: hist ? Object.keys(hist.months || {}).length : 0
  },
  verdict, results
};
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(`實驗回測完成：${out.range.from} ~ ${out.range.to}，${usedDays} 天，用時 ${Math.round((Date.now() - t0) / 1000)} 秒`);
console.log(`資料涵蓋：原版選到的股票有營收 ${out.coverage.picksWithRev}%、有法人 ${out.coverage.picksWithInst}%`);
for (const v of VARIANTS) {
  const r = results[v][20];
  console.log(`${LABEL[v]}：20 天 ${r.n} 筆，平均 ${r.avg}%，勝率 ${r.win}%，比對照組多 ${r.excess}%；三段 ${r.parts.map(p => p.excess).join(' / ')}`);
}
for (const [v, x] of Object.entries(verdict)) console.log(`${x.label}：比原版 ${x.diff >= 0 ? '+' : ''}${x.diff}，三段都較好 ${x.partsBetter.every(Boolean)} → ${x.pass ? '過關' : '沒過關'}`);
