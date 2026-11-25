"use client";

export function TimePicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: string;
  onChange: (v: string) => void;
}) {
  const setNow = () => {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    onChange(`${hh}:${mm}`);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-[var(--studio-muted,#64748b)]">{label}</label>
      <div className="flex gap-2 items-center">
        <input
          type="time"
          className="studio-input studio-tabular flex-1"
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" className="studio-btn-amber text-sm px-3 shrink-0" onClick={setNow}>
          עכשיו
        </button>
      </div>
    </div>
  );
}
