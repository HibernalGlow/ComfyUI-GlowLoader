"""Tests for BatchLoadTexts node."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from batch_load_texts import BatchLoadTexts


class TestBatchLoadTexts:
    """测试 BatchLoadTexts 节点"""

    def test_basic_batch_mode_direct(self):
        """测试基本的 batch 模式 - 直接输入"""
        node = BatchLoadTexts()
        text_list = "hello\nworld\ntest"
        result = node.load_texts("direct", text_list, "one_per_file", 0, "batch", 0)
        
        assert result[0] == "hello"  # text output
        assert result[1] == "hello\nworld\ntest"  # all_texts output
        assert result[2] == 0  # current_index

    def test_batch_mode_respects_index(self):
        """普通 ComfyUI 运行时 batch 模式也要按 index 输出当前文本。"""
        node = BatchLoadTexts()
        text_list = "hello\nworld\ntest"
        result = node.load_texts(
            "direct", text_list, "one_per_file", 0, "batch", 1,
            shuffle=False, allow_duplicate=False
        )

        assert result[0] == "world"
        assert result[2] == 1

    def test_single_mode_direct(self):
        """测试 single 模式 - 直接输入"""
        node = BatchLoadTexts()
        text_list = "line1\nline2\nline3"
        
        result = node.load_texts("direct", text_list, "one_per_file", 0, "single", 1)
        assert result[0] == "line2"
        assert result[2] == 1

    def test_max_texts_limit(self):
        """测试 max_texts 限制"""
        node = BatchLoadTexts()
        text_list = "a\nb\nc\nd\ne"
        
        result = node.load_texts("direct", text_list, "one_per_file", 3, "batch", 0)
        assert result[0] == "a"

    def test_empty_list_raises(self):
        """测试空列表抛出异常"""
        node = BatchLoadTexts()
        with pytest.raises(ValueError, match="text_list is empty"):
            node.load_texts("direct", "", "one_per_file", 0, "batch", 0)

    def test_single_mode_index_out_of_range(self):
        """测试 single 模式索引越界处理"""
        node = BatchLoadTexts()
        text_list = "only_one"
        
        # index 超出范围应该被 clamp 到最后一个
        result = node.load_texts("direct", text_list, "one_per_file", 0, "single", 100)
        assert result[0] == "only_one"
        assert result[2] == 0

    def test_string_false_booleans_do_not_shuffle(self):
        """字符串 false 也必须按关闭处理，兼容旧 workflow/前端传值。"""
        node = BatchLoadTexts()
        text_list = "line1\nline2\nline3"

        result = node.load_texts(
            "direct", text_list, "one_per_file", 0, "single", 1,
            shuffle="false", allow_duplicate="false", seed=123
        )

        assert result[0] == "line2"
        assert result[2] == 1


class TestGenerateQueueSequence:
    """测试 generate_queue_sequence 方法"""

    def test_sequential_no_duplicate(self):
        """测试顺序模式，不重复"""
        text_list = "a\nb\nc"
        sequence = BatchLoadTexts.generate_queue_sequence("direct", text_list, "one_per_file", 0, 0, False, False, -1)
        
        # queue_count=0 时，按列表数量返回
        assert len(sequence) == 3
        assert sequence == [0, 1, 2]

    def test_sequential_with_duplicate(self):
        """测试顺序模式，允许重复"""
        text_list = "a\nb"
        sequence = BatchLoadTexts.generate_queue_sequence("direct", text_list, "one_per_file", 0, 5, False, True, -1)
        
        # 应该循环 5 次
        assert len(sequence) == 5
        assert sequence == [0, 1, 0, 1, 0]

    def test_string_false_sequence_is_sequential(self):
        """字符串 false 不能触发乱序分支。"""
        text_list = "a\nb\nc"
        sequence = BatchLoadTexts.generate_queue_sequence(
            "direct", text_list, "one_per_file", 0, 3, "false", "false", 42
        )

        assert sequence == [0, 1, 2]

    def test_shuffle_no_duplicate(self):
        """测试乱序模式，不重复"""
        text_list = "a\nb\nc\nd"
        sequence = BatchLoadTexts.generate_queue_sequence("direct", text_list, "one_per_file", 0, 8, True, False, 42)
        
        # 8 次，4 个元素，应该每轮都打乱
        assert len(sequence) == 8
        # 使用固定种子，结果可复现
        sequence2 = BatchLoadTexts.generate_queue_sequence("direct", text_list, "one_per_file", 0, 8, True, False, 42)
        assert sequence == sequence2

    def test_shuffle_with_duplicate(self):
        """测试乱序模式，允许重复"""
        text_list = "a\nb\nc"
        sequence = BatchLoadTexts.generate_queue_sequence("direct", text_list, "one_per_file", 0, 10, True, True, 123)
        
        assert len(sequence) == 10
        # 所有索引都应在有效范围内
        assert all(0 <= i < 3 for i in sequence)

    def test_max_texts_with_sequence(self):
        """测试 max_texts 限制与序列生成"""
        text_list = "a\nb\nc\nd\ne"
        sequence = BatchLoadTexts.generate_queue_sequence("direct", text_list, "one_per_file", 3, 0, False, False, -1)
        
        # max_texts=3，只使用前 3 个
        assert len(sequence) == 3
        assert all(0 <= i < 3 for i in sequence)

    def test_empty_list_returns_empty(self):
        """测试空列表返回空序列"""
        sequence = BatchLoadTexts.generate_queue_sequence("direct", "", "one_per_file", 0, 10, True, True, -1)
        assert sequence == []

    def test_seed_reproducibility(self):
        """测试种子可复现性"""
        text_list = "a\nb\nc\nd\ne\nf\ng\nh"
        
        seq1 = BatchLoadTexts.generate_queue_sequence("direct", text_list, "one_per_file", 0, 20, True, True, 999)
        seq2 = BatchLoadTexts.generate_queue_sequence("direct", text_list, "one_per_file", 0, 20, True, True, 999)
        
        assert seq1 == seq2


class TestValidateInputs:
    """测试 VALIDATE_INPUTS 方法"""

    def test_valid_batch(self):
        result = BatchLoadTexts.VALIDATE_INPUTS("direct", "a\nb\nc", "one_per_file", 0, "batch", 0)
        assert result is True

    def test_valid_single(self):
        result = BatchLoadTexts.VALIDATE_INPUTS("direct", "a\nb\nc", "one_per_file", 0, "single", 1)
        assert result is True

    def test_empty_list_error(self):
        result = BatchLoadTexts.VALIDATE_INPUTS("direct", "", "one_per_file", 0, "batch", 0)
        assert result == "text_list is empty"

    def test_single_index_negative(self):
        result = BatchLoadTexts.VALIDATE_INPUTS("direct", "a\nb", "one_per_file", 0, "single", -1)
        assert result == "index must be >= 0"

    def test_single_index_out_of_range(self):
        result = BatchLoadTexts.VALIDATE_INPUTS("direct", "a\nb", "one_per_file", 0, "single", 5)
        assert "index out of range" in result


class TestFileMode:
    """测试文件模式"""

    def test_file_mode_one_per_file(self, tmp_path):
        """测试文件模式：整个文件作为一个条目"""
        # 创建测试文件
        test_file = tmp_path / "test.txt"
        test_file.write_text("line1\nline2\nline3", encoding="utf-8")
        
        # 模拟文件路径解析
        import batch_load_texts
        orig_exists = batch_load_texts.folder_paths.exists_annotated_filepath
        orig_get = batch_load_texts.folder_paths.get_annotated_filepath
        
        try:
            batch_load_texts.folder_paths.exists_annotated_filepath = lambda n: os.path.isfile(str(test_file))
            batch_load_texts.folder_paths.get_annotated_filepath = lambda n: str(test_file)
            
            node = BatchLoadTexts()
            # text_list 包含文件名
            result = node.load_texts("files", "test.txt", "one_per_file", 0, "batch", 0)
            
            # 整个文件内容作为一个条目
            assert result[0] == "line1\nline2\nline3"
        finally:
            batch_load_texts.folder_paths.exists_annotated_filepath = orig_exists
            batch_load_texts.folder_paths.get_annotated_filepath = orig_get

    def test_file_mode_lines_per_file(self, tmp_path):
        """测试文件模式：文件每行作为一个条目"""
        # 创建测试文件
        test_file = tmp_path / "test.txt"
        test_file.write_text("prompt1\nprompt2\nprompt3", encoding="utf-8")
        
        import batch_load_texts
        orig_exists = batch_load_texts.folder_paths.exists_annotated_filepath
        orig_get = batch_load_texts.folder_paths.get_annotated_filepath
        
        try:
            batch_load_texts.folder_paths.exists_annotated_filepath = lambda n: os.path.isfile(str(test_file))
            batch_load_texts.folder_paths.get_annotated_filepath = lambda n: str(test_file)
            
            node = BatchLoadTexts()
            result = node.load_texts("files", "test.txt", "lines_per_file", 0, "batch", 0)
            
            # 每行作为一个条目
            assert result[0] == "prompt1"
            assert result[1] == "prompt1\nprompt2\nprompt3"
        finally:
            batch_load_texts.folder_paths.exists_annotated_filepath = orig_exists
            batch_load_texts.folder_paths.get_annotated_filepath = orig_get


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
