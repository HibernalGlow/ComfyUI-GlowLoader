import { app } from "../../../scripts/app.js";

const MAX_TRIGGER_LORAS = 30;

function getWidget(node, name) {
    return node?.widgets?.find((widget) => widget.name === name);
}

function setWidgetVisible(widget, visible) {
    if (!widget) return;
    if (!widget._glowTriggerLoraOriginal) {
        widget._glowTriggerLoraOriginal = {
            type: widget.type,
            computeSize: widget.computeSize,
        };
    }
    if (visible) {
        widget.type = widget._glowTriggerLoraOriginal.type;
        widget.computeSize = widget._glowTriggerLoraOriginal.computeSize;
    } else {
        widget.type = "hidden";
        widget.computeSize = () => [0, -4];
    }
}

function clampCount(value) {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed)) return 0;
    return Math.max(0, Math.min(MAX_TRIGGER_LORAS, parsed));
}

function getInputIndex(node, name) {
    return (node.inputs || []).findIndex((input) => input.name === name);
}

function ensureInput(node, name) {
    if (getInputIndex(node, name) >= 0) return;
    node.addInput(name, "STRING");
}

function removeInput(node, name) {
    const index = getInputIndex(node, name);
    if (index >= 0) node.removeInput(index);
}

function localizeWidgets(node) {
    const labels = {
        lora_count: "LoRA数量",
        input_text: "匹配文本",
    };
    for (let i = 1; i <= MAX_TRIGGER_LORAS; i++) {
        labels[`enable_${i}`] = `启用 ${i}`;
        labels[`lora_name_${i}`] = `LoRA ${i}`;
        labels[`model_weight_${i}`] = `模型权重 ${i}`;
        labels[`clip_weight_${i}`] = `CLIP权重 ${i}`;
        labels[`trigger_${i}`] = `触发词 ${i}`;
    }
    for (const widget of node.widgets || []) {
        if (labels[widget.name]) widget.label = labels[widget.name];
    }
    for (const input of node.inputs || []) {
        if (input.name === "input_text_in") input.label = "匹配文本";
        const match = /^input_text_(\d+)$/.exec(input.name);
        if (match) input.label = `匹配文本 ${match[1]}`;
    }
}

function resizeNode(node, count) {
    const width = Math.max(node.size?.[0] || 420, 420);
    const height = Math.max(260, 280 + count * 132);
    node.size = [width, height];
    node.setSize?.([width, height]);
}

function updateVisibleGroups(node) {
    const count = clampCount(getWidget(node, "lora_count")?.value ?? 0);
    removeInput(node, "trigger_text_in");
    for (let i = 1; i <= MAX_TRIGGER_LORAS; i++) {
        const visible = i <= count;
        for (const name of [
            `enable_${i}`,
            `lora_name_${i}`,
            `model_weight_${i}`,
            `clip_weight_${i}`,
            `trigger_${i}`,
        ]) {
            setWidgetVisible(getWidget(node, name), visible);
        }
        removeInput(node, `trigger_text_${i}`);
        const inputName = `input_text_${i}`;
        if (visible) {
            ensureInput(node, inputName);
        } else {
            removeInput(node, inputName);
        }
    }
    localizeWidgets(node);
    resizeNode(node, count);
    app.graph.setDirtyCanvas(true, true);
}

app.registerExtension({
    name: "GlowLoader.TriggerLoRAStack",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "GlowTriggerLoRAStack") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = origOnNodeCreated?.apply(this, arguments);
            localizeWidgets(this);
            const node = this;
            const countWidget = getWidget(this, "lora_count");
            if (countWidget && !countWidget._glowTriggerLoraCallbackInstalled) {
                countWidget._glowTriggerLoraCallbackInstalled = true;
                const origCallback = countWidget.callback;
                countWidget.callback = function (value) {
                    origCallback?.call(this, value);
                    updateVisibleGroups(node);
                };
            }
            updateVisibleGroups(this);
            return result;
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = origOnConfigure?.apply(this, arguments);
            localizeWidgets(this);
            updateVisibleGroups(this);
            return result;
        };
    },
});
