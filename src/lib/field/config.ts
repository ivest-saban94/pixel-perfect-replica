export type TruckId = "615-41-002" | "651-51-701";
export interface Truck { id: TruckId; driver: string; driverAr: string; type: "crane" | "distribution"; maxTons: number }
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

/** YYYYMMDD in Asia/Jerusalem */
export function jerusalemDate(d = new Date()): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return p.replaceAll("-", "");
}
export function jerusalemTime(d: Date | number = new Date()): string {
  return new Intl.DateTimeFormat("he-IL", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(d);
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
