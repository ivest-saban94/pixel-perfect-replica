# חיבור DeliveryOverlay ל-Code.gs

הקובץ `DeliveryOverlay.gs` כבר במאגר. יש להדביק אותו **באותו פרויקט Apps Script** יחד עם `Code.gs`.

## 1. ב-doPost — לפני `VALID_KINDS`

```javascript
if (payload.kind === "delivery_overlay") {
  return jsonResponse(handleDeliveryOverlay_(payload, props));
}
if (payload.kind === "delivery_ocr") {
  return jsonResponse(handleDeliveryOcr_(payload, props));
}
```

## 2. ב-setupArchiveTabs

```javascript
if (typeof TAB_OVERLAY !== "undefined" && typeof OVERLAY_HEADERS !== "undefined") {
  ensureStyledTab_(ss, TAB_OVERLAY, OVERLAY_HEADERS);
}
```

## 3. Script Properties

- `GOOGLE_VISION_API_KEY` (אופציונלי ל-OCR)

## 4. Deploy מחדש של ה-Web App

לאחר ההדבקה — Save → Deploy → New version.
