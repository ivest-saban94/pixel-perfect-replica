import { describe, it, expect } from "vitest";
import { podFileName, uniqueKey, overWeight, dailyKm } from "./config";

describe("field rules", () => {
  const d = new Date("2026-11-24T23:30:00Z"); // 01:30 next day in Jerusalem
  it("POD file name uses Jerusalem date", () => expect(podFileName("12345", "כהן בניה", d)).toBe("12345_כהן_בניה_20261125.pdf"));
  it("unique key is note|date", () => expect(uniqueKey("777", d)).toBe("777|20261125"));
  it("Hikmat max 10.20t", () => { expect(overWeight("615-41-002", 10.2)).toBe(false); expect(overWeight("615-41-002", 10.21)).toBe(true); });
  it("Ali max 4.46t", () => { expect(overWeight("651-51-701", 4.46)).toBe(false); expect(overWeight("651-51-701", 4.5)).toBe(true); });
  it("daily km", () => { expect(dailyKm(1000, 1150)).toBe(150); expect(dailyKm(1000, 900)).toBeNull(); });
});
