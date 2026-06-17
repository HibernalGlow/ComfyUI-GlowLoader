import { app } from "../../../scripts/app.js";
import { Coordinator } from "./workflow_coordinator.js";

const POLL_INTERVAL = 1000;

let panelEl = null;
let pollTimer = null;
let selected = new Set();
let hidden = new Set(); // 已"清空"的终态工作流 id（仅本地面板隐藏）

function statusColor(status) {
    return {
        active: "#4a6",
        waiting: "#888",
        done: "#369",
        aborted: "#c33",
        stale: "#a60",
    }[status] || "#888";
}

function createPanel() {
    if (panelEl) return panelEl;
    panelEl = document.createElement("div");
    panelEl.style.cssText = `
        position: fixed; bottom: 20px; left: 20px; z-index: 10000;
        width: 460px; max-height: 60vh; overflow: auto;
        background: var(--comfy-menu-bg); color: var(--input-text);
        border: 1px solid var(--border-color); border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.4); font-size: 12px;
        padding: 8px; display: none;
    `;

    const header = document.createElement("div");
    header.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;font-weight:bold;";
    header.innerHTML = `<span>GlowLoader 工作流队列</span>`;
    const collapseBtn = document.createElement("button");
    collapseBtn.textContent = "—";
    collapseBtn.style.cssText = "background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;padding:2px 8px;";
    collapseBtn.onclick = () => { panelEl.style.display = "none"; };
    header.appendChild(collapseBtn);

    const toolbar = document.createElement("div");
    toolbar.style.cssText = "display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap;";
    const mkBtn = (label, fn, bg) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.style.cssText = `padding:4px 10px;border:1px solid var(--border-color);border-radius:4px;cursor:pointer;background:${bg || "var(--comfy-input-bg)"};color:${bg ? "#fff" : "var(--input-text)"};`;
        b.onclick = fn;
        return b;
    };
    const stopSelBtn = mkBtn("⏹ 停止选中", async () => {
        if (selected.size === 0) return;
        await Coordinator.abortBatch([...selected]);
        selected.clear();
        await refresh();
    }, "rgba(200,50,50,0.85)");
    const clearBtn = mkBtn("清空已完成", () => {
        // 终态工作流（done/aborted/stale）仅在本地面板隐藏；
        // 后端注册表为会话级，保留用于审计。
        hidden = new Set([...hidden, ...selected]);
        selected.clear();
        refresh();
    });
    const selectAllBtn = mkBtn("全选未完成", () => {
        const tbody = panelEl?.querySelector("tbody");
        if (!tbody) return;
        tbody.querySelectorAll("tr[data-status='active'], tr[data-status='waiting']").forEach(tr => {
            const cb = tr.querySelector("input[type='checkbox']");
            if (cb && !cb.checked) { cb.checked = true; selected.add(tr.dataset.id); }
        });
    });
    toolbar.appendChild(stopSelBtn);
    toolbar.appendChild(selectAllBtn);
    toolbar.appendChild(clearBtn);

    const tableWrap = document.createElement("div");
    tableWrap.style.cssText = "max-height:40vh;overflow:auto;";
    const table = document.createElement("table");
    table.style.cssText = "width:100%;border-collapse:collapse;";
    table.innerHTML = `
        <thead><tr style="text-align:left;border-bottom:1px solid var(--border-color);">
            <th style="padding:4px;width:20px;"></th>
            <th style="padding:4px;">名称</th>
            <th style="padding:4px;">状态</th>
            <th style="padding:4px;">进度</th>
            <th style="padding:4px;">操作</th>
        </tr></thead>
    `;
    const tbody = document.createElement("tbody");
    table.appendChild(tbody);
    tableWrap.appendChild(table);

    panelEl.appendChild(header);
    panelEl.appendChild(toolbar);
    panelEl.appendChild(tableWrap);
    document.body.appendChild(panelEl);

    // 独立的切换按钮（始终可见）
    const toggleBtn = document.createElement("button");
    toggleBtn.textContent = "☰ 队列";
    toggleBtn.style.cssText = `
        position: fixed; bottom: 20px; left: 20px; z-index: 9999;
        padding: 8px 14px; background: var(--comfy-input-bg); color: var(--input-text);
        border: 1px solid var(--border-color); border-radius: 8px; cursor:pointer;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    `;
    toggleBtn.onclick = () => {
        panelEl.style.display = panelEl.style.display === "none" ? "block" : "none";
        if (panelEl.style.display === "block") refresh();
    };
    document.body.appendChild(toggleBtn);

    return panelEl;
}

async function refresh() {
    const tbody = panelEl?.querySelector("tbody");
    if (!tbody) return;
    let st;
    try { st = await Coordinator.getStatus(); } catch (e) { return; }
    const workflows = (st.workflows || []).filter(w => !hidden.has(w.id));
    tbody.innerHTML = "";
    const frag = document.createDocumentFragment();
    workflows.forEach(wf => {
        const tr = document.createElement("tr");
        tr.dataset.status = wf.status;
        tr.dataset.id = wf.id;
        tr.style.cssText = "border-bottom:1px solid var(--border-color);";
        const isTerminal = wf.status === "done" || wf.status === "aborted" || wf.status === "stale";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = selected.has(wf.id);
        cb.disabled = isTerminal;
        cb.onchange = () => {
            if (cb.checked) selected.add(wf.id); else selected.delete(wf.id);
        };
        const cbTd = document.createElement("td"); cbTd.style.padding = "4px"; cbTd.appendChild(cb);

        const nameTd = document.createElement("td"); nameTd.style.padding = "4px";
        nameTd.textContent = wf.name;
        nameTd.title = `id: ${wf.id}\ntab: ${wf.tab_id}`;

        const stTd = document.createElement("td"); stTd.style.padding = "4px";
        stTd.innerHTML = `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${statusColor(wf.status)};margin-right:4px;"></span>${wf.status}`;

        const progTd = document.createElement("td"); progTd.style.padding = "4px";
        progTd.textContent = `${wf.executed}/${wf.enqueued}/${wf.total}`;
        progTd.title = "已执行/已入队/总数";

        const opTd = document.createElement("td"); opTd.style.padding = "4px";
        if (!isTerminal) {
            const stopOne = document.createElement("button");
            stopOne.textContent = "⏹";
            stopOne.title = "停止该工作流";
            stopOne.style.cssText = "background:rgba(200,50,50,0.85);color:#fff;border:none;border-radius:3px;cursor:pointer;padding:2px 6px;";
            stopOne.onclick = async () => { await Coordinator.abortWorkflow(wf.id); await refresh(); };
            opTd.appendChild(stopOne);
        }

        tr.appendChild(cbTd); tr.appendChild(nameTd); tr.appendChild(stTd); tr.appendChild(progTd); tr.appendChild(opTd);
        frag.appendChild(tr);
    });
    tbody.appendChild(frag);
}

app.registerExtension({
    name: "GlowLoader.WorkflowPanel",
    setup() {
        createPanel();
        pollTimer = setInterval(() => {
            if (panelEl && panelEl.style.display === "block") refresh();
        }, POLL_INTERVAL);
    },
});

console.log("[GlowLoader] workflow panel extension loaded");
