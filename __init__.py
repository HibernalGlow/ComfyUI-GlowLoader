from .batch_load_images import BatchLoadImages, VNCCS_PositionControl, VNCCS_VisualPositionControl

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {
    "BatchLoadImages": BatchLoadImages,
    "VNCCS_PositionControl": VNCCS_PositionControl,
    "VNCCS_VisualPositionControl": VNCCS_VisualPositionControl,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BatchLoadImages": "ComfyUI-IAI666-BatchLoadImages",
    "VNCCS_PositionControl": "VNCCS Position Control (Prompt)",
    "VNCCS_VisualPositionControl": "VNCCS Visual Position Control (Prompt)",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
