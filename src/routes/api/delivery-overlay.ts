import { createAPIFileRoute } from "@tanstack/react-start/api";
import { writeOverlayToSheet } from "@/lib/delivery/sheetWrite";
import type { OverlayPayload } from "@/lib/delivery/types";

export const APIRoute = createAPIFileRoute("/api/delivery-overlay")({
  POST: async ({ request }) => {
    try {
      const body = (await request.json()) as OverlayPayload;
      if (!body.deliveryId) {
        return Response.json({ ok: false, error: "deliveryId required" }, { status: 400 });
      }
      const result = await writeOverlayToSheet(body);
      return Response.json(result, { status: result.ok ? 200 : 502 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ ok: false, error: message }, { status: 500 });
    }
  },
});
