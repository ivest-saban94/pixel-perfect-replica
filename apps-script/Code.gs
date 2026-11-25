/**
 * Google Apps Script Web App — סבן שטח (ח. סבן חומרי בניין 1994 בע"מ)
 *
 * Supports two operating modes:
 *   Mode A (Full Sync): Set the deployed Web App URL as VITE_SYNC_ENDPOINT.
 *     The client app posts directly here; handles Drive upload, Sheets dedup/append,
 *     overweight manager override, and Hebrew email delivery via MailApp.
 *   Mode B (Hybrid Drive Upload): Set the deployed Web App URL as APPS_SCRIPT_URL
 *     or DRIVE_APPS_SCRIPT_URL on the server (/api/sync). The server handles
 *     Sheets (Service Account) + Resend email, and calls this Web App with
 *     kind: "drive_upload" so files are saved in the script owner's Google Drive quota.
 *
 * Optional Script Properties (Project Settings -> Script Properties):
 * - SHEET_ID_MAIN: defaults to "1FsLseQrKbIj_AvlE6-dW4J12Gr88P3uaoFVBjEcUjsw"
 * - DRIVE_FOLDER_ID: defaults to "1KvvtgwKBVrUlMEApK3Jy-ejfnUG3f_fT" (בירור-תעודות)
 * - MANAGER_OVERRIDE_CODE: server-side validation code for overweight POD deliveries
 */

const DEFAULT_SHEET_ID = "1FsLseQrKbIj_AvlE6-dW4J12Gr88P3uaoFVBjEcUjsw";
const DEFAULT_DRIVE_FOLDER_ID = "1KvvtgwKBVrUlMEApK3Jy-ejfnUG3f_fT";
const DEFAULT_DRIVE_FOLDER_NAME = "בירור-תעודות";
const TZ = "Asia/Jerusalem";

const VALID_KINDS = {
  pod: true,
  tacho: true,
  crane: true,
  deposit: true,
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

    lock.waitLock(30000);

    const props = PropertiesService.getScriptProperties();

    // Strategy B (Hybrid): Drive upload only from /api/sync (src/lib/server/drive.ts)
    if (payload.kind === "drive_upload") {
      return handleDriveUploadOnly_(payload, props);
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

    const sheetId = props.getProperty("SHEET_ID_MAIN") || DEFAULT_SHEET_ID;
    const ss = SpreadsheetApp.openById(sheetId);
    let sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      sheet = ss.insertSheet(tabName);
    }

    // Idempotent deduplication by key in column A
    const lastRow = sheet.getLastRow();
    if (lastRow > 0) {
      const numCols = Math.min(13, Math.max(1, sheet.getLastColumn()));
      const values = sheet.getRange(1, 1, lastRow, numCols).getValues();
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
            driveUrl: existingDriveUrl,
            duplicate: true,
            sheet: tabName,
            emailTo: emailTo,
            emailSent: false,
            whatsappSent: false,
          });
        }
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
    const row = buildRow_(payload, driver, driveUrl, emailTo);
    sheet.appendRow(row);

    // Optional email notification (pod / tacho only) via script owner's MailApp
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

    const result = {
      ok: true,
      driveUrl: driveUrl,
      duplicate: false,
      sheet: tabName,
      emailTo: emailTo,
      emailSent: emailSent,
      whatsappSent: false,
    };
    if (emailError) {
      result.emailError = emailError;
    }
    return jsonResponse(result);
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

  // Best-effort link sharing so dispatchers/managers can open driveUrl directly
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
  if (folderId) {
    try {
      return DriveApp.getFolderById(folderId);
    } catch (_idErr) {
      // Fall back to name lookup below if folder ID is inaccessible
    }
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

function buildRow_(payload, driver, driveUrl, emailTo) {
  const d = payload.at ? new Date(payload.at) : new Date();
  const dateStr = formatDate_(d);
  const timeStr = formatTime_(d);

  if (payload.kind === "pod") {
    return [
      payload.key,
      dateStr,
      timeStr,
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
  }
  if (payload.kind === "tacho") {
    return [
      payload.key,
      dateStr,
      timeStr,
      payload.truck,
      driver,
      payload.type || "",
      payload.odometer != null ? payload.odometer : "",
      payload.km != null ? payload.km : "",
      driveUrl || "",
      emailTo,
    ];
  }
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

/**
 * ============================================================
 * הוראות התקנה ו-Deploy (Google Apps Script Web App):
 * ============================================================
 * 1. פתחו https://script.google.com תחת החשבון שמחזיק בתיקיית ה-Drive ובגיליון.
 * 2. צרו פרויקט חדש והדביקו את כל תוכן הקובץ לתוך Code.gs (ושמרו).
 * 3. אופציונלי — Project Settings → Script Properties:
 *    - SHEET_ID_MAIN = 1FsLseQrKbIj_AvlE6-dW4J12Gr88P3uaoFVBjEcUjsw
 *    - DRIVE_FOLDER_ID = 1KvvtgwKBVrUlMEApK3Jy-ejfnUG3f_fT
 *    - MANAGER_OVERRIDE_CODE = <קוד המנהל לחריגת משקל>
 * 4. לחצו: Deploy → New deployment → Select type: Web app
 *    - Execute as: Me (המשתמש האנושי, כדי שהקבצים יישמרו ב-Drive שלכם)
 *    - Who has access: Anyone
 * 5. העתיקו את ה-Web app URL שנוצר:
 *    - למצב מלא (ללא צורך בשרת): הדביקו במשתנה VITE_SYNC_ENDPOINT
 *    - למצב היברידי (Sheets + Resend בשרת, Drive דרך Apps Script): הדביקו ב-APPS_SCRIPT_URL (או DRIVE_APPS_SCRIPT_URL)
 */
