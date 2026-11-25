import { useCallback, useEffect, useRef, useState } from "react";
import { useField } from "./FieldContext";
import {
  computeFocusMetrics,
  cropAndEnhanceCanvas,
  loadImage,
  type CropRect,
  type EnhanceMode,
  type ScanMode,
} from "@/lib/field/imaging";

interface CameraCanvasModalProps {
  open: boolean;
  mode: ScanMode;
  multiple?: boolean;
  onClose: () => void;
  onConfirm: (dataUrls: string[]) => void;
}

export function CameraCanvasModal({
  open,
  mode,
  multiple = false,
  onClose,
  onConfirm,
}: CameraCanvasModalProps) {
  const f = useField();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rawCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rawRectRef = useRef<CropRect | undefined>(undefined);
  const focusCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastLockStateRef = useRef(false);
  const stableTicksRef = useRef(0);

  const [cameraError, setCameraError] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [focusLocked, setFocusLocked] = useState(false);
  const [tapRing, setTapRing] = useState<{ x: number; y: number } | null>(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [enhanceMode, setEnhanceMode] = useState<EnhanceMode>(mode === "disc" ? "color" : "sharp");
  const [rotateDeg, setRotateDeg] = useState(0);
  const [tiltDeg, setTiltDeg] = useState(0);
  const [batchPages, setBatchPages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setCameraReady(false);
    setTorchOn(false);
    setTorchSupported(false);
  }, []);

  const startCamera = useCallback(async () => {
    setCameraError(false);
    setCameraReady(false);
    setFocusLocked(false);
    lastLockStateRef.current = false;
    stableTicksRef.current = 0;

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setCameraError(true);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 2560 },
          height: { ideal: 1920 },
        },
        audio: false,
      });
      streamRef.current = stream;

      const track = stream.getVideoTracks()[0];
      if (track) {
        try {
          const caps = track.getCapabilities?.() as
            (MediaTrackCapabilities & { torch?: boolean; focusMode?: string[] }) | undefined;
          if (caps?.torch) setTorchSupported(true);
          if (caps?.focusMode?.includes("continuous")) {
            await track.applyConstraints({
              advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
            });
          }
        } catch {
          /* ignore unsupported hardware camera constraints */
        }
      }

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
        setCameraReady(true);
      }
    } catch {
      setCameraError(true);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      stopCamera();
      setPreviewUrl(null);
      setBatchPages([]);
      setRotateDeg(0);
      setTiltDeg(0);
      rawCanvasRef.current = null;
      return;
    }
    setEnhanceMode(mode === "disc" ? "color" : "sharp");
    void startCamera();
    return () => {
      stopCamera();
    };
  }, [open, mode, startCamera, stopCamera]);

  /** Computes the crop rectangle inside native video pixels matching the visible object-cover guide frame. */
  const computeGuideCropRect = useCallback((): CropRect | undefined => {
    const video = videoRef.current;
    const frame = frameRef.current;
    if (!video || !frame || !video.videoWidth || !video.videoHeight) return undefined;

    const vRect = video.getBoundingClientRect();
    const fRect = frame.getBoundingClientRect();
    if (!vRect.width || !vRect.height || !fRect.width || !fRect.height) return undefined;

    const scale = Math.max(vRect.width / video.videoWidth, vRect.height / video.videoHeight);
    const renderedW = video.videoWidth * scale;
    const renderedH = video.videoHeight * scale;
    const offsetX = (renderedW - vRect.width) / 2;
    const offsetY = (renderedH - vRect.height) / 2;

    const relLeft = fRect.left - vRect.left + offsetX;
    const relTop = fRect.top - vRect.top + offsetY;

    const x = Math.max(0, relLeft / scale);
    const y = Math.max(0, relTop / scale);
    const w = Math.min(video.videoWidth - x, fRect.width / scale);
    const h = Math.min(video.videoHeight - y, fRect.height / scale);
    return { x, y, w, h };
  }, []);

  // Periodic focus & sharpness lock detector on guide frame ROI
  useEffect(() => {
    if (!open || previewUrl || !cameraReady || cameraError) return;

    if (!focusCanvasRef.current) {
      focusCanvasRef.current = document.createElement("canvas");
    }
    const scratch = focusCanvasRef.current;
    scratch.width = 200;
    scratch.height = 200;

    const timer = setInterval(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || !video.videoWidth) return;
      const crop = computeGuideCropRect() ?? {
        x: Math.round(video.videoWidth * 0.12),
        y: Math.round(video.videoHeight * 0.12),
        w: Math.round(video.videoWidth * 0.76),
        h: Math.round(video.videoHeight * 0.76),
      };
      const ctx = scratch.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, scratch.width, scratch.height);
      const { sharpness, brightness } = computeFocusMetrics(scratch);
      const isSharp = sharpness >= 9.5 && brightness >= 28;
      if (isSharp) {
        stableTicksRef.current = Math.min(stableTicksRef.current + 1, 5);
      } else {
        stableTicksRef.current = Math.max(stableTicksRef.current - 1, 0);
      }

      const nextLocked = stableTicksRef.current >= 2;
      if (nextLocked !== lastLockStateRef.current) {
        lastLockStateRef.current = nextLocked;
        setFocusLocked(nextLocked);
        if (nextLocked) {
          try {
            navigator.vibrate?.([35, 25, 35]);
          } catch {
            /* ignore unsupported vibrate */
          }
        }
      }
    }, 220);

    return () => clearInterval(timer);
  }, [open, previewUrl, cameraReady, cameraError, computeGuideCropRect]);

  const renderPreviewFromRaw = useCallback(
    (nextEnhance: EnhanceMode, nextRotate: number, nextTilt: number) => {
      const raw = rawCanvasRef.current;
      if (!raw) return;
      const url = cropAndEnhanceCanvas(raw, {
        ...(rawRectRef.current ? { cropRect: rawRectRef.current } : {}),
        mode,
        enhanceMode: nextEnhance,
        rotateDeg: nextRotate,
        tiltDeg: nextTilt,
        maxW: 1800,
      });
      setPreviewUrl(url);
    },
    [mode],
  );

  const captureFromVideo = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    setBusy(true);
    try {
      const crop = computeGuideCropRect();
      const raw = document.createElement("canvas");
      raw.width = video.videoWidth;
      raw.height = video.videoHeight;
      raw.getContext("2d")!.drawImage(video, 0, 0, raw.width, raw.height);
      rawCanvasRef.current = raw;
      rawRectRef.current = crop;
      setRotateDeg(0);
      setTiltDeg(0);
      renderPreviewFromRaw(enhanceMode, 0, 0);
      try {
        navigator.vibrate?.(45);
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(false);
    }
  };

  const handleFallbackFiles = async (files: File[]) => {
    if (!files.length) return;
    if (multiple && files.length > 1) {
      setBusy(true);
      try {
        const urls: string[] = [];
        for (const file of files) {
          const objUrl = URL.createObjectURL(file);
          try {
            const img = await loadImage(objUrl);
            urls.push(
              cropAndEnhanceCanvas(img, {
                mode,
                enhanceMode,
                maxW: 1800,
              }),
            );
          } finally {
            URL.revokeObjectURL(objUrl);
          }
        }
        onConfirm([...batchPages, ...urls]);
        onClose();
      } finally {
        setBusy(false);
      }
      return;
    }

    const file = files[0]!;
    setBusy(true);
    const objUrl = URL.createObjectURL(file);
    try {
      const img = await loadImage(objUrl);
      const raw = document.createElement("canvas");
      raw.width = img.naturalWidth || img.width;
      raw.height = img.naturalHeight || img.height;
      raw.getContext("2d")!.drawImage(img, 0, 0, raw.width, raw.height);
      rawCanvasRef.current = raw;
      rawRectRef.current = undefined;
      setRotateDeg(0);
      setTiltDeg(0);
      renderPreviewFromRaw(enhanceMode, 0, 0);
    } finally {
      URL.revokeObjectURL(objUrl);
      setBusy(false);
    }
  };

  const triggerTapFocus = async (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setTapRing({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    setTimeout(() => setTapRing(null), 650);
    stableTicksRef.current = 0;
    setFocusLocked(false);
    lastLockStateRef.current = false;

    const track = streamRef.current?.getVideoTracks()[0];
    if (track) {
      try {
        await track.applyConstraints({
          advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
        });
      } catch {
        /* ignore */
      }
    }
  };

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({
        advanced: [{ torch: next } as MediaTrackConstraintSet],
      });
      setTorchOn(next);
    } catch {
      /* ignore */
    }
  };

  const retake = () => {
    setPreviewUrl(null);
    rawCanvasRef.current = null;
    setRotateDeg(0);
    setTiltDeg(0);
    if (!streamRef.current) {
      void startCamera();
    }
  };

  const confirmAndFinish = () => {
    if (!previewUrl) return;
    onConfirm([...batchPages, previewUrl]);
    onClose();
  };

  const saveAndAddMore = () => {
    if (!previewUrl) return;
    setBatchPages((prev) => [...prev, previewUrl]);
    retake();
  };

  if (!open) return null;

  const isDisc = mode === "disc";

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background text-foreground"
      role="dialog"
      aria-modal="true"
      aria-label={f.t("cameraScan")}
    >
      {/* Top Bar */}
      <header className="flex items-center gap-3 border-b-[3px] border-brand bg-card px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          className="btn-field min-h-14 border-border bg-secondary px-4 text-lg"
        >
          → {f.t("back")}
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xl font-black">{f.t("cameraScan")}</div>
          <div className="text-sm font-bold text-muted-foreground">
            {isDisc ? f.t("alignDisc") : f.t("alignDocument")}
            {batchPages.length > 0 && ` · ${batchPages.length} ${f.t("pages")}`}
          </div>
        </div>
        {torchSupported && !previewUrl && (
          <button
            type="button"
            onClick={() => void toggleTorch()}
            className={`btn-field min-h-14 px-4 text-lg ${
              torchOn ? "border-brand bg-brand text-brand-foreground" : "border-border bg-secondary"
            }`}
          >
            🔦 {f.t("torch")}
          </button>
        )}
      </header>

      {/* Main Viewport or Preview */}
      {!previewUrl ? (
        <div className="relative flex flex-1 flex-col overflow-hidden bg-black">
          {!cameraError ? (
            <>
              <div
                className="relative flex-1 overflow-hidden"
                onClick={(e) => void triggerTapFocus(e)}
              >
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="h-full w-full object-cover"
                />

                {/* Alignment Guide Overlay */}
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center p-5">
                  {/* Status Banner */}
                  <div
                    className={`mb-4 rounded-xl border-[3px] px-4 py-2 text-lg font-black shadow-lg transition-colors ${
                      focusLocked
                        ? "border-success bg-success text-success-foreground"
                        : "border-brand bg-brand text-brand-foreground"
                    }`}
                  >
                    {focusLocked ? `✓ ${f.t("focusLocked")}` : `◎ ${f.t("focusSearching")}`}
                  </div>

                  {/* Guide Frame */}
                  <div
                    ref={frameRef}
                    className={`relative transition-all duration-200 ${
                      isDisc
                        ? "aspect-square w-full max-w-[340px] rounded-full border-4"
                        : "aspect-[3/4] w-full max-w-[420px] max-h-[60vh] rounded-2xl border-4"
                    } ${
                      focusLocked
                        ? "border-success shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
                        : "border-brand shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
                    }`}
                  >
                    {!isDisc && (
                      <>
                        <span
                          className={`absolute -top-1 -right-1 h-9 w-9 rounded-tr-xl border-t-[6px] border-r-[6px] ${
                            focusLocked ? "border-success" : "border-white"
                          }`}
                        />
                        <span
                          className={`absolute -top-1 -left-1 h-9 w-9 rounded-tl-xl border-t-[6px] border-l-[6px] ${
                            focusLocked ? "border-success" : "border-white"
                          }`}
                        />
                        <span
                          className={`absolute -bottom-1 -right-1 h-9 w-9 rounded-br-xl border-r-[6px] border-b-[6px] ${
                            focusLocked ? "border-success" : "border-white"
                          }`}
                        />
                        <span
                          className={`absolute -bottom-1 -left-1 h-9 w-9 rounded-bl-xl border-b-[6px] border-l-[6px] ${
                            focusLocked ? "border-success" : "border-white"
                          }`}
                        />
                      </>
                    )}
                  </div>
                </div>

                {/* Tap-to-focus ring */}
                {tapRing && (
                  <div
                    style={{ left: tapRing.x - 36, top: tapRing.y - 36 }}
                    className="pointer-events-none absolute size-[72px] rounded-full border-4 border-brand animate-ping"
                  />
                )}
              </div>

              {/* Capture Action Footer */}
              <div className="grid gap-3 border-t-[3px] border-border bg-card p-4">
                <button
                  type="button"
                  disabled={!cameraReady || busy}
                  onClick={() => void captureFromVideo()}
                  className={`btn-field w-full text-2xl ${
                    focusLocked
                      ? "border-success bg-success text-success-foreground"
                      : "border-brand bg-brand text-brand-foreground"
                  }`}
                >
                  📷 {busy ? "…" : f.t("captureNow")}
                </button>
                <label className="btn-field w-full cursor-pointer border-border bg-secondary text-lg">
                  📁 {f.t("systemCamera")}
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    multiple={multiple}
                    className="hidden"
                    onChange={(e) => {
                      const fs = Array.from(e.target.files ?? []);
                      if (fs.length) void handleFallbackFiles(fs);
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-5 bg-background p-6 text-center">
              <div className="max-w-md rounded-2xl border-[3px] border-brand bg-card p-6">
                <p className="text-2xl font-black">📷 {f.t("cameraScan")}</p>
                <p className="mt-3 text-lg font-bold text-muted-foreground">
                  {f.t("cameraFallbackNotice")}
                </p>
                <label className="btn-field mt-5 w-full cursor-pointer border-brand bg-brand text-brand-foreground text-xl">
                  📷 {f.t("systemCamera")}
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    multiple={multiple}
                    className="hidden"
                    onChange={(e) => {
                      const fs = Array.from(e.target.files ?? []);
                      if (fs.length) void handleFallbackFiles(fs);
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
            </div>
          )}
        </div>
      ) : (
        /* Preview + Crop/Straighten Controls */
        <div className="flex flex-1 flex-col justify-between gap-4 overflow-y-auto bg-background p-4">
          <div className="mx-auto flex w-full max-w-xl flex-1 items-center justify-center">
            <img
              src={previewUrl}
              alt=""
              className="max-h-[54vh] w-full rounded-2xl border-[3px] border-brand bg-white object-contain p-1"
            />
          </div>

          <div className="mx-auto grid w-full max-w-xl gap-3 rounded-2xl border-[3px] border-border bg-card p-4">
            {/* Scan Enhancement Mode & 90deg Rotation */}
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => {
                  setEnhanceMode("sharp");
                  renderPreviewFromRaw("sharp", rotateDeg, tiltDeg);
                }}
                className={`btn-field min-h-14 px-2 text-base ${
                  enhanceMode === "sharp"
                    ? "border-brand bg-brand text-brand-foreground"
                    : "border-border bg-secondary"
                }`}
              >
                {f.t("sharpScan")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEnhanceMode("color");
                  renderPreviewFromRaw("color", rotateDeg, tiltDeg);
                }}
                className={`btn-field min-h-14 px-2 text-base ${
                  enhanceMode === "color"
                    ? "border-brand bg-brand text-brand-foreground"
                    : "border-border bg-secondary"
                }`}
              >
                {f.t("colorScan")}
              </button>
              <button
                type="button"
                onClick={() => {
                  const nextRot = (rotateDeg + 90) % 360;
                  setRotateDeg(nextRot);
                  renderPreviewFromRaw(enhanceMode, nextRot, tiltDeg);
                }}
                className="btn-field min-h-14 border-border bg-secondary px-2 text-base"
              >
                ↻ {f.t("rotate90")}
              </button>
            </div>

            {/* Fine Tilt / Straightening */}
            <label className="flex items-center gap-3 px-1">
              <span className="text-base font-bold whitespace-nowrap">
                {f.t("straighten")}:{" "}
                <span dir="ltr">{tiltDeg > 0 ? `+${tiltDeg}°` : `${tiltDeg}°`}</span>
              </span>
              <input
                type="range"
                min={-6}
                max={6}
                step={0.5}
                value={tiltDeg}
                onChange={(e) => {
                  const nextTilt = Number(e.target.value);
                  setTiltDeg(nextTilt);
                  renderPreviewFromRaw(enhanceMode, rotateDeg, nextTilt);
                }}
                className="h-8 flex-1 accent-[#1A56DB]"
              />
            </label>

            {/* Confirm / Add Page / Retake */}
            <div className="grid gap-2">
              <button
                type="button"
                onClick={confirmAndFinish}
                className="btn-field w-full border-brand bg-brand text-brand-foreground text-2xl"
              >
                ✓ {f.t("confirmUse")}
              </button>
              {multiple && (
                <button
                  type="button"
                  onClick={saveAndAddMore}
                  className="btn-field w-full border-success bg-success text-success-foreground text-xl"
                >
                  ➕ {f.t("addAnotherPage")}
                </button>
              )}
              <button
                type="button"
                onClick={retake}
                className="btn-field w-full border-border bg-secondary text-xl"
              >
                ↺ {f.t("retake")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
