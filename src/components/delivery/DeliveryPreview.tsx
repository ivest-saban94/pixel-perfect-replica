"use client";
import type { DeliveryNote, OverlayPayload } from "@/lib/delivery/types";
import { OverlayForm } from "./OverlayForm";
import { studioCssVars } from "@/lib/delivery/design";

export function DeliveryPreview({
  note,
  onSubmit,
}: {
  note: DeliveryNote;
  onSubmit: (p: OverlayPayload) => Promise<void>;
}) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: studioCssVars }} />
      <div className="studio-root min-h-screen p-4 md:p-6" dir="rtl">
        <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="studio-card overflow-hidden flex flex-col">
            <div className="px-4 py-3 border-b border-[var(--studio-border,#dfe4ec)] flex items-center justify-between">
              <span className="font-semibold text-[var(--studio-primary,#0f4c81)]">
                תעודה {note.docNumber || "—"}
              </span>
              <span className="text-sm text-[var(--studio-muted,#64748b)]">{note.customerName}</span>
            </div>
            <div className="flex-1 bg-[#e8ecf1] min-h-[420px] flex items-center justify-center p-4">
              {note.sourceFileUrl ? (
                note.sourceFileUrl.toLowerCase().includes(".pdf") ? (
                  <iframe
                    src={note.sourceFileUrl}
                    className="w-full h-[70vh] rounded-lg bg-white"
                    title="תעודה"
                  />
                ) : (
                  <img
                    src={note.sourceFileUrl}
                    alt="תעודת משלוח"
                    className="max-w-full max-h-[70vh] object-contain rounded-lg shadow"
                  />
                )
              ) : (
                <div className="text-center text-[var(--studio-muted,#64748b)] p-8">
                  <p className="font-medium">אין קובץ מקור</p>
                  <p className="text-sm mt-1">העלה PDF או תמונה כדי לראות תצוגה מקדימה</p>
                </div>
              )}
            </div>
            <div className="p-4 border-t border-[var(--studio-border,#dfe4ec)] text-sm space-y-1">
              <div>
                <span className="text-[var(--studio-muted,#64748b)]">לקוח: </span>
                {note.customerName || "—"}
                {note.customerCode && (
                  <span className="studio-tabular text-[var(--studio-muted,#64748b)]"> ({note.customerCode})</span>
                )}
              </div>
              {note.deliveryAddress && (
                <div>
                  <span className="text-[var(--studio-muted,#64748b)]">כתובת: </span>
                  {note.deliveryAddress}
                </div>
              )}
              {note.truckId && (
                <div>
                  <span className="text-[var(--studio-muted,#64748b)]">רכב: </span>
                  <span className="studio-tabular">{note.truckId}</span>
                  {note.driverName && ` · ${note.driverName}`}
                </div>
              )}
              <div>
                <span className="text-[var(--studio-muted,#64748b)]">פריטים: </span>
                {note.lines.length} · פקדונות: {note.deposits.length}
              </div>
            </div>
          </div>

          <OverlayForm note={note} onSubmit={onSubmit} />
        </div>
      </div>
    </>
  );
}
