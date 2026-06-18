import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { QueueManager } from "./queue_manager.js";

function getTextListWidget(node) {
    return node?.widgets?.find((w) => w.name === "text_list");
}

function getSourceModeValue(node) {
    const w = node?.widgets?.find((x) => x.name === "source_mode");
    return w?.value || "direct";
}

function getFileModeValue(node) {
    const w = node?.widgets?.find((x) => x.name === "file_mode");
    return w?.value || "one_per_file";
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
    clearExcludedTextIndices(node);
    const value = (texts || []).join("\n");
    console.log(`[BatchLoadTexts] setTextList - 写入 ${texts?.length || 0} 个条目`);
    w.value = value;
    // 同步 inputEl（STRING multiline widget 序列化时从 inputEl.value 读取）
    if (w.inputEl) {
        w.inputEl.value = value;
        w.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        w.inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    }
    w.callback?.(value);
    QueueManager.invalidatePromptCache();
}

const EXCLUDED_TEXT_INDICES_PROP = "glowloader_excluded_text_indices";

function getTextExclusionSignature(node) {
    return JSON.stringify({
        source_mode: getSourceModeValue(node),
        file_mode: getFileModeValue(node),
        text_list: getTextListWidget(node)?.value || "",
    });
}

function getExcludedTextIndices(node) {
    const state = node?.properties?.[EXCLUDED_TEXT_INDICES_PROP];
    if (!state || state.signature !== getTextExclusionSignature(node)) return [];
    return Array.from(
        new Set((state.indices || []).map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x >= 0))
    );
}

function setExcludedTextIndices(node, indices) {
    if (!node) return;
    node.properties = node.properties || {};
    const next = Array.from(
        new Set((indices || []).map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x >= 0))
    ).sort((a, b) => a - b);
    if (next.length === 0) {
        delete node.properties[EXCLUDED_TEXT_INDICES_PROP];
    } else {
        node.properties[EXCLUDED_TEXT_INDICES_PROP] = {
            signature: getTextExclusionSignature(node),
            indices: next,
        };
    }
    app.graph.setDirtyCanvas(true, true);
}

function addExcludedTextIndex(node, index) {
    setExcludedTextIndices(node, [...getExcludedTextIndices(node), index]);
}

function clearExcludedTextIndices(node) {
    if (node?.properties?.[EXCLUDED_TEXT_INDICES_PROP]) {
        delete node.properties[EXCLUDED_TEXT_INDICES_PROP];
    }
}

function getMaxTextsValue(node) {
    const w = node?.widgets?.find((x) => x.name === "max_texts");
    const v = w?.value;
    return typeof v === "number" ? v : 0;
}

function getQueueCountValue(node) {
    return readIntWidget(node, "queue_count", 0, 0, 100000);
}

function getShuffleValue(node) {
    const w = getWidgetByName(node, "shuffle");
    return w?.value === true;
}

function getAllowDuplicateValue(node) {
    const w = getWidgetByName(node, "allow_duplicate");
    return w?.value !== false;
}

function getSeedValue(node) {
    const w = node?.widgets?.find((x) => x.name === "seed");
    const v = w?.value;
    return typeof v === "number" ? v : -1;
}

// 从节点自身读取队列阈值
function getQueueThresholdValue(node) {
    return readIntWidget(node, "queue_threshold", 199, 1, 1000);
}

// 从节点自身读取检查间隔
function getCheckIntervalValue(node) {
    return readIntWidget(node, "check_interval_ms", 1000, 100, 60000);
}

function getWidgetByName(node, name) {
    return node?.widgets?.find((w) => w.name === name);
}

const TEXT_WIDGET_LABELS = {
    source_mode: "数据源",
    file_mode: "文件解析",
    max_texts: "最大文本数",
    mode: "模式",
    index: "索引",
    seed: "种子",
    queue_count: "入队次数",
    shuffle: "乱序",
    allow_duplicate: "允许重复",
    queue_threshold: "队列阈值",
    check_interval_ms: "检查间隔ms",
    trigger: "触发",
};

function localizeStandardWidgets(node) {
    for (const w of node?.widgets || []) {
        const label = TEXT_WIDGET_LABELS[w.name];
        if (label) w.label = label;
    }
    for (const input of node?.inputs || []) {
        const label = TEXT_WIDGET_LABELS[input.name] || TEXT_WIDGET_LABELS[input.widget?.name];
        if (label) input.label = label;
    }
}

function moveWidgetAfter(node, name, afterName) {
    const widgets = node?.widgets;
    if (!widgets) return;
    const from = widgets.findIndex((w) => w.name === name);
    const after = widgets.findIndex((w) => w.name === afterName);
    if (from < 0 || after < 0 || from === after + 1) return;
    const [widget] = widgets.splice(from, 1);
    const nextAfter = widgets.findIndex((w) => w.name === afterName);
    widgets.splice(nextAfter + 1, 0, widget);
}

function readIntWidget(node, name, defaultValue, min, max) {
    const w = getWidgetByName(node, name);
    let v = parseInt(w?.value, 10);
    if (Number.isNaN(v)) v = defaultValue;
    if (typeof min === "number") v = Math.max(min, v);
    if (typeof max === "number") v = Math.min(max, v);
    return v;
}

function setWidgetValue(node, name, value) {
    const w = getWidgetByName(node, name);
    if (!w) return value;
    w.value = value;
    w.callback?.(w.value);
    app.graph.setDirtyCanvas(true, true);
    return w.value;
}

async function queueCurrent(node) {
    const prompt = await QueueManager.getPrompt();
    await QueueManager.enqueuePrompt(prompt);
}

// 等待队列有空位（使用共享 QueueManager）
async function waitForQueueSpace(node, targetSpace = 1) {
    const threshold = getQueueThresholdValue(node);
    const checkInterval = getCheckIntervalValue(node);
    return QueueManager.waitForSpace(threshold, checkInterval, targetSpace);
}

function setBatchStatus(node, status) {
    node._glowloaderBatchStatus = status;
    node.properties = node.properties || {};
    node.properties.glowloader_last_batch = status || null;
    if (status?.batch_id) {
        node.properties.glowloader_last_batch_id = status.batch_id;
    }
    node._batchLoadTextsUI?.updateBatchStatus?.(status);
    app.graph.setDirtyCanvas(true, true);
}

async function restoreBatchStatus(node) {
    const saved = node?.properties?.glowloader_last_batch || null;
    if (saved) {
        node._glowloaderBatchStatus = saved;
        node._batchLoadTextsUI?.updateBatchStatus?.(saved);
    }

    const batchId = node?.properties?.glowloader_last_batch_id || saved?.batch_id;
    if (!batchId) return;

    try {
        const status = await QueueManager.getBatchStatus(batchId);
        if (status) {
            setBatchStatus(node, status);
            if (!["completed", "cancelled", "error"].includes(status.status)) {
                QueueManager.watchBatch(status.batch_id, (next) => setBatchStatus(node, next));
            }
        }
    } catch (e) {
        console.warn("[BatchLoadTexts] 恢复批次状态失败:", e);
    }
}

async function submitPromptBatch(node, label, prompts) {
    const batch = await QueueManager.submitBatch({
        node,
        label,
        prompts,
        threshold: getQueueThresholdValue(node),
        checkInterval: getCheckIntervalValue(node),
    });
    if (batch) {
        setBatchStatus(node, batch);
        QueueManager.watchBatch(batch.batch_id, (status) => setBatchStatus(node, status));
    }
    return batch;
}

function patchTextPrompt(prompt, node, index, { seedValue, shuffle, allowDuplicate } = {}) {
    const nodeId = String(node.id);
    const apiNode = prompt.output?.[nodeId];
    if (!apiNode) return;
    apiNode.inputs = apiNode.inputs || {};
    apiNode.inputs.mode = "single";
    apiNode.inputs.index = index;
    if (seedValue !== undefined) {
        apiNode.inputs.seed = seedValue;
    }
    if (shuffle !== undefined) {
        apiNode.inputs.shuffle = shuffle;
    }
    if (allowDuplicate !== undefined) {
        apiNode.inputs.allow_duplicate = allowDuplicate;
    }
}

function setWidgetPreviewValue(widget, value) {
    if (!widget) return;
    widget.value = value;
    widget.callback?.(value);
    app.graph.setDirtyCanvas(true, true);
}

async function updatePrepareStatus(node, label, completed, total, currentIndex = null) {
    const workflow = QueueManager.getWorkflowInfo?.() || {};
    setBatchStatus(node, {
        batch_id: null,
        node_id: String(node?.id ?? ""),
        node_title: node?.title || node?.type || "",
        workflow_id: workflow.id || "current",
        workflow_label: workflow.label || "当前工作流",
        label,
        status: "准备中",
        threshold: getQueueThresholdValue(node),
        submitted: 0,
        total,
        completed,
        current_index: currentIndex,
        prompt_ids: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
}

// deepClone 委托给 QueueManager
function deepClone(obj) {
    return QueueManager.deepClone(obj);
}

// 调用后端生成入队序列
async function generateQueueSequence(node, overrides = {}) {
    const sourceMode = getSourceModeValue(node);
    const textList = getTextListWidget(node)?.value || "";
    const fileMode = getFileModeValue(node);
    const maxTexts = getMaxTextsValue(node);
    const queueCount = getQueueCountValue(node);
    const shuffle = overrides.shuffle ?? getShuffleValue(node);
    const allowDuplicate = overrides.allowDuplicate ?? getAllowDuplicateValue(node);
    const seed = getSeedValue(node);

    const resp = await api.fetchApi("/glowloader/generate_sequence_texts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            source_mode: sourceMode,
            text_list: textList,
            file_mode: fileMode,
            max_texts: maxTexts,
            queue_count: queueCount,
            shuffle: shuffle,
            allow_duplicate: allowDuplicate,
            seed: seed,
            excluded_indices: getExcludedTextIndices(node),
        }),
    });

    if (!resp.ok) {
        throw new Error(await resp.text());
    }

    const json = await resp.json();
    return json.sequence || [];
}

// 获取节点在直接模式下的条目数（近似）
function getNodeEntryCount(node) {
    const sourceMode = getSourceModeValue(node);
    const textList = getTextListWidget(node)?.value || "";
    if (sourceMode === "direct") {
        return parseTextList(textList).length;
    }
    // 文件模式：返回文件数量作为近似条目数
    return parseTextList(textList).length;
}

// 获取节点在 single 模式下的 index widget
function getNodeIndexWidget(node) {
    return getWidgetByName(node, "index");
}

// 获取节点在 single 模式下的 mode widget
function getNodeModeWidget(node) {
    return getWidgetByName(node, "mode");
}

// 为单个节点生成分配序列（复用后端 API 或前端 fallback）
async function generateSequenceForNode(targetNode, stepCount) {
    const sourceMode = getSourceModeValue(targetNode);
    const textList = getTextListWidget(targetNode)?.value || "";
    const fileMode = getFileModeValue(targetNode);
    const maxTexts = getMaxTextsValue(targetNode);
    const shuffle = getShuffleValue(targetNode);
    const allowDuplicate = getAllowDuplicateValue(targetNode);
    const seed = getSeedValue(targetNode);

    // 先尝试后端 API
    try {
        const resp = await api.fetchApi("/glowloader/generate_sequence_texts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                source_mode: sourceMode,
                text_list: textList,
                file_mode: fileMode,
                max_texts: maxTexts,
                queue_count: stepCount,
                shuffle: shuffle,
                allow_duplicate: allowDuplicate,
                seed: seed,
                excluded_indices: getExcludedTextIndices(targetNode),
            }),
        });
        if (resp.ok) {
            const json = await resp.json();
            if (json.sequence && json.sequence.length > 0) {
                return json.sequence;
            }
        }
    } catch (e) {
        // ignore, fallback below
    }

    // 前端 fallback
    const texts0 = parseTextList(textList);
    if (!texts0 || texts0.length === 0) return [];
    const texts = maxTexts && maxTexts > 0 ? texts0.slice(0, maxTexts) : texts0;
    const total = texts.length;
    if (total === 0) return [];

    if (sourceMode === "files") {
        return Array.from({ length: stepCount }, (_, i) =>
            shuffle ? Math.floor(Math.random() * total) : i
        );
    }
    return generateSequenceFallback(total, stepCount, shuffle, allowDuplicate, seed);
}

// 收集工作流中所有需要同步的 BatchLoadTexts 节点信息
async function collectSyncNodeStates(excludeNode, stepCount) {
    const allNodes = app.graph.nodes.filter(
        (n) => n.type === "BatchLoadTexts" || n.type === "GlowLoader 加载文件夹文本"
    );
    const states = [];
    for (const n of allNodes) {
        if (n === excludeNode) continue;
        const modeW = getNodeModeWidget(n);
        const indexW = getNodeIndexWidget(n);
        const seedW = getWidgetByName(n, "seed");
        // 只同步当前为 single 模式的节点（batch 模式不需要 index）
        if (modeW && modeW.value === "single" && indexW) {
            const sequence = await generateSequenceForNode(n, stepCount);
            states.push({
                node: n,
                modeWidget: modeW,
                indexWidget: indexW,
                prevIndex: indexW.value,
                prevSeed: seedW?.value,
                sequence: sequence,
            });
        }
    }
    return states;
}

async function queueAllSequential(node) {
    QueueManager.resetAbort();
    const sourceMode = getSourceModeValue(node);
    const texts0 = parseTextList(getTextListWidget(node)?.value);
    if (!texts0 || texts0.length === 0) return;

    const maxTexts = getMaxTextsValue(node);
    const texts = maxTexts && maxTexts > 0 ? texts0.slice(0, maxTexts) : texts0;
    if (texts.length === 0) return;

    let sequence;
    try {
        sequence = await generateQueueSequence(node, { shuffle: false });
    } catch (e) {
        console.warn("Backend sequence generation failed, using frontend fallback:", e);
        const fileMode = getFileModeValue(node);
        const queueCount = getQueueCountValue(node);
        const allowDuplicate = getAllowDuplicateValue(node);
        const seed = getSeedValue(node);

        if (sourceMode === "files") {
            const count = queueCount > 0 ? queueCount : texts.length;
            sequence = Array.from({ length: count }, (_, i) => i);
        } else {
            sequence = generateSequenceFallback(texts.length, queueCount, false, allowDuplicate, seed);
        }
    }

    if (sequence.length === 0) return;

    const prompts = [];
    const wMode = getWidgetByName(node, "mode");
    const wIndex = getWidgetByName(node, "index");

    const prevMode = wMode?.value;
    const prevIndex = wIndex?.value;

    const syncStates = await collectSyncNodeStates(node, sequence.length);

    const wSeed = getWidgetByName(node, "seed");
    const prevSeed = wSeed?.value;

    QueueManager.invalidatePromptCache();
    const basePrompt = deepClone(await QueueManager.getPrompt());
    try {
        for (let i = 0; i < sequence.length; i++) {
            if (QueueManager.aborted) break;
            const idx = sequence[i];
            const prompt = deepClone(basePrompt);
            const seedValue = wSeed && prevSeed === -1 ? Math.floor(Math.random() * 2147483647) : undefined;
            patchTextPrompt(prompt, node, idx, { seedValue, shuffle: false });
            for (const s of syncStates) {
                if (s.sequence.length > 0) {
                    const syncIdx = s.sequence[i % s.sequence.length];
                    const syncSeedW = getWidgetByName(s.node, "seed");
                    const syncSeedValue = syncSeedW && s.prevSeed === -1 ? Math.floor(Math.random() * 2147483647) : undefined;
                    patchTextPrompt(prompt, s.node, syncIdx, { seedValue: syncSeedValue });
                }
            }
            prompts.push(prompt);
            if (i === 0 || (i + 1) % 5 === 0 || i + 1 === sequence.length) {
                setWidgetPreviewValue(wIndex, idx);
                await updatePrepareStatus(node, "逐行入队", i + 1, sequence.length, idx);
            }
        }
    } finally {
        setWidgetPreviewValue(wIndex, prevIndex);
        QueueManager.invalidatePromptCache();
    }

    if (prompts.length === 0) return;
    return submitPromptBatch(node, "逐行入队", prompts);
}

// 前端备用序列生成
function generateSequenceFallback(totalEntries, queueCount, shuffle, allowDuplicate, seed) {
    const count = queueCount > 0 ? queueCount : totalEntries;
    const indices = Array.from({ length: totalEntries }, (_, i) => i);

    // 简单的伪随机
    let rng = seed >= 0 ? mulberry32(seed) : Math.random;

    function mulberry32(a) {
        return function () {
            let t = (a += 0x6d2b79f5);
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function shuffleArray(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    if (shuffle) {
        if (allowDuplicate) {
            return Array.from({ length: count }, () => Math.floor(rng() * totalEntries));
        } else {
            const result = [];
            let shuffled = [...indices];
            shuffleArray(shuffled);
            for (let i = 0; i < count; i++) {
                result.push(shuffled[i % totalEntries]);
                if (i % totalEntries === totalEntries - 1) {
                    shuffled = [...indices];
                    shuffleArray(shuffled);
                }
            }
            return result;
        }
    } else {
        if (allowDuplicate) {
            return Array.from({ length: count }, (_, i) => i % totalEntries);
        } else {
            return indices.slice(0, Math.min(count, totalEntries));
        }
    }
}

async function queueAllShuffled(node) {
    QueueManager.resetAbort();
    const sourceMode = getSourceModeValue(node);
    const texts0 = parseTextList(getTextListWidget(node)?.value);
    if (!texts0 || texts0.length === 0) return;

    const maxTexts = getMaxTextsValue(node);
    const texts = maxTexts && maxTexts > 0 ? texts0.slice(0, maxTexts) : texts0;
    if (texts.length === 0) return;

    let sequence;
    try {
        sequence = await generateQueueSequence(node, { shuffle: true });
    } catch (e) {
        console.warn("Backend sequence generation failed, using frontend fallback:", e);
        const fileMode = getFileModeValue(node);
        const queueCount = getQueueCountValue(node);
        const allowDuplicate = getAllowDuplicateValue(node);
        const seed = getSeedValue(node);

        if (sourceMode === "files") {
            const count = queueCount > 0 ? queueCount : texts.length;
            sequence = Array.from({ length: count }, (_, i) =>
                Math.floor(Math.random() * texts.length)
            );
        } else {
            sequence = generateSequenceFallback(texts.length, queueCount, true, allowDuplicate, seed);
        }
    }

    if (sequence.length === 0) return;

    const prompts = [];
    const wMode = getWidgetByName(node, "mode");
    const wIndex = getWidgetByName(node, "index");

    const prevMode = wMode?.value;
    const prevIndex = wIndex?.value;

    const syncStates = await collectSyncNodeStates(node, sequence.length);

    const wSeed = getWidgetByName(node, "seed");
    const prevSeed = wSeed?.value;

    QueueManager.invalidatePromptCache();
    const basePrompt = deepClone(await QueueManager.getPrompt());
    try {
        for (let i = 0; i < sequence.length; i++) {
            if (QueueManager.aborted) break;
            const idx = sequence[i];
            const prompt = deepClone(basePrompt);
            const seedValue = wSeed && prevSeed === -1 ? Math.floor(Math.random() * 2147483647) : undefined;
            patchTextPrompt(prompt, node, idx, { seedValue, shuffle: false });
            for (const s of syncStates) {
                if (s.sequence.length > 0) {
                    const syncIdx = s.sequence[i % s.sequence.length];
                    const syncSeedW = getWidgetByName(s.node, "seed");
                    const syncSeedValue = syncSeedW && s.prevSeed === -1 ? Math.floor(Math.random() * 2147483647) : undefined;
                    patchTextPrompt(prompt, s.node, syncIdx, { seedValue: syncSeedValue });
                }
            }
            prompts.push(prompt);
            if (i === 0 || (i + 1) % 5 === 0 || i + 1 === sequence.length) {
                setWidgetPreviewValue(wIndex, idx);
                await updatePrepareStatus(node, "乱序入队", i + 1, sequence.length, idx);
            }
        }
    } finally {
        setWidgetPreviewValue(wIndex, prevIndex);
        QueueManager.invalidatePromptCache();
    }

    if (prompts.length === 0) return;
    return submitPromptBatch(node, "乱序入队", prompts);
}

// 上传单个文件
async function uploadOneFile(file) {
    const body = new FormData();
    body.append("image", file, file.name);
    body.append("type", "input");

    const resp = await api.fetchApi("/upload/image", {
        method: "POST",
        body,
    });

    if (!resp.ok) {
        throw new Error(await resp.text());
    }

    const json = await resp.json();
    return json?.name || file.name;
}

// 上传文本文件
async function uploadTextFilesSequential(node, files, { replace = false } = {}) {
    const w = getTextListWidget(node);
    if (!w) return [];

    console.log(`[BatchLoadTexts] uploadTextFilesSequential - 接收 ${files?.length || 0} 个文件`);
    const existing = replace ? [] : parseTextList(w.value);
    const uploaded = [];

    for (const file of files) {
        if (!file) continue;
        const name = (file.name || "").toLowerCase();
        const extOk = name.endsWith(".txt") || name.endsWith(".md") || name.endsWith(".json") || 
                      name.endsWith(".csv") || name.endsWith(".yaml") || name.endsWith(".yml") || 
                      name.endsWith(".log") || name.endsWith(".wild") || name.endsWith(".wildcard");
        if (!extOk) continue;

        const comfyName = await uploadOneFile(file);
        if (!comfyName) continue;
        uploaded.push(comfyName);
    }

    const merged = existing.concat(uploaded);
    setTextList(node, merged);
    return uploaded;
}

function openMultiSelect(node, { replace = false } = {}) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".txt,.md,.json,.csv,.yaml,.yml,.log,.wild,.wildcard";
    input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);

    input.onchange = async (e) => {
        try {
            const files = Array.from(e.target.files || []);
            await uploadTextFilesSequential(node, files, { replace });
        } finally {
            document.body.removeChild(input);
        }
    };

    input.click();
}

function openFolderSelect(node, { replace = false } = {}) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".txt,.md,.json,.csv,.yaml,.yml,.log,.wild,.wildcard";
    input.multiple = true;
    input.webkitdirectory = true;
    input.directory = true;
    input.style.display = "none";
    document.body.appendChild(input);

    input.onchange = async (e) => {
        try {
            let files = Array.from(e.target.files || []);
            const allowExt = new Set([".txt", ".md", ".json", ".csv", ".yaml", ".yml", ".log", ".wild", ".wildcard"]);
            files = files.filter((f) => {
                const name = (f?.name || "").toLowerCase();
                for (const ext of allowExt) {
                    if (name.endsWith(ext)) return true;
                }
                return false;
            });
            files.sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name));
            await uploadTextFilesSequential(node, files, { replace });
        } finally {
            document.body.removeChild(input);
        }
    };

    input.click();
}

function isFilesDragEvent(e) {
    const dt = e?.dataTransfer;
    if (!dt) return false;
    if (dt.files && dt.files.length > 0) return true;
    return Array.from(dt.types || []).includes("Files");
}

function createTextListUI(node) {
    const container = document.createElement("div");
    container.style.cssText =
        "width:100%;padding:8px;background:var(--comfy-menu-bg);border:1px solid var(--border-color);border-radius:6px;margin:5px 0;pointer-events:auto;";

    // 源模式选择（保留内部控件用于拖拽切换，实际显示走 ComfyUI 标准 widget）
    const sourceModeRow = document.createElement("div");
    sourceModeRow.style.cssText = "display:flex;gap:6px;margin-bottom:8px;align-items:center;";
    
    const sourceModeLabel = document.createElement("span");
    sourceModeLabel.textContent = "数据源:";
    sourceModeLabel.style.cssText = "font-size:12px;opacity:0.8;";
    
    const sourceModeSelect = document.createElement("select");
    sourceModeSelect.style.cssText = "flex:1;padding:4px;background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;font-size:12px;";
    
    const directOption = document.createElement("option");
    directOption.value = "direct";
    directOption.textContent = "直接输入";
    
    const filesOption = document.createElement("option");
    filesOption.value = "files";
    filesOption.textContent = "从文件加载";
    
    sourceModeSelect.appendChild(directOption);
    sourceModeSelect.appendChild(filesOption);
    sourceModeSelect.value = getSourceModeValue(node);
    
    sourceModeSelect.onchange = (e) => {
        const w = getWidgetByName(node, "source_mode");
        if (w) {
            w.value = e.target.value;
            w.callback?.(w.value);
        }
        updateUIForSourceMode();
    };
    
    sourceModeRow.appendChild(sourceModeLabel);
    sourceModeRow.appendChild(sourceModeSelect);

    // 文件模式选择（仅在文件模式下显示）
    const fileModeRow = document.createElement("div");
    fileModeRow.style.cssText = "display:flex;gap:6px;margin-bottom:8px;align-items:center;";
    
    const fileModeLabel = document.createElement("span");
    fileModeLabel.textContent = "文件解析:";
    fileModeLabel.style.cssText = "font-size:12px;opacity:0.8;";
    
    const fileModeSelect = document.createElement("select");
    fileModeSelect.style.cssText = "flex:1;padding:4px;background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;font-size:12px;";
    
    const onePerFileOption = document.createElement("option");
    onePerFileOption.value = "one_per_file";
    onePerFileOption.textContent = "整个文件作为一个条目";
    
    const linesPerFileOption = document.createElement("option");
    linesPerFileOption.value = "lines_per_file";
    linesPerFileOption.textContent = "文件每行作为一个条目";
    
    fileModeSelect.appendChild(onePerFileOption);
    fileModeSelect.appendChild(linesPerFileOption);
    fileModeSelect.value = getFileModeValue(node);
    
    fileModeSelect.onchange = (e) => {
        const w = getWidgetByName(node, "file_mode");
        if (w) {
            w.value = e.target.value;
            w.callback?.(w.value);
        }
        // 切换文件模式时重新获取展开条目
        asyncRedraw();
    };
    
    fileModeRow.appendChild(fileModeLabel);
    fileModeRow.appendChild(fileModeSelect);

    // 文件操作按钮（仅在文件模式下显示）
    const fileBtnRow = document.createElement("div");
    fileBtnRow.style.cssText = "display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;";
    
    const mkBtn = (label) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.style.cssText =
            "flex:1;padding:8px;background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:13px;min-width:70px;";
        return b;
    };
    
    const selectFilesBtn = mkBtn("选择文件");
    const selectFolderBtn = mkBtn("选择文件夹");
    const addFilesBtn = mkBtn("追加文件");
    
    selectFilesBtn.onclick = () => openMultiSelect(node, { replace: true });
    selectFolderBtn.onclick = () => openFolderSelect(node, { replace: true });
    addFilesBtn.onclick = () => openMultiSelect(node, { replace: false });
    
    fileBtnRow.appendChild(selectFilesBtn);
    fileBtnRow.appendChild(selectFolderBtn);
    fileBtnRow.appendChild(addFilesBtn);

    const mkLabel = (text) => {
        const span = document.createElement("span");
        span.textContent = text;
        span.style.cssText = "font-size:11px;opacity:0.8;";
        return span;
    };

    // 直接输入模式按钮
    const directBtnRow = document.createElement("div");
    directBtnRow.style.cssText = "display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;";
    
    const addBtn = mkBtn("添加行");
    const insertBtn = mkBtn("插入行");
    const clearBtn2 = mkBtn("清空");
    
    addBtn.onclick = () => {
        const texts = parseTextList(getTextListWidget(node)?.value);
        texts.push("");
        setTextList(node, texts);
        redraw();
    };
    
    insertBtn.onclick = () => {
        const texts = parseTextList(getTextListWidget(node)?.value);
        const insertIdx = selectedIndex >= 0 ? selectedIndex : texts.length;
        texts.splice(insertIdx, 0, "");
        setTextList(node, texts);
        selectedIndex = insertIdx;
        redraw();
    };
    
    clearBtn2.onclick = () => {
        if (confirm("确定要清空所有文本吗?")) {
            setTextList(node, []);
            selectedIndex = -1;
            redraw();
        }
    };
    
    directBtnRow.appendChild(addBtn);
    directBtnRow.appendChild(insertBtn);
    directBtnRow.appendChild(clearBtn2);

    // 队列操作按钮
    const queueBtnRow = document.createElement("div");
    queueBtnRow.style.cssText = "display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;";
    
    const queueBtn = mkBtn("逐行入队");
    const queueShuffleBtn = mkBtn("🔀 乱序入队");
    const queueOneBtn = mkBtn("入队当前");
    const clearBtn = mkBtn("清空");

    const stopBtn = document.createElement("button");
    stopBtn.textContent = "⏹ 停止";
    stopBtn.style.cssText =
        "padding:8px;background:rgba(200,50,50,0.8);color:#fff;border:1px solid rgba(200,50,50,0.9);border-radius:4px;cursor:pointer;font-size:13px;";
    stopBtn.onclick = () => {
        QueueManager.stop();
    };

    const setQueueButtonsDisabled = (disabled) => {
        for (const btn of [queueBtn, queueShuffleBtn, queueOneBtn]) {
            btn.disabled = disabled;
            btn.style.opacity = disabled ? "0.55" : "";
            btn.style.cursor = disabled ? "wait" : "pointer";
        }
    };

    const runQueueAction = async (action) => {
        if (QueueManager.queuing) return;
        QueueManager.startQueuing();
        setQueueButtonsDisabled(true);
        try {
            await action();
        } catch (e) {
            console.error("[BatchLoadTexts] 入队失败:", e);
            setBatchStatus(node, {
                batch_id: null,
                label: "入队",
                status: "错误",
                threshold: getQueueThresholdValue(node),
                submitted: 0,
                total: 0,
                completed: 0,
                prompt_ids: [],
            });
        } finally {
            QueueManager.endQueuing();
            setQueueButtonsDisabled(false);
        }
    };
    
    queueBtn.onclick = async () => {
        await runQueueAction(() => queueAllSequential(node));
    };

    queueShuffleBtn.onclick = async () => {
        await runQueueAction(() => queueAllShuffled(node));
    };
    
    queueOneBtn.onclick = async () => {
        await runQueueAction(async () => {
            const wMode = getWidgetByName(node, "mode");
            if (wMode) {
                wMode.value = "single";
                wMode.callback?.(wMode.value);
            }
            await queueCurrent(node);
        });
    };
    
    clearBtn.onclick = () => {
        if (confirm("确定要清空所有文本吗?")) {
            setTextList(node, []);
            selectedIndex = -1;
            expandedEntries = null;
            expandedSourceIndices = null;
            redraw();
        }
    };
    
    queueBtnRow.appendChild(queueBtn);
    queueBtnRow.appendChild(queueShuffleBtn);
    queueBtnRow.appendChild(queueOneBtn);
    queueBtnRow.appendChild(clearBtn);
    queueBtnRow.appendChild(stopBtn);

    const info = document.createElement("div");
    info.style.cssText = "font-size:12px;opacity:0.85;margin-bottom:6px;";

    const batchInfo = document.createElement("div");
    batchInfo.style.cssText = "font-size:12px;opacity:0.85;margin-bottom:6px;";

    const updateBatchStatus = (status) => {
        if (!status) {
            batchInfo.textContent = "";
            return;
        }
        if (!status.batch_id && status.status === "准备中") {
            const indexText = status.current_index !== null && status.current_index !== undefined
                ? `，当前index ${status.current_index}`
                : "";
            batchInfo.textContent = `${status.label || "批次"} 准备中 ${status.completed || 0}/${status.total || 0}${indexText}`;
            return;
        }
        const id = status.batch_id ? status.batch_id.slice(0, 8) : "-";
        const queue = status.queue || {};
        const queueText = queue.total > 0 ? `，队列 ${queue.total}（运行 ${queue.running || 0}/等待 ${queue.pending || 0}）` : "";
        batchInfo.textContent = `批次 ${id} ${status.status} 已提交 ${status.submitted || 0}/${status.total || 0}，完成 ${status.completed || 0}/${status.total || 0}${queueText}`;
    };

    const listContainer = document.createElement("div");
    listContainer.style.cssText =
        "max-height:400px;overflow-y:auto;background:var(--comfy-input-bg);padding:6px;border-radius:4px;";

    let selectedIndex = -1;
    // 缓存展开后的条目（文件模式下从后端获取）
    let expandedEntries = null; // null 表示未加载，数组表示展开结果
    let expandedSourceIndices = null; // 每个展开条目对应的 text_list 源索引
    let expandVersion = 0; // 用于取消过期的异步请求

    // 从后端获取展开后的条目
    const fetchExpandedEntries = async () => {
        const sourceMode = getSourceModeValue(node);
        if (sourceMode !== "files") {
            expandedEntries = null;
            expandedSourceIndices = null;
            return;
        }
        const textList = getTextListWidget(node)?.value || "";
        const fileMode = getFileModeValue(node);
        const maxTexts = getMaxTextsValue(node);
        console.log(`[BatchLoadTexts] fetchExpandedEntries - sourceMode: ${sourceMode}, fileMode: ${fileMode}, textList长度: ${textList.length}`);
        try {
            const resp = await api.fetchApi("/glowloader/expand_text_entries", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    source_mode: sourceMode,
                    text_list: textList,
                    file_mode: fileMode,
                    max_texts: maxTexts,
                }),
            });
            if (!resp.ok) {
                console.warn(`[BatchLoadTexts] fetchExpandedEntries API返回错误: ${resp.status}`);
                return;
            }
            const json = await resp.json();
            console.log(`[BatchLoadTexts] fetchExpandedEntries - 返回 ${json.entries?.length || 0} 个条目`);
            expandedEntries = json.entries || [];
            expandedSourceIndices = json.source_indices || expandedEntries.map((_, index) => index);
        } catch (e) {
            console.warn("[BatchLoadTexts] 获取展开条目失败:", e);
            expandedEntries = null;
            expandedSourceIndices = null;
        }
    };

    // 获取当前显示用的条目列表，保留原始索引用于文件模式排除。
    const getDisplayItems = () => {
        const sourceMode = getSourceModeValue(node);
        if (sourceMode === "files" && expandedEntries && expandedEntries.length > 0) {
            const excluded = new Set(getExcludedTextIndices(node));
            console.log(`[BatchLoadTexts] getDisplayEntries - 使用展开条目: ${expandedEntries.length} 个，排除 ${excluded.size} 个`);
            return expandedEntries
                .map((text, index) => ({
                    text,
                    originalIndex: index,
                    sourceIndex: expandedSourceIndices?.[index] ?? index,
                }))
                .filter((item) => !excluded.has(item.originalIndex));
        }
        const raw = parseTextList(getTextListWidget(node)?.value);
        console.log(`[BatchLoadTexts] getDisplayEntries - 使用原始列表: ${raw.length} 个, sourceMode: ${sourceMode}, expandedEntries: ${expandedEntries ? expandedEntries.length : 'null'}`);
        return raw.map((text, index) => ({ text, originalIndex: index }));
    };

    const getDisplayEntries = () => {
        return getDisplayItems().map((item) => item.text);
    };

    const updateInfo = () => {
        const entries = getDisplayEntries();
        const queueCount = getQueueCountValue(node);
        const shuffle = getShuffleValue(node);
        const allowDup = getAllowDuplicateValue(node);
        const sourceMode = getSourceModeValue(node);
        const fileMode = getFileModeValue(node);
        
        let modeText = sourceMode === "files" ? "[文件·全文]" : "[直接输入]";
        if (sourceMode === "files" && fileMode === "lines_per_file") modeText = "[文件·逐行]";
        if (shuffle) modeText += "[乱序]";
        if (!allowDup) modeText += "[不重复]";
        if (queueCount > 0) modeText += `[跑${queueCount}次]`;
        
        info.textContent = `共 ${entries.length} 行 ${modeText}`;
    };

    const redraw = () => {
        const sourceMode = getSourceModeValue(node);
        const items = getDisplayItems();
        const entries = items.map((item) => item.text);
        console.log(`[BatchLoadTexts] redraw - 列表总数: ${entries.length}, sourceMode: ${sourceMode}`);
        listContainer.innerHTML = "";

        if (entries.length === 0) {
            const emptyMsg = document.createElement("div");
            emptyMsg.textContent = sourceMode === "files" 
                ? "点击「选择文件」或「选择文件夹」加载文本文件" 
                : "点击「添加行」输入文本";
            emptyMsg.style.cssText = "text-align:center;padding:20px;opacity:0.6;font-size:12px;";
            listContainer.appendChild(emptyMsg);
            selectedIndex = -1;
            updateInfo();
            return;
        }

        const frag = document.createDocumentFragment();
        items.forEach((itemData, idx) => {
            const text = itemData.text;
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
            
            const fileMode = getFileModeValue(node);
            if (sourceMode === "files" && fileMode === "one_per_file") {
                content.style.cssText =
                    "flex:1;font-size:12px;white-space:pre-wrap;overflow:hidden;max-height:80px;line-height:1.4;";
            } else {
                content.style.cssText =
                    "flex:1;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
            }

            const del = document.createElement("button");
            del.textContent = "×";
            del.title = "删除";
            del.style.cssText =
                "width:20px;height:20px;min-width:20px;background:rgba(255,0,0,0.75);color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:16px;line-height:1;";
            del.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (sourceMode === "files" && expandedEntries && expandedEntries.length > 0) {
                    const rawEntries = parseTextList(getTextListWidget(node)?.value);
                    if (itemData.sourceIndex >= 0 && itemData.sourceIndex < rawEntries.length) {
                        rawEntries.splice(itemData.sourceIndex, 1);
                        setTextList(node, rawEntries);
                        expandedEntries = null;
                        expandedSourceIndices = null;
                    } else {
                        addExcludedTextIndex(node, itemData.originalIndex);
                    }
                    if (selectedIndex === idx) {
                        selectedIndex = -1;
                    } else if (selectedIndex > idx) {
                        selectedIndex--;
                    }
                    asyncRedraw();
                } else {
                    const rawEntries = parseTextList(getTextListWidget(node)?.value);
                    const next = entries.slice(0, idx).concat(entries.slice(idx + 1));
                    if (itemData.originalIndex >= 0 && itemData.originalIndex < rawEntries.length) {
                        rawEntries.splice(itemData.originalIndex, 1);
                        setTextList(node, rawEntries);
                    } else {
                        setTextList(node, next);
                    }
                    if (selectedIndex === idx) {
                        selectedIndex = -1;
                    } else if (selectedIndex > idx) {
                        selectedIndex--;
                    }
                    redraw();
                }
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

    // 异步刷新：在文件模式下获取展开条目后重绘
    const asyncRedraw = async () => {
        const currentVersion = ++expandVersion;
        await fetchExpandedEntries();
        // 只有当前请求是最新的才重绘，避免竞态
        if (currentVersion === expandVersion) {
            redraw();
        }
    };

    // 根据源模式更新 UI
    const updateUIForSourceMode = () => {
        const sourceMode = getSourceModeValue(node);
        sourceModeSelect.value = sourceMode;
        fileModeSelect.value = getFileModeValue(node);
        if (sourceMode === "files") {
            fileModeRow.style.display = "flex";
            fileBtnRow.style.display = "flex";
            directBtnRow.style.display = "none";
            asyncRedraw();
        } else {
            fileModeRow.style.display = "none";
            fileBtnRow.style.display = "none";
            directBtnRow.style.display = "flex";
            expandedEntries = null;
            redraw();
        }
    };

    // 拖拽支持
    container.addEventListener("dragover", (e) => {
        if (!isFilesDragEvent(e)) return;
        e.preventDefault();
        e.stopPropagation();
        container.style.border = "2px dashed #4a6";
    });

    container.addEventListener("dragleave", (e) => {
        if (!isFilesDragEvent(e)) return;
        e.preventDefault();
        e.stopPropagation();
        container.style.border = "1px solid var(--border-color)";
    });

    container.addEventListener("drop", async (e) => {
        if (!isFilesDragEvent(e)) return;
        e.preventDefault();
        e.stopPropagation();
        container.style.border = "1px solid var(--border-color)";
        
        const files = Array.from(e.dataTransfer?.files || []);
        if (files.length === 0) return;
        
        // 切换到文件模式
        const w = getWidgetByName(node, "source_mode");
        if (w) {
            w.value = "files";
            w.callback?.(w.value);
            sourceModeSelect.value = "files";
            updateUIForSourceMode();
        }
        
        await uploadTextFilesSequential(node, files, { replace: false });
        asyncRedraw();
    });

    // source_mode / file_mode / 入队参数使用 ComfyUI 标准 widget 显示。
    container.appendChild(fileBtnRow);
    container.appendChild(directBtnRow);
    container.appendChild(queueBtnRow);
    container.appendChild(batchInfo);
    container.appendChild(info);
    container.appendChild(listContainer);
    updateBatchStatus(node._glowloaderBatchStatus || node?.properties?.glowloader_last_batch);

    // 初始化 UI 状态
    updateUIForSourceMode();

    return {
        container,
        redraw,
        asyncRedraw,
        updateBatchStatus,
        updateMode: updateUIForSourceMode,
    };
}

app.registerExtension({
    name: "BatchLoadTexts.Extension",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "BatchLoadTexts") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);
            localizeStandardWidgets(this);
            moveWidgetAfter(this, "source_mode", "file_mode");

            const textListWidget = getTextListWidget(this);
            if (textListWidget) {
                textListWidget.type = "hidden";
                textListWidget.computeSize = () => [0, -4];
            }

            // 只隐藏 trigger；其他配置全部交回 ComfyUI 标准 widget。
            const hiddenWidgets = ["trigger"];
            for (const name of hiddenWidgets) {
                const w = getWidgetByName(this, name);
                if (w) {
                    w.type = "hidden";
                    w.computeSize = () => [0, -4];
                }
            }

            // Create text list UI
            const ui = createTextListUI(this);
            this._batchLoadTextsUI = ui;
            this.addDOMWidget("batch_load_texts", "customwidget", ui.container);
            this.setSize([500, 520]);

            for (const name of ["source_mode", "file_mode"]) {
                const w = getWidgetByName(this, name);
                if (!w || w._glowloaderStandardCallbackInstalled) continue;
                w._glowloaderStandardCallbackInstalled = true;
                const origCallback = w.callback;
                w.callback = function (value) {
                    origCallback?.call(this, value);
                    if (name === "source_mode") {
                        ui.updateMode?.();
                    } else {
                        ui.asyncRedraw?.();
                    }
                };
            }

            // Keep the DOM list in sync if something else changes the widget.
            const _node = this;
            if (textListWidget) {
                const origCallback = textListWidget.callback;
                textListWidget.callback = function (value) {
                    origCallback?.call(this, value);
                    // 文件模式下需要异步获取展开条目
                    const sourceMode = getSourceModeValue(_node);
                    if (sourceMode === "files") {
                        ui.asyncRedraw();
                    } else {
                        ui.redraw();
                    }
                };
            }

            ui.asyncRedraw();
            restoreBatchStatus(this);

            return r;
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = origOnConfigure?.apply(this, arguments);
            localizeStandardWidgets(this);
            moveWidgetAfter(this, "source_mode", "file_mode");
            this._batchLoadTextsUI?.updateMode?.();
            this._batchLoadTextsUI?.asyncRedraw?.();
            restoreBatchStatus(this);
            return r;
        };

        const origOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (output) {
            origOnExecuted?.apply(this, arguments);
            const ui = this._batchLoadTextsUI;
            if (ui) {
                const sourceMode = getSourceModeValue(this);
                if (sourceMode === "files") {
                    ui.asyncRedraw();
                } else {
                    ui.redraw();
                }
            }
        };
    },
});
