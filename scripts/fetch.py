#!/usr/bin/env python3
"""每天收盤後抓證交所（上市）資料，更新 data/latest.json。只用 Python 內建套件。

- 第一次（或資料落後太久）：往回補抓約 100 個交易日，大約要 10 分鐘。
- 平常：只補抓還沒有的那幾天（通常 1 天）。
- 只收 4 位數字代號的一般股票，ETF、權證、特別股不收。
"""
import datetime as dt
import json
import os
import re
import sys
import time
from urllib.request import Request, urlopen

URL = "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date={d}&type=ALLBUT0999&response=json"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "latest.json")
MAX_DAYS = 100       # 最多留幾個交易日
BACKFILL_DAYS = 100  # 第一次補抓幾個交易日
MAX_GAP = 12         # 資料落後超過幾天，就整個重抓
SLEEP = 5            # 每次請求之間等幾秒（證交所不喜歡抓太快）
TW = dt.timezone(dt.timedelta(hours=8))


def num(x):
    try:
        return float(str(x).replace(",", "").strip())
    except ValueError:
        return None


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
    url = URL.format(d=d.strftime("%Y%m%d"))
    last = None
    for k in range(4):
        try:
            req = Request(url, headers={"User-Agent": "Mozilla/5.0 (benstock daily fetch)", "Accept": "application/json"})
            with urlopen(req, timeout=30) as r:
                js = json.loads(r.read().decode("utf-8"))
            stat = str(js.get("stat", ""))
            if stat != "OK":
                if "沒有符合" in stat:
                    return None
                raise RuntimeError("證交所回覆：" + stat)
            return parse_day(js)
        except Exception as e:  # 網路錯誤、被擋（回 HTML）、格式錯誤
            last = e
            time.sleep(SLEEP * (k + 1))
    raise RuntimeError(f"{d} 抓取失敗：{last}")


def weekdays_between(start, end):
    d = start
    while d <= end:
        if d.weekday() < 5:
            yield d
        d += dt.timedelta(days=1)


def update(old, new_days):
    """把新抓到的幾天接到舊資料後面。new_days 要照日期由舊到新：[(日期字串, 指數, 股票字典)]。"""
    dates = list(old["dates"]) if old else []
    market = list(old["market"]["closes"]) if old else []
    state = {}
    if old:
        for s in old["stocks"]:
            state[s["code"]] = {k: list(s[k]) for k in ("closes", "highs", "lows", "vols")}
            state[s["code"]]["name"] = s["name"]
    present_last = set()
    for date_str, idx, day in new_days:
        dates.append(date_str)
        market.append(round(idx, 2))
        for code, st in state.items():
            if code not in day:  # 這天沒成交：價格沿用前一天，量是 0
                prev = st["closes"][-1]
                st["closes"].append(prev); st["highs"].append(prev); st["lows"].append(prev); st["vols"].append(0)
        for code, (name, o, h, l, c, shares) in day.items():
            st = state.setdefault(code, {"name": name, "closes": [], "highs": [], "lows": [], "vols": []})
            st["name"] = name
            st["closes"].append(round(c, 2)); st["highs"].append(round(h, 2)); st["lows"].append(round(l, 2))
            st["vols"].append(int(round(shares / 1000)))  # 股 → 張
        present_last = set(day)
    stocks = []
    for code in sorted(state):
        if code not in present_last:  # 最新一天沒成交的（停牌、下市）不收
            continue
        st = state[code]
        stocks.append({
            "code": code, "name": st["name"],
            "closes": st["closes"][-MAX_DAYS:], "highs": st["highs"][-MAX_DAYS:],
            "lows": st["lows"][-MAX_DAYS:], "vols": st["vols"][-MAX_DAYS:],
        })
    dates = dates[-MAX_DAYS:]
    return {
        "asOf": dates[-1], "demo": False,
        "updatedAt": dt.datetime.now(TW).isoformat(timespec="seconds"),
        "dates": dates, "market": {"closes": market[-MAX_DAYS:]}, "stocks": stocks,
    }


def main():
    today = dt.datetime.now(TW).date()
    old = None
    try:
        with open(OUT, encoding="utf-8") as f:
            old = json.load(f)
        last = dt.date.fromisoformat(old["dates"][-1])
        if (today - last).days > MAX_GAP:
            print("資料落後太久，整個重抓")
            old = None
    except (FileNotFoundError, json.JSONDecodeError, KeyError, IndexError):
        old = None

    got = []  # (date, index, stocks)，由新到舊
    if old is None:
        print(f"第一次抓取：往回補 {BACKFILL_DAYS} 個交易日，約需 10 分鐘")
        d = today
        while len(got) < BACKFILL_DAYS and (today - d).days < 200:
            if d.weekday() < 5:
                r = fetch_day(d)
                if r:
                    got.append((d.isoformat(), r[0], r[1]))
                    print(f"  {d} OK（{len(got)}/{BACKFILL_DAYS}）", flush=True)
                time.sleep(SLEEP)
            d -= dt.timedelta(days=1)
        got.reverse()
    else:
        last = dt.date.fromisoformat(old["dates"][-1])
        for d in weekdays_between(last + dt.timedelta(days=1), today):
            r = fetch_day(d)
            if r:
                got.append((d.isoformat(), r[0], r[1]))
                print(f"  {d} OK", flush=True)
            time.sleep(SLEEP)

    if not got:
        print("沒有新資料（今天休市，或證交所還沒公布）")
        return 0
    result = update(old, got)
    if len(result["stocks"]) < 500:
        raise RuntimeError(f"只有 {len(result['stocks'])} 檔股票，太少了，不寫入")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))
    print(f"完成：{result['asOf']}，{len(result['stocks'])} 檔，{len(result['dates'])} 個交易日")
    return 0


if __name__ == "__main__":
    sys.exit(main())
