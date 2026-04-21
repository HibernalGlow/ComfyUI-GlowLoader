"""Tests for BatchLoadImages and BatchSaveImages nodes."""
import os
import sys
import shutil
import tempfile

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
    """Create a small test image at *path*."""
    img = Image.new("RGB", size, color)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    img.save(path, format=fmt)


def _make_test_structure(root):
    """Create a directory tree with images:

    root/
      a.png
      sub/
        b.png
        deep/
          c.png
    """
    _make_test_image(os.path.join(root, "a.png"), color=(255, 0, 0))
    _make_test_image(os.path.join(root, "sub", "b.png"), color=(0, 255, 0))
    _make_test_image(os.path.join(root, "sub", "deep", "c.png"), color=(0, 0, 255))
    return root


# ---------------------------------------------------------------------------
# BatchLoadImages tests
# ---------------------------------------------------------------------------

class TestBatchLoadImages:
    """Test the BatchLoadImages node logic (path handling, format support)."""

    def _make_node(self):
        from batch_load_images import BatchLoadImages
        return BatchLoadImages()

    def test_load_png_images_flat(self, tmp_path):
        """Loading flat images should return correct filenames and paths."""
        _make_test_image(str(tmp_path / "img1.png"), color=(255, 0, 0))
        _make_test_image(str(tmp_path / "img2.png"), color=(0, 255, 0))

        # Simulate the annotated path list that ComfyUI would produce
        image_list = "\n".join(["img1.png", "img2.png"])

        node = self._make_node()
        # Monkey-patch folder_paths helpers for testing
        import batch_load_images
        _orig_exists = batch_load_images.folder_paths.exists_annotated_filepath
        _orig_get = batch_load_images.folder_paths.get_annotated_filepath

        batch_load_images.folder_paths.exists_annotated_filepath = lambda n: os.path.isfile(os.path.join(str(tmp_path), n))
        batch_load_images.folder_paths.get_annotated_filepath = lambda n: os.path.join(str(tmp_path), n)

        try:
            images, filenames, paths = node.load_images(image_list, max_images=0, mode="batch", index=0)
        finally:
            batch_load_images.folder_paths.exists_annotated_filepath = _orig_exists
            batch_load_images.folder_paths.get_annotated_filepath = _orig_get

        assert images.shape[0] == 2
        assert "img1.png" in filenames
        assert "img2.png" in filenames
        # paths should contain the annotated names (flat in this case)
        assert "img1.png" in paths
        assert "img2.png" in paths

    def test_load_images_with_subfolders(self, tmp_path):
        """Images in subfolders should produce paths that include the subfolder."""
        _make_test_structure(str(tmp_path))

        # Simulate folder upload: paths include subfolder structure
        image_list = "\n".join(["a.png", "sub/b.png", "sub/deep/c.png"])

        node = self._make_node()
        import batch_load_images
        _orig_exists = batch_load_images.folder_paths.exists_annotated_filepath
        _orig_get = batch_load_images.folder_paths.get_annotated_filepath

        batch_load_images.folder_paths.exists_annotated_filepath = lambda n: os.path.isfile(os.path.join(str(tmp_path), n))
        batch_load_images.folder_paths.get_annotated_filepath = lambda n: os.path.join(str(tmp_path), n)

        try:
            images, filenames, paths = node.load_images(image_list, max_images=0, mode="batch", index=0)
        finally:
            batch_load_images.folder_paths.exists_annotated_filepath = _orig_exists
            batch_load_images.folder_paths.get_annotated_filepath = _orig_get

        assert images.shape[0] == 3
        # filenames should be basename only
        assert "a.png" in filenames
        assert "b.png" in filenames
        assert "c.png" in filenames
        # paths should preserve subfolder structure
        assert "sub/b.png" in paths
        assert "sub/deep/c.png" in paths

    def test_load_webp_image(self, tmp_path):
        """WebP images should be loadable."""
        img = Image.new("RGB", (32, 32), (128, 128, 0))
        webp_path = os.path.join(str(tmp_path), "test.webp")
        img.save(webp_path, format="WEBP")

        image_list = "test.webp"
        node = self._make_node()
        import batch_load_images
        _orig_exists = batch_load_images.folder_paths.exists_annotated_filepath
        _orig_get = batch_load_images.folder_paths.get_annotated_filepath

        batch_load_images.folder_paths.exists_annotated_filepath = lambda n: os.path.isfile(os.path.join(str(tmp_path), n))
        batch_load_images.folder_paths.get_annotated_filepath = lambda n: os.path.join(str(tmp_path), n)

        try:
            images, filenames, paths = node.load_images(image_list, max_images=0, mode="batch", index=0)
        finally:
            batch_load_images.folder_paths.exists_annotated_filepath = _orig_exists
            batch_load_images.folder_paths.get_annotated_filepath = _orig_get

        assert images.shape[0] == 1
        assert "test.webp" in filenames

    def test_load_single_mode(self, tmp_path):
        """Single mode should return only the selected index."""
        _make_test_image(str(tmp_path / "img0.png"), color=(255, 0, 0))
        _make_test_image(str(tmp_path / "img1.png"), color=(0, 255, 0))
        _make_test_image(str(tmp_path / "img2.png"), color=(0, 0, 255))

        image_list = "img0.png\nimg1.png\nimg2.png"
        node = self._make_node()
        import batch_load_images
        _orig_exists = batch_load_images.folder_paths.exists_annotated_filepath
        _orig_get = batch_load_images.folder_paths.get_annotated_filepath

        batch_load_images.folder_paths.exists_annotated_filepath = lambda n: os.path.isfile(os.path.join(str(tmp_path), n))
        batch_load_images.folder_paths.get_annotated_filepath = lambda n: os.path.join(str(tmp_path), n)

        try:
            images, filenames, paths = node.load_images(image_list, max_images=0, mode="single", index=1)
        finally:
            batch_load_images.folder_paths.exists_annotated_filepath = _orig_exists
            batch_load_images.folder_paths.get_annotated_filepath = _orig_get

        assert images.shape[0] == 1
        assert "img1.png" in filenames

    def test_load_max_images(self, tmp_path):
        """max_images should limit the number of loaded images."""
        for i in range(5):
            _make_test_image(str(tmp_path / f"img{i}.png"), color=(i * 50, 0, 0))

        image_list = "\n".join([f"img{i}.png" for i in range(5)])
        node = self._make_node()
        import batch_load_images
        _orig_exists = batch_load_images.folder_paths.exists_annotated_filepath
        _orig_get = batch_load_images.folder_paths.get_annotated_filepath

        batch_load_images.folder_paths.exists_annotated_filepath = lambda n: os.path.isfile(os.path.join(str(tmp_path), n))
        batch_load_images.folder_paths.get_annotated_filepath = lambda n: os.path.join(str(tmp_path), n)

        try:
            images, filenames, paths = node.load_images(image_list, max_images=3, mode="batch", index=0)
        finally:
            batch_load_images.folder_paths.exists_annotated_filepath = _orig_exists
            batch_load_images.folder_paths.get_annotated_filepath = _orig_get

        assert images.shape[0] == 3


# ---------------------------------------------------------------------------
# BatchSaveImages tests
# ---------------------------------------------------------------------------

class TestBatchSaveImages:
    """Test the BatchSaveImages node logic (folder structure, filename)."""

    def _make_node(self):
        from batch_load_images import BatchSaveImages
        return BatchSaveImages()

    def _make_test_tensors(self, count):
        """Create dummy image tensors."""
        tensors = []
        for i in range(count):
            arr = np.random.randint(0, 256, (32, 32, 3), dtype=np.uint8).astype(np.float32) / 255.0
            tensors.append(torch.from_numpy(arr)[None,])
        return torch.cat(tensors, dim=0)

    def test_save_preserves_subfolder_structure(self, tmp_path):
        """Saving with subfolder paths should recreate the directory tree."""
        node = self._make_node()
        images = self._make_test_tensors(3)

        # paths that include subfolders (as returned from BatchLoadImages)
        paths = "a.png\nsub/b.png\nsub/deep/c.png"
        output_dir = str(tmp_path / "output")

        result = node.save_images(images, paths, output_dir, format="png", quality=95)
        saved = result[0].split("\n")

        # Verify files exist
        assert os.path.isfile(os.path.join(output_dir, "a.png"))
        assert os.path.isfile(os.path.join(output_dir, "sub", "b.png"))
        assert os.path.isfile(os.path.join(output_dir, "sub", "deep", "c.png"))

        # Verify saved_paths contains the full paths
        for p in saved:
            assert os.path.isfile(p)

    def test_save_keeps_original_filename(self, tmp_path):
        """The original filename stem should be preserved (with new extension)."""
        node = self._make_node()
        images = self._make_test_tensors(1)

        paths = "my_photo.png"
        output_dir = str(tmp_path / "output")

        result = node.save_images(images, paths, output_dir, format="png", quality=95)

        saved_file = result[0].strip()
        assert os.path.basename(saved_file) == "my_photo.png"

    def test_save_changes_format(self, tmp_path):
        """Output format should match the specified format."""
        node = self._make_node()
        images = self._make_test_tensors(1)

        paths = "test_img.png"
        output_dir = str(tmp_path / "output")

        result = node.save_images(images, paths, output_dir, format="webp", quality=90)

        saved_file = result[0].strip()
        assert saved_file.endswith(".webp")
        assert os.path.isfile(saved_file)

    def test_save_avoid_overwrite(self, tmp_path):
        """If file already exists, a counter suffix should be added."""
        node = self._make_node()
        output_dir = str(tmp_path / "output")

        # First save
        images1 = self._make_test_tensors(1)
        paths = "dup.png"
        result1 = node.save_images(images1, paths, output_dir, format="png", quality=95)

        # Second save with same name
        images2 = self._make_test_tensors(1)
        result2 = node.save_images(images2, paths, output_dir, format="png", quality=95)

        saved1 = result1[0].strip()
        saved2 = result2[0].strip()

        assert os.path.basename(saved1) == "dup.png"
        assert os.path.basename(saved2) == "dup_1.png"

    def test_save_deep_nested_subfolders(self, tmp_path):
        """Deeply nested folder structures should be preserved."""
        node = self._make_node()
        images = self._make_test_tensors(2)

        paths = "level1/level2/level3/img1.png\nlevel1/level2/img2.png"
        output_dir = str(tmp_path / "output")

        result = node.save_images(images, paths, output_dir, format="png", quality=95)

        assert os.path.isfile(os.path.join(output_dir, "level1", "level2", "level3", "img1.png"))
        assert os.path.isfile(os.path.join(output_dir, "level1", "level2", "img2.png"))

    def test_save_more_images_than_paths(self, tmp_path):
        """If there are more images than paths, fallback naming should be used."""
        node = self._make_node()
        images = self._make_test_tensors(3)

        paths = "a.png\nb.png"  # only 2 paths for 3 images
        output_dir = str(tmp_path / "output")

        result = node.save_images(images, paths, output_dir, format="png", quality=95)
        saved = result[0].split("\n")

        assert len(saved) == 3
        assert os.path.isfile(os.path.join(output_dir, "a.png"))
        assert os.path.isfile(os.path.join(output_dir, "b.png"))
        # Third image gets auto-generated name
        assert os.path.isfile(saved[2])

    def test_save_empty_paths_raises(self, tmp_path):
        """Empty paths should raise ValueError."""
        node = self._make_node()
        images = self._make_test_tensors(1)
        output_dir = str(tmp_path / "output")

        with pytest.raises(ValueError, match="paths is empty"):
            node.save_images(images, "", output_dir, format="png", quality=95)

    def test_save_jpg_format(self, tmp_path):
        """JPG format should produce .jpg files and convert to RGB."""
        node = self._make_node()
        images = self._make_test_tensors(1)

        paths = "photo.png"
        output_dir = str(tmp_path / "output")

        result = node.save_images(images, paths, output_dir, format="jpg", quality=85)
        saved_file = result[0].strip()
        assert saved_file.endswith(".jpg")
        assert os.path.isfile(saved_file)

        # Verify it's a valid image
        with Image.open(saved_file) as img:
            assert img.mode == "RGB"

    def test_save_default_output_dir(self, tmp_path):
        """When output_dir is empty, should use ComfyUI's output directory."""
        node = self._make_node()
        images = self._make_test_tensors(1)

        import batch_load_images
        _orig_get = batch_load_images.folder_paths.get_output_directory
        mock_output = str(tmp_path / "comfy_output")
        os.makedirs(mock_output, exist_ok=True)
        batch_load_images.folder_paths.get_output_directory = lambda: mock_output

        try:
            result = node.save_images(images, "test.png", "", format="png", quality=95)
            saved_file = result[0].strip()
            assert saved_file.startswith(mock_output)
            assert os.path.isfile(saved_file)
        finally:
            batch_load_images.folder_paths.get_output_directory = _orig_get


# ---------------------------------------------------------------------------
# Integration: Load → Save round-trip
# ---------------------------------------------------------------------------

class TestRoundTrip:
    """End-to-end: load images with subfolder paths, then save them."""

    def test_load_then_save_preserves_structure(self, tmp_path):
        """Images loaded from subfolders should be saved back with the same structure."""
        from batch_load_images import BatchLoadImages, BatchSaveImages

        # Setup source directory with subfolders
        src = str(tmp_path / "source")
        _make_test_structure(src)

        # --- Load ---
        load_node = BatchLoadImages()
        import batch_load_images
        _orig_exists = batch_load_images.folder_paths.exists_annotated_filepath
        _orig_get = batch_load_images.folder_paths.get_annotated_filepath

        batch_load_images.folder_paths.exists_annotated_filepath = lambda n: os.path.isfile(os.path.join(src, n))
        batch_load_images.folder_paths.get_annotated_filepath = lambda n: os.path.join(src, n)

        try:
            image_list = "a.png\nsub/b.png\nsub/deep/c.png"
            images, filenames, paths = load_node.load_images(image_list, max_images=0, mode="batch", index=0)
        finally:
            batch_load_images.folder_paths.exists_annotated_filepath = _orig_exists
            batch_load_images.folder_paths.get_annotated_filepath = _orig_get

        # --- Save ---
        output_dir = str(tmp_path / "output")
        save_node = BatchSaveImages()
        result = save_node.save_images(images, paths, output_dir, format="png", quality=95)

        # Verify structure is preserved
        assert os.path.isfile(os.path.join(output_dir, "a.png"))
        assert os.path.isfile(os.path.join(output_dir, "sub", "b.png"))
        assert os.path.isfile(os.path.join(output_dir, "sub", "deep", "c.png"))

        # Verify pixel values are preserved (at least for lossless png)
        for orig_rel, orig_color in [
            ("a.png", (255, 0, 0)),
            ("sub/b.png", (0, 255, 0)),
            ("sub/deep/c.png", (0, 0, 255)),
        ]:
            orig_img = Image.open(os.path.join(src, orig_rel)).convert("RGB")
            saved_img = Image.open(os.path.join(output_dir, orig_rel)).convert("RGB")
            np.testing.assert_array_equal(np.array(orig_img), np.array(saved_img))
