import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type VisionState = "off" | "requesting" | "on" | "paused" | "error";

export type VisionSourceInfo = {
    label: string; // e.g. "Display capture"
};

export type CapturedFrame = {
    blob: Blob;
    url: string; // objectURL for preview
    capturedAt: number;
    width: number;
    height: number;
};

type Options = {
    /** How often to auto-capture while Vision is ON (ms). 0 = no auto-capture */
    autoCaptureEveryMs?: number;
    /** JPEG quality (0..1) */
    jpegQuality?: number;
    /** Max preview width (for performance) */
    maxWidth?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useAIVision(opts?: Options) {
    const autoCaptureEveryMs = opts?.autoCaptureEveryMs ?? 0; // start with 0 (manual only)
    const jpegQuality = opts?.jpegQuality ?? 0.75;
    const maxWidth = opts?.maxWidth ?? 900;

    const [state, setState] = useState<VisionState>("off");
    const [lastCaptureAt, setLastCaptureAt] = useState<number | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [sourceInfo, setSourceInfo] = useState<VisionSourceInfo | null>(null);
    const [error, setError] = useState<string | null>(null);

    // For API: keep the last captured frame as Blob in memory
    const lastFrameRef = useRef<CapturedFrame | null>(null);

    const streamRef = useRef<MediaStream | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const timerRef = useRef<number | null>(null);

    const lastBlobUrlRef = useRef<string | null>(null);

    const cleanupBlobUrl = useCallback(() => {
        if (lastBlobUrlRef.current) {
            URL.revokeObjectURL(lastBlobUrlRef.current);
            lastBlobUrlRef.current = null;
        }
    }, []);

    const stopTimer = useCallback(() => {
        if (timerRef.current) {
            window.clearInterval(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    const stop = useCallback(() => {
        stopTimer();
        cleanupBlobUrl();

        // also cleanup lastFrame url
        if (lastFrameRef.current?.url) {
            URL.revokeObjectURL(lastFrameRef.current.url);
        }
        lastFrameRef.current = null;

        setPreviewUrl(null);
        setLastCaptureAt(null);
        setSourceInfo(null);
        setError(null);
        setState("off");

        if (videoRef.current) {
            videoRef.current.srcObject = null;
        }

        const s = streamRef.current;
        streamRef.current = null;
        if (s) {
            s.getTracks().forEach((t) => t.stop());
        }
    }, [cleanupBlobUrl, stopTimer]);

    const ensureVideo = useCallback(() => {
        if (!videoRef.current) {
            const v = document.createElement("video");
            v.muted = true;
            v.playsInline = true;
            videoRef.current = v;
        }
        if (!canvasRef.current) {
            canvasRef.current = document.createElement("canvas");
        }
        return { video: videoRef.current!, canvas: canvasRef.current! };
    }, []);

    /**
     * Core: capture a single frame as JPEG Blob (+ objectURL for preview).
     * This is what we'll use for:
     * - Re-sync (single image)
     * - Clip frames (multiple images)
     */
    const captureFrameBlob = useCallback(async (): Promise<CapturedFrame | null> => {
        try {
            const s = streamRef.current;
            if (!s) return null;

            const { video, canvas } = ensureVideo();

            // Wait until video has frames
            if (video.readyState < 2) {
                await new Promise<void>((resolve) => {
                    const onLoaded = () => {
                        video.removeEventListener("loadeddata", onLoaded);
                        resolve();
                    };
                    video.addEventListener("loadeddata", onLoaded);
                });
            }

            const vw = video.videoWidth || 0;
            const vh = video.videoHeight || 0;
            if (!vw || !vh) return null;

            // Scale down for perf
            const scale = Math.min(1, maxWidth / vw);
            const tw = Math.max(1, Math.round(vw * scale));
            const th = Math.max(1, Math.round(vh * scale));

            canvas.width = tw;
            canvas.height = th;

            const ctx = canvas.getContext("2d");
            if (!ctx) return null;

            ctx.drawImage(video, 0, 0, tw, th);

            const blob: Blob | null = await new Promise((resolve) =>
                canvas.toBlob(resolve, "image/jpeg", jpegQuality)
            );
            if (!blob) return null;

            const url = URL.createObjectURL(blob);
            const frame: CapturedFrame = {
                blob,
                url,
                capturedAt: Date.now(),
                width: tw,
                height: th,
            };

            return frame;
        } catch (e: any) {
            setError(e?.message ?? "capture error");
            setState("error");
            return null;
        }
    }, [ensureVideo, jpegQuality, maxWidth]);

    const applyLastFrameToUI = useCallback((frame: CapturedFrame) => {
        // Replace preview URL (revoke old)
        cleanupBlobUrl();
        lastBlobUrlRef.current = frame.url;

        setPreviewUrl(frame.url);
        setLastCaptureAt(frame.capturedAt);
        setError(null);

        // keep it for API
        // cleanup previous lastFrame url if different
        if (lastFrameRef.current?.url && lastFrameRef.current.url !== frame.url) {
            URL.revokeObjectURL(lastFrameRef.current.url);
        }
        lastFrameRef.current = frame;
    }, [cleanupBlobUrl]);

    const captureOnce = useCallback(async () => {
        const frame = await captureFrameBlob();
        if (!frame) return;
        applyLastFrameToUI(frame);
    }, [applyLastFrameToUI, captureFrameBlob]);

    const start = useCallback(async () => {
        try {
            setError(null);
            setState("requesting");

            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: false,
            });

            // user can stop sharing from browser UI
            stream.getVideoTracks()[0]?.addEventListener("ended", () => {
                stop();
            });

            streamRef.current = stream;

            const { video } = ensureVideo();
            video.srcObject = stream;

            await video.play().catch(() => { });

            setSourceInfo({ label: "Display capture" });

            setState("on");

            // First snapshot immediately
            await captureOnce();

            // Optional auto-capture
            stopTimer();
            if (autoCaptureEveryMs > 0) {
                timerRef.current = window.setInterval(() => {
                    void captureOnce();
                }, autoCaptureEveryMs);
            }
        } catch (e: any) {
            setError(e?.message ?? "permission denied");
            setState("off");
        }
    }, [autoCaptureEveryMs, captureOnce, ensureVideo, stop, stopTimer]);

    const pause = useCallback(() => {
        if (state === "on") {
            stopTimer();
            setState("paused");
        }
    }, [state, stopTimer]);

    const resume = useCallback(() => {
        if (state === "paused") {
            setState("on");
            stopTimer();
            if (autoCaptureEveryMs > 0) {
                timerRef.current = window.setInterval(() => {
                    void captureOnce();
                }, autoCaptureEveryMs);
            }
        }
    }, [autoCaptureEveryMs, captureOnce, state, stopTimer]);

    const reSync = useCallback(async () => {
        await captureOnce();
    }, [captureOnce]);

    /**
     * MVP "clip": capture N frames over time.
     * Example: seconds=5, fps=1 => 5 frames (1 per second)
     */
    const recordClipFrames = useCallback(
        async (seconds: number, fps: number): Promise<CapturedFrame[]> => {
            const frames: CapturedFrame[] = [];
            if (!streamRef.current) return frames;

            const total = Math.max(1, Math.round(seconds * fps));
            const intervalMs = Math.max(50, Math.round(1000 / fps));

            for (let i = 0; i < total; i++) {
                const frame = await captureFrameBlob();
                if (frame) frames.push(frame);

                // wait until next frame (but don't wait after the last one)
                if (i < total - 1) {
                    await sleep(intervalMs);
                }
            }

            // Also update the main preview with the last frame of the clip
            const last = frames[frames.length - 1];
            if (last) {
                applyLastFrameToUI(last);
            }

            return frames;
        },
        [applyLastFrameToUI, captureFrameBlob]
    );

    const getLastFrame = useCallback((): CapturedFrame | null => {
        return lastFrameRef.current;
    }, []);

    const lastCaptureText = useMemo(() => {
        if (!lastCaptureAt) return "—";
        const sec = Math.max(0, Math.round((Date.now() - lastCaptureAt) / 1000));
        return `${sec}s ago`;
    }, [lastCaptureAt]);

    useEffect(() => {
        return () => {
            stop();
        };
    }, [stop]);

    return {
        state,
        error,
        sourceInfo,
        previewUrl,
        lastCaptureAt,
        lastCaptureText,

        start,
        stop,
        pause,
        resume,
        reSync,

        // NEW for MVP clip + API
        recordClipFrames,
        getLastFrame,

        isOn: state === "on",
        isPaused: state === "paused",
        isRequesting: state === "requesting",
    };
}
