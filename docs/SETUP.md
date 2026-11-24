# סבן שטח – מבנה, התקנה ומשתני סביבה

## מבנה תיקיות
```
src/
  routes/            index (בית/בחירת משאית), tacho, pod, crane, deposits, summary
  components/field/  FieldContext (שפה, משאית, יום, סנכרון), Shell (כותרת, כפתורים גדולים, ✓)
  lib/field/
    config.ts        משאיות, מגבלות משקל, שמות קבצים, זמן Asia/Jerusalem, Unique Key
    db.ts            IndexedDB (idb): תור אופליין עם עדיפויות + kv
    sync.ts          ריקון התור לפי עדיפות (POD → טכוגרף → מנוף/פקדונות → GPS)
    imaging.ts       ניקוי צללים, ניגודיות, המרה ל-PDF (jsPDF)
    i18n.ts          עברית / ערבית
public/manifest.webmanifest   מצב fullscreen
```

## משתני סביבה
| משתנה | שלב | תיאור |
|---|---|---|
| VITE_SYNC_ENDPOINT | 1 | כתובת Apps Script Web App שמקבל JSON ומעלה ל-Drive/Sheets |
| GOOGLE_SERVICE_ACCOUNT_JSON | 2 | אם עוברים מ-Apps Script ל-Service Account |
| SHEET_ID_MAIN | 1 | הגיליון המרכזי (ארכיון_תעודות_גליה, ארכיון_טכוגרף, היסטוריית_ביקורים, אתרי_לקוחות) |
| DRIVE_FOLDER_ID | 1 | תיקיית בירור_תעודות_משלוח_ראמי |
| MANAGER_OVERRIDE_CODE | 1 | קוד מנהל לחריגת משקל (בדיקה בשרת) |
| WHATSAPP_GROUP_ID | 3 | קבוצת הסידור |
| ITURAN_API_USER / ITURAN_API_PASS | 3 | נתוני PTO מאיתוראן |
| GOOGLE_VISION_API_KEY | 2 | OCR לכתב יד |
| NOTIFY_EMAIL | 3 | galya@saban94.co.il |

## התקנה במצב Kiosk על Android
1. פרסמו את האפליקציה ופתחו את הכתובת ב-Chrome בטאבלט.
2. תפריט ⋮ → "הוספה למסך הבית" (נפתח במסך מלא).
3. נעילה: הגדרות → אבטחה → **הצמדת אפליקציה (App pinning)** → הפעל, פתחו את סבן שטח → סקירה → הצמד.
4. לנעילה מלאה (מומלץ): התקינו **Fully Kiosk Browser** או השתמשו ב-Android Enterprise / MDM (למשל Google Workspace, Hexnode) ב-Lock Task Mode, עם הכתובת כדף הבית.
5. הרשאות: מצלמה ומיקום → "תמיד אפשר"; כבו אופטימיזציית סוללה ל-Chrome/Fully.
6. השאירו את המסך דולק בזמן טעינה (אפשרויות מפתח → Stay awake).

## מה בשלב 1 ומה בהמשך
- ✅ בחירת משאית, טכוגרף חובה, POD מרובה עמודים → PDF, מנוף (טיימר+GPS / צילום ל-OCR), פקדונות וגבייה, חסימת משקל, סיכום יום, תור אופליין עם מניעת כפילויות.
- ⏳ שלב 2: Service Worker לעבודה בלי אינטרנט גם בפתיחה מחדש, Heartbeat GPS רציף, תיקון פרספקטיבה אוטומטי, OCR.
- ⏳ שלב 3: WhatsApp, מייל, הצלבת איתוראן.
