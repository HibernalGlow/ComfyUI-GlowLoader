import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

function getTextListWidget(node) {
    return node?.widgets?.find((w) => w.name === "text_list");
}

function clampInt(v, min, max) {
    v = Math.floor(Number(v));
    if (Number.isNaN(v)) v = min;
    if (v < min) v = min;
    if (v > max) v = max;
    return v;
}

function parseTextList(text) {
    return (text || "")
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => !!s);
}

function setTextList(node, texts) {
    const w = getTextListWidget(node);
    if (!w) return;
    w.value = (texts || []).join("\n");
    w.callback?.(w.value);
}

function getMaxTextsValue(node) {
    const w = node?.widgets?.find((x) => x.name === "max_texts");
    const v = w?.value;
    return typeof v === "number" ? v : 0;
}

function getWidgetByName(node, name) {
    return node?.widgets?.find((w) => w.name === name);
}

async function queueCurrent(node) {
    const prompt = await app.graphToPrompt();
    await api.queuePrompt(-1, prompt);
}

function deepClone(obj) {
    if (typeof structuredClone === "function") return structuredClone(obj);
    return JSON.parse(JSON.stringify(obj));
}

async function queueAllSequential(node) {
    const texts0 = parseTextList(getTextListWidget(node)?.value);
    if (!texts0 || texts0.length === 0) return;

    const maxTexts = getMaxTextsValue(node);
    const texts = maxTexts && maxTexts > 0 ? texts0.slice(0, maxTexts) : texts0;
    if (texts.length === 0) return;

    const wMode = getWidgetByName(node, "mode");
    const wIndex = getWidgetByName(node, "index");
    if (!wMode || !wIndex) {
        // Fallback: modify prompt JSON directly.
        const basePrompt = await app.graphToPrompt();
        const nodeId = String(node.id);
        for (let i = 0; i < texts.length; i++) {
            const prompt = deepClone(basePrompt);
            const apiNode = prompt.output?.[nodeId];
            if (!apiNode) continue;
            apiNode.inputs = apiNode.inputs || {};
            apiNode.inputs.mode = "single";
            apiNode.inputs.index = i;
            await api.queuePrompt(-1, prompt);
        }
        return;
    }

    const prevMode = wMode.value;
    const prevIndex = wIndex.value;
    try {
        wMode.value = "single";
        wMode.callback?.(wMode.value);
        for (let i = 0; i < texts.length; i++) {
            wIndex.value = i;
            wIndex.callback?.(wIndex.value);
            await queueCurrent(node);
        }
    } finally {
        wMode.value = prevMode;
        wMode.callback?.(wMode.value);
        wIndex.value = prevIndex;
        wIndex.callback?.(wIndex.value);
    }
}

function createTextListUI(node) {
    const container = document.createElement("div");
    container.style.cssText =
        "width:100%;padding:8px;background:var(--comfy-menu-bg);border:1px solid var(--border-color);border-radius:6px;margin:5px 0;pointer-events:auto;";

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;";

    const mkBtn = (label) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.style.cssText =
            "flex:1;padding:8px;background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:13px;min-width:70px;";
        return b;
    };

    const addBtn = mkBtn("添加行");
    const insertBtn = mkBtn("插入行");
    const queueBtn = mkBtn("逐行入队");
    const queueOneBtn = mkBtn("入队当前");

    const clearBtn = document.createElement("button");
    clearBtn.textContent = "清空";
    clearBtn.style.cssText =
        "padding:8px;background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:13px;";

    btnRow.appendChild(addBtn);
    btnRow.appendChild(insertBtn);
    btnRow.appendChild(queueBtn);
    btnRow.appendChild(queueOneBtn);
    btnRow.appendChild(clearBtn);

    const info = document.createElement("div");
    info.style.cssText = "font-size:12px;opacity:0.85;margin-bottom:6px;";

    const listContainer = document.createElement("div");
    listContainer.style.cssText =
        "max-height:300px;overflow-y:auto;background:var(--comfy-input-bg);padding:6px;border-radius:4px;";

    let selectedIndex = -1;

    const updateInfo = () => {
        const texts = parseTextList(getTextListWidget(node)?.value);
        info.textContent = `共 ${texts.length} 行 (当前选中: ${selectedIndex >= 0 ? selectedIndex + 1 : "无"})`;
    };

    const redraw = () => {
        const texts = parseTextList(getTextListWidget(node)?.value);
        listContainer.innerHTML = "";

        if (texts.length === 0) {
            const emptyMsg = document.createElement("div");
            emptyMsg.textContent = "点击「添加行」输入文本，或直接编辑下方文本框";
            emptyMsg.style.cssText = "text-align:center;padding:20px;opacity:0.6;font-size:12px;";
            listContainer.appendChild(emptyMsg);
            selectedIndex = -1;
            updateInfo();
            return;
        }

        const frag = document.createDocumentFragment();
        texts.forEach((text, idx) => {
            const item = document.createElement("div");
            const isSelected = idx === selectedIndex;
            item.style.cssText = `
                display:flex;
                align-items:center;
                gap:8px;
                padding:8px;
                border-bottom:1px solid var(--border-color);
                cursor:pointer;
                background:${isSelected ? 'var(--comfy-menu-bg)' : 'transparent'};
                border-left:3px solid ${isSelected ? '#4a6' : 'transparent'};
            `;

            const num = document.createElement("span");
            num.textContent = `${idx + 1}.`;
            num.style.cssText = "font-size:11px;opacity:0.6;min-width:24px;";

            const content = document.createElement("div");
            content.textContent = text;
            content.title = text;
            content.style.cssText =
                "flex:1;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";

            const del = document.createElement("button");
            del.textContent = "×";
            del.title = "删除";
            del.style.cssText =
                "width:20px;height:20px;background:rgba(255,0,0,0.75);color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:16px;line-height:1;";
            del.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const next = texts.slice(0, idx).concat(texts.slice(idx + 1));
                setTextList(node, next);
                if (selectedIndex === idx) {
                    selectedIndex = -1;
                } else if (selectedIndex > idx) {
                    selectedIndex--;
                }
                redraw();
            };

            item.onclick = () => {
                selectedIndex = idx;
                redraw();
            };

            item.appendChild(num);
            item.appendChild(content);
            item.appendChild(del);
            frag.appendChild(item);
        });

        listContainer.appendChild(frag);
        updateInfo();
        app.graph.setDirtyCanvas(true);
    };

    addBtn.onclick = () => {
        const texts = parseTextList(getTextListWidget(node)?.value);
        texts.push("");
        setTextList(node, texts);
        selectedIndex = texts.length - 1;
        redraw();
        // Focus on editing the new row
        setTimeout(() => {
            editSelectedRow();
        }, 50);
    };

    insertBtn.onclick = () => {
        const texts = parseTextList(getTextListWidget(node)?.value);
        const insertIdx = selectedIndex >= 0 ? selectedIndex : texts.length;
        texts.splice(insertIdx, 0, "");
        setTextList(node, texts);
        selectedIndex = insertIdx;
        redraw();
        setTimeout(() => {
            editSelectedRow();
        }, 50);
    };

    const editSelectedRow = () => {
        if (selectedIndex < 0) return;
        const texts = parseTextList(getTextListWidget(node)?.value);
        if (selectedIndex >= texts.length) return;

        const currentText = texts[selectedIndex];
        const newText = prompt("编辑文本:", currentText);
        if (newText !== null) {
            texts[selectedIndex] = newText.trim();
            setTextList(node, texts);
            redraw();
        }
    };

    queueBtn.onclick = async () => {
        await queueAllSequential(node);
    };

    queueOneBtn.onclick = async () => {
        const wMode = getWidgetByName(node, "mode");
        if (wMode) {
            wMode.value = "single";
            wMode.callback?.(wMode.value);
        }
        await queueCurrent(node);
    };

    clearBtn.onclick = () => {
        if (confirm("确定要清空所有文本吗?")) {
            setTextList(node, []);
            selectedIndex = -1;
            redraw();
        }
    };

    // Double click to edit
    listContainer.addEventListener("dblclick", (e) => {
        const item = e.target.closest("div[onclick]");
        if (item) {
            editSelectedRow();
        }
    });

    container.appendChild(btnRow);
    container.appendChild(info);
    container.appendChild(listContainer);

    return { container, redraw };
}

app.registerExtension({
    name: "BatchLoadTexts.Extension",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "BatchLoadTexts") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);

            const textListWidget = getTextListWidget(this);
            if (textListWidget) {
                // Hide the giant textbox; we manage it through the DOM UI.
                textListWidget.type = "hidden";
                textListWidget.computeSize = () => [0, -4];
            }

            // Create text list UI
            const ui = createTextListUI(this);
            this._batchLoadTextsUI = ui;
            this.addDOMWidget("batch_load_texts", "customwidget", ui.container);
            this.setSize([420, 400]);

            // Keep the DOM list in sync if something else changes the widget.
            if (textListWidget) {
                const origCallback = textListWidget.callback;
                textListWidget.callback = function (value) {
                    origCallback?.call(this, value);
                    ui.redraw();
                };
            }

            ui.redraw();

            return r;
        };

        const origOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (output) {
            origOnExecuted?.apply(this, arguments);
            this._batchLoadTextsUI?.redraw?.();
        };
    },
});
