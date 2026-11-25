import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import {
  deleteQueueItem,
  errorItemsSorted,
  kvGet,
  kvSet,
  pendingSorted,
  resetQueueItemToPending,
  type DayState,
  type QueueItem,
} from "@/lib/field/db";
import { drainQueue, startSyncLoop } from "@/lib/field/sync";
import { jerusalemDate, TRUCKS, type Truck, type TruckId } from "@/lib/field/config";
import { tr, type Key, type Lang } from "@/lib/field/i18n";
import {
  initOneSignal,
  onForegroundOrderNotification,
  setTruckUser,
  type OrderPushData,
} from "@/lib/field/onesignal";

export interface OrderAlertBanner {
  title: string;
  body: string;
  orderId?: string;
}

function dayKeyForTruck(truckId: TruckId): string {
  return `day:${truckId}`;
}

function shiftCycleKey(truckId: TruckId, date: string): string {
  return `shiftCycle:${truckId}:${date}`;
}

interface Ctx {
  ready: boolean;
  lang: Lang;
  setLang: (l: Lang) => void;
  sun: boolean;
  toggleSun: () => void;
  truck: Truck | null;
  setTruck: (id: TruckId | null) => void;
  truckPickerOpen: boolean;
  setTruckPickerOpen: (open: boolean) => void;
  day: DayState | null;
  setDay: (d: DayState | null) => void;
  resetDay: () => Promise<void>;
  shiftCycle: number;
  pending: number;
  errorItems: QueueItem[];
  retryErrorItem: (id: number) => Promise<void>;
  removeErrorItem: (id: number) => Promise<void>;
  refreshPending: () => void;
  online: boolean;
  t: (k: Key) => string;
  confirm: () => void;
  flash: boolean;
  ordersVersion: number;
  orderAlert: OrderAlertBanner | null;
  dismissOrderAlert: () => void;
}
const C = createContext<Ctx | null>(null);
export const useField = () => {
  const c = useContext(C);
  if (!c) throw new Error("no FieldProvider");
  return c;
};

export function FieldProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [lang, setLangS] = useState<Lang>("he");
  const [sun, setSun] = useState(false);
  const [truckId, setTruckId] = useState<TruckId | null>(null);
  const [truckPickerOpen, setTruckPickerOpen] = useState(false);
  const [day, setDayS] = useState<DayState | null>(null);
  const [shiftCycle, setShiftCycle] = useState(0);
  const [pending, setPending] = useState(0);
  const [errorItems, setErrorItems] = useState<QueueItem[]>([]);
  const [online, setOnline] = useState(true);
  const [flash, setFlash] = useState(false);
  const [ordersVersion, setOrdersVersion] = useState(0);
  const [orderAlert, setOrderAlert] = useState<OrderAlertBanner | null>(null);

  const refreshPending = useCallback(() => {
    void pendingSorted().then((p) => setPending(p.length));
    void errorItemsSorted().then(setErrorItems);
  }, []);

  const loadTruckShift = useCallback(async (id: TruckId | null) => {
    if (!id) {
      setDayS(null);
      setShiftCycle(0);
      return;
    }
    const today = jerusalemDate();
    const scoped = await kvGet<DayState>(dayKeyForTruck(id));
    if (scoped && scoped.date === today) {
      setDayS(scoped);
    } else {
      const legacy = await kvGet<DayState>("day");
      if (legacy && legacy.date === today && legacy.truck === id) {
        setDayS(legacy);
        await kvSet(dayKeyForTruck(id), legacy);
      } else {
        setDayS(null);
      }
    }
    const cycle = (await kvGet<number>(shiftCycleKey(id, today))) ?? 0;
    setShiftCycle(cycle);
  }, []);

  useEffect(() => {
    void (async () => {
      setLangS((await kvGet<Lang>("lang")) ?? "he");
      setSun((await kvGet<boolean>("sun")) ?? false);
      const savedTruck = (await kvGet<TruckId>("truck")) ?? null;
      setTruckId(savedTruck);
      if (savedTruck) setTruckUser(savedTruck);
      await loadTruckShift(savedTruck);
      setReady(true);
      refreshPending();
    })();
    initOneSignal();
    const unsubPush = onForegroundOrderNotification((data: OrderPushData) => {
      setOrderAlert({
        title: data.title || (data.orderId ? `הזמנה חדשה · ${data.orderId}` : "הזמנה חדשה"),
        body: data.body || "",
        ...(data.orderId ? { orderId: data.orderId } : {}),
      });
      setOrdersVersion((v) => v + 1);
      refreshPending();
    });
    setOnline(navigator.onLine);
    const on = () => setOnline(true),
      off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const stop = startSyncLoop();
    const t = setInterval(refreshPending, 5000);
    return () => {
      unsubPush();
      stop();
      clearInterval(t);
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [loadTruckShift, refreshPending]);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = "rtl";
    document.documentElement.classList.toggle("sun", sun);
  }, [lang, sun]);

  const confirm = useCallback(() => {
    setFlash(true);
    setTimeout(() => setFlash(false), 900);
    try {
      navigator.vibrate?.(80);
      const a = new AudioContext();
      const o = a.createOscillator();
      o.frequency.value = 880;
      o.connect(a.destination);
      o.start();
      o.stop(a.currentTime + 0.12);
    } catch {
      /* ignore */
    }
    refreshPending();
  }, [refreshPending]);

  const setTruck = useCallback(
    (id: TruckId | null) => {
      setTruckId(id);
      setTruckPickerOpen(false);
      void kvSet("truck", id);
      if (id) setTruckUser(id);
      void loadTruckShift(id);
    },
    [loadTruckShift],
  );

  const setDay = useCallback(
    (d: DayState | null) => {
      setDayS(d);
      if (truckId) {
        void kvSet(dayKeyForTruck(truckId), d);
      }
      void kvSet("day", d);
    },
    [truckId],
  );

  const resetDay = useCallback(async () => {
    if (!truckId) return;
    const today = jerusalemDate();
    const nextCycle = ((await kvGet<number>(shiftCycleKey(truckId, today))) ?? 0) + 1;
    await kvSet(shiftCycleKey(truckId, today), nextCycle);
    setShiftCycle(nextCycle);
    setDayS(null);
    await kvSet(dayKeyForTruck(truckId), null);
    await kvSet("day", null);
  }, [truckId]);

  const retryErrorItem = useCallback(
    async (id: number) => {
      await resetQueueItemToPending(id);
      await drainQueue(true);
      refreshPending();
    },
    [refreshPending],
  );

  const removeErrorItem = useCallback(
    async (id: number) => {
      await deleteQueueItem(id);
      refreshPending();
    },
    [refreshPending],
  );

  const value: Ctx = {
    ready,
    lang,
    sun,
    online,
    pending,
    errorItems,
    retryErrorItem,
    removeErrorItem,
    refreshPending,
    flash,
    confirm,
    day,
    resetDay,
    shiftCycle,
    ordersVersion,
    orderAlert,
    dismissOrderAlert: () => setOrderAlert(null),
    setLang: (l) => {
      setLangS(l);
      void kvSet("lang", l);
    },
    toggleSun: () => {
      setSun((s) => {
        void kvSet("sun", !s);
        return !s;
      });
    },
    truck: TRUCKS.find((x) => x.id === truckId) ?? null,
    setTruck,
    truckPickerOpen,
    setTruckPickerOpen,
    setDay,
    t: (k) => tr(k, lang),
  };
  return <C.Provider value={value}>{children}</C.Provider>;
}
