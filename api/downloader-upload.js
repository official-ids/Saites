const { put } = require('@vercel/blob');
const crypto = require('crypto');
const { kv } = require('@vercel/kv');
const busboy = require('busboy');

// ============================================
// Константы
// ============================================

/**
 * Максимальный размер загружаемого файла (100 МБ)
 * @constant {number}
 */
const MAX_FILE_SIZE = 100 * 1024 * 1024;

/**
 * Путь для сохранения файлов в Blob Storage
 * @constant {string}
 */
const BLOB_PATH_PREFIX = 'downloads/';

/**
 * Префикс для ключей метаданных в KV
 * @constant {string}
 */
const KV_META_PREFIX = 'download:sha256:';

/**
 * Ключ индекса всех файлов в KV
 * @constant {string}
 */
const KV_INDEX_KEY = 'download:files:index';

/**
 * Ожидаемый заголовок авторизации
 * @constant {string}
 */
const AUTH_HEADER_PREFIX = 'Bearer ';

// ============================================
// Обработчик API
// ============================================

/**
 * API endpoint для загрузки файлов с дедупликацией по SHA-256
 * 
 * @param {import('next/server').NextApiRequest} req - HTTP запрос
 * @param {import('next/server').NextApiResponse} res - HTTP ответ
 * @returns {Promise<void>}
 */
module.exports = async (req, res) => {
    // Проверка метода HTTP
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Проверка токена авторизации
    const authHeader = req.headers.authorization;
    const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
    
    if (!authHeader || !authHeader.startsWith(AUTH_HEADER_PREFIX) || authHeader.split(' ')[1] !== ADMIN_TOKEN) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    try {
        // Парсинг multipart/form-data
        const { fileBuffer, fileName, contentType } = await parseMultipartRequest(req);

        if (!fileBuffer) {
            return res.status(400).json({ error: 'No file provided' });
        }

        // Вычисление SHA-256 хеша файла
        const hash = computeFileHash(fileBuffer);

        // Проверка существования файла (дедупликация)
        const existingFile = await getExistingFile(hash);
        if (existingFile) {
            return res.json({
                existed: true,
                hash,
                url: `/downloader/${hash}`,
                name: existingFile.name,
                size: parseInt(existingFile.size, 10),
                sizeFormatted: formatSize(parseInt(existingFile.size, 10))
            });
        }

        // Загрузка нового файла в Blob Storage
        const blobUrl = await uploadToBlobStorage(fileBuffer, hash, fileName, contentType);

        // Сохранение метаданных в KV
        const metadata = createFileMetadata(hash, blobUrl, fileName, fileBuffer.length, contentType);
        await saveFileMetadata(hash, metadata);

        // Ответ клиенту
        res.json({
            existed: false,
            hash,
            url: `/downloader/${hash}`,
            name: metadata.name,
            size: fileBuffer.length,
            sizeFormatted: formatSize(fileBuffer.length)
        });

    } catch (err) {
        console.error('[downloader-upload]', err);
        res.status(500).json({ error: err.message || 'Upload failed' });
    }
};

// ============================================
// Парсинг запроса
// ============================================

/**
 * Парсинг multipart/form-data запроса
 * 
 * @param {import('next/server').NextApiRequest} req - HTTP запрос
 * @returns {Promise<{fileBuffer: Buffer|null, fileName: string|null, contentType: string|null}>}
 */
async function parseMultipartRequest(req) {
    return new Promise((resolve, reject) => {
        const bb = busboy({ 
            headers: req.headers, 
            limits: { fileSize: MAX_FILE_SIZE } 
        });
        
        let fileBuffer = null;
        let fileName = null;
        let contentType = null;

        bb.on('file', (name, file, info) => {
            fileName = info.filename;
            contentType = info.mimeType;
            const chunks = [];
            
            file.on('data', (data) => {
                chunks.push(data);
            });
            
            file.on('end', () => {
                fileBuffer = Buffer.concat(chunks);
            });
        });
        
        bb.on('finish', () => {
            resolve({ fileBuffer, fileName, contentType });
        });
        
        bb.on('error', reject);
        
        req.pipe(bb);
    });
}

// ============================================
// Работа с файлами
// ============================================

/**
 * Вычисление SHA-256 хеша файла
 * 
 * @param {Buffer} fileBuffer - Буфер файла
 * @returns {string} - SHA-256 хеш в hex формате
 */
function computeFileHash(fileBuffer) {
    return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

/**
 * Получение информации о существующем файле из KV
 * 
 * @param {string} hash - SHA-256 хеш файла
 * @returns {Promise<Object|null>} - Метаданные файла или null
 */
async function getExistingFile(hash) {
    const existing = await kv.hgetall(`${KV_META_PREFIX}${hash}`);
    return (existing && existing.hash) ? existing : null;
}

/**
 * Загрузка файла в Vercel Blob Storage
 * 
 * @param {Buffer} fileBuffer - Буфер файла
 * @param {string} hash - SHA-256 хеш файла
 * @param {string} fileName - Имя файла
 * @param {string} contentType - MIME тип файла
 * @returns {Promise<string>} - URL загруженного файла
 */
async function uploadToBlobStorage(fileBuffer, hash, fileName, contentType) {
    const ext = extractFileExtension(fileName);
    const blobPath = `${BLOB_PATH_PREFIX}${hash}${ext}`;
    
    const blob = await put(blobPath, fileBuffer, {
        access: 'public',
        addRandomSuffix: false,
        contentType: contentType
    });

    return blob.url;
}

/**
 * Извлечение расширения файла из имени
 * 
 * @param {string} fileName - Имя файла
 * @returns {string} - Расширение файла (например, '.jpg')
 */
function extractFileExtension(fileName) {
    const match = fileName.match(/\.[a-z0-9]+$/i);
    return match ? match[0] : '.bin';
}

// ============================================
// Работа с метаданными
// ============================================

/**
 * Создание объекта метаданных файла
 * 
 * @param {string} hash - SHA-256 хеш файла
 * @param {string} url - URL файла в Blob Storage
 * @param {string} name - Имя файла
 * @param {number} size - Размер файла в байтах
 * @param {string} contentType - MIME тип файла
 * @returns {Object} - Объект метаданных
 */
function createFileMetadata(hash, url, name, size, contentType) {
    return {
        hash,
        url,
        name,
        size: String(size),
        contentType,
        uploadedAt: new Date().toISOString(),
        downloads: '0'
    };
}

/**
 * Сохранение метаданных файла в KV и добавление в индекс
 * 
 * @param {string} hash - SHA-256 хеш файла
 * @param {Object} metadata - Объект метаданных
 * @returns {Promise<void>}
 */
async function saveFileMetadata(hash, metadata) {
    await kv.hset(`${KV_META_PREFIX}${hash}`, metadata);
    await kv.sadd(KV_INDEX_KEY, hash);
}

// ============================================
// Утилиты
// ============================================

/**
 * Форматирование размера файла в читаемый вид
 * 
 * @param {number} bytes - Размер в байтах
 * @returns {string} - Отформатированный размер (например, '1.5 MB')
 * 
 * @example
 * formatSize(1024); // '1.0 KB'
 * formatSize(1048576); // '1.00 MB'
 */
function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}