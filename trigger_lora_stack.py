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


def _split_triggers(trigger):
    text = str(trigger or "").strip()
    if not text:
        return []
    return [part.strip() for part in re.split(r"[\n,|;]+", text) if part.strip()]


def _trigger_matches(source_text, trigger):
    triggers = _split_triggers(trigger)
    if not triggers:
        return True
    haystack = str(source_text or "").casefold()
    return any(token.casefold() in haystack for token in triggers)


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
            "input_text": ("STRING", {"multiline": True, "default": ""}),
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

        optional = _InputTextInputs({
            "lora_stack": ("LORA_STACK",),
            "input_text_in": ("STRING", {"forceInput": True}),
        })
        return {"required": required, "optional": optional}

    RETURN_TYPES = ("LORA_STACK", "STRING", "STRING")
    RETURN_NAMES = ("LORA_STACK", "active_loras", "show_help")
    FUNCTION = "build_lora_stack"
    CATEGORY = "ComfyUI-GlowLoader/LoRA"

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

        for index in range(1, count + 1):
            lora_name = kwargs.get(f"lora_name_{index}", "None")
            if not lora_name or lora_name == "None":
                continue

            enabled = _normalize_bool(kwargs.get(f"enable_{index}", True), True)
            if not enabled:
                continue

            local_text = kwargs.get(f"input_text_{index}", None)
            source_text = local_text if local_text not in (None, "") else global_text
            trigger = kwargs.get(f"trigger_{index}", "")
            if not _trigger_matches(source_text, trigger):
                continue

            model_weight = float(kwargs.get(f"model_weight_{index}", 1.0))
            clip_weight = float(kwargs.get(f"clip_weight_{index}", 1.0))
            lora_list.append((lora_name, model_weight, clip_weight))
            active_names.append(lora_name)

        show_help = (
            "enable_N controls the LoRA switch. trigger_N is matched against input_text_in/"
            "input_text, or input_text_N when that per-LoRA input is connected."
        )
        return (lora_list, ", ".join(active_names), show_help)
