import React, { useMemo, useReducer } from "react";
import {
    assistantReducer,
    defaultState,
    uid,
    type AssistantState,
    type AttachmentKind,
} from "@assistant/core";

type ShellMode = "mysession" | "standalone";

export type AssistantRootProps = {
    mode: ShellMode;

    /** Called when user toggles AI Vision (private). You implement capture pipeline outside UI. */
    onVisionChange?: (next: "off" | "on" | "paused") => void;

    /** Called when user clicks Send. You implement LLM request outside UI. */
    onSend?: (payload: {
        inputText: string;
        explainMode: boolean;
        attachments: { kind: AttachmentKind; title: string; content: string }[];
    }) => Promise<{ assistantText: string } | void>;

    /** Called when user clicks Re-sync. You implement “grab latest screen context and regenerate” outside UI. */
    onResync?: () => Promise<{ assistantText: string } | void>;

    /** Optional: if you want to expose “Speak” buttons to your TTS. */
    onSpeak?: (text: string) => void;
    onPauseSpeak?: () => void;
};

function fmtTime(ts?: number) {
    if (!ts) return "—";
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function AssistantRoot(props: AssistantRootProps) {
    const [state, dispatch] = useReducer(assistantReducer, defaultState);

    const title = useMemo(() => {
        return props.mode === "mysession" ? "MySession Assist" : "Assist";
    }, [props.mode]);

    const visionLabel =
        state.settings.vision === "off"
            ? "OFF"
            : state.settings.vision === "paused"
                ? "PAUSED"
                : "ON";

    async function handleSend() {
        const text = state.inputText.trim();
        if (!text && state.attachments.length === 0) return;

        dispatch({
            type: "add_message",
            msg: { id: uid("u"), role: "user", content: text || "(attachments)", createdAt: Date.now() },
        });
        dispatch({ type: "set_input", value: "" });

        if (props.onSend) {
            const res = await props.onSend({
                inputText: text,
                explainMode: state.settings.explainMode,
                attachments: state.attachments.map((a) => ({
                    kind: a.kind,
                    title: a.title,
                    content: a.content,
                })),
            });
            if (res?.assistantText) {
                dispatch({
                    type: "add_message",
                    msg: { id: uid("a"), role: "assistant", content: res.assistantText, createdAt: Date.now() },
                });
            }
        } else {
            // fallback stub
            dispatch({
                type: "add_message",
                msg: {
                    id: uid("a"),
                    role: "assistant",
                    content:
                        "⚠️ onSend not wired yet. Hook this to your backend/LLM.\n\n(But UI is working.)",
                    createdAt: Date.now(),
                },
            });
        }
    }

    async function handleResync() {
        dispatch({
            type: "add_message",
            msg: { id: uid("u"), role: "user", content: "❗ Не совпадает. Re-sync.", createdAt: Date.now() },
        });

        const res = (await props.onResync?.()) ?? undefined;
        if (res?.assistantText) {
            dispatch({
                type: "add_message",
                msg: { id: uid("a"), role: "assistant", content: res.assistantText, createdAt: Date.now() },
            });
            return;
        }

        // fallback stub
        dispatch({
            type: "add_message",
            msg: {
                id: uid("a"),
                role: "assistant",
                content:
                    "Re-sync stub: capture current screen context and regenerate.\n\nWire onResync() to do:\n1) grab last frame\n2) OCR/summary\n3) call LLM\n4) return corrected steps",
                createdAt: Date.now(),
            },
        });
    }

    function setVision(next: "off" | "on" | "paused") {
        dispatch({ type: "set_setting", key: "vision", value: next });
        props.onVisionChange?.(next);
    }

    return (
        <>
            <AssistChip
                open={state.isOpen}
                title={title}
                vision={state.settings.vision}
                lastCaptureAt={state.lastVisionCaptureAt}
                onToggleOpen={() => dispatch({ type: "toggle_open" })}
            />

            {state.isOpen && (
                <AssistPanel
                    title={title}
                    state={state}
                    visionLabel={visionLabel}
                    lastCaptureStr={fmtTime(state.lastVisionCaptureAt)}
                    onClose={() => dispatch({ type: "set_open", value: false })}
                    onToggleExplain={() =>
                        dispatch({ type: "set_setting", key: "explainMode", value: !state.settings.explainMode })
                    }
                    onToggleSpeak={() =>
                        dispatch({ type: "set_setting", key: "speakOutput", value: !state.settings.speakOutput })
                    }
                    onVisionOff={() => setVision("off")}
                    onVisionOn={() => setVision("on")}
                    onVisionPause={() => setVision("paused")}
                    onAddAttachment={(kind, title, content) =>
                        dispatch({
                            type: "add_attachment",
                            att: { id: uid("att"), kind, title, content, createdAt: Date.now() },
                        })
                    }
                    onRemoveAttachment={(id) => dispatch({ type: "remove_attachment", id })}
                    onInputChange={(v) => dispatch({ type: "set_input", value: v })}
                    onSend={handleSend}
                    onResync={handleResync}
                    onSpeak={(text) => props.onSpeak?.(text)}
                    onPauseSpeak={() => props.onPauseSpeak?.()}
                    onClearChat={() => dispatch({ type: "clear_chat" })}
                />
            )}
        </>
    );
}

// ---------- UI primitives (no external UI libs) ----------

function AssistChip(props: {
    open: boolean;
    title: string;
    vision: "off" | "on" | "paused";
    lastCaptureAt?: number;
    onToggleOpen: () => void;
}) {
    const dot =
        props.vision === "on" ? "🟢" : props.vision === "paused" ? "🟠" : "⚫";
    return (
        <div style={styles.chipWrap}>
            <button style={styles.chip} onClick={props.onToggleOpen} title="Toggle assistant">
                <span style={{ marginRight: 8 }}>{dot}</span>
                <strong style={{ marginRight: 8 }}>{props.title}</strong>
                <span style={{ opacity: 0.75 }}>{props.open ? "Hide" : "Show"}</span>
            </button>
        </div>
    );
}

function AssistPanel(props: {
    title: string;
    state: AssistantState;
    visionLabel: string;
    lastCaptureStr: string;
    onClose: () => void;

    onToggleExplain: () => void;
    onToggleSpeak: () => void;

    onVisionOff: () => void;
    onVisionOn: () => void;
    onVisionPause: () => void;

    onAddAttachment: (kind: AttachmentKind, title: string, content: string) => void;
    onRemoveAttachment: (id: string) => void;

    onInputChange: (v: string) => void;
    onSend: () => void;
    onResync: () => void;

    onSpeak?: (text: string) => void;
    onPauseSpeak?: () => void;

    onClearChat: () => void;
}) {
    return (
        <div style={styles.panel}>
            <div style={styles.header}>
                <div>
                    <div style={styles.hTitle}>{props.title}</div>
                    <div style={styles.hSub}>
                        AI Vision: <b>{props.visionLabel}</b> · last capture: {props.lastCaptureStr} ·{" "}
                        <span style={{ opacity: 0.8 }}>🔒 private</span>
                    </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                    <button style={styles.btnGhost} onClick={props.onClearChat}>Clear</button>
                    <button style={styles.btnGhost} onClick={props.onClose}>✕</button>
                </div>
            </div>

            <div style={styles.controls}>
                <div style={styles.controlRow}>
                    <div style={styles.group}>
                        <span style={styles.label}>AI Vision</span>
                        <button style={styles.btn} onClick={props.onVisionOn}>On</button>
                        <button style={styles.btn} onClick={props.onVisionPause}>Pause</button>
                        <button style={styles.btn} onClick={props.onVisionOff}>Off</button>
                    </div>

                    <div style={styles.group}>
                        <span style={styles.label}>Mode</span>
                        <Toggle
                            label="Explain step-by-step"
                            value={props.state.settings.explainMode}
                            onToggle={props.onToggleExplain}
                        />
                        <Toggle
                            label="Speak output"
                            value={props.state.settings.speakOutput}
                            onToggle={props.onToggleSpeak}
                        />
                    </div>
                </div>

                <div style={styles.controlRow}>
                    <button style={styles.btnDanger} onClick={props.onResync}>
                        ❗ Не совпадает (Re-sync)
                    </button>

                    <button
                        style={styles.btnGhost}
                        onClick={() => {
                            // “push-to-talk” placeholder
                            const t = "Voice input stub: integrate Whisper STT and append transcript here.";
                            props.onInputChange((props.state.inputText ? props.state.inputText + "\n" : "") + t);
                        }}
                    >
                        🎙 Push-to-talk (stub)
                    </button>
                </div>
            </div>

            <div style={styles.body}>
                <div style={styles.messages}>
                    {props.state.messages.map((m) => (
                        <div key={m.id} style={m.role === "assistant" ? styles.msgA : m.role === "user" ? styles.msgU : styles.msgS}>
                            <div style={styles.msgRole}>
                                {m.role === "assistant" ? "Assistant" : m.role === "user" ? "You" : "System"}
                            </div>
                            <pre style={styles.msgText}>{m.content}</pre>

                            {m.role === "assistant" && (
                                <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                                    <button style={styles.btnGhost} onClick={() => props.onSpeak?.(m.content)}>
                                        🔊 Speak
                                    </button>
                                    <button style={styles.btnGhost} onClick={() => props.onPauseSpeak?.()}>
                                        ⏸ Pause
                                    </button>
                                </div>
                            )}
                        </div>
                    ))}
                </div>

                <div style={styles.attachWrap}>
                    <div style={styles.attachHeader}>
                        <b>Attachments</b>
                        <div style={{ display: "flex", gap: 8 }}>
                            <AttachButton kind="code" onAdd={props.onAddAttachment} />
                            <AttachButton kind="logs" onAdd={props.onAddAttachment} />
                            <AttachButton kind="text" onAdd={props.onAddAttachment} />
                        </div>
                    </div>

                    <div style={styles.attachList}>
                        {props.state.attachments.length === 0 ? (
                            <div style={{ opacity: 0.7 }}>No attachments yet.</div>
                        ) : (
                            props.state.attachments.map((a) => (
                                <div key={a.id} style={styles.attachItem}>
                                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                                        <div>
                                            <b>{a.title}</b> <span style={{ opacity: 0.7 }}>({a.kind})</span>
                                        </div>
                                        <button style={styles.btnGhost} onClick={() => props.onRemoveAttachment(a.id)}>
                                            Remove
                                        </button>
                                    </div>
                                    <textarea
                                        style={styles.attachTextarea}
                                        value={a.content}
                                        onChange={(e) => {
                                            // simplest approach for MVP: remove & re-add with updated content
                                            props.onRemoveAttachment(a.id);
                                            props.onAddAttachment(a.kind, a.title, e.target.value);
                                        }}
                                    />
                                </div>
                            ))
                        )}
                    </div>

                    <div style={styles.inputWrap}>
                        <textarea
                            style={styles.input}
                            placeholder="Type here or use voice… (input is always text)"
                            value={props.state.inputText}
                            onChange={(e) => props.onInputChange(e.target.value)}
                        />
                        <button style={styles.btnPrimary} onClick={props.onSend}>
                            Send
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

function Toggle(props: { label: string; value: boolean; onToggle: () => void }) {
    return (
        <button style={props.value ? styles.toggleOn : styles.toggleOff} onClick={props.onToggle}>
            {props.value ? "✅" : "⬜"} {props.label}
        </button>
    );
}

function AttachButton(props: {
    kind: AttachmentKind;
    onAdd: (kind: AttachmentKind, title: string, content: string) => void;
}) {
    return (
        <button
            style={styles.btn}
            onClick={() => {
                const title = props.kind === "code" ? "code.ts" : props.kind === "logs" ? "logs.txt" : "note.txt";
                props.onAdd(props.kind, title, "");
            }}
        >
            + {props.kind}
        </button>
    );
}

const styles: Record<string, React.CSSProperties> = {
    chipWrap: {
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 2147483647,
    },
    chip: {
        border: "1px solid rgba(255,255,255,0.15)",
        background: "rgba(20,20,24,0.92)",
        color: "white",
        padding: "10px 12px",
        borderRadius: 999,
        cursor: "pointer",
        boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        gap: 6,
    },
    panel: {
        position: "fixed",
        right: 16,
        bottom: 72,
        width: 420,
        height: 720,
        zIndex: 2147483647,
        background: "rgba(18,18,22,0.96)",
        color: "white",
        border: "1px solid rgba(255,255,255,0.14)",
        borderRadius: 16,
        boxShadow: "0 18px 60px rgba(0,0,0,0.5)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
    },
    header: {
        padding: 12,
        borderBottom: "1px solid rgba(255,255,255,0.10)",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: 12,
    },
    hTitle: { fontSize: 16, fontWeight: 700 },
    hSub: { fontSize: 12, opacity: 0.85, marginTop: 2 },
    controls: {
        padding: 12,
        borderBottom: "1px solid rgba(255,255,255,0.10)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
    },
    controlRow: { display: "flex", gap: 10, flexWrap: "wrap" },
    group: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
    label: { fontSize: 12, opacity: 0.8, marginRight: 4 },

    body: { flex: 1, display: "flex", flexDirection: "column" },
    messages: {
        flex: 1,
        padding: 12,
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 10,
    },
    msgU: {
        border: "1px solid rgba(255,255,255,0.10)",
        borderRadius: 12,
        padding: 10,
        background: "rgba(255,255,255,0.04)",
    },
    msgA: {
        border: "1px solid rgba(255,255,255,0.10)",
        borderRadius: 12,
        padding: 10,
        background: "rgba(0,140,255,0.12)",
    },
    msgS: {
        border: "1px solid rgba(255,255,255,0.10)",
        borderRadius: 12,
        padding: 10,
        background: "rgba(255,190,0,0.10)",
    },
    msgRole: { fontSize: 12, opacity: 0.8, marginBottom: 6 },
    msgText: { whiteSpace: "pre-wrap", margin: 0, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },

    attachWrap: {
        borderTop: "1px solid rgba(255,255,255,0.10)",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
    },
    attachHeader: { display: "flex", justifyContent: "space-between", alignItems: "center" },
    attachList: { maxHeight: 180, overflow: "auto", display: "flex", flexDirection: "column", gap: 10 },
    attachItem: {
        border: "1px solid rgba(255,255,255,0.10)",
        borderRadius: 12,
        padding: 10,
        background: "rgba(255,255,255,0.03)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
    },
    attachTextarea: {
        width: "100%",
        minHeight: 90,
        resize: "vertical",
        borderRadius: 10,
        padding: 10,
        border: "1px solid rgba(255,255,255,0.10)",
        background: "rgba(0,0,0,0.2)",
        color: "white",
        outline: "none",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
    },
    inputWrap: { display: "flex", gap: 10 },
    input: {
        flex: 1,
        minHeight: 60,
        borderRadius: 12,
        padding: 10,
        border: "1px solid rgba(255,255,255,0.12)",
        background: "rgba(0,0,0,0.25)",
        color: "white",
        outline: "none",
    },

    btnPrimary: {
        padding: "10px 12px",
        borderRadius: 12,
        border: "1px solid rgba(255,255,255,0.14)",
        background: "rgba(0,140,255,0.9)",
        color: "white",
        cursor: "pointer",
        fontWeight: 700,
    },
    btn: {
        padding: "8px 10px",
        borderRadius: 12,
        border: "1px solid rgba(255,255,255,0.12)",
        background: "rgba(255,255,255,0.06)",
        color: "white",
        cursor: "pointer",
    },
    btnGhost: {
        padding: "8px 10px",
        borderRadius: 12,
        border: "1px solid rgba(255,255,255,0.12)",
        background: "transparent",
        color: "white",
        cursor: "pointer",
        opacity: 0.9,
    },
    btnDanger: {
        padding: "8px 10px",
        borderRadius: 12,
        border: "1px solid rgba(255,90,90,0.25)",
        background: "rgba(255,90,90,0.15)",
        color: "white",
        cursor: "pointer",
        fontWeight: 700,
    },
    toggleOn: {
        padding: "8px 10px",
        borderRadius: 12,
        border: "1px solid rgba(255,255,255,0.12)",
        background: "rgba(0,200,120,0.20)",
        color: "white",
        cursor: "pointer",
    },
    toggleOff: {
        padding: "8px 10px",
        borderRadius: 12,
        border: "1px solid rgba(255,255,255,0.12)",
        background: "rgba(255,255,255,0.04)",
        color: "white",
        cursor: "pointer",
    },
};
