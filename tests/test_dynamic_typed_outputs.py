from dynamic_typed_outputs import GlowDynamicTypedOutputs, MAX_DYNAMIC_OUTPUTS, OUTPUT_TYPE_CHOICES


def test_connected_inputs_pass_through_before_defaults():
    node = GlowDynamicTypedOutputs()
    model = {"model": object()}

    outputs = node.emit(
        output_count=3,
        input_1="from input",
        input_2=12.5,
        input_3=model,
        index=3,
        type_1="STRING",
        default_value_1="from default",
        type_2="FLOAT",
        default_value_2="0.0",
        type_3="MODEL",
    )

    assert outputs[:3] == ("from input", 12.5, model)
    assert outputs[-1] is model
    assert len(outputs) == MAX_DYNAMIC_OUTPUTS + 1


def test_primitive_defaults_are_coerced_by_selected_type():
    node = GlowDynamicTypedOutputs()

    outputs = node.emit(
        output_count=5,
        type_1="STRING",
        default_value_1="hello",
        type_2="INT",
        default_value_2="7.8",
        type_3="FLOAT",
        default_value_3="2.5",
        type_4="BOOLEAN",
        default_value_4="yes",
        type_5="COMBO",
        default_value_5="option_a",
    )

    assert outputs[:5] == ("hello", 7, 2.5, True, "option_a")


def test_inactive_outputs_return_none_even_when_defaults_exist():
    node = GlowDynamicTypedOutputs()

    outputs = node.emit(
        output_count=1,
        type_1="STRING",
        default_value_1="active",
        type_2="STRING",
        default_value_2="inactive",
    )

    assert outputs[0] == "active"
    assert outputs[1] is None
    assert outputs[MAX_DYNAMIC_OUTPUTS - 1] is None
    assert outputs[-1] == "active"


def test_non_primitive_unconnected_output_defaults_to_none():
    node = GlowDynamicTypedOutputs()

    outputs = node.emit(
        output_count=1,
        type_1="MODEL",
        default_value_1="not a model",
    )

    assert outputs[0] is None


def test_by_index_output_uses_one_based_index():
    node = GlowDynamicTypedOutputs()

    outputs = node.emit(
        output_count=3,
        index=2,
        type_1="STRING",
        default_value_1="first",
        type_2="STRING",
        default_value_2="second",
        type_3="STRING",
        default_value_3="third",
    )

    assert outputs[-1] == "second"


def test_by_index_output_returns_none_when_index_is_inactive():
    node = GlowDynamicTypedOutputs()

    outputs = node.emit(
        output_count=1,
        index=2,
        type_1="STRING",
        default_value_1="first",
        type_2="STRING",
        default_value_2="inactive",
    )

    assert outputs[-1] is None


def test_new_nodes_default_to_float_outputs_not_any_choice():
    assert "*" not in OUTPUT_TYPE_CHOICES

    input_types = GlowDynamicTypedOutputs.INPUT_TYPES()
    assert input_types["required"]["type_1"][1]["default"] == "FLOAT"

    outputs = GlowDynamicTypedOutputs().emit(output_count=2)
    assert outputs[:2] == (0.0, 0.0)


def test_legacy_empty_and_any_type_values_validate_and_fall_back_to_float():
    input_types = GlowDynamicTypedOutputs.INPUT_TYPES()
    type_choices = input_types["required"]["type_26"][0]
    assert "" in type_choices
    assert "*" in type_choices

    outputs = GlowDynamicTypedOutputs().emit(
        output_count=2,
        type_1="",
        default_value_1="1.5",
        type_2="*",
        default_value_2="2.5",
    )

    assert outputs[:2] == (1.5, 2.5)
