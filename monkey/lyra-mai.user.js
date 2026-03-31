// ==UserScript==
// @name         Lyra Maimai 数据捕获
// @description  用于捕获「电棍」版本的舞萌数据
// @version      0.2.2
// @author       GoldSheep3 with Gemini
// @match        https://*/maimai/music
// @match        https://*/maimai/music?*
// @updateURL    https://github.com/goldsheep3/lyra-parse/raw/refs/heads/main/monkey/lyra-mai.user.js
// @downloadURL  https://github.com/goldsheep3/lyra-parse/raw/refs/heads/main/monkey/lyra-mai.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// ==/UserScript==

(function() {
    'use strict';

    /**
     * @typedef {Object} RecordItem
     * @property {string} sheetId - 唯一标识符
     * @property {number} achievementRate - 达成率（与 achievement 同义，导出时保持一致）
     * @property {string} title - 曲目名称
     * @property {string} type - 谱面类型 (std / dx 等)
     * @property {string} diff - 难度
     * @property {number} achievement - 达成率
     * @property {number} dxscore - DX 分数
     * @property {string} combo - 连击评级 (fc, ap 等)
     * @property {string} sync - 同步评级 (fs, fdx 等)
     * @property {string} play_time - 游玩时间
     */

    /** @type {Map<string, RecordItem>} */
    const dataMap = new Map();

    /** @type {Set<string>} 缓存所有已处理的游玩时间记录 */
    const processedTimes = new Set(GM_getValue("lyra_parse_mai_processed_times", []));

    /** @type {Set<string>} 仅保存本次运行前的历史时间记录，用于判定同步边界 */
    const oldTimesSet = new Set(GM_getValue("lyra_parse_mai_processed_times", []));

    // 运行状态控制变量
    let isImporting = false;
    let stopRequested = false;

    // UI 元素引用
    const uiRefs = {
        btnStop: null,
        btnCatch: null
    };

    const RANK_WEIGHT = {
        combo: { "fc": 1, "fcp": 2, "ap": 3, "app": 4 },
        sync: { "fs": 1, "fsp": 2, "fdx": 3, "fdxp": 4 }
    };

    const BASE_BTN_STYLE = "padding:8px 12px;color:white;border:none;border-radius:8px;cursor:pointer;font-weight:bold;font-size:13px;white-space:nowrap;transition:all 0.2s;";
    const CONTAINER_STYLE = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:10000;display:flex;gap:8px;align-items:center;background:rgba(255,255,255,0.95);padding:10px;border:1px solid rgba(0,0,0,0.06);border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.15);";
    const MENU_STYLE = "position:absolute;bottom:calc(100% + 10px);right:0;background:rgba(255,255,255,0.95);padding:8px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.15);display:none;flex-direction:column;gap:8px;min-width:200px;";
    const LABEL_STYLE = "background:#e84393;color:white;padding:6px 10px;border-radius:8px;font-weight:900;font-size:14px;letter-spacing:1px;user-select:none;";

    const normalizePlayTime = (s) => (s || "").toString().trim().replace(/\s+/g, ' ');

    function refreshOldTimesSetFromProcessedTimes() {
        oldTimesSet.clear();
        for (const t of processedTimes) {
            const nt = normalizePlayTime(t);
            if (nt) oldTimesSet.add(nt);
        }
    }

    const getImgName = (src) => {
        if (!src) return "";
        let name = src.split('/').pop().replace(/\.[^/.]+$/, "");
        name = name.replace('music_icon_', '').replace('music_', '').replace('diff_', '');
        return name === 'standard' ? 'std' : name;
    };

    const getWeight = (type, name) => {
        if (!name) return 0;
        return RANK_WEIGHT[type][name] || 0;
    };

    const parseTime = (timeStr) => {
        if (!timeStr) return 0;
        return new Date(timeStr).getTime() || 0;
    };

    const hasAntiCrawlerWarning = () => {
        const messages = document.querySelectorAll('.n-message__content');
        for (let i = 0; i < messages.length; i++) {
            if (messages[i].innerText.includes('读取游玩记录失败')) {
                return true;
            }
        }
        return false;
    };

    const updateUIState = () => {
        if (uiRefs.btnStop) {
            uiRefs.btnStop.style.display = isImporting ? 'block' : 'none';
        }
        if (uiRefs.btnCatch) {
            uiRefs.btnCatch.style.opacity = isImporting ? '0.6' : '1';
            uiRefs.btnCatch.disabled = isImporting;
        }
    };

    // =============== 导入兼容：sheetId 解析（仅缺失补齐） ===============
    function parseSheetId(sheetId) {
        // 当前脚本生成规则：`${title}__dxrt__${typeKey}__dxrt__${diff}`
        if (!sheetId || typeof sheetId !== 'string') return null;
        const parts = sheetId.split('__dxrt__');
        if (parts.length !== 3) return null;

        const title = (parts[0] || "").trim();
        const type = (parts[1] || "").trim();
        const diff = (parts[2] || "").trim();

        if (!title || !type || !diff) return null;
        return { title, type, diff };
    }

    const normalizeString = (v) => (typeof v === 'string') ? v.trim() : "";
    const normalizeNumber = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : 0;

    /**
     * 将导入条目标准化为 RecordItem（可能部分字段为空）。
     * 规则：
     * - achievementRate 与 achievement 同义
     * - title/type/diff：优先使用 item 自带字段；若缺失再尝试从 sheetId 解析（仅用于“补齐候选”）
     * - 如果除了 sheetId 外完全没有任何可用字段，则返回 null（跳过）
     */
    function normalizeImportedItem(item) {
        if (!item || !item.sheetId || typeof item.sheetId !== 'string') return null;

        const parsed = parseSheetId(item.sheetId);

        const explicitTitle = normalizeString(item.title);
        const explicitType = normalizeString(item.type);
        const explicitDiff = normalizeString(item.diff);

        // 兼容：achievementRate == achievement
        const achievement = (typeof item.achievement === 'number')
            ? normalizeNumber(item.achievement)
            : normalizeNumber(item.achievementRate);

        const dxscore = normalizeNumber(item.dxscore);
        const combo = normalizeString(item.combo);
        const sync = normalizeString(item.sync);
        const play_time = normalizePlayTime(item.play_time);

        // “候选补齐”字段
        const fallbackTitle = parsed ? parsed.title : "";
        const fallbackType = parsed ? parsed.type : "";
        const fallbackDiff = parsed ? parsed.diff : "";

        const hasUseful =
            achievement > 0 ||
            dxscore > 0 ||
            combo !== "" ||
            sync !== "" ||
            play_time !== "" ||
            explicitTitle !== "" ||
            explicitType !== "" ||
            explicitDiff !== "";

        if (!hasUseful) return null;

        return {
            sheetId: item.sheetId,
            achievementRate: achievement,
            title: explicitTitle || fallbackTitle,
            type: explicitType || fallbackType,
            diff: explicitDiff || fallbackDiff,
            achievement: achievement,
            dxscore: dxscore,
            combo: combo,
            sync: sync,
            play_time: play_time
        };
    }

    // =============== 合并逻辑：更优覆盖 + 仅缺失补齐 ===============
    function mergeRecordIntoMap(incoming) {
        if (!incoming || !incoming.sheetId) return false;

        const sheetId = incoming.sheetId;
        const old = dataMap.get(sheetId) || {
            sheetId,
            achievementRate: 0,
            title: "",
            type: "",
            diff: "",
            achievement: 0,
            dxscore: 0,
            combo: "",
            sync: "",
            play_time: ""
        };

        const incomingAchv = normalizeNumber(incoming.achievement);
        const incomingDx = normalizeNumber(incoming.dxscore);

        const isAchvBetter = incomingAchv > normalizeNumber(old.achievement);
        const isDxBetter = incomingDx > normalizeNumber(old.dxscore);

        const incomingComboWeight = getWeight('combo', incoming.combo);
        const oldComboWeight = getWeight('combo', old.combo);
        const isComboBetter = incomingComboWeight > oldComboWeight;

        const incomingSyncWeight = getWeight('sync', incoming.sync);
        const oldSyncWeight = getWeight('sync', old.sync);
        const isSyncBetter = incomingSyncWeight > oldSyncWeight;

        const shouldFillPlayTime = (!normalizePlayTime(old.play_time) && normalizePlayTime(incoming.play_time));

        // 仅缺失补齐
        const title = normalizeString(old.title) || normalizeString(incoming.title);
        const type = normalizeString(old.type) || normalizeString(incoming.type);
        const diff = normalizeString(old.diff) || normalizeString(incoming.diff);

        const shouldUpdate =
            isAchvBetter ||
            isDxBetter ||
            (normalizeString(incoming.combo) !== "" && isComboBetter) ||
            (normalizeString(incoming.sync) !== "" && isSyncBetter) ||
            shouldFillPlayTime ||
            (title !== old.title) ||
            (type !== old.type) ||
            (diff !== old.diff);

        if (!shouldUpdate) return false;

        const merged = {
            sheetId,
            title,
            type,
            diff,
            achievement: Math.max(normalizeNumber(old.achievement), incomingAchv),
            dxscore: Math.max(normalizeNumber(old.dxscore), incomingDx),
            combo: (normalizeString(incoming.combo) !== "" && isComboBetter) ? incoming.combo : normalizeString(old.combo),
            sync: (normalizeString(incoming.sync) !== "" && isSyncBetter) ? incoming.sync : normalizeString(old.sync),
            play_time: shouldFillPlayTime ? incoming.play_time : normalizePlayTime(old.play_time)
        };
        merged.achievementRate = merged.achievement;

        dataMap.set(sheetId, merged);
        return true;
    }

    // --- 1. 核心捕获逻辑 ---
    function captureCurrentVisibleItems(ignoreCache = false) {
        const playlogItems = document.querySelectorAll('.n-list-item');
        const tileItems = document.querySelectorAll('.tile');
        let updateCount = 0;
        let hitCachedTime = false;

        const processItem = (raw, isPlaylog) => {
            if (hitCachedTime) return;
            if (!raw || !raw.title) return;

            if (isPlaylog && raw.play_time) {
                const npt = normalizePlayTime(raw.play_time);
                if (!ignoreCache && npt && oldTimesSet.has(npt)) {
                    hitCachedTime = true;
                    return;
                }
                if (npt) processedTimes.add(npt);
                raw.play_time = npt;
            }

            const typeKey = raw.type === 'standard' ? 'std' : raw.type;
            const sheetId = `${raw.title}__dxrt__${typeKey}__dxrt__${raw.diff}`;

            const old = dataMap.get(sheetId) || { achievement: 0, dxscore: 0, combo: "", sync: "", play_time: "", title: "", type: "", diff: "" };

            const isAchvBetter = raw.achievement > old.achievement;
            const isDxBetter = (raw.dxscore || 0) > old.dxscore;
            const isComboBetter = getWeight('combo', raw.combo) > getWeight('combo', old.combo);
            const isSyncBetter = getWeight('sync', raw.sync) > getWeight('sync', old.sync);

            if (isAchvBetter || isDxBetter || isComboBetter || isSyncBetter || (isPlaylog && !old.play_time)) {
                const merged = {
                    sheetId: sheetId,
                    achievementRate: Math.max(old.achievement || 0, raw.achievement || 0),
                    title: raw.title,
                    type: typeKey,
                    diff: raw.diff,
                    achievement: Math.max(old.achievement || 0, raw.achievement || 0),
                    dxscore: Math.max(old.dxscore || 0, (raw.dxscore || 0)),
                    combo: isComboBetter ? raw.combo : (old.combo || ""),
                    sync: isSyncBetter ? raw.sync : (old.sync || ""),
                    play_time: (isPlaylog && raw.play_time) ? raw.play_time : (old.play_time || "")
                };
                dataMap.set(sheetId, merged);
                updateCount++;
            }
        };

        playlogItems.forEach(node => {
            if (hitCachedTime) return;

            const isPlaylog = !!node.querySelector('.mai-music-box');
            let raw = null;
            if (isPlaylog) {
                const badgeImgs = Array.from(node.querySelectorAll('.playlog_score'));
                raw = {
                    title: node.querySelector('.mai-music-title span')?.innerText.trim(),
                    type: getImgName(node.querySelector('.playlog_music_kind_icon')?.src),
                    diff: getImgName(node.querySelector('#diff_and_date img')?.src),
                    achievement: parseFloat(node.querySelector('.mai-music-info_achievement_score span')?.innerText.replace(/[^\d.]/g, '')),
                    dxscore: parseInt(node.querySelector('.score')?.innerText.split('/')[0].trim()) || 0,
                    combo: getImgName(badgeImgs[0]?.src),
                    sync: getImgName(badgeImgs[1]?.src),
                    play_time: node.querySelector('.sub_title span:last-child')?.innerText.trim()
                };
            } else if (node.querySelector('.music_name_block')) {
                const rateImgs = Array.from(node.querySelectorAll('.music_rate_block img'));
                raw = {
                    title: node.querySelector('.music_name_block').innerText.trim(),
                    type: getImgName(node.querySelector('.music_kind_icon')?.src),
                    diff: getImgName(node.querySelector('img[src*="diff_"]')?.src),
                    achievement: parseFloat(node.querySelector('.music_score_block')?.innerText.replace(/[^\d.]/g, '')),
                    dxscore: parseInt(node.querySelector('.music_score_block span')?.innerText.trim()) || 0,
                    combo: getImgName(rateImgs[1]?.src),
                    sync: getImgName(rateImgs[2]?.src),
                    play_time: ""
                };
            }
            if (raw) processItem(raw, isPlaylog);
        });

        tileItems.forEach(node => {
            if (hitCachedTime) return;

            const title = node.querySelector('.title')?.innerText.trim();
            const typeImg = getImgName(node.querySelector('.kind')?.src);
            const diffImg = getImgName(node.querySelector('.diff')?.src);
            const achvStr = node.querySelector('.row .val')?.innerText || "0";
            const comboImg = node.querySelector('.badges img[alt="combo"]')?.src;
            const syncImg = node.querySelector('.badges img[alt="sync"]')?.src;

            const raw = {
                title: title,
                type: typeImg,
                diff: diffImg,
                achievement: parseFloat(achvStr.replace(/[^\d.]/g, '')),
                dxscore: 0,
                combo: getImgName(comboImg),
                sync: getImgName(syncImg),
                play_time: ""
            };
            processItem(raw, false);
        });

        updateClearButtonText();
        return { updateCount, hitCachedTime };
    }

    // --- 2. 持久化辅助逻辑 ---
    function saveCurrentData() {
        const finalArray = Array.from(dataMap.values());
        finalArray.sort((a, b) => parseTime(b.play_time) - parseTime(a.play_time));

        GM_setValue("lyra_parse_mai_records", finalArray);
        GM_setValue("lyra_parse_mai_processed_times", Array.from(processedTimes));
        updateClearButtonText();
        return finalArray.length;
    }

    function finishImport(msgPrefix = "") {
        const totalLen = saveCurrentData();
        isImporting = false;
        updateUIState();
        alert(`${msgPrefix}\n当前档案共 ${totalLen} 条数据。`);
    }

    // --- 3. 抓取控制逻辑 ---
    async function autoPaginateAndCollect() {
        if (isImporting) return;
        isImporting = true;
        stopRequested = false;
        updateUIState();

        const savedData = GM_getValue("lyra_parse_mai_records", []);
        savedData.forEach(item => dataMap.set(item.sheetId, item));

        let hasNextPage = true;
        let shouldStopOverall = false;
        let antiCrawlerTriggered = false;
        let pageCount = 0;

        while (hasNextPage && !shouldStopOverall && !stopRequested && !antiCrawlerTriggered) {
            pageCount++;
            window.scrollTo(0, 0);
            await new Promise(r => setTimeout(r, 500));

            let lastHeight = 0, sameHeightCount = 0;

            while (sameHeightCount < 3) {
                if (stopRequested) break;

                if (hasAntiCrawlerWarning()) {
                    antiCrawlerTriggered = true;
                    break;
                }

                const { hitCachedTime } = captureCurrentVisibleItems(false);
                if (hitCachedTime) {
                    shouldStopOverall = true;
                    break;
                }

                window.scrollBy(0, 3000);
                await new Promise(r => setTimeout(r, 300));

                let currentHeight = document.documentElement.scrollHeight;
                if (currentHeight === lastHeight) sameHeightCount++;
                else { lastHeight = currentHeight; sameHeightCount = 0; }
            }

            saveCurrentData();

            if (shouldStopOverall || stopRequested || antiCrawlerTriggered) break;

            const pageButtons = document.querySelectorAll('.n-pagination-item--button');
            if (pageButtons.length > 0) {
                const nextBtn = pageButtons[pageButtons.length - 1];
                const isDisabled = nextBtn.classList.contains('n-pagination-item--disabled') || nextBtn.hasAttribute('disabled');

                if (isDisabled) {
                    hasNextPage = false;
                } else {
                    nextBtn.click();
                    await new Promise(r => setTimeout(r, 2500));
                }
            } else {
                hasNextPage = false;
            }
        }

        let prefix = `同步结束（查阅了 ${pageCount} 页）。`;
        if (antiCrawlerTriggered) prefix = `检测到反爬限制，已强制终止提取（查阅了 ${pageCount} 页）。`;
        else if (stopRequested) prefix = `已手动停止导入（查阅了 ${pageCount} 页）。`;
        else if (shouldStopOverall) prefix = `触发增量同步！已自动停止（查阅了 ${pageCount} 页）。`;

        finishImport(prefix);
    }

    async function forceImportCurrentPage() {
        if (isImporting) return;
        isImporting = true;
        stopRequested = false;
        updateUIState();

        let antiCrawlerTriggered = false;

        const savedData = GM_getValue("lyra_parse_mai_records", []);
        savedData.forEach(item => dataMap.set(item.sheetId, item));

        window.scrollTo(0, 0);
        await new Promise(r => setTimeout(r, 500));

        let lastHeight = 0, sameHeightCount = 0;

        while (sameHeightCount < 3) {
            if (stopRequested) break;

            if (hasAntiCrawlerWarning()) {
                antiCrawlerTriggered = true;
                break;
            }

            captureCurrentVisibleItems(true);

            window.scrollBy(0, 3000);
            await new Promise(r => setTimeout(r, 300));

            let currentHeight = document.documentElement.scrollHeight;
            if (currentHeight === lastHeight) sameHeightCount++;
            else { lastHeight = currentHeight; sameHeightCount = 0; }
        }

        saveCurrentData();

        let prefix = "强制导入本页完成。";
        if (antiCrawlerTriggered) prefix = "检测到反爬限制，已强制终止。";
        else if (stopRequested) prefix = "已中断强制导入。";

        finishImport(prefix);
    }

    // =============== 导入 / 覆盖导入 ===============
    function importJsonFile(mode = 'incremental') {
        // mode: 'incremental' | 'overwrite'
        if (isImporting) return;

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json';
        input.style.display = 'none';
        document.body.appendChild(input);

        input.onchange = async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) {
                document.body.removeChild(input);
                return;
            }

            try {
                const text = await file.text();
                const parsed = JSON.parse(text);
                if (!Array.isArray(parsed)) {
                    alert("导入失败：JSON 必须为数组格式。");
                    return;
                }

                const savedData = GM_getValue("lyra_parse_mai_records", []);
                savedData.forEach(item => dataMap.set(item.sheetId, item));

                let imported = 0;
                let updated = 0;
                let skipped = 0;

                if (mode === 'overwrite') {
                    dataMap.clear();
                    processedTimes.clear();
                    oldTimesSet.clear();
                }

                for (const rawItem of parsed) {
                    const incoming = normalizeImportedItem(rawItem);
                    if (!incoming) {
                        skipped++;
                        continue;
                    }

                    imported++;

                    if (mode === 'overwrite') {
                        const rec = {
                            sheetId: incoming.sheetId,
                            title: normalizeString(incoming.title),
                            type: normalizeString(incoming.type),
                            diff: normalizeString(incoming.diff),
                            achievement: normalizeNumber(incoming.achievement),
                            dxscore: normalizeNumber(incoming.dxscore),
                            combo: normalizeString(incoming.combo),
                            sync: normalizeString(incoming.sync),
                            play_time: normalizePlayTime(incoming.play_time)
                        };
                        rec.achievementRate = rec.achievement;

                        dataMap.set(rec.sheetId, rec);
                        if (rec.play_time) processedTimes.add(rec.play_time);
                        updated++;
                        continue;
                    }

                    const changed = mergeRecordIntoMap(incoming);
                    if (incoming.play_time) processedTimes.add(incoming.play_time);
                    if (changed) updated++;
                }

                saveCurrentData();

                // 关键修复：导入后刷新 oldTimesSet（保证同一次会话里立刻生效）
                refreshOldTimesSetFromProcessedTimes();

                const modeText = (mode === 'overwrite') ? "覆盖导入" : "增量导入";
                alert(`${modeText}完成：读入 ${imported} 条，合并/写入 ${updated} 条，跳过 ${skipped} 条（信息不足/格式不符）。`);
            } catch (err) {
                console.error(err);
                alert("导入失败：读取或解析文件时出错，请确认为合法 JSON 文件。");
            } finally {
                document.body.removeChild(input);
            }
        };

        input.click();
    }

    function exportFlatJson() {
        const savedData = GM_getValue("lyra_parse_mai_records", []);
        if (savedData.length === 0) return alert("没有数据可供导出！");

        const normalized = savedData.map(item => {
            const achv = normalizeNumber(item.achievement);
            return {
                ...item,
                achievement: achv,
                achievementRate: achv,
                play_time: normalizePlayTime(item.play_time)
            };
        });

        const blob = new Blob([JSON.stringify(normalized, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `maimai_unified_profile_${Date.now()}.json`;
        a.click();
    }

    function updateClearButtonText() {
        const btn = document.getElementById('tm-clear-btn');
        if (btn) {
            const len = GM_getValue("lyra_parse_mai_records", []).length;
            btn.innerText = `清除数据 (${len})`;
        }
    }

    function showInstruction() {
        alert(
            "【Lyra Maimai 数据捕获 - 使用说明】\n\n" +
            "1. 同步数据：自动滚动翻页收集游玩记录，遇到历史记录时会自动增量判定并停止。\n" +
            "2. 强制同步：忽略历史时间判定，强制遍历抓取当前页可视的所有数据（不会自动翻页）。\n" +
            "3. 停止：在抓取中途可以随时点击中断，已抓取部分会自动保存。\n" +
            "4. 反爬：若网站提示“读取失败”，脚本会自动保存当页内容并强制中断。\n" +
            "5. 导入：支持“增量导入 JSON”（更优合并）与“覆盖导入 JSON”（清空后写入）。\n" +
            "   - achievementRate 与 achievement 视为同义。\n" +
            "   - sheetId 解析仅用于 title/type/diff 的缺失补齐，不会覆盖已有字段。\n"
        );
    }

    // --- 4. UI 初始化 ---
    function createUI() {
        if (document.getElementById('tm-capture-container')) return;

        const container = document.createElement('div');
        container.id = "tm-capture-container";
        container.style = CONTAINER_STYLE;

        const gameLabel = document.createElement('div');
        gameLabel.innerText = "mai";
        gameLabel.style = LABEL_STYLE;

        const btnCatch = document.createElement('button');
        btnCatch.innerText = "同步数据";
        btnCatch.style = BASE_BTN_STYLE + "background:#00b8a9;";
        btnCatch.onclick = autoPaginateAndCollect;
        uiRefs.btnCatch = btnCatch;

        const btnExport = document.createElement('button');
        btnExport.innerText = "导出数据";
        btnExport.style = BASE_BTN_STYLE + "background:#3775de;";
        btnExport.onclick = exportFlatJson;

        const btnStop = document.createElement('button');
        btnStop.innerText = "停止";
        btnStop.style = BASE_BTN_STYLE + "background:#e74c3c; display:none;";
        btnStop.onclick = () => { if (isImporting) stopRequested = true; };
        uiRefs.btnStop = btnStop;

        const moreWrapper = document.createElement('div');
        moreWrapper.style = "position:relative;";

        const btnMore = document.createElement('button');
        btnMore.innerText = "更多";
        btnMore.style = BASE_BTN_STYLE + "background:#7f8c8d;";

        const moreMenu = document.createElement('div');
        moreMenu.style = MENU_STYLE;

        const btnForce = document.createElement('button');
        btnForce.innerText = "强制同步该页面";
        btnForce.style = BASE_BTN_STYLE + "background:#f39c12;";
        btnForce.onclick = () => { moreMenu.style.display = 'none'; forceImportCurrentPage(); };

        const btnImportInc = document.createElement('button');
        btnImportInc.innerText = "增量导入 JSON";
        btnImportInc.style = BASE_BTN_STYLE + "background:#16a085;";
        btnImportInc.onclick = () => { moreMenu.style.display = 'none'; importJsonFile('incremental'); };

        const btnImportOvr = document.createElement('button');
        btnImportOvr.innerText = "覆盖导入 JSON";
        btnImportOvr.style = BASE_BTN_STYLE + "background:#d35400;";
        btnImportOvr.onclick = () => {
            moreMenu.style.display = 'none';
            if (!confirm("确定要覆盖本地档案吗？此操作会清空当前缓存，且不可逆。")) return;
            importJsonFile('overwrite');
        };

        const btnHelp = document.createElement('button');
        btnHelp.innerText = "使用说明";
        btnHelp.style = BASE_BTN_STYLE + "background:#2c3e50;";
        btnHelp.onclick = () => { moreMenu.style.display = 'none'; showInstruction(); };

        const btnClear = document.createElement('button');
        btnClear.id = 'tm-clear-btn';
        btnClear.style = BASE_BTN_STYLE + "background:#c0392b;";
        btnClear.onclick = () => {
            moreMenu.style.display = 'none';
            if (confirm("确定清空本地档案吗？所有数据及时间缓存将被抹除。")) {
                GM_deleteValue("lyra_parse_mai_records");
                GM_deleteValue("lyra_parse_mai_processed_times");
                dataMap.clear();
                processedTimes.clear();
                oldTimesSet.clear();
                updateClearButtonText();
            }
        };

        moreMenu.appendChild(btnForce);
        moreMenu.appendChild(btnImportInc);
        moreMenu.appendChild(btnImportOvr);
        moreMenu.appendChild(btnHelp);
        moreMenu.appendChild(btnClear);

        btnMore.onclick = (e) => {
            e.stopPropagation();
            moreMenu.style.display = (moreMenu.style.display === 'none' || moreMenu.style.display === '') ? 'flex' : 'none';
        };

        document.addEventListener('click', () => {
            moreMenu.style.display = 'none';
        });

        moreWrapper.appendChild(btnMore);
        moreWrapper.appendChild(moreMenu);

        container.appendChild(gameLabel);
        container.appendChild(btnCatch);
        container.appendChild(btnExport);
        container.appendChild(btnStop);
        container.appendChild(moreWrapper);
        document.body.appendChild(container);

        updateClearButtonText();
    }

    setTimeout(createUI, 1000);
})();