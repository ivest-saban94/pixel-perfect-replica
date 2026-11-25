import { createFileRoute, Link } from "@tanstack/react-router";
import { useField } from "@/components/field/FieldContext";
import { PWAInstallButton } from "@/components/field/PWAInstallButton";
import { Shell } from "@/components/field/Shell";
import { TRUCKS } from "@/lib/field/config";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "סבן שטח – מסך בית" },
      { name: "description", content: "מסך הבית של נהגי ח. סבן: טכוגרף, תעודות, מנוף ופקדונות" },
      { property: "og:title", content: "סבן שטח – מסך בית" },
      {
        property: "og:description",
        content: "מסך הבית של נהגי ח. סבן: טכוגרף, תעודות, מנוף ופקדונות",
      },
    ],
  }),
  component: Home,
});

function Home() {
  const f = useField();
  if (!f.ready) return <div className="min-h-screen bg-background" />;
  if (!f.truck) {
    return (
      <Shell title={f.t("chooseTruck")} back={false}>
        <div className="mx-auto grid max-w-xl gap-4">
          {TRUCKS.map((tk) => (
            <button
              key={tk.id}
              type="button"
              onClick={() => f.setTruck(tk.id)}
              className="btn-field min-h-32 flex-col border-brand bg-card text-3xl"
            >
              <span>{f.lang === "he" ? tk.driver : tk.driverAr}</span>
              <span className="text-xl text-muted-foreground" dir="ltr">
                {tk.id} · {tk.type === "crane" ? f.t("craneTruckLabel") : f.t("distTruckLabel")}
              </span>
            </button>
          ))}
          <PWAInstallButton />
        </div>
      </Shell>
    );
  }
  const open = !!f.day && !f.day.closeAt;
  const closed = !!f.day?.closeAt;
  const tiles = [
    {
      to: "/tacho",
      label: open ? f.t("closeDay") : closed ? f.t("reopenDemoShift") : f.t("openDay"),
      icon: "⏱",
      enabled: true,
    },
    { to: "/orders", label: f.t("orders"), icon: "📋", enabled: true },
    { to: "/pod", label: f.t("scanPod"), icon: "📄", enabled: open },
    { to: "/crane", label: f.t("crane"), icon: "🏗", enabled: open && f.truck.type === "crane" },
    { to: "/deposits", label: f.t("deposits"), icon: "🔁", enabled: open },
  ] as const;

  return (
    <Shell
      title={`${f.lang === "he" ? f.truck.driver : f.truck.driverAr} · ${f.truck.id}`}
      back={false}
    >
      {!open && !closed && (
        <p className="mb-4 rounded-xl border-[3px] border-brand bg-card p-4 text-xl font-bold">
          ⚠ {f.t("mustOpen")}
        </p>
      )}
      {closed && (
        <div className="mb-4 grid gap-3 rounded-xl border-[3px] border-success bg-card p-4">
          <div className="rounded-lg bg-success p-3 text-xl font-bold text-success-foreground">
            ✓ {f.t("dayClosed")}
          </div>
          <button
            type="button"
            onClick={() => void f.resetDay()}
            className="btn-field w-full border-brand bg-brand text-brand-foreground"
          >
            ↺ {f.t("reopenDemoShift")}
          </button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-4">
        {tiles.map((x) =>
          x.enabled ? (
            <Link
              key={x.to}
              to={x.to}
              className="btn-field aspect-square flex-col border-primary bg-card text-center text-2xl"
            >
              <span className="text-6xl">{x.icon}</span>
              {x.label}
            </Link>
          ) : (
            <div
              key={x.to}
              className="btn-field aspect-square flex-col border-border bg-muted text-center text-2xl opacity-40"
            >
              <span className="text-6xl">{x.icon}</span>
              {x.label}
            </div>
          ),
        )}
      </div>
      <div className="mt-4 grid gap-3">
        <Link
          to="/summary"
          className="btn-field w-full border-brand bg-brand text-brand-foreground"
        >
          📊 {f.t("summary")}
        </Link>
        <PWAInstallButton />
      </div>
    </Shell>
  );
}
