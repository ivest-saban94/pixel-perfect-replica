/**
 * Google Apps Script Web App — סבן שטח (ח. סבן חומרי בניין 1994 בע"מ)
 * Deploy as Web App (Execute as: Me, Who has access: Anyone) and set URL in VITE_SYNC_ENDPOINT.
 *
 * Optional Script Properties (Project Settings -> Script Properties):
 * - SHEET_ID_MAIN: defaults to 1FsLseQrKbIj_AvlE6-dW4J12Gr88P3uaoFVBjEcUjsw
 * - DRIVE_FOLDER_ID: target Google Drive folder ID (defaults to folder "בירור_תעודות_משלוח_ראמי")
 * - MANAGER_OVERRIDE_CODE: server-side validation code for overweight deliveries
 * - WHATSAPP_WEBHOOK_URL: webhook endpoint for WhatsApp group notifications
 * - WHATSAPP_WEBHOOK_TOKEN: optional Bearer token for WhatsApp webhook
 * - WHATSAPP_GROUP_ID: group identifier (e.g. "עדכונים מהסידור")
 */

const DEFAULT_SHEET_ID = "1FsLseQrKbIj_AvlE6-dW4J12Gr88P3uaoFVBjEcUjsw";
const DEFAULT_DRIVE_FOLDER = "בירור_תעודות_משלוח_ראמי";
const TZ = "Asia/Jerusalem";

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
      return jsonResponse({ ok: false, error: "Empty request body" });
    }
    const payload = JSON.parse(e.postData.contents);
    if (!payload.kind || !payload.key || !payload.truck) {
      return jsonResponse({ ok: false, error: "Missing required fields (kind, key, truck)" });
    }

    const props = PropertiesService.getScriptProperties();

    // Server-side manager override validation for overweight deliveries
    const maxTons = TRUCK_MAX_TONS[payload.truck];
    if (payload.kind === "pod" && maxTons && payload.tons != null && Number(payload.tons) > maxTons) {
      const expectedCode = props.getProperty("MANAGER_OVERRIDE_CODE");
      if (expectedCode && payload.overrideCode !== expectedCode) {
        return jsonResponse({ ok: false, error: "קוד מנהל שגוי לחריגת משקל" });
      }
    }

    lock.waitLock(20000);

    const sheetId = props.getProperty("SHEET_ID_MAIN") || DEFAULT_SHEET_ID;
    const ss = SpreadsheetApp.openById(sheetId);
    const tabName = resolveTabName_(payload);
    let sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      sheet = ss.insertSheet(tabName);
    }

    // Idempotent deduplication by key in column A
    const lastRow = sheet.getLastRow();
    if (lastRow > 0) {
      const values = sheet.getRange(1, 1, lastRow, Math.min(12, Math.max(1, sheet.getLastColumn()))).getValues();
      for (let i = 0; i < values.length; i++) {
        if (String(values[i][0]) === String(payload.key)) {
          let existingDriveUrl = null;
          for (let c = 0; c < values[i].length; c++) {
            const val = String(values[i][c] || "");
            if (val.indexOf("https://drive.google.com/") === 0) {
              existingDriveUrl = val;
              break;
            }
          }
          return jsonResponse({
            ok: true,
            duplicate: true,
            driveUrl: existingDriveUrl,
            sheet: tabName,
            emailSent: false,
            whatsappSent: false,
          });
        }
      }
    }

    let driveUrl = null;
    let attachmentBlob = null;
    const mediaSource = payload.pdf || payload.photo || (payload.payment && payload.payment.receipt);
    if (mediaSource) {
      const parsed = parseDataUri_(mediaSource, payload.pdf ? "application/pdf" : "image/jpeg");
      const ext = payload.pdf ? "pdf" : "jpg";
      const fileName = payload.fileName || payload.kind + "_" + payload.truck + "_" + formatDate_(new Date()) + "." + ext;
      const folder = resolveDriveFolder_(props.getProperty("DRIVE_FOLDER_ID"), payload.folder || DEFAULT_DRIVE_FOLDER);
      attachmentBlob = Utilities.newBlob(Utilities.base64Decode(parsed.base64), parsed.mimeType, fileName);
      const file = folder.createFile(attachmentBlob);
      driveUrl = file.getUrl();
    }

    const emailTo = TRUCK_EMAILS[payload.truck] || "galya@saban94.co.il";
    const driver = payload.driver || TRUCK_DRIVERS[payload.truck] || payload.truck;
    const row = buildRow_(payload, driver, driveUrl, emailTo);
    sheet.appendRow(row);

    const copy = buildNotification_(payload, driver, driveUrl);
    let emailSent = false;
    if (payload.kind === "pod" || payload.kind === "tacho" || (payload.notify && payload.notify.email)) {
      const options = attachmentBlob ? { attachments: [attachmentBlob] } : {};
      GmailApp.sendEmail(emailTo, copy.subject, copy.text, options);
      emailSent = true;
    }

    let whatsappSent = false;
    const waWebhook = props.getProperty("WHATSAPP_WEBHOOK_URL");
    if (waWebhook && payload.notify && payload.notify.whatsapp && (payload.kind === "pod" || payload.kind === "tacho")) {
      const waToken = props.getProperty("WHATSAPP_WEBHOOK_TOKEN");
      const waGroup = props.getProperty("WHATSAPP_GROUP_ID") || "עדכונים מהסידור";
      const headers = { "Content-Type": "application/json" };
      if (waToken) headers["Authorization"] = "Bearer " + waToken;
      const res = UrlFetchApp.fetch(waWebhook, {
        method: "post",
        contentType: "application/json",
        headers: headers,
        payload: JSON.stringify({
          groupId: waGroup,
          chatName: "עדכונים מהסידור",
          message: copy.text,
          docNumber: payload.docNumber || null,
          driver: driver,
          truck: payload.truck,
          driveUrl: driveUrl,
        }),
        muteHttpExceptions: true,
      });
      if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) {
        throw new Error("WhatsApp webhook HTTP " + res.getResponseCode() + ": " + res.getContentText());
      }
      whatsappSent = true;
    }

    return jsonResponse({
      ok: true,
      duplicate: false,
      driveUrl: driveUrl,
      sheet: tabName,
      emailTo: emailTo,
      emailSent: emailSent,
      whatsappSent: whatsappSent,
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: err && err.message ? err.message : String(err) });
  } finally {
    try {
      lock.releaseLock();
    } catch (_) {}
  }
}

function resolveTabName_(payload) {
  const valid = {
    "ארכיון_תעודות_גליה": true,
    "ארכיון_טכוגרף": true,
    "סשנים_PTO": true,
    "אתרי_לקוחות": true,
    "היסטוריית_ביקורים": true,
  };
  if (payload.sheet && valid[payload.sheet]) return payload.sheet;
  if (payload.kind === "pod") return "ארכיון_תעודות_גליה";
  if (payload.kind === "tacho") return "ארכיון_טכוגרף";
  if (payload.kind === "crane") return "סשנים_PTO";
  return "אתרי_לקוחות";
}

function resolveDriveFolder_(folderId, folderName) {
  if (folderId) return DriveApp.getFolderById(folderId);
  const it = DriveApp.getFoldersByName(folderName);
  return it.hasNext() ? it.next() : DriveApp.createFolder(folderName);
}

function parseDataUri_(input, fallbackMime) {
  const m = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$/.exec(String(input).trim());
  if (m) return { mimeType: m[1], base64: m[2].replace(/\s+/g, "") };
  return { mimeType: fallbackMime, base64: String(input).replace(/\s+/g, "") };
}

function formatDate_(d) {
  return Utilities.formatDate(d, TZ, "yyyyMMdd");
}

function formatTime_(d) {
  return Utilities.formatDate(d, TZ, "HH:mm");
}

function buildRow_(payload, driver, driveUrl, emailTo) {
  const d = payload.at ? new Date(payload.at) : new Date();
  const dateStr = formatDate_(d);
  const timeStr = formatTime_(d);

  if (payload.kind === "pod") {
    return [
      payload.key, dateStr, timeStr, payload.truck, driver,
      payload.docNumber || "", payload.customer || "", payload.tons != null ? payload.tons : "",
      payload.overrideCode || "", payload.fileName || "", driveUrl || "", emailTo,
    ];
  }
  if (payload.kind === "tacho") {
    return [
      payload.key, dateStr, timeStr, payload.truck, driver,
      payload.type || "", payload.odometer != null ? payload.odometer : "",
      payload.km != null ? payload.km : "", driveUrl || "", emailTo,
    ];
  }
  if (payload.kind === "crane") {
    return [
      payload.key, dateStr, timeStr, payload.truck, driver,
      payload.mode || "timer", payload.docNumber || "", payload.seconds != null ? payload.seconds : "",
      payload.start ? formatTime_(new Date(payload.start)) : "",
      payload.end ? formatTime_(new Date(payload.end)) : "",
      Array.isArray(payload.startGps) ? payload.startGps.join(",") : "",
      Array.isArray(payload.endGps) ? payload.endGps.join(",") : "",
      driveUrl || "",
    ];
  }
  if (payload.kind === "deposit") {
    return [
      payload.key, dateStr, timeStr, payload.truck, driver,
      payload.docNumber || "", JSON.stringify(payload.items || {}), Boolean(payload.twoSites),
      payload.payment ? payload.payment.method : "", payload.payment ? payload.payment.amount : "",
      driveUrl || "",
    ];
  }
  return [
    payload.key, dateStr, timeStr, payload.truck, driver,
    payload.lat != null ? payload.lat : "", payload.lng != null ? payload.lng : "", payload.customer || "",
  ];
}

function buildNotification_(payload, driver, driveUrl) {
  if (payload.kind === "tacho") {
    const phase = payload.type === "open" ? "פתיחת יום" : "סגירת יום";
    const subject = "טכוגרף " + phase + " · משאית " + payload.truck + " (" + driver + ")";
    const lines = [
      "⏱ טכוגרף " + phase,
      "🚚 משאית: " + payload.truck + " (" + driver + ")",
      "🔢 מד אוץ: " + (payload.odometer != null ? payload.odometer : "—") + (payload.km != null ? " | ק״מ היום: " + payload.km : ""),
    ];
    if (driveUrl) lines.push("🔗 קישור לדרייב: " + driveUrl);
    return { subject: subject, text: lines.join("\n") };
  }
  const subject = ("תעודת משלוח " + (payload.docNumber || "") + " · " + (payload.customer || "") + " · " + driver).trim();
  const lines = [
    "📄 תעודת משלוח: " + (payload.docNumber || "—") + (payload.customer ? " | לקוח: " + payload.customer : ""),
    "🚚 משאית: " + payload.truck + " (" + driver + ")",
  ];
  if (payload.tons != null) lines.push("⚖️ משקל: " + payload.tons + " טון");
  if (driveUrl) lines.push("🔗 קישור לדרייב: " + driveUrl);
  return { subject: subject, text: lines.join("\n") };
}
