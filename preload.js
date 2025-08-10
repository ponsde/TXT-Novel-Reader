const { contextBridge, ipcRenderer } = require('electron');

// 安全地暴露 Electron 的 API 到渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
    // 文件操作
    readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
    searchFile: (baseDir, fileName) => ipcRenderer.invoke('search-file', baseDir, fileName),
    
    // 配置操作
    loadConfig: () => ipcRenderer.invoke('load-config'),
    saveConfig: (newSettings) => ipcRenderer.invoke('save-config', newSettings),
    
    // 随机文件
    getRandomFile: (baseDir) => ipcRenderer.invoke('get-random-file', baseDir),
    
    // 目录选择
    selectDirectory: () => ipcRenderer.invoke('select-directory'),
    
    // 查找文件位置
    findAndOpenFileLocation: (searchPaths, fileName) => ipcRenderer.invoke('find-and-open-file-location', searchPaths, fileName)
});

// 添加控制台日志以便调试
console.log('预加载脚本已执行'); 