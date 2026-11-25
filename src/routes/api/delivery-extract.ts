import { createAPIFileRoute } from "@tanstack/react-start/api";
import { normalizeExtracted, parseDeliveryText } from "@/lib/delivery/normalize";

export const APIRoute = createAPIFileRoute("/api/delivery-extract")({
  POST: async ({ request }) => {
    try {
      const form = await request.formData();
      const file = form.get("file") as File | null;
      if (!file) {
        return Response.json({ ok: false, error: "missing file" }, { status: 400 });
      }

      // Minimal text extraction: if PDF text libs unavailable, return editable shell
      // Clients can still fill fields manually on the overlay form.
      let text = "";
      try {
        // Best-effort: some environments may polyfill or use OCR later
        const buf = Buffer.from(await file.arrayBuffer());
        // Attempt naive string scrape from buffer (works for some text PDFs)
        text = buf.toString("utf8").replace(/[^\x20-\x7E\u0590-\u05FF\n\r\t]/g, " ");
        if (text.length < 40) text = "";
      } catch {
        text = "";
      }

      const raw = text
        ? parseDeliveryText(text, { sourceFileUrl: undefined })
        : {
            docNumber: "",
            customerName: "",
            lines: [],
            deposits: [],
          };

      // Optional object URL for preview is client-side only; server keeps structure
      const note = normalizeExtracted({
        ...raw,
        sourceFileUrl: undefined,
      });

      return Response.json({ ok: true, note });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ ok: false, error: message }, { status: 500 });
    }
  },
});
