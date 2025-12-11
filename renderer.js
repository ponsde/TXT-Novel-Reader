
// 简单的 IndexedDB 封装，用于 Web 模式下的缓存
class SimpleDB {
    constructor(dbName, storeName) {
        this.dbName = dbName;
        this.storeName = storeName;
        this.db = null;
        this.openPromise = null;
    }

    async open() {
        if (this.db) return this.db;
        if (this.openPromise) return this.openPromise;

        this.openPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 2); // 升级版本号以确保 store 创建
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName);
                }
            };
            request.onsuccess = (event) => {
                this.db = event.target.result;
                this.openPromise = null;
                resolve(this.db);
            };
            request.onerror = (event) => {
                this.openPromise = null;
                reject(event.target.error);
            };
        });
        return this.openPromise;
    }

    async get(key) {
        try {
            await this.open();
            return new Promise((resolve, reject) => {
                const transaction = this.db.transaction([this.storeName], 'readonly');
                const store = transaction.objectStore(this.storeName);
                const request = store.get(key);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        } catch (e) {
            console.error('SimpleDB Get Error:', e);
            return null;
        }
    }

    async set(key, value) {
        try {
            await this.open();
            return new Promise((resolve, reject) => {
                const transaction = this.db.transaction([this.storeName], 'readwrite');
                const store = transaction.objectStore(this.storeName);
                const request = store.put(value, key);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        } catch (e) {
            console.error('SimpleDB Set Error:', e);
            throw e;
        }
    }

    async clear() {
        await this.open();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
}

const webBookCache = new SimpleDB('BookCacheDB', 'chapters');

// 安全地引入 Electron
let ipcRenderer;
let pathModule;
let isWebMode = false;
try {
    const electron = require('electron');
    ipcRenderer = electron.ipcRenderer;
    pathModule = require('path');
    console.log('Electron 成功加载');
} catch (error) {
    console.log('Electron 加载失败，切换到 Web 模式');
    isWebMode = true;
    // Web 模式下的 ipcRenderer 模拟
    ipcRenderer = {
        invoke: async (channel, ...args) => {
            console.log(`[Web API] 调用: ${channel}`, args);
            try {
                // 针对 read-file 使用优化的流式接口
                if (channel === 'read-file') {
                    const response = await fetch('/api/raw-read', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ filePath: args[0] })
                    });

                    if (!response.ok) {
                        throw new Error(`HTTP error! status: ${response.status}`);
                    }

                    const arrayBuffer = await response.arrayBuffer();
                    return new Uint8Array(arrayBuffer);
                }

                // Web 模式下的缓存检查
                if (channel === 'check-book-cache') {
                    const filePath = args[0];
                    // 1. 获取服务器文件状态
                    const statResponse = await fetch('/api/invoke', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ channel: 'get-file-stat', args: [filePath] })
                    });
                    const statResult = await statResponse.json();
                    const stats = statResult.data;

                    if (!stats) {
                        console.warn('无法获取文件状态，跳过缓存检查:', filePath);
                        return null;
                    }

                    // 2. 生成缓存键 (filePath + size + mtime)
                    const cacheKey = `${filePath}-${stats.size}-${stats.mtime}`;
                    console.log('检查缓存 Key:', cacheKey);

                    // 3. 检查 IndexedDB
                    try {
                        const cachedData = await webBookCache.get(cacheKey);
                        if (cachedData) {
                            console.log('Web 缓存命中!');
                        } else {
                            console.log('Web 缓存未命中');
                        }
                        return cachedData || null;
                    } catch (e) {
                        console.error('读取 Web 缓存失败:', e);
                        return null;
                    }
                }

                // Web 模式下的缓存保存
                if (channel === 'save-book-cache') {
                    const filePath = args[0];
                    const data = args[1];

                    // 1. 获取服务器文件状态
                    const statResponse = await fetch('/api/invoke', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ channel: 'get-file-stat', args: [filePath] })
                    });
                    const statResult = await statResponse.json();
                    const stats = statResult.data;

                    if (!stats) {
                        console.error('保存缓存失败: 无法获取文件状态', filePath);
                        return false;
                    }

                    // 2. 生成缓存键
                    const cacheKey = `${filePath}-${stats.size}-${stats.mtime}`;
                    console.log('保存缓存 Key:', cacheKey);

                    // 3. 保存到 IndexedDB
                    try {
                        await webBookCache.set(cacheKey, data);
                        console.log('Web 缓存保存成功');
                        return true;
                    } catch (e) {
                        console.error('保存 Web 缓存失败:', e);
                        return false;
                    }
                }

                const response = await fetch('/api/invoke', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ channel, args })
                });

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                const result = await response.json();
                if (result.error) {
                    throw new Error(result.error);
                }

                // 特殊处理 Buffer 数据
                if (result.data && result.data.type === 'Buffer' && Array.isArray(result.data.data)) {
                    return Uint8Array.from(result.data.data);
                }

                return result.data;
            } catch (e) {
                console.error(`[Web API] 调用失败: ${channel}`, e);
                if (channel === 'select-directory') {
                    // Web 模式下返回 null，由调用方处理
                    return null;
                }
                throw e;
            }
        },
        on: () => { },
        removeListener: () => { }
    };
}



let currentContent = [];
let currentPage = 0;
let currentFileName = '';
let chapters = [];
let currentChapter = 0;
let fontSize = 18; // 阅读内容的字体大小
let homePageFontSize = 16; // 主页字体大小
let baseDir = ''; // 随机阅读的路径
let searchDirs = []; // 历史记录搜索路径列表
let wordsPerPage = 4000;
// 全局预览模式标志
window.isPreviewMode = false;

// 多配置文件支持
// 强制默认启动为普通模式
let currentProfile = 'default';
localStorage.setItem('currentProfile', 'default');

function getStorageKey(key) {
    if (currentProfile === 'default') return key;
    return `${key}_${currentProfile}`;
}

function toggleProfile() {
    const newProfile = currentProfile === 'default' ? 'hidden' : 'default';
    currentProfile = newProfile;
    localStorage.setItem('currentProfile', currentProfile);

    showNotification(currentProfile === 'hidden' ? '已切换到隐私模式' : '已切换到普通模式');

    // 重新加载应用状态
    // 1. 清空当前显示
    document.getElementById('content').style.display = 'none';
    document.getElementById('book-title').textContent = '优雅阅读器';
    const mobileTitle = document.getElementById('mobile-book-title');
    if (mobileTitle) mobileTitle.textContent = '优雅阅读器';
    currentFileName = '';
    chapters = [];
    currentContent = [];

    // 2. 重新加载历史记录
    updateHistoryDisplay();

    // 3. 尝试加载上次阅读的书籍
    loadLastRead();

    // 4. 重新同步云端历史
    syncCloudHistory();
}

function loadLastRead() {
    const historyKey = getStorageKey('readingHistory');
    const history = JSON.parse(localStorage.getItem(historyKey)) || [];

    // 无论是否有历史记录，都更新显示
    updateHistoryDisplay();

    if (history.length > 0) {
        const lastBook = history[0];
        if (lastBook.filePath) {
            // 询问用户是否继续阅读？或者直接加载？
            // 为了体验流畅，直接加载，但如果是大文件可能会慢
            // 这里我们只显示在列表中，不自动打开，以免用户想看别的
            // 但用户要求"切换界面"，通常期望看到上次的内容
            // 让我们尝试加载
            // loadAndRenderBook(lastBook.filePath, lastBook.fileName);
            // 考虑到性能，还是只停留在主页比较好，用户可以点击历史记录
        }
    }
}

// 同步云端历史记录
function syncCloudHistory() {
    ipcRenderer.invoke('load-history', currentProfile).then(cloudHistory => {
        if (cloudHistory && Array.isArray(cloudHistory)) {
            const localKey = getStorageKey('readingHistory');
            let localHistory = JSON.parse(localStorage.getItem(localKey)) || [];

            // 加载已删除记录
            ipcRenderer.invoke('load-deleted-history', currentProfile).then(deletedHistory => {
                const deletedSet = new Set(deletedHistory || []);

                // 合并策略：
                // 1. 过滤掉已删除的
                // 2. 以时间戳为准合并

                const historyMap = new Map();

                // 处理本地记录
                localHistory.forEach(item => {
                    if (!deletedSet.has(item.fileName)) {
                        historyMap.set(item.fileName, item);
                    }
                });

                // 处理云端记录
                cloudHistory.forEach(item => {
                    if (!deletedSet.has(item.fileName)) {
                        const existing = historyMap.get(item.fileName);
                        if (!existing || (item.timestamp > existing.timestamp)) {
                            historyMap.set(item.fileName, item);
                        }
                    }
                });

                // 转回数组并按时间排序
                const mergedHistory = Array.from(historyMap.values())
                    .sort((a, b) => b.timestamp - a.timestamp);

                localStorage.setItem(localKey, JSON.stringify(mergedHistory));
                updateHistoryDisplay();
            });
        }
    }).catch(err => console.error('加载云端历史记录失败:', err));
}

document.getElementById('file-input').addEventListener('change', async function (e) {
    // 立即显示加载遮罩
    document.getElementById('loading-overlay').style.display = 'flex';
    document.querySelector('.loading-message').textContent = '准备加载文件...';

    // 给UI一点渲染时间
    await new Promise(resolve => requestAnimationFrame(resolve));

    const file = e.target.files[0];
    if (!file) {
        document.getElementById('loading-overlay').style.display = 'none';
        return;
    }

    // 如果当前已经打开了该文件，则不重新加载
    if (currentFileName === file.name) {
        document.getElementById('loading-overlay').style.display = 'none';
        showNotification('该书籍已打开');
        e.target.value = ''; // 重置 input
        return;
    }

    // 自动添加文件所在目录到搜索路径
    if (file.path && pathModule) {
        try {
            const fileDir = pathModule.dirname(file.path);
            // 检查是否已经在搜索路径中
            if (!searchDirs.includes(fileDir)) {
                searchDirs.push(fileDir);

                // 保存配置
                await ipcRenderer.invoke('save-config', {
                    searchDirs: searchDirs
                });
                console.log(`已自动添加搜索路径: ${fileDir}`);
            }
        } catch (err) {
            console.error('自动添加搜索路径失败:', err);
        }
    }

    currentFileName = file.name;
    window.isPreviewMode = false;

    // 直接加载完整文件
    const reader = new FileReader();
    reader.onload = async function (e) {
        try {
            await processFileContent(e.target.result, file.name);
        } catch (err) {
            console.error('加载失败:', err);
            showNotification('加载失败: ' + err);
        }
    };
    reader.readAsArrayBuffer(file);

    // 清空 input 值，允许重复选择同一文件
    e.target.value = '';
});

function detectChapters(text, options = {}) {
    // 只有在显示遮罩时才更新文本
    if (document.getElementById('loading-overlay').style.display !== 'none') {
        document.querySelector('.loading-message').textContent = '正在分析章节结构...';
    }

    // 使用 Web Worker 进行章节检测，避免阻塞主线程
    const chapterWorker = createChapterWorker();

    chapterWorker.onmessage = function (e) {
        const result = e.data;

        if (result.error) {
            console.error("章节分析错误:", result.error);
            document.getElementById('loading-overlay').style.display = 'none';
            return;
        }

        chapters = result.chapters;

        // 如果没有检测到章节，或者章节列表为空，将整个文本作为一个章节
        if (result.noChapters || !chapters || chapters.length === 0) {
            chapters = [{
                title: "全文",
                content: text,
                index: 0
            }];
        }

        if (chapters.length > 0) {
            // 保存到缓存
            if (window.currentFilePath) {
                ipcRenderer.invoke('save-book-cache', window.currentFilePath, { chapters: chapters })
                    .then(success => {
                        if (success) console.log('书籍缓存已保存');
                    })
                    .catch(err => console.error('保存缓存失败:', err));
            }

            isChapterListDirty = true; // 标记目录需要更新
            // updateChapterList(); // 延迟渲染
            // 显示翻页按钮
            document.querySelector('.navigation-buttons').style.display = 'flex';
            document.querySelector('.progress-indicator').style.display = 'block';

            // 如果遮罩层是显示的，说明用户正在等待加载，此时不应视为后台更新（需要强制刷新/滚动）
            const isOverlayVisible = document.getElementById('loading-overlay').style.display !== 'none';
            const effectiveIsBackground = options.isBackground && !isOverlayVisible;

            // 检查是否有保存的进度，从多书籍进度存储中获取
            const progressKey = getStorageKey('allBookProgress');
            const allBookProgress = JSON.parse(localStorage.getItem(progressKey)) || {};
            if (allBookProgress[currentFileName]) {
                let targetChapter = allBookProgress[currentFileName].chapter || 0;
                let targetPage = allBookProgress[currentFileName].page || 0;
                let waitingForContent = false;

                // 如果是预览模式，且目标章节不存在，则显示第一章，但不覆盖进度
                if (options.isPreview && targetChapter >= chapters.length) {
                    console.log('预览模式：目标章节超出范围，暂时显示第一章');
                    targetChapter = 0;
                    targetPage = 0;
                    waitingForContent = true;
                    window.waitingForHistory = true; // 标记正在等待历史记录
                }

                // 如果是后台更新，且之前没有在等待历史记录（说明用户可能已经开始阅读了），则优先保持当前位置
                // 除非当前位置是0（可能是刚打开），而历史记录不是0
                if (effectiveIsBackground && !window.waitingForHistory) {
                    // 使用当前内存中的位置，而不是历史记录
                    // 注意：如果用户在预览期间翻页了，currentPage/currentChapter 应该已经更新
                    // 如果是滚动模式，showAllContent 会处理滚动位置恢复
                    console.log('后台更新：用户已在阅读，保持当前位置');

                    if (pageMode === 'scroll') {
                        showAllContent({ isBackground: true });
                    } else {
                        showPage(currentPage, currentChapter, {
                            ...options,
                            isBackground: true
                        });
                    }
                } else {
                    // 正常加载历史记录，或者正在等待历史记录加载
                    if (pageMode === 'scroll') {
                        showAllContent({ isBackground: effectiveIsBackground });
                    } else {
                        showPage(targetPage, targetChapter, {
                            ...options,
                            isBackground: effectiveIsBackground
                        });
                    }
                }

                // 处理遮罩层逻辑
                if (isOverlayVisible) {
                    if (waitingForContent) {
                        // 如果还在等待内容（目标章节未加载），保持遮罩层显示
                        document.querySelector('.loading-message').textContent = '正在跳转到历史位置...';
                    } else {
                        // 内容已就绪，隐藏遮罩层
                        document.querySelector('.loading-message').textContent = '加载完成';
                        document.getElementById('loading-overlay').style.display = 'none';
                    }
                }

                // 如果是后台更新且完成了等待，重置标志
                if (effectiveIsBackground) {
                    window.waitingForHistory = false;
                }
            } else {
                // 没有历史记录
                if (effectiveIsBackground) {
                    // 如果是后台更新（例如从预览模式升级），保持当前位置
                    if (pageMode === 'scroll') {
                        showAllContent({ isBackground: true });
                    } else {
                        showPage(currentPage, currentChapter, {
                            ...options,
                            isBackground: true
                        });
                    }
                } else {
                    // 首次加载，跳转到第一章
                    if (pageMode === 'scroll') {
                        showAllContent();
                    } else {
                        jumpToChapter(0);
                    }
                }

                // 直接隐藏遮罩
                if (document.getElementById('loading-overlay').style.display !== 'none') {
                    document.querySelector('.loading-message').textContent = '加载完成';
                    document.getElementById('loading-overlay').style.display = 'none';
                }
            }
        }

        // 保存当前文件的进度（预览模式和后台加载时不保存）
        if (!options.isPreview && !options.isBackground) {
            saveProgress();
        }

        // 更新进度条
        updateProgressBar();

        // 应用存储的字体设置
        applyStoredSettings();
    };

    // 发送文本到 Worker 进行处理
    chapterWorker.postMessage({
        text: text,
        wordsPerPage: wordsPerPage
    });
}

// 修改 createFileWorker 函数以支持更多编码格式
function createFileWorker() {
    const workerCode = `
                // 引入外部的 GBK 解码库
                importScripts('https://cdn.jsdelivr.net/npm/gbk.js@0.3.0/dist/gbk.min.js');
                
                self.onmessage = function(e) {
                    const arrayBuffer = e.data.buffer;
                    const fileName = e.data.fileName;
                    let text = null;
                    let successEncoding = '';
                    
                    try {
                        // 1. 提取样本进行编码检测 (前 64KB)
                        // 只对样本进行多重编码测试，避免对大文件重复全量解码
                        const sampleSize = Math.min(arrayBuffer.byteLength, 64 * 1024);
                        const sampleBuffer = arrayBuffer.slice(0, sampleSize);

                        // 尝试不同的编码 - 优先次序很重要
                        const encodings = [
                            'utf-8', 
                            'gbk',    // 中文简体
                            'big5',   // 中文繁体
                            'shift_jis', // 日文
                            'euc-kr',    // 韩文
                            'windows-1252', // 西欧
                            'iso-8859-1',   // 拉丁文1
                            'iso-8859-2',   // 中欧
                            'iso-8859-5',   // 西里尔文
                            'iso-8859-7',   // 希腊文
                            'utf-16le',
                            'utf-16be',
                            'iso-8859-9',   // 土耳其语
                            'windows-1256', // 阿拉伯语
                            'windows-1251', // 西里尔文
                            'windows-1254', // 土耳其语
                            'koi8-r',      // 俄语
                            'euc-jp',      // 日语
                            'gb18030',     // 中文扩展
                            'hz-gb-2312',  // 中文简体
                            'iso-2022-jp', // 日语
                            'iso-2022-kr', // 韩语
                            'iso-8859-6',  // 阿拉伯语
                            'iso-8859-8',  // 希伯来语
                            'windows-874', // 泰语
                            'windows-1255', // 希伯来语
                            'windows-1258'  // 越南语
                        ];
                        
                        let detectedEncoding = null;

                        // 尝试自动检测BOM标记 (直接检查原始 buffer)
                        const byteArray = new Uint8Array(arrayBuffer.slice(0, 4));
                        if (byteArray[0] === 0xEF && byteArray[1] === 0xBB && byteArray[2] === 0xBF) {
                            detectedEncoding = 'utf-8';
                            successEncoding = 'utf-8 (BOM)';
                        } else if (byteArray[0] === 0xFE && byteArray[1] === 0xFF) {
                            detectedEncoding = 'utf-16be';
                            successEncoding = 'utf-16be (BOM)';
                        } else if (byteArray[0] === 0xFF && byteArray[1] === 0xFE) {
                            detectedEncoding = 'utf-16le';
                            successEncoding = 'utf-16le (BOM)';
                        } else if (byteArray[0] === 0x00 && byteArray[1] === 0x00 && byteArray[2] === 0xFE && byteArray[3] === 0xFF) {
                            detectedEncoding = 'utf-32be';
                            successEncoding = 'utf-32be (BOM)';
                        } else if (byteArray[0] === 0xFF && byteArray[1] === 0xFE && byteArray[2] === 0x00 && byteArray[3] === 0x00) {
                            detectedEncoding = 'utf-32le';
                            successEncoding = 'utf-32le (BOM)';
                        } 
                        
                        // 如果没有BOM，使用样本检测编码
                        if (!detectedEncoding) {
                            for (let encoding of encodings) {
                                try {
                                    let sampleText;
                                    if (encoding === 'gbk' || encoding === 'gb18030' || encoding === 'hz-gb-2312') {
                                        // 使用GBK.js库处理中文编码
                                        const gbkBytes = new Uint8Array(sampleBuffer);
                                        try {
                                            sampleText = GBK.decode(gbkBytes);
                                        } catch (err) { continue; }
                                    } else {
                                        const decoder = new TextDecoder(encoding);
                                        sampleText = decoder.decode(sampleBuffer);
                                    }
                                    
                                    if (sampleText && !containsUnreadableChars(sampleText)) {
                                        detectedEncoding = encoding;
                                        break;
                                    }
                                } catch (error) {
                                    continue;
                                }
                            }
                        }
                        
                        // 如果所有编码都失败，使用系统默认编码
                        if (!detectedEncoding) {
                            detectedEncoding = 'utf-8'; // 默认回退到 utf-8
                            successEncoding = 'default (utf-8)';
                        } else if (!successEncoding) {
                            successEncoding = detectedEncoding;
                        }
                        
                        // 2. 使用检测到的最佳编码解码完整文件
                        // 这样只进行一次全量解码，大大提高大文件加载速度
                        try {
                            if (detectedEncoding === 'gbk' || detectedEncoding === 'gb18030' || detectedEncoding === 'hz-gb-2312') {
                                const gbkBytes = new Uint8Array(arrayBuffer);
                                text = GBK.decode(gbkBytes);
                            } else {
                                const decoder = new TextDecoder(detectedEncoding);
                                text = decoder.decode(arrayBuffer);
                            }
                        } catch (err) {
                            // 如果全量解码失败，尝试回退到 UTF-8
                            console.error('全量解码失败，回退到 UTF-8', err);
                            const decoder = new TextDecoder('utf-8');
                            text = decoder.decode(arrayBuffer);
                            successEncoding = 'fallback (utf-8)';
                        }
                        
                        // 检查最终解码结果是否有效 (如果样本检测误判)
                        if (text && containsUnreadableChars(text)) {
                            // 如果包含太多无法读取的字符，尝试使用文件名提示的编码再次解码
                            const fileName_lower = fileName.toLowerCase();
                            let hintEncoding = null;
                            
                            if (fileName_lower.includes('gbk') || fileName_lower.includes('gb2312')) hintEncoding = 'gbk';
                            else if (fileName_lower.includes('big5')) hintEncoding = 'big5';
                            else if (fileName_lower.includes('shift-jis') || fileName_lower.includes('sjis')) hintEncoding = 'shift-jis';
                            
                            if (hintEncoding && hintEncoding !== detectedEncoding) {
                                try {
                                    if (hintEncoding === 'gbk') {
                                        const gbkBytes = new Uint8Array(arrayBuffer);
                                        text = GBK.decode(gbkBytes);
                                    } else {
                                        const decoder = new TextDecoder(hintEncoding);
                                        text = decoder.decode(arrayBuffer);
                                    }
                                    successEncoding = hintEncoding + ' (filename hint)';
                                } catch (e) {}
                            }
                        }
                        
                        // 发送解码结果和使用的编码信息
                        self.postMessage({ 
                            text: text, 
                            encoding: successEncoding 
                        });
                    } catch (error) {
                        self.postMessage({ error: error.message });
                    }
                };
                
                // 检查文本中是否包含过多无法读取的字符
                function containsUnreadableChars(text) {
                    // 检查替换字符的比例
                    const replacementChar = '\\uFFFD'; // Unicode 替换字符
                    const replacementCount = (text.match(new RegExp(replacementChar, 'g')) || []).length;
                    
                    // 检查问号字符的比例（可能是替换字符）
                    const questionMarkCount = (text.match(/\\?/g) || []).length;
                    
                    // 检查乱码字符的比例
                    const gibberishRegex = /[\\x00-\\x08\\x0E-\\x1F\\x7F-\\x9F\\uFFFD]/g;
                    const gibberishCount = (text.match(gibberishRegex) || []).length;
                    
                    // 计算总的可疑字符比例
                    const suspiciousChars = replacementCount + questionMarkCount + gibberishCount;
                    const threshold = 0.1; // 如果超过10%的字符是可疑字符，认为编码可能不正确
                    
                    return suspiciousChars > text.length * threshold;
                }
            `;

    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);

    // 清理 URL 对象
    URL.revokeObjectURL(url);

    return worker;
}

// 创建处理章节的 Web Worker
function createChapterWorker() {
    const workerCode = `
                self.onmessage = function(e) {
                    const text = e.data.text;
                    const wordsPerPage = e.data.wordsPerPage;
                    
                    try {
                        let chapters = [];
                        let position = 0;
                        let lastChapterStart = 0;
                        
                        // 改进章节匹配模式，支持更多格式
                        const chapterPatterns = [
                            /^第[一二三四五六七八九十百千万0-9０-９\\d]+[章节回集卷]/,  // 标准章节格式
                            /^[第]?[0-9０-９]{1,4}[章节回集卷]/,  // 数字章节
                            /^Chapter\\s+[0-9０-９]+/i,  // 英文章节
                            /^[（(【「『]?第?[一二三四五六七八九十百千万0-9０-９\\d]+[章节回集卷][)）】」』]?/,  // 带括号的章节
                            /^(序章|序幕|前言|引子|楔子|尾声|后记|番外|番外篇|终章|完本感言|附录|附件)/  // 特殊章节
                        ];
                        
                        // 预扫描检查是否有章节 (只检查前 2000 行)
                        // 避免对无章节的大文件进行全量扫描
                        let hasChapters = false;
                        let scanIndex = 0;
                        let lineCount = 0;
                        
                        while (lineCount < 2000 && scanIndex < text.length) {
                            let nextNewLine = text.indexOf('\\n', scanIndex);
                            if (nextNewLine === -1) nextNewLine = text.length;
                            
                            const line = text.slice(scanIndex, nextNewLine).trim();
                            if (line.length > 0 && line.length < 50) {
                                for (const pattern of chapterPatterns) {
                                    if (pattern.test(line)) {
                                        hasChapters = true;
                                        break;
                                    }
                                }
                            }
                            if (hasChapters) break;
                            
                            scanIndex = nextNewLine + 1;
                            lineCount++;
                        }
                        
                        if (!hasChapters) {
                            // 如果没有检测到章节，通知主线程
                            self.postMessage({
                                noChapters: true,
                                chapters: []
                            });
                            return;
                        }
                        
                        // 如果有章节，按章节处理
                        // 完整扫描，避免使用 split('\\n') 创建巨大数组
                        let currentIndex = 0;
                        let textLength = text.length;
                        
                        // 检查第一行是否为章节
                        let firstLineEnd = text.indexOf('\\n');
                        if (firstLineEnd === -1) firstLineEnd = textLength;
                        const firstLine = text.slice(0, firstLineEnd).trim();
                        
                        let firstChapterFound = false;
                        for (const pattern of chapterPatterns) {
                            if (pattern.test(firstLine)) {
                                firstChapterFound = true;
                                break;
                            }
                        }
                        
                        if (!firstChapterFound) {
                            chapters.push({
                                title: '开始',
                                position: 0,
                                content: ''
                            });
                        }
                        
                        // 遍历全文查找章节
                        while (currentIndex < textLength) {
                            let nextNewLine = text.indexOf('\\n', currentIndex);
                            if (nextNewLine === -1) nextNewLine = textLength;
                            
                            // 获取当前行内容 (不包含换行符)
                            const line = text.slice(currentIndex, nextNewLine);
                            const trimmedLine = line.trim();
                            
                            let isChapter = false;
                            // 章节名通常比较短，忽略过长的行
                            if (trimmedLine.length > 0 && trimmedLine.length < 50) {
                                for (const pattern of chapterPatterns) {
                                    if (pattern.test(trimmedLine)) {
                                        isChapter = true;
                                        break;
                                    }
                                }
                            }
                            
                            if (isChapter) {
                                if (chapters.length > 0) {
                                    // 设置上一章的内容
                                    chapters[chapters.length - 1].content = text.slice(lastChapterStart, currentIndex);
                                }
                                chapters.push({
                                    title: trimmedLine,
                                    position: currentIndex,
                                    content: ''
                                });
                                lastChapterStart = currentIndex;
                            }
                            
                            // 移动到下一行
                            currentIndex = nextNewLine + 1;
                        }
                        
                        if (chapters.length > 0) {
                            chapters[chapters.length - 1].content = text.slice(lastChapterStart);
                            self.postMessage({
                                chapters: chapters,
                                noChapters: false
                            });
                        }
                    } catch (error) {
                        self.postMessage({ error: error.message });
                    }
                };
            `;

    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);

    // 清理 URL 对象
    URL.revokeObjectURL(url);

    return worker;
}

// 修复无章节文件的分页问题
function showTextPage(pageNum, totalPages, options = {}) {
    if (pageNum >= 0 && pageNum < totalPages) {
        currentPage = pageNum;

        const content = document.getElementById('content');
        // 确保内容区域可见
        content.style.display = 'block';

        // 保存当前的滚动位置
        const savedScrollTop = content.scrollTop;
        const savedWindowScrollY = window.scrollY;

        // 获取当前页内容
        const pageText = currentContent[currentPage];

        // 按行拆分当前页内容并显示
        let htmlContent = '';
        if (pageText) {
            const lines = pageText.split('\n');
            for (let line of lines) {
                htmlContent += line.trim()
                    ? `<p>${line}</p>`
                    : '<p><br></p>';
            }
        } else {
            htmlContent = '<p>此页内容为空</p>';
            console.warn('当前页内容为空: pageNum =', pageNum, 'totalPages =', totalPages);
        }

        // 如果是后台更新且内容没有变化，则不重新渲染DOM
        if (options.isBackground && content.innerHTML === htmlContent) {
            console.log('后台更新：内容未变，跳过DOM更新');
            return;
        }

        content.innerHTML = htmlContent || '<p>此页内容为空</p>';

        // 应用段落间距设置
        const settings = JSON.parse(localStorage.getItem('readerSettings') || '{}');
        if (settings.paragraphSpacing) {
            const paragraphs = document.querySelectorAll('#content p');
            paragraphs.forEach(p => {
                p.style.marginBottom = `${settings.paragraphSpacing}em`;
            });
        }

        // 更新页码显示，确保页码正确
        document.getElementById('page-info').textContent = `第 ${currentPage + 1}/${totalPages} 页`;

        // 保存进度（预览模式下不保存，后台更新也不保存）
        if (!options.isPreview && !options.isBackground) {
            saveProgress();
        }

        // 只有非后台更新时才强制滚动到顶部
        if (!options.isBackground) {
            window.scrollTo(0, 0);
            content.scrollTop = 0;
        } else {
            // 后台更新，恢复滚动位置
            content.scrollTop = savedScrollTop;
            window.scrollTo(0, savedWindowScrollY);
        }

        // 确保翻页按钮可见
        document.querySelector('.navigation-buttons').style.display = 'flex';

        // 确保整个控制栏可见
        const controls = document.querySelector('.reader-controls');
        if (controls) {
            controls.style.display = 'block';
        }

        // 更新进度条
        updateProgressBar();
    } else {
        console.error('无效的页码:', pageNum, '总页数:', totalPages);
    }
}

function showPage(pageNum, chapterNum = currentChapter, options = {}) {
    if (!chapters[chapterNum]) {
        console.error('无效的章节:', chapterNum);
        return;
    }

    const chapterContent = chapters[chapterNum].content;
    const totalPages = Math.ceil(chapterContent.length / wordsPerPage);

    if (pageNum >= 0 && pageNum < totalPages) {
        currentPage = pageNum;
        currentChapter = chapterNum;

        const start = currentPage * wordsPerPage;
        const end = start + wordsPerPage;
        const content = document.getElementById('content');

        // 保存当前的滚动位置
        const savedScrollTop = content.scrollTop;
        const savedWindowScrollY = window.scrollY;

        // 如果是后台更新且内容没有变化，则不重新渲染DOM，避免闪烁
        // 这里简单比较一下内容长度，如果完全一致可能不需要重绘
        // 但为了保险起见，我们只在 isBackground 为 true 时尝试优化
        // 实际上，最简单的防闪烁是保持滚动位置

        const newHTML = chapterContent
            .slice(start, end)
            .split('\n')
            .map(line => line.trim() ? `<p>${line}</p>` : '<p><br></p>')
            .join('');

        // 如果内容完全一样，直接返回，不操作DOM
        if (options.isBackground && content.innerHTML === newHTML) {
            console.log('后台更新：内容未变，跳过DOM更新');
            return;
        }

        content.innerHTML = newHTML;

        // 确保翻页按钮可见
        if (pageMode === 'page') {
            document.querySelector('.navigation-buttons').style.display = 'flex';
        }

        // 确保整个控制栏可见
        const controls = document.querySelector('.reader-controls');
        if (controls) {
            controls.style.display = 'block';
        }

        // 应用段落间距设置
        const settings = JSON.parse(localStorage.getItem('readerSettings') || '{}');
        if (settings.paragraphSpacing) {
            const paragraphs = document.querySelectorAll('#content p');
            paragraphs.forEach(p => {
                p.style.marginBottom = `${settings.paragraphSpacing}em`;
            });
        }

        document.getElementById('page-info').textContent = `第 ${currentPage + 1}/${totalPages} 页`;

        // 保存进度（预览模式下不保存，后台更新也不保存）
        if (!options.isPreview && !options.isBackground) {
            saveProgress();
        }

        // 只有非后台更新时才强制滚动到顶部
        // 后台更新时，用户可能正在阅读，保持位置
        if (!options.isBackground) {
            window.scrollTo(0, 0);
            content.scrollTop = 0;
        } else {
            // 后台更新，恢复滚动位置
            content.scrollTop = savedScrollTop;
            window.scrollTo(0, savedWindowScrollY);
        }
    } else {
        console.error('无效的页码:', pageNum, '总页数:', totalPages);
    }
}

function nextPage() {
    // 如果没有章节，使用整体分页逻辑
    if (chapters.length === 0) {
        // 确保正确计算总页数
        const totalPages = currentContent.length;

        if (currentPage < totalPages - 1) {
            showTextPage(currentPage + 1, totalPages);
        } else {
            // 已是最后一页，显示提示
            showNotification('已经是最后一页了');
        }
    } else {
        // 有章节的情况，使用原有逻辑
        const currentChapterContent = chapters[currentChapter].content;
        const totalPagesInChapter = Math.ceil(currentChapterContent.length / wordsPerPage);

        if (currentPage < totalPagesInChapter - 1) {
            showPage(currentPage + 1);
        } else if (currentChapter < chapters.length - 1) {
            jumpToChapter(currentChapter + 1);
        } else {
            // 已是最后一章最后一页，显示提示
            showNotification('已经是最后一页了');
        }
    }
    saveProgress();
}

function previousPage() {
    // 如果没有章节，使用整体分页逻辑
    if (chapters.length === 0) {
        if (currentPage > 0) {
            // 确保正确计算总页数
            const totalPages = currentContent.length;
            showTextPage(currentPage - 1, totalPages);
        } else {
            // 已是第一页，显示提示
            showNotification('已经是第一页了');
        }
    } else {
        // 有章节的情况，使用原有逻辑
        if (currentPage > 0) {
            showPage(currentPage - 1);
        } else if (currentChapter > 0) {
            const prevChapterContent = chapters[currentChapter - 1].content;
            const lastPage = Math.ceil(prevChapterContent.length / wordsPerPage) - 1;
            showPage(lastPage, currentChapter - 1);
        } else {
            // 已是第一章第一页，显示提示
            showNotification('已经是第一页了');
        }
    }
    saveProgress();
}

function toggleChapterList() {
    const chapterList = document.getElementById('chapter-list');
    if (chapterList.classList.contains('hidden')) {
        // 如果没有打开书籍，不显示目录
        if (!currentFileName) {
            showNotification('请先打开一本书');
            return;
        }

        // 强制更新目录（如果 dirty）
        if (isChapterListDirty) {
            updateChapterList();
        } else {
            // 如果目录没有重建，手动更新 active 状态
            const oldActive = chapterList.querySelector('.chapter-item.active');
            if (oldActive) oldActive.classList.remove('active');

            const content = chapterList.querySelector('.chapter-list-content');
            if (content && content.children[currentChapter]) {
                content.children[currentChapter].classList.add('active');
            }
        }
        chapterList.classList.remove('hidden');

        // 滚动到当前章节
        const activeItem = chapterList.querySelector('.chapter-item.active');
        if (activeItem) {
            // 将当前章节滚动到可视区域中间
            setTimeout(() => {
                activeItem.scrollIntoView({ block: 'center', behavior: 'auto' });
            }, 0);
        }
    } else {
        chapterList.classList.add('hidden');
    }
}

function jumpToChapter(index) {
    if (chapters[index]) {
        showPage(0, index);
        // 确保滚动到顶部
        window.scrollTo(0, 0);
        document.getElementById('content').scrollTop = 0;
    }
}

function toggleTheme() {
    document.body.classList.toggle('dark-mode');
    // 保存主题设置到配置文件
    ipcRenderer.invoke('save-config', {
        theme: document.body.classList.contains('dark-mode') ? 'dark' : 'light'
    });
}

function toggleFontSettings() {
    const panel = document.getElementById('font-settings-panel');
    panel.classList.toggle('hidden');
}

function changeFontFamily() {
    const fontFamily = document.getElementById('font-family-selector').value;
    document.getElementById('content').style.fontFamily = fontFamily;

    // 保存到localStorage
    const settings = JSON.parse(localStorage.getItem('readerSettings') || '{}');
    settings.fontFamily = fontFamily;
    localStorage.setItem('readerSettings', JSON.stringify(settings));
}

function changeLineHeight() {
    const lineHeight = document.getElementById('line-height-slider').value;
    document.getElementById('line-height-value').textContent = lineHeight;
    document.getElementById('content').style.lineHeight = lineHeight;

    // 保存到localStorage
    const settings = JSON.parse(localStorage.getItem('readerSettings') || '{}');
    settings.lineHeight = lineHeight;
    localStorage.setItem('readerSettings', JSON.stringify(settings));
}

function changeLetterSpacing() {
    const letterSpacing = document.getElementById('letter-spacing-slider').value;
    document.getElementById('letter-spacing-value').textContent = letterSpacing;
    document.getElementById('content').style.letterSpacing = `${letterSpacing}em`;

    // 保存到localStorage
    const settings = JSON.parse(localStorage.getItem('readerSettings') || '{}');
    settings.letterSpacing = letterSpacing;
    localStorage.setItem('readerSettings', JSON.stringify(settings));
}

function changeParagraphSpacing() {
    const paragraphSpacing = document.getElementById('paragraph-spacing-slider').value;
    document.getElementById('paragraph-spacing-value').textContent = `${paragraphSpacing}em`;

    // 应用样式到所有段落
    const paragraphs = document.querySelectorAll('#content p');
    paragraphs.forEach(p => {
        p.style.marginBottom = `${paragraphSpacing}em`;
    });

    // 保存到localStorage
    const settings = JSON.parse(localStorage.getItem('readerSettings') || '{}');
    settings.paragraphSpacing = paragraphSpacing;
    localStorage.setItem('readerSettings', JSON.stringify(settings));
}

function applyStoredSettings() {
    const settings = JSON.parse(localStorage.getItem('readerSettings') || '{}');

    if (settings.fontFamily) {
        document.getElementById('font-family-selector').value = settings.fontFamily;
        document.getElementById('content').style.fontFamily = settings.fontFamily;
    }

    if (settings.lineHeight) {
        document.getElementById('line-height-slider').value = settings.lineHeight;
        document.getElementById('line-height-value').textContent = settings.lineHeight;
        document.getElementById('content').style.lineHeight = settings.lineHeight;
    }

    if (settings.letterSpacing) {
        document.getElementById('letter-spacing-slider').value = settings.letterSpacing;
        document.getElementById('letter-spacing-value').textContent = settings.letterSpacing;
        document.getElementById('content').style.letterSpacing = `${settings.letterSpacing}em`;
    }

    if (settings.paragraphSpacing) {
        document.getElementById('paragraph-spacing-slider').value = settings.paragraphSpacing;
        document.getElementById('paragraph-spacing-value').textContent = `${settings.paragraphSpacing}em`;
    }

    // 分别应用阅读内容和主页字体大小
    if (settings.fontSize) {
        fontSize = parseInt(settings.fontSize);
        // 只有在阅读模式下才应用字体大小
        if (currentFileName) {
            document.getElementById('content').style.fontSize = `${fontSize}px`;
        }
    }

    if (settings.homePageFontSize) {
        homePageFontSize = parseInt(settings.homePageFontSize);
        // 只有在主页模式下才应用主页字体大小
        if (!currentFileName) {
            applyHomePageFontSize();
        }
    }
}

function applyHomePageFontSize() {
    // 应用主页字体大小
    if (!currentFileName) {
        document.querySelectorAll('.history-list').forEach(el => {
            el.style.fontSize = `${homePageFontSize}px`;
        });
        document.querySelectorAll('.history-title').forEach(el => {
            el.style.fontSize = `${homePageFontSize + 2}px`;
        });
        document.querySelectorAll('.history-date, .history-progress').forEach(el => {
            el.style.fontSize = `${homePageFontSize - 2}px`;
        });
    }
}

function changeFontSize(delta) {
    if (currentFileName) {
        // 阅读模式下，调整阅读字体大小
        fontSize += delta * 2;
        if (fontSize < 12) fontSize = 12;
        if (fontSize > 36) fontSize = 36;

        document.getElementById('content').style.fontSize = `${fontSize}px`;

        // 保存到localStorage
        const settings = JSON.parse(localStorage.getItem('readerSettings') || '{}');
        settings.fontSize = fontSize;
        localStorage.setItem('readerSettings', JSON.stringify(settings));
    } else {
        // 主页模式下，调整主页字体大小
        homePageFontSize += delta * 2;
        if (homePageFontSize < 12) homePageFontSize = 12;
        if (homePageFontSize > 24) homePageFontSize = 24;

        applyHomePageFontSize();

        // 保存到localStorage
        const settings = JSON.parse(localStorage.getItem('readerSettings') || '{}');
        settings.homePageFontSize = homePageFontSize;
        localStorage.setItem('readerSettings', JSON.stringify(settings));
    }
}

function setFontSize(size) {
    if (currentFileName) {
        // 阅读模式下设置字体大小
        fontSize = size;
        document.getElementById('content').style.fontSize = `${fontSize}px`;

        // 保存到localStorage
        const settings = JSON.parse(localStorage.getItem('readerSettings') || '{}');
        settings.fontSize = fontSize;
        localStorage.setItem('readerSettings', JSON.stringify(settings));
    } else {
        // 主页模式下设置字体大小
        homePageFontSize = size;
        applyHomePageFontSize();

        // 保存到localStorage
        const settings = JSON.parse(localStorage.getItem('readerSettings') || '{}');
        settings.homePageFontSize = homePageFontSize;
        localStorage.setItem('readerSettings', JSON.stringify(settings));
    }
}

// 修改键盘事件处理，删除数字键调节字体大小和沉浸式阅读模式切换
document.addEventListener('keydown', function (e) {
    // 左箭头或PageUp - 上一页
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        previousPage();
        e.preventDefault();
    }
    // 右箭头或PageDown或空格 - 下一页
    else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        nextPage();
        e.preventDefault();
    }
    // Home键 - 返回首页
    else if (e.key === 'Home') {
        backToHome();
        e.preventDefault();
    }
    // T键 - 切换主题
    else if (e.key === 't' || e.key === 'T') {
        toggleTheme();
        e.preventDefault();
    }
    // ESC键 - 返回主页 (已在全局监听器中处理)
    // else if (e.key === 'Escape') {
    //     backToHome();
    //     e.preventDefault();
    // }
});

let isChapterListDirty = true;

function updateChapterList() {
    if (!isChapterListDirty) return;

    const chapterList = document.getElementById('chapter-list');
    const headerHtml = `
                <div class="chapter-list-header">
                    <h3>目录</h3>
                    <button class="close-btn" onclick="toggleChapterList()">×</button>
                </div>
            `;

    // 优化：如果章节太多，分批渲染或者简化渲染
    // 这里暂时保持原样，但标记为已更新
    const listHtml = chapters.map((chapter, index) =>
        `<div class="chapter-item ${index === currentChapter ? 'active' : ''}" 
                      onclick="jumpToChapter(${index}); toggleChapterList();">${chapter.title}</div>`
    ).join('');

    chapterList.innerHTML = headerHtml + '<div class="chapter-list-content">' + listHtml + '</div>';
    isChapterListDirty = false;
}

// 修改 loadHistoryRecord 和 searchFile 函数，支持多本书的阅读进度
function loadHistoryRecord(fileName, lastPosition, lastChapter, filePath = null) {
    // 如果侧边栏是打开的，关闭它
    const sidebar = document.querySelector('.reader-sidebar');
    if (sidebar && sidebar.classList.contains('active')) {
        sidebar.classList.remove('active');
        // 同时隐藏子面板
        document.getElementById('chapter-list').classList.add('hidden');
        document.getElementById('font-settings-panel').classList.add('hidden');
    }

    const pendingRestore = {
        fileName: fileName,
        position: lastPosition,
        chapter: lastChapter
    };
    localStorage.setItem('pendingRestore', JSON.stringify(pendingRestore));

    // 保存这些值到全局变量，以便在 searchFile 的回调中使用
    window.pendingPosition = lastPosition;
    window.pendingChapter = lastChapter;

    // 如果有完整路径，直接尝试加载，不再搜索
    if (filePath) {
        console.log('使用保存的路径直接加载:', filePath);
        loadAndRenderBook(filePath, fileName, lastPosition, lastChapter).catch(err => {
            console.warn('直接加载失败，尝试搜索:', err);
            // 如果直接加载失败（可能文件移动了），回退到搜索逻辑
            startSearch(fileName);
        });
        return;
    }

    startSearch(fileName);
}

function startSearch(fileName) {
    // 显示加载中
    document.getElementById('loading-overlay').style.display = 'flex';
    document.querySelector('.loading-message').textContent = `正在查找文件: ${fileName}...`;

    // 递归搜索文件，先在当前目录搜索，然后在历史搜索目录中搜索
    // 确保 searchDirs 已经包含了 baseDir，并且去重
    const allPaths = [baseDir].concat(searchDirs);
    searchFile(allPaths, fileName);
}

// 递归搜索文件，使用 find-and-open-file-location 的逻辑，但只返回路径
async function searchFile(searchDirectories, fileName) {
    try {
        // 去重并过滤空路径
        const uniqueDirs = [...new Set(searchDirectories)].filter(dir => dir);

        if (uniqueDirs.length === 0) {
            throw new Error('没有可用的搜索路径');
        }

        // 使用主进程的 find-and-open-file-location 逻辑来查找文件
        // 但我们需要一个新的 IPC 接口只返回路径而不打开文件夹
        // 这里我们复用 search-file 接口，但需要修改它的调用方式
        // 或者我们可以直接在前端循环调用，但为了效率，最好在后端做

        // 既然用户反馈速度慢，我们尝试并行搜索所有路径
        // 但为了保证优先级，我们还是按顺序或者分组并行

        // 这里我们修改策略：直接调用一个新的 IPC 接口，让主进程去处理优先级和并行
        // 我们先用现有的 search-file 接口，但要在前端控制好逻辑

        // 实际上，之前的递归逻辑是串行的，确实慢
        // 我们改为并行搜索，但保留优先级

        // 创建一个 Promise 数组，每个目录一个搜索任务
        // 但为了优先级，我们不能简单地 Promise.any，因为那会返回最快的结果而不是优先级最高的结果

        // 更好的方法是：让主进程提供一个 'find-file-in-paths' 接口
        // 既然不能改主进程接口（或者改起来麻烦），我们在前端优化

        // 尝试使用 find-and-open-file-location 的逻辑变体
        // 但这里我们直接修改 searchFile 函数，不再递归，而是使用循环 + await

        let foundPath = null;

        // 优先搜索 searchDirs 中的路径（按顺序）
        // 为了提高速度，我们可以分批并行，比如每3个目录一组
        const BATCH_SIZE = 3;

        for (let i = 0; i < uniqueDirs.length; i += BATCH_SIZE) {
            const batch = uniqueDirs.slice(i, i + BATCH_SIZE);
            const promises = batch.map(dir => ipcRenderer.invoke('search-file', dir, fileName));

            const results = await Promise.all(promises);

            // 检查这一批次有没有找到
            // 注意：我们要按 batch 中的顺序来检查结果，以保持优先级
            for (let j = 0; j < results.length; j++) {
                if (results[j]) {
                    foundPath = results[j];
                    break;
                }
            }

            if (foundPath) break;
        }

        if (foundPath) {
            // 使用新的智能加载函数
            await loadAndRenderBook(foundPath, fileName, window.pendingPosition || 0, window.pendingChapter || 0);
        } else {
            throw new Error(`找不到文件: ${fileName}`);
        }

    } catch (error) {
        console.error('文件读取错误:', error);
        showNotification(`${error.message}`);

        if (error.message.includes('找不到文件')) {
            if (confirm(`${fileName} 文件不存在，是否从历史记录中删除？`)) {
                deleteHistoryRecord(fileName);
            }
        }
        document.getElementById('loading-overlay').style.display = 'none';
    }
}

// 修改添加历史记录的函数，保存更多信息以便计算进度
function addToHistory(record) {
    // 验证记录有效性
    if (!record || !record.fileName || record.fileName.trim() === '') {
        console.warn('尝试添加无效的历史记录:', record);
        return;
    }

    const historyKey = getStorageKey('readingHistory');
    let history = JSON.parse(localStorage.getItem(historyKey)) || [];

    // 添加时间戳
    record.timestamp = new Date().getTime();

    // 添加章节和页面总数信息，用于计算进度
    if (chapters.length > 0) {
        record.totalChapters = chapters.length;
    } else if (currentContent) {
        record.totalPages = Math.ceil(currentContent.length / wordsPerPage);
    }

    // 检查是否已存在相同文件名的记录
    const existingIndex = history.findIndex(item => item.fileName === record.fileName);
    if (existingIndex !== -1) {
        // 保留原来的record对象，只更新需要变动的字段
        const oldRecord = history[existingIndex];
        record = { ...oldRecord, ...record };
        // 删除旧记录
        history.splice(existingIndex, 1);
    }

    // 添加新记录到最前面
    history.unshift(record);

    // 移除历史记录数量限制，改为无限
    // if (history.length > 50) {
    //     history.pop();
    // }

    localStorage.setItem(historyKey, JSON.stringify(history));

    // 同步到云端/本地库目录
    ipcRenderer.invoke('save-history', history, currentProfile).catch(err => console.error('同步历史记录失败:', err));

    // 如果当前在主页，则更新历史记录显示
    if (!currentFileName) {
        updateHistoryDisplay();
    }

    // 也更新阅读进度存储
    const progressKey = getStorageKey('allBookProgress');
    let allBookProgress = JSON.parse(localStorage.getItem(progressKey)) || {};
    allBookProgress[record.fileName] = {
        page: record.lastPosition,
        chapter: record.chapter || 0,
        lastRead: new Date().toISOString(),
        hasChapters: chapters.length > 0,
        totalChapters: chapters.length > 0 ? chapters.length : 0,
        totalPages: chapters.length === 0 && currentContent ? Math.ceil(currentContent.length / wordsPerPage) : 0
    };
    localStorage.setItem(progressKey, JSON.stringify(allBookProgress));
}

// 修改历史记录显示
function updateHistoryDisplay() {
    const historyKey = getStorageKey('readingHistory');
    const progressKey = getStorageKey('allBookProgress');

    let history = JSON.parse(localStorage.getItem(historyKey)) || [];

    // 过滤掉无效的历史记录（没有文件名的记录）
    const validHistory = history.filter(record => record && record.fileName && record.fileName.trim() !== '');

    // 如果发现无效记录，更新 localStorage
    if (validHistory.length !== history.length) {
        history = validHistory;
        localStorage.setItem(historyKey, JSON.stringify(history));
    }

    const content = document.getElementById('content');

    // 如果当前没有打开的文件，显示历史记录
    if (!currentFileName) {
        let historyHtml = '<div class="history-list">';
        historyHtml += '<div class="history-header">';
        historyHtml += `<h2>${currentProfile === 'hidden' ? '隐私阅读' : '最近阅读'}</h2>`;
        if (history.length > 0) {
            historyHtml += '<button onclick="clearHistory()" class="clear-history-btn">清空历史</button>';
        }
        historyHtml += '</div>';

        if (history.length === 0) {
            historyHtml += '<p class="no-history">暂无阅读记录</p>';
        } else {
            historyHtml += '<div class="history-items">';
            history.forEach(record => {
                // 再次检查文件名，确保安全
                if (!record.fileName) return;

                // 获取该书籍的最新进度信息
                const allBookProgress = JSON.parse(localStorage.getItem(progressKey)) || {};
                const bookProgress = allBookProgress[record.fileName] || {};
                const lastReadDate = bookProgress.lastRead ? new Date(bookProgress.lastRead).toLocaleString() : record.date;

                // 计算阅读进度百分比
                let progressDisplay = '';
                if (bookProgress.hasChapters) {
                    // 如果有章节，获取章节数量
                    let chapterCount = record.totalChapters || 0;
                    if (chapterCount > 0) {
                        progressDisplay = `读到: ${(bookProgress.chapter + 1)}/${chapterCount} 章`;
                    } else {
                        // 如果没有章节数量信息，只显示当前章节
                        progressDisplay = `读到: 第${bookProgress.chapter + 1}章`;
                    }
                } else {
                    // 如果没有章节，尝试使用页码百分比
                    if (bookProgress.page !== undefined && record.totalPages) {
                        const percentage = Math.min(100, Math.round(((bookProgress.page + 1) / record.totalPages) * 100));
                        progressDisplay = `进度: ${percentage}%`;
                    } else if (bookProgress.page !== undefined) {
                        // 如果没有总页数信息，只显示当前页码
                        progressDisplay = `读到: 第${bookProgress.page + 1}页`;
                    }
                }

                // 确保 filePath 被正确转义和传递
                const filePathArg = record.filePath ? `'${record.filePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : 'null';

                historyHtml += `
                            <div class="history-item" 
                                data-filename="${record.fileName}"
                                onclick="loadHistoryRecord('${record.fileName}', ${record.lastPosition}, ${record.chapter || 0}, ${filePathArg})"
                                oncontextmenu="showHistoryContextMenu(event, '${record.fileName}'); return false;">
                                <div class="history-info">
                                    <div class="history-title">${record.fileName}</div>
                                    <div class="history-date">最后阅读: ${lastReadDate}</div>
                                    <div class="history-progress">${progressDisplay}</div>
                                </div>
                                <div class="history-delete" onclick="event.stopPropagation(); deleteHistoryRecord('${record.fileName}');">
                                    ×
                                </div>
                            </div>
                        `;
            });
            historyHtml += '</div>';
        }

        historyHtml += '</div>';
        content.innerHTML = historyHtml;
        content.style.display = 'block';

        // 隐藏阅读控制栏
        const controls = document.querySelector('.reader-controls');
        if (controls) controls.style.display = 'none';

        // 应用主页字体大小
        applyHomePageFontSize();
    }
}

// 添加删除单个历史记录的函数
function deleteHistoryRecord(fileName) {
    const historyKey = getStorageKey('readingHistory');
    const progressKey = getStorageKey('allBookProgress');

    let history = JSON.parse(localStorage.getItem(historyKey)) || [];
    history = history.filter(record => record.fileName !== fileName);
    localStorage.setItem(historyKey, JSON.stringify(history));

    // 同步到云端/本地库目录
    ipcRenderer.invoke('save-history', history, currentProfile).catch(err => console.error('同步历史记录失败:', err));

    // 同步删除记录到云端
    ipcRenderer.invoke('save-deleted-history', [fileName], currentProfile).catch(err => console.error('同步删除记录失败:', err));

    // 同时清除阅读进度
    let allBookProgress = JSON.parse(localStorage.getItem(progressKey)) || {};
    if (allBookProgress[fileName]) {
        delete allBookProgress[fileName];
        localStorage.setItem(progressKey, JSON.stringify(allBookProgress));
    }

    // 更新显示
    updateHistoryDisplay();
    showNotification(`已从历史记录中移除: ${fileName}`);
}

// 添加右键菜单相关函数
function showHistoryContextMenu(event, fileName) {
    event.preventDefault();

    // 删除已存在的右键菜单
    const existingMenu = document.getElementById('history-context-menu');
    if (existingMenu) {
        existingMenu.remove();
    }

    // 创建右键菜单
    const menu = document.createElement('div');
    menu.id = 'history-context-menu';
    menu.className = 'context-menu';
    menu.innerHTML = `
                <div class="context-menu-item" onclick="deleteHistoryRecord('${fileName}')">
                    删除记录
                </div>
                <div class="context-menu-item" onclick="openFileLocation('${fileName}')">
                    打开文件所在位置
                </div>
                <div class="context-menu-item" onclick="selectCustomPath()">
                    添加搜索路径
                </div>
                <div class="context-menu-item" onclick="manageSearchPaths()">
                    管理搜索路径
                </div>
            `;

    // 设置菜单位置
    menu.style.left = event.pageX + 'px';
    menu.style.top = event.pageY + 'px';

    // 添加到页面
    document.body.appendChild(menu);

    // 存储当前选中的文件名，用于键盘快捷键删除
    window.currentSelectedFileName = fileName;

    // 添加键盘事件监听，按D键快速删除
    function handleKeyDown(e) {
        if (e.key.toLowerCase() === 'd') {
            deleteHistoryRecord(window.currentSelectedFileName);
            menu.remove();
            document.removeEventListener('keydown', handleKeyDown);
        }
    }
    document.addEventListener('keydown', handleKeyDown);

    // 点击其他地方关闭菜单
    document.addEventListener('click', function closeMenu() {
        menu.remove();
        document.removeEventListener('click', closeMenu);
        document.removeEventListener('keydown', handleKeyDown);
        window.currentSelectedFileName = null;
    });
}

// 添加管理搜索路径的函数
function manageSearchPaths() {
    // 创建一个模态对话框
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
                <div class="modal-content">
                    <div class="modal-header">
                        <h3>管理搜索路径 (可拖拽排序)</h3>
                        <span class="modal-close">&times;</span>
                    </div>
                    <div class="modal-body">
                        <div class="search-paths-list" id="search-paths-list">
                            ${searchDirs.map((dir, index) => {
        const isBaseDir = dir === baseDir;
        return `<div class="search-path-item ${isBaseDir ? 'active-base-dir' : ''}" draggable="true" data-index="${index}">
                                    <span class="drag-handle">☰</span>
                                    <div class="path-info">
                                        <span class="search-path-text" title="${dir}">${dir}</span>
                                        ${isBaseDir ? '<span class="base-dir-tag">当前随机源</span>' : ''}
                                    </div>
                                    <div class="path-actions">
                                        ${!isBaseDir ? `<button class="set-base-btn" data-index="${index}" title="设为随机阅读路径">设为随机源</button>` : ''}
                                        <span class="search-path-delete" data-index="${index}">×</span>
                                    </div>
                                </div>`;
    }).join('')}
                        </div>
                        <div class="search-path-actions">
                            <button id="add-search-path">添加路径</button>
                        </div>
                    </div>
                </div>
            `;

    // 添加样式
    const style = document.createElement('style');
    style.textContent = `
                .search-path-item { cursor: move; user-select: none; display: flex; align-items: center; padding: 10px; border-bottom: 1px solid #eee; }
                .search-path-item.active-base-dir { background-color: #f0f9ff; border-left: 4px solid #2196F3; }
                .dark-mode .search-path-item.active-base-dir { background-color: #2c3e50; border-left: 4px solid #3498db; }
                .search-path-item.dragging { opacity: 0.5; background: #e0e0e0; }
                .drag-handle { margin-right: 10px; cursor: grab; color: #888; font-size: 18px; }
                .path-info { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
                .search-path-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .base-dir-tag { font-size: 12px; color: #2196F3; margin-top: 2px; font-weight: bold; }
                .path-actions { display: flex; align-items: center; gap: 10px; }
                .set-base-btn { padding: 2px 8px; font-size: 12px; background: #e0e0e0; border: none; border-radius: 4px; cursor: pointer; }
                .set-base-btn:hover { background: #d0d0d0; }
                .search-path-delete { color: #e74c3c; font-size: 20px; cursor: pointer; padding: 0 5px; }
            `;
    modal.appendChild(style);

    document.body.appendChild(modal);

    // 绑定设为随机源按钮事件
    modal.querySelectorAll('.set-base-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const index = parseInt(e.target.dataset.index);
            if (index >= 0 && index < searchDirs.length) {
                baseDir = searchDirs[index];

                // 保存配置
                await ipcRenderer.invoke('save-config', {
                    baseDir: baseDir,
                    searchDirs: searchDirs
                });

                showNotification(`已将随机阅读路径设置为: ${baseDir}`);

                // 刷新列表
                document.body.removeChild(modal);
                manageSearchPaths();
            }
        });
    });

    // 拖拽逻辑
    const list = modal.querySelector('#search-paths-list');
    let draggedItem = null;

    list.addEventListener('dragstart', (e) => {
        draggedItem = e.target.closest('.search-path-item');
        if (draggedItem) {
            draggedItem.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', draggedItem.dataset.index);
        }
    });

    list.addEventListener('dragend', () => {
        if (draggedItem) {
            draggedItem.classList.remove('dragging');
            draggedItem = null;

            // 重新构建数组
            const newSearchDirs = [];
            list.querySelectorAll('.search-path-item .search-path-text').forEach(span => {
                newSearchDirs.push(span.title || span.textContent);
            });

            // 检查是否有变化
            if (JSON.stringify(searchDirs) !== JSON.stringify(newSearchDirs)) {
                searchDirs = newSearchDirs;
                // 保存配置
                ipcRenderer.invoke('save-config', {
                    searchDirs: searchDirs
                }).then(() => {
                    // 重新渲染列表以更新索引
                    document.body.removeChild(modal);
                    manageSearchPaths();
                });
            }
        }
    });

    list.addEventListener('dragover', (e) => {
        e.preventDefault();
        const afterElement = getDragAfterElement(list, e.clientY);
        const draggable = document.querySelector('.dragging');
        if (draggable) {
            if (afterElement == null) {
                list.appendChild(draggable);
            } else {
                list.insertBefore(draggable, afterElement);
            }
        }
    });

    function getDragAfterElement(container, y) {
        const draggableElements = [...container.querySelectorAll('.search-path-item:not(.dragging)')];

        return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = y - box.top - box.height / 2;
            if (offset < 0 && offset > closest.offset) {
                return { offset: offset, element: child };
            } else {
                return closest;
            }
        }, { offset: Number.NEGATIVE_INFINITY }).element;
    }

    // 关闭按钮事件
    modal.querySelector('.modal-close').addEventListener('click', () => {
        document.body.removeChild(modal);
    });

    // 删除路径事件
    modal.querySelectorAll('.search-path-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            // 重新获取当前DOM中的索引，因为拖拽可能改变了顺序
            const item = e.target.closest('.search-path-item');
            const allItems = Array.from(list.querySelectorAll('.search-path-item'));
            const index = allItems.indexOf(item);

            if (index >= 0 && index < searchDirs.length) {
                // 如果是当前随机阅读路径，不允许删除
                if (searchDirs[index] === baseDir) {
                    showNotification('不能删除当前随机阅读路径，请先将其他路径设为随机源');
                    return;
                } searchDirs.splice(index, 1);

                // 保存配置
                await ipcRenderer.invoke('save-config', {
                    searchDirs: searchDirs
                });

                // 刷新列表
                manageSearchPaths();
                document.body.removeChild(modal);
            }
        });
    });

    // 添加路径事件
    modal.querySelector('#add-search-path').addEventListener('click', async () => {
        const newPath = await selectCustomPath();
        if (newPath) {
            document.body.removeChild(modal);
            manageSearchPaths();
        }
    });
}

// 选择自定义路径函数 - 仅选择路径，不加载书籍
async function selectCustomPath() {
    try {
        let newPath;
        if (isWebMode) {
            newPath = await showRemotePathSelector();
        } else {
            newPath = await ipcRenderer.invoke('select-directory');
        }

        if (newPath) {
            // 保存新路径作为默认路径
            baseDir = newPath;

            // 添加到搜索路径列表
            if (!searchDirs.includes(newPath)) {
                searchDirs.push(newPath);
            }

            // 保存配置
            await ipcRenderer.invoke('save-config', {
                baseDir: baseDir,
                searchDirs: searchDirs
            });

            showNotification(`已将随机阅读路径设置为: ${baseDir}`);
            return newPath;
        }
    } catch (error) {
        console.error('选择自定义路径失败:', error);
        if (error !== 'cancelled') {
            showNotification('选择路径失败: ' + error.message);
        }
    }
    return null;
}

// 更新进度条
function updateProgressBar() {
    let percentage = 0;

    if (chapters.length === 0) {
        // 如果没有章节，使用页码计算进度
        const totalPages = currentContent.length;
        if (totalPages > 1) {
            percentage = (currentPage / (totalPages - 1)) * 100;
        } else {
            percentage = 100; // 只有一页则显示100%
        }

        // 检查进度是否计算正确
        if (isNaN(percentage) || percentage < 0) {
            console.warn('进度计算出错:', currentPage, totalPages);
            percentage = 0;
        }
    } else {
        // 如果有章节，计算整体进度
        let totalCharsRead = 0;
        let totalChars = 0;

        // 计算所有已读章节的字符数
        for (let i = 0; i < currentChapter; i++) {
            totalCharsRead += chapters[i].content.length;
        }

        // 加上当前章节已读的字符数
        if (chapters[currentChapter]) {
            totalCharsRead += Math.min(
                currentPage * wordsPerPage,
                chapters[currentChapter].content.length
            );
        }

        // 计算所有章节的总字符数
        for (let i = 0; i < chapters.length; i++) {
            totalChars += chapters[i].content.length;
        }

        // 计算百分比
        if (totalChars > 0) {
            percentage = (totalCharsRead / totalChars) * 100;
        }
    }

    // 更新进度条和文本
    document.getElementById('progress-bar').style.width = `${Math.min(percentage, 100)}%`;
    document.getElementById('progress-percentage').textContent = `${Math.min(Math.round(percentage), 100)}%`;

    // 更新标题显示当前章节或页码
    if (chapters.length > 0 && chapters[currentChapter]) {
        const chapterTitle = chapters[currentChapter].title;
        const titleText = `${currentFileName.replace('.txt', '')} - ${chapterTitle}`;
        document.getElementById('book-title').textContent = titleText;
        const mobileTitle = document.getElementById('mobile-book-title');
        if (mobileTitle) mobileTitle.textContent = titleText;
    } else if (currentContent && currentContent.length > 0) {
        // 无章节时显示页码
        const titleText = `${currentFileName.replace('.txt', '')} - 第${currentPage + 1}/${currentContent.length}页`;
        document.getElementById('book-title').textContent = titleText;
        const mobileTitle = document.getElementById('mobile-book-title');
        if (mobileTitle) mobileTitle.textContent = titleText;
    }
}

// 修改showPage函数以更新进度条
const originalShowPage = showPage;
showPage = function (pageNum, chapterIndex) {
    originalShowPage(pageNum, chapterIndex);
    updateProgressBar();
}

// 修改showTextPage函数以更新进度条
const originalShowTextPage = showTextPage;
showTextPage = function (pageNum, totalPages) {
    originalShowTextPage(pageNum, totalPages);
    updateProgressBar();
}

// 修复滚动模式切换和显示
// 页面滚动模式
let pageMode = 'page'; // 默认分页模式

document.getElementById('page-turn-mode').addEventListener('change', function (e) {
    pageMode = e.target.value;
    const content = document.getElementById('content');

    if (pageMode === 'scroll') {
        // 切换到滚动模式
        content.style.overflowY = 'auto';
        content.style.maxHeight = '800px';
        content.classList.add('scroll-mode');

        // 隐藏翻页按钮
        document.querySelector('.navigation-buttons').style.display = 'none';

        // 显示所有内容
        showAllContent();
    } else {
        // 切换回分页模式
        content.style.overflowY = 'hidden';
        content.style.maxHeight = 'none';
        content.classList.remove('scroll-mode');

        // 显示翻页按钮
        document.querySelector('.navigation-buttons').style.display = 'flex';

        if (chapters.length > 0) {
            // 有章节时，显示当前章节
            showPage(currentPage, currentChapter);
        } else {
            // 无章节时，显示当前页
            const totalPages = currentContent.length;
            showTextPage(currentPage, totalPages);
        }
    }
});

// 修复显示所有内容的函数
function showAllContent(options = {}) {
    const content = document.getElementById('content');
    // 确保内容区域可见
    content.style.display = 'block';

    // 保存当前的滚动位置
    const savedScrollTop = content.scrollTop;
    const savedWindowScrollY = window.scrollY;

    content.innerHTML = '';

    if (chapters.length > 0) {
        // 有章节的情况
        for (let i = 0; i < chapters.length; i++) {
            const chapter = chapters[i];

            // 添加章节标题
            const titleElement = document.createElement('h3');
            titleElement.className = 'chapter-title';
            titleElement.textContent = chapter.title;
            content.appendChild(titleElement);

            // 添加章节内容
            const lines = chapter.content.split('\n');
            for (let line of lines) {
                if (line.trim()) {
                    const p = document.createElement('p');
                    p.textContent = line;
                    content.appendChild(p);
                } else {
                    content.innerHTML += '<p><br></p>';
                }
            }
        }
    } else if (currentContent && currentContent.length > 0) {
        // 无章节的情况，显示所有分页内容
        for (let i = 0; i < currentContent.length; i++) {
            // 添加页码标记
            const pageTitle = document.createElement('div');
            pageTitle.className = 'page-marker';
            pageTitle.textContent = `第 ${i + 1} 页`;
            content.appendChild(pageTitle);

            // 添加页面内容
            const pageText = currentContent[i];
            if (pageText) {
                const lines = pageText.split('\n');
                for (let line of lines) {
                    if (line.trim()) {
                        const p = document.createElement('p');
                        p.textContent = line;
                        content.appendChild(p);
                    } else {
                        content.innerHTML += '<p><br></p>';
                    }
                }
            } else {
                const p = document.createElement('p');
                p.textContent = '此页无内容';
                content.appendChild(p);
            }
        }
    } else {
        // 没有内容
        content.innerHTML = '<p>没有可显示的内容</p>';
    }

    if (options.isBackground) {
        // 后台更新，恢复滚动位置
        content.scrollTop = savedScrollTop;
        window.scrollTo(0, savedWindowScrollY);
    } else {
        // 滚动到当前阅读位置
        scrollToCurrentPosition();
    }
}

// 滚动到当前阅读位置
function scrollToCurrentPosition() {
    const content = document.getElementById('content');

    if (chapters.length === 0) {
        // 没有章节时，根据页码计算滚动位置
        const scrollPercentage = currentPage / Math.ceil(currentContent.length / wordsPerPage);
        content.scrollTop = content.scrollHeight * scrollPercentage;
    } else if (chapters[currentChapter]) {
        // 有章节时，查找当前章节标题并滚动到该位置
        const chapterTitles = content.querySelectorAll('.chapter-title');

        if (chapterTitles.length > currentChapter) {
            chapterTitles[currentChapter].scrollIntoView();

            // 计算章节内部滚动位置
            if (currentPage > 0) {
                const chapterContent = chapters[currentChapter].content;
                const totalPages = Math.ceil(chapterContent.length / wordsPerPage);
                const scrollOffset = (currentPage / totalPages) *
                    (chapters[currentChapter].content.length / wordsPerPage) * 24; // 估计每行高度24px

                content.scrollTop += scrollOffset;
            }
        }
    }
}

// 自定义右键菜单
const contextMenu = document.getElementById('context-menu');
const content = document.getElementById('content');

// 阻止默认右键菜单
content.addEventListener('contextmenu', function (e) {
    e.preventDefault();

    // 获取选中的文本
    const selectedText = window.getSelection().toString().trim();
    if (!selectedText) return;

    // 显示自定义菜单
    contextMenu.style.display = 'block';
    contextMenu.style.left = `${e.pageX}px`;
    contextMenu.style.top = `${e.pageY}px`;

    // 存储选中的文本
    contextMenu.dataset.selectedText = selectedText;
});

// 点击页面其他区域时隐藏菜单
document.addEventListener('click', function () {
    contextMenu.style.display = 'none';
});

// 复制选中文本
document.getElementById('menu-copy').addEventListener('click', function () {
    const selectedText = contextMenu.dataset.selectedText;
    if (selectedText) {
        navigator.clipboard.writeText(selectedText)
            .then(() => {
                showNotification('文本已复制到剪贴板');
            })
            .catch(err => {
                console.error('复制失败: ', err);
            });
    }
});

// 搜索选中文本
document.getElementById('menu-search').addEventListener('click', function () {
    const selectedText = contextMenu.dataset.selectedText;
    if (selectedText) {
        window.open(`https://www.baidu.com/s?wd=${encodeURIComponent(selectedText)}`, '_blank');
    }
});

// 翻译选中文本
document.getElementById('menu-translate').addEventListener('click', function () {
    const selectedText = contextMenu.dataset.selectedText;
    if (selectedText) {
        window.open(`https://fanyi.baidu.com/#zh/en/${encodeURIComponent(selectedText)}`, '_blank');
    }
});

// 朗读选中文本
document.getElementById('menu-tts').addEventListener('click', function () {
    const selectedText = contextMenu.dataset.selectedText;
    if (selectedText && 'speechSynthesis' in window) {
        const speech = new SpeechSynthesisUtterance(selectedText);
        speech.lang = 'zh-CN';
        window.speechSynthesis.speak(speech);
    } else {
        showNotification('您的浏览器不支持语音合成');
    }
});

// 通知提示
function showNotification(message) {
    const notification = document.createElement('div');
    notification.className = 'notification';
    notification.textContent = message;
    document.body.appendChild(notification);

    // 2秒后自动消失
    setTimeout(() => {
        notification.classList.add('fadeout');
        setTimeout(() => {
            document.body.removeChild(notification);
        }, 500);
    }, 2000);
}

// 添加清空历史记录的函数
function clearHistory() {
    if (confirm('确定要清空所有阅读历史吗？')) {
        localStorage.removeItem('readingHistory');

        // 清空所有书籍的阅读进度
        localStorage.removeItem('allBookProgress');

        // 更新界面
        updateHistoryDisplay();
        showNotification('已清空所有阅读历史');
    }
}

// 初始化函数
function debounce(func, delay) {
    let debounceTimer;
    return function () {
        const context = this;
        const args = arguments;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => func.apply(context, args), delay);
    }
}

function initApp() {
    console.log('App initializing...');

    // 屏幕常亮 (Wake Lock API)
    let wakeLock = null;
    const requestWakeLock = async () => {
        try {
            if ('wakeLock' in navigator) {
                wakeLock = await navigator.wakeLock.request('screen');
                console.log('屏幕常亮已激活');
            }
        } catch (err) {
            console.log('无法激活屏幕常亮:', err);
        }
    };

    // 页面可见性改变时重新申请
    document.addEventListener('visibilitychange', async () => {
        if (wakeLock !== null && document.visibilityState === 'visible') {
            await requestWakeLock();
        }
    });

    // 初始化时申请
    requestWakeLock();

    // 触摸手势支持 (左右滑动翻页)
    let touchStartX = 0;
    let touchStartY = 0;
    const contentArea = document.getElementById('content');

    contentArea.addEventListener('touchstart', e => {
        touchStartX = e.changedTouches[0].screenX;
        touchStartY = e.changedTouches[0].screenY;
    }, { passive: true });

    contentArea.addEventListener('touchend', e => {
        const touchEndX = e.changedTouches[0].screenX;
        const touchEndY = e.changedTouches[0].screenY;

        const diffX = touchEndX - touchStartX;
        const diffY = touchEndY - touchStartY;

        // 点击判定 (滑动距离很小)
        if (Math.abs(diffX) < 10 && Math.abs(diffY) < 10) {
            // 检查点击目标是否是交互元素
            const target = e.target;
            if (target.closest('button') ||
                target.closest('.history-item') ||
                target.closest('.setting-item') ||
                target.closest('.nav-btn') ||
                target.closest('.modal') ||
                target.closest('.context-menu')) {
                return;
            }

            // 获取点击位置相对于视口的坐标
            const clientX = e.changedTouches[0].clientX;
            const clientY = e.changedTouches[0].clientY;
            const screenWidth = window.innerWidth;
            const screenHeight = window.innerHeight;

            // 定义中间区域 (例如：宽度 30%-70%，高度 20%-80%)
            const isCenter = clientX > screenWidth * 0.3 && clientX < screenWidth * 0.7 &&
                clientY > screenHeight * 0.2 && clientY < screenHeight * 0.8;

            if (isCenter) {
                const sidebar = document.querySelector('.reader-sidebar');

                // 检查当前状态 (以侧边栏为准)
                const isSidebarActive = sidebar.classList.contains('active');

                if (isSidebarActive) {
                    // 隐藏侧边栏
                    sidebar.classList.remove('active');

                    // 隐藏子面板
                    document.getElementById('chapter-list').classList.add('hidden');
                    document.getElementById('font-settings-panel').classList.add('hidden');
                } else {
                    // 显示侧边栏
                    sidebar.classList.add('active');
                }
            }
            return;
        }                // 如果是滚动模式，不处理翻页手势
        if (pageMode === 'scroll') return;

        // 移除左右滑动翻页功能，防止误触
        /*
        if (Math.abs(diffX) > 50 && Math.abs(diffX) > Math.abs(diffY)) {
            if (diffX > 0) {
                // 向右滑 -> 上一页
                previousPage();
            } else {
                // 向左滑 -> 下一页
                nextPage();
            }
        }
        */
    }, { passive: true });

    // 绑定事件监听
    const randomButton = document.getElementById('random-book-btn');
    if (randomButton) {
        // 提取显示菜单的逻辑
        const showRandomMenu = (x, y) => {
            // 移除已存在的菜单
            const existingMenu = document.getElementById('random-context-menu');
            if (existingMenu) existingMenu.remove();

            // 创建右键菜单
            const menu = document.createElement('div');
            menu.className = 'context-menu';
            menu.id = 'random-context-menu';
            menu.innerHTML = `
                <div class="context-menu-item" onclick="resetRandomState()">
                    重置随机状态
                </div>
                <div class="context-menu-item" onclick="selectCustomPath()">
                    选择随机目录
                </div>
            `;

            menu.style.left = x + 'px';
            menu.style.top = y + 'px';

            // 添加到页面
            document.body.appendChild(menu);

            // 点击其他地方关闭菜单
            function closeMenu() {
                if (menu && menu.parentNode) {
                    menu.parentNode.removeChild(menu);
                }
                document.removeEventListener('click', closeMenu);
            }
            // 延迟绑定关闭事件，防止立即触发
            setTimeout(() => document.addEventListener('click', closeMenu), 0);
        };

        // 使用 onclick 属性以确保覆盖旧的事件处理，避免重复绑定
        randomButton.onclick = function (e) {
            console.log('Random button clicked');
            // 检查是否按住了Ctrl键
            const useCustomPath = e.ctrlKey;
            loadRandomBook(useCustomPath);
        };

        // 添加长按事件支持（针对移动端）
        let pressTimer;
        let isLongPress = false;

        randomButton.addEventListener('touchstart', (e) => {
            isLongPress = false;
            pressTimer = setTimeout(() => {
                isLongPress = true;
                // 触发菜单逻辑
                const touch = e.touches[0];
                showRandomMenu(touch.pageX, touch.pageY);
            }, 800); // 800ms 长按
        }, { passive: true });

        randomButton.addEventListener('touchend', (e) => {
            clearTimeout(pressTimer);
            if (isLongPress) {
                // 如果是长按，阻止默认点击行为（虽然 passive 不能阻止，但我们可以通过标志位控制）
                // 注意：touchend 无法阻止 click 事件，因为 touchstart 是 passive 的
                // 我们需要在 click 事件中检查 isLongPress
                e.preventDefault(); // 尝试阻止（如果不是 passive）
            }
        }, { passive: false }); // 改为 false 以便调用 preventDefault

        randomButton.addEventListener('touchmove', () => {
            clearTimeout(pressTimer);
        }, { passive: true });

        // 拦截点击事件，如果是长按触发的，则不执行点击逻辑
        const originalClick = randomButton.onclick;
        randomButton.onclick = function (e) {
            if (isLongPress) {
                isLongPress = false;
                return;
            }
            if (originalClick) originalClick.call(this, e);
        };

        // 右键菜单 (PC端)
        randomButton.oncontextmenu = function (e) {
            e.preventDefault();
            const pageX = e.pageX || (e.clientX ? e.clientX + window.scrollX : 0);
            const pageY = e.pageY || (e.clientY ? e.clientY + window.scrollY : 0);
            showRandomMenu(pageX, pageY);
        };
    } else {
        console.error('Random button not found');
    }

    const libraryButton = document.getElementById('library-btn');
    const mobileLibraryButton = document.getElementById('mobile-library-btn-top');

    const handleLibraryClick = async function (e) {
        console.log('Library button clicked');
        if (e.ctrlKey) {
            // 按住 Ctrl 键，设置书库路径
            await setLibraryPath();
        } else {
            // 普通点击，显示书库
            showServerLibrary();
        }
    };

    if (libraryButton) {
        libraryButton.onclick = handleLibraryClick;
    }
    if (mobileLibraryButton) {
        mobileLibraryButton.onclick = handleLibraryClick;
    }

    // 应用存储的字体设置
    applyStoredSettings();

    // 尝试从云端加载历史记录并合并
    syncCloudHistory();

    // 更新历史记录显示
    updateHistoryDisplay();

    // 加载配置
    loadConfig().catch(err => console.error('配置加载失败:', err));

    // 添加滚动监听，用于在滚动模式下实时保存进度
    const content = document.getElementById('content');
    content.addEventListener('scroll', debounce(function () {
        if (pageMode === 'scroll' && chapters.length > 0) {
            const chapterTitles = content.querySelectorAll('.chapter-title');
            let activeChapterIndex = 0;

            // 找到当前视口顶部的章节
            // 优化：二分查找或从当前章节附近查找会更快，但这里简单遍历也行，因为章节数通常不会太多
            // 为了性能，我们可以假设用户不会瞬间跳跃太远，从 currentChapter 开始搜索

            // 简单遍历所有章节标题找到当前可见的
            // 注意：chapterTitles 是 NodeList
            for (let i = 0; i < chapterTitles.length; i++) {
                const title = chapterTitles[i];
                // 如果标题在视口上方或视口内靠上位置
                if (title.offsetTop <= content.scrollTop + 100) {
                    activeChapterIndex = i;
                } else {
                    // 标题在视口下方，说明上一个是当前章节
                    break;
                }
            }

            // 更新当前章节
            if (activeChapterIndex !== currentChapter) {
                currentChapter = activeChapterIndex;
            }

            // 计算当前章节内的进度（估算页码）
            const currentTitle = chapterTitles[activeChapterIndex];
            // 下一个章节标题，如果没有则是内容底部
            const nextTitle = chapterTitles[activeChapterIndex + 1];

            const chapterStart = currentTitle.offsetTop;
            const chapterEnd = nextTitle ? nextTitle.offsetTop : content.scrollHeight;
            const chapterHeight = chapterEnd - chapterStart;

            // 当前滚动位置相对于章节顶部的偏移
            const scrollOffset = content.scrollTop - chapterStart;

            if (chapterHeight > 0) {
                // 计算进度比例 (0.0 - 1.0)
                const progress = Math.max(0, Math.min(1, scrollOffset / chapterHeight));

                const chapterContent = chapters[activeChapterIndex].content;
                const totalPages = Math.ceil(chapterContent.length / wordsPerPage);

                // 更新 currentPage
                currentPage = Math.floor(progress * totalPages);
            }

            // 保存进度 (debounce 确保不会频繁写入)
            saveProgress();
        }
    }, 500));
}

// 尝试立即初始化（如果脚本在body底部）
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}

// 全局按键监听
document.addEventListener('keydown', function (e) {
    // ESC键处理
    if (e.key === 'Escape') {
        // 1. 如果目录打开，关闭目录
        const chapterList = document.getElementById('chapter-list');
        if (chapterList && !chapterList.classList.contains('hidden')) {
            chapterList.classList.add('hidden');
            // 不 return，继续执行以返回主页
        }

        // 2. 如果有模态框打开，关闭模态框
        const modals = document.querySelectorAll('.modal');
        let modalClosed = false;
        modals.forEach(modal => {
            if (modal.parentNode) {
                // 模态框通常有自己的关闭逻辑，这里只检测是否存在
                // 如果存在，说明用户是在与模态框交互，ESC 应该只关闭模态框
                modalClosed = true;
            }
        });

        // 如果有模态框，ESC 只负责关闭模态框（由模态框内部逻辑处理），不返回主页
        if (modalClosed) return;

        // 3. 如果没有模态框，执行返回主页
        if (currentFileName) {
            backToHome();
        }
    }
});

// 设置书库路径
async function setLibraryPath() {
    try {
        let newPath;

        if (isWebMode) {
            // Web 模式下，使用自定义的远程目录选择器
            newPath = await showRemotePathSelector();
        } else {
            // Electron 模式下，打开选择对话框
            newPath = await ipcRenderer.invoke('select-directory');
        }

        if (newPath) {
            // 保存配置
            await ipcRenderer.invoke('save-config', {
                libraryDir: newPath
            });
            showNotification(`已设置书库路径: ${newPath}`);
        }
    } catch (error) {
        console.error('设置书库路径失败:', error);
        if (error !== 'cancelled') {
            showNotification('设置书库路径失败: ' + error.message);
        }
    }
}

// 显示远程目录选择器
function showRemotePathSelector() {
    return new Promise(async (resolve, reject) => {
        // 获取初始路径
        let currentPath = '';
        try {
            const config = await ipcRenderer.invoke('load-config');
            currentPath = config.libraryDir || config.baseDir || '';
        } catch (e) { }

        const modal = document.createElement('div');
        modal.className = 'modal';

        // 渲染列表函数
        async function renderList(path) {
            const listContainer = modal.querySelector('.file-list');
            const pathDisplay = modal.querySelector('.current-path');

            listContainer.innerHTML = '<div class="loading-spinner" style="margin: 20px auto;"></div>';

            try {
                const result = await ipcRenderer.invoke('list-directory', path);

                if (result.error) {
                    showNotification('无法访问目录: ' + result.error);
                    // 如果出错，尝试回退到根目录或上级
                    return;
                }

                currentPath = result.currentPath;
                pathDisplay.textContent = currentPath;
                pathDisplay.title = currentPath;

                listContainer.innerHTML = result.items.map(item => `
                            <div class="file-item ${item.isParent ? 'parent-dir' : ''}" data-path="${item.path.replace(/"/g, '&quot;')}">
                                <span class="file-icon">${item.isParent ? '⬆️' : '📁'}</span>
                                <span class="file-name">${item.name}</span>
                            </div>
                        `).join('');

                // 绑定点击事件
                listContainer.querySelectorAll('.file-item').forEach(item => {
                    item.addEventListener('click', () => {
                        renderList(item.dataset.path);
                    });
                });

            } catch (error) {
                listContainer.innerHTML = `<div style="color:red; padding:10px;">加载失败: ${error.message}</div>`;
            }
        }

        modal.innerHTML = `
                    <div class="modal-content path-selector-modal">
                        <div class="modal-header">
                            <h3>选择服务器文件夹</h3>
                            <span class="modal-close">&times;</span>
                        </div>
                        <div class="path-display-container">
                            <div class="current-path">正在加载...</div>
                        </div>
                        <div class="modal-body custom-scrollbar">
                            <div class="file-list"></div>
                        </div>
                        <div class="modal-footer">
                            <button class="cancel-btn">取消</button>
                            <button class="confirm-btn">选择此目录</button>
                        </div>
                    </div>
                `;

        // 添加样式
        const style = document.createElement('style');
        style.textContent = `
                    .path-selector-modal {
                        width: 500px;
                        max-width: 90vw;
                        height: 600px;
                        max-height: 80vh;
                        display: flex;
                        flex-direction: column;
                        border-radius: 8px;
                        background: var(--bg-color, #fff);
                    }
                    .dark-mode .path-selector-modal {
                        background: #2d2d2d;
                        border: 1px solid #444;
                    }
                    .path-display-container {
                        padding: 10px 15px;
                        background: rgba(0,0,0,0.03);
                        border-bottom: 1px solid #eee;
                    }
                    .dark-mode .path-display-container {
                        background: rgba(255,255,255,0.03);
                        border-bottom-color: #444;
                    }
                    .current-path {
                        font-family: monospace;
                        white-space: nowrap;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        font-size: 14px;
                        color: #666;
                    }
                    .dark-mode .current-path { color: #aaa; }
                    
                    .file-list { display: flex; flex-direction: column; }
                    .file-item {
                        display: flex;
                        align-items: center;
                        padding: 10px 15px;
                        cursor: pointer;
                        border-bottom: 1px solid #f5f5f5;
                    }
                    .dark-mode .file-item { border-bottom-color: #3d3d3d; }
                    .file-item:hover { background-color: rgba(0,0,0,0.05); }
                    .dark-mode .file-item:hover { background-color: rgba(255,255,255,0.05); }
                    
                    .parent-dir { background-color: rgba(0,0,0,0.02); font-weight: bold; }
                    .dark-mode .parent-dir { background-color: rgba(255,255,255,0.02); }
                    
                    .file-icon { margin-right: 10px; font-size: 18px; }
                    .file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                    
                    .modal-footer {
                        padding: 15px;
                        border-top: 1px solid #eee;
                        display: flex;
                        justify-content: flex-end;
                        gap: 10px;
                    }
                    .dark-mode .modal-footer { border-top-color: #444; }
                    
                    .confirm-btn, .cancel-btn {
                        padding: 8px 16px;
                        border-radius: 4px;
                        cursor: pointer;
                        border: none;
                        font-size: 14px;
                    }
                    .confirm-btn { background: #3498db; color: white; }
                    .confirm-btn:hover { background: #2980b9; }
                    .cancel-btn { background: #e0e0e0; color: #333; }
                    .cancel-btn:hover { background: #d0d0d0; }
                    .dark-mode .cancel-btn { background: #444; color: #ddd; }
                    .dark-mode .cancel-btn:hover { background: #555; }
                `;
        modal.appendChild(style);
        document.body.appendChild(modal);

        // 初始加载
        await renderList(currentPath);

        // 绑定按钮事件
        const close = () => {
            if (modal.parentNode) modal.parentNode.removeChild(modal);
            document.removeEventListener('keydown', handleEsc, { capture: true });
        };

        // ESC 键关闭
        const handleEsc = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close();
                reject('cancelled');
            }
        };
        document.addEventListener('keydown', handleEsc, { capture: true });

        modal.querySelector('.modal-close').addEventListener('click', () => {
            close();
            reject('cancelled');
        });

        modal.querySelector('.cancel-btn').addEventListener('click', () => {
            close();
            reject('cancelled');
        });

        modal.querySelector('.confirm-btn').addEventListener('click', () => {
            close();
            resolve(currentPath);
        });

        // 点击遮罩关闭
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                close();
                reject('cancelled');
            }
        });
    });
}

// 修改加载配置的函数
async function loadConfig() {
    try {
        const config = await ipcRenderer.invoke('load-config');
        // 使用配置值
        baseDir = config.baseDir || '';
        searchDirs = config.searchDirs || [];

        // 确保当前baseDir也在searchDirs中
        if (!searchDirs.includes(baseDir)) {
            searchDirs.push(baseDir);
        }

        wordsPerPage = config.wordsPerPage || 4000;
        fontSize = config.fontSize || 18;
        homePageFontSize = config.homePageFontSize || 16;

        // 应用主题设置
        if (config.theme === 'dark') {
            document.body.classList.add('dark-mode');
        }

        // 根据当前模式应用字体大小
        if (currentFileName) {
            // 阅读模式
            document.getElementById('content').style.fontSize = fontSize + 'px';
        } else {
            // 主页模式
            applyHomePageFontSize();
        }

        // 如果配置中禁用了某些功能，可以隐藏对应按钮
        if (config.hideRandomButton) {
            const randomButton = document.getElementById('random-book-btn');
            if (randomButton) {
                randomButton.style.display = 'none';
            }
        }
    } catch (error) {
        console.error('加载配置失败:', error);
    }
}

// 修改保存进度的函数，确保保存章节信息，支持多本书
function saveProgress() {
    if (!currentFileName) return; // 如果没有打开文件，不保存

    // 检查是否处于预览模式
    // 如果正在后台加载或处于预览模式，不要保存进度，以免覆盖正确的历史记录
    if (window.isPreviewMode || document.getElementById('loading-overlay').style.display !== 'none') {
        console.log('正在加载或预览中，跳过保存进度');
        return;
    }

    // 获取所有书籍的进度记录
    const progressKey = getStorageKey('allBookProgress');
    let allBookProgress = JSON.parse(localStorage.getItem(progressKey)) || {};

    // 更新当前书籍的进度
    allBookProgress[currentFileName] = {
        page: currentPage,
        chapter: chapters.length > 0 ? currentChapter : 0,  // 如果没有章节，章节号始终为0
        lastRead: new Date().toISOString(),
        hasChapters: chapters.length > 0  // 记录是否有章节
    };

    // 保存所有书籍的进度
    localStorage.setItem(progressKey, JSON.stringify(allBookProgress));

    // 更新历史记录
    addToHistory({
        fileName: currentFileName,
        filePath: window.currentFilePath, // 保存完整路径
        date: new Date().toLocaleString(),
        lastPosition: currentPage,
        chapter: chapters.length > 0 ? currentChapter : 0  // 如果没有章节，章节号始终为0
    });
}

// 清理书籍缓存
async function clearBookCache() {
    if (confirm('确定要清空所有书籍缓存吗？\n这将释放本地空间，但下次打开书籍需要重新下载。')) {
        try {
            if (isWebMode) {
                await webBookCache.clear();
            } else {
                // Electron 模式暂未实现清理接口，或者可以手动删除文件夹
                // 这里简单提示
                alert('Electron 模式请手动清理缓存文件夹');
                return;
            }
            showNotification('缓存已清空');
        } catch (error) {
            console.error('清理缓存失败:', error);
            showNotification('清理缓存失败: ' + error.message);
        }
    }
}

// 添加返回主页函数
function backToHome(event) {
    // 检查是否按下了 Ctrl 键
    if (event && event.ctrlKey) {
        toggleProfile();
        return;
    }

    currentFileName = '';
    currentPage = 0;
    currentChapter = 0;
    chapters = [];

    // 重置标题
    document.getElementById('book-title').textContent = '优雅阅读器';
    const mobileTitle = document.getElementById('mobile-book-title');
    if (mobileTitle) mobileTitle.textContent = '优雅阅读器';

    updateHistoryDisplay();

    // 滚动到顶部，确保首页从顶部开始
    window.scrollTo(0, 0);
    const content = document.getElementById('content');
    if (content) content.scrollTop = 0;

    // 应用主页字体大小
    applyHomePageFontSize();
}

// 添加随机阅读相关函数
async function loadRandomBook(useCustomPath = false) {
    try {
        // 如果按住Ctrl键点击，只允许用户选择自定义路径，不加载书籍
        if (useCustomPath) {
            await selectCustomPath();
            return; // 选择完路径后直接返回，不加载书籍
        }

        // 检查 baseDir 是否有效，如果无效则提示选择
        if (!baseDir) {
            // 尝试重新加载配置
            await loadConfig();

            // 如果仍然无效，直接打开路径选择器
            if (!baseDir) {
                if (confirm('尚未设置随机阅读路径，是否现在设置？')) {
                    await selectCustomPath();
                }
                return;
            }
        }

        // 显示加载中状态
        document.getElementById('loading-overlay').style.display = 'flex';
        document.querySelector('.loading-message').textContent = '正在随机获取书籍...';

        // 强制UI渲染
        await new Promise(resolve => requestAnimationFrame(resolve));

        // 获取随机文件
        console.log('正在获取随机文件，路径:', baseDir);
        const filePath = await ipcRenderer.invoke('get-random-file', baseDir);
        if (!filePath) {
            throw new Error('没有找到任何 TXT 文件');
        }

        // 使用智能加载
        const fileName = filePath.split(/[/\\]/).pop();
        await loadAndRenderBook(filePath, fileName);

    } catch (error) {
        console.error('加载随机书籍失败:', error);
        alert('加载随机书籍失败: ' + error.message);
        document.getElementById('loading-overlay').style.display = 'none';
    }
}

// 切换移动端侧边栏
function toggleMobileSidebar() {
    const sidebar = document.querySelector('.reader-sidebar');
    sidebar.classList.toggle('active');
}

// 添加打开文件所在位置的函数
async function openFileLocation(fileName) {
    try {
        document.getElementById('loading-overlay').style.display = 'flex';
        document.querySelector('.loading-message').textContent = `正在查找文件: ${fileName}...`;

        // 在所有搜索路径中查找文件
        const searchPaths = [baseDir].concat(searchDirs);

        // 查找文件并打开其所在目录
        const result = await ipcRenderer.invoke('find-and-open-file-location', searchPaths, fileName);

        if (result.success) {
            showNotification(`已打开文件所在位置: ${result.filePath}`);
        } else {
            showNotification(`找不到文件: ${fileName}`);
        }

        document.getElementById('loading-overlay').style.display = 'none';
    } catch (error) {
        console.error('打开文件位置失败:', error);
        showNotification('打开文件位置失败: ' + error.message);
        document.getElementById('loading-overlay').style.display = 'none';
    }
}

// 添加重置随机状态的函数
async function resetRandomState() {
    try {
        document.getElementById('loading-overlay').style.display = 'flex';
        document.querySelector('.loading-message').textContent = '正在重置随机状态...';

        const result = await ipcRenderer.invoke('reset-random-state');

        if (result) {
            showNotification('随机状态已重置，所有书籍将重新参与随机');
        } else {
            showNotification('重置随机状态失败');
        }

        document.getElementById('loading-overlay').style.display = 'none';
    } catch (error) {
        console.error('重置随机状态失败:', error);
        showNotification('重置随机状态失败: ' + error.message);
        document.getElementById('loading-overlay').style.display = 'none';
    }
}

// 显示服务器书库
async function showServerLibrary() {
    try {
        document.getElementById('loading-overlay').style.display = 'flex';
        document.querySelector('.loading-message').textContent = '正在获取书库...';

        const files = await ipcRenderer.invoke('get-file-list');

        document.getElementById('loading-overlay').style.display = 'none';

        if (!files || files.length === 0) {
            showNotification('书库为空，请上传小说到 books 目录');
            return;
        }

        // 禁止背景滚动
        document.body.style.overflow = 'hidden';

        // 创建模态框显示列表
        const modal = document.createElement('div');
        modal.className = 'modal';

        // 递归生成文件树 HTML
        function generateTreeHtml(items, level = 0) {
            if (!items || items.length === 0) return '';

            return items.map(item => {
                const paddingLeft = level * 24 + 10; // 增加缩进
                if (item.type === 'directory') {
                    return `
                                <div class="tree-item directory collapsed">
                                    <div class="tree-content" style="padding-left: ${paddingLeft}px">
                                        <span class="tree-icon">📁</span>
                                        <span class="tree-name">${item.name}</span>
                                        <span class="tree-meta">${item.children.length} 项</span>
                                    </div>
                                    <div class="tree-children" style="display: none;">
                                        ${generateTreeHtml(item.children, level + 1)}
                                    </div>
                                </div>
                            `;
                } else {
                    return `
                                <div class="tree-item file" 
                                     data-path="${item.path.replace(/"/g, '&quot;')}" 
                                     data-name="${item.name.replace(/"/g, '&quot;')}"
                                     data-size="${item.size}"
                                     data-mtime="${item.mtime || 0}">
                                    <div class="tree-content" style="padding-left: ${paddingLeft}px">
                                        <span class="tree-icon">📄</span>
                                        <span class="tree-name">${item.name}</span>
                                        <span class="tree-meta">${(item.size / 1024 / 1024).toFixed(2)} MB</span>
                                    </div>
                                </div>
                            `;
                }
            }).join('');
        }

        modal.innerHTML = `
                    <div class="modal-content library-modal">
                        <div class="modal-header">
                            <h3>云端书库</h3>
                            <span class="modal-close">&times;</span>
                        </div>
                        <div class="modal-body custom-scrollbar">
                            <div class="file-tree">
                                ${generateTreeHtml(files)}
                            </div>
                        </div>
                    </div>
                `;

        // 添加样式
        const style = document.createElement('style');
        style.textContent = `
                    .library-modal {
                        max-width: 600px; 
                        max-height: 85vh; 
                        display: flex; 
                        flex-direction: column;
                        border-radius: 12px;
                        box-shadow: 0 10px 30px rgba(0,0,0,0.2);
                        overflow: hidden;
                        background: var(--bg-color, #fff);
                    }
                    .dark-mode .library-modal {
                        background: #2d2d2d;
                        border: 1px solid #444;
                    }
                    
                    .modal-header {
                        padding: 16px 24px;
                        border-bottom: 1px solid #eee;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        background: rgba(0,0,0,0.02);
                    }
                    .dark-mode .modal-header {
                        border-bottom-color: #444;
                        background: rgba(255,255,255,0.02);
                    }
                    .modal-header h3 { margin: 0; font-size: 18px; font-weight: 600; }
                    
                    .modal-body {
                        overflow-y: auto;
                        flex: 1;
                        padding: 10px 0;
                    }
                    
                    /* 自定义滚动条 */
                    .custom-scrollbar::-webkit-scrollbar { width: 6px; }
                    .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
                    .custom-scrollbar::-webkit-scrollbar-thumb { background-color: rgba(0,0,0,0.2); border-radius: 3px; }
                    .custom-scrollbar::-webkit-scrollbar-thumb:hover { background-color: rgba(0,0,0,0.3); }
                    .dark-mode .custom-scrollbar::-webkit-scrollbar-thumb { background-color: rgba(255,255,255,0.2); }
                    
                    .file-tree { display: flex; flex-direction: column; }
                    .tree-item { cursor: pointer; user-select: none; }
                    
                    .tree-content { 
                        display: flex; 
                        align-items: center; 
                        padding: 10px 16px 10px 0; /* Left padding is inline */
                        transition: background-color 0.15s;
                        border-left: 3px solid transparent;
                    }
                    .tree-content:hover { 
                        background: rgba(0,0,0,0.04); 
                        border-left-color: var(--primary-color, #3498db);
                    }
                    .dark-mode .tree-content:hover { background: rgba(255,255,255,0.05); }
                    
                    .tree-icon { margin-right: 12px; font-size: 20px; width: 24px; text-align: center; }
                    .tree-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
                    .tree-meta { font-size: 12px; color: #999; margin-left: 12px; min-width: 60px; text-align: right; }
                    
                    .directory .tree-icon { color: #f39c12; }
                    .file .tree-icon { color: #3498db; }
                    .dark-mode .file .tree-icon { color: #5dade2; }
                `;
        modal.appendChild(style);

        document.body.appendChild(modal);

        // 关闭函数
        const closeModal = () => {
            document.body.style.overflow = ''; // 恢复滚动
            if (modal.parentNode) modal.parentNode.removeChild(modal);
            // 移除 ESC 监听
            document.removeEventListener('keydown', handleEsc, { capture: true });
        };

        // ESC 键关闭
        const handleEsc = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                closeModal();
            }
        };
        // 使用 capture: true 确保在全局监听器之前捕获
        document.addEventListener('keydown', handleEsc, { capture: true });

        modal.querySelector('.modal-close').addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });

        // 绑定文件夹点击事件（展开/折叠）
        modal.querySelectorAll('.directory > .tree-content').forEach(header => {
            header.addEventListener('click', (e) => {
                e.stopPropagation();
                const parent = header.parentElement;
                const childrenContainer = parent.querySelector('.tree-children');
                const icon = header.querySelector('.tree-icon');

                if (childrenContainer.style.display === 'none') {
                    childrenContainer.style.display = 'block';
                    icon.textContent = '📂'; // 打开状态图标
                    parent.classList.remove('collapsed');
                    parent.classList.add('expanded');
                } else {
                    childrenContainer.style.display = 'none';
                    icon.textContent = '📁'; // 关闭状态图标
                    parent.classList.remove('expanded');
                    parent.classList.add('collapsed');
                }
            });
        });

        // 绑定文件点击事件
        modal.querySelectorAll('.file').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const path = item.getAttribute('data-path');
                const name = item.getAttribute('data-name');
                const size = parseInt(item.getAttribute('data-size') || '0');
                const mtime = parseInt(item.getAttribute('data-mtime') || '0');

                loadServerBook(path, name, { size, mtime });
                closeModal();
            });
        });

    } catch (error) {
        document.getElementById('loading-overlay').style.display = 'none';
        console.error('获取书库失败:', error);
        showNotification('获取书库失败');
    }
}

async function loadServerBook(filePath, fileName, fileInfo = null) {
    try {
        await loadAndRenderBook(filePath, fileName, 0, 0, fileInfo);
    } catch (error) {
        console.error('加载书籍失败:', error);
        showNotification('加载书籍失败: ' + error.message);
    }
}

// 智能加载书籍（支持大文件分片加载）
async function loadAndRenderBook(filePath, fileName, initialPosition = 0, initialChapter = 0, fileInfo = null) {
    try {
        document.getElementById('loading-overlay').style.display = 'flex';
        document.querySelector('.loading-message').textContent = `正在加载: ${fileName}...`;

        // 保存当前文件路径供后续使用
        window.currentFilePath = filePath;

        // 尝试从缓存加载
        try {
            // 如果提供了 fileInfo (包含 size 和 mtime)，则可以直接生成 key，避免一次网络请求
            let cachedData = null;
            if (fileInfo && fileInfo.size && fileInfo.mtime && isWebMode) {
                const cacheKey = `${filePath}-${fileInfo.size}-${fileInfo.mtime}`;
                console.log('使用预知信息检查缓存:', cacheKey);
                cachedData = await webBookCache.get(cacheKey);
            } else {
                cachedData = await ipcRenderer.invoke('check-book-cache', filePath);
            }

            if (cachedData && cachedData.chapters && cachedData.chapters.length > 0) {
                console.log('命中缓存，使用缓存数据');
                chapters = cachedData.chapters;
                currentFileName = fileName;
                window.isPreviewMode = false;
                window.waitingForHistory = false;

                // 更新UI
                const titleText = fileName.replace('.txt', '');
                document.getElementById('book-title').textContent = titleText;
                const mobileTitle = document.getElementById('mobile-book-title');
                if (mobileTitle) mobileTitle.textContent = titleText;
                document.getElementById('content').style.display = 'block';

                updateChapterList(); // 标记为 dirty，实际渲染延迟到打开菜单时
                isChapterListDirty = true;
                document.querySelector('.navigation-buttons').style.display = 'flex';
                document.querySelector('.progress-indicator').style.display = 'block';

                // 恢复进度逻辑
                const progressKey = getStorageKey('allBookProgress');
                const allBookProgress = JSON.parse(localStorage.getItem(progressKey)) || {};
                let targetChapter = 0;
                let targetPage = 0;

                if (initialPosition > 0 || initialChapter > 0) {
                    targetPage = initialPosition;
                    targetChapter = initialChapter;
                    // 更新进度记录
                    allBookProgress[fileName] = {
                        page: targetPage,
                        chapter: targetChapter,
                        lastRead: new Date().toISOString(),
                        hasChapters: true
                    };
                    localStorage.setItem(progressKey, JSON.stringify(allBookProgress));
                } else if (allBookProgress[fileName]) {
                    targetChapter = allBookProgress[fileName].chapter || 0;
                    targetPage = allBookProgress[fileName].page || 0;
                }

                // 显示页面
                if (pageMode === 'scroll') {
                    showAllContent();
                } else {
                    showPage(targetPage, targetChapter);
                }

                addToHistory({
                    fileName: fileName,
                    filePath: filePath,
                    date: new Date().toLocaleString(),
                    lastPosition: targetPage,
                    chapter: targetChapter
                });

                document.querySelector('.loading-message').textContent = '加载完成';
                document.getElementById('loading-overlay').style.display = 'none';

                // 移动端自动进入沉浸模式
                if (window.innerWidth <= 768) {
                    document.querySelector('.reader-sidebar').classList.add('controls-hidden');
                }
                return;
            }
        } catch (cacheError) {
            console.error('检查缓存失败:', cacheError);
        }

        // 设置全局预览模式标志，防止在预览期间保存进度
        window.isPreviewMode = true;
        // 重置等待历史记录标志
        window.waitingForHistory = false;

        // 如果提供了初始位置，更新 allBookProgress
        // 这样后台加载完成后，detectChapters 能读取到正确的进度
        if (initialPosition > 0 || initialChapter > 0) {
            const progressKey = getStorageKey('allBookProgress');
            const allBookProgress = JSON.parse(localStorage.getItem(progressKey)) || {};
            allBookProgress[fileName] = {
                page: initialPosition,
                chapter: initialChapter,
                lastRead: new Date().toISOString(),
                hasChapters: true // 假设有章节，detectChapters 会修正
            };
            localStorage.setItem(progressKey, JSON.stringify(allBookProgress));
        }

        // 强制UI渲染
        await new Promise(resolve => requestAnimationFrame(resolve));

        // 直接加载完整文件
        const data = await ipcRenderer.invoke('read-file', filePath);

        let arrayBuffer;
        if (data.buffer) {
            arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        } else {
            arrayBuffer = new Uint8Array(data).buffer;
        }

        // 普通加载不是预览模式
        window.isPreviewMode = false;
        await processFileContent(arrayBuffer, fileName);

    } catch (error) {
        console.error('加载书籍失败:', error);
        showNotification('加载书籍失败: ' + error.message);
        document.getElementById('loading-overlay').style.display = 'none';
        window.isPreviewMode = false; // 出错重置
    }
}        // 处理文件内容（复用现有的 Worker 逻辑）
function processFileContent(buffer, fileName, options = {}) {
    return new Promise((resolve, reject) => {
        // 只有在非后台加载时才显示遮罩
        if (!options.isBackground) {
            document.getElementById('loading-overlay').style.display = 'flex';
            document.querySelector('.loading-message').textContent = '正在处理文件内容...';
        }

        currentFileName = fileName;

        const fileWorker = createFileWorker();

        fileWorker.onmessage = function (e) {
            // 如果当前文件名不匹配（说明用户已经切换了书籍或退出了），则不处理结果
            if (currentFileName !== fileName) {
                console.log('文件处理结果已过期，忽略');
                return;
            }

            const result = e.data;
            if (result.error) {
                console.error("文件处理错误:", result.error);
                if (!options.isBackground) {
                    alert("文件处理失败: " + result.error);
                    document.getElementById('loading-overlay').style.display = 'none';
                }
                reject(result.error);
                return;
            }

            const text = result.text;
            const encoding = result.encoding || '未知';

            if (!options.isPreview && !options.isBackground) {
                showNotification(`检测到文件编码: ${encoding}`);
            }

            const progressKey = getStorageKey('allBookProgress');
            const allBookProgress = JSON.parse(localStorage.getItem(progressKey)) || {};
            if (allBookProgress[currentFileName]) {
                currentPage = allBookProgress[currentFileName].page;
                currentChapter = allBookProgress[currentFileName].chapter;
            } else {
                currentPage = 0;
                currentChapter = 0;
            }

            // 只有在非后台加载时才更新标题，防止闪烁
            if (!options.isBackground) {
                const titleText = fileName.replace('.txt', '');
                document.getElementById('book-title').textContent = titleText;
                const mobileTitle = document.getElementById('mobile-book-title');
                if (mobileTitle) mobileTitle.textContent = titleText;
                document.querySelector('.loading-message').textContent = '正在分析章节结构...';
            }

            document.getElementById('content').style.display = 'block';

            // 显示阅读控制栏
            const controls = document.querySelector('.reader-controls');
            if (controls) controls.style.display = 'block';

            // 确保翻页按钮在分页模式下可见
            if (pageMode === 'page') {
                const navButtons = document.querySelector('.navigation-buttons');
                if (navButtons) navButtons.style.display = 'flex';
            }

            detectChapters(text, options);

            addToHistory({
                fileName: currentFileName,
                filePath: window.currentFilePath,
                date: new Date().toLocaleString(),
                lastPosition: currentPage,
                chapter: currentChapter
            });

            resolve();
        }; fileWorker.postMessage({
            buffer: buffer,
            fileName: fileName
        });
    });
}


