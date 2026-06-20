import os
import re

import folder_paths


MAX_TRIGGER_LORAS = 30


def _normalize_bool(value, default=False):
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        value = value.strip().lower()
        if value in ("true", "1", "yes", "y", "on", "enable", "enabled"):
            return True
        if value in ("false", "0", "no", "n", "off", "disable", "disabled", ""):
            return False
    return default


def _safe_float(value, default=1.0):
    if isinstance(value, str) and value.strip().casefold() in ("", "none", "null"):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _split_triggers(trigger):
    text = str(trigger or "").strip()
    if not text:
        return []
    return [part.strip() for part in re.split(r"[\n,，、|;；]+", text) if part.strip()]


def _trigger_matches(source_text, trigger):
    triggers = _split_triggers(trigger)
    if not triggers:
        return True
    haystack = str(source_text or "").casefold()
    return any(token.casefold() in haystack for token in triggers)


def _collapse_trigger_line(trigger):
    return ", ".join(part.strip() for part in str(trigger or "").splitlines() if part.strip())


def _clean_lora_trigger_text(trigger):
    lines = []
    for raw_line in str(trigger or "").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        lines.append(line)
    return "\n".join(lines)


def _safe_lora_relative_path(lora_name):
    if not lora_name or lora_name == "None":
        return None
    rel = str(lora_name).replace("\\", "/").strip()
    if not rel:
        return None
    rel = os.path.normpath(rel)
    if os.path.isabs(rel) or rel == "." or rel.startswith(".."):
        return None
    return rel


def _get_lora_root_paths():
    get_folder_paths = getattr(folder_paths, "get_folder_paths", None)
    if callable(get_folder_paths):
        try:
            return list(get_folder_paths("loras") or [])
        except Exception:
            pass

    folder_names_and_paths = getattr(folder_paths, "folder_names_and_paths", None)
    if isinstance(folder_names_and_paths, dict):
        entry = folder_names_and_paths.get("loras")
        if entry:
            paths = entry[0] if isinstance(entry, (list, tuple)) else entry
            if isinstance(paths, (list, tuple)):
                return list(paths)
            return [paths]
    return []


def _candidate_lora_trigger_paths(lora_name):
    rel_lora = _safe_lora_relative_path(lora_name)
    if not rel_lora:
        return []

    candidates = []
    rel_trigger = os.path.splitext(rel_lora)[0] + ".trigger.txt"

    get_full_path = getattr(folder_paths, "get_full_path", None)
    if callable(get_full_path):
        try:
            lora_path = get_full_path("loras", rel_lora)
            if lora_path:
                candidates.append(os.path.splitext(lora_path)[0] + ".trigger.txt")
        except Exception:
            pass
        try:
            trigger_path = get_full_path("loras", rel_trigger)
            if trigger_path:
                candidates.append(trigger_path)
        except Exception:
            pass

    for root in _get_lora_root_paths():
        if not root:
            continue
        root = os.path.abspath(str(root))
        path = os.path.abspath(os.path.join(root, rel_trigger))
        try:
            if os.path.commonpath([root, path]) == root:
                candidates.append(path)
        except ValueError:
            continue

    seen = set()
    result = []
    for path in candidates:
        if not path:
            continue
        normalized = os.path.normcase(os.path.abspath(str(path)))
        if normalized in seen:
            continue
        seen.add(normalized)
        result.append(path)
    return result


def read_lora_trigger_file(lora_name):
    for path in _candidate_lora_trigger_paths(lora_name):
        if not os.path.isfile(path):
            continue
        for encoding in ("utf-8-sig", "utf-8"):
            try:
                with open(path, "r", encoding=encoding) as f:
                    return _clean_lora_trigger_text(f.read())
            except UnicodeDecodeError:
                continue
            except OSError:
                break
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                return _clean_lora_trigger_text(f.read())
        except OSError:
            continue
    return ""


class _InputTextInputs(dict):
    def __contains__(self, key):
        name = str(key or "")
        return (
            dict.__contains__(self, key)
            or re.fullmatch(r"input_text_\d+", name) is not None
        )

    def __getitem__(self, key):
        name = str(key or "")
        if re.fullmatch(r"input_text_\d+", name):
            return ("STRING", {"forceInput": True})
        return dict.__getitem__(self, key)


class GlowTriggerLoRAStack:
    @classmethod
    def INPUT_TYPES(cls):
        loras = ["None"] + folder_paths.get_filename_list("loras")
        required = {
            "lora_count": ("INT", {"default": 3, "min": 0, "max": MAX_TRIGGER_LORAS, "step": 1}),
            "input_text": ("STRING", {"multiline": False, "default": ""}),
        }

        for index in range(1, MAX_TRIGGER_LORAS + 1):
            required[f"enable_{index}"] = ("BOOLEAN", {"default": True})
            required[f"lora_name_{index}"] = (loras,)
            required[f"model_weight_{index}"] = (
                "FLOAT",
                {"default": 1.0, "min": -10.0, "max": 10.0, "step": 0.01},
            )
            required[f"clip_weight_{index}"] = (
                "FLOAT",
                {"default": 1.0, "min": -10.0, "max": 10.0, "step": 0.01},
            )
            required[f"trigger_{index}"] = ("STRING", {"default": ""})
            required[f"lora_trigger_{index}"] = ("STRING", {"default": "", "multiline": False})

        optional = _InputTextInputs({
            "lora_stack": ("LORA_STACK",),
            "input_text_in": ("STRING", {"forceInput": True}),
        })
        return {"required": required, "optional": optional}

    RETURN_TYPES = ("LORA_STACK", "STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = (
        "LORA_STACK",
        "active_loras",
        "show_help",
        "active_trigger_words",
        "all_trigger_words",
    )
    FUNCTION = "build_lora_stack"
    CATEGORY = "ComfyUI-GlowLoader/LoRA"

    @staticmethod
    def read_lora_trigger(lora_name):
        return read_lora_trigger_file(lora_name)

    def build_lora_stack(self, lora_count=3, input_text="", lora_stack=None, input_text_in=None, **kwargs):
        try:
            count = int(lora_count)
        except (TypeError, ValueError):
            count = 0
        count = max(0, min(MAX_TRIGGER_LORAS, count))

        lora_list = []
        if lora_stack is not None:
            lora_list.extend([item for item in lora_stack if item and item[0] != "None"])

        global_text = input_text_in if input_text_in not in (None, "") else input_text
        active_names = []
        active_trigger_lines = []
        all_trigger_lines = []

        for index in range(1, count + 1):
            lora_name = kwargs.get(f"lora_name_{index}", "None")
            if not lora_name or lora_name == "None":
                continue

            own_trigger = _clean_lora_trigger_text(kwargs.get(f"lora_trigger_{index}") or "")
            if not own_trigger:
                own_trigger = read_lora_trigger_file(lora_name)
            own_trigger_line = _collapse_trigger_line(own_trigger)
            if own_trigger_line:
                all_trigger_lines.append(own_trigger_line)

            enabled = _normalize_bool(kwargs.get(f"enable_{index}", True), True)
            if not enabled:
                continue

            local_text = kwargs.get(f"input_text_{index}", None)
            source_text = local_text if local_text not in (None, "") else global_text
            trigger = kwargs.get(f"trigger_{index}", "")
            if not _trigger_matches(source_text, trigger):
                continue

            model_weight = _safe_float(kwargs.get(f"model_weight_{index}", 1.0), 1.0)
            clip_weight = _safe_float(kwargs.get(f"clip_weight_{index}", 1.0), 1.0)
            lora_list.append((lora_name, model_weight, clip_weight))
            active_names.append(lora_name)
            if own_trigger_line:
                active_trigger_lines.append(own_trigger_line)

        show_help = (
            "trigger_N is the prompt matching switch. lora_trigger_N is the LoRA's own "
            "trigger words, usually auto-loaded from the same-name .trigger.txt file."
        )
        return (
            lora_list,
            ", ".join(active_names),
            show_help,
            "\n".join(active_trigger_lines),
            "\n".join(all_trigger_lines),
        )
