import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

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

function deepClone(obj) {
    if (typeof structuredClone === "function") return structuredClone(obj);
    return JSON.parse(JSON.stringify(obj));
}

function getWidgetByName(node, name) {
    return node?.widgets?.find((w) => w.name === name);
}

function getCameraDataWidget(node) {
    return getWidgetByName(node, "camera_data");
}

async function queueCurrent(node) {
    const prompt = await app.graphToPrompt();
    await api.queuePrompt(-1, prompt);
}

// 从节点自身读取队列阈值
function getQueueThresholdValue(node) {
    const w = node?.widgets?.find((x) => x.name === "queue_threshold");
    const v = w?.value;
    return typeof v === "number" && v > 0 ? v : 199;
}

// 从节点自身读取检查间隔
function getCheckIntervalValue(node) {
    const w = node?.widgets?.find((x) => x.name === "check_interval_ms");
    const v = w?.value;
    return typeof v === "number" && v > 0 ? v : 1000;
}

// 等待队列有空位（从节点自身读取阈值和间隔）
async function waitForQueueSpace(node, targetSpace = 1) {
    const threshold = getQueueThresholdValue(node);
    const checkInterval = getCheckIntervalValue(node);
    const maxWaitTime = 300000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
        const queueSize = app.ui?.lastQueueSize || 0;
        const remaining = threshold - queueSize;
        if (remaining >= targetSpace) return true;
        console.log(`[BatchLoadImages] 队列已满 (${queueSize}/${threshold})，等待 ${checkInterval}ms...`);
        await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    console.warn(`[BatchLoadImages] 等待队列空位超时，继续执行...`);
    return false;
}

async function queueAllSequential(node) {
    const names0 = parseImageList(getImageListWidget(node)?.value);
    if (!names0 || names0.length === 0) return;

    const maxImages = getMaxImagesValue(node);
    const names = maxImages && maxImages > 0 ? names0.slice(0, maxImages) : names0;
    if (names.length === 0) return;

    const wMode = getWidgetByName(node, "mode");
    const wIndex = getWidgetByName(node, "index");
    if (!wMode || !wIndex) {
        // Fallback: modify prompt JSON directly.
        const basePrompt = await app.graphToPrompt();
        const nodeId = String(node.id);
        for (let i = 0; i < names.length; i++) {
            await waitForQueueSpace(node, 1);
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
        for (let i = 0; i < names.length; i++) {
            await waitForQueueSpace(node, 1);
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
    const queueOneBtn = mkBtn("入队当前");

    const clearBtn = document.createElement("button");
    clearBtn.textContent = "清空";
    clearBtn.style.cssText =
        "padding:8px;background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;cursor:pointer;font-size:13px;";

    btnRow.appendChild(replaceBtn);
    btnRow.appendChild(addBtn);
    btnRow.appendChild(folderBtn);
    btnRow.appendChild(queueBtn);
    btnRow.appendChild(queueOneBtn);
    btnRow.appendChild(clearBtn);

    // 队列设置行
    const queueSettingsRow = document.createElement("div");
    queueSettingsRow.style.cssText = "display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;align-items:center;";

    const mkLabel = (text) => {
        const span = document.createElement("span");
        span.textContent = text;
        span.style.cssText = "font-size:11px;opacity:0.8;";
        return span;
    };

    const mkInput = (type, value, onChange) => {
        const input = document.createElement("input");
        input.type = type;
        input.value = value;
        input.style.cssText = "width:60px;padding:4px;background:var(--comfy-input-bg);color:var(--input-text);border:1px solid var(--border-color);border-radius:4px;font-size:12px;";
        input.onchange = (e) => onChange?.(e.target.value);
        return input;
    };

    queueSettingsRow.appendChild(mkLabel("队列阈值:"));
    const thresholdInput = mkInput("number", getQueueThresholdValue(node), (v) => {
        const w = getWidgetByName(node, "queue_threshold");
        if (w) {
            w.value = Math.max(1, Math.min(1000, parseInt(v) || 199));
            w.callback?.(w.value);
        }
    });
    thresholdInput.style.width = "50px";
    queueSettingsRow.appendChild(thresholdInput);

    queueSettingsRow.appendChild(mkLabel("检查间隔ms:"));
    const intervalInput = mkInput("number", getCheckIntervalValue(node), (v) => {
        const w = getWidgetByName(node, "check_interval_ms");
        if (w) {
            w.value = Math.max(100, Math.min(60000, parseInt(v) || 1000));
            w.callback?.(w.value);
        }
    });
    intervalInput.style.width = "60px";
    queueSettingsRow.appendChild(intervalInput);

    const info = document.createElement("div");
    info.style.cssText = "font-size:12px;opacity:0.85;margin-bottom:6px;";

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
    container.appendChild(queueSettingsRow);
    container.appendChild(info);
    container.appendChild(grid);

    return { container, redraw, setDragging };
}

app.registerExtension({
    name: "BatchLoadImages.Extension",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "BatchLoadImages") return;

        ensureGlobalDragDropPrevention();

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);

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

            // 隐藏队列控制 widget（通过 UI 控制）
            const queueWidgets = ["queue_threshold", "check_interval_ms"];
            for (const name of queueWidgets) {
                const w = getWidgetByName(this, name);
                if (w) {
                    w.type = "hidden";
                    w.computeSize = () => [0, -4];
                }
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
