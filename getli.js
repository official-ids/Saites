const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const { kv } = require('@vercel/kv');

const router = express.Router();

// -----------------------------
// Middleware
// -----------------------------
router.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true
}));
router.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
router.use(express.json({ limit: '1mb' }));

// -----------------------------
// Константы
// -----------------------------
const K = {
    LINKS: 'getli:links',
    USER_LINKS: (userId) => `getli:user:${userId}:links`,
    STATS: (alias) => `getli:stats:${alias}`,
    SESSIONS: 'getli:sessions',
    USERS: 'getli:users',
    LAST_SESSION_CLEANUP: 'getli:last_session_cleanup',
    CLICK_RATE: (alias, ip) => `getli:rate:${alias}:${ip}`
};

const ALIAS_REGEX = /^[a-zA-Z0-9_-]{3,50}$/;
const MAX_LINKS_PER_USER = 100;
const MAX_CLICKS_PER_HOUR = 1000;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 дней
const SESSION_CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // раз в сутки
const CLICK_RATE_WINDOW = 60 * 60 * 1000; // 1 час
const MAX_TAGS_PER_LINK = 5;
const MAX_TAG_LENGTH = 20;
const MAX_DESCRIPTION_LENGTH = 500;

// Переменные окружения
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const RECAPTCHA_SECRET_KEY = process.env.RECAPTCHA_SECRET_KEY;
const BASE_URL = process.env.BASE_URL || 'https://oris-flax.vercel.app';

// -----------------------------
// Утилиты
// -----------------------------
function generateId(length = 8) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function isValidAlias(alias) {
    return ALIAS_REGEX.test(alias);
}

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function isValidUrl(url) {
    try {
        const parsed = new URL(url);
        return ['http:', 'https:'].includes(parsed.protocol);
    } catch {
        return false;
    }
}

function sanitizeTag(tag) {
    return String(tag || '')
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .toLowerCase()
        .slice(0, MAX_TAG_LENGTH);
}

function getBaseUrl(req) {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    return `${proto}://${host}`;
}

// -----------------------------
// Google reCAPTCHA Verification
// -----------------------------
async function verifyRecaptcha(token) {
    if (!token) {
        throw new Error('reCAPTCHA token required');
    }

    if (!RECAPTCHA_SECRET_KEY) {
        console.warn('[getli] RECAPTCHA_SECRET_KEY not set — skipping verification');
        return { success: true, score: 1.0 };
    }

    const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `secret=${RECAPTCHA_SECRET_KEY}&response=${token}`
    });

    const data = await response.json();

    if (!data.success) {
        throw new Error('reCAPTCHA verification failed: ' + (data['error-codes']?.join(', ') || 'unknown'));
    }

    if (data.score !== undefined && data.score < 0.5) {
        throw new Error(`reCAPTCHA score too low: ${data.score}`);
    }

    return data;
}

// -----------------------------
// Google OAuth
// -----------------------------
function decodeGoogleJWT(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) throw new Error('Invalid JWT');
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        return payload;
    } catch (err) {
        throw new Error('Invalid Google token');
    }
}

// -----------------------------
// Session Cleanup (background)
// -----------------------------
async function cleanupExpiredSessions() {
    try {
        const lastCleanup = await kv.get(K.LAST_SESSION_CLEANUP) || 0;
        if (Date.now() - lastCleanup < SESSION_CLEANUP_INTERVAL) {
            return;
        }

        const sessions = await kv.get(K.SESSIONS) || {};
        const now = Date.now();
        let cleaned = 0;

        for (const [token, session] of Object.entries(sessions)) {
            if (session.expiresAt < now) {
                delete sessions[token];
                cleaned++;
            }
        }

        if (cleaned > 0) {
            await kv.set(K.SESSIONS, sessions);
            console.log(`[getli] Cleaned ${cleaned} expired sessions`);
        }

        await kv.set(K.LAST_SESSION_CLEANUP, now);
    } catch (err) {
        console.error('[getli] Session cleanup error:', err);
    }
}

// Запускаем очистку при загрузке модуля
cleanupExpiredSessions();

// -----------------------------
// Middleware: Проверка авторизации
// -----------------------------
async function requireAuth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
        return res.status(401).json({ error: 'Требуется авторизация', code: 'NO_TOKEN' });
    }
    
    const sessions = await kv.get(K.SESSIONS) || {};
    const session = sessions[token];
    
    if (!session || session.expiresAt < Date.now()) {
        return res.status(401).json({ error: 'Сессия истекла', code: 'EXPIRED_TOKEN' });
    }
    
    req.userId = session.userId;
    req.userEmail = session.email;
    next();
}

// -----------------------------
// API Routes
// -----------------------------

// Health check
router.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        recaptchaConfigured: !!RECAPTCHA_SECRET_KEY,
        googleConfigured: !!GOOGLE_CLIENT_ID,
        version: '1.1.0'
    });
});

// Google OAuth — вход через Google
router.post('/auth/google', async (req, res) => {
    try {
        const { credential } = req.body;
        
        if (!credential) {
            return res.status(400).json({ error: 'Missing credential', code: 'NO_CREDENTIAL' });
        }
        
        const payload = decodeGoogleJWT(credential);
        
        if (payload.iss !== 'https://accounts.google.com' && 
            payload.iss !== 'accounts.google.com') {
            return res.status(401).json({ error: 'Invalid issuer', code: 'INVALID_ISSUER' });
        }
        
        if (GOOGLE_CLIENT_ID && payload.aud !== GOOGLE_CLIENT_ID) {
            return res.status(401).json({ error: 'Invalid audience', code: 'INVALID_AUDIENCE' });
        }
        
        if (payload.exp && payload.exp * 1000 < Date.now()) {
            return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
        }
        
        const users = await kv.get(K.USERS) || {};
        if (!users[payload.sub]) {
            users[payload.sub] = {
                id: payload.sub,
                email: payload.email,
                name: payload.name,
                picture: payload.picture,
                createdAt: Date.now()
            };
            await kv.set(K.USERS, users);
        }
        
        const sessions = await kv.get(K.SESSIONS) || {};
        const sessionToken = crypto.randomBytes(32).toString('hex');
        sessions[sessionToken] = {
            userId: payload.sub,
            email: payload.email,
            name: payload.name,
            picture: payload.picture,
            expiresAt: Date.now() + SESSION_TTL
        };
        await kv.set(K.SESSIONS, sessions);
        
        res.json({
            success: true,
            token: sessionToken,
            user: {
                id: payload.sub,
                name: payload.name,
                email: payload.email,
                picture: payload.picture
            }
        });
    } catch (err) {
        console.error('[getli/auth/google]', err);
        res.status(500).json({ error: 'Ошибка авторизации', code: 'AUTH_ERROR' });
    }
});

// Выход из аккаунта
router.post('/auth/logout', requireAuth, async (req, res) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        const sessions = await kv.get(K.SESSIONS) || {};
        delete sessions[token];
        await kv.set(K.SESSIONS, sessions);
        res.json({ success: true });
    } catch (err) {
        console.error('[getli/auth/logout]', err);
        res.status(500).json({ error: 'Ошибка выхода', code: 'LOGOUT_ERROR' });
    }
});

// Получение текущего пользователя
router.get('/auth/me', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден', code: 'USER_NOT_FOUND' });
        }
        res.json({ user });
    } catch (err) {
        console.error('[getli/auth/me]', err);
        res.status(500).json({ error: 'Ошибка получения профиля', code: 'INTERNAL_ERROR' });
    }
});

// Создание ссылки
router.post('/create', requireAuth, async (req, res) => {
    try {
        const { targetUrl, customAlias, password, description, tags, expiresAt } = req.body;
        
        // Валидация URL (ИСПРАВЛЕНИЕ: используем URL конструктор)
        if (!targetUrl || !isValidUrl(targetUrl)) {
            return res.status(400).json({ 
                error: 'Некорректный URL. Должен начинаться с http:// или https://', 
                code: 'INVALID_URL' 
            });
        }
        
        // Проверка лимита ссылок (НОВАЯ ФУНКЦИЯ)
        const userLinks = await kv.get(K.USER_LINKS(req.userId)) || [];
        if (userLinks.length >= MAX_LINKS_PER_USER) {
            return res.status(429).json({ 
                error: `Превышен лимит ссылок (${MAX_LINKS_PER_USER})`, 
                code: 'LINK_LIMIT_EXCEEDED',
                limit: MAX_LINKS_PER_USER
            });
        }
        
        // Обработка алиаса
        let finalAlias = customAlias || generateId();
        
        if (customAlias) {
            if (!isValidAlias(customAlias)) {
                return res.status(400).json({ 
                    error: 'Алиас должен содержать 3-50 символов: a-z, A-Z, 0-9, -, _', 
                    code: 'INVALID_ALIAS' 
                });
            }
            
            const links = await kv.get(K.LINKS) || {};
            if (links[customAlias]) {
                return res.status(409).json({ 
                    error: 'Этот алиас уже занят', 
                    code: 'ALIAS_TAKEN' 
                });
            }
            finalAlias = customAlias;
        }
        
        // Обработка тегов (НОВАЯ ФУНКЦИЯ)
        const processedTags = Array.isArray(tags) 
            ? tags.map(sanitizeTag).filter(Boolean).slice(0, MAX_TAGS_PER_LINK)
            : [];
        
        // Обработка описания (НОВАЯ ФУНКЦИЯ)
        const processedDescription = description 
            ? String(description).slice(0, MAX_DESCRIPTION_LENGTH)
            : '';
        
        // Обработка срока жизни (НОВАЯ ФУНКЦИЯ)
        const processedExpiresAt = expiresAt 
            ? Math.max(Date.now(), new Date(expiresAt).getTime())
            : null;
        
        // Создание ссылки
        const link = {
            alias: finalAlias,
            targetUrl,
            password: password ? hashPassword(password) : null,
            description: processedDescription,
            tags: processedTags,
            createdBy: req.userId,
            createdAt: Date.now(),
            expiresAt: processedExpiresAt,
            clicks: 0,
            lastClick: null
        };
        
        // Сохранение
        const links = await kv.get(K.LINKS) || {};
        links[finalAlias] = link;
        await kv.set(K.LINKS, links);
        
        userLinks.push(finalAlias);
        await kv.set(K.USER_LINKS(req.userId), userLinks);
        
        const baseUrl = getBaseUrl(req);
        
        res.json({
            success: true,
            alias: finalAlias,
            url: `/getli/${finalAlias}`,
            fullUrl: `${baseUrl}/getli/${finalAlias}`,
            qrUrl: `${baseUrl}/api/getli/qr/${finalAlias}`,
            expiresAt: processedExpiresAt
        });
    } catch (err) {
        console.error('[getli/create]', err);
        res.status(500).json({ error: 'Ошибка создания ссылки', code: 'INTERNAL_ERROR' });
    }
});

// Получение списка ссылок пользователя (с пагинацией и поиском)
router.get('/my-links', requireAuth, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const search = (req.query.q || '').toLowerCase();
        const tag = req.query.tag?.toLowerCase();
        
        const userLinks = await kv.get(K.USER_LINKS(req.userId)) || [];
        const links = await kv.get(K.LINKS) || {};
        
        let result = userLinks
            .filter(alias => links[alias])
            .map(alias => links[alias])
            .filter(link => {
                // Фильтрация по поиску
                if (search) {
                    const searchable = `${link.alias} ${link.targetUrl} ${link.description || ''}`.toLowerCase();
                    if (!searchable.includes(search)) return false;
                }
                // Фильтрация по тегу
                if (tag && (!link.tags || !link.tags.includes(tag))) {
                    return false;
                }
                return true;
            });
        
        const total = result.length;
        const totalPages = Math.ceil(total / limit);
        const startIndex = (page - 1) * limit;
        const paginatedLinks = result.slice(startIndex, startIndex + limit);
        
        const mappedLinks = paginatedLinks.map(link => ({
            alias: link.alias,
            targetUrl: link.targetUrl,
            description: link.description || '',
            tags: link.tags || [],
            hasPassword: !!link.password,
            createdAt: link.createdAt,
            expiresAt: link.expiresAt || null,
            clicks: link.clicks,
            lastClick: link.lastClick
        }));
        
        res.json({ 
            links: mappedLinks, 
            total,
            page,
            limit,
            totalPages
        });
    } catch (err) {
        console.error('[getli/my-links]', err);
        res.status(500).json({ error: 'Ошибка получения списка', code: 'INTERNAL_ERROR' });
    }
});

// Экспорт ссылок (НОВАЯ ФУНКЦИЯ)
router.get('/export', requireAuth, async (req, res) => {
    try {
        const userLinks = await kv.get(K.USER_LINKS(req.userId)) || [];
        const links = await kv.get(K.LINKS) || {};
        
        const result = userLinks
            .filter(alias => links[alias])
            .map(alias => {
                const link = links[alias];
                return {
                    alias: link.alias,
                    targetUrl: link.targetUrl,
                    description: link.description || '',
                    tags: link.tags || [],
                    hasPassword: !!link.password,
                    createdAt: new Date(link.createdAt).toISOString(),
                    expiresAt: link.expiresAt ? new Date(link.expiresAt).toISOString() : null,
                    clicks: link.clicks
                };
            });
        
        res.json({
            exportedAt: new Date().toISOString(),
            total: result.length,
            links: result
        });
    } catch (err) {
        console.error('[getli/export]', err);
        res.status(500).json({ error: 'Ошибка экспорта', code: 'INTERNAL_ERROR' });
    }
});

// Обновление ссылки (НОВАЯ ФУНКЦИЯ)
router.put('/:alias', requireAuth, async (req, res) => {
    try {
        const { alias } = req.params;
        const { targetUrl, password, description, tags, expiresAt } = req.body;
        
        const links = await kv.get(K.LINKS) || {};
        const link = links[alias];
        
        if (!link) {
            return res.status(404).json({ error: 'Ссылка не найдена', code: 'NOT_FOUND' });
        }
        
        if (link.createdBy !== req.userId) {
            return res.status(403).json({ error: 'Нет доступа', code: 'FORBIDDEN' });
        }
        
        if (targetUrl && !isValidUrl(targetUrl)) {
            return res.status(400).json({ error: 'Некорректный URL', code: 'INVALID_URL' });
        }
        
        // Обновляем поля
        if (targetUrl !== undefined) link.targetUrl = targetUrl;
        if (password !== undefined) link.password = password ? hashPassword(password) : null;
        if (description !== undefined) link.description = String(description).slice(0, MAX_DESCRIPTION_LENGTH);
        if (tags !== undefined) {
            link.tags = Array.isArray(tags) 
                ? tags.map(sanitizeTag).filter(Boolean).slice(0, MAX_TAGS_PER_LINK)
                : [];
        }
        if (expiresAt !== undefined) {
            link.expiresAt = expiresAt 
                ? Math.max(Date.now(), new Date(expiresAt).getTime())
                : null;
        }
        
        link.updatedAt = Date.now();
        links[alias] = link;
        await kv.set(K.LINKS, links);
        
        res.json({ success: true, message: 'Ссылка обновлена', link: { ...link, password: undefined } });
    } catch (err) {
        console.error('[getli/update]', err);
        res.status(500).json({ error: 'Ошибка обновления', code: 'INTERNAL_ERROR' });
    }
});

// Клонирование ссылки (НОВАЯ ФУНКЦИЯ)
router.post('/clone/:alias', requireAuth, async (req, res) => {
    try {
        const { alias } = req.params;
        const { newAlias } = req.body;
        
        const links = await kv.get(K.LINKS) || {};
        const original = links[alias];
        
        if (!original) {
            return res.status(404).json({ error: 'Ссылка не найдена', code: 'NOT_FOUND' });
        }
        
        if (original.createdBy !== req.userId) {
            return res.status(403).json({ error: 'Нет доступа', code: 'FORBIDDEN' });
        }
        
        const cloneAlias = (newAlias && isValidAlias(newAlias)) ? newAlias : generateId();
        
        if (links[cloneAlias]) {
            return res.status(409).json({ error: 'Алиас уже занят', code: 'ALIAS_TAKEN' });
        }
        
        const clone = {
            ...original,
            alias: cloneAlias,
            createdAt: Date.now(),
            clicks: 0,
            lastClick: null
        };
        
        links[cloneAlias] = clone;
        await kv.set(K.LINKS, links);
        
        const userLinks = await kv.get(K.USER_LINKS(req.userId)) || [];
        userLinks.push(cloneAlias);
        await kv.set(K.USER_LINKS(req.userId), userLinks);
        
        const baseUrl = getBaseUrl(req);
        
        res.json({
            success: true,
            alias: cloneAlias,
            fullUrl: `${baseUrl}/getli/${cloneAlias}`
        });
    } catch (err) {
        console.error('[getli/clone]', err);
        res.status(500).json({ error: 'Ошибка клонирования', code: 'INTERNAL_ERROR' });
    }
});

// Массовое удаление (НОВАЯ ФУНКЦИЯ)
router.post('/bulk-delete', requireAuth, async (req, res) => {
    try {
        const { aliases } = req.body;
        
        if (!Array.isArray(aliases) || aliases.length === 0) {
            return res.status(400).json({ error: 'Укажите массив aliases', code: 'INVALID_INPUT' });
        }
        
        if (aliases.length > 50) {
            return res.status(400).json({ error: 'Максимум 50 ссылок за раз', code: 'TOO_MANY' });
        }
        
        const links = await kv.get(K.LINKS) || {};
        const userLinks = await kv.get(K.USER_LINKS(req.userId)) || [];
        let deleted = 0;
        
        for (const alias of aliases) {
            const link = links[alias];
            if (link && link.createdBy === req.userId) {
                delete links[alias];
                const idx = userLinks.indexOf(alias);
                if (idx !== -1) userLinks.splice(idx, 1);
                deleted++;
            }
        }
        
        await kv.set(K.LINKS, links);
        await kv.set(K.USER_LINKS(req.userId), userLinks);
        
        res.json({ success: true, deleted });
    } catch (err) {
        console.error('[getli/bulk-delete]', err);
        res.status(500).json({ error: 'Ошибка массового удаления', code: 'INTERNAL_ERROR' });
    }
});

// Удаление ссылки
router.delete('/:alias', requireAuth, async (req, res) => {
    try {
        const { alias } = req.params;
        const links = await kv.get(K.LINKS) || {};
        const link = links[alias];
        
        if (!link) {
            return res.status(404).json({ error: 'Ссылка не найдена', code: 'NOT_FOUND' });
        }
        
        if (link.createdBy !== req.userId) {
            return res.status(403).json({ error: 'Нет доступа', code: 'FORBIDDEN' });
        }
        
        delete links[alias];
        await kv.set(K.LINKS, links);
        
        const userLinks = await kv.get(K.USER_LINKS(req.userId)) || [];
        const idx = userLinks.indexOf(alias);
        if (idx !== -1) {
            userLinks.splice(idx, 1);
            await kv.set(K.USER_LINKS(req.userId), userLinks);
        }
        
        // Удаляем статистику
        await kv.del(K.STATS(alias));
        
        res.json({ success: true, message: 'Ссылка удалена' });
    } catch (err) {
        console.error('[getli/delete]', err);
        res.status(500).json({ error: 'Ошибка удаления', code: 'INTERNAL_ERROR' });
    }
});

// Получение статистики
router.get('/stats/:alias', requireAuth, async (req, res) => {
    try {
        const { alias } = req.params;
        const links = await kv.get(K.LINKS) || {};
        const link = links[alias];
        
        if (!link) {
            return res.status(404).json({ error: 'Ссылка не найдена', code: 'NOT_FOUND' });
        }
        
        if (link.createdBy !== req.userId) {
            return res.status(403).json({ error: 'Нет доступа', code: 'FORBIDDEN' });
        }
        
        const stats = await kv.get(K.STATS(alias)) || { clicks: [], total: 0 };
        
        // Агрегация по устройствам (НОВАЯ ФУНКЦИЯ)
        const deviceStats = { mobile: 0, desktop: 0, other: 0 };
        for (const click of stats.clicks) {
            const ua = (click.userAgent || '').toLowerCase();
            if (/mobile|android|iphone|ipad/i.test(ua)) deviceStats.mobile++;
            else if (/windows|macintosh|linux/i.test(ua)) deviceStats.desktop++;
            else deviceStats.other++;
        }
        
        res.json({
            alias: link.alias,
            targetUrl: link.targetUrl,
            description: link.description || '',
            tags: link.tags || [],
            totalClicks: link.clicks,
            createdAt: link.createdAt,
            expiresAt: link.expiresAt || null,
            recentClicks: stats.clicks.slice(-50),
            deviceStats
        });
    } catch (err) {
        console.error('[getli/stats]', err);
        res.status(500).json({ error: 'Ошибка получения статистики', code: 'INTERNAL_ERROR' });
    }
});

// QR-код URL (НОВАЯ ФУНКЦИЯ)
router.get('/qr/:alias', async (req, res) => {
    try {
        const { alias } = req.params;
        const links = await kv.get(K.LINKS) || {};
        const link = links[alias];
        
        if (!link) {
            return res.status(404).json({ error: 'Ссылка не найдена', code: 'NOT_FOUND' });
        }
        
        const baseUrl = getBaseUrl(req);
        const fullUrl = `${baseUrl}/getli/${alias}`;
        const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(fullUrl)}`;
        
        res.json({
            alias,
            fullUrl,
            qrUrl: qrApiUrl,
            qrSvg: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&format=svg&data=${encodeURIComponent(fullUrl)}`
        });
    } catch (err) {
        console.error('[getli/qr]', err);
        res.status(500).json({ error: 'Ошибка генерации QR', code: 'INTERNAL_ERROR' });
    }
});

// Публичная проверка капчи + пароля + редирект
router.post('/verify-captcha', async (req, res) => {
    try {
        const { alias, password, recaptchaToken } = req.body;
        
        if (!alias) {
            return res.status(400).json({ error: 'Алиас обязателен', code: 'MISSING_ALIAS' });
        }
        
        try {
            await verifyRecaptcha(recaptchaToken);
        } catch (err) {
            return res.status(403).json({ 
                error: 'Проверка безопасности не пройдена', 
                code: 'CAPTCHA_FAILED' 
            });
        }
        
        const links = await kv.get(K.LINKS) || {};
        const link = links[alias];
        
        if (!link) {
            return res.status(404).json({ error: 'Ссылка не найдена', code: 'NOT_FOUND' });
        }
        
        // Проверка срока жизни (НОВАЯ ФУНКЦИЯ)
        if (link.expiresAt && link.expiresAt < Date.now()) {
            return res.status(410).json({ 
                error: 'Срок действия ссылки истёк', 
                code: 'LINK_EXPIRED' 
            });
        }
        
        // Anti-fraud: rate limit на клики (НОВАЯ ФУНКЦИЯ)
        const clientIp = req.ip || req.headers['x-forwarded-for'] || 'unknown';
        const rateKey = K.CLICK_RATE(alias, clientIp);
        const rateData = await kv.get(rateKey) || { count: 0, resetAt: Date.now() + CLICK_RATE_WINDOW };
        
        if (Date.now() > rateData.resetAt) {
            rateData.count = 0;
            rateData.resetAt = Date.now() + CLICK_RATE_WINDOW;
        }
        
        if (rateData.count >= MAX_CLICKS_PER_HOUR) {
            return res.status(429).json({ 
                error: 'Слишком много кликов. Попробуйте позже', 
                code: 'RATE_LIMITED',
                resetAt: rateData.resetAt
            });
        }
        
        rateData.count++;
        await kv.set(rateKey, rateData, { ex: Math.ceil(CLICK_RATE_WINDOW / 1000) });
        
        // Проверка пароля
        if (link.password) {
            if (!password) {
                return res.status(401).json({ 
                    error: 'Требуется пароль', 
                    code: 'PASSWORD_REQUIRED' 
                });
            }
            
            const hashedPassword = hashPassword(password);
            if (hashedPassword !== link.password) {
                return res.status(401).json({ 
                    error: 'Неверный пароль', 
                    code: 'WRONG_PASSWORD' 
                });
            }
        }
        
        // Инкремент счётчика кликов
        link.clicks = (link.clicks || 0) + 1;
        link.lastClick = Date.now();
        links[alias] = link;
        await kv.set(K.LINKS, links);
        
        // Сохранение в статистику
        const stats = await kv.get(K.STATS(alias)) || { clicks: [], total: 0 };
        stats.clicks.push({
            timestamp: Date.now(),
            ip: clientIp,
            userAgent: req.headers['user-agent']?.slice(0, 100)
        });
        stats.total = (stats.total || 0) + 1;
        if (stats.clicks.length > 100) {
            stats.clicks = stats.clicks.slice(-100);
        }
        await kv.set(K.STATS(alias), stats);
        
        res.json({ 
            success: true, 
            redirectUrl: link.targetUrl,
            clicks: link.clicks
        });
    } catch (err) {
        console.error('[getli/verify-captcha]', err);
        res.status(500).json({ error: 'Ошибка проверки', code: 'INTERNAL_ERROR' });
    }
});

// Получение информации о ссылке (для клиента)
router.get('/info/:alias', async (req, res) => {
    try {
        const { alias } = req.params;
        const links = await kv.get(K.LINKS) || {};
        const link = links[alias];
        
        if (!link) {
            return res.status(404).json({ error: 'Ссылка не найдена', code: 'NOT_FOUND' });
        }
        
        // Проверка срока жизни
        if (link.expiresAt && link.expiresAt < Date.now()) {
            return res.status(410).json({ 
                error: 'Срок действия ссылки истёк', 
                code: 'LINK_EXPIRED' 
            });
        }
        
        res.json({
            alias: link.alias,
            hasPassword: !!link.password,
            createdAt: link.createdAt,
            expiresAt: link.expiresAt || null,
            description: link.description || ''
        });
    } catch (err) {
        console.error('[getli/info]', err);
        res.status(500).json({ error: 'Ошибка получения информации', code: 'INTERNAL_ERROR' });
    }
});

module.exports = router;