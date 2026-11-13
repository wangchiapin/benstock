#!/usr/bin/env node
// 觀察組往後記錄：M（Minervini 趨勢條件）與 V（台股版 VCP）。這兩組回測都「沒過關」，只是觀察，不是候選。
// 用法：node scripts/record_obs.js 歷史檔.json index.html data data/forward-obs.json [--asof 2026-11-12]
//   歷史檔要有 770 天（--keep 770），因為趨勢條件要 250 天以上的股價。
//
// 規則（Ben 2026-11-13 確認，開始記錄後不再改；改了前面的記錄就作廢）：
//   M：基本門檻合格 ＋ 趨勢條件（股價 > 150、200 日線；150 日線 > 200 日線；150、200 日線都比 21 日前高；
//      50 日線 > 150、200 日線；股價 ≥ 52 週低點 ×1.3；股價 ≥ 52 週高點 ×0.75）＋ 近 250 日漲幅百分位 ≥ 0.70
//   V：M 的條件 ＋ 兩段收縮（前段 t-42～t-23、後段 t-22～t-3，後段 < 前段 且 ≤ 12%）
//      ＋ 近 3 天內放量創 20 日新高（收盤 > 前 20 日最高價、量 > 前 50 日均量 ×1.3）
//      ＋ 近 20 日法人買賣超 ≥ 0、月營收年增率 ≥ 0（沒資料不排除）
//   兩組都依近 250 日漲幅由高到低取前 10 檔；持有中（含還沒買、還沒賣）的同一檔不重複記。
//   買賣：隔天開盤買（漲停或停牌標「沒買到」）；盤中碰到 −8% 停損（開盤跳空用開盤價）；沒碰到持有 30 個交易日收盤賣；
//   手續費 2.8 折、證交稅 0.3%。對照組 = 同一天買、同一個賣出日的基本門檻合格股票平均（同樣手續費）。
// 判斷：M 至少 100 筆已結算、V 至少 30 筆才判斷；用 M 的標準（每筆多賺 ≥ 0.5%、前後兩半都 > 0）。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Z = require('./backtest_zhu.js');
const Mn = require('./backtest_minervini.js');
const Vv = require('./backtest_v.js');
const Gg = require('./backtest_g.js');

const TOP = 10, FD = 0.28, HOLD = Mn.HOLD, STOP = Mn.STOP;
const WARM = 125, WIN = 130, INST_DAYS = 20, INST_MIN = 15, REV_MAX_AGE = 75, MIN_DAYS = Mn.YEAR + 60;
const net = Z.makeNet(FD);
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const round2 = x => Math.round(x * 100) / 100;
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };

// 一筆交易到目前為止的狀態。t = 訊號日序號，T = 資料天數。
// 回傳 { status: wait|unfilled|open|stop|expire, entry, x(賣出日序號), r(小數), sofar(小數), days }
function settle(st, t, T, netFn = net) {
  const avail = T - 1 - t;
  if (avail < 1) return { status: 'wait' };
  const entry = Z.enter(st, t, T);
  if (entry === null) return { status: 'unfilled' };
  const sp = entry * (1 - STOP), lastDay = Math.min(t + HOLD, st.e, T - 1);
  for (let j = t + 1; j <= lastDay; j++) {
    const k = j - st.s;
    if (st.vols[k] > 0 && st.lows[k] <= sp) return { status: 'stop', entry, x: j, r: netFn(entry, Math.min(sp, st.opens[k])) };
    if (j === t + HOLD || (j === lastDay && st.e < T - 1)) return { status: 'expire', entry, x: j, r: netFn(entry, st.closes[k]) };
  }
  const last = Math.min(T - 1, st.e);
  return { status: 'open', entry, sofar: netFn(entry, st.closes[last - st.s]), days: avail };
}
// 依近 250 日漲幅由高到低（同分用代號），取前 n 檔
function rankPicks(cands, n = TOP) {
  return [...cands].sort((p, q) => q.ret250 - p.ret250 || (p.code < q.code ? -1 : p.code > q.code ? 1 : 0)).slice(0, n);
}
// 持有中的代號 → 解除持有的日序號（還沒買、還沒賣用 Infinity）。picks = {date: {items:[{code}]}}
function heldMap(picks, dates, lookup, T, netFn = net) {
  const held = new Map();
  for (const date of Object.keys(picks)) {
    const t = dates.indexOf(date);
    if (t < 0) continue;
    for (const it of picks[date].items) {
      const st = lookup(it.code);
      if (!st) continue;
      const r = settle(st, t, T, netFn);
      if (r.status === 'unfilled') continue;
      const until = (r.status === 'stop' || r.status === 'expire') ? r.x : Infinity;
      if (!held.has(it.code) || until > held.get(it.code)) held.set(it.code, until);
    }
  }
  return held;
}
// 已結算（停損或到期）的成績。items 要有 r 和 base（對照組，百分比）
function summarize(items) {
  const done = items.filter(x => x.status === 'stop' || x.status === 'expire');
  const o = { settled: done.length, open: items.filter(x => x.status === 'open').length, wait: items.filter(x => x.status === 'wait').length, unfilled: items.filter(x => x.status === 'unfilled').length };
  if (!done.length) return o;
  const rs = done.map(x => x.r);
  const ex = done.filter(x => x.base !== null && x.base !== undefined).map(x => x.r - x.base);
  return Object.assign(o, {
    win: round2(rs.filter(v => v > 0).length / rs.length * 100), avg: round2(mean(rs)),
    stopShare: round2(done.filter(x => x.status === 'stop').length / done.length * 100),
    excess: ex.length ? round2(mean(ex)) : null
  });
}

function main() {
  const args = process.argv.slice(2);
  const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--asof'));
  const [histPath, htmlPath, dataDir, outPath] = pos;
  if (!histPath || !htmlPath || !dataDir || !outPath) { console.error('用法：node scripts/record_obs.js 歷史檔.json index.html data 輸出.json [--asof 日期]'); process.exit(2); }
  const ai = args.indexOf('--asof'), asof = ai >= 0 ? args[ai + 1] : null;
  const html = fs.readFileSync(htmlPath, 'utf8');
  const mm = html.match(/\/\/<core>([\s\S]*?)\/\/<\/core>/);
  if (!mm) { console.error('index.html 裡找不到 //<core> 區塊'); process.exit(2); }
  const { runAll, DEFAULT_CFG, DEFAULT_ON } = new Function(mm[1] + ';return {runAll,DEFAULT_CFG,DEFAULT_ON};')();
  const ON = Object.assign({}, DEFAULT_ON, { div: false });
  const H = JSON.parse(fs.readFileSync(histPath, 'utf8'));
  const dates = H.dates, mk = H.market.closes, stocks = H.stocks;
  let T = dates.length;
  if (asof) { const i = dates.indexOf(asof); if (i < 0) { console.error('--asof 的日期不在資料裡：' + asof); process.exit(2); } T = i + 1; }
  if (T < MIN_DAYS) { console.error(`歷史資料只有 ${T} 天，至少要 ${MIN_DAYS} 天（--keep 770）`); process.exit(2); }
  const byCode = new Map(stocks.map(s => [s.code, s]));
  const lookup = c => byCode.get(c);

  // 三大法人、月營收（只有 V 的 B 過濾用到；算法同 backtest_exp.js）
  const hasInst = new Array(dates.length).fill(false), instTot = new Map();
  for (let t = Math.max(0, T - 60); t < T; t++) {
    const p = path.join(dataDir, 'inst', dates[t] + '.json.gz');
    if (!fs.existsSync(p)) continue;
    const js = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
    hasInst[t] = true;
    for (const [code, row] of Object.entries(js.d)) { let a = instTot.get(code); if (!a) instTot.set(code, a = new Float64Array(dates.length)); a[t] = row[3]; }
  }
  const instRatio = (st, t) => {
    let have = 0, sum = 0, vol = 0; const a = instTot.get(st.code);
    for (let j = t - INST_DAYS + 1; j <= t; j++) { if (j < st.s || j > st.e || !hasInst[j]) continue; have++; if (a) sum += a[j]; vol += st.vols[j - st.s] * 1000; }
    return have < INST_MIN || !(vol > 0) ? null : sum / vol;
  };
  const nm11 = ym => { let y = +ym.slice(0, 4), m = +ym.slice(5, 7) + 1; if (m > 12) { m = 1; y++; } return `${y}-${String(m).padStart(2, '0')}-11`; };
  const revBy = new Map();
  for (const src of [readJson(path.join(dataDir, 'revenue_hist.json')), readJson(path.join(dataDir, 'revenue.json'))]) {
    if (!src || !src.months) continue;
    for (const [ym, rows] of Object.entries(src.months)) for (const [code, r] of Object.entries(rows)) {
      const cur = r[0], ly = r[1], seen = r[2] || null;
      if (!(cur > 0) || !(ly > 0)) continue;
      let avail = nm11(ym); if (seen && seen < avail) avail = seen;
      let a = revBy.get(code); if (!a) revBy.set(code, a = []);
      const k = a.findIndex(x => x.ym === ym), rec = { ym, avail, yoy: cur / ly - 1 };
      if (k >= 0) { if (avail < a[k].avail) a[k] = rec; } else a.push(rec);
    }
  }
  for (const a of revBy.values()) a.sort((x, y) => x.avail < y.avail ? -1 : x.avail > y.avail ? 1 : 0);
  const revOf = (code, date) => {
    const a = revBy.get(code); if (!a) return null;
    let best = null; for (const x of a) { if (x.avail <= date) best = x; else break; }
    return !best || (Date.parse(date) - Date.parse(best.avail)) / 864e5 > REV_MAX_AGE ? null : best;
  };

  const evalCache = new Map();
  function evalAt(t) {
    if (evalCache.has(t)) return evalCache.get(t);
    const list = [];
    for (const st of stocks) {
      if (st.t || st.s > t || st.e < t) continue;
      const idx = t - st.s; if (idx < WARM) continue;
      const a = Math.max(0, idx - WIN + 1), b = idx + 1;
      list.push({ code: st.code, name: st.name, full: st, closes: st.closes.slice(a, b), highs: st.highs.slice(a, b), lows: st.lows.slice(a, b), vols: st.vols.slice(a, b) });
    }
    const res = runAll({ market: { closes: mk.slice(0, t + 1) }, stocks: list }, DEFAULT_CFG, ON);
    evalCache.set(t, res);
    return res;
  }

  let prev = readJson(outPath) || {};
  const groups = prev.groups || {};
  for (const g of ['M', 'V']) { groups[g] = groups[g] || { picks: {} }; groups[g].picks = groups[g].picks || {}; }
  const lastDate = dates[T - 1], t0 = T - 1;
  const notes = [];

  // ── 今天的名單（只在還沒記過時才記，記下就不改）
  if (!groups.M.picks[lastDate] || !groups.V.picks[lastDate]) {
    const res = evalAt(t0);
    if (!res.market) notes.push('今天沒有大盤資料，不記錄');
    else {
      const gate = res.rows.filter(x => x.ev.chk.liq && x.ev.chk.price && x.ev.chk.safe);
      const info = gate.map(x => ({ x, code: x.s.code, tp: Mn.template(x.s.full, t0) }));
      const pct = Mn.pctRanks(info.filter(o => o.tp.ret250 !== null).map(o => ({ code: o.code, ret250: o.tp.ret250 })));
      const mSig = info.filter(o => o.tp.pass && pct.get(o.code) >= Mn.RS_MIN);
      let k = 0; for (let j = t0 - INST_DAYS + 1; j <= t0; j++) if (j >= 0 && hasInst[j]) k++;
      const mk1 = (o, extra) => Object.assign({ code: o.code, name: o.x.s.name, ret250: round2(o.tp.ret250 * 100), rs: round2(pct.get(o.code) * 100) }, extra || {});
      if (!groups.M.picks[lastDate]) {
        const held = heldMap(groups.M.picks, dates, lookup, T);
        const cands = mSig.filter(o => !(held.has(o.code) && t0 < held.get(o.code))).map(o => Object.assign({ ret250: o.tp.ret250 }, o));
        const items = rankPicks(cands).map((o, i) => mk1(o, { rank: i + 1 }));
        groups.M.picks[lastDate] = { state: res.market.state, signals: mSig.length, items };
      }
      if (!groups.V.picks[lastDate]) {
        if (k < INST_MIN) notes.push(`法人資料只有 ${k} 天（要 ${INST_MIN} 天），V 今天不記錄`);
        else {
          const held = heldMap(groups.V.picks, dates, lookup, T);
          const cands = [];
          for (const o of mSig) {
            const st = o.x.s.full;
            if (!Vv.contraction(st, t0).pass || !Vv.breakout3(st, t0)) continue;
            const r = revOf(o.code, lastDate), ins = instRatio(st, t0);
            if (!Gg.passB({ rev: r ? r.yoy : null, inst: ins })) continue;
            if (held.has(o.code) && t0 < held.get(o.code)) continue;
            cands.push(Object.assign({ ret250: o.tp.ret250, rev: r ? round2(r.yoy * 100) : null, inst: ins === null ? null : round2(ins * 100) }, o));
          }
          const items = rankPicks(cands).map((o, i) => mk1(o, { rank: i + 1, rev: o.rev, inst: o.inst }));
          groups.V.picks[lastDate] = { state: res.market.state, signals: cands.length, items };
        }
      }
    }
  }

  // ── 用最新價格算每一筆的成績
  const cache = new Map(), out = { groups: {} };
  for (const g of ['M', 'V']) {
    const days = [], all = [];
    for (const date of Object.keys(groups[g].picks).sort()) {
      const t = dates.indexOf(date), rec = groups[g].picks[date];
      if (t < 0 || t >= T) { const old = ((prev.groups || {})[g] || {}).days; const o = old && old.find(d => d.date === date); if (o) { days.push(o); all.push(...o.items); } continue; }
      const gateObj = () => evalAt(t).rows.filter(x => x.ev.chk.liq && x.ev.chk.price && x.ev.chk.safe).map(x => ({ s: { full: x.s.full } }));
      let gobj = null;
      const items = rec.items.map(it => {
        const st = lookup(it.code), r = st ? settle(st, t, T) : { status: 'unfilled' };
        const o = Object.assign({}, it, { status: r.status });
        if (r.entry) { o.entry = round2(r.entry); o.entryDate = dates[t + 1]; }
        if (r.status === 'open') { o.sofar = round2(r.sofar * 100); o.days = r.days; }
        if (r.status === 'stop' || r.status === 'expire') {
          o.exitDate = dates[r.x]; o.r = round2(r.r * 100);
          gobj = gobj || gateObj();
          const b = Z.ctrl(gobj, t, r.x, 'close', T, net, cache);
          o.base = b === null ? null : round2(b * 100);
        }
        return o;
      });
      days.push({ date, state: rec.state, signals: rec.signals, avail: T - 1 - t, items });
      all.push(...items);
    }
    out.groups[g] = { picks: groups[g].picks, days, summary: summarize(all) };
  }
  Object.assign(out, {
    generatedAt: new Date().toISOString(), lastDate, topN: TOP, feeDiscount: FD,
    startDate: [...Object.keys(groups.M.picks), ...Object.keys(groups.V.picks)].sort()[0] || null,
    note: '觀察組：回測沒過關，不是候選。規則見 scripts/record_obs.js 開頭。M 至少 100 筆、V 至少 30 筆已結算才判斷。',
    rules: { M: '趨勢條件＋近 250 日漲幅前 30%，取前 10 檔', V: 'M 的條件＋兩段收縮＋近 3 天放量創 20 日新高＋法人與營收過濾，取前 10 檔', exit: '隔天開盤買，−8% 停損，否則持有 30 個交易日收盤賣，手續費 2.8 折＋證交稅 0.3%' }
  });
  const text = JSON.stringify(out);
  let same = false;
  try { const o = JSON.parse(fs.readFileSync(outPath, 'utf8')); delete o.generatedAt; const c = JSON.parse(text); delete c.generatedAt; same = JSON.stringify(o) === JSON.stringify(c); } catch (e) { }
  if (!same) fs.writeFileSync(outPath, text);
  const f = g => { const s = out.groups[g].summary; const td = groups[g].picks[lastDate]; return `${g}：今天${td ? ' ' + td.items.length + ' 檔（符合 ' + td.signals + '）' : '沒記錄'}，已結算 ${s.settled}、持有中 ${s.open}`; };
  console.log(`觀察組 ${lastDate}：${f('M')}；${f('V')}${notes.length ? '；' + notes.join('；') : ''}；${same ? '沒有變動' : '已寫入'}`);
}

module.exports = { settle, rankPicks, heldMap, summarize, TOP, HOLD, STOP };
if (require.main === module) main();
