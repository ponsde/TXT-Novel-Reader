const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');
const os = require('os');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = getListenHost();
const fsPromises = fs.promises;

// 模拟 Electron 的 app.getPath('exe')
// 在 Web 模式下，我们使用当前目录作为基准
const BASE_DIR = __dirname;
const RANDOM_STATE_FILE = 'random_state.json';
const CONFIG_FILE = 'config.json';

// 全局变量
// key: baseDir, value: { randomizedBooks: [], allAvailableBooks: [] }
let randomStateMap = {};

// 从 tailscale0 接口获取 IPv4 地址，确保仅在 Tailscale 网络监听
function getListenHost() {
    if (process.env.LISTEN_HOST) return process.env.LISTEN_HOST;

    const ifaces = os.networkInterfaces();
    for (const [name, entries] of Object.entries(ifaces)) {
        if (!name.startsWith('tailscale')) continue;
        for (const entry of entries) {
            if (entry.family === 'IPv4' && !entry.internal && entry.address) {
                return entry.address;
            }
        }
    }

    // 未找到 tailscale，回退到本地仅限本机访问
    return '127.0.0.1';
}

// 扫描搜索小说（按文件名包含关键字）
async function searchBooks(keyword, limit = 100) {
    const config = await apiHandlers['load-config']();
    const baseDir = config.baseDir || path.join(BASE_DIR, 'books');
    const libraryDir = config.libraryDir || config.hiddenLibraryDir || '';
    const searchDirs = config.searchDirs || [];
    const uniqueDirs = [...new Set([libraryDir, ...searchDirs, baseDir].filter(Boolean))];

    const lowerKeyword = keyword.toLowerCase();
    const results = [];
    const seen = new Set();

    for (const dir of uniqueDirs) {
        const txtFiles = await getAllTxtFiles(dir);
        for (const filePath of txtFiles) {
            if (seen.has(filePath)) continue;
            seen.add(filePath);

            const name = path.basename(filePath);
            if (!name.toLowerCase().includes(lowerKeyword)) continue;

            let stat = null;
            try {
                stat = await fsPromises.stat(filePath);
            } catch (_) { }

            results.push({
                name,
                path: filePath,
                relativePath: path.relative(dir, filePath),
                size: stat ? stat.size : 0,
                mtime: stat ? stat.mtime.getTime() : 0
            });

            if (results.length >= limit) return results;
        }
    }
    return results;
}

// 辅助函数：加载随机状态
async function loadRandomState() {
    try {
        const stateFilePath = path.join(BASE_DIR, RANDOM_STATE_FILE);
        if (fs.existsSync(stateFilePath)) {
            const stateData = await fsPromises.readFile(stateFilePath, 'utf8');
            const state = JSON.parse(stateData);

            // 兼容旧格式
            if (Array.isArray(state.randomizedBooks)) {
                randomStateMap = {};
            } else {
                randomStateMap = state.randomStateMap || {};
            }
        }
    } catch (error) {
        console.error('加载随机状态失败:', error);
        randomStateMap = {};
    }
}

// 辅助函数：保存随机状态
async function saveRandomState() {
    try {
        const stateFilePath = path.join(BASE_DIR, RANDOM_STATE_FILE);
        const state = {
            randomStateMap,
            timestamp: new Date().toISOString()
        };
        await fsPromises.writeFile(stateFilePath, JSON.stringify(state, null, 4));
    } catch (error) {
        console.error('保存随机状态失败:', error);
    }
}

// 辅助函数：获取目录树结构
async function getDirectoryTree(dir, relativePath = '') {
    const items = [];
    try {
        const entries = await fsPromises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const entryRelativePath = path.join(relativePath, entry.name);

            if (entry.isDirectory()) {
                // 递归获取子目录
                const children = await getDirectoryTree(fullPath, entryRelativePath);
                // 只有当目录不为空时才添加
                if (children.length > 0) {
                    items.push({
                        name: entry.name,
                        path: fullPath, // 服务器绝对路径，用于读取
                        relativePath: entryRelativePath, // 相对路径，用于展示
                        type: 'directory',
                        children: children
                    });
                }
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.txt')) {
                const stats = fs.statSync(fullPath);
                items.push({
                    name: entry.name,
                    path: fullPath,
                    relativePath: entryRelativePath,
                    type: 'file',
                    size: stats.size,
                    mtime: stats.mtime.getTime()
                });
            }
        }

        // 排序：文件夹在前，文件在后
        items.sort((a, b) => {
            if (a.type === b.type) return a.name.localeCompare(b.name);
            return a.type === 'directory' ? -1 : 1;
        });

    } catch (e) {
        console.error(`无法扫描目录 ${dir}:`, e);
    }
    return items;
}

// 递归获取所有 TXT 文件
async function getAllTxtFiles(dir) {
    const files = [];
    const IGNORED_DIRS = new Set([
        'node_modules', '.git', '.vscode', '.idea', 'dist', 'build', 'coverage',
        '$RECYCLE.BIN', 'System Volume Information', 'Windows', 'Program Files', 'Program Files (x86)'
    ]);
    const MAX_DEPTH = 20;

    async function scan(directory, depth = 0) {
        if (depth > MAX_DEPTH) return;
        try {
            const entries = await fsPromises.readdir(directory, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(directory, entry.name);
                if (entry.isDirectory()) {
                    if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
                        await scan(fullPath, depth + 1);
                    }
                } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.txt')) {
                    files.push(fullPath);
                }
            }
        } catch (e) {
            console.error(`无法扫描目录 ${directory}:`, e);
        }
    }
    await scan(dir);
    return files;
}

// API 处理函数
const apiHandlers = {
    'save-history': async (args) => {
        const history = args[0];
        const profile = args[1] || 'default'; // 支持多配置文件
        try {
            const filename = profile === 'hidden' ? 'reading_history_hidden.json' : 'reading_history.json';
            const historyPath = path.join(BASE_DIR, filename);
            await fsPromises.writeFile(historyPath, JSON.stringify(history, null, 4));
            return true;
        } catch (error) {
            console.error('保存历史记录失败:', error);
            return false;
        }
    },

    'load-history': async (args) => {
        const profile = (args && args[0]) || 'default';
        try {
            const filename = profile === 'hidden' ? 'reading_history_hidden.json' : 'reading_history.json';
            const historyPath = path.join(BASE_DIR, filename);
            if (fs.existsSync(historyPath)) {
                const data = await fsPromises.readFile(historyPath, 'utf8');
                return JSON.parse(data);
            }
            return [];
        } catch (error) {
            console.error('加载历史记录失败:', error);
            return [];
        }
    },

    'save-deleted-history': async (args) => {
        const deletedItems = args[0];
        const profile = args[1] || 'default';
        try {
            const filename = profile === 'hidden' ? 'deleted_history_hidden.json' : 'deleted_history.json';
            const deletedPath = path.join(BASE_DIR, filename);
            let currentDeleted = [];
            if (fs.existsSync(deletedPath)) {
                const data = await fsPromises.readFile(deletedPath, 'utf8');
                currentDeleted = JSON.parse(data);
            }
            // 合并并去重
            const newSet = new Set([...currentDeleted, ...deletedItems]);
            await fsPromises.writeFile(deletedPath, JSON.stringify([...newSet], null, 4));
            return true;
        } catch (error) {
            console.error('保存删除记录失败:', error);
            return false;
        }
    },

    'remove-from-deleted-history': async (args) => {
        const itemsToRemove = args[0]; // Array of filenames
        const profile = args[1] || 'default';
        try {
            const filename = profile === 'hidden' ? 'deleted_history_hidden.json' : 'deleted_history.json';
            const deletedPath = path.join(BASE_DIR, filename);
            if (fs.existsSync(deletedPath)) {
                const data = await fsPromises.readFile(deletedPath, 'utf8');
                let currentDeleted = [];
                try {
                    currentDeleted = JSON.parse(data);
                    if (!Array.isArray(currentDeleted)) currentDeleted = [];
                } catch (e) {
                    currentDeleted = [];
                }
                const removeSet = new Set(itemsToRemove);
                currentDeleted = currentDeleted.filter(item => !removeSet.has(item));
                await fsPromises.writeFile(deletedPath, JSON.stringify(currentDeleted, null, 4));
            }
            return true;
        } catch (error) {
            console.error('移除删除记录失败:', error);
            return false;
        }
    },

    'load-deleted-history': async (args) => {
        const profile = (args && args[0]) || 'default';
        try {
            const filename = profile === 'hidden' ? 'deleted_history_hidden.json' : 'deleted_history.json';
            const deletedPath = path.join(BASE_DIR, filename);
            if (fs.existsSync(deletedPath)) {
                const data = await fsPromises.readFile(deletedPath, 'utf8');
                return JSON.parse(data);
            }
            return [];
        } catch (error) {
            console.error('加载删除记录失败:', error);
            return [];
        }
    },

    'load-config': async () => {
        const configPath = path.join(BASE_DIR, CONFIG_FILE);
        // 环境变量 BOOKS_DIR 仅作为默认值，不强制覆盖用户选择
        const envBooksDir = process.env.BOOKS_DIR;

        if (!fs.existsSync(configPath)) {
            const defaultConfig = {
                baseDir: envBooksDir || path.join(BASE_DIR, 'books'), // 默认书籍目录
                searchDirs: [envBooksDir || path.join(BASE_DIR, 'books')],
                wordsPerPage: 4000,
                maxHistory: 50,
                fontSize: 18,
                homePageFontSize: 16,
                theme: 'light'
            };
            // 确保 books 目录存在
            if (!fs.existsSync(defaultConfig.baseDir)) {
                try { await fsPromises.mkdir(defaultConfig.baseDir, { recursive: true }); } catch (e) { }
            }
            await fsPromises.writeFile(configPath, JSON.stringify(defaultConfig, null, 4));
            return defaultConfig;
        }
        const configData = await fsPromises.readFile(configPath, 'utf8');
        const config = JSON.parse(configData);

        // 检查路径是否存在，不存在则修正为默认
        // 这对于从其他环境（如 Windows）迁移过来的配置文件很有用
        let configChanged = false;

        // 只有当 baseDir 为空时才采用 env 作为默认
        if (!config.baseDir) {
            config.baseDir = envBooksDir || path.join(BASE_DIR, 'books');
            configChanged = true;
        }

        if (!config.searchDirs || !Array.isArray(config.searchDirs)) {
            config.searchDirs = [config.baseDir];
            configChanged = true;
        }

        // 如果 baseDir 不存在，退回默认
        if (!fs.existsSync(config.baseDir)) {
            config.baseDir = envBooksDir || path.join(BASE_DIR, 'books');
            if (!config.searchDirs.includes(config.baseDir)) {
                config.searchDirs = [config.baseDir];
            }
            configChanged = true;
            if (!fs.existsSync(config.baseDir)) {
                try { await fsPromises.mkdir(config.baseDir, { recursive: true }); } catch (e) { }
            }
        }

        // 确保 baseDir 在 searchDirs 中
        if (!config.searchDirs.includes(config.baseDir)) {
            config.searchDirs.unshift(config.baseDir);
            configChanged = true;
        }

        // 过滤不存在的 searchDirs/hiddenSearchDirs
        const filterExisting = (arr) => Array.from(new Set((arr || []).filter(p => p && fs.existsSync(p))));
        const filteredSearch = filterExisting(config.searchDirs);
        if (filteredSearch.length !== (config.searchDirs || []).length) {
            config.searchDirs = filteredSearch;
            configChanged = true;
        }

        if (config.hiddenSearchDirs) {
            const filteredHidden = filterExisting(config.hiddenSearchDirs);
            if (filteredHidden.length !== config.hiddenSearchDirs.length) {
                config.hiddenSearchDirs = filteredHidden;
                configChanged = true;
            }
        }

        // 隐私模式基准目录兜底
        if (config.hiddenBaseDir && !fs.existsSync(config.hiddenBaseDir)) {
            config.hiddenBaseDir = config.baseDir;
            configChanged = true;
        }
        if (config.hiddenBaseDir && config.hiddenSearchDirs && !config.hiddenSearchDirs.includes(config.hiddenBaseDir)) {
            config.hiddenSearchDirs.unshift(config.hiddenBaseDir);
            configChanged = true;
        }

        if (configChanged) {
            await fsPromises.writeFile(configPath, JSON.stringify(config, null, 4));
        }

        return config;
    },

    'save-config': async (args) => {
        const newSettings = args[0];
        const configPath = path.join(BASE_DIR, CONFIG_FILE);
        let config = {};
        try {
            const configData = await fsPromises.readFile(configPath, 'utf8');
            config = JSON.parse(configData);
        } catch (error) {
            config = {
                baseDir: process.env.BOOKS_DIR || path.join(BASE_DIR, 'books'),
                wordsPerPage: 4000,
                maxHistory: 10,
                fontSize: 18,
                homePageFontSize: 16,
                theme: 'light'
            };
        }
        Object.assign(config, newSettings);
        await fsPromises.writeFile(configPath, JSON.stringify(config, null, 4));
        return true;
    },

    'read-file': async (args) => {
        const filePath = args[0];
        // 安全检查：防止读取系统关键文件，这里简单放行，因为是个人服务器
        return await fsPromises.readFile(filePath); // 返回 Buffer，JSON.stringify 会将其转换为 {type: 'Buffer', data: [...]}
    },

    'get-file-size': async (args) => {
        const filePath = args[0];
        try {
            const stats = await fsPromises.stat(filePath);
            return stats.size;
        } catch (error) {
            return 0;
        }
    },

    'read-file-chunk': async (args) => {
        const [filePath, start, length] = args;
        let fd = null;
        try {
            fd = await fsPromises.open(filePath, 'r');
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await fd.read(buffer, 0, length, start);
            return buffer.subarray(0, bytesRead);
        } catch (error) {
            console.error('读取文件分片失败:', error);
            return null;
        } finally {
            if (fd) await fd.close();
        }
    },

    'get-file-list': async (args) => {
        let libraryDir = args && args[0];

        // 如果参数没有提供路径，则回退到读取配置
        if (!libraryDir) {
            // 获取配置
            const configPath = path.join(BASE_DIR, CONFIG_FILE);
            try {
                if (fs.existsSync(configPath)) {
                    const configData = await fsPromises.readFile(configPath, 'utf8');
                    const config = JSON.parse(configData);
                    // 优先使用 libraryDir，如果没有则使用 baseDir
                    libraryDir = config.libraryDir || config.baseDir;
                }
            } catch (e) { }
        }

        // 环境变量仅作为最后兜底
        if (!libraryDir && process.env.BOOKS_DIR) {
            libraryDir = process.env.BOOKS_DIR;
        }

        // 如果没有配置路径，使用默认 books 目录
        if (!libraryDir) {
            libraryDir = path.join(BASE_DIR, 'books');
        }

        // 返回树状结构
        return await getDirectoryTree(libraryDir);
    },

    'get-file-stat': async (args) => {
        const filePath = args[0];
        console.log(`[get-file-stat] Checking: ${filePath}`);
        try {
            const stats = await fsPromises.stat(filePath);
            return {
                size: stats.size,
                mtime: stats.mtime.getTime()
            };
        } catch (error) {
            console.error(`[get-file-stat] Error: ${error.message}`);
            return null;
        }
    },

    // 列出指定目录下的文件夹（用于Web端选择路径）
    'list-directory': async (args) => {
        let dirPath = args && args[0];
        const includeFiles = args && args[1] !== false; // 默认包含文件

        if (!dirPath) dirPath = process.cwd();

        try {
            const items = [];
            const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });

            // 添加"上级目录"选项（如果不是根目录）
            const parentDir = path.dirname(dirPath);
            if (parentDir !== dirPath) {
                items.push({
                    name: '..',
                    path: parentDir,
                    type: 'directory',
                    isParent: true
                });
            }

            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name.startsWith('.')) continue;
                    items.push({
                        name: entry.name,
                        path: fullPath,
                        type: 'directory'
                    });
                } else if (includeFiles && entry.isFile() && entry.name.toLowerCase().endsWith('.txt')) {
                    const stats = await fsPromises.stat(fullPath).catch(() => null);
                    items.push({
                        name: entry.name,
                        path: fullPath,
                        type: 'file',
                        size: stats ? stats.size : 0,
                        mtime: stats ? stats.mtime.getTime() : 0
                    });
                }
            }

            items.sort((a, b) => {
                if (a.isParent) return -1;
                if (b.isParent) return 1;
                if (a.type === b.type) return a.name.localeCompare(b.name);
                return a.type === 'directory' ? -1 : 1;
            });

            return {
                currentPath: dirPath,
                items,
                separator: path.sep,
                truncated: false
            };
        } catch (error) {
            console.error(`列出目录失败 ${dirPath}:`, error);
            return { error: error.message };
        }
    }, 'search-file': async (args) => {
        const [baseDir, fileName] = args;
        async function searchInDir(dir) {
            try {
                const entries = await fsPromises.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        const result = await searchInDir(fullPath);
                        if (result) return result;
                    } else if (entry.name.toLowerCase() === fileName.toLowerCase()) {
                        return fullPath;
                    }
                }
            } catch (error) {
                console.error(`读取目录 ${dir} 时出错:`, error);
            }
            return null;
        }
        return await searchInDir(baseDir);
    },

    // 按文件名关键字搜索小说
    'search-books': async (args) => {
        const keyword = (args && args[0] || '').trim();
        const limit = (args && args[1]) || 100;
        if (!keyword) return [];
        try {
            return await searchBooks(keyword, limit);
        } catch (error) {
            console.error('搜索小说失败:', error);
            return [];
        }
    },

    'get-random-file': async (args) => {
        let baseDir = args[0];

        // 如果未提供路径或路径不存在，尝试使用配置中的默认路径
        if (!baseDir || !fs.existsSync(baseDir)) {
            try {
                const config = await apiHandlers['load-config']();
                baseDir = config.baseDir;
            } catch (e) {
                console.error('获取默认路径失败:', e);
            }
        }

        // 如果仍然无效，尝试使用默认 books 目录
        if (!baseDir || !fs.existsSync(baseDir)) {
            baseDir = path.join(BASE_DIR, 'books');
        }

        await loadRandomState(); // 确保状态是最新的

        // 确保 baseDir 是字符串
        const dirKey = baseDir || 'default';

        // 初始化该目录的状态
        if (!randomStateMap[dirKey]) {
            randomStateMap[dirKey] = {
                randomizedBooks: [],
                allAvailableBooks: []
            };
        }

        const state = randomStateMap[dirKey];
        // 确保属性存在
        if (!state.randomizedBooks) state.randomizedBooks = [];
        if (!state.allAvailableBooks) state.allAvailableBooks = [];

        const txtFiles = await getAllTxtFiles(baseDir);
        if (txtFiles.length === 0) return null;

        const currentBookSet = JSON.stringify(txtFiles.sort());
        const previousBookSet = JSON.stringify(state.allAvailableBooks.sort());

        if (currentBookSet !== previousBookSet) {
            state.allAvailableBooks = [...txtFiles];
            state.randomizedBooks = [];
        }

        if (state.randomizedBooks.length >= txtFiles.length) {
            state.randomizedBooks = [];
        }

        let availableBooks = txtFiles.filter(book => !state.randomizedBooks.includes(book));
        if (availableBooks.length === 0) {
            state.randomizedBooks = [];
            availableBooks = [...txtFiles];
        }

        const randomIndex = Math.floor(Math.random() * availableBooks.length);
        const selectedBook = availableBooks[randomIndex];
        state.randomizedBooks.push(selectedBook);
        await saveRandomState();
        return selectedBook;
    },

    'reset-random-state': async (args) => {
        const baseDir = args && args[0];

        if (baseDir) {
            // 如果指定了目录，只重置该目录
            if (randomStateMap[baseDir]) {
                randomStateMap[baseDir].randomizedBooks = [];
            }
        } else {
            // 如果未指定，重置所有目录的随机状态
            for (const key in randomStateMap) {
                if (randomStateMap[key]) {
                    randomStateMap[key].randomizedBooks = [];
                }
            }
        }

        await saveRandomState();
        return true;
    },

    'select-directory': async () => {
        // Web 端无法弹出选择框，返回 null，前端会处理
        // 或者我们可以返回一个默认路径
        return null;
    },

    'find-and-open-file-location': async () => {
        return { success: false, error: 'Web 端不支持打开文件位置' };
    }
};

const server = http.createServer(async (req, res) => {
    // 全局错误处理，防止崩溃
    req.on('error', (err) => {
        console.error('Request error:', err);
    });
    res.on('error', (err) => {
        console.error('Response error:', err);
    });

    // 处理 CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsedUrl = url.parse(req.url, true);

    try {
        // 优化的文件读取接口 (流式传输)
        if (parsedUrl.pathname === '/api/raw-read' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });
            req.on('end', async () => {
                try {
                    const { filePath } = JSON.parse(body);
                    console.log(`[raw-read] Reading file: ${filePath}`);

                    // 简单的安全检查
                    try {
                        const stat = await fsPromises.stat(filePath);

                        // 启用压缩支持
                        const acceptEncoding = req.headers['accept-encoding'] || '';
                        const rawStream = fs.createReadStream(filePath);

                        // 设置基本头部
                        const headers = {
                            'Content-Type': 'application/octet-stream',
                            'Cache-Control': 'no-store'
                        };

                        let outputStream = rawStream;

                        // 根据客户端支持的编码进行压缩
                        if (acceptEncoding.includes('gzip')) {
                            headers['Content-Encoding'] = 'gzip';
                            res.writeHead(200, headers);
                            const gzip = zlib.createGzip();
                            outputStream = rawStream.pipe(gzip);
                        } else if (acceptEncoding.includes('deflate')) {
                            headers['Content-Encoding'] = 'deflate';
                            res.writeHead(200, headers);
                            const deflate = zlib.createDeflate();
                            outputStream = rawStream.pipe(deflate);
                        } else {
                            headers['Content-Length'] = stat.size;
                            res.writeHead(200, headers);
                        }

                        outputStream.pipe(res);

                        outputStream.on('error', (error) => {
                            console.error('Stream error:', error);
                            if (!res.headersSent) {
                                res.writeHead(500);
                                res.end(JSON.stringify({ error: 'File read error' }));
                            }
                        });

                        // 监听原始流的错误，防止未捕获异常
                        rawStream.on('error', (error) => {
                            console.error('Raw stream error:', error);
                            // 如果响应头还没发送，可以尝试发送错误
                            // 但通常 outputStream 的 error 也会触发
                        });

                    } catch (error) {
                        console.error('File access error:', error);
                        if (!res.headersSent) {
                            res.writeHead(404, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'File not found or inaccessible' }));
                        }
                    }
                } catch (error) {
                    console.error('API Error:', error);
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: error.message }));
                    }
                }
            });
            return;
        }

        // API 路由
        if (parsedUrl.pathname === '/api/invoke' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });
            req.on('end', async () => {
                try {
                    const { channel, args } = JSON.parse(body);
                    console.log(`[API] Invoke: ${channel}`);

                    if (apiHandlers[channel]) {
                        const result = await apiHandlers[channel](args);
                        if (!res.headersSent) {
                            res.writeHead(200, {
                                'Content-Type': 'application/json',
                                'Cache-Control': 'no-store'
                            });
                            res.end(JSON.stringify({ data: result }));
                        }
                    } else {
                        if (!res.headersSent) {
                            res.writeHead(404, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: `Unknown channel: ${channel}` }));
                        }
                    }
                } catch (error) {
                    console.error('API Error:', error);
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: error.message }));
                    }
                }
            });
            return;
        }

        // 静态文件服务
        let filePath = path.join(BASE_DIR, parsedUrl.pathname === '/' ? 'index.html' : parsedUrl.pathname);

        // 防止目录遍历攻击
        if (!filePath.startsWith(BASE_DIR)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        const extname = path.extname(filePath);
        let contentType = 'text/html';
        switch (extname) {
            case '.js': contentType = 'text/javascript'; break;
            case '.css': contentType = 'text/css'; break;
            case '.json': contentType = 'application/json'; break;
            case '.png': contentType = 'image/png'; break;
            case '.jpg': contentType = 'image/jpg'; break;
        }

        try {
            const content = await fsPromises.readFile(filePath);
            res.writeHead(200, {
                'Content-Type': contentType,
                'Cache-Control': 'no-cache' // 总是验证，确保开发调试时文件更新及时生效
            });
            res.end(content, 'utf-8');
        } catch (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404);
                res.end('File not found');
            } else {
                res.writeHead(500);
                res.end(`Server Error: ${error.code}`);
            }
        }
    } catch (err) {
        console.error('Server processing error:', err);
        if (!res.headersSent) {
            res.writeHead(500);
            res.end('Internal Server Error');
        }
    }
});

// 防止进程崩溃
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

server.listen(PORT, HOST, () => {
    console.log(`\n=== 优雅阅读器 Web 服务已启动 ===`);
    console.log(`监听地址: ${HOST}`);
    console.log(`端口: ${PORT}`);
    console.log(`Server running at http://${HOST}:${PORT}/`);
});

// 恢复默认超时设置
try {
    server.timeout = 0; // 保持为 0 仅在必要时可以修改
    server.keepAliveTimeout = 0;
} catch (e) {
    // 如果运行环境不允许修改，不影响主流程
    console.warn('无法修改 server 超时设置:', e.message || e);
}
