# 跨工作流串行入队 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让多个 ComfyUI 标签页的 GlowLoader 批量入队共用一个串行队列——先点击入队的工作流把所有 prompt 入队并执行完成后，后续工作流才开始入队；并提供浮动面板 + 图内节点双形态查看/控制（多选、一键停止、清空）。

**Architecture:** 后端在 `__init__.py` 注册一个内存态 `WorkflowRegistry`（单例，线程安全），作为跨标签页的协调源：管理 waiting/active/done/aborted 状态机 + 心跳租约。前端新增 `workflow_coordinator.js` 封装 API 并改造入队按钮为 register→等 active→入队(上报 prompt_id)→监听 execution 事件→done。执行完成检测在前端（每个 tab 监听自己收到的 WebSocket execution 事件），后端只管锁与注册表；tab 异常关闭靠心跳超时降级（FIFO 仍保序，状态短暂标 stale）。新增浮动面板 `workflow_panel.js` 与图内节点 `BatchWorkflowMonitor`。

**Tech Stack:** Python (aiohttp routes via PromptServer), vanilla JS (ComfyUI frontend extensions), pytest.

---

## File Structure

**Backend (Python):**
- Create: `workflow_registry.py` — `WorkflowRegistry` 纯逻辑类（线程安全，可单测）+ `get_registry()` 单例 + `register_routes(app)` 路由注册函数。
- Create: `workflow_monitor.py` — `BatchWorkflowMonitor` 透传节点（图内状态显示用）。
- Modify: `__init__.py` — 导入并注册路由 + 节点映射。
- Create: `tests/test_workflow_registry.py` — `WorkflowRegistry` 单测。

**Frontend (JS, all under `web/`):**
- Create: `workflow_coordinator.js` — API 客户端 + 入队编排 + execution 事件追踪。
- Create: `workflow_panel.js` — 全局浮动面板（轮询 /status，多选，一键停止，清空）。
- Create: `workflow_monitor.js` — `BatchWorkflowMonitor` 节点的 DOM widget 扩展。
- Modify: `queue_manager.js` — `enqueuePrompt` 返回 `prompt_id`；新增 `Coordinator` 钩子。
- Modify: `batch_load_images.js` — 入队按钮走 `Coordinator.runWorkflow`。
- Modify: `batch_load_texts.js` — 入队按钮走 `Coordinator.runWorkflow`。

---

## Task 1: 后端 WorkflowRegistry 核心逻辑（TDD）

**Files:**
- Create: `workflow_registry.py`
- Test: `tests/test_workflow_registry.py`

- [ ] **Step 1: 写失败测试**

Create `tests/test_workflow_registry.py`:

```python
"""Tests for WorkflowRegistry."""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from workflow_registry import WorkflowRegistry


class TestRegister:
    def test_first_workflow_becomes_active(self):
        r = WorkflowRegistry()
        wf = r.register("wf-a", total=5, tab_id="t1")
        assert wf["status"] == "active"
        assert wf["total"] == 5
        assert wf["enqueued"] == 0
        assert wf["executed"] == 0
        assert wf["id"]

    def test_second_workflow_waits(self):
        r = WorkflowRegistry()
        a = r.register("wf-a", 5, "t1")
        b = r.register("wf-b", 3, "t2")
        assert a["status"] == "active"
        assert b["status"] == "waiting"
        st = r.get_status()
        assert st["active_id"] == a["id"]


class TestDone:
    def test_done_activates_next(self):
        r = WorkflowRegistry()
        a = r.register("wf-a", 2, "t1")
        b = r.register("wf-b", 2, "t2")
        assert r.mark_done(a["id"]) is True
        st = r.get_status()
        assert st["active_id"] == b["id"]
        assert st["workflows"][0]["status"] == "done"
        assert st["workflows"][1]["status"] == "active"

    def test_done_unknown_returns_false(self):
        r = WorkflowRegistry()
        assert r.mark_done("nope") is False


class TestPromptTracking:
    def test_record_prompt_increments_enqueued(self):
        r = WorkflowRegistry()
        a = r.register("wf-a", 2, "t1")
        assert r.record_prompt(a["id"], "pid-1") is True
        assert r.record_prompt(a["id"], "pid-2") is True
        st = r.get_status()
        assert st["workflows"][0]["enqueued"] == 2

    def test_record_executed_increments_executed(self):
        r = WorkflowRegistry()
        a = r.register("wf-a", 2, "t1")
        r.record_prompt(a["id"], "pid-1")
        r.record_prompt(a["id"], "pid-2")
        r.record_executed(a["id"], "pid-1")
        r.record_executed(a["id"], "pid-1")  # idempotent
        assert r.get_status()["workflows"][0]["executed"] == 1
        r.record_executed(a["id"], "pid-2")
        assert r.get_status()["workflows"][0]["executed"] == 2


class TestAbort:
    def test_abort_returns_prompt_ids_and_activates_next(self):
        r = WorkflowRegistry()
        a = r.register("wf-a", 2, "t1")
        b = r.register("wf-b", 2, "t2")
        r.record_prompt(a["id"], "pid-1")
        r.record_prompt(a["id"], "pid-2")
        ids = r.abort(a["id"])
        assert ids == ["pid-1", "pid-2"]
        st = r.get_status()
        assert st["active_id"] == b["id"]
        assert st["workflows"][0]["status"] == "aborted"

    def test_abort_batch(self):
        r = WorkflowRegistry()
        a = r.register("wf-a", 1, "t1")
        b = r.register("wf-b", 1, "t2")
        c = r.register("wf-c", 1, "t3")
        r.record_prompt(a["id"], "pa")
        r.record_prompt(b["id"], "pb")
        result = r.abort_batch([a["id"], c["id"]])
        assert result[a["id"]] == ["pa"]
        assert result[c["id"]] == []
        st = r.get_status()
        by_id = {w["id"]: w for w in st["workflows"]}
        assert by_id[a["id"]]["status"] == "aborted"
        assert by_id[c["id"]]["status"] == "aborted"
        # b was waiting; after a aborted, b should become active
        assert st["active_id"] == b["id"]


class TestHeartbeat:
    def test_heartbeat_resets_lease(self):
        r = WorkflowRegistry(lease_timeout=0.5)
        a = r.register("wf-a", 1, "t1")
        time.sleep(0.3)
        assert r.heartbeat(a["id"]) is True
        time.sleep(0.3)
        # would have expired without heartbeat, but heartbeat extended it
        st = r.get_status()
        assert st["active_id"] == a["id"]

    def test_stale_active_released_and_next_promoted(self):
        r = WorkflowRegistry(lease_timeout=0.3)
        a = r.register("wf-a", 1, "t1")
        b = r.register("wf-b", 1, "t2")
        time.sleep(0.4)
        st = r.get_status()  # triggers expiry check
        assert st["active_id"] == b["id"]
        by_id = {w["id"]: w for w in st["workflows"]}
        assert by_id[a["id"]]["status"] == "stale"

    def test_heartbeat_non_active_returns_false(self):
        r = WorkflowRegistry()
        a = r.register("wf-a", 1, "t1")
        b = r.register("wf-b", 1, "t2")
        assert r.heartbeat(b["id"]) is False


class TestStatusOrder:
    def test_status_preserves_registration_order(self):
        r = WorkflowRegistry()
        r.register("wf-a", 1, "t1")
        r.register("wf-b", 1, "t2")
        r.register("wf-c", 1, "t3")
        st = r.get_status()
        assert [w["name"] for w in st["workflows"]] == ["wf-a", "wf-b", "wf-c"]
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pytest tests/test_workflow_registry.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'workflow_registry'`

- [ ] **Step 3: 实现 WorkflowRegistry**

Create `workflow_registry.py`:

```python
"""In-memory registry coordinating batch enqueue workflows across ComfyUI tabs.

Only one workflow is 'active' (enqueueing + executing) at a time. Others wait.
The active workflow must heartbeat; if it dies the lock is released after a
lease timeout. Already-enqueued prompts remain in ComfyUI's FIFO queue, so
execution order is preserved even when the active tab dies — only the status
display becomes briefly inaccurate until the lease expires.
"""
import threading
import time
import uuid


class WorkflowRegistry:
    def __init__(self, lease_timeout=15.0):
        self._lock = threading.Lock()
        self._workflows = {}  # id -> dict
        self._order = []  # workflow ids in registration order
        self._active_id = None
        self.lease_timeout = lease_timeout

    # -- internal helpers (must be called with lock held) --

    def _expire_stale_locked(self):
        if self._active_id and self._active_id in self._workflows:
            wf = self._workflows[self._active_id]
            if time.time() - wf["last_heartbeat"] > self.lease_timeout:
                wf["status"] = "stale"
                self._active_id = None
                self._activate_next_locked()

    def _activate_next_locked(self):
        for wid in self._order:
            wf = self._workflows.get(wid)
            if wf and wf["status"] == "waiting":
                wf["status"] = "active"
                wf["last_heartbeat"] = time.time()
                self._active_id = wid
                return
        self._active_id = None

    def _public_locked(self, wid):
        wf = self._workflows.get(wid)
        if not wf:
            return None
        return {
            "id": wf["id"],
            "name": wf["name"],
            "tab_id": wf["tab_id"],
            "total": wf["total"],
            "enqueued": wf["enqueued"],
            "executed": wf["executed"],
            "status": wf["status"],
            "created_at": wf["created_at"],
            "last_heartbeat": wf["last_heartbeat"],
        }

    # -- public API --

    def register(self, name, total, tab_id):
        with self._lock:
            self._expire_stale_locked()
            wid = str(uuid.uuid4())
            wf = {
                "id": wid,
                "name": name,
                "tab_id": tab_id,
                "total": int(total),
                "enqueued": 0,
                "executed": 0,
                "prompt_ids": [],
                "_executed_set": set(),
                "status": "waiting",
                "created_at": time.time(),
                "last_heartbeat": time.time(),
            }
            self._workflows[wid] = wf
            self._order.append(wid)
            if self._active_id is None:
                self._activate_next_locked()
            return self._public_locked(wid)

    def heartbeat(self, wid):
        with self._lock:
            self._expire_stale_locked()
            wf = self._workflows.get(wid)
            if not wf or wid != self._active_id or wf["status"] != "active":
                return False
            wf["last_heartbeat"] = time.time()
            return True

    def record_prompt(self, wid, prompt_id):
        with self._lock:
            wf = self._workflows.get(wid)
            if not wf:
                return False
            wf["prompt_ids"].append(str(prompt_id))
            wf["enqueued"] = len(wf["prompt_ids"])
            return True

    def record_executed(self, wid, prompt_id):
        with self._lock:
            wf = self._workflows.get(wid)
            if not wf:
                return False
            s = wf["_executed_set"]
            if str(prompt_id) in s:
                return True
            s.add(str(prompt_id))
            wf["executed"] = len(s)
            return True

    def mark_done(self, wid):
        with self._lock:
            wf = self._workflows.get(wid)
            if not wf:
                return False
            wf["status"] = "done"
            if wid == self._active_id:
                self._active_id = None
                self._activate_next_locked()
            return True

    def abort(self, wid):
        with self._lock:
            wf = self._workflows.get(wid)
            if not wf:
                return None
            wf["status"] = "aborted"
            if wid == self._active_id:
                self._active_id = None
                self._activate_next_locked()
            return list(wf["prompt_ids"])

    def abort_batch(self, wids):
        result = {}
        with self._lock:
            for wid in wids:
                wf = self._workflows.get(wid)
                if not wf:
                    result[wid] = []
                    continue
                wf["status"] = "aborted"
                if wid == self._active_id:
                    self._active_id = None
                    self._activate_next_locked()
                result[wid] = list(wf["prompt_ids"])
        return result

    def get_status(self):
        with self._lock:
            self._expire_stale_locked()
            return {
                "active_id": self._active_id,
                "workflows": [self._public_locked(wid) for wid in self._order if wid in self._workflows],
            }

    def get_prompt_ids(self, wid):
        with self._lock:
            wf = self._workflows.get(wid)
            return list(wf["prompt_ids"]) if wf else []


_registry = None


def get_registry():
    global _registry
    if _registry is None:
        _registry = WorkflowRegistry()
    return _registry
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pytest tests/test_workflow_registry.py -v`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add workflow_registry.py tests/test_workflow_registry.py
git commit -m "feat(workflow-queue): add thread-safe WorkflowRegistry with lease/heartbeat"
```

---

## Task 2: 后端 HTTP 路由注册

**Files:**
- Modify: `__init__.py`

- [ ] **Step 1: 在 `__init__.py` 顶部导入后添加路由注册**

在 `__init__.py` 现有 `from .llm_chat import ...` 块之后、`try: from server import PromptServer` 之前，新增导入：

```python
try:
    from .workflow_registry import get_registry
    from .workflow_monitor import BatchWorkflowMonitor
except ImportError:
    get_registry = None
    BatchWorkflowMonitor = None
```

- [ ] **Step 2: 在 `if PromptServer is not None:` 块内追加工作流队列路由**

在 `__init__.py` 的 `api_generate_sequence_texts` 路由之后（仍在 `if PromptServer is not None:` 块内）追加：

```python
    if get_registry is not None:
        import json as _json

        @PromptServer.instance.routes.post("/glowloader/wf/register")
        async def wf_register(request):
            try:
                data = await request.json()
                wf = get_registry().register(
                    data.get("name", "workflow"),
                    data.get("total", 0),
                    data.get("tab_id", ""),
                )
                return web.json_response(wf)
            except Exception as e:
                return web.json_response({"error": str(e)}, status=500)

        @PromptServer.instance.routes.post("/glowloader/wf/{wid}/heartbeat")
        async def wf_heartbeat(request):
            wid = request.match_info.get("wid")
            ok = get_registry().heartbeat(wid)
            return web.json_response({"ok": ok})

        @PromptServer.instance.routes.post("/glowloader/wf/{wid}/prompt")
        async def wf_prompt(request):
            wid = request.match_info.get("wid")
            try:
                data = await request.json()
                ok = get_registry().record_prompt(wid, data.get("prompt_id", ""))
                return web.json_response({"ok": ok})
            except Exception as e:
                return web.json_response({"error": str(e)}, status=500)

        @PromptServer.instance.routes.post("/glowloader/wf/{wid}/executed")
        async def wf_executed(request):
            wid = request.match_info.get("wid")
            try:
                data = await request.json()
                ok = get_registry().record_executed(wid, data.get("prompt_id", ""))
                return web.json_response({"ok": ok})
            except Exception as e:
                return web.json_response({"error": str(e)}, status=500)

        @PromptServer.instance.routes.post("/glowloader/wf/{wid}/done")
        async def wf_done(request):
            wid = request.match_info.get("wid")
            ok = get_registry().mark_done(wid)
            return web.json_response({"ok": ok})

        @PromptServer.instance.routes.post("/glowloader/wf/{wid}/abort")
        async def wf_abort(request):
            wid = request.match_info.get("wid")
            prompt_ids = get_registry().abort(wid) or []
            return web.json_response({"prompt_ids": prompt_ids})

        @PromptServer.instance.routes.post("/glowloader/wf/abort_batch")
        async def wf_abort_batch(request):
            try:
                data = await request.json()
                ids = data.get("ids", [])
                result = get_registry().abort_batch(ids)
                return web.json_response(result)
            except Exception as e:
                return web.json_response({"error": str(e)}, status=500)

        @PromptServer.instance.routes.get("/glowloader/wf/status")
        async def wf_status(request):
            return web.json_response(get_registry().get_status())
```

- [ ] **Step 3: 在 `NODE_CLASS_MAPPINGS` / `NODE_DISPLAY_NAME_MAPPINGS` 中注册监控节点**

修改 `__init__.py` 的 `NODE_CLASS_MAPPINGS`，在 `"GlowApplyChatTemplate": GlowApplyChatTemplate,` 之后追加：

```python
    "BatchWorkflowMonitor": BatchWorkflowMonitor,
```

修改 `NODE_DISPLAY_NAME_MAPPINGS`，在 `"GlowApplyChatTemplate": ...` 行之后追加：

```python
    "BatchWorkflowMonitor": "GlowLoader 工作流监控",
```

- [ ] **Step 4: 手动验证路由可达（需 ComfyUI 运行）**

Run (ComfyUI 启动后):
```bash
curl -s http://127.0.0.1:8188/glowloader/wf/status
```
Expected: `{"active_id": null, "workflows": []}`

- [ ] **Step 5: Commit**

```bash
git add __init__.py
git commit -m "feat(workflow-queue): register workflow registry HTTP routes + monitor node mapping"
```

---

## Task 3: BatchWorkflowMonitor 透传节点（Python 侧）

**Files:**
- Create: `workflow_monitor.py`

- [ ] **Step 1: 实现透传节点**

Create `workflow_monitor.py`:

```python
"""BatchWorkflowMonitor — a passthrough node whose real job is to host a DOM
widget (registered from web/workflow_monitor.js) that displays the current
tab's workflow status. It passes its optional trigger input through unchanged
so it can sit anywhere in the graph without affecting execution.
"""


class BatchWorkflowMonitor:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "trigger": ("*",),
            },
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("trigger",)
    FUNCTION = "execute"
    CATEGORY = "GlowLoader"

    def execute(self, trigger=None):
        return (trigger,)
```

- [ ] **Step 2: 验证导入无误**

Run: `python -c "import sys; sys.path.insert(0, r'D:\1Repo\Github\ComfyUI\Library\custom_nodes\ComfyUI-GlowLoader'); from workflow_monitor import BatchWorkflowMonitor; print(BatchWorkflowMonitor.INPUT_TYPES())"`
Expected: prints dict with `optional.trigger`

- [ ] **Step 3: Commit**

```bash
git add workflow_monitor.py
git commit -m "feat(workflow-queue): add BatchWorkflowMonitor passthrough node"
```

---

## Task 4: 前端 Coordinator — API 客户端 + 编排

**Files:**
- Create: `web/workflow_coordinator.js`

- [ ] **Step 1: 实现 Coordinator**

Create `web/workflow_coordinator.js`:

```javascript
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
};

export { Coordinator };
```

- [ ] **Step 2: 手动验证（ComfyUI 运行时，浏览器控制台）**

在 ComfyUI 页面控制台执行：
```js
const { Coordinator } = await import("/extensions/ComfyUI-GlowLoader/workflow_coordinator.js");
const st = await Coordinator.getStatus();
console.log(st); // { active_id: null, workflows: [] }
```
Expected: 打印空状态对象

- [ ] **Step 3: Commit**

```bash
git add web/workflow_coordinator.js
git commit -m "feat(workflow-queue): add frontend Coordinator (register/heartbeat/abort/exec-tracking)"
```

---

## Task 5: queue_manager.js — enqueuePrompt 返回 prompt_id

**Files:**
- Modify: `web/queue_manager.js`

- [ ] **Step 1: 修改 `enqueuePrompt` 返回 prompt_id**

在 `web/queue_manager.js` 中，将：

```javascript
    async enqueuePrompt(prompt) {
        await api.queuePrompt(0, prompt);
    },
```

替换为：

```javascript
    async enqueuePrompt(prompt) {
        const resp = await api.queuePrompt(0, prompt);
        try {
            const json = await resp.json();
            return json?.prompt_id || null;
        } catch (e) {
            return null;
        }
    },
```

- [ ] **Step 2: 验证无语法错误**

在浏览器控制台执行：
```js
const { QueueManager } = await import("/extensions/ComfyUI-GlowLoader/queue_manager.js");
console.log(typeof QueueManager.enqueuePrompt);
```
Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add web/queue_manager.js
git commit -m "feat(workflow-queue): enqueuePrompt returns prompt_id for tracking"
```

---

## Task 6: batch_load_images.js — 入队按钮走 Coordinator

**Files:**
- Modify: `web/batch_load_images.js`

- [ ] **Step 1: 顶部导入 Coordinator**

在 `web/batch_load_images.js` 第 3 行 `import { QueueManager } from "./queue_manager.js";` 之后新增：

```javascript
import { Coordinator } from "./workflow_coordinator.js";
```

- [ ] **Step 2: 改造 `queueAllSequential` 接受 report 回调**

在 `web/batch_load_images.js` 的 `queueAllSequential` 函数中，把签名：

```javascript
async function queueAllSequential(node) {
```

改为：

```javascript
async function queueAllSequential(node, report) {
```

把该函数内两处 `await QueueManager.enqueuePrompt(prompt);`（第一处在 `if (!wMode || !wIndex)` 分支，第二处在末尾 `await queueCurrent(node);` 之前的循环里——实际是 `await queueCurrent(node);` 这行）改为上报 prompt_id。

具体：
- 第一处（`if (!wMode || !wIndex)` 分支内的 `await QueueManager.enqueuePrompt(prompt);`）替换为：

```javascript
                const pid = await QueueManager.enqueuePrompt(prompt);
                if (report) report(pid);
```

- 第二处（`!wMode || !wIndex` 分支之后的循环里的 `await queueCurrent(node);`）替换为：

```javascript
                const pid = await QueueManager.enqueuePrompt(await QueueManager.getPrompt());
                if (report) report(pid);
```

  注意：原 `queueCurrent(node)` 内部就是 `getPrompt` + `enqueuePrompt`。这里展开以拿 pid。删除该循环里原来的 `await queueCurrent(node);` 行。

- [ ] **Step 3: 同样改造 `queueAllShuffled`**

在 `queueAllShuffled` 签名加 `report` 参数：

```javascript
async function queueAllShuffled(node, report) {
```

同样替换两处 `await QueueManager.enqueuePrompt(prompt);` 与 `await queueCurrent(node);`（与 Step 2 相同模式）。

- [ ] **Step 4: 新增 `runQueueWorkflow` 包装函数**

在 `queueAllShuffled` 函数定义之后新增：

```javascript
async function runQueueWorkflow(node, shuffle) {
    const names0 = parseImageList(getImageListWidget(node)?.value);
    if (!names0 || names0.length === 0) return;
    const maxImages = getMaxImagesValue(node);
    const names = maxImages && maxImages > 0 ? names0.slice(0, maxImages) : names0;
    const queueCount = getQueueCountValue(node);
    const total = queueCount > 0 ? queueCount : names.length;
    if (total <= 0) return;

    const name = `Images#${node.id} (${total})`;
    await Coordinator.runWorkflow(name, total, async ({ report, isAborted }) => {
        if (shuffle) {
            await queueAllShuffled(node, report);
        } else {
            await queueAllSequential(node, report);
        }
    });
}
```

- [ ] **Step 5: 改造按钮 onclick 与停止按钮**

在 `createBrowserUI` 中：
- `queueBtn.onclick`：`await queueAllSequential(node);` → `await runQueueWorkflow(node, false);`
- `queueShuffleBtn.onclick`：`await queueAllShuffled(node);` → `await runQueueWorkflow(node, true);`
- `stopBtn.onclick`：`QueueManager.stop();` → `Coordinator.requestLocalStop();`

- [ ] **Step 6: 手动验证**

在 ComfyUI 中给一个 BatchLoadImages 节点选几张图，点"逐张入队"。观察：
1. 浏览器控制台出现 `[Coordinator]` 注册日志
2. `/glowloader/wf/status` 返回该工作流 status=active
3. 入队完成后等待执行完成，status 变 done

Run: `curl -s http://127.0.0.1:8188/glowloader/wf/status`
Expected: workflows 列表含该工作流，最终 status=done

- [ ] **Step 7: Commit**

```bash
git add web/batch_load_images.js
git commit -m "feat(workflow-queue): route BatchLoadImages enqueue through Coordinator"
```

---

## Task 7: batch_load_texts.js — 入队按钮走 Coordinator

**Files:**
- Modify: `web/batch_load_texts.js`

- [ ] **Step 1: 顶部导入 Coordinator**

在 `web/batch_load_texts.js` 第 3 行 `import { QueueManager } from "./queue_manager.js";` 之后新增：

```javascript
import { Coordinator } from "./workflow_coordinator.js";
```

- [ ] **Step 2: 改造 `queueAllSequential` 与 `queueAllShuffled` 接受 report**

在 `batch_load_texts.js` 中：
- `async function queueAllSequential(node) {` → `async function queueAllSequential(node, report) {`
- `async function queueAllShuffled(node) {` → `async function queueAllShuffled(node, report) {`

两个函数内都有两处入队调用：
- `await QueueManager.enqueuePrompt(prompt);`（在 `if (!wIndex)` 分支内）→ 替换为：

```javascript
                    const pid = await QueueManager.enqueuePrompt(prompt);
                    if (report) report(pid);
```

- `await queueCurrent(node);`（循环末尾）→ 替换为：

```javascript
                    const pid = await QueueManager.enqueuePrompt(await QueueManager.getPrompt());
                    if (report) report(pid);
```

  删除原 `await queueCurrent(node);` 行。

- [ ] **Step 3: 新增 `runQueueWorkflow` 包装**

在 `queueAllShuffled` 定义之后新增：

```javascript
async function runQueueWorkflow(node, shuffle) {
    const texts0 = parseTextList(getTextListWidget(node)?.value);
    if (!texts0 || texts0.length === 0) return;
    const maxTexts = getMaxTextsValue(node);
    const texts = maxTexts && maxTexts > 0 ? texts0.slice(0, maxTexts) : texts0;
    const queueCount = getQueueCountValue(node);
    const total = queueCount > 0 ? queueCount : texts.length;
    if (total <= 0) return;

    const name = `Texts#${node.id} (${total})`;
    await Coordinator.runWorkflow(name, total, async ({ report }) => {
        if (shuffle) {
            await queueAllShuffled(node, report);
        } else {
            await queueAllSequential(node, report);
        }
    });
}
```

- [ ] **Step 4: 改造按钮 onclick 与停止按钮**

在 `createTextListUI` 中：
- `queueBtn.onclick`：`await queueAllSequential(node);` → `await runQueueWorkflow(node, false);`
- `queueShuffleBtn.onclick`：`await queueAllShuffled(node);` → `await runQueueWorkflow(node, true);`
- `stopBtn.onclick`：`QueueManager.stop();` → `Coordinator.requestLocalStop();`

- [ ] **Step 5: 手动验证**

同 Task 6 Step 6，但用 BatchLoadTexts 节点。

- [ ] **Step 6: Commit**

```bash
git add web/batch_load_texts.js
git commit -m "feat(workflow-queue): route BatchLoadTexts enqueue through Coordinator"
```

---

## Task 8: 浮动面板 workflow_panel.js

**Files:**
- Create: `web/workflow_panel.js`

- [ ] **Step 1: 实现浮动面板**

Create `web/workflow_panel.js`:

```javascript
import { app } from "../../../scripts/app.js";
import { Coordinator } from "./workflow_coordinator.js";

const POLL_INTERVAL = 1000;

let panelEl = null;
let pollTimer = null;
let selected = new Set();

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
    const clearBtn = mkBtn("清空已完成", async () => {
        // done/aborted/stale are terminal; clearing is purely visual —
        // we just hide them locally. Backend keeps them (session-level).
        const rows = panelEl.querySelectorAll("tr[data-status='done'], tr[data-status='aborted'], tr[data-status='stale']");
        rows.forEach(r => r.remove());
    });
    toolbar.appendChild(stopSelBtn);
    toolbar.appendChild(clearBtn);

    const tableWrap = document.createElement("div");
    tableWrap.style.cssText = "max-height:40vh;overflow:auto;";
    tableWrap.innerHTML = `<table style="width:100%;border-collapse:collapse;">
        <thead><tr style="text-align:left;border-bottom:1px solid var(--border-color);">
            <th style="padding:4px;width:20px;"></th>
            <th style="padding:4px;">名称</th>
            <th style="padding:4px;">状态</th>
            <th style="padding:4px;">进度</th>
            <th style="padding:4px;">操作</th>
        </tr></thead>
        <tbody id="glowloader-wf-tbody"></tbody>
    </table>`;
    tableWrap.querySelector("#glowloader-wf-tbody").id = "";

    panelEl.appendChild(header);
    panelEl.appendChild(toolbar);
    panelEl.appendChild(tableWrap);
    document.body.appendChild(panelEl);

    // toggle button (separate, always visible)
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
    const workflows = st.workflows || [];
    tbody.innerHTML = "";
    const frag = document.createDocumentFragment();
    workflows.forEach(wf => {
        const tr = document.createElement("tr");
        tr.dataset.status = wf.status;
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

        const opTd = document.createElement("td"); opTd.style.padding = "4px";
        if (!isTerminal) {
            const stopOne = document.createElement("button");
            stopOne.textContent = "⏹";
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
```

- [ ] **Step 2: 手动验证**

ComfyUI 启动后，左下角出现"☰ 队列"按钮。点击展开面板。在另一个 BatchLoadImages 节点点"逐张入队"，面板内出现该工作流行，状态从 active → done。勾选多行后点"⏹ 停止选中"可中止。

- [ ] **Step 3: Commit**

```bash
git add web/workflow_panel.js
git commit -m "feat(workflow-queue): add floating workflow panel (multi-select, stop, clear)"
```

---

## Task 9: 图内监控节点 workflow_monitor.js

**Files:**
- Create: `web/workflow_monitor.js`

- [ ] **Step 1: 实现监控节点 DOM widget**

Create `web/workflow_monitor.js`:

```javascript
import { app } from "../../../scripts/app.js";
import { Coordinator } from "./workflow_coordinator.js";

function createMonitorUI(node) {
    const container = document.createElement("div");
    container.style.cssText =
        "width:100%;padding:8px;background:var(--comfy-menu-bg);border:1px solid var(--border-color);border-radius:6px;margin:5px 0;pointer-events:auto;font-size:12px;";

    const title = document.createElement("div");
    title.textContent = "本标签页工作流状态";
    title.style.cssText = "font-weight:bold;margin-bottom:6px;";

    const body = document.createElement("div");
    body.style.cssText = "max-height:200px;overflow:auto;background:var(--comfy-input-bg);padding:6px;border-radius:4px;";

    container.appendChild(title);
    container.appendChild(body);

    const redraw = async () => {
        const tabId = Coordinator._getTabId();
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
            row.style.cssText = "display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border-color);";
            const left = document.createElement("span");
            left.textContent = wf.name;
            const right = document.createElement("span");
            right.textContent = `${wf.status} · ${wf.executed}/${wf.total}`;
            right.style.opacity = "0.85";
            row.appendChild(left); row.appendChild(right);
            frag.appendChild(row);
        }
        body.appendChild(frag);
    };

    // poll while node exists
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
```

- [ ] **Step 2: 手动验证**

在 ComfyUI 中右键添加"GlowLoader 工作流监控"节点。节点内显示"本标签页工作流状态"。在同一标签页的 BatchLoadImages 点入队，监控节点内出现该工作流及进度。

- [ ] **Step 3: Commit**

```bash
git add web/workflow_monitor.js
git commit -m "feat(workflow-queue): add in-graph BatchWorkflowMonitor DOM widget"
```

---

## Task 10: 跨标签页串行验证 + 边缘场景

**Files:** 无（仅验证）

- [ ] **Step 1: 跨标签页串行验证**

1. 打开两个 ComfyUI 标签页（同一浏览器，同源）。
2. 标签页 A 加载 BatchLoadImages，选 10 张图，点"逐张入队"。
3. 立即切到标签页 B，加载 BatchLoadImages，选 10 张图，点"逐张入队"。
4. 打开浮动面板观察：
   - A 的工作流 status=active，B 的 status=waiting。
   - A 的全部 10 张入队并执行完成后（executed==10），A 变 done，B 变 active。
   - B 开始入队并执行。
5. 验证后端队列顺序：A 的 10 个 prompt 全部排在 B 的之前（FIFO）。

Run: `curl -s http://127.0.0.1:8188/glowloader/wf/status | python -m json.tool`
Expected: A.status=done, B.status=active（A 完成后）

- [ ] **Step 2: 中止验证**

1. 标签页 A 点入队 20 张。
2. 浮动面板勾选 A 的工作流，点"⏹ 停止选中"。
3. 观察：A.status=aborted；A 未执行的 prompt 从后端队列删除（`/queue` 不再含它们）；当前正在执行的 1 个被 interrupt。
4. 若 B 在 waiting，B 升为 active。

- [ ] **Step 3: 心跳降级验证**

1. 标签页 A 点入队 50 张（active）。
2. 关闭标签页 A（不点停止）。
3. 等待 >15s（默认 lease_timeout）。
4. 标签页 B 的面板轮询：A.status 变 stale；若 B 在 waiting，B 升 active。
5. 验证 A 已入队的 prompt 仍在后端队列按原顺序执行（FIFO 保序）。

- [ ] **Step 4: 回归测试**

Run: `pytest tests/ -v`
Expected: 全部通过（含原有 test_batch_nodes / test_batch_load_texts 与新 test_workflow_registry）

- [ ] **Step 5: 最终 Commit（如有遗漏修复）**

```bash
git add -A
git commit -m "test(workflow-queue): verify cross-tab serialization, abort, heartbeat degradation"
```

---

## Self-Review Notes

- **Spec coverage**: 跨标签页共用串行队列 ✓（Task 1-2,4,6,7）；先入队工作流执行完成后其他才入队 ✓（Coordinator runWorkflow 等待 active + 等待 executed==total）；浮动面板查看/控制/多选/一键停止 ✓（Task 8）；图内节点 ✓（Task 3,9）。
- **Placeholder scan**: 所有代码块均为完整实现，无 TODO/TBD。
- **Type consistency**: `Coordinator.runWorkflow(name, total, enqueueFn)`、`enqueueFn({report, isAborted})`、`report(pid)`、`QueueManager.enqueuePrompt` 返回 prompt_id —— 在 Task 4/5/6/7 中签名一致。
- **已知边缘**：tab 关闭后状态短暂 stale（≤15s），FIFO 保序，符合方案约定。
