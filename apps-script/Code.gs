/**
 * Google Apps Script Web App — סבן שטח (ח. סבן חומרי בניין 1994 בע"מ)
 *
 * Modes supported:
 *   Mode A (Full Sync): Set deployed Web App URL as VITE_SYNC_ENDPOINT.
 *   Mode B (Hybrid Drive / Orders): Set deployed Web App URL as APPS_SCRIPT_URL
 *     or DRIVE_APPS_SCRIPT_URL on the server (/api/sync).
 *
 * Optional Script Properties (Project Settings -> Script Properties):
 * - SHEET_ID_MAIN: defaults to "1FsLseQrKbIj_AvlE6-dW4J12Gr88P3uaoFVBjEcUjsw"
 * - DRIVE_FOLDER_ID: defaults to "1KvvtgwKBVrUlMEApK3Jy-ejfnUG3f_fT" (בירור-תעודות)
 * - MANAGER_OVERRIDE_CODE: manager override code for overweight PODs
 * - ONESIGNAL_APP_ID: OneSignal App ID for driver push notifications
 * - ONESIGNAL_REST_API_KEY: OneSignal REST API key for push notifications
 */

// ============================================================
// 1. קבועים + Headers + שמות טאבים (קשיח)
// ============================================================

const DEFAULT_SHEET_ID = "1FsLseQrKbIj_AvlE6-dW4J12Gr88P3uaoFVBjEcUjsw";
const DEFAULT_DRIVE_FOLDER_ID = "1KvvtgwKBVrUlMEApK3Jy-ejfnUG3f_fT";
const DEFAULT_DRIVE_FOLDER_NAME = "בירור-תעודות";
const TZ = "Asia/Jerusalem";

const TAB_POD = "ארכיון_תעודות_גליה";
const TAB_TACHO = "ארכיון_טכוגרף";
const TAB_TACHO_DUP = "טכנו";
const TAB_CRANE = "סשנים_PTO";
const TAB_DEPOSIT_GPS = "אתרי_לקוחות";
const TAB_ORDERS = "הזמנות";
const TAB_DICT = "מילון_לוגיסט";
const TAB_LOAD_CONFIRM = "אישורי_העמסה";

// Columns A-L only; existing columns beyond L are never overwritten
const POD_HEADERS = [
  "מפתח ייחודי",
  "תאריך",
  "שעה",
  "משאית",
  "נהג",
  "מספר תעודה",
  "לקוח",
  "משקל (טון)",
  "קוד חריגה",
  "שם קובץ",
  "קישור לתעודה",
  "מייל יעד",
];

// Exact 18 columns A-R for ארכיון_טכוגרף and טכנו (unique key in column P = 16)
const TACHO_HEADERS = [
  "תאריך קליטה",
  "תאריך דיסקית",
  "ק\"מ פתיחה",
  "ק\"מ סגירה",
  "סה\"כ ק\"מ",
  "קישור לדיסקית",
  "שעות תנועה",
  "שעות מנוף",
  "שעות סרק",
  "הערות",
  "נהג",
  "רישוי / משאית",
  "קובץ מקור",
  "עמוד",
  "סטטוס חילוץ",
  "מפתח ייחודי",
  "אושר ע״י",
  "אושר בתאריך",
];
const TACHO_KEY_COL = 16; // Column P (1-indexed)

const VALID_KINDS = {
  pod: true,
  tacho: true,
  crane: true,
  deposit: true,
  load_confirm: true,
  gps: true,
};

const TRUCK_MAX_TONS = {
  "615-41-002": 10.2,
  "651-51-701": 4.46,
};

const TRUCK_EMAILS = {
  "615-41-002": "galya@saban94.co.il",
  "651-51-701": "lina@saban94.co.il",
};

const TRUCK_DRIVERS = {
  "615-41-002": "חכמת גאבר",
  "651-51-701": "עלי",
};

// ============================================================
// 2. doGet / doPost
// ============================================================

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return jsonResponse({ ok: true, service: "saban-field-sync" });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ ok: false, error: "גוף הבקשה ריק" });
    }

    let payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (_parseErr) {
      return jsonResponse({ ok: false, error: "פורמט JSON לא תקין" });
    }

    if (!payload || !payload.kind) {
      return jsonResponse({ ok: false, error: "חסר שדה חובה: kind" });
    }

    const props = PropertiesService.getScriptProperties();

    // Read-only orders_list endpoint (no write lock required)
    if (payload.kind === "orders_list") {
      return jsonResponse(readOrders_(payload.truck || "", payload.date || ""));
    }

    lock.waitLock(30000);

    // Mode B: Drive upload only from /api/sync
    if (payload.kind === "drive_upload") {
      return handleDriveUploadOnly_(payload, props);
    }

    // Explicit OneSignal push trigger
    if (payload.kind === "notify_order") {
      if (!payload.truck || !payload.orderId) {
        return jsonResponse({ ok: false, error: "חסרים שדות חובה להתראה (truck, orderId)" });
      }
      return jsonResponse(sendOrderPush_(payload.truck, payload, props));
    }

    if (!VALID_KINDS[payload.kind]) {
      return jsonResponse({ ok: false, error: "סוג פעולה לא חוקי: " + payload.kind });
    }

    if (!payload.key || !payload.truck) {
      return jsonResponse({ ok: false, error: "חסרים שדות חובה (kind, key, truck)" });
    }

    const emailTo = TRUCK_EMAILS[payload.truck] || "galya@saban94.co.il";
    const tabName = resolveTabName_(payload);

    // Server-side manager override validation for overweight POD deliveries
    const maxTons = TRUCK_MAX_TONS[payload.truck];
    if (payload.kind === "pod" && maxTons && payload.tons != null && Number(payload.tons) > maxTons) {
      const expectedCode = props.getProperty("MANAGER_OVERRIDE_CODE");
      if (expectedCode && String(payload.overrideCode || "") !== String(expectedCode)) {
        return jsonResponse({
          ok: false,
          driveUrl: null,
          duplicate: false,
          sheet: tabName,
          emailTo: emailTo,
          emailSent: false,
          whatsappSent: false,
          error: "קוד מנהל שגוי לחריגת משקל",
        });
      }
    }

    // Upload media (PDF / Tacho photo / Deposit receipt) to Drive using script owner's quota
    let driveUrl = null;
    let attachmentBlob = null;
    const mediaSource = payload.pdf || payload.photo || (payload.payment && payload.payment.receipt);
    if (mediaSource) {
      const isPdf = Boolean(payload.pdf);
      const fallbackMime = isPdf ? "application/pdf" : "image/jpeg";
      const ext = isPdf ? "pdf" : "jpg";
      const fileName =
        payload.fileName || payload.kind + "_" + payload.truck + "_" + formatDate_(new Date()) + "." + ext;
      const saved = saveMediaToDrive_(
        mediaSource,
        fileName,
        fallbackMime,
        props.getProperty("DRIVE_FOLDER_ID") || DEFAULT_DRIVE_FOLDER_ID,
        payload.folder || DEFAULT_DRIVE_FOLDER_NAME,
      );
      driveUrl = saved.driveUrl;
      attachmentBlob = saved.blob;
    }

    const driver = payload.driver || TRUCK_DRIVERS[payload.truck] || payload.truck;
    const sheetId = props.getProperty("SHEET_ID_MAIN") || DEFAULT_SHEET_ID;
    const ss = SpreadsheetApp.openById(sheetId);

    let writeResult;
    if (payload.kind === "pod") {
      writeResult = appendPodRow_(ss, payload, driveUrl, driver, emailTo);
    } else if (payload.kind === "tacho") {
      writeResult = appendTachoDouble_(ss, payload, driveUrl, driver, emailTo);
    } else {
      writeResult = appendGenericRow_(ss, tabName, payload, driver, driveUrl, emailTo);
    }

    if (writeResult.duplicate) {
      return jsonResponse({
        ok: true,
        driveUrl: writeResult.driveUrl || driveUrl || null,
        duplicate: true,
        sheet: writeResult.sheet || tabName,
        emailTo: emailTo,
        emailSent: false,
        whatsappSent: false,
      });
    }

    // Email notification (pod / tacho only) via script owner's MailApp
    let emailSent = false;
    let emailError = null;
    if (payload.kind === "pod" || payload.kind === "tacho") {
      try {
        const copy = buildNotification_(payload, driver, driveUrl);
        const options = {};
        if (payload.kind === "pod" && attachmentBlob) {
          options.attachments = [attachmentBlob];
        } else if (payload.kind === "tacho" && !driveUrl && attachmentBlob) {
          options.attachments = [attachmentBlob];
        }
        MailApp.sendEmail(emailTo, copy.subject, copy.text, options);
        emailSent = true;
      } catch (mailErr) {
        emailError = mailErr && mailErr.message ? mailErr.message : String(mailErr);
      }
    }

    const response = {
      ok: true,
      driveUrl: driveUrl,
      duplicate: false,
      sheet: writeResult.sheet || tabName,
      emailTo: emailTo,
      emailSent: emailSent,
      whatsappSent: false,
    };
    if (emailError) {
      response.emailError = emailError;
    }
    return jsonResponse(response);
  } catch (err) {
    return jsonResponse({
      ok: false,
      driveUrl: null,
      duplicate: false,
      sheet: "",
      emailTo: "",
      emailSent: false,
      whatsappSent: false,
      error: err && err.message ? err.message : String(err),
    });
  } finally {
    try {
      lock.releaseLock();
    } catch (_releaseErr) {}
  }
}

function resolveTabName_(payload) {
  if (payload.kind === "pod") return TAB_POD;
  if (payload.kind === "tacho") return TAB_TACHO;
  if (payload.kind === "crane") return TAB_CRANE;
  if (payload.kind === "load_confirm") return TAB_LOAD_CONFIRM;
  return TAB_DEPOSIT_GPS;
}

// ============================================================
// 3. Drive Helpers
// ============================================================

function handleDriveUploadOnly_(payload, props) {
  const source = payload.base64 || payload.dataUri;
  if (!source) {
    return jsonResponse({ ok: false, driveUrl: null, error: "חסר תוכן קובץ (base64)" });
  }
  const fallbackMime = payload.mimeType || "application/octet-stream";
  const ext = fallbackMime.indexOf("pdf") !== -1 ? "pdf" : "jpg";
  const fileName = payload.fileName || "saban_upload_" + formatDate_(new Date()) + "." + ext;
  const folderId = payload.folderId || props.getProperty("DRIVE_FOLDER_ID") || DEFAULT_DRIVE_FOLDER_ID;
  const folderName = payload.folder || DEFAULT_DRIVE_FOLDER_NAME;

  const saved = saveMediaToDrive_(source, fileName, fallbackMime, folderId, folderName);
  return jsonResponse({
    ok: true,
    driveUrl: saved.driveUrl,
    fileId: saved.fileId,
    fileName: saved.fileName,
  });
}

function saveMediaToDrive_(mediaSource, fileName, fallbackMime, folderId, folderName) {
  const parsed = parseDataUri_(mediaSource, fallbackMime);
  const blob = Utilities.newBlob(Utilities.base64Decode(parsed.base64), parsed.mimeType, fileName);
  const folder = resolveDriveFolder_(folderId, folderName);
  const file = folder.createFile(blob);

  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (_sharingErr) {
    // Domain policies may restrict external sharing; keep file.getUrl() intact
  }

  return {
    fileId: file.getId(),
    fileName: file.getName(),
    driveUrl: file.getUrl(),
    blob: blob,
  };
}

function resolveDriveFolder_(folderId, folderName) {
  if (folderId) {
    try {
      return DriveApp.getFolderById(folderId);
    } catch (_idErr) {}
  }
  const targetName = folderName || DEFAULT_DRIVE_FOLDER_NAME;
  const it = DriveApp.getFoldersByName(targetName);
  return it.hasNext() ? it.next() : DriveApp.createFolder(targetName);
}

function parseDataUri_(input, fallbackMime) {
  const raw = String(input).trim();
  const m = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$/.exec(raw);
  if (m) {
    return { mimeType: m[1], base64: m[2].replace(/\s+/g, "") };
  }
  return { mimeType: fallbackMime, base64: raw.replace(/\s+/g, "") };
}

function formatDate_(d) {
  return Utilities.formatDate(d, TZ, "yyyyMMdd");
}

function formatTime_(d) {
  return Utilities.formatDate(d, TZ, "HH:mm");
}

// ============================================================
// 4. appendPodRow_ / appendTachoDouble_ / buildTachoRow_ / ensureStyledTab_
// ============================================================

function ensureSheetByName_(ss, exactName) {
  let sheet = ss.getSheetByName(exactName);
  if (!sheet) {
    sheet = ss.insertSheet(exactName);
  }
  return sheet;
}

function ensureStyledTab_(ss, exactName, headers) {
  const sheet = ensureSheetByName_(ss, exactName);
  const lastRow = sheet.getLastRow();

  if (lastRow === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    styleHeaderRow_(sheet, headers.length);
    return sheet;
  }

  const firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const isBlankRow1 = firstRow.every(function (cell) {
    return String(cell || "").trim() === "";
  });
  const matchesHeaders = firstRow.every(function (cell, idx) {
    return String(cell || "").trim() === headers[idx];
  });

  if (isBlankRow1) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    styleHeaderRow_(sheet, headers.length);
  } else if (!matchesHeaders) {
    const firstCell = String(firstRow[0] || "").trim();
    if (firstCell.indexOf("|") !== -1 || /^\d{8}$/.test(firstCell)) {
      sheet.insertRowBefore(1);
    }
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    styleHeaderRow_(sheet, headers.length);
  }

  return sheet;
}

function styleHeaderRow_(sheet, colCount) {
  const range = sheet.getRange(1, 1, 1, colCount);
  range.setFontWeight("bold");
  range.setBackground("#1e293b");
  range.setFontColor("#f8fafc");
  sheet.setFrozenRows(1);
}

function findKeyInColumn_(sheet, keyStr, colIndex1Based) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 0) return { found: false, driveUrl: null };

  const numCols = Math.max(colIndex1Based, sheet.getLastColumn());
  const values = sheet.getRange(1, 1, lastRow, numCols).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][colIndex1Based - 1]) === keyStr) {
      let existingDriveUrl = null;
      for (let c = 0; c < values[i].length; c++) {
        const val = String(values[i][c] || "");
        if (val.indexOf("https://drive.google.com/") === 0) {
          existingDriveUrl = val;
          break;
        }
      }
      return { found: true, driveUrl: existingDriveUrl };
    }
  }
  return { found: false, driveUrl: null };
}

function appendPodRow_(ss, payload, driveUrl, driver, emailTo) {
  const sheet = ensureStyledTab_(ss, TAB_POD, POD_HEADERS);
  const existing = findKeyInColumn_(sheet, String(payload.key), 1);
  if (existing.found) {
    return { duplicate: true, driveUrl: existing.driveUrl, sheet: TAB_POD };
  }

  const d = payload.at ? new Date(payload.at) : new Date();
  // Columns A-L only; preserves any columns >= M
  const row = [
    payload.key,
    formatDate_(d),
    formatTime_(d),
    payload.truck,
    driver,
    payload.docNumber || "",
    payload.customer || "",
    payload.tons != null ? payload.tons : "",
    payload.overrideCode || "",
    payload.fileName || "",
    driveUrl || "",
    emailTo,
  ];
  sheet.appendRow(row);
  return { duplicate: false, driveUrl: driveUrl || null, sheet: TAB_POD };
}

function buildTachoRow_(payload, driver, driveUrl, _emailTo) {
  const nowStr = formatDate_(new Date());
  const d = payload.at ? new Date(payload.at) : new Date();
  const discDateStr = formatDate_(d);
  const openOdo =
    payload.type === "open"
      ? payload.odometer != null ? payload.odometer : ""
      : payload.openOdo != null
        ? payload.openOdo
        : payload.odometer != null && payload.km != null
          ? Number(payload.odometer) - Number(payload.km)
          : "";
  const closeOdo = payload.type === "close" && payload.odometer != null ? payload.odometer : "";
  const extractStatus =
    payload.type === "open" ? "פתיחת יום" : payload.type === "close" ? "סגירת יום" : "נקלט";

  // 18 columns A-R; col P (index 15) = מפתח ייחודי
  return [
    nowStr,
    discDateStr,
    openOdo,
    closeOdo,
    payload.km != null ? payload.km : "",
    driveUrl || "",
    payload.driveHours != null ? payload.driveHours : "",
    payload.craneHours != null ? payload.craneHours : "",
    payload.idleHours != null ? payload.idleHours : "",
    payload.notes || extractStatus,
    driver,
    payload.truck,
    payload.fileName || "",
    payload.page != null ? payload.page : 1,
    extractStatus,
    String(payload.key),
    "",
    "",
  ];
}

function appendTachoDouble_(ss, payload, driveUrl, driver, emailTo) {
  const resolvedEmail = emailTo || TRUCK_EMAILS[payload.truck] || "galya@saban94.co.il";
  const mainSheet = ensureStyledTab_(ss, TAB_TACHO, TACHO_HEADERS);
  const dupSheet = ensureStyledTab_(ss, TAB_TACHO_DUP, TACHO_HEADERS);

  const existing = findKeyInColumn_(mainSheet, String(payload.key), TACHO_KEY_COL);
  if (existing.found) {
    return { duplicate: true, driveUrl: existing.driveUrl, sheet: TAB_TACHO };
  }

  const row = buildTachoRow_(payload, driver, driveUrl, resolvedEmail);
  mainSheet.appendRow(row);

  const existingDup = findKeyInColumn_(dupSheet, String(payload.key), TACHO_KEY_COL);
  if (!existingDup.found) {
    dupSheet.appendRow(row);
  }

  return { duplicate: false, driveUrl: driveUrl || null, sheet: TAB_TACHO };
}

// ============================================================
// 5. buildRow_ + appendGenericRow_ (crane / deposit / load_confirm / gps)
// ============================================================

function appendGenericRow_(ss, tabName, payload, driver, driveUrl, emailTo) {
  const sheet = ensureSheetByName_(ss, tabName);
  const existing = findKeyInColumn_(sheet, String(payload.key), 1);
  if (existing.found) {
    return { duplicate: true, driveUrl: existing.driveUrl, sheet: tabName };
  }

  const row = buildRow_(payload, driver, driveUrl, emailTo);
  sheet.appendRow(row);
  return { duplicate: false, driveUrl: driveUrl || null, sheet: tabName };
}

function buildRow_(payload, driver, driveUrl, _emailTo) {
  const d = payload.at ? new Date(payload.at) : new Date();
  const dateStr = formatDate_(d);
  const timeStr = formatTime_(d);

  if (payload.kind === "crane") {
    return [
      payload.key,
      dateStr,
      timeStr,
      payload.truck,
      driver,
      payload.mode || "timer",
      payload.docNumber || "",
      payload.seconds != null ? payload.seconds : "",
      payload.start ? formatTime_(new Date(payload.start)) : "",
      payload.end ? formatTime_(new Date(payload.end)) : "",
      Array.isArray(payload.startGps) ? payload.startGps.join(",") : "",
      Array.isArray(payload.endGps) ? payload.endGps.join(",") : "",
      driveUrl || "",
    ];
  }

  if (payload.kind === "deposit") {
    return [
      payload.key,
      dateStr,
      timeStr,
      payload.truck,
      driver,
      payload.docNumber || "",
      JSON.stringify(payload.items || {}),
      Boolean(payload.twoSites),
      payload.payment ? payload.payment.method : "",
      payload.payment ? payload.payment.amount : "",
      driveUrl || "",
    ];
  }

  if (payload.kind === "load_confirm") {
    return [
      payload.key,
      dateStr,
      timeStr,
      payload.truck,
      driver,
      payload.orderId || "",
      payload.docNumber || "",
      JSON.stringify(payload.lines || []),
      JSON.stringify(payload.deposits || []),
      payload.notes || "",
    ];
  }

  // gps
  return [
    payload.key,
    dateStr,
    timeStr,
    payload.truck,
    driver,
    payload.lat != null ? payload.lat : "",
    payload.lng != null ? payload.lng : "",
    payload.customer || "",
  ];
}

// ============================================================
// 6. readOrders_ (קריאת "הזמנות" A-R + נרמול מול "מילון_לוגיסט")
// ============================================================

function normalizeSheetDate_(raw) {
  if (raw == null || raw === "") return "";
  if (Object.prototype.toString.call(raw) === "[object Date]" && !isNaN(raw.getTime())) {
    return formatDate_(raw);
  }
  const str = String(raw).trim();
  if (!str) return "";
  if (/^\d{8}$/.test(str)) return str;

  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(str);
  if (iso) {
    return iso[1] + ("0" + iso[2]).slice(-2) + ("0" + iso[3]).slice(-2);
  }

  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(str);
  if (dmy) {
    const year = dmy[3].length === 2 ? "20" + dmy[3] : dmy[3];
    return year + ("0" + dmy[2]).slice(-2) + ("0" + dmy[1]).slice(-2);
  }

  const parsed = new Date(str);
  return !isNaN(parsed.getTime()) ? formatDate_(parsed) : "";
}

function resolveTruckFromLabel_(label) {
  const raw = String(label || "").trim();
  if (!raw) return null;
  const digits = raw.replace(/[-\s]/g, "");
  if (raw.indexOf("615-41-002") !== -1 || digits.indexOf("61541002") !== -1) return "615-41-002";
  if (raw.indexOf("651-51-701") !== -1 || digits.indexOf("65151701") !== -1) return "651-51-701";
  if (raw.indexOf("חכמת") !== -1 || raw.indexOf("גאבר") !== -1 || raw.indexOf("حكمت") !== -1) {
    return "615-41-002";
  }
  if (/(?:^|[\s/,\-|])עלי(?:$|[\s/,\-|])/.test(raw) || raw === "עלי" || raw.indexOf("علي") !== -1) {
    return "651-51-701";
  }
  return null;
}

function parseDictionary_(dictRows) {
  const out = [];
  for (let i = 0; i < dictRows.length; i++) {
    const r = dictRows[i];
    const sku = String(r[0] || "").trim();
    const officialName = String(r[1] || "").trim();
    if (!sku && !officialName) continue;
    if (i === 0 && (sku.indexOf("מק") !== -1 || officialName.indexOf("שם מוצר") !== -1)) continue;
    const slangRaw = String(r[4] || "").trim();
    const keywords = slangRaw
      ? slangRaw.split(/[,;|/\n]+/).map(function (s) {
          return s.trim().toLowerCase();
        }).filter(function (s) {
          return s.length >= 2;
        })
      : [];
    out.push({ sku: sku, officialName: officialName, keywords: keywords });
  }
  return out;
}

function parseProductsRaw_(productsRaw, dict) {
  const raw = String(productsRaw || "").trim();
  if (!raw) return [];
  const units = ["משטחים", "משטח", "שקים", "שק", "בלות", "בלה", "יח'", "יח", "טון", "מ״ק", "ק״ג"];
  const chunks = raw.split(/\r?\n|[;|]+|,\s+/).map(function (s) {
    return s.trim();
  }).filter(Boolean);

  return chunks.map(function (chunk) {
    let parsedSku = "";
    let qtyPlanned = 1;
    let desc = chunk;
    let unit = "יח'";
    for (let u = 0; u < units.length; u++) {
      if (chunk.indexOf(units[u]) !== -1) {
        unit = units[u];
        break;
      }
    }

    const skuFirstQtyParen = /^(\d{4,8})\s+(.+?)\s*\((\d+(?:\.\d+)?)(?:\s*[^)]*)?\)\s*$/.exec(chunk);
    const qtyFirstSkuParen = /^(\d+(?:\.\d+)?)\s+(.+?)\s*\((\d{4,8})\)\s*$/.exec(chunk);
    const skuFirstOnly = /^(\d{4,8})\s+(.+)$/.exec(chunk);

    if (skuFirstQtyParen) {
      parsedSku = skuFirstQtyParen[1];
      desc = skuFirstQtyParen[2].trim();
      qtyPlanned = Number(skuFirstQtyParen[3]);
    } else if (qtyFirstSkuParen && Number(qtyFirstSkuParen[1]) < 1000) {
      qtyPlanned = Number(qtyFirstSkuParen[1]);
      desc = qtyFirstSkuParen[2].trim();
      parsedSku = qtyFirstSkuParen[3];
    } else if (skuFirstOnly) {
      parsedSku = skuFirstOnly[1];
      desc = skuFirstOnly[2].trim();
    } else {
      const lead = /^(\d+(?:\.\d+)?)\s*(?:[x×*]|(?:משטחים|משטח|שקים|שק|בלות|בלה|יח'|יח|טון|מ"ק|מ״ק|ק"ג|ק״ג))?\s+(.+)$/.exec(chunk);
      const trail = /^(.+?)\s*(?:[x×*-])\s*(\d+(?:\.\d+)?)\s*(?:משטחים|משטח|שקים|שק|בלות|בלה|יח'|יח|טון|מ"ק|מ״ק|ק"ג|ק״ג)?$/.exec(chunk);
      if (lead && Number(lead[1]) < 1000) {
        qtyPlanned = Number(lead[1]);
        desc = lead[2].trim();
      } else if (trail) {
        desc = trail[1].trim();
        qtyPlanned = Number(trail[2]);
      }
    }

    const lower = chunk.toLowerCase();
    let matched = null;
    for (let d = 0; d < dict.length; d++) {
      if (parsedSku && dict[d].sku === parsedSku) {
        matched = dict[d];
        break;
      }
      if (dict[d].sku && lower.indexOf(dict[d].sku.toLowerCase()) !== -1) {
        matched = dict[d];
        break;
      }
      if (dict[d].officialName && lower.indexOf(dict[d].officialName.toLowerCase()) !== -1) {
        matched = dict[d];
        break;
      }
      for (let k = 0; k < dict[d].keywords.length; k++) {
        if (lower.indexOf(dict[d].keywords[k]) !== -1) {
          matched = dict[d];
          break;
        }
      }
      if (matched) break;
    }

    return {
      sku: matched ? matched.sku : parsedSku,
      name: matched ? matched.officialName : desc,
      qtyPlanned: qtyPlanned > 0 ? qtyPlanned : 1,
      unit: unit,
    };
  });
}

function readOrders_(truck, date) {
  const props = PropertiesService.getScriptProperties();
  const sheetId = props.getProperty("SHEET_ID_MAIN") || DEFAULT_SHEET_ID;
  const ss = SpreadsheetApp.openById(sheetId);
  const targetDate = normalizeSheetDate_(date) || formatDate_(new Date());

  const ordersSheet = ss.getSheetByName(TAB_ORDERS);
  if (!ordersSheet) {
    return { ok: true, orders: [], date: targetDate, truck: truck || "" };
  }

  const lastRow = ordersSheet.getLastRow();
  if (lastRow <= 0) {
    return { ok: true, orders: [], date: targetDate, truck: truck || "" };
  }

  const orderValues = ordersSheet.getRange(1, 1, lastRow, 18).getValues();
  const dictSheet = ss.getSheetByName(TAB_DICT);
  const dictValues =
    dictSheet && dictSheet.getLastRow() > 0
      ? dictSheet.getRange(1, 1, dictSheet.getLastRow(), 14).getValues()
      : [];
  const dict = parseDictionary_(dictValues);

  const requestedTruck = resolveTruckFromLabel_(truck) || String(truck || "").trim();
  const orders = [];

  for (let i = 0; i < orderValues.length; i++) {
    const r = orderValues[i];
    const orderId = String(r[3] || "").trim();
    const customerName = String(r[5] || "").trim();
    if (!orderId && !customerName) continue;
    if (i === 0 && (orderId.indexOf("הזמנה") !== -1 || String(r[1] || "").indexOf("תאריך אספקה") !== -1)) {
      continue;
    }

    const supplyDate = normalizeSheetDate_(r[1]);
    if (supplyDate && supplyDate !== targetDate) continue;

    const truckDriver = String(r[9] || "").trim();
    const rowTruck = resolveTruckFromLabel_(truckDriver);
    if (requestedTruck) {
      if (rowTruck ? rowTruck !== requestedTruck : truckDriver.indexOf(requestedTruck) === -1) {
        continue;
      }
    }

    const status = String(r[15] || "").trim();
    if (
      status.indexOf("בוצע") !== -1 ||
      status.indexOf("בוטל") !== -1 ||
      status.indexOf("נמסר") !== -1 ||
      status.indexOf("סגור") !== -1 ||
      status.indexOf("סופק") !== -1
    ) {
      continue;
    }

    const productsRaw = String(r[10] || "").trim();
    const mQty = Number(String(r[12] || "").replace(/[^\d.-]/g, "")) || 0;
    const nQty = Number(String(r[13] || "").replace(/[^\d.-]/g, "")) || 0;
    const deposits = [];
    if (mQty > 0) deposits.push({ sku: "60002", name: "שק גדול (בלה)", qty: mQty });
    if (nQty > 0) {
      const pSku = productsRaw.indexOf("60006") !== -1 || productsRaw.indexOf("בלוק") !== -1 ? "60006" : "60060";
      deposits.push({ sku: pSku, name: pSku === "60006" ? "משטח בלוקים" : "משטח סבן", qty: nQty });
    }

    const timeVal =
      Object.prototype.toString.call(r[2]) === "[object Date]"
        ? formatTime_(r[2])
        : String(r[2] || "").trim();
    const tonsRaw = Number(String(r[11] || "").replace(/[^\d.-]/g, ""));

    orders.push({
      orderId: orderId || "ROW-" + (i + 1),
      receivedDate: normalizeSheetDate_(r[0]),
      supplyDate: supplyDate || targetDate,
      time: timeVal,
      customerId: String(r[4] || "").trim(),
      customerName: customerName,
      contact: String(r[6] || "").trim(),
      address: String(r[7] || "").trim(),
      warehouse: String(r[8] || "").trim(),
      truckDriver: truckDriver,
      truckId: rowTruck,
      tons: isFinite(tonsRaw) && tonsRaw > 0 ? tonsRaw : null,
      docNumber: String(r[14] || "").trim(),
      status: status,
      waze: String(r[16] || "").trim(),
      notes: String(r[17] || "").trim(),
      productsRaw: productsRaw,
      lines: parseProductsRaw_(productsRaw, dict),
      deposits: deposits,
    });
  }

  return { ok: true, orders: orders, date: targetDate, truck: requestedTruck };
}

// ============================================================
// 7. OneSignal Push + Time-Driven Trigger (checkNewOrdersAndNotify)
// ============================================================

function sendOrderPush_(truck, order, props) {
  const scriptProps = props || PropertiesService.getScriptProperties();
  const truckId = resolveTruckFromLabel_(truck) || String(truck || "").trim();
  const dateStr = normalizeSheetDate_(order.supplyDate) || formatDate_(new Date());
  const dedupKey = String(order.orderId) + "|" + truckId + "|" + dateStr;

  const cachePropKey = "ONESIGNAL_SENT_" + dateStr;
  const sentMapRaw = scriptProps.getProperty(cachePropKey) || "{}";
  let sentMap;
  try {
    sentMap = JSON.parse(sentMapRaw);
  } catch (_e) {
    sentMap = {};
  }
  if (sentMap[dedupKey]) {
    return { ok: true, sent: false, duplicate: true, dedupKey: dedupKey };
  }

  const appId = scriptProps.getProperty("ONESIGNAL_APP_ID");
  const restKey = scriptProps.getProperty("ONESIGNAL_REST_API_KEY");
  if (!appId || !restKey) {
    return { ok: false, sent: false, skipped: true, dedupKey: dedupKey, error: "OneSignal לא מוגדר ב-Script Properties" };
  }

  const title = "הזמנה חדשה · " + order.orderId;
  const bodyParts = [order.customerName, order.address, order.time]
    .map(function (v) {
      return String(v || "").trim();
    })
    .filter(Boolean);
  const bodyText = bodyParts.join(" · ") || "הזמנה חדשה שובצה למשאית שלך";

  const res = UrlFetchApp.fetch("https://api.onesignal.com/notifications", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Basic " + restKey },
    payload: JSON.stringify({
      app_id: appId,
      include_external_user_ids: [truckId],
      target_channel: "push",
      idempotency_key: dedupKey,
      headings: { he: title, en: title },
      contents: { he: bodyText, en: bodyText },
      data: {
        type: "order",
        orderId: String(order.orderId),
        truck: truckId,
        url: "/orders?orderId=" + encodeURIComponent(String(order.orderId)),
      },
      priority: 10,
    }),
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) {
    return {
      ok: false,
      sent: false,
      dedupKey: dedupKey,
      error: "OneSignal HTTP " + res.getResponseCode() + ": " + res.getContentText(),
    };
  }

  sentMap[dedupKey] = true;
  scriptProps.setProperty(cachePropKey, JSON.stringify(sentMap));
  return { ok: true, sent: true, dedupKey: dedupKey };
}

/**
 * Connect to a Time-driven trigger (every 1 or 5 minutes) to push newly assigned orders to drivers.
 */
function checkNewOrdersAndNotify() {
  const props = PropertiesService.getScriptProperties();
  const today = formatDate_(new Date());
  const data = readOrders_("", today);
  const results = [];
  for (let i = 0; i < data.orders.length; i++) {
    const ord = data.orders[i];
    if (!ord.truckId) continue;
    results.push(sendOrderPush_(ord.truckId, ord, props));
  }
  return { ok: true, checked: data.orders.length, results: results };
}

// ============================================================
// 8. Email Copy + setupArchiveTabs
// ============================================================

function buildNotification_(payload, driver, driveUrl) {
  if (payload.kind === "tacho") {
    const phase = payload.type === "open" ? "פתיחת יום" : "סגירת יום";
    const subject = "טכוגרף " + phase + " · משאית " + payload.truck + " (" + driver + ")";
    const lines = [
      "⏱ טכוגרף " + phase,
      "🚚 משאית: " + payload.truck + " (" + driver + ")",
      "🔢 מד אוץ: " + (payload.odometer != null ? payload.odometer : "—"),
    ];
    if (payload.type === "close" && payload.km != null) {
      lines.push("📏 ק״מ היום: " + payload.km);
    }
    if (driveUrl) {
      lines.push("🔗 צפייה בצילום הדיסקית: " + driveUrl);
    }
    lines.push("", "בברכה,", "מערכת סבן שטח");
    return { subject: subject, text: lines.join("\n") };
  }

  const doc = payload.docNumber || "—";
  const customer = payload.customer || "—";
  const subject = "תעודת משלוח " + doc + " · " + customer + " · " + driver;
  const lines = [
    "שלום,",
    "מצורפת תעודת משלוח לעיונך.",
    "",
    "📄 מספר תעודה: " + doc,
    "👤 לקוח: " + customer,
    "🚚 משאית: " + payload.truck + " (" + driver + ")",
  ];
  if (payload.tons != null) {
    lines.push("⚖️ משקל: " + payload.tons + " טון");
  }
  if (driveUrl) {
    lines.push("🔗 קישור לדרייב: " + driveUrl);
  }
  lines.push("", "בברכה,", "מערכת סבן שטח");
  return { subject: subject, text: lines.join("\n") };
}

function setupArchiveTabs() {
  const props = PropertiesService.getScriptProperties();
  const sheetId = props.getProperty("SHEET_ID_MAIN") || DEFAULT_SHEET_ID;
  const ss = SpreadsheetApp.openById(sheetId);

  ensureStyledTab_(ss, TAB_POD, POD_HEADERS);
  ensureStyledTab_(ss, TAB_TACHO, TACHO_HEADERS);
  ensureStyledTab_(ss, TAB_TACHO_DUP, TACHO_HEADERS);
  ensureSheetByName_(ss, TAB_CRANE);
  ensureSheetByName_(ss, TAB_DEPOSIT_GPS);

  return {
    ok: true,
    tabs: [TAB_POD, TAB_TACHO, TAB_TACHO_DUP, TAB_CRANE, TAB_DEPOSIT_GPS],
  };
}

/**
 * ============================================================
 * הוראות התקנה, Deploy ו-Triggers:
 * ============================================================
 * 1. פתחו https://script.google.com תחת החשבון שמחזיק בתיקיית ה-Drive ובגיליון.
 * 2. הדביקו את הקוד ל-Code.gs ושמרו.
 * 3. הריצו פעם אחת את setupArchiveTabs לאימות הכותרות ב-ארכיון_תעודות_גליה, ארכיון_טכוגרף ו-טכנו.
 * 4. ב-Project Settings → Script Properties:
 *    - SHEET_ID_MAIN = 1FsLseQrKbIj_AvlE6-dW4J12Gr88P3uaoFVBjEcUjsw
 *    - DRIVE_FOLDER_ID = 1KvvtgwKBVrUlMEApK3Jy-ejfnUG3f_fT
 *    - MANAGER_OVERRIDE_CODE = <קוד המנהל>
 *    - ONESIGNAL_APP_ID = <OneSignal App ID>
 *    - ONESIGNAL_REST_API_KEY = <OneSignal REST API Key>
 * 5. Triggers → Add Trigger → checkNewOrdersAndNotify → Time-driven → Every 1 minute (או 5 minutes).
 * 6. Deploy → New deployment → Web app → Execute as: Me → Who has access: Anyone.
 */
