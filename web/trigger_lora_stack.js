import { app } from "../../../scripts/app.js";

const MAX_TRIGGER_LORAS = 30;
const HIDDEN_WIDGET_HEIGHT = -4;
const COMPACT_TEXT_HEIGHT = 26;
const COMPACT_ROW_HEIGHT = 16;
const COMPACT_ROW_GAP = 2;
const RESIZE_GUARD_INTERVAL_MS = 150;

function getWidget(node, name) {
    return node?.widgets?.find((widget) => widget.name === name);
}

function setWidgetVisible(widget, visible) {
    if (!widget) return;
    if (!widget._glowTriggerLoraOriginal) {
        widget._glowTriggerLoraOriginal = {
            type: widget.type,
            computeSize: widget.computeSize,
            serializeValue: widget.serializeValue,
        };
    }
    if (visible) {
        widget.type = widget._glowTriggerLoraOriginal.type;
        widget.computeSize = widget._glowTriggerLoraOriginal.computeSize;
        widget.serializeValue = widget._glowTriggerLoraOriginal.serializeValue;
        widget.hidden = false;
        if (widget.options) widget.options.hidden = false;
    } else {
        widget.type = "hidden";
        widget.hidden = true;
        if (widget.options) widget.options.hidden = true;
        widget.computeSize = () => [0, HIDDEN_WIDGET_HEIGHT];
        widget.serializeValue = widget._glowTriggerLoraOriginal.serializeValue || (() => widget.value);
    }
}

function notifyVue(node) {
    const widgets = node.widgets;
    if (!widgets?.length) return;
    const last = widgets.pop();
    widgets.push(last);
}

function patchNodeCSSSize(node) {
    if (node.id == null) return;
    const el = document.querySelector(`[data-node-id="${node.id}"]`);
    if (!el) return;
    el.style.setProperty("--node-width", `${node.size[0]}px`);
    el.style.setProperty("--node-height", `${node.size[1]}px`);
}

function compactTextElement(element) {
    if (!element) return;
    const targets = [];
    if (element.tagName === "TEXTAREA" || element.tagName === "INPUT") targets.push(element);
    if (element.querySelectorAll) targets.push(...element.querySelectorAll("textarea, input"));
    for (const target of targets) {
        target.rows = 1;
        target.style.height = "26px";
        target.style.minHeight = "26px";
        target.style.maxHeight = "26px";
        target.style.resize = "none";
        target.style.overflow = "hidden";
    }
}

function compactInputTextWidget(node) {
    const widget = getWidget(node, "input_text");
    if (!widget) return;
    widget.computeSize = (width) => [width, COMPACT_TEXT_HEIGHT];
    if (widget.options && typeof widget.options === "object") {
        widget.options.multiline = false;
        widget.options.rows = 1;
    }
    compactTextElement(widget.inputEl);
    compactTextElement(widget.element);
    compactTextElement(widget.el);
    if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => {
            compactTextElement(widget.inputEl);
            compactTextElement(widget.element);
            compactTextElement(widget.el);
        });
    }
    setTimeout(() => {
        compactTextElement(widget.inputEl);
        compactTextElement(widget.element);
        compactTextElement(widget.el);
    }, 50);
}

function getVisibleWidgets(node) {
    return (node.widgets || []).filter((widget) => widget.type !== "hidden" && !widget.hidden);
}

function getCompactWidgetHeight(widget, width) {
    if (widget.name === "input_text") return COMPACT_TEXT_HEIGHT;
    const size = widget.computeSize?.(width);
    const height = Number(size?.[1]);
    if (Number.isFinite(height) && height > 0 && height <= 22) return height;
    return COMPACT_ROW_HEIGHT;
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

function estimateCompactHeight(node) {
    const width = Math.max(node.size?.[0] || 420, 420);
    const visibleWidgets = getVisibleWidgets(node);

    let layoutBottom = 0;
    for (const widget of visibleWidgets) {
        const y = Number(widget.last_y);
        if (Number.isFinite(y) && y > 0 && y < 5000) {
            layoutBottom = Math.max(layoutBottom, y + getCompactWidgetHeight(widget, width) + 8);
        }
    }

    const widgetHeight =
        26 +
        visibleWidgets.reduce(
            (total, widget) => total + getCompactWidgetHeight(widget, width) + COMPACT_ROW_GAP,
            0
        );
    if (layoutBottom > widgetHeight + 80) {
        layoutBottom = 0;
    }
    const slotRows = Math.max(node.inputs?.length || 0, node.outputs?.length || 0);
    const slotHeight = 24 + slotRows * 16;
    return Math.ceil(Math.max(layoutBottom || widgetHeight, widgetHeight, slotHeight, 140) + 8);
}

function installCompactSizing(node) {
    if (node._glowTriggerLoraCompactSizingInstalled) return;
    node._glowTriggerLoraCompactSizingInstalled = true;
    node._glowTriggerLoraOriginalComputeSize = node.computeSize?.bind(node);
    node.computeSize = function () {
        const width = Math.max(this.size?.[0] || 420, 420);
        return [width, estimateCompactHeight(this)];
    };

    const originalOnResize = node.onResize;
    node.onResize = function () {
        const result = originalOnResize?.apply(this, arguments);
        if (!this._glowTriggerLoraResizing) scheduleSizeGuard(this);
        return result;
    };

    const originalOnDrawForeground = node.onDrawForeground;
    node.onDrawForeground = function () {
        const result = originalOnDrawForeground?.apply(this, arguments);
        scheduleSizeGuard(this);
        return result;
    };
}

function resizeNode(node) {
    const width = Math.max(node.size?.[0] || 420, 420);
    if (node.size) node.size[1] = 0;
    const height = estimateCompactHeight(node);
    node._glowTriggerLoraResizing = true;
    try {
        node.size = [width, height];
        node.setSize?.([width, height]);
        node.size[0] = width;
        node.size[1] = height;
        node.onResize?.([width, height]);
        patchNodeCSSSize(node);
        notifyVue(node);
        node.setDirtyCanvas?.(true, true);
        node._glowTriggerLoraLastResize = performance.now?.() ?? Date.now();
    } finally {
        node._glowTriggerLoraResizing = false;
    }
}

function scheduleResize(node) {
    resizeNode(node);
    if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => resizeNode(node));
        requestAnimationFrame(() => requestAnimationFrame(() => resizeNode(node)));
    }
    setTimeout(() => resizeNode(node), 50);
    setTimeout(() => resizeNode(node), 200);
}

function enforceCompactSize(node) {
    if (!node || node.flags?.collapsed) return;
    const now = performance.now?.() ?? Date.now();
    if (now - (node._glowTriggerLoraLastGuard || 0) < RESIZE_GUARD_INTERVAL_MS) return;
    node._glowTriggerLoraLastGuard = now;

    compactInputTextWidget(node);
    const width = Math.max(node.size?.[0] || 420, 420);
    const height = estimateCompactHeight(node);
    const currentHeight = Number(node.size?.[1] || 0);
    if (Math.abs(currentHeight - height) <= 2) {
        patchNodeCSSSize(node);
        return;
    }

    node._glowTriggerLoraResizing = true;
    try {
        node.size = [width, height];
        node.setSize?.([width, height]);
        node.size[0] = width;
        node.size[1] = height;
        patchNodeCSSSize(node);
        notifyVue(node);
        node.setDirtyCanvas?.(true, true);
        node._glowTriggerLoraLastResize = now;
    } finally {
        node._glowTriggerLoraResizing = false;
    }
}

function scheduleSizeGuard(node) {
    if (node._glowTriggerLoraGuardQueued) return;
    node._glowTriggerLoraGuardQueued = true;
    const run = () => {
        node._glowTriggerLoraGuardQueued = false;
        enforceCompactSize(node);
    };
    if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(run);
    } else {
        setTimeout(run, 0);
    }
}

function updateVisibleGroups(node) {
    installCompactSizing(node);
    compactInputTextWidget(node);
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
    scheduleResize(node);
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

    loadedGraphNode(node) {
        const nodeName = node.comfyClass || node.type || node.constructor?.nodeData?.name;
        if (nodeName !== "GlowTriggerLoRAStack") return;
        updateVisibleGroups(node);
    },
});
