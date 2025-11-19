self.onmessage = function(e) {
    const { text, wordsPerPage } = e.data;
    try {
        const chapterRegex = /(第[〇零一二三四五六七八九十百千0-9]+[章节卷部回集篇节]\s*[^\n]*)|(^\s*第\s*[0-9]+\s*章)/i;
        const lines = text.split(/\n+/);
        const chapters = [];
        let buffer = [];
        let lastTitle = '开始';

        const flushChapter = (title) => {
            if (buffer.length === 0) return;
            chapters.push({ title: lastTitle, content: buffer.join('\n') });
            buffer = [];
            lastTitle = title;
        };

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (chapterRegex.test(line)) {
                flushChapter(line || '未命名章节');
            }
            buffer.push(rawLine);
        }

        if (buffer.length) {
            flushChapter('');
        }

        if (chapters.length === 0) {
            self.postMessage({ chapters: [], noChapters: true });
            return;
        }

        self.postMessage({ chapters, noChapters: false });
    } catch (error) {
        self.postMessage({ error: error.message });
    }
};
