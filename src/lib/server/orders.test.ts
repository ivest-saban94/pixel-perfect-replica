import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchLoadToPod } from "@/lib/field/loadMatch";
import {
  buildOneSignalAuthHeader,
  clearSentOrderNotificationsForTest,
  deterministicIdempotencyUuid,
  sendOrderPush,
  sendOrderTestPush,
} from "./notifyOrder";
import { buildOrdersFromSheetValues, normalizeSheetDate, parseProductsRaw } from "./orders";

describe("orders, load matching, and OneSignal push", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearSentOrderNotificationsForTest();
  });

  it("normalizes various sheet date formats to YYYYMMDD", () => {
    expect(normalizeSheetDate("20261125")).toBe("20261125");
    expect(normalizeSheetDate("25/11/2026")).toBe("20261125");
    expect(normalizeSheetDate("2026-11-25")).toBe("20261125");
  });

  it("parses K productsRaw lines against מילון_לוגיסט dictionary", () => {
    const dict = [
      {
        sku: "1001",
        officialName: "מלט אפור 25 ק״ג",
        slangKeywords: ["שק מלט", "צמנט"],
        depositCategory: "",
        unitWeightKg: 25,
      },
      {
        sku: "2002",
        officialName: "בלוק איטונג 20",
        slangKeywords: ["איטונג 20", "בלוק 20"],
        depositCategory: "60006",
        unitWeightKg: 18,
      },
    ];

    const lines = parseProductsRaw("10 שק מלט\n4 משטחים איטונג 20", dict);
    expect(lines).toEqual([
      { sku: "1001", name: "מלט אפור 25 ק״ג", qtyPlanned: 10, unit: "שק" },
      { sku: "2002", name: "בלוק איטונג 20", qtyPlanned: 4, unit: "משטחים" },
    ]);

    const comaxLines = parseProductsRaw("11570 חמרה שק גדול (18), 3 חצץ שק (11505)", []);
    expect(comaxLines).toEqual([
      { sku: "11570", name: "חמרה שק גדול", qtyPlanned: 18, unit: "שק" },
      { sku: "11505", name: "חצץ שק", qtyPlanned: 3, unit: "שק" },
    ]);
  });

  it("filters הזמנות by date, truck/driver in col J, active status in col P, and extracts M/N deposits", () => {
    const orderRows = [
      [
        "תאריך קליטה",
        "תאריך אספקה",
        "שעה",
        "מס' הזמנה",
        "מס' לקוח",
        "שם לקוח",
        "איש קשר",
        "כתובת",
        "מחסן",
        "נהג / משאית",
        "פירוט מוצרים",
        "משקל",
        "בלות",
        "משטחים",
        "תעודה",
        "סטטוס",
        "waze",
        "הערות",
      ],
      [
        "20261124",
        "25/11/2026",
        "08:00",
        "ORD-101",
        "C1",
        "אבי בניה",
        "050-111",
        "תל אביב 5",
        "מחסן ראשי",
        "חכמת גאבר 615-41-002",
        "10 שק מלט",
        "7.5",
        "2",
        "3",
        "5443",
        "",
        "https://waze.com/ul/1",
        "כניסה מהחצר",
      ],
      [
        "20261124",
        "25/11/2026",
        "09:00",
        "ORD-102",
        "C2",
        "לקוח אחר",
        "050-222",
        "רמת גן",
        "ראשי",
        "עלי 651-51-701",
        "5 מלט",
        "2.0",
        "0",
        "1",
        "5444",
        "פתוח",
        "",
        "",
      ],
      [
        "20261124",
        "25/11/2026",
        "10:00",
        "ORD-103",
        "C3",
        "סגור",
        "",
        "",
        "",
        "615-41-002",
        "1 מלט",
        "1.0",
        "0",
        "0",
        "5445",
        "בוצע",
        "",
        "",
      ],
    ];

    const hikmatOrders = buildOrdersFromSheetValues(orderRows, [], {
      truck: "615-41-002",
      date: "20261125",
    });
    expect(hikmatOrders).toHaveLength(1);
    expect(hikmatOrders[0]?.orderId).toBe("ORD-101");
    expect(hikmatOrders[0]?.deposits).toEqual([
      { sku: "60002", name: "שק גדול (בלה)", qty: 2 },
      { sku: "60060", name: "משטח סבן", qty: 3 },
    ]);
  });

  it("evaluates matchLoadToPod as full, partial, or fail accurately", () => {
    const order = {
      orderId: "ORD-1",
      docNumber: "5443",
      customerName: "כהן בניה בע״מ",
      tons: 8.5,
      deposits: [
        { sku: "60002", qty: 2 },
        { sku: "60060", qty: 3 },
      ],
    };

    expect(
      matchLoadToPod(
        order,
        { depositsConfirmed: { "60002": 2, "60060": 3 } },
        { docNumber: "5443", customer: "כהן בניה", tons: 8.7 },
      ),
    ).toEqual({ match: "full", gaps: [] });

    const partial = matchLoadToPod(
      order,
      { depositsConfirmed: { "60002": 1, "60060": 3 } },
      { docNumber: "5443", customer: "כהן בניה", tons: 9.2 },
    );
    expect(partial.match).toBe("partial");
    expect(partial.gaps).toHaveLength(2);

    const fail = matchLoadToPod(
      order,
      { depositsConfirmed: { "60002": 0, "60060": 0 } },
      { docNumber: "9999", customer: "מישהו אחר", tons: 2.0 },
    );
    expect(fail.match).toBe("fail");
  });

  it("targets truck external_id and prevents duplicate OneSignal pushes", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "notif_1" }), { status: 200 }));

    const env = { ONESIGNAL_APP_ID: "app_123", ONESIGNAL_REST_API_KEY: "rest_secret" };
    const first = await sendOrderPush(
      "חכמת 615-41-002",
      {
        orderId: "ORD-77",
        customerName: "כהן בניה",
        address: "הרצל 10",
        time: "08:30",
        supplyDate: "20261125",
        truck: "615-41-002",
      },
      env,
    );
    expect(first).toEqual({
      ok: true,
      sent: true,
      dedupKey: "ORD-77|615-41-002|20261125",
      notificationId: "notif_1",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const dup = await sendOrderPush(
      "615-41-002",
      {
        orderId: "ORD-77",
        customerName: "כהן בניה",
        supplyDate: "20261125",
        truck: "615-41-002",
      },
      env,
    );
    expect(dup).toEqual({
      ok: true,
      sent: false,
      duplicate: true,
      dedupKey: "ORD-77|615-41-002|20261125",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const callInit = fetchSpy.mock.calls[0]?.[1];
    const sentBody = JSON.parse(String(callInit?.body)) as {
      include_aliases?: { external_id?: string[] };
      idempotency_key?: string;
    };
    expect(sentBody.include_aliases).toEqual({ external_id: ["615-41-002"] });
    expect(sentBody.idempotency_key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(sentBody.idempotency_key).toBe(
      deterministicIdempotencyUuid("ORD-77|615-41-002|20261125"),
    );
  });

  it("supports os_v2 Key auth, handles HTTP 200 OneSignal errors without caching dedup, and sends test pushes", async () => {
    expect(buildOneSignalAuthHeader("os_v2_app_secret")).toBe("Key os_v2_app_secret");
    expect(buildOneSignalAuthHeader("legacy_rest_key")).toBe("Basic legacy_rest_key");

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: "", errors: ["All included players are not subscribed"] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "notif_test_2" }), { status: 200 }));

    const env = { ONESIGNAL_APP_ID: "app_123", ONESIGNAL_REST_API_KEY: "os_v2_app_secret" };
    const unsubscribed = await sendOrderPush(
      "651-51-701",
      {
        orderId: "ORD-88",
        customerName: "בדיקה",
        supplyDate: "20261125",
        truck: "651-51-701",
      },
      env,
    );
    expect(unsubscribed.ok).toBe(false);
    expect(unsubscribed.sent).toBe(false);
    expect(unsubscribed.error).toContain("טרם נרשמה");

    const testPush = await sendOrderTestPush("651-51-701", env);
    expect(testPush.ok).toBe(true);
    expect(testPush.sent).toBe(true);
    expect(testPush.notificationId).toBe("notif_test_2");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
