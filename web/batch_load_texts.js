import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

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
    w.value = (texts || []).join("\n");
    w.callback?.(w.value);
}

function getMaxTextsValue(node) {
    const w = node?.widgets?.find((x) => x.name === "max_texts");
    const v = w?.value;
    return typeof v === "number" ? v : 0;
}

function getQueueCountValue(node) {
    const w = node?.widgets?.find((x) => x.name === "queue_count");
    const v = w?.value;
    return typeof v === "number" ? v : 0;
}

function getShuffleValue(node) {
    const w = node?.widgets?.find((x) => x.name === "shuffle");
    return w?.value === true;
}

function getAllowDuplicateValue(node) {
    const w = node?.widgets?.find((x) => x.name === "allow_duplicate");
    return w?.value !== false;
}

function getSeedValue(node) {
    const w = node?.widgets?.find((x) => x.name === "seed");
    const v = w?.value;
    return typeof v === "number" ? v : -1;
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

function getWidgetByName(node, name) {
    return node?.widgets?.find((w) => w.name === name);
}

async function queueCurrent(node) {
    const prompt = await app.graphToPrompt();
    await api.queuePrompt(-1, prompt);
}

// 等待队列有空位（从节点自身读取阈值和间隔）
async function waitForQueueSpace(node, targetSpace = 1) {
    const threshold = getQueueThresholdValue(node);
    const checkInterval = getCheckIntervalValue(node);
    const maxWaitTime = 300000; // 最多等待 5 分钟
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
        // 获取当前队列大小
        const queueSize = app.ui?.lastQueueSize || 0;
        const remaining = threshold - queueSize;

        if (remaining >= targetSpace) {
            return true; // 有足够空间
        }

        console.log(`[BatchLoadTexts] 队列已满 (${queueSize}/${threshold})，等待 ${checkInterval}ms...`);
        await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    console.warn(`[BatchLoadTexts] 等待队列空位超时，继续执行...`);
    return false;
}

function deepClone(obj) {
    if (typeof structuredClone === "function") return structuredClone(obj);
    return JSON.parse(JSON.stringify(obj));
}

// 调用后端生成入队序列
async function generateQueueSequence(node) {
    const sourceMode = getSourceModeValue(node);
    const textList = getTextListWidget(node)?.value || "";
    const fileMode = getFileModeValue(node);
    const maxTexts = getMaxTextsValue(node);
    const queueCount = getQueueCountValue(node);
    const shuffle = getShuffleValue(node);
    const allowDuplicate = getAllowDuplicateValue(node);
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
            shuffle ? Math.floor(Math.random() * total) : i % total
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
    const sourceMode = getSourceModeValue(node);
    const texts0 = parseTextList(getTextListWidget(node)?.value);
    if (!texts0 || texts0.length === 0) return;

    const maxTexts = getMaxTextsValue(node);
    const texts = maxTexts && maxTexts > 0 ? texts0.slice(0, maxTexts) : texts0;
    if (texts.length === 0) return;

    // 生成分配序列
    let sequence;
    try {
        sequence = await generateQueueSequence(node);
    } catch (e) {
        // 后端API失败，使用前端简单逻辑
        console.warn("Backend sequence generation failed, using frontend fallback:", e);
        const fileMode = getFileModeValue(node);
        const queueCount = getQueueCountValue(node);
        const shuffle = getShuffleValue(node);
        const allowDuplicate = getAllowDuplicateValue(node);
        const seed = getSeedValue(node);

        // 文件模式下无法准确计算，使用简单循环
        if (sourceMode === "files") {
            const count = queueCount > 0 ? queueCount : texts.length;
            sequence = Array.from({ length: count }, (_, i) =>
                shuffle ? Math.floor(Math.random() * texts.length) : i % texts.length
            );
        } else {
            sequence = generateSequenceFallback(texts.length, queueCount, shuffle, allowDuplicate, seed);
        }
    }

    if (sequence.length === 0) return;

    const wMode = getWidgetByName(node, "mode");
    const wIndex = getWidgetByName(node, "index");

    const prevMode = wMode?.value;
    const prevIndex = wIndex?.value;

    // 收集其他需要同步的节点（按各自配置生成序列）
    const syncStates = await collectSyncNodeStates(node, sequence.length);

    // 保存当前节点 seed 以便恢复
    const wSeed = getWidgetByName(node, "seed");
    const prevSeed = wSeed?.value;

    try {
        if (wMode) {
            wMode.value = "single";
            wMode.callback?.(wMode.value);
        }

        // 第一次：获取当前队列大小，计算可直接入队的数量
        const initialQueueSize = app.ui?.lastQueueSize || 0;
        const threshold = getQueueThresholdValue(node);
        const firstBatch = Math.max(0, threshold - initialQueueSize);
        console.log(`[BatchLoadTexts] 初始队列: ${initialQueueSize}, 阈值: ${threshold}, 首批入队: ${Math.min(firstBatch, sequence.length)}`);

        for (let i = 0; i < sequence.length; i++) {
            // 超过首批数量后，才轮询等待队列空位
            if (i >= firstBatch) {
                await waitForQueueSpace(node, 1);
            }
            
            const idx = sequence[i];
            if (wIndex) {
                wIndex.value = idx;
                wIndex.callback?.(wIndex.value);
            }

            // 为当前节点生成新 seed（如果原 seed == -1），确保 IS_CHANGED 变化
            if (wSeed && prevSeed === -1) {
                const newSeed = Math.floor(Math.random() * 2147483647);
                wSeed.value = newSeed;
                wSeed.callback?.(newSeed);
            }

            // 同步其他 BatchLoadTexts 节点的 index 和 seed
            for (const s of syncStates) {
                if (s.sequence.length > 0) {
                    const syncIdx = s.sequence[i % s.sequence.length];
                    s.indexWidget.value = syncIdx;
                    s.indexWidget.callback?.(syncIdx);
                }
                // 为其他节点也生成新 seed（如果原 seed == -1）
                const syncSeedW = getWidgetByName(s.node, "seed");
                if (syncSeedW && s.prevSeed === -1) {
                    const newSeed = Math.floor(Math.random() * 2147483647);
                    syncSeedW.value = newSeed;
                    syncSeedW.callback?.(newSeed);
                }
            }

            if (!wIndex) {
                // Fallback: modify prompt JSON directly
                const prompt = deepClone(await app.graphToPrompt());
                const nodeId = String(node.id);
                const apiNode = prompt.output?.[nodeId];
                if (!apiNode) continue;
                apiNode.inputs = apiNode.inputs || {};
                apiNode.inputs.mode = "single";
                apiNode.inputs.index = idx;
                if (wSeed && prevSeed === -1) {
                    apiNode.inputs.seed = wSeed.value;
                }
                // 同步其他节点到 prompt JSON
                for (const s of syncStates) {
                    const syncNodeId = String(s.node.id);
                    const syncApiNode = prompt.output?.[syncNodeId];
                    if (syncApiNode) {
                        syncApiNode.inputs = syncApiNode.inputs || {};
                        syncApiNode.inputs.index = s.indexWidget.value;
                        const syncSeedW = getWidgetByName(s.node, "seed");
                        if (syncSeedW && s.prevSeed === -1) {
                            syncApiNode.inputs.seed = syncSeedW.value;
                        }
                    }
                }
                await api.queuePrompt(-1, prompt);
                continue;
            }
            await queueCurrent(node);
        }
    } finally {
        if (wMode) {
            wMode.value = prevMode;
            wMode.callback?.(wMode.value);
        }
        if (wIndex) {
            wIndex.value = prevIndex;
            wIndex.callback?.(wIndex.value);
        }
        // 恢复当前节点 seed
        if (wSeed) {
            wSeed.value = prevSeed;
            wSeed.callback?.(prevSeed);
        }
        // 恢复其他节点的 index 和 seed
        for (const s of syncStates) {
            s.indexWidget.value = s.prevIndex;
            s.indexWidget.callback?.(s.prevIndex);
            const syncSeedW = getWidgetByName(s.node, "seed");
            if (syncSeedW && s.prevSeed !== undefined) {
                syncSeedW.value = s.prevSeed;
                syncSeedW.callback?.(s.prevSeed);
            }
        }
    }
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

    // 源模式选择
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

    // 设置区域
    const settingsRow = document.createElement("div");
    settingsRow.style.cssText = "display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;align-items:center;";

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

    const mkCheckbox = (checked, onChange) => {
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = checked;
        input.style.cssText = "cursor:pointer;";
        input.onchange = (e) => onChange?.(e.target.checked);
        return input;
    };

    // Queue Count
    settingsRow.appendChild(mkLabel("入队次数:"));
    const queueCountInput = mkInput("number", getQueueCountValue(node) || 0, (v) => {
        const w = getWidgetByName(node, "queue_count");
        if (w) {
            w.value = parseInt(v) || 0;
            w.callback?.(w.value);
        }
    });
    settingsRow.appendChild(queueCountInput);

    // Shuffle
    settingsRow.appendChild(mkLabel("乱序:"));
    const shuffleCheckbox = mkCheckbox(getShuffleValue(node), (v) => {
        const w = getWidgetByName(node, "shuffle");
        if (w) {
            w.value = v;
            w.callback?.(w.value);
        }
    });
    settingsRow.appendChild(shuffleCheckbox);

    // Allow Duplicate
    settingsRow.appendChild(mkLabel("允许重复:"));
    const dupCheckbox = mkCheckbox(getAllowDuplicateValue(node), (v) => {
        const w = getWidgetByName(node, "allow_duplicate");
        if (w) {
            w.value = v;
            w.callback?.(w.value);
        }
    });
    settingsRow.appendChild(dupCheckbox);

    // Seed
    settingsRow.appendChild(mkLabel("种子:"));
    const seedInput = mkInput("number", getSeedValue(node), (v) => {
        const w = getWidgetByName(node, "seed");
        if (w) {
            w.value = parseInt(v) || -1;
            w.callback?.(w.value);
        }
    });
    settingsRow.appendChild(seedInput);

    // Queue Threshold
    settingsRow.appendChild(mkLabel("队列阈值:"));
    const thresholdInput = mkInput("number", getQueueThresholdValue(node), (v) => {
        const w = getWidgetByName(node, "queue_threshold");
        if (w) {
            w.value = Math.max(1, Math.min(1000, parseInt(v) || 199));
            w.callback?.(w.value);
        }
    });
    thresholdInput.style.width = "50px";
    settingsRow.appendChild(thresholdInput);

    // Check Interval
    settingsRow.appendChild(mkLabel("检查间隔ms:"));
    const intervalInput = mkInput("number", getCheckIntervalValue(node), (v) => {
        const w = getWidgetByName(node, "check_interval_ms");
        if (w) {
            w.value = Math.max(100, Math.min(60000, parseInt(v) || 1000));
            w.callback?.(w.value);
        }
    });
    intervalInput.style.width = "60px";
    settingsRow.appendChild(intervalInput);

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
    const queueOneBtn = mkBtn("入队当前");
    const clearBtn = mkBtn("清空");
    
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
    
    queueBtnRow.appendChild(queueBtn);
    queueBtnRow.appendChild(queueOneBtn);
    queueBtnRow.appendChild(clearBtn);

    const info = document.createElement("div");
    info.style.cssText = "font-size:12px;opacity:0.85;margin-bottom:6px;";

    const listContainer = document.createElement("div");
    listContainer.style.cssText =
        "max-height:260px;overflow-y:auto;background:var(--comfy-input-bg);padding:6px;border-radius:4px;";

    let selectedIndex = -1;

    const updateInfo = () => {
        const texts = parseTextList(getTextListWidget(node)?.value);
        const queueCount = getQueueCountValue(node);
        const shuffle = getShuffleValue(node);
        const allowDup = getAllowDuplicateValue(node);
        const sourceMode = getSourceModeValue(node);
        
        let modeText = sourceMode === "files" ? "[文件模式]" : "[直接输入]";
        if (shuffle) modeText += "[乱序]";
        if (!allowDup) modeText += "[不重复]";
        if (queueCount > 0) modeText += `[跑${queueCount}次]`;
        
        info.textContent = `共 ${texts.length} 行 ${modeText}`;
    };

    const redraw = () => {
        const texts = parseTextList(getTextListWidget(node)?.value);
        listContainer.innerHTML = "";

        if (texts.length === 0) {
            const emptyMsg = document.createElement("div");
            const sourceMode = getSourceModeValue(node);
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

    // 根据源模式更新 UI
    const updateUIForSourceMode = () => {
        const sourceMode = getSourceModeValue(node);
        if (sourceMode === "files") {
            fileModeRow.style.display = "flex";
            fileBtnRow.style.display = "flex";
            directBtnRow.style.display = "none";
        } else {
            fileModeRow.style.display = "none";
            fileBtnRow.style.display = "none";
            directBtnRow.style.display = "flex";
        }
        redraw();
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
        redraw();
    });

    container.appendChild(sourceModeRow);
    container.appendChild(fileModeRow);
    container.appendChild(fileBtnRow);
    container.appendChild(settingsRow);
    container.appendChild(directBtnRow);
    container.appendChild(queueBtnRow);
    container.appendChild(info);
    container.appendChild(listContainer);

    // 初始化 UI 状态
    updateUIForSourceMode();

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
                textListWidget.type = "hidden";
                textListWidget.computeSize = () => [0, -4];
            }

            // 隐藏所有 widget，通过 UI 控制
            const hiddenWidgets = ["source_mode", "file_mode", "max_texts", "queue_count", "shuffle", "allow_duplicate", "seed", "trigger", "queue_threshold", "check_interval_ms"];
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
