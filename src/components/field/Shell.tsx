import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { TRUCKS } from "@/lib/field/config";
import type { ScanMode } from "@/lib/field/imaging";
import { CameraCanvasModal } from "./CameraCanvasModal";
import { useField } from "./FieldContext";

export function Shell({
  title,
  children,
  back = true,
}: {
  title: string;
  children: ReactNode;
  back?: boolean;
}) {
  const f = useField();
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b-[3px] border-border bg-card px-3 py-2">
        {back && (
          <Link to="/" className="btn-field min-h-14 border-border bg-secondary text-lg">
            → {f.t("back")}
          </Link>
        )}
        <h1 className="min-w-0 flex-1 truncate text-2xl font-black">{title}</h1>
        <span
          className={`rounded-full px-3 py-1 text-sm font-bold ${
            f.online
              ? "bg-success text-success-foreground"
              : "bg-destructive text-destructive-foreground"
          }`}
        >
          {f.online ? f.t("online") : f.t("offline")}
          {f.pending > 0 && ` · ${f.pending}`}
        </span>
        {f.errorItems.length > 0 && (
          <Link
            to="/summary"
            className="rounded-full bg-destructive px-3 py-1 text-sm font-black text-destructive-foreground"
          >
            ⛔ {f.errorItems.length}
          </Link>
        )}
        {f.truck && (
          <button
            type="button"
            onClick={() => f.setTruckPickerOpen(true)}
            aria-label={f.t("switchTruck")}
            className="btn-field min-h-14 border-brand bg-brand px-3 text-base text-brand-foreground"
          >
            🚚 {f.t("switchTruck")}
          </button>
        )}
        <button
          type="button"
          onClick={() => f.setLang(f.lang === "he" ? "ar" : "he")}
          className="btn-field min-h-14 border-primary bg-primary text-primary-foreground"
        >
          {f.lang === "he" ? "عربي" : "עברית"}
        </button>
        <button
          type="button"
          onClick={f.toggleSun}
          aria-label={f.t("sun")}
          className="btn-field min-h-14 border-border bg-secondary"
        >
          ☀
        </button>
      </header>
      {f.orderAlert && (
        <div className="flex items-center gap-3 border-b-[3px] border-border bg-primary px-4 py-3 text-primary-foreground">
          <Link
            to="/orders"
            search={f.orderAlert.orderId ? { orderId: f.orderAlert.orderId } : {}}
            onClick={f.dismissOrderAlert}
            className="flex-1 text-xl font-black underline-offset-4 hover:underline"
          >
            🔔 {f.orderAlert.title}
            {f.orderAlert.body ? ` — ${f.orderAlert.body}` : ""}
          </Link>
          <button
            type="button"
            onClick={f.dismissOrderAlert}
            aria-label="סגור"
            className="btn-field min-h-12 border-primary-foreground/30 bg-card px-3 text-card-foreground"
          >
            ✕
          </button>
        </div>
      )}
      <main className="flex-1 p-4">{children}</main>
      {f.truckPickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={f.t("switchTruckTitle")}
        >
          <div className="grid w-full max-w-md gap-4 rounded-2xl border-[3px] border-brand bg-card p-5">
            <h2 className="text-2xl font-black">{f.t("switchTruckTitle")}</h2>
            {TRUCKS.map((tk) => {
              const active = f.truck?.id === tk.id;
              return (
                <button
                  key={tk.id}
                  type="button"
                  onClick={() => f.setTruck(tk.id)}
                  className={`btn-field min-h-24 flex-col py-3 text-2xl ${
                    active
                      ? "border-brand bg-brand text-brand-foreground"
                      : "border-primary bg-background text-foreground"
                  }`}
                >
                  <span>
                    {active ? "✓ " : ""}
                    {f.lang === "he" ? tk.driver : tk.driverAr}
                  </span>
                  <span className="text-base font-bold opacity-85" dir="ltr">
                    {tk.id} · {tk.type === "crane" ? f.t("craneTruckLabel") : f.t("distTruckLabel")}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => f.setTruckPickerOpen(false)}
              className="btn-field border-border bg-secondary"
            >
              {f.t("back")}
            </button>
          </div>
        </div>
      )}
      {f.flash && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/60">
          <div className="animate-pop flex size-48 items-center justify-center rounded-full bg-success text-9xl font-black text-success-foreground">
            ✓
          </div>
        </div>
      )}
    </div>
  );
}

export function PhotoButton({
  label,
  onFiles,
  onCaptured,
  mode = "document",
  multiple,
  done,
}: {
  label: string;
  onFiles?: (f: File[]) => void;
  onCaptured?: (dataUrls: string[]) => void;
  mode?: ScanMode;
  multiple?: boolean;
  done?: boolean;
}) {
  const [cameraOpen, setCameraOpen] = useState(false);

  const handleConfirm = async (dataUrls: string[]) => {
    if (onCaptured) {
      onCaptured(dataUrls);
      return;
    }
    if (onFiles) {
      const files = await Promise.all(
        dataUrls.map(async (url, idx) => {
          const res = await fetch(url);
          const blob = await res.blob();
          return new File([blob], `scan_${Date.now()}_${idx + 1}.jpg`, { type: "image/jpeg" });
        }),
      );
      onFiles(files);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setCameraOpen(true)}
        className={`btn-field w-full cursor-pointer ${
          done
            ? "border-success bg-success text-success-foreground"
            : "border-brand bg-brand text-brand-foreground"
        }`}
      >
        📷 {label} {done && "✓"}
      </button>
      <CameraCanvasModal
        open={cameraOpen}
        mode={mode}
        multiple={Boolean(multiple)}
        onClose={() => setCameraOpen(false)}
        onConfirm={(urls) => void handleConfirm(urls)}
      />
    </>
  );
}

export function BigInput(props: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const { label, ...rest } = props;
  return (
    <label className="block">
      <span className="mb-1 block text-lg font-bold">{label}</span>
      <input
        {...rest}
        className="h-16 w-full rounded-xl border-[3px] border-input bg-card px-4 text-2xl font-bold outline-none focus:border-brand"
      />
    </label>
  );
}
