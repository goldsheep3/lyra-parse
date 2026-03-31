// ==UserScript==
// @name         Lyra Chunithm 数据捕获
// @description  用于捕获「电棍」版本的中二数据
// @version      0.2.2
// @author       GoldSheep3 with Gemini
// @match        https://*/chunithm/music
// @match        https://*/chunithm/music?*
// @updateURL    https://github.com/goldsheep3/lyra-parse/raw/refs/heads/main/monkey/lyra-chu.user.js
// @downloadURL  https://github.com/goldsheep3/lyra-parse/raw/refs/heads/main/monkey/lyra-chu.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// ==/UserScript==

(function() {
    'use strict';

    /**
     * @typedef {Object} ChuRecordItem
     * @property {string} sheetId - 唯一标识符 (曲名__chu__难度)
     * @property {string} title - 曲目名称
     * @property {string} diff - 难度 (expert, master 等)
     * @property {number} score - 分数
     * @property {string[]} icons - 评级图标集合 (clear, sss+, fc 等)
     * @property {string} play_time - 游玩时间
     */

    /** @type {Map<string, ChuRecordItem>} */
    const dataMap = new Map();

    /** @type {Set<string>} 缓存所有已处理的游玩时间记录 */
    const processedTimes = new Set(GM_getValue("lyra_parse_chu_processed_times", []));

    /** @type {Set<string>} 仅保存本次运行前的历史时间记录，用于判定同步边界 */
    const oldTimesSet = new Set(GM_getValue("lyra_parse_chu_processed_times", []));

    // 运行状态控制变量
    let isImporting = false;
    let stopRequested = false;

    // UI 元素引用
    const uiRefs = {
        btnStop: null,
        btnCatch: null
    };

    const RANK_MAP = {
        "0": "d", "1": "c", "2": "b", "3": "bb", "4": "bbb",
        "5": "a", "6": "aa", "7": "aaa", "8": "s", "9": "s+",
        "10": "ss", "11": "ss+", "12": "sss", "13": "sss+"
    };

    const BASE_BTN_STYLE = "padding:8px 12px;color:white;border:none;border-radius:8px;cursor:pointer;font-weight:bold;font-size:13px;white-space:nowrap;transition:all 0.2s;";
    const CONTAINER_STYLE = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:10000;display:flex;gap:8px;align-items:center;background:rgba(255,255,255,0.95);padding:10px;border:1px solid rgba(0,0,0,0.06);border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.15);";
    const MENU_STYLE = "position:absolute;bottom:calc(100% + 10px);right:0;background:rgba(255,255,255,0.95);padding:8px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.15);display:none;flex-direction:column;gap:8px;min-width:200px;";
    const LABEL_STYLE = "background:#f1c40f;color:#2c3e50;padding:6px 10px;border-radius:8px;font-weight:900;font-size:14px;letter-spacing:1px;user-select:none;";

    const normalizePlayTime = (s) => (s || "").toString().trim().replace(/\s+/g, ' ');

    function refreshOldTimesSetFromProcessedTimes() {
        oldTimesSet.clear();
        for (const t of processedTimes) {
            const nt = normalizePlayTime(t);
            if (nt) oldTimesSet.add(nt);
        }
    }

    /**
     * 清洗图片名称，提取核心标识并映射 Rank
     */
    const getImgName = (src) => {
        if (!src) return "";
        let name = src.split('/').pop().replace(/\.[^/.]+$/, "");
        name = name.replace('music_icon_', '')
            .replace('music_', '')
            .replace('diff_', '')
            .replace('musiclevel_', '')
            .replace('icon_', '');

        const rankMatch = name.match(/^rank_(\d+)$/);
        if (rankMatch) {
            const rankNum = rankMatch[1];
            if (RANK_MAP[rankNum]) return RANK_MAP[rankNum];
        }

        return name;
    };

    const normalizeString = (v) => (typeof v === 'string') ? v.trim() : "";
    const normalizeNumber = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : 0;
    const normalizeIcons = (v) => Array.isArray(v) ? v.map(x => normalizeString(x)).filter(x => x !== "") : [];

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

    function parseSheetId(sheetId) {
        if (!sheetId || typeof sheetId !== 'string') return null;
        const parts = sheetId.split('__chu__');
        if (parts.length !== 2) return null;

        const title = (parts[0] || "").trim();
        const diff = (parts[1] || "").trim();
        if (!title || !diff) return null;

        return { title, diff };
    }

    function normalizeImportedItem(item) {
        if (!item || !item.sheetId || typeof item.sheetId !== 'string') return null;

        const parsed = parseSheetId(item.sheetId);

        const explicitTitle = normalizeString(item.title);
        const explicitDiff = normalizeString(item.diff);

        const score = normalizeNumber(item.score);
        const icons = normalizeIcons(item.icons);
        const play_time = normalizePlayTime(item.play_time);

        const hasUseful =
            score > 0 ||
            icons.length > 0 ||
            play_time !== "" ||
            explicitTitle !== "" ||
            explicitDiff !== "";

        if (!hasUseful) return null;

        return {
            sheetId: item.sheetId,
            title: explicitTitle || (parsed ? parsed.title : ""),
            diff: explicitDiff || (parsed ? parsed.diff : ""),
            score,
            icons,
            play_time
        };
    }

    function mergeRecordIntoMap(incoming) {
        if (!incoming || !incoming.sheetId) return false;

        const sheetId = incoming.sheetId;
        const old = dataMap.get(sheetId) || {
            sheetId,
            title: "",
            diff: "",
            score: 0,
            icons: [],
            play_time: ""
        };

        const incomingScore = normalizeNumber(incoming.score);
        const oldScore = normalizeNumber(old.score);
        const isScoreBetter = incomingScore > oldScore;

        const title = normalizeString(old.title) || normalizeString(incoming.title);
        const diff = normalizeString(old.diff) || normalizeString(incoming.diff);

        const incomingIcons = normalizeIcons(incoming.icons);
        const oldIcons = normalizeIcons(old.icons);
        const shouldUpdateIcons =
            (incomingIcons.length > 0) && (isScoreBetter || oldIcons.length === 0);

        const incomingPlayTime = normalizePlayTime(incoming.play_time);
        const shouldFillPlayTime = (!normalizePlayTime(old.play_time) && incomingPlayTime);

        const shouldUpdate =
            isScoreBetter ||
            (title !== old.title) ||
            (diff !== old.diff) ||
            shouldUpdateIcons ||
            shouldFillPlayTime;

        if (!shouldUpdate) return false;

        const merged = {
            sheetId,
            title,
            diff,
            score: Math.max(oldScore, incomingScore),
            icons: shouldUpdateIcons ? incomingIcons : oldIcons,
            play_time: shouldFillPlayTime ? incomingPlayTime : normalizePlayTime(old.play_time)
        };

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

            const sheetId = `${raw.title}__chu__${raw.diff}`;
            const old = dataMap.get(sheetId) || { sheetId, title: "", diff: "", score: 0, icons: [], play_time: "" };

            const isScoreBetter = raw.score > old.score;

            if (isScoreBetter || (isPlaylog && !old.play_time)) {
                const merged = {
                    sheetId: sheetId,
                    title: raw.title,
                    diff: raw.diff,
                    score: Math.max(old.score, raw.score),
                    icons: isScoreBetter ? raw.icons : old.icons,
                    play_time: (isPlaylog && raw.play_time) ? raw.play_time : old.play_time
                };
                dataMap.set(sheetId, merged);
                updateCount++;
            }
        };

        playlogItems.forEach(node => {
            if (hitCachedTime) return;

            const isPlaylog = !!node.querySelector('.play_datalist_date');
            let raw = null;

            if (isPlaylog) {
                const iconImgs = Array.from(node.querySelectorAll('.play_musicdata_icon img')).map(img => getImgName(img.src));
                const scoreText = node.querySelector('.play_musicdata_score_text')?.innerText || "0";

                raw = {
                    title: node.querySelector('.play_musicdata_title')?.innerText.trim(),
                    diff: getImgName(node.querySelector('.play_track_result img')?.src),
                    score: parseInt(scoreText.replace(/,/g, '')),
                    icons: iconImgs,
                    play_time: node.querySelector('.play_datalist_date')?.innerText.trim()
                };
            } else if (node.querySelector('.music_name_block')) {
                const scoreText = node.querySelector('.music_score_block span')?.innerText || node.querySelector('.music_score_block')?.innerText || "0";
                raw = {
                    title: node.querySelector('.music_name_block')?.innerText.trim(),
                    diff: getImgName(node.querySelector('img[src*="musiclevel_"]')?.src || node.querySelector('img[src*="diff_"]')?.src),
                    score: parseInt(scoreText.replace(/,/g, '')),
                    icons: [],
                    play_time: ""
                };
            }
            if (raw) processItem(raw, isPlaylog);
        });

        tileItems.forEach(node => {
            if (hitCachedTime) return;

            const title = node.querySelector('.title')?.innerText.trim();
            const diffImg = getImgName(node.querySelector('.diff')?.src || node.querySelector('img[src*="musiclevel_"]')?.src);
            const scoreStr = node.querySelector('.row .val')?.innerText || "0";

            const raw = {
                title: title,
                diff: diffImg,
                score: parseInt(scoreStr.replace(/,/g, '')),
                icons: [],
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

        GM_setValue("lyra_parse_chu_records", finalArray);
        GM_setValue("lyra_parse_chu_processed_times", Array.from(processedTimes));
        updateClearButtonText();
        return finalArray.length;
    }

    function finishImport(msgPrefix = "") {
        const totalLen = saveCurrentData();
        isImporting = false;
        updateUIState();
        alert(`[Lyra CHU] ${msgPrefix}\n当前档案共 ${totalLen} 条数据。`);
    }

    // --- 3. 抓取控制逻辑 ---
    async function autoPaginateAndCollect() {
        if (isImporting) return;
        isImporting = true;
        stopRequested = false;
        updateUIState();

        const savedData = GM_getValue("lyra_parse_chu_records", []);
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

        const savedData = GM_getValue("lyra_parse_chu_records", []);
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

    function importJsonFile(mode = 'incremental') {
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

                const savedData = GM_getValue("lyra_parse_chu_records", []);
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
                            diff: normalizeString(incoming.diff),
                            score: normalizeNumber(incoming.score),
                            icons: normalizeIcons(incoming.icons),
                            play_time: normalizePlayTime(incoming.play_time)
                        };
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
        const savedData = GM_getValue("lyra_parse_chu_records", []);
        if (savedData.length === 0) return alert("没有数据可供导出！");

        const normalized = savedData.map(item => ({
            ...item,
            play_time: normalizePlayTime(item.play_time)
        }));

        const blob = new Blob([JSON.stringify(normalized, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `chu_unified_profile_${Date.now()}.json`;
        a.click();
    }

    function updateClearButtonText() {
        const btn = document.getElementById('tm-clear-btn');
        if (btn) {
            const len = GM_getValue("lyra_parse_chu_records", []).length;
            btn.innerText = `清除数据 (${len})`;
        }
    }

    function showInstruction() {
        alert(
            "【Lyra CHU 数据捕获 - 使用说明】\n\n" +
            "1. 同步数据：自动滚动翻页收集游玩记录，遇到历史记录时会自动增量判定并停止。\n" +
            "2. 强制同步：忽略历史时间判定，强制遍历抓取当前页可视的所有数据（不会自动翻页）。\n" +
            "3. 停止：在抓取中途可以随时点击中断，已抓取部分会自动保存。\n" +
            "4. 反爬：若网站提示“读取失败”，脚本会自动保存当页内容并强制中断。\n" +
            "5. 导入：支持“增量导入 JSON”与“覆盖导入 JSON”。导入后会刷新时间缓存用于增量判定。\n"
        );
    }

    function createUI() {
        if (document.getElementById('tm-capture-container')) return;

        const container = document.createElement('div');
        container.id = "tm-capture-container";
        container.style = CONTAINER_STYLE;

        const gameLabel = document.createElement('div');
        gameLabel.innerText = "CHU";
        gameLabel.style = LABEL_STYLE;

        const btnCatch = document.createElement('button');
        btnCatch.innerText = "���步数据";
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
            if (!confirm("确定要覆盖本地 CHU 档案吗？此操作会清空当前缓存，且不可逆。")) return;
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
            if (confirm("确定清空本地 CHU 档案吗？所有数据及时间缓存将被抹除。")) {
                GM_deleteValue("lyra_parse_chu_records");
                GM_deleteValue("lyra_parse_chu_processed_times");
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