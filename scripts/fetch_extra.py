#!/usr/bin/env python3
"""抓「三大法人買賣超」和「月營收」，給實驗版用。原本的選股和網頁不會讀這些檔案。

資料夾：
  data/inst/YYYY-MM-DD.json.gz   每天的三大法人買賣超（單位：股），一天一個檔，只增不改
                                 每檔：[外資, 投信, 自營商, 三大法人合計]
  data/revenue.json              月營收：{"months": {"2026-09": {代號: [當月營收, 去年同月營收, 第一次看到的日期]}}}
                                 「第一次看到的日期」用來避免偷看未來：那天以前不能用這筆營收

用法：
  python scripts/fetch_extra.py                     每天更新：補最近 5 個交易日缺的法人資料，再更新月營收
  python scripts/fetch_extra.py --days 750 --max-new 150
                                                    往回補法人資料（回測用），一次最多送 150 個請求
                                                    （還沒補完會回傳 10，可以接著再跑）
  python scripts/fetch_extra.py --no-revenue        只抓法人
  python scripts/fetch_extra.py --no-inst --revenue-history 40
                                                    從公開資訊觀測站補最近 40 個月的月營收（回測用），存到 data/revenue_hist.json
                                                    回測一律當作「次月 11 日」才公布，避免偷看未來

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
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch import CODE_OK, DATA, SLEEP, TW, get_json, num, raw_dates  # noqa: E402

INST = os.path.join(DATA, "inst")
REVENUE = os.path.join(DATA, "revenue.json")
REV_HIST = os.path.join(DATA, "revenue_hist.json")
URL_MOPS = "https://mopsov.twse.com.tw/nas/t21/sii/t21sc03_{y}_{m}_{k}.html"   # k=0 國內公司、k=1 外國（KY）公司
URL_INST = "https://www.twse.com.tw/rwd/zh/fund/T86?date={d}&selectType=ALLBUT0999&response=json"
URL_REV = "https://openapi.twse.com.tw/v1/opendata/t187ap05_L"
INST_VER = 1


# ───────────── 三大法人 ─────────────
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


def parse_inst(js):
    """證交所三大法人日報 → {代號: [外資, 投信, 自營商, 合計]}（股）。"""
    fields = [str(f).strip() for f in (js.get("fields") or [])]
    ix = {f: i for i, f in enumerate(fields)}
    i_code = pick(ix, "證券代號")
    i_for = pick(ix, "外陸資買賣超股數(不含外資自營商)", "外陸資買賣超股數", "外資買賣超股數")
    i_fd = pick(ix, "外資自營商買賣超股數")
    i_tr = pick(ix, "投信買賣超股數")
    i_de = ix.get("自營商買賣超股數")
    i_tot = pick(ix, "三大法人買賣超股數")
    if None in (i_code, i_for, i_tr, i_tot):
        raise RuntimeError("三大法人表的欄位跟預期不同，請檢查 parse_inst：" + "、".join(fields))
    out = {}
    for r in js.get("data") or []:
        code = str(r[i_code]).strip()
        if not CODE_OK.fullmatch(code):
            continue
        f = (num(r[i_for]) or 0) + ((num(r[i_fd]) or 0) if i_fd is not None else 0)
        t = num(r[i_tr]) or 0
        tot = num(r[i_tot]) or 0
        d = num(r[i_de]) if i_de is not None else None
        if d is None:
            d = tot - f - t
        out[code] = [int(f), int(t), int(d), int(tot)]
    if len(out) < 300:
        raise RuntimeError(f"三大法人只有 {len(out)} 檔，太少了，可能格式改了")
    return out


def inst_path(date):
    return os.path.join(INST, date + ".json.gz")


def have_inst(date):
    return os.path.exists(inst_path(date))


def save_inst(date, rows):
    os.makedirs(INST, exist_ok=True)
    obj = {"v": INST_VER, "date": date, "unit": "股", "cols": ["外資", "投信", "自營商", "合計"], "d": rows}
    with gzip.open(inst_path(date), "wt", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def fetch_inst(date):
    """抓某一天。還沒公布回傳 None，被擋或格式錯誤會丟出錯誤。"""
    js = get_json(URL_INST.format(d=date.replace("-", "")))
    stat = str(js.get("stat", ""))
    if stat == "OK":
        return parse_inst(js)
    if "沒有符合" in stat:
        return None
    raise RuntimeError("證交所回覆：" + stat)


def update_inst(days, max_new):
    """補 data/raw 最近 days 個交易日裡缺的法人資料。回傳 (是否補完, 新增幾天)。"""
    want = [d for d in raw_dates()[-days:] if not have_inst(d)]
    want.reverse()          # 新的先抓：每天更新時最重要的是今天
    sent = added = 0
    for d in want:
        if sent >= max_new:
            print(f"這次先抓到這裡，還差 {len(want) - sent} 天")
            return False, added
        if sent:
            time.sleep(SLEEP)
        sent += 1
        rows = fetch_inst(d)
        if rows is None:
            print(f"{d}：三大法人還沒公布（或那天沒有資料），下次再抓")
            continue
        save_inst(d, rows)
        added += 1
        print(f"{d}：三大法人 {len(rows)} 檔")
    return True, added


# ───────────── 月營收 ─────────────
def ym_of(s):
    """資料年月 '11509'（民國）→ '2026-09'。"""
    s = re.sub(r"\D", "", str(s))
    if len(s) < 5:
        return None
    y, m = int(s[:-2]) + 1911, int(s[-2:])
    if not 1 <= m <= 12:
        return None
    return f"{y}-{m:02d}"


def parse_revenue(rows):
    """openapi 月營收 → {'2026-09': {代號: [當月營收, 去年同月營收]}}（千元）。"""
    out = {}
    for r in rows or []:
        code = str(r.get("公司代號", "")).strip()
        ym = ym_of(r.get("資料年月"))
        if not ym or not re.fullmatch(r"\d{4}", code):
            continue
        cur = num(r.get("營業收入-當月營收"))
        ly = num(r.get("營業收入-去年當月營收"))
        if cur is None:
            continue
        out.setdefault(ym, {})[code] = [cur, ly]
    return out


def merge_revenue(old, new, today):
    """把新抓到的併進去。已經有的不改「第一次看到的日期」；數字有更正就改數字。回傳新增筆數。"""
    months = old.setdefault("months", {})
    added = 0
    for ym, rows in new.items():
        m = months.setdefault(ym, {})
        for code, (cur, ly) in rows.items():
            if code in m:
                m[code][0], m[code][1] = cur, ly
            else:
                m[code] = [cur, ly, today]
                added += 1
    return added


def update_revenue(today):
    try:
        with open(REVENUE, encoding="utf-8") as f:
            old = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        old = {"note": "月營收（千元）：[當月營收, 去年同月營收, 第一次看到的日期]。只能在第一次看到的日期當天收盤後才算已公布。",
               "months": {}}
    js = get_json(URL_REV)
    if not isinstance(js, list):
        raise RuntimeError("月營收回覆的格式跟預期不同")
    new = parse_revenue(js)
    if js and not new:
        raise RuntimeError("月營收有資料但一筆都讀不出來，可能欄位改了：" + "、".join(js[0].keys()))
    added = merge_revenue(old, new, today)
    old["months"] = dict(sorted(old["months"].items()))
    with open(REVENUE, "w", encoding="utf-8") as f:
        json.dump(old, f, ensure_ascii=False, separators=(",", ":"))
    print(f"月營收：新增 {added} 筆（{'、'.join(f'{k} 共 {len(v)} 家' for k, v in new.items()) or '沒有資料'}）")


# ───────────── 過去的月營收（回測用） ─────────────
def get_text(url):
    """抓網頁文字。公開資訊觀測站是 Big5 編碼；我們只需要數字，解不出來的字直接換掉。"""
    last = None
    for k in range(4):
        try:
            req = Request(url, headers={"User-Agent": "Mozilla/5.0 (benstock revenue history)"})
            with urlopen(req, timeout=40) as r:
                b = r.read()
            for enc in ("utf-8", "cp950"):
                try:
                    return b.decode(enc)
                except UnicodeDecodeError:
                    pass
            return b.decode("cp950", errors="replace")
        except HTTPError as e:
            if e.code == 404:
                return None
            last = e
        except Exception as e:
            last = e
        time.sleep(SLEEP * (k + 1))
    raise RuntimeError(f"抓取失敗：{last}")


def parse_mops(html):
    """公開資訊觀測站月營收表 → {代號: [當月營收, 去年當月營收]}（千元）。
    每一列：公司代號、公司名稱、當月營收、上月營收、去年當月營收、…"""
    out = {}
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S | re.I):
        cells = [re.sub(r"<[^>]+>|&nbsp;", "", c).strip() for c in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S | re.I)]
        if len(cells) < 5 or not re.fullmatch(r"\d{4}", cells[0]):
            continue
        cur, ly = num(cells[2]), num(cells[4])
        if cur is not None:
            out[cells[0]] = [cur, ly]
    return out


def update_revenue_hist(months, today):
    """補最近 months 個月（不含還沒公布的這個月）。已經有的月份不重抓，最近兩個月會重抓一次（可能有更正）。"""
    try:
        with open(REV_HIST, encoding="utf-8") as f:
            old = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        old = {"note": "過去月營收（千元）：[當月營收, 去年同月營收]。回測當作次月 11 日才公布。", "months": {}}
    have = old.setdefault("months", {})
    y, m = int(today[:4]), int(today[5:7])
    todo = []
    for i in range(1, months + 1):
        mm, yy = m - i, y
        while mm <= 0:
            mm += 12; yy -= 1
        ym = f"{yy}-{mm:02d}"
        if ym in have and len(have[ym]) >= 500 and i > 2:
            continue
        todo.append((yy, mm, ym))
    sent = 0
    for yy, mm, ym in todo:
        rows = {}
        for k in (0, 1):
            if sent:
                time.sleep(SLEEP)
            sent += 1
            html = get_text(URL_MOPS.format(y=yy - 1911, m=mm, k=k))
            if html:
                rows.update(parse_mops(html))
        if len(rows) < 300:
            if ym == todo[0][2]:      # 上個月可能還沒公布完，不算錯
                print(f"{ym}：只有 {len(rows)} 家，可能還沒公布完，先跳過")
                continue
            raise RuntimeError(f"{ym} 月營收只讀到 {len(rows)} 家，可能被擋或網頁格式改了")
        have[ym] = rows
        print(f"{ym}：月營收 {len(rows)} 家")
    old["months"] = dict(sorted(have.items()))
    with open(REV_HIST, "w", encoding="utf-8") as f:
        json.dump(old, f, ensure_ascii=False, separators=(",", ":"))
    print(f"過去月營收：共 {len(old['months'])} 個月")


# ───────────── 主程式 ─────────────
def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=5, help="補最近幾個交易日的法人資料")
    ap.add_argument("--max-new", type=int, default=20, help="法人資料這次最多送幾個請求")
    ap.add_argument("--no-revenue", action="store_true", help="不抓月營收")
    ap.add_argument("--no-inst", action="store_true", help="不抓三大法人")
    ap.add_argument("--revenue-history", type=int, default=0, help="補過去幾個月的月營收（回測用）")
    a = ap.parse_args(argv)
    today = dt.datetime.now(TW).date().isoformat()

    if a.revenue_history:
        update_revenue_hist(a.revenue_history, today)
    err, complete = None, True
    if not a.no_inst:
        try:
            complete, _ = update_inst(a.days, a.max_new)
        except Exception as e:      # 法人抓失敗，月營收照樣抓
            err, complete = e, True
            print(f"三大法人抓取失敗：{e}")
    if not a.no_revenue:
        time.sleep(SLEEP)
        update_revenue(today)
    if err:
        raise err
    return 0 if complete else 10


if __name__ == "__main__":
    sys.exit(main())
