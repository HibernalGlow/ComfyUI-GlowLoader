from trigger_lora_stack import GlowTriggerLoRAStack


def test_global_input_text_enables_lora():
    node = GlowTriggerLoRAStack()

    stack, active, _ = node.build_lora_stack(
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

    stack, active, _ = node.build_lora_stack(
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


def test_disabled_switch_blocks_lora_even_when_trigger_matches():
    node = GlowTriggerLoRAStack()

    stack, active, _ = node.build_lora_stack(
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
