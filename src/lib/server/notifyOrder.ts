import { jerusalemDate, resolveTruckIdFromLabel } from "@/lib/field/config";
import { readEnv, type SyncEnv } from "./googleAuth";

export interface OrderPushPayload {
  orderId: string;
  customerName: string;
  address?: string;
  time?: string;
  supplyDate?: string;
  truck: string;
}

export interface SendOrderPushOptions {
  bypassDedup?: boolean;
  isTest?: boolean;
}

export interface NotifyOrderResult {
  ok: boolean;
  sent: boolean;
  duplicate?: boolean;
  skipped?: boolean;
  notificationId?: string;
  dedupKey: string;
  error?: string;
  details?: unknown;
}

// In-memory dedup guard per worker/server instance; OneSignal idempotency_key also deduplicates
const sentOrderNotifications = new Set<string>();

export function buildOrderNotifyKey(orderId: string, truckId: string, date?: string): string {
  const day = (date && date.trim()) || jerusalemDate();
  return `${orderId.trim()}|${truckId.trim()}|${day}`;
}

/** Formats any string deterministically as a valid UUID v4 for OneSignal idempotency_key. */
export function deterministicIdempotencyUuid(seed: string): string {
  const mix = (init: number, salt: number) => {
    let h = init >>> 0;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i) + ((salt + i) << 5);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  const p1 = mix(0x811c9dc5, 11).toString(16).padStart(8, "0");
  const p2 = (mix(0x9e3779b9, 23) & 0xffff).toString(16).padStart(4, "0");
  const p3 = (0x4000 | (mix(0x85ebca6b, 37) & 0x0fff)).toString(16).padStart(4, "0");
  const p4 = (0x8000 | (mix(0xc2b2ae35, 53) & 0x3fff)).toString(16).padStart(4, "0");
  const p5a = mix(0x27d4eb2f, 71).toString(16).padStart(8, "0");
  const p5b = (mix(0x165667b1, 97) & 0xffff).toString(16).padStart(4, "0");
  return `${p1}-${p2}-${p3}-${p4}-${p5a}${p5b}`;
}

export function buildOneSignalAuthHeader(restApiKey: string): string {
  const clean = restApiKey.trim();
  if (clean.startsWith("os_v2_")) {
    return `Key ${clean}`;
  }
  return `Basic ${clean}`;
}

export function getOneSignalServerConfig(runtimeEnv?: SyncEnv): {
  appId: string | undefined;
  restApiKey: string | undefined;
  configured: boolean;
} {
  const appId =
    readEnv("ONESIGNAL_APP_ID", runtimeEnv) || readEnv("VITE_ONESIGNAL_APP_ID", runtimeEnv);
  const restApiKey =
    readEnv("ONESIGNAL_REST_API_KEY", runtimeEnv) || readEnv("ONESIGNAL_API_KEY", runtimeEnv);
  return {
    appId,
    restApiKey,
    configured: Boolean(appId && restApiKey),
  };
}

export function clearSentOrderNotificationsForTest(): void {
  sentOrderNotifications.clear();
}

export async function sendOrderPush(
  truck: string,
  order: OrderPushPayload,
  runtimeEnv?: SyncEnv,
  options: SendOrderPushOptions = {},
): Promise<NotifyOrderResult> {
  const truckId = resolveTruckIdFromLabel(truck) || truck.trim();
  const dedupKey = buildOrderNotifyKey(order.orderId, truckId, order.supplyDate);

  if (!options.bypassDedup && sentOrderNotifications.has(dedupKey)) {
    return { ok: true, sent: false, duplicate: true, dedupKey };
  }

  const { appId, restApiKey } = getOneSignalServerConfig(runtimeEnv);
  if (!appId || !restApiKey) {
    return {
      ok: false,
      sent: false,
      skipped: true,
      dedupKey,
      error: "OneSignal לא מוגדר (חסרים ONESIGNAL_APP_ID / ONESIGNAL_REST_API_KEY)",
    };
  }

  const title = options.isTest
    ? `בדיקת התראה · סבן שטח (${truckId})`
    : `הזמנה חדשה · ${order.orderId}`;
  const bodyParts = [order.customerName, order.address, order.time]
    .map((p) => (p ?? "").trim())
    .filter(Boolean);
  const bodyText =
    bodyParts.join(" · ") ||
    (options.isTest ? "חיבור OneSignal תקין למשאית הפעילה" : "הזמנה חדשה שובצה למשאית שלך");

  const payload: Record<string, unknown> = {
    app_id: appId,
    include_aliases: { external_id: [truckId] },
    target_channel: "push",
    headings: { en: title, he: title },
    contents: { en: bodyText, he: bodyText },
    chrome_web_icon: "/pwa-192x192.png",
    chrome_web_badge: "/pwa-192x192.png",
    ttl: 3600,
    collapse_id: options.isTest ? `test_${truckId}` : `order_${order.orderId}`,
    data: {
      type: options.isTest ? "test" : "order",
      orderId: order.orderId,
      truck: truckId,
      url: options.isTest ? "/orders" : `/orders?orderId=${encodeURIComponent(order.orderId)}`,
    },
    priority: 10,
  };

  if (!options.bypassDedup) {
    payload["idempotency_key"] = deterministicIdempotencyUuid(dedupKey);
  }

  const res = await fetch("https://api.onesignal.com/notifications", {
    method: "POST",
    headers: {
      Authorization: buildOneSignalAuthHeader(restApiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    return {
      ok: false,
      sent: false,
      dedupKey,
      error: `OneSignal HTTP ${res.status}: ${errText}`,
    };
  }

  const json = (await res.json()) as { id?: string; errors?: unknown };
  const hasErrors = Array.isArray(json.errors)
    ? json.errors.length > 0
    : Boolean(
        json.errors && typeof json.errors === "object" && Object.keys(json.errors).length > 0,
      );

  if (hasErrors || !json.id) {
    return {
      ok: false,
      sent: false,
      dedupKey,
      error: "המשאית טרם נרשמה להתראות בדפדפן (יש ללחוץ על הפעל התראות בטאבלט)",
      details: json.errors ?? json,
    };
  }

  if (!options.bypassDedup) {
    sentOrderNotifications.add(dedupKey);
  }
  return {
    ok: true,
    sent: true,
    dedupKey,
    notificationId: json.id,
  };
}

export async function sendOrderTestPush(
  truck: string,
  runtimeEnv?: SyncEnv,
): Promise<NotifyOrderResult> {
  const truckId = resolveTruckIdFromLabel(truck) || truck.trim();
  return sendOrderPush(
    truckId,
    {
      orderId: `TEST-${Date.now()}`,
      customerName: "בדיקת מערכת סבן שטח",
      address: `משאית ${truckId}`,
      truck: truckId,
    },
    runtimeEnv,
    { bypassDedup: true, isTest: true },
  );
}
