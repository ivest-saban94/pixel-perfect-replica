"use client";

export function QuantityStepper({
  value,
  onChange,
  min = -99,
  max = 99,
}: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className="w-11 h-11 rounded-xl border border-[var(--studio-border,#dfe4ec)] bg-white text-xl font-bold"
        onClick={() => onChange(Math.max(min, value - 1))}
        aria-label="הקטן"
      >
        −
      </button>
      <span className="w-12 text-center text-lg font-semibold studio-tabular">{value}</span>
      <button
        type="button"
        className="w-11 h-11 rounded-xl border border-[var(--studio-border,#dfe4ec)] bg-white text-xl font-bold"
        onClick={() => onChange(Math.min(max, value + 1))}
        aria-label="הגדל"
      >
        +
      </button>
    </div>
  );
}
