// ============================================
// Модуль: Push Notifications
// ============================================
// Управление веб-пуш уведомлениями
// Подключается в proxy.js как: require('../notifications')
// ============================================

const express = require('express');
const crypto = require('crypto');
const webpush = require('web-push');
const { kv } = require('@vercel/kv');
const router = express.Router();

// ============================================
// Переменные окружения
// ============================================
/**
Токен администратора для защиты приватных endpoints
@constant {string}
*/
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

/**
VAPID Public Key для Web Push
@constant {string}
*/
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;

/**
VAPID Private Key для Web Push
@constant {string}
*/
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

/**
Email для VAPID (используется при генерации ключей)
@constant {string}
*/
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'admin@saite-oris.ru';

// ============================================
// Конфигурация Web Push
// ============================================
/**
Инициализация VAPID ключей для web-push библиотеки
*/
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        `mailto:${VAPID_EMAIL}`,
        VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY
    );
    console.log('[notifications] VAPID keys configured');
} else {
    console.warn('[notifications] WARNING: VAPID keys not configured. Push notifications will not work.');
    console.warn('[notifications] Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in environment variables.');
}

// ============================================
// Конфигурация приложения
// ============================================
/**
Конфигурация системы уведомлений
@namespace
*/
const CONFIG = {
    /**
    Валидация данных
    @type {Object}
    */
    VALIDATION: {
        /** @type {number} Максимальная длина заголовка */
        TITLE_MAX_LENGTH: 100,
        /** @type {number} Максимальная длина текста уведомления */
        BODY_MAX_LENGTH: 500,
        /** @type {number} Максимальная длина URL иконки */
        ICON_MAX_LENGTH: 500,
        /** @type {number} Максимальная длина URL открытия */
        URL_MAX_LENGTH: 500
    },
    /**
    Rate limiting для публичных endpoints
    @type {Object}
    */
    RATE_LIMIT: {
        /** @type {number} Окно времени в миллисекундах (1 минута) */
        WINDOW: 60 * 1000,
        /** @type {number} Максимальное количество запросов в окне */
        MAX: 10,
        /** @type {number} Интервал очистки кэша (5 минут) */
        CLEANUP_INTERVAL: 5 * 60 * 1000
    },
    /**
    Rate limiting для отправки уведомлений (админ)
    @type {Object}
    */
    SEND_RATE_LIMIT: {
        /** @type {number} Окно времени в миллисекундах (1 час) */
        WINDOW: 60 * 60 * 1000,
        /** @type {number} Максимальное количество отправок в час */
        MAX: 100
    },
    /**
    Кэш подписок
    @type {Object}
    */
    CACHE: {
        /** @type {number} Время жизни кэша в миллисекундах (1 минута) */
        TTL: 60 * 1000,
        /** @type {number} Максимальное количество записей в кэше */
        MAX_SIZE: 1000
    },
    /**
    HTTP статус коды
    @constant {Object<string, number>}
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
Сообщения об ошибках
@constant {Object<string, string>}
*/
const ERROR_MESSAGES = {
    // Валидация
    SUBSCRIPTION_REQUIRED: 'Subscription object is required',
    INVALID_SUBSCRIPTION: 'Invalid subscription format',
    TITLE_REQUIRED: 'Title is required',
    TITLE_TOO_LONG: `Title must be ${CONFIG.VALIDATION.TITLE_MAX_LENGTH} characters or less`,
    BODY_REQUIRED: 'Body is required',
    BODY_TOO_LONG: `Body must be ${CONFIG.VALIDATION.BODY_MAX_LENGTH} characters or less`,
    INVALID_URL: 'Invalid URL format',
    // Аутентификация
    MISSING_TOKEN: 'Missing token',
    INVALID_TOKEN: 'Invalid token',
    VAPID_NOT_CONFIGURED: 'VAPID keys not configured',
    // Rate limiting
    TOO_MANY_REQUESTS: 'Too many requests',
    SEND_RATE_LIMIT: 'Send rate limit exceeded',
    // Общие ошибки
    SUBSCRIBE_ERROR: 'Error saving subscription',
    UNSUBSCRIBE_ERROR: 'Error removing subscription',
    SEND_ERROR: 'Error sending notification',
    STATS_ERROR: 'Error getting statistics',
    SUBSCRIPTION_NOT_FOUND: 'Subscription not found',
    // Публичные сообщения
    INTERNAL_ERROR: 'Internal server error'
};

// ============================================
// KV Keys
// ============================================
/**
Фабрика ключей для Vercel KV
@namespace
*/
const K = {
    /**
    Ключ для хранения подписки
    @param {string} endpoint - Endpoint подписки
    @returns {string} Ключ KV
    */
    SUBSCRIPTION: (endpoint) => `push:sub:${endpoint}`,
    
    /** @type {string} Set всех endpoints подписок */
    SUBSCRIPTIONS_INDEX: 'push:subscriptions:index',
    
    /**
    Ключ для rate limiting подписки
    @param {string} ip - IP адрес клиента
    @returns {string} Ключ KV
    */
    RATE_LIMIT: (ip) => `rl:push:sub:${ip}`,
    
    /**
    Ключ для rate limiting отправки уведомлений
    @param {string} ip - IP адрес клиента
    @returns {string} Ключ KV
    */
    SEND_RATE_LIMIT: (ip) => `rl:push:send:${ip}`,
    
    /** @type {string} Счётчик отправленных уведомлений */
    SEND_COUNTER: 'push:send:counter',
    
    /** @type {string} История отправленных уведомлений */
    SEND_HISTORY: 'push:send:history'
};

// ============================================
// In-Memory кэш
// ============================================
/**
In-memory кэш для статистики подписок
@type {Map<string, {data: Object, timestamp: number}>}
*/
const statsCache = new Map();

/**
Получение статистики из кэша
@returns {Object|null} Данные статистики или null
*/
function getCachedStats() {
    const entry = statsCache.get('global');
    if (!entry) return null;
    
    if (Date.now() - entry.timestamp > CONFIG.CACHE.TTL) {
        statsCache.delete('global');
        return null;
    }
    
    return entry.data;
}

/**
Сохранение статистики в кэш
@param {Object} data - Данные статистики
*/
function setCachedStats(data) {
    statsCache.set('global', { data, timestamp: Date.now() });
}

/**
Инвалидация кэша статистики
*/
function invalidateStatsCache() {
    statsCache.delete('global');
}

// ============================================
// Middleware
// ============================================
/**
Middleware для проверки токена администратора
Использует timing-safe сравнение для защиты от timing-атак
@param {express.Request} req - HTTP запрос
@param {express.Response} res - HTTP ответ
@param {express.NextFunction} next - Следующий middleware
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
// Rate Limiting
// ============================================
/**
Проверка и обновление rate limit
Использует KV для распределённого rate limiting
@param {string} key - Ключ KV для rate limit
@param {number} windowMs - Окно времени в миллисекундах
@param {number} max - Максимальное количество запросов
@returns {Promise<Object>} Результат проверки: { allowed, remaining, retryAfter? }
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
        console.error('[notifications Rate Limit] KV error:', err.message);
        return { allowed: true, remaining: max }; // fail-open
    }
}

// ============================================
// Утилиты валидации
// ============================================
/**
Проверка валидности URL
Принимает как абсолютные (https://...), так и относительные (/path) URL
@param {string} string - URL для проверки
@returns {boolean} true если URL валиден
*/
function isValidUrl(string) {
    if (!string || typeof string !== 'string') return false;
    
    // Относительные пути (начинаются с /) — валидны
    if (string.startsWith('/')) {
        return true;
    }
    
    // Абсолютные URL
    try {
        const url = new URL(string);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

/**
Валидация объекта подписки
@param {Object} subscription - Объект подписки
@returns {{ valid: boolean, error?: string }}
*/
function validateSubscription(subscription) {
    if (!subscription || typeof subscription !== 'object') {
        return { valid: false, error: ERROR_MESSAGES.SUBSCRIPTION_REQUIRED };
    }
    
    if (!subscription.endpoint || typeof subscription.endpoint !== 'string') {
        return { valid: false, error: ERROR_MESSAGES.INVALID_SUBSCRIPTION };
    }
    
    if (!subscription.keys || typeof subscription.keys !== 'object') {
        return { valid: false, error: ERROR_MESSAGES.INVALID_SUBSCRIPTION };
    }
    
    if (!subscription.keys.p256dh || !subscription.keys.auth) {
        return { valid: false, error: ERROR_MESSAGES.INVALID_SUBSCRIPTION };
    }
    
    return { valid: true };
}

/**
Валидация данных уведомления
@param {Object} notification - Данные уведомления
@returns {{ valid: boolean, error?: string }}
*/
function validateNotification(notification) {
    if (!notification || typeof notification !== 'object') {
        return { valid: false, error: 'Notification data is required' };
    }
    
    if (!notification.title || typeof notification.title !== 'string') {
        return { valid: false, error: ERROR_MESSAGES.TITLE_REQUIRED };
    }
    
    if (notification.title.length > CONFIG.VALIDATION.TITLE_MAX_LENGTH) {
        return { valid: false, error: ERROR_MESSAGES.TITLE_TOO_LONG };
    }
    
    if (!notification.body || typeof notification.body !== 'string') {
        return { valid: false, error: ERROR_MESSAGES.BODY_REQUIRED };
    }
    
    if (notification.body.length > CONFIG.VALIDATION.BODY_MAX_LENGTH) {
        return { valid: false, error: ERROR_MESSAGES.BODY_TOO_LONG };
    }
    
    if (notification.icon && !isValidUrl(notification.icon)) {
        return { valid: false, error: 'Invalid icon URL' };
    }
    
    if (notification.url && !isValidUrl(notification.url)) {
        return { valid: false, error: ERROR_MESSAGES.INVALID_URL };
    }
    
    return { valid: true };
}

// ============================================
// Публичные эндпоинты
// ============================================
/**
POST /subscribe — сохранение подписки на уведомления
@param {express.Request} req - HTTP запрос с объектом subscription
@param {express.Response} res - HTTP ответ
*/
router.post('/subscribe', async (req, res) => {
    try {
        const { subscription } = req.body;
        
        // Валидация подписки
        const validation = validateSubscription(subscription);
        if (!validation.valid) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ 
                error: validation.error 
            });
        }
        
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
                .json({ 
                    error: ERROR_MESSAGES.TOO_MANY_REQUESTS 
                });
        }
        
        // Проверка, существует ли уже такая подписка
        const existing = await kv.get(K.SUBSCRIPTION(subscription.endpoint));
        if (existing) {
            return res.status(CONFIG.HTTP.CONFLICT).json({ 
                error: 'Subscription already exists' 
            });
        }
        
        // Сохранение подписки
        const subscriptionData = {
            endpoint: subscription.endpoint,
            keys: subscription.keys,
            createdAt: new Date().toISOString(),
            userAgent: req.headers['user-agent'] || 'Unknown',
            ip: ip
        };
        
        await kv.set(K.SUBSCRIPTION(subscription.endpoint), subscriptionData);
        await kv.sadd(K.SUBSCRIPTIONS_INDEX, subscription.endpoint);
        
        console.log(`[notifications] New subscription: ${subscription.endpoint}`);
        
        res.status(CONFIG.HTTP.CREATED).json({ 
            success: true,
            message: 'Subscription saved'
        });
    } catch (err) {
        console.error('[notifications POST /subscribe]', err);
        res.status(CONFIG.HTTP.SERVER_ERROR).json({
            error: ERROR_MESSAGES.SUBSCRIBE_ERROR
        });
    }
});

/**
POST /unsubscribe — удаление подписки
@param {express.Request} req - HTTP запрос с endpoint
@param {express.Response} res - HTTP ответ
*/
router.post('/unsubscribe', async (req, res) => {
    try {
        const { endpoint } = req.body;
        
        if (!endpoint || typeof endpoint !== 'string') {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ 
                error: 'Endpoint is required' 
            });
        }
        
        // Проверка существования подписки
        const existing = await kv.get(K.SUBSCRIPTION(endpoint));
        if (!existing) {
            return res.status(CONFIG.HTTP.NOT_FOUND).json({ 
                error: ERROR_MESSAGES.SUBSCRIPTION_NOT_FOUND 
            });
        }
        
        // Удаление подписки
        await kv.del(K.SUBSCRIPTION(endpoint));
        await kv.srem(K.SUBSCRIPTIONS_INDEX, endpoint);
        
        console.log(`[notifications] Removed subscription: ${endpoint}`);
        
        res.json({ 
            success: true,
            message: 'Subscription removed'
        });
    } catch (err) {
        console.error('[notifications POST /unsubscribe]', err);
        res.status(CONFIG.HTTP.SERVER_ERROR).json({
            error: ERROR_MESSAGES.UNSUBSCRIBE_ERROR
        });
    }
});

/**
GET /stats — получение статистики подписок (публичный)
@param {express.Request} req - HTTP запрос
@param {express.Response} res - HTTP ответ
*/
router.get('/stats', async (req, res) => {
    try {
        // Проверяем кэш
        const cached = getCachedStats();
        if (cached) {
            return res.json(cached);
        }
        
        // Получаем количество подписок
        const subscriptions = await kv.smembers(K.SUBSCRIPTIONS_INDEX);
        const totalSubscriptions = subscriptions ? subscriptions.length : 0;
        
        // Получаем счётчик отправленных уведомлений
        const sendCounter = await kv.get(K.SEND_COUNTER);
        const totalSent = sendCounter ? parseInt(sendCounter, 10) : 0;
        
        const stats = {
            totalSubscriptions,
            totalSent,
            timestamp: new Date().toISOString()
        };
        
        // Сохраняем в кэш
        setCachedStats(stats);
        
        res.json(stats);
    } catch (err) {
        console.error('[notifications GET /stats]', err);
        res.status(CONFIG.HTTP.SERVER_ERROR).json({
            error: ERROR_MESSAGES.STATS_ERROR
        });
    }
});

// ============================================
// Админские эндпоинты
// ============================================
/**
GET /admin/subscriptions — получение списка всех подписок
@param {express.Request} req - HTTP запрос
@param {express.Response} res - HTTP ответ
*/
router.get('/admin/subscriptions', verifyAdminToken, async (req, res) => {
    try {
        const endpoints = await kv.smembers(K.SUBSCRIPTIONS_INDEX);
        
        if (!endpoints || !Array.isArray(endpoints) || endpoints.length === 0) {
            return res.json({ subscriptions: [], total: 0 });
        }
        
        const subscriptions = [];
        
        for (const endpoint of endpoints) {
            try {
                const data = await kv.get(K.SUBSCRIPTION(endpoint));
                if (data) {
                    subscriptions.push({
                        endpoint: data.endpoint,
                        createdAt: data.createdAt,
                        userAgent: data.userAgent,
                        ip: data.ip
                    });
                } else {
                    // Битая запись — удаляем из индекса
                    console.warn(`[notifications] Orphan subscription removed: ${endpoint}`);
                    await kv.srem(K.SUBSCRIPTIONS_INDEX, endpoint).catch(() => {});
                }
            } catch (itemErr) {
                console.error(`[notifications] Error processing subscription "${endpoint}":`, itemErr.message);
            }
        }
        
        // Сортировка по дате создания (новые сверху)
        subscriptions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        
        res.json({ 
            subscriptions,
            total: subscriptions.length
        });
    } catch (err) {
        console.error('[notifications GET /admin/subscriptions]', err);
        res.status(CONFIG.HTTP.SERVER_ERROR).json({
            error: 'Error getting subscriptions list'
        });
    }
});

/**
POST /admin/send — отправка уведомления всем подписчикам
@param {express.Request} req - HTTP запрос с { notification: { title, body, icon?, url? } }
@param {express.Response} res - HTTP ответ
*/
router.post('/admin/send', verifyAdminToken, async (req, res) => {
    try {
        // Проверка настройки VAPID
        if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
            return res.status(CONFIG.HTTP.SERVER_ERROR).json({
                error: ERROR_MESSAGES.VAPID_NOT_CONFIGURED
            });
        }
        
        const { notification } = req.body;
        
        // Валидация уведомления
        const validation = validateNotification(notification);
        if (!validation.valid) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ 
                error: validation.error 
            });
        }
        
        // Rate limiting для отправки
        const ip = req.ip || req.connection.remoteAddress;
        const rateLimit = await checkRateLimit(
            K.SEND_RATE_LIMIT(ip), 
            CONFIG.SEND_RATE_LIMIT.WINDOW, 
            CONFIG.SEND_RATE_LIMIT.MAX
        );
        
        if (!rateLimit.allowed) {
            return res.status(CONFIG.HTTP.TOO_MANY)
                .set('Retry-After', rateLimit.retryAfter)
                .json({ 
                    error: ERROR_MESSAGES.SEND_RATE_LIMIT 
                });
        }
        
        // Получаем все подписки
        const endpoints = await kv.smembers(K.SUBSCRIPTIONS_INDEX);
        
        if (!endpoints || endpoints.length === 0) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({
                error: 'No subscribers found'
            });
        }
        
        // Формируем payload
        const payload = JSON.stringify({
            title: notification.title,
            body: notification.body,
            icon: notification.icon || '/favicon.ico',
            data: {
                url: notification.url || '/'
            },
            requireInteraction: notification.requireInteraction || false,
            timestamp: Date.now()
        });
        
        // Отправляем уведомления всем подписчикам
        const results = {
            total: endpoints.length,
            success: 0,
            failed: 0,
            errors: []
        };
        
        for (const endpoint of endpoints) {
            try {
                const subscriptionData = await kv.get(K.SUBSCRIPTION(endpoint));
                
                if (!subscriptionData) {
                    results.failed++;
                    continue;
                }
                
                // Восстанавливаем объект подписки для web-push
                const subscription = {
                    endpoint: subscriptionData.endpoint,
                    keys: subscriptionData.keys
                };
                
                await webpush.sendNotification(subscription, payload);
                results.success++;
                
            } catch (sendErr) {
                results.failed++;
                results.errors.push({
                    endpoint: endpoint,
                    error: sendErr.message
                });
                
                // Если подписка недействительна — удаляем её
                if (sendErr.statusCode === 410 || sendErr.statusCode === 404) {
                    console.log(`[notifications] Removing invalid subscription: ${endpoint}`);
                    await kv.del(K.SUBSCRIPTION(endpoint)).catch(() => {});
                    await kv.srem(K.SUBSCRIPTIONS_INDEX, endpoint).catch(() => {});
                }
            }
        }
        
        // Обновляем счётчик отправленных уведомлений
        await kv.incr(K.SEND_COUNTER);
        
        // Сохраняем в историю
        const historyEntry = {
            timestamp: new Date().toISOString(),
            title: notification.title,
            body: notification.body,
            ...results
        };
        
        await kv.lpush(K.SEND_HISTORY, JSON.stringify(historyEntry));
        await kv.ltrim(K.SEND_HISTORY, 0, 99); // Храним последние 100 записей
        
        console.log(`[notifications] Notification sent: ${notification.title} (${results.success}/${results.total})`);
        
        res.json({ 
            success: true,
            results
        });
    } catch (err) {
        console.error('[notifications POST /admin/send]', err);
        res.status(CONFIG.HTTP.SERVER_ERROR).json({
            error: ERROR_MESSAGES.SEND_ERROR
        });
    }
});

/**
GET /admin/history — получение истории отправленных уведомлений
@param {express.Request} req - HTTP запрос
@param {express.Response} res - HTTP ответ
*/
router.get('/admin/history', verifyAdminToken, async (req, res) => {
    try {
        const history = await kv.lrange(K.SEND_HISTORY, 0, 99);
        
        const parsedHistory = history ? history.map(entry => {
            try {
                return JSON.parse(entry);
            } catch (e) {
                return null;
            }
        }).filter(Boolean) : [];
        
        res.json({ 
            history: parsedHistory,
            total: parsedHistory.length
        });
    } catch (err) {
        console.error('[notifications GET /admin/history]', err);
        res.status(CONFIG.HTTP.SERVER_ERROR).json({
            error: 'Error getting history'
        });
    }
});

/**
POST /admin/cleanup — очистка недействительных подписок
@param {express.Request} req - HTTP запрос
@param {express.Response} res - HTTP ответ
*/
router.post('/admin/cleanup', verifyAdminToken, async (req, res) => {
    try {
        const endpoints = await kv.smembers(K.SUBSCRIPTIONS_INDEX);
        
        if (!endpoints || endpoints.length === 0) {
            return res.json({ cleaned: 0 });
        }
        
        let cleaned = 0;
        
        for (const endpoint of endpoints) {
            const data = await kv.get(K.SUBSCRIPTION(endpoint));
            
            if (!data) {
                // Подписка не найдена — удаляем из индекса
                await kv.srem(K.SUBSCRIPTIONS_INDEX, endpoint).catch(() => {});
                cleaned++;
            }
        }
        
        console.log(`[notifications] Cleaned ${cleaned} invalid subscriptions`);
        
        res.json({ 
            success: true,
            cleaned
        });
    } catch (err) {
        console.error('[notifications POST /admin/cleanup]', err);
        res.status(CONFIG.HTTP.SERVER_ERROR).json({
            error: 'Error cleaning subscriptions'
        });
    }
});

// ============================================
// Экспорт роутера
// ============================================
module.exports = router;