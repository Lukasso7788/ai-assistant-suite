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

export default function App() {
  // --- Vision hook (твоя существующая штука) ---
  const vision = useAIVision({
    autoCaptureEveryMs: 0,
    jpegQuality: 0.75,
    maxWidth: 900,
  });

  // --- UI state ---
  const [dock, setDock] = useState<DockMode>("right");
  const [isExpanded, setIsExpanded] = useState(true); // expanded = как на скрине, collapsed = маленькая
  const [explainMode, setExplainMode] = useState(false);
  const [speakOutput, setSpeakOutput] = useState(false); // пока stub, позже TTS
  const [modelLabel] = useState("Model"); // потом подключим реальный выбор моделей

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
          "Assistant ready. Toggle AI Vision (private) to let the assistant see your screen without sharing to others.",
      },
    ];
  });

  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Attachments (простые файлы, без кнопок +code/+logs/+text пока)
  const [attachments, setAttachments] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // --- free-move drag ---
  const [freePos, setFreePos] = useState<{ x: number; y: number }>({
    x: Math.max(16, window.innerWidth - 460),
    y: 16,
  });

  const dragRef = useRef<{
    dragging: boolean;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
  }>({ dragging: false, startX: 0, startY: 0, baseX: freePos.x, baseY: freePos.y });

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current.dragging) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setFreePos({
        x: clamp(dragRef.current.baseX + dx, 8, window.innerWidth - 360),
        y: clamp(dragRef.current.baseY + dy, 8, window.innerHeight - 120),
      });
    };

    const onUp = () => {
      dragRef.current.dragging = false;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  // Cleanup vision clip object URLs + stop
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
    // Пока это просто “индикатор”: если vision ON и долго не было capture — считаем “не совпадает”
    if (!vision.isOn && !vision.isPaused) return false;
    // очень грубо: если lastCaptureText "—" => не было захвата
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
    setIsSending(true);

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

      // clip frames (ограничиваем как и раньше)
      clipFrames.forEach((f, idx) => {
        fd.append("clipFrames", f.blob, `clip-${idx + 1}-${f.capturedAt}.jpg`);
      });

      // file attachments
      attachments.forEach((f) => fd.append("attachments", f, f.name));

      const resp = await fetch(`${BACKEND_URL}/api/assistant/send`, {
        method: "POST",
        body: fd,
      });

      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}: ${t || "request failed"}`);
      }

      const json = await resp.json();

      const assistantText =
        (json?.assistantText as string) || "(empty response)";

      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          ts: Date.now(),
          text: assistantText,
        },
      ]);

      // после удачной отправки — очищаем вложения
      setAttachments([]);
      if (fileInputRef.current) fileInputRef.current.value = "";

      // TTS пока не делаем, но оставляем флаг
      if (speakOutput) {
        // TODO: подключим позже
      }
    } catch (e: any) {
      const msg = String(e?.message || e);
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

  // --- Dock/layout metrics (под скрин) ---
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
    };

    const w = isExpanded ? 470 : 320;
    const top = 12;
    const bottom = 12;

    if (dock === "left") {
      return { ...base, left: 12, top, bottom, width: w };
    }
    if (dock === "right") {
      return { ...base, right: 12, top, bottom, width: w };
    }
    if (dock === "center") {
      // центр — как “большая” панель по центру (скрин 1)
      return {
        ...base,
        left: "50%",
        top: 18,
        transform: "translateX(-50%)",
        width: 820,
        height: Math.min(720, window.innerHeight - 36),
      };
    }
    // free
    return {
      ...base,
      left: freePos.x,
      top: freePos.y,
      width: w,
      height: dock === "free" ? undefined : undefined,
    };
  }, [dock, isExpanded, freePos.x, freePos.y]);

  const sideControlsStyle: React.CSSProperties = {
    position: "fixed",
    right: 18,
    top: "50%",
    transform: "translateY(-50%)",
    zIndex: 999999,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  };

  return (
    <div style={pageStyle}>
      {/* Side controls (как на скринах справа) */}
      <div style={sideControlsStyle}>
        <SideBtn label="⚙" title="Settings (stub)" onClick={() => alert("Settings позже")} />
        <SideBtn
          label="⤢"
          title={isExpanded ? "Compact" : "Expand"}
          onClick={() => setIsExpanded((v) => !v)}
        />
        <SideBtn label="⟵" title="Dock left" onClick={() => setDock("left")} />
        <SideBtn label="◻" title="Dock center" onClick={() => setDock("center")} />
        <SideBtn label="⟶" title="Dock right" onClick={() => setDock("right")} />
        <SideBtn label="✥" title="Free move" onClick={() => setDock("free")} />
        <SideBtn label="🙈" title="Hide" onClick={() => setDock("hidden")} />
      </div>

      {/* маленькая кнопка Show, если hidden */}
      {dock === "hidden" ? (
        <div style={showPillWrap}>
          <button style={showPillBtn} onClick={() => setDock("right")}>
            <span style={dotGreen} /> Assist <span style={{ opacity: 0.8 }}>Show</span>
          </button>
        </div>
      ) : null}

      {/* Main panel */}
      <div style={panelStyle}>
        {/* Header (draggable в free-mode) */}
        <div
          style={headerStyle}
          onMouseDown={(e) => {
            if (dock !== "free") return;
            dragRef.current.dragging = true;
            dragRef.current.startX = e.clientX;
            dragRef.current.startY = e.clientY;
            dragRef.current.baseX = freePos.x;
            dragRef.current.baseY = freePos.y;
          }}
        >
          <button style={iconBtn} title="Close" onClick={() => setDock("hidden")}>
            ✕
          </button>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontWeight: 700 }}>ChatName</div>

            <button style={modelBtn} title="Model (stub)">
              {modelLabel} ▾
            </button>
          </div>

          <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
            <button style={reSyncBtn} onClick={() => void handleResync()} title="Re-sync">
              ⟳ Re-Sync
            </button>

            <button style={iconBtn} title="Clear chat" onClick={() => setMessages((prev) => prev.filter((m) => m.role === "system"))}>
              Clear
            </button>

            <button style={iconBtn} title="Hide" onClick={() => setDock("hidden")}>
              —
            </button>
          </div>
        </div>

        {/* Top status line */}
        <div style={topLineStyle}>
          <div style={{ fontSize: 12, opacity: 0.85 }}>
            AI Vision:{" "}
            <b>
              {vision.isOn ? "ON" : vision.isPaused ? "PAUSED" : "OFF"}
            </b>{" "}
            · last capture: <b>{lastCaptureText}</b> · 🔒 <span style={{ opacity: 0.8 }}>private</span>
          </div>
        </div>

        {/* Vision controls row */}
        <div style={controlRowStyle}>
          <div style={{ display: "flex", gap: 10 }}>
            <MiniToggle
              label="On"
              active={vision.isOn}
              onClick={() => void handleSource()}
            />
            <MiniToggle
              label={vision.isPaused ? "Resume" : "Pause"}
              active={vision.isPaused}
              disabled={!vision.isOn && !vision.isPaused}
              onClick={() => (vision.isPaused ? vision.resume() : vision.pause())}
            />
            <MiniToggle
              label="Off"
              active={!vision.isOn && !vision.isPaused}
              onClick={() => vision.stop()}
            />
          </div>

          <div style={{ display: "flex", gap: 10, marginLeft: "auto" }}>
            <ChipToggle
              label="Explain step-by-step"
              active={explainMode}
              onClick={() => setExplainMode((v) => !v)}
            />
            <ChipToggle
              label="Speak output"
              active={speakOutput}
              onClick={() => setSpeakOutput((v) => !v)}
            />
          </div>
        </div>

        {/* Mismatch / resync warning */}
        {mismatchVisible ? (
          <div style={mismatchStyle}>
            <span style={{ fontWeight: 700 }}>!</span>
            <span>Не совпадает</span>
            <button style={mismatchBtn} onClick={() => void handleResync()}>
              (Re-sync)
            </button>
          </div>
        ) : null}

        {/* Push-to-talk stub */}
        <div style={pttRowStyle}>
          <button style={pttBtn} disabled title="Voice позже">
            🎙 Push-to-talk (stub)
          </button>
        </div>

        {/* Chat area */}
        <div style={chatAreaStyle}>
          {messages.map((m) => (
            <MessageBubble key={m.id} msg={m} />
          ))}
          {sendError ? (
            <div style={{ marginTop: 10, color: "#ff6b6b", fontSize: 12 }}>
              Error: {sendError}
            </div>
          ) : null}
        </div>

        {/* Bottom composer area (как на скрине — большая зона ввода) */}
        <div style={composerWrap}>
          {/* Vision mini-strip inside composer (как твоя нижняя панелька: preview + source/resync/pause/stop/clip) */}
          <div style={visionStrip}>
            <div style={previewBox} title={vision.previewUrl ? "Preview (private)" : "No preview"}>
              {vision.previewUrl ? (
                <img
                  src={vision.previewUrl}
                  alt="preview"
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
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

            <button style={stripBtn} onClick={() => void handleSource()} title="Pick tab/window/screen">
              ☐ Source
            </button>
            <button
              style={{ ...stripBtn, background: "rgba(40,160,80,0.18)" }}
              onClick={() => void handleResync()}
              disabled={!vision.isOn && !vision.isPaused}
              title="Fresh snapshot"
            >
              ⟳ Re-sync
            </button>
            <button
              style={stripBtn}
              onClick={() => (vision.isPaused ? vision.resume() : vision.pause())}
              disabled={!vision.isOn && !vision.isPaused}
              title="Pause / Resume capture"
            >
              {vision.isPaused ? "▶ Resume" : "⏸ Pause"}
            </button>
            <button
              style={{ ...stripBtn, background: "rgba(255,0,0,0.16)" }}
              onClick={() => vision.stop()}
              disabled={!vision.isOn && !vision.isPaused && !vision.isRequesting}
              title="Stop capture"
            >
              ⏹ Stop
            </button>

            <button
              style={{ ...stripBtn, background: "rgba(80,160,255,0.18)" }}
              onClick={() => void handleClip5s()}
              disabled={isRecordingClip}
              title="Record 5 seconds as frames"
            >
              {isRecordingClip ? "⏳ Clip…" : "🎞 Clip 5s"}
            </button>

            <div style={{ marginLeft: "auto", fontSize: 12, opacity: 0.8 }}>
              <div>
                <b>Seeing:</b>{" "}
                {vision.sourceInfo?.label
                  ? vision.sourceInfo.label
                  : vision.isRequesting
                    ? "Selecting…"
                    : "—"}
              </div>
              <div>
                <b>{clipLabel}</b>
              </div>
            </div>
          </div>

          {/* Attachments row (превью файлов) */}
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
              <button
                style={attachBtn}
                onClick={() => fileInputRef.current?.click()}
                title="Attach file(s)"
              >
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
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Type here or use voice… (input is always text)"
              style={textareaStyle}
            />

            <button style={sendBtn} onClick={() => void send()} disabled={isSending}>
              {isSending ? "…" : "➜"}
            </button>
          </div>

          <div style={bottomPillWrap}>
            <button style={bottomPillBtn} onClick={() => setDock("hidden")}>
              <span style={dotGreen} /> Assist <span style={{ opacity: 0.8 }}>Hide</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- UI bits ---------------- */

function MessageBubble({ msg }: { msg: ChatMsg }) {
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
      <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>Assistant</div>
      <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{msg.text}</div>
    </div>
  );
}

function SideBtn({
  label,
  title,
  onClick,
}: {
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      style={sideBtn}
      onClick={onClick}
      title={title}
    >
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

function ChipToggle({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
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

const pttRowStyle: React.CSSProperties = {
  padding: "10px 14px",
};

const pttBtn: React.CSSProperties = {
  width: "100%",
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.10)",
  background: "rgba(255,255,255,0.05)",
  color: "rgba(255,255,255,0.85)",
  padding: "10px 12px",
  cursor: "not-allowed",
};

const chatAreaStyle: React.CSSProperties = {
  padding: "12px 14px",
  overflow: "auto",
  flex: 1,
  height: "calc(100% - 340px)", // чтобы стабильно оставалось место под composer
};

const composerWrap: React.CSSProperties = {
  padding: "12px 14px",
  borderTop: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(0,0,0,0.18)",
};

const visionStrip: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: 10,
  borderRadius: 16,
  border: "1px solid rgba(255,255,255,0.10)",
  background: "rgba(255,255,255,0.04)",
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

const stripBtn: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.06)",
  color: "white",
  cursor: "pointer",
  fontSize: 13,
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
