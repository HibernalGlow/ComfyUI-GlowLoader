/**
 * 共享队列管理器 - 全局单例
 *
 * 解决多节点同时轮询队列导致的性能问题：
 * - 共享一次 prompt 序列化（app.graphToPrompt 很重）
 * - 共享一次队列大小轮询
 * - 多节点入队时串行执行，避免竞争
 */
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const QueueManager = {
    /** 是否有入队任务正在运行 */
    _running: false,

    /** 入队任务队列 */
    _queue: [],

    /** 缓存的 prompt（一次序列化，多次使用） */
    _cachedPrompt: null,
    _cacheExpiry: 0,

    /**
     * 获取序列化后的 prompt（500ms 内缓存）
     */
    async getPrompt() {
        const now = Date.now();
        if (this._cachedPrompt && now - this._cacheExpiry < 500) {
            return this._cachedPrompt;
        }
        this._cachedPrompt = await app.graphToPrompt();
        this._cacheExpiry = now;
        return this._cachedPrompt;
    },

    /** 清除 prompt 缓存（修改 widget 值后调用） */
    invalidatePromptCache() {
        this._cachedPrompt = null;
        this._cacheExpiry = 0;
    },

    /**
     * 获取当前队列大小
     */
    getQueueSize() {
        return app.ui?.lastQueueSize || 0;
    },

    /**
     * 等待队列有空位
     * @param {number} threshold - 队列阈值
     * @param {number} checkInterval - 检查间隔 ms
     * @param {number} targetSpace - 需要的空位数
     */
    async waitForSpace(threshold, checkInterval, targetSpace = 1) {
        const maxWaitTime = 300000;
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitTime) {
            const queueSize = this.getQueueSize();
            if (threshold - queueSize >= targetSpace) {
                return true;
            }
            console.log(`[QueueManager] 队列已满 (${queueSize}/${threshold})，等待 ${checkInterval}ms...`);
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }

        console.warn(`[QueueManager] 等待队列空位超时，继续执行...`);
        return false;
    },

    /**
     * 入队一个 prompt（串行执行，避免并发问题）
     */
    async enqueuePrompt(prompt) {
        await api.queuePrompt(-1, prompt);
    },

    /**
     * 深拷贝
     */
    deepClone(obj) {
        if (typeof structuredClone === "function") return structuredClone(obj);
        return JSON.parse(JSON.stringify(obj));
    },
};

export { QueueManager };
