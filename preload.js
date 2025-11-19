const { contextBridge, ipcRenderer } = require('electron');

const api = {
    // 文件操作
    readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
    searchFile: (baseDir, fileName) => ipcRenderer.invoke('search-file', baseDir, fileName),

    // 配置操作
    loadConfig: () => ipcRenderer.invoke('load-config'),
    saveConfig: (newSettings) => ipcRenderer.invoke('save-config', newSettings),

    // 随机文件
    getRandomFile: (baseDir) => ipcRenderer.invoke('get-random-file', baseDir),
    resetRandomState: () => ipcRenderer.invoke('reset-random-state'),

    // 目录选择
    selectDirectory: () => ipcRenderer.invoke('select-directory'),

    // 查找文件位置
    findAndOpenFileLocation: (searchPaths, fileName) => ipcRenderer.invoke('find-and-open-file-location', searchPaths, fileName)
};

contextBridge.exposeInMainWorld('electronAPI', api);

console.log('预加载脚本已执行');
