const express = require('express');
const crypto = require('crypto');
const { put, del } = require('@vercel/blob');
const { kv } = require('@vercel/kv');
const multer = require('multer');

const router = express.Router();

// ============================================
// Middleware: Multer для загрузки файлов
// ============================================

/**
 * Multer middleware для обработки multipart/form-data
 * Хранит файлы в памяти для последующей обработки
 * @type {multer.Instance}
 */
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 4.4 * 1024 * 1024 } // 4.4 МБ — максимум для Vercel Hobby
});

// ============================================
// Переменные окружения
// ============================================

/**
 * Токен администратора для защиты приватных endpoints
 * @constant {string}
 */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

if (!ADMIN_TOKEN) {
    throw new Error('ADMIN_TOKEN environment variable is required');
}

// ============================================
// Конфигурация приложения
// ============================================

/**
 * Конфигурация загрузчика файлов
 * @namespace
 */
const CONFIG = {
    /** @type {number} Максимальный размер файла в байтах (100 МБ) */
    MAX_FILE_SIZE: 100 * 1024 * 1024,
    
    /** @type {number} Максимальная длина имени файла */
    MAX_NAME_LENGTH: 255,
    
    /** @type {number} Окно rate limiting в миллисекундах (1 минута) */
    RATE_LIMIT_WINDOW: 60 * 1000,
    
    /** @type {number} Максимальное количество запросов в окне rate limiting */
    RATE_LIMIT_MAX: 60,
    
    /** @type {number} Время жизни кэша в миллисекундах (30 секунд) */
    CACHE_TTL: 30 * 1000,
    
    /** @type {number} Максимальное количество записей в кэше */
    CACHE_MAX_SIZE: 500,
    
    /** @type {number} Интервал очистки устаревших записей кэша (1 минута) */
    CACHE_CLEANUP_INTERVAL: 60000,
    
    /** @type {number} HTTP статус для редиректа на файл */
    REDIRECT_STATUS: 302
};

/**
 * Сообщения об ошибках
 * @constant {Object<string, string>}
 */
const ERROR_MESSAGES = {
    UNAUTHORIZED: 'Unauthorized',
    FORBIDDEN: 'Forbidden',
    NO_FILE: 'No file provided',
    UNSUPPORTED_TYPE: 'Unsupported file type',
    INVALID_HASH: 'Invalid SHA-256 hash format',
    INVALID_NAME: `Valid name required (1-${CONFIG.MAX_NAME_LENGTH} chars, no special chars)`,
    FILE_NOT_FOUND: 'File not found',
    TOO_MANY_REQUESTS: 'Too many requests',
    SERVER_ERROR: 'Server error',
    UPLOAD_FAILED: 'Upload failed',
    DELETE_FAILED: 'Delete failed',
    UPDATE_FAILED: 'Update failed'
};

// ============================================
// Ключи KV (Key-Value хранилище)
// ============================================

/**
 * Фабрика ключей для Vercel KV
 * @namespace
 */
const K = {
    /**
     * Ключ для метаданных файла
     * @param {string} hash - SHA-256 хеш файла
     * @returns {string} Ключ KV
     */
    FILE: (hash) => `download:sha256:${hash}`,
    
    /** @type {string} Ключ для индекса всех файлов (Set) */
    FILES_INDEX: 'download:files:index',
    
    /** @type {string} Ключ для общей статистики загрузок */
    STATS: 'download:stats:total',
    
    /** @type {string} Ключ для статистики по каждому файлу (Hash) */
    STATS_HASH: 'download:stats:per-file',
    
    /**
     * Ключ для rate limiting по IP
     * @param {string} ip - IP адрес клиента
     * @returns {string} Ключ KV
     */
    RATE_LIMIT: (ip) => `rl:download:${ip}`
};

// ============================================
// Разрешённые MIME-типы
// ============================================

/**
 * Список разрешённых MIME-типов для загрузки
 * @constant {Array<string>}
 */
const ALLOWED_MIME_TYPES = [
    // Изображения
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    
    // Документы
    'application/pdf', 'application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed',
    'text/plain', 'application/json', 'text/csv', 'application/xml',
    
    // Медиа
    'video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav', 'audio/ogg',
    
    // Office документы
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
];

// ============================================
// In-Memory кэш
// ============================================

/**
 * In-memory кэш для метаданных файлов
 * Ключ: SHA-256 хеш файла
 * Значение: { data: Object, timestamp: number }
 * @type {Map<string, {data: Object, timestamp: number}>}
 */
const fileCache = new Map();

/**
 * Время последней очистки кэша
 * @type {number}
 */
let cacheLastCleanup = Date.now();

/**
 * Получение метаданных файла из кэша
 * 
 * @param {string} hash - SHA-256 хеш файла
 * @returns {Object|null} Метаданные файла или null, если не найдены или устарели
 */
function getCachedFile(hash) {
    const entry = fileCache.get(hash);
    if (!entry) return null;
    
    // Проверка актуальности кэша
    if (Date.now() - entry.timestamp > CONFIG.CACHE_TTL) {
        fileCache.delete(hash);
        return null;
    }
    
    return entry.data;
}

/**
 * Сохранение метаданных файла в кэш
 * Автоматически очищает устаревшие записи при достижении лимита
 * 
 * @param {string} hash - SHA-256 хеш файла
 * @param {Object} data - Метаданные файла
 */
function setCachedFile(hash, data) {
    // Очистка устаревших записей при достижении лимита
    if (fileCache.size >= CONFIG.CACHE_MAX_SIZE && Date.now() - cacheLastCleanup > CONFIG.CACHE_CLEANUP_INTERVAL) {
        const now = Date.now();
        for (const [key, entry] of fileCache.entries()) {
            if (now - entry.timestamp > CONFIG.CACHE_TTL) {
                fileCache.delete(key);
            }
        }
        cacheLastCleanup = now;
    }
    
    fileCache.set(hash, { data, timestamp: Date.now() });
}

/**
 * Инвалидация кэша для конкретного файла
 * 
 * @param {string} hash - SHA-256 хеш файла
 */
function invalidateCache(hash) {
    fileCache.delete(hash);
}

// ============================================
// Middleware: Аутентификация и валидация
// ============================================

/**
 * Middleware для проверки токена администратора
 * Использует timing-safe сравнение для защиты от timing-атак
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 * @param {express.NextFunction} next - Следующий middleware
 */
function verifyAdminToken(req, res, next) {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: ERROR_MESSAGES.UNAUTHORIZED });
    }
    
    const token = authHeader.split(' ')[1];
    
    // Timing-safe сравнение для защиты от timing-атак
    const isValid = ADMIN_TOKEN
        && token
        && token.length === ADMIN_TOKEN.length
        && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN));
    
    if (!isValid) {
        logWarn('auth', 'Failed admin authentication attempt', { ip: req.ip });
        return res.status(403).json({ error: ERROR_MESSAGES.FORBIDDEN });
    }
    
    next();
}

/**
 * Middleware для валидации MIME-типа загруженного файла
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 * @param {express.NextFunction} next - Следующий middleware
 */
function validateMimeType(req, res, next) {
    if (!req.file) return next();
    
    if (!ALLOWED_MIME_TYPES.includes(req.file.mimetype)) {
        return res.status(400).json({
            error: ERROR_MESSAGES.UNSUPPORTED_TYPE,
            received: req.file.mimetype,
            allowed: ALLOWED_MIME_TYPES
        });
    }
    
    next();
}

// ============================================
// Rate Limiting
// ============================================

/**
 * Проверка и обновление rate limit для IP адреса
 * Использует Hash в KV для хранения счётчика и времени сброса
 * 
 * @param {string} key - Ключ KV для rate limit
 * @param {number} windowMs - Окно времени в миллисекундах
 * @param {number} max - Максимальное количество запросов
 * @returns {Promise<Object>} Результат проверки: { allowed, remaining, retryAfter? }
 */
async function checkRateLimit(key, windowMs, max) {
    try {
        // Получаем текущие данные из Hash
        const data = await kv.hgetall(key);
        const now = Date.now();
        
        // Если ключа нет — создаём новый
        if (!data || !data.count) {
            await kv.hset(key, { count: '1', resetAt: String(now + windowMs) });
            await kv.expire(key, Math.ceil(windowMs / 1000));
            return { allowed: true, remaining: max - 1 };
        }
        
        const resetAt = parseInt(data.resetAt, 10);
        
        // Если окно истекло — сбрасываем счётчик
        if (now > resetAt) {
            await kv.del(key);
            await kv.hset(key, { count: '1', resetAt: String(now + windowMs) });
            await kv.expire(key, Math.ceil(windowMs / 1000));
            return { allowed: true, remaining: max - 1 };
        }
        
        const count = parseInt(data.count, 10);
        
        // Если лимит исчерпан — отказываем
        if (count >= max) {
            return { 
                allowed: false, 
                retryAfter: Math.ceil((resetAt - now) / 1000),
                remaining: 0
            };
        }
        
        // Увеличиваем счётчик
        await kv.hincrby(key, 'count', 1);
        return { allowed: true, remaining: max - count - 1 };
        
    } catch (err) {
        // Если ключ имеет неправильный тип — удаляем и начинаем заново
        if (err.message && err.message.includes('WRONGTYPE')) {
            try {
                await kv.del(key);
            } catch (_) {}
            return { allowed: true, remaining: max };
        }
        
        console.error('[Rate Limit] KV error:', err.message);
        return { allowed: true, remaining: max }; // fail-open
    }
}

// ============================================
// Утилиты: Хеширование и форматирование
// ============================================

/**
 * Вычисление SHA-256 хеша буфера
 * 
 * @param {Buffer} buffer - Буфер данных
 * @returns {string} SHA-256 хеш в hex формате
 */
function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Форматирование размера файла в читаемый вид
 * 
 * @param {number} bytes - Размер в байтах
 * @returns {string} Отформатированный размер (например, '1.5 MB')
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

// ============================================
// Утилиты: Валидация
// ============================================

/**
 * Проверка валидности SHA-256 хеша
 * 
 * @param {string} hash - Хеш для проверки
 * @returns {boolean} true если хеш валиден
 * 
 * @example
 * isValidSha256('a1b2c3d4...'); // true
 * isValidSha256('invalid'); // false
 */
function isValidSha256(hash) {
    return typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash);
}

/**
 * Проверка валидности имени файла
 * 
 * @param {string} name - Имя файла для проверки
 * @returns {boolean} true если имя валидно
 * 
 * @example
 * isValidFileName('document.pdf'); // true
 * isValidFileName('file<name>.txt'); // false (недопустимые символы)
 */
function isValidFileName(name) {
    return typeof name === 'string' 
        && name.trim().length > 0 
        && name.trim().length <= CONFIG.MAX_NAME_LENGTH
        && !/[<>:"|?*\x00-\x1f]/.test(name);
}

// ============================================
// Утилиты: Логирование
// ============================================

/**
 * Логирование информационного сообщения
 * 
 * @param {string} operation - Название операции
 * @param {string} message - Текст сообщения
 * @param {Object} extra - Дополнительные данные
 */
function logInfo(operation, message, extra = {}) {
    console.log(JSON.stringify({
        level: 'info',
        operation,
        message,
        timestamp: new Date().toISOString(),
        ...extra
    }));
}

/**
 * Логирование ошибки
 * 
 * @param {string} operation - Название операции
 * @param {string} message - Текст сообщения
 * @param {Error} err - Объект ошибки
 * @param {Object} extra - Дополнительные данные
 */
function logError(operation, message, err, extra = {}) {
    console.error(JSON.stringify({
        level: 'error',
        operation,
        message,
        error: err?.message,
        stack: err?.stack,
        timestamp: new Date().toISOString(),
        ...extra
    }));
}

/**
 * Логирование предупреждения
 * 
 * @param {string} operation - Название операции
 * @param {string} message - Текст сообщения
 * @param {Object} extra - Дополнительные данные
 */
function logWarn(operation, message, extra = {}) {
    console.warn(JSON.stringify({
        level: 'warn',
        operation,
        message,
        timestamp: new Date().toISOString(),
        ...extra
    }));
}

// ============================================
// Утилиты: Измерение времени
// ============================================

/**
 * Выполнение операции с измерением времени
 * Автоматически логирует время выполнения
 * 
 * @param {string} operation - Название операции
 * @param {Function} fn - Асинхронная функция для выполнения
 * @returns {Promise<*>} Результат выполнения функции
 * @throws {Error} Если функция завершилась с ошибкой
 */
async function timed(operation, fn) {
    const start = Date.now();
    
    try {
        const result = await fn();
        logInfo(operation, 'completed', { durationMs: Date.now() - start });
        return result;
    } catch (err) {
        logError(operation, 'failed', err, { durationMs: Date.now() - start });
        throw err;
    }
}

// ============================================
// Утилиты: Миграция метаданных
// ============================================

/**
 * Миграция метаданных файла из старого формата (JSON) в новый (Hash)
 * 
 * @param {string} hash - SHA-256 хеш файла
 * @param {Object} oldMeta - Старые метаданные в формате JSON
 * @returns {Promise<Object>} Новые метаданные в формате Hash
 */
async function migrateMetadata(hash, oldMeta) {
    const newMeta = {
        hash: oldMeta.hash,
        name: oldMeta.name,
        size: String(oldMeta.size),
        contentType: oldMeta.contentType,
        uploadedAt: oldMeta.uploadedAt,
        downloads: String(oldMeta.downloads || 0),
        url: oldMeta.url
    };
    
    // Удаляем старый ключ и создаём новый Hash
    await kv.del(K.FILE(hash));
    await kv.hset(K.FILE(hash), newMeta);
    
    logInfo('migrate', 'Migrated file metadata to Hash', { hash });
    
    return newMeta;
}

/**
 * Получение метаданных файла с автоматической миграцией
 * 
 * @param {string} hash - SHA-256 хеш файла
 * @returns {Promise<Object|null>} Метаданные файла или null, если не найдены
 */
async function getFileMetadata(hash) {
    // Попытка 1: Чтение из Hash (новый формат)
    let meta = await kv.hgetall(K.FILE(hash));
    
    if (meta && meta.hash) {
        return meta;
    }
    
    // Попытка 2: Чтение из JSON (старый формат) с миграцией
    const oldMeta = await kv.get(K.FILE(hash));
    
    if (oldMeta && oldMeta.hash) {
        return await migrateMetadata(hash, oldMeta);
    }
    
    return null;
}

// ============================================
// Маршруты: Статические endpoints
// ============================================

/**
 * GET /health — проверка здоровья сервиса
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.get('/health', async (req, res) => {
    try {
        await kv.exists(K.STATS);
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            uptime: process.uptime()
        });
    } catch (err) {
        res.status(503).json({
            status: 'unhealthy',
            error: err.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * GET /info/:hash — получение метаданных файла
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.get('/info/:hash', async (req, res) => {
    try {
        const hash = req.params.hash.toLowerCase();
        
        if (!isValidSha256(hash)) {
            return res.status(400).json({ error: ERROR_MESSAGES.INVALID_HASH });
        }
        
        const meta = await timed('kv.get.info', () => getFileMetadata(hash));
        
        if (!meta || !meta.hash) {
            return res.status(404).json({ error: ERROR_MESSAGES.FILE_NOT_FOUND });
        }
        
        res.json({
            hash: meta.hash,
            name: meta.name,
            size: parseInt(meta.size, 10),
            sizeFormatted: formatSize(parseInt(meta.size, 10)),
            contentType: meta.contentType,
            uploadedAt: meta.uploadedAt,
            downloads: parseInt(meta.downloads, 10) || 0
        });
        
    } catch (err) {
        logError('download/info', 'Failed to get metadata', err, { hash: req.params.hash });
        res.status(500).json({ error: ERROR_MESSAGES.SERVER_ERROR });
    }
});

// ============================================
// Маршруты: Админские endpoints
// ============================================

/**
 * GET /list — получение списка всех файлов (только для админа)
 * Поддерживает пагинацию через query параметры: page, limit
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.get('/list', verifyAdminToken, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const offset = (page - 1) * limit;
        
        // Получаем все хеши из индекса
        let hashes = await kv.smembers(K.FILES_INDEX);
        if (!hashes || !Array.isArray(hashes)) {
            hashes = [];
        }
        
        const total = hashes.length;
        const paginatedHashes = hashes.slice(offset, offset + limit);
        
        const files = [];
        let migrationCount = 0;
        
        // Чтение метаданных для каждого файла
        for (const hash of paginatedHashes) {
            try {
                let meta = null;
                
                // Попытка 1: Hash (новый формат)
                try {
                    const hashData = await kv.hgetall(K.FILE(hash));
                    if (hashData && hashData.hash) {
                        meta = {
                            hash: hashData.hash,
                            name: hashData.name,
                            size: parseInt(hashData.size, 10),
                            contentType: hashData.contentType,
                            uploadedAt: hashData.uploadedAt,
                            downloads: parseInt(hashData.downloads, 10) || 0,
                            url: hashData.url
                        };
                    }
                } catch (_) {}
                
                // Попытка 2: JSON (старый формат) — мигрируем
                if (!meta) {
                    const oldMeta = await kv.get(K.FILE(hash));
                    if (oldMeta && oldMeta.hash) {
                        meta = {
                            hash: oldMeta.hash,
                            name: oldMeta.name,
                            size: oldMeta.size,
                            contentType: oldMeta.contentType,
                            uploadedAt: oldMeta.uploadedAt,
                            downloads: oldMeta.downloads || 0,
                            url: oldMeta.url
                        };
                        
                        await migrateMetadata(hash, oldMeta);
                        migrationCount++;
                    }
                }
                
                if (meta) {
                    files.push({
                        hash: meta.hash,
                        name: meta.name,
                        size: meta.size,
                        sizeFormatted: formatSize(meta.size),
                        contentType: meta.contentType,
                        uploadedAt: meta.uploadedAt,
                        downloads: meta.downloads
                    });
                }
            } catch (err) {
                logWarn('download/list', 'Failed to read file metadata', { hash, error: err.message });
            }
        }
        
        if (migrationCount > 0) {
            logInfo('migrate', `Migrated ${migrationCount} files from JSON to Hash`);
        }
        
        res.json({
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            files,
            migrated: migrationCount
        });
        
    } catch (err) {
        logError('download/list', 'Failed to list files', err);
        res.status(500).json({ error: ERROR_MESSAGES.SERVER_ERROR });
    }
});

/**
 * GET / — получение общей статистики
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.get('/', async (req, res) => {
    try {
        const hashes = await kv.smembers(K.FILES_INDEX);
        const totalDownloads = await kv.get(K.STATS).catch(() => 0);
        
        res.json({ 
            count: hashes ? hashes.length : 0, 
            totalDownloads: totalDownloads || 0 
        });
    } catch (err) {
        logError('download/stats', 'Failed to get stats', err);
        res.status(500).json({ error: ERROR_MESSAGES.SERVER_ERROR });
    }
});

/**
 * POST / — загрузка нового файла (только для админа)
 * Автоматически вычисляет SHA-256 хеш и проверяет дубликаты
 * 
 * @param {express.Request} req - HTTP запрос с файлом в multipart/form-data
 * @param {express.Response} res - HTTP ответ
 */
router.post('/', verifyAdminToken, upload.single('file'), validateMimeType, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: ERROR_MESSAGES.NO_FILE });
        }
        
        const buffer = req.file.buffer;
        const hash = sha256(buffer);
        
        // Проверка существования файла (дедупликация)
        let existing = await timed('kv.get.check', () => getFileMetadata(hash));
        
        if (existing && existing.hash) {
            return res.json({
                existed: true,
                hash,
                url: `/downloader/${hash}`,
                name: existing.name,
                size: parseInt(existing.size, 10) || existing.size,
                sizeFormatted: formatSize(parseInt(existing.size, 10) || existing.size)
            });
        }
        
        // Извлечение расширения файла
        const ext = (req.file.originalname.match(/\.[a-z0-9]+$/i) || ['.bin'])[0];
        const blobPath = `downloads/${hash}${ext}`;
        
        // Загрузка в Vercel Blob Storage
        const blob = await timed('blob.put', () => put(blobPath, buffer, {
            access: 'public',
            addRandomSuffix: false,
            contentType: req.file.mimetype
        }));
        
        // Сохранение метаданных в KV
        const meta = {
            hash,
            url: blob.url,
            name: req.file.originalname,
            size: String(buffer.length),
            contentType: req.file.mimetype,
            uploadedAt: new Date().toISOString(),
            downloads: '0'
        };
        
        await kv.hset(K.FILE(hash), meta);
        await kv.sadd(K.FILES_INDEX, hash);
        invalidateCache(hash);
        
        logInfo('download/upload', 'File uploaded', {
            hash,
            name: req.file.originalname,
            size: buffer.length
        });
        
        res.json({
            existed: false,
            hash,
            url: `/downloader/${hash}`,
            name: meta.name,
            size: buffer.length,
            sizeFormatted: formatSize(buffer.length)
        });
        
    } catch (err) {
        logError('download/upload', 'Upload failed', err);
        res.status(500).json({ error: `${ERROR_MESSAGES.UPLOAD_FAILED}: ${err.message}` });
    }
});

// ============================================
// Маршруты: Динамические endpoints
// ============================================

/**
 * GET /:hash — скачивание файла по хешу
 * Выполняет редирект на URL в Blob Storage
 * Поддерживает rate limiting и асинхронное обновление счётчиков
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.get('/:hash', async (req, res) => {
    const startTime = Date.now();
    
    try {
        const hash = req.params.hash.toLowerCase();
        
        if (!isValidSha256(hash)) {
            return res.status(400).json({ error: ERROR_MESSAGES.INVALID_HASH });
        }
        
        // Rate limiting
        const ip = req.ip || req.connection.remoteAddress;
        const rateLimit = await checkRateLimit(
            K.RATE_LIMIT(ip),
            CONFIG.RATE_LIMIT_WINDOW,
            CONFIG.RATE_LIMIT_MAX
        );
        
        if (!rateLimit.allowed) {
            return res.status(429)
                .set('Retry-After', rateLimit.retryAfter)
                .json({ error: ERROR_MESSAGES.TOO_MANY_REQUESTS });
        }
        
        // Чтение метаданных (сначала из кэша, потом из KV)
        let meta = getCachedFile(hash);
        
        if (!meta) {
            meta = await getFileMetadata(hash);
            
            if (meta && meta.hash) {
                setCachedFile(hash, meta);
            }
        }
        
        if (!meta || !meta.hash || !meta.url) {
            return res.status(404).json({ error: ERROR_MESSAGES.FILE_NOT_FOUND });
        }
        
        // Асинхронное обновление счётчиков (не блокирует ответ)
        Promise.all([
            kv.incr(K.STATS).catch(() => {}),
            kv.hincrby(K.STATS_HASH, hash, 1).catch(() => {}),
            kv.hincrby(K.FILE(hash), 'downloads', 1).catch(err => {
                logWarn('download/counter', 'Failed to increment downloads', {
                    hash,
                    error: err.message
                });
            })
        ]).then(() => {
            invalidateCache(hash);
        });
        
        const duration = Date.now() - startTime;
        logInfo('download/redirect', 'Redirecting to file', { hash, durationMs: duration });
        
        // Установка заголовков
        res.setHeader('X-RateLimit-Remaining', String(rateLimit.remaining));
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        
        // Редирект на файл
        res.redirect(CONFIG.REDIRECT_STATUS, meta.url);
        
    } catch (err) {
        logError('download/redirect', 'Failed to redirect', err, { hash: req.params.hash });
        res.status(500).json({ error: ERROR_MESSAGES.SERVER_ERROR });
    }
});

/**
 * DELETE /:hash — удаление файла (только для админа)
 * Удаляет файл из Blob Storage и метаданные из KV
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.delete('/:hash', verifyAdminToken, async (req, res) => {
    try {
        const hash = req.params.hash.toLowerCase();
        
        if (!isValidSha256(hash)) {
            return res.status(400).json({ error: 'Invalid hash' });
        }
        
        const meta = await getFileMetadata(hash);
        
        if (!meta || !meta.hash) {
            return res.status(404).json({ error: ERROR_MESSAGES.FILE_NOT_FOUND });
        }
        
        // Удаление из Blob Storage
        if (meta.url) {
            await timed('blob.del', () => del(meta.url)).catch(err => {
                logWarn('blob.del', 'Failed to delete blob', {
                    url: meta.url,
                    error: err.message
                });
            });
        }
        
        // Удаление метаданных из KV
        await kv.del(K.FILE(hash));
        await kv.srem(K.FILES_INDEX, hash);
        invalidateCache(hash);
        
        logInfo('download/delete', 'File deleted', { hash, name: meta.name });
        
        res.json({ success: true, hash });
        
    } catch (err) {
        logError('download/delete', 'Delete failed', err, { hash: req.params.hash });
        res.status(500).json({ error: ERROR_MESSAGES.DELETE_FAILED });
    }
});

/**
 * PATCH /:hash — переименование файла (только для админа)
 * 
 * @param {express.Request} req - HTTP запрос с { name: string } в body
 * @param {express.Response} res - HTTP ответ
 */
router.patch('/:hash', verifyAdminToken, async (req, res) => {
    try {
        const hash = req.params.hash.toLowerCase();
        
        if (!isValidSha256(hash)) {
            return res.status(400).json({ error: 'Invalid hash' });
        }
        
        const { name } = req.body;
        
        if (!isValidFileName(name)) {
            return res.status(400).json({ 
                error: ERROR_MESSAGES.INVALID_NAME 
            });
        }
        
        const meta = await getFileMetadata(hash);
        
        if (!meta || !meta.hash) {
            return res.status(404).json({ error: ERROR_MESSAGES.FILE_NOT_FOUND });
        }
        
        // Обновление имени в KV
        await kv.hset(K.FILE(hash), { name: name.trim() });
        invalidateCache(hash);
        
        logInfo('download/rename', 'File renamed', {
            hash,
            oldName: meta.name,
            newName: name.trim()
        });
        
        res.json({ success: true, hash, name: name.trim() });
        
    } catch (err) {
        logError('download/patch', 'Update failed', err, { hash: req.params.hash });
        res.status(500).json({ error: ERROR_MESSAGES.UPDATE_FAILED });
    }
});

// ============================================
// Экспорт роутера
// ============================================

module.exports = router;