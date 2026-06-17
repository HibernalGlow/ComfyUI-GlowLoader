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
    },

    /** 重置中止标志（新一轮入队开始时调用） */
    resetAbort() {
        this._aborted = false;
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
        const resp = await api.queuePrompt(0, prompt);
        try {
            const json = await resp.json();
            return json?.prompt_id || null;
        } catch (e) {
            return null;
        }
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
