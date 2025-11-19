import { readerState } from './state.js';
import { loadLocalFile, loadFromPath } from './fileLoader.js';
import { electronAPI } from './electronBridge.js';

const contentEl = document.getElementById('content');
const progressBarEl = document.getElementById('progress-bar');
const progressPercentageEl = document.getElementById('progress-percentage');
const pageInfoEl = document.getElementById('page-info');
const chapterListEl = document.getElementById('chapter-list');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingMessage = loadingOverlay?.querySelector('.loading-message');

function setLoading(message) {
    if (!loadingOverlay) return;
    loadingOverlay.style.display = message ? 'flex' : 'none';
    if (loadingMessage && message) {
        loadingMessage.textContent = message;
    }
}

function renderParagraphs(text) {
    const paragraphs = text.split('\n');
    return paragraphs.map(line => line.trim() ? `<p>${line}</p>` : '<p><br></p>').join('');
}

function renderPage() {
    const chapters = readerState.get('chapters');
    const wordsPerPage = readerState.get('wordsPerPage');
    const currentPage = readerState.get('currentPage');
    const currentChapter = readerState.get('currentChapter');

    const settings = JSON.parse(localStorage.getItem('readerSettings') || '{}');

    if (chapters.length === 0) {
        const pages = readerState.get('currentContent');
        const totalPages = pages.length || 1;
        const safePage = Math.min(Math.max(currentPage, 0), totalPages - 1);
        const pageText = pages[safePage] || '';
        contentEl.innerHTML = renderParagraphs(pageText);
        pageInfoEl.textContent = `第 ${safePage + 1}/${totalPages} 页`;
        readerState.set({ currentPage: safePage });
        updateProgress(totalPages, safePage + 1);
        saveProgress();
        if (settings.paragraphSpacing) {
            document.querySelectorAll('#content p').forEach(p => {
                p.style.marginBottom = `${settings.paragraphSpacing}em`;
            });
        }
        return;
    }

    const chapter = chapters[currentChapter];
    if (!chapter) return;
    const totalPages = Math.max(1, Math.ceil(chapter.content.length / wordsPerPage));
    const safePage = Math.min(Math.max(currentPage, 0), totalPages - 1);
    const start = safePage * wordsPerPage;
    const end = start + wordsPerPage;
    const slice = chapter.content.slice(start, end);
    contentEl.innerHTML = renderParagraphs(slice);
    pageInfoEl.textContent = `第 ${safePage + 1}/${totalPages} 页`;
    readerState.set({ currentPage: safePage });
    updateProgress(totalPages, safePage + 1);
    saveProgress();
    if (settings.paragraphSpacing) {
        document.querySelectorAll('#content p').forEach(p => {
            p.style.marginBottom = `${settings.paragraphSpacing}em`;
        });
    }
}

function updateProgress(totalPages, currentPage) {
    const percentage = totalPages ? Math.min(100, Math.round((currentPage / totalPages) * 100)) : 0;
    progressBarEl.style.width = `${percentage}%`;
    progressPercentageEl.textContent = `${percentage}%`;
}

function showNotification(message) {
    if (!message) return;
    const el = document.createElement('div');
    el.className = 'notification';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
}

function applyTheme(theme) {
    document.body.classList.toggle('dark-mode', theme === 'dark');
}

function applyFontSettings() {
    const settings = JSON.parse(localStorage.getItem('readerSettings') || '{}');
    if (settings.fontFamily) {
        contentEl.style.fontFamily = settings.fontFamily;
        document.getElementById('font-family-selector').value = settings.fontFamily;
    }
    if (settings.lineHeight) {
        contentEl.style.lineHeight = settings.lineHeight;
        document.getElementById('line-height-slider').value = settings.lineHeight;
        document.getElementById('line-height-value').textContent = settings.lineHeight;
    }
    if (settings.letterSpacing) {
        contentEl.style.letterSpacing = `${settings.letterSpacing}em`;
        document.getElementById('letter-spacing-slider').value = settings.letterSpacing;
        document.getElementById('letter-spacing-value').textContent = settings.letterSpacing;
    }
    if (settings.paragraphSpacing) {
        document.getElementById('paragraph-spacing-slider').value = settings.paragraphSpacing;
        document.getElementById('paragraph-spacing-value').textContent = `${settings.paragraphSpacing}em`;
        document.querySelectorAll('#content p').forEach(p => {
            p.style.marginBottom = `${settings.paragraphSpacing}em`;
        });
    }
}

function saveProgress() {
    const { fileName, currentPage, currentChapter, chapters, currentContent } = readerState.state;
    if (!fileName) return;
    const allBookProgress = JSON.parse(localStorage.getItem('allBookProgress') || '{}');
    const totalPages = chapters.length > 0
        ? Math.max(1, Math.ceil((chapters[currentChapter]?.content.length || 0) / readerState.get('wordsPerPage')))
        : currentContent.length || 1;
    allBookProgress[fileName] = {
        page: currentPage,
        chapter: chapters.length > 0 ? currentChapter : 0,
        totalPages,
        lastRead: new Date().toISOString()
    };
    localStorage.setItem('allBookProgress', JSON.stringify(allBookProgress));
    updateHistoryRecord();
}

function updateHistoryRecord() {
    const { fileName, currentPage, currentChapter, chapters, currentContent } = readerState.state;
    if (!fileName) return;
    const history = JSON.parse(localStorage.getItem('readingHistory') || '[]');
    const totalPages = chapters.length > 0
        ? Math.max(1, Math.ceil((chapters[currentChapter]?.content.length || 0) / readerState.get('wordsPerPage')))
        : currentContent.length || 1;
    const existing = history.findIndex(item => item.fileName === fileName);
    const record = {
        fileName,
        lastPosition: currentPage,
        chapter: chapters.length > 0 ? currentChapter : 0,
        lastRead: new Date().toISOString(),
        totalPages
    };
    if (existing >= 0) {
        history.splice(existing, 1, record);
    } else {
        history.unshift(record);
    }
    localStorage.setItem('readingHistory', JSON.stringify(history.slice(0, 50)));
    readerState.set({ history });
}

function updateChapterList() {
    const chapters = readerState.get('chapters');
    if (!chapters.length) {
        chapterListEl.classList.add('hidden');
        chapterListEl.innerHTML = '';
        return;
    }
    chapterListEl.innerHTML = chapters
        .map((chapter, index) => `<div class="chapter-item ${index === readerState.get('currentChapter') ? 'active' : ''}" data-index="${index}">${chapter.title || `第 ${index + 1} 章`}</div>`)
        .join('');
}

function restoreProgress() {
    const { fileName, chapters } = readerState.state;
    if (!fileName) return;
    const allBookProgress = JSON.parse(localStorage.getItem('allBookProgress') || '{}');
    const progress = allBookProgress[fileName];
    if (!progress) return;
    readerState.set({
        currentPage: progress.page || 0,
        currentChapter: chapters.length > 0 ? (progress.chapter || 0) : 0
    });
}

async function handleRandomBook() {
    setLoading('正在获取随机书籍...');
    try {
        const filePath = await electronAPI.getRandomFile(readerState.get('baseDir'));
        if (!filePath) {
            showNotification('没有找到任何 TXT 文件');
            return;
        }
        await loadFromPath(filePath);
        document.getElementById('book-title').textContent = filePath.split('\\').pop()?.replace('.txt', '') || '优雅阅读器';
        restoreProgress();
        renderPage();
        updateChapterList();
    } catch (error) {
        showNotification(`加载失败: ${error.message}`);
    } finally {
        setLoading('');
    }
}

function bindFontControls() {
    document.getElementById('font-family-selector').addEventListener('change', (e) => {
        const fontFamily = e.target.value;
        contentEl.style.fontFamily = fontFamily;
        const settings = JSON.parse(localStorage.getItem('readerSettings') || '{}');
        settings.fontFamily = fontFamily;
        localStorage.setItem('readerSettings', JSON.stringify(settings));
    });

    document.getElementById('line-height-slider').addEventListener('input', (e) => {
        const value = e.target.value;
        document.getElementById('line-height-value').textContent = value;
        contentEl.style.lineHeight = value;
        const settings = JSON.parse(localStorage.getItem('readerSettings') || '{}');
        settings.lineHeight = value;
        localStorage.setItem('readerSettings', JSON.stringify(settings));
    });

    document.getElementById('letter-spacing-slider').addEventListener('input', (e) => {
        const value = e.target.value;
        document.getElementById('letter-spacing-value').textContent = value;
        contentEl.style.letterSpacing = `${value}em`;
        const settings = JSON.parse(localStorage.getItem('readerSettings') || '{}');
        settings.letterSpacing = value;
        localStorage.setItem('readerSettings', JSON.stringify(settings));
    });

    document.getElementById('paragraph-spacing-slider').addEventListener('input', (e) => {
        const value = e.target.value;
        document.getElementById('paragraph-spacing-value').textContent = `${value}em`;
        document.querySelectorAll('#content p').forEach(p => {
            p.style.marginBottom = `${value}em`;
        });
        const settings = JSON.parse(localStorage.getItem('readerSettings') || '{}');
        settings.paragraphSpacing = value;
        localStorage.setItem('readerSettings', JSON.stringify(settings));
    });
}

function bindNavigation() {
    document.getElementById('prev-page').addEventListener('click', () => {
        const chapters = readerState.get('chapters');
        if (chapters.length === 0) {
            readerState.set({ currentPage: Math.max(0, readerState.get('currentPage') - 1) });
        } else {
            if (readerState.get('currentPage') > 0) {
                readerState.set({ currentPage: readerState.get('currentPage') - 1 });
            } else if (readerState.get('currentChapter') > 0) {
                const prevChapterIdx = readerState.get('currentChapter') - 1;
                const prevChapter = chapters[prevChapterIdx];
                const totalPages = Math.max(1, Math.ceil(prevChapter.content.length / readerState.get('wordsPerPage')));
                readerState.set({ currentChapter: prevChapterIdx, currentPage: totalPages - 1 });
            }
        }
        renderPage();
    });

    document.getElementById('next-page').addEventListener('click', () => {
        const chapters = readerState.get('chapters');
        const wordsPerPage = readerState.get('wordsPerPage');
        if (chapters.length === 0) {
            const pages = readerState.get('currentContent');
            const totalPages = pages.length || 1;
            if (readerState.get('currentPage') < totalPages - 1) {
                readerState.set({ currentPage: readerState.get('currentPage') + 1 });
            }
            renderPage();
            return;
        }
        const chapter = chapters[readerState.get('currentChapter')];
        const totalPages = Math.max(1, Math.ceil(chapter.content.length / wordsPerPage));
        if (readerState.get('currentPage') < totalPages - 1) {
            readerState.set({ currentPage: readerState.get('currentPage') + 1 });
        } else if (readerState.get('currentChapter') < chapters.length - 1) {
            readerState.set({ currentChapter: readerState.get('currentChapter') + 1, currentPage: 0 });
        }
        renderPage();
    });
}

function bindSidebar() {
    document.getElementById('toggle-chapters').addEventListener('click', () => {
        chapterListEl.classList.toggle('hidden');
        updateChapterList();
    });

    document.getElementById('toggle-theme').addEventListener('click', () => {
        const nextTheme = document.body.classList.contains('dark-mode') ? 'light' : 'dark';
        readerState.set({ theme: nextTheme });
        applyTheme(nextTheme);
        electronAPI.saveConfig({ theme: nextTheme }).catch(() => {});
    });

    document.getElementById('toggle-font-panel').addEventListener('click', () => {
        document.getElementById('font-settings-panel').classList.toggle('hidden');
    });

    document.getElementById('font-size-up').addEventListener('click', () => {
        const nextSize = (readerState.get('fontSize') || 18) + 1;
        readerState.set({ fontSize: nextSize });
        contentEl.style.fontSize = `${nextSize}px`;
    });

    document.getElementById('font-size-down').addEventListener('click', () => {
        const nextSize = Math.max(12, (readerState.get('fontSize') || 18) - 1);
        readerState.set({ fontSize: nextSize });
        contentEl.style.fontSize = `${nextSize}px`;
    });

    document.getElementById('go-home').addEventListener('click', () => {
        readerState.reset();
        document.getElementById('book-title').textContent = '优雅阅读器';
        contentEl.innerHTML = '<p>请选择一个 TXT 文件开始阅读</p>';
        chapterListEl.classList.add('hidden');
        updateProgress(1, 0);
    });

    document.getElementById('close-font-panel').addEventListener('click', () => {
        document.getElementById('font-settings-panel').classList.add('hidden');
    });
}

function bindChapterListClick() {
    chapterListEl.addEventListener('click', (event) => {
        const target = event.target.closest('.chapter-item');
        if (!target) return;
        const index = Number(target.dataset.index);
        readerState.set({ currentChapter: index, currentPage: 0 });
        renderPage();
        updateChapterList();
    });
}

function bindContextMenu() {
    const menu = document.getElementById('context-menu');
    document.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const selection = window.getSelection();
        if (!selection || selection.toString().trim() === '') return;
        menu.style.top = `${event.clientY}px`;
        menu.style.left = `${event.clientX}px`;
        menu.style.display = 'block';
    });

    document.addEventListener('click', () => {
        menu.style.display = 'none';
    });

    menu.addEventListener('click', (event) => {
        const action = event.target.dataset.action;
        const selection = window.getSelection()?.toString() || '';
        if (!action || !selection) return;
        switch (action) {
            case 'copy':
                navigator.clipboard?.writeText(selection);
                break;
            case 'translate':
                window.open(`https://translate.google.com/?sl=auto&tl=zh-CN&text=${encodeURIComponent(selection)}`);
                break;
            case 'search':
                window.open(`https://www.baidu.com/s?wd=${encodeURIComponent(selection)}`);
                break;
            case 'tts':
                const utterance = new SpeechSynthesisUtterance(selection);
                speechSynthesis.speak(utterance);
                break;
            default:
                break;
        }
    });
}

function bindFileInput() {
    const fileInput = document.getElementById('file-input');
    document.getElementById('pick-file-btn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        setLoading('准备加载文件...');
        try {
            await loadLocalFile(file);
            document.getElementById('book-title').textContent = file.name.replace('.txt', '');
            restoreProgress();
            renderPage();
            updateChapterList();
        } catch (error) {
            showNotification(`文件处理失败: ${error.message}`);
        } finally {
            setLoading('');
            fileInput.value = '';
        }
    });
}

function bindRandomButton() {
    document.getElementById('random-book-btn').addEventListener('click', () => {
        handleRandomBook();
    });
}

function restoreConfig() {
    electronAPI.loadConfig()
        .then(config => {
            if (config?.theme) {
                readerState.set({ theme: config.theme });
                applyTheme(config.theme);
            }
            if (Array.isArray(config?.searchDirs)) {
                readerState.set({ searchDirs: config.searchDirs });
            }
        })
        .catch(() => {});
}

export function bootstrapUI() {
    bindFontControls();
    bindNavigation();
    bindSidebar();
    bindChapterListClick();
    bindContextMenu();
    bindFileInput();
    bindRandomButton();
    document.getElementById('page-turn-mode').addEventListener('change', (event) => {
        readerState.set({ pageTurnMode: event.target.value });
    });
    applyFontSettings();
    restoreConfig();
    readerState.on('state:change', () => updateChapterList());
    readerState.on('chapters:ready', () => {
        setLoading('加载完成');
        updateChapterList();
        renderPage();
    });
    readerState.on('content:ready', () => {
        setLoading('加载完成');
        renderPage();
    });
}
