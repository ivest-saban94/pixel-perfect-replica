/**
 * Delivery Overlay + Vision OCR — סבן שטח
 * Merge into Code.gs OR paste below the main constants and call from doPost.
 *
 * In doPost, BEFORE `if (!VALID_KINDS[payload.kind])`, add:
 *
 *   if (payload.kind === "delivery_overlay") {
 *     return jsonResponse(handleDeliveryOverlay_(payload, props));
 *   }
 *   if (payload.kind === "delivery_ocr") {
 *     return jsonResponse(handleDeliveryOcr_(payload, props));
 *   }
 *
 * In setupArchiveTabs add:
 *   ensureStyledTab_(ss, TAB_OVERLAY, OVERLAY_HEADERS);
 *
 * Script Property (optional OCR): GOOGLE_VISION_API_KEY
 */

const TAB_OVERLAY = "שכבת_נהג";

const OVERLAY_HEADERS = [
  "מפתח ייחודי",
  "תאריך",
  "שעה",
  "משאית",
  "נהג",
  "מספר תעודה",
  "לקוח",
  "פתיחת מנוף",
  "סגירת מנוף",
  "משך מנוף",
  "המתנה משעה",
  "המתנה עד",
  "משך המתנה",
  "סוג מנוף",
  "סוג עבודה",
  "התחלת עבודה",
  "סיום עבודה",
  "משך עבודה",
  "פקדונות JSON",
  "הערות",
  "קישור מקור",
  "נשלח ב",
];

// ============================================================
// Delivery Overlay + OCR handlers
// ============================================================

function durationHm_(from, to) {
  if (!from || !to) return "";
  var p1 = String(from).split(":");
  var p2 = String(to).split(":");
  if (p1.length < 2 || p2.length < 2) return "";
  var h1 = Number(p1[0]);
  var m1 = Number(p1[1]);
  var h2 = Number(p2[0]);
  var m2 = Number(p2[1]);
  if (isNaN(h1) || isNaN(m1) || isNaN(h2) || isNaN(m2)) return "";
  var mins = h2 * 60 + m2 - (h1 * 60 + m1);
  if (mins < 0) mins += 24 * 60;
  var h = Math.floor(mins / 60);
  var m = mins % 60;
  return h + ":" + (m < 10 ? "0" : "") + m;
}

function buildOverlayKey_(payload) {
  if (payload.key) return String(payload.key);
  var doc = payload.docNumber || payload.deliveryId || "overlay";
  return String(doc) + "|" + formatDate_(new Date());
}

/**
 * Full write path for kind === "delivery_overlay"
 * Writes: שכבת_נהג + optional mirror to סשנים_PTO / אתרי_לקוחות / ארכיון_תעודות_גליה
 */
function handleDeliveryOverlay_(payload, props) {
  var truck = String(payload.truck || "").trim();
  var emailTo = TRUCK_EMAILS[truck] || "galya@saban94.co.il";
  var driver = payload.driver || TRUCK_DRIVERS[truck] || truck;
  var key = buildOverlayKey_(payload);
  var sheetId = props.getProperty("SHEET_ID_MAIN") || DEFAULT_SHEET_ID;
  var ss = SpreadsheetApp.openById(sheetId);
  var sheet = ensureStyledTab_(ss, TAB_OVERLAY, OVERLAY_HEADERS);

  var existing = findKeyInColumn_(sheet, key, 1);
  if (existing.found) {
    return {
      ok: true,
      key: key,
      sheet: TAB_OVERLAY,
      emailTo: emailTo,
      duplicate: true,
      driveUrl: existing.driveUrl || null,
    };
  }

  var work = payload.craneWork || {};
  var depositsJson = "";
  try {
    depositsJson = JSON.stringify(payload.depositsAdjust || payload.deposits || {});
  } catch (_e) {
    depositsJson = "{}";
  }

  var now = new Date();
  var row = [
    key,
    formatDate_(now),
    formatTime_(now),
    truck,
    driver,
    payload.docNumber || "",
    payload.customer || "",
    payload.craneOpen || "",
    payload.craneClose || "",
    durationHm_(payload.craneOpen, payload.craneClose),
    payload.waitFrom || "",
    payload.waitUntil || "",
    durationHm_(payload.waitFrom, payload.waitUntil),
    work.type || "",
    work.workType || "",
    work.start || "",
    work.end || "",
    durationHm_(work.start, work.end),
    depositsJson,
    payload.notes || "",
    payload.sourceFileUrl || payload.driveUrl || "",
    payload.submittedAt || now.toISOString(),
  ];
  sheet.appendRow(row);

  if (payload.craneOpen || payload.craneClose || work.start || work.end) {
    var craneSheet = ensureSheetByName_(ss, TAB_CRANE);
    var craneExisting = findKeyInColumn_(craneSheet, key, 1);
    if (!craneExisting.found) {
      craneSheet.appendRow([
        key,
        formatDate_(now),
        formatTime_(now),
        truck,
        driver,
        "overlay",
        payload.docNumber || "",
        "",
        payload.craneOpen || work.start || "",
        payload.craneClose || work.end || "",
        "",
        "",
        payload.sourceFileUrl || "",
      ]);
    }
  }

  var depObj = payload.depositsAdjust || payload.deposits || {};
  var hasDep = false;
  if (depObj && typeof depObj === "object") {
    for (var k in depObj) {
      if (Object.prototype.hasOwnProperty.call(depObj, k)) {
        hasDep = true;
        break;
      }
    }
  }
  if (hasDep) {
    var depSheet = ensureSheetByName_(ss, TAB_DEPOSIT_GPS);
    var depExisting = findKeyInColumn_(depSheet, key, 1);
    if (!depExisting.found) {
      depSheet.appendRow([
        key,
        formatDate_(now),
        formatTime_(now),
        truck,
        driver,
        payload.docNumber || "",
        depositsJson,
        false,
        "",
        "",
        "",
      ]);
    }
  }

  var podSheet = ensureStyledTab_(ss, TAB_POD, POD_HEADERS);
  var podExisting = findKeyInColumn_(podSheet, key, 1);
  if (!podExisting.found) {
    podSheet.appendRow([
      key,
      formatDate_(now),
      formatTime_(now),
      truck,
      driver,
      payload.docNumber || "",
      payload.customer || "",
      payload.tons != null ? payload.tons : "",
      "",
      "",
      payload.sourceFileUrl || "",
      emailTo,
    ]);
  }

  return {
    ok: true,
    key: key,
    sheet: TAB_OVERLAY,
    emailTo: emailTo,
    duplicate: false,
  };
}

/**
 * OCR via Google Cloud Vision (optional).
 * Payload: { kind: "delivery_ocr", imageBase64: "..." }
 */
function handleDeliveryOcr_(payload, props) {
  var b64 = payload.imageBase64 || payload.base64 || "";
  if (!b64) {
    return { ok: false, error: "חסר imageBase64" };
  }
  var m = /^data:[^;]+;base64,([\s\S]+)$/.exec(String(b64).trim());
  if (m) b64 = m[1];
  b64 = String(b64).replace(/\s+/g, "");

  var apiKey = props.getProperty("GOOGLE_VISION_API_KEY") || props.getProperty("VISION_API_KEY");
  if (!apiKey) {
    return {
      ok: false,
      error: "חסר GOOGLE_VISION_API_KEY ב-Script Properties",
      text: "",
    };
  }

  var url =
    "https://vision.googleapis.com/v1/images:annotate?key=" + encodeURIComponent(apiKey);
  var body = {
    requests: [
      {
        image: { content: b64 },
        features: [
          { type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 },
          { type: "TEXT_DETECTION", maxResults: 1 },
        ],
        imageContext: { languageHints: ["he", "en", "ar"] },
      },
    ],
  };

  var res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var raw = res.getContentText() || "";
  if (code < 200 || code >= 300) {
    return { ok: false, error: "Vision HTTP " + code + ": " + raw.slice(0, 500), text: "" };
  }

  var json;
  try {
    json = JSON.parse(raw);
  } catch (_e) {
    return { ok: false, error: "Vision JSON parse failed", text: "" };
  }

  var text = "";
  try {
    var resp0 = json.responses && json.responses[0];
    if (resp0 && resp0.fullTextAnnotation && resp0.fullTextAnnotation.text) {
      text = resp0.fullTextAnnotation.text;
    } else if (resp0 && resp0.textAnnotations && resp0.textAnnotations[0]) {
      text = resp0.textAnnotations[0].description || "";
    }
  } catch (_e2) {
    text = "";
  }

  return { ok: true, text: text, chars: text.length };
}
