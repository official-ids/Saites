// ============================================
// МОДУЛЬ: ROBLOX INTEGRATION
// Прокси для Roblox API + общая база "страницы смерти"
// ============================================

const express = require('express');
const crypto = require('crypto');
const { kv } = require('@vercel/kv');
const router = express.Router();

// ============================================
// КОНСТАНТЫ
// ============================================

const ROBLOX_THUMBNAIL_API = 'https://thumbnails.roblox.com';
const ROBLOX_USERS_API = 'https://users.roblox.com';
const ROBLOX_AVATAR_API = 'https://avatar.roblox.com';

const CONFIG = {
    CACHE_TTL: 60 * 60, // 1 час кэш аватарок
    USER_CACHE_TTL: 30 * 60, // 30 мин кэш юзеров
    MAX_LIST_SIZE: 500,
    MAX_REASON_LENGTH: 300,
    MAX_NAME_LENGTH: 50,
    MAX_USERNAME_LENGTH: 30,
    RATE_LIMIT_WINDOW: 60 * 1000,
    RATE_LIMIT_MAX: 30,
    HTTP: {
        OK: 200,
        CREATED: 201,
        BAD_REQUEST: 400,
        NOT_FOUND: 404,
        TOO_MANY: 429,
        SERVER_ERROR: 500
    }
};

const K = {
    DIE_LIST: 'die:list',
    DIE_INDEX: 'die:index',
    ROBLOX_USER: (id) => `rbx:user:${id}`,
    ROBLOX_USERNAME: (name) => `rbx:name:${name.toLowerCase()}`,
    RATE_LIMIT: (ip) => `rl:die:${ip}`
};

// ============================================
// RATE LIMIT
// ============================================

async function checkRateLimit(key, windowMs, max) {
    try {
        const current = await kv.get(key);
        const now = Date.now();

        if (!current || now > current.resetAt) {
            await kv.set(key, { count: 1, resetAt: now + windowMs }, {
                ex: Math.ceil(windowMs / 1000)
            });
            return { allowed: true, remaining: max - 1 };
        }

        if (current.count >= max) {
            return {
                allowed: false,
                retryAfter: Math.ceil((current.resetAt - now) / 1000),
                remaining: 0
            };
        }

        current.count += 1;
        const ttl = Math.ceil((current.resetAt - now) / 1000);
        await kv.set(key, current, { ex: Math.max(ttl, 1) });
        return { allowed: true, remaining: max - current.count };
    } catch (err) {
        console.error('[roblox] Rate limit error:', err.message);
        return { allowed: true, remaining: max };
    }
}

async function rateLimiter(req, res, next) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.ip
        || req.connection?.remoteAddress
        || 'unknown';

    const rateLimit = await checkRateLimit(
        K.RATE_LIMIT(ip),
        CONFIG.RATE_LIMIT_WINDOW,
        CONFIG.RATE_LIMIT_MAX
    );

    if (!rateLimit.allowed) {
        return res.status(CONFIG.HTTP.TOO_MANY)
            .set('Retry-After', rateLimit.retryAfter)
            .json({ error: 'Too many requests' });
    }

    req.clientIp = ip;
    next();
}

// ============================================
// ROBLOX API HELPERS
// ============================================

/**
 * Поиск пользователя Roblox по username
 * Возвращает { id, username, displayName }
 */
async function searchRobloxUser(username) {
    if (!username || typeof username !== 'string') {
        throw new Error('Username required');
    }

    const cleanUsername = username.trim();
    if (cleanUsername.length < 3 || cleanUsername.length > 20) {
        throw new Error('Username must be 3-20 characters');
    }

    // Проверяем кэш
    const cacheKey = K.ROBLOX_USERNAME(cleanUsername);
    const cached = await kv.get(cacheKey);
    if (cached) return cached;

    // Запрос к Roblox API
    const response = await fetch(`${ROBLOX_USERS_API}/v1/usernames/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            usernames: [cleanUsername],
            excludeBannedUsers: false
        })
    });

    if (!response.ok) {
        throw new Error(`Roblox API error: ${response.status}`);
    }

    const data = await response.json();

    if (!data.data || data.data.length === 0) {
        throw new Error('User not found');
    }

    const user = data.data[0];
    const result = {
        id: user.id,
        username: user.name,
        displayName: user.displayName
    };

    // Сохраняем в кэш
    await kv.set(cacheKey, result, { ex: CONFIG.USER_CACHE_TTL });
    await kv.set(K.ROBLOX_USER(user.id), result, { ex: CONFIG.USER_CACHE_TTL });

    return result;
}

/**
 * Получение URL аватарки по userId
 */
function getAvatarUrl(userId, size = 150) {
    return `${ROBLOX_THUMBNAIL_API}/v1/users/avatar-headshot?userIds=${userId}&size=${size}x${size}&format=Png&isCircular=true`;
}

/**
 * Прямой запрос к Roblox Thumbnails API для получения URL аватарки
 */
async function fetchAvatarUrl(userId, size = 150) {
    if (!userId || isNaN(parseInt(userId))) {
        throw new Error('Invalid userId');
    }

    // Проверяем кэш
    const cacheKey = `rbx:avatar:${userId}:${size}`;
    const cached = await kv.get(cacheKey);
    if (cached) return cached;

    const response = await fetch(getAvatarUrl(userId, size));
    if (!response.ok) {
        throw new Error(`Avatar API error: ${response.status}`);
    }

    const data = await response.json();

    if (!data.data || data.data.length === 0 || !data.data[0].imageUrl) {
        throw new Error('Avatar not found');
    }

    const imageUrl = data.data[0].imageUrl;

    // Сохраняем в кэш
    await kv.set(cacheKey, imageUrl, { ex: CONFIG.CACHE_TTL });

    return imageUrl;
}

// ============================================
// ВАЛИДАЦИЯ
// ============================================

function sanitize(str, maxLen) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/[<>]/g, '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .trim()
        .substring(0, maxLen);
}

// ============================================
// PUBLIC ENDPOINTS
// ============================================

/**
 * GET /avatar/:userId — прокси аватарки
 * Возвращает JSON { url } с прямой ссылкой на картинку
 */
router.get('/avatar/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const size = Math.min(parseInt(req.query.size) || 150, 420);

        const url = await fetchAvatarUrl(userId, size);
        res.json({ url, userId, size });
    } catch (err) {
        res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: err.message });
    }
});

/**
 * GET /avatar/:userId/image — редирект на саму картинку
 */
router.get('/avatar/:userId/image', async (req, res) => {
    try {
        const { userId } = req.params;
        const size = Math.min(parseInt(req.query.size) || 150, 420);

        const url = await fetchAvatarUrl(userId, size);

        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.redirect(302, url);
    } catch (err) {
        res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: err.message });
    }
});

/**
 * GET /search?username=... — поиск пользователя
 */
router.get('/search', async (req, res) => {
    try {
        const { username } = req.query;

        if (!username) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: 'Username required' });
        }

        const user = await searchRobloxUser(username);
        const avatarUrl = await fetchAvatarUrl(user.id, 150);

        res.json({
            ...user,
            avatarUrl,
            profileUrl: `https://www.roblox.com/users/${user.id}/profile`
        });
    } catch (err) {
        res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: err.message });
    }
});

// ============================================
// DIE LIST (СТРАНИЦА СМЕРТИ)
// ============================================

/**
 * GET /die — список всех записей
 */
router.get('/die', async (req, res) => {
    try {
        const ids = await kv.smembers(K.DIE_INDEX);
        if (!ids || ids.length === 0) {
            return res.json({ entries: [], total: 0 });
        }

        const entries = [];
        for (const id of ids) {
            const entry = await kv.get(`${K.DIE_LIST}:${id}`);
            if (entry) entries.push(entry);
        }

        // Сортировка: новые сверху
        entries.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));

        res.json({ entries, total: entries.length });
    } catch (err) {
        console.error('[roblox] GET /die error:', err.message);
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: 'Failed to load list' });
    }
});

/**
 * GET /die/:id — одна запись
 */
router.get('/die/:id', async (req, res) => {
    try {
        const entry = await kv.get(`${K.DIE_LIST}:${req.params.id}`);
        if (!entry) {
            return res.status(CONFIG.HTTP.NOT_FOUND).json({ error: 'Not found' });
        }
        res.json(entry);
    } catch (err) {
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: 'Error loading entry' });
    }
});

/**
 * POST /die — добавить запись
 * Body: { username, reason, reporter? }
 * Автоматически ищет ID и аватарку
 */
router.post('/die', rateLimiter, async (req, res) => {
    try {
        const { username, reason, reporter } = req.body;

        // Валидация
        if (!username || typeof username !== 'string') {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: 'Username required' });
        }

        if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({
                error: 'Reason required (min 5 characters)'
            });
        }

        const cleanUsername = sanitize(username, CONFIG.MAX_USERNAME_LENGTH);
        const cleanReason = sanitize(reason, CONFIG.MAX_REASON_LENGTH);
        const cleanReporter = reporter ? sanitize(reporter, 30) : 'anonymous';

        if (cleanUsername.length < 3) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({
                error: 'Username too short (min 3 characters)'
            });
        }

        // Ищем пользователя в Roblox
        let robloxUser;
        try {
            robloxUser = await searchRobloxUser(cleanUsername);
        } catch (err) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({
                error: `Roblox user not found: ${err.message}`
            });
        }

        // Получаем аватарку
        let avatarUrl;
        try {
            avatarUrl = await fetchAvatarUrl(robloxUser.id, 150);
        } catch (err) {
            avatarUrl = null;
        }

        // Проверяем, нет ли уже такой записи (по username)
        const existingIds = await kv.smembers(K.DIE_INDEX);
        if (existingIds) {
            for (const id of existingIds) {
                const existing = await kv.get(`${K.DIE_LIST}:${id}`);
                if (existing && existing.username.toLowerCase() === robloxUser.username.toLowerCase()) {
                    return res.status(CONFIG.HTTP.BAD_REQUEST).json({
                        error: 'This user is already in the list',
                        existing: existing
                    });
                }
            }
        }

        // Создаём запись
        const entry = {
            id: crypto.randomUUID(),
            robloxId: robloxUser.id,
            username: robloxUser.username,
            displayName: robloxUser.displayName,
            avatarUrl,
            reason: cleanReason,
            reporter: cleanReporter,
            addedAt: new Date().toISOString(),
            ip: req.clientIp
        };

        // Сохраняем
        await kv.set(`${K.DIE_LIST}:${entry.id}`, entry);
        await kv.sadd(K.DIE_INDEX, entry.id);

        // Ограничиваем размер списка
        const allIds = await kv.smembers(K.DIE_INDEX);
        if (allIds && allIds.length > CONFIG.MAX_LIST_SIZE) {
            // Удаляем самые старые
            const entries = [];
            for (const id of allIds) {
                const e = await kv.get(`${K.DIE_LIST}:${id}`);
                if (e) entries.push(e);
            }
            entries.sort((a, b) => new Date(a.addedAt) - new Date(b.addedAt));
            const toDelete = entries.slice(0, entries.length - CONFIG.MAX_LIST_SIZE);
            for (const old of toDelete) {
                await kv.del(`${K.DIE_LIST}:${old.id}`);
                await kv.srem(K.DIE_INDEX, old.id);
            }
        }

        console.log(`[roblox] New die entry: ${robloxUser.username} by ${cleanReporter}`);

        res.status(CONFIG.HTTP.CREATED).json({
            success: true,
            entry: {
                id: entry.id,
                username: entry.username,
                displayName: entry.displayName,
                avatarUrl: entry.avatarUrl,
                reason: entry.reason,
                addedAt: entry.addedAt
            }
        });
    } catch (err) {
        console.error('[roblox] POST /die error:', err.message);
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: 'Error adding entry' });
    }
});

/**
 * DELETE /die/:id — удалить запись (по токену админа)
 */
router.delete('/die/:id', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const adminToken = process.env.ADMIN_TOKEN;

        if (!authHeader || !authHeader.startsWith('Bearer ') || !adminToken) {
            return res.status(CONFIG.HTTP.UNAUTHORIZED).json({ error: 'Admin token required' });
        }

        const token = authHeader.split(' ')[1];
        if (token.length !== adminToken.length ||
            !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(adminToken))) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: 'Invalid token' });
        }

        const entry = await kv.get(`${K.DIE_LIST}:${req.params.id}`);
        if (!entry) {
            return res.status(CONFIG.HTTP.NOT_FOUND).json({ error: 'Entry not found' });
        }

        await kv.del(`${K.DIE_LIST}:${req.params.id}`);
        await kv.srem(K.DIE_INDEX, req.params.id);

        console.log(`[roblox] Deleted die entry: ${entry.username}`);

        res.json({ success: true, deleted: entry.username });
    } catch (err) {
        console.error('[roblox] DELETE /die error:', err.message);
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: 'Error deleting entry' });
    }
});

/**
 * GET /die/stats — статистика
 */
router.get('/die/stats', async (req, res) => {
    try {
        const ids = await kv.smembers(K.DIE_INDEX);
        res.json({
            total: ids ? ids.length : 0,
            maxSize: CONFIG.MAX_LIST_SIZE
        });
    } catch (err) {
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: 'Error getting stats' });
    }
});

// ============================================
// ЭКСПОРТ
// ============================================

module.exports = router;