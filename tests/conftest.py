"""conftest.py — mock ComfyUI runtime modules so batch_load_images can be imported in tests."""
import sys
import types

# folder_paths mock
folder_paths = types.ModuleType("folder_paths")
folder_paths.exists_annotated_filepath = lambda name: False
folder_paths.get_annotated_filepath = lambda name: name
folder_paths.get_output_directory = lambda: "/tmp/comfyui_output"
sys.modules["folder_paths"] = folder_paths

# node_helpers mock
node_helpers = types.ModuleType("node_helpers")
node_helpers.pillow = lambda fn, *args, **kwargs: fn(*args, **kwargs)
sys.modules["node_helpers"] = node_helpers
