import { useEffect, useState } from "react";
import { useField } from "./FieldContext";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export function PWAInstallButton() {
  const f = useField();
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    setIsInstalled(standalone);
    setIsIOS(/iphone|ipad|ipod/.test(window.navigator.userAgent.toLowerCase()));

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (isInstalled) return null;

  if (deferredPrompt) {
    return (
      <button
        type="button"
        onClick={async () => {
          await deferredPrompt.prompt();
          const { outcome } = await deferredPrompt.userChoice;
          if (outcome === "accepted") {
            setIsInstalled(true);
            setDeferredPrompt(null);
          }
        }}
        className="btn-field w-full border-brand bg-brand text-brand-foreground"
      >
        📲 {f.t("installApp")}
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="btn-field w-full border-brand bg-card text-foreground"
        >
          📲 {f.t("installApp")}
        </button>
        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4">
            <div className="w-full max-w-md rounded-2xl border-[3px] border-brand bg-card p-6">
              <h3 className="text-2xl font-black">{f.t("installIosTitle")}</h3>
              <p className="mt-3 text-lg font-bold text-muted-foreground">
                {f.t("installIosSteps")}
              </p>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="btn-field mt-5 w-full border-brand bg-brand text-brand-foreground"
              >
                {f.t("back")}
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
}
