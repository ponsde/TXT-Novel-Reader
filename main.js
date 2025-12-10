const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const crypto = require('crypto');

// 缓存目录
const CACHE_DIR = path.join(app.getPath('userData'), 'book_cache');

// 确保缓存目录存在
if (!fs.existsSync(CACHE_DIR)) {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    } catch (err) {
        console.error('创建缓存目录失败:', err);
    }
}

// 使用应用根目录而不是执行文件目录，以确保开发环境和生产环境一致性
// 在开发环境中，__dirname 指向项目根目录
// 在打包后，通常指向 resources/app.asar 或 resources/app
const BASE_DIR = __dirname;
const RANDOM_STATE_FILE = 'random_state.json';

// 全局变量存储随机状态
let randomizedBooks = [];
let allAvailableBooks = [];

// 加载随机状态
async function loadRandomState() {
    try {
        const stateFilePath = path.join(BASE_DIR, RANDOM_STATE_FILE);

        if (fs.existsSync(stateFilePath)) {
            const stateData = await fsPromises.readFile(stateFilePath, 'utf8');
            const state = JSON.parse(stateData);
            randomizedBooks = state.randomizedBooks || [];
            allAvailableBooks = state.allAvailableBooks || [];
            console.log(`已加载随机状态: ${randomizedBooks.length}/${allAvailableBooks.length} 本书已随机`);
        }
    } catch (error) {
        console.error('加载随机状态失败:', error);
        // 加载失败时重置状态
        randomizedBooks = [];
        allAvailableBooks = [];
    }
}

// 保存随机状态
async function saveRandomState() {
    try {
        const stateFilePath = path.join(BASE_DIR, RANDOM_STATE_FILE);

        const state = {
            randomizedBooks,
            allAvailableBooks,
            timestamp: new Date().toISOString()
        };

        await fsPromises.writeFile(stateFilePath, JSON.stringify(state, null, 4));
        console.log('已保存随机状态');
    } catch (error) {
        console.error('保存随机状态失败:', error);
    }
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        }
    });

    win.loadFile('index.html').catch(err => {
        console.error('加载 index.html 失败:', err);
    });

    // 添加错误处理
    win.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
        console.error('页面加载失败:', errorCode, errorDescription);
    });

    // 注释掉开发者工具，以避免生产环境中显示
    // win.webContents.openDevTools();
}

app.whenReady().then(async () => {
    // 加载随机状态
    await loadRandomState();
    createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// 在应用退出前保存随机状态
app.on('quit', async () => {
    await saveRandomState();
});

// 添加重置随机状态的处理函数
ipcMain.handle('reset-random-state', async () => {
    try {
        randomizedBooks = [];
        console.log('已重置随机状态');
        await saveRandomState();
        return true;
    } catch (error) {
        console.error('重置随机状态失败:', error);
        return false;
    }
});

// 处理读取文件请求
ipcMain.handle('read-file', async (event, filePath) => {
    try {
        const data = await fsPromises.readFile(filePath);
        return data;
    } catch (error) {
        console.error('Error reading file:', error);
        throw error;
    }
});

// 修改文件搜索处理（优化版：并行处理 + 忽略目录）
ipcMain.handle('search-file', async (event, baseDir, fileName) => {
    // 忽略列表
    const IGNORED_DIRS = new Set([
        'node_modules', '.git', '.vscode', '.idea', 'dist', 'build', 'coverage',
        '$RECYCLE.BIN', 'System Volume Information', 'Windows', 'Program Files', 'Program Files (x86)'
    ]);

    // 最大递归深度
    const MAX_DEPTH = 10;

    // 用于控制提前结束
    let foundPath = null;

    async function searchInDir(dir, depth = 0) {
        if (foundPath) return foundPath; // 如果已经找到了，直接返回
        if (depth > MAX_DEPTH) return null;

        try {
            const entries = await fsPromises.readdir(dir, { withFileTypes: true });

            // 检查当前目录下的文件
            for (const entry of entries) {
                if (foundPath) return foundPath;

                if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
                    foundPath = path.join(dir, entry.name);
                    return foundPath;
                }
            }

            // 收集子目录
            const subDirs = [];
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
                        subDirs.push(path.join(dir, entry.name));
                    }
                }
            }

            // 并行扫描子目录
            if (subDirs.length > 0) {
                // 使用 Promise.all 并行执行，但只要有一个找到就返回
                // 注意：这里没有使用 Promise.any 因为 Node 版本可能不支持，且我们需要自定义逻辑
                const promises = subDirs.map(subDir => searchInDir(subDir, depth + 1));
                await Promise.all(promises);
            }

            return foundPath;
        } catch (error) {
            // 忽略错误
            return null;
        }
    }

    try {
        console.log('开始搜索文件:', fileName, '在目录:', baseDir);
        const result = await searchInDir(baseDir);
        console.log('搜索结果:', result);
        return result;
    } catch (error) {
        console.error('搜索文件错误:', error);
        return null;
    }
});

// 添加配置文件处理
ipcMain.handle('load-config', async () => {
    try {
        // 使用 app.getPath('exe') 获取程序所在目录
        const exePath = app.getPath('exe');
        const configPath = path.join(path.dirname(exePath), 'config.json');

        // 如果配置文件不存在，创建默认配置
        if (!fs.existsSync(configPath)) {
            const documentsPath = app.getPath('documents');
            const defaultConfig = {
                baseDir: documentsPath,
                searchDirs: [documentsPath],  // 默认搜索目录
                wordsPerPage: 4000,
                maxHistory: 50,
                fontSize: 18,
                homePageFontSize: 16,
                theme: 'light'
            };
            await fsPromises.writeFile(configPath, JSON.stringify(defaultConfig, null, 4));
            return defaultConfig;
        }

        const configData = await fsPromises.readFile(configPath, 'utf8');
        const config = JSON.parse(configData);

        // 如果没有searchDirs字段，添加一个默认值
        if (!config.searchDirs) {
            config.searchDirs = [config.baseDir];
            // 保存更新后的配置
            await fsPromises.writeFile(configPath, JSON.stringify(config, null, 4));
        }

        return config;
    } catch (error) {
        console.error('读取配置文件失败:', error);
        // 返回默认配置
        const documentsPath = app.getPath('documents');
        return {
            baseDir: documentsPath,
            searchDirs: [documentsPath],  // 默认搜索目录
            wordsPerPage: 4000,
            maxHistory: 50,
            fontSize: 18,
            homePageFontSize: 16,
            theme: 'light'
        };
    }
});

// 添加获取随机文件的 IPC 处理
ipcMain.handle('get-random-file', async (event, baseDir) => {
    try {
        // 获取目录中的所有TXT文件
        const txtFiles = await getAllTxtFiles(baseDir);
        if (txtFiles.length === 0) {
            return null;
        }

        // 检查是否所有书籍列表已更新
        const currentBookSet = JSON.stringify(txtFiles.sort());
        const previousBookSet = JSON.stringify(allAvailableBooks.sort());

        // 如果书籍列表发生变化或首次运行，重置已随机列表
        if (currentBookSet !== previousBookSet) {
            console.log('书籍列表已更新，重置随机状态');
            allAvailableBooks = [...txtFiles];
            randomizedBooks = [];
        }

        // 如果所有书籍都已经随机过一遍，重置已随机列表
        if (randomizedBooks.length >= txtFiles.length) {
            console.log('所有书籍都已随机过一遍，重置随机状态');
            randomizedBooks = [];
        }

        // 过滤出未随机过的书籍
        const availableBooks = txtFiles.filter(book => !randomizedBooks.includes(book));

        // 如果没有可用书籍（理论上不应该发生），重置并使用所有书籍
        if (availableBooks.length === 0) {
            console.log('没有可用书籍，重置随机状态');
            randomizedBooks = [];
            availableBooks = [...txtFiles];
        }

        // 从可用书籍中随机选择一本
        const randomIndex = Math.floor(Math.random() * availableBooks.length);
        const selectedBook = availableBooks[randomIndex];

        // 将选中的书籍添加到已随机列表
        randomizedBooks.push(selectedBook);
        console.log(`已随机过 ${randomizedBooks.length}/${txtFiles.length} 本书`);

        // 保存随机状态
        await saveRandomState();

        return selectedBook;
    } catch (error) {
        console.error('获取随机文件失败:', error);
        throw error;
    }
});

// 选择目录
ipcMain.handle('select-directory', async () => {
    try {
        const result = await dialog.showOpenDialog({
            properties: ['openDirectory'],
            title: '选择小说文件夹路径'
        });

        if (result.canceled) {
            return null;
        }

        return result.filePaths[0];
    } catch (error) {
        console.error('选择目录失败:', error);
        return null;
    }
});

// 递归获取所有 TXT 文件（优化版：并行处理 + 忽略目录）
async function getAllTxtFiles(dir) {
    const files = [];
    // 忽略列表
    const IGNORED_DIRS = new Set([
        'node_modules', '.git', '.vscode', '.idea', 'dist', 'build', 'coverage',
        '$RECYCLE.BIN', 'System Volume Information', 'Windows', 'Program Files', 'Program Files (x86)'
    ]);

    // 最大递归深度，防止过深
    const MAX_DEPTH = 20;

    async function scan(directory, depth = 0) {
        if (depth > MAX_DEPTH) return;

        try {
            const entries = await fsPromises.readdir(directory, { withFileTypes: true });

            // 分离文件和目录，以便并行处理
            const subDirs = [];

            for (const entry of entries) {
                const fullPath = path.join(directory, entry.name);

                if (entry.isDirectory()) {
                    if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
                        subDirs.push(fullPath);
                    }
                } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.txt')) {
                    files.push(fullPath);
                }
            }

            // 并行扫描子目录
            if (subDirs.length > 0) {
                await Promise.all(subDirs.map(subDir => scan(subDir, depth + 1).catch(err => {
                    // 忽略访问权限等错误，继续扫描其他目录
                    // console.warn(`无法扫描目录 ${subDir}:`, err.message);
                })));
            }
        } catch (error) {
            // 忽略读取目录错误（如权限不足）
            // console.warn(`读取目录 ${directory} 失败:`, error.message);
        }
    }

    await scan(dir);
    return files;
}// 辅助函数：获取目录树结构
async function getDirectoryTree(dir, relativePath = '') {
    const items = [];
    try {
        const entries = await fsPromises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const entryRelativePath = path.join(relativePath, entry.name);

            if (entry.isDirectory()) {
                // 忽略隐藏目录和系统目录
                if (entry.name.startsWith('.') || entry.name === '$RECYCLE.BIN' || entry.name === 'System Volume Information') continue;

                // 递归获取子目录
                const children = await getDirectoryTree(fullPath, entryRelativePath);
                // 只有当目录不为空时才添加
                if (children.length > 0) {
                    items.push({
                        name: entry.name,
                        path: fullPath,
                        relativePath: entryRelativePath,
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

// 添加获取文件列表的 IPC 处理
ipcMain.handle('get-file-list', async () => {
    try {
        // 获取配置
        const exePath = app.getPath('exe');
        const configPath = path.join(path.dirname(exePath), 'config.json');
        let libraryDir = '';

        if (fs.existsSync(configPath)) {
            const configData = await fsPromises.readFile(configPath, 'utf8');
            const config = JSON.parse(configData);
            // 优先使用 libraryDir，如果没有则使用 baseDir
            libraryDir = config.libraryDir || config.baseDir;
        }

        // 如果没有配置路径，使用文档目录
        if (!libraryDir) {
            libraryDir = app.getPath('documents');
        }

        console.log('正在获取书库列表，路径:', libraryDir);
        return await getDirectoryTree(libraryDir);
    } catch (error) {
        console.error('获取文件列表失败:', error);
        return [];
    }
});

// 列出指定目录下的文件夹（用于Web端选择路径，虽然Electron有原生对话框，但保持接口一致性）
ipcMain.handle('list-directory', async (event, dirPath) => {
    // 如果未指定路径，默认使用文档目录
    if (!dirPath) {
        dirPath = app.getPath('documents');
    }

    try {
        const items = [];
        const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });

        // 添加"上级目录"
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
                // 忽略隐藏目录和系统目录
                if (entry.name.startsWith('.') || entry.name === '$RECYCLE.BIN' || entry.name === 'System Volume Information') continue;

                items.push({
                    name: entry.name,
                    path: path.join(dirPath, entry.name),
                    type: 'directory'
                });
            }
        }

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
});

// 添加保存配置的处理函数
ipcMain.handle('save-config', async (event, newSettings) => {
    try {
        const exePath = app.getPath('exe');
        const configPath = path.join(path.dirname(exePath), 'config.json');

        // 读取现有配置
        let config = {};
        try {
            const configData = await fsPromises.readFile(configPath, 'utf8');
            config = JSON.parse(configData);
        } catch (error) {
            // 如果文件不存在或无法解析，使用默认配置
            const documentsPath = app.getPath('documents');
            config = {
                baseDir: documentsPath,
                wordsPerPage: 4000,
                maxHistory: 10,
                fontSize: 18,
                homePageFontSize: 16,
                theme: 'light'
            };
        }

        // 更新配置
        Object.assign(config, newSettings);

        // 保存配置
        await fsPromises.writeFile(configPath, JSON.stringify(config, null, 4));
        return true;
    } catch (error) {
        console.error('保存配置失败:', error);
        return false;
    }
});

// 获取文件大小
ipcMain.handle('get-file-size', async (event, filePath) => {
    try {
        const stats = await fsPromises.stat(filePath);
        return stats.size;
    } catch (error) {
        console.error('获取文件大小失败:', error);
        return 0;
    }
});

// 读取文件分片
ipcMain.handle('read-file-chunk', async (event, filePath, start, length) => {
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
});

// 添加查找并打开文件位置的处理函数
ipcMain.handle('find-and-open-file-location', async (event, searchPaths, fileName) => {
    try {
        // 在多个路径中查找文件
        for (const dir of searchPaths) {
            try {
                const filePath = await findFileInDirectory(dir, fileName);
                if (filePath) {
                    // 使用系统默认文件管理器打开文件所在目录并选中文件
                    shell.showItemInFolder(filePath);
                    return { success: true, filePath };
                }
            } catch (error) {
                console.error(`在目录 ${dir} 中搜索文件时出错:`, error);
                // 继续搜索下一个目录
            }
        }

        // 所有路径都搜索完毕，未找到文件
        return { success: false };
    } catch (error) {
        console.error('查找并打开文件位置失败:', error);
        return { success: false, error: error.message };
    }
});

// 在目录中查找文件的辅助函数
async function findFileInDirectory(dir, fileName) {
    async function searchInDir(directory) {
        try {
            const entries = await fsPromises.readdir(directory, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(directory, entry.name);
                if (entry.isDirectory()) {
                    try {
                        const result = await searchInDir(fullPath);
                        if (result) return result;
                    } catch (error) {
                        console.error(`搜索子目录 ${fullPath} 时出错:`, error);
                        continue;
                    }
                } else if (entry.name.toLowerCase() === fileName.toLowerCase()) {
                    return fullPath;
                }
            }
        } catch (error) {
            console.error(`读取目录 ${directory} 时出错:`, error);
        }
        return null;
    }

    return await searchInDir(dir);
}

// 保存历史记录到文件
ipcMain.handle('save-history', async (event, history, profile = 'default') => {
    try {
        // 获取配置
        const configPath = path.join(BASE_DIR, 'config.json');
        let libraryDir = '';

        if (fs.existsSync(configPath)) {
            const configData = await fsPromises.readFile(configPath, 'utf8');
            const config = JSON.parse(configData);
            libraryDir = config.libraryDir || config.baseDir;
        }

        // 如果没有配置路径，使用文档目录
        if (!libraryDir) {
            libraryDir = app.getPath('documents');
        }

        const filename = profile === 'hidden' ? 'reading_history_hidden.json' : 'reading_history.json';
        const historyPath = path.join(libraryDir, filename);
        await fsPromises.writeFile(historyPath, JSON.stringify(history, null, 4));
        return true;
    } catch (error) {
        console.error('保存历史记录失败:', error);
        return false;
    }
});

// 从文件加载历史记录
ipcMain.handle('load-history', async (event, profile = 'default') => {
    try {
        // 获取配置
        const configPath = path.join(BASE_DIR, 'config.json');
        let libraryDir = '';

        if (fs.existsSync(configPath)) {
            const configData = await fsPromises.readFile(configPath, 'utf8');
            const config = JSON.parse(configData);
            libraryDir = config.libraryDir || config.baseDir;
        }

        // 如果没有配置路径，使用文档目录
        if (!libraryDir) {
            libraryDir = app.getPath('documents');
        }

        const filename = profile === 'hidden' ? 'reading_history_hidden.json' : 'reading_history.json';
        const historyPath = path.join(libraryDir, filename);
        if (fs.existsSync(historyPath)) {
            const data = await fsPromises.readFile(historyPath, 'utf8');
            try {
                const parsed = JSON.parse(data);
                return Array.isArray(parsed) ? parsed : [];
            } catch (e) {
                return [];
            }
        }
        return [];
    } catch (error) {
        console.error('加载历史记录失败:', error);
        return [];
    }
});

// 保存已删除的历史记录
ipcMain.handle('save-deleted-history', async (event, deletedHistory, profile = 'default') => {
    try {
        // 获取配置
        const configPath = path.join(BASE_DIR, 'config.json');
        let libraryDir = '';

        if (fs.existsSync(configPath)) {
            const configData = await fsPromises.readFile(configPath, 'utf8');
            const config = JSON.parse(configData);
            libraryDir = config.libraryDir || config.baseDir;
        }

        // 如果没有配置路径，使用文档目录
        if (!libraryDir) {
            libraryDir = app.getPath('documents');
        }

        const filename = profile === 'hidden' ? 'deleted_history_hidden.json' : 'deleted_history.json';
        const deletedHistoryPath = path.join(libraryDir, filename);

        let currentDeleted = [];
        if (fs.existsSync(deletedHistoryPath)) {
            const data = await fsPromises.readFile(deletedHistoryPath, 'utf8');
            try {
                currentDeleted = JSON.parse(data);
                if (!Array.isArray(currentDeleted)) currentDeleted = [];
            } catch (e) {
                currentDeleted = [];
            }
        }

        // 合并并去重
        const newSet = new Set([...currentDeleted, ...deletedHistory]);

        await fsPromises.writeFile(deletedHistoryPath, JSON.stringify([...newSet], null, 4));
        return true;
    } catch (error) {
        console.error('保存已删除历史记录失败:', error);
        return false;
    }
});

// 加载已删除的历史记录
ipcMain.handle('load-deleted-history', async (event, profile = 'default') => {
    try {
        // 获取配置
        const configPath = path.join(BASE_DIR, 'config.json');
        let libraryDir = '';

        if (fs.existsSync(configPath)) {
            const configData = await fsPromises.readFile(configPath, 'utf8');
            const config = JSON.parse(configData);
            libraryDir = config.libraryDir || config.baseDir;
        }

        // 如果没有配置路径，使用文档目录
        if (!libraryDir) {
            libraryDir = app.getPath('documents');
        }

        const filename = profile === 'hidden' ? 'deleted_history_hidden.json' : 'deleted_history.json';
        const deletedHistoryPath = path.join(libraryDir, filename);
        if (fs.existsSync(deletedHistoryPath)) {
            const data = await fsPromises.readFile(deletedHistoryPath, 'utf8');
            try {
                const parsed = JSON.parse(data);
                return Array.isArray(parsed) ? parsed : [];
            } catch (e) {
                return [];
            }
        }
        return [];
    } catch (error) {
        console.error('加载已删除历史记录失败:', error);
        return [];
    }
});

// 生成书籍缓存键
async function getBookKey(filePath) {
    try {
        const stats = await fsPromises.stat(filePath);
        const key = `${filePath}-${stats.size}-${stats.mtime.getTime()}`;
        return crypto.createHash('md5').update(key).digest('hex');
    } catch (error) {
        console.error('生成缓存键失败:', error);
        return null;
    }
}

// 检查书籍缓存
ipcMain.handle('check-book-cache', async (event, filePath) => {
    try {
        const bookKey = await getBookKey(filePath);
        if (!bookKey) return null;

        const cachePath = path.join(CACHE_DIR, `${bookKey}.json`);
        if (fs.existsSync(cachePath)) {
            const data = await fsPromises.readFile(cachePath, 'utf8');
            return JSON.parse(data);
        }
        return null;
    } catch (error) {
        console.error('读取缓存失败:', error);
        return null;
    }
});

// 保存书籍缓存
ipcMain.handle('save-book-cache', async (event, filePath, data) => {
    try {
        const bookKey = await getBookKey(filePath);
        if (!bookKey) return false;

        const cachePath = path.join(CACHE_DIR, `${bookKey}.json`);
        await fsPromises.writeFile(cachePath, JSON.stringify(data), 'utf8');
        return true;
    } catch (error) {
        console.error('保存缓存失败:', error);
        return false;
    }
});