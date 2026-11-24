import { describe, it, expect } from "vitest";
import { computeBackoffMs, getSyncEndpoint } from "./sync";

describe("sync queue helpers", () => {
  it("computes bounded exponential backoff for retries", () => {
    expect(computeBackoffMs(1)).toBe(5_000);
    expect(computeBackoffMs(2)).toBe(15_000);
    expect(computeBackoffMs(3)).toBe(30_000);
    expect(computeBackoffMs(4)).toBe(60_000);
    expect(computeBackoffMs(5)).toBe(180_000);
    expect(computeBackoffMs(10)).toBe(300_000);
  });

  it("defaults sync endpoint to /api/sync when VITE_SYNC_ENDPOINT is unset", () => {
    expect(getSyncEndpoint()).toBe("/api/sync");
  });
});
