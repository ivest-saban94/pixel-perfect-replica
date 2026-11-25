export type TruckId = "615-41-002" | "651-51-701";
export interface Truck {
  id: TruckId;
  driver: string;
  driverAr: string;
  type: "crane" | "distribution";
  maxTons: number;
}
export const TRUCKS: Truck[] = [
  { id: "615-41-002", driver: "חכמת גאבר", driverAr: "حكمت جابر", type: "crane", maxTons: 10.2 },
  { id: "651-51-701", driver: "עלי", driverAr: "علي", type: "distribution", maxTons: 4.46 },
];
export const DEPOSIT_ITEMS = [
  { sku: "60002", he: "שק גדול (בלה)", ar: "كيس كبير (بالة)" },
  { sku: "60060", he: "משטח סבן", ar: "مشطاح سابان" },
  { sku: "60006", he: "משטח בלוקים", ar: "مشطاح بلوكات" },
] as const;
export const TZ = "Asia/Jerusalem";
export const DRIVE_FOLDER = "בירור_תעודות_משלוח_ראמי";
export const SHEET_ID_MAIN = "1FsLseQrKbIj_AvlE6-dW4J12Gr88P3uaoFVBjEcUjsw";

export const TAB_POD = "ארכיון_תעודות_גליה";
export const TAB_TACHO = "ארכיון_טכוגרף";
export const TAB_TACHO_TECHNO = "טכנו";
export const TAB_CRANE = "סשנים_PTO";
export const TAB_DEPOSIT_GPS = "אתרי_לקוחות";
export const TAB_ORDERS = "הזמנות";
export const TAB_DICT = "מילון_לוגיסט";
export const TAB_LOAD_CONFIRM = "אישורי_העמסה";

export const TRUCK_EMAILS: Record<TruckId, string> = {
  "615-41-002": "galya@saban94.co.il",
  "651-51-701": "lina@saban94.co.il",
};

export function emailForTruck(truck: TruckId | string): string {
  return (TRUCK_EMAILS as Record<string, string>)[truck] ?? "galya@saban94.co.il";
}

export function driverNameForTruck(truck: TruckId | string): string {
  return TRUCKS.find((x) => x.id === truck)?.driver ?? truck;
}

/** Matches either plate ("615-41-002" / "61541002") or driver name ("חכמת" / "עלי") in Orders column J */
export function resolveTruckIdFromLabel(label: string): TruckId | null {
  const raw = label.trim();
  if (!raw) return null;
  const digits = raw.replace(/[-\s]/g, "");
  for (const t of TRUCKS) {
    if (raw.includes(t.id) || digits.includes(t.id.replace(/-/g, ""))) {
      return t.id;
    }
  }
  if (raw.includes("חכמת") || raw.includes("גאבר") || raw.includes("حكمت")) {
    return "615-41-002";
  }
  if (/(?:^|[\s/,\-|])עלי(?:$|[\s/,\-|])/.test(raw) || raw === "עלי" || raw.includes("علي")) {
    return "651-51-701";
  }
  return null;
}

/** YYYYMMDD in Asia/Jerusalem */
export function jerusalemDate(d = new Date()): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  return p.replaceAll("-", "");
}
export function jerusalemTime(d: Date | number = new Date()): string {
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
export function podFileName(docNumber: string, customer: string, d = new Date()): string {
  const clean = (s: string) => s.trim().replace(/[\\/:*?"<>|\s]+/g, "_");
  return `${clean(docNumber)}_${clean(customer)}_${jerusalemDate(d)}.pdf`;
}
export function uniqueKey(noteId: string, d = new Date()): string {
  return `${noteId}|${jerusalemDate(d)}`;
}
export function dailyKm(open: number, close: number): number | null {
  return close >= open ? close - open : null;
}
export function overWeight(truck: TruckId, tons: number): boolean {
  const t = TRUCKS.find((x) => x.id === truck);
  return !!t && tons > t.maxTons;
}
