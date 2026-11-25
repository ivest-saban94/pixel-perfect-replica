import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { DeliveryPreview } from "@/components/delivery/DeliveryPreview";
import type { DeliveryNote, OverlayPayload } from "@/lib/delivery/types";
import { normalizeExtracted } from "@/lib/delivery/normalize";
import { studioCssVars } from "@/lib/delivery/design";

export const Route = createFileRoute("/delivery-overlay")({
  validateSearch: (search: Record<string, unknown>): { id?: string } =>
    typeof search["id"] === "string" ? { id: search["id"] } : {},
  head: () => ({
    meta: [
      { title: "שכבת תעודה חיה | סבן" },
      { name: "description", content: "תצוגה מקדימה + שדות נהג וכתיבה לגיליון" },
    ],
  }),
  component: DeliveryOverlayPage,
});

function DeliveryOverlayPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [note, setNote] = useState<DeliveryNote | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!search.id) return;
    const raw = sessionStorage.getItem(`delivery:${search.id}`);
    if (raw) {
      try {
        setNote(JSON.parse(raw) as DeliveryNote);
      } catch {
        /* ignore */
      }
    }
  }, [search.id]);

  async function handleExtract() {
    if (!file) return;
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/delivery-extract", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok || !data.note) throw new Error(data.error || "חילוץ נכשל");
      const n = data.note as DeliveryNote;
      sessionStorage.setItem(`delivery:${n.id}`, JSON.stringify(n));
      setNote(n);
      navigate({ to: "/delivery-overlay", search: { id: n.id } });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit(payload: OverlayPayload) {
    const res = await fetch("/api/delivery-overlay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || "שליחה לגיליון נכשלה");
    }
    setMsg(`נשמר בגיליון · מפתח ${data.key}`);
    setTimeout(() => navigate({ to: "/" }), 1500);
  }

  if (note) {
    return <DeliveryPreview note={note} onSubmit={handleSubmit} />;
  }

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: studioCssVars }} />
      <div className="studio-root min-h-screen flex items-center justify-center p-6" dir="rtl">
        <div className="studio-card max-w-md w-full p-8 flex flex-col gap-5">
          <h1 className="text-2xl font-bold text-[var(--studio-primary,#0f4c81)] m-0">קליטת תעודת משלוח</h1>
          <p className="text-[var(--studio-muted,#64748b)] text-sm m-0">
            העלה PDF או תמונה. המערכת תחלץ נתונים, תפתח תצוגה מקדימה חיה ותכתוב לגיליון לאחר אישור הנהג.
          </p>
          <input
            type="file"
            accept="application/pdf,image/*"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="studio-input"
          />
          <button className="studio-btn-primary" disabled={!file || busy} onClick={handleExtract}>
            {busy ? "מעבד..." : "חלץ ופתח תצוגה מקדימה"}
          </button>
          {msg && <p className="text-sm text-red-600 m-0">{msg}</p>}
          <button
            type="button"
            className="text-sm text-[var(--studio-primary,#0f4c81)] underline bg-transparent border-0 cursor-pointer"
            onClick={() => {
              const demo = normalizeExtracted({
                docNumber: "DEMO-001",
                customerName: "לקוח לדוגמה",
                truckId: "615-41-002",
                driverName: "חכמת גאבר",
                lines: [{ sku: "11570", description: "חמרה שק גדול", qty: 18 }],
                deposits: [
                  { sku: "60002", description: "שק גדול (בלה)", qty: 2 },
                  { sku: "60060", description: "משטח סבן", qty: 1 },
                ],
              });
              sessionStorage.setItem(`delivery:${demo.id}`, JSON.stringify(demo));
              setNote(demo);
              navigate({ to: "/delivery-overlay", search: { id: demo.id } });
            }}
          >
            פתח דמו (חכמת + פקדונות)
          </button>
        </div>
      </div>
    </>
  );
}
