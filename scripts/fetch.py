#!/usr/bin/env python3
"""抓證交所（上市）每日資料。只用 Python 內建套件。

資料夾：
  data/raw/YYYY-MM-DD.json.gz   每天的原始行情（沒還原），一天一個檔，只增不改
  data/raw/holidays.json        確認過休市的平日，不用重複去問
  data/exdiv.json               除權息事件（參考價 / 前收盤價 = 還原係數）
  data/latest.json              給網頁用：最近 130 個交易日，已還原除權息

用法：
  python scripts/fetch.py                       每天更新（只補缺的日子）
  python scripts/fetch.py --days 740 --max-new 150
                                                往回補到約 740 個交易日，一次最多送 150 個請求
                                                （還沒補完會回傳 10，可以接著再跑）
  python scripts/fetch.py --export 檔案 --keep 760
                                                不連網，把最近 760 天匯出成回測用的長歷史
"""
import argparse
import datetime as dt
import gzip
import json
import os
import re
import sys
import time
from urllib.request import Request, urlopen

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
DATA = os.path.join(ROOT, "data")
RAW = os.path.join(DATA, "raw")
EXDIV = os.path.join(DATA, "exdiv.json")
HOLI = os.path.join(RAW, "holidays.json")
LATEST = os.path.join(DATA, "latest.json")

URL_DAY = "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date={d}&type=ALLBUT0999&response=json"
URL_EX = "https://www.twse.com.tw/rwd/zh/exRight/TWT49U?startDate={a}&endDate={b}&response=json"
GAP_ADJ = 0.12     # 開盤價和前一天收盤價差超過這個比例，就當作分割或減資來還原
GAP_LOG = []       # 這次還原了哪些事件（代號、日期、倍率）
KEEP_LATEST = 130  # 網頁用的資料留幾個交易日
SLEEP = 5          # 每次請求之間等幾秒（證交所不喜歡抓太快）
TW = dt.timezone(dt.timedelta(hours=8))


def num(x):
    try:
        return float(str(x).replace(",", "").strip())
    except ValueError:
        return None


# ───────────── 抓取與解析 ─────────────
def get_json(url):
    last = None
    for k in range(4):
        try:
            req = Request(url, headers={"User-Agent": "Mozilla/5.0 (benstock daily fetch)", "Accept": "application/json"})
            with urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # 網路錯誤、被擋（回 HTML）
            last = e
            time.sleep(SLEEP * (k + 1))
    raise RuntimeError(f"抓取失敗：{last}")


def parse_day(js):
    """把證交所一天的回覆整理成 (加權指數收盤, {代號: [名稱, 開, 高, 低, 收, 成交股數]})。"""
    index_close = None
    stocks = {}
    for t in js.get("tables") or []:
        fields = t.get("fields") or []
        data = t.get("data") or []
        if "證券代號" in fields and "收盤價" in fields:
            ix = {f: i for i, f in enumerate(fields)}
            for r in data:
                code = str(r[ix["證券代號"]]).strip()
                if not re.fullmatch(r"\d{4}", code):
                    continue
                c = num(r[ix["收盤價"]])
                if c is None or c <= 0:  # 當天沒成交
                    continue
                o, h, l = (num(r[ix[k]]) for k in ("開盤價", "最高價", "最低價"))
                shares = num(r[ix["成交股數"]]) or 0
                stocks[code] = [str(r[ix["證券名稱"]]).strip(), o or c, h or c, l or c, c, shares]
        for r in data:
            if r and str(r[0]).strip() == "發行量加權股價指數" and len(r) > 1:
                index_close = num(r[1])
    if not stocks or index_close is None:
        raise RuntimeError("證交所回覆的格式跟預期不同（找不到股票表或加權指數），請檢查 parse_day")
    return index_close, stocks


def fetch_day(d):
    """抓某一天。休市日回傳 None，被擋或格式錯誤會丟出錯誤。"""
    url = URL_DAY.format(d=d.strftime("%Y%m%d"))
    stat = ""
    for k in range(3):
        js = get_json(url)
        stat = str(js.get("stat", ""))
        if stat == "OK":
            return parse_day(js)
        if "沒有符合" in stat:
            return None
        time.sleep(SLEEP * (k + 2))
    raise RuntimeError("證交所回覆：" + stat)


def parse_exdiv(js):
    """除權息表 → {日期: {代號: 還原係數}}。係數 = 除權息參考價 / 除權息前收盤價（小於 1）。"""
    events = {}
    fields = js.get("fields") or []
    ix = {f: i for i, f in enumerate(fields)}
    i_prev, i_ref = ix.get("除權息前收盤價"), ix.get("除權息參考價")
    if i_prev is None or i_ref is None:
        raise RuntimeError("除權息表的欄位跟預期不同，請檢查 parse_exdiv")
    for r in js.get("data") or []:
        m = re.match(r"(\d+)年(\d+)月(\d+)日", str(r[0]))
        if not m:
            continue
        date = dt.date(int(m.group(1)) + 1911, int(m.group(2)), int(m.group(3))).isoformat()
        code = str(r[1]).strip()
        if not re.fullmatch(r"\d{4}", code):
            continue
        prev, ref = num(r[i_prev]), num(r[i_ref])
        if not prev or not ref:
            continue
        f = ref / prev
        if 0.2 < f < 1.0001:
            events.setdefault(date, {})[code] = round(f, 6)
    return events


def fetch_exdiv_range(a, b):
    js = get_json(URL_EX.format(a=a.strftime("%Y%m%d"), b=b.strftime("%Y%m%d")))
    stat = str(js.get("stat", ""))
    if stat == "OK":
        return parse_exdiv(js)
    if "沒有符合" in stat:
        return {}
    raise RuntimeError("除權息查詢回覆：" + stat)


# ───────────── 檔案存取 ─────────────
def raw_dates():
    if not os.path.isdir(RAW):
        return []
    return sorted(f[:-8] for f in os.listdir(RAW) if re.fullmatch(r"\d{4}-\d{2}-\d{2}\.json\.gz", f))


def save_raw(date_str, idx, stocks):
    os.makedirs(RAW, exist_ok=True)
    with gzip.open(os.path.join(RAW, date_str + ".json.gz"), "wt", encoding="utf-8") as f:
        json.dump({"date": date_str, "index": idx, "stocks": stocks}, f, ensure_ascii=False, separators=(",", ":"))


def load_raw(date_str):
    with gzip.open(os.path.join(RAW, date_str + ".json.gz"), "rt", encoding="utf-8") as f:
        j = json.load(f)
    return j["date"], j["index"], j["stocks"]


def load_holidays():
    try:
        with open(HOLI, encoding="utf-8") as f:
            return set(json.load(f))
    except (FileNotFoundError, json.JSONDecodeError):
        return set()


def save_holidays(s):
    os.makedirs(RAW, exist_ok=True)
    with open(HOLI, "w", encoding="utf-8") as f:
        json.dump(sorted(s), f)


def load_exdiv():
    try:
        with open(EXDIV, encoding="utf-8") as f:
            j = json.load(f)
        return {"months": list(j.get("months", [])), "events": j.get("events", {})}
    except (FileNotFoundError, json.JSONDecodeError):
        return {"months": [], "events": {}}


def save_exdiv(ex):
    os.makedirs(DATA, exist_ok=True)
    with open(EXDIV, "w", encoding="utf-8") as f:
        json.dump({"months": sorted(set(ex["months"])), "events": ex["events"]}, f, ensure_ascii=False, separators=(",", ":"))


# ───────────── 補抓 ─────────────
def ensure_raw(target_days, max_new, today):
    """從今天往回，確保最近 target_days 個交易日都有原始檔。回傳 True 表示已補齊。"""
    existing = set(raw_dates())
    holi = load_holidays()
    count = new = walked = 0
    d = today
    limit = target_days * 2 + 60
    while count < target_days and walked < limit:
        if d.weekday() < 5:
            walked += 1
            ds = d.isoformat()
            if ds in existing:
                count += 1
            elif ds in holi:
                pass
            else:
                if new >= max_new:
                    return False
                r = fetch_day(d)
                new += 1
                if r:
                    save_raw(ds, r[0], r[1])
                    existing.add(ds)
                    count += 1
                    print(f"  {ds} OK（共 {count} 天）", flush=True)
                elif d < today:  # 今天沒資料可能只是還沒公布，不算休市
                    holi.add(ds)
                    save_holidays(holi)
                time.sleep(SLEEP)
        d -= dt.timedelta(days=1)
    return True


def update_exdiv(first, last, today):
    """補齊 first ~ last 之間每個月的除權息資料。回傳 (事件, 是否都補到了)。"""
    ex = load_exdiv()
    done = set(ex["months"])
    ok = True
    y, m = first.year, first.month
    while (y, m) <= (last.year, last.month):
        key = f"{y:04d}-{m:02d}"
        start = dt.date(y, m, 1)
        end = (dt.date(y + (m == 12), m % 12 + 1, 1) - dt.timedelta(days=1))
        is_past = end < today
        if not (key in done and is_past):
            try:
                ev = fetch_exdiv_range(start, min(end, today))
                for k in [k for k in ex["events"] if k.startswith(key)]:
                    del ex["events"][k]
                ex["events"].update(ev)
                if is_past:
                    done.add(key)
                ex["months"] = sorted(done)
                save_exdiv(ex)
                print(f"  除權息 {key}：{sum(len(v) for v in ev.values())} 筆", flush=True)
                time.sleep(SLEEP)
            except RuntimeError as e:
                print(f"  警告：{key} 除權息資料沒抓到（{e}），這個月不還原")
                ok = False
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return ex["events"], ok


# ───────────── 組成時間序列 ─────────────
def build_series(days, events):
    """days 由舊到新：[(日期, 指數, {代號: [名稱, 開, 高, 低, 收, 股數]})]。
    回傳 {代號: {name, s, e, o, h, l, c, v}}，價格已還原除權息，s/e 是這檔股票出現的第一天/最後一天（在 days 裡的位置）。
    中間停牌的日子用前一天收盤補，量是 0。"""
    st = {}
    for i, (date, _idx, day) in enumerate(days):
        for code, f in events.get(date, {}).items():
            s = st.get(code)
            if s:
                for k in ("o", "h", "l", "c"):
                    s[k] = [x * f for x in s[k]]
        for code, row in day.items():
            name, o, h, l, c, sh = row
            s = st.get(code)
            if s is None:
                s = st[code] = {"name": name, "s": i, "e": i - 1, "o": [], "h": [], "l": [], "c": [], "v": []}
            while s["e"] < i - 1:
                p = s["c"][-1]
                for k in ("o", "h", "l", "c"):
                    s[k].append(p)
                s["v"].append(0)
                s["e"] += 1
            # 股票分割、減資等：開盤價跟前一天收盤價差超過 12%（正常漲跌幅上限 10%），
            # 這不是真的漲跌，把之前的價格換算過去，價格才接得起來。除權息已經在上面處理過了。
            if s["c"] and s["c"][-1] > 0 and o > 0 and sh > 0 and abs(o / s["c"][-1] - 1) > GAP_ADJ:
                g = o / s["c"][-1]
                for k in ("o", "h", "l", "c"):
                    s[k] = [x * g for x in s[k]]
                GAP_LOG.append((code, date, round(g, 3)))
            s["o"].append(o); s["h"].append(h); s["l"].append(l); s["c"].append(c)
            s["v"].append(int(round(sh / 1000)))  # 股 → 張
            s["e"] = i
            s["name"] = name
    return st


def r3(a):
    return [round(x, 3) for x in a]


def to_latest(days, st, adjusted):
    n = len(days)
    stocks = []
    for code in sorted(st):
        s = st[code]
        if s["e"] != n - 1:  # 最新一天沒成交的不收
            continue
        stocks.append({"code": code, "name": s["name"], "closes": r3(s["c"]), "highs": r3(s["h"]),
                       "lows": r3(s["l"]), "vols": s["v"]})
    return {"asOf": days[-1][0], "demo": False, "adjusted": adjusted, "dates": [d[0] for d in days],
            "market": {"closes": [round(d[1], 2) for d in days]}, "stocks": stocks}


def to_export(days, st, adjusted):
    stocks = []
    for code in sorted(st):
        s = st[code]
        stocks.append({"code": code, "name": s["name"], "s": s["s"], "e": s["e"], "opens": r3(s["o"]),
                       "highs": r3(s["h"]), "lows": r3(s["l"]), "closes": r3(s["c"]), "vols": s["v"]})
    return {"adjusted": adjusted, "dates": [d[0] for d in days],
            "market": {"closes": [round(d[1], 2) for d in days]}, "stocks": stocks}


def write_if_changed(path, obj):
    """內容沒變就不重寫（只有更新時間不同不算變），避免每天產生沒意義的 commit。"""
    try:
        with open(path, encoding="utf-8") as f:
            old = json.load(f)
        if {k: v for k, v in old.items() if k != "updatedAt"} == obj:
            return False
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    out = dict(obj)
    out["updatedAt"] = dt.datetime.now(TW).isoformat(timespec="seconds")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    return True


# ───────────── 主程式 ─────────────
def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=KEEP_LATEST, help="至少要有最近幾個交易日的原始檔")
    ap.add_argument("--max-new", type=int, default=300, help="這次最多送幾個請求")
    ap.add_argument("--export", help="不連網，把長歷史匯出到這個檔案")
    ap.add_argument("--keep", type=int, default=760, help="匯出時保留最近幾個交易日")
    a = ap.parse_args(argv)
    today = dt.datetime.now(TW).date()

    if a.export:
        dates = raw_dates()[-a.keep:]
        if not dates:
            raise RuntimeError("data/raw 裡沒有資料")
        ex = load_exdiv()
        need = {f"{d[:4]}-{d[5:7]}" for d in dates}
        adjusted = need <= set(ex["months"]) | {today.strftime("%Y-%m")}
        days = [load_raw(d) for d in dates]
        obj = to_export(days, build_series(days, ex["events"]), adjusted)
        print(f"分割或減資還原：{len(GAP_LOG)} 件")
        with open(a.export, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        print(f"匯出 {len(obj['dates'])} 天、{len(obj['stocks'])} 檔（含已下市），已還原除權息：{adjusted}")
        return 0

    complete = ensure_raw(a.days, a.max_new, today)
    dates = raw_dates()
    if not dates:
        print("沒有任何資料（證交所還沒公布，或被擋）")
        return 0 if complete else 10
    events, adjusted = update_exdiv(dt.date.fromisoformat(dates[0]), dt.date.fromisoformat(dates[-1]), today)
    days = [load_raw(d) for d in dates[-KEEP_LATEST:]]
    latest = to_latest(days, build_series(days, events), adjusted)
    print(f"分割或減資還原：{len(GAP_LOG)} 件")
    if len(latest["stocks"]) < 500:
        raise RuntimeError(f"只有 {len(latest['stocks'])} 檔股票，太少了，不寫入")
    changed = write_if_changed(LATEST, latest)
    print(f"{'更新' if changed else '沒有變動'}：{latest['asOf']}，{len(latest['stocks'])} 檔，"
          f"{len(latest['dates'])} 個交易日，原始檔共 {len(dates)} 天，已還原除權息：{adjusted}")
    return 0 if complete else 10


if __name__ == "__main__":
    sys.exit(main())
