import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getSyncDiagnostics,
  handleSyncRequest,
  parseDataUri,
  processSyncPayload,
  resolveSheetTab,
  validateSafeWebhookUrl,
} from "./syncHandler";

describe("syncHandler", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("maps queue kinds to master Google Sheet tabs", () => {
    expect(resolveSheetTab({ kind: "pod", key: "1|20261124", truck: "615-41-002" })).toBe(
      "ארכיון_תעודות_גליה",
    );
    expect(resolveSheetTab({ kind: "tacho", key: "t|1", truck: "615-41-002" })).toBe(
      "ארכיון_טכוגרף",
    );
    expect(resolveSheetTab({ kind: "crane", key: "c|1", truck: "615-41-002" })).toBe("סשנים_PTO");
    expect(resolveSheetTab({ kind: "deposit", key: "d|1", truck: "651-51-701" })).toBe(
      "אתרי_לקוחות",
    );
    expect(resolveSheetTab({ kind: "gps", key: "g|1", truck: "651-51-701" })).toBe("אתרי_לקוחות");
  });

  it("rejects overweight POD when MANAGER_OVERRIDE_CODE does not match", async () => {
    const res = await processSyncPayload(
      {
        kind: "pod",
        key: "555|20261124",
        truck: "651-51-701",
        docNumber: "555",
        customer: "בדיקה",
        tons: 5.5,
        overrideCode: "0000",
      },
      { MANAGER_OVERRIDE_CODE: "9988" },
    );
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.emailTo).toBe("lina@saban94.co.il");
  });

  it("returns 503 when GOOGLE_SERVICE_ACCOUNT_JSON is not configured (no fake success)", async () => {
    const res = await processSyncPayload(
      {
        kind: "pod",
        key: "556|20261124",
        truck: "615-41-002",
        docNumber: "556",
        customer: "לקוח",
      },
      {},
    );
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.emailTo).toBe("galya@saban94.co.il");
  });

  it("rejects unsafe internal webhook URLs", () => {
    expect(() => validateSafeWebhookUrl("http://127.0.0.1:8080/hook")).toThrow();
    expect(() => validateSafeWebhookUrl("http://169.254.169.254/latest/meta-data")).toThrow();
    expect(validateSafeWebhookUrl("https://hooks.example.com/whatsapp").hostname).toBe(
      "hooks.example.com",
    );
  });

  it("parses PDF and JPEG data URIs cleanly", () => {
    const parsed = parseDataUri("data:application/pdf;base64,SGVsbG8=", "application/pdf");
    expect(parsed.mimeType).toBe("application/pdf");
    expect(parsed.base64).toBe("SGVsbG8=");
    expect(new TextDecoder().decode(parsed.bytes)).toBe("Hello");
  });

  it("validates HTTP method and JSON body in handleSyncRequest", async () => {
    const getRes = await handleSyncRequest(
      new Request("http://localhost/api/sync", { method: "GET" }),
    );
    expect(getRes.status).toBe(405);

    const badJson = await handleSyncRequest(
      new Request("http://localhost/api/sync", { method: "POST", body: "not-json" }),
    );
    expect(badJson.status).toBe(400);
  });

  it("reports unconfigured diagnostics safely without throwing", async () => {
    const diag = await getSyncDiagnostics({});
    expect(diag.ok).toBe(false);
    expect(diag.serviceAccount.configured).toBe(false);
    expect(diag.serviceAccount.oauthTokenOk).toBe(false);
    expect(diag.sheets.sheetId).toBe("1FsLseQrKbIj_AvlE6-dW4J12Gr88P3uaoFVBjEcUjsw");
  });
});
