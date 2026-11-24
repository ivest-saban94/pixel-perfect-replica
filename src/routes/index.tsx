import { createFileRoute, Link } from "@tanstack/react-router";
import { useField } from "@/components/field/FieldContext";
import { Shell } from "@/components/field/Shell";
import { TRUCKS } from "@/lib/field/config";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [
    { title: "סבן שטח – מסך בית" },
    { name: "description", content: "מסך הבית של נהגי ח. סבן: טכוגרף, תעודות, מנוף ופקדונות" },
    { property: "og:title", content: "סבן שטח – מסך בית" },
    { property: "og:description", content: "מסך הבית של נהגי ח. סבן: טכוגרף, תעודות, מנוף ופקדונות" },
  ] }),
  component: Home,
});

function Home() {
  const f = useField();
  if (!f.ready) return <div className="min-h-screen bg-background" />;
  if (!f.truck) return (
    <Shell title={f.t("chooseTruck")} back={false}>
      <div className="grid gap-4">
        {TRUCKS.map((tk) => (
          <button key={tk.id} onClick={() => f.setTruck(tk.id)} className="btn-field min-h-32 flex-col border-primary bg-card text-3xl">
            <span>{f.lang === "he" ? tk.driver : tk.driverAr}</span>
            <span className="text-xl text-muted-foreground" dir="ltr">{tk.id}</span>
          </button>
        ))}
      </div>
    </Shell>
  );
  const open = !!f.day && !f.day.closeAt;
  const tiles = [
    { to: "/tacho", label: open ? f.t("closeDay") : f.t("openDay"), icon: "⏱", enabled: !f.day?.closeAt },
    { to: "/pod", label: f.t("scanPod"), icon: "📄", enabled: open },
    { to: "/crane", label: f.t("crane"), icon: "🏗", enabled: open && f.truck.type === "crane" },
    { to: "/deposits", label: f.t("deposits"), icon: "🔁", enabled: open },
  ] as const;
  return (
    <Shell title={`${f.lang === "he" ? f.truck.driver : f.truck.driverAr} · ${f.truck.id}`} back={false}>
      {!open && !f.day?.closeAt && <p className="mb-4 rounded-xl border-[3px] border-primary bg-card p-4 text-xl font-bold">⚠ {f.t("mustOpen")}</p>}
      {f.day?.closeAt && <p className="mb-4 rounded-xl bg-success p-4 text-xl font-bold text-success-foreground">✓ {f.t("dayClosed")}</p>}
      <div className="grid grid-cols-2 gap-4">
        {tiles.map((x) => x.enabled ? (
          <Link key={x.to} to={x.to} className="btn-field aspect-square flex-col border-primary bg-card text-2xl">
            <span className="text-6xl">{x.icon}</span>{x.label}
          </Link>
        ) : (
          <div key={x.to} className="btn-field aspect-square flex-col border-border bg-muted text-2xl opacity-40"><span className="text-6xl">{x.icon}</span>{x.label}</div>
        ))}
      </div>
      <Link to="/summary" className="btn-field mt-4 w-full border-accent bg-accent text-accent-foreground">📊 {f.t("summary")}</Link>
    </Shell>
  );
}
