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
