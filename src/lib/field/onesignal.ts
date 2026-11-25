import type { TruckId } from "./config";

export interface OrderPushData {
  type?: string;
  orderId?: string;
  truck?: string;
  url?: string;
  title?: string;
  body?: string;
}

interface OneSignalV16 {
  init: (opts: { appId: string; allowLocalhostAsSecureOrigin?: boolean }) => Promise<void>;
  login: (externalId: string) => Promise<void>;
  User: {
    addTag: (key: string, value: string) => void;
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
const foregroundListeners = new Set<(data: OrderPushData) => void>();

export function getOneSignalAppId(): string | undefined {
  const id = (import.meta.env["VITE_ONESIGNAL_APP_ID"] as string | undefined)?.trim();
  return id && id.length > 0 ? id : undefined;
}

/** Plays a two-tone driver dispatch chime via Web Audio API without external audio files */
export function playOrderAlertSound(): void {
  if (typeof window === "undefined") return;
  try {
    navigator.vibrate?.([200, 100, 200]);
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const playTone = (freq: number, startOffset: number, duration: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.25, ctx.currentTime + startOffset);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + startOffset + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + startOffset);
      osc.stop(ctx.currentTime + startOffset + duration);
    };
    playTone(880, 0, 0.18);
    playTone(1174.66, 0.2, 0.28);
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
  if (initializedAppId === appId) return true;
  initializedAppId = appId;

  if (!sdkInjected) {
    sdkInjected = true;
    const script = document.createElement("script");
    script.src = ONESIGNAL_SDK_URL;
    script.defer = true;
    document.head.appendChild(script);
  }

  enqueueDeferred(async (OneSignal) => {
    await OneSignal.init({
      appId,
      allowLocalhostAsSecureOrigin: true,
    });

    OneSignal.Notifications.addEventListener("foregroundWillDisplay", (rawEv) => {
      const ev = rawEv as {
        notification?: {
          title?: string;
          body?: string;
          additionalData?: OrderPushData;
        };
      };
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
  });

  return true;
}

export function setTruckUser(truckId: TruckId | string | null): void {
  if (typeof window === "undefined" || !truckId) return;
  const appId = getOneSignalAppId();
  if (!appId) return;
  initOneSignal(appId);

  enqueueDeferred(async (OneSignal) => {
    try {
      await OneSignal.login(truckId);
      OneSignal.User.addTag("truck", truckId);
    } catch {
      // Ignore network/offline SDK errors so field workflow never blocks
    }
  });
}

export async function requestPushPermission(): Promise<boolean> {
  const appId = getOneSignalAppId();
  if (!appId || typeof window === "undefined") return false;
  initOneSignal(appId);

  return await new Promise<boolean>((resolve) => {
    enqueueDeferred(async (OneSignal) => {
      try {
        const granted = await OneSignal.Notifications.requestPermission();
        resolve(Boolean(granted));
      } catch {
        resolve(false);
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
