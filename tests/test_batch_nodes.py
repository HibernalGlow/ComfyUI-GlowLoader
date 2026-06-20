"""Tests for BatchLoadImages and BatchSaveImages nodes."""
import os
import sys

# Ensure the parent directory is on sys.path so we can import batch_load_images
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
import pytest
import torch
from PIL import Image


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_test_image(path, size=(64, 48), color=(255, 0, 0), fmt="PNG"):
    img = Image.new("RGB", size, color)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    img.save(path, format=fmt)


def _make_test_structure(root):
    """root/a.png, root/sub/b.png, root/sub/deep/c.png"""
    _make_test_image(os.path.join(root, "a.png"), color=(255, 0, 0))
    _make_test_image(os.path.join(root, "sub", "b.png"), color=(0, 255, 0))
    _make_test_image(os.path.join(root, "sub", "deep", "c.png"), color=(0, 0, 255))


def _make_deep_nested_structure(root):
    """root/top.png, root/L1/img1.png, ..., root/L1/L2/L3/L4/img4.png, root/L1_sib/sibling.png"""
    _make_test_image(os.path.join(root, "top.png"), color=(255, 0, 0))
    _make_test_image(os.path.join(root, "L1", "img1.png"), color=(0, 255, 0))
    _make_test_image(os.path.join(root, "L1", "L2", "img2.png"), color=(0, 0, 255))
    _make_test_image(os.path.join(root, "L1", "L2", "L3", "img3.png"), color=(255, 255, 0))
    _make_test_image(os.path.join(root, "L1", "L2", "L3", "L4", "img4.png"), color=(0, 255, 255))
    _make_test_image(os.path.join(root, "L1_sib", "sibling.png"), color=(255, 0, 255))


def _patch_folder_paths(module, base_dir):
    _orig_exists = module.folder_paths.exists_annotated_filepath
    _orig_get = module.folder_paths.get_annotated_filepath
    module.folder_paths.exists_annotated_filepath = lambda n: os.path.isfile(os.path.join(base_dir, n))
    module.folder_paths.get_annotated_filepath = lambda n: os.path.join(base_dir, n)
    return _orig_exists, _orig_get


def _restore_folder_paths(module, orig_exists, orig_get):
    module.folder_paths.exists_annotated_filepath = orig_exists
    module.folder_paths.get_annotated_filepath = orig_get


# ---------------------------------------------------------------------------
# _parse_image_list_entry unit tests
# ---------------------------------------------------------------------------

class TestParseImageListEntry:
    def test_plain_filename(self):
        from batch_load_images import _parse_image_list_entry
        c, p = _parse_image_list_entry("photo.png")
        assert c == "photo.png"
        assert p == "photo.png"

    def test_pipe_separated(self):
        from batch_load_images import _parse_image_list_entry
        c, p = _parse_image_list_entry("photo.png|sub/deep/photo.png")
        assert c == "photo.png"
        assert p == "sub/deep/photo.png"

    def test_deep_nested(self):
        from batch_load_images import _parse_image_list_entry
        c, p = _parse_image_list_entry("img4.png|L1/L2/L3/L4/img4.png")
        assert c == "img4.png"
        assert p == "L1/L2/L3/L4/img4.png"

    def test_empty(self):
        from batch_load_images import _parse_image_list_entry
        c, p = _parse_image_list_entry("")
        assert c is None
        assert p is None

    def test_whitespace(self):
        from batch_load_images import _parse_image_list_entry
        c, p = _parse_image_list_entry("  photo.png | sub/dir/photo.png  ")
        assert c == "photo.png"
        assert p == "sub/dir/photo.png"

    def test_windows_backslash_path(self):
        from batch_load_images import _parse_image_list_entry
        c, p = _parse_image_list_entry("photo.png|sub\\deep\\photo.png")
        assert c == "photo.png"
        assert p == "sub/deep/photo.png"

    def test_leading_slash_stripped(self):
        from batch_load_images import _parse_image_list_entry
        c, p = _parse_image_list_entry("photo.png|/sub/deep/photo.png")
        assert c == "photo.png"
        assert p == "sub/deep/photo.png"

    def test_windows_drive_letter_stripped(self):
        from batch_load_images import _parse_image_list_entry
        c, p = _parse_image_list_entry("photo.png|C:/sub/deep/photo.png")
        assert c == "photo.png"
        assert p == "sub/deep/photo.png"

    def test_path_traversal_removed(self):
        from batch_load_images import _parse_image_list_entry
        c, p = _parse_image_list_entry("photo.png|../../../etc/passwd")
        assert c == "photo.png"
        assert p == "etc/passwd"

    def test_path_traversal_in_middle(self):
        from batch_load_images import _parse_image_list_entry
        c, p = _parse_image_list_entry("photo.png|sub/../../etc/photo.png")
        assert c == "photo.png"
        assert p == "etc/photo.png"

    def test_dot_components_removed(self):
        from batch_load_images import _parse_image_list_entry
        c, p = _parse_image_list_entry("photo.png|./sub/./deep/./photo.png")
        assert c == "photo.png"
        assert p == "sub/deep/photo.png"

    def test_unicode_filename(self):
        from batch_load_images import _parse_image_list_entry
        c, p = _parse_image_list_entry("photo.png|图片/风景/photo.png")
        assert c == "photo.png"
        assert p == "图片/风景/photo.png"

    def test_spaces_in_path(self):
        from batch_load_images import _parse_image_list_entry
        c, p = _parse_image_list_entry("photo.png|My Photos/Summer Trip/photo.png")
        assert c == "photo.png"
        assert p == "My Photos/Summer Trip/photo.png"

    def test_double_slash_collapsed(self):
        from batch_load_images import _parse_image_list_entry
        c, p = _parse_image_list_entry("photo.png|sub//deep///photo.png")
        assert c == "photo.png"
        assert p == "sub/deep/photo.png"


class TestSanitizeRelpath:
    def test_basic(self):
        from batch_load_images import _sanitize_relpath
        assert _sanitize_relpath("sub/deep/photo.png") == "sub/deep/photo.png"

    def test_backslash(self):
        from batch_load_images import _sanitize_relpath
        assert _sanitize_relpath("sub\\deep\\photo.png") == "sub/deep/photo.png"

    def test_leading_slash(self):
        from batch_load_images import _sanitize_relpath
        assert _sanitize_relpath("/sub/deep/photo.png") == "sub/deep/photo.png"

    def test_multiple_leading_slashes(self):
        from batch_load_images import _sanitize_relpath
        assert _sanitize_relpath("///sub/photo.png") == "sub/photo.png"

    def test_drive_letter(self):
        from batch_load_images import _sanitize_relpath
        assert _sanitize_relpath("C:/sub/photo.png") == "sub/photo.png"
        assert _sanitize_relpath("D:\\sub\\photo.png") == "sub/photo.png"

    def test_traversal_above_root(self):
        from batch_load_images import _sanitize_relpath
        # All .. should be consumed without going above root
        assert _sanitize_relpath("../../../etc/passwd") == "etc/passwd"

    def test_traversal_partial(self):
        from batch_load_images import _sanitize_relpath
        assert _sanitize_relpath("a/b/../../c/photo.png") == "c/photo.png"

    def test_empty(self):
        from batch_load_images import _sanitize_relpath
        assert _sanitize_relpath("") == ""

    def test_only_dots(self):
        from batch_load_images import _sanitize_relpath
        assert _sanitize_relpath("../../..") == ""

    def test_mixed_backslash_and_traversal(self):
        from batch_load_images import _sanitize_relpath
        assert _sanitize_relpath("..\\..\\sub\\photo.png") == "sub/photo.png"


# ---------------------------------------------------------------------------
# BatchLoadImages tests
# ---------------------------------------------------------------------------

class TestBatchLoadImages:

    def _make_node(self):
        from batch_load_images import BatchLoadImages
        return BatchLoadImages()

    def test_seed_widget_does_not_auto_increment(self):
        from batch_load_images import BatchLoadImages

        seed_options = BatchLoadImages.INPUT_TYPES()["optional"]["seed"][1]

        assert seed_options["default"] == -1
        assert "control_after_generate" not in seed_options

    def test_random_seed_mode_changes_cache_key(self):
        from batch_load_images import BatchLoadImages

        args = ("missing.png", 0, "single", 0)

        first = BatchLoadImages.IS_CHANGED(*args, seed=-1)
        second = BatchLoadImages.IS_CHANGED(*args, seed=-1)

        assert first != second

    def test_load_flat(self, tmp_path):
        _make_test_image(str(tmp_path / "img1.png"), color=(255, 0, 0))
        _make_test_image(str(tmp_path / "img2.png"), color=(0, 255, 0))

        node = self._make_node()
        import batch_load_images
        orig = _patch_folder_paths(batch_load_images, str(tmp_path))
        try:
            images, filenames, paths = node.load_images("img1.png\nimg2.png", 0, "batch", 0)
        finally:
            _restore_folder_paths(batch_load_images, *orig)

        assert images.shape[0] == 2
        assert "img1.png" in filenames
        assert "img2.png" in filenames
        assert "img1.png" in paths
        assert "img2.png" in paths

    def test_load_with_pipe_encoded_paths(self, tmp_path):
        """Simulate what the JS would produce after a folder upload:
        comfy_name|original_relpath"""
        _make_test_image(str(tmp_path / "a.png"), color=(255, 0, 0))
        _make_test_image(str(tmp_path / "b.png"), color=(0, 255, 0))
        _make_test_image(str(tmp_path / "c.png"), color=(0, 0, 255))

        # Files uploaded flat to input, but original paths preserved via |
        image_list = "a.png|a.png\nb.png|sub/b.png\nc.png|sub/deep/c.png"

        node = self._make_node()
        import batch_load_images
        orig = _patch_folder_paths(batch_load_images, str(tmp_path))
        try:
            images, filenames, paths = node.load_images(image_list, 0, "batch", 0)
        finally:
            _restore_folder_paths(batch_load_images, *orig)

        assert images.shape[0] == 3
        # filenames are basenames from original_relpath
        assert "a.png" in filenames
        assert "b.png" in filenames
        assert "c.png" in filenames
        # paths preserve original folder structure
        assert "a.png" in paths
        assert "sub/b.png" in paths
        assert "sub/deep/c.png" in paths

    def test_load_deep_recursive_with_pipe(self, tmp_path):
        src = str(tmp_path / "source")
        _make_deep_nested_structure(src)

        # All files are flat in input, but original paths encoded with |
        image_list = "\n".join([
            "top.png|top.png",
            "img1.png|L1/img1.png",
            "img2.png|L1/L2/img2.png",
            "img3.png|L1/L2/L3/img3.png",
            "img4.png|L1/L2/L3/L4/img4.png",
            "sibling.png|L1_sib/sibling.png",
        ])

        node = self._make_node()
        import batch_load_images
        orig = _patch_folder_paths(batch_load_images, src)
        try:
            images, filenames, paths = node.load_images(image_list, 0, "batch", 0)
        finally:
            _restore_folder_paths(batch_load_images, *orig)

        assert images.shape[0] == 6
        for fn in ["top.png", "img1.png", "img2.png", "img3.png", "img4.png", "sibling.png"]:
            assert fn in filenames

        path_list = paths.split("\n")
        assert "L1/img1.png" in path_list
        assert "L1/L2/img2.png" in path_list
        assert "L1/L2/L3/img3.png" in path_list
        assert "L1/L2/L3/L4/img4.png" in path_list
        assert "L1_sib/sibling.png" in path_list

    def test_load_single_mode_picks_correct_image(self, tmp_path):
        _make_test_image(str(tmp_path / "a.png"), color=(255, 0, 0))
        _make_test_image(str(tmp_path / "b.png"), color=(0, 255, 0))

        node = self._make_node()
        import batch_load_images
        orig = _patch_folder_paths(batch_load_images, str(tmp_path))
        try:
            images, filenames, paths = node.load_images(
                "a.png|root/a.png\nb.png|sub/b.png", 0, "single", 1,
            )
        finally:
            _restore_folder_paths(batch_load_images, *orig)

        assert images.shape[0] == 1
        assert "b.png" in filenames
        assert "sub/b.png" in paths


# ---------------------------------------------------------------------------
# BatchSaveImages tests
# ---------------------------------------------------------------------------

class TestBatchSaveImages:

    def _make_node(self):
        from batch_load_images import BatchSaveImages
        return BatchSaveImages()

    def _make_test_tensors(self, count):
        tensors = []
        for i in range(count):
            arr = np.random.randint(0, 256, (32, 32, 3), dtype=np.uint8).astype(np.float32) / 255.0
            tensors.append(torch.from_numpy(arr)[None,])
        return torch.cat(tensors, dim=0)

    def test_save_preserves_subfolders(self, tmp_path):
        node = self._make_node()
        images = self._make_test_tensors(3)
        output_dir = str(tmp_path / "output")

        result = node.save_images(images, "a.png\nsub/b.png\nsub/deep/c.png", output_dir, "png", 95)

        assert os.path.isfile(os.path.join(output_dir, "a.png"))
        assert os.path.isfile(os.path.join(output_dir, "sub", "b.png"))
        assert os.path.isfile(os.path.join(output_dir, "sub", "deep", "c.png"))

    def test_save_deep_recursive(self, tmp_path):
        node = self._make_node()
        images = self._make_test_tensors(5)
        output_dir = str(tmp_path / "output")

        paths = "top.png\nL1/img1.png\nL1/L2/img2.png\nL1/L2/L3/img3.png\nL1/L2/L3/L4/img4.png"
        result = node.save_images(images, paths, output_dir, "png", 95)

        assert os.path.isfile(os.path.join(output_dir, "top.png"))
        assert os.path.isfile(os.path.join(output_dir, "L1", "img1.png"))
        assert os.path.isfile(os.path.join(output_dir, "L1", "L2", "img2.png"))
        assert os.path.isfile(os.path.join(output_dir, "L1", "L2", "L3", "img3.png"))
        assert os.path.isfile(os.path.join(output_dir, "L1", "L2", "L3", "L4", "img4.png"))

    def test_save_multiple_branches(self, tmp_path):
        node = self._make_node()
        images = self._make_test_tensors(4)
        output_dir = str(tmp_path / "output")

        paths = "branchA/deep/x/img_a.png\nbranchB/y/img_b.png\nbranchB/deep/z/w/img_c.png\nbranchC/img_d.png"
        node.save_images(images, paths, output_dir, "png", 95)

        assert os.path.isfile(os.path.join(output_dir, "branchA", "deep", "x", "img_a.png"))
        assert os.path.isfile(os.path.join(output_dir, "branchB", "y", "img_b.png"))
        assert os.path.isfile(os.path.join(output_dir, "branchB", "deep", "z", "w", "img_c.png"))
        assert os.path.isfile(os.path.join(output_dir, "branchC", "img_d.png"))

    def test_save_keeps_original_filename_with_format_change(self, tmp_path):
        node = self._make_node()
        images = self._make_test_tensors(1)
        output_dir = str(tmp_path / "output")

        result = node.save_images(images, "sub/deep/my_photo.png", output_dir, "webp", 90)
        saved = result[0].strip()
        assert saved.endswith(os.path.join("sub", "deep", "my_photo.webp"))

    def test_save_avoid_overwrite(self, tmp_path):
        node = self._make_node()
        output_dir = str(tmp_path / "output")

        images1 = self._make_test_tensors(1)
        r1 = node.save_images(images1, "dup.png", output_dir, "png", 95)
        images2 = self._make_test_tensors(1)
        r2 = node.save_images(images2, "dup.png", output_dir, "png", 95)

        assert os.path.basename(r1[0].strip()) == "dup.png"
        assert os.path.basename(r2[0].strip()) == "dup_1.png"

    def test_save_avoid_overwrite_in_subfolder(self, tmp_path):
        node = self._make_node()
        output_dir = str(tmp_path / "output")

        images1 = self._make_test_tensors(1)
        r1 = node.save_images(images1, "sub/deep/img.png", output_dir, "png", 95)
        images2 = self._make_test_tensors(1)
        r2 = node.save_images(images2, "sub/deep/img.png", output_dir, "png", 95)

        assert os.path.basename(r1[0].strip()) == "img.png"
        assert os.path.basename(r2[0].strip()) == "img_1.png"

    def test_save_empty_paths_raises(self, tmp_path):
        node = self._make_node()
        images = self._make_test_tensors(1)
        with pytest.raises(ValueError, match="paths is empty"):
            node.save_images(images, "", str(tmp_path / "output"), "png", 95)

    def test_save_path_traversal_blocked(self, tmp_path):
        """Ensure .. in paths cannot escape the output directory."""
        node = self._make_node()
        images = self._make_test_tensors(1)
        output_dir = str(tmp_path / "output")

        # Try to write to ../../../escape.png — should be sanitized
        node.save_images(images, "../../../escape.png", output_dir, "png", 95)

        # File should be inside output_dir, not above it
        assert not os.path.exists(os.path.join(str(tmp_path), "escape.png"))
        # Should be saved as escape.png inside output_dir (.. stripped)
        assert os.path.isfile(os.path.join(output_dir, "escape.png"))

    def test_save_absolute_path_blocked(self, tmp_path):
        """Ensure absolute paths are treated as relative within output_dir."""
        node = self._make_node()
        images = self._make_test_tensors(1)
        output_dir = str(tmp_path / "output")

        # Absolute path should be sanitized
        node.save_images(images, "/etc/passwd.png", output_dir, "png", 95)
        assert os.path.isfile(os.path.join(output_dir, "etc", "passwd.png"))

    def test_save_windows_drive_path_blocked(self, tmp_path):
        """Windows-style drive letter paths should be sanitized."""
        node = self._make_node()
        images = self._make_test_tensors(1)
        output_dir = str(tmp_path / "output")

        node.save_images(images, "C:/Windows/System32/evil.png", output_dir, "png", 95)
        assert os.path.isfile(os.path.join(output_dir, "Windows", "System32", "evil.png"))

    def test_save_backslash_path_normalized(self, tmp_path):
        """Backslash paths should be normalized to forward slashes."""
        node = self._make_node()
        images = self._make_test_tensors(1)
        output_dir = str(tmp_path / "output")

        node.save_images(images, "sub\\deep\\photo.png", output_dir, "png", 95)
        assert os.path.isfile(os.path.join(output_dir, "sub", "deep", "photo.png"))

    def test_save_unicode_path(self, tmp_path):
        """Unicode paths (Chinese, emoji, etc.) should work."""
        node = self._make_node()
        images = self._make_test_tensors(2)
        output_dir = str(tmp_path / "output")

        node.save_images(images, "图片/风景/photo.png\n folder🐱/emoji/img.png", output_dir, "png", 95)
        assert os.path.isfile(os.path.join(output_dir, "图片", "风景", "photo.png"))
        assert os.path.isfile(os.path.join(output_dir, " folder🐱", "emoji", "img.png"))

    def test_save_spaces_in_path(self, tmp_path):
        """Paths with spaces should be preserved."""
        node = self._make_node()
        images = self._make_test_tensors(1)
        output_dir = str(tmp_path / "output")

        node.save_images(images, "My Photos/Summer Trip/photo.png", output_dir, "png", 95)
        assert os.path.isfile(os.path.join(output_dir, "My Photos", "Summer Trip", "photo.png"))


# ---------------------------------------------------------------------------
# Integration: Load → Save round-trip
# ---------------------------------------------------------------------------

class TestRoundTrip:

    def test_flat_to_flat(self, tmp_path):
        from batch_load_images import BatchLoadImages, BatchSaveImages
        import batch_load_images

        src = str(tmp_path / "source")
        _make_test_image(os.path.join(src, "a.png"), color=(255, 0, 0))
        _make_test_image(os.path.join(src, "b.png"), color=(0, 255, 0))

        load_node = BatchLoadImages()
        orig = _patch_folder_paths(batch_load_images, src)
        try:
            images, filenames, paths = load_node.load_images("a.png\nb.png", 0, "batch", 0)
        finally:
            _restore_folder_paths(batch_load_images, *orig)

        output_dir = str(tmp_path / "output")
        save_node = BatchSaveImages()
        save_node.save_images(images, paths, output_dir, "png", 95)

        assert os.path.isfile(os.path.join(output_dir, "a.png"))
        assert os.path.isfile(os.path.join(output_dir, "b.png"))

    def test_pipe_encoded_preserves_structure(self, tmp_path):
        """The critical test: files are flat in input but | encoding preserves
        the original folder structure through load → save."""
        from batch_load_images import BatchLoadImages, BatchSaveImages
        import batch_load_images

        src = str(tmp_path / "source")
        _make_test_image(os.path.join(src, "a.png"), color=(255, 0, 0))
        _make_test_image(os.path.join(src, "b.png"), color=(0, 255, 0))
        _make_test_image(os.path.join(src, "c.png"), color=(0, 0, 255))

        # Simulate JS output: flat upload + pipe-encoded original paths
        image_list = "a.png|a.png\nb.png|sub/b.png\nc.png|sub/deep/c.png"

        load_node = BatchLoadImages()
        orig = _patch_folder_paths(batch_load_images, src)
        try:
            images, filenames, paths = load_node.load_images(image_list, 0, "batch", 0)
        finally:
            _restore_folder_paths(batch_load_images, *orig)

        output_dir = str(tmp_path / "output")
        save_node = BatchSaveImages()
        save_node.save_images(images, paths, output_dir, "png", 95)

        # Verify folder structure is recreated
        assert os.path.isfile(os.path.join(output_dir, "a.png"))
        assert os.path.isfile(os.path.join(output_dir, "sub", "b.png"))
        assert os.path.isfile(os.path.join(output_dir, "sub", "deep", "c.png"))

        # Verify pixel values match
        for orig_rel, orig_color in [("a.png", (255, 0, 0)), ("sub/b.png", (0, 255, 0)), ("sub/deep/c.png", (0, 0, 255))]:
            orig_img = Image.open(os.path.join(src, os.path.basename(orig_rel))).convert("RGB")
            saved_img = Image.open(os.path.join(output_dir, orig_rel)).convert("RGB")
            np.testing.assert_array_equal(np.array(orig_img), np.array(saved_img))

    def test_deep_recursive_round_trip(self, tmp_path):
        from batch_load_images import BatchLoadImages, BatchSaveImages
        import batch_load_images

        src = str(tmp_path / "source")
        _make_deep_nested_structure(src)

        # All files flat in input, deep paths encoded
        image_list = "\n".join([
            "top.png|top.png",
            "img1.png|L1/img1.png",
            "img2.png|L1/L2/img2.png",
            "img3.png|L1/L2/L3/img3.png",
            "img4.png|L1/L2/L3/L4/img4.png",
            "sibling.png|L1_sib/sibling.png",
        ])

        load_node = BatchLoadImages()
        orig = _patch_folder_paths(batch_load_images, src)
        try:
            images, filenames, paths = load_node.load_images(image_list, 0, "batch", 0)
        finally:
            _restore_folder_paths(batch_load_images, *orig)

        output_dir = str(tmp_path / "output")
        save_node = BatchSaveImages()
        save_node.save_images(images, paths, output_dir, "png", 95)

        assert os.path.isfile(os.path.join(output_dir, "top.png"))
        assert os.path.isfile(os.path.join(output_dir, "L1", "img1.png"))
        assert os.path.isfile(os.path.join(output_dir, "L1", "L2", "img2.png"))
        assert os.path.isfile(os.path.join(output_dir, "L1", "L2", "L3", "img3.png"))
        assert os.path.isfile(os.path.join(output_dir, "L1", "L2", "L3", "L4", "img4.png"))
        assert os.path.isfile(os.path.join(output_dir, "L1_sib", "sibling.png"))
