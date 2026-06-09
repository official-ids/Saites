const express = require('express');
const crypto = require('crypto');
const { put, del } = require('@vercel/blob');
const { kv } = require('@vercel/kv');
const multer = require('multer');

const router = express.Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 4 * 1024 * 1024 } 
});

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
    throw new Error('ADMIN_TOKEN environment variable is required');
}

// ====================================
// КОНФИГУРАЦИЯ
// ====================================

const CONFIG = {
    MAX_FILE_SIZE: 100 * 1024 * 1024,
    MAX_NAME_LENGTH: 255,
    RATE_LIMIT_WINDOW: 60 * 1000,
    RATE_LIMIT_MAX: 60,
    CACHE_TTL: 30 * 1000,
    CACHE_MAX_SIZE: 500
};

// ====================================
// КЛЮЧИ KV
// ====================================

const K = {
    FILE: (hash) => `download:sha256:${hash}`,
    FILES_INDEX: 'download:files:index',
    STATS: 'download:stats:total',
    STATS_HASH: 'download:stats:per-file',
    RATE_LIMIT: (ip) => `rl:download:${ip}`
};

// ====================================
// РАЗРЕШЁННЫЕ MIME-ТИПЫ
// ====================================

const ALLOWED_MIME_TYPES = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    'application/pdf', 'application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed',
    'text/plain', 'application/json', 'text/csv', 'application/xml',
    'video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav', 'audio/ogg',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
];

// ====================================
// IN-MEMORY КЭШ
// ====================================

const fileCache = new Map();
let cacheLastCleanup = Date.now();

function getCachedFile(hash) {
    const entry = fileCache.get(hash);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CONFIG.CACHE_TTL) {
        fileCache.delete(hash);
        return null;
    }
    return entry.data;
}

function setCachedFile(hash, data) {
    if (fileCache.size >= CONFIG.CACHE_MAX_SIZE && Date.now() - cacheLastCleanup > 60000) {
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

function invalidateCache(hash) {
    fileCache.delete(hash);
}

// ====================================
// УТИЛИТЫ
// ====================================

function verifyAdminToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.split(' ')[1];
    const isValid = ADMIN_TOKEN
        && token
        && token.length === ADMIN_TOKEN.length
        && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN));
    if (!isValid) {
        logWarn('auth', 'Failed admin authentication attempt', { ip: req.ip });
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
}

function validateMimeType(req, res, next) {
    if (!req.file) return next();
    if (!ALLOWED_MIME_TYPES.includes(req.file.mimetype)) {
        return res.status(400).json({
            error: 'Unsupported file type',
            received: req.file.mimetype,
            allowed: ALLOWED_MIME_TYPES
        });
    }
    next();
}

async function checkRateLimit(key, windowMs, max) {
    try {
        // Используем только hset/hincrby (hash) — без смешивания с kv.set
        const data = await kv.hgetall(key);
        const now = Date.now();
        
        if (!data || !data.count) {
            await kv.hset(key, { count: '1', resetAt: String(now + windowMs) });
            await kv.expire(key, Math.ceil(windowMs / 1000));
            return { allowed: true, remaining: max - 1 };
        }
        
        const resetAt = parseInt(data.resetAt, 10);
        if (now > resetAt) {
            // Окно истекло — сбрасываем
            await kv.del(key);
            await kv.hset(key, { count: '1', resetAt: String(now + windowMs) });
            await kv.expire(key, Math.ceil(windowMs / 1000));
            return { allowed: true, remaining: max - 1 };
        }
        
        const count = parseInt(data.count, 10);
        if (count >= max) {
            return { 
                allowed: false, 
                retryAfter: Math.ceil((resetAt - now) / 1000),
                remaining: 0
            };
        }
        
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

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function isValidSha256(hash) {
    return typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash);
}

function isValidFileName(name) {
    return typeof name === 'string' 
        && name.trim().length > 0 
        && name.trim().length <= CONFIG.MAX_NAME_LENGTH
        && !/[<>:"|?*\x00-\x1f]/.test(name);
}

function logInfo(operation, message, extra = {}) {
    console.log(JSON.stringify({
        level: 'info', operation, message,
        timestamp: new Date().toISOString(), ...extra
    }));
}

function logError(operation, message, err, extra = {}) {
    console.error(JSON.stringify({
        level: 'error', operation, message,
        error: err?.message, stack: err?.stack,
        timestamp: new Date().toISOString(), ...extra
    }));
}

function logWarn(operation, message, extra = {}) {
    console.warn(JSON.stringify({
        level: 'warn', operation, message,
        timestamp: new Date().toISOString(), ...extra
    }));
}

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

// ====================================
// СТАТИЧЕСКИЕ МАРШРУТЫ
// ====================================

router.get('/health', async (req, res) => {
    try {
        await kv.exists(K.STATS);
        res.json({ status: 'healthy', timestamp: new Date().toISOString(), uptime: process.uptime() });
    } catch (err) {
        res.status(503).json({ status: 'unhealthy', error: err.message, timestamp: new Date().toISOString() });
    }
});

router.get('/info/:hash', async (req, res) => {
    try {
        const hash = req.params.hash.toLowerCase();
        if (!isValidSha256(hash)) return res.status(400).json({ error: 'Invalid SHA-256 hash format' });
        
        let meta = await timed('kv.get.info', () => kv.hgetall(K.FILE(hash)));
        
        // Миграция старого формата
        if (!meta || !meta.hash) {
            const oldMeta = await kv.get(K.FILE(hash));
            if (oldMeta && oldMeta.hash) {
                meta = oldMeta;
                await kv.del(K.FILE(hash));
                await kv.hset(K.FILE(hash), {
                    hash: meta.hash,
                    name: meta.name,
                    size: String(meta.size),
                    contentType: meta.contentType,
                    uploadedAt: meta.uploadedAt,
                    downloads: String(meta.downloads || 0),
                    url: meta.url
                });
                logInfo('migrate', 'Migrated file metadata to Hash', { hash });
            }
        }
        
        if (!meta || !meta.hash) return res.status(404).json({ error: 'File not found' });
        
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
        res.status(500).json({ error: 'Server error' });
    }
});

// ====================================
// АДМИНСКИЕ МАРШРУТЫ
// ====================================

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
                        
                        await kv.del(K.FILE(hash));
                        await kv.hset(K.FILE(hash), {
                            hash: meta.hash,
                            name: meta.name,
                            size: String(meta.size),
                            contentType: meta.contentType,
                            uploadedAt: meta.uploadedAt,
                            downloads: String(meta.downloads),
                            url: meta.url
                        });
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
        res.status(500).json({ error: 'Server error' });
    }
});

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
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/', verifyAdminToken, upload.single('file'), validateMimeType, async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file provided' });
        
        const buffer = req.file.buffer;
        const hash = sha256(buffer);
        
        // Проверка существования
        let existing = await timed('kv.get.check', () => kv.hgetall(K.FILE(hash)));
        if (!existing || !existing.hash) {
            const oldExisting = await kv.get(K.FILE(hash));
            if (oldExisting && oldExisting.hash) {
                existing = oldExisting;
            }
        }
        
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
        
        const ext = (req.file.originalname.match(/\.[a-z0-9]+$/i) || ['.bin'])[0];
        const blobPath = `downloads/${hash}${ext}`;
        
        const blob = await timed('blob.put', () => put(blobPath, buffer, {
            access: 'public',
            addRandomSuffix: false,
            contentType: req.file.mimetype
        }));
        
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
        
        logInfo('download/upload', 'File uploaded', { hash, name: req.file.originalname, size: buffer.length });
        
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
        res.status(500).json({ error: 'Upload failed: ' + err.message });
    }
});

// ====================================
// ДИНАМИЧЕСКИЕ МАРШРУТЫ
// ====================================

router.get('/:hash', async (req, res) => {
    const startTime = Date.now();
    
    try {
        const hash = req.params.hash.toLowerCase();
        if (!isValidSha256(hash)) return res.status(400).json({ error: 'Invalid SHA-256 hash format' });
        
        // Rate limiting
        const ip = req.ip || req.connection.remoteAddress;
        const rateLimit = await checkRateLimit(K.RATE_LIMIT(ip), CONFIG.RATE_LIMIT_WINDOW, CONFIG.RATE_LIMIT_MAX);
        
        if (!rateLimit.allowed) {
            return res.status(429)
                .set('Retry-After', rateLimit.retryAfter)
                .json({ error: 'Too many requests' });
        }
        
        // Читаем метаданные
        let meta = getCachedFile(hash);
        
        if (!meta) {
            meta = await kv.hgetall(K.FILE(hash));
            
            // Миграция старого формата
            if (!meta || !meta.hash) {
                const oldMeta = await kv.get(K.FILE(hash));
                if (oldMeta && oldMeta.hash) {
                    meta = oldMeta;
                    await kv.del(K.FILE(hash));
                    await kv.hset(K.FILE(hash), {
                        hash: meta.hash,
                        name: meta.name,
                        size: String(meta.size),
                        contentType: meta.contentType,
                        uploadedAt: meta.uploadedAt,
                        downloads: String(meta.downloads || 0),
                        url: meta.url
                    });
                    logInfo('migrate', 'Migrated file on download', { hash });
                }
            }
            
            if (meta && meta.hash) {
                setCachedFile(hash, meta);
            }
        }
        
        if (!meta || !meta.hash || !meta.url) {
            return res.status(404).json({ error: 'File not found' });
        }
        
        // Асинхронное обновление счётчиков
        Promise.all([
            kv.incr(K.STATS).catch(() => {}),
            kv.hincrby(K.STATS_HASH, hash, 1).catch(() => {}),
            kv.hincrby(K.FILE(hash), 'downloads', 1).catch(err => {
                logWarn('download/counter', 'Failed to increment downloads', { hash, error: err.message });
            })
        ]).then(() => {
            invalidateCache(hash);
        });
        
        const duration = Date.now() - startTime;
        logInfo('download/redirect', `Redirecting to file`, { hash, durationMs: duration });
        
        res.setHeader('X-RateLimit-Remaining', String(rateLimit.remaining));
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.redirect(302, meta.url);
        
    } catch (err) {
        logError('download/redirect', 'Failed to redirect', err, { hash: req.params.hash });
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/:hash', verifyAdminToken, async (req, res) => {
    try {
        const hash = req.params.hash.toLowerCase();
        if (!isValidSha256(hash)) return res.status(400).json({ error: 'Invalid hash' });
        
        let meta = await kv.hgetall(K.FILE(hash));
        if (!meta || !meta.hash) {
            const oldMeta = await kv.get(K.FILE(hash));
            if (oldMeta && oldMeta.hash) {
                meta = oldMeta;
            }
        }
        
        if (!meta || !meta.hash) {
            return res.status(404).json({ error: 'File not found' });
        }
        
        if (meta.url) {
            await timed('blob.del', () => del(meta.url)).catch(err => {
                logWarn('blob.del', 'Failed to delete blob', { url: meta.url, error: err.message });
            });
        }
        
        await kv.del(K.FILE(hash));
        await kv.srem(K.FILES_INDEX, hash);
        invalidateCache(hash);
        
        logInfo('download/delete', 'File deleted', { hash, name: meta.name });
        res.json({ success: true, hash });
    } catch (err) {
        logError('download/delete', 'Delete failed', err, { hash: req.params.hash });
        res.status(500).json({ error: 'Delete failed' });
    }
});

router.patch('/:hash', verifyAdminToken, async (req, res) => {
    try {
        const hash = req.params.hash.toLowerCase();
        if (!isValidSha256(hash)) return res.status(400).json({ error: 'Invalid hash' });
        
        const { name } = req.body;
        if (!isValidFileName(name)) {
            return res.status(400).json({ 
                error: `Valid name required (1-${CONFIG.MAX_NAME_LENGTH} chars, no special chars)` 
            });
        }
        
        let meta = await kv.hgetall(K.FILE(hash));
        if (!meta || !meta.hash) {
            const oldMeta = await kv.get(K.FILE(hash));
            if (oldMeta && oldMeta.hash) {
                meta = oldMeta;
                await kv.del(K.FILE(hash));
                await kv.hset(K.FILE(hash), {
                    hash: meta.hash,
                    name: meta.name,
                    size: String(meta.size),
                    contentType: meta.contentType,
                    uploadedAt: meta.uploadedAt,
                    downloads: String(meta.downloads || 0),
                    url: meta.url
                });
            } else {
                return res.status(404).json({ error: 'File not found' });
            }
        }
        
        await kv.hset(K.FILE(hash), { name: name.trim() });
        invalidateCache(hash);
        
        logInfo('download/rename', 'File renamed', { hash, oldName: meta.name, newName: name.trim() });
        res.json({ success: true, hash, name: name.trim() });
    } catch (err) {
        logError('download/patch', 'Update failed', err, { hash: req.params.hash });
        res.status(500).json({ error: 'Update failed' });
    }
});

module.exports = router;