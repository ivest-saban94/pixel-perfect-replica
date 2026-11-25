import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { QueueItem } from "./db";
import * as dbMod from "./db";
import { computeBackoffMs, drainQueue, getSyncEndpoint, isPermanentRejectionStatus } from "./sync";

describe("sync queue helpers", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: true },
      configurable: true,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

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

  it("treats 403 and other 4xx validation rejections as permanent", () => {
    expect(isPermanentRejectionStatus(403)).toBe(true);
    expect(isPermanentRejectionStatus(400)).toBe(true);
    expect(isPermanentRejectionStatus(502)).toBe(false);
    expect(isPermanentRejectionStatus(429)).toBe(false);
  });

  it("marks 403 item as error and continues draining remaining queued items", async () => {
    const podItem: QueueItem = {
      id: 1,
      kind: "pod",
      priority: 1,
      key: "pod-100|20261124",
      payload: { truck: "615-41-002", docNumber: "100", overrideCode: "0000" },
      createdAt: 1000,
      status: "pending",
      attempts: 0,
    };
    const tachoItem: QueueItem = {
      id: 2,
      kind: "tacho",
      priority: 2,
      key: "tacho-open|615-41-002|20261124",
      payload: { truck: "615-41-002", odometer: 12345 },
      createdAt: 2000,
      status: "pending",
      attempts: 0,
    };

    const updated: QueueItem[] = [];
    vi.spyOn(dbMod, "pendingReady").mockResolvedValue([podItem, tachoItem]);
    vi.spyOn(dbMod, "pendingSorted").mockResolvedValue([]);
    vi.spyOn(dbMod, "updateItem").mockImplementation(async (item) => {
      updated.push({ ...item });
    });

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: "קוד מנהל שגוי לחריגת משקל" }), {
          status: 403,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, sheet: "ארכיון_טכוגרף" }), {
          status: 200,
        }),
      ) as typeof fetch;

    const result = await drainQueue(true);

    expect(result).toEqual({ sent: 1, left: 0, errors: 1 });
    expect(updated).toHaveLength(2);
    expect(updated[0]!.status).toBe("error");
    expect(updated[0]!.error).toBe("קוד מנהל שגוי לחריגת משקל");
    expect(updated[0]!.nextRetryAt).toBeUndefined();
    expect(updated[1]!.status).toBe("done");
  });

  it("keeps item pending with backoff and stops on transient 502 error", async () => {
    const tachoItem: QueueItem = {
      id: 10,
      kind: "tacho",
      priority: 2,
      key: "tacho-open|651-51-701|20261124",
      payload: { truck: "651-51-701" },
      createdAt: 1000,
      status: "pending",
      attempts: 0,
    };
    const depositItem: QueueItem = {
      id: 11,
      kind: "deposit",
      priority: 3,
      key: "dep-1|20261124",
      payload: { truck: "651-51-701" },
      createdAt: 2000,
      status: "pending",
      attempts: 0,
    };

    const updated: QueueItem[] = [];
    vi.spyOn(dbMod, "pendingReady").mockResolvedValue([tachoItem, depositItem]);
    vi.spyOn(dbMod, "pendingSorted").mockResolvedValue([tachoItem, depositItem]);
    vi.spyOn(dbMod, "updateItem").mockImplementation(async (item) => {
      updated.push({ ...item });
    });

    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "Temporary gateway error" }), {
        status: 502,
      }),
    ) as typeof fetch;

    const result = await drainQueue(true);

    expect(result).toEqual({ sent: 0, left: 2, errors: 0 });
    expect(updated).toHaveLength(1);
    expect(updated[0]!.status).toBe("pending");
    expect(updated[0]!.nextRetryAt).toBeGreaterThan(Date.now() - 1000);
  });
});
