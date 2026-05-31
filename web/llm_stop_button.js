import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const LLM_NODES = [
    "GlowAPIChat",
    "GlowCaptioner",
    "GlowGenerateBBOX",
    "GlowApplyChatTemplate",
];

let stopButton = null;
let isExecuting = false;

function createStopButton() {
    if (stopButton) return stopButton;

    stopButton = document.createElement("button");
    stopButton.textContent = "⏹ 停止 LLM";
    stopButton.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        padding: 12px 24px;
        background: rgba(200, 50, 50, 0.9);
        color: #fff;
        border: 2px solid rgba(255, 100, 100, 0.9);
        border-radius: 8px;
        cursor: pointer;
        font-size: 14px;
        font-weight: bold;
        z-index: 10000;
        display: none;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        transition: all 0.2s ease;
    `;

    stopButton.onmouseenter = () => {
        stopButton.style.background = "rgba(220, 60, 60, 1)";
        stopButton.style.transform = "scale(1.05)";
    };
    stopButton.onmouseleave = () => {
        stopButton.style.background = "rgba(200, 50, 50, 0.9)";
        stopButton.style.transform = "scale(1)";
    };

    stopButton.onclick = async () => {
        console.log("[GlowLoader LLM] 用户点击停止按钮");
        try {
            await api.fetchApi("/interrupt", { method: "POST" });
            console.log("[GlowLoader LLM] 已发送中断请求");
            stopButton.textContent = "⏳ 正在停止...";
            stopButton.disabled = true;
        } catch (e) {
            console.error("[GlowLoader LLM] 发送中断请求失败:", e);
        }
    };

    document.body.appendChild(stopButton);
    return stopButton;
}

function showStopButton() {
    if (!stopButton) createStopButton();
    stopButton.style.display = "block";
    stopButton.textContent = "⏹ 停止 LLM";
    stopButton.disabled = false;
    isExecuting = true;
}

function hideStopButton() {
    if (stopButton) {
        stopButton.style.display = "none";
    }
    isExecuting = false;
}

function hasLLMNodeInGraph() {
    for (const node of app.graph.nodes) {
        if (LLM_NODES.includes(node.type)) {
            return true;
        }
    }
    return false;
}

app.registerExtension({
    name: "GlowLoader.LLMStopButton",

    setup() {
        createStopButton();
    },
});

api.addEventListener("execution_start", () => {
    if (hasLLMNodeInGraph()) {
        showStopButton();
    }
});

api.addEventListener("execution_error", () => {
    hideStopButton();
});

api.addEventListener("executing", (e) => {
    if (e.detail && e.detail.node) {
        const node = app.graph.getNodeById(e.detail.node);
        if (node && LLM_NODES.includes(node.type)) {
            showStopButton();
        }
    }
    if (e.detail === null) {
        hideStopButton();
    }
});

api.addEventListener("status", (e) => {
    const status = e.detail;
    if (status && status.exec_info) {
        const remaining = status.exec_info.queue_remaining;
        if (remaining === 0) {
            hideStopButton();
        }
    }
});

console.log("[GlowLoader LLM] 停止按钮扩展已加载");