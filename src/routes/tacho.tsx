import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useField } from "@/components/field/FieldContext";
import { BigInput, PhotoButton, Shell } from "@/components/field/Shell";
import { enqueue, kvSet } from "@/lib/field/db";
import { photoToDataUrl } from "@/lib/field/imaging";
import { DRIVE_FOLDER, SHEET_ID_MAIN, dailyKm, emailForTruck, jerusalemDate } from "@/lib/field/config";

export const Route = createFileRoute("/tacho")({
  head: () => ({ meta: [
    { title: "טכוגרף – פתיחה וסגירת יום | סבן שטח" },
    { name: "description", content: "צילום דיסקית והזנת מד אוץ לפתיחה וסגירת יום" },
    { property: "og:title", content: "טכוגרף | סבן שטח" },
    { property: "og:description", content: "צילום דיסקית והזנת מד אוץ" },
  ] }),
  component: Tacho,
});

function Tacho() {
  const f = useField(); const nav = useNavigate();
  const [photo, setPhoto] = useState<string>(""); const [odo, setOdo] = useState("");
  if (!f.truck) return null;
  const closing = !!f.day && !f.day.closeAt;
  const n = Number(odo);
  const km = closing && odo ? dailyKm(f.day!.openOdo, n) : null;
  const valid = !!photo && odo !== "" && n > 0 && (!closing || km !== null);

  async function save() {
    const now = Date.now(); const date = jerusalemDate();
    if (!closing) {
      await Promise.all([kvSet("podCount", 0), kvSet("depSum", { items: 0, cash: 0 }), kvSet("craneSec", 0)]);
      f.setDay({ date, truck: f.truck!.id, openOdo: n, openPhoto: photo, openAt: now });
      await enqueue("tacho", `tacho-open|${f.truck!.id}|${date}`, {
        type: "open", truck: f.truck!.id, driver: f.truck!.driver, odometer: n, photo,
        fileName: `tacho_open_${f.truck!.id}_${date}.jpg`, folder: DRIVE_FOLDER, at: now,
        sheetId: SHEET_ID_MAIN, sheet: "ארכיון_טכוגרף", notify: { email: emailForTruck(f.truck!.id) },
      });
    } else {
      f.setDay({ ...f.day!, closeOdo: n, closePhoto: photo, closeAt: now });
      await enqueue("tacho", `tacho-close|${f.truck!.id}|${date}`, {
        type: "close", truck: f.truck!.id, driver: f.truck!.driver, odometer: n, km, photo,
        fileName: `tacho_close_${f.truck!.id}_${date}.jpg`, folder: DRIVE_FOLDER, at: now,
        sheetId: SHEET_ID_MAIN, sheet: "ארכיון_טכוגרף", notify: { email: emailForTruck(f.truck!.id) },
      });
    }
    f.confirm(); setTimeout(() => nav({ to: "/" }), 700);
  }

  return (
    <Shell title={closing ? f.t("closeDay") : f.t("openDay")}>
      <div className="mx-auto grid max-w-xl gap-5">
        <PhotoButton label={f.t("photoDisc")} done={!!photo} onFiles={async ([file]) => setPhoto(await photoToDataUrl(file!))} />
        {photo && <img src={photo} alt="" className="max-h-64 w-full rounded-xl border-2 object-contain" />}
        <BigInput label={f.t("odometer")} inputMode="numeric" value={odo} onChange={(e) => setOdo(e.target.value.replace(/\D/g, ""))} dir="ltr" />
        {closing && <p className="text-xl font-bold">{f.t("km")}: <span dir="ltr">{km ?? "—"}</span> <span className="text-muted-foreground">(פתיחה: {f.day!.openOdo})</span></p>}
        <button disabled={!valid} onClick={save} className="btn-field border-primary bg-primary text-primary-foreground text-2xl">{f.t("save")}</button>
      </div>
    </Shell>
  );
}
