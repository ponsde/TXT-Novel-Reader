export function parseChapters(text, wordsPerPage = 4000) {
    return new Promise((resolve, reject) => {
        const worker = new Worker('./renderer/workers/chapterWorker.js');
        worker.onmessage = (e) => {
            const { error, chapters, noChapters } = e.data;
            worker.terminate();
            if (error) {
                reject(new Error(error));
                return;
            }
            resolve({ chapters, noChapters });
        };
        worker.onerror = (err) => {
            worker.terminate();
            reject(err);
        };
        worker.postMessage({ text, wordsPerPage });
    });
}
