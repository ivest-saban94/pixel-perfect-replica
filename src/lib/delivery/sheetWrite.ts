/**
 * Write driver overlay + delivery note data into the main Saban sheet tabs.
 * Uses the same SHEET_ID_MAIN and tab names as field sync.
 */
import {
  SHEET_ID_MAIN,
  TAB_CRANE,
  TAB_DEPOSIT_GPS,
  TAB_POD,
  driverNameForTruck,
  emailForTruck,
  jerusalemDate,
  jerusalemTime,
  uniqueKey,
  type TruckId,
} from "@/lib/field/config";
import { getGoogleAccessToken, readEnv, type ServiceAccountCreds, type SyncEnv } from "@/lib/server/googleAuth";
import { validateSafeWebhookUrl } from "@/lib/server/drive";
import type { OverlayPayload } from "./types";

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

function durationHm(from?: string, to?: string): string {
  if (!from || !to) return "";
  const [h1, m1] = from.split(":").map(Number);
  const [h2, m2] = to.split(":").map(Number);
  if ([h1, m1, h2, m2].some((n) => Number.isNaN(n))) return "";
  let mins = h2! * 60 + m2! - (h1! * 60 + m1!);
  if (mins < 0) mins += 24 * 60;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

export function buildOverlayRow(payload: OverlayPayload): (string | number)[] {
  const now = payload.submittedAt ? new Date(payload.submittedAt) : new Date();
  const truck = payload.truck || "";
  const driver = payload.driver || driverNameForTruck(truck);
  const key = uniqueKey(payload.docNumber || payload.deliveryId, now);

  const craneDur = durationHm(payload.craneOpen, payload.craneClose);
  const waitDur = durationHm(payload.waitFrom, payload.waitUntil);
  const work = payload.craneWork;
  const workDur = work ? durationHm(work.start, work.end) : "";

  return [
    key,
    jerusalemDate(now),
    jerusalemTime(now),
    truck,
    driver,
    payload.docNumber || "",
    payload.customer || "",
    payload.craneOpen || "",
    payload.craneClose || "",
    craneDur,
    payload.waitFrom || "",
    payload.waitUntil || "",
    waitDur,
    work?.type || "",
    work?.workType || "",
    work?.start || "",
    work?.end || "",
    workDur,
    JSON.stringify(payload.depositsAdjust || {}),
    payload.notes || "",
    payload.sourceFileUrl || "",
    payload.submittedAt || now.toISOString(),
  ];
}

async function ensureTabWithHeaders(
  token: string,
  sheetId: string,
  tabName: string,
  headers: string[],
): Promise<void> {
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!metaRes.ok) throw new Error(`Sheets meta failed: ${await metaRes.text()}`);
  const meta = (await metaRes.json()) as { sheets?: Array<{ properties?: { title?: string } }> };
  const exists = meta.sheets?.some((s) => s.properties?.title === tabName);

  if (!exists) {
    const createRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}:batchUpdate`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] }),
      },
    );
    if (!createRes.ok) throw new Error(`Create tab failed: ${await createRes.text()}`);
  }

  // Write headers if first row empty / missing
  const range = `${tabName}!A1:${String.fromCharCode(64 + headers.length)}1`;
  const getRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const getData = getRes.ok ? ((await getRes.json()) as { values?: string[][] }) : { values: [] };
  const first = getData.values?.[0];
  const needsHeader =
    !first || first.every((c) => !String(c || "").trim()) || first[0] !== headers[0];
  if (needsHeader) {
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [headers] }),
      },
    );
  }
}

async function appendRow(
  token: string,
  sheetId: string,
  tabName: string,
  row: (string | number)[],
): Promise<void> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(`${tabName}!A1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [row] }),
    },
  );
  if (!res.ok) throw new Error(`Sheets append failed (${res.status}): ${await res.text()}`);
}

export interface OverlayWriteResult {
  ok: boolean;
  key: string;
  sheet: string;
  emailTo: string;
  duplicate?: boolean;
  error?: string;
}

/**
 * Primary write path for overlay submissions.
 * - Appends full overlay row to a dedicated tab "שכבת_נהג" (or falls back to POD + CRANE + DEPOSIT)
 * - Also mirrors crane session into TAB_CRANE and deposits into TAB_DEPOSIT_GPS when present
 */
export async function writeOverlayToSheet(
  payload: OverlayPayload,
  runtimeEnv?: SyncEnv,
): Promise<OverlayWriteResult> {
  const truck = (payload.truck || "") as TruckId | string;
  const emailTo = emailForTruck(truck);
  const key = uniqueKey(payload.docNumber || payload.deliveryId);
  const tabOverlay = "שכבת_נהג";

  const rawSa = readEnv("GOOGLE_SERVICE_ACCOUNT_JSON", runtimeEnv);
  const appsScriptUrl = readEnv("APPS_SCRIPT_URL", runtimeEnv);
  const sheetId = readEnv("SHEET_ID_MAIN", runtimeEnv) || SHEET_ID_MAIN;

  // Prefer Apps Script proxy when SA is not configured (same as field sync)
  if (!rawSa && appsScriptUrl) {
    const safeUrl = validateSafeWebhookUrl(appsScriptUrl);
    const body = {
      kind: "delivery_overlay",
      key,
      ...payload,
      sheet: tabOverlay,
      sheetId,
    };
    const res = await fetch(safeUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      redirect: "follow",
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let remote: Partial<OverlayWriteResult> = {};
    try {
      remote = JSON.parse(text);
    } catch {
      /* ignore */
    }
    if (!res.ok || remote.ok === false) {
      return {
        ok: false,
        key,
        sheet: tabOverlay,
        emailTo,
        error: remote.error || `Apps Script HTTP ${res.status}`,
      };
    }
    return { ok: true, key, sheet: tabOverlay, emailTo, duplicate: remote.duplicate };
  }

  if (!rawSa) {
    return {
      ok: false,
      key,
      sheet: tabOverlay,
      emailTo,
      error: "חסר GOOGLE_SERVICE_ACCOUNT_JSON או APPS_SCRIPT_URL",
    };
  }

  try {
    const creds = JSON.parse(rawSa) as ServiceAccountCreds;
    const token = await getGoogleAccessToken(creds, [
      "https://www.googleapis.com/auth/spreadsheets",
    ]);

    await ensureTabWithHeaders(token, sheetId, tabOverlay, OVERLAY_HEADERS);
    const row = buildOverlayRow({ ...payload, submittedAt: payload.submittedAt || new Date().toISOString() });
    await appendRow(token, sheetId, tabOverlay, row);

    // Mirror crane session
    if (payload.craneOpen || payload.craneClose || payload.craneWork) {
      const craneRow = [
        key,
        jerusalemDate(),
        jerusalemTime(),
        truck,
        payload.driver || driverNameForTruck(truck),
        "overlay",
        payload.docNumber || "",
        "",
        payload.craneOpen || payload.craneWork?.start || "",
        payload.craneClose || payload.craneWork?.end || "",
        "",
        "",
        "",
      ];
      await appendRow(token, sheetId, TAB_CRANE, craneRow);
    }

    // Mirror deposits
    const dep = payload.depositsAdjust || {};
    if (Object.keys(dep).length > 0) {
      const depRow = [
        key,
        jerusalemDate(),
        jerusalemTime(),
        truck,
        payload.driver || driverNameForTruck(truck),
        payload.docNumber || "",
        JSON.stringify(dep),
        false,
        "",
        "",
        "",
      ];
      await appendRow(token, sheetId, TAB_DEPOSIT_GPS, depRow);
    }

    // Light POD archive line (no PDF required)
    const podRow = [
      key,
      jerusalemDate(),
      jerusalemTime(),
      truck,
      payload.driver || driverNameForTruck(truck),
      payload.docNumber || "",
      payload.customer || "",
      "",
      "",
      "",
      payload.sourceFileUrl || "",
      emailTo,
    ];
    await appendRow(token, sheetId, TAB_POD, podRow);

    return { ok: true, key, sheet: tabOverlay, emailTo };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, key, sheet: tabOverlay, emailTo, error: message };
  }
}
