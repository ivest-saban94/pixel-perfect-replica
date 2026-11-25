"use client";
import { useMemo, useState } from "react";
import { TimePicker } from "./TimePicker";
import { QuantityStepper } from "./QuantityStepper";
import type { DeliveryNote, OverlayPayload } from "@/lib/delivery/types";

function duration(from?: string, to?: string) {
  if (!from || !to) return null;
  const [h1, m1] = from.split(":").map(Number);
  const [h2, m2] = to.split(":").map(Number);
  if ([h1, m1, h2, m2].some((n) => Number.isNaN(n))) return null;
  let mins = h2! * 60 + m2! - (h1! * 60 + m1!);
  if (mins < 0) mins += 24 * 60;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

export function OverlayForm({
  note,
  onSubmit,
}: {
  note: DeliveryNote;
  onSubmit: (payload: OverlayPayload) => Promise<void>;
}) {
  const isHikmat = /חכמת|حكمت|615-41-002/.test(`${note.driverName || ""} ${note.truckId || ""}`);

  const [craneOpen, setCraneOpen] = useState("");
  const [craneClose, setCraneClose] = useState("");
  const [waitFrom, setWaitFrom] = useState("");
  const [waitUntil, setWaitUntil] = useState("");
  const [craneType, setCraneType] = useState<"9m" | "15m">("15m");
  const [workType, setWorkType] = useState("");
  const [workStart, setWorkStart] = useState("");
  const [workEnd, setWorkEnd] = useState("");
  const [deposits, setDeposits] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    note.deposits.forEach((d) => {
      init[d.sku] = d.qty;
    });
    return init;
  });
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const craneDur = useMemo(() => duration(craneOpen, craneClose), [craneOpen, craneClose]);
  const waitDur = useMemo(() => duration(waitFrom, waitUntil), [waitFrom, waitUntil]);
  const workDur = useMemo(() => duration(workStart, workEnd), [workStart, workEnd]);

  async function handleSubmit() {
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        deliveryId: note.id,
        docNumber: note.docNumber,
        truck: note.truckId,
        driver: note.driverName,
        customer: note.customerName,
        craneOpen: craneOpen || undefined,
        craneClose: craneClose || undefined,
        waitFrom: waitFrom || undefined,
        waitUntil: waitUntil || undefined,
        craneWork: isHikmat
          ? { type: craneType, workType, start: workStart, end: workEnd }
          : undefined,
        depositsAdjust: deposits,
        notes: notes || undefined,
        sourceFileUrl: note.sourceFileUrl,
        submittedAt: new Date().toISOString(),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="studio-card p-5 flex flex-col gap-5">
      <h2 className="text-lg font-bold text-[var(--studio-primary,#0f4c81)] m-0">
        שדות נהג – תעודה {note.docNumber || "—"}
      </h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <TimePicker label="פתיחת מנוף" value={craneOpen} onChange={setCraneOpen} />
        <TimePicker label="סגירת מנוף" value={craneClose} onChange={setCraneClose} />
      </div>
      {craneDur && (
        <p className="text-sm text-[var(--studio-muted,#64748b)] m-0">
          משך מנוף: <strong className="studio-tabular text-[var(--studio-primary,#0f4c81)]">{craneDur}</strong>
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <TimePicker label="המתנה משעה" value={waitFrom} onChange={setWaitFrom} />
        <TimePicker label="המתנה עד שעה" value={waitUntil} onChange={setWaitUntil} />
      </div>
      {waitDur && (
        <p className="text-sm text-[var(--studio-muted,#64748b)] m-0">
          משך המתנה: <strong className="studio-tabular">{waitDur}</strong>
        </p>
      )}

      {isHikmat && (
        <div className="rounded-xl border border-[var(--studio-border,#dfe4ec)] bg-[var(--studio-amber-soft,#fef3c7)] p-4 flex flex-col gap-3">
          <div className="font-semibold text-[var(--studio-primary,#0f4c81)]">עבודות מנוף (חכמת)</div>
          <div className="flex gap-3">
            <button
              type="button"
              className={`px-4 py-2 rounded-lg font-medium ${
                craneType === "9m"
                  ? "bg-[var(--studio-primary,#0f4c81)] text-white"
                  : "bg-white border border-[var(--studio-border,#dfe4ec)]"
              }`}
              onClick={() => setCraneType("9m")}
            >
              9 מ׳
            </button>
            <button
              type="button"
              className={`px-4 py-2 rounded-lg font-medium ${
                craneType === "15m"
                  ? "bg-[var(--studio-primary,#0f4c81)] text-white"
                  : "bg-white border border-[var(--studio-border,#dfe4ec)]"
              }`}
              onClick={() => setCraneType("15m")}
            >
              15 מ׳
            </button>
          </div>
          <input
            className="studio-input"
            placeholder="סוג עבודה"
            value={workType}
            onChange={(e) => setWorkType(e.target.value)}
          />
          <div className="grid grid-cols-2 gap-3">
            <TimePicker label="התחלה" value={workStart} onChange={setWorkStart} />
            <TimePicker label="סיום" value={workEnd} onChange={setWorkEnd} />
          </div>
          {workDur && (
            <p className="text-sm m-0">
              משך עבודה: <strong className="studio-tabular">{workDur}</strong>
            </p>
          )}
        </div>
      )}

      {note.deposits.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="font-semibold">פקדונות / החזרות</div>
          {note.deposits.map((d) => (
            <div
              key={d.sku}
              className="flex items-center justify-between gap-3 py-2 border-b border-[var(--studio-border,#dfe4ec)]"
            >
              <div>
                <div className="font-medium">{d.description}</div>
                <div className="text-xs text-[var(--studio-muted,#64748b)] studio-tabular">{d.sku}</div>
              </div>
              <QuantityStepper
                value={deposits[d.sku] ?? 0}
                onChange={(n) => setDeposits((prev) => ({ ...prev, [d.sku]: n }))}
              />
            </div>
          ))}
        </div>
      )}

      <div>
        <label className="text-sm font-medium text-[var(--studio-muted,#64748b)]">הערות</label>
        <textarea
          className="studio-input mt-1.5 min-h-[90px] resize-y"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="הערות נהג / אתר..."
        />
      </div>

      {error && <p className="text-sm text-red-600 m-0">{error}</p>}

      <button type="button" className="studio-btn-primary w-full" disabled={busy} onClick={handleSubmit}>
        {busy ? "שולח..." : "סיום ושליחה לגיליון"}
      </button>
    </div>
  );
}
