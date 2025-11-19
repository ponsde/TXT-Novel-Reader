import { readerState } from './state.js';
import { parseChapters } from './chapterParser.js';
import { electronAPI } from './electronBridge.js';

const CHUNK_SIZE = 1024 * 1024 * 4;

function decodeBuffer(buffer, fileName) {
    return new Promise((resolve, reject) => {
        const worker = new Worker('./renderer/workers/fileWorker.js');
        worker.onmessage = (e) => {
            worker.terminate();
            const { error, text, encoding } = e.data;
            if (error) {
                reject(new Error(error));
            } else {
                resolve({ text, encoding });
            }
        };
        worker.onerror = (err) => {
            worker.terminate();
            reject(err);
        };
        worker.postMessage({ buffer, fileName });
    });
}

async function readLocalFile(file) {
    return new Promise((resolve, reject) => {
        let offset = 0;
        const chunks = [];
        const reader = new FileReader();

        reader.onload = (e) => {
            if (e.target.result) {
                chunks.push(e.target.result);
                offset += CHUNK_SIZE;
                if (offset < file.size) {
                    readNext();
                } else {
                    const merged = mergeBuffers(chunks);
                    resolve(merged);
                }
            }
        };

        reader.onerror = (e) => reject(e);

        function readNext() {
            const slice = file.slice(offset, offset + CHUNK_SIZE);
            reader.readAsArrayBuffer(slice);
        }

        readNext();
    });
}

function mergeBuffers(buffers) {
    const totalLength = buffers.reduce((acc, buffer) => acc + buffer.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    buffers.forEach(buffer => {
        result.set(new Uint8Array(buffer), offset);
        offset += buffer.byteLength;
    });
    return result.buffer;
}

function paginateWithoutChapters(text, wordsPerPage) {
    const pages = [];
    for (let i = 0; i < text.length; i += wordsPerPage) {
        pages.push(text.slice(i, i + wordsPerPage));
    }
    return pages.length ? pages : [text];
}

async function handleDecodedText(text, fileName, encoding) {
    const wordsPerPage = readerState.get('wordsPerPage');
    readerState.set({ fileName });
    const { chapters, noChapters } = await parseChapters(text, wordsPerPage);

    if (noChapters) {
        const pages = paginateWithoutChapters(text, wordsPerPage);
        readerState.set({
            chapters: [],
            currentContent: pages,
            currentPage: 0,
            currentChapter: 0
        });
        readerState.emit('content:ready', { text, encoding, totalPages: pages.length });
    } else {
        readerState.set({ chapters, currentPage: 0, currentChapter: 0 });
        readerState.emit('chapters:ready', { chapters, encoding });
    }
}

export async function loadLocalFile(file) {
    const buffer = await readLocalFile(file);
    const { text, encoding } = await decodeBuffer(buffer, file.name);
    await handleDecodedText(text, file.name, encoding);
}

export async function loadFromPath(filePath) {
    const fileBuffer = await electronAPI.readFile(filePath);
    const normalized = fileBuffer instanceof ArrayBuffer
        ? fileBuffer
        : fileBuffer.buffer.slice(fileBuffer.byteOffset || 0, (fileBuffer.byteOffset || 0) + fileBuffer.byteLength);
    const { text, encoding } = await decodeBuffer(normalized, filePath.split('\\').pop());
    await handleDecodedText(text, filePath.split('\\').pop(), encoding);
}
