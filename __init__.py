from .batch_load_images import BatchLoadImages, BatchSaveImages, VNCCS_PositionControl, VNCCS_VisualPositionControl
from .batch_load_texts import BatchLoadTexts

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {
    "BatchLoadImages": BatchLoadImages,
    "BatchSaveImages": BatchSaveImages,
    "BatchLoadTexts": BatchLoadTexts,
    "VNCCS_PositionControl": VNCCS_PositionControl,
    "VNCCS_VisualPositionControl": VNCCS_VisualPositionControl,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BatchLoadImages": "GlowLoader 加载文件夹图像",
    "BatchSaveImages": "GlowLoader 保存文件夹图像",
    "BatchLoadTexts": "GlowLoader 加载文件夹文本",
    "VNCCS_PositionControl": "VNCCS Position Control (Prompt)",
    "VNCCS_VisualPositionControl": "VNCCS Visual Position Control (Prompt)",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
