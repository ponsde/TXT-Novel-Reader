const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');

const PORT = 3000;
const fsPromises = fs.promises;

// 模拟 Electron 的 app.getPath('exe')
// 在 Web 模式下，我们使用当前目录作为基准
const BASE_DIR = __dirname;
const RANDOM_STATE_FILE = 'random_state.json';
const CONFIG_FILE = 'config.json';

// 全局变量
let randomizedBooks = [];
let allAvailableBooks = [];

// 辅助函数：加载随机状态
async function loadRandomState() {
    try {
        const stateFilePath = path.join(BASE_DIR, RANDOM_STATE_FILE);
        if (fs.existsSync(stateFilePath)) {
            const stateData = await fsPromises.readFile(stateFilePath, 'utf8');
            const state = JSON.parse(stateData);
            randomizedBooks = state.randomizedBooks || [];
            allAvailableBooks = state.allAvailableBooks || [];
        }
    } catch (error) {
        console.error('加载随机状态失败:', error);
        randomizedBooks = [];
        allAvailableBooks = [];
    }
}

// 辅助函数：保存随机状态
async function saveRandomState() {
    try {
        const stateFilePath = path.join(BASE_DIR, RANDOM_STATE_FILE);
        const state = {
            randomizedBooks,
            allAvailableBooks,
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
                items.push({
                    name: entry.name,
                    path: fullPath,
                    relativePath: entryRelativePath,
                    type: 'file',
                    size: fs.statSync(fullPath).size
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
    'load-config': async () => {
        const configPath = path.join(BASE_DIR, CONFIG_FILE);
        // 优先使用环境变量中的 BOOKS_DIR
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

        // 如果环境变量设置了 BOOKS_DIR，覆盖配置
        if (envBooksDir && config.baseDir !== envBooksDir) {
            config.baseDir = envBooksDir;
            config.searchDirs = [envBooksDir]; // 重置搜索目录
            configChanged = true;
        }

        if (!config.baseDir || !fs.existsSync(config.baseDir)) {
            config.baseDir = envBooksDir || path.join(BASE_DIR, 'books');
            config.searchDirs = [config.baseDir];
            configChanged = true;

            // 确保 books 目录存在
            if (!fs.existsSync(config.baseDir)) {
                try { await fsPromises.mkdir(config.baseDir, { recursive: true }); } catch (e) { }
            }
        }

        if (!config.searchDirs) {
            config.searchDirs = [config.baseDir];
            configChanged = true;
        }

        if (configChanged) {
            // 保存修正后的配置
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
        // 获取配置
        const configPath = path.join(BASE_DIR, CONFIG_FILE);
        let libraryDir = '';

        try {
            if (fs.existsSync(configPath)) {
                const configData = await fsPromises.readFile(configPath, 'utf8');
                const config = JSON.parse(configData);
                // 优先使用 libraryDir，如果没有则使用 baseDir
                libraryDir = config.libraryDir || config.baseDir;
            }
        } catch (e) { }

        // 如果环境变量强制指定，则使用环境变量
        if (process.env.BOOKS_DIR) {
            libraryDir = process.env.BOOKS_DIR;
        }

        // 如果没有配置路径，使用默认 books 目录
        if (!libraryDir) {
            libraryDir = path.join(BASE_DIR, 'books');
        }

        // 返回树状结构
        return await getDirectoryTree(libraryDir);
    },

    // 列出指定目录下的文件夹（用于Web端选择路径）
    'list-directory': async (args) => {
        let dirPath = args[0];

        // 如果未指定路径，默认使用当前工作目录或根目录
        if (!dirPath) {
            dirPath = process.cwd();
        }

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
                if (entry.isDirectory()) {
                    // 忽略隐藏目录
                    if (entry.name.startsWith('.')) continue;

                    items.push({
                        name: entry.name,
                        path: path.join(dirPath, entry.name),
                        type: 'directory'
                    });
                }
            }

            // 排序
            items.sort((a, b) => {
                if (a.isParent) return -1;
                if (b.isParent) return 1;
                return a.name.localeCompare(b.name);
            });

            return {
                currentPath: dirPath,
                items: items,
                separator: path.sep
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

    'get-random-file': async (args) => {
        const baseDir = args[0];
        await loadRandomState(); // 确保状态是最新的

        const txtFiles = await getAllTxtFiles(baseDir);
        if (txtFiles.length === 0) return null;

        const currentBookSet = JSON.stringify(txtFiles.sort());
        const previousBookSet = JSON.stringify(allAvailableBooks.sort());

        if (currentBookSet !== previousBookSet) {
            allAvailableBooks = [...txtFiles];
            randomizedBooks = [];
        }

        if (randomizedBooks.length >= txtFiles.length) {
            randomizedBooks = [];
        }

        const availableBooks = txtFiles.filter(book => !randomizedBooks.includes(book));
        if (availableBooks.length === 0) {
            randomizedBooks = [];
            availableBooks = [...txtFiles];
        }

        const randomIndex = Math.floor(Math.random() * availableBooks.length);
        const selectedBook = availableBooks[randomIndex];
        randomizedBooks.push(selectedBook);
        await saveRandomState();
        return selectedBook;
    },

    'reset-random-state': async () => {
        randomizedBooks = [];
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

    // 优化的文件读取接口 (流式传输)
    if (parsedUrl.pathname === '/api/raw-read' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const { filePath } = JSON.parse(body);

                // 简单的安全检查
                // 注意：这里应该有更严格的路径检查，但为了保持与原 read-file 逻辑一致（允许读取任意文件），我们暂时只做基本错误处理

                try {
                    const stat = await fsPromises.stat(filePath);
                    const acceptEncoding = req.headers['accept-encoding'] || '';

                    if (acceptEncoding.includes('gzip')) {
                        // 使用 GZIP 压缩传输
                        res.writeHead(200, {
                            'Content-Type': 'application/octet-stream',
                            'Content-Encoding': 'gzip'
                        });

                        const gzip = zlib.createGzip();
                        const stream = fs.createReadStream(filePath);
                        stream.pipe(gzip).pipe(res);

                        stream.on('error', (error) => {
                            console.error('Stream error:', error);
                        });
                    } else {
                        // 不支持压缩，直接传输
                        res.writeHead(200, {
                            'Content-Type': 'application/octet-stream',
                            'Content-Length': stat.size
                        });

                        const stream = fs.createReadStream(filePath);
                        stream.pipe(res);

                        stream.on('error', (error) => {
                            console.error('Stream error:', error);
                            if (!res.headersSent) {
                                res.writeHead(500);
                                res.end(JSON.stringify({ error: 'File read error' }));
                            }
                        });
                    }
                } catch (error) {
                    console.error('File access error:', error);
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'File not found or inaccessible' }));
                }
            } catch (error) {
                console.error('API Error:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
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
                if (apiHandlers[channel]) {
                    const result = await apiHandlers[channel](args || []);

                    // 特殊处理 Buffer 数据 (read-file)
                    if (Buffer.isBuffer(result)) {
                        // 直接发送 Buffer 数据可能在 JSON.stringify 中变成对象
                        // 我们保持一致性，前端会收到 { type: 'Buffer', data: [...] }
                        // 或者我们可以直接发送 base64，但前端代码可能期待 Buffer 结构
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ data: result }));
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `Unknown channel: ${channel}` }));
                }
            } catch (error) {
                console.error('API Error:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
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
        res.writeHead(200, { 'Content-Type': contentType });
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
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n=== 优雅阅读器 Web 服务已启动 ===`);
    console.log(`端口: ${PORT}`);
    console.log(`\n访问方式:`);
    console.log(`1. 如果你在云服务器上操作: http://localhost:${PORT}/`);
    console.log(`2. 如果你在其他电脑/手机上: http://<你的云服务器公网IP>:${PORT}/`);
    console.log(`   (例如: http://123.45.67.89:${PORT}/)`);
    console.log(`\n注意: 请务必在云服务器控制台的安全组设置中，放行 TCP ${PORT} 端口，否则无法访问。`);
});
