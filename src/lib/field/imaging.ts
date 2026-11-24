import { jsPDF } from "jspdf";

/** Downscale + grayscale + contrast stretch + simple shadow flattening. Returns JPEG data URL. */
export async function enhanceDocument(file: File, maxW = 1600): Promise<string> {
  const img = await loadImage(URL.createObjectURL(file));
  const scale = Math.min(1, maxW / img.width);
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d")!; ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h); const px = data.data;
  // background estimate via blurred copy (shadow removal)
  const bc = document.createElement("canvas"); bc.width = w; bc.height = h;
  const bctx = bc.getContext("2d")!; bctx.filter = "blur(24px) grayscale(1)"; bctx.drawImage(c, 0, 0);
  const bg = bctx.getImageData(0, 0, w, h).data;
  for (let i = 0; i < px.length; i += 4) {
    const g = 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;
    const b = Math.max(bg[i]!, 1);
    let v = Math.min(255, (g / b) * 255);   // divide by background → flat lighting
    v = v < 140 ? v * 0.6 : Math.min(255, v * 1.08); // contrast boost
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(data, 0, 0);
  return c.toDataURL("image/jpeg", 0.75);
}

export async function photoToDataUrl(file: File, maxW = 1200): Promise<string> {
  const img = await loadImage(URL.createObjectURL(file));
  const s = Math.min(1, maxW / img.width);
  const c = document.createElement("canvas"); c.width = img.width * s; c.height = img.height * s;
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.7);
}

export async function pagesToPdf(pages: string[]): Promise<string> {
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  for (let i = 0; i < pages.length; i++) {
    const img = await loadImage(pages[i]!);
    const W = 210, H = 297; const r = Math.min(W / img.width, H / img.height);
    const w = img.width * r, h = img.height * r;
    if (i > 0) pdf.addPage();
    pdf.addImage(pages[i]!, "JPEG", (W - w) / 2, (H - h) / 2, w, h);
  }
  return pdf.output("datauristring");
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}
