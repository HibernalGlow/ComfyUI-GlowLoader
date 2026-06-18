MAX_DYNAMIC_OUTPUTS = 30

OUTPUT_TYPE_CHOICES = [
    "MODEL",
    "CLIP",
    "VAE",
    "CONDITIONING",
    "LATENT",
    "IMAGE",
    "MASK",
    "STRING",
    "INT",
    "FLOAT",
    "BOOLEAN",
    "COMBO",
    "LORA_STACK",
    "CONTROL_NET",
    "SAMPLER",
    "SIGMAS",
    "NOISE",
    "GUIDER",
    "AUDIO",
    "VIDEO",
    "CUSTOM",
]


class AnyType(str):
    def __ne__(self, _):
        return False


any_type = AnyType("*")


def _clamp_count(value):
    try:
        count = int(value)
    except (TypeError, ValueError):
        count = 1
    return max(1, min(MAX_DYNAMIC_OUTPUTS, count))


def _normalize_type(output_type, custom_type=""):
    output_type = str(output_type or "*").strip().upper()
    if output_type in ("ANY", ""):
        return "*"
    if output_type == "CUSTOM":
        custom_type = str(custom_type or "").strip().upper()
        return custom_type or "*"
    return output_type


def _to_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value or "").strip().lower()
    return text in ("1", "true", "yes", "y", "on", "enable", "enabled")


def _coerce_default_value(output_type, raw_value):
    output_type = _normalize_type(output_type)
    raw_value = "" if raw_value is None else raw_value

    if output_type in ("STRING", "COMBO"):
        return str(raw_value)
    if output_type == "INT":
        try:
            return int(float(raw_value))
        except (TypeError, ValueError):
            return 0
    if output_type == "FLOAT":
        try:
            return float(raw_value)
        except (TypeError, ValueError):
            return 0.0
    if output_type == "BOOLEAN":
        return _to_bool(raw_value)
    if output_type == "*":
        return str(raw_value) if str(raw_value) else None
    return None


class GlowDynamicTypedOutputs:
    @classmethod
    def INPUT_TYPES(cls):
        required = {
            "output_count": (
                "INT",
                {"default": 4, "min": 1, "max": MAX_DYNAMIC_OUTPUTS, "step": 1},
            ),
            "index": (
                "INT",
                {"default": 1, "min": 1, "max": MAX_DYNAMIC_OUTPUTS, "step": 1},
            ),
        }
        optional = {}

        for index in range(1, MAX_DYNAMIC_OUTPUTS + 1):
            required[f"type_{index}"] = (OUTPUT_TYPE_CHOICES, {"default": "FLOAT"})
            required[f"custom_type_{index}"] = ("STRING", {"default": ""})
            required[f"default_value_{index}"] = ("STRING", {"default": ""})
            optional[f"input_{index}"] = (any_type,)

        return {"required": required, "optional": optional}

    RETURN_TYPES = (any_type,) * (MAX_DYNAMIC_OUTPUTS + 1)
    RETURN_NAMES = tuple(f"out_{index}" for index in range(1, MAX_DYNAMIC_OUTPUTS + 1)) + ("by_index",)
    FUNCTION = "emit"
    CATEGORY = "ComfyUI-GlowLoader/Utils"
    DESCRIPTION = "Creates a compact set of typed outputs. Connected inputs pass through; primitive defaults are used when unconnected."

    def emit(self, output_count=4, index=1, **kwargs):
        count = _clamp_count(output_count)
        outputs = []

        for slot in range(1, MAX_DYNAMIC_OUTPUTS + 1):
            if slot > count:
                outputs.append(None)
                continue

            input_key = f"input_{slot}"
            if input_key in kwargs:
                outputs.append(kwargs.get(input_key))
                continue

            output_type = _normalize_type(
                kwargs.get(f"type_{slot}", "FLOAT"),
                kwargs.get(f"custom_type_{slot}", ""),
            )
            outputs.append(_coerce_default_value(output_type, kwargs.get(f"default_value_{slot}", "")))

        selected_index = _clamp_count(index)
        selected = outputs[selected_index - 1] if selected_index <= count else None
        return tuple(outputs + [selected])
