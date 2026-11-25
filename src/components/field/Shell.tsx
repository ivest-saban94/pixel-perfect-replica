import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useField } from "./FieldContext";

export function Shell({ title, children, back = true }: { title: string; children: ReactNode; back?: boolean }) {
  const f = useField();
  return (
    <div className="min-h-screen flex flex-col">
      <header className="flex items-center gap-2 border-b-2 bg-card px-3 py-2">
        {back && <Link to="/" className="btn-field min-h-14 border-border bg-secondary text-lg">→ {f.t("back")}</Link>}
        <h1 className="flex-1 truncate text-2xl font-black">{title}</h1>
        <span className={`rounded-full px-3 py-1 text-sm font-bold ${f.online ? "bg-success text-success-foreground" : "bg-destructive text-destructive-foreground"}`}>
          {f.online ? f.t("online") : f.t("offline")}{f.pending > 0 && ` · ${f.pending}`}
        </span>
        <button onClick={() => f.setLang(f.lang === "he" ? "ar" : "he")} className="btn-field min-h-14 border-primary bg-primary text-primary-foreground">
          {f.lang === "he" ? "عربي" : "עברית"}
        </button>
        <button onClick={f.toggleSun} aria-label={f.t("sun")} className="btn-field min-h-14 border-border bg-secondary">☀</button>
      </header>
      {f.orderAlert && (
        <div className="flex items-center gap-3 border-b-[3px] border-border bg-primary px-4 py-3 text-primary-foreground">
          <Link
            to="/orders"
            search={f.orderAlert.orderId ? { orderId: f.orderAlert.orderId } : {}}
            onClick={f.dismissOrderAlert}
            className="flex-1 text-xl font-black underline-offset-4 hover:underline"
          >
            🔔 {f.orderAlert.title}{f.orderAlert.body ? ` — ${f.orderAlert.body}` : ""}
          </Link>
          <button
            onClick={f.dismissOrderAlert}
            aria-label="סגור"
            className="btn-field min-h-12 border-primary-foreground/30 bg-card px-3 text-card-foreground"
          >
            ✕
          </button>
        </div>
      )}
      <main className="flex-1 p-4">{children}</main>
      {f.flash && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/60">
          <div className="animate-pop flex size-48 items-center justify-center rounded-full bg-success text-9xl font-black text-success-foreground">✓</div>
        </div>
      )}
    </div>
  );
}

export function PhotoButton({ label, onFiles, multiple, done }: { label: string; onFiles: (f: File[]) => void; multiple?: boolean; done?: boolean }) {
  return (
    <label className={`btn-field w-full cursor-pointer ${done ? "border-success bg-success text-success-foreground" : "border-primary bg-card"}`}>
      📷 {label} {done && "✓"}
      <input type="file" accept="image/*" capture="environment" multiple={multiple} className="hidden"
        onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length) onFiles(fs); e.target.value = ""; }} />
    </label>
  );
}

export function BigInput(props: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const { label, ...rest } = props;
  return (
    <label className="block">
      <span className="mb-1 block text-lg font-bold">{label}</span>
      <input {...rest} className="h-16 w-full rounded-xl border-[3px] border-input bg-card px-4 text-2xl font-bold outline-none focus:border-ring" />
    </label>
  );
}
