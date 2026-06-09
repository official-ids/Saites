const express = require('express');
const crypto = require('crypto');
const { kv } = require('@vercel/kv');

const router = express.Router();
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

// ====================================
// КОНФИГУРАЦИЯ
// ====================================

const CONFIG = {
    // Валидация
    SLUG_PATTERN: /^[a-z0-9_-]{2,32}$/,
    SLUG_MAX_LENGTH: 32,
    DESC_MAX_LENGTH: 200,
    
    // Rate limiting для публичного эндпоинта
    RATE_LIMIT_WINDOW: 60 * 1000,      // 1 минута
    RATE_LIMIT_MAX: 30,                // 30 переходов в минуту с одного IP
    RATE_LIMIT_CLEANUP: 5 * 60 * 1000, // очистка каждые 5 минут
    
    // Защита от брутфорса slug
    BRUTE_FORCE_WINDOW: 60 * 1000,
    BRUTE_FORCE_MAX: 60,               // 60 попыток в минуту
    
    // Кэш популярных редиректов
    CACHE_TTL: 30 * 1000,              // 30 секунд
    CACHE_MAX_SIZE: 500,               // максимум записей в кэше
    
    // HTTP коды
    HTTP: {
        OK: 200,
        CREATED: 201,
        BAD_REQUEST: 400,
        UNAUTHORIZED: 401,
        FORBIDDEN: 403,
        NOT_FOUND: 404,
        CONFLICT: 409,
        TOO_MANY: 429,
        SERVER_ERROR: 500
    }
};

// ====================================
// КЛЮЧИ KV
// ====================================

const K = {
    // Hash: redirect:{slug} — поля: url, description, clicks, createdAt, lastClickedAt
    REDIRECT: (slug) => `redirect:${slug.toLowerCase()}`,
    // Set: все slug'и
    REDIRECTS_INDEX: 'redirects:index',
    // Rate limit для публичных переходов
    RATE_LIMIT: (ip) => `rl:redirect:pub:${ip}`,
    // Rate limit для админских операций
    ADMIN_RATE_LIMIT: (ip) => `rl:redirect:admin:${ip}`,
    // Брутфорс-защита
    BRUTE_FORCE: (ip) => `bf:redirect:${ip}`
};

// ====================================
// IN-MEMORY КЭШ
// ====================================

const redirectCache = new Map();
let cacheLastCleanup = Date.now();

function getCachedRedirect(slug) {
    const entry = redirectCache.get(slug);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CONFIG.CACHE_TTL) {
        redirectCache.delete(slug);
        return null;
    }
    return entry.data;
}

function setCachedRedirect(slug, data) {
    // Очистка старого кэша при переполнении
    if (redirectCache.size >= CONFIG.CACHE_MAX_SIZE && Date.now() - cacheLastCleanup > 60000) {
        const now = Date.now();
        for (const [key, entry] of redirectCache.entries()) {
            if (now - entry.timestamp > CONFIG.CACHE_TTL) {
                redirectCache.delete(key);
            }
        }
        cacheLastCleanup = now;
    }
    redirectCache.set(slug, { data, timestamp: Date.now() });
}

function invalidateCache(slug) {
    redirectCache.delete(slug);
}

// ====================================
// RATE LIMITING
// ====================================

async function checkRateLimit(key, windowMs, max) {
    try {
        const current = await kv.get(key);
        const now = Date.now();
        
        if (!current) {
            await kv.set(key, { count: 1, resetAt: now + windowMs }, { ex: Math.ceil(windowMs / 1000) });
            return { allowed: true, remaining: max - 1 };
        }
        
        if (now > current.resetAt) {
            await kv.set(key, { count: 1, resetAt: now + windowMs }, { ex: Math.ceil(windowMs / 1000) });
            return { allowed: true, remaining: max - 1 };
        }
        
        if (current.count >= max) {
            return { 
                allowed: false, 
                retryAfter: Math.ceil((current.resetAt - now) / 1000),
                remaining: 0
            };
        }
        
        await kv.hincrby(key, 'count', 1);
        return { allowed: true, remaining: max - current.count - 1 };
    } catch (err) {
        console.error('[Rate Limit] KV error:', err.message);
        return { allowed: true, remaining: max }; // fail-open
    }
}

// ====================================
// MIDDLEWARE
// ====================================

function verifyAdminToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(CONFIG.HTTP.UNAUTHORIZED).json({ error: 'Missing token' });
    }
    
    const token = authHeader.split(' ')[1];
    
    if (!ADMIN_TOKEN || !token) {
        return res.status(CONFIG.HTTP.FORBIDDEN).json({ error: 'Invalid token' });
    }
    
    // Безопасное сравнение: сначала проверяем длину, затем timing-safe
    const isValid = token.length === ADMIN_TOKEN.length &&
                    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN));
    
    if (!isValid) {
        return res.status(CONFIG.HTTP.FORBIDDEN).json({ error: 'Invalid token' });
    }
    
    next();
}

function isValidUrl(string) {
    try {
        const url = new URL(string);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

// ====================================
// АДМИНСКИЕ ЭНДПОИНТЫ
// ====================================

// Получить список всех редиректов
router.get('/admin', verifyAdminToken, async (req, res) => {
    try {
        const slugs = await kv.smembers(K.REDIRECTS_INDEX);
        if (!slugs || !Array.isArray(slugs)) {
            return res.json({ redirects: [], total: 0, totalClicks: 0 });
        }
        
        const redirects = [];
        let migrationCount = 0;
        
        for (const slug of slugs) {
            try {
                const normalizedSlug = String(slug).toLowerCase().trim();
                if (!normalizedSlug) continue;
                
                let data = null;
                
                // Попытка 1: читаем как Hash (новый формат)
                try {
                    const hashData = await kv.hgetall(K.REDIRECT(normalizedSlug));
                    if (hashData && typeof hashData === 'object' && hashData.url) {
                        data = {
                            slug: hashData.slug || normalizedSlug,
                            url: hashData.url,
                            description: hashData.description || '',
                            clicks: parseInt(hashData.clicks, 10) || 0,
                            createdAt: hashData.createdAt || new Date().toISOString(),
                            lastClickedAt: hashData.lastClickedAt || null
                        };
                    }
                } catch (hashErr) {
                    // Hash не удался — возможно, старый формат
                }
                
                // Попытка 2: читаем как JSON (старый формат) и мигрируем
                if (!data) {
                    try {
                        const oldData = await kv.get(K.REDIRECT(normalizedSlug));
                        if (oldData && typeof oldData === 'object' && oldData.url) {
                            data = {
                                slug: oldData.slug || normalizedSlug,
                                url: oldData.url,
                                description: oldData.description || '',
                                clicks: parseInt(oldData.clicks, 10) || 0,
                                createdAt: oldData.createdAt || new Date().toISOString(),
                                lastClickedAt: oldData.lastClickedAt || null
                            };
                            
                            // Миграция: перезаписываем в Hash-формат
                            try {
                                await kv.del(K.REDIRECT(normalizedSlug));
                                await kv.hset(K.REDIRECT(normalizedSlug), {
                                    slug: data.slug,
                                    url: data.url,
                                    description: data.description,
                                    clicks: String(data.clicks),
                                    createdAt: data.createdAt,
                                    lastClickedAt: data.lastClickedAt || ''
                                });
                                migrationCount++;
                                console.log(`[migrate] ${normalizedSlug}: JSON → Hash`);
                            } catch (migErr) {
                                console.warn(`[migrate] Failed to migrate ${normalizedSlug}:`, migErr.message);
                            }
                        }
                    } catch (jsonErr) {
                        console.warn(`[redirects] Cannot read ${normalizedSlug}:`, jsonErr.message);
                    }
                }
                
                if (data) {
                    redirects.push(data);
                } else {
                    // Битая запись — удаляем из индекса
                    console.warn(`[redirects] Orphan slug removed: ${normalizedSlug}`);
                    await kv.srem(K.REDIRECTS_INDEX, normalizedSlug).catch(() => {});
                }
                
            } catch (itemErr) {
                console.error(`[redirects] Error processing slug "${slug}":`, itemErr.message);
                // Продолжаем обработку остальных
            }
        }
        
        // Сортировка: по кликам (убыв.), затем по дате (нов. сверху)
        redirects.sort((a, b) => {
            if (b.clicks !== a.clicks) return b.clicks - a.clicks;
            return new Date(b.createdAt) - new Date(a.createdAt);
        });
        
        if (migrationCount > 0) {
            console.log(`[redirects] Migrated ${migrationCount} records from JSON to Hash`);
        }
        
        res.json({ 
            redirects,
            total: redirects.length,
            totalClicks: redirects.reduce((sum, r) => sum + r.clicks, 0),
            migrated: migrationCount
        });
    } catch (err) {
        console.error('[redirects GET admin]', err);
        res.status(500).json({ 
            error: 'Ошибка получения списка',
            details: process.env.NODE_ENV !== 'production' ? err.message : undefined
        });
    }
});

// Создать редирект
router.post('/admin', verifyAdminToken, async (req, res) => {
    try {
        const { slug, url, description } = req.body;
        
        // Валидация slug
        if (!slug || typeof slug !== 'string') {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: 'Slug обязателен' });
        }
        const normalizedSlug = slug.toLowerCase().trim();
        if (!CONFIG.SLUG_PATTERN.test(normalizedSlug)) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ 
                error: `Slug: 2-32 символа (a-z, 0-9, -, _)` 
            });
        }
        
        // Валидация URL
        if (!url || typeof url !== 'string' || !isValidUrl(url)) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ 
                error: 'Требуется корректный HTTP/HTTPS URL' 
            });
        }
        
        // Проверка существования
        const existing = await kv.hgetall(K.REDIRECT(normalizedSlug));
        if (existing && existing.slug) {
            return res.status(CONFIG.HTTP.CONFLICT).json({ error: 'Такой slug уже существует' });
        }
        
        const now = new Date().toISOString();
        const redirectData = {
            slug: normalizedSlug,
            url: url.trim(),
            description: description ? String(description).slice(0, CONFIG.DESC_MAX_LENGTH) : '',
            clicks: '0',
            createdAt: now,
            lastClickedAt: ''
        };
        
        // Сохраняем как Redis Hash
        await kv.hset(K.REDIRECT(normalizedSlug), redirectData);
        await kv.sadd(K.REDIRECTS_INDEX, normalizedSlug);
        
        // Инвалидируем кэш (на случай, если был)
        invalidateCache(normalizedSlug);
        
        res.status(CONFIG.HTTP.CREATED).json({ 
            success: true, 
            redirect: {
                ...redirectData,
                clicks: 0
            }
        });
    } catch (err) {
        console.error('[redirects POST admin]', err);
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: 'Ошибка создания редиректа' });
    }
});

// Обновить редирект (новое)
router.patch('/admin/:slug', verifyAdminToken, async (req, res) => {
    try {
        const slug = req.params.slug.toLowerCase().trim();
        if (!CONFIG.SLUG_PATTERN.test(slug)) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: 'Invalid slug' });
        }
        
        const existing = await kv.hgetall(K.REDIRECT(slug));
        if (!existing || !existing.slug) {
            return res.status(CONFIG.HTTP.NOT_FOUND).json({ error: 'Редирект не найден' });
        }
        
        const updates = {};
        const { url, description } = req.body;
        
        if (url !== undefined) {
            if (!isValidUrl(url)) {
                return res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: 'Некорректный URL' });
            }
            updates.url = url.trim();
        }
        
        if (description !== undefined) {
            updates.description = String(description).slice(0, CONFIG.DESC_MAX_LENGTH);
        }
        
        if (Object.keys(updates).length === 0) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: 'Нет данных для обновления' });
        }
        
        await kv.hset(K.REDIRECT(slug), updates);
        invalidateCache(slug);
        
        res.json({ success: true, updated: updates });
    } catch (err) {
        console.error('[redirects PATCH admin]', err);
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: 'Ошибка обновления' });
    }
});

// Удалить редирект
router.delete('/admin/:slug', verifyAdminToken, async (req, res) => {
    try {
        const slug = req.params.slug.toLowerCase().trim();
        if (!CONFIG.SLUG_PATTERN.test(slug)) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: 'Invalid slug' });
        }
        
        await kv.del(K.REDIRECT(slug));
        await kv.srem(K.REDIRECTS_INDEX, slug);
        invalidateCache(slug);
        
        res.json({ success: true });
    } catch (err) {
        console.error('[redirects DELETE admin]', err);
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: 'Ошибка удаления' });
    }
});

// Сброс счётчика кликов (новое)
router.post('/admin/:slug/reset-stats', verifyAdminToken, async (req, res) => {
    try {
        const slug = req.params.slug.toLowerCase().trim();
        if (!CONFIG.SLUG_PATTERN.test(slug)) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: 'Invalid slug' });
        }
        
        const existing = await kv.hgetall(K.REDIRECT(slug));
        if (!existing || !existing.slug) {
            return res.status(CONFIG.HTTP.NOT_FOUND).json({ error: 'Редирект не найден' });
        }
        
        await kv.hset(K.REDIRECT(slug), { clicks: '0', lastClickedAt: '' });
        invalidateCache(slug);
        
        res.json({ success: true, message: 'Статистика сброшена' });
    } catch (err) {
        console.error('[redirects reset-stats]', err);
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: 'Ошибка сброса статистики' });
    }
});

// ====================================
// ПУБЛИЧНЫЙ ЭНДПОИНТ
// ====================================

router.get('/:slug', async (req, res) => {
    const startTime = Date.now();
    
    try {
        const slug = req.params.slug.toLowerCase().trim();
        
        if (!CONFIG.SLUG_PATTERN.test(slug)) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).send('Invalid redirect slug');
        }
        
        // Rate limiting по IP
        const ip = req.ip || req.connection.remoteAddress;
        const rateLimit = await checkRateLimit(
            K.RATE_LIMIT(ip), 
            CONFIG.RATE_LIMIT_WINDOW, 
            CONFIG.RATE_LIMIT_MAX
        );
        
        if (!rateLimit.allowed) {
            return res.status(CONFIG.HTTP.TOO_MANY)
                .set('Retry-After', rateLimit.retryAfter)
                .set('X-RateLimit-Remaining', '0')
                .send('Too many requests');
        }
        
        // Пробуем кэш
        let redirectData = getCachedRedirect(slug);
        
        if (!redirectData) {
            const data = await kv.hgetall(K.REDIRECT(slug));
            if (!data || !data.slug || !data.url) {
                return res.status(CONFIG.HTTP.NOT_FOUND).send('Redirect not found');
            }
            redirectData = data;
            setCachedRedirect(slug, data);
        }
        
        // Асинхронный инкремент счётчика (не блокирует ответ)
        Promise.all([
            kv.hincrby(K.REDIRECT(slug), 'clicks', 1).catch(err => {
                console.error('[redirects click increment]', err.message);
            }),
            kv.hset(K.REDIRECT(slug), { lastClickedAt: new Date().toISOString() }).catch(() => {})
        ]).then(() => {
            invalidateCache(slug); // инвалидируем кэш после обновления
        });
        
        // Логируем переход
        const duration = Date.now() - startTime;
        console.log(`[redirect] /${slug} → ${redirectData.url} (${duration}ms)`);
        
        // Редирект с правильными заголовками
        res.setHeader('X-RateLimit-Remaining', String(rateLimit.remaining));
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.redirect(302, redirectData.url);
        
    } catch (err) {
        console.error('[redirects GET]', err);
        res.status(CONFIG.HTTP.SERVER_ERROR).send('Internal server error');
    }
});

// ====================================
// ПУБЛИЧНАЯ СТАТИСТИКА (для виджетов)
// ====================================

router.get('/stats/:slug', async (req, res) => {
    try {
        const slug = req.params.slug.toLowerCase().trim();
        if (!CONFIG.SLUG_PATTERN.test(slug)) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: 'Invalid slug' });
        }
        
        const data = await kv.hgetall(K.REDIRECT(slug));
        if (!data || !data.slug) {
            return res.status(CONFIG.HTTP.NOT_FOUND).json({ error: 'Not found' });
        }
        
        res.json({
            slug: data.slug,
            clicks: parseInt(data.clicks, 10) || 0,
            lastClickedAt: data.lastClickedAt || null,
            createdAt: data.createdAt || null
        });
    } catch (err) {
        console.error('[redirects stats]', err);
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: 'Ошибка получения статистики' });
    }
});

module.exports = router;