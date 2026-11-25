import type { DeliveryLine, DeliveryNote, DepositLine } from "./types";
import { resolveTruckIdFromLabel } from "@/lib/field/config";

const DEPOSIT_SKUS = new Set(["60002", "60060", "60006"]);

export function normalizeExtracted(raw: Record<string, unknown>): DeliveryNote {
  const linesSrc = (raw.lines || raw.items || []) as Array<Record<string, unknown>>;
  const lines: DeliveryLine[] = linesSrc.map((l) => ({
    sku: String(l.sku || l.makat || "").trim(),
    description: String(l.description || l.desc || l.name || "").trim(),
    size: l.size || l.midah ? String(l.size || l.midah) : undefined,
    qty: Number(l.qty || l.quantity || l.kamut || 0),
    unit: l.unit ? String(l.unit) : undefined,
  }));

  const depositsSrc = (raw.deposits || raw.pkodonot || []) as Array<Record<string, unknown>>;
  let deposits: DepositLine[] = depositsSrc.map((d) => ({
    sku: String(d.sku || "").trim(),
    description: String(d.description || d.name || "").trim(),
    qty: Number(d.qty || 0),
  }));

  // Auto-promote known deposit SKUs from lines if deposits empty
  if (deposits.length === 0) {
    deposits = lines
      .filter((l) => DEPOSIT_SKUS.has(l.sku))
      .map((l) => ({ sku: l.sku, description: l.description, qty: l.qty }));
  }

  const truckRaw = String(raw.truckId || raw.vehicle || raw.plate || raw.truck || "");
  const truckId = resolveTruckIdFromLabel(truckRaw) || (truckRaw || undefined);

  return {
    id: String(raw.id || `dn-${Date.now()}`),
    docNumber: String(raw.docNumber || raw.teuda || raw.orderNumber || "").trim(),
    warehouse: raw.warehouse || raw.machsan ? String(raw.warehouse || raw.machsan) : undefined,
    customerCode: raw.customerCode || raw.customerId ? String(raw.customerCode || raw.customerId) : undefined,
    customerName: String(raw.customerName || raw.customer || "").trim(),
    deliveryAddress: raw.deliveryAddress || raw.address ? String(raw.deliveryAddress || raw.address) : undefined,
    contactName: raw.contactName || raw.contact ? String(raw.contactName || raw.contact) : undefined,
    contactPhone: raw.contactPhone || raw.phone ? String(raw.contactPhone || raw.phone).replace(/\s+/g, "") : undefined,
    driverName: raw.driverName || raw.driver ? String(raw.driverName || raw.driver) : undefined,
    truckId: truckId || undefined,
    lines: lines.filter((l) => !DEPOSIT_SKUS.has(l.sku)),
    deposits,
    sourceFileUrl: raw.sourceFileUrl ? String(raw.sourceFileUrl) : undefined,
    extractedAt: new Date().toISOString(),
    rawText: raw.rawText ? String(raw.rawText).slice(0, 4000) : undefined,
    tons: raw.tons != null ? Number(raw.tons) : null,
  };
}

/** Parse free-text from PDF/OCR into rough structured fields */
export function parseDeliveryText(text: string, meta: Record<string, unknown> = {}): Record<string, unknown> {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const docMatch =
    text.match(/(?:תעודה|תעודת משלוח|מס['׳]?|מספר|Order|Doc)[:\s#]*([0-9A-Z\-\/]+)/i) ||
    text.match(/\b(62\d{5,}|6\d{6,})\b/);
  const docNumber = docMatch?.[1]?.trim() || meta.docNumber || "";

  const customerMatch =
    text.match(/(?:לקוח|Customer|שם לקוח)[:\s]+([^\n\r]+)/i) ||
    text.match(/קוד לקוח[:\s]*(\d+)[^\n]*שם[:\s]*([^\n]+)/i);
  const customerName = (customerMatch?.[2] || customerMatch?.[1] || meta.customerName || "").toString().trim();
  const customerCode =
    customerMatch?.[1] && /^\d+$/.test(String(customerMatch[1])) ? String(customerMatch[1]) : undefined;

  const addressMatch = text.match(/(?:כתובת|Address|אתר)[:\s]+([^\n\r]+)/i);
  const phoneMatch = text.match(/(?:טלפון|Phone|נייד)[:\s]*([0-9\-+\s]{9,})/i);
  const contactMatch = text.match(/(?:איש קשר|Contact)[:\s]+([^\n\r]+)/i);

  const driverMatch =
    text.match(/(?:נהג|Driver)[:\s]+([^\n\r]+)/i) || text.match(/(חכמת|עלי|حكمت)/);
  const truckMatch =
    text.match(/(615-?41-?002|651-?51-?701)/i) ||
    text.match(/(?:רכב|משאית|מס['׳]? רכב)[:\s]*([0-9\-]+)/i);

  const itemLines: Array<Record<string, unknown>> = [];
  const depositLines: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    const m = line.match(/(\d{4,6})\s+(.+?)\s+(\d+(?:\.\d+)?)\s*(?:יח'|יחידות|יח)?/);
    if (m) {
      const sku = m[1]!;
      const entry = { sku, description: m[2]!.trim(), qty: Number(m[3]) };
      if (DEPOSIT_SKUS.has(sku)) depositLines.push(entry);
      else itemLines.push(entry);
    }
  }

  return {
    docNumber,
    customerCode,
    customerName,
    deliveryAddress: addressMatch?.[1]?.trim(),
    contactName: contactMatch?.[1]?.trim(),
    contactPhone: phoneMatch?.[1]?.replace(/\s+/g, ""),
    driverName: driverMatch?.[1]?.trim(),
    truckId: truckMatch?.[1]?.replace(/\s/g, "") || undefined,
    lines: itemLines,
    deposits: depositLines,
    rawText: text.slice(0, 4000),
    sourceFileUrl: meta.sourceFileUrl,
  };
}
