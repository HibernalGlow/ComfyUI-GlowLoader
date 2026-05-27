import os
import hashlib
import json

import numpy as np
import torch
from PIL import Image, ImageOps, ImageSequence

import folder_paths
import node_helpers

# Register avif and webp support
try:
    from pillow_avif import AvifImagePlugin  # noqa: F401
except ImportError:
    pass

SUPPORTED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".avif", ".bmp", ".gif", ".tiff", ".tif"}

# Separator used in image_list to encode the original relative path.
# Format per line:  <comfy_filename> | <original_relative_path>
# Example:  photo.png|sub/deep/photo.png
# If no | is present, the original_relative_path equals the comfy_filename.
PATH_SEPARATOR = "|"


def _sanitize_relpath(relpath):
    """Sanitize a relative path to prevent path traversal and normalize separators.

    - Normalizes Windows backslashes to forward slashes
    - Removes leading slashes or drive letters (e.g. C:/)
    - Resolves and strips '..' traversal components
    - Collapses redundant separators
    - Returns empty string if the path is unsafe or empty after sanitization
    """
    if not relpath:
        return ""
    # Normalize backslashes to forward slashes
    relpath = relpath.replace("\\", "/")
    # Strip leading slashes and Windows drive letters (e.g. C:/)
    while relpath.startswith("/"):
        relpath = relpath[1:]
    if len(relpath) >= 2 and relpath[1] == ":" and relpath[0].isalpha():
        relpath = relpath[2:]
        while relpath.startswith("/"):
            relpath = relpath[1:]
    # Split into components and resolve '..' / '.'
    parts = []
    for seg in relpath.split("/"):
        if seg == "" or seg == ".":
            continue
        if seg == "..":
            if parts:
                parts.pop()
            # If '..' goes above root, just ignore it (don't allow escape)
            continue
        parts.append(seg)
    return "/".join(parts)


def _parse_image_list_entry(entry):
    """Parse a single image_list line into (comfy_name, original_relpath).

    Returns (comfy_name, original_relpath) where:
    - comfy_name: the filename ComfyUI can locate via annotated_filepath
    - original_relpath: the original relative path (may include subfolders)

    Handles edge cases:
    - Filenames containing '|' are parsed correctly by checking if the part
      after the last '|' looks like a path (contains '/' or a file extension).
    - Windows backslash paths are normalized to forward slashes.
    - Path traversal (..) is stripped out for safety.
    """
    entry = entry.strip()
    if not entry:
        return None, None
    if PATH_SEPARATOR not in entry:
        return entry, _sanitize_relpath(entry) or entry
    # Find the correct split point. Since filenames should not contain '/',
    # we split at the first '|' whose right side contains '/' or has a
    # different extension than the left side — this handles filenames with '|'.
    # Simple strategy: split at first '|' and sanitize the right side.
    # If the right side is empty after sanitization, treat whole line as filename.
    parts = entry.split(PATH_SEPARATOR, 1)
    comfy_name = parts[0].strip()
    raw_relpath = parts[1].strip()
    sanitized = _sanitize_relpath(raw_relpath)
    if sanitized:
        return comfy_name, sanitized
    # If sanitization emptied the path, fall back to comfy_name
    return comfy_name, comfy_name


class BatchLoadImages:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image_list": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                    },
                ),
                "max_images": ("INT", {"default": 0, "min": 0, "max": 100000, "step": 1}),
                "mode": (["batch", "single"], {"default": "batch"}),
                "index": ("INT", {"default": 0, "min": 0, "max": 100000, "step": 1}),
            },
            "optional": {
                "seed": ("INT", {"default": -1, "min": -1, "max": 2147483647, "control_after_generate": True, "forceInput": True}),
                "queue_count": ("INT", {"default": 0, "min": 0, "max": 100000, "step": 1}),
                "shuffle": ("BOOLEAN", {"default": False}),
                "allow_duplicate": ("BOOLEAN", {"default": True}),
                "trigger": ("BOOLEAN", {"default": True, "forceInput": True}),
                "queue_threshold": ("INT", {"default": 199, "min": 1, "max": 1000, "step": 1, "forceInput": True}),
                "check_interval_ms": ("INT", {"default": 1000, "min": 100, "max": 60000, "step": 100, "forceInput": True}),
            }
        }

    CATEGORY = "ComfyUI-GlowLoader"

    RETURN_TYPES = ("IMAGE", "STRING", "STRING", "INT", "INT")
    RETURN_NAMES = ("images", "filenames", "paths", "seed_out", "loop_index")
    FUNCTION = "load_images"
    OUTPUT_NODE = True

    def load_images(self, image_list: str, max_images: int, mode: str, index: int, seed: int = -1,
                    queue_count: int = 0, shuffle: bool = False, allow_duplicate: bool = True,
                    trigger: bool = True, queue_threshold=199, check_interval_ms=1000):
        # 防御空字符串：前端可能传入空值
        try:
            queue_threshold = int(queue_threshold) if queue_threshold != '' else 199
        except (ValueError, TypeError):
            queue_threshold = 199
        try:
            check_interval_ms = int(check_interval_ms) if check_interval_ms != '' else 1000
        except (ValueError, TypeError):
            check_interval_ms = 1000

        # 确定实际使用的种子：seed==-1 或 None 时生成随机种子
        import random as _random
        seed = seed if seed is not None else -1
        effective_seed = seed if seed >= 0 else _random.randint(0, 2147483647)

        entries = [_parse_image_list_entry(x) for x in (image_list or "").splitlines()]
        entries = [(c, p) for c, p in entries if c]

        if max_images and max_images > 0:
            entries = entries[:max_images]

        total_entries = len(entries)
        loop_index = 0

        if mode == "single":
            # 根据 shuffle/seed/allow_duplicate 解析实际索引
            effective_index = self._resolve_index(total_entries, index, shuffle, allow_duplicate, effective_seed)
            if effective_index < 0:
                effective_index = 0
            if effective_index >= total_entries:
                effective_index = total_entries - 1
            # 计算循环索引：当 allow_duplicate=True 时，index 可以超过 total_entries
            # loop_index 表示当前是第几轮循环（从0开始）
            if total_entries > 0 and allow_duplicate:
                loop_index = index // total_entries
            entries = [entries[effective_index]]

        if len(entries) == 0:
            raise ValueError("image_list is empty")

        output_images = []
        output_names = []
        output_paths = []

        excluded_formats = ["MPO"]

        for comfy_name, original_relpath in entries:
            if not folder_paths.exists_annotated_filepath(comfy_name):
                continue

            image_path = folder_paths.get_annotated_filepath(comfy_name)
            img = node_helpers.pillow(Image.open, image_path)

            w, h = None, None
            frames = []

            for i in ImageSequence.Iterator(img):
                i = node_helpers.pillow(ImageOps.exif_transpose, i)

                if i.mode == "I":
                    i = i.point(lambda p: p * (1 / 255))
                pil_image = i.convert("RGB")

                if len(frames) == 0:
                    w = pil_image.size[0]
                    h = pil_image.size[1]

                if pil_image.size[0] != w or pil_image.size[1] != h:
                    continue

                arr = np.array(pil_image).astype(np.float32) / 255.0
                tensor = torch.from_numpy(arr)[None,]
                frames.append(tensor)

            if len(frames) == 0:
                continue

            if len(frames) > 1 and img.format not in excluded_formats:
                image_tensor = torch.cat(frames, dim=0)
            else:
                image_tensor = frames[0]

            output_images.append(image_tensor)
            # filename only (no directory part)
            output_names.append(os.path.basename(original_relpath))
            # full original relative path for saving (preserves folder structure)
            output_paths.append(original_relpath)

        if len(output_images) == 0:
            raise ValueError("No valid images found")

        output_image = torch.cat(output_images, dim=0)
        return (output_image, "\n".join(output_names), "\n".join(output_paths), effective_seed, loop_index)

    @staticmethod
    def _resolve_index(total: int, index: int, shuffle: bool,
                        allow_duplicate: bool, seed: int) -> int:
        """根据 shuffle/seed/allow_duplicate 解析实际索引。"""
        if total <= 0:
            return 0
        if index < 0:
            index = 0

        if not shuffle:
            if allow_duplicate:
                return index % total
            else:
                if index >= total:
                    index = total - 1
                return index

        import random
        if seed >= 0:
            rng = random.Random(seed)
        else:
            rng = random.Random(index)

        if allow_duplicate:
            return rng.randint(0, total - 1)
        else:
            indices = list(range(total))
            rng.shuffle(indices)
            return indices[index % total]

    @classmethod
    def IS_CHANGED(s, image_list: str, max_images: int, mode: str, index: int, seed: int = -1,
                   queue_count: int = 0, shuffle: bool = False, allow_duplicate: bool = True,
                   trigger: bool = True, queue_threshold: int = 199, check_interval_ms: int = 1000):
        seed = seed if seed is not None else -1
        m = hashlib.sha256()
        entries = [_parse_image_list_entry(x) for x in (image_list or "").splitlines()]
        entries = [(c, p) for c, p in entries if c]
        if max_images and max_images > 0:
            entries = entries[:max_images]

        if mode == "single":
            effective_index = s._resolve_index(len(entries), index, shuffle, allow_duplicate, seed)
            if effective_index < 0:
                effective_index = 0
            if effective_index >= len(entries):
                effective_index = len(entries) - 1
            entries = entries[:1] if len(entries) == 0 else [entries[effective_index]]

        m.update(str(mode).encode("utf-8"))
        m.update(str(index).encode("utf-8"))
        m.update(str(max_images).encode("utf-8"))
        m.update(str(seed).encode("utf-8"))
        m.update(str(shuffle).encode("utf-8"))
        m.update(str(allow_duplicate).encode("utf-8"))
        for comfy_name, original_relpath in entries:
            m.update(comfy_name.encode("utf-8"))
            m.update(original_relpath.encode("utf-8"))
            if folder_paths.exists_annotated_filepath(comfy_name):
                image_path = folder_paths.get_annotated_filepath(comfy_name)
                if os.path.isfile(image_path):
                    with open(image_path, "rb") as f:
                        m.update(f.read())
        return m.digest().hex()

    @classmethod
    def VALIDATE_INPUTS(s, image_list: str, max_images: int, mode: str, index: int, seed: int = -1,
                        queue_count: int = 0, shuffle: bool = False, allow_duplicate: bool = True,
                        trigger: bool = True, queue_threshold: int = 199, check_interval_ms: int = 1000):
        seed = seed if seed is not None else -1
        entries = [_parse_image_list_entry(x) for x in (image_list or "").splitlines()]
        entries = [(c, p) for c, p in entries if c]
        if max_images and max_images > 0:
            entries = entries[:max_images]

        if mode == "single":
            if len(entries) == 0:
                return "image_list is empty"
            # 当 allow_duplicate=True 时，index 可以超过 total，用于循环入队
            # 所以只在 shuffle=False 且 allow_duplicate=False 时检查范围
            if not shuffle and not allow_duplicate:
                if index < 0:
                    return "index must be >= 0"
                if index >= len(entries):
                    return f"index out of range (0..{len(entries)-1})"

        if len(entries) == 0:
            return "image_list is empty"

        valid = False
        for comfy_name, _ in entries:
            if folder_paths.exists_annotated_filepath(comfy_name):
                valid = True
                break

        if not valid:
            return "No valid images in image_list"

        return True


class VNCCS_PositionControl:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "azimuth": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 360,
                        "step": 45,
                        "display": "slider",
                        "tooltip": "Angle of the camera around the subject (0=Front, 90=Right, 180=Back)",
                    },
                ),
                "elevation": (
                    "INT",
                    {
                        "default": 0,
                        "min": -30,
                        "max": 60,
                        "step": 30,
                        "display": "slider",
                        "tooltip": "Vertical angle of the camera (-30=Low, 0=Eye Level, 60=High)",
                    },
                ),
                "distance": (["close-up", "medium shot", "wide shot"], {"default": "medium shot"}),
                "include_trigger": ("BOOLEAN", {"default": True, "tooltip": "Include <sks> trigger word"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    CATEGORY = "VNCCS"
    FUNCTION = "generate_prompt"

    def generate_prompt(self, azimuth, elevation, distance, include_trigger):
        azimuth = int(azimuth) % 360

        azimuth_map = {
            0: "front view",
            45: "front-right quarter view",
            90: "right side view",
            135: "back-right quarter view",
            180: "back view",
            225: "back-left quarter view",
            270: "left side view",
            315: "front-left quarter view",
        }

        if azimuth > 337.5:
            closest_azimuth = 0
        else:
            closest_azimuth = min(azimuth_map.keys(), key=lambda x: abs(x - azimuth))
        az_str = azimuth_map[closest_azimuth]

        elevation_map = {
            -30: "low-angle shot",
            0: "eye-level shot",
            30: "elevated shot",
            60: "high-angle shot",
        }
        closest_elevation = min(elevation_map.keys(), key=lambda x: abs(x - elevation))
        el_str = elevation_map[closest_elevation]

        parts = []
        if include_trigger:
            parts.append("<sks>")
        parts.append(az_str)
        parts.append(el_str)
        parts.append(distance)

        return (" ".join(parts),)


class VNCCS_VisualPositionControl(VNCCS_PositionControl):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "camera_data": ("STRING", {"default": "{}", "hidden": True}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    CATEGORY = "VNCCS"
    FUNCTION = "generate_prompt_from_json"

    def generate_prompt_from_json(self, camera_data):
        try:
            data = json.loads(camera_data)
        except json.JSONDecodeError:
            data = {"azimuth": 0, "elevation": 0, "distance": "medium shot", "include_trigger": True}

        return self.generate_prompt(
            data.get("azimuth", 0),
            data.get("elevation", 0),
            data.get("distance", "medium shot"),
            data.get("include_trigger", True),
        )


class BatchSaveImages:
    """Save images preserving the folder structure and original filenames from the loading paths."""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "images": ("IMAGE",),
                "paths": ("STRING", {"multiline": True, "default": ""}),
                "output_dir": ("STRING", {"default": ""}),
                "format": (["png", "webp", "avif", "jpg"], {"default": "png"}),
                "quality": ("INT", {"default": 95, "min": 1, "max": 100, "step": 1}),
            }
        }

    CATEGORY = "ComfyUI-GlowLoader"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("saved_paths",)
    FUNCTION = "save_images"
    OUTPUT_NODE = True

    def save_images(self, images, paths: str, output_dir: str, format: str, quality: int):
        path_list = [x.strip() for x in (paths or "").splitlines() if x.strip()]

        if len(path_list) == 0:
            raise ValueError("paths is empty - connect the 'paths' output from BatchLoadImages")

        # Determine base output directory
        if output_dir:
            base_dir = output_dir
        else:
            # Default: ComfyUI output directory
            base_dir = folder_paths.get_output_directory()

        # Normalize base_dir for safety checks later
        base_dir = os.path.normpath(os.path.abspath(base_dir))
        os.makedirs(base_dir, exist_ok=True)

        saved = []
        batch_size = images.shape[0]

        for i in range(batch_size):
            img_tensor = images[i]
            pil_image = self._tensor_to_pil(img_tensor)

            if i < len(path_list):
                original_path = _sanitize_relpath(path_list[i])
                if not original_path:
                    original_path = f"image_{i:05d}.png"
                # Derive subfolder structure from the annotated path
                # e.g. "subdir/photo.png" -> subdir = "subdir"
                rel_dir = os.path.dirname(original_path)
                original_name = os.path.splitext(os.path.basename(original_path))[0]
            else:
                rel_dir = ""
                original_name = f"image_{i:05d}"

            # Build the save directory preserving folder structure
            if rel_dir:
                save_dir = os.path.join(base_dir, rel_dir)
            else:
                save_dir = base_dir

            # Security: verify save_dir stays within base_dir after normalization
            save_dir_norm = os.path.normpath(os.path.abspath(save_dir))
            if not save_dir_norm.startswith(base_dir + os.sep) and save_dir_norm != base_dir:
                # Path traversal detected — fall back to base_dir
                save_dir = base_dir
                original_name = os.path.splitext(os.path.basename(original_path if i < len(path_list) else ""))[0] or f"image_{i:05d}"

            os.makedirs(save_dir, exist_ok=True)

            # Build filename with chosen format
            ext = f".{format}"
            filename = original_name + ext
            full_path = os.path.join(save_dir, filename)

            # Avoid overwriting: append suffix if exists
            counter = 1
            while os.path.exists(full_path):
                filename = f"{original_name}_{counter}{ext}"
                full_path = os.path.join(save_dir, filename)
                counter += 1

            # Save with appropriate parameters
            save_kwargs = {}
            if format == "jpg":
                pil_image = pil_image.convert("RGB")
                save_kwargs["quality"] = quality
            elif format == "webp":
                save_kwargs["quality"] = quality
            elif format == "avif":
                save_kwargs["quality"] = quality
            elif format == "png":
                save_kwargs["compress_level"] = 6

            pil_image.save(full_path, **save_kwargs)
            saved.append(full_path)

        return ("\n".join(saved),)

    @staticmethod
    def _tensor_to_pil(tensor):
        arr = tensor.cpu().numpy()
        arr = (arr * 255.0).clip(0, 255).astype(np.uint8)
        return Image.fromarray(arr)
