/**
 * Google Cloud Vision OCR for scanned delivery notes (PDF page images / photos).
 * Uses GOOGLE_VISION_API_KEY or Service Account with cloud-vision scope.
 */
import {
  getGoogleAccessToken,
  readEnv,
  type ServiceAccountCreds,
  type SyncEnv,
} from "@/lib/server/googleAuth";
import { validateSafeWebhookUrl } from "@/lib/server/drive";

export interface OcrResult {
  ok: boolean;
  text: string;
  error?: string;
  source?: "vision-api-key" | "service-account" | "apps-script";
}

function stripDataUri(input: string): { mimeType: string; base64: string } {
  const m = /^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/s.exec(input.trim());
  if (m) return { mimeType: m[1]!, base64: m[2]!.replace(/\s+/g, "") };
  return { mimeType: "image/jpeg", base64: input.replace(/\s+/g, "") };
}

async function annotateWithApiKey(apiKey: string, base64: string): Promise<OcrResult> {
  const res = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            image: { content: base64 },
            features: [
              { type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 },
              { type: "TEXT_DETECTION", maxResults: 1 },
            ],
            imageContext: { languageHints: ["he", "en", "ar"] },
          },
        ],
      }),
    },
  );
  if (!res.ok) {
    return { ok: false, text: "", error: `Vision HTTP ${res.status}: ${(await res.text()).slice(0, 400)}` };
  }
  const json = (await res.json()) as {
    responses?: Array<{
      fullTextAnnotation?: { text?: string };
      textAnnotations?: Array<{ description?: string }>;
      error?: { message?: string };
    }>;
  };
  const r0 = json.responses?.[0];
  if (r0?.error?.message) {
    return { ok: false, text: "", error: r0.error.message };
  }
  const text =
    r0?.fullTextAnnotation?.text ||
    r0?.textAnnotations?.[0]?.description ||
    "";
  return { ok: true, text, source: "vision-api-key" };
}

async function annotateWithServiceAccount(
  creds: ServiceAccountCreds,
  base64: string,
): Promise<OcrResult> {
  const token = await getGoogleAccessToken(creds, [
    "https://www.googleapis.com/auth/cloud-vision",
  ]);
  const res = await fetch("https://vision.googleapis.com/v1/images:annotate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [
        {
          image: { content: base64 },
          features: [
            { type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 },
            { type: "TEXT_DETECTION", maxResults: 1 },
          ],
          imageContext: { languageHints: ["he", "en", "ar"] },
        },
      ],
    }),
  });
  if (!res.ok) {
    return { ok: false, text: "", error: `Vision SA HTTP ${res.status}: ${(await res.text()).slice(0, 400)}` };
  }
  const json = (await res.json()) as {
    responses?: Array<{
      fullTextAnnotation?: { text?: string };
      textAnnotations?: Array<{ description?: string }>;
    }>;
  };
  const r0 = json.responses?.[0];
  const text =
    r0?.fullTextAnnotation?.text ||
    r0?.textAnnotations?.[0]?.description ||
    "";
  return { ok: true, text, source: "service-account" };
}

/** OCR a single image (JPEG/PNG base64 or data-URI). PDF pages should be rasterized client-side first. */
export async function ocrImageBase64(
  imageInput: string,
  runtimeEnv?: SyncEnv,
): Promise<OcrResult> {
  const { base64 } = stripDataUri(imageInput);
  if (!base64 || base64.length < 32) {
    return { ok: false, text: "", error: "image base64 empty" };
  }

  const apiKey = readEnv("GOOGLE_VISION_API_KEY", runtimeEnv) || readEnv("VISION_API_KEY", runtimeEnv);
  if (apiKey) {
    return annotateWithApiKey(apiKey, base64);
  }

  const rawSa = readEnv("GOOGLE_SERVICE_ACCOUNT_JSON", runtimeEnv);
  if (rawSa) {
    try {
      const creds = JSON.parse(rawSa) as ServiceAccountCreds;
      return await annotateWithServiceAccount(creds, base64);
    } catch (e) {
      return {
        ok: false,
        text: "",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  const appsScriptUrl = readEnv("APPS_SCRIPT_URL", runtimeEnv);
  if (appsScriptUrl) {
    try {
      const safeUrl = validateSafeWebhookUrl(appsScriptUrl);
      const res = await fetch(safeUrl.toString(), {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        redirect: "follow",
        body: JSON.stringify({ kind: "delivery_ocr", imageBase64: base64 }),
      });
      const textBody = await res.text();
      const parsed = JSON.parse(textBody) as { ok?: boolean; text?: string; error?: string };
      if (!res.ok || parsed.ok === false) {
        return { ok: false, text: "", error: parsed.error || `Apps Script OCR HTTP ${res.status}` };
      }
      return { ok: true, text: parsed.text || "", source: "apps-script" };
    } catch (e) {
      return { ok: false, text: "", error: e instanceof Error ? e.message : String(e) };
    }
  }

  return {
    ok: false,
    text: "",
    error: "חסר GOOGLE_VISION_API_KEY / GOOGLE_SERVICE_ACCOUNT_JSON / APPS_SCRIPT_URL ל-OCR",
  };
}
