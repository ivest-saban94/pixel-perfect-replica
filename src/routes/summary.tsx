import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useField } from "@/components/field/FieldContext";
import { Shell } from "@/components/field/Shell";
import { kvGet } from "@/lib/field/db";

export const Route = createFileRoute("/summary")({
  head: () => ({ meta: [
    { title: "סיכום יום לנהג | סבן שטח" },
    { name: "description", content: "תעודות, פקדונות, מזומן ושעות מנוף של היום" },
    { property: "og:title", content: "סיכום יום | סבן שטח" },
    { property: "og:description", content: "סיכום היום של הנהג" },
  ] }),
  component: Summary,
});

function Summary() {
  const f = useField();
  const [s, setS] = useState({ pods: 0, items: 0, cash: 0, crane: 0 });
  useEffect(() => { void (async () => {
    const d = (await kvGet<{ items: number; cash: number }>("depSum")) ?? { items: 0, cash: 0 };
    setS({ pods: (await kvGet<number>("podCount")) ?? 0, items: d.items, cash: d.cash, crane: (await kvGet<number>("craneSec")) ?? 0 });
  })(); }, []);
  const km = f.day?.closeOdo != null ? f.day.closeOdo - f.day.openOdo : null;
  const rows: [string, string][] = [
    [f.t("docs"), String(s.pods)], [f.t("deposits"), String(s.items)], [`${f.t("cash")} ₪`, s.cash.toFixed(0)],
    [f.t("craneHours"), (s.crane / 3600).toFixed(2)], [f.t("km"), km == null ? "—" : String(km)], [f.t("pending"), String(f.pending)],
  ];
  return (
    <Shell title={f.t("summary")}>
      <div className="mx-auto grid max-w-xl grid-cols-2 gap-4">
        {rows.map(([k, v]) => (
          <div key={k} className="rounded-2xl border-[3px] border-primary bg-card p-5 text-center">
            <div className="text-5xl font-black" dir="ltr">{v}</div><div className="mt-2 text-lg font-bold text-muted-foreground">{k}</div>
          </div>
        ))}
      </div>
    </Shell>
  );
}
