import trigger_lora_stack
from trigger_lora_stack import GlowTriggerLoRAStack


def test_global_input_text_enables_lora():
    node = GlowTriggerLoRAStack()

    stack, active, *_ = node.build_lora_stack(
        lora_count=2,
        input_text="masterpiece, blue dress",
        enable_1=True,
        lora_name_1="blue_dress.safetensors",
        model_weight_1=0.8,
        clip_weight_1=0.7,
        trigger_1="blue dress",
        enable_2=True,
        lora_name_2="red_hat.safetensors",
        model_weight_2=1.0,
        clip_weight_2=1.0,
        trigger_2="red hat",
    )

    assert stack == [("blue_dress.safetensors", 0.8, 0.7)]
    assert active == "blue_dress.safetensors"


def test_per_lora_input_text_overrides_global_text():
    node = GlowTriggerLoRAStack()

    stack, active, *_ = node.build_lora_stack(
        lora_count=1,
        input_text="no match",
        input_text_1="this line has cat ears",
        enable_1=True,
        lora_name_1="cat_ears.safetensors",
        model_weight_1=1.0,
        clip_weight_1=1.0,
        trigger_1="cat ears",
    )

    assert stack == [("cat_ears.safetensors", 1.0, 1.0)]
    assert active == "cat_ears.safetensors"


def test_prompt_match_trigger_supports_comma_separated_aliases():
    node = GlowTriggerLoRAStack()

    stack, active, *_ = node.build_lora_stack(
        lora_count=1,
        input_text="portrait with animal ears",
        enable_1=True,
        lora_name_1="cat_ears.safetensors",
        model_weight_1=1.0,
        clip_weight_1=1.0,
        trigger_1="cat ears, animal ears, kemonomimi",
    )

    assert stack == [("cat_ears.safetensors", 1.0, 1.0)]
    assert active == "cat_ears.safetensors"


def test_prompt_match_trigger_supports_chinese_comma_aliases():
    node = GlowTriggerLoRAStack()

    stack, active, *_ = node.build_lora_stack(
        lora_count=1,
        input_text="portrait with animal ears",
        enable_1=True,
        lora_name_1="cat_ears.safetensors",
        model_weight_1=1.0,
        clip_weight_1=1.0,
        trigger_1="cat ears，animal ears、kemonomimi",
    )

    assert stack == [("cat_ears.safetensors", 1.0, 1.0)]
    assert active == "cat_ears.safetensors"


def test_invalid_weight_values_fall_back_to_one():
    node = GlowTriggerLoRAStack()

    stack, active, *_ = node.build_lora_stack(
        lora_count=1,
        input_text="cat ears",
        enable_1=True,
        lora_name_1="cat_ears.safetensors",
        model_weight_1="None",
        clip_weight_1=None,
        trigger_1="cat ears",
    )

    assert stack == [("cat_ears.safetensors", 1.0, 1.0)]
    assert active == "cat_ears.safetensors"


def test_lora_trigger_widgets_are_grouped_with_each_lora(monkeypatch):
    monkeypatch.setattr(trigger_lora_stack.folder_paths, "get_filename_list", lambda name: [], raising=False)

    required = GlowTriggerLoRAStack.INPUT_TYPES()["required"]
    keys = list(required.keys())

    assert keys.index("trigger_1") < keys.index("lora_trigger_1")
    assert keys.index("lora_trigger_1") < keys.index("enable_2")


def test_disabled_switch_blocks_lora_even_when_trigger_matches():
    node = GlowTriggerLoRAStack()

    stack, active, *_ = node.build_lora_stack(
        lora_count=1,
        input_text="cat ears",
        enable_1=False,
        lora_name_1="cat_ears.safetensors",
        model_weight_1=1.0,
        clip_weight_1=1.0,
        trigger_1="cat ears",
    )

    assert stack == []
    assert active == ""


def test_same_name_trigger_file_outputs_lora_own_trigger(tmp_path, monkeypatch):
    lora_dir = tmp_path / "loras"
    lora_dir.mkdir()
    (lora_dir / "cat_ears.trigger.txt").write_text("cat ears\nwhiskers", encoding="utf-8")
    monkeypatch.setattr(trigger_lora_stack.folder_paths, "get_folder_paths", lambda name: [str(lora_dir)], raising=False)

    node = GlowTriggerLoRAStack()
    stack, active, _, active_triggers, all_triggers = node.build_lora_stack(
        lora_count=1,
        input_text="this prompt contains switch words",
        enable_1=True,
        lora_name_1="cat_ears.safetensors",
        model_weight_1=1.0,
        clip_weight_1=1.0,
        trigger_1="switch words",
    )

    assert stack == [("cat_ears.safetensors", 1.0, 1.0)]
    assert active == "cat_ears.safetensors"
    assert active_triggers == "cat ears, whiskers"
    assert all_triggers == "cat ears, whiskers"


def test_trigger_file_skips_comment_lines(tmp_path, monkeypatch):
    lora_dir = tmp_path / "loras"
    lora_dir.mkdir()
    (lora_dir / "arcana.trigger.txt").write_text(
        "# LoRA: anima_cure_arcana_shadow_v1.4\n"
        "# Character trigger: cure arcana shadow\n"
        "#\n"
        "# Prompt (trigger + appearance tags):\n"
        "cure arcana shadow, purple eyes\n"
        "black dress\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(trigger_lora_stack.folder_paths, "get_folder_paths", lambda name: [str(lora_dir)], raising=False)

    node = GlowTriggerLoRAStack()
    _, _, _, active_triggers, all_triggers = node.build_lora_stack(
        lora_count=1,
        input_text="arcana",
        enable_1=True,
        lora_name_1="arcana.safetensors",
        model_weight_1=1.0,
        clip_weight_1=1.0,
        trigger_1="arcana",
    )

    assert active_triggers == "cure arcana shadow, purple eyes, black dress"
    assert all_triggers == "cure arcana shadow, purple eyes, black dress"


def test_lora_own_trigger_does_not_enable_lora_by_itself(tmp_path, monkeypatch):
    lora_dir = tmp_path / "loras"
    lora_dir.mkdir()
    (lora_dir / "cat_ears.trigger.txt").write_text("cat ears", encoding="utf-8")
    monkeypatch.setattr(trigger_lora_stack.folder_paths, "get_folder_paths", lambda name: [str(lora_dir)], raising=False)

    node = GlowTriggerLoRAStack()
    stack, active, _, active_triggers, all_triggers = node.build_lora_stack(
        lora_count=1,
        input_text="no matching switch",
        enable_1=True,
        lora_name_1="cat_ears.safetensors",
        model_weight_1=1.0,
        clip_weight_1=1.0,
        trigger_1="only this switch enables it",
    )

    assert stack == []
    assert active == ""
    assert active_triggers == ""
    assert all_triggers == "cat ears"


def test_manual_lora_trigger_overrides_trigger_file(tmp_path, monkeypatch):
    lora_dir = tmp_path / "loras"
    lora_dir.mkdir()
    (lora_dir / "cat_ears.trigger.txt").write_text("file trigger", encoding="utf-8")
    monkeypatch.setattr(trigger_lora_stack.folder_paths, "get_folder_paths", lambda name: [str(lora_dir)], raising=False)

    node = GlowTriggerLoRAStack()
    _, _, _, active_triggers, all_triggers = node.build_lora_stack(
        lora_count=1,
        input_text="cat",
        enable_1=True,
        lora_name_1="cat_ears.safetensors",
        model_weight_1=1.0,
        clip_weight_1=1.0,
        trigger_1="cat",
        lora_trigger_1="manual trigger",
    )

    assert active_triggers == "manual trigger"
    assert all_triggers == "manual trigger"
