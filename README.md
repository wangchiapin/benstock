# benstock 選股掃描器

台股（上市）選股掃描器，手機優先。每天收盤後自動更新資料，網頁顯示符合條件的股票。

## 檔案

- `index.html`：網頁本體，自動讀取 `data/latest.json`。沒有資料檔時顯示示範資料。
- `data/latest.json`：最近約 100 個交易日的上市股票資料，由腳本自動更新，不用手動改。
- `scripts/fetch.py`：向證交所抓資料。第一次執行會補抓約 100 個交易日（約 10 分鐘），之後每天只補新的一天。
- `.github/workflows/daily.yml`：台灣時間每週一到週五 16:00 自動執行，也可以在 Actions 頁面手動執行。

## 第一次使用

1. Settings → Pages → Source 選 `main` 分支、根目錄。
2. Actions 頁面 → 「每日更新股價資料」→ Run workflow，等它跑完（第一次約 10 分鐘）。
3. 打開 `https://wangchiapin.github.io/benstock/`。

## 注意

篩選只能縮小範圍，不能保證獲利。本工具不構成投資建議。
