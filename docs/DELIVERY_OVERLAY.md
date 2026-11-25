# שכבת תעודה חיה + אינטגרציית גיליון + OCR

## מה כלול

1. **`/delivery-overlay`** – קליטה, תצוגה מקדימה RTL, טופס נהג.
2. **`/api/delivery-extract`** – חילוץ טקסט + **Google Vision OCR** לתמונות סרוקות.
3. **`/api/delivery-overlay`** – שליחה לגיליון (שרת Node **או** Apps Script).
4. **Apps Script** – handler מלא `kind: "delivery_overlay"` + `kind: "delivery_ocr"`.
5. **קישור מ-POD** – כפתור «שכבת נהג» במסך `/pod` + seed ל-sessionStorage אחרי יצירת PDF.

## Apps Script (`apps-script/Code.gs`)

### `delivery_overlay`
כותב ל:
- **שכבת_נהג** (כותרות מלאות, מפתח ייחודי, מניעת כפילויות)
- **סשנים_PTO** – שיקוף מנוף
- **אתרי_לקוחות** – שיקוף פקדונות
- **ארכיון_תעודות_גליה** – שורת ארכיון

### `delivery_ocr`
Vision API עם `GOOGLE_VISION_API_KEY` ב-Script Properties (languageHints: he/en/ar).

### התקנה
1. העתיקו את `Code.gs` המעודכן לפרויקט Apps Script.
2. הריצו `setupArchiveTabs` (יוצר גם **שכבת_נהג**).
3. Script Properties:
   - `SHEET_ID_MAIN`, `DRIVE_FOLDER_ID`, `MANAGER_OVERRIDE_CODE`
   - `GOOGLE_VISION_API_KEY` (אופציונלי, ל-OCR)
4. Deploy Web App מחדש.

## OCR בשרת (Node)

`src/lib/delivery/visionOcr.ts` מנסה לפי סדר:
1. `GOOGLE_VISION_API_KEY`
2. `GOOGLE_SERVICE_ACCOUNT_JSON` (scope cloud-vision)
3. `APPS_SCRIPT_URL` עם `kind: "delivery_ocr"`

לתמונות (`image/*`). PDF סרוק – מומלץ לרסטר עמוד בצד הלקוח ואז לשלוח JPEG.

## קישור מ-POD

במסך `/pod`:
- אחרי «צור PDF» – נשמר `delivery:lastPodId` ב-sessionStorage
- כפתור **שכבת נהג (מנוף / המתנה / פקדונות)** פותח `/delivery-overlay` עם מספר תעודה/לקוח/משאית ממולאים
- לינק נוסף למסך המלא

## עיצוב
`#f4f6f9` / `#0f4c81` / `#f59e0b`, Heebo, RTL, tabular-nums.
