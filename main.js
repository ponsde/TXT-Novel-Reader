const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;

// 添加全局变量存储已随机过的书籍
let randomizedBooks = [];
let allAvailableBooks = [];
const RANDOM_STATE_FILE = 'random_state.json';
const CONFIG_FILE = 'config.json';
const USER_STATE_FILE = 'user_state.json';
const USER_STATE_SAVE_DELAY = 500;

function getDefaultUserState() {
    return {
        theme: 'light',
        readerSettings: {
            fontSize: 18,
            homePageFontSize: 16,
            fontFamily: "'Microsoft YaHei', 'PingFang SC', sans-serif",
            lineHeight: '1.8',
            letterSpacing: '0',
            paragraphSpacing: '0.8',
            pageTurnMode: 'page'
        },
        allBookProgress: {},
        readingHistory: [],
        pendingRestore: null
    };
}

let pendingUserState = null;
let userStateSaveTimer = null;
let userStateWriting = false;

async function ensureUserDataDir() {
    const userDataPath = app.getPath('userData');
    await fsPromises.mkdir(userDataPath, { recursive: true });
    return userDataPath;
}

async function getDataFilePath(fileName) {
    const userDataPath = await ensureUserDataDir();
    return path.join(userDataPath, fileName);
}

async function moveFileWithFallback(source, target) {
    try {
        await fsPromises.rename(source, target);
    } catch (error) {
        try {
            await fsPromises.copyFile(source, target);
        } catch (copyError) {
            throw copyError;
        }
    }
}

async function migrateDataFile(fileName) {
    const legacyPath = path.join(path.dirname(app.getPath('exe')), fileName);
    const newPath = await getDataFilePath(fileName);

    if (fs.existsSync(legacyPath) && !fs.existsSync(newPath)) {
        try {
            await moveFileWithFallback(legacyPath, newPath);
            console.log(`已迁移 ${fileName} 至用户数据目录`);
        } catch (error) {
            console.error(`迁移 ${fileName} 失败:`, error);
        }
    }
}

async function migrateDataFiles() {
    await migrateDataFile(RANDOM_STATE_FILE);
    await migrateDataFile(CONFIG_FILE);
}

async function readUserState() {
    try {
        const stateFilePath = await getDataFilePath(USER_STATE_FILE);
        if (!fs.existsSync(stateFilePath)) {
            return getDefaultUserState();
        }

        const data = await fsPromises.readFile(stateFilePath, 'utf8');
        const parsed = JSON.parse(data);
        return {
            ...getDefaultUserState(),
            ...parsed,
            readerSettings: {
                ...getDefaultUserState().readerSettings,
                ...(parsed.readerSettings || {})
            },
            allBookProgress: parsed.allBookProgress || {},
            readingHistory: parsed.readingHistory || [],
            pendingRestore: parsed.pendingRestore || null
        };
    } catch (error) {
        console.error('读取用户状态失败，使用默认值:', error);
        return getDefaultUserState();
    }
}

async function writeUserState(state) {
    const stateFilePath = await getDataFilePath(USER_STATE_FILE);

    if (userStateWriting) {
        pendingUserState = state;
        return;
    }

    userStateWriting = true;
    try {
        await fsPromises.writeFile(stateFilePath, JSON.stringify(state, null, 4));
    } catch (error) {
        console.error('保存用户状态失败:', error);
    } finally {
        userStateWriting = false;

        if (pendingUserState) {
            const nextState = pendingUserState;
            pendingUserState = null;
            await writeUserState(nextState);
        }
    }
}

function scheduleUserStateSave(state) {
    pendingUserState = state;

    if (userStateSaveTimer) {
        clearTimeout(userStateSaveTimer);
    }

    userStateSaveTimer = setTimeout(() => {
        if (pendingUserState) {
            writeUserState(pendingUserState);
            pendingUserState = null;
        }
    }, USER_STATE_SAVE_DELAY);
}

// 加载随机状态
async function loadRandomState() {
    try {
        const stateFilePath = await getDataFilePath(RANDOM_STATE_FILE);
        
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
        const stateFilePath = await getDataFilePath(RANDOM_STATE_FILE);
        
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
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
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
    await migrateDataFiles();
    // 加载随机状态
    await loadRandomState();
    createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', async () => {
    if (pendingUserState) {
        const stateToSave = pendingUserState;
        pendingUserState = null;
        await writeUserState(stateToSave);
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

// 用户状态持久化
ipcMain.handle('load-user-state', async () => {
    return await readUserState();
});

ipcMain.handle('save-user-state', async (event, state) => {
    scheduleUserStateSave(state || getDefaultUserState());
    return true;
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

// 修改文件搜索处理
ipcMain.handle('search-file', async (event, baseDir, fileName) => {
    async function searchInDir(dir) {
        try {
            const entries = await fsPromises.readdir(dir, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    try {
                        const result = await searchInDir(fullPath);
                        if (result) return result;
                    } catch (error) {
                        console.error(`搜索目录 ${fullPath} 时出错:`, error);
                        continue;
                    }
                } else if (entry.name.toLowerCase() === fileName.toLowerCase()) {
                    return fullPath;
                }
            }
        } catch (error) {
            console.error(`读取目录 ${dir} 时出错:`, error);
        }
        return null;
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
        const configPath = await getDataFilePath(CONFIG_FILE);
        
        // 如果配置文件不存在，创建默认配置
        if (!fs.existsSync(configPath)) {
            const defaultConfig = {
                baseDir: 'E:\\18\\utf',
                searchDirs: ['E:\\18\\utf'],  // 默认搜索目录
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
        return {
            baseDir: 'E:\\18\\utf',
            searchDirs: ['E:\\18\\utf'],  // 默认搜索目录
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

// 递归获取所有 TXT 文件
async function getAllTxtFiles(dir) {
    const files = [];
    
    async function scan(directory) {
        const entries = await fsPromises.readdir(directory, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(directory, entry.name);
            
            if (entry.isDirectory()) {
                await scan(fullPath);
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.txt')) {
                files.push(fullPath);
            }
        }
    }
    
    await scan(dir);
    return files;
}

// 添加保存配置的处理函数
ipcMain.handle('save-config', async (event, newSettings) => {
    try {
        const configPath = await getDataFilePath(CONFIG_FILE);
        
        // 读取现有配置
        let config = {};
        try {
            const configData = await fsPromises.readFile(configPath, 'utf8');
            config = JSON.parse(configData);
        } catch (error) {
            // 如果文件不存在或无法解析，使用默认配置
            config = {
                baseDir: 'E:\\18\\utf',
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