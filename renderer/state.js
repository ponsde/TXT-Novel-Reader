import { createEventBus } from './eventBus.js';

const defaultState = {
    fileName: '',
    chapters: [],
    currentContent: [],
    currentChapter: 0,
    currentPage: 0,
    wordsPerPage: 4000,
    theme: 'light',
    fontSize: 18,
    homePageFontSize: 16,
    pageTurnMode: 'page',
    baseDir: 'E:/18/utf',
    searchDirs: [],
    history: [],
};

class ReaderState {
    constructor() {
        this.bus = createEventBus();
        this.state = { ...defaultState };
    }

    on(event, handler) {
        return this.bus.on(event, handler);
    }

    emit(event, payload) {
        this.bus.emit(event, payload);
    }

    get(key) {
        return this.state[key];
    }

    set(partial) {
        this.state = { ...this.state, ...partial };
        this.emit('state:change', this.state);
    }

    reset() {
        this.state = { ...defaultState };
        this.emit('state:change', this.state);
    }
}

export const readerState = new ReaderState();
