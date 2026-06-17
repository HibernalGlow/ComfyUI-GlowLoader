import { api } from "../../../scripts/api.js";
import { QueueManager } from "./queue_manager.js";

/**
 * Cross-tab workflow coordinator.
 *
 * Enqueue buttons call runWorkflow(name, total, enqueueFn). The coordinator:
 *   1. registers with the backend (gets a workflow id)
 *   2. waits until it becomes the active workflow
 *   3. starts heartbeat + abort-poller
 *   4. calls enqueueFn({ report, isAborted }) which does the actual enqueue loop
 *   5. waits until all enqueued prompts have finished executing
 *      (tracked via execution_success/error/interrupted WebSocket events)
 *   6. marks done on the backend
 *
 * Abort from the floating panel (possibly another tab) marks the workflow
 * aborted on the backend; the abort-poller in the owning tab notices and
 * calls QueueManager.stop() to break the enqueue loop.
 */
const Coordinator = {
    _tabId: null,
    _current: null, // { id, name, total, promptIds: Set, executed: Set }
    _heartbeatTimer: null,
    _abortTimer: null,
    _listenersInstalled: false,

    _getTabId() {
        if (!this._tabId) {
            this._tabId = sessionStorage.getItem("glowloader_tab_id");
            if (!this._tabId) {
                this._tabId = "tab_" + Math.random().toString(36).slice(2, 10);
                sessionStorage.setItem("glowloader_tab_id", this._tabId);
            }
        }
        return this._tabId;
    },

    async _post(path, body) {
        const resp = await api.fetchApi(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body || {}),
        });
        return resp.json();
    },

    async _get(path) {
        const resp = await api.fetchApi(path);
        return resp.json();
    },

    _installExecListeners() {
        if (this._listenersInstalled) return;
        this._listenersInstalled = true;
        const handler = (e) => {
            const wf = this._current;
            if (!wf) return;
            const pid = e?.detail?.prompt_id;
            if (!pid || !wf.promptIds.has(String(pid))) return;
            if (e.type === "execution_success" || e.type === "execution_error" || e.type === "execution_interrupted") {
                wf.executed.add(String(pid));
                this._post(`/glowloader/wf/${wf.id}/executed`, { prompt_id: String(pid) }).catch(() => {});
            }
        };
        api.addEventListener("execution_success", handler);
        api.addEventListener("execution_error", handler);
        api.addEventListener("execution_interrupted", handler);
    },

    _startHeartbeat() {
        this._stopHeartbeat();
        const wf = this._current;
        if (!wf) return;
        this._heartbeatTimer = setInterval(async () => {
            try {
                const r = await this._post(`/glowloader/wf/${wf.id}/heartbeat`, {});
                if (!r?.ok) console.warn("[Coordinator] heartbeat lost (preempted or stale)");
            } catch (e) { /* ignore */ }
        }, 5000);
    },

    _stopHeartbeat() {
        if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    },

    _startAbortPoller() {
        this._stopAbortPoller();
        const wf = this._current;
        if (!wf) return;
        this._abortTimer = setInterval(async () => {
            try {
                const st = await this._get("/glowloader/wf/status");
                const me = (st.workflows || []).find(w => w.id === wf.id);
                if (!me || me.status === "aborted" || me.status === "stale") {
                    console.warn(`[Coordinator] workflow ${wf.id} is ${me?.status || "gone"}, stopping local enqueue`);
                    QueueManager.stop();
                }
            } catch (e) { /* ignore */ }
        }, 1000);
    },

    _stopAbortPoller() {
        if (this._abortTimer) { clearInterval(this._abortTimer); this._abortTimer = null; }
    },

    /**
     * Run a workflow to completion (enqueue + execute).
     * @param {string} name
     * @param {number} total
     * @param {(ctx: {report: (pid: string)=>void, isAborted: ()=>boolean}) => Promise<void>} enqueueFn
     * @returns {Promise<boolean>} true if completed, false if aborted/failed
     */
    async runWorkflow(name, total, enqueueFn) {
        this._installExecListeners();
        const reg = await this._post("/glowloader/wf/register", {
            name, total, tab_id: this._getTabId(),
        });
        if (reg?.error) throw new Error(reg.error);

        const wf = {
            id: reg.id, name, total: reg.total,
            promptIds: new Set(), executed: new Set(),
        };
        this._current = wf;

        // Wait until active
        while (true) {
            const st = await this._get("/glowloader/wf/status");
            const me = (st.workflows || []).find(w => w.id === wf.id);
            if (!me || me.status === "aborted") { this._current = null; return false; }
            if (st.active_id === wf.id) break;
            await new Promise(r => setTimeout(r, 1000));
        }

        this._startHeartbeat();
        this._startAbortPoller();
        QueueManager.resetAbort();

        try {
            await enqueueFn({
                report: (pid) => {
                    if (!pid) return;
                    wf.promptIds.add(String(pid));
                    this._post(`/glowloader/wf/${wf.id}/prompt`, { prompt_id: String(pid) }).catch(() => {});
                },
                isAborted: () => QueueManager.aborted,
            });
        } catch (e) {
            console.error("[Coordinator] enqueueFn error", e);
        }

        // Wait for execution to finish (or abort)
        while (this._current && wf.executed.size < wf.total) {
            if (QueueManager.aborted) {
                // confirm abort on backend
                await this._post(`/glowloader/wf/${wf.id}/abort`, {}).catch(() => {});
                break;
            }
            const st = await this._get("/glowloader/wf/status");
            const me = (st.workflows || []).find(w => w.id === wf.id);
            if (!me || me.status === "aborted" || me.status === "stale") break;
            await new Promise(r => setTimeout(r, 500));
        }

        // If we enqueued everything and it all executed, mark done
        if (wf.executed.size >= wf.total && wf.promptIds.size >= wf.total && !QueueManager.aborted) {
            await this._post(`/glowloader/wf/${wf.id}/done`, {}).catch(() => {});
        }

        this._stopHeartbeat();
        this._stopAbortPoller();
        this._current = null;
        return !QueueManager.aborted;
    },

    /** Local stop (existing stop buttons): also abort current workflow on backend + clear queue. */
    async requestLocalStop() {
        QueueManager.stop();
        const wf = this._current;
        if (wf) {
            try {
                const r = await this._post(`/glowloader/wf/${wf.id}/abort`, {});
                await this._deleteQueuePrompts(r?.prompt_ids || []);
                await api.fetchApi("/interrupt", { method: "POST" }).catch(() => {});
            } catch (e) { /* ignore */ }
        }
    },

    /** Panel-driven abort (possibly cross-tab). */
    async abortWorkflow(id) {
        const r = await this._post(`/glowloader/wf/${id}/abort`, {});
        await this._deleteQueuePrompts(r?.prompt_ids || []);
        await api.fetchApi("/interrupt", { method: "POST" }).catch(() => {});
        return r;
    },

    async abortBatch(ids) {
        const r = await this._post("/glowloader/wf/abort_batch", { ids });
        const all = [];
        for (const k of Object.keys(r || {})) all.push(...(r[k] || []));
        await this._deleteQueuePrompts(all);
        await api.fetchApi("/interrupt", { method: "POST" }).catch(() => {});
        return r;
    },

    async _deleteQueuePrompts(promptIds) {
        if (!promptIds || promptIds.length === 0) return;
        try {
            await api.fetchApi("/queue", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ delete: promptIds }),
            });
        } catch (e) { /* ignore */ }
    },

    async getStatus() {
        return this._get("/glowloader/wf/status");
    },

    get currentId() {
        return this._current?.id || null;
    },

    getTabId() {
        return this._getTabId();
    },
};

export { Coordinator };
