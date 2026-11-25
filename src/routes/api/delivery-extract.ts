import { createAPIFileRoute } from "@tanstack/react-start/api";
import { normalizeExtracted, parseDeliveryText } from "@/lib/delivery/normalize";
import { ocrImageBase64 } from "@/lib/delivery/visionOcr";

export const APIRoute = createAPIFileRoute("/api/delivery-extract")({
  POST: async ({ request }) => {
    try {
      const form = await request.formData();
      const file = form.get("file") as File | null;
      if (!file) {
        return Response.json({ ok: false, error: "missing file" }, { status: 400 });
      }

      const buf = Buffer.from(await file.arrayBuffer());
      const mime = file.type || "application/octet-stream";
      const isImage = mime.startsWith("image/");
      const isPdf = mime === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

      let text = "";
      let ocrSource: string | undefined;
      let ocrError: string | undefined;

      try {
        const scraped = buf.toString("utf8").replace(/[^\x20-\x7E\u0590-\u05FF\n\r\t]/g, " ");
        if (scraped.replace(/\s+/g, "").length > 80) {
          text = scraped;
        }
      } catch {
        /* ignore */
      }

      if (text.length < 40 && isImage) {
        const b64 = buf.toString("base64");
        const dataUri = `data:${mime};base64,${b64}`;
        const ocr = await ocrImageBase64(dataUri);
        if (ocr.ok && ocr.text) {
          text = ocr.text;
          ocrSource = ocr.source;
        } else {
          ocrError = ocr.error;
        }
      } else if (text.length < 40 && isPdf) {
        ocrError =
          "PDF סרוק: המר עמוד ראשון לתמונה בצד הלקוח או העלה JPEG/PNG. Vision דורש image.";
      }

      const raw = text
        ? parseDeliveryText(text, { sourceFileUrl: undefined })
        : {
            docNumber: "",
            customerName: "",
            lines: [],
            deposits: [],
          };

      const note = normalizeExtracted({
        ...raw,
        sourceFileUrl: undefined,
      });

      return Response.json({
        ok: true,
        note,
        ocr: { used: Boolean(ocrSource), source: ocrSource, error: ocrError, textChars: text.length },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ ok: false, error: message }, { status: 500 });
    }
  },
});
