from .batch_load_images import BatchLoadImages, BatchSaveImages, VNCCS_PositionControl, VNCCS_VisualPositionControl
from .batch_load_texts import BatchLoadTexts, QueueController

try:
    from server import PromptServer  # type: ignore
except ImportError:
    PromptServer = None

WEB_DIRECTORY = "./web"

# Register API routes for text sequence generation
if PromptServer is not None:
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
            return PromptServer.instance.web.json_response({"sequence": sequence})
        except Exception as e:
            return PromptServer.instance.web.json_response(
                {"error": str(e)}, status=500
            )

NODE_CLASS_MAPPINGS = {
    "BatchLoadImages": BatchLoadImages,
    "BatchSaveImages": BatchSaveImages,
    "BatchLoadTexts": BatchLoadTexts,
    "QueueController": QueueController,
    "VNCCS_PositionControl": VNCCS_PositionControl,
    "VNCCS_VisualPositionControl": VNCCS_VisualPositionControl,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BatchLoadImages": "GlowLoader 加载文件夹图像",
    "BatchSaveImages": "GlowLoader 保存文件夹图像",
    "BatchLoadTexts": "GlowLoader 加载文件夹文本",
    "QueueController": "GlowLoader 队列控制器",
    "VNCCS_PositionControl": "VNCCS Position Control (Prompt)",
    "VNCCS_VisualPositionControl": "VNCCS Visual Position Control (Prompt)",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
