import { pendingSorted, updateItem } from "./db";

/**
 * Drains the offline queue in priority order (POD → tacho → crane/deposits → GPS).
 * Phase 1: endpoint is VITE_SYNC_ENDPOINT (e.g. existing Apps Script web app). If unset, items stay pending.
 */
let running = false;
export async function drainQueue(): Promise<{ sent: number; left: number }> {
  if (running || typeof navigator === "undefined" || !navigator.onLine) return { sent: 0, left: (await pendingSorted()).length };
  const endpoint = import.meta.env["VITE_SYNC_ENDPOINT"] as string | undefined;
  running = true; let sent = 0;
  try {
    const items = await pendingSorted();
    if (!endpoint) return { sent: 0, left: items.length };
    for (const it of items) {
      try {
        const r = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ kind: it.kind, key: it.key, ...it.payload }) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        it.status = "done"; sent++;
      } catch (e) {
        it.attempts++; it.error = String(e); await updateItem(it); break; // stop on failure, retry later in order
      }
      await updateItem(it);
    }
    return { sent, left: (await pendingSorted()).length };
  } finally { running = false; }
}

export function startSyncLoop() {
  const run = () => void drainQueue();
  window.addEventListener("online", run);
  const t = setInterval(run, 30_000);
  run();
  return () => { window.removeEventListener("online", run); clearInterval(t); };
}
