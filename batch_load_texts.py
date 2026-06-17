import hashlib
import os
import random

import folder_paths


# Separator used in text_list to encode the original relative path.
PATH_SEPARATOR = "|"


def _normalize_combo(value, options, default):
    if isinstance(value, str) and value in options:
        return value
    if isinstance(value, int) and 0 <= value < len(options):
        return options[value]
    try:
        idx = int(value)
        if 0 <= idx < len(options):
            return options[idx]
    except (ValueError, TypeError):
        pass
    return default


def _sanitize_relpath(relpath):
    """Sanitize a relative path to prevent path traversal and normalize separators."""
    if not relpath:
        return ""
    relpath = relpath.replace("\\", "/")
    while relpath.startswith("/"):
        relpath = relpath[1:]
    if len(relpath) >= 2 and relpath[1] == ":" and relpath[0].isalpha():
        relpath = relpath[2:]
        while relpath.startswith("/"):
            relpath = relpath[1:]
    parts = []
    for seg in relpath.split("/"):
        if seg == "" or seg == ".":
            continue
        if seg == "..":
            if parts:
                parts.pop()
            continue
        parts.append(seg)
    return "/".join(parts)


def _parse_text_list_entry(entry):
    """Parse a single text_list line into (comfy_name, original_relpath)."""
    entry = entry.strip()
    if not entry:
        return None, None
    if PATH_SEPARATOR not in entry:
        return entry, _sanitize_relpath(entry) or entry
    parts = entry.split(PATH_SEPARATOR, 1)
    comfy_name = parts[0].strip()
    raw_relpath = parts[1].strip()
    sanitized = _sanitize_relpath(raw_relpath)
    if sanitized:
        return comfy_name, sanitized
    return comfy_name, comfy_name


class BatchLoadTexts:
    """批量加载文本，支持直接输入或从文件读取，用于 wildcards 组合"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "source_mode": (["direct", "files"], {"default": "direct"}),
                "text_list": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                    },
                ),
                "file_mode": (["one_per_file", "lines_per_file"], {"default": "one_per_file"}),
                "max_texts": ("INT", {"default": 0, "min": 0, "max": 100000, "step": 1}),
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

    RETURN_TYPES = ("STRING", "STRING", "INT", "INT", "STRING", "INT")
    RETURN_NAMES = ("text", "all_texts", "current_index", "seed_out", "filename", "loop_index")
    FUNCTION = "load_texts"

    def load_texts(self, source_mode: str, text_list: str, file_mode,
                   max_texts: int, mode: str, index: int,
                   seed=-1, queue_count=0,
                   shuffle: bool = False, allow_duplicate: bool = True,
                   trigger: bool = True,
                   queue_threshold=199, check_interval_ms=1000):
        file_mode = _normalize_combo(file_mode, ["one_per_file", "lines_per_file"], "one_per_file")
        source_mode = _normalize_combo(source_mode, ["direct", "files"], "direct")
        mode = _normalize_combo(mode, ["batch", "single"], "batch")
        # 防御空字符串：前端可能传入空值
        try:
            queue_threshold = int(queue_threshold) if queue_threshold != '' else 199
        except (ValueError, TypeError):
            queue_threshold = 199
        try:
            check_interval_ms = int(check_interval_ms) if check_interval_ms != '' else 1000
        except (ValueError, TypeError):
            check_interval_ms = 1000

        # 根据 source_mode 获取 entries 和对应的文件名
        if source_mode == "direct":
            # 直接输入模式：一行一个文本，文件名为空
            entries = [x.strip() for x in (text_list or "").splitlines() if x.strip()]
            filenames = ["" for _ in entries]
        else:
            # 文件模式：返回 (文本, 文件名) 元组列表
            entries_with_files = self._load_from_files_with_names(text_list, file_mode)
            entries = [e[0] for e in entries_with_files]
            filenames = [e[1] for e in entries_with_files]

        if len(entries) == 0:
            raise ValueError("text_list is empty")

        if max_texts and max_texts > 0:
            entries = entries[:max_texts]
            filenames = filenames[:max_texts]

        total = len(entries)
        loop_index = 0

        # 确定实际使用的种子：seed==-1 时生成随机种子
        effective_seed = seed if seed >= 0 else random.randint(0, 2147483647)

        if mode == "single":
            # 根据 shuffle/seed/allow_duplicate 计算实际输出索引
            effective_index = self._resolve_index(
                total, index, shuffle, allow_duplicate, effective_seed
            )
            # 计算循环索引：当 allow_duplicate=True 时，index 可以超过 total
            # loop_index 表示当前是第几轮循环（从0开始）
            if total > 0 and allow_duplicate:
                loop_index = index // total
            current_filename = filenames[effective_index] if effective_index < len(filenames) else ""
            return (entries[effective_index], "\n".join(entries), effective_index, effective_seed, current_filename, loop_index)

        # batch mode: 同样支持 shuffle，返回按规则计算的第一个
        effective_index = self._resolve_index(
            total, 0, shuffle, allow_duplicate, effective_seed
        )
        current_filename = filenames[effective_index] if effective_index < len(filenames) else ""
        return (entries[effective_index], "\n".join(entries), effective_index, effective_seed, current_filename, loop_index)

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

    def _load_from_files(self, text_list: str, file_mode: str):
        """从文件加载文本（兼容旧接口）"""
        entries_with_names = self._load_from_files_with_names(text_list, file_mode)
        return [e[0] for e in entries_with_names]

    def _load_from_files_with_names(self, text_list: str, file_mode):
        file_mode = _normalize_combo(file_mode, ["one_per_file", "lines_per_file"], "one_per_file")
        """从文件加载文本，返回 (文本, 文件名) 元组列表"""
        entries = []
        file_entries = [_parse_text_list_entry(x) for x in (text_list or "").splitlines()]
        file_entries = [(c, p) for c, p in file_entries if c]

        for comfy_name, original_relpath in file_entries:
            if not folder_paths.exists_annotated_filepath(comfy_name):
                continue

            file_path = folder_paths.get_annotated_filepath(comfy_name)
            # 提取文件名（不含扩展名）
            filename = os.path.splitext(os.path.basename(file_path))[0]

            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read()
            except Exception:
                continue

            if file_mode == "one_per_file":
                # 整个文件作为一个 entry（保留原始空行/首尾空白）
                if content.strip():
                    entries.append((content, filename))
            else:
                # 文件内每行作为一个 entry，每行都关联同一个文件名
                for line in content.splitlines():
                    line = line.strip()
                    if line:
                        entries.append((line, filename))

        return entries

    def _load_from_files_with_names_and_indices(self, text_list: str, file_mode):
        """从文件加载文本，返回 (文本, 文件名, 源行索引) 元组列表。
        源行索引是 text_list 中对应文件的行号（从 0 开始）。
        """
        file_mode = _normalize_combo(file_mode, ["one_per_file", "lines_per_file"], "one_per_file")
        entries = []
        lines = (text_list or "").splitlines()

        for line_idx, raw_line in enumerate(lines):
            comfy_name, original_relpath = _parse_text_list_entry(raw_line)
            if not comfy_name:
                continue

            if not folder_paths.exists_annotated_filepath(comfy_name):
                continue

            file_path = folder_paths.get_annotated_filepath(comfy_name)
            filename = os.path.splitext(os.path.basename(file_path))[0]

            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read()
            except Exception:
                continue

            if file_mode == "one_per_file":
                if content.strip():
                    entries.append((content, filename, line_idx))
            else:
                for line in content.splitlines():
                    line = line.strip()
                    if line:
                        entries.append((line, filename, line_idx))

        return entries

    @classmethod
    def IS_CHANGED(s, source_mode: str, text_list: str, file_mode: str,
                   max_texts: int, mode: str, index: int,
                   seed: int = -1, queue_count: int = 0,
                   shuffle: bool = False, allow_duplicate: bool = True,
                   trigger: bool = True):
        m = hashlib.sha256()
        
        # 计算 entries 用于 hash
        if source_mode == "direct":
            entries = [x.strip() for x in (text_list or "").splitlines() if x.strip()]
        else:
            # 文件模式：需要读取文件内容
            entries = []
            file_entries = [_parse_text_list_entry(x) for x in (text_list or "").splitlines()]
            file_entries = [(c, p) for c, p in file_entries if c]
            
            for comfy_name, _ in file_entries:
                if folder_paths.exists_annotated_filepath(comfy_name):
                    file_path = folder_paths.get_annotated_filepath(comfy_name)
                    if os.path.isfile(file_path):
                        try:
                            with open(file_path, "rb") as f:
                                entries.append(f.read().decode('utf-8'))
                        except Exception:
                            pass
        
        if max_texts and max_texts > 0:
            entries = entries[:max_texts]

        if mode == "single":
            if index < 0:
                index = 0
            if index >= len(entries):
                index = len(entries) - 1
            entries = entries[:1] if len(entries) == 0 else [entries[index]]

        m.update(str(source_mode).encode("utf-8"))
        m.update(str(file_mode).encode("utf-8"))
        m.update(str(mode).encode("utf-8"))
        m.update(str(index).encode("utf-8"))
        m.update(str(max_texts).encode("utf-8"))
        m.update(str(queue_count).encode("utf-8"))
        m.update(str(shuffle).encode("utf-8"))
        m.update(str(allow_duplicate).encode("utf-8"))
        m.update(str(seed).encode("utf-8"))
        for entry in entries:
            m.update(entry.encode("utf-8") if isinstance(entry, str) else entry)

        return m.digest().hex()

    @classmethod
    def VALIDATE_INPUTS(s, source_mode: str, text_list: str, file_mode: str,
                        max_texts: int, mode: str, index: int,
                        seed: int = -1, queue_count: int = 0,
                        shuffle: bool = False, allow_duplicate: bool = True,
                        trigger: bool = True):
        # 防御 None 值：可选输入未连接时可能传入 None
        index = 0 if index is None else index
        shuffle = True if shuffle else False
        allow_duplicate = False if allow_duplicate is False else True
        
        # 检查是否有内容
        if source_mode == "direct":
            entries = [x.strip() for x in (text_list or "").splitlines() if x.strip()]
            if len(entries) == 0:
                return "text_list is empty"
        else:
            # 文件模式：检查是否有有效文件
            file_entries = [_parse_text_list_entry(x) for x in (text_list or "").splitlines()]
            file_entries = [(c, p) for c, p in file_entries if c]
            
            if len(file_entries) == 0:
                return "text_list is empty"
            
            valid = False
            for comfy_name, _ in file_entries:
                if folder_paths.exists_annotated_filepath(comfy_name):
                    valid = True
                    break
            
            if not valid:
                return "No valid text files in text_list"

        # 计算 entries 用于验证 index
        if source_mode == "direct":
            entries = [x.strip() for x in (text_list or "").splitlines() if x.strip()]
        else:
            # 文件模式下无法预知最终 entries 数量，跳过 index 验证
            entries = list(range(100))  # 假设足够大

        if max_texts and max_texts > 0:
            entries = entries[:max_texts]

        if mode == "single":
            if index < 0:
                return "index must be >= 0"
            # 当 allow_duplicate=True 时，index 可以超过 total，用于循环入队
            # 所以只在 shuffle=False 且 allow_duplicate=False 时检查范围
            if not shuffle and not allow_duplicate:
                if index >= len(entries):
                    return f"index out of range (0..{len(entries)-1})"

        return True

    @classmethod
    def generate_queue_sequence(cls, source_mode: str, text_list: str, file_mode: str,
                                max_texts: int, queue_count: int, shuffle: bool,
                                allow_duplicate: bool, seed: int):
        """生成入队序列，返回索引列表"""

        # 计算 entries 数量
        if source_mode == "direct":
            entries = [x.strip() for x in (text_list or "").splitlines() if x.strip()]
        else:
            # 文件模式需要实际加载
            entries = cls._load_entries_for_sequence(text_list, file_mode)

        if len(entries) == 0:
            return []

        if max_texts and max_texts > 0:
            entries = entries[:max_texts]

        total_entries = len(entries)

        # 确定实际入队次数
        count = queue_count if queue_count > 0 else total_entries

        # 确定实际使用的种子
        effective_seed = seed if seed >= 0 else random.randint(0, 2147483647)
        rng = random.Random(effective_seed)

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
                # 允许重复：循环使用，返回实际索引值以便后端计算 loop_index
                return list(range(count))
            else:
                # 不允许重复：只取前count个（不超过总数）
                return indices[:min(count, total_entries)]

    @classmethod
    def _load_entries_for_sequence(cls, text_list: str, file_mode):
        file_mode = _normalize_combo(file_mode, ["one_per_file", "lines_per_file"], "one_per_file")
        """为序列生成加载 entries（类方法版本）"""
        entries = []
        file_entries = [_parse_text_list_entry(x) for x in (text_list or "").splitlines()]
        file_entries = [(c, p) for c, p in file_entries if c]

        for comfy_name, original_relpath in file_entries:
            if not folder_paths.exists_annotated_filepath(comfy_name):
                continue

            file_path = folder_paths.get_annotated_filepath(comfy_name)
            
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read()
            except Exception:
                continue

            if file_mode == "one_per_file":
                if content.strip():
                    entries.append(content)
            else:
                for line in content.splitlines():
                    line = line.strip()
                    if line:
                        entries.append(line)

        return entries
