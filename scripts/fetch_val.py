#!/usr/bin/env python3
"""抓「本益比／淨值比／殖利率」、「融資餘額」和「產業分類」，給實驗回測用（C～F 組）。
原本的選股、網頁、每日更新都不會讀這些檔案，也不會呼叫這支程式。

資料夾：
  data/val/YYYY-MM-DD.json.gz      每天每檔的 [本益比, 股價淨值比, 殖利率%]，沒有的存 null，一天一個檔，只增不改
                                   數字是證交所用「當天已公布的財報」算的，所以回測不會偷看未來
  data/margin/YYYY-MM-DD.json.gz   每天每檔的 [融資前日餘額, 融資今日餘額]（單位：張）
  data/industry.json               產業分類 {"d": {代號: 產業別代碼}}。只有「現在」的分類，沒有歷史版本（產業很少換，影響不大）

「那天沒有資料」的日子（隔了一個星期以上還是沒有）會存一個空檔（"empty": true），免得每次都重抓。

用法：
  python scripts/fetch_val.py --days 750 --max-new 200
        往回補最近 750 個交易日，一次最多送 200 個請求（本益比和融資輪流抓，新的先抓）
        還沒補完會回傳 10，可以接著再跑
  python scripts/fetch_val.py --no-margin           只抓本益比（--no-val 只抓融資、--no-industry 不抓產業）

交易日以 data/raw 裡已經有的股價檔為準，所以要先跑 fetch.py。
"""
import argparse
import datetime as dt
import gzip
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch import CODE_OK, DATA, SLEEP, TW, get_json, num, raw_dates  # noqa: E402

VAL = os.path.join(DATA, "val")
MARGIN = os.path.join(DATA, "margin")
INDUSTRY = os.path.join(DATA, "industry.json")
URL_VAL = "https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?date={d}&selectType=ALL&response=json"
URL_MARGIN = "https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date={d}&selectType=STOCK&response=json"
URL_IND = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L"
VER = 1
EMPTY_AFTER_DAYS = 7      # 超過幾天還是「沒有符合的資料」，就當那天真的沒有資料
MIN_ROWS = 300            # 一天少於這個檔數，就當格式改了或被擋


# ───────────── 解析 ─────────────
def pick(ix, *names):
    """依欄位名稱找位置：先找完全一樣的，再找開頭一樣的。"""
    for n in names:
        if n in ix:
            return ix[n]
    for n in names:
        for f, i in ix.items():
            if f.startswith(n):
                return i
    return None


def find_table(js, need):
    """證交所有時把表放在最上層（fields/data），有時放在 tables 裡。找出欄位都齊、資料最多的那張。
    回傳 (欄位名稱清單, 資料列) 或 None。"""
    cands = js.get("tables") if isinstance(js.get("tables"), list) else None
    best = None
    for t in (cands or [js]):
        if not isinstance(t, dict):
            continue
        fields = [str(f).strip() for f in (t.get("fields") or [])]
        if all(any(f == n or f.startswith(n) for f in fields) for n in need):
            data = t.get("data") or []
            if best is None or len(data) > len(best[1]):
                best = (fields, data)
    return best


def parse_val(js):
    """本益比日報 → {代號: [本益比, 淨值比, 殖利率%]}。「-」（虧損、沒資料）存 None；本益比或淨值比 ≤ 0 也當沒資料。"""
    tb = find_table(js, ["證券代號", "本益比", "股價淨值比"])
    if tb is None:
        allf = [str(f) for t in (js.get("tables") or [js]) if isinstance(t, dict) for f in (t.get("fields") or [])]
        raise RuntimeError("本益比表的欄位跟預期不同，請檢查 parse_val：" + "、".join(allf))
    fields, data = tb
    ix = {f: i for i, f in enumerate(fields)}
    i_code, i_pe, i_pb, i_y = pick(ix, "證券代號"), pick(ix, "本益比"), pick(ix, "股價淨值比"), pick(ix, "殖利率")
    need = max(x for x in (i_code, i_pe, i_pb, i_y) if x is not None)
    out = {}
    for r in data:
        if len(r) <= need:
            continue
        code = str(r[i_code]).strip()
        if not CODE_OK.fullmatch(code):
            continue
        pe, pb = num(r[i_pe]), num(r[i_pb])
        y = num(r[i_y]) if i_y is not None else None
        out[code] = [pe if pe is not None and pe > 0 else None,
                     pb if pb is not None and pb > 0 else None,
                     y if y is not None and y >= 0 else None]
    if len(out) < MIN_ROWS:
        raise RuntimeError(f"本益比只有 {len(out)} 檔，太少了，可能格式改了")
    return out


def parse_margin(js):
    """融資融券彙總 → {代號: [融資前日餘額, 融資今日餘額]}（張）。
    表裡「前日餘額」「今日餘額」各出現兩次：第一次是融資、第二次是融券，這裡只取融資。第一列的「合計」不是股票，會被略過。"""
    tb = find_table(js, ["今日餘額", "前日餘額"])
    code_name = None
    if tb is not None:
        for n in ("代號", "證券代號"):
            if any(f == n for f in tb[0]):
                code_name = n
    if tb is None or code_name is None:
        allf = [str(f) for t in (js.get("tables") or [js]) if isinstance(t, dict) for f in (t.get("fields") or [])]
        raise RuntimeError("融資表的欄位跟預期不同，請檢查 parse_margin：" + "、".join(allf))
    fields, data = tb
    i_code = fields.index(code_name)
    prevs = [i for i, f in enumerate(fields) if f == "前日餘額"]
    todays = [i for i, f in enumerate(fields) if f == "今日餘額"]
    if len(prevs) < 1 or len(todays) < 1:
        raise RuntimeError("融資表找不到前日餘額／今日餘額，請檢查 parse_margin：" + "、".join(fields))
    ip, it = prevs[0], todays[0]          # 第一組 = 融資
    if len(prevs) >= 2 and len(todays) >= 2 and not (ip < it < prevs[1] < todays[1]):
        raise RuntimeError("融資表的欄位順序跟預期不同，請檢查 parse_margin：" + "、".join(fields))
    out = {}
    for r in data:
        if len(r) <= max(i_code, ip, it):
            continue
        code = str(r[i_code]).strip()
        if not CODE_OK.fullmatch(code):
            continue
        p, t = num(r[ip]), num(r[it])
        if t is None:
            continue
        out[code] = [int(p) if p is not None else None, int(t)]
    if len(out) < MIN_ROWS:
        raise RuntimeError(f"融資只有 {len(out)} 檔，太少了，可能格式改了")
    return out


def parse_industry(rows):
    """上市公司基本資料 → {代號: 產業別代碼}。"""
    out = {}
    for r in rows or []:
        code = str(r.get("公司代號", "")).strip()
        ind = str(r.get("產業別", "")).strip()
        if CODE_OK.fullmatch(code) and ind:
            out[code] = ind
    return out


# ───────────── 存取 ─────────────
KINDS = {
    "val": dict(dir=lambda: VAL, url=URL_VAL, parse=parse_val, cols=["本益比", "淨值比", "殖利率%"], label="本益比"),
    "margin": dict(dir=lambda: MARGIN, url=URL_MARGIN, parse=parse_margin, cols=["融資前日餘額", "融資今日餘額"], label="融資"),
}


def path_of(kind, date):
    return os.path.join(KINDS[kind]["dir"](), date + ".json.gz")


def have(kind, date):
    return os.path.exists(path_of(kind, date))


def save(kind, date, rows, empty=False):
    os.makedirs(KINDS[kind]["dir"](), exist_ok=True)
    obj = {"v": VER, "date": date, "cols": KINDS[kind]["cols"], "d": rows}
    if empty:
        obj["empty"] = True
    with gzip.open(path_of(kind, date), "wt", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def fetch_day(kind, date):
    """抓某一天。還沒公布（或那天沒有資料）回傳 None；被擋、格式錯誤、回了別天的資料都會丟出錯誤。"""
    want = date.replace("-", "")
    js = get_json(KINDS[kind]["url"].format(d=want))
    if not isinstance(js, dict):
        raise RuntimeError(f"{KINDS[kind]['label']}的回覆格式跟預期不同")
    stat = str(js.get("stat", ""))
    if stat != "OK":
        if "沒有符合" in stat:
            return None
        raise RuntimeError("證交所回覆：" + stat)
    got = str(js.get("date", "")).strip()
    if re.fullmatch(r"\d{8}", got) and got != want:
        raise RuntimeError(f"{KINDS[kind]['label']}：要的是 {want}，證交所回的是 {got}")
    return KINDS[kind]["parse"](js)


def update(days, max_new, kinds, today):
    """補 data/raw 最近 days 個交易日裡缺的資料，新的先抓、各種資料輪流抓。回傳 (是否補完, 新增幾天)。"""
    todo = []
    for d in reversed(raw_dates()[-days:]):
        for k in kinds:
            if not have(k, d):
                todo.append((k, d))
    limit = (dt.date.fromisoformat(today) - dt.timedelta(days=EMPTY_AFTER_DAYS)).isoformat()
    sent = added = nodata = 0
    for k, d in todo:
        if sent >= max_new:
            print(f"這次先抓到這裡，還差 {len(todo) - sent} 筆")
            _sanity(sent, added, nodata)
            return False, added
        if sent:
            time.sleep(SLEEP)
        sent += 1
        rows = fetch_day(k, d)
        label = KINDS[k]["label"]
        if rows is None:
            nodata += 1
            if d <= limit:
                save(k, d, {}, empty=True)
                print(f"{d}：{label}沒有資料（超過 {EMPTY_AFTER_DAYS} 天了，存成空檔，不再重抓）")
            else:
                print(f"{d}：{label}還沒公布（或那天沒有資料），下次再抓")
            continue
        save(k, d, rows)
        added += 1
        print(f"{d}：{label} {len(rows)} 檔")
    _sanity(sent, added, nodata)
    return True, added


def _sanity(sent, added, nodata):
    """一口氣抓了好幾天卻一天都沒抓到，多半是被擋或格式改了，要讓人看到，不要默默存一堆空檔。"""
    if sent >= 5 and added == 0 and nodata == sent:
        raise RuntimeError(f"送了 {sent} 個請求，全部都說沒有資料，請檢查證交所網址或格式有沒有改")


def update_industry(today):
    rows = get_json(URL_IND)
    if not isinstance(rows, list):
        raise RuntimeError("產業分類回覆的格式跟預期不同")
    new = parse_industry(rows)
    if len(new) < 500:
        raise RuntimeError(f"產業分類只讀到 {len(new)} 家，可能欄位改了" + (("：" + "、".join(rows[0].keys())) if rows else ""))
    old = {}
    try:
        with open(INDUSTRY, encoding="utf-8") as f:
            old = json.load(f).get("d", {})
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    merged = dict(old)
    merged.update(new)      # 新的蓋過舊的；已下市的舊代號保留
    with open(INDUSTRY, "w", encoding="utf-8") as f:
        json.dump({"asOf": today, "note": "只有抓取當時的產業分類，沒有歷史版本", "d": dict(sorted(merged.items()))},
                  f, ensure_ascii=False, separators=(",", ":"))
    print(f"產業分類：{len(new)} 家（累計 {len(merged)} 檔）")


# ───────────── 主程式 ─────────────
def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=5, help="補最近幾個交易日")
    ap.add_argument("--max-new", type=int, default=20, help="這次最多送幾個請求")
    ap.add_argument("--no-val", action="store_true", help="不抓本益比")
    ap.add_argument("--no-margin", action="store_true", help="不抓融資")
    ap.add_argument("--no-industry", action="store_true", help="不抓產業分類")
    a = ap.parse_args(argv)
    today = dt.datetime.now(TW).date().isoformat()
    kinds = [k for k, off in (("val", a.no_val), ("margin", a.no_margin)) if not off]

    err, complete = None, True
    if kinds:
        try:
            complete, _ = update(a.days, a.max_new, kinds, today)
        except Exception as e:      # 本益比或融資抓失敗，產業分類照樣抓
            err, complete = e, True
            print(f"抓取失敗：{e}")
    if not a.no_industry:
        try:
            update_industry(today)
        except Exception as e:
            err = err or e
            print(f"產業分類抓取失敗：{e}")
    if err:
        raise err
    return 0 if complete else 10


if __name__ == "__main__":
    sys.exit(main())
