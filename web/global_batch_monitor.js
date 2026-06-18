import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { QueueManager } from "./queue_manager.js";

const DONE_STATUSES = new Set(["completed", "cancelled", "error"]);

function clampPercent(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, value));
}

function shortId(id) {
    return id ? String(id).slice(0, 8) : "-";
}

function statusText(status) {
    const map = {
        queued: "等待",
        running: "运行",
        completed: "完成",
        cancelled: "取消",
        error: "错误",
        "准备中": "准备",
    };
    return map[status] || status || "-";
}

function isActive(batch) {
    return batch && !DONE_STATUSES.has(batch.status);
}

function getBatchKey(batch, index) {
    return batch.batch_id || `local:${batch.workflow_id || "current"}:${batch.node_id || index}:${batch.status || "status"}`;
}

function mergeBatches(remoteBatches, localBatches) {
    const map = new Map();
    for (const batch of remoteBatches || []) {
        if (!batch) continue;
        map.set(getBatchKey(batch, map.size), batch);
    }
    for (const batch of localBatches || []) {
        if (!batch) continue;
        const key = getBatchKey(batch, map.size);
        if (!map.has(key)) map.set(key, batch);
    }
    return Array.from(map.values()).sort((a, b) => {
        const activeDelta = Number(isActive(b)) - Number(isActive(a));
        if (activeDelta) return activeDelta;
        return (b.created_at || 0) - (a.created_at || 0);
    });
}

function getLocalPreparingBatches() {
    const workflow = QueueManager.getWorkflowInfo?.() || {};
    const nodes = app.graph?.nodes || [];
    const result = [];
    for (const node of nodes) {
        const status = node?._glowloaderBatchStatus || node?.properties?.glowloader_last_batch;
        if (!status || status.batch_id || status.status !== "准备中") continue;
        result.push({
            ...status,
            node_id: status.node_id || String(node.id ?? ""),
            node_title: status.node_title || node.title || node.type || "",
            workflow_id: status.workflow_id || workflow.id || "current",
            workflow_label: status.workflow_label || workflow.label || "当前工作流",
        });
    }
    return result;
}

function groupByWorkflow(batches) {
    const groups = new Map();
    for (const batch of batches) {
        const label = batch.workflow_label || "未知工作流";
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(batch);
    }
    return Array.from(groups.entries());
}

const monitor = {
    root: null,
    pill: null,
    panel: null,
    list: null,
    expanded: false,
    batches: [],
    timer: null,

    init() {
        if (this.root || !document.body) return;
        this.injectStyle();
        this.root = document.createElement("div");
        this.root.className = "glowloader-global-monitor";

        this.pill = document.createElement("button");
        this.pill.className = "glowloader-global-pill";
        this.pill.type = "button";
        this.pill.title = "查看 GlowLoader 批次进度";
        this.pill.onclick = () => {
            this.expanded = !this.expanded;
            this.render();
        };

        this.panel = document.createElement("div");
        this.panel.className = "glowloader-global-panel";

        const header = document.createElement("div");
        header.className = "glowloader-global-header";
        const title = document.createElement("div");
        title.textContent = "GlowLoader 批次进度";
        const refresh = document.createElement("button");
        refresh.type = "button";
        refresh.textContent = "刷新";
        refresh.onclick = (e) => {
            e.stopPropagation();
            this.refresh();
        };
        header.appendChild(title);
        header.appendChild(refresh);

        this.list = document.createElement("div");
        this.list.className = "glowloader-global-list";
        this.panel.appendChild(header);
        this.panel.appendChild(this.list);

        this.root.appendChild(this.pill);
        this.root.appendChild(this.panel);
        document.body.appendChild(this.root);

        this.refresh();
        this.timer = setInterval(() => this.refresh(), 1000);
    },

    injectStyle() {
        if (document.getElementById("glowloader-global-monitor-style")) return;
        const style = document.createElement("style");
        style.id = "glowloader-global-monitor-style";
        style.textContent = `
            .glowloader-global-monitor {
                position: fixed;
                right: 18px;
                bottom: 72px;
                z-index: 99999;
                font-family: Arial, sans-serif;
                color: var(--input-text, #ddd);
                pointer-events: none;
            }
            .glowloader-global-pill,
            .glowloader-global-panel {
                pointer-events: auto;
                background: rgba(24, 26, 31, 0.94);
                border: 1px solid rgba(255,255,255,0.16);
                box-shadow: 0 8px 28px rgba(0,0,0,0.32);
            }
            .glowloader-global-pill {
                min-width: 180px;
                border-radius: 8px;
                padding: 8px 10px;
                color: inherit;
                cursor: pointer;
                font-size: 12px;
                text-align: left;
            }
            .glowloader-global-pill .line {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
            }
            .glowloader-global-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: #5b8cff;
                display: inline-block;
                margin-right: 6px;
            }
            .glowloader-global-dot.idle { background: #6f7685; }
            .glowloader-global-dot.error { background: #ff6565; }
            .glowloader-global-panel {
                display: none;
                width: min(520px, calc(100vw - 36px));
                max-height: min(560px, calc(100vh - 120px));
                margin-top: 8px;
                border-radius: 8px;
                overflow: hidden;
            }
            .glowloader-global-monitor.expanded .glowloader-global-panel { display: block; }
            .glowloader-global-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px 12px;
                border-bottom: 1px solid rgba(255,255,255,0.12);
                font-size: 13px;
                font-weight: 600;
            }
            .glowloader-global-header button {
                border: 1px solid rgba(255,255,255,0.18);
                background: rgba(255,255,255,0.08);
                color: inherit;
                border-radius: 5px;
                padding: 4px 8px;
                cursor: pointer;
                font-size: 12px;
            }
            .glowloader-global-list {
                overflow-y: auto;
                max-height: calc(min(560px, calc(100vh - 120px)) - 43px);
                padding: 10px 12px 12px;
            }
            .glowloader-global-empty {
                opacity: 0.7;
                font-size: 12px;
                padding: 12px 0;
            }
            .glowloader-workflow-group + .glowloader-workflow-group {
                margin-top: 12px;
                padding-top: 12px;
                border-top: 1px solid rgba(255,255,255,0.1);
            }
            .glowloader-workflow-title {
                font-size: 12px;
                font-weight: 600;
                margin-bottom: 8px;
                color: #fff;
            }
            .glowloader-batch-row {
                padding: 8px;
                border-radius: 6px;
                background: rgba(255,255,255,0.055);
                margin-bottom: 7px;
            }
            .glowloader-batch-top,
            .glowloader-batch-meta {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
            }
            .glowloader-batch-top {
                font-size: 12px;
                color: #fff;
            }
            .glowloader-batch-meta {
                margin-top: 5px;
                font-size: 11px;
                opacity: 0.8;
            }
            .glowloader-progress-track {
                height: 5px;
                border-radius: 999px;
                background: rgba(255,255,255,0.12);
                overflow: hidden;
                margin-top: 7px;
            }
            .glowloader-progress-bar {
                height: 100%;
                width: 0;
                background: #6fa3ff;
                transition: width 160ms ease;
            }
            .glowloader-progress-bar.done { background: #64d27b; }
            .glowloader-progress-bar.error { background: #ff6565; }
        `;
        document.head.appendChild(style);
    },

    async fetchRemoteBatches() {
        const resp = await api.fetchApi("/glowloader/batch/status");
        if (!resp.ok) throw new Error(await resp.text());
        const json = await resp.json();
        return (json?.batches || []).filter(Boolean);
    },

    async refresh() {
        try {
            const remote = await this.fetchRemoteBatches();
            const local = getLocalPreparingBatches();
            this.batches = mergeBatches(remote, local);
        } catch (e) {
            console.warn("[GlowLoader] 全局批次进度刷新失败:", e);
            this.batches = mergeBatches([], getLocalPreparingBatches());
        }
        this.render();
    },

    render() {
        if (!this.root) return;
        this.root.classList.toggle("expanded", this.expanded);
        const active = this.batches.filter(isActive);
        const errors = this.batches.filter((b) => b.status === "error");
        const submitted = active.reduce((sum, b) => sum + (b.submitted || 0), 0);
        const total = active.reduce((sum, b) => sum + (b.total || 0), 0);
        const completed = active.reduce((sum, b) => sum + (b.completed || 0), 0);
        const dotClass = errors.length ? "error" : active.length ? "" : "idle";
        this.pill.innerHTML = `
            <div class="line"><span><span class="glowloader-global-dot ${dotClass}"></span>Glow 批次</span><span>${active.length} 活跃</span></div>
            <div class="line" style="margin-top:4px;opacity:.82;"><span>提交 ${submitted}/${total}</span><span>完成 ${completed}/${total}</span></div>
        `;
        this.renderList();
    },

    renderList() {
        if (!this.list) return;
        this.list.innerHTML = "";
        if (!this.batches.length) {
            const empty = document.createElement("div");
            empty.className = "glowloader-global-empty";
            empty.textContent = "暂无批次";
            this.list.appendChild(empty);
            return;
        }
        for (const [workflow, batches] of groupByWorkflow(this.batches)) {
            const group = document.createElement("div");
            group.className = "glowloader-workflow-group";
            const title = document.createElement("div");
            title.className = "glowloader-workflow-title";
            const activeCount = batches.filter(isActive).length;
            title.textContent = `${workflow} · ${activeCount} 活跃 / ${batches.length} 批次`;
            group.appendChild(title);

            for (const batch of batches) {
                group.appendChild(this.renderBatchRow(batch));
            }
            this.list.appendChild(group);
        }
    },

    renderBatchRow(batch) {
        const row = document.createElement("div");
        row.className = "glowloader-batch-row";
        const total = batch.total || 0;
        const completed = batch.completed || 0;
        const submitted = batch.submitted || 0;
        const percent = total > 0 ? clampPercent((completed / total) * 100) : 0;
        const queue = batch.queue || {};
        const nodeLabel = batch.node_title || batch.label || `节点 ${batch.node_id || "-"}`;
        const barClass = batch.status === "completed" ? "done" : batch.status === "error" ? "error" : "";

        row.innerHTML = `
            <div class="glowloader-batch-top">
                <span>${nodeLabel}</span>
                <span>${statusText(batch.status)} #${shortId(batch.batch_id)}</span>
            </div>
            <div class="glowloader-batch-meta">
                <span>提交 ${submitted}/${total} · 完成 ${completed}/${total}</span>
                <span>队列 ${queue.total || 0}（运行 ${queue.running || 0}/等待 ${queue.pending || 0}）</span>
            </div>
            <div class="glowloader-progress-track"><div class="glowloader-progress-bar ${barClass}" style="width:${percent}%"></div></div>
        `;
        if (batch.current_index !== undefined && batch.current_index !== null) {
            const meta = document.createElement("div");
            meta.className = "glowloader-batch-meta";
            meta.innerHTML = `<span>当前 index ${batch.current_index}</span><span>${batch.label || ""}</span>`;
            row.appendChild(meta);
        }
        if (batch.error) {
            const err = document.createElement("div");
            err.className = "glowloader-batch-meta";
            err.style.color = "#ff8585";
            err.textContent = batch.error;
            row.appendChild(err);
        }
        return row;
    },
};

app.registerExtension({
    name: "GlowLoader.GlobalBatchMonitor",
    setup() {
        const start = () => monitor.init();
        if (document.body) start();
        else requestAnimationFrame(start);
    },
});
