# שכבת תעודה חיה + אינטגרציית גיליון

## מה נוסף

1. **`/delivery-overlay`** – מסך קליטה + תצוגה מקדימה RTL + טופס נהג.
2. **`/api/delivery-extract`** – חילוץ ראשוני מ-PDF/תמונה → JSON אחיד (ניתן להשלים ידנית).
3. **`/api/delivery-overlay`** – שליחת שכבת הנהג לגיליון.

## כתיבה לגיליון (`writeOverlayToSheet`)

| יעד | תוכן |
|-----|------|
| **שכבת_נהג** (טאב חדש) | שורה מלאה: מנוף, המתנה, עבודת חכמת, פקדונות JSON, הערות |
| **סשנים_PTO** | שיקוף סשן מנוף |
| **אתרי_לקוחות** | שיקוף פקדונות |
| **ארכיון_תעודות_גליה** | שורת ארכיון קלה (ללא PDF חובה) |

מזהה ייחודי: `uniqueKey(docNumber|deliveryId)` כמו בשאר המערכת.

## משתני סביבה

אותם כמו field sync:

- `GOOGLE_SERVICE_ACCOUNT_JSON` **או** `APPS_SCRIPT_URL`
- `SHEET_ID_MAIN` (ברירת מחדל: `1FsLseQrKbIj_AvlE6-dW4J12Gr88P3uaoFVBjEcUjsw`)

כשאין Service Account – ה-payload נשלח ל-Apps Script עם `kind: "delivery_overlay"` (יש להוסיף handler ב-`Code.gs`).

## עיצוב סטודיו

- רקע `#f4f6f9`, כרטיס לבן, גבול `#dfe4ec`, רדיוס 14px
- כחול `#0f4c81`, ענבר `#f59e0b`
- Heebo / Assistant, `dir=rtl`, `tabular-nums`

## זרימה

1. העלאת PDF/תמונה → extract → sessionStorage
2. טופס נהג (פתיחה/סגירה, המתנה, חכמת 9/15מ׳, פקדונות ±, הערות)
3. POST `/api/delivery-overlay` → Sheets
4. אישור + חזרה לבית

## דמו

במסך הקליטה: כפתור **"פתח דמו (חכמת + פקדונות)"**.
