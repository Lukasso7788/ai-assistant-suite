import React, { useEffect, useMemo, useRef, useState } from "react";
import type { CapturedFrame } from "./features/vision/useAIVision";
import { useAIVision } from "./features/vision/useAIVision";

type Role = "system" | "user" | "assistant";

type ChatMsg = {
  id: string;
  role: Role;
  text: string;
  ts: number;
};

type DockMode = "left" | "center" | "right" | "free" | "hidden";

const BACKEND_URL = "http://localhost:3001";
const CLIENT_TIMEOUT_MS = 75_000;

declare global {
  interface Window {
    webkitSpeechRecognition?: any;
    SpeechRecognition?: any;
  }
}

const LANG_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "Auto", value: "auto" },
  { label: "EN", value: "en-US" },
  { label: "RU", value: "ru-RU" },
  { label: "UK", value: "uk-UA" },
  { label: "DE", value: "de-DE" },
  { label: "ES", value: "es-ES" },
  { label: "FR", value: "fr-FR" },
  { label: "PL", value: "pl-PL" },
  { label: "TR", value: "tr-TR" },
];

function resolveLang(v: string) {
  if (v === "auto") return (navigator.language || "en-US").trim();
  return v.trim();
}

function isInteractiveTarget(t: EventTarget | null) {
  if (!(t instanceof HTMLElement)) return false;
  return Boolean(t.closest("button,a,input,textarea,select,option,label,[role='button'],[data-no-drag='1']"));
}

export default function App() {
  // --- Vision hook ---
  const vision = useAIVision({
    autoCaptureEveryMs: 0,
    jpegQuality: 0.75,
    maxWidth: 900,
  });

  // ✅ Dynamic page style: when stream exists, do NOT paint gradient background
  const pageStyleDyn = useMemo<React.CSSProperties>(() => {
    return {
      ...pageStyle,
      background: vision.stream ? "transparent" : pageStyle.background,
    };
  }, [vision.stream]);

  // --- Viewport (needed for free-mode sizing/clamp) ---
  const [viewport, setViewport] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // --- UI state ---
  const [dock, setDock] = useState<DockMode>("right");
  const [isExpanded, setIsExpanded] = useState(true);
  const [explainMode, setExplainMode] = useState(false);
  const [speakOutput, setSpeakOutput] = useState(false);
  const [modelLabel] = useState("Model");

  const [clipFrames, setClipFrames] = useState<CapturedFrame[]>([]);
  const [isRecordingClip, setIsRecordingClip] = useState(false);

  const [messages, setMessages] = useState<ChatMsg[]>(() => {
    const now = Date.now();
    return [
      {
        id: "sys-1",
        role: "system",
        ts: now,
        text:
          "Assistant ready. Use AI Vision (private) to let the assistant see your screen. Voice input/output is browser-based (free).",
      },
    ];
  });

  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Attachments (files)
  const [attachments, setAttachments] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // --- Panel metrics (used for bounds in free-mode) ---
  const panelW = isExpanded ? 470 : 320;

  // высота floating-окна в free mode (фиксирует раздувание панели под сообщения)
  const freeH = useMemo(() => {
    const target = isExpanded ? 720 : 620;
    return clamp(target, 360, viewport.h - 24);
  }, [isExpanded, viewport.h]);

  // --- free-move drag ---
  const [freePos, setFreePos] = useState<{ x: number; y: number }>(() => ({
    x: Math.max(16, window.innerWidth - (470 + 16)), // initial as expanded
    y: 16,
  }));

  const [isDragging, setIsDragging] = useState(false);

  const dragRef = useRef<{
    dragging: boolean;
    pointerId: number | null;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
  }>({
    dragging: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    baseX: freePos.x,
    baseY: freePos.y,
  });

  const beginDrag = (clientX: number, clientY: number, pointerId: number | null) => {
    dragRef.current.dragging = true;
    dragRef.current.pointerId = pointerId;
    dragRef.current.startX = clientX;
    dragRef.current.startY = clientY;
    dragRef.current.baseX = freePos.x;
    dragRef.current.baseY = freePos.y;
    setIsDragging(true);
  };

  // While dragging: disable text selection (prevents “it doesn’t move” feel because you’re selecting text)
  useEffect(() => {
    if (!isDragging) return;
    const prev = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.userSelect = prev;
    };
  }, [isDragging]);

  // ✅ Pointer-based dragging (more reliable than mousemove in overlays/iframes)
  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      if (!dragRef.current.dragging) return;
      if (dragRef.current.pointerId != null && e.pointerId !== dragRef.current.pointerId) return;

      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;

      setFreePos({
        x: clamp(dragRef.current.baseX + dx, 8, viewport.w - panelW - 8),
        y: clamp(dragRef.current.baseY + dy, 8, viewport.h - freeH - 8),
      });
    };

    const end = () => {
      if (!dragRef.current.dragging) return;
      dragRef.current.dragging = false;
      dragRef.current.pointerId = null;
      setIsDragging(false);
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);

    return () => {
      window.removeEventListener("pointermove", onPointerMove as any);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
    };
  }, [viewport.w, viewport.h, panelW, freeH, freePos.x, freePos.y]);

  // Clamp position when switching to free or when viewport/panel size changes
  useEffect(() => {
    if (dock !== "free") return;
    setFreePos((p) => ({
      x: clamp(p.x, 8, viewport.w - panelW - 8),
      y: clamp(p.y, 8, viewport.h - freeH - 8),
    }));
  }, [dock, viewport.w, viewport.h, panelW, freeH]);

  // ---------------------------
  // VOICE INPUT (STT) - FREE
  // ---------------------------
  const recognitionRef = useRef<any>(null);
  const [isListening, setIsListening] = useState(false);
  const [sttError, setSttError] = useState<string | null>(null);

  const [sttLang, setSttLang] = useState<string>(() => {
    return localStorage.getItem("assistant_stt_lang") || "ru-RU";
  });

  useEffect(() => {
    localStorage.setItem("assistant_stt_lang", sttLang);
  }, [sttLang]);

  const sttSupported = useMemo(() => {
    return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  }, []);

  const initRecognitionIfNeeded = () => {
    if (!sttSupported) return null;
    if (recognitionRef.current) return recognitionRef.current;

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();

    rec.continuous = true;
    rec.interimResults = true;

    // default lang (can be changed before start)
    rec.lang = resolveLang(sttLang);

    rec.onstart = () => {
      setSttError(null);
      setIsListening(true);
    };

    rec.onend = () => {
      setIsListening(false);
    };

    rec.onerror = (e: any) => {
      setSttError(e?.error ? String(e.error) : "Speech recognition error");
      setIsListening(false);
    };

    rec.onresult = (event: any) => {
      let interim = "";
      let finalText = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        const transcript = r[0]?.transcript ?? "";
        if (r.isFinal) finalText += transcript;
        else interim += transcript;
      }

      setInput((prev) => {
        return prev + (finalText ? (prev.endsWith(" ") || prev.length === 0 ? "" : " ") + finalText.trim() : "");
      });

      setInterimSTT(interim.trim());
    };

    recognitionRef.current = rec;
    return rec;
  };

  const [interimSTT, setInterimSTT] = useState("");

  const startListening = async () => {
    setSttError(null);
    if (!sttSupported) {
      setSttError("STT not supported in this browser. Use Chrome/Edge.");
      return;
    }
    try {
      const rec = initRecognitionIfNeeded();
      if (!rec) return;
      setInterimSTT("");
      rec.lang = resolveLang(sttLang);
      rec.start();
    } catch (e: any) {
      setSttError(String(e?.message || e));
      setIsListening(false);
    }
  };

  const stopListening = () => {
    try {
      setInterimSTT("");
      recognitionRef.current?.stop?.();
    } catch {
      // ignore
    } finally {
      setIsListening(false);
    }
  };

  // ---------------------------
  // VOICE OUTPUT (TTS) - FREE
  // ---------------------------
  const [isSpeaking, setIsSpeaking] = useState(false);

  const [ttsLang, setTtsLang] = useState<string>(() => {
    return localStorage.getItem("assistant_tts_lang") || "auto";
  });

  useEffect(() => {
    localStorage.setItem("assistant_tts_lang", ttsLang);
  }, [ttsLang]);

  const ttsSupported = useMemo(() => {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }, []);

  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (!ttsSupported) return;
    const load = () => setVoices(window.speechSynthesis.getVoices() || []);
    load();
    window.speechSynthesis.onvoiceschanged = load;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, [ttsSupported]);

  const pickVoice = (lang: string) => {
    if (!voices.length) return undefined;
    const l = lang.toLowerCase();
    return (
      voices.find((v) => v.lang?.toLowerCase() === l) ||
      voices.find((v) => v.lang?.toLowerCase().startsWith(l)) ||
      voices.find((v) => v.lang?.toLowerCase().startsWith(l.split("-")[0])) ||
      undefined
    );
  };

  const speak = (text: string) => {
    if (!ttsSupported) return;

    const cleaned = ttsSanitize(text);
    if (!cleaned) return;

    try {
      window.speechSynthesis.cancel();

      const lang = resolveLang(ttsLang);
      const u = new SpeechSynthesisUtterance(cleaned);
      u.lang = lang;

      const v = pickVoice(lang);
      if (v) u.voice = v;

      u.rate = 1.0;
      u.pitch = 1.0;

      u.onstart = () => setIsSpeaking(true);
      u.onend = () => setIsSpeaking(false);
      u.onerror = () => setIsSpeaking(false);

      window.speechSynthesis.speak(u);
    } catch {
      setIsSpeaking(false);
    }
  };

  const stopSpeak = () => {
    if (!ttsSupported) return;
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
  };

  // Stop voice when unmount
  useEffect(() => {
    return () => {
      stopListening();
      stopSpeak();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup vision clip URLs + stop
  useEffect(() => {
    return () => {
      setClipFrames((prev) => {
        prev.forEach((f) => URL.revokeObjectURL(f.url));
        return [];
      });
      vision.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clipLabel = useMemo(() => {
    if (!clipFrames.length) return "Clip: —";
    return `Clip: ${clipFrames.length} frames`;
  }, [clipFrames.length]);

  const lastCaptureText = vision.lastCaptureText || "—";

  // --- Vision controls ---
  const handleSource = async () => {
    setSendError(null);
    if (vision.isOn || vision.isPaused || vision.isRequesting) {
      vision.stop();
    }
    await vision.start();
  };

  const handleResync = async () => {
    setSendError(null);
    if (!vision.isOn && !vision.isPaused) {
      await handleSource();
      return;
    }
    await vision.reSync();
  };

  const handleClip5s = async () => {
    setSendError(null);
    if (!vision.isOn && !vision.isPaused) {
      await handleSource();
    }
    setIsRecordingClip(true);
    try {
      const frames = await vision.recordClipFrames(5, 1);
      setClipFrames((prev) => {
        prev.forEach((f) => URL.revokeObjectURL(f.url));
        return frames;
      });
    } finally {
      setIsRecordingClip(false);
    }
  };

  const mismatchVisible = useMemo(() => {
    if (!vision.isOn && !vision.isPaused) return false;
    return lastCaptureText === "—";
  }, [vision.isOn, vision.isPaused, lastCaptureText]);

  // --- Sending ---
  const send = async () => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;

    setSendError(null);

    const userMsg: ChatMsg = {
      id: `u-${Date.now()}`,
      role: "user",
      ts: Date.now(),
      text: text || "(attachment)",
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setInterimSTT("");
    setIsSending(true);

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

    try {
      // Pre-send snapshot (если vision включен)
      if (vision.isOn || vision.isPaused) {
        await vision.reSync();
      }

      const lastFrame = vision.getLastFrame();

      const fd = new FormData();
      fd.append("text", text);
      fd.append("explainMode", String(explainMode));
      fd.append("clipCount", String(clipFrames.length));

      if (lastFrame?.blob) {
        fd.append("lastFrame", lastFrame.blob, `last-frame-${Date.now()}.jpg`);
      }

      clipFrames.forEach((f, idx) => {
        fd.append("clipFrames", f.blob, `clip-${idx + 1}-${f.capturedAt}.jpg`);
      });

      attachments.forEach((f) => fd.append("attachments", f, f.name));

      const resp = await fetch(`${BACKEND_URL}/api/assistant/send`, {
        method: "POST",
        body: fd,
        signal: controller.signal,
      });

      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}: ${t || "request failed"}`);
      }

      const json = await resp.json();
      const assistantText = (json?.assistantText as string) || "(empty response)";

      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          ts: Date.now(),
          text: assistantText,
        },
      ]);

      // clear attachments on success
      setAttachments([]);
      if (fileInputRef.current) fileInputRef.current.value = "";

      // Auto speak if enabled
      if (speakOutput) {
        speak(assistantText);
      }
    } catch (e: any) {
      const isAbort = e?.name === "AbortError";
      const msg = isAbort
        ? `Timeout after ${Math.round(CLIENT_TIMEOUT_MS / 1000)}s (backend/model stuck)`
        : String(e?.message || e);

      setSendError(msg);
      setMessages((prev) => [
        ...prev,
        {
          id: `aerr-${Date.now()}`,
          role: "assistant",
          ts: Date.now(),
          text: `❌ Send failed\n\n${msg}`,
        },
      ]);
    } finally {
      window.clearTimeout(timeoutId);
      setIsSending(false);
    }
  };

  // Enter to send
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  // --- Dock/layout metrics ---
  const panelStyle = useMemo(() => {
    if (dock === "hidden") return { display: "none" as const };

    const base: React.CSSProperties = {
      position: "fixed",
      zIndex: 999999,
      borderRadius: 22,
      overflow: "hidden",
      border: "1px solid rgba(255,255,255,0.10)",
      background: "rgba(10, 10, 12, 0.88)",
      backdropFilter: "blur(18px)",
      boxShadow: "0 24px 90px rgba(0,0,0,0.55)",
      color: "white",
      display: "flex",
      flexDirection: "column",
    };

    const top = 12;
    const bottom = 12;

    if (dock === "left") return { ...base, left: 12, top, bottom, width: panelW };
    if (dock === "right") return { ...base, right: 12, top, bottom, width: panelW };

    if (dock === "center") {
      return {
        ...base,
        left: "50%",
        top: 18,
        transform: "translateX(-50%)",
        width: 820,
        height: Math.min(720, viewport.h - 36),
      };
    }

    // ✅ free mode: fixed height so chat cannot inflate panel beyond viewport
    return { ...base, left: freePos.x, top: freePos.y, width: panelW, height: freeH };
  }, [dock, panelW, freeH, freePos.x, freePos.y, viewport.h]);

  // ✅ Site-controls: start from bottom corner depending on dock
  // left dock => bottom-right, right dock => bottom-left, center/free => bottom-right
  const sideControlsStyle = useMemo(() => {
    const base: React.CSSProperties = {
      position: "fixed",
      bottom: 18,
      zIndex: 999999,
      display: "flex",
      flexDirection: "column-reverse", // ✅ first button sits at the bottom
      gap: 10,
    };

    // avoid overlapping the Show pill when dock is hidden
    const bottom = dock === "hidden" ? 78 : 18;

    if (dock === "right") {
      return { ...base, bottom, left: 18 };
    }

    // left / center / free / hidden
    return { ...base, bottom, right: 18 };
  }, [dock]);

  // dropdown styles (visible list)
  const selectStyle: React.CSSProperties = {
    height: 30,
    padding: "0 10px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.06)",
    color: "rgba(255,255,255,0.92)",
    outline: "none",
    cursor: "pointer",
    fontSize: 12,
    lineHeight: "30px",
  };

  // ✅ Fix invisible dropdown items (Chrome): options often render on a light native menu
  const optionStyle: React.CSSProperties = {
    color: "#111",
    background: "#fff",
  };

  // ✅ Make it obvious/usable that free-mode is draggable
  const headerStyleDyn: React.CSSProperties = useMemo(() => {
    return {
      ...headerStyle,
      cursor: dock === "free" ? (isDragging ? "grabbing" : "grab") : "default",
      touchAction: dock === "free" ? "none" : "auto",
    };
  }, [dock, isDragging]);

  const topLineStyleDyn: React.CSSProperties = useMemo(() => {
    return {
      ...topLineStyle,
      cursor: dock === "free" ? (isDragging ? "grabbing" : "grab") : "default",
      touchAction: dock === "free" ? "none" : "auto",
    };
  }, [dock, isDragging]);

  const onDragPointerDown = (e: React.PointerEvent) => {
    if (dock !== "free") return;
    // only left click for mouse
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (isInteractiveTarget(e.target)) return;

    e.preventDefault();
    e.stopPropagation();

    try {
      (e.currentTarget as any)?.setPointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }

    beginDrag(e.clientX, e.clientY, e.pointerId);
  };

  return (
    <div style={pageStyleDyn}>
      {/* ✅ background video (screen share) */}
      {vision.stream ? (
        <video
          style={bgVideoStyle}
          muted
          autoPlay
          playsInline
          ref={(el) => {
            if (!el) return;
            if ((el as any).srcObject !== vision.stream) {
              try {
                (el as any).srcObject = vision.stream;
              } catch {
                // ignore
              }
            }
          }}
        />
      ) : null}

      {/* ✅ optional dim overlay ON TOP of video (and only when stream exists) */}
      {vision.stream ? <div style={bgDimStyle} /> : null}

      {/* Side controls */}
      <div style={sideControlsStyle}>
        <SideBtn label="⚙" title="Settings (stub)" onClick={() => alert("Settings позже")} />
        <SideBtn label="⤢" title={isExpanded ? "Compact" : "Expand"} onClick={() => setIsExpanded((v) => !v)} />
        <SideBtn label="⟵" title="Dock left" onClick={() => setDock("left")} />
        <SideBtn label="◻" title="Dock center" onClick={() => setDock("center")} />
        <SideBtn label="⟶" title="Dock right" onClick={() => setDock("right")} />
        <SideBtn label="✥" title="Free move" onClick={() => setDock("free")} />
        <SideBtn label="🙈" title="Hide" onClick={() => setDock("hidden")} />
      </div>

      {dock === "hidden" ? (
        <div style={showPillWrap}>
          <button style={showPillBtn} onClick={() => setDock("right")}>
            <span style={dotGreen} /> Assist <span style={{ opacity: 0.8 }}>Show</span>
          </button>
        </div>
      ) : null}

      {/* Main panel */}
      <div style={panelStyle}>
        {/* Header (draggable in free-mode) */}
        <div style={headerStyleDyn} onPointerDown={onDragPointerDown}>
          <button style={iconBtn} title="Close" onClick={() => setDock("hidden")} data-no-drag="1">
            ✕
          </button>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontWeight: 700 }}>ChatName</div>
            <button style={modelBtn} title="Model (stub)" data-no-drag="1">
              {modelLabel} ▾
            </button>
            {dock === "free" ? <span style={{ fontSize: 12, opacity: 0.65 }}>· drag</span> : null}
          </div>

          <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
            <button style={reSyncBtn} onClick={() => void handleResync()} title="Re-sync" data-no-drag="1">
              ⟳ Re-Sync
            </button>

            <button style={iconBtn} title="Stop speaking" onClick={stopSpeak} disabled={!isSpeaking} data-no-drag="1">
              ⏹ Voice
            </button>

            <button
              style={iconBtn}
              title="Clear chat"
              onClick={() => setMessages((prev) => prev.filter((m) => m.role === "system"))}
              data-no-drag="1"
            >
              Clear
            </button>

            <button style={iconBtn} title="Hide" onClick={() => setDock("hidden")} data-no-drag="1">
              —
            </button>
          </div>
        </div>

        {/* Top status line (also draggable in free-mode, but ignores clicks on controls/selects) */}
        <div style={topLineStyleDyn} onPointerDown={onDragPointerDown}>
          <div style={{ fontSize: 12, opacity: 0.85 }}>
            AI Vision: <b>{vision.isOn ? "ON" : vision.isPaused ? "PAUSED" : "OFF"}</b> · last capture:{" "}
            <b>{lastCaptureText}</b> · 🔒 <span style={{ opacity: 0.8 }}>private</span>
          </div>

          <div
            style={{
              fontSize: 12,
              opacity: 0.9,
              marginTop: 6,
              display: "flex",
              gap: 10,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <b>Voice:</b>{" "}
            {sttSupported ? (
              <span>{isListening ? "🎙 listening" : "idle"}</span>
            ) : (
              <span style={{ color: "#ff6b6b" }}>STT unsupported (use Chrome/Edge)</span>
            )}
            {ttsSupported ? (
              <span>{isSpeaking ? "🔊 speaking" : ""}</span>
            ) : (
              <span style={{ color: "#ff6b6b" }}>TTS unsupported</span>
            )}

            <span style={{ marginLeft: 6, opacity: 0.85 }}>IN:</span>
            <select
              value={sttLang}
              onChange={(e) => {
                const next = e.target.value;
                setSttLang(next);
                // if currently listening, restart so lang applies
                if (isListening) {
                  stopListening();
                  setTimeout(() => void startListening(), 0);
                }
              }}
              style={selectStyle}
              title="Speech recognition language"
              disabled={!sttSupported}
              data-no-drag="1"
            >
              {LANG_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} style={optionStyle}>
                  {o.label}
                </option>
              ))}
            </select>

            <span style={{ marginLeft: 6, opacity: 0.85 }}>OUT:</span>
            <select
              value={ttsLang}
              onChange={(e) => setTtsLang(e.target.value)}
              style={selectStyle}
              title="Text-to-speech language"
              disabled={!ttsSupported}
              data-no-drag="1"
            >
              {LANG_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} style={optionStyle}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {sttError ? (
            <div style={{ fontSize: 12, color: "#ff6b6b", marginTop: 6 }}>STT error: {sttError}</div>
          ) : null}
        </div>

        {/* Vision controls row */}
        <div style={controlRowStyle}>
          <div style={{ display: "flex", gap: 10 }}>
            <MiniToggle label="On" active={vision.isOn} onClick={() => void handleSource()} />
            <MiniToggle
              label={vision.isPaused ? "Resume" : "Pause"}
              active={vision.isPaused}
              disabled={!vision.isOn && !vision.isPaused}
              onClick={() => (vision.isPaused ? vision.resume() : vision.pause())}
            />
            <MiniToggle label="Off" active={!vision.isOn && !vision.isPaused} onClick={() => vision.stop()} />
          </div>

          <div style={{ display: "flex", gap: 10, marginLeft: "auto" }}>
            <ChipToggle label="Explain step-by-step" active={explainMode} onClick={() => setExplainMode((v) => !v)} />
            <ChipToggle label="Speak output" active={speakOutput} onClick={() => setSpeakOutput((v) => !v)} />
          </div>
        </div>

        {/* Mismatch warning */}
        {mismatchVisible ? (
          <div style={mismatchStyle}>
            <span style={{ fontWeight: 700 }}>!</span>
            <span>Не совпадает</span>
            <button style={mismatchBtn} onClick={() => void handleResync()} data-no-drag="1">
              (Re-sync)
            </button>
          </div>
        ) : null}

        {/* Chat area */}
        <div style={chatAreaStyle}>
          {messages.map((m) => (
            <MessageBubble key={m.id} msg={m} onSpeak={(t) => speak(t)} />
          ))}
          {sendError ? <div style={{ marginTop: 10, color: "#ff6b6b", fontSize: 12 }}>Error: {sendError}</div> : null}
        </div>

        {/* Bottom composer */}
        <div style={composerWrap}>
          {/* Vision mini-strip */}
          <div style={visionStrip}>
            {/* left scrollable group */}
            <div style={visionStripLeft}>
              <div style={previewBox} title={vision.previewUrl ? "Preview (private)" : "No preview"}>
                {vision.previewUrl ? (
                  <img src={vision.previewUrl} alt="preview" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : null}
                <div
                  style={{
                    position: "absolute",
                    top: 6,
                    left: 6,
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    background: vision.isOn ? "#33d17a" : vision.isPaused ? "#f5c211" : "#777",
                    boxShadow: "0 0 0 2px rgba(0,0,0,0.35)",
                  }}
                />
                <div style={previewLabel}>PREVIEW</div>
              </div>

              {/* Clip thumbnails (scrollable) */}
              {clipFrames.length ? (
                <div style={clipThumbsWrap} title="Clip frames (click to open)">
                  {clipFrames.map((f, idx) => (
                    <button
                      key={`${f.capturedAt}-${idx}`}
                      style={clipThumbBtn}
                      onClick={() => window.open(f.url, "_blank")}
                      title={`Frame ${idx + 1}`}
                      data-no-drag="1"
                    >
                      <img src={f.url} alt={`clip-${idx + 1}`} style={clipThumbImg} />
                    </button>
                  ))}
                </div>
              ) : null}

              <button style={stripBtn} onClick={() => void handleSource()} title="Pick tab/window/screen" data-no-drag="1">
                ☐ Source
              </button>

              <button
                style={{ ...stripBtn, background: "rgba(40,160,80,0.18)" }}
                onClick={() => void handleResync()}
                disabled={!vision.isOn && !vision.isPaused}
                title="Fresh snapshot"
                data-no-drag="1"
              >
                ⟳
              </button>

              <button
                style={stripBtn}
                onClick={() => (vision.isPaused ? vision.resume() : vision.pause())}
                disabled={!vision.isOn && !vision.isPaused}
                title={vision.isPaused ? "Resume capture" : "Pause capture"}
                data-no-drag="1"
              >
                {vision.isPaused ? "▶" : "⏸"}
              </button>

              <button
                style={{ ...stripBtn, background: "rgba(255,0,0,0.16)" }}
                onClick={() => vision.stop()}
                disabled={!vision.isOn && !vision.isPaused && !vision.isRequesting}
                title="Stop capture"
                data-no-drag="1"
              >
                ⏹
              </button>

              <button
                style={{ ...stripBtn, background: "rgba(80,160,255,0.18)" }}
                onClick={() => void handleClip5s()}
                disabled={isRecordingClip}
                title="Record 5 seconds as frames"
                data-no-drag="1"
              >
                {isRecordingClip ? "⏳" : "🎞"}
              </button>
            </div>

            {/* right fixed info */}
            <div style={visionStripRight}>
              <div>
                <b>Seeing:</b> {vision.sourceInfo?.label ? vision.sourceInfo.label : vision.isRequesting ? "Selecting…" : "—"}
              </div>
              <div>
                <b>{clipLabel}</b>
              </div>
            </div>
          </div>

          {/* Attachments row */}
          <div style={attachmentsRow}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {attachments.length ? (
                attachments.map((f, idx) => (
                  <div key={idx} style={fileChip} title={f.name}>
                    <span style={{ opacity: 0.9 }}>{truncate(f.name, 28)}</span>
                    <button
                      style={fileChipX}
                      onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== idx))}
                      title="Remove"
                      data-no-drag="1"
                    >
                      ✕
                    </button>
                  </div>
                ))
              ) : (
                <div style={{ opacity: 0.65, fontSize: 12 }}>No attachments yet.</div>
              )}
            </div>

            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button style={attachBtn} onClick={() => fileInputRef.current?.click()} title="Attach file(s)" data-no-drag="1">
                +
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  if (files.length) setAttachments((prev) => [...prev, ...files]);
                }}
              />
            </div>
          </div>

          {/* Input row */}
          <div style={inputRow}>
            <textarea
              value={input + (interimSTT ? (input.endsWith(" ") || input.length === 0 ? "" : " ") + interimSTT : "")}
              onChange={(e) => {
                setInterimSTT("");
                setInput(e.target.value);
              }}
              onKeyDown={onKeyDown}
              placeholder="Type here or use voice… (input is always text)"
              style={textareaStyle}
            />

            {/* Voice button */}
            <button
              style={{
                ...voiceBtn,
                opacity: sttSupported ? 1 : 0.4,
                background: isListening ? "rgba(255,90,90,0.22)" : "rgba(255,255,255,0.06)",
              }}
              onClick={() => {
                if (!sttSupported) return;
                if (isListening) stopListening();
                else void startListening();
              }}
              title={sttSupported ? (isListening ? "Stop listening" : "Start voice input") : "Use Chrome/Edge for STT"}
              disabled={!sttSupported}
              data-no-drag="1"
            >
              {isListening ? "⏹" : "🎙"}
            </button>

            <button style={sendBtn} onClick={() => void send()} disabled={isSending} data-no-drag="1">
              {isSending ? "…" : "➜"}
            </button>
          </div>

          <div style={bottomPillWrap}>
            <button style={bottomPillBtn} onClick={() => setDock("hidden")} data-no-drag="1">
              <span style={dotGreen} /> Assist <span style={{ opacity: 0.8 }}>Hide</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- UI bits ---------------- */

function MessageBubble({ msg, onSpeak }: { msg: ChatMsg; onSpeak: (t: string) => void }) {
  if (msg.role === "system") {
    return (
      <div style={sysBubble}>
        <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>System</div>
        <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.35 }}>{msg.text}</div>
      </div>
    );
  }

  if (msg.role === "user") {
    return (
      <div style={userBubble}>
        <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>You</div>
        <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.35 }}>{msg.text}</div>
      </div>
    );
  }

  return (
    <div style={assistantBubble}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <div style={{ fontSize: 12, opacity: 0.85 }}>Assistant</div>
        <button style={{ ...miniSpeakBtn }} onClick={() => onSpeak(msg.text)} title="Speak this answer" data-no-drag="1">
          🔊
        </button>
      </div>
      <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{msg.text}</div>
    </div>
  );
}

function SideBtn({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <button style={sideBtn} onClick={onClick} title={title}>
      {label}
    </button>
  );
}

function MiniToggle({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      style={{
        ...miniToggle,
        opacity: disabled ? 0.4 : 1,
        background: active ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.06)",
      }}
      onClick={onClick}
      disabled={disabled}
    >
      {label}
    </button>
  );
}

function ChipToggle({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      style={{
        ...chipToggle,
        background: active ? "rgba(170,140,230,0.22)" : "rgba(255,255,255,0.06)",
        borderColor: active ? "rgba(180,150,240,0.35)" : "rgba(255,255,255,0.12)",
      }}
      onClick={onClick}
    >
      <span
        style={{
          width: 12,
          height: 12,
          borderRadius: 4,
          background: active ? "rgba(200,170,255,0.85)" : "rgba(255,255,255,0.18)",
          display: "inline-block",
        }}
      />
      <span>{label}</span>
    </button>
  );
}

/* ---------------- styles ---------------- */

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background:
    "radial-gradient(1200px 700px at 70% 15%, rgba(140,120,220,0.18), transparent 60%)," +
    "radial-gradient(1000px 600px at 20% 85%, rgba(80,160,255,0.10), transparent 55%)," +
    "linear-gradient(180deg, #0b0b0e 0%, #09090c 100%)",
  color: "white",
};

// ✅ background video layer (screen share)
const bgVideoStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  width: "100%",
  height: "100%",
  objectFit: "cover",
  zIndex: 0,
  pointerEvents: "none",
};

// ✅ dim overlay above the video (so assistant stays readable)
const bgDimStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1,
  pointerEvents: "none",
  background: "rgba(0,0,0,0.35)",
};

const sideBtn: React.CSSProperties = {
  width: 46,
  height: 46,
  borderRadius: 14,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(0,0,0,0.35)",
  backdropFilter: "blur(12px)",
  color: "white",
  cursor: "pointer",
  fontSize: 18,
  boxShadow: "0 18px 60px rgba(0,0,0,0.35)",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "12px 14px",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(0,0,0,0.20)",
};

const topLineStyle: React.CSSProperties = {
  padding: "8px 14px",
  borderBottom: "1px solid rgba(255,255,255,0.06)",
};

const iconBtn: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.10)",
  background: "rgba(255,255,255,0.05)",
  color: "white",
  padding: "8px 10px",
  borderRadius: 12,
  cursor: "pointer",
  fontSize: 13,
};

const miniSpeakBtn: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.06)",
  color: "white",
  padding: "4px 8px",
  borderRadius: 10,
  cursor: "pointer",
  fontSize: 12,
};

const modelBtn: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.06)",
  color: "white",
  padding: "6px 10px",
  borderRadius: 999,
  cursor: "pointer",
  fontSize: 12,
};

const reSyncBtn: React.CSSProperties = {
  border: "1px solid rgba(80,200,120,0.35)",
  background: "rgba(40,160,80,0.20)",
  color: "white",
  padding: "8px 12px",
  borderRadius: 999,
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 700,
};

const controlRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
  padding: "10px 14px",
};

const miniToggle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.10)",
  color: "white",
  cursor: "pointer",
  fontSize: 13,
};

const chipToggle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 12px",
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.12)",
  color: "white",
  cursor: "pointer",
  fontSize: 13,
};

const mismatchStyle: React.CSSProperties = {
  margin: "0 14px",
  padding: "10px 12px",
  borderRadius: 14,
  border: "1px solid rgba(255,80,80,0.25)",
  background: "rgba(255, 0, 0, 0.10)",
  display: "flex",
  gap: 10,
  alignItems: "center",
};

const mismatchBtn: React.CSSProperties = {
  marginLeft: 6,
  border: "none",
  background: "transparent",
  color: "rgba(255,255,255,0.9)",
  cursor: "pointer",
  textDecoration: "underline",
};

// ✅ ключевой фикс: minHeight:0, иначе flex:1 может "не сжиматься" и выдавит composer
const chatAreaStyle: React.CSSProperties = {
  padding: "12px 14px",
  overflow: "auto",
  flex: 1,
  minHeight: 0,
};

const composerWrap: React.CSSProperties = {
  padding: "12px 14px",
  borderTop: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(0,0,0,0.18)",
};

const visionStrip: React.CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  gap: 12,
  padding: 10,
  borderRadius: 16,
  border: "1px solid rgba(255,255,255,0.10)",
  background: "rgba(255,255,255,0.04)",
};

const visionStripLeft: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  overflowX: "auto",
  overflowY: "hidden",
  flex: 1,
  minWidth: 0,
  paddingBottom: 2,
};

const visionStripRight: React.CSSProperties = {
  flex: "0 0 auto",
  fontSize: 12,
  opacity: 0.8,
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  gap: 4,
  maxWidth: 220,
};

const previewBox: React.CSSProperties = {
  width: 78,
  height: 52,
  borderRadius: 12,
  overflow: "hidden",
  border: "1px solid rgba(255,255,255,0.14)",
  background: "rgba(255,255,255,0.04)",
  position: "relative",
  flex: "0 0 auto",
};

const previewLabel: React.CSSProperties = {
  position: "absolute",
  left: 6,
  bottom: 6,
  fontSize: 9,
  opacity: 0.85,
  background: "rgba(0,0,0,0.35)",
  padding: "2px 6px",
  borderRadius: 999,
  border: "1px solid rgba(255,255,255,0.10)",
};

const clipThumbsWrap: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flex: "0 0 auto",
};

const clipThumbBtn: React.CSSProperties = {
  width: 44,
  height: 30,
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.14)",
  overflow: "hidden",
  background: "rgba(0,0,0,0.35)",
  padding: 0,
  cursor: "pointer",
  flex: "0 0 auto",
};

const clipThumbImg: React.CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  display: "block",
};

const stripBtn: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.06)",
  color: "white",
  cursor: "pointer",
  fontSize: 13,
  flex: "0 0 auto",
};

const attachmentsRow: React.CSSProperties = {
  marginTop: 10,
  display: "flex",
  alignItems: "center",
  gap: 10,
};

const attachBtn: React.CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.06)",
  color: "white",
  cursor: "pointer",
  fontSize: 18,
};

const fileChip: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 10px",
  borderRadius: 999,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.06)",
  fontSize: 12,
};

const fileChipX: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "rgba(255,255,255,0.9)",
  cursor: "pointer",
  fontSize: 12,
};

const inputRow: React.CSSProperties = {
  marginTop: 10,
  display: "flex",
  gap: 10,
  alignItems: "stretch",
};

const textareaStyle: React.CSSProperties = {
  width: "100%",
  minHeight: 64,
  maxHeight: 160,
  resize: "vertical",
  borderRadius: 16,
  border: "1px solid rgba(255,255,255,0.10)",
  background: "rgba(0,0,0,0.25)",
  color: "white",
  padding: "12px 14px",
  outline: "none",
  fontSize: 14,
  lineHeight: 1.35,
};

const voiceBtn: React.CSSProperties = {
  width: 54,
  borderRadius: 18,
  border: "1px solid rgba(255,255,255,0.12)",
  color: "white",
  cursor: "pointer",
  fontSize: 18,
  fontWeight: 800,
};

const sendBtn: React.CSSProperties = {
  width: 54,
  borderRadius: 18,
  border: "1px solid rgba(80,160,255,0.35)",
  background: "rgba(80,160,255,0.25)",
  color: "white",
  cursor: "pointer",
  fontSize: 18,
  fontWeight: 800,
};

const sysBubble: React.CSSProperties = {
  padding: 12,
  borderRadius: 14,
  border: "1px solid rgba(255,220,120,0.18)",
  background: "rgba(120,90,30,0.18)",
  marginBottom: 10,
};

const userBubble: React.CSSProperties = {
  padding: 12,
  borderRadius: 14,
  border: "1px solid rgba(255,255,255,0.10)",
  background: "rgba(255,255,255,0.04)",
  marginBottom: 10,
};

const assistantBubble: React.CSSProperties = {
  padding: 12,
  borderRadius: 14,
  border: "1px solid rgba(80,160,255,0.18)",
  background: "rgba(40,90,140,0.18)",
  marginBottom: 10,
};

const showPillWrap: React.CSSProperties = {
  position: "fixed",
  right: 18,
  bottom: 18,
  zIndex: 999999,
};

const bottomPillWrap: React.CSSProperties = {
  marginTop: 10,
  display: "flex",
  justifyContent: "flex-end",
};

const showPillBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 14px",
  borderRadius: 999,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(0,0,0,0.35)",
  backdropFilter: "blur(14px)",
  color: "white",
  cursor: "pointer",
  boxShadow: "0 20px 70px rgba(0,0,0,0.45)",
};

const bottomPillBtn: React.CSSProperties = showPillBtn;

const dotGreen: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: 999,
  background: "#33d17a",
  boxShadow: "0 0 0 2px rgba(0,0,0,0.35)",
};

/* ---------------- helpers ---------------- */

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function truncate(s: string, n: number) {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + "…";
}

/**
 * TTS sanitize: убираем markdown/символы, чтобы не читало "*", "#", "```" и т.п.
 * (сильно лучше ощущается при Speak output)
 */
function ttsSanitize(input: string) {
  if (!input) return "";

  let s = String(input);

  // remove code blocks ```...```
  s = s.replace(/```[\s\S]*?```/g, " ");

  // remove inline code `...`
  s = s.replace(/`[^`]*`/g, " ");

  // markdown links: [text](url) -> text
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");

  // images: ![alt](url) -> alt
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1");

  // headings
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");

  // blockquotes
  s = s.replace(/^\s{0,3}>\s?/gm, "");

  // list markers
  s = s.replace(/^\s*[-*+]\s+/gm, "");
  s = s.replace(/^\s*\d+[\.\)]\s+/gm, "");

  // remove remaining markdown tokens/symbol noise
  s = s.replace(/[*_~#^=|<>]/g, " ");

  // collapse excessive punctuation like "----"
  s = s.replace(/[-]{3,}/g, " ");
  s = s.replace(/[•·]/g, " ");

  // remove bare urls
  s = s.replace(/\bhttps?:\/\/\S+\b/g, " ");

  // normalize whitespace
  s = s.replace(/\s+/g, " ").trim();

  return s;
}
