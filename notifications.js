// ============================================
// ============================================
// ============================================
// МОДУЛЬ: PUSH NOTIFICATIONS (ALL-IN-ONE)
// Универсальная система веб-пуш уведомлений
// с каналами, сервисным API, логгером и безопасностью
// ============================================
// ============================================
// ============================================

const express = require('express');
const crypto = require('crypto');
const webpush = require('web-push');
const { kv } = require('@vercel/kv');

const router = express.Router();

// ============================================
// ██████  КОНФИГУРАЦИЯ
// ============================================

const CONFIG = {
    VALIDATION: {
        TITLE_MAX_LENGTH: 150,
        BODY_MAX_LENGTH: 1000,
        URL_MAX_LENGTH: 500,
        ICON_MAX_LENGTH: 500,
        CHANNEL_ID_MAX_LENGTH: 50,
        TAG_MAX_LENGTH: 100,
        MAX_CHANNELS_PER_USER: 20,
        MAX_BATCH_SIZE: 50,
        SERVICE_ID_MAX_LENGTH: 50
    },
    RATE_LIMIT: {
        PUBLIC: { WINDOW: 60 * 1000, MAX: 15 },
        SEND: { WINDOW: 60 * 60 * 1000, MAX: 200 },
        API: { WINDOW: 60 * 1000, MAX: 60 },
        ADMIN: { WINDOW: 60 * 1000, MAX: 30 }
    },
    CACHE: {
        STATS_TTL: 30 * 1000,
        CHANNELS_TTL: 5 * 60 * 1000,
        SUBSCRIPTIONS_TTL: 60 * 1000
    },
    STORAGE: {
        MAX_HISTORY_ENTRIES: 500,
        MAX_LOG_ENTRIES: 1000
    },
    SECURITY: {
        TOKEN_EXPIRY: 24 * 60 * 60 * 1000,
        MAX_FAILED_ATTEMPTS: 5,
        LOCKOUT_DURATION: 15 * 60 * 1000,
        IP_WHITELIST_ENABLED: false,
        IP_WHITELIST: []
    },
    LOG: {
        LEVELS: { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, TRACE: 4 },
        CURRENT_LEVEL: 3,
        MAX_SIZE: 1000,
        PERSIST_TO_KV: true
    },
    HTTP: {
        OK: 200, CREATED: 201, NO_CONTENT: 204,
        BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403,
        NOT_FOUND: 404, CONFLICT: 409, TOO_MANY: 429,
        SERVER_ERROR: 500, SERVICE_UNAVAILABLE: 503
    },
    DEFAULT_CHANNELS: [
        { id: 'news', name: 'Новости', description: 'Новые новости и обновления', icon: '/icons/news.svg', public: true },
        { id: 'support', name: 'Поддержка', description: 'Ответы от службы поддержки', icon: '/icons/support.svg', public: false },
        { id: 'updates', name: 'Обновления', description: 'Обновления системы', icon: '/icons/updates.svg', public: true },
        { id: 'messages', name: 'Сообщения', description: 'Личные сообщения', icon: '/icons/messages.svg', public: false },
        { id: 'alerts', name: 'Оповещения', description: 'Системные оповещения', icon: '/icons/alerts.svg', public: true }
    ]
};

// ============================================
// ██████  ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ
// ============================================

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'admin@saite-oris.ru';
const SERVICE_API_KEYS = process.env.SERVICE_API_KEYS 
    ? JSON.parse(process.env.SERVICE_API_KEYS) 
    : {};

// ============================================
// ██████  VAPID ИНИЦИАЛИЗАЦИЯ
// ============================================

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        `mailto:${VAPID_EMAIL}`,
        VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY
    );
    console.log('[notifications] VAPID keys configured');
} else {
    console.warn('[notifications] WARNING: VAPID keys not configured');
}

// ============================================
// ██████  КЛЮЧИ KV
// ============================================

const K = {
    SUBSCRIPTION: (endpoint) => `push:sub:${endpoint}`,
    SUBSCRIPTIONS_INDEX: 'push:subscriptions:index',
    CHANNEL_INDEX: (channelId) => `push:channel:${channelId}:subs`,
    CHANNEL_META: (channelId) => `push:channel:${channelId}:meta`,
    CHANNELS_LIST: 'push:channels:list',
    SERVICE_KEY: (keyHash) => `push:svc:${keyHash}`,
    SERVICE_KEYS_INDEX: 'push:svc:index',
    RATE_LIMIT: (ip) => `rl:push:sub:${ip}`,
    SEND_RATE_LIMIT: (ip) => `rl:push:send:${ip}`,
    API_RATE_LIMIT: (keyHash) => `rl:push:api:${keyHash}`,
    ADMIN_RATE_LIMIT: (ip) => `rl:push:admin:${ip}`,
    SEND_COUNTER: 'push:send:counter',
    SEND_HISTORY: 'push:send:history',
    LOGS: 'push:logs',
    FAILED_ATTEMPTS: (ip) => `push:failed:${ip}`,
    LOCKOUT: (ip) => `push:lockout:${ip}`,
    STATS_CACHE: 'push:stats:cache'
};

// ============================================
// ██████  ЛОГГЕР
// ============================================

class Logger {
    constructor(namespace = 'notifications') {
        this.namespace = namespace;
        this.buffer = [];
        this.flushInterval = setInterval(() => this.flush(), 30000);
    }

    _timestamp() {
        return new Date().toISOString();
    }

    _generateId() {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    _sanitizeMeta(meta) {
        if (!meta || typeof meta !== 'object') return {};
        const sanitized = { ...meta };
        const sensitiveKeys = ['password', 'token', 'secret', 'key', 'auth', 'authorization', 'apiKey'];
        for (const key of sensitiveKeys) {
            if (sanitized[key]) sanitized[key] = '***REDACTED***';
        }
        return sanitized;
    }

    _format(level, message, meta = {}) {
        const levelNames = Object.keys(CONFIG.LOG.LEVELS);
        return {
            id: this._generateId(),
            timestamp: this._timestamp(),
            level: levelNames[level],
            namespace: this.namespace,
            message: typeof message === 'string' ? message : JSON.stringify(message),
            meta: this._sanitizeMeta(meta)
        };
    }

    _log(level, message, meta = {}) {
        if (level > CONFIG.LOG.CURRENT_LEVEL) return;
        const entry = this._format(level, message, meta);
        const prefix = `[${entry.timestamp}] [${entry.level}] [${this.namespace}]`;
        
        switch (level) {
            case CONFIG.LOG.LEVELS.ERROR: console.error(prefix, entry.message, entry.meta); break;
            case CONFIG.LOG.LEVELS.WARN: console.warn(prefix, entry.message, entry.meta); break;
            case CONFIG.LOG.LEVELS.INFO: console.log(prefix, entry.message, entry.meta); break;
            default: console.debug(prefix, entry.message, entry.meta);
        }
        
        this.buffer.push(entry);
        if (this.buffer.length >= 50) this.flush().catch(() => {});
    }

    async flush() {
        if (this.buffer.length === 0 || !CONFIG.LOG.PERSIST_TO_KV) {
            this.buffer = [];
            return;
        }
        try {
            const entries = [...this.buffer];
            this.buffer = [];
            const serialized = entries.map(e => JSON.stringify(e));
            await kv.lpush(K.LOGS, ...serialized);
            await kv.ltrim(K.LOGS, 0, CONFIG.LOG.MAX_SIZE - 1);
        } catch (err) {
            console.error('[Logger] Failed to persist:', err.message);
            this.buffer = [];
        }
    }

    error(msg, meta) { this._log(CONFIG.LOG.LEVELS.ERROR, msg, meta); }
    warn(msg, meta) { this._log(CONFIG.LOG.LEVELS.WARN, msg, meta); }
    info(msg, meta) { this._log(CONFIG.LOG.LEVELS.INFO, msg, meta); }
    debug(msg, meta) { this._log(CONFIG.LOG.LEVELS.DEBUG, msg, meta); }
    trace(msg, meta) { this._log(CONFIG.LOG.LEVELS.TRACE, msg, meta); }

    logSubscription(event, data) {
        this.info(`Subscription ${event}`, {
            event,
            endpoint: data.endpoint?.substring(0, 80) + '...',
            channel: data.channel,
            ip: data.ip,
            userAgent: data.userAgent?.substring(0, 100)
        });
    }

    logSend(channel, results) {
        this.info(`Notification sent to "${channel}"`, {
            channel,
            total: results.total,
            success: results.success,
            failed: results.failed,
            duration: results.duration
        });
    }

    logSecurity(event, data) {
        this.warn(`Security: ${event}`, {
            event, ip: data.ip, reason: data.reason, endpoint: data.endpoint
        });
    }

    destroy() {
        if (this.flushInterval) {
            clearInterval(this.flushInterval);
            this.flushInterval = null;
        }
        this.flush().catch(() => {});
    }
}

const logger = new Logger('notifications');

// ============================================
// ██████  БЕЗОПАСНОСТЬ
// ============================================

class Security {
    static generateToken(length = 32) {
        return crypto.randomBytes(length).toString('hex');
    }

    static generateServiceKey() {
        return `svc_${crypto.randomBytes(24).toString('base64url')}`;
    }

    static hashToken(token) {
        return crypto.createHash('sha256').update(token).digest('hex');
    }

    static safeCompare(a, b) {
        if (!a || !b) return false;
        if (typeof a !== 'string' || typeof b !== 'string') return false;
        if (a.length !== b.length) return false;
        try {
            return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
        } catch {
            return false;
        }
    }

    static async checkFailedAttempts(ip) {
        try {
            const lockout = await kv.get(K.LOCKOUT(ip));
            if (lockout) return { locked: true, retryAfter: Math.ceil((lockout.unlockAt - Date.now()) / 1000) };
            
            const attempts = await kv.get(K.FAILED_ATTEMPTS(ip));
            const count = attempts?.count || 0;
            
            if (count >= CONFIG.SECURITY.MAX_FAILED_ATTEMPTS) {
                const unlockAt = Date.now() + CONFIG.SECURITY.LOCKOUT_DURATION;
                await kv.set(K.LOCKOUT(ip), { unlockAt }, { ex: Math.ceil(CONFIG.SECURITY.LOCKOUT_DURATION / 1000) });
                await kv.del(K.FAILED_ATTEMPTS(ip));
                return { locked: true, retryAfter: Math.ceil(CONFIG.SECURITY.LOCKOUT_DURATION / 1000) };
            }
            
            return { locked: false, attempts: count };
        } catch (err) {
            logger.error('Failed attempts check error', { error: err.message, ip });
            return { locked: false, attempts: 0 };
        }
    }

    static async recordFailedAttempt(ip) {
        try {
            const key = K.FAILED_ATTEMPTS(ip);
            const current = await kv.get(key);
            const count = (current?.count || 0) + 1;
            await kv.set(key, { count, lastAttempt: Date.now() }, { ex: 3600 });
            return count;
        } catch (err) {
            logger.error('Record failed attempt error', { error: err.message, ip });
            return 0;
        }
    }

    static async clearFailedAttempts(ip) {
        try {
            await kv.del(K.FAILED_ATTEMPTS(ip));
            await kv.del(K.LOCKOUT(ip));
        } catch (err) {
            logger.error('Clear failed attempts error', { error: err.message, ip });
        }
    }

    static isIpWhitelisted(ip) {
        if (!CONFIG.SECURITY.IP_WHITELIST_ENABLED) return true;
        return CONFIG.SECURITY.IP_WHITELIST.includes(ip);
    }

    static sanitizeInput(str) {
        if (typeof str !== 'string') return '';
        return str.replace(/[<>\"'&]/g, (c) => ({
            '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;'
        }[c]));
    }

    static validateServiceKey(key) {
        if (!key || typeof key !== 'string') return false;
        return /^svc_[A-Za-z0-9_-]{32}$/.test(key);
    }
}

// ============================================
// ██████  RATE LIMITING (ИСПРАВЛЕНО)
// ============================================

async function checkRateLimit(key, windowMs, max) {
    try {
        const current = await kv.get(key);
        const now = Date.now();
        
        // Если ключа нет или окно истекло — создаём новый
        if (!current || now > current.resetAt) {
            const data = { count: 1, resetAt: now + windowMs };
            await kv.set(key, data, { ex: Math.ceil(windowMs / 1000) });
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
        
        // Увеличиваем счётчик (через set, не hincrby!)
        current.count += 1;
        const ttl = Math.ceil((current.resetAt - now) / 1000);
        await kv.set(key, current, { ex: Math.max(ttl, 1) });
        return { allowed: true, remaining: max - current.count };
    } catch (err) {
        logger.error('Rate limit error', { error: err.message, key });
        return { allowed: true, remaining: max }; // fail-open
    }
}

// ============================================
// ██████  ВАЛИДАТОР
// ============================================

class Validator {
    static isValidUrl(string) {
        if (!string || typeof string !== 'string') return false;
        if (string.startsWith('/')) return true;
        try {
            const url = new URL(string);
            return url.protocol === 'http:' || url.protocol === 'https:';
        } catch {
            return false;
        }
    }

    static isValidChannelId(id) {
        if (!id || typeof id !== 'string') return false;
        if (id.length > CONFIG.VALIDATION.CHANNEL_ID_MAX_LENGTH) return false;
        return /^[a-z0-9_-]+$/i.test(id);
    }

    static validateSubscription(subscription) {
        if (!subscription || typeof subscription !== 'object') {
            return { valid: false, error: 'Subscription object is required' };
        }
        if (!subscription.endpoint || typeof subscription.endpoint !== 'string') {
            return { valid: false, error: 'Invalid subscription: endpoint required' };
        }
        if (!subscription.keys || typeof subscription.keys !== 'object') {
            return { valid: false, error: 'Invalid subscription: keys required' };
        }
        if (!subscription.keys.p256dh || !subscription.keys.auth) {
            return { valid: false, error: 'Invalid subscription: p256dh and auth required' };
        }
        return { valid: true };
    }

    static validateNotification(notification) {
        if (!notification || typeof notification !== 'object') {
            return { valid: false, error: 'Notification data is required' };
        }
        if (!notification.title || typeof notification.title !== 'string') {
            return { valid: false, error: 'Title is required' };
        }
        if (notification.title.length > CONFIG.VALIDATION.TITLE_MAX_LENGTH) {
            return { valid: false, error: `Title must be ${CONFIG.VALIDATION.TITLE_MAX_LENGTH} chars or less` };
        }
        if (!notification.body || typeof notification.body !== 'string') {
            return { valid: false, error: 'Body is required' };
        }
        if (notification.body.length > CONFIG.VALIDATION.BODY_MAX_LENGTH) {
            return { valid: false, error: `Body must be ${CONFIG.VALIDATION.BODY_MAX_LENGTH} chars or less` };
        }
        if (notification.icon && !this.isValidUrl(notification.icon)) {
            return { valid: false, error: 'Invalid icon URL' };
        }
        if (notification.url && !this.isValidUrl(notification.url)) {
            return { valid: false, error: 'Invalid URL format' };
        }
        return { valid: true };
    }

    static validateChannel(channel) {
        if (!channel || typeof channel !== 'object') {
            return { valid: false, error: 'Channel data is required' };
        }
        if (!this.isValidChannelId(channel.id)) {
            return { valid: false, error: 'Invalid channel ID (use a-z, 0-9, -, _)' };
        }
        if (!channel.name || typeof channel.name !== 'string') {
            return { valid: false, error: 'Channel name is required' };
        }
        return { valid: true };
    }
}

// ============================================
// ██████  МЕНЕДЖЕР КАНАЛОВ
// ============================================

class ChannelManager {
    static async init() {
        try {
            const existing = await kv.smembers(K.CHANNELS_LIST);
            if (!existing || existing.length === 0) {
                for (const ch of CONFIG.DEFAULT_CHANNELS) {
                    await this.create(ch, false);
                }
                logger.info('Default channels initialized', { count: CONFIG.DEFAULT_CHANNELS.length });
            }
        } catch (err) {
            logger.error('Channel init error', { error: err.message });
        }
    }

    static async create(channelData, log = true) {
        const validation = Validator.validateChannel(channelData);
        if (!validation.valid) throw new Error(validation.error);

        const channel = {
            id: channelData.id,
            name: channelData.name,
            description: channelData.description || '',
            icon: channelData.icon || '/icons/default.svg',
            public: channelData.public !== false,
            createdAt: new Date().toISOString(),
            createdBy: channelData.createdBy || 'system'
        };

        await kv.set(K.CHANNEL_META(channel.id), channel);
        await kv.sadd(K.CHANNELS_LIST, channel.id);

        if (log) logger.info('Channel created', { channelId: channel.id, name: channel.name });
        return channel;
    }

    static async get(channelId) {
        if (!Validator.isValidChannelId(channelId)) return null;
        return await kv.get(K.CHANNEL_META(channelId));
    }

    static async list() {
        const ids = await kv.smembers(K.CHANNELS_LIST);
        if (!ids || ids.length === 0) return [];
        
        const channels = [];
        for (const id of ids) {
            const ch = await kv.get(K.CHANNEL_META(id));
            if (ch) channels.push(ch);
        }
        return channels.sort((a, b) => a.name.localeCompare(b.name));
    }

    static async delete(channelId) {
        if (!Validator.isValidChannelId(channelId)) throw new Error('Invalid channel ID');
        
        await kv.del(K.CHANNEL_META(channelId));
        await kv.del(K.CHANNEL_INDEX(channelId));
        await kv.srem(K.CHANNELS_LIST, channelId);
        
        logger.info('Channel deleted', { channelId });
        return true;
    }

    static async subscribe(channelId, endpoint) {
        const channel = await this.get(channelId);
        if (!channel) throw new Error('Channel not found');
        if (!channel.public) {
            // Приватные каналы требуют дополнительной проверки
            // (реализуется на уровне API)
        }
        await kv.sadd(K.CHANNEL_INDEX(channelId), endpoint);
        return true;
    }

    static async unsubscribe(channelId, endpoint) {
        await kv.srem(K.CHANNEL_INDEX(channelId), endpoint);
        return true;
    }

    static async getSubscribers(channelId) {
        const subs = await kv.smembers(K.CHANNEL_INDEX(channelId));
        return subs || [];
    }

    static async getStats(channelId) {
        const subs = await this.getSubscribers(channelId);
        return {
            channelId,
            subscribers: subs.length,
            channel: await this.get(channelId)
        };
    }
}

// ============================================
// ██████  МЕНЕДЖЕР СЕРВИСНЫХ КЛЮЧЕЙ
// ============================================

class ServiceKeyManager {
    static async create(serviceId, description = '') {
        if (!serviceId || typeof serviceId !== 'string') {
            throw new Error('Service ID is required');
        }
        if (serviceId.length > CONFIG.VALIDATION.SERVICE_ID_MAX_LENGTH) {
            throw new Error(`Service ID too long (max ${CONFIG.VALIDATION.SERVICE_ID_MAX_LENGTH})`);
        }
        if (!/^[a-z0-9_-]+$/i.test(serviceId)) {
            throw new Error('Service ID must be alphanumeric with - or _');
        }

        const plainKey = Security.generateServiceKey();
        const keyHash = Security.hashToken(plainKey);
        
        const serviceData = {
            serviceId,
            description,
            keyHash,
            createdAt: new Date().toISOString(),
            lastUsed: null,
            requestCount: 0,
            active: true
        };

        await kv.set(K.SERVICE_KEY(keyHash), serviceData);
        await kv.sadd(K.SERVICE_KEYS_INDEX, keyHash);
        
        logger.info('Service key created', { serviceId });
        
        // Возвращаем plain key только один раз!
        return {
            serviceId,
            apiKey: plainKey,
            message: 'Save this key — it will not be shown again!'
        };
    }

    static async validate(apiKey) {
        if (!Security.validateServiceKey(apiKey)) {
            return { valid: false, error: 'Invalid API key format' };
        }
        
        const keyHash = Security.hashToken(apiKey);
        const serviceData = await kv.get(K.SERVICE_KEY(keyHash));
        
        if (!serviceData) {
            return { valid: false, error: 'API key not found' };
        }
        
        if (!serviceData.active) {
            return { valid: false, error: 'API key is disabled' };
        }
        
        // Обновляем статистику
        serviceData.lastUsed = new Date().toISOString();
        serviceData.requestCount = (serviceData.requestCount || 0) + 1;
        await kv.set(K.SERVICE_KEY(keyHash), serviceData);
        
        return { 
            valid: true, 
            serviceId: serviceData.serviceId,
            keyHash
        };
    }

    static async list() {
        const hashes = await kv.smembers(K.SERVICE_KEYS_INDEX);
        if (!hashes || hashes.length === 0) return [];
        
        const services = [];
        for (const hash of hashes) {
            const data = await kv.get(K.SERVICE_KEY(hash));
            if (data) {
                services.push({
                    serviceId: data.serviceId,
                    description: data.description,
                    createdAt: data.createdAt,
                    lastUsed: data.lastUsed,
                    requestCount: data.requestCount,
                    active: data.active,
                    keyHash: hash.substring(0, 12) + '...'
                });
            }
        }
        return services;
    }

    static async revoke(keyHash) {
        const data = await kv.get(K.SERVICE_KEY(keyHash));
        if (!data) throw new Error('Service key not found');
        
        data.active = false;
        data.revokedAt = new Date().toISOString();
        await kv.set(K.SERVICE_KEY(keyHash), data);
        
        logger.info('Service key revoked', { serviceId: data.serviceId });
        return true;
    }

    static async activate(keyHash) {
        const data = await kv.get(K.SERVICE_KEY(keyHash));
        if (!data) throw new Error('Service key not found');
        
        data.active = true;
        delete data.revokedAt;
        await kv.set(K.SERVICE_KEY(keyHash), data);
        
        logger.info('Service key activated', { serviceId: data.serviceId });
        return true;
    }

    static async delete(keyHash) {
        await kv.del(K.SERVICE_KEY(keyHash));
        await kv.srem(K.SERVICE_KEYS_INDEX, keyHash);
        logger.info('Service key deleted', { keyHash: keyHash.substring(0, 12) });
        return true;
    }
}

// ============================================
// ██████  ОТПРАВИТЕЛЬ PUSH
// ============================================

class PushSender {
    static async sendToChannel(channelId, notification, options = {}) {
        if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
            throw new Error('VAPID keys not configured');
        }

        const channel = await ChannelManager.get(channelId);
        if (!channel) throw new Error('Channel not found');

        const validation = Validator.validateNotification(notification);
        if (!validation.valid) throw new Error(validation.error);

        const endpoints = await ChannelManager.getSubscribers(channelId);
        
        const results = {
            channelId,
            total: endpoints.length,
            success: 0,
            failed: 0,
            errors: [],
            startTime: Date.now()
        };

        if (endpoints.length === 0) {
            results.duration = 0;
            logger.info('No subscribers for channel', { channelId });
            return results;
        }

        const payload = JSON.stringify({
            title: Security.sanitizeInput(notification.title),
            body: Security.sanitizeInput(notification.body),
            icon: notification.icon || channel.icon || '/favicon.ico',
            badge: notification.badge || '/badge.png',
            tag: notification.tag || `ch-${channelId}-${Date.now()}`,
            data: {
                url: notification.url || '/',
                channelId,
                timestamp: Date.now(),
                ...notification.data
            },
            requireInteraction: notification.requireInteraction || false,
            actions: notification.actions || [],
            renotify: notification.renotify || false,
            silent: notification.silent || false
        });

        const batchSize = options.batchSize || 10;
        
        for (let i = 0; i < endpoints.length; i += batchSize) {
            const batch = endpoints.slice(i, i + batchSize);
            const promises = batch.map(endpoint => this._sendOne(endpoint, payload, results));
            await Promise.allSettled(promises);
        }

        results.duration = Date.now() - results.startTime;
        
        // Обновляем счётчик и историю
        await kv.incr(K.SEND_COUNTER);
        await this._saveToHistory(channelId, notification, results);
        
        logger.logSend(channelId, results);
        
        return results;
    }

    static async _sendOne(endpoint, payload, results) {
        try {
            const subscriptionData = await kv.get(K.SUBSCRIPTION(endpoint));
            if (!subscriptionData) {
                results.failed++;
                return;
            }

            const subscription = {
                endpoint: subscriptionData.endpoint,
                keys: subscriptionData.keys
            };

            await webpush.sendNotification(subscription, payload);
            results.success++;
        } catch (err) {
            results.failed++;
            results.errors.push({
                endpoint: endpoint.substring(0, 80),
                error: err.message,
                statusCode: err.statusCode
            });

            // Удаляем недействительные подписки
            if (err.statusCode === 410 || err.statusCode === 404) {
                logger.debug('Removing invalid subscription', { endpoint: endpoint.substring(0, 80) });
                await kv.del(K.SUBSCRIPTION(endpoint)).catch(() => {});
                await kv.srem(K.SUBSCRIPTIONS_INDEX, endpoint).catch(() => {});
                
                // Удаляем из всех каналов
                const channels = await kv.smembers(K.CHANNELS_LIST);
                if (channels) {
                    for (const chId of channels) {
                        await kv.srem(K.CHANNEL_INDEX(chId), endpoint).catch(() => {});
                    }
                }
            }
        }
    }

    static async _saveToHistory(channelId, notification, results) {
        try {
            const entry = {
                id: Security.generateToken(8),
                timestamp: new Date().toISOString(),
                channelId,
                title: notification.title,
                body: notification.body,
                url: notification.url,
                total: results.total,
                success: results.success,
                failed: results.failed,
                duration: results.duration
            };
            
            await kv.lpush(K.SEND_HISTORY, JSON.stringify(entry));
            await kv.ltrim(K.SEND_HISTORY, 0, CONFIG.STORAGE.MAX_HISTORY_ENTRIES - 1);
        } catch (err) {
            logger.error('Failed to save history', { error: err.message });
        }
    }

    static async sendToUser(userId, notification) {
        // Отправка конкретному пользователю по userId
        // Ищем все подписки с этим userId
        const validation = Validator.validateNotification(notification);
        if (!validation.valid) throw new Error(validation.error);

        // userId хранится в meta подписки
        const allEndpoints = await kv.smembers(K.SUBSCRIPTIONS_INDEX);
        if (!allEndpoints || allEndpoints.length === 0) {
            return { total: 0, success: 0, failed: 0 };
        }

        const userEndpoints = [];
        for (const endpoint of allEndpoints) {
            const data = await kv.get(K.SUBSCRIPTION(endpoint));
            if (data && data.userId === userId) {
                userEndpoints.push(endpoint);
            }
        }

        const results = {
            userId,
            total: userEndpoints.length,
            success: 0,
            failed: 0,
            errors: [],
            startTime: Date.now()
        };

        const payload = JSON.stringify({
            title: Security.sanitizeInput(notification.title),
            body: Security.sanitizeInput(notification.body),
            icon: notification.icon || '/favicon.ico',
            data: {
                url: notification.url || '/',
                userId,
                timestamp: Date.now(),
                ...notification.data
            },
            tag: notification.tag || `user-${userId}-${Date.now()}`,
            requireInteraction: notification.requireInteraction || false
        });

        for (const endpoint of userEndpoints) {
            await this._sendOne(endpoint, payload, results);
        }

        results.duration = Date.now() - results.startTime;
        logger.info('Notification sent to user', { userId, ...results });
        return results;
    }
}

// ============================================
// ██████  MIDDLEWARE
// ============================================

function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() 
        || req.ip 
        || req.connection?.remoteAddress 
        || 'unknown';
}

async function verifyAdminToken(req, res, next) {
    const ip = getClientIp(req);
    
    // Проверка lockout
    const lockoutCheck = await Security.checkFailedAttempts(ip);
    if (lockoutCheck.locked) {
        logger.logSecurity('Locked IP attempted access', { ip });
        return res.status(CONFIG.HTTP.TOO_MANY)
            .set('Retry-After', lockoutCheck.retryAfter)
            .json({ error: 'Too many failed attempts', retryAfter: lockoutCheck.retryAfter });
    }

    // IP whitelist
    if (!Security.isIpWhitelisted(ip)) {
        logger.logSecurity('IP not whitelisted', { ip });
        return res.status(CONFIG.HTTP.FORBIDDEN).json({ error: 'IP not allowed' });
    }

    // Rate limit
    const rateLimit = await checkRateLimit(
        K.ADMIN_RATE_LIMIT(ip),
        CONFIG.RATE_LIMIT.ADMIN.WINDOW,
        CONFIG.RATE_LIMIT.ADMIN.MAX
    );
    if (!rateLimit.allowed) {
        return res.status(CONFIG.HTTP.TOO_MANY)
            .set('Retry-After', rateLimit.retryAfter)
            .json({ error: 'Too many requests' });
    }

    // Token check
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        await Security.recordFailedAttempt(ip);
        logger.logSecurity('Missing admin token', { ip });
        return res.status(CONFIG.HTTP.UNAUTHORIZED).json({ error: 'Missing token' });
    }

    const token = authHeader.split(' ')[1];
    if (!ADMIN_TOKEN || !token) {
        await Security.recordFailedAttempt(ip);
        return res.status(CONFIG.HTTP.FORBIDDEN).json({ error: 'Invalid token' });
    }

    const isValid = token.length === ADMIN_TOKEN.length &&
        Security.safeCompare(token, ADMIN_TOKEN);

    if (!isValid) {
        const attempts = await Security.recordFailedAttempt(ip);
        logger.logSecurity('Invalid admin token', { ip, attempts });
        return res.status(CONFIG.HTTP.FORBIDDEN).json({ 
            error: 'Invalid token',
            attemptsRemaining: CONFIG.SECURITY.MAX_FAILED_ATTEMPTS - attempts
        });
    }

    await Security.clearFailedAttempts(ip);
    req.adminIp = ip;
    next();
}

async function verifyServiceKey(req, res, next) {
    const ip = getClientIp(req);
    
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    
    if (!apiKey) {
        logger.logSecurity('Missing API key', { ip });
        return res.status(CONFIG.HTTP.UNAUTHORIZED).json({ error: 'API key required' });
    }

    const validation = await ServiceKeyManager.validate(apiKey);
    if (!validation.valid) {
        logger.logSecurity('Invalid API key', { ip, error: validation.error });
        return res.status(CONFIG.HTTP.UNAUTHORIZED).json({ error: validation.error });
    }

    // Rate limit по ключу
    const rateLimit = await checkRateLimit(
        K.API_RATE_LIMIT(validation.keyHash),
        CONFIG.RATE_LIMIT.API.WINDOW,
        CONFIG.RATE_LIMIT.API.MAX
    );
    if (!rateLimit.allowed) {
        return res.status(CONFIG.HTTP.TOO_MANY)
            .set('Retry-After', rateLimit.retryAfter)
            .json({ error: 'API rate limit exceeded' });
    }

    req.serviceId = validation.serviceId;
    req.serviceKeyHash = validation.keyHash;
    req.serviceIp = ip;
    next();
}

async function publicRateLimiter(req, res, next) {
    const ip = getClientIp(req);
    const rateLimit = await checkRateLimit(
        K.RATE_LIMIT(ip),
        CONFIG.RATE_LIMIT.PUBLIC.WINDOW,
        CONFIG.RATE_LIMIT.PUBLIC.MAX
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
// ██████  ПУБЛИЧНЫЕ ENDPOINTS
// ============================================

/**
 * GET /vapid-public-key — получить VAPID public key
 */
router.get('/vapid-public-key', (req, res) => {
    if (!VAPID_PUBLIC_KEY) {
        return res.status(CONFIG.HTTP.SERVER_ERROR).json({
            error: 'VAPID not configured'
        });
    }
    res.json({ publicKey: VAPID_PUBLIC_KEY });
});

/**
 * GET /channels — список публичных каналов
 */
router.get('/channels', async (req, res) => {
    try {
        const channels = await ChannelManager.list();
        const publicChannels = channels.filter(ch => ch.public);
        res.json({ channels: publicChannels, total: publicChannels.length });
    } catch (err) {
        logger.error('GET /channels error', { error: err.message });
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: 'Failed to load channels' });
    }
});

/**
 * POST /subscribe — подписка на уведомления
 * Body: { subscription, channels: ['news', 'support'], userId? }
 */
router.post('/subscribe', publicRateLimiter, async (req, res) => {
    try {
        const { subscription, channels, userId } = req.body;
        
        const validation = Validator.validateSubscription(subscription);
        if (!validation.valid) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: validation.error });
        }

        // Валидация каналов
        const channelsToSubscribe = Array.isArray(channels) && channels.length > 0 
            ? channels 
            : ['news'];
        
        for (const chId of channelsToSubscribe) {
            if (!Validator.isValidChannelId(chId)) {
                return res.status(CONFIG.HTTP.BAD_REQUEST).json({ 
                    error: `Invalid channel ID: ${chId}` 
                });
            }
            const channel = await ChannelManager.get(chId);
            if (!channel) {
                return res.status(CONFIG.HTTP.NOT_FOUND).json({ 
                    error: `Channel not found: ${chId}` 
                });
            }
            if (!channel.public) {
                return res.status(CONFIG.HTTP.FORBIDDEN).json({ 
                    error: `Channel "${chId}" is private` 
                });
            }
        }

        if (channelsToSubscribe.length > CONFIG.VALIDATION.MAX_CHANNELS_PER_USER) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ 
                error: `Too many channels (max ${CONFIG.VALIDATION.MAX_CHANNELS_PER_USER})` 
            });
        }

        // Проверяем существующую подписку
        const existing = await kv.get(K.SUBSCRIPTION(subscription.endpoint));
        
        if (existing) {
            // Подписка уже есть — обновляем каналы!
            const currentChannels = existing.channels || [];
            const newChannels = [...new Set([...currentChannels, ...channelsToSubscribe])];
            
            existing.channels = newChannels;
            if (userId) existing.userId = Security.sanitizeInput(userId);
            
            await kv.set(K.SUBSCRIPTION(subscription.endpoint), existing);
            
            // Добавляем в новые каналы
            for (const chId of channelsToSubscribe) {
                await kv.sadd(K.CHANNEL_INDEX(chId), subscription.endpoint);
            }
            
            logger.logSubscription('updated', {
                endpoint: subscription.endpoint,
                channels: newChannels,
                ip: req.clientIp
            });

            return res.json({ 
                success: true,
                message: 'Subscription updated',
                channels: newChannels
            });
        }

        // Новая подписка
        const subscriptionData = {
            endpoint: subscription.endpoint,
            keys: subscription.keys,
            userId: userId ? Security.sanitizeInput(userId) : null,
            channels: channelsToSubscribe,
            createdAt: new Date().toISOString(),
            userAgent: req.headers['user-agent'] || 'Unknown',
            ip: req.clientIp
        };

        await kv.set(K.SUBSCRIPTION(subscription.endpoint), subscriptionData);
        await kv.sadd(K.SUBSCRIPTIONS_INDEX, subscription.endpoint);

        // Добавляем в каналы
        for (const chId of channelsToSubscribe) {
            await kv.sadd(K.CHANNEL_INDEX(chId), subscription.endpoint);
        }

        logger.logSubscription('created', {
            endpoint: subscription.endpoint,
            channels: channelsToSubscribe,
            ip: req.clientIp
        });

        res.status(CONFIG.HTTP.CREATED).json({ 
            success: true,
            message: 'Subscription saved',
            channels: channelsToSubscribe
        });
    } catch (err) {
        logger.error('POST /subscribe error', { error: err.message });
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: 'Error saving subscription' });
    }
});

/**
 * POST /unsubscribe — отписка
 * Body: { endpoint, channels?: [] }
 */
router.post('/unsubscribe', publicRateLimiter, async (req, res) => {
    try {
        const { endpoint, channels } = req.body;
        
        if (!endpoint || typeof endpoint !== 'string') {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: 'Endpoint is required' });
        }

        const existing = await kv.get(K.SUBSCRIPTION(endpoint));
        if (!existing) {
            return res.status(CONFIG.HTTP.NOT_FOUND).json({ error: 'Subscription not found' });
        }

        // Если указаны каналы — отписываем только от них
        if (Array.isArray(channels) && channels.length > 0) {
            for (const chId of channels) {
                await ChannelManager.unsubscribe(chId, endpoint);
            }
            existing.channels = (existing.channels || []).filter(c => !channels.includes(c));
            
            // Если каналов не осталось — удаляем подписку полностью
            if (existing.channels.length === 0) {
                await kv.del(K.SUBSCRIPTION(endpoint));
                await kv.srem(K.SUBSCRIPTIONS_INDEX, endpoint);
                logger.logSubscription('fully_unsubscribed', { endpoint, ip: req.clientIp });
            } else {
                await kv.set(K.SUBSCRIPTION(endpoint), existing);
                logger.logSubscription('partially_unsubscribed', { endpoint, channels, ip: req.clientIp });
            }
        } else {
            // Полная отписка
            await kv.del(K.SUBSCRIPTION(endpoint));
            await kv.srem(K.SUBSCRIPTIONS_INDEX, endpoint);
            
            // Удаляем из всех каналов
            const allChannels = await kv.smembers(K.CHANNELS_LIST);
            if (allChannels) {
                for (const chId of allChannels) {
                    await kv.srem(K.CHANNEL_INDEX(chId), endpoint).catch(() => {});
                }
            }
            logger.logSubscription('unsubscribed', { endpoint, ip: req.clientIp });
        }

        res.json({ success: true, message: 'Unsubscribed' });
    } catch (err) {
        logger.error('POST /unsubscribe error', { error: err.message });
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: 'Error unsubscribing' });
    }
});

/**
 * POST /subscribe-private — подписка на приватный канал
 * Требует авторизации (например, токен пользователя)
 * Body: { subscription, channelId, userToken }
 */
router.post('/subscribe-private', publicRateLimiter, async (req, res) => {
    try {
        const { subscription, channelId, userToken } = req.body;
        
        const validation = Validator.validateSubscription(subscription);
        if (!validation.valid) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: validation.error });
        }

        if (!Validator.isValidChannelId(channelId)) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: 'Invalid channel ID' });
        }

        const channel = await ChannelManager.get(channelId);
        if (!channel) {
            return res.status(CONFIG.HTTP.NOT_FOUND).json({ error: 'Channel not found' });
        }

        if (channel.public) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ 
                error: 'Channel is public, use /subscribe' 
            });
        }

        // Здесь должна быть проверка userToken
        // Например, валидация токена сессии пользователя
        // В реальном приложении интегрируйте со своей системой авторизации
        if (!userToken) {
            return res.status(CONFIG.HTTP.UNAUTHORIZED).json({ 
                error: 'User token required for private channel' 
            });
        }

        // TODO: Валидация userToken через вашу систему авторизации
        // const user = await authSystem.validateToken(userToken);
        // if (!user) return res.status(401).json({ error: 'Invalid user token' });

        // Сохраняем подписку
        const existing = await kv.get(K.SUBSCRIPTION(subscription.endpoint));
        if (!existing) {
            await kv.set(K.SUBSCRIPTION(subscription.endpoint), {
                endpoint: subscription.endpoint,
                keys: subscription.keys,
                channels: [channelId],
                createdAt: new Date().toISOString(),
                userAgent: req.headers['user-agent'] || 'Unknown',
                ip: req.clientIp
            });
            await kv.sadd(K.SUBSCRIPTIONS_INDEX, subscription.endpoint);
        } else {
            if (!existing.channels.includes(channelId)) {
                existing.channels.push(channelId);
                await kv.set(K.SUBSCRIPTION(subscription.endpoint), existing);
            }
        }

        await ChannelManager.subscribe(channelId, subscription.endpoint);
        logger.logSubscription('private_subscribed', { endpoint: subscription.endpoint, channelId, ip: req.clientIp });

        res.status(CONFIG.HTTP.CREATED).json({ 
            success: true, 
            message: `Subscribed to private channel "${channelId}"` 
        });
    } catch (err) {
        logger.error('POST /subscribe-private error', { error: err.message });
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: 'Error subscribing' });
    }
});

/**
 * GET /stats — публичная статистика
 */
router.get('/stats', async (req, res) => {
    try {
        const subscriptions = await kv.smembers(K.SUBSCRIPTIONS_INDEX);
        const sendCounter = await kv.get(K.SEND_COUNTER);
        const channels = await ChannelManager.list();
        
        const channelStats = {};
        for (const ch of channels) {
            const subs = await ChannelManager.getSubscribers(ch.id);
            channelStats[ch.id] = {
                name: ch.name,
                subscribers: subs.length,
                public: ch.public
            };
        }

        const stats = {
            totalSubscriptions: subscriptions?.length || 0,
            totalSent: sendCounter ? parseInt(sendCounter, 10) : 0,
            channels: channelStats,
            timestamp: new Date().toISOString()
        };

        res.json(stats);
    } catch (err) {
        logger.error('GET /stats error', { error: err.message });
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: 'Error getting stats' });
    }
});

// ============================================
// ██████  API ДЛЯ СЕРВИСОВ
// ============================================

/**
 * POST /api/send — отправка уведомления в канал
 * Требует API ключ сервиса в header X-API-Key
 * Body: { channel, notification: { title, body, icon?, url?, data? } }
 */
router.post('/api/send', verifyServiceKey, async (req, res) => {
    try {
        const { channel, notification } = req.body;
        
        if (!channel || !Validator.isValidChannelId(channel)) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: 'Valid channel ID required' });
        }

        const channelData = await ChannelManager.get(channel);
        if (!channelData) {
            return res.status(CONFIG.HTTP.NOT_FOUND).json({ error: 'Channel not found' });
        }

        const results = await PushSender.sendToChannel(channel, notification, {
            serviceId: req.serviceId
        });

        res.json({ 
            success: true,
            serviceId: req.serviceId,
            channel,
            results: {
                total: results.total,
                success: results.success,
                failed: results.failed,
                duration: results.duration
            }
        });
    } catch (err) {
        logger.error('POST /api/send error', { 
            error: err.message, 
            serviceId: req.serviceId 
        });
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: err.message });
    }
});

/**
 * POST /api/send-batch — пакетная отправка в несколько каналов
 * Body: { channels: ['news', 'updates'], notification: {...} }
 */
router.post('/api/send-batch', verifyServiceKey, async (req, res) => {
    try {
        const { channels, notification } = req.body;
        
        if (!Array.isArray(channels) || channels.length === 0) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: 'Channels array required' });
        }

        if (channels.length > CONFIG.VALIDATION.MAX_BATCH_SIZE) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ 
                error: `Too many channels (max ${CONFIG.VALIDATION.MAX_BATCH_SIZE})` 
            });
        }

        const results = {};
        for (const chId of channels) {
            if (!Validator.isValidChannelId(chId)) {
                results[chId] = { error: 'Invalid channel ID' };
                continue;
            }
            try {
                const res = await PushSender.sendToChannel(chId, notification, {
                    serviceId: req.serviceId
                });
                results[chId] = {
                    total: res.total,
                    success: res.success,
                    failed: res.failed,
                    duration: res.duration
                };
            } catch (err) {
                results[chId] = { error: err.message };
            }
        }

        res.json({ 
            success: true,
            serviceId: req.serviceId,
            results
        });
    } catch (err) {
        logger.error('POST /api/send-batch error', { 
            error: err.message, 
            serviceId: req.serviceId 
        });
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: err.message });
    }
});

/**
 * POST /api/send-to-user — отправка конкретному пользователю
 * Body: { userId, notification: {...} }
 */
router.post('/api/send-to-user', verifyServiceKey, async (req, res) => {
    try {
        const { userId, notification } = req.body;
        
        if (!userId || typeof userId !== 'string') {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: 'userId required' });
        }

        const results = await PushSender.sendToUser(userId, notification);

        res.json({ 
            success: true,
            serviceId: req.serviceId,
            userId,
            results: {
                total: results.total,
                success: results.success,
                failed: results.failed,
                duration: results.duration
            }
        });
    } catch (err) {
        logger.error('POST /api/send-to-user error', { 
            error: err.message, 
            serviceId: req.serviceId 
        });
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: err.message });
    }
});

// ============================================
// ██████  АДМИНСКИЕ ENDPOINTS
// ============================================

/**
 * POST /admin/send — отправка уведомления (админ)
 */
router.post('/admin/send', verifyAdminToken, async (req, res) => {
    try {
        const { channel, notification } = req.body;
        
        if (!channel || !Validator.isValidChannelId(channel)) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: 'Valid channel ID required' });
        }

        const results = await PushSender.sendToChannel(channel, notification);

        res.json({ 
            success: true,
            results: {
                total: results.total,
                success: results.success,
                failed: results.failed,
                duration: results.duration
            }
        });
    } catch (err) {
        logger.error('POST /admin/send error', { error: err.message });
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: err.message });
    }
});

/**
 * GET /admin/subscriptions — список всех подписок
 */
router.get('/admin/subscriptions', verifyAdminToken, async (req, res) => {
    try {
        const endpoints = await kv.smembers(K.SUBSCRIPTIONS_INDEX);
        if (!endpoints || endpoints.length === 0) {
            return res.json({ subscriptions: [], total: 0 });
        }

        const subscriptions = [];
        for (const endpoint of endpoints) {
            try {
                const data = await kv.get(K.SUBSCRIPTION(endpoint));
                if (data) {
                    subscriptions.push({
                        endpoint: data.endpoint,
                        userId: data.userId,
                        channels: data.channels || [],
                        createdAt: data.createdAt,
                        userAgent: data.userAgent,
                        ip: data.ip
                    });
                } else {
                    await kv.srem(K.SUBSCRIPTIONS_INDEX, endpoint).catch(() => {});
                }
            } catch (itemErr) {
                logger.error('Error processing subscription', { error: itemErr.message, endpoint });
            }
        }

        subscriptions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        res.json({ subscriptions, total: subscriptions.length });
    } catch (err) {
        logger.error('GET /admin/subscriptions error', { error: err.message });
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: 'Error getting subscriptions' });
    }
});

/**
 * GET /admin/channels — список всех каналов
 */
router.get('/admin/channels', verifyAdminToken, async (req, res) => {
    try {
        const channels = await ChannelManager.list();
        const withStats = [];
        
        for (const ch of channels) {
            const subs = await ChannelManager.getSubscribers(ch.id);
            withStats.push({ ...ch, subscribers: subs.length });
        }

        res.json({ channels: withStats, total: withStats.length });
    } catch (err) {
        logger.error('GET /admin/channels error', { error: err.message });
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: 'Error getting channels' });
    }
});

/**
 * POST /admin/channels — создание канала
 */
router.post('/admin/channels', verifyAdminToken, async (req, res) => {
    try {
        const channel = await ChannelManager.create({
            ...req.body,
            createdBy: 'admin'
        });
        res.status(CONFIG.HTTP.CREATED).json({ success: true, channel });
    } catch (err) {
        logger.error('POST /admin/channels error', { error: err.message });
        res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: err.message });
    }
});

/**
 * DELETE /admin/channels/:id — удаление канала
 */
router.delete('/admin/channels/:id', verifyAdminToken, async (req, res) => {
    try {
        const { id } = req.params;
        await ChannelManager.delete(id);
        res.json({ success: true, message: `Channel "${id}" deleted` });
    } catch (err) {
        logger.error('DELETE /admin/channels error', { error: err.message });
        res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: err.message });
    }
});

/**
 * GET /admin/channels/:id/stats — статистика канала
 */
router.get('/admin/channels/:id/stats', verifyAdminToken, async (req, res) => {
    try {
        const stats = await ChannelManager.getStats(req.params.id);
        if (!stats.channel) {
            return res.status(CONFIG.HTTP.NOT_FOUND).json({ error: 'Channel not found' });
        }
        res.json(stats);
    } catch (err) {
        logger.error('GET /admin/channels/:id/stats error', { error: err.message });
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: err.message });
    }
});

/**
 * POST /admin/services — создание сервисного ключа
 * Body: { serviceId, description }
 */
router.post('/admin/services', verifyAdminToken, async (req, res) => {
    try {
        const { serviceId, description } = req.body;
        const result = await ServiceKeyManager.create(serviceId, description);
        res.status(CONFIG.HTTP.CREATED).json(result);
    } catch (err) {
        logger.error('POST /admin/services error', { error: err.message });
        res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: err.message });
    }
});

/**
 * GET /admin/services — список всех сервисных ключей
 */
router.get('/admin/services', verifyAdminToken, async (req, res) => {
    try {
        const services = await ServiceKeyManager.list();
        res.json({ services, total: services.length });
    } catch (err) {
        logger.error('GET /admin/services error', { error: err.message });
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: err.message });
    }
});

/**
 * POST /admin/services/:keyHash/revoke — отозвать ключ
 */
router.post('/admin/services/:keyHash/revoke', verifyAdminToken, async (req, res) => {
    try {
        await ServiceKeyManager.revoke(req.params.keyHash);
        res.json({ success: true, message: 'Service key revoked' });
    } catch (err) {
        logger.error('POST /admin/services/revoke error', { error: err.message });
        res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: err.message });
    }
});

/**
 * POST /admin/services/:keyHash/activate — активировать ключ
 */
router.post('/admin/services/:keyHash/activate', verifyAdminToken, async (req, res) => {
    try {
        await ServiceKeyManager.activate(req.params.keyHash);
        res.json({ success: true, message: 'Service key activated' });
    } catch (err) {
        logger.error('POST /admin/services/activate error', { error: err.message });
        res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: err.message });
    }
});

/**
 * DELETE /admin/services/:keyHash — удалить ключ
 */
router.delete('/admin/services/:keyHash', verifyAdminToken, async (req, res) => {
    try {
        await ServiceKeyManager.delete(req.params.keyHash);
        res.json({ success: true, message: 'Service key deleted' });
    } catch (err) {
        logger.error('DELETE /admin/services error', { error: err.message });
        res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: err.message });
    }
});

/**
 * GET /admin/history — история отправок
 */
router.get('/admin/history', verifyAdminToken, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const history = await kv.lrange(K.SEND_HISTORY, 0, limit - 1);
        
        const parsed = history ? history.map(entry => {
            try { return JSON.parse(entry); } 
            catch { return null; }
        }).filter(Boolean) : [];

        res.json({ history: parsed, total: parsed.length });
    } catch (err) {
        logger.error('GET /admin/history error', { error: err.message });
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: 'Error getting history' });
    }
});

/**
 * GET /admin/logs — логи системы
 */
router.get('/admin/logs', verifyAdminToken, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const offset = parseInt(req.query.offset) || 0;
        const logs = await Logger.getLogs(limit, offset);
        res.json({ logs, total: logs.length });
    } catch (err) {
        logger.error('GET /admin/logs error', { error: err.message });
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: 'Error getting logs' });
    }
});

/**
 * GET /admin/logs/search — поиск по логам
 */
router.get('/admin/logs/search', verifyAdminToken, async (req, res) => {
    try {
        const { q, limit } = req.query;
        if (!q) {
            return res.status(CONFIG.HTTP.BAD_REQUEST).json({ error: 'Query parameter "q" required' });
        }
        const results = await Logger.searchLogs(q, Math.min(parseInt(limit) || 50, 200));
        res.json({ results, total: results.length });
    } catch (err) {
        logger.error('GET /admin/logs/search error', { error: err.message });
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: 'Error searching logs' });
    }
});

/**
 * DELETE /admin/logs — очистка логов
 */
router.delete('/admin/logs', verifyAdminToken, async (req, res) => {
    try {
        await Logger.clearLogs();
        res.json({ success: true, message: 'Logs cleared' });
    } catch (err) {
        logger.error('DELETE /admin/logs error', { error: err.message });
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: 'Error clearing logs' });
    }
});

/**
 * POST /admin/cleanup — очистка недействительных подписок
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
                await kv.srem(K.SUBSCRIPTIONS_INDEX, endpoint).catch(() => {});
                const channels = await kv.smembers(K.CHANNELS_LIST);
                if (channels) {
                    for (const chId of channels) {
                        await kv.srem(K.CHANNEL_INDEX(chId), endpoint).catch(() => {});
                    }
                }
                cleaned++;
            }
        }

        logger.info('Cleanup completed', { cleaned });
        res.json({ success: true, cleaned });
    } catch (err) {
        logger.error('POST /admin/cleanup error', { error: err.message });
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: 'Error cleaning' });
    }
});

/**
 * GET /admin/stats — полная статистика
 */
router.get('/admin/stats', verifyAdminToken, async (req, res) => {
    try {
        const subscriptions = await kv.smembers(K.SUBSCRIPTIONS_INDEX);
        const sendCounter = await kv.get(K.SEND_COUNTER);
        const channels = await ChannelManager.list();
        const services = await ServiceKeyManager.list();
        
        const channelStats = {};
        for (const ch of channels) {
            const subs = await ChannelManager.getSubscribers(ch.id);
            channelStats[ch.id] = {
                name: ch.name,
                subscribers: subs.length,
                public: ch.public
            };
        }

        const stats = {
            totalSubscriptions: subscriptions?.length || 0,
            totalSent: sendCounter ? parseInt(sendCounter, 10) : 0,
            channels: channelStats,
            services: {
                total: services.length,
                active: services.filter(s => s.active).length
            },
            timestamp: new Date().toISOString()
        };

        res.json(stats);
    } catch (err) {
        logger.error('GET /admin/stats error', { error: err.message });
        res.status(CONFIG.HTTP.SERVER_ERROR).json({ error: 'Error getting stats' });
    }
});

// ============================================
// ██████  ИНИЦИАЛИЗАЦИЯ
// ============================================

// Инициализируем каналы при загрузке модуля
ChannelManager.init().catch(err => {
    logger.error('Channel initialization failed', { error: err.message });
});

// ============================================
// ██████  ЭКСПОРТ
// ============================================

module.exports = router;
module.exports.PushSender = PushSender;
module.exports.ChannelManager = ChannelManager;
module.exports.ServiceKeyManager = ServiceKeyManager;
module.exports.logger = logger;
module.exports.CONFIG = CONFIG;