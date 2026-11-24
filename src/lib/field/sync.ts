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

/**
 * Drains the offline queue in priority order (POD → tacho → crane/deposits → GPS).
 * Retries failed network or server responses with exponential backoff, and retries immediately on reconnect.
 */
let running = false;
export async function drainQueue(force = false): Promise<{ sent: number; left: number }> {
  if (running || typeof navigator === "undefined" || !navigator.onLine) {
    return { sent: 0, left: (await pendingSorted()).length };
  }
  const endpoint = getSyncEndpoint();
  running = true;
  let sent = 0;
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
          throw new Error(data?.error || `HTTP ${r.status}`);
        }
        it.status = "done";
        it.syncedAt = Date.now();
        if (data?.driveUrl) it.driveUrl = data.driveUrl;
        delete it.error;
        delete it.nextRetryAt;
        sent++;
        await updateItem(it);
      } catch (e) {
        it.attempts++;
        it.lastAttemptAt = Date.now();
        it.nextRetryAt = it.lastAttemptAt + computeBackoffMs(it.attempts);
        it.error = e instanceof Error ? e.message : String(e);
        await updateItem(it);
        break; // preserve priority order, retry on next tick or online event
      } finally {
        clearTimeout(timer);
      }
    }
    return { sent, left: (await pendingSorted()).length };
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
