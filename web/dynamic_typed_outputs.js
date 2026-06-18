import { app } from "../../../scripts/app.js";

const NODE_NAME = "GlowDynamicTypedOutputs";
const MAX_DYNAMIC_OUTPUTS = 30;
const HIDDEN_WIDGET_HEIGHT = -4;
const MIN_NODE_WIDTH = 360;
const DEFAULTABLE_TYPES = new Set(["STRING", "INT", "FLOAT", "BOOLEAN", "COMBO"]);
const RESIZE_GUARD_INTERVAL_MS = 150;

function getWidget(node, name) {
    return node?.widgets?.find((widget) => widget.name === name);
}

function clampCount(value) {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed)) return 1;
    return Math.max(1, Math.min(MAX_DYNAMIC_OUTPUTS, parsed));
}

function normalizeType(type, customType = "") {
    const normalized = String(type || "FLOAT").trim().toUpperCase();
    if (!normalized || normalized === "*" || normalized === "ANY") return "FLOAT";
    if (normalized === "CUSTOM") {
        const custom = String(customType || "").trim().toUpperCase();
        return custom || "FLOAT";
    }
    return normalized;
}

function cleanTypeWidget(widget) {
    if (!widget) return;
    const value = String(widget.value ?? "").trim().toUpperCase();
    if (!value || value === "*" || value === "ANY") {
        widget.value = "FLOAT";
    }

    for (const holder of [widget, widget.options]) {
        if (!holder || typeof holder !== "object") continue;
        for (const key of ["values", "items", "options"]) {
            if (!Array.isArray(holder[key])) continue;
            holder[key] = holder[key].filter((item) => {
                const text = String(item ?? "").trim().toUpperCase();
                return text && text !== "*" && text !== "ANY";
            });
        }
    }
}

function selectedType(node, index) {
    const typeWidget = getWidget(node, `type_${index}`);
    const customWidget = getWidget(node, `custom_type_${index}`);
    return normalizeType(typeWidget?.value, customWidget?.value);
}

function selectedTypeRaw(node, index) {
    return String(getWidget(node, `type_${index}`)?.value || "FLOAT").trim().toUpperCase();
}

function selectedIndex(node) {
    const value = getWidget(node, "index")?.value ?? 1;
    return clampCount(value);
}

function selectedCount(node) {
    const value = getWidget(node, "output_count")?.value ?? node.properties?.outputCount ?? 4;
    return clampCount(value);
}

function displayType(type) {
    return type === "*" ? "ANY" : type;
}

function setWidgetVisible(widget, visible) {
    if (!widget) return;
    if (!widget._glowDynamicOriginal) {
        widget._glowDynamicOriginal = {
            type: widget.type,
            computeSize: widget.computeSize,
            serializeValue: widget.serializeValue,
        };
    }

    if (visible) {
        widget.type = widget._glowDynamicOriginal.type;
        widget.computeSize = widget._glowDynamicOriginal.computeSize;
        widget.serializeValue = widget._glowDynamicOriginal.serializeValue;
        widget.hidden = false;
        if (widget.options) widget.options.hidden = false;
    } else {
        widget.type = "hidden";
        widget.hidden = true;
        if (widget.options) widget.options.hidden = true;
        widget.computeSize = () => [0, HIDDEN_WIDGET_HEIGHT];
        widget.serializeValue = widget._glowDynamicOriginal.serializeValue || (() => widget.value);
    }
}

function getVisibleWidgets(node) {
    return (node.widgets || []).filter((widget) => widget.type !== "hidden" && !widget.hidden);
}

function notifyVue(node) {
    const widgets = node.widgets;
    if (!widgets?.length) return;
    const last = widgets.pop();
    widgets.push(last);
}

function patchNodeCSSSize(node) {
    if (node.id == null) return;
    const element = document.querySelector(`[data-node-id="${node.id}"]`);
    if (!element) return;
    element.style.setProperty("--node-width", `${node.size[0]}px`);
    element.style.setProperty("--node-height", `${node.size[1]}px`);
}

function estimateHeight(node) {
    const count = selectedCount(node);
    let visibleWidgetRows = 2; // output_count + index
    for (let index = 1; index <= count; index += 1) {
        const rawType = selectedTypeRaw(node, index);
        const actualType = selectedType(node, index);
        visibleWidgetRows += 1; // type_N
        if (rawType === "CUSTOM") visibleWidgetRows += 1;
        if (DEFAULTABLE_TYPES.has(actualType)) visibleWidgetRows += 1;
    }
    const slotRows = count + 1;
    return Math.max(110, 42 + visibleWidgetRows * 24 + slotRows * 14);
}

function installSizing(node) {
    if (node._glowDynamicSizingInstalled) return;
    node._glowDynamicSizingInstalled = true;
    node._glowDynamicOriginalComputeSize = node.computeSize?.bind(node);
    node.computeSize = function () {
        const width = Math.max(this.size?.[0] || MIN_NODE_WIDTH, MIN_NODE_WIDTH);
        return [width, estimateHeight(this)];
    };

    const originalOnResize = node.onResize;
    node.onResize = function () {
        const result = originalOnResize?.apply(this, arguments);
        if (!this._glowDynamicResizing) scheduleSizeGuard(this);
        return result;
    };

    const originalOnDrawForeground = node.onDrawForeground;
    node.onDrawForeground = function () {
        const result = originalOnDrawForeground?.apply(this, arguments);
        scheduleSizeGuard(this);
        return result;
    };

    const originalOnSerialize = node.onSerialize;
    node.onSerialize = function (serialized) {
        const result = originalOnSerialize?.apply(this, arguments);
        applyCompactSize(this, serialized);
        return result;
    };

    const originalSerialize = node.serialize;
    if (typeof originalSerialize === "function") {
        node.serialize = function () {
            const serialized = originalSerialize.apply(this, arguments);
            applyCompactSize(this, serialized);
            return serialized;
        };
    }
}

function resizeNode(node) {
    const width = Math.max(node.size?.[0] || MIN_NODE_WIDTH, MIN_NODE_WIDTH);
    const height = estimateHeight(node);
    node._glowDynamicResizing = true;
    try {
        node.size = [width, height];
        node.setSize?.([width, height]);
        node.onResize?.([width, height]);
        patchNodeCSSSize(node);
        notifyVue(node);
        node.setDirtyCanvas?.(true, true);
        node._glowDynamicLastResize = performance.now?.() ?? Date.now();
    } finally {
        node._glowDynamicResizing = false;
    }
}

function compactSize(node) {
    const width = Math.max(node.size?.[0] || MIN_NODE_WIDTH, MIN_NODE_WIDTH);
    return [width, estimateHeight(node)];
}

function applyCompactSize(node, serialized = null) {
    const size = compactSize(node);
    node._glowDynamicResizing = true;
    try {
        node.size = [...size];
        node.setSize?.([...size]);
        patchNodeCSSSize(node);
        if (serialized && typeof serialized === "object") {
            serialized.size = [...size];
            serialized.properties = serialized.properties || {};
            serialized.properties._glow_dynamic_compact_size = [...size];
        }
        node.properties = node.properties || {};
        node.properties._glow_dynamic_compact_size = [...size];
    } finally {
        node._glowDynamicResizing = false;
    }
    return size;
}

function scheduleResize(node) {
    resizeNode(node);
    if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => resizeNode(node));
        requestAnimationFrame(() => requestAnimationFrame(() => resizeNode(node)));
    }
    setTimeout(() => resizeNode(node), 50);
}

function enforceCompactSize(node) {
    if (!node || node.flags?.collapsed) return;
    const now = performance.now?.() ?? Date.now();
    if (now - (node._glowDynamicLastGuard || 0) < RESIZE_GUARD_INTERVAL_MS) return;
    node._glowDynamicLastGuard = now;

    const width = Math.max(node.size?.[0] || MIN_NODE_WIDTH, MIN_NODE_WIDTH);
    const height = estimateHeight(node);
    const currentHeight = Number(node.size?.[1] || 0);
    if (Math.abs(currentHeight - height) <= 2) {
        patchNodeCSSSize(node);
        return;
    }

    node._glowDynamicResizing = true;
    try {
        applyCompactSize(node);
        patchNodeCSSSize(node);
        notifyVue(node);
        node.setDirtyCanvas?.(true, true);
        node._glowDynamicLastResize = now;
    } finally {
        node._glowDynamicResizing = false;
    }
}

function scheduleSizeGuard(node) {
    if (node._glowDynamicGuardQueued) return;
    node._glowDynamicGuardQueued = true;
    const run = () => {
        node._glowDynamicGuardQueued = false;
        enforceCompactSize(node);
    };
    if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(run);
    } else {
        setTimeout(run, 0);
    }
}

function getInputIndex(node, name) {
    return (node.inputs || []).findIndex((input) => input.name === name);
}

function ensureInput(node, name, type, label) {
    let index = getInputIndex(node, name);
    if (index < 0) {
        node.addInput(name, type);
        index = getInputIndex(node, name);
    }
    const input = node.inputs?.[index];
    if (!input) return;
    input.type = type;
    input.label = label;
}

function removeInactiveInputs(node, count) {
    if (!node.inputs) return;
    for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
        const input = node.inputs[index];
        const match = /^input_(\d+)$/.exec(input?.name || "");
        if (match && parseInt(match[1], 10) > count) {
            node.removeInput(index);
        }
    }
}

function ensureOutputCount(node, count) {
    node.outputs = node.outputs || [];
    while (node.outputs.length > count) {
        node.removeOutput(node.outputs.length - 1);
    }
    while (node.outputs.length < count) {
        node.addOutput(`out_${node.outputs.length + 1}`, "*");
    }
}

function syncSlotTypes(node, count) {
    removeInactiveInputs(node, count);
    ensureOutputCount(node, count + 1);

    for (let index = 1; index <= count; index += 1) {
        const type = selectedType(node, index);
        const label = `${index} ${displayType(type)}`;
        ensureInput(node, `input_${index}`, type, label);

        const output = node.outputs[index - 1];
        if (!output) continue;
        output.name = label;
        output.type = type;
        output.label = label;
    }

    syncIndexOutput(node, count);
}

function syncIndexOutput(node, count = selectedCount(node)) {
    const index = selectedIndex(node);
    const selectedOutput = node.outputs?.[count];
    if (selectedOutput) {
        const type = selectedType(node, index);
        const label = `index ${index} ${displayType(type)}`;
        selectedOutput.name = label;
        selectedOutput.type = type;
        selectedOutput.label = label;
    }
    node.properties = node.properties || {};
    node.properties.index = index;
}

function localizeWidgets(node) {
    const labels = {
        output_count: "输出数量",
        index: "索引",
    };
    for (let index = 1; index <= MAX_DYNAMIC_OUTPUTS; index += 1) {
        labels[`type_${index}`] = `类型 ${index}`;
        labels[`custom_type_${index}`] = `自定义类型 ${index}`;
        labels[`default_value_${index}`] = `默认值 ${index}`;
    }
    for (const widget of node.widgets || []) {
        if (labels[widget.name]) widget.label = labels[widget.name];
    }
}

function syncProperties(node, count) {
    node.properties = node.properties || {};
    node.properties.outputCount = count;
    node.properties.index = selectedIndex(node);
    node.properties.outputTypes = [];
    node.properties.customTypes = [];
    for (let index = 1; index <= MAX_DYNAMIC_OUTPUTS; index += 1) {
        node.properties.outputTypes.push(selectedTypeRaw(node, index));
        node.properties.customTypes.push(String(getWidget(node, `custom_type_${index}`)?.value || ""));
    }
}

function updateVisibleWidgets(node, count) {
    for (let index = 1; index <= MAX_DYNAMIC_OUTPUTS; index += 1) {
        const active = index <= count;
        cleanTypeWidget(getWidget(node, `type_${index}`));
        const rawType = selectedTypeRaw(node, index);
        const actualType = selectedType(node, index);
        setWidgetVisible(getWidget(node, `type_${index}`), active);
        setWidgetVisible(getWidget(node, `custom_type_${index}`), active && rawType === "CUSTOM");
        setWidgetVisible(getWidget(node, `default_value_${index}`), active && DEFAULTABLE_TYPES.has(actualType));
    }
}

function updateNode(node) {
    if (node._glowDynamicUpdating) return;
    node._glowDynamicUpdating = true;
    try {
        installSizing(node);
        localizeWidgets(node);

        const countWidget = getWidget(node, "output_count");
        const count = selectedCount(node);
        if (countWidget && countWidget.value !== count) countWidget.value = count;

        const indexWidget = getWidget(node, "index");
        const index = clampCount(indexWidget?.value ?? node.properties?.index ?? 1);
        if (indexWidget && indexWidget.value !== index) indexWidget.value = index;

        updateVisibleWidgets(node, count);
        syncSlotTypes(node, count);
        syncProperties(node, count);
        scheduleResize(node);
        app.graph?.setDirtyCanvas(true, true);
    } finally {
        node._glowDynamicUpdating = false;
    }
}

function wrapWidgetCallback(node, widget) {
    if (!widget || widget._glowDynamicCallbackInstalled) return;
    widget._glowDynamicCallbackInstalled = true;
    const originalCallback = widget.callback;
    widget.callback = function () {
        const result = originalCallback?.apply(this, arguments);
        updateNode(node);
        return result;
    };
}

function wrapIndexCallback(node) {
    const widget = getWidget(node, "index");
    if (!widget || widget._glowDynamicCallbackInstalled) return;
    widget._glowDynamicCallbackInstalled = true;
    const originalCallback = widget.callback;
    widget.callback = function () {
        const result = originalCallback?.apply(this, arguments);
        const index = selectedIndex(node);
        if (widget.value !== index) widget.value = index;
        syncIndexOutput(node);
        notifyVue(node);
        node.setDirtyCanvas?.(true, true);
        app.graph?.setDirtyCanvas(true, true);
        return result;
    };
}

function installCallbacks(node) {
    wrapWidgetCallback(node, getWidget(node, "output_count"));
    wrapIndexCallback(node);
    for (let index = 1; index <= MAX_DYNAMIC_OUTPUTS; index += 1) {
        wrapWidgetCallback(node, getWidget(node, `type_${index}`));
        wrapWidgetCallback(node, getWidget(node, `custom_type_${index}`));
    }
}

app.registerExtension({
    name: "GlowLoader.DynamicTypedOutputs",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = originalOnNodeCreated?.apply(this, arguments);
            installCallbacks(this);
            updateNode(this);
            return result;
        };

        const originalOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = originalOnConfigure?.apply(this, arguments);
            installCallbacks(this);
            updateNode(this);
            return result;
        };
    },

    loadedGraphNode(node) {
        const nodeName = node.comfyClass || node.type || node.constructor?.nodeData?.name;
        if (nodeName !== NODE_NAME) return;
        installCallbacks(node);
        updateNode(node);
    },
});
