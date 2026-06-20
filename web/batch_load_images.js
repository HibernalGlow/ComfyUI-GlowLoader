import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { QueueManager } from "./queue_manager.js";

function getImageListWidget(node) {
    return node?.widgets?.find((w) => w.name === "image_list");
}

function clampInt(v, min, max) {
    v = Math.floor(Number(v));
    if (Number.isNaN(v)) v = min;
    if (v < min) v = min;
    if (v > max) v = max;
    return v;
}

function buildVNCCSPrompt(data) {
    const azimuth = clampInt(data?.azimuth ?? 0, 0, 360) % 360;
    const elevation = clampInt(data?.elevation ?? 0, -30, 60);
    const distance = data?.distance ?? "medium shot";
    const include_trigger = data?.include_trigger !== false;

    const azimuthMap = {
        0: "front view",
        45: "front-right quarter view",
        90: "right side view",
        135: "back-right quarter view",
        180: "back view",
        225: "back-left quarter view",
        270: "left side view",
        315: "front-left quarter view",
    };

    const closestAzimuth = azimuth > 337.5 ? 0 : Object.keys(azimuthMap).map((k) => Number(k)).reduce((best, k) => {
        return Math.abs(k - azimuth) < Math.abs(best - azimuth) ? k : best;
    }, 0);

    const elevationMap = {
        "-30": "low-angle shot",
        "0": "eye-level shot",
        "30": "elevated shot",
        "60": "high-angle shot",
    };

    const closestElevation = Object.keys(elevationMap).map((k) => Number(k)).reduce((best, k) => {
        return Math.abs(k - elevation) < Math.abs(best - elevation) ? k : best;
    }, 0);

    const parts = [];
    if (include_trigger) parts.push("<sks>");
    parts.push(azimuthMap[closestAzimuth]);
    parts.push(elevationMap[String(closestElevation)]);
    parts.push(distance);
    return parts.join(" ");
}

function createVNCCSVisualUI(node) {
    const w = getCameraDataWidget(node);
    if (!w) return null;

    w.type = "hidden";
    w.computeSize = () => [0, -4];

    const container = document.createElement("div");
    container.style.cssText =
        "width:100%;padding:8px;background:var(--comfy-menu-bg);border:1px solid var(--border-color);border-radius:6px;margin:5px 0;pointer-events:auto;";

    const row = document.createElement("div");
    row.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:8px;";

    const mkField = (labelText) => {
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;";
        const label = document.createElement("div");
        label.textContent = labelText;
        label.style.cssText = "font-size:12px;opacity:0.9;";
        wrap.appendChild(label);
        return { wrap };
    };

    const azF = mkField("水平角度(azimuth)");
    const elF = mkField("垂直角度(elevation)");
    const distF = mkField("远近(distance)");
    const trigF = mkField("触发词");

    const az = document.createElement("input");
    az.type = "range";
    az.min = "0";
    az.max = "360";
    az.step = "45";

    const el = document.createElement("input");
    el.type = "range";
    el.min = "-30";
    el.max = "60";
    el.step = "30";

    const dist = document.createElement("select");
    for (const v of ["close-up", "medium shot", "wide shot"]) {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = v;
        dist.appendChild(opt);
    }

    const trig = document.createElement("input");
    trig.type = "checkbox";

    const azVal = document.createElement("div");
    azVal.style.cssText = "font-size:12px;opacity:0.8;";
    const elVal = document.createElement("div");
    elVal.style.cssText = "font-size:12px;opacity:0.8;";

    const promptOut = document.createElement("input");
    promptOut.type = "text";
    promptOut.readOnly = true;
    promptOut.style.cssText =
        "width:100%;padding:8px;background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;";

    azF.wrap.appendChild(az);
    azF.wrap.appendChild(azVal);
    elF.wrap.appendChild(el);
    elF.wrap.appendChild(elVal);
    distF.wrap.appendChild(dist);
    trigF.wrap.appendChild(trig);

    row.appendChild(azF.wrap);
    row.appendChild(elF.wrap);
    row.appendChild(distF.wrap);
    row.appendChild(trigF.wrap);

    const write = () => {
        const data = {
            azimuth: clampInt(az.value, 0, 360),
            elevation: clampInt(el.value, -30, 60),
            distance: dist.value,
            include_trigger: !!trig.checked,
        };
        w.value = JSON.stringify(data);
        w.callback?.(w.value);
        azVal.textContent = String(data.azimuth);
        elVal.textContent = String(data.elevation);
        promptOut.value = buildVNCCSPrompt(data);
    };

    const read = () => {
        let data;
        try {
            data = JSON.parse(w.value || "{}");
        } catch {
            data = {};
        }
        az.value = String(clampInt(data?.azimuth ?? 0, 0, 360));
        el.value = String(clampInt(data?.elevation ?? 0, -30, 60));
        dist.value = data?.distance ?? "medium shot";
        trig.checked = data?.include_trigger !== false;
        write();
    };

    az.addEventListener("input", write);
    el.addEventListener("input", write);
    dist.addEventListener("change", write);
    trig.addEventListener("change", write);

    container.appendChild(row);
    container.appendChild(promptOut);

    return { container, read };
}

function parseImageList(text) {
    return (text || "")
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => !!s);
}

function setImageList(node, names) {
    const w = getImageListWidget(node);
    if (!w) return;
    w.value = (names || []).join("\n");
    w.callback?.(w.value);
}

function getMaxImagesValue(node) {
    const w = node?.widgets?.find((x) => x.name === "max_images");
    const v = w?.value;
    return typeof v === "number" ? v : 0;
}

function getSeedValue(node) {
    const w = node?.widgets?.find((x) => x.name === "seed");
    const v = w?.value;
    return typeof v === "number" ? v : -1;
}

function randomSeedValue() {
    return Math.floor(Math.random() * 2147483647);
}

function deepClone(obj) {
    return QueueManager.deepClone(obj);
}

function getWidgetByName(node, name) {
    return node?.widgets?.find((w) => w.name === name);
}

const IMAGE_WIDGET_LABELS = {
    image_list: "图片列表",
    max_images: "最大图片数",
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
        const label = IMAGE_WIDGET_LABELS[w.name];
        if (label) w.label = label;
    }
    for (const input of node?.inputs || []) {
        const label = IMAGE_WIDGET_LABELS[input.name] || IMAGE_WIDGET_LABELS[input.widget?.name];
        if (label) input.label = label;
    }
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

function getCameraDataWidget(node) {
    return getWidgetByName(node, "camera_data");
}

async function queueCurrent(node) {
    const prompt = await QueueManager.getPrompt();
    const index = readIntWidget(node, "index", 0, 0, 100000);
    const seed = getSeedValue(node);
    patchImagePrompt(prompt, node, index, {
        seedValue: seed === -1 ? randomSeedValue() : undefined,
        shuffle: false,
    });
    await QueueManager.enqueuePrompt(prompt);
}

function patchImagePrompt(prompt, node, index, { seedValue, shuffle, allowDuplicate } = {}) {
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

// 从节点自身读取队列阈值
function getQueueThresholdValue(node) {
    return readIntWidget(node, "queue_threshold", 199, 1, 1000);
}

// 从节点自身读取检查间隔
function getCheckIntervalValue(node) {
    return readIntWidget(node, "check_interval_ms", 1000, 100, 60000);
}

// 从节点自身读取入队次数
function getQueueCountValue(node) {
    return readIntWidget(node, "queue_count", 0, 0, 100000);
}

// 从节点自身读取是否乱序
function getShuffleValue(node) {
    const w = getWidgetByName(node, "shuffle");
    return w?.value === true;
}

// 从节点自身读取是否允许重复
function getAllowDuplicateValue(node) {
    const w = getWidgetByName(node, "allow_duplicate");
    return w?.value !== false; // 默认 true
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
    node._batchLoadImagesUI?.updateBatchStatus?.(status);
    app.graph.setDirtyCanvas(true, true);
}

async function restoreBatchStatus(node) {
    const saved = node?.properties?.glowloader_last_batch || null;
    if (saved) {
        node._glowloaderBatchStatus = saved;
        node._batchLoadImagesUI?.updateBatchStatus?.(saved);
    }

    const batchId = node?.properties?.glowloader_last_batch_id || saved?.batch_id;
    if (!batchId) return;

    try {
        const status = await QueueManager.getBatchStatus(batchId);
        if (status) {
            setBatchStatus(node, status);
            if (!["completed", "cancelled", "error", "paused"].includes(status.status)) {
                QueueManager.watchBatch(status.batch_id, (next) => setBatchStatus(node, next));
            }
        }
    } catch (e) {
        console.warn("[BatchLoadImages] 恢复批次状态失败:", e);
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

async function queueAllSequential(node) {
    const names0 = parseImageList(getImageListWidget(node)?.value);
    if (!names0 || names0.length === 0) return;

    const maxImages = getMaxImagesValue(node);
    const names = maxImages && maxImages > 0 ? names0.slice(0, maxImages) : names0;
    if (names.length === 0) return;

    const queueCount = getQueueCountValue(node);
    const totalCount = queueCount > 0 ? queueCount : names.length;

    const prompts = [];
    const wMode = getWidgetByName(node, "mode");
    const wIndex = getWidgetByName(node, "index");
    const wShuffle = getWidgetByName(node, "shuffle");
    const wAllowDup = getWidgetByName(node, "allow_duplicate");
    const wSeed = getWidgetByName(node, "seed");

    if (!wMode || !wIndex) {
        const basePrompt = await QueueManager.getPrompt();
        const nodeId = String(node.id);
        for (let i = 0; i < totalCount; i++) {
            const prompt = deepClone(basePrompt);
            const apiNode = prompt.output?.[nodeId];
            if (!apiNode) continue;
            apiNode.inputs = apiNode.inputs || {};
            apiNode.inputs.mode = "single";
            apiNode.inputs.index = i;
            apiNode.inputs.shuffle = false;
            apiNode.inputs.allow_duplicate = true;
            if (getSeedValue(node) === -1) apiNode.inputs.seed = randomSeedValue();
            prompts.push(prompt);
        }
        return submitPromptBatch(node, "逐张入队", prompts);
    }

    const prevMode = wMode.value;
    const prevIndex = wIndex.value;
    const prevShuffle = wShuffle?.value;
    const prevAllowDup = wAllowDup?.value;
    const prevSeed = wSeed?.value;

    try {
        wMode.value = "single";
        wMode.callback?.(wMode.value);
        // 顺序入队：禁用 shuffle，按 index 顺序
        if (wShuffle) {
            wShuffle.value = false;
            wShuffle.callback?.(false);
        }
        if (wAllowDup) {
            wAllowDup.value = true; // 顺序入队允许重复（循环）
            wAllowDup.callback?.(true);
        }
        for (let i = 0; i < totalCount; i++) {
            wIndex.value = i;
            wIndex.callback?.(wIndex.value);
            QueueManager.invalidatePromptCache();
            const prompt = deepClone(await QueueManager.getPrompt());
            patchImagePrompt(prompt, node, i, {
                seedValue: prevSeed === -1 ? randomSeedValue() : undefined,
                shuffle: false,
                allowDuplicate: true,
            });
            prompts.push(prompt);
        }
    } finally {
        wMode.value = prevMode;
        wMode.callback?.(wMode.value);
        wIndex.value = prevIndex;
        wIndex.callback?.(wIndex.value);
        if (wShuffle) {
            wShuffle.value = prevShuffle;
            wShuffle.callback?.(prevShuffle);
        }
        if (wAllowDup) {
            wAllowDup.value = prevAllowDup;
            wAllowDup.callback?.(prevAllowDup);
        }
        if (wSeed) {
            wSeed.value = prevSeed;
            wSeed.callback?.(prevSeed);
        }
    }

    return submitPromptBatch(node, "逐张入队", prompts);
}

// Fisher-Yates 洗牌算法
function shuffleArray(array) {
    const arr = array.slice();
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function mulberry32(seed) {
    return function () {
        let t = (seed += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffleArrayWithRng(array, rng) {
    const arr = array.slice();
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

async function queueAllShuffled(node) {
    const names0 = parseImageList(getImageListWidget(node)?.value);
    if (!names0 || names0.length === 0) return;

    const maxImages = getMaxImagesValue(node);
    const names = maxImages && maxImages > 0 ? names0.slice(0, maxImages) : names0;
    if (names.length === 0) return;

    const queueCount = getQueueCountValue(node);
    const allowDuplicate = getAllowDuplicateValue(node);
    const seed = getSeedValue(node);
    const rng = seed >= 0 ? mulberry32(seed) : Math.random;
    const totalCount = queueCount > 0 ? queueCount : names.length;

    // 生成乱序索引
    let indices;
    if (allowDuplicate) {
        // 允许重复：纯随机选择
        indices = Array.from({ length: totalCount }, () => Math.floor(rng() * names.length));
    } else {
        // 不允许重复：每轮重新打乱，每轮每张图只出现一次
        indices = [];
        let remaining = totalCount;
        while (remaining > 0) {
            const roundSize = Math.min(remaining, names.length);
            const roundIndices = shuffleArrayWithRng(Array.from({ length: names.length }, (_, i) => i), rng).slice(0, roundSize);
            indices.push(...roundIndices);
            remaining -= roundSize;
        }
    }

    const prompts = [];
    const wMode = getWidgetByName(node, "mode");
    const wIndex = getWidgetByName(node, "index");
    const wShuffle = getWidgetByName(node, "shuffle");
    const wAllowDup = getWidgetByName(node, "allow_duplicate");
    const wSeed = getWidgetByName(node, "seed");

    if (!wMode || !wIndex) {
        const basePrompt = await QueueManager.getPrompt();
        const nodeId = String(node.id);
        for (let i = 0; i < indices.length; i++) {
            const idx = indices[i];
            const prompt = deepClone(basePrompt);
            const apiNode = prompt.output?.[nodeId];
            if (!apiNode) continue;
            apiNode.inputs = apiNode.inputs || {};
            apiNode.inputs.mode = "single";
            apiNode.inputs.index = idx;
            apiNode.inputs.shuffle = false;
            apiNode.inputs.allow_duplicate = allowDuplicate;
            if (seed === -1) apiNode.inputs.seed = randomSeedValue();
            prompts.push(prompt);
        }
        return submitPromptBatch(node, "乱序入队", prompts);
    }

    const prevMode = wMode.value;
    const prevIndex = wIndex.value;
    const prevShuffle = wShuffle?.value;
    const prevAllowDup = wAllowDup?.value;
    const prevSeed = wSeed?.value;

    try {
        wMode.value = "single";
        wMode.callback?.(wMode.value);
        // 乱序入队：启用 shuffle，seed 由标准控件决定随机序列
        if (wShuffle) {
            wShuffle.value = true;
            wShuffle.callback?.(true);
        }
        if (wAllowDup) {
            wAllowDup.value = allowDuplicate;
            wAllowDup.callback?.(allowDuplicate);
        }
        for (let i = 0; i < indices.length; i++) {
            wIndex.value = indices[i];
            wIndex.callback?.(wIndex.value);
            QueueManager.invalidatePromptCache();
            const prompt = deepClone(await QueueManager.getPrompt());
            patchImagePrompt(prompt, node, indices[i], {
                seedValue: prevSeed === -1 ? randomSeedValue() : undefined,
                shuffle: false,
                allowDuplicate,
            });
            prompts.push(prompt);
        }
    } finally {
        wMode.value = prevMode;
        wMode.callback?.(wMode.value);
        wIndex.value = prevIndex;
        wIndex.callback?.(wIndex.value);
        if (wShuffle) {
            wShuffle.value = prevShuffle;
            wShuffle.callback?.(prevShuffle);
        }
        if (wAllowDup) {
            wAllowDup.value = prevAllowDup;
            wAllowDup.callback?.(prevAllowDup);
        }
        if (wSeed) {
            wSeed.value = prevSeed;
            wSeed.callback?.(prevSeed);
        }
    }

    return submitPromptBatch(node, "乱序入队", prompts);
}

function getViewUrl(filename) {
    const previewParam = app.getPreviewFormatParam?.() || "";
    const randParam = app.getRandParam?.() || "";
    return api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input${previewParam}${randParam}`);
}

function isFilesDragEvent(e) {
    const dt = e?.dataTransfer;
    if (!dt) return false;
    if (dt.files && dt.files.length > 0) return true;
    // Some browsers only set types during dragover
    return Array.from(dt.types || []).includes("Files");
}

const _batchLoadImagesDomUIs = new Set();

function _isPointInRect(x, y, rect) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function _getUIUnderPointer(e) {
    const x = e?.clientX;
    const y = e?.clientY;
    if (typeof x !== "number" || typeof y !== "number") return null;

    for (const entry of _batchLoadImagesDomUIs) {
        const rect = entry?.container?.getBoundingClientRect?.();
        if (!rect) continue;
        if (_isPointInRect(x, y, rect)) return entry;
    }
    return null;
}

function _setDraggingUI(activeEntry) {
    for (const entry of _batchLoadImagesDomUIs) {
        entry?.setDragging?.(entry === activeEntry);
    }
}

// Prevent the browser from navigating away when dropping files.
// We only do this for file drags.
let _globalDragDropInstalled = false;
function ensureGlobalDragDropPrevention() {
    if (_globalDragDropInstalled) return;
    _globalDragDropInstalled = true;

    window.addEventListener(
        "dragover",
        (e) => {
            if (!isFilesDragEvent(e)) return;
            e.preventDefault();
            _setDraggingUI(_getUIUnderPointer(e));
        },
        { capture: true }
    );

    window.addEventListener(
        "drop",
        async (e) => {
            if (!isFilesDragEvent(e)) return;
            e.preventDefault();

            const hit = _getUIUnderPointer(e);
            _setDraggingUI(null);
            if (!hit) return;

            const files = Array.from(e.dataTransfer?.files || []);
            if (files.length === 0) return;
            await uploadFilesSequential(hit.node, files, { replace: false, preserveFolders: true });
            hit.redraw?.();
        },
        { capture: true }
    );

    window.addEventListener(
        "dragleave",
        (e) => {
            if (!isFilesDragEvent(e)) return;
            _setDraggingUI(null);
        },
        { capture: true }
    );
}

async function uploadOneImage(file) {
    // Always upload flat to ComfyUI input directory.
    // The original folder structure is encoded in the image_list entry instead.
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

/**
 * Sanitize a relative path: normalize backslashes, strip leading slashes /
 * drive letters, and resolve '..' components to prevent path traversal.
 */
function sanitizeRelPath(relpath) {
    if (!relpath) return "";
    // Normalize backslashes to forward slashes
    relpath = relpath.replace(/\\/g, "/");
    // Strip leading slashes
    relpath = relpath.replace(/^\/+/, "");
    // Strip Windows drive letters (C:/ etc.)
    relpath = relpath.replace(/^[A-Za-z]:\/+/, "");
    // Split and resolve '..' / '.' components
    const parts = [];
    for (const seg of relpath.split("/")) {
        if (seg === "" || seg === ".") continue;
        if (seg === "..") {
            if (parts.length > 0) parts.pop();
            continue;
        }
        parts.push(seg);
    }
    return parts.join("/");
}

/**
 * Build an image_list entry that encodes both the ComfyUI filename
 * and the original relative path (for folder structure preservation).
 * Format:  <comfy_filename>|<original_relative_path>
 * If no original relpath, just returns the comfy filename.
 * The originalRelPath is sanitized before encoding.
 */
function buildImageListEntry(comfyName, originalRelPath) {
    const sanitized = sanitizeRelPath(originalRelPath);
    if (sanitized && sanitized !== comfyName) {
        return comfyName + "|" + sanitized;
    }
    return comfyName;
}

/**
 * Parse an image_list entry back into (comfyName, originalRelPath).
 * Handles filenames that may contain '|' by splitting at the first '|'
 * whose right side contains '/' (indicating a path component).
 */
function parseImageListEntry(entry) {
    entry = (entry || "").trim();
    if (!entry) return null;
    const sep = entry.indexOf("|");
    if (sep >= 0) {
        let comfyName = entry.substring(0, sep).trim();
        let rawRelPath = entry.substring(sep + 1).trim();
        let originalRelPath = sanitizeRelPath(rawRelPath) || comfyName;
        return { comfyName, originalRelPath };
    }
    return { comfyName: entry, originalRelPath: entry };
}

async function uploadFilesSequential(node, files, { replace = false, preserveFolders = false } = {}) {
    const w = getImageListWidget(node);
    if (!w) return [];

    const existing = replace ? [] : parseImageList(w.value);
    const uploaded = [];

    for (const file of files) {
        if (!file) continue;
        // skip non-images (allow by MIME type or by extension)
        const name = (file.name || "").toLowerCase();
        const extOk = name.endsWith(".webp") || name.endsWith(".avif") || name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".gif") || name.endsWith(".bmp") || name.endsWith(".tiff");
        if (file?.type && !file.type.startsWith("image/") && !extOk) continue;
        if (!file?.type && !extOk) continue;

        // Upload file to ComfyUI input (flat, no subfolder)
        const comfyName = await uploadOneImage(file);
        if (!comfyName) continue;

        // Determine the original relative path from the folder structure
        let originalRelPath = comfyName;
        if (preserveFolders && file.webkitRelativePath) {
            // webkitRelativePath is already relative; sanitize for safety
            originalRelPath = sanitizeRelPath(file.webkitRelativePath) || comfyName;
        }

        uploaded.push(buildImageListEntry(comfyName, originalRelPath));
    }

    const merged = existing.concat(uploaded);
    setImageList(node, merged);
    return uploaded;
}

function openMultiSelect(node, { replace = false } = {}) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/avif,image/avif-sequence";
    input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);

    input.onchange = async (e) => {
        try {
            const files = Array.from(e.target.files || []);
            await uploadFilesSequential(node, files, { replace, preserveFolders: false });
        } finally {
            document.body.removeChild(input);
        }
    };

    input.click();
}

function openFolderSelect(node, { replace = false } = {}) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/avif,image/avif-sequence";
    input.multiple = true;
    input.webkitdirectory = true;
    input.directory = true;
    input.style.display = "none";
    document.body.appendChild(input);

    input.onchange = async (e) => {
        try {
            let files = Array.from(e.target.files || []);
            const allowExt = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif"]);
            files = files.filter((f) => {
                const name = (f?.name || "").toLowerCase();
                for (const ext of allowExt) {
                    if (name.endsWith(ext)) return true;
                }
                return false;
            });
            // keep stable ordering
            files.sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name));
            await uploadFilesSequential(node, files, { replace, preserveFolders: true });
        } finally {
            document.body.removeChild(input);
        }
    };

    input.click();
}

function createBrowserUI(node) {
    const container = document.createElement("div");
    container.style.cssText =
        "width:100%;padding:8px;background:var(--comfy-menu-bg);border:1px solid var(--border-color);border-radius:6px;margin:5px 0;pointer-events:auto;";

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:6px;margin-bottom:8px;";

    const mkBtn = (label) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.style.cssText =
            "flex:1;padding:8px;background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:13px;";
        return b;
    };

    const replaceBtn = mkBtn("选择图片");
    const addBtn = mkBtn("追加图片");
    const folderBtn = mkBtn("选择文件夹");
    const queueBtn = mkBtn("逐张入队");
    const queueShuffleBtn = mkBtn("🔀 乱序入队");
    const queueOneBtn = mkBtn("入队当前");

    const clearBtn = document.createElement("button");
    clearBtn.textContent = "清空";
    clearBtn.style.cssText =
        "padding:8px;background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:13px;";

    const stopBtn = document.createElement("button");
    stopBtn.textContent = "⏹ 停止";
    stopBtn.style.cssText =
        "padding:8px;background:rgba(200,50,50,0.8);color:#fff;border:1px solid rgba(200,50,50,0.9);border-radius:4px;cursor:pointer;font-size:13px;";
    stopBtn.onclick = () => {
        QueueManager.stop();
    };

    btnRow.appendChild(replaceBtn);
    btnRow.appendChild(addBtn);
    btnRow.appendChild(folderBtn);
    btnRow.appendChild(queueBtn);
    btnRow.appendChild(queueShuffleBtn);
    btnRow.appendChild(queueOneBtn);
    btnRow.appendChild(clearBtn);
    btnRow.appendChild(stopBtn);

    const mkLabel = (text) => {
        const span = document.createElement("span");
        span.textContent = text;
        span.style.cssText = "font-size:11px;opacity:0.8;";
        return span;
    };

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
            batchInfo.textContent = `${status.label || "批次"} 准备中 ${status.completed || 0}/${status.total || 0}`;
            return;
        }
        const id = status.batch_id ? status.batch_id.slice(0, 8) : "-";
        const queue = status.queue || {};
        const queueText = queue.total > 0 ? `，队列 ${queue.total}（运行 ${queue.running || 0}/等待 ${queue.pending || 0}）` : "";
        batchInfo.textContent = `批次 ${id} ${status.status} 已提交 ${status.submitted || 0}/${status.total || 0}，完成 ${status.completed || 0}/${status.total || 0}${queueText}`;
    };

    const grid = document.createElement("div");
    grid.style.cssText =
        "display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:6px;max-height:260px;overflow-y:auto;background:var(--comfy-input-bg);padding:6px;border-radius:4px;";

    const updateInfo = () => {
        const names = parseImageList(getImageListWidget(node)?.value);
        info.textContent = `已选择 ${names.length} 张（可拖拽图片到此面板/节点上）`;
    };

    const redraw = () => {
        const names = parseImageList(getImageListWidget(node)?.value);
        grid.innerHTML = "";

        if (names.length > 10) {
            // 超过10张：用文字列表展示，避免大量 img 请求导致卡顿
            grid.style.gridTemplateColumns = "1fr";
            grid.style.maxHeight = "200px";

            const listEl = document.createElement("div");
            listEl.style.cssText = "display:flex;flex-direction:column;gap:2px;";

            names.forEach((rawEntry, idx) => {
                const parsed = parseImageListEntry(rawEntry);
                const displayLabel = parsed && parsed.originalRelPath !== parsed.comfyName ? parsed.originalRelPath : (parsed ? parsed.comfyName : rawEntry);

                const row = document.createElement("div");
                row.style.cssText = "display:flex;align-items:center;gap:6px;font-size:11px;padding:2px 4px;border-radius:3px;";
                row.onmouseenter = () => { row.style.background = "var(--comfy-input-bg)"; };
                row.onmouseleave = () => { row.style.background = ""; };

                const idxSpan = document.createElement("span");
                idxSpan.textContent = `${idx + 1}.`;
                idxSpan.style.cssText = "opacity:0.5;min-width:24px;text-align:right;";

                const nameSpan = document.createElement("span");
                nameSpan.textContent = displayLabel;
                nameSpan.title = displayLabel;
                nameSpan.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;";

                const del = document.createElement("button");
                del.textContent = "×";
                del.title = "删除";
                del.style.cssText =
                    "width:18px;height:18px;background:rgba(255,0,0,0.6);color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:13px;line-height:1;flex-shrink:0;";
                del.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const next = names.slice(0, idx).concat(names.slice(idx + 1));
                    setImageList(node, next);
                    redraw();
                };

                row.appendChild(idxSpan);
                row.appendChild(nameSpan);
                row.appendChild(del);
                listEl.appendChild(row);
            });

            grid.appendChild(listEl);
        } else {
            // 10张及以下：显示缩略图
            grid.style.gridTemplateColumns = "repeat(auto-fill,minmax(96px,1fr))";
            grid.style.maxHeight = "260px";

            const frag = document.createDocumentFragment();
            names.forEach((rawEntry, idx) => {
                const parsed = parseImageListEntry(rawEntry);
                const comfyName = parsed ? parsed.comfyName : rawEntry;
                const displayLabel = parsed && parsed.originalRelPath !== parsed.comfyName ? parsed.originalRelPath : comfyName;

                const cell = document.createElement("div");
                cell.style.cssText = "display:flex;flex-direction:column;gap:3px;";

                const thumb = document.createElement("div");
                thumb.style.cssText =
                    "position:relative;aspect-ratio:1;border-radius:4px;overflow:hidden;border:1px solid var(--border-color);background:#000;";

                const img = document.createElement("img");
                img.src = getViewUrl(comfyName);
                img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";

                const del = document.createElement("button");
                del.textContent = "×";
                del.title = "删除";
                del.style.cssText =
                    "position:absolute;top:2px;right:2px;width:20px;height:20px;background:rgba(255,0,0,0.75);color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:16px;line-height:1;";
                del.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const next = names.slice(0, idx).concat(names.slice(idx + 1));
                    setImageList(node, next);
                    redraw();
                };

                const label = document.createElement("div");
                label.textContent = displayLabel;
                label.title = displayLabel;
                label.style.cssText =
                    "font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:0.9;";

                thumb.appendChild(img);
                thumb.appendChild(del);
                cell.appendChild(thumb);
                cell.appendChild(label);
                frag.appendChild(cell);
            });

            grid.appendChild(frag);
        }

        updateInfo();
        app.graph.setDirtyCanvas(true);
    };

    const handleDropFiles = async (files, { replace = false } = {}) => {
        if (!files || files.length === 0) return;
        await uploadFilesSequential(node, files, { replace, preserveFolders: true });
        redraw();
    };

    // Most reliable: handle drop on our DOM panel.
    container.addEventListener("dragover", (e) => {
        if (!isFilesDragEvent(e)) return;
        e.preventDefault();
        e.stopPropagation();
    });

    container.addEventListener("drop", async (e) => {
        if (!isFilesDragEvent(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const files = Array.from(e.dataTransfer?.files || []);
        await handleDropFiles(files, { replace: false });
    });

    const setDragging = (on) => {
        container.style.border = on ? "2px dashed #4a6" : "1px solid var(--border-color)";
    };

    replaceBtn.onclick = async () => {
        openMultiSelect(node, { replace: true });
    };
    addBtn.onclick = async () => {
        openMultiSelect(node, { replace: false });
    };
    folderBtn.onclick = async () => {
        openFolderSelect(node, { replace: true });
    };
    queueBtn.onclick = async () => {
        await queueAllSequential(node);
    };
    queueShuffleBtn.onclick = async () => {
        await queueAllShuffled(node);
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
        setImageList(node, []);
        redraw();
    };

    container.appendChild(btnRow);
    container.appendChild(batchInfo);
    container.appendChild(info);
    container.appendChild(grid);
    updateBatchStatus(node._glowloaderBatchStatus || node?.properties?.glowloader_last_batch);

    return {
        container,
        redraw,
        setDragging,
        updateBatchStatus,
    };
}

app.registerExtension({
    name: "BatchLoadImages.Extension",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "BatchLoadImages") return;

        ensureGlobalDragDropPrevention();

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);
            localizeStandardWidgets(this);

            const imageListWidget = getImageListWidget(this);
            if (imageListWidget) {
                // Hide the giant textbox; we manage it through the DOM UI.
                imageListWidget.type = "hidden";
                imageListWidget.computeSize = () => [0, -4];
            }

            // 隐藏 trigger widget（通过连线控制）
            const triggerWidget = getWidgetByName(this, "trigger");
            if (triggerWidget) {
                triggerWidget.type = "hidden";
                triggerWidget.computeSize = () => [0, -4];
            }

            // Create file-browser like UI
            const ui = createBrowserUI(this);
            this._batchLoadImagesUI = ui;
            this.addDOMWidget("batch_load_images", "customwidget", ui.container);
            this.setSize([420, 320]);

            _batchLoadImagesDomUIs.add({ node: this, container: ui.container, redraw: ui.redraw, setDragging: ui.setDragging });

            const prevOnRemoved = this.onRemoved;
            this.onRemoved = function () {
                for (const entry of _batchLoadImagesDomUIs) {
                    if (entry?.node === this) {
                        _batchLoadImagesDomUIs.delete(entry);
                        break;
                    }
                }
                return prevOnRemoved?.apply(this, arguments);
            };

            // Keep the DOM gallery in sync if something else changes the widget.
            if (imageListWidget) {
                const origCallback = imageListWidget.callback;
                imageListWidget.callback = function (value) {
                    origCallback?.call(this, value);
                    ui.redraw();
                };
            }

            ui.redraw();
            restoreBatchStatus(this);

            return r;
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = origOnConfigure?.apply(this, arguments);
            localizeStandardWidgets(this);
            this._batchLoadImagesUI?.redraw?.();
            restoreBatchStatus(this);
            return r;
        };

        const origOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (output) {
            origOnExecuted?.apply(this, arguments);
            this._batchLoadImagesUI?.redraw?.();
        };
    },
});

app.registerExtension({
    name: "VNCCS.VisualPositionControl.Extension",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "VNCCS_VisualPositionControl") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);

            const ui = createVNCCSVisualUI(this);
            if (ui) {
                this.addDOMWidget("vnccs_visual", "customwidget", ui.container);
                this.setSize([420, 220]);
                ui.read();
            }

            return r;
        };
    },
});

app.registerExtension({
    name: "BatchSaveImages.Extension",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "BatchSaveImages") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);

            // Hide the paths multiline textbox
            const pathsWidget = this?.widgets?.find((w) => w.name === "paths");
            if (pathsWidget) {
                pathsWidget.type = "hidden";
                pathsWidget.computeSize = () => [0, -4];
            }

            return r;
        };
    },
});
