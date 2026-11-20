# 外勤路線規劃

上載每週路線 Excel → 地圖落點 → 揀日數同時間 → 自動排每日最順路線 → 逐間 tick 成功／不成功 → 未做嘅自動排去之後日子 → 總覽。

全部資料只存喺使用者自己部機（browser localStorage），冇 server、冇 login。換機或者清 browser 資料就會冇，記得用「總覽 → 匯出 Excel」備份。

## 用法
1. **設定** → 揀 Excel（可以多份，相同 MID 會合併）→ 確認欄位 → 匯入
2. 撳「開始查」：每間鋪查位置、營業時間、電話
3. 揀分幾多日、開始日期、交通、每間停留分鐘；每日填開始／收工時間同出發地址（或者撳 📍 用而家位置）
4. 撳「AI 排路線」
5. **路線** 頁逐間撳 ✓ 成功／✗ 不成功（執咗／冇開／錯地址／其他）
   - 「冇開」會當「再去」，自動排返入之後日子
   - 撳「今日收工」或者過咗日子，未 tick 嘅會自動排去之後嘅日子
6. **總覽**：做咗幾多、仲有幾多、逐間刪除、匯出 Excel

## 排路線點計
- 位置：先用政府「地址查詢服務」(ALS) 按地址落點，再用 Google 搵返間鋪；Google 結果要喺地址 300 米內先會用（避免搵錯同名鋪）
- 行車時間：按直線距離估（行路 4.5km/h、港鐵/巴士、揸車各有系數），唔使額外 Google 收費
- 次序：避開未開門／已收工嘅鋪（最多等 90 分鐘開門），就快收嘅鋪優先，再揀最近，最後用 2-opt 調整減少走回頭路
- 冇開風險：每站會標「應該有開／可能冇開／好大機會冇開」
  - 冇營業時間資料：按行業同地址估（工廈樓上 = 平日 10–6、週六半日、週日唔開；診所有午飯時間；補習社下晝先開；食肆 11–9:30 等），排路線時都會用
  - 公眾假期（2026–2027，政府 1823 資料）同星期日：會提示，估計時間會當休息日
  - 之前「冇開」過：避開同一個星期幾、差唔多時間再去；兩次或以上冇開會排後啲
  - Google 顯示已結業／暫停營業：唔排入路線，另外列出
  - 啱啱開門（20 分鐘內）或就收工（30 分鐘內）都會提醒
- 「每日平均分配」開咗會盡量每日差唔多間數；有剩時間嘅日子會再塞排唔落嘅鋪

## Google API key 設定（一次過）
1. 去 https://console.cloud.google.com/ 開一個 project，連一個 billing account
2. 「APIs & Services → Library」啟用 **Maps JavaScript API** 同 **Places API (New)**
3. 「APIs & Services → Credentials → Create credentials → API key」
4. 撳個 key 入去設定限制（**一定要做**，因為 key 會喺網頁度睇得到）：
   - Application restrictions → **Websites** → 加 `https://tiffanyckh.github.io/*`
   - API restrictions → Restrict key → 只揀 Maps JavaScript API、Places API (New)
5. 「APIs & Services → Places API (New) → Quotas」將每日請求上限設低啲（例如每日 150），防止超額收費
6. 將 key 貼入 `config.js` 嘅 `GOOGLE_MAPS_API_KEY`

收費：查營業時間同電話屬 Google 最高級數據，每月頭 1,000 次免費，之後按次收費。同一 MID 查過就唔會再查。

## 檔案
- `index.html` / `styles.css` / `app.js`：個 app
- `config.js`：API key 同預設停留時間
- `vendor/`：SheetJS（讀 Excel）、Leaflet（地圖，用 OpenStreetMap）
