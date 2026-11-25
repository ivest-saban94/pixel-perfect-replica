import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useField } from "@/components/field/FieldContext";
import { BigInput, PhotoButton, Shell } from "@/components/field/Shell";
import { enqueue, kvSet } from "@/lib/field/db";
import {
  DRIVE_FOLDER,
  SHEET_ID_MAIN,
  TAB_TACHO,
  dailyKm,
  emailForTruck,
  jerusalemDate,
} from "@/lib/field/config";

export const Route = createFileRoute("/tacho")({
  head: () => ({
    meta: [
      { title: "טכוגרף – פתיחה וסגירת יום | סבן שטח" },
      { name: "description", content: "צילום דיסקית והזנת מד אוץ לפתיחה וסגירת יום" },
      { property: "og:title", content: "טכוגרף | סבן שטח" },
      { property: "og:description", content: "צילום דיסקית והזנת מד אוץ" },
    ],
  }),
  component: Tacho,
});

function Tacho() {
  const f = useField();
  const nav = useNavigate();
  const [photo, setPhoto] = useState<string>("");
  const [odo, setOdo] = useState("");
  if (!f.truck) return null;

  const closed = !!f.day?.closeAt;
  const closing = !!f.day && !f.day.closeAt;
  const n = Number(odo);
  const km = closing && odo ? dailyKm(f.day!.openOdo, n) : null;
  const valid = !!photo && odo !== "" && n > 0 && (!closing || km !== null);
  const keySuffix = f.shiftCycle > 0 ? `|r${f.shiftCycle}` : "";

  async function save() {
    const now = Date.now();
    const date = jerusalemDate();
    if (!closing) {
      await Promise.all([
        kvSet("podCount", 0),
        kvSet("depSum", { items: 0, cash: 0 }),
        kvSet("craneSec", 0),
      ]);
      f.setDay({ date, truck: f.truck!.id, openOdo: n, openPhoto: photo, openAt: now });
      await enqueue("tacho", `tacho-open|${f.truck!.id}|${date}${keySuffix}`, {
        type: "open",
        truck: f.truck!.id,
        driver: f.truck!.driver,
        odometer: n,
        photo,
        fileName: `tacho_open_${f.truck!.id}_${date}.jpg`,
        folder: DRIVE_FOLDER,
        at: now,
        sheetId: SHEET_ID_MAIN,
        sheet: TAB_TACHO,
        notify: { email: emailForTruck(f.truck!.id) },
      });
    } else {
      f.setDay({ ...f.day!, closeOdo: n, closePhoto: photo, closeAt: now });
      await enqueue("tacho", `tacho-close|${f.truck!.id}|${date}${keySuffix}`, {
        type: "close",
        truck: f.truck!.id,
        driver: f.truck!.driver,
        odometer: n,
        openOdo: f.day!.openOdo,
        km,
        photo,
        fileName: `tacho_close_${f.truck!.id}_${date}.jpg`,
        folder: DRIVE_FOLDER,
        at: now,
        sheetId: SHEET_ID_MAIN,
        sheet: TAB_TACHO,
        notify: { email: emailForTruck(f.truck!.id) },
      });
    }
    f.confirm();
    setTimeout(() => nav({ to: "/" }), 700);
  }

  if (closed) {
    const closedKm = f.day?.closeOdo != null ? f.day.closeOdo - f.day.openOdo : null;
    return (
      <Shell title={f.t("closeDay")}>
        <div className="mx-auto grid max-w-xl gap-5 rounded-2xl border-[3px] border-success bg-card p-6 text-center">
          <div className="rounded-xl bg-success p-4 text-2xl font-black text-success-foreground">
            ✓ {f.t("dayClosed")}
          </div>
          <p className="text-xl font-bold">
            {f.t("km")}: <span dir="ltr">{closedKm ?? "—"}</span>
          </p>
          <p className="text-lg font-bold text-muted-foreground">{f.t("demoClosedHint")}</p>
          <button
            type="button"
            onClick={() => {
              void f.resetDay();
              setPhoto("");
              setOdo("");
            }}
            className="btn-field w-full border-brand bg-brand text-brand-foreground text-2xl"
          >
            ↺ {f.t("reopenDemoShift")}
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title={closing ? f.t("closeDay") : f.t("openDay")}>
      <div className="mx-auto grid max-w-xl gap-5">
        <PhotoButton
          label={f.t("photoDisc")}
          mode="disc"
          done={!!photo}
          onCaptured={([dataUrl]) => {
            if (dataUrl) setPhoto(dataUrl);
          }}
        />
        {photo && (
          <img
            src={photo}
            alt=""
            className="max-h-64 w-full rounded-xl border-[3px] border-brand bg-white object-contain"
          />
        )}
        <BigInput
          label={f.t("odometer")}
          inputMode="numeric"
          value={odo}
          onChange={(e) => setOdo(e.target.value.replace(/\D/g, ""))}
          dir="ltr"
        />
        {closing && (
          <p className="text-xl font-bold">
            {f.t("km")}: <span dir="ltr">{km ?? "—"}</span>{" "}
            <span className="text-muted-foreground">(פתיחה: {f.day!.openOdo})</span>
          </p>
        )}
        <button
          disabled={!valid}
          onClick={save}
          className="btn-field border-brand bg-brand text-brand-foreground text-2xl"
        >
          {f.t("save")}
        </button>
      </div>
    </Shell>
  );
}
