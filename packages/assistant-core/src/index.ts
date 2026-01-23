export type AttachmentKind = "code" | "logs" | "text";

export type Attachment = {
    id: string;
    kind: AttachmentKind;
    title: string;
    content: string;
    createdAt: number;
};

export type Role = "user" | "assistant" | "system";

export type ChatMessage = {
    id: string;
    role: Role;
    content: string;
    createdAt: number;
};

export type VisionState = "off" | "on" | "paused";

export type AssistantSettings = {
    vision: VisionState;
    explainMode: boolean;
    speakOutput: boolean;
};

export type AssistantState = {
    isOpen: boolean;
    settings: AssistantSettings;
    inputText: string;
    attachments: Attachment[];
    messages: ChatMessage[];
    lastVisionCaptureAt?: number;
};

export type AssistantAction =
    | { type: "toggle_open" }
    | { type: "set_open"; value: boolean }
    | { type: "set_input"; value: string }
    | { type: "set_setting"; key: keyof AssistantSettings; value: any }
    | { type: "add_attachment"; att: Attachment }
    | { type: "remove_attachment"; id: string }
    | { type: "add_message"; msg: ChatMessage }
    | { type: "mark_vision_capture"; ts: number }
    | { type: "clear_chat" };

export const defaultState: AssistantState = {
    isOpen: true,
    settings: { vision: "off", explainMode: false, speakOutput: false },
    inputText: "",
    attachments: [],
    messages: [
        {
            id: "sys-1",
            role: "system",
            content:
                "Assistant ready. Toggle AI Vision (private) to let the assistant see your screen without sharing to others.",
            createdAt: Date.now()
        }
    ]
};

export function assistantReducer(state: AssistantState, action: AssistantAction): AssistantState {
    switch (action.type) {
        case "toggle_open":
            return { ...state, isOpen: !state.isOpen };
        case "set_open":
            return { ...state, isOpen: action.value };
        case "set_input":
            return { ...state, inputText: action.value };
        case "set_setting":
            return { ...state, settings: { ...state.settings, [action.key]: action.value } };
        case "add_attachment":
            return { ...state, attachments: [action.att, ...state.attachments] };
        case "remove_attachment":
            return { ...state, attachments: state.attachments.filter((a) => a.id !== action.id) };
        case "add_message":
            return { ...state, messages: [...state.messages, action.msg] };
        case "mark_vision_capture":
            return { ...state, lastVisionCaptureAt: action.ts };
        case "clear_chat":
            return { ...state, messages: state.messages.filter((m) => m.role === "system") };
        default:
            return state;
    }
}

export function uid(prefix = "id") {
    return `${prefix}-${Math.random().toString(16).slice(2)}-${Date.now()}`;
}
