import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { kvGet, kvSet, pendingSorted, type DayState } from "@/lib/field/db";
import { startSyncLoop } from "@/lib/field/sync";
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

interface Ctx {
  ready: boolean;
  lang: Lang;
  setLang: (l: Lang) => void;
  sun: boolean;
  toggleSun: () => void;
  truck: Truck | null;
  setTruck: (id: TruckId | null) => void;
  day: DayState | null;
  setDay: (d: DayState | null) => void;
  pending: number;
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
  const [day, setDayS] = useState<DayState | null>(null);
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(true);
  const [flash, setFlash] = useState(false);
  const [ordersVersion, setOrdersVersion] = useState(0);
  const [orderAlert, setOrderAlert] = useState<OrderAlertBanner | null>(null);

  const refreshPending = useCallback(() => {
    void pendingSorted().then((p) => setPending(p.length));
  }, []);

  useEffect(() => {
    void (async () => {
      setLangS((await kvGet<Lang>("lang")) ?? "he");
      setSun((await kvGet<boolean>("sun")) ?? false);
      const savedTruck = (await kvGet<TruckId>("truck")) ?? null;
      setTruckId(savedTruck);
      if (savedTruck) setTruckUser(savedTruck);
      const d = await kvGet<DayState>("day");
      setDayS(d && d.date === jerusalemDate() ? d : null);
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
  }, [refreshPending]);

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

  const value: Ctx = {
    ready,
    lang,
    sun,
    online,
    pending,
    refreshPending,
    flash,
    confirm,
    day,
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
    setTruck: (id) => {
      setTruckId(id);
      void kvSet("truck", id);
      if (id) setTruckUser(id);
    },
    setDay: (d) => {
      setDayS(d);
      void kvSet("day", d);
    },
    t: (k) => tr(k, lang),
  };
  return <C.Provider value={value}>{children}</C.Provider>;
}
