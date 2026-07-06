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
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
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

// Проверка пароля на ссылку
router.post('/verify-password', async (req, res) => {
    try {
        const { alias, password } = req.body;
        const links = await kv.get(K.LINKS) || {};
        const link = links[alias];
        
        if (!link) {
            return res.status(404).json({ error: 'Ссылка не найдена', code: 'NOT_FOUND' });
        }
        
        if (!link.password) {
            return res.json({ success: true, redirectUrl: link.targetUrl });
        }
        
        const hashedPassword = hashPassword(password);
        
        if (hashedPassword !== link.password) {
            return res.status(401).json({ error: 'Неверный пароль', code: 'WRONG_PASSWORD' });
        }
        
        res.json({ success: true, redirectUrl: link.targetUrl });
    } catch (err) {
        console.error('[getli/verify-password]', err);
        res.status(500).json({ error: 'Ошибка проверки пароля', code: 'INTERNAL_ERROR' });
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