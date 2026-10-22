#!/usr/bin/env python3
"""fetch_val.py 的單元測試（用人造資料，不連網）：python scripts/test_fetch_val.py
欄位名稱照 2026-10-22 實際查到的證交所格式：
  本益比：證券代號、證券名稱、收盤價、殖利率(%)、股利年度、本益比、股價淨值比、財報年/季
  融資融券彙總：代號、名稱、買進、賣出、現金償還、前日餘額、今日餘額、次一營業日限額（融資）＋ 買進、賣出、現券償還、前日餘額、今日餘額、次一營業日限額（融券）＋ 資券互抵、註記
"""
import gzip
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_val as F  # noqa: E402

VAL_FIELDS = ["證券代號", "證券名稱", "收盤價", "殖利率(%)", "股利年度", "本益比", "股價淨值比", "財報年/季"]
MARGIN_FIELDS = ["代號", "名稱", "買進", "賣出", "現金償還", "前日餘額", "今日餘額", "次一營業日限額",
                 "買進", "賣出", "現券償還", "前日餘額", "今日餘額", "次一營業日限額", "資券互抵", "註記"]


def val_rows(n=400):
    rows = [["1101", "台泥", "32.15", "3.11", 112, "34.20", "1.04", "113/2"],
            ["1102", "亞泥", "45.10", "4.66", 112, "14.27", "0.90", "113/2"],
            ["1103", "嘉泥", "18.30", "2.73", 112, "122.00", "0.56", "113/2"],
            ["2002", "中鋼", "20.00", "-", 112, "-", "1.50", "113/2"],            # 虧損：沒有本益比
            ["0050", "元大台灣50", "150.00", "2.50", 112, "-", "-", "-"],         # ETF
            ["1234", "千分位", "10.00", "1.00", 112, "1,234.50", "2.00", "113/2"],
            ["ABCD", "壞代號", "10", "1", 112, "10", "1", "113/2"],
            ["3000", "負值", "10", "-", 112, "-5.00", "0.00", "113/2"]]
    for i in range(n):
        rows.append([str(5000 + i), f"股{i}", "10", "2", 112, "15.00", "1.20", "113/2"])
    return rows


def margin_rows(n=400):
    rows = [["　", "合計", "219,884", "180,176", "5,153", "6,718,311", "6,752,866", "184,988,464", "12,427", "21,316", "4,873", "203,309", "207,325", "184,988,464", "7,338", "　"],
            ["1101", "台泥", "351", "343", "1", "16,437", "16,444", "1,887,795", "14", "4", "0", "21", "11", "1,887,795", "1", " "],
            ["1102", "亞泥", "5", "11", "0", "1,693", "1,687", "886,640", "0", "2", "0", "109", "111", "886,640", "1", " "]]
    for i in range(n):
        rows.append([str(5000 + i), f"股{i}", "1", "1", "0", "100", "100", "999", "0", "0", "0", "5", "5", "999", "0", " "])
    return rows


def val_json(date="20240903", flat=True, rows=None):
    rows = val_rows() if rows is None else rows
    if flat:
        return {"stat": "OK", "date": date, "fields": VAL_FIELDS, "data": rows}
    return {"stat": "OK", "date": date, "tables": [{"title": "x", "fields": VAL_FIELDS, "data": rows}]}


def margin_json(date="20240903", flat=False, rows=None, fields=None):
    rows = margin_rows() if rows is None else rows
    fields = fields or MARGIN_FIELDS
    if flat:
        return {"stat": "OK", "date": date, "fields": fields, "data": rows}
    return {"stat": "OK", "date": date, "tables": [
        {"title": "信用交易統計", "fields": ["項目", "買進", "賣出", "現金(券)償還", "前日餘額", "今日餘額"], "data": [["融資(交易單位)", "1", "1", "1", "1", "1"]]},
        {"title": "融資融券彙總", "fields": fields, "data": rows}]}


class Parse(unittest.TestCase):
    def test_val_flat_and_tables_same(self):
        a, b = F.parse_val(val_json(flat=True)), F.parse_val(val_json(flat=False))
        self.assertEqual(a, b)

    def test_val_values(self):
        d = F.parse_val(val_json())
        self.assertEqual(d["1101"], [34.2, 1.04, 3.11])
        self.assertEqual(d["2002"], [None, 1.5, None])           # 「-」→ None
        self.assertEqual(d["0050"], [None, None, 2.5])           # ETF 照收
        self.assertEqual(d["1234"][0], 1234.5)                   # 千分位
        self.assertEqual(d["3000"][0:2], [None, None])           # 負的本益比、0 的淨值比 → 沒資料
        self.assertNotIn("ABCD", d)                              # 壞代號略過

    def test_val_too_few_rows(self):
        with self.assertRaisesRegex(RuntimeError, "太少"):
            F.parse_val(val_json(rows=val_rows(10)[:20]))

    def test_val_missing_columns_names_fields(self):
        js = {"stat": "OK", "fields": ["證券代號", "收盤價"], "data": []}
        with self.assertRaisesRegex(RuntimeError, "證券代號"):
            F.parse_val(js)

    def test_val_short_rows_are_skipped(self):
        rows = val_rows() + [["9999", "短"]]
        self.assertNotIn("9999", F.parse_val(val_json(rows=rows)))

    def test_margin_takes_margin_not_short_and_skips_total(self):
        d = F.parse_margin(margin_json())
        self.assertEqual(d["1101"], [16437, 16444])              # 融資（不是融券的 21、11）
        self.assertEqual(d["1102"], [1693, 1687])
        self.assertNotIn("合計", d)
        self.assertNotIn("　", d)

    def test_margin_flat_form(self):
        self.assertEqual(F.parse_margin(margin_json(flat=True))["1101"], [16437, 16444])

    def test_margin_picks_summary_table_not_stats_table(self):
        self.assertGreater(len(F.parse_margin(margin_json())), 300)

    def test_margin_unexpected_order_raises(self):
        f = list(MARGIN_FIELDS)
        f[5], f[6] = f[6], f[5]                                  # 今日餘額跑到前日餘額前面
        with self.assertRaisesRegex(RuntimeError, "順序"):
            F.parse_margin(margin_json(fields=f))

    def test_margin_too_few(self):
        with self.assertRaisesRegex(RuntimeError, "太少"):
            F.parse_margin(margin_json(rows=margin_rows(5)))

    def test_industry(self):
        rows = [{"公司代號": "1101", "產業別": "01"}, {"公司代號": "2330", "產業別": "24"},
                {"公司代號": "ABC", "產業別": "01"}, {"公司代號": "1102", "產業別": ""}]
        self.assertEqual(F.parse_industry(rows), {"1101": "01", "2330": "24"})


class Tmp(unittest.TestCase):
    """把資料夾、網路、日期都換成假的。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.saved = (F.VAL, F.MARGIN, F.INDUSTRY, F.get_json, F.raw_dates, F.SLEEP)
        F.VAL, F.MARGIN = os.path.join(self.tmp.name, "val"), os.path.join(self.tmp.name, "margin")
        F.INDUSTRY = os.path.join(self.tmp.name, "industry.json")
        F.SLEEP = 0
        self.calls = []
        self.addCleanup(self.restore)

    def restore(self):
        F.VAL, F.MARGIN, F.INDUSTRY, F.get_json, F.raw_dates, F.SLEEP = self.saved

    def fake_net(self, none_dates=(), wrong_day=None):
        def gj(url):
            kind = "val" if "BWIBBU" in url else "margin" if "MI_MARGN" in url else "ind"
            if kind == "ind":
                return [{"公司代號": str(1000 + i), "產業別": "01"} for i in range(600)]
            d = url.split("date=")[1][:8]
            self.calls.append((kind, d))
            if d in none_dates:
                return {"stat": "很抱歉，沒有符合條件的資料!"}
            if wrong_day:
                d = wrong_day
            return val_json(date=d) if kind == "val" else margin_json(date=d)
        F.get_json = gj

    def read(self, kind, date):
        with gzip.open(F.path_of(kind, date), "rt", encoding="utf-8") as f:
            return json.load(f)


class Fetch(Tmp):
    def test_fetch_day_none_for_no_data(self):
        self.fake_net(none_dates=("20240903",))
        self.assertIsNone(F.fetch_day("val", "2024-09-03"))

    def test_fetch_day_other_stat_raises(self):
        F.get_json = lambda url: {"stat": "查詢過於頻繁"}
        with self.assertRaisesRegex(RuntimeError, "查詢過於頻繁"):
            F.fetch_day("val", "2024-09-03")

    def test_fetch_day_wrong_date_raises(self):
        self.fake_net(wrong_day="20240830")
        with self.assertRaisesRegex(RuntimeError, "20240830"):
            F.fetch_day("margin", "2024-09-03")

    def test_fetch_day_without_date_field_is_ok(self):
        js = val_json()
        del js["date"]
        F.get_json = lambda url: js
        self.assertGreater(len(F.fetch_day("val", "2024-09-03")), 300)

    def test_fetch_day_non_dict_raises(self):
        F.get_json = lambda url: "<html>blocked</html>"
        with self.assertRaises(RuntimeError):
            F.fetch_day("val", "2024-09-03")


class Update(Tmp):
    DATES = [f"2024-09-{d:02d}" for d in (2, 3, 4, 5, 6, 9, 10, 11)]

    def run_update(self, **kw):
        F.raw_dates = lambda: self.DATES
        args = dict(days=100, max_new=100, kinds=["val", "margin"], today="2024-09-12")
        args.update(kw)
        return F.update(args["days"], args["max_new"], args["kinds"], args["today"])

    def test_newest_first_and_interleaved(self):
        self.fake_net()
        self.run_update(max_new=4)
        self.assertEqual(self.calls, [("val", "20240911"), ("margin", "20240911"), ("val", "20240910"), ("margin", "20240910")])

    def test_budget_then_resume_then_complete(self):
        self.fake_net()
        done, added = self.run_update(max_new=6)
        self.assertFalse(done); self.assertEqual(added, 6)
        self.calls.clear()
        done, added = self.run_update(max_new=100)
        self.assertTrue(done); self.assertEqual(added, 10)       # 16 筆 − 已有 6 筆
        self.assertEqual(len(self.calls), 10)                    # 已經有的不重抓
        self.calls.clear()
        done, added = self.run_update()
        self.assertTrue(done); self.assertEqual((added, self.calls), (0, []))

    def test_days_limits_range(self):
        self.fake_net()
        self.run_update(days=2)
        self.assertEqual({d for _, d in self.calls}, {"20240910", "20240911"})

    def test_single_kind(self):
        self.fake_net()
        self.run_update(kinds=["margin"])
        self.assertEqual({k for k, _ in self.calls}, {"margin"})
        self.assertFalse(os.path.exists(F.VAL))

    def test_saved_file_contents(self):
        self.fake_net()
        self.run_update(max_new=2)
        v = self.read("val", "2024-09-11")
        self.assertEqual((v["date"], v["cols"][0], v["d"]["1101"]), ("2024-09-11", "本益比", [34.2, 1.04, 3.11]))
        m = self.read("margin", "2024-09-11")
        self.assertEqual(m["d"]["1101"], [16437, 16444])
        self.assertNotIn("empty", v)

    def test_recent_no_data_not_saved(self):
        self.fake_net(none_dates=("20240911",))
        self.run_update(max_new=2, kinds=["val"])
        self.assertFalse(F.have("val", "2024-09-11"))            # 才隔 1 天，可能還沒公布，下次再抓
        self.assertTrue(F.have("val", "2024-09-10"))

    def test_old_no_data_saved_as_empty_and_not_refetched(self):
        self.fake_net(none_dates=("20240902",))
        self.run_update(kinds=["val"], today="2024-09-20")
        self.assertTrue(self.read("val", "2024-09-02")["empty"])
        self.calls.clear()
        self.run_update(kinds=["val"], today="2024-09-20")
        self.assertEqual(self.calls, [])

    def test_all_no_data_raises_instead_of_saving_empties(self):
        F.get_json = lambda url: {"stat": "很抱歉，沒有符合條件的資料!"}
        with self.assertRaisesRegex(RuntimeError, "全部都說沒有資料"):
            self.run_update(today="2024-12-31")
        self.assertFalse(os.path.exists(F.VAL) and os.listdir(F.VAL) == [])

    def test_few_no_data_does_not_trigger_sanity(self):
        F.get_json = lambda url: {"stat": "很抱歉，沒有符合條件的資料!"}
        F.raw_dates = lambda: self.DATES[-3:]
        self.assertTrue(F.update(100, 100, ["val"], "2024-09-12")[0])

    def test_bad_format_raises_and_keeps_earlier_days(self):
        n = {"i": 0}

        def gj(url):
            n["i"] += 1
            d = url.split("date=")[1][:8]
            return val_json(date=d, rows=val_rows(10)[:20]) if n["i"] == 3 else val_json(date=d)
        F.get_json = gj
        with self.assertRaisesRegex(RuntimeError, "太少"):
            self.run_update(kinds=["val"])
        self.assertEqual(len(os.listdir(F.VAL)), 2)              # 前兩天已存下，壞掉那天沒存

    def test_nothing_to_do(self):
        F.raw_dates = lambda: []
        self.assertEqual(F.update(100, 100, ["val", "margin"], "2024-09-12"), (True, 0))


class Industry(Tmp):
    def test_writes_and_keeps_delisted(self):
        self.fake_net()
        os.makedirs(self.tmp.name, exist_ok=True)
        with open(F.INDUSTRY, "w", encoding="utf-8") as f:
            json.dump({"d": {"9999": "99"}}, f)
        F.update_industry("2026-10-22")
        with open(F.INDUSTRY, encoding="utf-8") as f:
            js = json.load(f)
        self.assertEqual(js["d"]["9999"], "99")                  # 舊的保留
        self.assertEqual(js["d"]["1000"], "01")
        self.assertEqual(js["asOf"], "2026-10-22")

    def test_too_few_raises_and_keeps_old_file(self):
        F.get_json = lambda url: [{"公司代號": "1101", "產業別": "01"}]
        with open(F.INDUSTRY, "w", encoding="utf-8") as f:
            json.dump({"d": {"1": "1"}}, f)
        with self.assertRaisesRegex(RuntimeError, "太少|只讀到"):
            F.update_industry("2026-10-22")
        with open(F.INDUSTRY, encoding="utf-8") as f:
            self.assertEqual(json.load(f), {"d": {"1": "1"}})


class Main(Tmp):
    def test_main_exit_codes(self):
        self.fake_net()
        F.raw_dates = lambda: [f"2024-09-{d:02d}" for d in range(1, 21)]
        self.assertEqual(F.main(["--days", "50", "--max-new", "5"]), 10)       # 還沒補完
        self.assertEqual(F.main(["--days", "50", "--max-new", "500"]), 0)
        self.assertTrue(os.path.exists(F.INDUSTRY))

    def test_main_industry_failure_still_saves_val_then_raises(self):
        def gj(url):
            if "t187ap03" in url:
                raise RuntimeError("擋住了")
            return val_json(date=url.split("date=")[1][:8])
        F.get_json = gj
        F.raw_dates = lambda: ["2024-09-02", "2024-09-03"]
        with self.assertRaisesRegex(RuntimeError, "擋住了"):
            F.main(["--days", "5", "--max-new", "10", "--no-margin"])
        self.assertTrue(F.have("val", "2024-09-03"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
