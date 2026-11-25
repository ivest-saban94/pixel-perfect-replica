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

export interface NotifyOrderResult {
  ok: boolean;
  sent: boolean;
  duplicate?: boolean;
  skipped?: boolean;
  notificationId?: string;
  dedupKey: string;
  error?: string;
}

// In-memory dedup guard per worker/server instance; OneSignal external_id also deduplicates
const sentOrderNotifications = new Set<string>();

export function buildOrderNotifyKey(orderId: string, truckId: string, date?: string): string {
  const day = (date && date.trim()) || jerusalemDate();
  return `${orderId.trim()}|${truckId.trim()}|${day}`;
}

export function clearSentOrderNotificationsForTest(): void {
  sentOrderNotifications.clear();
}

export async function sendOrderPush(
  truck: string,
  order: OrderPushPayload,
  runtimeEnv?: SyncEnv,
): Promise<NotifyOrderResult> {
  const truckId = resolveTruckIdFromLabel(truck) || truck.trim();
  const dedupKey = buildOrderNotifyKey(order.orderId, truckId, order.supplyDate);

  if (sentOrderNotifications.has(dedupKey)) {
    return { ok: true, sent: false, duplicate: true, dedupKey };
  }

  const appId =
    readEnv("ONESIGNAL_APP_ID", runtimeEnv) || readEnv("VITE_ONESIGNAL_APP_ID", runtimeEnv);
  const restApiKey = readEnv("ONESIGNAL_REST_API_KEY", runtimeEnv);
  if (!appId || !restApiKey) {
    return {
      ok: false,
      sent: false,
      skipped: true,
      dedupKey,
      error: "OneSignal לא מוגדר (חסרים ONESIGNAL_APP_ID / ONESIGNAL_REST_API_KEY)",
    };
  }

  const title = `הזמנה חדשה · ${order.orderId}`;
  const bodyParts = [order.customerName, order.address, order.time]
    .map((p) => (p ?? "").trim())
    .filter(Boolean);
  const bodyText = bodyParts.join(" · ") || "הזמנה חדשה שובצה למשאית שלך";

  const res = await fetch("https://api.onesignal.com/notifications", {
    method: "POST",
    headers: {
      Authorization: `Basic ${restApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      app_id: appId,
      include_external_user_ids: [truckId],
      target_channel: "push",
      idempotency_key: dedupKey,
      headings: { he: title, en: title },
      contents: { he: bodyText, en: bodyText },
      data: {
        type: "order",
        orderId: order.orderId,
        truck: truckId,
        url: `/orders?orderId=${encodeURIComponent(order.orderId)}`,
      },
      priority: 10,
    }),
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

  const json = (await res.json()) as { id?: string };
  sentOrderNotifications.add(dedupKey);
  return {
    ok: true,
    sent: true,
    dedupKey,
    ...(json.id ? { notificationId: json.id } : {}),
  };
}
