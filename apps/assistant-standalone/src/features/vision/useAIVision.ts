import { useCallback, useEffect, useRef, useState } from "react";

export type CapturedFrame = {
    url: string;        // objectURL (для превью/клика)
    blob: Blob;         // jpeg blob (для отправки на бэк)
    capturedAt: number; // timestamp
};

type SourceInfo = {
    label?: string;
    displaySurface?: string;
};

type Options = {
    autoCaptureEveryMs?: number; // 0 = off
    jpegQuality?: number;        // 0..1
    maxWidth?: number;           // downscale for performance
};

type LastFrame = CapturedFrame & { w: number; h: number };

function sleep(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms));
}

async function waitVideoReady(v: HTMLVideoElement) {
    // HAVE_CURRENT_DATA = 2
    if (v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0) return;

    await new Promise<void>((resolve) => {
        const onMeta = () => {
            cleanup();
            resolve();
        };
        const onData = () => {
            if (v.videoWidth > 0 && v.videoHeight > 0) {
                cleanup();
                resolve();
            }
        };
        const cleanup = () => {
            v.removeEventListener("loadedmetadata", onMeta);
            v.removeEventListener("loadeddata", onData);
        };

        v.addEventListener("loadedmetadata", onMeta, { once: true });
        v.addEventListener("loadeddata", onData, { once: true });
    });
}

export function useAIVision(opts: Options = {}) {
    const autoCaptureEveryMs = Number(opts.autoCaptureEveryMs || 0);
    const jpegQuality = typeof opts.jpegQuality === "number" ? opts.jpegQuality : 0.75;
    const maxWidth = Number(opts.maxWidth || 900);

    const streamRef = useRef<MediaStream | null>(null);
    const trackRef = useRef<MediaStreamTrack | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const lastFrameRef = useRef<LastFrame | null>(null);
    const autoTimerRef = useRef<number | null>(null);

    const [stream, setStream] = useState<MediaStream | null>(null);
    const [isOn, setIsOn] = useState(false);
    const [isPaused, setIsPaused] = useState(false);
    const [isRequesting, setIsRequesting] = useState(false);

    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [lastCaptureText, setLastCaptureText] = useState<string>("—");
    const [sourceInfo, setSourceInfo] = useState<SourceInfo | null>(null);

    const revokeUrl = (u: string | null) => {
        if (!u) return;
        try {
            URL.revokeObjectURL(u);
        } catch {
            // ignore
        }
    };

    const clearAutoTimer = () => {
        if (autoTimerRef.current != null) {
            window.clearInterval(autoTimerRef.current);
            autoTimerRef.current = null;
        }
    };

    const stop = useCallback(() => {
        clearAutoTimer();

        // revoke preview
        setPreviewUrl((prev) => {
            revokeUrl(prev);
            return null;
        });

        setLastCaptureText("—");
        setSourceInfo(null);

        lastFrameRef.current = null;

        // stop tracks
        try {
            streamRef.current?.getTracks?.().forEach((t) => {
                try {
                    t.stop();
                } catch {
                    // ignore
                }
            });
        } catch {
            // ignore
        }

        streamRef.current = null;
        trackRef.current = null;

        // detach video
        if (videoRef.current) {
            try {
                (videoRef.current as any).srcObject = null;
            } catch {
                // ignore
            }
        }
        videoRef.current = null;

        canvasRef.current = null;

        setStream(null);
        setIsOn(false);
        setIsPaused(false);
        setIsRequesting(false);
    }, []);

    const ensureInternals = () => {
        if (!videoRef.current) {
            const v = document.createElement("video");
            v.muted = true;
            v.autoplay = true;
            v.playsInline = true;
            videoRef.current = v;
        }
        if (!canvasRef.current) {
            canvasRef.current = document.createElement("canvas");
        }
    };

    const captureFrameBlob = useCallback(async () => {
        const v = videoRef.current;
        if (!v) throw new Error("Vision video is not initialized");
        await waitVideoReady(v);

        const vw = v.videoWidth || 1280;
        const vh = v.videoHeight || 720;

        const scale = vw > maxWidth ? maxWidth / vw : 1;
        const w = Math.max(1, Math.round(vw * scale));
        const h = Math.max(1, Math.round(vh * scale));

        const canvas = canvasRef.current!;
        canvas.width = w;
        canvas.height = h;

        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas 2D context not available");

        ctx.drawImage(v, 0, 0, w, h);

        const blob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
                (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob failed"))),
                "image/jpeg",
                jpegQuality
            );
        });

        return { blob, w, h };
    }, [jpegQuality, maxWidth]);

    const reSync = useCallback(async () => {
        if (!streamRef.current) return null;

        const { blob, w, h } = await captureFrameBlob();
        const capturedAt = Date.now();
        const url = URL.createObjectURL(blob);

        setPreviewUrl((prev) => {
            revokeUrl(prev);
            return url;
        });

        const lf: LastFrame = { blob, url, capturedAt, w, h };
        lastFrameRef.current = lf;

        setLastCaptureText(new Date(capturedAt).toLocaleTimeString());
        return lf;
    }, [captureFrameBlob]);

    const getLastFrame = useCallback(() => {
        const lf = lastFrameRef.current;
        if (!lf) return null;
        // важно: blob отдаём напрямую; url используется только для превью
        return { blob: lf.blob, url: lf.url, capturedAt: lf.capturedAt };
    }, []);

    const recordClipFrames = useCallback(
        async (durationSec: number, fps = 1): Promise<CapturedFrame[]> => {
            if (!streamRef.current) throw new Error("Vision is OFF");

            const safeFps = Math.max(0.2, Number(fps || 1));
            const intervalMs = Math.max(200, Math.round(1000 / safeFps));
            const total = Math.max(1, Math.round((Math.max(0.5, durationSec) * 1000) / intervalMs));

            const frames: CapturedFrame[] = [];

            for (let i = 0; i < total; i++) {
                const { blob } = await captureFrameBlob();
                const capturedAt = Date.now();
                const url = URL.createObjectURL(blob);
                frames.push({ blob, url, capturedAt });

                if (i !== total - 1) await sleep(intervalMs);
            }

            return frames;
        },
        [captureFrameBlob]
    );

    const start = useCallback(async () => {
        // важное правило: getDisplayMedia должен быть вызван из user gesture (клик по кнопке)
        stop();
        setIsRequesting(true);

        try {
            ensureInternals();

            const s = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    frameRate: 30,
                } as any,
                audio: false,
            });

            streamRef.current = s;
            setStream(s);

            const track = s.getVideoTracks?.()[0] || null;
            trackRef.current = track;

            if (track) {
                const settings: any = track.getSettings?.() || {};
                setSourceInfo({
                    label: track.label || "Shared screen",
                    displaySurface: settings.displaySurface,
                });

                track.onended = () => {
                    // пользователь нажал "Stop sharing" в браузере
                    stop();
                };
            } else {
                setSourceInfo({ label: "Shared screen" });
            }

            // attach stream to internal video (for frame capture)
            const v = videoRef.current!;
            (v as any).srcObject = s;

            // play
            try {
                await v.play();
            } catch {
                // иногда autoplay блокируется, но для displayMedia обычно ок
            }

            await waitVideoReady(v);

            setIsOn(true);
            setIsPaused(false);
            setIsRequesting(false);

            // сразу сделаем первый кадр, чтобы превью/lastCaptureText не были "—"
            await reSync();
        } catch (e) {
            setIsRequesting(false);
            stop();
            throw e;
        }
    }, [reSync, stop]);

    const pause = useCallback(() => {
        // пауза = оставляем стрим, но прекращаем автоснимки (и считаем состояние paused)
        if (!streamRef.current) return;
        clearAutoTimer();
        setIsPaused(true);
        setIsOn(false);
    }, []);

    const resume = useCallback(() => {
        if (!streamRef.current) return;
        setIsPaused(false);
        setIsOn(true);
    }, []);

    // auto-capture loop (если включено)
    useEffect(() => {
        clearAutoTimer();

        if (!autoCaptureEveryMs) return;
        if (!streamRef.current) return;
        if (!isOn) return; // когда paused/off — не снимаем

        autoTimerRef.current = window.setInterval(() => {
            void reSync();
        }, autoCaptureEveryMs);

        return () => clearAutoTimer();
    }, [autoCaptureEveryMs, isOn, reSync]);

    // cleanup on unmount
    useEffect(() => {
        return () => stop();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return {
        // stream (для background video)
        stream,

        // states
        isOn,
        isPaused,
        isRequesting,

        // ui bits
        previewUrl,
        lastCaptureText,
        sourceInfo,

        // actions
        start,
        stop,
        pause,
        resume,
        reSync,
        getLastFrame,
        recordClipFrames,
    };
}
