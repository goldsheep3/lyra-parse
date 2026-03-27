// ==UserScript==
// @name         Lyra Maimai 数据捕获
// @description  用于捕获「电棍」版本的舞萌数据
// @version      0.2.0
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
     * @property {number} achievementRate - 达成率
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
    const CONTAINER_STYLE = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:10000;display:flex;gap:8px;align-items:center;background:rgba(255,255,255,0.95);padding:10px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.15);";
    const MENU_STYLE = "position:absolute;bottom:calc(100% + 10px);right:0;background:rgba(255,255,255,0.95);padding:8px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.15);display:none;flex-direction:column;gap:8px;";
    const LABEL_STYLE = "background:#e84393;color:white;padding:6px 10px;border-radius:8px;font-weight:900;font-size:14px;letter-spacing:1px;user-select:none;";

    const getImgName = (src) => {
        if (!src) return "";
        let name = src.split('/').pop().replace(/\.[^/.]+$/, "");
        name = name.replace('music_icon_', '').replace('music_', '').replace('diff_', '');
        return name === 'standard' ? 'std' : name;
    };

    const getWeight = (type, name) => RANK_WEIGHT[type][name] || 0;

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
                if (!ignoreCache && oldTimesSet.has(raw.play_time)) {
                    hitCachedTime = true;
                    return;
                }
                processedTimes.add(raw.play_time);
            }

            const typeKey = raw.type === 'standard' ? 'std' : raw.type;
            const sheetId = `${raw.title}__dxrt__${typeKey}__dxrt__${raw.diff}`;

            const old = dataMap.get(sheetId) || { achievement: 0, dxscore: 0, combo: "", sync: "", play_time: "" };

            const isAchvBetter = raw.achievement > old.achievement;
            const isDxBetter = (raw.dxscore || 0) > old.dxscore;
            const isComboBetter = getWeight('combo', raw.combo) > getWeight('combo', old.combo);
            const isSyncBetter = getWeight('sync', raw.sync) > getWeight('sync', old.sync);

            if (isAchvBetter || isDxBetter || isComboBetter || isSyncBetter || (isPlaylog && !old.play_time)) {
                const merged = {
                    sheetId: sheetId,
                    achievementRate: Math.max(old.achievement, raw.achievement),
                    title: raw.title,
                    type: typeKey,
                    diff: raw.diff,
                    achievement: Math.max(old.achievement, raw.achievement),
                    dxscore: Math.max(old.dxscore, (raw.dxscore || 0)),
                    combo: isComboBetter ? raw.combo : old.combo,
                    sync: isSyncBetter ? raw.sync : old.sync,
                    play_time: (isPlaylog && raw.play_time) ? raw.play_time : old.play_time
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

    function exportFlatJson() {
        const savedData = GM_getValue("lyra_parse_mai_records", []);
        if (savedData.length === 0) return alert("没有数据可供导出！");
        const blob = new Blob([JSON.stringify(savedData, null, 2)], {type: 'application/json'});
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
            "4. 反爬：若网站提示“读取失败”，脚本会自动保存当页内容并强制中断。"
        );
    }

    // --- 4. UI 初始化 ---
    function createUI() {
        if (document.getElementById('tm-capture-container')) return;

        const container = document.createElement('div');
        container.id = "tm-capture-container";
        container.style = CONTAINER_STYLE; 

        // 游戏标签
        const gameLabel = document.createElement('div');
        gameLabel.innerText = "mai";
        gameLabel.style = LABEL_STYLE;

        // 主按钮区
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

        // 更多菜单
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

        const btnHelp = document.createElement('button');
        btnHelp.innerText = "使用说明";
        btnHelp.style = BASE_BTN_STYLE + "background:#2c3e50;";
        btnHelp.onclick = () => { moreMenu.style.display = 'none'; showInstruction(); };

        const btnClear = document.createElement('button');
        btnClear.id = 'tm-clear-btn';
        btnClear.style = BASE_BTN_STYLE + "background:#c0392b;";
        btnClear.onclick = () => {
            moreMenu.style.display = 'none';
            if(confirm("确定清空本地档案吗？所有数据及时间缓存将被抹除。")) {
                GM_deleteValue("lyra_parse_mai_records");
                GM_deleteValue("lyra_parse_mai_processed_times");
                dataMap.clear();
                processedTimes.clear();
                oldTimesSet.clear();
                updateClearButtonText();
            }
        };

        moreMenu.appendChild(btnForce);
        moreMenu.appendChild(btnHelp);
        moreMenu.appendChild(btnClear);

        // 菜单切换逻辑
        btnMore.onclick = (e) => {
            e.stopPropagation();
            moreMenu.style.display = moreMenu.style.display === 'none' ? 'flex' : 'none';
        };

        // 点击外部关闭菜单
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