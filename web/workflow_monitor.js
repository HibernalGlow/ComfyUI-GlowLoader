import { app } from "../../../scripts/app.js";
import { Coordinator } from "./workflow_coordinator.js";

function statusColor(status) {
    return {
        active: "#4a6",
        waiting: "#888",
        done: "#369",
        aborted: "#c33",
        stale: "#a60",
    }[status] || "#888";
}

function createMonitorUI(node) {
    const container = document.createElement("div");
    container.style.cssText =
        "width:100%;padding:8px;background:var(--comfy-menu-bg);border:1px solid var(--border-color);border-radius:6px;margin:5px 0;pointer-events:auto;font-size:12px;";

    const title = document.createElement("div");
    title.textContent = "本标签页工作流状态";
    title.style.cssText = "font-weight:bold;margin-bottom:6px;";

    const body = document.createElement("div");
    body.style.cssText = "max-height:220px;overflow:auto;background:var(--comfy-input-bg);padding:6px;border-radius:4px;";

    container.appendChild(title);
    container.appendChild(body);

    const redraw = async () => {
        const tabId = Coordinator.getTabId();
        let st;
        try { st = await Coordinator.getStatus(); } catch (e) { return; }
        const mine = (st.workflows || []).filter(w => w.tab_id === tabId);
        body.innerHTML = "";
        if (mine.length === 0) {
            body.textContent = "（本标签页暂无工作流）";
            return;
        }
        const frag = document.createDocumentFragment();
        for (const wf of mine) {
            const row = document.createElement("div");
            row.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid var(--border-color);";
            const left = document.createElement("span");
            left.textContent = wf.name;
            left.title = `id: ${wf.id}`;
            const right = document.createElement("span");
            right.style.cssText = "display:flex;align-items:center;gap:4px;opacity:0.9;";
            const dot = document.createElement("span");
            dot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;background:${statusColor(wf.status)};`;
            right.appendChild(dot);
            const txt = document.createElement("span");
            txt.textContent = `${wf.status} · ${wf.executed}/${wf.total}`;
            right.appendChild(txt);
            row.appendChild(left); row.appendChild(right);
            frag.appendChild(row);
        }
        body.appendChild(frag);
    };

    // 节点存在时轮询
    const timer = setInterval(() => {
        if (!app.graph?.nodes?.includes(node)) {
            clearInterval(timer);
            return;
        }
        redraw();
    }, 1500);

    return { container, redraw };
}

app.registerExtension({
    name: "GlowLoader.WorkflowMonitor.Extension",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "BatchWorkflowMonitor") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);
            const ui = createMonitorUI(this);
            this.addDOMWidget("workflow_monitor", "customwidget", ui.container);
            this.setSize([360, 240]);
            ui.redraw();
            return r;
        };
    },
});

console.log("[GlowLoader] workflow monitor extension loaded");
