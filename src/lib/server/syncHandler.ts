import { z } from "zod";
import {
  DRIVE_FOLDER,
  SHEET_ID_MAIN,
  TAB_CRANE,
  TAB_DEPOSIT_GPS,
  TAB_LOAD_CONFIRM,
  TAB_POD,
  TAB_TACHO,
  TAB_TACHO_TECHNO,
  driverNameForTruck,
  emailForTruck,
  jerusalemDate,
  jerusalemTime,
  overWeight,
  type TruckId,
} from "@/lib/field/config";
import { getDriveAppsScriptUrl, uploadDriveFile, validateSafeWebhookUrl } from "./drive";
import {
  base64ToBytes,
  getGoogleAccessToken,
  getUserOAuthAccessToken,
  readEnv,
  type ServiceAccountCreds,
  type SyncEnv,
} from "./googleAuth";
import { sendOrderPush } from "./notifyOrder";
import { fetchOrdersFromSheet } from "./orders";

export { validateSafeWebhookUrl };
export type { SyncEnv };

const SyncPayloadSchema = z
  .object({
    kind: z.enum(["pod", "tacho", "crane", "deposit", "load_confirm", "gps"]),
    key: z.string().trim().min(1).max(200),
    truck: z.string().trim().min(1).max(40),
    driver: z.string().trim().max(120).optional(),
    sheet: z.string().trim().max(80).optional(),
    sheetId: z.string().trim().max(120).optional(),
    docNumber: z.string().trim().max(80).nullable().optional(),
    orderId: z.string().trim().max(80).optional(),
    customer: z.string().trim().max(200).optional(),
    tons: z.number().finite().nonnegative().nullable().optional(),
    overrideCode: z.string().trim().max(40).nullable().optional(),
    fileName: z.string().trim().max(200).optional(),
    folder: z.string().trim().max(120).optional(),
    pdf: z.string().max(25_000_000).optional(),
    photo: z.string().max(15_000_000).optional(),
    type: z.enum(["open", "close"]).optional(),
    odometer: z.number().finite().nonnegative().optional(),
    openOdo: z.number().finite().nonnegative().nullable().optional(),
    km: z.number().finite().nonnegative().nullable().optional(),
    driveHours: z.union([z.number(), z.string()]).optional(),
    craneHours: z.union([z.number(), z.string()]).optional(),
    idleHours: z.union([z.number(), z.string()]).optional(),
    page: z.number().finite().optional(),
    notes: z.string().max(1000).optional(),
    mode: z.enum(["timer", "ocr"]).optional(),
    start: z.number().finite().optional(),
    end: z.number().finite().optional(),
    seconds: z.number().finite().nonnegative().optional(),
    startGps: z.array(z.number().nullable().optional()).max(2).optional(),
    endGps: z.array(z.number().nullable().optional()).max(2).nullable().optional(),
    items: z.record(z.string(), z.number().finite().nonnegative()).optional(),
    lines: z.array(z.record(z.string(), z.unknown())).optional(),
    deposits: z.array(z.record(z.string(), z.unknown())).optional(),
    twoSites: z.boolean().optional(),
    payment: z
      .object({
        method: z.enum(["cash", "check"]),
        amount: z.number().finite().nonnegative(),
        receipt: z.string().max(15_000_000).optional(),
      })
      .nullable()
      .optional(),
    lat: z.number().finite().optional(),
    lng: z.number().finite().optional(),
    at: z.number().finite().optional(),
    notify: z
      .object({
        whatsapp: z.boolean().optional(),
        email: z.string().email().optional(),
      })
      .optional(),
  })
  .passthrough();

export type SyncPayload = z.infer<typeof SyncPayloadSchema>;

export interface SyncResult {
  ok: boolean;
  driveUrl: string | null;
  duplicate: boolean;
  sheet: string;
  emailTo: string;
  emailSent: boolean;
  emailError?: string;
  whatsappSent: boolean;
  error?: string;
}

const DEFAULT_EMAIL_FROM = "סבן שטח <onboarding@resend.dev>";
const TACHO_KEY_INDEX_0 = 15; // Column P (16th column)

const inflightPromises = new Map<string, Promise<{ status: number; body: SyncResult }>>();

export function resolveSheetTab(payload: SyncPayload): string {
  switch (payload.kind) {
    case "pod":
      return TAB_POD;
    case "tacho":
      return TAB_TACHO;
    case "crane":
      return TAB_CRANE;
    case "load_confirm":
      return TAB_LOAD_CONFIRM;
    case "gps":
    case "deposit":
      return TAB_DEPOSIT_GPS;
  }
}

export function parseDataUri(
  input: string,
  fallbackMime: string,
): { mimeType: string; base64: string; bytes: Uint8Array } {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/s.exec(input.trim());
  const mimeType = match?.[1] ?? fallbackMime;
  const base64 = (match?.[2] ?? input).replace(/\s+/g, "");
  return { mimeType, base64, bytes: base64ToBytes(base64) };
}

async function resolveOrCreateDriveFolder(
  token: string,
  folderName: string,
  configuredFolderId?: string,
): Promise<string | undefined> {
  if (configuredFolderId) return configuredFolderId;
  const q = `mimeType = 'application/vnd.google-apps.folder' and name = '${folderName.replace(/'/g, "\\'")}' and trashed = false`;
  const listRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (listRes.ok) {
    const data = (await listRes.json()) as { files?: Array<{ id: string }> };
    const existing = data.files?.[0]?.id;
    if (existing) return existing;
  }
  const createRes = await fetch(
    "https://www.googleapis.com/drive/v3/files?fields=id&supportsAllDrives=true",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
      }),
    },
  );
  if (!createRes.ok) return undefined;
  const created = (await createRes.json()) as { id?: string };
  return created.id;
}

async function uploadFileToDrive(
  token: string,
  fileName: string,
  mimeType: string,
  fileBytes: Uint8Array,
  folderId?: string,
): Promise<{ fileId: string; driveUrl: string }> {
  const boundary = `saban_boundary_${crypto.randomUUID()}`;
  const metadata = JSON.stringify({
    name: fileName,
    mimeType,
    ...(folderId ? { parents: [folderId] } : {}),
  });

  const enc = new TextEncoder();
  const part1 = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
  );
  const part2 = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(part1.length + fileBytes.length + part2.length);
  body.set(part1, 0);
  body.set(fileBytes, part1.length);
  body.set(part2, part1.length + fileBytes.length);

  const uploadRes = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  if (!uploadRes.ok) {
    throw new Error(`Drive upload failed (${uploadRes.status}): ${await uploadRes.text()}`);
  }
  const uploaded = (await uploadRes.json()) as { id: string; webViewLink?: string };
  const driveUrl = uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`;
  return { fileId: uploaded.id, driveUrl };
}

async function ensureSheetTabExists(
  token: string,
  sheetId: string,
  tabName: string,
): Promise<void> {
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!metaRes.ok) {
    throw new Error(`Google Sheets metadata failed (${metaRes.status}): ${await metaRes.text()}`);
  }
  const meta = (await metaRes.json()) as {
    sheets?: Array<{ properties?: { title?: string } }>;
  };
  const exists = meta.sheets?.some((s) => s.properties?.title === tabName);
  if (exists) return;

  const createRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title: tabName } } }],
      }),
    },
  );
  if (!createRes.ok) {
    throw new Error(`Failed creating sheet tab ${tabName}: ${await createRes.text()}`);
  }
}

async function findExistingRowByKey(
  token: string,
  sheetId: string,
  tabName: string,
  key: string,
  keyColIndex0 = 0,
): Promise<{ exists: boolean; existingDriveUrl?: string }> {
  const range = `${tabName}!A:Z`;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    throw new Error(`Google Sheets read failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { values?: string[][] };
  const matchRow = (data.values ?? []).find((row) => row[keyColIndex0] === key);
  if (!matchRow) return { exists: false };
  const urlCell = matchRow.find(
    (cell) => typeof cell === "string" && cell.startsWith("https://drive.google.com/"),
  );
  return urlCell ? { exists: true, existingDriveUrl: urlCell } : { exists: true };
}

export function buildSheetRow(
  payload: SyncPayload,
  driveUrl: string | null,
  emailTo: string,
): (string | number | boolean)[] {
  const ts = payload.at ? new Date(payload.at) : new Date();
  const dateStr = jerusalemDate(ts);
  const timeStr = jerusalemTime(ts);
  const driver = payload.driver || driverNameForTruck(payload.truck);

  switch (payload.kind) {
    case "pod":
      // Columns A-L only; never overwrite columns beyond L
      return [
        payload.key,
        dateStr,
        timeStr,
        payload.truck,
        driver,
        payload.docNumber ?? "",
        payload.customer ?? "",
        payload.tons ?? "",
        payload.overrideCode ?? "",
        payload.fileName ?? "",
        driveUrl ?? "",
        emailTo,
      ];
    case "tacho": {
      const openOdo =
        payload.type === "open"
          ? (payload.odometer ?? "")
          : (payload.openOdo ??
            (payload.odometer != null && payload.km != null ? payload.odometer - payload.km : ""));
      const closeOdo = payload.type === "close" ? (payload.odometer ?? "") : "";
      const extractStatus =
        payload.type === "open" ? "פתיחת יום" : payload.type === "close" ? "סגירת יום" : "נקלט";
      // 18 columns A-R; unique key at column P (index 15)
      return [
        jerusalemDate(),
        dateStr,
        openOdo,
        closeOdo,
        payload.km ?? "",
        driveUrl ?? "",
        payload.driveHours ?? "",
        payload.craneHours ?? "",
        payload.idleHours ?? "",
        payload.notes ?? extractStatus,
        driver,
        payload.truck,
        payload.fileName ?? "",
        payload.page ?? 1,
        extractStatus,
        payload.key,
        "",
        "",
      ];
    }
    case "crane":
      return [
        payload.key,
        dateStr,
        timeStr,
        payload.truck,
        driver,
        payload.mode ?? "timer",
        payload.docNumber ?? "",
        payload.seconds ?? "",
        payload.start ? jerusalemTime(payload.start) : "",
        payload.end ? jerusalemTime(payload.end) : "",
        payload.startGps ? payload.startGps.filter((v) => v != null).join(",") : "",
        payload.endGps ? payload.endGps.filter((v) => v != null).join(",") : "",
        driveUrl ?? "",
      ];
    case "deposit":
      return [
        payload.key,
        dateStr,
        timeStr,
        payload.truck,
        driver,
        payload.docNumber ?? "",
        JSON.stringify(payload.items ?? {}),
        Boolean(payload.twoSites),
        payload.payment?.method ?? "",
        payload.payment?.amount ?? "",
        driveUrl ?? "",
      ];
    case "load_confirm":
      return [
        payload.key,
        dateStr,
        timeStr,
        payload.truck,
        driver,
        payload.orderId ?? "",
        payload.docNumber ?? "",
        JSON.stringify(payload.lines ?? []),
        JSON.stringify(payload.deposits ?? []),
        payload.notes ?? "",
      ];
    case "gps":
      return [
        payload.key,
        dateStr,
        timeStr,
        payload.truck,
        driver,
        payload.lat ?? "",
        payload.lng ?? "",
        payload.customer ?? "",
      ];
  }
}

async function appendSheetRow(
  token: string,
  sheetId: string,
  tabName: string,
  row: (string | number | boolean)[],
): Promise<void> {
  const range = `${tabName}!A1`;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: [row] }),
    },
  );
  if (!res.ok) {
    throw new Error(`Google Sheets append failed (${res.status}): ${await res.text()}`);
  }
}

export function buildNotificationCopy(
  payload: SyncPayload,
  driver: string,
  driveUrl: string | null,
): { subject: string; text: string } {
  if (payload.kind === "tacho") {
    const phase = payload.type === "open" ? "פתיחת יום" : "סגירת יום";
    const subject = `טכוגרף ${phase} · משאית ${payload.truck} (${driver})`;
    const lines = [
      `⏱ טכוגרף ${phase}`,
      `🚚 משאית: ${payload.truck} (${driver})`,
      `🔢 מד אוץ: ${payload.odometer ?? "—"}`,
      payload.type === "close" && payload.km != null ? `📏 ק״מ היום: ${payload.km}` : "",
      driveUrl ? `🔗 צפייה בצילום הדיסקית: ${driveUrl}` : "",
      "",
      "בברכה,",
      "מערכת סבן שטח",
    ].filter((line, idx, arr) => line !== "" || (idx > 0 && arr[idx - 1] !== ""));
    return { subject, text: lines.join("\n") };
  }

  const doc = payload.docNumber ?? "—";
  const customer = payload.customer ?? "—";
  const subject = `תעודת משלוח ${doc} · ${customer} · ${driver}`;
  const lines = [
    "שלום,",
    "מצורפת תעודת משלוח לעיונך.",
    "",
    `📄 מספר תעודה: ${doc}`,
    `👤 לקוח: ${customer}`,
    `🚚 משאית: ${payload.truck} (${driver})`,
    payload.tons != null ? `⚖️ משקל: ${payload.tons} טון` : "",
    driveUrl ? `🔗 קישור לדרייב: ${driveUrl}` : "",
    "",
    "בברכה,",
    "מערכת סבן שטח",
  ].filter((line, idx, arr) => line !== "" || (idx > 0 && arr[idx - 1] !== ""));
  return { subject, text: lines.join("\n") };
}

export async function sendResendEmail(
  env: SyncEnv | undefined,
  opts: {
    to: string;
    subject: string;
    text: string;
    attachment?: { fileName: string; base64: string };
  },
): Promise<boolean> {
  const resendKey = readEnv("RESEND_API_KEY", env);
  if (!resendKey) return false;

  const from = readEnv("EMAIL_FROM", env) || DEFAULT_EMAIL_FROM;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [opts.to],
      subject: opts.subject,
      text: opts.text,
      ...(opts.attachment
        ? {
            attachments: [
              {
                filename: opts.attachment.fileName,
                content: opts.attachment.base64,
              },
            ],
          }
        : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend email failed (${res.status}): ${await res.text()}`);
  }
  return true;
}

export async function processSyncPayload(
  rawInput: unknown,
  runtimeEnv?: SyncEnv,
): Promise<{ status: number; body: SyncResult }> {
  const parsed = SyncPayloadSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      status: 400,
      body: {
        ok: false,
        driveUrl: null,
        duplicate: false,
        sheet: "",
        emailTo: "",
        emailSent: false,
        whatsappSent: false,
        error: `בקשה לא תקינה: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      },
    };
  }

  const payload = parsed.data;
  const targetSheet = resolveSheetTab(payload);
  const emailTo = emailForTruck(payload.truck);
  const driver = payload.driver || driverNameForTruck(payload.truck);

  // Server-side manager override verification for overweight deliveries
  if (
    payload.kind === "pod" &&
    payload.tons != null &&
    overWeight(payload.truck as TruckId, payload.tons)
  ) {
    const expectedCode = readEnv("MANAGER_OVERRIDE_CODE", runtimeEnv);
    if (expectedCode && payload.overrideCode !== expectedCode) {
      return {
        status: 403,
        body: {
          ok: false,
          driveUrl: null,
          duplicate: false,
          sheet: targetSheet,
          emailTo,
          emailSent: false,
          whatsappSent: false,
          error: "קוד מנהל שגוי לחריגת משקל",
        },
      };
    }
  }

  const rawSa = readEnv("GOOGLE_SERVICE_ACCOUNT_JSON", runtimeEnv);
  const appsScriptUrl = readEnv("APPS_SCRIPT_URL", runtimeEnv);
  const driveAppsScriptUrl = getDriveAppsScriptUrl(runtimeEnv);

  // Strategy A proxy: forward full payload to Apps Script when Service Account is not configured
  if (!rawSa && appsScriptUrl) {
    const safeUrl = validateSafeWebhookUrl(appsScriptUrl);
    const res = await fetch(safeUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      redirect: "follow",
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let remote: Partial<SyncResult> | null = null;
    try {
      remote = JSON.parse(text) as Partial<SyncResult>;
    } catch {
      remote = null;
    }
    if (!res.ok || remote?.ok === false) {
      return {
        status: res.ok ? 502 : res.status,
        body: {
          ok: false,
          driveUrl: null,
          duplicate: false,
          sheet: targetSheet,
          emailTo,
          emailSent: false,
          whatsappSent: false,
          error: remote?.error || `Apps Script HTTP ${res.status}`,
        },
      };
    }
    return {
      status: 200,
      body: {
        ok: true,
        driveUrl: remote?.driveUrl ?? null,
        duplicate: Boolean(remote?.duplicate),
        sheet: remote?.sheet || targetSheet,
        emailTo: remote?.emailTo || emailTo,
        emailSent: Boolean(remote?.emailSent),
        whatsappSent: false,
      },
    };
  }

  if (!rawSa) {
    return {
      status: 503,
      body: {
        ok: false,
        driveUrl: null,
        duplicate: false,
        sheet: targetSheet,
        emailTo,
        emailSent: false,
        whatsappSent: false,
        error:
          "הסנכרון בשרת אינו מוגדר: יש להגדיר GOOGLE_SERVICE_ACCOUNT_JSON או כתובת Apps Script",
      },
    };
  }

  const existingPromise = inflightPromises.get(payload.key);
  if (existingPromise) {
    return await existingPromise;
  }

  const work = (async (): Promise<{ status: number; body: SyncResult }> => {
    try {
      const creds = JSON.parse(rawSa) as ServiceAccountCreds;
      if (!creds.client_email || !creds.private_key) {
        throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON missing client_email or private_key");
      }

      const token = await getGoogleAccessToken(creds, [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/spreadsheets",
      ]);
      const oauthClientId = readEnv("GOOGLE_OAUTH_CLIENT_ID", runtimeEnv);
      const oauthClientSecret = readEnv("GOOGLE_OAUTH_CLIENT_SECRET", runtimeEnv);
      const oauthRefreshToken = readEnv("GOOGLE_OAUTH_REFRESH_TOKEN", runtimeEnv);
      const driveToken =
        oauthClientId && oauthClientSecret && oauthRefreshToken
          ? await getUserOAuthAccessToken(oauthClientId, oauthClientSecret, oauthRefreshToken)
          : token;

      const sheetId = readEnv("SHEET_ID_MAIN", runtimeEnv) || SHEET_ID_MAIN;
      await ensureSheetTabExists(token, sheetId, targetSheet);
      if (payload.kind === "tacho") {
        await ensureSheetTabExists(token, sheetId, TAB_TACHO_TECHNO);
      }

      const dedupColIndex0 = payload.kind === "tacho" ? TACHO_KEY_INDEX_0 : 0;
      const existing = await findExistingRowByKey(
        token,
        sheetId,
        targetSheet,
        payload.key,
        dedupColIndex0,
      );
      if (existing.exists) {
        return {
          status: 200,
          body: {
            ok: true,
            driveUrl: existing.existingDriveUrl ?? null,
            duplicate: true,
            sheet: targetSheet,
            emailTo,
            emailSent: false,
            whatsappSent: false,
          },
        };
      }

      let driveUrl: string | null = null;
      let attachment: { fileName: string; base64: string } | undefined;

      const mediaSource = payload.pdf || payload.photo || payload.payment?.receipt;
      if (mediaSource) {
        const isPdf = Boolean(payload.pdf);
        const fallbackMime = isPdf ? "application/pdf" : "image/jpeg";
        const fileData = parseDataUri(mediaSource, fallbackMime);
        const fileName =
          payload.fileName ||
          `${payload.kind}_${payload.truck}_${jerusalemDate()}.${isPdf ? "pdf" : "jpg"}`;
        const configuredFolderId = readEnv("DRIVE_FOLDER_ID", runtimeEnv);

        if (driveAppsScriptUrl) {
          const uploaded = await uploadDriveFile(
            {
              fileName,
              mimeType: fileData.mimeType,
              base64: fileData.base64,
              folder: payload.folder || DRIVE_FOLDER,
              ...(configuredFolderId ? { folderId: configuredFolderId } : {}),
            },
            runtimeEnv,
          );
          if (!uploaded.ok || !uploaded.driveUrl) {
            throw new Error(uploaded.error || "העלאת הקובץ ל-Drive דרך Apps Script נכשלה");
          }
          driveUrl = uploaded.driveUrl;
        } else {
          const folderId = await resolveOrCreateDriveFolder(
            driveToken,
            payload.folder || DRIVE_FOLDER,
            configuredFolderId,
          );
          const uploaded = await uploadFileToDrive(
            driveToken,
            fileName,
            fileData.mimeType,
            fileData.bytes,
            folderId,
          );
          driveUrl = uploaded.driveUrl;
        }
        attachment = { fileName, base64: fileData.base64 };
      }

      const row = buildSheetRow(payload, driveUrl, emailTo);
      await appendSheetRow(token, sheetId, targetSheet, row);

      // Tacho double-write into "טכנו" (dedup by column P)
      if (payload.kind === "tacho") {
        const existingDup = await findExistingRowByKey(
          token,
          sheetId,
          TAB_TACHO_TECHNO,
          payload.key,
          TACHO_KEY_INDEX_0,
        );
        if (!existingDup.exists) {
          await appendSheetRow(token, sheetId, TAB_TACHO_TECHNO, row);
        }
      }

      let emailSent = false;
      let emailError: string | undefined;
      if (payload.kind === "pod" || payload.kind === "tacho") {
        const copy = buildNotificationCopy(payload, driver, driveUrl);
        const shouldAttach = payload.kind === "pod" || !driveUrl;
        try {
          emailSent = await sendResendEmail(runtimeEnv, {
            to: emailTo,
            subject: copy.subject,
            text: copy.text,
            ...(shouldAttach && attachment ? { attachment } : {}),
          });
        } catch (err) {
          emailError = err instanceof Error ? err.message : String(err);
          console.error("[/api/sync] Resend email failed:", emailError);
        }
      }

      return {
        status: 200,
        body: {
          ok: true,
          driveUrl,
          duplicate: false,
          sheet: targetSheet,
          emailTo,
          emailSent,
          ...(emailError ? { emailError } : {}),
          whatsappSent: false,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[/api/sync] failed:", {
        kind: payload.kind,
        key: payload.key,
        sheet: targetSheet,
        error: message,
      });
      return {
        status: 502,
        body: {
          ok: false,
          driveUrl: null,
          duplicate: false,
          sheet: targetSheet,
          emailTo,
          emailSent: false,
          whatsappSent: false,
          error: message,
        },
      };
    } finally {
      inflightPromises.delete(payload.key);
    }
  })();

  inflightPromises.set(payload.key, work);
  return await work;
}

export interface SyncDiagnostics {
  ok: boolean;
  serviceAccount: {
    configured: boolean;
    parseError?: string;
    projectId?: string;
    clientEmail?: string;
    oauthTokenOk: boolean;
    oauthError?: string;
  };
  sheets: {
    sheetId: string;
    readOk: boolean;
    title?: string;
    tabs?: string[];
    error?: string;
  };
  drive: {
    folderIdConfigured: boolean;
    folderName: string;
    accessOk: boolean;
    folderFound?: boolean;
    isSharedDrive?: boolean;
    driveAppsScriptConfigured?: boolean;
    error?: string;
  };
  notifications: {
    emailProvider: "resend" | "none";
    emailFrom: string;
    oneSignalConfigured: boolean;
    whatsappConfigured: boolean;
    managerOverrideConfigured: boolean;
  };
}

export async function getSyncDiagnostics(runtimeEnv?: SyncEnv): Promise<SyncDiagnostics> {
  const sheetId = readEnv("SHEET_ID_MAIN", runtimeEnv) || SHEET_ID_MAIN;
  const folderId = readEnv("DRIVE_FOLDER_ID", runtimeEnv);
  const emailProvider: SyncDiagnostics["notifications"]["emailProvider"] = readEnv(
    "RESEND_API_KEY",
    runtimeEnv,
  )
    ? "resend"
    : "none";

  const out: SyncDiagnostics = {
    ok: false,
    serviceAccount: {
      configured: false,
      oauthTokenOk: false,
    },
    sheets: {
      sheetId,
      readOk: false,
    },
    drive: {
      folderIdConfigured: Boolean(folderId),
      folderName: DRIVE_FOLDER,
      accessOk: false,
      driveAppsScriptConfigured: Boolean(getDriveAppsScriptUrl(runtimeEnv)),
    },
    notifications: {
      emailProvider,
      emailFrom: readEnv("EMAIL_FROM", runtimeEnv) || DEFAULT_EMAIL_FROM,
      oneSignalConfigured: Boolean(
        (readEnv("ONESIGNAL_APP_ID", runtimeEnv) || readEnv("VITE_ONESIGNAL_APP_ID", runtimeEnv)) &&
        readEnv("ONESIGNAL_REST_API_KEY", runtimeEnv),
      ),
      whatsappConfigured: false,
      managerOverrideConfigured: Boolean(readEnv("MANAGER_OVERRIDE_CODE", runtimeEnv)),
    },
  };

  const rawSa = readEnv("GOOGLE_SERVICE_ACCOUNT_JSON", runtimeEnv);
  if (!rawSa) return out;

  out.serviceAccount.configured = true;
  let creds: ServiceAccountCreds;
  try {
    creds = JSON.parse(rawSa) as ServiceAccountCreds;
    if (creds.project_id) out.serviceAccount.projectId = creds.project_id;
    if (creds.client_email) out.serviceAccount.clientEmail = creds.client_email;
    if (!creds.client_email || !creds.private_key) {
      out.serviceAccount.parseError = "Missing client_email or private_key";
      return out;
    }
  } catch (e) {
    out.serviceAccount.parseError = e instanceof Error ? e.message : String(e);
    return out;
  }

  let token: string;
  try {
    token = await getGoogleAccessToken(creds, [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/spreadsheets",
    ]);
    out.serviceAccount.oauthTokenOk = true;
  } catch (e) {
    out.serviceAccount.oauthError = e instanceof Error ? e.message : String(e);
    return out;
  }

  try {
    const metaRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}?fields=properties.title,sheets.properties.title`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!metaRes.ok) {
      out.sheets.error = `HTTP ${metaRes.status}: ${await metaRes.text()}`;
    } else {
      const meta = (await metaRes.json()) as {
        properties?: { title?: string };
        sheets?: Array<{ properties?: { title?: string } }>;
      };
      out.sheets.readOk = true;
      if (meta.properties?.title) out.sheets.title = meta.properties.title;
      out.sheets.tabs = (meta.sheets ?? [])
        .map((s) => s.properties?.title)
        .filter((t): t is string => Boolean(t));
    }
  } catch (e) {
    out.sheets.error = e instanceof Error ? e.message : String(e);
  }

  try {
    if (folderId) {
      const fRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name,driveId,capabilities(canAddChildren)&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!fRes.ok) {
        out.drive.error = `HTTP ${fRes.status}: ${await fRes.text()}`;
      } else {
        const fData = (await fRes.json()) as {
          name?: string;
          driveId?: string;
          capabilities?: { canAddChildren?: boolean };
        };
        out.drive.accessOk = true;
        out.drive.folderFound = true;
        out.drive.isSharedDrive = Boolean(fData.driveId);
        if (fData.name) out.drive.folderName = fData.name;
        const hasOAuthDrive = Boolean(
          readEnv("GOOGLE_OAUTH_CLIENT_ID", runtimeEnv) &&
          readEnv("GOOGLE_OAUTH_CLIENT_SECRET", runtimeEnv) &&
          readEnv("GOOGLE_OAUTH_REFRESH_TOKEN", runtimeEnv),
        );
        const hasAppsScript = Boolean(getDriveAppsScriptUrl(runtimeEnv));
        if (fData.capabilities?.canAddChildren === false && !hasAppsScript) {
          out.drive.error =
            "Service Account lacks write permission (canAddChildren=false) on DRIVE_FOLDER_ID";
        } else if (!fData.driveId && !hasOAuthDrive && !hasAppsScript) {
          out.drive.error =
            "DRIVE_FOLDER_ID is in My Drive (not a Shared Drive). Service Accounts have 0 GB storage quota; move folder to a Shared Drive, set GOOGLE_OAUTH_* refresh token, or deploy apps-script/Code.gs.";
        }
      }
    } else {
      const q = `mimeType = 'application/vnd.google-apps.folder' and name = '${DRIVE_FOLDER.replace(/'/g, "\\'")}' and trashed = false`;
      const lRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,capabilities(canAddChildren))&supportsAllDrives=true&includeItemsFromAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!lRes.ok) {
        out.drive.error = `HTTP ${lRes.status}: ${await lRes.text()}`;
      } else {
        const lData = (await lRes.json()) as {
          files?: Array<{ id: string; capabilities?: { canAddChildren?: boolean } }>;
        };
        out.drive.accessOk = true;
        out.drive.folderFound = Boolean(lData.files && lData.files.length > 0);
      }
    }
  } catch (e) {
    out.drive.error = e instanceof Error ? e.message : String(e);
  }

  out.ok = out.serviceAccount.oauthTokenOk && out.sheets.readOk && out.drive.accessOk;
  return out;
}

export async function handleSyncRequest(request: Request, runtimeEnv?: SyncEnv): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method Not Allowed" }, { status: 405 });
  }

  let body: unknown;
  try {
    const rawText = await request.text();
    body = JSON.parse(rawText);
  } catch {
    return Response.json({ ok: false, error: "גוף JSON לא תקין" }, { status: 400 });
  }

  if (body && typeof body === "object" && !Array.isArray(body)) {
    const kind = (body as { kind?: unknown }).kind;
    if (kind === "orders_list") {
      try {
        const reqObj = body as { truck?: string; date?: string };
        const ordersRes = await fetchOrdersFromSheet(
          {
            truck: typeof reqObj.truck === "string" ? reqObj.truck : "",
            ...(typeof reqObj.date === "string" ? { date: reqObj.date } : {}),
          },
          runtimeEnv,
        );
        return Response.json(ordersRes, { status: 200 });
      } catch (err) {
        return Response.json(
          {
            ok: false,
            orders: [],
            error: err instanceof Error ? err.message : String(err),
          },
          { status: 502 },
        );
      }
    }

    if (kind === "notify_order") {
      const reqObj = body as {
        truck?: string;
        orderId?: string;
        customerName?: string;
        address?: string;
        time?: string;
        supplyDate?: string;
      };
      if (!reqObj.truck || !reqObj.orderId) {
        return Response.json(
          { ok: false, error: "חסרים שדות חובה להתראה (truck, orderId)" },
          { status: 400 },
        );
      }
      const pushRes = await sendOrderPush(
        reqObj.truck,
        {
          orderId: reqObj.orderId,
          customerName: reqObj.customerName ?? "",
          truck: reqObj.truck,
          ...(reqObj.address ? { address: reqObj.address } : {}),
          ...(reqObj.time ? { time: reqObj.time } : {}),
          ...(reqObj.supplyDate ? { supplyDate: reqObj.supplyDate } : {}),
        },
        runtimeEnv,
      );
      return Response.json(pushRes, { status: pushRes.ok || pushRes.skipped ? 200 : 502 });
    }
  }

  const result = await processSyncPayload(body, runtimeEnv);
  return Response.json(result.body, { status: result.status });
}
