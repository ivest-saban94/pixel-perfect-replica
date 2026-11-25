import { pendingReady, pendingSorted, updateItem } from "./db";

export interface SyncResponse {
  ok?: boolean;
  driveUrl?: string | null;
  duplicate?: boolean;
  sheet?: string;
  emailSent?: boolean;
  whatsappSent?: boolean;
  error?: string;
}

const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 180_000, 300_000] as const;
const REQUEST_TIMEOUT_MS = 30_000;

export function getSyncEndpoint(): string {
  const configured = (import.meta.env["VITE_SYNC_ENDPOINT"] as string | undefined)?.trim();
  return configured && configured.length > 0 ? configured : "/api/sync";
}

export function computeBackoffMs(attempts: number): number {
  const idx = Math.min(Math.max(0, attempts - 1), BACKOFF_MS.length - 1);
  return BACKOFF_MS[idx] ?? 300_000;
}

/** HTTP status codes that represent permanent rejection (e.g. 403 wrong manager code) rather than transient network failure. */
export function isPermanentRejectionStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403 || status === 404 || status === 422;
}

/**
 * Drains the offline queue in priority order (POD → tacho → crane/deposits → GPS).
 * Permanent rejections (like 403 invalid manager override code) mark the item as "error"
 * and continue draining remaining items instead of blocking the entire queue.
 */
let running = false;
export async function drainQueue(
  force = false,
): Promise<{ sent: number; left: number; errors: number }> {
  if (running || typeof navigator === "undefined" || !navigator.onLine) {
    return { sent: 0, left: (await pendingSorted()).length, errors: 0 };
  }
  const endpoint = getSyncEndpoint();
  running = true;
  let sent = 0;
  let errors = 0;
  try {
    const items = await pendingReady(Date.now(), force);
    for (const it of items) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const r = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify({ kind: it.kind, key: it.key, ...it.payload }),
          signal: controller.signal,
        });
        const text = await r.text();
        let data: SyncResponse | null = null;
        if (text) {
          try {
            data = JSON.parse(text) as SyncResponse;
          } catch {
            data = null;
          }
        }
        if (!r.ok || data?.ok === false) {
          const errMsg = data?.error || `HTTP ${r.status}`;
          if (isPermanentRejectionStatus(r.status)) {
            console.error("[sync] permanent rejection:", it.kind, it.key, r.status, errMsg);
            it.status = "error";
            it.attempts++;
            it.lastAttemptAt = Date.now();
            it.error = errMsg;
            delete it.nextRetryAt;
            await updateItem(it);
            errors++;
            continue;
          }
          throw new Error(errMsg);
        }
        it.status = "done";
        it.syncedAt = Date.now();
        if (data?.driveUrl) it.driveUrl = data.driveUrl;
        delete it.error;
        delete it.nextRetryAt;
        sent++;
        await updateItem(it);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn("[sync] retry queued:", it.kind, it.key, message);
        it.attempts++;
        it.lastAttemptAt = Date.now();
        it.nextRetryAt = it.lastAttemptAt + computeBackoffMs(it.attempts);
        it.error = message;
        await updateItem(it);
        break; // preserve priority order on transient/network errors
      } finally {
        clearTimeout(timer);
      }
    }
    return { sent, left: (await pendingSorted()).length, errors };
  } finally {
    running = false;
  }
}

export function startSyncLoop() {
  const runScheduled = () => void drainQueue(false);
  const runImmediate = () => void drainQueue(true);
  window.addEventListener("online", runImmediate);
  const t = setInterval(runScheduled, 30_000);
  runImmediate();
  return () => {
    window.removeEventListener("online", runImmediate);
    clearInterval(t);
  };
}
