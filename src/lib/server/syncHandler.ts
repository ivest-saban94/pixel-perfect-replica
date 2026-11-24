import { z } from "zod";
import {
  DRIVE_FOLDER,
  SHEET_ID_MAIN,
  driverNameForTruck,
  emailForTruck,
  jerusalemDate,
  jerusalemTime,
  overWeight,
  type TruckId,
} from "@/lib/field/config";

export interface SyncEnv {
  [key: string]: string | undefined;
}

const VALID_SHEETS = new Set([
  "ארכיון_תעודות_גליה",
  "ארכיון_טכוגרף",
  "סשנים_PTO",
  "אתרי_לקוחות",
  "היסטוריית_ביקורים",
]);

const SyncPayloadSchema = z
  .object({
    kind: z.enum(["pod", "tacho", "crane", "deposit", "gps"]),
    key: z.string().trim().min(1).max(200),
    truck: z.string().trim().min(1).max(40),
    driver: z.string().trim().max(120).optional(),
    sheet: z.string().trim().max(80).optional(),
    sheetId: z.string().trim().max(120).optional(),
    docNumber: z.string().trim().max(80).nullable().optional(),
    customer: z.string().trim().max(200).optional(),
    tons: z.number().finite().nonnegative().nullable().optional(),
    overrideCode: z.string().trim().max(40).nullable().optional(),
    fileName: z.string().trim().max(200).optional(),
    folder: z.string().trim().max(120).optional(),
    pdf: z.string().max(25_000_000).optional(),
    photo: z.string().max(15_000_000).optional(),
    type: z.enum(["open", "close"]).optional(),
    odometer: z.number().finite().nonnegative().optional(),
    km: z.number().finite().nonnegative().nullable().optional(),
    mode: z.enum(["timer", "ocr"]).optional(),
    start: z.number().finite().optional(),
    end: z.number().finite().optional(),
    seconds: z.number().finite().nonnegative().optional(),
    startGps: z.array(z.number().nullable().optional()).max(2).optional(),
    endGps: z.array(z.number().nullable().optional()).max(2).nullable().optional(),
    items: z.record(z.string(), z.number().finite().nonnegative()).optional(),
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
  whatsappSent: boolean;
  error?: string;
}

interface ServiceAccountCreds {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const tokenCache = new Map<string, { token: string; exp: number }>();
const inflightKeys = new Set<string>();

function readEnv(name: string, runtimeEnv?: SyncEnv): string | undefined {
  const fromRuntime = runtimeEnv?.[name];
  if (typeof fromRuntime === "string" && fromRuntime.trim() !== "") return fromRuntime.trim();
  const fromProcess = typeof process !== "undefined" ? process.env[name] : undefined;
  if (typeof fromProcess === "string" && fromProcess.trim() !== "") return fromProcess.trim();
  return undefined;
}

export function resolveSheetTab(payload: SyncPayload): string {
  if (payload.sheet && VALID_SHEETS.has(payload.sheet)) return payload.sheet;
  switch (payload.kind) {
    case "pod":
      return "ארכיון_תעודות_גליה";
    case "tacho":
      return "ארכיון_טכוגרף";
    case "crane":
      return "סשנים_PTO";
    case "gps":
      return "אתרי_לקוחות";
    case "deposit":
      return "אתרי_לקוחות";
  }
}

export function validateSafeWebhookUrl(rawUrl: string): URL {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Webhook URL must use http or https");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host === "169.254.169.254" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    throw new Error("Webhook URL targets a restricted network address");
  }
  return parsed;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function utf8ToBase64Url(str: string): string {
  return bytesToBase64Url(new TextEncoder().encode(str));
}

function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/\s+/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
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

async function getGoogleAccessToken(
  creds: ServiceAccountCreds,
  scopes: string[],
  subjectEmail?: string,
): Promise<string> {
  const cacheKey = `${creds.client_email}|${scopes.join(" ")}|${subjectEmail ?? ""}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.exp > nowSec + 60) return cached.token;

  const pem = creds.private_key
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const keyBytes = base64ToBytes(pem);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes.buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const tokenUri = creds.token_uri || "https://oauth2.googleapis.com/token";
  const header = utf8ToBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claimSet: Record<string, unknown> = {
    iss: creds.client_email,
    scope: scopes.join(" "),
    aud: tokenUri,
    iat: nowSec,
    exp: nowSec + 3600,
  };
  if (subjectEmail) claimSet["sub"] = subjectEmail;

  const signingInput = `${header}.${utf8ToBase64Url(JSON.stringify(claimSet))}`;
  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );
  const assertion = `${signingInput}.${bytesToBase64Url(new Uint8Array(sigBuf))}`;

  const tokenRes = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(
      `Google OAuth token exchange failed (${tokenRes.status}): ${await tokenRes.text()}`,
    );
  }
  const tokenJson = (await tokenRes.json()) as { access_token: string; expires_in?: number };
  tokenCache.set(cacheKey, {
    token: tokenJson.access_token,
    exp: nowSec + (tokenJson.expires_in ?? 3600),
  });
  return tokenJson.access_token;
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
  const matchRow = (data.values ?? []).find((row) => row[0] === key);
  if (!matchRow) return { exists: false };
  const urlCell = matchRow.find(
    (cell) => typeof cell === "string" && cell.startsWith("https://drive.google.com/"),
  );
  return urlCell ? { exists: true, existingDriveUrl: urlCell } : { exists: true };
}

function buildSheetRow(
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
    case "tacho":
      return [
        payload.key,
        dateStr,
        timeStr,
        payload.truck,
        driver,
        payload.type ?? "",
        payload.odometer ?? "",
        payload.km ?? "",
        driveUrl ?? "",
        emailTo,
      ];
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

function buildNotificationCopy(
  payload: SyncPayload,
  driver: string,
  driveUrl: string | null,
): { subject: string; text: string } {
  if (payload.kind === "tacho") {
    const phase = payload.type === "open" ? "פתיחת יום" : "סגירת יום";
    const subject = `טכוגרף ${phase} · משאית ${payload.truck} (${driver})`;
    const text = [
      `⏱ טכוגרף ${phase}`,
      `🚚 משאית: ${payload.truck} (${driver})`,
      `🔢 מד אוץ: ${payload.odometer ?? "—"}${payload.km != null ? ` | ק״מ היום: ${payload.km}` : ""}`,
      driveUrl ? `🔗 קישור לדרייב: ${driveUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return { subject, text };
  }

  const subject =
    `תעודת משלוח ${payload.docNumber ?? ""} · ${payload.customer ?? ""} · ${driver}`.trim();
  const text = [
    `📄 תעודת משלוח: ${payload.docNumber ?? "—"}${payload.customer ? ` | לקוח: ${payload.customer}` : ""}`,
    `🚚 משאית: ${payload.truck} (${driver})`,
    payload.tons != null ? `⚖️ משקל: ${payload.tons} טון` : "",
    driveUrl ? `🔗 קישור לדרייב: ${driveUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { subject, text };
}

function buildMimeEmailWithAttachment(opts: {
  from: string;
  to: string;
  subject: string;
  text: string;
  attachment?: { fileName: string; mimeType: string; base64: string };
}): string {
  const encodedSubject = `=?UTF-8?B?${bytesToBase64(new TextEncoder().encode(opts.subject))}?=`;
  if (!opts.attachment) {
    return [
      `From: ${opts.from}`,
      `To: ${opts.to}`,
      `Subject: ${encodedSubject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      opts.text,
    ].join("\r\n");
  }

  const boundary = `saban_mail_${crypto.randomUUID()}`;
  return [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    opts.text,
    "",
    `--${boundary}`,
    `Content-Type: ${opts.attachment.mimeType}; name="${opts.attachment.fileName}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${opts.attachment.fileName}"`,
    "",
    opts.attachment.base64,
    `--${boundary}--`,
  ].join("\r\n");
}

async function sendEmailNotification(
  creds: ServiceAccountCreds,
  env: SyncEnv | undefined,
  opts: {
    to: string;
    subject: string;
    text: string;
    driveUrl: string | null;
    attachment?: { fileName: string; mimeType: string; base64: string };
  },
): Promise<boolean> {
  const resendKey = readEnv("RESEND_API_KEY", env);
  if (resendKey) {
    const from = readEnv("EMAIL_FROM", env) || "סבן שטח <noreply@saban94.co.il>";
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
    if (!res.ok) throw new Error(`Resend email failed (${res.status}): ${await res.text()}`);
    return true;
  }

  const emailWebhook = readEnv("EMAIL_WEBHOOK_URL", env);
  if (emailWebhook) {
    const safeUrl = validateSafeWebhookUrl(emailWebhook);
    const secret = readEnv("EMAIL_WEBHOOK_SECRET", env);
    const res = await fetch(safeUrl.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify({
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
        driveUrl: opts.driveUrl,
        ...(opts.attachment ? { attachment: opts.attachment } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Email webhook failed (${res.status}): ${await res.text()}`);
    return true;
  }

  const gmailSender = readEnv("GMAIL_SENDER_EMAIL", env);
  if (gmailSender) {
    const gmailToken = await getGoogleAccessToken(
      creds,
      ["https://www.googleapis.com/auth/gmail.send"],
      gmailSender,
    );
    const rawMime = buildMimeEmailWithAttachment({
      from: gmailSender,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      ...(opts.attachment ? { attachment: opts.attachment } : {}),
    });
    const raw = utf8ToBase64Url(rawMime);
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${gmailToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) throw new Error(`Gmail API send failed (${res.status}): ${await res.text()}`);
    return true;
  }

  return false;
}

async function sendWhatsAppWebhook(
  env: SyncEnv | undefined,
  opts: {
    message: string;
    docNumber: string | null | undefined;
    driver: string;
    truck: string;
    driveUrl: string | null;
  },
): Promise<boolean> {
  const webhookUrl = readEnv("WHATSAPP_WEBHOOK_URL", env);
  if (!webhookUrl) return false;
  const safeUrl = validateSafeWebhookUrl(webhookUrl);
  const token = readEnv("WHATSAPP_WEBHOOK_TOKEN", env);
  const groupId = readEnv("WHATSAPP_GROUP_ID", env) || "עדכונים מהסידור";

  const res = await fetch(safeUrl.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      groupId,
      chatName: "עדכונים מהסידור",
      message: opts.message,
      docNumber: opts.docNumber ?? null,
      driver: opts.driver,
      truck: opts.truck,
      driveUrl: opts.driveUrl,
    }),
  });
  if (!res.ok) {
    throw new Error(`WhatsApp webhook failed (${res.status}): ${await res.text()}`);
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
        error: `Invalid payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
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
          "Server sync not configured: set GOOGLE_SERVICE_ACCOUNT_JSON or deploy Apps Script and set VITE_SYNC_ENDPOINT",
      },
    };
  }

  if (inflightKeys.has(payload.key)) {
    return {
      status: 409,
      body: {
        ok: false,
        driveUrl: null,
        duplicate: false,
        sheet: targetSheet,
        emailTo,
        emailSent: false,
        whatsappSent: false,
        error: "Sync for this key is already in progress",
      },
    };
  }

  inflightKeys.add(payload.key);
  try {
    const creds = JSON.parse(rawSa) as ServiceAccountCreds;
    if (!creds.client_email || !creds.private_key) {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON missing client_email or private_key");
    }

    const token = await getGoogleAccessToken(creds, [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/spreadsheets",
    ]);

    const sheetId = readEnv("SHEET_ID_MAIN", runtimeEnv) || SHEET_ID_MAIN;
    await ensureSheetTabExists(token, sheetId, targetSheet);

    const existing = await findExistingRowByKey(token, sheetId, targetSheet, payload.key);
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
    let attachment: { fileName: string; mimeType: string; base64: string } | undefined;

    const mediaSource = payload.pdf || payload.photo || payload.payment?.receipt;
    if (mediaSource) {
      const isPdf = Boolean(payload.pdf);
      const fallbackMime = isPdf ? "application/pdf" : "image/jpeg";
      const fileData = parseDataUri(mediaSource, fallbackMime);
      const fileName =
        payload.fileName ||
        `${payload.kind}_${payload.truck}_${jerusalemDate()}.${isPdf ? "pdf" : "jpg"}`;
      const folderId = await resolveOrCreateDriveFolder(
        token,
        payload.folder || DRIVE_FOLDER,
        readEnv("DRIVE_FOLDER_ID", runtimeEnv),
      );
      const uploaded = await uploadFileToDrive(
        token,
        fileName,
        fileData.mimeType,
        fileData.bytes,
        folderId,
      );
      driveUrl = uploaded.driveUrl;
      attachment = { fileName, mimeType: fileData.mimeType, base64: fileData.base64 };
    }

    const row = buildSheetRow(payload, driveUrl, emailTo);
    await appendSheetRow(token, sheetId, targetSheet, row);

    const copy = buildNotificationCopy(payload, driver, driveUrl);
    let emailSent = false;
    if (payload.kind === "pod" || payload.kind === "tacho" || payload.notify?.email) {
      emailSent = await sendEmailNotification(creds, runtimeEnv, {
        to: emailTo,
        subject: copy.subject,
        text: copy.text,
        driveUrl,
        ...(attachment ? { attachment } : {}),
      });
    }

    let whatsappSent = false;
    if (payload.notify?.whatsapp && (payload.kind === "pod" || payload.kind === "tacho")) {
      whatsappSent = await sendWhatsAppWebhook(runtimeEnv, {
        message: copy.text,
        docNumber: payload.docNumber,
        driver,
        truck: payload.truck,
        driveUrl,
      });
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
        whatsappSent,
      },
    };
  } catch (err) {
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
        error: err instanceof Error ? err.message : String(err),
      },
    };
  } finally {
    inflightKeys.delete(payload.key);
  }
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
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const result = await processSyncPayload(body, runtimeEnv);
  return Response.json(result.body, { status: result.status });
}
