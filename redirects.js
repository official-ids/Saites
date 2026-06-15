const express = require('express');
const crypto = require('crypto');
const { kv } = require('@vercel/kv');

const router = express.Router();

// ============================================
// Переменные окружения
// ============================================

/**
 * Токен администратора для защиты приватных endpoints
 * @constant {string}
 */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

// ============================================
// Конфигурация приложения
// ============================================

/**
 * Конфигурация системы редиректов
 * @namespace
 */
const CONFIG = {
    /**
     * Валидация slug
     * @type {Object}
     */
    VALIDATION: {
        /** @type {RegExp} Паттерн для валидации slug */
        SLUG_PATTERN: /^[a-z0-9_-]{2,32}$/,
        
        /** @type {number} Максимальная длина slug */
        SLUG_MAX_LENGTH: 32,
        
        /** @type {number} Максимальная длина описания */
        DESC_MAX_LENGTH: 200
    },
    
    /**
     * Rate limiting для публичного эндпоинта
     * @type {Object}
     */
    RATE_LIMIT: {
        /** @type {number} Окно времени в миллисекундах (1 минута) */
        WINDOW: 60 * 1000,
        
        /** @type {number} Максимальное количество переходов в окне */
        MAX: 30,
        
        /** @type {number} Интервал очистки кэша (5 минут) */
        CLEANUP_INTERVAL: 5 * 60 * 1000
    },
    
    /**
     * Защита от брутфорса
     * @type {Object}
     */
    BRUTE_FORCE: {
        /** @type {number} Окно времени в миллисекундах (1 минута) */
        WINDOW: 60 * 1000,
        
        /** @type {number} Максимальное количество попыток в окне */
        MAX: 60
    },
    
    /**
     * Кэш популярных редиректов
     * @type {Object}
     */
    CACHE: {
        /** @type {number} Время жизни кэша в миллисекундах (30 секунд) */
        TTL: 30 * 1000,
        
        /** @type {number} Максимальное количество записей в кэше */
        MAX_SIZE: 500,
        
        /** @type {number} Интервал очистки устаревших записей (1 минута) */
        CLEANUP_INTERVAL: 60000
    },
    
    /**
     * HTTP статус коды
     * @constant {Object<string, number>}
     */
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

/**
 * Сообщения об ошибках
 * @constant {Object<string, string>}
 */
const ERROR_MESSAGES = {
    // Валидация
    SLUG_REQUIRED: 'Slug обязателен',
    SLUG_INVALID: `Slug: 2-32 символа (a-z, 0-9, -, _)`,
    URL_REQUIRED: 'Требуется корректный HTTP/HTTPS URL',
    URL_INVALID: 'Некорректный URL',
    REDIRECT_EXISTS: 'Такой slug уже существует',
    REDIRECT_NOT_FOUND: 'Редирект не найден',
    NO_UPDATE_DATA: 'Нет данных для обновления',
    
    // Аутентификация
    MISSING_TOKEN: 'Missing token',
    INVALID_TOKEN: 'Invalid token',
    
    // Rate limiting
    TOO_MANY_REQUESTS: 'Too many requests',
    
    // Общие ошибки
    LIST_ERROR: 'Ошибка получения списка',
    CREATE_ERROR: 'Ошибка создания редиректа',
    UPDATE_ERROR: 'Ошибка обновления',
    DELETE_ERROR: 'Ошибка удаления',
    STATS_RESET_ERROR: 'Ошибка сброса статистики',
    STATS_ERROR: 'Ошибка получения статистики',
    
    // Публичные сообщения
    INVALID_SLUG: 'Invalid redirect slug',
    REDIRECT_NOT_FOUND_PUBLIC: 'Redirect not found',
    INTERNAL_ERROR: 'Internal server error'
};

// ============================================
// KV Keys
// ============================================

/**
 * Фабрика ключей для Vercel KV
 * @namespace
 */
const K = {
    /**
     * Ключ для данных редиректа (Hash)
     * Поля: slug, url, description, clicks, createdAt, lastClickedAt
     * 
     * @param {string} slug - Slug редиректа
     * @returns {string} Ключ KV
     */
    REDIRECT: (slug) => `redirect:${slug.toLowerCase()}`,
    
    /** @type {string} Set всех slug'и */
    REDIRECTS_INDEX: 'redirects:index',
    
    /**
     * Ключ для rate limiting публичных переходов
     * @param {string} ip - IP адрес клиента
     * @returns {string} Ключ KV
     */
    RATE_LIMIT: (ip) => `rl:redirect:pub:${ip}`,
    
    /**
     * Ключ для rate limiting админских операций
     * @param {string} ip - IP адрес клиента
     * @returns {string} Ключ KV
     */
    ADMIN_RATE_LIMIT: (ip) => `rl:redirect:admin:${ip}`,
    
    /**
     * Ключ для защиты от брутфорса
     * @param {string} ip - IP адрес клиента
     * @returns {string} Ключ KV
     */
    BRUTE_FORCE: (ip) => `bf:redirect:${ip}`
};

// ============================================
// In-Memory кэш
// ============================================

/**
 * In-memory кэш для популярных редиректов
 * Ключ: slug редиректа
 * Значение: { data: Object, timestamp: number }
 * @type {Map<string, {data: Object, timestamp: number}>}
 */
const redirectCache = new Map();

/**
 * Время последней очистки кэша
 * @type {number}
 */
let cacheLastCleanup = Date.now();

/**
 * Получение редиректа из кэша
 * 
 * @param {string} slug - Slug редиректа
 * @returns {Object|null} Данные редиректа или null, если не найдены или устарели
 */
function getCachedRedirect(slug) {
    const entry = redirectCache.get(slug);
    if (!entry) return null;
    
    // Проверка актуальности кэша
    if (Date.now() - entry.timestamp > CONFIG.CACHE.TTL) {
        redirectCache.delete(slug);
        return null;
    }
    
    return entry.data;
}

/**
 * Сохранение редиректа в кэш
 * Автоматически очищает устаревшие записи при достижении лимита
 * 
 * @param {string} slug - Slug редиректа
 * @param {Object} data - Данные редиректа
 */
function setCachedRedirect(slug, data) {
    // Очистка устаревших записей при достижении лимита
    if (redirectCache.size >= CONFIG.CACHE.MAX_SIZE && 
        Date.now() - cacheLastCleanup > CONFIG.CACHE.CLEANUP_INTERVAL) {
        const now = Date.now();
        for (const [key, entry] of redirectCache.entries()) {
            if (now - entry.timestamp > CONFIG.CACHE.TTL) {
                redirectCache.delete(key);
            }
        }
        cacheLastCleanup = now;
    }
    
    redirectCache.set(slug, { data, timestamp: Date.now() });
}

/**
 * Инвалидация кэша для конкретного редиректа
 * 
 * @param {string} slug - Slug редиректа
 */
function invalidateCache(slug) {
    redirectCache.delete(slug);
}

// ============================================
// Rate Limiting
// ============================================

/**
 * Проверка и обновление rate limit
 * Использует KV для распределённого rate limiting
 * 
 * @param {string} key - Ключ KV для rate limit
 * @param {number} windowMs - Окно времени в миллисекундах
 * @param {number} max - Максимальное количество запросов
 * @returns {Promise<Object>} Результат проверки: { allowed, remaining, retryAfter? }
 */
async function checkRateLimit(key, windowMs, max) {
    try {
        const current = await kv.get(key);
        const now = Date.now();
        
        // Если ключа нет — создаём новый
        if (!current) {
            await kv.set(key, { count: 1, resetAt: now + windowMs }, { 
                ex: Math.ceil(windowMs / 1000) 
            });
            return { allowed: true, remaining: max - 1 };
        }
        
        // Если окно истекло — сбрасываем счётчик
        if (now > current.resetAt) {
            await kv.set(key, { count: 1, resetAt: now + windowMs }, { 
                ex: Math.ceil(windowMs / 1000) 
            });
            return { allowed: true, remaining: max - 1 };
        }
        
        // Если лимит исчерпан — отказываем
        if (current.count >= max) {
            return { 
                allowed: false, 
                retryAfter: Math.ceil((current.resetAt - now) / 1000),
                remaining: 0
            };
        }
        
        // Увеличиваем счётчик
        await kv.hincrby(key, 'count', 1);
        return { allowed: true, remaining: max - current.count - 1 };
        
    } catch (err) {
        console.error('[Rate Limit] KV error:', err.message);
        return { allowed: true, remaining: max }; // fail-open
    }
}

// ============================================
// Middleware
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
        return res.status(CONFIG.HTTP.UNAUTHORIZED).json({ 
            error: ERROR_MESSAGES.MISSING_TOKEN 
        });
    }
    
    const token = authHeader.split(' ')[1];
    
    if (!ADMIN_TOKEN || !token) {
        return res.status(CONFIG.HTTP.FORBIDDEN).json({ 
            error: ERROR_MESSAGES.INVALID_TOKEN 
        });
    }
    
    // Безопасное сравнение: сначала проверяем длину, затем timing-safe
    const isValid = token.length === ADMIN_TOKEN.length &&
                    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN));
    
    if (!isValid) {
        return res.status(CONFIG.HTTP.FORBIDDEN).json({ 
            error: ERROR_MESSAGES.INVALID_TOKEN 
        });
    }
    
    next();
}

// ============================================
// Утилиты валидации
// ============================================

/**
 * Проверка валидности URL
 * 
 * @param {string} string - URL для проверки
 * @returns {boolean} true если URL валиден (http или https)
 * 
 * @example
 * isValidUrl('https://example.com'); // true
 * isValidUrl('ftp://example.com'); // false
 */
function isValidUrl(string) {
    try {
        const url = new URL(string);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

/**
 * Валидация slug
 * 
 * @param {string} slug - Slug для проверки
 * @returns {{ valid: boolean, error?: string, normalized?: string }}
 */
function validateSlug(slug) {
    if (!slug || typeof slug !== 'string') {
        return { valid: false, error: ERROR_MESSAGES.SLUG_REQUIRED };
    }
    
    const normalizedSlug = slug.toLowerCase().trim();
    
    if (!CONFIG.VALIDATION.SLUG_PATTERN.test(normalizedSlug)) {
        return { valid: false, error: ERROR_MESSAGES.SLUG_INVALID };
    }
    
    return { valid: true, normalized: normalizedSlug };
}

/**
 * Валидация URL
 * 
 * @param {string} url - URL для проверки
 * @returns {{ valid: boolean, error?: string, normalized?: string }}
 */
function validateUrl(url) {
    if (!url || typeof url !== 'string' || !isValidUrl(url)) {
        return { valid: false, error: ERROR_MESSAGES.URL_REQUIRED };
    }
    
    return { valid: true, normalized: url.trim() };
}

// ============================================
// Утилиты миграции
// ============================================

/**
 * Нормализация данных редиректа из KV
 * 
 * @param {Object} data - Сырые данные из KV
 * @param {string} slug - Slug редиректа
 * @returns {Object} Нормализованные данные
 */
function normalizeRedirectData(data, slug) {
    return {
        slug: data.slug || slug,
        url: data.url,
        description: data.description || '',
        clicks: parseInt(data.clicks, 10) || 0,
        createdAt: data.createdAt || new Date().toISOString(),
        lastClickedAt: data.lastClickedAt || null
    };
}

/**
 * Миграция редиректа из JSON формата в Hash формат
 * 
 * @param {string} slug - Slug редиректа
 * @param {Object} data - Данные редиректа
 * @returns {Promise<void>}
 */
async function migrateRedirectToHash(slug, data) {
    try {
        await kv.del(K.REDIRECT(slug));
        await kv.hset(K.REDIRECT(slug), {
            slug: data.slug,
            url: data.url,
            description: data.description,
            clicks: String(data.clicks),
            createdAt: data.createdAt,
            lastClickedAt: data.lastClickedAt || ''
        });
        console.log(`[migrate] ${slug}: JSON → Hash`);
    } catch (err) {
        console.warn(`[migrate] Failed to migrate ${slug}:`, err.message);
    }
}

/**
 * Чтение данных редиректа с автоматической миграцией
 * 
 * @param {string} slug - Slug редиректа
 * @returns {Promise<Object|null>} Данные редиректа или null, если не найдены
 */
async function getRedirectWithMigration(slug) {
    // Попытка 1: читаем как Hash (новый формат)
    try {
        const hashData = await kv.hgetall(K.REDIRECT(slug));
        if (hashData && typeof hashData === 'object' && hashData.url) {
            return normalizeRedirectData(hashData, slug);
        }
    } catch (hashErr) {
        // Hash не удался — возможно, старый формат
    }
    
    // Попытка 2: читаем как JSON (старый формат) и мигрируем
    try {
        const oldData = await kv.get(K.REDIRECT(slug));
        if (oldData && typeof oldData === 'object' && oldData.url) {
            const data = normalizeRedirectData(oldData, slug);
            
            // Миграция: перезаписываем в Hash-формат
            await migrateRedirectToHash(slug, data);
            
            return data;
        }
    } catch (jsonErr) {
        console.warn(`[redirects] Cannot read ${slug}:`, jsonErr.message);
    }
    
    return null;
}

// ============================================
// Админские эндпоинты
// ============================================

/**
 * GET /admin — получение списка всех редиректов
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
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
                
                const data = await getRedirectWithMigration(normalizedSlug);
                
                if (data) {
                    redirects.push(data);
                    if (data.migrated) migrationCount++;
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
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ 
            error: ERROR_MESSAGES.LIST_ERROR,
            details: process.env.NODE_ENV !== 'production' ? err.message : undefined
        });
    }
});

/**
 * POST /admin — создание нового редиректа
 * 
 * @param {express.Request} req - HTTP запрос с { slug, url, description? }
 * @param {express.Response} res - HTTP ответ
 */
router.post('/admin', verifyAdminToken, async (req, res) => {
    try {
        const { slug, url, description } = req.body;
        
        // Валидация slug
        const slugValidation = validateSlug(slug);
        if (!slugValidation.valid) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ 
                error: slugValidation.error 
            });
        }
        
        const normalizedSlug = slugValidation.normalized;
        
        // Валидация URL
        const urlValidation = validateUrl(url);
        if (!urlValidation.valid) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ 
                error: urlValidation.error 
            });
        }
        
        // Проверка существования
        const existing = await kv.hgetall(K.REDIRECT(normalizedSlug));
        if (existing && existing.slug) {
            return res.status(CONFIG.HTTP.CONFLICT).json({ 
                error: ERROR_MESSAGES.REDIRECT_EXISTS 
            });
        }
        
        const now = new Date().toISOString();
        const redirectData = {
            slug: normalizedSlug,
            url: urlValidation.normalized,
            description: description ? String(description).slice(0, CONFIG.VALIDATION.DESC_MAX_LENGTH) : '',
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
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ 
            error: ERROR_MESSAGES.CREATE_ERROR 
        });
    }
});

/**
 * PATCH /admin/:slug — обновление редиректа
 * 
 * @param {express.Request} req - HTTP запрос с { url?, description? }
 * @param {express.Response} res - HTTP ответ
 */
router.patch('/admin/:slug', verifyAdminToken, async (req, res) => {
    try {
        const slugValidation = validateSlug(req.params.slug);
        if (!slugValidation.valid) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ 
                error: slugValidation.error 
            });
        }
        
        const slug = slugValidation.normalized;
        
        const existing = await kv.hgetall(K.REDIRECT(slug));
        if (!existing || !existing.slug) {
            return res.status(CONFIG.HTTP.NOT_FOUND).json({ 
                error: ERROR_MESSAGES.REDIRECT_NOT_FOUND 
            });
        }
        
        const updates = {};
        const { url, description } = req.body;
        
        if (url !== undefined) {
            const urlValidation = validateUrl(url);
            if (!urlValidation.valid) {
                return res.status(CONFIG.HTTP.BAD_REQUEST).json({ 
                    error: urlValidation.error 
                });
            }
            updates.url = urlValidation.normalized;
        }
        
        if (description !== undefined) {
            updates.description = String(description).slice(0, CONFIG.VALIDATION.DESC_MAX_LENGTH);
        }
        
        if (Object.keys(updates).length === 0) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ 
                error: ERROR_MESSAGES.NO_UPDATE_DATA 
            });
        }
        
        await kv.hset(K.REDIRECT(slug), updates);
        invalidateCache(slug);
        
        res.json({ success: true, updated: updates });
        
    } catch (err) {
        console.error('[redirects PATCH admin]', err);
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ 
            error: ERROR_MESSAGES.UPDATE_ERROR 
        });
    }
});

/**
 * DELETE /admin/:slug — удаление редиректа
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.delete('/admin/:slug', verifyAdminToken, async (req, res) => {
    try {
        const slugValidation = validateSlug(req.params.slug);
        if (!slugValidation.valid) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ 
                error: slugValidation.error 
            });
        }
        
        const slug = slugValidation.normalized;
        
        await kv.del(K.REDIRECT(slug));
        await kv.srem(K.REDIRECTS_INDEX, slug);
        invalidateCache(slug);
        
        res.json({ success: true });
        
    } catch (err) {
        console.error('[redirects DELETE admin]', err);
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ 
            error: ERROR_MESSAGES.DELETE_ERROR 
        });
    }
});

/**
 * POST /admin/:slug/reset-stats — сброс счётчика кликов
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.post('/admin/:slug/reset-stats', verifyAdminToken, async (req, res) => {
    try {
        const slugValidation = validateSlug(req.params.slug);
        if (!slugValidation.valid) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ 
                error: slugValidation.error 
            });
        }
        
        const slug = slugValidation.normalized;
        
        const existing = await kv.hgetall(K.REDIRECT(slug));
        if (!existing || !existing.slug) {
            return res.status(CONFIG.HTTP.NOT_FOUND).json({ 
                error: ERROR_MESSAGES.REDIRECT_NOT_FOUND 
            });
        }
        
        await kv.hset(K.REDIRECT(slug), { clicks: '0', lastClickedAt: '' });
        invalidateCache(slug);
        
        res.json({ success: true, message: 'Статистика сброшена' });
        
    } catch (err) {
        console.error('[redirects reset-stats]', err);
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ 
            error: ERROR_MESSAGES.STATS_RESET_ERROR 
        });
    }
});

// ============================================
// Публичный эндпоинт
// ============================================

/**
 * GET /:slug — публичный переход по редиректу
 * Поддерживает rate limiting и кэширование
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.get('/:slug', async (req, res) => {
    const startTime = Date.now();
    
    try {
        const slugValidation = validateSlug(req.params.slug);
        if (!slugValidation.valid) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).send(ERROR_MESSAGES.INVALID_SLUG);
        }
        
        const slug = slugValidation.normalized;
        
        // Rate limiting по IP
        const ip = req.ip || req.connection.remoteAddress;
        const rateLimit = await checkRateLimit(
            K.RATE_LIMIT(ip), 
            CONFIG.RATE_LIMIT.WINDOW, 
            CONFIG.RATE_LIMIT.MAX
        );
        
        if (!rateLimit.allowed) {
            return res.status(CONFIG.HTTP.TOO_MANY)
                .set('Retry-After', rateLimit.retryAfter)
                .set('X-RateLimit-Remaining', '0')
                .send(ERROR_MESSAGES.TOO_MANY_REQUESTS);
        }
        
        // Пробуем кэш
        let redirectData = getCachedRedirect(slug);
        
        if (!redirectData) {
            const data = await kv.hgetall(K.REDIRECT(slug));
            if (!data || !data.slug || !data.url) {
                return res.status(CONFIG.HTTP.NOT_FOUND).send(ERROR_MESSAGES.REDIRECT_NOT_FOUND_PUBLIC);
            }
            redirectData = data;
            setCachedRedirect(slug, data);
        }
        
        // Асинхронный инкремент счётчика (не блокирует ответ)
        Promise.all([
            kv.hincrby(K.REDIRECT(slug), 'clicks', 1).catch(err => {
                console.error('[redirects click increment]', err.message);
            }),
            kv.hset(K.REDIRECT(slug), { 
                lastClickedAt: new Date().toISOString() 
            }).catch(() => {})
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
        res.status(CONFIG.HTTP.SERVER_ERROR).send(ERROR_MESSAGES.INTERNAL_ERROR);
    }
});

// ============================================
// Публичная статистика
// ============================================

/**
 * GET /stats/:slug — получение публичной статистики редиректа
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.get('/stats/:slug', async (req, res) => {
    try {
        const slugValidation = validateSlug(req.params.slug);
        if (!slugValidation.valid) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ 
                error: slugValidation.error 
            });
        }
        
        const slug = slugValidation.normalized;
        
        const data = await kv.hgetall(K.REDIRECT(slug));
        if (!data || !data.slug) {
            return res.status(CONFIG.HTTP.NOT_FOUND).json({ 
                error: ERROR_MESSAGES.REDIRECT_NOT_FOUND 
            });
        }
        
        res.json({
            slug: data.slug,
            clicks: parseInt(data.clicks, 10) || 0,
            lastClickedAt: data.lastClickedAt || null,
            createdAt: data.createdAt || null
        });
        
    } catch (err) {
        console.error('[redirects stats]', err);
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ 
            error: ERROR_MESSAGES.STATS_ERROR 
        });
    }
});

// ============================================
// Экспорт роутера
// ============================================

module.exports = router;