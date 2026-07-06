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
    USERS: 'getli:users'
};

const ALIAS_REGEX = /^[a-zA-Z0-9_-]{3,50}$/;
const MAX_CLICKS_PER_HOUR = 1000;

// Переменные окружения
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const RECAPTCHA_SECRET_KEY = process.env.RECAPTCHA_SECRET_KEY;

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

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
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

    // Для v3: score от 0.0 (бот) до 1.0 (человек)
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
        googleConfigured: !!GOOGLE_CLIENT_ID
    });
});

// Google OAuth — вход через Google
router.post('/auth/google', async (req, res) => {
    try {
        const { credential } = req.body;
        
        if (!credential) {
            return res.status(400).json({ error: 'Missing credential', code: 'NO_CREDENTIAL' });
        }
        
        // Декодируем JWT
        const payload = decodeGoogleJWT(credential);
        
        // Проверяем issuer
        if (payload.iss !== 'https://accounts.google.com' && 
            payload.iss !== 'accounts.google.com') {
            return res.status(401).json({ error: 'Invalid issuer', code: 'INVALID_ISSUER' });
        }
        
        // Проверяем audience (если настроен GOOGLE_CLIENT_ID)
        if (GOOGLE_CLIENT_ID && payload.aud !== GOOGLE_CLIENT_ID) {
            return res.status(401).json({ error: 'Invalid audience', code: 'INVALID_AUDIENCE' });
        }
        
        // Проверяем срок действия
        if (payload.exp && payload.exp * 1000 < Date.now()) {
            return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
        }
        
        // Сохраняем пользователя в KV
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
        
        // Создаём сессию (30 дней)
        const sessions = await kv.get(K.SESSIONS) || {};
        const sessionToken = crypto.randomBytes(32).toString('hex');
        sessions[sessionToken] = {
            userId: payload.sub,
            email: payload.email,
            name: payload.name,
            picture: payload.picture,
            expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000
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
        const { targetUrl, alias, password, customAlias } = req.body;
        
        // Валидация URL
        if (!targetUrl || !targetUrl.startsWith('http')) {
            return res.status(400).json({ error: 'Некорректный URL', code: 'INVALID_URL' });
        }
        
        // Проверка кастомного алиаса
        let finalAlias = alias || generateId();
        
        if (customAlias) {
            if (!isValidAlias(customAlias)) {
                return res.status(400).json({ 
                    error: 'Алиас должен содержать 3-50 символов: a-z, A-Z, 0-9, -, _', 
                    code: 'INVALID_ALIAS' 
                });
            }
            
            // Проверка уникальности
            const links = await kv.get(K.LINKS) || {};
            if (links[customAlias]) {
                return res.status(409).json({ 
                    error: 'Этот алиас уже занят', 
                    code: 'ALIAS_TAKEN' 
                });
            }
            
            finalAlias = customAlias;
        }
        
        // Создание ссылки
        const link = {
            alias: finalAlias,
            targetUrl,
            password: password ? hashPassword(password) : null,
            createdBy: req.userId,
            createdAt: Date.now(),
            clicks: 0,
            lastClick: null
        };
        
        // Сохранение
        const links = await kv.get(K.LINKS) || {};
        links[finalAlias] = link;
        await kv.set(K.LINKS, links);
        
        // Добавление в список пользователя
        const userLinks = await kv.get(K.USER_LINKS(req.userId)) || [];
        userLinks.push(finalAlias);
        await kv.set(K.USER_LINKS(req.userId), userLinks);
        
        res.json({
            success: true,
            alias: finalAlias,
            url: `/getli/${finalAlias}`,
            fullUrl: `${req.protocol}://${req.get('host')}/getli/${finalAlias}`
        });
    } catch (err) {
        console.error('[getli/create]', err);
        res.status(500).json({ error: 'Ошибка создания ссылки', code: 'INTERNAL_ERROR' });
    }
});

// Получение списка ссылок пользователя
router.get('/my-links', requireAuth, async (req, res) => {
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
                    hasPassword: !!link.password,
                    createdAt: link.createdAt,
                    clicks: link.clicks,
                    lastClick: link.lastClick
                };
            });
        
        res.json({ links: result, total: result.length });
    } catch (err) {
        console.error('[getli/my-links]', err);
        res.status(500).json({ error: 'Ошибка получения списка', code: 'INTERNAL_ERROR' });
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
        
        res.json({
            alias: link.alias,
            targetUrl: link.targetUrl,
            totalClicks: link.clicks,
            createdAt: link.createdAt,
            recentClicks: stats.clicks.slice(-50)
        });
    } catch (err) {
        console.error('[getli/stats]', err);
        res.status(500).json({ error: 'Ошибка получения статистики', code: 'INTERNAL_ERROR' });
    }
});

// Публичная проверка капчи + пароля + редирект
router.post('/verify-captcha', async (req, res) => {
    try {
        const { alias, password, recaptchaToken } = req.body;
        
        if (!alias) {
            return res.status(400).json({ error: 'Алиас обязателен', code: 'MISSING_ALIAS' });
        }
        
        // Проверка reCAPTCHA
        try {
            await verifyRecaptcha(recaptchaToken);
        } catch (err) {
            return res.status(403).json({ 
                error: 'Проверка безопасности не пройдена', 
                code: 'CAPTCHA_FAILED' 
            });
        }
        
        // Получение ссылки
        const links = await kv.get(K.LINKS) || {};
        const link = links[alias];
        
        if (!link) {
            return res.status(404).json({ error: 'Ссылка не найдена', code: 'NOT_FOUND' });
        }
        
        // Проверка пароля (если установлен)
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
            ip: req.ip,
            userAgent: req.headers['user-agent']?.slice(0, 100)
        });
        stats.total = (stats.total || 0) + 1;
        // Ограничиваем историю последними 100 записями
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
        
        res.json({
            alias: link.alias,
            hasPassword: !!link.password,
            createdAt: link.createdAt
        });
    } catch (err) {
        console.error('[getli/info]', err);
        res.status(500).json({ error: 'Ошибка получения информации', code: 'INTERNAL_ERROR' });
    }
});

module.exports = router;