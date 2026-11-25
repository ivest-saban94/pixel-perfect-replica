import {
  SHEET_ID_MAIN,
  TAB_DICT,
  TAB_ORDERS,
  jerusalemDate,
  resolveTruckIdFromLabel,
} from "@/lib/field/config";
import { matchLoadToPod } from "@/lib/field/loadMatch";
import { validateSafeWebhookUrl } from "./drive";
import {
  getGoogleAccessToken,
  readEnv,
  type ServiceAccountCreds,
  type SyncEnv,
} from "./googleAuth";

export { matchLoadToPod };

export interface OrderLine {
  sku: string;
  name: string;
  qtyPlanned: number;
  unit: string;
}

export interface DepositLine {
  sku: string;
  name?: string;
  qty: number;
}

export interface Order {
  orderId: string;
  receivedDate: string;
  supplyDate: string;
  time: string;
  customerId: string;
  customerName: string;
  contact: string;
  address: string;
  warehouse: string;
  truckDriver: string;
  truckId: string | null;
  tons: number | null;
  docNumber: string;
  status: string;
  waze: string;
  notes: string;
  productsRaw: string;
  lines: OrderLine[];
  deposits: DepositLine[];
}

export interface DictEntry {
  sku: string;
  officialName: string;
  slangKeywords: string[];
  depositCategory: string;
  unitWeightKg: number | null;
}

export interface OrdersListResponse {
  ok: boolean;
  orders: Order[];
  date: string;
  truck: string;
  error?: string;
}

/** Normalizes sheet date values (YYYYMMDD, DD/MM/YYYY, YYYY-MM-DD, DD.MM.YYYY) to YYYYMMDD */
export function normalizeSheetDate(raw: unknown): string {
  if (raw == null) return "";
  const str = String(raw).trim();
  if (!str) return "";
  if (/^\d{8}$/.test(str)) return str;

  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(str);
  if (iso) {
    return `${iso[1]}${iso[2]!.padStart(2, "0")}${iso[3]!.padStart(2, "0")}`;
  }

  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(str);
  if (dmy) {
    const year = dmy[3]!.length === 2 ? `20${dmy[3]}` : dmy[3]!;
    return `${year}${dmy[2]!.padStart(2, "0")}${dmy[1]!.padStart(2, "0")}`;
  }

  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime())) {
    return jerusalemDate(parsed);
  }
  return "";
}

export function parseDictionaryRows(rows: string[][]): DictEntry[] {
  if (rows.length === 0) return [];
  const entries: DictEntry[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const sku = (row[0] ?? "").trim();
    const officialName = (row[1] ?? "").trim();
    if (!sku && !officialName) continue;
    // Skip header row
    if (i === 0 && (sku.includes("מק") || officialName.includes("שם מוצר"))) continue;

    const slangRaw = (row[4] ?? "").trim();
    const slangKeywords = slangRaw
      ? slangRaw
          .split(/[,;|/\n]+/)
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s.length >= 2)
      : [];
    const depositCategory = ((row[5] ?? "") || (row[13] ?? "")).trim();
    const weightRaw = Number((row[6] ?? "").trim());
    entries.push({
      sku,
      officialName,
      slangKeywords,
      depositCategory,
      unitWeightKg: Number.isFinite(weightRaw) && weightRaw > 0 ? weightRaw : null,
    });
  }
  return entries;
}

const UNIT_WORDS = [
  "משטחים",
  "משטח",
  "שקים",
  "שק",
  "בלות",
  "בלה",
  "יח'",
  "יח",
  "טון",
  'מ"ק',
  "מ״ק",
  'ק"ג',
  "ק״ג",
];

function detectUnit(text: string): string {
  for (const u of UNIT_WORDS) {
    if (text.includes(u)) return u;
  }
  return "יח'";
}

function matchDictEntry(fragment: string, dict: DictEntry[]): DictEntry | undefined {
  const lower = fragment.toLowerCase();
  // 1. SKU match
  for (const entry of dict) {
    if (entry.sku && lower.includes(entry.sku.toLowerCase())) {
      return entry;
    }
  }
  // 2. Official name match
  for (const entry of dict) {
    if (entry.officialName && lower.includes(entry.officialName.toLowerCase())) {
      return entry;
    }
  }
  // 3. Slang keyword match
  for (const entry of dict) {
    for (const kw of entry.slangKeywords) {
      if (lower.includes(kw)) return entry;
    }
  }
  return undefined;
}

export function parseProductsRaw(productsRaw: string, dict: DictEntry[] = []): OrderLine[] {
  const raw = productsRaw.trim();
  if (!raw) return [];

  const chunks = raw
    .split(/\r?\n|[;|]+|,\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const lines: OrderLine[] = [];
  for (const chunk of chunks) {
    let parsedSku = "";
    let qtyPlanned = 1;
    let desc = chunk;
    const unit = detectUnit(chunk);

    // Format A: "11570 חמרה שק גדול (18)" or "19994 פורצלן (85 קרטון)"
    const skuFirstQtyParen = /^(\d{4,8})\s+(.+?)\s*\((\d+(?:\.\d+)?)(?:\s*[^)]*)?\)\s*$/.exec(
      chunk,
    );
    // Format B: "3 חצץ שק (11505)"
    const qtyFirstSkuParen = /^(\d+(?:\.\d+)?)\s+(.+?)\s*\((\d{4,8})\)\s*$/.exec(chunk);
    // Format C: "11570 חמרה שק גדול" (4-8 digit SKU at start, no paren qty)
    const skuFirstOnly = /^(\d{4,8})\s+(.+)$/.exec(chunk);

    if (skuFirstQtyParen) {
      parsedSku = skuFirstQtyParen[1]!;
      desc = skuFirstQtyParen[2]!.trim();
      qtyPlanned = Number(skuFirstQtyParen[3]);
    } else if (qtyFirstSkuParen && Number(qtyFirstSkuParen[1]) < 1000) {
      qtyPlanned = Number(qtyFirstSkuParen[1]);
      desc = qtyFirstSkuParen[2]!.trim();
      parsedSku = qtyFirstSkuParen[3]!;
    } else if (skuFirstOnly) {
      parsedSku = skuFirstOnly[1]!;
      desc = skuFirstOnly[2]!.trim();
    } else {
      // Leading quantity: "10 שקי מלט" or "4x בלוקים"
      const leadMatch =
        /^(\d+(?:\.\d+)?)\s*(?:[x×*]|(?:משטחים|משטח|שקים|שק|בלות|בלה|יח'|יח|טון|מ"ק|מ״ק|ק"ג|ק״ג))?\s+(.+)$/.exec(
          chunk,
        );
      // Trailing quantity: "מלט 25 קג x 10" or "מלט - 10 יח'"
      const trailMatch =
        /^(.+?)\s*(?:[x×*-])\s*(\d+(?:\.\d+)?)\s*(?:משטחים|משטח|שקים|שק|בלות|בלה|יח'|יח|טון|מ"ק|מ״ק|ק"ג|ק״ג)?$/.exec(
          chunk,
        );

      if (leadMatch && Number(leadMatch[1]) < 1000) {
        qtyPlanned = Number(leadMatch[1]);
        desc = leadMatch[2]!.trim();
      } else if (trailMatch) {
        desc = trailMatch[1]!.trim();
        qtyPlanned = Number(trailMatch[2]);
      }
    }

    const matched =
      (parsedSku ? dict.find((e) => e.sku === parsedSku) : undefined) ??
      matchDictEntry(desc, dict) ??
      matchDictEntry(chunk, dict);

    lines.push({
      sku: matched?.sku || parsedSku,
      name: matched?.officialName || desc,
      qtyPlanned: Number.isFinite(qtyPlanned) && qtyPlanned > 0 ? qtyPlanned : 1,
      unit,
    });
  }
  return lines;
}

function parseNumberSafe(val: unknown): number | null {
  if (val == null) return null;
  const cleaned = String(val)
    .replace(/[^\d.-]/g, "")
    .trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function isOrderClosedStatus(status: string): boolean {
  const s = status.trim();
  if (!s) return false;
  return (
    s.includes("בוצע") ||
    s.includes("בוטל") ||
    s.includes("נמסר") ||
    s.includes("סגור") ||
    s.includes("סופק")
  );
}

function rowMatchesTruck(colJ: string, requestedTruck: string): boolean {
  const target = requestedTruck.trim();
  if (!target) return true;
  const resolvedCol = resolveTruckIdFromLabel(colJ);
  const resolvedTarget = resolveTruckIdFromLabel(target) ?? target;
  if (resolvedCol) {
    return resolvedCol === resolvedTarget;
  }
  const cleanCol = colJ.replace(/[-\s]/g, "").toLowerCase();
  const cleanTarget = target.replace(/[-\s]/g, "").toLowerCase();
  return cleanCol.includes(cleanTarget);
}

export function buildOrdersFromSheetValues(
  orderRows: string[][],
  dictRows: string[][],
  opts: { truck: string; date?: string },
): Order[] {
  const targetDate = normalizeSheetDate(opts.date) || jerusalemDate();
  const dict = parseDictionaryRows(dictRows);
  const orders: Order[] = [];

  for (let i = 0; i < orderRows.length; i++) {
    const r = orderRows[i] ?? [];
    const orderId = (r[3] ?? "").trim();
    const customerName = (r[5] ?? "").trim();
    // Skip blank or header row
    if (!orderId && !customerName) continue;
    if (i === 0 && (orderId.includes("הזמנה") || (r[1] ?? "").includes("תאריך אספקה"))) {
      continue;
    }

    const supplyDate = normalizeSheetDate(r[1]);
    if (supplyDate && supplyDate !== targetDate) continue;

    const truckDriver = (r[9] ?? "").trim();
    if (opts.truck && !rowMatchesTruck(truckDriver, opts.truck)) continue;

    const status = (r[15] ?? "").trim();
    if (isOrderClosedStatus(status)) continue;

    const productsRaw = (r[10] ?? "").trim();
    const lines = parseProductsRaw(productsRaw, dict);

    const mQty = parseNumberSafe(r[12]) ?? 0;
    const nQty = parseNumberSafe(r[13]) ?? 0;
    const deposits: DepositLine[] = [];
    if (mQty > 0) deposits.push({ sku: "60002", name: "שק גדול (בלה)", qty: mQty });
    if (nQty > 0) {
      const palletSku =
        productsRaw.includes("60006") || productsRaw.includes("בלוק") ? "60006" : "60060";
      deposits.push({
        sku: palletSku,
        name: palletSku === "60006" ? "משטח בלוקים" : "משטח סבן",
        qty: nQty,
      });
    }

    orders.push({
      orderId: orderId || `ROW-${i + 1}`,
      receivedDate: normalizeSheetDate(r[0]),
      supplyDate: supplyDate || targetDate,
      time: (r[2] ?? "").trim(),
      customerId: (r[4] ?? "").trim(),
      customerName,
      contact: (r[6] ?? "").trim(),
      address: (r[7] ?? "").trim(),
      warehouse: (r[8] ?? "").trim(),
      truckDriver,
      truckId: resolveTruckIdFromLabel(truckDriver),
      tons: parseNumberSafe(r[11]),
      docNumber: (r[14] ?? "").trim(),
      status,
      waze: (r[16] ?? "").trim(),
      notes: (r[17] ?? "").trim(),
      productsRaw,
      lines,
      deposits,
    });
  }

  return orders;
}

export async function fetchOrdersFromSheet(
  opts: { truck: string; date?: string },
  runtimeEnv?: SyncEnv,
): Promise<OrdersListResponse> {
  const targetDate = normalizeSheetDate(opts.date) || jerusalemDate();
  const truck = opts.truck.trim();
  const rawSa = readEnv("GOOGLE_SERVICE_ACCOUNT_JSON", runtimeEnv);
  const appsScriptUrl = readEnv("APPS_SCRIPT_URL", runtimeEnv);

  if (rawSa) {
    const creds = JSON.parse(rawSa) as ServiceAccountCreds;
    if (!creds.client_email || !creds.private_key) {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON missing client_email or private_key");
    }
    const token = await getGoogleAccessToken(creds, [
      "https://www.googleapis.com/auth/spreadsheets.readonly",
    ]);
    const sheetId = readEnv("SHEET_ID_MAIN", runtimeEnv) || SHEET_ID_MAIN;

    const [ordersRes, dictRes] = await Promise.all([
      fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(`${TAB_ORDERS}!A:R`)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      ),
      fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(`${TAB_DICT}!A:N`)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      ),
    ]);

    if (!ordersRes.ok) {
      throw new Error(
        `שגיאה בקריאת גיליון הזמנות (${ordersRes.status}): ${await ordersRes.text()}`,
      );
    }
    const ordersData = (await ordersRes.json()) as { values?: string[][] };
    const dictData = dictRes.ok
      ? ((await dictRes.json()) as { values?: string[][] })
      : { values: [] };

    const orders = buildOrdersFromSheetValues(ordersData.values ?? [], dictData.values ?? [], {
      truck,
      date: targetDate,
    });
    return { ok: true, orders, date: targetDate, truck };
  }

  if (appsScriptUrl) {
    const safeUrl = validateSafeWebhookUrl(appsScriptUrl);
    const res = await fetch(safeUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      redirect: "follow",
      body: JSON.stringify({ kind: "orders_list", truck, date: targetDate }),
    });
    const text = await res.text();
    const parsed = JSON.parse(text) as Partial<OrdersListResponse>;
    if (!res.ok || parsed.ok === false) {
      throw new Error(parsed.error || `Apps Script orders_list HTTP ${res.status}`);
    }
    return {
      ok: true,
      orders: Array.isArray(parsed.orders) ? parsed.orders : [],
      date: targetDate,
      truck,
    };
  }

  throw new Error(
    "השרת אינו מוגדר לקריאת הזמנות (חסר GOOGLE_SERVICE_ACCOUNT_JSON או APPS_SCRIPT_URL)",
  );
}

export async function handleOrdersRequest(
  request: Request,
  runtimeEnv?: SyncEnv,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  try {
    let truck = "";
    let date = "";
    if (request.method === "GET") {
      const url = new URL(request.url);
      truck = url.searchParams.get("truck") ?? "";
      date = url.searchParams.get("date") ?? "";
    } else if (request.method === "POST") {
      const body = (await request.json()) as { truck?: string; date?: string };
      truck = body.truck ?? "";
      date = body.date ?? "";
    } else {
      return Response.json({ ok: false, orders: [], error: "Method Not Allowed" }, { status: 405 });
    }

    const result = await fetchOrdersFromSheet({ truck, date }, runtimeEnv);
    return Response.json(result, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { ok: false, orders: [], date: jerusalemDate(), truck: "", error: message },
      { status: 502 },
    );
  }
}
