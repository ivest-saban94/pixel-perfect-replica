export interface OrderDepositRef {
  sku: string;
  qty: number;
}

export interface OrderRef {
  orderId: string;
  docNumber?: string;
  customerName: string;
  tons?: number | null;
  deposits?: OrderDepositRef[];
}

export interface LoadConfirmationSummary {
  depositsConfirmed?: Record<string, number>;
  linesConfirmedCount?: number;
  linesTotalCount?: number;
}

export interface PodRowRef {
  key?: string;
  docNumber?: string | null;
  customer?: string;
  tons?: number | null;
}

export interface LoadMatchResult {
  match: "full" | "partial" | "fail";
  gaps: string[];
}

function normalizeText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/["'״׳.,\-_/\\()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDoc(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/^#/, "").replace(/\s+/g, "");
}

function customerFuzzyMatch(orderCustomer: string, podCustomer: string): boolean {
  const a = normalizeText(orderCustomer);
  const b = normalizeText(podCustomer);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;

  const tokensA = a.split(" ").filter((t) => t.length >= 2);
  const tokensB = new Set(b.split(" ").filter((t) => t.length >= 2));
  if (tokensA.length === 0 || tokensB.size === 0) return false;
  const overlap = tokensA.filter((t) => tokensB.has(t));
  return overlap.length >= Math.min(2, Math.min(tokensA.length, tokensB.size));
}

/**
 * Compares a planned dispatch order + driver loading confirmations against a scanned POD row.
 * Evaluates document number, fuzzy customer name, weight tolerance (<= 0.3t), and 60002/60060 deposits.
 */
export function matchLoadToPod(
  order: OrderRef,
  confirmations: LoadConfirmationSummary | null | undefined,
  podRow: PodRowRef,
): LoadMatchResult {
  const gaps: string[] = [];
  let checksRun = 0;
  let checksPassed = 0;

  // 1. Document number check (order.docNumber <-> podRow.docNumber or podRow.key)
  const expectedDoc = normalizeDoc(order.docNumber);
  const actualDoc = normalizeDoc(podRow.docNumber);
  const keyDoc = normalizeDoc(podRow.key?.split("|")[0]);
  if (expectedDoc) {
    checksRun++;
    if (actualDoc === expectedDoc || keyDoc === expectedDoc) {
      checksPassed++;
    } else {
      gaps.push(
        `אי התאמה במספר תעודה (בהזמנה: ${expectedDoc}, בתעודה: ${actualDoc || keyDoc || "חסר"})`,
      );
    }
  }

  // 2. Customer name fuzzy check
  if (order.customerName.trim()) {
    checksRun++;
    if (podRow.customer && customerFuzzyMatch(order.customerName, podRow.customer)) {
      checksPassed++;
    } else {
      gaps.push(
        `אי התאמה בשם לקוח (בהזמנה: ${order.customerName}, בתעודה: ${podRow.customer || "חסר"})`,
      );
    }
  }

  // 3. Weight tolerance check (|L - H| <= 0.3 tons)
  if (order.tons != null && Number.isFinite(order.tons) && order.tons > 0) {
    checksRun++;
    if (podRow.tons != null && Number.isFinite(podRow.tons)) {
      const diff = Math.abs(order.tons - podRow.tons);
      if (diff <= 0.3) {
        checksPassed++;
      } else {
        gaps.push(
          `פער משקל חריג: הזמנה ${order.tons} טון מול תעודה ${podRow.tons} טון (פער ${diff.toFixed(2)})`,
        );
      }
    } else {
      gaps.push(`חסר משקל בתעודת המשלוח (צפוי ${order.tons} טון)`);
    }
  }

  // 4. Deposits check (60002 / 60060 / 60006)
  const expectedDeposits = (order.deposits ?? []).filter((d) => d.qty > 0);
  if (expectedDeposits.length > 0) {
    checksRun++;
    const confirmedMap = confirmations?.depositsConfirmed ?? {};
    const depositGaps: string[] = [];
    for (const dep of expectedDeposits) {
      const got = confirmedMap[dep.sku] ?? 0;
      if (got !== dep.qty) {
        depositGaps.push(`מק״ט ${dep.sku}: מתוכנן ${dep.qty}, אושר ${got}`);
      }
    }
    if (depositGaps.length === 0) {
      checksPassed++;
    } else {
      gaps.push(`פער בפקדונות (${depositGaps.join("; ")})`);
    }
  }

  if (gaps.length === 0) {
    return { match: "full", gaps: [] };
  }
  if (checksPassed === 0 && checksRun > 0) {
    return { match: "fail", gaps };
  }
  return { match: "partial", gaps };
}
