/**
 * Hybrid Drive upload bridge (Strategy B).
 *
 * Strategy overview:
 * - Strategy A (Full Apps Script): set VITE_SYNC_ENDPOINT to the Apps Script Web App URL.
 *   The browser sends queue items directly to Apps Script without hitting /api/sync.
 * - Strategy B (Hybrid — used here when DRIVE_APPS_SCRIPT_URL or APPS_SCRIPT_URL is set alongside
 *   GOOGLE_SERVICE_ACCOUNT_JSON): /api/sync keeps Sheets (Service Account) + Resend email, and
 *   delegates media upload to Apps Script (`kind: "drive_upload"`) so files use the script owner's
 *   My Drive storage quota instead of hitting Service Account 403 storageQuotaExceeded.
 */

export interface DriveEnv {
  [key: string]: string | undefined;
}

export interface DriveUploadPayload {
  fileName: string;
  mimeType: string;
  base64: string;
  folderId?: string;
  folder?: string;
}

export interface DriveUploadResult {
  ok: boolean;
  driveUrl: string | null;
  fileId?: string;
  error?: string;
}

const DRIVE_UPLOAD_TIMEOUT_MS = 30_000;

function readEnvVar(name: string, runtimeEnv?: DriveEnv): string | undefined {
  const fromRuntime = runtimeEnv?.[name];
  if (typeof fromRuntime === "string" && fromRuntime.trim() !== "") return fromRuntime.trim();
  const fromProcess = typeof process !== "undefined" ? process.env[name] : undefined;
  if (typeof fromProcess === "string" && fromProcess.trim() !== "") return fromProcess.trim();
  return undefined;
}

export function validateSafeWebhookUrl(rawUrl: string): URL {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("URL must use http or https");
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
    throw new Error("URL targets a restricted network address");
  }
  return parsed;
}

/**
 * Resolves the Apps Script Web App URL configured for Drive uploads.
 * Ignores relative paths (e.g. "/api/sync") so the server never calls itself recursively.
 */
export function getDriveAppsScriptUrl(runtimeEnv?: DriveEnv): string | undefined {
  const candidates = [
    readEnvVar("DRIVE_APPS_SCRIPT_URL", runtimeEnv),
    readEnvVar("APPS_SCRIPT_URL", runtimeEnv),
    readEnvVar("VITE_SYNC_ENDPOINT", runtimeEnv),
  ];
  for (const candidate of candidates) {
    if (candidate && (candidate.startsWith("https://") || candidate.startsWith("http://"))) {
      return candidate;
    }
  }
  return undefined;
}

export async function uploadDriveFile(
  payload: DriveUploadPayload,
  runtimeEnv?: DriveEnv,
): Promise<DriveUploadResult> {
  const endpoint = getDriveAppsScriptUrl(runtimeEnv);
  if (!endpoint) {
    return {
      ok: false,
      driveUrl: null,
      error: "לא הוגדר APPS_SCRIPT_URL / DRIVE_APPS_SCRIPT_URL להעלאת קבצים ל-Drive",
    };
  }

  let safeUrl: URL;
  try {
    safeUrl = validateSafeWebhookUrl(endpoint);
  } catch (err) {
    return {
      ok: false,
      driveUrl: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DRIVE_UPLOAD_TIMEOUT_MS);

  try {
    const res = await fetch(safeUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      redirect: "follow",
      body: JSON.stringify({
        kind: "drive_upload",
        fileName: payload.fileName,
        mimeType: payload.mimeType,
        base64: payload.base64,
        ...(payload.folderId ? { folderId: payload.folderId } : {}),
        ...(payload.folder ? { folder: payload.folder } : {}),
      }),
      signal: controller.signal,
    });

    const text = await res.text();
    let data: { ok?: boolean; driveUrl?: string | null; fileId?: string; error?: string } | null =
      null;
    if (text) {
      try {
        data = JSON.parse(text) as {
          ok?: boolean;
          driveUrl?: string | null;
          fileId?: string;
          error?: string;
        };
      } catch {
        data = null;
      }
    }

    if (!res.ok || !data || data.ok === false || !data.driveUrl) {
      return {
        ok: false,
        driveUrl: null,
        error: data?.error || `Apps Script Drive upload HTTP ${res.status}`,
      };
    }

    return {
      ok: true,
      driveUrl: data.driveUrl,
      ...(data.fileId ? { fileId: data.fileId } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      driveUrl: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export const uploadViaAppsScript = uploadDriveFile;
