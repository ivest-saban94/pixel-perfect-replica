import { openDB, type IDBPDatabase } from "idb";

/** Sync priority: lower uploads first */
export const PRIORITY = { pod: 1, tacho: 2, crane: 3, deposit: 3, gps: 4 } as const;
export type QueueKind = keyof typeof PRIORITY;

export interface QueueItem {
  id?: number; kind: QueueKind; priority: number; key: string;
  payload: Record<string, unknown>; createdAt: number; status: "pending" | "done" | "error"; attempts: number; error?: string;
}
export interface DayState {
  date: string; truck: string; openOdo: number; openPhoto: string; openAt: number;
  closeOdo?: number; closePhoto?: string; closeAt?: number;
}

let dbp: Promise<IDBPDatabase> | null = null;
export function db() {
  if (!dbp) dbp = openDB("saban-field", 1, {
    upgrade(d) {
      const q = d.createObjectStore("queue", { keyPath: "id", autoIncrement: true });
      q.createIndex("status", "status");
      q.createIndex("key", "key", { unique: true });
      d.createObjectStore("kv");
    },
  });
  return dbp;
}
export async function kvGet<T>(k: string) { return (await (await db()).get("kv", k)) as T | undefined; }
export async function kvSet(k: string, v: unknown) { await (await db()).put("kv", v, k); }

export async function enqueue(kind: QueueKind, key: string, payload: Record<string, unknown>) {
  const d = await db();
  const exists = await d.getFromIndex("queue", "key", key);
  if (exists) return exists.id as number; // dedupe by unique key
  return (await d.add("queue", { kind, key, payload, priority: PRIORITY[kind], createdAt: Date.now(), status: "pending", attempts: 0 } satisfies QueueItem)) as number;
}
export async function allItems(): Promise<QueueItem[]> { return (await db()).getAll("queue"); }
export async function pendingSorted(): Promise<QueueItem[]> {
  const items = await (await db()).getAllFromIndex("queue", "status", "pending");
  return items.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
}
export async function updateItem(item: QueueItem) { await (await db()).put("queue", item); }
