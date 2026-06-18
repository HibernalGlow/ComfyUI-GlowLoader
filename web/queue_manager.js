import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const QueueManager = {
    _cachedPrompt: null,
    _cacheExpiry: 0,

    /** 中止标志 */
    _aborted: false,

    /** 当前是否正在入队 */
    _queuing: false,

    get aborted() {
        return this._aborted;
    },

    get queuing() {
        return this._queuing;
    },

    /** 请求中止当前入队操作 */
    stop() {
        this._aborted = true;
        console.log("[QueueManager] 收到停止请求");
        api.fetchApi("/glowloader/batch/cancel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        }).catch((e) => console.warn("[QueueManager] 后端批次取消失败:", e));
    },

    /** 重置中止标志（新一轮入队开始时调用） */
    resetAbort() {
        this._aborted = false;
    },

    abortLocal() {
        this._aborted = true;
    },

    async getPrompt() {
        const now = Date.now();
        if (this._cachedPrompt && now - this._cacheExpiry < 500) {
            return this._cachedPrompt;
        }
        this._cachedPrompt = await app.graphToPrompt();
        this._cacheExpiry = now;
        return this._cachedPrompt;
    },

    invalidatePromptCache() {
        this._cachedPrompt = null;
        this._cacheExpiry = 0;
    },

    getQueueSize() {
        return app.ui?.lastQueueSize || 0;
    },

    async getQueueCounts() {
        try {
            const resp = await api.fetchApi("/queue");
            if (resp.ok) {
                const json = await resp.json();
                const pending = Array.isArray(json?.queue_pending) ? json.queue_pending.length : 0;
                const running = Array.isArray(json?.queue_running) ? json.queue_running.length : 0;
                return { pending, running, total: pending + running };
            }
        } catch (e) {
            console.warn("[QueueManager] 获取队列状态失败，退回 lastQueueSize:", e);
        }

        const pending = this.getQueueSize();
        return { pending, running: 0, total: pending };
    },

    async waitUntilIdle(checkInterval = 1000) {
        while (!this._aborted) {
            const counts = await this.getQueueCounts();
            if (counts.total <= 0) {
                return true;
            }
            console.log(`[QueueManager] 等待当前批次执行完毕 (pending=${counts.pending}, running=${counts.running})...`);
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }
        return false;
    },

    async waitForSpace(threshold, checkInterval, targetSpace = 1) {
        const maxWaitTime = 300000;
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitTime) {
            if (this._aborted) return false;
            const queueSize = this.getQueueSize();
            if (threshold - queueSize >= targetSpace) {
                return true;
            }
            console.log(`[QueueManager] 队列已满 (${queueSize}/${threshold})，等待 ${checkInterval}ms...`);
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }

        console.warn("[QueueManager] 等待队列空位超时，继续执行...");
        return false;
    },

    async enqueuePrompt(prompt) {
        await api.queuePrompt(0, prompt);
    },

    getWorkflowInfo() {
        const candidates = [
            app.workflowManager?.activeWorkflow,
            app.workflowManager?.workflow,
            app.extensionManager?.workflow?.activeWorkflow,
            app.extensionManager?.workflow,
            app.graph?._workflow,
            app.graph?.workflow,
            app.graph,
        ];
        const keys = ["name", "title", "filename", "fileName", "path", "fullPath", "basename"];
        for (const source of candidates) {
            if (!source || typeof source !== "object") continue;
            for (const key of keys) {
                const value = source[key];
                if (typeof value === "string" && value.trim()) {
                    const label = value.split(/[\\/]/).pop() || value;
                    return { id: value, label };
                }
            }
        }
        const title = document?.title?.replace(/\s*-\s*ComfyUI\s*$/i, "").trim();
        if (title && title !== "ComfyUI") return { id: title, label: title };
        return { id: "current", label: "当前工作流" };
    },

    async submitBatch({ node, label, prompts, threshold, checkInterval }) {
        if (!prompts || prompts.length === 0) return null;
        const workflow = this.getWorkflowInfo();
        const body = {
            node_id: String(node?.id ?? ""),
            label: label || node?.title || node?.type || "GlowLoader Batch",
            workflow_id: workflow.id,
            workflow_label: workflow.label,
            node_title: node?.title || node?.type || "",
            threshold,
            check_interval_ms: checkInterval,
            client_id: api.clientId,
            prompts,
        };
        const resp = await api.fetchApi("/glowloader/batch/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            throw new Error(await resp.text());
        }
        return await resp.json();
    },

    async getBatchStatus(batchId) {
        const resp = await api.fetchApi(`/glowloader/batch/status?batch_id=${encodeURIComponent(batchId)}`);
        if (!resp.ok) {
            throw new Error(await resp.text());
        }
        const json = await resp.json();
        return json?.batches?.[0] || null;
    },

    async pauseBatch(batchId) {
        const resp = await api.fetchApi("/glowloader/batch/pause", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ batch_id: batchId }),
        });
        if (!resp.ok) throw new Error(await resp.text());
        return await resp.json();
    },

    async pauseWorkflow(workflowId) {
        const resp = await api.fetchApi("/glowloader/batch/pause", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workflow_id: workflowId }),
        });
        if (!resp.ok) throw new Error(await resp.text());
        return await resp.json();
    },

    watchBatch(batchId, onUpdate) {
        let stopped = false;
        const tick = async () => {
            if (stopped) return;
            try {
                const status = await this.getBatchStatus(batchId);
                if (status) {
                    onUpdate?.(status);
                    if (["completed", "cancelled", "error", "paused"].includes(status.status)) return;
                }
            } catch (e) {
                console.warn("[QueueManager] 批次状态查询失败:", e);
            }
            setTimeout(tick, 1000);
        };
        tick();
        return () => {
            stopped = true;
        };
    },

    deepClone(obj) {
        if (typeof structuredClone === "function") return structuredClone(obj);
        return JSON.parse(JSON.stringify(obj));
    },

    /** 标记入队开始 */
    startQueuing() {
        this._queuing = true;
        this._aborted = false;
    },

    /** 标记入队结束 */
    endQueuing() {
        this._queuing = false;
    },
};

export { QueueManager };
