import { jsPDF } from "jspdf";

export type ScanMode = "document" | "disc" | "receipt";
export type EnhanceMode = "sharp" | "color";

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CropEnhanceOptions {
  cropRect?: CropRect;
  mode: ScanMode;
  enhanceMode: EnhanceMode;
  rotateDeg?: number;
  tiltDeg?: number;
  maxW?: number;
}

/** Fast edge-gradient sharpness + mean luminance calculation on a canvas ROI for focus locking. */
export function computeFocusMetrics(canvas: HTMLCanvasElement): {
  sharpness: number;
  brightness: number;
} {
  const ctx = canvas.getContext("2d");
  if (!ctx || canvas.width < 4 || canvas.height < 4) {
    return { sharpness: 0, brightness: 0 };
  }
  const { width: w, height: h } = canvas;
  const data = ctx.getImageData(0, 0, w, h).data;
  let lumSum = 0;
  let gradSum = 0;
  let count = 0;

  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      const idx = (y * w + x) * 4;
      const idxR = (y * w + (x + 1)) * 4;
      const idxD = ((y + 1) * w + x) * 4;
      const c = 0.299 * data[idx]! + 0.587 * data[idx + 1]! + 0.114 * data[idx + 2]!;
      const r = 0.299 * data[idxR]! + 0.587 * data[idxR + 1]! + 0.114 * data[idxR + 2]!;
      const d = 0.299 * data[idxD]! + 0.587 * data[idxD + 1]! + 0.114 * data[idxD + 2]!;
      lumSum += c;
      gradSum += Math.abs(c - r) + Math.abs(c - d);
      count++;
    }
  }
  if (count === 0) return { sharpness: 0, brightness: 0 };
  return {
    sharpness: gradSum / count,
    brightness: lumSum / count,
  };
}

/** Crops to target frame, applies rotation/straightening and sharp document/disc enhancement. */
export function cropAndEnhanceCanvas(
  source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement,
  opts: CropEnhanceOptions,
): string {
  const srcW =
    source instanceof HTMLVideoElement
      ? source.videoWidth
      : source instanceof HTMLImageElement
        ? source.naturalWidth || source.width
        : source.width;
  const srcH =
    source instanceof HTMLVideoElement
      ? source.videoHeight
      : source instanceof HTMLImageElement
        ? source.naturalHeight || source.height
        : source.height;

  const rect = opts.cropRect ?? { x: 0, y: 0, w: srcW, h: srcH };
  const rx = Math.max(0, Math.round(rect.x));
  const ry = Math.max(0, Math.round(rect.y));
  const rw = Math.max(16, Math.min(srcW - rx, Math.round(rect.w)));
  const rh = Math.max(16, Math.min(srcH - ry, Math.round(rect.h)));

  const rotateDeg = (((opts.rotateDeg ?? 0) % 360) + 360) % 360;
  const swapAxes = rotateDeg === 90 || rotateDeg === 270;
  const baseW = swapAxes ? rh : rw;
  const baseH = swapAxes ? rw : rh;

  const maxW = opts.maxW ?? 1800;
  const scale = Math.min(1, maxW / baseW);
  const outW = Math.max(16, Math.round(baseW * scale));
  const outH = Math.max(16, Math.round(baseH * scale));

  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext("2d")!;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, outW, outH);

  ctx.save();
  ctx.translate(outW / 2, outH / 2);
  const totalRad = ((rotateDeg + (opts.tiltDeg ?? 0)) * Math.PI) / 180;
  ctx.rotate(totalRad);

  const drawW = swapAxes ? outH : outW;
  const drawH = swapAxes ? outW : outH;
  // Slightly zoom on non-zero tilt so corners remain filled without dark edges
  const tiltBoost = opts.tiltDeg ? 1 + Math.abs(opts.tiltDeg) * 0.018 : 1;
  ctx.drawImage(
    source,
    rx,
    ry,
    rw,
    rh,
    (-drawW * tiltBoost) / 2,
    (-drawH * tiltBoost) / 2,
    drawW * tiltBoost,
    drawH * tiltBoost,
  );
  ctx.restore();

  if (opts.enhanceMode === "sharp") {
    applyDocumentSharpFilter(out);
  } else {
    applyColorClarityFilter(out);
  }

  return out.toDataURL("image/jpeg", 0.88);
}

function applyDocumentSharpFilter(c: HTMLCanvasElement) {
  const w = c.width;
  const h = c.height;
  const ctx = c.getContext("2d")!;
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;

  const bc = document.createElement("canvas");
  bc.width = w;
  bc.height = h;
  const bctx = bc.getContext("2d")!;
  bctx.filter = "blur(24px) grayscale(1)";
  bctx.drawImage(c, 0, 0);
  const bg = bctx.getImageData(0, 0, w, h).data;

  for (let i = 0; i < px.length; i += 4) {
    const g = 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;
    const b = Math.max(bg[i]!, 1);
    let v = Math.min(255, (g / b) * 255);
    v = v < 145 ? v * 0.58 : Math.min(255, v * 1.1);
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(data, 0, 0);
}

function applyColorClarityFilter(c: HTMLCanvasElement) {
  const ctx = c.getContext("2d")!;
  const data = ctx.getImageData(0, 0, c.width, c.height);
  const px = data.data;
  const contrast = 1.16;
  for (let i = 0; i < px.length; i += 4) {
    px[i] = clampByte((px[i]! - 128) * contrast + 132);
    px[i + 1] = clampByte((px[i + 1]! - 128) * contrast + 132);
    px[i + 2] = clampByte((px[i + 2]! - 128) * contrast + 132);
  }
  ctx.putImageData(data, 0, 0);
}

function clampByte(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

/** Downscale + grayscale + contrast stretch + simple shadow flattening. Returns JPEG data URL. */
export async function enhanceDocument(file: File, maxW = 1600): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    return cropAndEnhanceCanvas(img, {
      mode: "document",
      enhanceMode: "sharp",
      maxW,
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function photoToDataUrl(file: File, maxW = 1400): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const s = Math.min(1, maxW / img.width);
    const c = document.createElement("canvas");
    c.width = img.width * s;
    c.height = img.height * s;
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function pagesToPdf(pages: string[]): Promise<string> {
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  for (let i = 0; i < pages.length; i++) {
    const img = await loadImage(pages[i]!);
    const W = 210,
      H = 297;
    const r = Math.min(W / img.width, H / img.height);
    const w = img.width * r,
      h = img.height * r;
    if (i > 0) pdf.addPage();
    pdf.addImage(pages[i]!, "JPEG", (W - w) / 2, (H - h) / 2, w, h);
  }
  return pdf.output("datauristring");
}

export function loadImage(src: string) {
  return new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
}
