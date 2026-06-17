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
            else:
                entries_with_files = BatchLoadTexts()._load_from_files_with_names(text_list, file_mode)
                entries = [e[0] for e in entries_with_files]
                filenames = [e[1] for e in entries_with_files]

            if max_texts and max_texts > 0:
                entries = entries[:max_texts]
                filenames = filenames[:max_texts]

            return web.json_response({
                "entries": entries,
                "filenames": filenames,
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
