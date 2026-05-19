"""Tests for BatchLoadTexts node."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from batch_load_texts import BatchLoadTexts


class TestBatchLoadTexts:
    """测试 BatchLoadTexts 节点"""

    def test_basic_batch_mode(self):
        """测试基本的 batch 模式"""
        node = BatchLoadTexts()
        text_list = "hello\nworld\ntest"
        result = node.load_texts(text_list, 0, "batch", 0)
        
        assert result[0] == "hello"  # text output
        assert result[1] == "hello\nworld\ntest"  # all_texts output
        assert result[2] == 0  # current_index

    def test_single_mode(self):
        """测试 single 模式"""
        node = BatchLoadTexts()
        text_list = "line1\nline2\nline3"
        
        result = node.load_texts(text_list, 0, "single", 1)
        assert result[0] == "line2"
        assert result[2] == 1

    def test_max_texts_limit(self):
        """测试 max_texts 限制"""
        node = BatchLoadTexts()
        text_list = "a\nb\nc\nd\ne"
        
        result = node.load_texts(text_list, 3, "batch", 0)
        assert result[0] == "a"
        # max_texts 只影响返回的第一条，all_texts 仍返回全部

    def test_empty_list_raises(self):
        """测试空列表抛出异常"""
        node = BatchLoadTexts()
        with pytest.raises(ValueError, match="text_list is empty"):
            node.load_texts("", 0, "batch", 0)

    def test_single_mode_index_out_of_range(self):
        """测试 single 模式索引越界处理"""
        node = BatchLoadTexts()
        text_list = "only_one"
        
        # index 超出范围应该被 clamp 到最后一个
        result = node.load_texts(text_list, 0, "single", 100)
        assert result[0] == "only_one"
        assert result[2] == 0


class TestGenerateQueueSequence:
    """测试 generate_queue_sequence 方法"""

    def test_sequential_no_duplicate(self):
        """测试顺序模式，不重复"""
        text_list = "a\nb\nc"
        sequence = BatchLoadTexts.generate_queue_sequence(text_list, 0, 0, False, False, -1)
        
        # queue_count=0 时，按列表数量返回
        assert len(sequence) == 3
        assert sequence == [0, 1, 2]

    def test_sequential_with_duplicate(self):
        """测试顺序模式，允许重复"""
        text_list = "a\nb"
        sequence = BatchLoadTexts.generate_queue_sequence(text_list, 0, 5, False, True, -1)
        
        # 应该循环 5 次
        assert len(sequence) == 5
        assert sequence == [0, 1, 0, 1, 0]

    def test_shuffle_no_duplicate(self):
        """测试乱序模式，不重复"""
        text_list = "a\nb\nc\nd"
        sequence = BatchLoadTexts.generate_queue_sequence(text_list, 0, 8, True, False, 42)
        
        # 8 次，4 个元素，应该每轮都打乱
        assert len(sequence) == 8
        # 使用固定种子，结果可复现
        sequence2 = BatchLoadTexts.generate_queue_sequence(text_list, 0, 8, True, False, 42)
        assert sequence == sequence2

    def test_shuffle_with_duplicate(self):
        """测试乱序模式，允许重复"""
        text_list = "a\nb\nc"
        sequence = BatchLoadTexts.generate_queue_sequence(text_list, 0, 10, True, True, 123)
        
        assert len(sequence) == 10
        # 所有索引都应在有效范围内
        assert all(0 <= i < 3 for i in sequence)

    def test_max_texts_with_sequence(self):
        """测试 max_texts 限制与序列生成"""
        text_list = "a\nb\nc\nd\ne"
        sequence = BatchLoadTexts.generate_queue_sequence(text_list, 3, 0, False, False, -1)
        
        # max_texts=3，只使用前 3 个
        assert len(sequence) == 3
        assert all(0 <= i < 3 for i in sequence)

    def test_empty_list_returns_empty(self):
        """测试空列表返回空序列"""
        sequence = BatchLoadTexts.generate_queue_sequence("", 0, 10, True, True, -1)
        assert sequence == []

    def test_seed_reproducibility(self):
        """测试种子可复现性"""
        text_list = "a\nb\nc\nd\ne\nf\ng\nh"
        
        seq1 = BatchLoadTexts.generate_queue_sequence(text_list, 0, 20, True, True, 999)
        seq2 = BatchLoadTexts.generate_queue_sequence(text_list, 0, 20, True, True, 999)
        
        assert seq1 == seq2


class TestValidateInputs:
    """测试 VALIDATE_INPUTS 方法"""

    def test_valid_batch(self):
        result = BatchLoadTexts.VALIDATE_INPUTS("a\nb\nc", 0, "batch", 0)
        assert result is True

    def test_valid_single(self):
        result = BatchLoadTexts.VALIDATE_INPUTS("a\nb\nc", 0, "single", 1)
        assert result is True

    def test_empty_list_error(self):
        result = BatchLoadTexts.VALIDATE_INPUTS("", 0, "batch", 0)
        assert result == "text_list is empty"

    def test_single_index_negative(self):
        result = BatchLoadTexts.VALIDATE_INPUTS("a\nb", 0, "single", -1)
        assert result == "index must be >= 0"

    def test_single_index_out_of_range(self):
        result = BatchLoadTexts.VALIDATE_INPUTS("a\nb", 0, "single", 5)
        assert "index out of range" in result


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
