import hashlib


class BatchLoadTexts:
    """批量加载文本，支持直接输入多行文本，一行一个"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "text_list": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                    },
                ),
                "max_texts": ("INT", {"default": 0, "min": 0, "max": 100000, "step": 1}),
                "mode": (["batch", "single"], {"default": "batch"}),
                "index": ("INT", {"default": 0, "min": 0, "max": 100000, "step": 1}),
            }
        }

    CATEGORY = "ComfyUI-GlowLoader"

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("text", "all_texts")
    FUNCTION = "load_texts"
    OUTPUT_NODE = True

    def load_texts(self, text_list: str, max_texts: int, mode: str, index: int):
        entries = [x.strip() for x in (text_list or "").splitlines() if x.strip()]

        if len(entries) == 0:
            raise ValueError("text_list is empty")

        if max_texts and max_texts > 0:
            entries = entries[:max_texts]

        if mode == "single":
            if index < 0:
                index = 0
            if index >= len(entries):
                index = len(entries) - 1
            return (entries[index], "\n".join(entries))

        # batch mode: return first text as main output, all as secondary
        return (entries[0] if entries else "", "\n".join(entries))

    @classmethod
    def IS_CHANGED(s, text_list: str, max_texts: int, mode: str, index: int):
        m = hashlib.sha256()
        entries = [x.strip() for x in (text_list or "").splitlines() if x.strip()]
        if max_texts and max_texts > 0:
            entries = entries[:max_texts]

        if mode == "single":
            if index < 0:
                index = 0
            if index >= len(entries):
                index = len(entries) - 1
            entries = entries[:1] if len(entries) == 0 else [entries[index]]

        m.update(str(mode).encode("utf-8"))
        m.update(str(index).encode("utf-8"))
        m.update(str(max_texts).encode("utf-8"))
        for entry in entries:
            m.update(entry.encode("utf-8"))
        return m.digest().hex()

    @classmethod
    def VALIDATE_INPUTS(s, text_list: str, max_texts: int, mode: str, index: int):
        entries = [x.strip() for x in (text_list or "").splitlines() if x.strip()]

        if len(entries) == 0:
            return "text_list is empty"

        if max_texts and max_texts > 0:
            entries = entries[:max_texts]

        if mode == "single":
            if index < 0:
                return "index must be >= 0"
            if index >= len(entries):
                return f"index out of range (0..{len(entries)-1})"

        return True
