import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useField } from "@/components/field/FieldContext";
import { BigInput, PhotoButton, Shell } from "@/components/field/Shell";
import { enqueue, kvGet, kvSet } from "@/lib/field/db";
import { enhanceDocument, pagesToPdf } from "@/lib/field/imaging";
import { matchLoadToPod, type LoadConfirmationSummary, type OrderRef } from "@/lib/field/loadMatch";
import {
  DRIVE_FOLDER,
  SHEET_ID_MAIN,
  TAB_POD,
  emailForTruck,
  overWeight,
  podFileName,
  uniqueKey,
} from "@/lib/field/config";

export const Route = createFileRoute("/pod")({
  validateSearch: (search: Record<string, unknown>): { orderId?: string } =>
    typeof search["orderId"] === "string" ? { orderId: search["orderId"] } : {},
  head: () => ({
    meta: [
      { title: "סריקת תעודת משלוח | סבן שטח" },
      { name: "description", content: "צילום מרובה עמודים, שיפור תמונה והמרה ל-PDF" },
      { property: "og:title", content: "סריקת תעודה | סבן שטח" },
      { property: "og:description", content: "צילום תעודה והמרה ל-PDF" },
    ],
  }),
  component: Pod,
});

interface ActivePodOrder extends OrderRef, LoadConfirmationSummary {}

function Pod() {
  const f = useField();
  const search = Route.useSearch();
  const [pages, setPages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [doc, setDoc] = useState("");
  const [cust, setCust] = useState("");
  const [tons, setTons] = useState("");
  const [code, setCode] = useState("");
  const [linkedOrder, setLinkedOrder] = useState<ActivePodOrder | null>(null);

  useEffect(() => {
    if (!search.orderId) return;
    void (async () => {
      const saved = await kvGet<ActivePodOrder>("active_pod_order");
      if (saved && saved.orderId === search.orderId) {
        setLinkedOrder(saved);
        if (saved.docNumber && !saved.docNumber.includes("ממתין")) {
          setDoc((prev) => prev || saved.docNumber || "");
        }
        if (saved.customerName) setCust((prev) => prev || saved.customerName);
        if (saved.tons != null) setTons((prev) => prev || String(saved.tons));
      }
    })();
  }, [search.orderId]);

  if (!f.truck) return null;
  const heavy = tons !== "" && overWeight(f.truck.id, Number(tons));
  const overrideOk = !heavy || code.length >= 4; // validated server-side against manager code
  const valid = pages.length > 0 && doc.trim() && cust.trim() && overrideOk;

  const matchResult =
    linkedOrder && (doc.trim() || cust.trim() || tons !== "")
      ? matchLoadToPod(linkedOrder, linkedOrder, {
          docNumber: doc,
          customer: cust,
          tons: tons ? Number(tons) : null,
        })
      : null;

  async function submit() {
    setBusy(true);
    const pdf = await pagesToPdf(pages);
    const fileName = podFileName(doc, cust);
    await enqueue("pod", uniqueKey(doc), {
      truck: f.truck!.id,
      driver: f.truck!.driver,
      docNumber: doc,
      customer: cust,
      tons: tons ? Number(tons) : null,
      overrideCode: heavy ? code : null,
      fileName,
      folder: DRIVE_FOLDER,
      pdf,
      at: Date.now(),
      sheetId: SHEET_ID_MAIN,
      sheet: TAB_POD,
      notify: { email: emailForTruck(f.truck!.id) },
    });
    await kvSet("podCount", ((await kvGet<number>("podCount")) ?? 0) + 1);
    f.confirm();
    setPages([]);
    setDoc("");
    setCust("");
    setTons("");
    setCode("");
    setLinkedOrder(null);
    setBusy(false);
  }

  return (
    <Shell title={f.t("scanPod")}>
      <div className="mx-auto grid max-w-xl gap-5">
        <PhotoButton
          label={`${f.t("addPage")} (${pages.length} ${f.t("pages")})`}
          multiple
          onFiles={async (fs) => {
            setBusy(true);
            const out = await Promise.all(fs.map((x) => enhanceDocument(x)));
            setPages((p) => [...p, ...out]);
            setBusy(false);
          }}
        />
        {pages.length > 0 && (
          <div className="grid grid-cols-3 gap-2">
            {pages.map((p, i) => (
              <button
                key={i}
                onClick={() => setPages(pages.filter((_, j) => j !== i))}
                className="relative"
              >
                <img
                  src={p}
                  alt=""
                  className="aspect-[3/4] w-full rounded-lg border-2 object-cover"
                />
                <span className="absolute top-1 left-1 rounded-full bg-destructive px-2 font-bold text-destructive-foreground">
                  ✕
                </span>
              </button>
            ))}
          </div>
        )}
        <BigInput
          label={f.t("docNumber")}
          inputMode="numeric"
          value={doc}
          onChange={(e) => setDoc(e.target.value)}
          dir="ltr"
        />
        <BigInput label={f.t("customer")} value={cust} onChange={(e) => setCust(e.target.value)} />
        <BigInput
          label={`${f.t("weight")} – מקס׳ ${f.truck.maxTons}`}
          inputMode="decimal"
          value={tons}
          onChange={(e) => setTons(e.target.value.replace(/[^\d.]/g, ""))}
          dir="ltr"
        />
        {matchResult && (
          <div
            className={`grid gap-1 rounded-xl border-[3px] p-4 text-lg font-bold ${
              matchResult.match === "full"
                ? "border-success bg-success/15"
                : matchResult.match === "partial"
                  ? "border-primary bg-card"
                  : "border-destructive bg-card text-destructive"
            }`}
          >
            <div className="text-xl font-black">
              {matchResult.match === "full"
                ? `✅ ${f.t("loadMatchFull")}`
                : matchResult.match === "partial"
                  ? `⚠ ${f.t("loadMatchPartial")}`
                  : `⛔ ${f.t("loadMatchFail")}`}
            </div>
            {matchResult.gaps.map((g, i) => (
              <p key={i}>• {g}</p>
            ))}
          </div>
        )}
        {heavy && (
          <div className="grid gap-3 rounded-xl border-[3px] border-destructive p-4">
            <p className="text-xl font-black text-destructive">⛔ {f.t("overweight")}</p>
            <BigInput
              label={f.t("overrideCode")}
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              dir="ltr"
            />
          </div>
        )}
        <button
          disabled={!valid || busy}
          onClick={submit}
          className="btn-field border-primary bg-primary text-primary-foreground text-2xl"
        >
          {busy ? "…" : f.t("createPdf")}
        </button>
      </div>
    </Shell>
  );
}
