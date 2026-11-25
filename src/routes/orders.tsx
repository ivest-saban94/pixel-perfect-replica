import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useField } from "@/components/field/FieldContext";
import { Shell } from "@/components/field/Shell";
import { SHEET_ID_MAIN, TAB_LOAD_CONFIRM, jerusalemDate, uniqueKey } from "@/lib/field/config";
import { enqueue, kvGet, kvSet } from "@/lib/field/db";
import { getOneSignalAppId, requestPushPermission } from "@/lib/field/onesignal";
import { getSyncEndpoint } from "@/lib/field/sync";
import type { Order } from "@/lib/server/orders";

export const Route = createFileRoute("/orders")({
  validateSearch: (search: Record<string, unknown>): { orderId?: string } =>
    typeof search["orderId"] === "string" ? { orderId: search["orderId"] } : {},
  head: () => ({
    meta: [
      { title: "הזמנות להיום | סבן שטח" },
      { name: "description", content: "רשימת הזמנות לנהג, אישור כמויות העמסה ופקדונות" },
      { property: "og:title", content: "הזמנות להיום | סבן שטח" },
      { property: "og:description", content: "הזמנות לנהג ואישור כמויות העמסה" },
    ],
  }),
  component: OrdersScreen,
});

interface LineConfirmState {
  qtyConfirmed: number;
  confirmed: boolean;
}

interface OrderConfirmState {
  lines: Record<number, LineConfirmState>;
  deposits: Record<string, LineConfirmState>;
  updatedAt: number;
}

function ordersCacheKey(truckId: string, date: string) {
  return `orders:${truckId}:${date}`;
}

function confirmCacheKey(truckId: string, date: string, orderId: string) {
  return `load_confirm:${truckId}:${date}:${orderId}`;
}

async function fetchOrdersForDriver(truckId: string, date: string): Promise<Order[]> {
  const endpoint = getSyncEndpoint();
  const isExternalScript = endpoint.startsWith("http://") || endpoint.startsWith("https://");

  const res = isExternalScript
    ? await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ kind: "orders_list", truck: truckId, date }),
      })
    : await fetch(
        `/api/orders?truck=${encodeURIComponent(truckId)}&date=${encodeURIComponent(date)}`,
      );

  const data = (await res.json()) as { ok?: boolean; orders?: Order[]; error?: string };
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `שגיאה בטעינת הזמנות (${res.status})`);
  }
  return Array.isArray(data.orders) ? data.orders : [];
}

function OrdersScreen() {
  const f = useField();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const today = jerusalemDate();

  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(search.orderId ?? null);
  const [confirmState, setConfirmState] = useState<OrderConfirmState>({
    lines: {},
    deposits: {},
    updatedAt: 0,
  });
  const [activeLineIdx, setActiveLineIdx] = useState<number>(0);
  const [alertsEnabled, setAlertsEnabled] = useState<boolean>(false);

  const lineRefs = useRef<Record<number, HTMLDivElement | null>>({});

  const loadOrders = useCallback(
    async (fromNetwork = true) => {
      if (!f.truck) return;
      const cacheKey = ordersCacheKey(f.truck.id, today);
      const cached = await kvGet<Order[]>(cacheKey);
      if (cached && cached.length > 0) {
        setOrders(cached);
      }

      if (!fromNetwork || !f.online) return;
      setLoading(true);
      setError(null);
      try {
        const fresh = await fetchOrdersForDriver(f.truck.id, today);
        setOrders(fresh);
        await kvSet(cacheKey, fresh);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [f.online, f.truck, today],
  );

  useEffect(() => {
    void loadOrders(true);
  }, [loadOrders, f.ordersVersion]);

  useEffect(() => {
    if (search.orderId) {
      setSelectedOrderId(search.orderId);
    }
  }, [search.orderId]);

  useEffect(() => {
    if (typeof Notification !== "undefined") {
      setAlertsEnabled(Notification.permission === "granted");
    }
  }, []);

  const selectedOrder = orders.find((o) => o.orderId === selectedOrderId) ?? null;

  useEffect(() => {
    if (!f.truck || !selectedOrder) return;
    void (async () => {
      const saved = await kvGet<OrderConfirmState>(
        confirmCacheKey(f.truck!.id, today, selectedOrder.orderId),
      );
      if (saved) {
        setConfirmState(saved);
        const firstOpen = selectedOrder.lines.findIndex((_, idx) => !saved.lines[idx]?.confirmed);
        setActiveLineIdx(firstOpen >= 0 ? firstOpen : 0);
      } else {
        const initLines: Record<number, LineConfirmState> = {};
        selectedOrder.lines.forEach((line, idx) => {
          initLines[idx] = { qtyConfirmed: line.qtyPlanned, confirmed: false };
        });
        const initDeposits: Record<string, LineConfirmState> = {};
        selectedOrder.deposits.forEach((dep) => {
          initDeposits[dep.sku] = { qtyConfirmed: dep.qty, confirmed: false };
        });
        setConfirmState({ lines: initLines, deposits: initDeposits, updatedAt: Date.now() });
        setActiveLineIdx(0);
      }
    })();
  }, [f.truck, selectedOrder, today]);

  if (!f.truck) return null;

  const persistConfirmState = async (next: OrderConfirmState) => {
    if (!f.truck || !selectedOrder) return;
    setConfirmState(next);
    await kvSet(confirmCacheKey(f.truck.id, today, selectedOrder.orderId), next);
  };

  const updateLineQty = (idx: number, delta: number, planned: number) => {
    const cur = confirmState.lines[idx] ?? { qtyConfirmed: planned, confirmed: false };
    const nextQty = Math.max(0, Number((cur.qtyConfirmed + delta).toFixed(2)));
    void persistConfirmState({
      ...confirmState,
      updatedAt: Date.now(),
      lines: { ...confirmState.lines, [idx]: { ...cur, qtyConfirmed: nextQty } },
    });
  };

  const confirmLine = (idx: number, planned: number) => {
    if (!selectedOrder) return;
    const cur = confirmState.lines[idx] ?? { qtyConfirmed: planned, confirmed: false };
    const nextLines = {
      ...confirmState.lines,
      [idx]: { qtyConfirmed: cur.qtyConfirmed, confirmed: true },
    };
    const nextState: OrderConfirmState = {
      ...confirmState,
      updatedAt: Date.now(),
      lines: nextLines,
    };
    void persistConfirmState(nextState);
    f.confirm();

    const nextUnconfirmed = selectedOrder.lines.findIndex(
      (_, i) => i > idx && !nextLines[i]?.confirmed,
    );
    const fallbackUnconfirmed = selectedOrder.lines.findIndex((_, i) => !nextLines[i]?.confirmed);
    const nextIdx = nextUnconfirmed >= 0 ? nextUnconfirmed : fallbackUnconfirmed;
    if (nextIdx >= 0) {
      setActiveLineIdx(nextIdx);
      setTimeout(() => {
        lineRefs.current[nextIdx]?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 120);
    }
  };

  const updateDepositQty = (sku: string, delta: number, planned: number) => {
    const cur = confirmState.deposits[sku] ?? { qtyConfirmed: planned, confirmed: false };
    const nextQty = Math.max(0, cur.qtyConfirmed + delta);
    void persistConfirmState({
      ...confirmState,
      updatedAt: Date.now(),
      deposits: { ...confirmState.deposits, [sku]: { ...cur, qtyConfirmed: nextQty } },
    });
  };

  const toggleDepositConfirm = (sku: string, planned: number) => {
    const cur = confirmState.deposits[sku] ?? { qtyConfirmed: planned, confirmed: false };
    const nextConfirmed = !cur.confirmed;
    void persistConfirmState({
      ...confirmState,
      updatedAt: Date.now(),
      deposits: { ...confirmState.deposits, [sku]: { ...cur, confirmed: nextConfirmed } },
    });
    if (nextConfirmed) f.confirm();
  };

  const finishLoading = async () => {
    if (!f.truck || !selectedOrder) return;

    const linesPayload = selectedOrder.lines.map((line, idx) => ({
      sku: line.sku,
      name: line.name,
      qtyPlanned: line.qtyPlanned,
      qtyConfirmed: confirmState.lines[idx]?.qtyConfirmed ?? line.qtyPlanned,
      confirmed: Boolean(confirmState.lines[idx]?.confirmed),
    }));

    const depositsConfirmedMap: Record<string, number> = {};
    const depositsPayload = selectedOrder.deposits.map((dep) => {
      const qtyConfirmed = confirmState.deposits[dep.sku]?.qtyConfirmed ?? dep.qty;
      depositsConfirmedMap[dep.sku] = qtyConfirmed;
      return {
        sku: dep.sku,
        qtyPlanned: dep.qty,
        qtyConfirmed,
        confirmed: Boolean(confirmState.deposits[dep.sku]?.confirmed),
      };
    });

    await enqueue("load_confirm", uniqueKey(`load-${selectedOrder.orderId}`), {
      truck: f.truck.id,
      driver: f.truck.driver,
      orderId: selectedOrder.orderId,
      docNumber: selectedOrder.docNumber || selectedOrder.orderId,
      customer: selectedOrder.customerName,
      lines: linesPayload,
      deposits: depositsPayload,
      notes: selectedOrder.notes,
      at: Date.now(),
      sheetId: SHEET_ID_MAIN,
      sheet: TAB_LOAD_CONFIRM,
    });

    await kvSet("active_pod_order", {
      orderId: selectedOrder.orderId,
      docNumber: selectedOrder.docNumber || "",
      customerName: selectedOrder.customerName,
      tons: selectedOrder.tons,
      deposits: selectedOrder.deposits,
      depositsConfirmed: depositsConfirmedMap,
      linesConfirmedCount: linesPayload.filter((l) => l.confirmed).length,
      linesTotalCount: linesPayload.length,
    });

    f.confirm();
    void navigate({ to: "/pod", search: { orderId: selectedOrder.orderId } });
  };

  const oneSignalConfigured = Boolean(getOneSignalAppId());

  if (selectedOrder) {
    const confirmedCount = selectedOrder.lines.filter(
      (_, i) => confirmState.lines[i]?.confirmed,
    ).length;

    return (
      <Shell title={`${f.t("orders")} · #${selectedOrder.orderId}`}>
        <div className="mx-auto grid max-w-2xl gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => setSelectedOrderId(null)}
              className="btn-field border-border bg-secondary text-xl"
            >
              → {f.t("orders")}
            </button>
            {selectedOrder.waze && (
              <a
                href={selectedOrder.waze}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-field flex-1 border-accent bg-accent text-accent-foreground text-xl"
              >
                🧭 {f.t("openWaze")}
              </a>
            )}
          </div>

          <div className="grid gap-2 rounded-xl border-[3px] border-primary bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-2xl font-black">{selectedOrder.customerName}</span>
              <span
                className="rounded-lg bg-primary px-3 py-1 text-lg font-black text-primary-foreground"
                dir="ltr"
              >
                #{selectedOrder.orderId}
              </span>
            </div>
            {selectedOrder.address && (
              <p className="text-xl font-bold text-muted-foreground">📍 {selectedOrder.address}</p>
            )}
            <div className="flex flex-wrap gap-4 text-xl font-bold">
              {selectedOrder.time && <span>🕒 {selectedOrder.time}</span>}
              {selectedOrder.tons != null && <span>⚖️ {selectedOrder.tons} טון</span>}
              {selectedOrder.docNumber && <span dir="ltr">📄 {selectedOrder.docNumber}</span>}
            </div>
            {selectedOrder.notes && (
              <p className="rounded-lg bg-muted p-3 text-lg font-bold">📝 {selectedOrder.notes}</p>
            )}
          </div>

          <div className="flex items-center justify-between px-1">
            <h2 className="text-2xl font-black">{f.t("orderLines")}</h2>
            <span className="text-xl font-bold text-muted-foreground">
              {confirmedCount}/{selectedOrder.lines.length}
            </span>
          </div>

          {selectedOrder.lines.length === 0 ? (
            <div className="rounded-xl border-[3px] border-border bg-card p-5 text-xl font-bold">
              <p>{f.t("noLinesParsed")}</p>
              {selectedOrder.productsRaw && (
                <p className="mt-2 whitespace-pre-line text-muted-foreground">
                  {selectedOrder.productsRaw}
                </p>
              )}
            </div>
          ) : (
            <div className="grid gap-3">
              {selectedOrder.lines.map((line, idx) => {
                const st = confirmState.lines[idx] ?? {
                  qtyConfirmed: line.qtyPlanned,
                  confirmed: false,
                };
                const isActive = idx === activeLineIdx;

                return (
                  <div
                    key={`${line.sku}-${idx}`}
                    ref={(el) => {
                      lineRefs.current[idx] = el;
                    }}
                    onClick={() => setActiveLineIdx(idx)}
                    className={`rounded-xl border-[3px] transition-all ${
                      st.confirmed
                        ? "border-success bg-success/15 p-3 opacity-85"
                        : isActive
                          ? "scale-[1.01] border-primary bg-card p-5 shadow-lg"
                          : "border-border bg-card p-4"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <div
                          className={
                            isActive && !st.confirmed ? "text-2xl font-black" : "text-xl font-bold"
                          }
                        >
                          {st.confirmed ? "✅ " : ""}
                          {line.name}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-3 text-lg text-muted-foreground">
                          {line.sku && <span dir="ltr">#{line.sku}</span>}
                          <span>
                            {f.t("plannedQty")}: {line.qtyPlanned} {line.unit}
                          </span>
                          {st.confirmed && (
                            <span className="font-black text-foreground">
                              · {f.t("actualQty")}: {st.qtyConfirmed} {line.unit}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {isActive && (
                      <div className="mt-4 grid gap-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-between gap-3 rounded-xl border-2 bg-muted p-3">
                          <button
                            onClick={() => updateLineQty(idx, -1, line.qtyPlanned)}
                            className="btn-field size-16 border-border bg-secondary text-3xl"
                          >
                            −
                          </button>
                          <div className="text-center">
                            <div className="text-4xl font-black" dir="ltr">
                              {st.qtyConfirmed}
                            </div>
                            <div className="text-lg font-bold text-muted-foreground">
                              {line.unit}
                            </div>
                          </div>
                          <button
                            onClick={() => updateLineQty(idx, 1, line.qtyPlanned)}
                            className="btn-field size-16 border-primary bg-primary text-primary-foreground text-3xl"
                          >
                            +
                          </button>
                        </div>

                        <button
                          onClick={() => confirmLine(idx, line.qtyPlanned)}
                          className="btn-field min-h-16 w-full border-success bg-success text-success-foreground text-2xl"
                        >
                          ✅ {st.confirmed ? f.t("confirmed") : f.t("confirmQty")}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {selectedOrder.deposits.length > 0 && (
            <div className="grid gap-3 rounded-xl border-[3px] border-border bg-card p-4">
              <h3 className="text-2xl font-black">🔁 {f.t("loadDeposits")}</h3>
              {selectedOrder.deposits.map((dep) => {
                const depState = confirmState.deposits[dep.sku] ?? {
                  qtyConfirmed: dep.qty,
                  confirmed: false,
                };
                return (
                  <div
                    key={dep.sku}
                    className={`flex flex-wrap items-center gap-3 rounded-xl border-2 p-3 ${
                      depState.confirmed ? "border-success bg-success/15" : "border-border bg-muted"
                    }`}
                  >
                    <div className="min-w-36 flex-1">
                      <div className="text-xl font-black">{dep.name || dep.sku}</div>
                      <div className="text-base text-muted-foreground" dir="ltr">
                        {dep.sku} · {f.t("plannedQty")}: {dep.qty}
                      </div>
                    </div>
                    <button
                      onClick={() => updateDepositQty(dep.sku, -1, dep.qty)}
                      className="btn-field size-14 border-border bg-secondary text-2xl"
                    >
                      −
                    </button>
                    <span className="w-10 text-center text-2xl font-black" dir="ltr">
                      {depState.qtyConfirmed}
                    </span>
                    <button
                      onClick={() => updateDepositQty(dep.sku, 1, dep.qty)}
                      className="btn-field size-14 border-primary bg-primary text-primary-foreground text-2xl"
                    >
                      +
                    </button>
                    <button
                      onClick={() => toggleDepositConfirm(dep.sku, dep.qty)}
                      className={`btn-field min-h-14 px-4 text-xl ${
                        depState.confirmed
                          ? "border-success bg-success text-success-foreground"
                          : "border-primary bg-card"
                      }`}
                    >
                      {depState.confirmed ? "✅" : "☐"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <button
            onClick={() => void finishLoading()}
            className="btn-field min-h-20 w-full border-primary bg-primary text-primary-foreground text-2xl"
          >
            📄 {f.t("finishLoad")}
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title={f.t("orders")}>
      <div className="mx-auto grid max-w-2xl gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => void loadOrders(true)}
            disabled={loading}
            className="btn-field flex-1 border-primary bg-primary text-primary-foreground text-2xl"
          >
            🔄 {loading ? f.t("loadingOrders") : f.t("refresh")}
          </button>
          {oneSignalConfigured && !alertsEnabled && (
            <button
              onClick={async () => {
                const ok = await requestPushPermission();
                setAlertsEnabled(ok);
              }}
              className="btn-field border-accent bg-accent text-accent-foreground text-xl"
            >
              🔔 {f.t("enableAlerts")}
            </button>
          )}
        </div>

        {error && (
          <div className="rounded-xl border-[3px] border-destructive bg-card p-4 text-xl font-bold text-destructive">
            ⚠ {error}
          </div>
        )}

        {!loading && orders.length === 0 ? (
          <div className="rounded-xl border-[3px] border-border bg-card p-8 text-center text-2xl font-black">
            📋 {f.t("noOrders")}
          </div>
        ) : (
          <div className="grid gap-4">
            {orders.map((order) => (
              <button
                key={order.orderId}
                onClick={() => setSelectedOrderId(order.orderId)}
                className="btn-field min-h-32 w-full flex-col items-stretch justify-center gap-2 border-primary bg-card p-5 text-right"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-2xl font-black">
                    {order.customerName || "לקוח"}
                  </span>
                  <span
                    className="rounded-lg bg-primary px-3 py-1 text-lg font-black text-primary-foreground"
                    dir="ltr"
                  >
                    #{order.orderId}
                  </span>
                </div>
                {order.address && (
                  <div className="truncate text-xl font-bold text-muted-foreground">
                    📍 {order.address}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-4 text-xl font-bold">
                  {order.time && <span>🕒 {order.time}</span>}
                  {order.tons != null && <span>⚖️ {order.tons} טון</span>}
                  {order.status && <span>• {order.status}</span>}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </Shell>
  );
}
