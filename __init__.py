try:
    from .batch_load_images import BatchLoadImages, BatchSaveImages, VNCCS_PositionControl, VNCCS_VisualPositionControl
    from .batch_load_texts import BatchLoadTexts
except ImportError:
    # Allow import outside ComfyUI (e.g. pytest with direct module imports)
    BatchLoadImages = None
    BatchSaveImages = None
    BatchLoadTexts = None
    VNCCS_PositionControl = None
    VNCCS_VisualPositionControl = None

try:
    from .llm_chat import GlowAPILLMLoader, GlowExtraParameters, GlowAPIChat, GlowCaptioner, GlowGenerateBBOX, GlowApplyChatTemplate
except ImportError:
    GlowAPILLMLoader = None
    GlowExtraParameters = None
    GlowAPIChat = None
    GlowCaptioner = None
    GlowGenerateBBOX = None
    GlowApplyChatTemplate = None

try:
    from server import PromptServer  # type: ignore
    from aiohttp import web
except ImportError:
    PromptServer = None
    web = None

WEB_DIRECTORY = "./web"


class GlowBatchCoordinator:
    def __init__(self):
        self.batches = []
        self.by_id = {}
        self.worker_task = None
        self.lock = None

    def _ensure_lock(self):
        import asyncio
        if self.lock is None:
            self.lock = asyncio.Lock()

    def _ensure_worker(self):
        import asyncio
        self._ensure_lock()
        if self.worker_task is None or self.worker_task.done():
            self.worker_task = asyncio.create_task(self._worker())

    def _public_batch(self, batch):
        return {
            "batch_id": batch["batch_id"],
            "node_id": batch.get("node_id"),
            "node_title": batch.get("node_title", ""),
            "workflow_id": batch.get("workflow_id", ""),
            "workflow_label": batch.get("workflow_label", ""),
            "label": batch.get("label", ""),
            "status": batch["status"],
            "threshold": batch["threshold"],
            "submitted": batch["submitted"],
            "total": len(batch["prompts"]),
            "completed": batch["completed"],
            "queue": dict(batch.get("queue_counts") or {"pending": 0, "running": 0, "total": 0}),
            "prompt_ids": list(batch["prompt_ids"]),
            "error": batch.get("error", ""),
            "created_at": batch.get("created_at"),
            "started_at": batch.get("started_at"),
            "completed_at": batch.get("completed_at"),
            "paused_at": batch.get("paused_at"),
        }

    async def submit(self, request, data):
        import time
        import uuid

        prompts = data.get("prompts") or []
        if not isinstance(prompts, list) or len(prompts) == 0:
            raise ValueError("prompts must be a non-empty list")

        threshold = int(data.get("threshold") or 1)
        threshold = max(1, min(1000, threshold))
        check_interval_ms = int(data.get("check_interval_ms") or 1000)
        check_interval_ms = max(100, min(60000, check_interval_ms))

        batch_id = str(uuid.uuid4())
        batch = {
            "batch_id": batch_id,
            "node_id": str(data.get("node_id", "")),
            "node_title": str(data.get("node_title", "")),
            "workflow_id": str(data.get("workflow_id", "")),
            "workflow_label": str(data.get("workflow_label", "")),
            "label": str(data.get("label", "")),
            "base_url": f"{request.scheme}://{request.host}",
            "client_id": data.get("client_id"),
            "threshold": threshold,
            "check_interval_ms": check_interval_ms,
            "prompts": prompts,
            "submitted": 0,
            "completed": 0,
            "queue_counts": {"pending": 0, "running": 0, "total": 0},
            "prompt_ids": [],
            "status": "queued",
            "error": "",
            "created_at": time.time(),
            "started_at": None,
            "completed_at": None,
            "paused_at": None,
            "cancelled": False,
            "paused": False,
        }

        self._ensure_lock()
        async with self.lock:
            self.batches.append(batch)
            self.by_id[batch_id] = batch

        self._ensure_worker()
        return self._public_batch(batch)

    async def status(self, batch_id=None, node_id=None):
        self._ensure_lock()
        async with self.lock:
            if batch_id:
                batch = self.by_id.get(batch_id)
                return self._public_batch(batch) if batch else None
            batches = self.batches
            if node_id is not None:
                node_id = str(node_id)
                batches = [b for b in batches if b.get("node_id") == node_id]
            return [self._public_batch(b) for b in batches[-50:]]

    async def cancel(self, batch_id=None, node_id=None):
        self._ensure_lock()
        cancelled = []
        async with self.lock:
            for batch in self.batches:
                if batch["status"] in ("completed", "cancelled", "error"):
                    continue
                if batch_id and batch["batch_id"] != batch_id:
                    continue
                if node_id is not None and batch.get("node_id") != str(node_id):
                    continue
                batch["cancelled"] = True
                batch["status"] = "cancelled"
                cancelled.append(batch["batch_id"])
        return cancelled

    async def pause(self, batch_id=None, node_id=None, workflow_id=None):
        import time
        self._ensure_lock()
        paused = []
        async with self.lock:
            for batch in self.batches:
                if batch["status"] in ("completed", "cancelled", "error", "paused"):
                    continue
                if batch_id and batch["batch_id"] != batch_id:
                    continue
                if node_id is not None and batch.get("node_id") != str(node_id):
                    continue
                if workflow_id is not None and batch.get("workflow_id") != str(workflow_id):
                    continue
                batch["paused"] = True
                batch["status"] = "paused"
                batch["paused_at"] = time.time()
                paused.append(batch["batch_id"])
        return paused

    async def _queue_counts(self, session, base_url):
        try:
            async with session.get(f"{base_url}/queue") as resp:
                if resp.status != 200:
                    return {"pending": 0, "running": 0, "total": 0}
                data = await resp.json()
        except Exception:
            return {"pending": 0, "running": 0, "total": 0}

        pending = len(data.get("queue_pending") or [])
        running = len(data.get("queue_running") or [])
        return {"pending": pending, "running": running, "total": pending + running}

    async def _history_has_prompt(self, session, base_url, prompt_id):
        try:
            async with session.get(f"{base_url}/history/{prompt_id}") as resp:
                if resp.status != 200:
                    return False
                data = await resp.json()
        except Exception:
            return False
        return bool(data)

    def _prompt_payload(self, batch, prompt_data):
        if isinstance(prompt_data, dict) and "prompt" in prompt_data:
            payload = dict(prompt_data)
        else:
            payload = {
                "prompt": (prompt_data or {}).get("output", prompt_data),
                "extra_data": {
                    "extra_pnginfo": {
                        "workflow": (prompt_data or {}).get("workflow"),
                    }
                },
            }
        if batch.get("client_id") and "client_id" not in payload:
            payload["client_id"] = batch["client_id"]
        return payload

    async def _post_prompt(self, session, batch, prompt_data):
        payload = self._prompt_payload(batch, prompt_data)
        async with session.post(f"{batch['base_url']}/prompt", json=payload) as resp:
            data = await resp.json()
            if resp.status != 200:
                raise RuntimeError(data.get("error") or str(data))
            prompt_id = data.get("prompt_id")
            if not prompt_id:
                raise RuntimeError(f"Unexpected /prompt response: {data}")
            return prompt_id

    async def _run_batch(self, session, batch):
        import asyncio
        import time

        batch["status"] = "running"
        batch["started_at"] = time.time()
        sleep_s = batch["check_interval_ms"] / 1000.0

        while batch["submitted"] < len(batch["prompts"]):
            if batch.get("cancelled"):
                batch["status"] = "cancelled"
                return
            if batch.get("paused"):
                batch["status"] = "paused"
                return

            counts = await self._queue_counts(session, batch["base_url"])
            batch["queue_counts"] = counts
            capacity = max(0, batch["threshold"] - counts["total"])
            if capacity <= 0:
                await asyncio.sleep(sleep_s)
                continue

            for _ in range(min(capacity, len(batch["prompts"]) - batch["submitted"])):
                if batch.get("cancelled"):
                    batch["status"] = "cancelled"
                    return
                if batch.get("paused"):
                    batch["status"] = "paused"
                    return
                prompt_data = batch["prompts"][batch["submitted"]]
                prompt_id = await self._post_prompt(session, batch, prompt_data)
                batch["prompt_ids"].append(prompt_id)
                batch["submitted"] += 1

        while batch["completed"] < len(batch["prompt_ids"]):
            if batch.get("cancelled"):
                batch["status"] = "cancelled"
                return
            if batch.get("paused"):
                batch["status"] = "paused"
                return

            completed = 0
            for prompt_id in batch["prompt_ids"]:
                if await self._history_has_prompt(session, batch["base_url"], prompt_id):
                    completed += 1
            batch["completed"] = completed
            if completed >= len(batch["prompt_ids"]):
                break
            counts = await self._queue_counts(session, batch["base_url"])
            batch["queue_counts"] = counts
            if counts["total"] <= 0:
                batch["completed"] = len(batch["prompt_ids"])
                break
            await asyncio.sleep(sleep_s)

        batch["status"] = "completed"
        batch["completed_at"] = time.time()

    async def _worker(self):
        import asyncio
        from aiohttp import ClientSession

        while True:
            self._ensure_lock()
            async with self.lock:
                batch = next((b for b in self.batches if b["status"] == "queued"), None)

            if batch is None:
                return

            try:
                async with ClientSession() as session:
                    await self._run_batch(session, batch)
            except Exception as e:
                batch["status"] = "error"
                batch["error"] = str(e)
            await asyncio.sleep(0)


_glow_batch_coordinator = GlowBatchCoordinator()

# Register API routes for text sequence generation
if PromptServer is not None:
    @PromptServer.instance.routes.post("/glowloader/expand_text_entries")
    async def api_expand_text_entries(request):
        import json
        try:
            data = await request.json()
            source_mode = data.get("source_mode", "direct")
            text_list = data.get("text_list", "")
            file_mode = data.get("file_mode", "one_per_file")
            max_texts = data.get("max_texts", 0)

            if source_mode == "direct":
                entries = [x.strip() for x in (text_list or "").splitlines() if x.strip()]
                filenames = ["" for _ in entries]
                source_indices = list(range(len(entries)))
            else:
                entries_with_files = BatchLoadTexts()._load_from_files_with_names_and_indices(text_list, file_mode)
                entries = [e[0] for e in entries_with_files]
                filenames = [e[1] for e in entries_with_files]
                source_indices = [e[2] for e in entries_with_files]

            if max_texts and max_texts > 0:
                entries = entries[:max_texts]
                filenames = filenames[:max_texts]
                source_indices = source_indices[:max_texts]

            return web.json_response({
                "entries": entries,
                "filenames": filenames,
                "source_indices": source_indices,
            })
        except Exception as e:
            return web.json_response(
                {"error": str(e)}, status=500
            )

    @PromptServer.instance.routes.post("/glowloader/generate_sequence_texts")
    async def api_generate_sequence_texts(request):
        import json
        try:
            data = await request.json()
            sequence = BatchLoadTexts.generate_queue_sequence(
                data.get("source_mode", "direct"),
                data.get("text_list", ""),
                data.get("file_mode", "one_per_file"),
                data.get("max_texts", 0),
                data.get("queue_count", 0),
                data.get("shuffle", False),
                data.get("allow_duplicate", True),
                data.get("seed", -1),
                data.get("excluded_indices", None),
            )
            return web.json_response({"sequence": sequence})
        except Exception as e:
            return web.json_response(
                {"error": str(e)}, status=500
            )

    @PromptServer.instance.routes.post("/glowloader/batch/submit")
    async def api_batch_submit(request):
        try:
            data = await request.json()
            batch = await _glow_batch_coordinator.submit(request, data)
            return web.json_response(batch)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.get("/glowloader/batch/status")
    async def api_batch_status(request):
        try:
            batch_id = request.query.get("batch_id")
            node_id = request.query.get("node_id")
            status = await _glow_batch_coordinator.status(batch_id=batch_id, node_id=node_id)
            if batch_id and status is None:
                return web.json_response({"error": "batch not found"}, status=404)
            return web.json_response({"batches": status if isinstance(status, list) else [status]})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/glowloader/batch/cancel")
    async def api_batch_cancel(request):
        try:
            data = await request.json()
            cancelled = await _glow_batch_coordinator.cancel(
                batch_id=data.get("batch_id"),
                node_id=data.get("node_id"),
            )
            return web.json_response({"cancelled": cancelled})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/glowloader/batch/pause")
    async def api_batch_pause(request):
        try:
            data = await request.json()
            paused = await _glow_batch_coordinator.pause(
                batch_id=data.get("batch_id"),
                node_id=data.get("node_id"),
                workflow_id=data.get("workflow_id"),
            )
            return web.json_response({"paused": paused})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

NODE_CLASS_MAPPINGS = {
    "BatchLoadImages": BatchLoadImages,
    "BatchSaveImages": BatchSaveImages,
    "BatchLoadTexts": BatchLoadTexts,
    "VNCCS_PositionControl": VNCCS_PositionControl,
    "VNCCS_VisualPositionControl": VNCCS_VisualPositionControl,
    "GlowAPILLMLoader": GlowAPILLMLoader,
    "GlowExtraParameters": GlowExtraParameters,
    "GlowAPIChat": GlowAPIChat,
    "GlowCaptioner": GlowCaptioner,
    "GlowGenerateBBOX": GlowGenerateBBOX,
    "GlowApplyChatTemplate": GlowApplyChatTemplate,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BatchLoadImages": "GlowLoader 加载文件夹图像",
    "BatchSaveImages": "GlowLoader 保存文件夹图像",
    "BatchLoadTexts": "GlowLoader 加载文件夹文本",
    "VNCCS_PositionControl": "VNCCS Position Control (Prompt)",
    "VNCCS_VisualPositionControl": "VNCCS Visual Position Control (Prompt)",
    "GlowAPILLMLoader": "GlowLoader API LLM 加载器",
    "GlowExtraParameters": "GlowLoader Extra Parameters",
    "GlowAPIChat": "GlowLoader API Chat",
    "GlowCaptioner": "GlowLoader Captioner",
    "GlowGenerateBBOX": "GlowLoader Generate BBOXes",
    "GlowApplyChatTemplate": "GlowLoader Apply Chat Template",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
