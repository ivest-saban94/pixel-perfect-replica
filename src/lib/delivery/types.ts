/** Unified delivery-note + driver overlay types (סבן שטח) */

export interface DeliveryLine {
  sku: string;
  description: string;
  size?: string;
  qty: number;
  unit?: string;
}

export interface DepositLine {
  sku: string;
  description: string;
  qty: number;
}

export interface DeliveryNote {
  id: string;
  docNumber: string;
  warehouse?: string;
  customerCode?: string;
  customerName: string;
  deliveryAddress?: string;
  contactName?: string;
  contactPhone?: string;
  driverName?: string;
  truckId?: string;
  lines: DeliveryLine[];
  deposits: DepositLine[];
  sourceFileUrl?: string;
  extractedAt: string;
  rawText?: string;
  tons?: number | null;
}

export interface CraneWork {
  type: "9m" | "15m";
  workType: string;
  start: string;
  end: string;
}

export interface OverlayPayload {
  deliveryId: string;
  docNumber?: string;
  truck?: string;
  driver?: string;
  customer?: string;
  craneOpen?: string;
  craneClose?: string;
  waitFrom?: string;
  waitUntil?: string;
  craneWork?: CraneWork;
  depositsAdjust: Record<string, number>;
  notes?: string;
  signatureDataUrl?: string;
  submittedAt?: string;
  submittedBy?: string;
  sourceFileUrl?: string;
}

export interface OverlayHistoryItem extends OverlayPayload {
  key: string;
  date: string;
  time: string;
  driveUrl?: string | null;
}
