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
    from .workflow_registry import get_registry
    from .workflow_monitor import BatchWorkflowMonitor
except ImportError:
    get_registry = None
    BatchWorkflowMonitor = None

try:
    from server import PromptServer  # type: ignore
    from aiohttp import web
except ImportError:
    PromptServer = None
    web = None

WEB_DIRECTORY = "./web"

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
                source_line_indices = list(range(len(entries)))
            else:
                result = BatchLoadTexts()._load_from_files_with_names_and_indices(text_list, file_mode)
                entries = [e[0] for e in result]
                filenames = [e[1] for e in result]
                source_line_indices = [e[2] for e in result]

            if max_texts and max_texts > 0:
                entries = entries[:max_texts]
                filenames = filenames[:max_texts]
                source_line_indices = source_line_indices[:max_texts]

            return web.json_response({
                "entries": entries,
                "filenames": filenames,
                "source_line_indices": source_line_indices,
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
            )
            return web.json_response({"sequence": sequence})
        except Exception as e:
            return web.json_response(
                {"error": str(e)}, status=500
            )

    if get_registry is not None:
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
    "BatchWorkflowMonitor": BatchWorkflowMonitor,
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
    "BatchWorkflowMonitor": "GlowLoader 工作流监控",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
