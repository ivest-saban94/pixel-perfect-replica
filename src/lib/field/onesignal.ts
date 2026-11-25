import type { TruckId } from "./config";

export interface OrderPushData {
  type?: string;
  orderId?: string;
  truck?: string;
  url?: string;
  title?: string;
  body?: string;
}

export interface OneSignalClientStatus {
  sdkConfigured: boolean;
  sdkLoaded: boolean;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
  subscriptionId: string | null;
  externalId: string | null;
  initError: string | null;
}

interface OneSignalPushSubscription {
  id?: string | null;
  optedIn?: boolean;
  optIn?: () => Promise<void>;
  addEventListener?: (event: string, listener: () => void) => void;
}

interface OneSignalV16 {
  init: (opts: {
    appId: string;
    allowLocalhostAsSecureOrigin?: boolean;
    serviceWorkerPath?: string;
    serviceWorkerParam?: { scope: string };
  }) => Promise<void>;
  login: (externalId: string) => Promise<void>;
  logout?: () => Promise<void>;
  User: {
    externalId?: string | null;
    addTag: (key: string, value: string) => void;
    addTags?: (tags: Record<string, string>) => void;
    PushSubscription?: OneSignalPushSubscription;
  };
  Notifications: {
    permission?: boolean;
    requestPermission: () => Promise<boolean>;
    addEventListener: (event: string, listener: (ev: unknown) => void) => void;
  };
}

declare global {
  interface Window {
    OneSignalDeferred?: Array<(OneSignal: OneSignalV16) => void | Promise<void>>;
  }
}

const ONESIGNAL_SDK_URL = "https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js";
let sdkInjected = false;
let initializedAppId: string | null = null;
let runtimeAppId: string | null = null;
let sdkRef: OneSignalV16 | null = null;
let lastInitError: string | null = null;
let activeExternalId: string | null = null;
let activeDriverName: string | undefined;
const foregroundListeners = new Set<(data: OrderPushData) => void>();
const statusListeners = new Set<(status: OneSignalClientStatus) => void>();

export function getOneSignalAppId(): string | undefined {
  const id = (import.meta.env["VITE_ONESIGNAL_APP_ID"] as string | undefined)?.trim();
  return (id && id.length > 0 ? id : undefined) ?? runtimeAppId ?? undefined;
}

export function getOneSignalStatus(): OneSignalClientStatus {
  const sdkConfigured = Boolean(getOneSignalAppId());
  const permission: NotificationPermission | "unsupported" =
    typeof Notification !== "undefined" ? Notification.permission : "unsupported";
  const sub = sdkRef?.User?.PushSubscription;
  const subscriptionId = sub?.id ?? null;
  const subscribed = Boolean(sub?.optedIn && subscriptionId && permission === "granted");
  const externalId = sdkRef?.User?.externalId ?? activeExternalId;

  return {
    sdkConfigured,
    sdkLoaded: Boolean(sdkRef),
    permission,
    subscribed,
    subscriptionId,
    externalId,
    initError: lastInitError,
  };
}

function notifyStatusListeners(): void {
  const snapshot = getOneSignalStatus();
  for (const cb of statusListeners) {
    try {
      cb(snapshot);
    } catch {
      /* ignore listener errors */
    }
  }
}

export function onOneSignalStatusChange(cb: (status: OneSignalClientStatus) => void): () => void {
  statusListeners.add(cb);
  cb(getOneSignalStatus());
  return () => {
    statusListeners.delete(cb);
  };
}

/** Plays a two-tone driver dispatch chime via Web Audio API and closes AudioContext cleanly afterward. */
export function playOrderAlertSound(): void {
  if (typeof window === "undefined") return;
  try {
    navigator.vibrate?.([200, 100, 200]);
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => undefined);
    }
    const playTone = (freq: number, startOffset: number, duration: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.28, ctx.currentTime + startOffset);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + startOffset + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + startOffset);
      osc.stop(ctx.currentTime + startOffset + duration);
    };
    playTone(880, 0, 0.18);
    playTone(1174.66, 0.2, 0.28);
    setTimeout(() => {
      void ctx.close().catch(() => undefined);
    }, 650);
  } catch {
    // Ignore autoplay restrictions before user gesture
  }
}

function enqueueDeferred(fn: (os: OneSignalV16) => void | Promise<void>): void {
  if (typeof window === "undefined") return;
  window.OneSignalDeferred = window.OneSignalDeferred || [];
  window.OneSignalDeferred.push(fn);
}

function emitForeground(data: OrderPushData): void {
  playOrderAlertSound();
  for (const cb of foregroundListeners) {
    try {
      cb(data);
    } catch {
      // Keep other listeners running
    }
  }
}

export function initOneSignal(appId = getOneSignalAppId()): boolean {
  if (typeof window === "undefined" || typeof document === "undefined" || !appId) {
    return false;
  }
  runtimeAppId = appId;
  if (initializedAppId === appId) return true;
  initializedAppId = appId;
  lastInitError = null;
  notifyStatusListeners();

  if (!sdkInjected) {
    sdkInjected = true;
    const script = document.createElement("script");
    script.src = ONESIGNAL_SDK_URL;
    script.defer = true;
    script.onerror = () => {
      lastInitError = "טעינת OneSignal SDK נחסמה או שאין חיבור רשת";
      notifyStatusListeners();
    };
    document.head.appendChild(script);
  }

  enqueueDeferred(async (OneSignal) => {
    try {
      await OneSignal.init({
        appId,
        allowLocalhostAsSecureOrigin: true,
        serviceWorkerPath: "/OneSignalSDKWorker.js",
        serviceWorkerParam: { scope: "/" },
      });
      sdkRef = OneSignal;
      lastInitError = null;

      OneSignal.Notifications.addEventListener("foregroundWillDisplay", (rawEv) => {
        const ev = rawEv as {
          notification?: {
            title?: string;
            body?: string;
            additionalData?: OrderPushData;
            display?: () => void;
          };
        };
        try {
          ev.notification?.display?.();
        } catch {
          /* ignore */
        }
        const additional = ev.notification?.additionalData ?? {};
        emitForeground({
          ...additional,
          ...(ev.notification?.title ? { title: ev.notification.title } : {}),
          ...(ev.notification?.body ? { body: ev.notification.body } : {}),
        });
      });

      OneSignal.Notifications.addEventListener("click", (rawEv) => {
        const ev = rawEv as {
          notification?: { additionalData?: OrderPushData };
        };
        const data = ev.notification?.additionalData;
        if (data?.url && typeof window !== "undefined") {
          window.location.assign(data.url);
        } else if (data?.orderId && typeof window !== "undefined") {
          window.location.assign(`/orders?orderId=${encodeURIComponent(data.orderId)}`);
        }
      });

      OneSignal.Notifications.addEventListener("permissionChange", () => {
        notifyStatusListeners();
      });

      OneSignal.User.PushSubscription?.addEventListener?.("change", () => {
        notifyStatusListeners();
      });

      notifyStatusListeners();
    } catch (err) {
      lastInitError = err instanceof Error ? err.message : String(err);
      notifyStatusListeners();
    }
  });

  return true;
}

export function setTruckUser(truckId: TruckId | string | null, driverName?: string): void {
  if (typeof window === "undefined") return;
  activeExternalId = truckId;
  activeDriverName = driverName;
  const appId = getOneSignalAppId();
  if (!appId) {
    notifyStatusListeners();
    return;
  }
  initOneSignal(appId);

  enqueueDeferred(async (OneSignal) => {
    try {
      if (!truckId) {
        await OneSignal.logout?.();
        notifyStatusListeners();
        return;
      }
      await OneSignal.login(truckId);
      if (OneSignal.User.addTags) {
        OneSignal.User.addTags({
          truck: truckId,
          app: "saban-field",
          ...(driverName ? { driver: driverName } : {}),
        });
      } else {
        OneSignal.User.addTag("truck", truckId);
      }
      notifyStatusListeners();
    } catch {
      // Ignore network/offline SDK errors so field workflow never blocks
    }
  });
}

export function getPendingTruckUser(): { truckId: string | null; driverName?: string } {
  return {
    truckId: activeExternalId,
    ...(activeDriverName ? { driverName: activeDriverName } : {}),
  };
}

export async function requestPushPermission(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const appId = getOneSignalAppId();
  if (!appId) {
    if (typeof Notification !== "undefined" && Notification.requestPermission) {
      const res = await Notification.requestPermission().catch(() => "denied" as const);
      notifyStatusListeners();
      return res === "granted";
    }
    return false;
  }
  initOneSignal(appId);

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (granted: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      notifyStatusListeners();
      resolve(granted);
    };

    const timeout = setTimeout(async () => {
      if (typeof Notification !== "undefined" && Notification.requestPermission) {
        const nativeRes = await Notification.requestPermission().catch(() => "denied" as const);
        finish(nativeRes === "granted");
      } else {
        finish(false);
      }
    }, 8000);

    enqueueDeferred(async (OneSignal) => {
      try {
        const granted = await OneSignal.Notifications.requestPermission();
        if (granted) {
          await OneSignal.User.PushSubscription?.optIn?.().catch(() => undefined);
          if (activeExternalId) {
            await OneSignal.login(activeExternalId).catch(() => undefined);
          }
        }
        finish(Boolean(granted));
      } catch {
        finish(false);
      }
    });
  });
}

export function onForegroundOrderNotification(listener: (data: OrderPushData) => void): () => void {
  foregroundListeners.add(listener);
  return () => {
    foregroundListeners.delete(listener);
  };
}
