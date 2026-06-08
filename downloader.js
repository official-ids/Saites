const express = require('express');
const crypto = require('crypto');
const { put, del } = require('@vercel/blob');
const { kv } = require('@vercel/kv');
const multer = require('multer');

const router = express.Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 } // 100 MB
});

// -----------------------------
// Fail-fast конфигурация
// -----------------------------
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
    throw new Error('ADMIN_TOKEN environment variable is required');
}

// -----------------------------
// KV Keys
// -----------------------------
const K = {
    FILE: (hash) => `download:sha256:${hash}`,
    STATS: 'download:stats:total',
    STATS_HASH: 'download:stats:per-file'
};

// -----------------------------
// MIME whitelist
// -----------------------------
const ALLOWED_MIME_TYPES = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'application/pdf', 'application/zip', 'application/x-rar-compressed',
    'text/plain', 'application/json',
    'video/mp4', 'audio/mpeg'
];

// -----------------------------
// Middleware
// -----------------------------
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

// -----------------------------
// Утилиты
// -----------------------------
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

function logInfo(operation, message, extra = {}) {
    console.log(JSON.stringify({
        level: 'info',
        operation,
        message,
        timestamp: new Date().toISOString(),
        ...extra
    }));
}

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

function logWarn(operation, message, extra = {}) {
    console.warn(JSON.stringify({
        level: 'warn',
        operation,
        message,
        timestamp: new Date().toISOString(),
        ...extra
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

// =========================
// Маршруты (относительные!)
// =========================

// Health
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

// Админский список (пагинация)
router.get('/list', verifyAdminToken, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
        const offset = (page - 1) * limit;

        const keys = await kv.keys('download:sha256:*');
        const paginatedKeys = keys.slice(offset, offset + limit);

        const files = await Promise.all(
            paginatedKeys.map(async (key) => {
                const meta = await kv.get(key);
                if (!meta) return null;
                return {
                    hash: meta.hash,
                    name: meta.name,
                    size: meta.size,
                    sizeFormatted: formatSize(meta.size),
                    contentType: meta.contentType,
                    uploadedAt: meta.uploadedAt,
                    downloads: meta.downloads || 0
                };
            })
        );

        res.json({
            total: keys.length,
            page,
            limit,
            totalPages: Math.ceil(keys.length / limit),
            files: files.filter(Boolean)
        });
    } catch (err) {
        logError('download/list', 'Failed to list files', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Публичная статистика (GET /)
router.get('/', async (req, res) => {
    try {
        const keys = await kv.keys('download:sha256:*');
        const totalDownloads = await kv.get(K.STATS).catch(() => 0);

        res.json({
            count: keys.length,
            totalDownloads: totalDownloads || 0
        });
    } catch (err) {
        logError('download/stats', 'Failed to get stats', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Загрузка (POST /)
router.post('/', verifyAdminToken, upload.single('file'), validateMimeType, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file provided' });
        }

        const buffer = req.file.buffer;
        const hash = sha256(buffer);

        const existing = await timed('kv.get.check', () => kv.get(K.FILE(hash)));
        if (existing) {
            return res.json({
                existed: true,
                hash,
                url: `/downloader/${hash}`,
                name: existing.name,
                size: existing.size,
                sizeFormatted: formatSize(existing.size)
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
            size: buffer.length,
            contentType: req.file.mimetype,
            uploadedAt: new Date().toISOString(),
            downloads: 0
        };

        const setResult = await timed('kv.set.nx', () => kv.set(K.FILE(hash), meta, { nx: true }));
        if (!setResult) {
            await del(blob.url).catch(() => {});
            const existingMeta = await kv.get(K.FILE(hash));
            return res.json({
                existed: true,
                hash,
                url: `/downloader/${hash}`,
                name: existingMeta?.name || meta.name,
                size: existingMeta?.size || meta.size,
                sizeFormatted: formatSize(existingMeta?.size || meta.size)
            });
        }

        res.json({
            existed: false,
            hash,
            url: `/downloader/${hash}`,
            name: meta.name,
            size: meta.size,
            sizeFormatted: formatSize(meta.size)
        });
    } catch (err) {
        logError('download/upload', 'Upload failed', err);
        res.status(500).json({ error: 'Upload failed: ' + err.message });
    }
});

// Метаданные по хешу (GET /info/:hash)
router.get('/info/:hash', async (req, res) => {
    try {
        const hash = req.params.hash.toLowerCase();
        if (!isValidSha256(hash)) {
            return res.status(400).json({ error: 'Invalid SHA-256 hash format' });
        }

        const meta = await timed('kv.get.info', () => kv.get(K.FILE(hash)));
        if (!meta) {
            return res.status(404).json({ error: 'File not found' });
        }

        res.json({
            hash: meta.hash,
            name: meta.name,
            size: meta.size,
            sizeFormatted: formatSize(meta.size),
            contentType: meta.contentType,
            uploadedAt: meta.uploadedAt,
            downloads: meta.downloads || 0
        });
    } catch (err) {
        logError('download/info', 'Failed to get metadata', err, { hash: req.params.hash });
        res.status(500).json({ error: 'Server error' });
    }
});

// Скачивание (GET /:hash)
router.get('/:hash', async (req, res) => {
    try {
        const hash = req.params.hash.toLowerCase();
        if (!isValidSha256(hash)) {
            return res.status(400).json({ error: 'Invalid SHA-256 hash format' });
        }

        const meta = await timed('kv.get.redirect', () => kv.get(K.FILE(hash)));
        if (!meta) {
            return res.status(404).json({ error: 'File not found' });
        }

        kv.incr(K.STATS).catch(() => {});
        kv.hincrby(K.STATS_HASH, hash, 1).catch(() => {});
        kv.hincrby(K.FILE(hash), 'downloads', 1).catch(() => {});

        res.redirect(302, meta.url);
    } catch (err) {
        logError('download/redirect', 'Failed to redirect', err, { hash: req.params.hash });
        res.status(500).json({ error: 'Server error' });
    }
});

// Удаление (DELETE /:hash)
router.delete('/:hash', verifyAdminToken, async (req, res) => {
    try {
        const hash = req.params.hash.toLowerCase();
        if (!isValidSha256(hash)) {
            return res.status(400).json({ error: 'Invalid hash' });
        }

        const meta = await kv.get(K.FILE(hash));
        if (!meta) {
            return res.status(404).json({ error: 'File not found' });
        }

        if (meta.url) {
            await timed('blob.del', () => del(meta.url)).catch((err) => {
                logWarn('blob.del', 'Failed to delete blob, continuing with KV cleanup', { url: meta.url, error: err.message });
            });
        }

        await timed('kv.del', () => kv.del(K.FILE(hash)));

        logInfo('download/delete', 'File deleted', { hash, name: meta.name });
        res.json({ success: true, hash });
    } catch (err) {
        logError('download/delete', 'Delete failed', err, { hash: req.params.hash });
        res.status(500).json({ error: 'Delete failed' });
    }
});

// Переименование (PATCH /:hash)
router.patch('/:hash', verifyAdminToken, async (req, res) => {
    try {
        const hash = req.params.hash.toLowerCase();
        if (!isValidSha256(hash)) {
            return res.status(400).json({ error: 'Invalid hash' });
        }

        const { name } = req.body;
        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return res.status(400).json({ error: 'Valid name is required' });
        }

        const meta = await kv.get(K.FILE(hash));
        if (!meta) {
            return res.status(404).json({ error: 'File not found' });
        }

        meta.name = name.trim();
        await kv.set(K.FILE(hash), meta);

        res.json({ success: true, hash, name: meta.name });
    } catch (err) {
        logError('download/patch', 'Update failed', err, { hash: req.params.hash });
        res.status(500).json({ error: 'Update failed' });
    }
});

module.exports = router;