import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildNotificationCopy,
  buildSheetRow,
  getSyncDiagnostics,
  handleSyncRequest,
  parseDataUri,
  processSyncPayload,
  resolveSheetTab,
  sendResendEmail,
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

  it("builds exact Hebrew POD notification copy", () => {
    const copy = buildNotificationCopy(
      {
        kind: "pod",
        key: "1234|20261125",
        truck: "615-41-002",
        docNumber: "1234",
        customer: "כהן בניה",
        tons: 8.5,
      },
      "חכמת גאבר",
      "https://drive.google.com/file/d/abc/view",
    );
    expect(copy.subject).toBe("תעודת משלוח 1234 · כהן בניה · חכמת גאבר");
    expect(copy.text).toContain("שלום,\nמצורפת תעודת משלוח לעיונך.");
    expect(copy.text).toContain("📄 מספר תעודה: 1234");
    expect(copy.text).toContain("👤 לקוח: כהן בניה");
    expect(copy.text).toContain("🚚 משאית: 615-41-002 (חכמת גאבר)");
    expect(copy.text).toContain("⚖️ משקל: 8.5 טון");
    expect(copy.text).toContain("🔗 קישור לדרייב: https://drive.google.com/file/d/abc/view");
    expect(copy.text).toContain("בברכה,\nמערכת סבן שטח");
  });

  it("builds exact Hebrew tacho open/close notification copy and sheet row", () => {
    const openCopy = buildNotificationCopy(
      {
        kind: "tacho",
        key: "tacho-open|651-51-701|20261125",
        truck: "651-51-701",
        type: "open",
        odometer: 120500,
      },
      "עלי",
      "https://drive.google.com/file/d/t1/view",
    );
    expect(openCopy.subject).toBe("טכוגרף פתיחת יום · משאית 651-51-701 (עלי)");
    expect(openCopy.text).toContain("⏱ טכוגרף פתיחת יום");
    expect(openCopy.text).toContain("🔢 מד אוץ: 120500");
    expect(openCopy.text).not.toContain("ק״מ היום");
    expect(openCopy.text).toContain(
      "🔗 צפייה בצילום הדיסקית: https://drive.google.com/file/d/t1/view",
    );

    const closePayload = {
      kind: "tacho" as const,
      key: "tacho-close|651-51-701|20261125",
      truck: "651-51-701",
      type: "close" as const,
      odometer: 120650,
      km: 150,
      at: new Date("2026-11-24T23:30:00Z").getTime(),
    };
    const closeCopy = buildNotificationCopy(
      closePayload,
      "עלי",
      "https://drive.google.com/file/d/t2/view",
    );
    expect(closeCopy.subject).toBe("טכוגרף סגירת יום · משאית 651-51-701 (עלי)");
    expect(closeCopy.text).toContain("📏 ק״מ היום: 150");

    const row = buildSheetRow(
      closePayload,
      "https://drive.google.com/file/d/t2/view",
      "lina@saban94.co.il",
    );
    expect(row).toHaveLength(18);
    expect(row[1]).toBe("20261125"); // B תאריך דיסקית
    expect(row[3]).toBe(120650); // D ק"מ סגירה
    expect(row[4]).toBe(150); // E סה"כ ק"מ
    expect(row[5]).toBe("https://drive.google.com/file/d/t2/view"); // F קישור לדיסקית
    expect(row[10]).toBe("עלי"); // K נהג
    expect(row[11]).toBe("651-51-701"); // L רישוי / משאית
    expect(row[15]).toBe("tacho-close|651-51-701|20261125"); // P מפתח ייחודי

    // POD must always resolve strictly to ארכיון_תעודות_גליה even if payload.sheet differs
    expect(
      resolveSheetTab({
        kind: "pod",
        key: "p|1",
        truck: "615-41-002",
        sheet: "טכנו",
      }),
    ).toBe("ארכיון_תעודות_גליה");
    expect(resolveSheetTab({ kind: "load_confirm", key: "lc|1", truck: "615-41-002" })).toBe(
      "אישורי_העמסה",
    );
  });

  it("returns false when RESEND_API_KEY is unset and posts to Resend API when configured", async () => {
    const skipped = await sendResendEmail(
      {},
      { to: "galya@saban94.co.il", subject: "test", text: "body" },
    );
    expect(skipped).toBe(false);

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "email_123" }), { status: 200 }));
    const sent = await sendResendEmail(
      { RESEND_API_KEY: "re_test_key", EMAIL_FROM: "סבן שטח <onboarding@resend.dev>" },
      {
        to: "lina@saban94.co.il",
        subject: "תעודת משלוח 1",
        text: "גוף",
        attachment: { fileName: "1.pdf", base64: "JVBERi0=" },
      },
    );
    expect(sent).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer re_test_key",
        }),
      }),
    );
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
    expect(diag.notifications.emailProvider).toBe("none");
    expect(diag.sheets.sheetId).toBe("1FsLseQrKbIj_AvlE6-dW4J12Gr88P3uaoFVBjEcUjsw");
  });

  it("resolves Drive Apps Script URL cleanly and ignores relative /api/sync", async () => {
    const { getDriveAppsScriptUrl, uploadViaAppsScript } = await import("./drive");
    expect(getDriveAppsScriptUrl({ VITE_SYNC_ENDPOINT: "/api/sync" })).toBeUndefined();
    expect(
      getDriveAppsScriptUrl({
        VITE_SYNC_ENDPOINT: "/api/sync",
        APPS_SCRIPT_URL: "https://script.google.com/macros/s/abc/exec",
      }),
    ).toBe("https://script.google.com/macros/s/abc/exec");
    expect(
      getDriveAppsScriptUrl({
        APPS_SCRIPT_URL: "https://script.google.com/macros/s/old/exec",
        DRIVE_APPS_SCRIPT_URL: "https://script.google.com/macros/s/drive/exec",
      }),
    ).toBe("https://script.google.com/macros/s/drive/exec");

    const missing = await uploadViaAppsScript(
      { fileName: "test.pdf", mimeType: "application/pdf", base64: "JVBERi0=" },
      {},
    );
    expect(missing.ok).toBe(false);
    expect(missing.driveUrl).toBeNull();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          driveUrl: "https://drive.google.com/file/d/drive123/view",
          fileId: "drive123",
        }),
        { status: 200 },
      ),
    );
    const uploaded = await uploadViaAppsScript(
      {
        fileName: "123_test_20261125.pdf",
        mimeType: "application/pdf",
        base64: "JVBERi0=",
        folderId: "1KvvtgwKBVrUlMEApK3Jy-ejfnUG3f_fT",
      },
      { APPS_SCRIPT_URL: "https://script.google.com/macros/s/drive/exec" },
    );
    expect(uploaded).toEqual({
      ok: true,
      driveUrl: "https://drive.google.com/file/d/drive123/view",
      fileId: "drive123",
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://script.google.com/macros/s/drive/exec",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "text/plain" },
      }),
    );
  });
});
