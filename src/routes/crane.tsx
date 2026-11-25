import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useField } from "@/components/field/FieldContext";
import { BigInput, PhotoButton, Shell } from "@/components/field/Shell";
import { enqueue, kvGet, kvSet } from "@/lib/field/db";
import {
  DRIVE_FOLDER,
  SHEET_ID_MAIN,
  TAB_CRANE,
  emailForTruck,
  jerusalemDate,
  jerusalemTime,
  uniqueKey,
} from "@/lib/field/config";

export const Route = createFileRoute("/crane")({
  head: () => ({
    meta: [
      { title: "הפעלת מנוף | סבן שטח" },
      { name: "description", content: "טיימר מנוף עם GPS או רישום ידני לפענוח OCR" },
      { property: "og:title", content: "הפעלת מנוף | סבן שטח" },
      { property: "og:description", content: "טיימר מנוף עם GPS" },
    ],
  }),
  component: Crane,
});

type Run = { start: number; lat?: number; lng?: number };
const gps = () =>
  new Promise<GeolocationPosition | null>((r) =>
    navigator.geolocation
      ? navigator.geolocation.getCurrentPosition(r, () => r(null), {
          timeout: 8000,
          enableHighAccuracy: true,
        })
      : r(null),
  );

function Crane() {
  const f = useField();
  const [run, setRun] = useState<Run | null>(null);
  const [now, setNow] = useState(Date.now());
  const [doc, setDoc] = useState("");
  const [photo, setPhoto] = useState("");

  useEffect(() => {
    void kvGet<Run>("craneRun").then((r) => setRun(r ?? null));
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!f.truck) return null;
  if (f.truck.type !== "crane") {
    return (
      <Shell title={f.t("crane")}>
        <p className="text-2xl font-bold">{f.t("craneOnly")}</p>
      </Shell>
    );
  }

  const el = run ? Math.floor((now - run.start) / 1000) : 0;
  const hms = `${String(Math.floor(el / 3600)).padStart(2, "0")}:${String(Math.floor(el / 60) % 60).padStart(2, "0")}:${String(el % 60).padStart(2, "0")}`;

  async function start() {
    const r: Run = { start: Date.now() };
    setRun(r);
    await kvSet("craneRun", r);
    f.confirm();
    const p = await gps();
    if (p) {
      r.lat = p.coords.latitude;
      r.lng = p.coords.longitude;
      await kvSet("craneRun", r);
    }
  }

  async function stop() {
    const p = await gps();
    const end = Date.now();
    await enqueue("crane", `crane|${f.truck!.id}|${run!.start}`, {
      mode: "timer",
      truck: f.truck!.id,
      driver: f.truck!.driver,
      docNumber: doc || null,
      start: run!.start,
      end,
      seconds: Math.round((end - run!.start) / 1000),
      startGps: [run!.lat, run!.lng],
      endGps: p ? [p.coords.latitude, p.coords.longitude] : null,
      sheetId: SHEET_ID_MAIN,
      sheet: TAB_CRANE,
      notify: { whatsapp: false, email: emailForTruck(f.truck!.id) },
    });
    await kvSet(
      "craneSec",
      ((await kvGet<number>("craneSec")) ?? 0) + Math.round((end - run!.start) / 1000),
    );
    await kvSet("craneRun", null);
    setRun(null);
    setDoc("");
    f.confirm();
  }

  async function sendOcr() {
    await enqueue("crane", uniqueKey(`crane-ocr-${doc}`), {
      mode: "ocr",
      truck: f.truck!.id,
      driver: f.truck!.driver,
      docNumber: doc,
      photo,
      fileName: `crane_ocr_${doc}_${jerusalemDate()}.jpg`,
      folder: DRIVE_FOLDER,
      at: Date.now(),
      sheetId: SHEET_ID_MAIN,
      sheet: TAB_CRANE,
      notify: { whatsapp: false, email: emailForTruck(f.truck!.id) },
    });
    setPhoto("");
    setDoc("");
    f.confirm();
  }

  return (
    <Shell title={f.t("crane")}>
      <div className="mx-auto grid max-w-xl gap-5">
        <div className="rounded-2xl border-[3px] border-brand bg-card p-6 text-center">
          <div className="text-7xl font-black tabular-nums" dir="ltr">
            {hms}
          </div>
          {run && (
            <div className="mt-2 text-lg text-muted-foreground">
              {f.t("start")}: {jerusalemTime(run.start)}
            </div>
          )}
        </div>
        <BigInput
          label={`${f.t("docNumber")} (אופציונלי)`}
          inputMode="numeric"
          value={doc}
          onChange={(e) => setDoc(e.target.value)}
          dir="ltr"
        />
        {!run ? (
          <button
            onClick={start}
            className="btn-field min-h-24 border-success bg-success text-success-foreground text-3xl"
          >
            ▶ {f.t("start")}
          </button>
        ) : (
          <button
            onClick={stop}
            className="btn-field min-h-24 border-destructive bg-destructive text-destructive-foreground text-3xl"
          >
            ■ {f.t("stop")}
          </button>
        )}
        <hr className="border-2" />
        <h2 className="text-xl font-bold">{f.t("manualOcr")}</h2>
        <PhotoButton
          label={f.t("scanPod")}
          mode="document"
          done={!!photo}
          onCaptured={([url]) => {
            if (url) setPhoto(url);
          }}
        />
        <button
          disabled={!photo || !doc}
          onClick={sendOcr}
          className="btn-field border-brand bg-brand text-brand-foreground"
        >
          {f.t("save")}
        </button>
      </div>
    </Shell>
  );
}
