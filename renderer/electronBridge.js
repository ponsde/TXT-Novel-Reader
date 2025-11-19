const fallbackApi = {
    readFile: async () => null,
    searchFile: async () => null,
    loadConfig: async () => ({}),
    saveConfig: async () => null,
    getRandomFile: async () => null,
    resetRandomState: async () => null,
    selectDirectory: async () => null,
    findAndOpenFileLocation: async () => ({ success: false })
};

export const electronAPI = window.electronAPI ?? fallbackApi;
