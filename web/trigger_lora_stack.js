import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const MAX_TRIGGER_LORAS = 30;
const HIDDEN_WIDGET_HEIGHT = -4;
const COMPACT_TEXT_HEIGHT = 26;
const COMPACT_ROW_HEIGHT = 16;
const COMPACT_ROW_GAP = 2;
const RESIZE_GUARD_INTERVAL_MS = 150;
const AUTO_TRIGGER_PROP = "_glow_trigger_lora_auto_triggers";
const LEGACY_WIDGET_COUNT = 2 + MAX_TRIGGER_LORAS * 5;
const CURRENT_WIDGET_COUNT = 2 + MAX_TRIGGER_LORAS * 6;

function getWidget(node, name) {
    return node?.widgets?.find((widget) => widget.name === name);
}

function isWeightWidgetName(name) {
    return /^model_weight_\d+$/.test(name || "") || /^clip_weight_\d+$/.test(name || "");
}

function normalizeWeightValue(value, fallback = 1.0) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed || trimmed.toLowerCase() === "none" || trimmed.toLowerCase() === "null") return fallback;
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : fallback;
    }
    return fallback;
}

function sanitizeWeightWidget(widget) {
    if (!widget || !isWeightWidgetName(widget.name)) return false;
    const next = normalizeWeightValue(widget.value, 1.0);
    if (widget.value === next) return false;
    widget.value = next;
    if (widget.inputEl) widget.inputEl.value = String(next);
    return true;
}

function sanitizeWeightWidgets(node) {
    let changed = false;
    for (const widget of node?.widgets || []) {
        changed = sanitizeWeightWidget(widget) || changed;
    }
    return changed;
}

function legacyWidgetNames() {
    const names = ["lora_count", "input_text"];
    for (let i = 1; i <= MAX_TRIGGER_LORAS; i++) {
        names.push(
            `enable_${i}`,
            `lora_name_${i}`,
            `model_weight_${i}`,
            `clip_weight_${i}`,
            `trigger_${i}`
        );
    }
    return names;
}

function setRawWidgetValue(widget, value) {
    if (!widget) return;
    widget.value = value;
    if (widget.inputEl) widget.inputEl.value = value == null ? "" : String(value);
}

function migrateLegacyWidgetValues(node, serialized) {
    const values = serialized?.widgets_values;
    if (!Array.isArray(values) || values.length < LEGACY_WIDGET_COUNT) return false;

    const loraTrigger1Slot = values[7];
    if (typeof loraTrigger1Slot !== "boolean") return false;

    const byName = new Map((node.widgets || []).map((widget) => [widget.name, widget]));
    const legacyNames = legacyWidgetNames();
    for (let index = 0; index < legacyNames.length; index++) {
        setRawWidgetValue(byName.get(legacyNames[index]), values[index]);
    }

    const hasTailTriggers = values.length >= CURRENT_WIDGET_COUNT;
    for (let i = 1; i <= MAX_TRIGGER_LORAS; i++) {
        const value = hasTailTriggers ? values[LEGACY_WIDGET_COUNT + i - 1] : "";
        setRawWidgetValue(byName.get(`lora_trigger_${i}`), value || "");
    }

    sanitizeWeightWidgets(node);
    return true;
}

function setWidgetVisible(widget, visible) {
    if (!widget) return;
    sanitizeWeightWidget(widget);
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
        widget.serializeValue = () => {
            sanitizeWeightWidget(widget);
            return widget._glowTriggerLoraOriginal.serializeValue?.call(widget) ?? widget.value;
        };
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

function compactLoraTriggerWidgets(node) {
    for (let i = 1; i <= MAX_TRIGGER_LORAS; i++) {
        const widget = getWidget(node, `lora_trigger_${i}`);
        if (!widget) continue;
        widget.computeSize = (width) => [width, COMPACT_TEXT_HEIGHT];
        compactTextElement(widget.inputEl);
        compactTextElement(widget.element);
        compactTextElement(widget.el);
    }
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
        labels[`trigger_${i}`] = `匹配词 ${i}`;
        labels[`lora_trigger_${i}`] = `LoRA触发词 ${i}`;
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
    const count = clampCount(getWidget(node, "lora_count")?.value ?? 0);
    const visibleWidgetRows = 2 + count * 6; // lora_count + input_text + 6 controls per LoRA
    const widgetHeight =
        26 +
        COMPACT_ROW_HEIGHT +
        COMPACT_TEXT_HEIGHT +
        count * 6 * COMPACT_ROW_HEIGHT +
        visibleWidgetRows * COMPACT_ROW_GAP;
    const slotRows = Math.max(count + 2, 5);
    const slotHeight = 24 + slotRows * 16;
    return Math.ceil(Math.max(widgetHeight, slotHeight, 140) + 8);
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

    const originalOnSerialize = node.onSerialize;
    node.onSerialize = function (serialized) {
        sanitizeWeightWidgets(this);
        const result = originalOnSerialize?.apply(this, arguments);
        applyCompactSize(this, serialized);
        return result;
    };

    const originalSerialize = node.serialize;
    if (typeof originalSerialize === "function") {
        node.serialize = function () {
            sanitizeWeightWidgets(this);
            const serialized = originalSerialize.apply(this, arguments);
            applyCompactSize(this, serialized);
            return serialized;
        };
    }
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

function compactSize(node) {
    const width = Math.max(node.size?.[0] || 420, 420);
    return [width, estimateCompactHeight(node)];
}

function applyCompactSize(node, serialized = null) {
    const size = compactSize(node);
    node._glowTriggerLoraResizing = true;
    try {
        node.size = [...size];
        node.setSize?.([...size]);
        node.size[0] = size[0];
        node.size[1] = size[1];
        patchNodeCSSSize(node);
        if (serialized && typeof serialized === "object") {
            serialized.size = [...size];
            serialized.properties = serialized.properties || {};
            serialized.properties._glow_trigger_lora_compact_size = [...size];
        }
        node.properties = node.properties || {};
        node.properties._glow_trigger_lora_compact_size = [...size];
    } finally {
        node._glowTriggerLoraResizing = false;
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
        applyCompactSize(node);
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

function getAutoTriggerState(node, index) {
    return node?.properties?.[AUTO_TRIGGER_PROP]?.[String(index)] || null;
}

function setAutoTriggerState(node, index, loraName, trigger) {
    if (!node) return;
    node.properties = node.properties || {};
    node.properties[AUTO_TRIGGER_PROP] = node.properties[AUTO_TRIGGER_PROP] || {};
    node.properties[AUTO_TRIGGER_PROP][String(index)] = {
        lora_name: loraName || "None",
        trigger: trigger || "",
    };
}

function setWidgetValue(widget, value) {
    if (!widget) return;
    widget.value = value || "";
    widget.callback?.(widget.value);
}

async function fetchLoraTrigger(loraName) {
    if (!loraName || loraName === "None") return "";
    try {
        const resp = await api.fetchApi("/glowloader/lora_trigger", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lora_name: loraName }),
        });
        if (!resp.ok) return "";
        const json = await resp.json();
        return json.trigger || "";
    } catch (error) {
        console.warn("[GlowTriggerLoRAStack] failed to load lora trigger", error);
        return "";
    }
}

async function syncLoraTriggerWidget(node, index, { force = false } = {}) {
    const loraWidget = getWidget(node, `lora_name_${index}`);
    const triggerWidget = getWidget(node, `lora_trigger_${index}`);
    if (!loraWidget || !triggerWidget) return;

    const loraName = loraWidget.value || "None";
    const current = triggerWidget.value || "";
    const state = getAutoTriggerState(node, index);
    const shouldReplace =
        force ||
        current === "" ||
        (state && state.lora_name === loraName && current === (state.trigger || ""));

    if (!shouldReplace) return;

    const trigger = await fetchLoraTrigger(loraName);
    const nextLoraName = loraWidget.value || "None";
    if (nextLoraName !== loraName) return;

    setWidgetValue(triggerWidget, trigger);
    setAutoTriggerState(node, index, loraName, trigger);
    app.graph.setDirtyCanvas(true, true);
}

function installLoraNameCallbacks(node) {
    for (let i = 1; i <= MAX_TRIGGER_LORAS; i++) {
        const widget = getWidget(node, `lora_name_${i}`);
        if (!widget || widget._glowTriggerLoraNameCallbackInstalled) continue;
        widget._glowTriggerLoraNameCallbackInstalled = true;
        const originalCallback = widget.callback;
        widget.callback = function (value) {
            originalCallback?.call(this, value);
            syncLoraTriggerWidget(node, i, { force: true });
        };
    }
}

function syncVisibleLoraTriggers(node) {
    const count = clampCount(getWidget(node, "lora_count")?.value ?? 0);
    for (let i = 1; i <= count; i++) {
        syncLoraTriggerWidget(node, i);
    }
}

function updateVisibleGroups(node) {
    sanitizeWeightWidgets(node);
    installCompactSizing(node);
    compactInputTextWidget(node);
    compactLoraTriggerWidgets(node);
    installLoraNameCallbacks(node);
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
            `lora_trigger_${i}`,
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
    syncVisibleLoraTriggers(node);
    app.graph.setDirtyCanvas(true, true);
}

app.registerExtension({
    name: "GlowLoader.TriggerLoRAStack",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "GlowTriggerLoRAStack") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = origOnNodeCreated?.apply(this, arguments);
            sanitizeWeightWidgets(this);
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
            migrateLegacyWidgetValues(this, arguments[0]);
            sanitizeWeightWidgets(this);
            localizeWidgets(this);
            updateVisibleGroups(this);
            return result;
        };
    },

    loadedGraphNode(node) {
        const nodeName = node.comfyClass || node.type || node.constructor?.nodeData?.name;
        if (nodeName !== "GlowTriggerLoRAStack") return;
        sanitizeWeightWidgets(node);
        updateVisibleGroups(node);
    },
});
