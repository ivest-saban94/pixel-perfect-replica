import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useField } from "@/components/field/FieldContext";
import { BigInput, PhotoButton, Shell } from "@/components/field/Shell";
import { enqueue, kvGet, kvSet } from "@/lib/field/db";
import { photoToDataUrl } from "@/lib/field/imaging";
import { DEPOSIT_ITEMS, DRIVE_FOLDER, SHEET_ID_MAIN, emailForTruck, jerusalemDate, uniqueKey } from "@/lib/field/config";

export const Route = createFileRoute("/deposits")({
  head: () => ({ meta: [
    { title: "החזרות ופקדונות | סבן שטח" },
    { name: "description", content: "דיווח מהיר של משטחים, שקים וגבייה" },
    { property: "og:title", content: "החזרות ופקדונות | סבן שטח" },
    { property: "og:description", content: "דיווח משטחים, שקים וגבייה" },
  ] }),
  component: Deposits,
});

function Deposits() {
  const f = useField();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [two, setTwo] = useState(false); const [doc, setDoc] = useState("");
  const [method, setMethod] = useState<"cash" | "check" | null>(null); const [amount, setAmount] = useState(""); const [receipt, setReceipt] = useState("");
  if (!f.truck) return null;
  const any = Object.values(counts).some((v) => v > 0);
  const payOk = !method || (Number(amount) > 0 && !!receipt);
  const valid = !!doc && (any || method) && payOk;

  async function save() {
    await enqueue("deposit", uniqueKey(`dep-${doc}`), { truck: f.truck!.id, driver: f.truck!.driver, docNumber: doc, items: counts, twoSites: two, payment: method ? { method, amount: Number(amount), receipt } : null, fileName: receipt ? `receipt_${doc}_${jerusalemDate()}.jpg` : undefined, folder: DRIVE_FOLDER, at: Date.now(), sheetId: SHEET_ID_MAIN, sheet: "אתרי_לקוחות", notify: { whatsapp: false, email: emailForTruck(f.truck!.id) } });
    const s = (await kvGet<{ items: number; cash: number }>("depSum")) ?? { items: 0, cash: 0 };
    await kvSet("depSum", { items: s.items + Object.values(counts).reduce((a, b) => a + b, 0), cash: s.cash + (method ? Number(amount) : 0) });
    setCounts({}); setTwo(false); setDoc(""); setMethod(null); setAmount(""); setReceipt(""); f.confirm();
  }

  return (
    <Shell title={f.t("deposits")}>
      <div className="mx-auto grid max-w-xl gap-4">
        <BigInput label={f.t("docNumber")} inputMode="numeric" value={doc} onChange={(e) => setDoc(e.target.value)} dir="ltr" />
        {DEPOSIT_ITEMS.map((it) => (
          <div key={it.sku} className="flex items-center gap-3 rounded-xl border-2 bg-card p-3">
            <div className="flex-1"><div className="text-xl font-bold">{f.lang === "he" ? it.he : it.ar}</div><div className="text-muted-foreground" dir="ltr">{it.sku}</div></div>
            <button onClick={() => setCounts({ ...counts, [it.sku]: Math.max(0, (counts[it.sku] ?? 0) - 1) })} className="btn-field size-16 border-border bg-secondary text-3xl">−</button>
            <span className="w-12 text-center text-3xl font-black">{counts[it.sku] ?? 0}</span>
            <button onClick={() => setCounts({ ...counts, [it.sku]: (counts[it.sku] ?? 0) + 1 })} className="btn-field size-16 border-primary bg-primary text-primary-foreground text-3xl">+1</button>
          </div>
        ))}
        <button onClick={() => setTwo(!two)} className={`btn-field ${two ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card"}`}>{two ? "☑" : "☐"} {f.t("twoSites")}</button>
        <div className="grid grid-cols-2 gap-3">
          {(["cash", "check"] as const).map((m) => (
            <button key={m} onClick={() => setMethod(method === m ? null : m)} className={`btn-field ${method === m ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card"}`}>{f.t(m)}</button>
          ))}
        </div>
        {method && <>
          <BigInput label={f.t("amount")} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} dir="ltr" />
          <PhotoButton label={f.t("receiptPhoto")} done={!!receipt} onFiles={async ([x]) => setReceipt(await photoToDataUrl(x!))} />
        </>}
        <button disabled={!valid} onClick={save} className="btn-field border-primary bg-primary text-primary-foreground text-2xl">{f.t("save")}</button>
      </div>
    </Shell>
  );
}
