// 引入本地 GBK 解码库
importScripts('../../vendor/gbk.min.js');

self.onmessage = function(e) {
    const arrayBuffer = e.data.buffer;
    const fileName = e.data.fileName;
    let text = null;
    let successEncoding = '';

    try {
        const encodings = [
            'utf-8',
            'gbk',
            'big5',
            'shift_jis',
            'euc-kr',
            'windows-1252',
            'iso-8859-1',
            'iso-8859-2',
            'iso-8859-5',
            'iso-8859-7',
            'utf-16le',
            'utf-16be',
            'iso-8859-9',
            'windows-1256',
            'windows-1251',
            'windows-1254',
            'koi8-r',
            'euc-jp',
            'gb18030',
            'hz-gb-2312',
            'iso-2022-jp',
            'iso-2022-kr',
            'iso-8859-6',
            'iso-8859-8',
            'windows-874',
            'windows-1255',
            'windows-1258'
        ];

        const byteArray = new Uint8Array(arrayBuffer.slice(0, 4));
        if (byteArray[0] === 0xEF && byteArray[1] === 0xBB && byteArray[2] === 0xBF) {
            const decoder = new TextDecoder('utf-8');
            text = decoder.decode(arrayBuffer);
            successEncoding = 'utf-8 (BOM)';
        } else if (byteArray[0] === 0xFE && byteArray[1] === 0xFF) {
            const decoder = new TextDecoder('utf-16be');
            text = decoder.decode(arrayBuffer);
            successEncoding = 'utf-16be (BOM)';
        } else if (byteArray[0] === 0xFF && byteArray[1] === 0xFE) {
            const decoder = new TextDecoder('utf-16le');
            text = decoder.decode(arrayBuffer);
            successEncoding = 'utf-16le (BOM)';
        } else if (byteArray[0] === 0x00 && byteArray[1] === 0x00 && byteArray[2] === 0xFE && byteArray[3] === 0xFF) {
            try {
                const decoder = new TextDecoder('utf-32be');
                text = decoder.decode(arrayBuffer);
                successEncoding = 'utf-32be (BOM)';
            } catch (err) {}
        } else if (byteArray[0] === 0xFF && byteArray[1] === 0xFE && byteArray[2] === 0x00 && byteArray[3] === 0x00) {
            try {
                const decoder = new TextDecoder('utf-32le');
                text = decoder.decode(arrayBuffer);
                successEncoding = 'utf-32le (BOM)';
            } catch (err) {}
        } else {
            for (let encoding of encodings) {
                try {
                    if (encoding === 'gbk' || encoding === 'gb18030' || encoding === 'hz-gb-2312') {
                        const gbkBytes = new Uint8Array(arrayBuffer);
                        try {
                            text = GBK.decode(gbkBytes);
                            if (text && !containsUnreadableChars(text)) {
                                successEncoding = encoding;
                                break;
                            }
                        } catch (err) {
                            continue;
                        }
                    } else {
                        const decoder = new TextDecoder(encoding);
                        text = decoder.decode(arrayBuffer);
                        if (text && !containsUnreadableChars(text)) {
                            successEncoding = encoding;
                            break;
                        }
                    }
                } catch (error) {
                    continue;
                }
            }
        }

        if (!text) {
            const defaultDecoder = new TextDecoder();
            text = defaultDecoder.decode(arrayBuffer);
            successEncoding = 'default';
        }

        if (text && containsUnreadableChars(text)) {
            const fileNameLower = fileName.toLowerCase();
            if (fileNameLower.includes('gbk') || fileNameLower.includes('gb2312') || fileNameLower.includes('gb18030')) {
                const gbkBytes = new Uint8Array(arrayBuffer);
                text = GBK.decode(gbkBytes);
                successEncoding = 'gbk (filename hint)';
            } else if (fileNameLower.includes('big5')) {
                const decoder = new TextDecoder('big5');
                text = decoder.decode(arrayBuffer);
                successEncoding = 'big5 (filename hint)';
            } else if (fileNameLower.includes('sjis') || fileNameLower.includes('shift-jis')) {
                const decoder = new TextDecoder('shift-jis');
                text = decoder.decode(arrayBuffer);
                successEncoding = 'shift-jis (filename hint)';
            } else if (fileNameLower.includes('euc-kr')) {
                const decoder = new TextDecoder('euc-kr');
                text = decoder.decode(arrayBuffer);
                successEncoding = 'euc-kr (filename hint)';
            } else if (fileNameLower.includes('utf16') || fileNameLower.includes('utf-16')) {
                try {
                    const decoder = new TextDecoder('utf-16le');
                    text = decoder.decode(arrayBuffer);
                    successEncoding = 'utf-16le (filename hint)';
                } catch (err) {
                    try {
                        const decoder = new TextDecoder('utf-16be');
                        text = decoder.decode(arrayBuffer);
                        successEncoding = 'utf-16be (filename hint)';
                    } catch (err2) {}
                }
            }
        }

        self.postMessage({
            text,
            encoding: successEncoding
        });
    } catch (error) {
        self.postMessage({ error: error.message });
    }
};

function containsUnreadableChars(text) {
    const replacementChar = '\uFFFD';
    const replacementCount = (text.match(new RegExp(replacementChar, 'g')) || []).length;
    const questionMarkCount = (text.match(/\?/g) || []).length;
    const gibberishRegex = /[\x00-\x08\x0E-\x1F\x7F-\x9F\uFFFD]/g;
    const gibberishCount = (text.match(gibberishRegex) || []).length;
    const suspiciousChars = replacementCount + questionMarkCount + gibberishCount;
    const threshold = 0.1;
    return suspiciousChars > text.length * threshold;
}
