import hashlib
import random


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
            },
            "optional": {
                "queue_count": ("INT", {"default": 0, "min": 0, "max": 100000, "step": 1}),
                "shuffle": ("BOOLEAN", {"default": False}),
                "allow_duplicate": ("BOOLEAN", {"default": True}),
                "seed": ("INT", {"default": -1, "min": -1, "max": 2147483647}),
            }
        }

    CATEGORY = "ComfyUI-GlowLoader"

    RETURN_TYPES = ("STRING", "STRING", "INT")
    RETURN_NAMES = ("text", "all_texts", "current_index")
    FUNCTION = "load_texts"
    OUTPUT_NODE = True

    def load_texts(self, text_list: str, max_texts: int, mode: str, index: int, 
                   queue_count: int = 0, shuffle: bool = False, 
                   allow_duplicate: bool = True, seed: int = -1):
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
            return (entries[index], "\n".join(entries), index)

        # batch mode: return first text as main output, all as secondary
        return (entries[0] if entries else "", "\n".join(entries), 0)

    @classmethod
    def IS_CHANGED(s, text_list: str, max_texts: int, mode: str, index: int,
                   queue_count: int = 0, shuffle: bool = False, 
                   allow_duplicate: bool = True, seed: int = -1):
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
        m.update(str(queue_count).encode("utf-8"))
        m.update(str(shuffle).encode("utf-8"))
        m.update(str(allow_duplicate).encode("utf-8"))
        m.update(str(seed).encode("utf-8"))
        for entry in entries:
            m.update(entry.encode("utf-8"))
        return m.digest().hex()

    @classmethod
    def VALIDATE_INPUTS(s, text_list: str, max_texts: int, mode: str, index: int,
                        queue_count: int = 0, shuffle: bool = False, 
                        allow_duplicate: bool = True, seed: int = -1):
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

    @classmethod
    def generate_queue_sequence(cls, text_list: str, max_texts: int, 
                                queue_count: int, shuffle: bool, 
                                allow_duplicate: bool, seed: int):
        """生成入队序列，返回索引列表"""
        entries = [x.strip() for x in (text_list or "").splitlines() if x.strip()]
        
        if len(entries) == 0:
            return []
        
        if max_texts and max_texts > 0:
            entries = entries[:max_texts]
        
        total_entries = len(entries)
        
        # 确定实际入队次数
        count = queue_count if queue_count > 0 else total_entries
        
        # 设置随机种子
        if seed >= 0:
            rng = random.Random(seed)
        else:
            rng = random.Random()
        
        indices = list(range(total_entries))
        
        if shuffle:
            # 乱序模式
            if allow_duplicate:
                # 允许重复：随机选择
                return [rng.choice(indices) for _ in range(count)]
            else:
                # 不允许重复：先打乱，循环使用
                result = []
                rng.shuffle(indices)
                for i in range(count):
                    result.append(indices[i % total_entries])
                    if i % total_entries == total_entries - 1:
                        # 一轮结束，重新打乱
                        rng.shuffle(indices)
                return result
        else:
            # 顺序模式
            if allow_duplicate:
                # 允许重复：循环使用
                return [i % total_entries for i in range(count)]
            else:
                # 不允许重复：只取前count个（不超过总数）
                return indices[:min(count, total_entries)]
