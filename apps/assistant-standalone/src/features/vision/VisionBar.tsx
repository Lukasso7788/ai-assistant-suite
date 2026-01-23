import React from "react";
import { useAIVision } from "./useAIVision";

export function VisionBar() {
    const vision = useAIVision({
        autoCaptureEveryMs: 0, // начни с manual-only (Re-sync), потом включим авто
        jpegQuality: 0.75,
        maxWidth: 900,
    });

    const onSourceClick = async () => {
        if (vision.isOn || vision.isPaused) {
            // Change source = stop + start (и снова выбрать окно)
            vision.stop();
            await vision.start();
            return;
        }
        await vision.start();
    };

    return (
        <div
            style={{
                display: "flex",
                gap: 10,
                alignItems: "center",
                padding: 10,
                borderRadius: 14,
                border: "1px solid rgba(255,255,255,0.10)",
                background: "rgba(0,0,0,0.35)",
                backdropFilter: "blur(14px)",
            }}
        >
            {/* Preview */}
            <div
                style={{
                    width: 74,
                    height: 50,
                    borderRadius: 10,
                    overflow: "hidden",
                    border: "1px solid rgba(255,255,255,0.12)",
                    background: "rgba(255,255,255,0.04)",
                    position: "relative",
                    flex: "0 0 auto",
                }}
                title={vision.previewUrl ? "Preview (private)" : "No preview"}
            >
                {vision.previewUrl ? (
                    <img
                        src={vision.previewUrl}
                        alt="preview"
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                ) : null}

                {/* маленькая точка статуса */}
                <div
                    style={{
                        position: "absolute",
                        top: 6,
                        left: 6,
                        width: 8,
                        height: 8,
                        borderRadius: 999,
                        background:
                            vision.isOn ? "#33d17a" : vision.isPaused ? "#f5c211" : "#777",
                        boxShadow: "0 0 0 2px rgba(0,0,0,0.35)",
                    }}
                />
            </div>

            {/* Controls */}
            <button
                onClick={onSourceClick}
                style={btnStyle("rgba(255,255,255,0.08)")}
            >
                Source
            </button>

            <button
                onClick={vision.reSync}
                disabled={!vision.isOn && !vision.isPaused}
                style={btnStyle("#1f7a3a")}
                title="Make a fresh snapshot"
            >
                Re-sync
            </button>

            <button
                onClick={vision.isPaused ? vision.resume : vision.pause}
                disabled={!vision.isOn && !vision.isPaused}
                style={btnStyle("rgba(255,255,255,0.08)")}
            >
                {vision.isPaused ? "Resume" : "Pause"}
            </button>

            <button
                onClick={vision.stop}
                disabled={!vision.isOn && !vision.isPaused && !vision.isRequesting}
                style={btnStyle("rgba(255, 0, 0, 0.25)")}
            >
                Stop
            </button>

            {/* Meta */}
            <div style={{ marginLeft: 6, minWidth: 220 }}>
                <div style={{ fontSize: 12, opacity: 0.9 }}>
                    <b>Seeing:</b>{" "}
                    {vision.sourceInfo?.label
                        ? vision.sourceInfo.label
                        : vision.isRequesting
                            ? "Selecting…"
                            : "—"}
                </div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>
                    <b>Last capture:</b> {vision.lastCaptureText}
                </div>
                <div
                    style={{
                        fontSize: 12,
                        opacity: 0.75,
                        marginTop: 2,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                    }}
                >
                    <span
                        style={{
                            padding: "3px 8px",
                            borderRadius: 999,
                            background: "rgba(80,160,255,0.20)",
                            border: "1px solid rgba(80,160,255,0.35)",
                        }}
                    >
                        🔒 Private (not shared)
                    </span>

                    {vision.error ? (
                        <span style={{ color: "#ff6b6b" }}>Error: {vision.error}</span>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

function btnStyle(bg: string): React.CSSProperties {
    return {
        padding: "8px 10px",
        borderRadius: 10,
        border: "1px solid rgba(255,255,255,0.12)",
        background: bg,
        color: "white",
        cursor: "pointer",
        fontSize: 13,
    };
}
