// ============================================================
// МОДУЛЬ: SCRIPTBLOX — ПЛАТФОРМА ОБМЕНА СКРИПТАМИ
// Полноценный бэкенд с авторизацией, скриптами, комментариями
// и системой рейтинга
// ============================================================

const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const { kv } = require('@vercel/kv');

const router = express.Router();

// ------------------------------------------------------------
// MIDDLEWARE
// ------------------------------------------------------------
router.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true
}));

router.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

router.use(express.json({ limit: '2mb' }));

// ------------------------------------------------------------
// КОНСТАНТЫ ХРАНИЛИЩА
// ------------------------------------------------------------
const K = {
    USERS: 'scriptblox:users',
    SCRIPTS: 'scriptblox:scripts',
    COMMENTS: 'scriptblox:comments',
    LIKES: 'scriptblox:likes',
    VIEWS: 'scriptblox:views',
    CATEGORIES: 'scriptblox:categories',
    TAGS: 'scriptblox:tags',
    SESSIONS: 'scriptblox:sessions',
    GOOGLE_MAP: 'scriptblox:google_map',
    FAVORITES: 'scriptblox:favorites',
    REPORTS: 'scriptblox:reports',
    ACTIVITY: (userId) => `scriptblox:activity:${userId}`,
    SCRIPT_HISTORY: (scriptId) => `scriptblox:script_history:${scriptId}`,
    USER_STATS: (userId) => `scriptblox:user_stats:${userId}`,
    SCRIPT_STATS: (scriptId) => `scriptblox:script_stats:${scriptId}`
};

// ------------------------------------------------------------
// КОНФИГУРАЦИЯ
// ------------------------------------------------------------
const CONFIG = {
    SESSION_TTL: 30 * 24 * 60 * 60 * 1000,
    SCRIPT_MAX_LENGTH: 50000,
    SCRIPT_MIN_LENGTH: 10,
    SCRIPT_TITLE_MAX_LENGTH: 200,
    SCRIPT_TITLE_MIN_LENGTH: 3,
    SCRIPT_DESCRIPTION_MAX_LENGTH: 2000,
    COMMENT_MAX_LENGTH: 2000,
    COMMENT_MIN_LENGTH: 1,
    TAGS_MAX_COUNT: 10,
    TAG_MAX_LENGTH: 30,
    TAG_MIN_LENGTH: 2,
    MAX_FAVORITES: 1000,
    MAX_REPORTS_PER_USER: 10,
    REPORT_COOLDOWN: 60 * 60 * 1000,
    RATE_LIMIT_WINDOW: 60 * 1000,
    RATE_LIMIT_MAX: 100,
    SCRIPTS_PER_PAGE: 20,
    COMMENTS_PER_PAGE: 50,
    VALID_LANGUAGES: [
        'javascript', 'typescript', 'python', 'lua', 'ruby',
        'php', 'java', 'csharp', 'cpp', 'c', 'go', 'rust',
        'swift', 'kotlin', 'html', 'css', 'sql', 'bash',
        'powershell', 'perl', 'r', 'matlab', 'other'
    ],
    VALID_CATEGORIES: [
        'scripts', 'tools', 'games', 'automation', 'web',
        'mobile', 'desktop', 'api', 'library', 'tutorial',
        'snippet', 'config', 'data', 'other'
    ]
};

// ------------------------------------------------------------
// УТИЛИТЫ
// ------------------------------------------------------------

function generateId() {
    return crypto.randomBytes(16).toString('hex');
}

function generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
}

function sanitizeString(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .trim();
}

function sanitizeScriptContent(content) {
    if (typeof content !== 'string') return '';
    return content.trim();
}

function isValidLanguage(language) {
    return CONFIG.VALID_LANGUAGES.includes(language);
}

function isValidCategory(category) {
    return CONFIG.VALID_CATEGORIES.includes(category);
}

function isValidTag(tag) {
    if (typeof tag !== 'string') return false;
    const cleaned = tag.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    return cleaned.length >= CONFIG.TAG_MIN_LENGTH && 
           cleaned.length <= CONFIG.TAG_MAX_LENGTH;
}

function normalizeTag(tag) {
    return tag.toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

function now() {
    return new Date().toISOString();
}

function timestamp() {
    return Date.now();
}

function getRemoteIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.ip ||
           'unknown';
}

// ------------------------------------------------------------
// DEFAULT DATA FACTORIES
// ------------------------------------------------------------

function createDefaultUserStats() {
    return {
        scriptsCount: 0,
        totalViews: 0,
        totalLikes: 0,
        totalComments: 0,
        favoritesCount: 0,
        joinedAt: now()
    };
}

function createDefaultScriptStats() {
    return {
        views: 0,
        likes: 0,
        comments: 0,
        favorites: 0,
        createdAt: now(),
        lastViewedAt: null
    };
}

// ------------------------------------------------------------
// RATE LIMITING
// ------------------------------------------------------------

async function checkRateLimit(ip, action, maxRequests = CONFIG.RATE_LIMIT_MAX) {
    const key = `scriptblox:rate:${ip}:${action}`;
    const data = await kv.get(key);
    const now = timestamp();

    if (!data || now > data.resetAt) {
        await kv.set(key, {
            count: 1,
            resetAt: now + CONFIG.RATE_LIMIT_WINDOW
        }, { ex: Math.ceil(CONFIG.RATE_LIMIT_WINDOW / 1000) });
        return true;
    }

    if (data.count >= maxRequests) {
        return false;
    }

    data.count++;
    await kv.set(key, data, { ex: Math.ceil((data.resetAt - now) / 1000) });
    return true;
}

// ------------------------------------------------------------
// AUTH MIDDLEWARE
// ------------------------------------------------------------

async function requireAuth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
        return res.status(401).json({
            error: 'Требуется авторизация',
            code: 'NO_TOKEN'
        });
    }
    
    const sessions = await kv.get(K.SESSIONS) || {};
    const session = sessions[token];
    
    if (!session || session.expiresAt < timestamp()) {
        return res.status(401).json({
            error: 'Сессия истекла',
            code: 'EXPIRED_TOKEN'
        });
    }
    
    req.userId = session.userId;
    req.sessionId = token;
    next();
}

async function optionalAuth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (token) {
        const sessions = await kv.get(K.SESSIONS) || {};
        const session = sessions[token];
        
        if (session && session.expiresAt >= timestamp()) {
            req.userId = session.userId;
            req.sessionId = token;
        }
    }
    
    next();
}

// ------------------------------------------------------------
// ACTIVITY LOGGING
// ------------------------------------------------------------

async function logActivity(userId, action, details = {}) {
    const key = K.ACTIVITY(userId);
    const log = await kv.get(key) || [];
    
    log.unshift({
        id: generateId(),
        action,
        details,
        timestamp: now()
    });
    
    if (log.length > 100) {
        log.length = 100;
    }
    
    await kv.set(key, log);
}

// ------------------------------------------------------------
// GOOGLE OAUTH
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// API ROUTES
// ------------------------------------------------------------

// Health check
router.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: now(),
        version: '1.0.0'
    });
});

// ------------------------------------------------------------
// AUTH: Google OAuth
// ------------------------------------------------------------

router.post('/auth/google', async (req, res) => {
    try {
        const { credential } = req.body;
        
        if (!credential) {
            return res.status(400).json({
                error: 'Отсутствует credential',
                code: 'NO_CREDENTIAL'
            });
        }
        
        const payload = decodeGoogleJWT(credential);
        
        if (payload.iss !== 'https://accounts.google.com' &&
            payload.iss !== 'accounts.google.com') {
            return res.status(401).json({
                error: 'Неверный issuer',
                code: 'INVALID_ISSUER'
            });
        }
        
        if (payload.exp && payload.exp * 1000 < timestamp()) {
            return res.status(401).json({
                error: 'Токен истёк',
                code: 'TOKEN_EXPIRED'
            });
        }
        
        const googleId = payload.sub;
        const email = payload.email;
        const name = payload.name;
        const picture = payload.picture;
        
        const googleMap = await kv.get(K.GOOGLE_MAP) || {};
        let userId = googleMap[googleId];
        let user;
        
        if (userId) {
            const users = await kv.get(K.USERS) || {};
            user = users[userId];
            
            if (!user) {
                delete googleMap[googleId];
                await kv.set(K.GOOGLE_MAP, googleMap);
                userId = null;
            }
        }
        
        if (!userId) {
            userId = generateId();
            
            user = {
                id: userId,
                googleId,
                email,
                username: name.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 30),
                displayName: name,
                avatar: picture || null,
                bio: '',
                createdAt: now(),
                updatedAt: now(),
                stats: createDefaultUserStats()
            };
            
            const users = await kv.get(K.USERS) || {};
            users[userId] = user;
            await kv.set(K.USERS, users);
            
            googleMap[googleId] = userId;
            await kv.set(K.GOOGLE_MAP, googleMap);
            
            await logActivity(userId, 'register', { email });
        } else {
            user.updatedAt = now();
            const users = await kv.get(K.USERS) || {};
            users[userId] = user;
            await kv.set(K.USERS, users);
            
            await logActivity(userId, 'login', { method: 'google' });
        }
        
        const sessions = await kv.get(K.SESSIONS) || {};
        const sessionToken = generateSessionToken();
        
        sessions[sessionToken] = {
            userId,
            email: user.email,
            createdAt: now(),
            expiresAt: timestamp() + CONFIG.SESSION_TTL
        };
        
        await kv.set(K.SESSIONS, sessions);
        
        res.json({
            success: true,
            token: sessionToken,
            user: {
                id: user.id,
                username: user.username,
                displayName: user.displayName,
                avatar: user.avatar,
                email: user.email
            }
        });
    } catch (err) {
        console.error('[scriptblox/auth/google]', err);
        res.status(500).json({
            error: 'Ошибка авторизации',
            code: 'AUTH_ERROR'
        });
    }
});

// ------------------------------------------------------------
// AUTH: Logout
// ------------------------------------------------------------

router.post('/auth/logout', requireAuth, async (req, res) => {
    try {
        const sessions = await kv.get(K.SESSIONS) || {};
        delete sessions[req.sessionId];
        await kv.set(K.SESSIONS, sessions);
        
        await logActivity(req.userId, 'logout');
        
        res.json({ success: true });
    } catch (err) {
        console.error('[scriptblox/auth/logout]', err);
        res.status(500).json({
            error: 'Ошибка выхода',
            code: 'LOGOUT_ERROR'
        });
    }
});

// ------------------------------------------------------------
// AUTH: Get current user
// ------------------------------------------------------------

router.get('/auth/me', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];
        
        if (!user) {
            return res.status(404).json({
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }
        
        res.json({ user });
    } catch (err) {
        console.error('[scriptblox/auth/me]', err);
        res.status(500).json({
            error: 'Ошибка получения профиля',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// SCRIPTS: Create script
// ------------------------------------------------------------

router.post('/scripts', requireAuth, async (req, res) => {
    try {
        const { title, content, description, language, category, tags } = req.body;
        
        if (!title || title.length < CONFIG.SCRIPT_TITLE_MIN_LENGTH || 
            title.length > CONFIG.SCRIPT_TITLE_MAX_LENGTH) {
            return res.status(400).json({
                error: `Заголовок должен содержать от ${CONFIG.SCRIPT_TITLE_MIN_LENGTH} до ${CONFIG.SCRIPT_TITLE_MAX_LENGTH} символов`,
                code: 'INVALID_TITLE'
            });
        }
        
        if (!content || content.length < CONFIG.SCRIPT_MIN_LENGTH || 
            content.length > CONFIG.SCRIPT_MAX_LENGTH) {
            return res.status(400).json({
                error: `Код должен содержать от ${CONFIG.SCRIPT_MIN_LENGTH} до ${CONFIG.SCRIPT_MAX_LENGTH} символов`,
                code: 'INVALID_CONTENT'
            });
        }
        
        if (description && description.length > CONFIG.SCRIPT_DESCRIPTION_MAX_LENGTH) {
            return res.status(400).json({
                error: `Описание не должно превышать ${CONFIG.SCRIPT_DESCRIPTION_MAX_LENGTH} символов`,
                code: 'DESCRIPTION_TOO_LONG'
            });
        }
        
        if (!language || !isValidLanguage(language)) {
            return res.status(400).json({
                error: 'Неверный язык программирования',
                code: 'INVALID_LANGUAGE'
            });
        }
        
        if (!category || !isValidCategory(category)) {
            return res.status(400).json({
                error: 'Неверная категория',
                code: 'INVALID_CATEGORY'
            });
        }
        
        const processedTags = [];
        if (tags && Array.isArray(tags)) {
            for (const tag of tags.slice(0, CONFIG.TAGS_MAX_COUNT)) {
                if (isValidTag(tag)) {
                    processedTags.push(normalizeTag(tag));
                }
            }
        }
        
        const scriptId = generateId();
        const script = {
            id: scriptId,
            authorId: req.userId,
            title: sanitizeString(title),
            content: sanitizeScriptContent(content),
            description: description ? sanitizeString(description) : '',
            language,
            category,
            tags: processedTags,
            isPublic: true,
            createdAt: now(),
            updatedAt: now(),
            stats: createDefaultScriptStats()
        };
        
        const scripts = await kv.get(K.SCRIPTS) || {};
        scripts[scriptId] = script;
        await kv.set(K.SCRIPTS, scripts);
        
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];
        if (user) {
            user.stats = user.stats || createDefaultUserStats();
            user.stats.scriptsCount = (user.stats.scriptsCount || 0) + 1;
            user.updatedAt = now();
            users[req.userId] = user;
            await kv.set(K.USERS, users);
        }
        
        await logActivity(req.userId, 'script_created', { scriptId, title });
        
        res.json({
            success: true,
            script: {
                id: script.id,
                title: script.title,
                language: script.language,
                category: script.category,
                tags: script.tags
            }
        });
    } catch (err) {
        console.error('[scriptblox/scripts/create]', err);
        res.status(500).json({
            error: 'Ошибка создания скрипта',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// SCRIPTS: Get script by ID
// ------------------------------------------------------------

router.get('/scripts/:scriptId', optionalAuth, async (req, res) => {
    try {
        const { scriptId } = req.params;
        
        const scripts = await kv.get(K.SCRIPTS) || {};
        const script = scripts[scriptId];
        
        if (!script) {
            return res.status(404).json({
                error: 'Скрипт не найден',
                code: 'SCRIPT_NOT_FOUND'
            });
        }
        
        if (!script.isPublic && (!req.userId || req.userId !== script.authorId)) {
            return res.status(403).json({
                error: 'Доступ запрещён',
                code: 'FORBIDDEN'
            });
        }
        
        const users = await kv.get(K.USERS) || {};
        const author = users[script.authorId];
        
        const scriptWithAuthor = {
            ...script,
            author: author ? {
                id: author.id,
                username: author.username,
                displayName: author.displayName,
                avatar: author.avatar
            } : null
        };
        
        if (req.userId && req.userId !== script.authorId) {
            script.stats = script.stats || createDefaultScriptStats();
            script.stats.views = (script.stats.views || 0) + 1;
            script.stats.lastViewedAt = now();
            scripts[scriptId] = script;
            await kv.set(K.SCRIPTS, scripts);
            
            if (author) {
                author.stats = author.stats || createDefaultUserStats();
                author.stats.totalViews = (author.stats.totalViews || 0) + 1;
                users[script.authorId] = author;
                await kv.set(K.USERS, users);
            }
        }
        
        res.json({ script: scriptWithAuthor });
    } catch (err) {
        console.error('[scriptblox/scripts/get]', err);
        res.status(500).json({
            error: 'Ошибка получения скрипта',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// SCRIPTS: Update script
// ------------------------------------------------------------

router.put('/scripts/:scriptId', requireAuth, async (req, res) => {
    try {
        const { scriptId } = req.params;
        const { title, content, description, language, category, tags, isPublic } = req.body;
        
        const scripts = await kv.get(K.SCRIPTS) || {};
        const script = scripts[scriptId];
        
        if (!script) {
            return res.status(404).json({
                error: 'Скрипт не найден',
                code: 'SCRIPT_NOT_FOUND'
            });
        }
        
        if (script.authorId !== req.userId) {
            return res.status(403).json({
                error: 'Нет доступа',
                code: 'FORBIDDEN'
            });
        }
        
        if (title !== undefined) {
            if (title.length < CONFIG.SCRIPT_TITLE_MIN_LENGTH || 
                title.length > CONFIG.SCRIPT_TITLE_MAX_LENGTH) {
                return res.status(400).json({
                    error: `Заголовок должен содержать от ${CONFIG.SCRIPT_TITLE_MIN_LENGTH} до ${CONFIG.SCRIPT_TITLE_MAX_LENGTH} символов`,
                    code: 'INVALID_TITLE'
                });
            }
            script.title = sanitizeString(title);
        }
        
        if (content !== undefined) {
            if (content.length < CONFIG.SCRIPT_MIN_LENGTH || 
                content.length > CONFIG.SCRIPT_MAX_LENGTH) {
                return res.status(400).json({
                    error: `Код должен содержать от ${CONFIG.SCRIPT_MIN_LENGTH} до ${CONFIG.SCRIPT_MAX_LENGTH} символов`,
                    code: 'INVALID_CONTENT'
                });
            }
            script.content = sanitizeScriptContent(content);
        }
        
        if (description !== undefined) {
            if (description.length > CONFIG.SCRIPT_DESCRIPTION_MAX_LENGTH) {
                return res.status(400).json({
                    error: `Описание не должно превышать ${CONFIG.SCRIPT_DESCRIPTION_MAX_LENGTH} символов`,
                    code: 'DESCRIPTION_TOO_LONG'
                });
            }
            script.description = sanitizeString(description);
        }
        
        if (language !== undefined && !isValidLanguage(language)) {
            return res.status(400).json({
                error: 'Неверный язык программирования',
                code: 'INVALID_LANGUAGE'
            });
        }
        if (language !== undefined) script.language = language;
        
        if (category !== undefined && !isValidCategory(category)) {
            return res.status(400).json({
                error: 'Неверная категория',
                code: 'INVALID_CATEGORY'
            });
        }
        if (category !== undefined) script.category = category;
        
        if (tags !== undefined && Array.isArray(tags)) {
            const processedTags = [];
            for (const tag of tags.slice(0, CONFIG.TAGS_MAX_COUNT)) {
                if (isValidTag(tag)) {
                    processedTags.push(normalizeTag(tag));
                }
            }
            script.tags = processedTags;
        }
        
        if (isPublic !== undefined) {
            script.isPublic = Boolean(isPublic);
        }
        
        script.updatedAt = now();
        scripts[scriptId] = script;
        await kv.set(K.SCRIPTS, scripts);
        
        await logActivity(req.userId, 'script_updated', { scriptId });
        
        res.json({ success: true });
    } catch (err) {
        console.error('[scriptblox/scripts/update]', err);
        res.status(500).json({
            error: 'Ошибка обновления скрипта',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// SCRIPTS: Delete script
// ------------------------------------------------------------

router.delete('/scripts/:scriptId', requireAuth, async (req, res) => {
    try {
        const { scriptId } = req.params;
        
        const scripts = await kv.get(K.SCRIPTS) || {};
        const script = scripts[scriptId];
        
        if (!script) {
            return res.status(404).json({
                error: 'Скрипт не найден',
                code: 'SCRIPT_NOT_FOUND'
            });
        }
        
        if (script.authorId !== req.userId) {
            return res.status(403).json({
                error: 'Нет доступа',
                code: 'FORBIDDEN'
            });
        }
        
        delete scripts[scriptId];
        await kv.set(K.SCRIPTS, scripts);
        
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];
        if (user) {
            user.stats = user.stats || createDefaultUserStats();
            user.stats.scriptsCount = Math.max(0, (user.stats.scriptsCount || 0) - 1);
            user.updatedAt = now();
            users[req.userId] = user;
            await kv.set(K.USERS, users);
        }
        
        await logActivity(req.userId, 'script_deleted', { scriptId });
        
        res.json({ success: true });
    } catch (err) {
        console.error('[scriptblox/scripts/delete]', err);
        res.status(500).json({
            error: 'Ошибка удаления скрипта',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// SCRIPTS: List scripts
// ------------------------------------------------------------

router.get('/scripts', optionalAuth, async (req, res) => {
    try {
        const { 
            page = 1, 
            limit = CONFIG.SCRIPTS_PER_PAGE,
            category,
            language,
            tag,
            search,
            sort = 'newest',
            authorId
        } = req.query;
        
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit) || CONFIG.SCRIPTS_PER_PAGE));
        
        const scripts = await kv.get(K.SCRIPTS) || {};
        const users = await kv.get(K.USERS) || {};
        
        let filteredScripts = Object.values(scripts).filter(script => {
            if (!script.isPublic) return false;
            if (category && script.category !== category) return false;
            if (language && script.language !== language) return false;
            if (tag && !script.tags?.includes(normalizeTag(tag))) return false;
            if (authorId && script.authorId !== authorId) return false;
            if (search) {
                const searchLower = search.toLowerCase();
                const titleMatch = script.title.toLowerCase().includes(searchLower);
                const descMatch = script.description?.toLowerCase().includes(searchLower);
                const tagMatch = script.tags?.some(t => t.includes(searchLower));
                if (!titleMatch && !descMatch && !tagMatch) return false;
            }
            return true;
        });
        
        if (sort === 'newest') {
            filteredScripts.sort((a, b) => 
                new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
            );
        } else if (sort === 'popular') {
            filteredScripts.sort((a, b) => 
                (b.stats?.likes || 0) - (a.stats?.likes || 0)
            );
        } else if (sort === 'views') {
            filteredScripts.sort((a, b) => 
                (b.stats?.views || 0) - (a.stats?.views || 0)
            );
        }
        
        const start = (pageNum - 1) * limitNum;
        const end = start + limitNum;
        const paginatedScripts = filteredScripts.slice(start, end);
        
        const scriptsWithAuthors = paginatedScripts.map(script => {
            const author = users[script.authorId];
            return {
                ...script,
                author: author ? {
                    id: author.id,
                    username: author.username,
                    displayName: author.displayName,
                    avatar: author.avatar
                } : null
            };
        });
        
        res.json({
            scripts: scriptsWithAuthors,
            total: filteredScripts.length,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(filteredScripts.length / limitNum)
        });
    } catch (err) {
        console.error('[scriptblox/scripts/list]', err);
        res.status(500).json({
            error: 'Ошибка получения списка скриптов',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// SCRIPTS: My scripts
// ------------------------------------------------------------

router.get('/scripts/my', requireAuth, async (req, res) => {
    try {
        const { page = 1, limit = CONFIG.SCRIPTS_PER_PAGE } = req.query;
        
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit) || CONFIG.SCRIPTS_PER_PAGE));
        
        const scripts = await kv.get(K.SCRIPTS) || {};
        
        const myScripts = Object.values(scripts)
            .filter(script => script.authorId === req.userId)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        
        const start = (pageNum - 1) * limitNum;
        const end = start + limitNum;
        const paginatedScripts = myScripts.slice(start, end);
        
        res.json({
            scripts: paginatedScripts,
            total: myScripts.length,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(myScripts.length / limitNum)
        });
    } catch (err) {
        console.error('[scriptblox/scripts/my]', err);
        res.status(500).json({
            error: 'Ошибка получения моих скриптов',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// COMMENTS: Add comment
// ------------------------------------------------------------

router.post('/scripts/:scriptId/comments', requireAuth, async (req, res) => {
    try {
        const { scriptId } = req.params;
        const { content, parentId } = req.body;
        
        if (!content || content.length < CONFIG.COMMENT_MIN_LENGTH || 
            content.length > CONFIG.COMMENT_MAX_LENGTH) {
            return res.status(400).json({
                error: `Комментарий должен содержать от ${CONFIG.COMMENT_MIN_LENGTH} до ${CONFIG.COMMENT_MAX_LENGTH} символов`,
                code: 'INVALID_CONTENT'
            });
        }
        
        const scripts = await kv.get(K.SCRIPTS) || {};
        const script = scripts[scriptId];
        
        if (!script) {
            return res.status(404).json({
                error: 'Скрипт не найден',
                code: 'SCRIPT_NOT_FOUND'
            });
        }
        
        if (parentId) {
            const comments = await kv.get(K.COMMENTS) || {};
            const parentComment = comments[parentId];
            
            if (!parentComment || parentComment.scriptId !== scriptId) {
                return res.status(400).json({
                    error: 'Родительский комментарий не найден',
                    code: 'PARENT_NOT_FOUND'
                });
            }
        }
        
        const commentId = generateId();
        const comment = {
            id: commentId,
            scriptId,
            authorId: req.userId,
            content: sanitizeString(content),
            parentId: parentId || null,
            createdAt: now(),
            updatedAt: now(),
            likes: 0
        };
        
        const comments = await kv.get(K.COMMENTS) || {};
        comments[commentId] = comment;
        await kv.set(K.COMMENTS, comments);
        
        script.stats = script.stats || createDefaultScriptStats();
        script.stats.comments = (script.stats.comments || 0) + 1;
        scripts[scriptId] = script;
        await kv.set(K.SCRIPTS, scripts);
        
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];
        if (user) {
            user.stats = user.stats || createDefaultUserStats();
            user.stats.totalComments = (user.stats.totalComments || 0) + 1;
            users[req.userId] = user;
            await kv.set(K.USERS, users);
        }
        
        await logActivity(req.userId, 'comment_added', { scriptId, commentId });
        
        res.json({
            success: true,
            comment: {
                id: comment.id,
                content: comment.content,
                createdAt: comment.createdAt
            }
        });
    } catch (err) {
        console.error('[scriptblox/comments/add]', err);
        res.status(500).json({
            error: 'Ошибка добавления комментария',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// COMMENTS: Get comments for script
// ------------------------------------------------------------

router.get('/scripts/:scriptId/comments', optionalAuth, async (req, res) => {
    try {
        const { scriptId } = req.params;
        const { page = 1, limit = CONFIG.COMMENTS_PER_PAGE } = req.query;
        
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit) || CONFIG.COMMENTS_PER_PAGE));
        
        const comments = await kv.get(K.COMMENTS) || {};
        const users = await kv.get(K.USERS) || {};
        
        const scriptComments = Object.values(comments)
            .filter(comment => comment.scriptId === scriptId && !comment.parentId)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        
        const start = (pageNum - 1) * limitNum;
        const end = start + limitNum;
        const paginatedComments = scriptComments.slice(start, end);
        
        const commentsWithAuthors = paginatedComments.map(comment => {
            const author = users[comment.authorId];
            const replies = Object.values(comments)
                .filter(reply => reply.parentId === comment.id)
                .map(reply => {
                    const replyAuthor = users[reply.authorId];
                    return {
                        ...reply,
                        author: replyAuthor ? {
                            id: replyAuthor.id,
                            username: replyAuthor.username,
                            displayName: replyAuthor.displayName,
                            avatar: replyAuthor.avatar
                        } : null
                    };
                });
            
            return {
                ...comment,
                author: author ? {
                    id: author.id,
                    username: author.username,
                    displayName: author.displayName,
                    avatar: author.avatar
                } : null,
                replies
            };
        });
        
        res.json({
            comments: commentsWithAuthors,
            total: scriptComments.length,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(scriptComments.length / limitNum)
        });
    } catch (err) {
        console.error('[scriptblox/comments/get]', err);
        res.status(500).json({
            error: 'Ошибка получения комментариев',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// COMMENTS: Update comment
// ------------------------------------------------------------

router.put('/comments/:commentId', requireAuth, async (req, res) => {
    try {
        const { commentId } = req.params;
        const { content } = req.body;
        
        if (!content || content.length < CONFIG.COMMENT_MIN_LENGTH || 
            content.length > CONFIG.COMMENT_MAX_LENGTH) {
            return res.status(400).json({
                error: `Комментарий должен содержать от ${CONFIG.COMMENT_MIN_LENGTH} до ${CONFIG.COMMENT_MAX_LENGTH} символов`,
                code: 'INVALID_CONTENT'
            });
        }
        
        const comments = await kv.get(K.COMMENTS) || {};
        const comment = comments[commentId];
        
        if (!comment) {
            return res.status(404).json({
                error: 'Комментарий не найден',
                code: 'COMMENT_NOT_FOUND'
            });
        }
        
        if (comment.authorId !== req.userId) {
            return res.status(403).json({
                error: 'Нет доступа',
                code: 'FORBIDDEN'
            });
        }
        
        comment.content = sanitizeString(content);
        comment.updatedAt = now();
        comments[commentId] = comment;
        await kv.set(K.COMMENTS, comments);
        
        res.json({ success: true });
    } catch (err) {
        console.error('[scriptblox/comments/update]', err);
        res.status(500).json({
            error: 'Ошибка обновления комментария',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// COMMENTS: Delete comment
// ------------------------------------------------------------

router.delete('/comments/:commentId', requireAuth, async (req, res) => {
    try {
        const { commentId } = req.params;
        
        const comments = await kv.get(K.COMMENTS) || {};
        const comment = comments[commentId];
        
        if (!comment) {
            return res.status(404).json({
                error: 'Комментарий не найден',
                code: 'COMMENT_NOT_FOUND'
            });
        }
        
        if (comment.authorId !== req.userId) {
            return res.status(403).json({
                error: 'Нет доступа',
                code: 'FORBIDDEN'
            });
        }
        
        const replies = Object.values(comments).filter(c => c.parentId === commentId);
        for (const reply of replies) {
            delete comments[reply.id];
        }
        
        delete comments[commentId];
        await kv.set(K.COMMENTS, comments);
        
        const scripts = await kv.get(K.SCRIPTS) || {};
        const script = scripts[comment.scriptId];
        if (script) {
            script.stats = script.stats || createDefaultScriptStats();
            script.stats.comments = Math.max(0, (script.stats.comments || 0) - 1 - replies.length);
            scripts[comment.scriptId] = script;
            await kv.set(K.SCRIPTS, scripts);
        }
        
        res.json({ success: true });
    } catch (err) {
        console.error('[scriptblox/comments/delete]', err);
        res.status(500).json({
            error: 'Ошибка удаления комментария',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// LIKES: Toggle like on script
// ------------------------------------------------------------

router.post('/scripts/:scriptId/like', requireAuth, async (req, res) => {
    try {
        const { scriptId } = req.params;
        
        const scripts = await kv.get(K.SCRIPTS) || {};
        const script = scripts[scriptId];
        
        if (!script) {
            return res.status(404).json({
                error: 'Скрипт не найден',
                code: 'SCRIPT_NOT_FOUND'
            });
        }
        
        const likes = await kv.get(K.LIKES) || {};
        const likeKey = `${scriptId}:${req.userId}`;
        
        const isLiked = likes[likeKey];
        
        if (isLiked) {
            delete likes[likeKey];
            script.stats = script.stats || createDefaultScriptStats();
            script.stats.likes = Math.max(0, (script.stats.likes || 0) - 1);
            
            const users = await kv.get(K.USERS) || {};
            const author = users[script.authorId];
            if (author) {
                author.stats = author.stats || createDefaultUserStats();
                author.stats.totalLikes = Math.max(0, (author.stats.totalLikes || 0) - 1);
                users[script.authorId] = author;
                await kv.set(K.USERS, users);
            }
        } else {
            likes[likeKey] = {
                userId: req.userId,
                scriptId,
                createdAt: now()
            };
            script.stats = script.stats || createDefaultScriptStats();
            script.stats.likes = (script.stats.likes || 0) + 1;
            
            const users = await kv.get(K.USERS) || {};
            const author = users[script.authorId];
            if (author) {
                author.stats = author.stats || createDefaultUserStats();
                author.stats.totalLikes = (author.stats.totalLikes || 0) + 1;
                users[script.authorId] = author;
                await kv.set(K.USERS, users);
            }
        }
        
        await kv.set(K.LIKES, likes);
        scripts[scriptId] = script;
        await kv.set(K.SCRIPTS, scripts);
        
        res.json({
            success: true,
            isLiked: !isLiked,
            likesCount: script.stats.likes
        });
    } catch (err) {
        console.error('[scriptblox/likes/toggle]', err);
        res.status(500).json({
            error: 'Ошибка переключения лайка',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// FAVORITES: Add to favorites
// ------------------------------------------------------------

router.post('/favorites/:scriptId', requireAuth, async (req, res) => {
    try {
        const { scriptId } = req.params;
        
        const scripts = await kv.get(K.SCRIPTS) || {};
        const script = scripts[scriptId];
        
        if (!script) {
            return res.status(404).json({
                error: 'Скрипт не найден',
                code: 'SCRIPT_NOT_FOUND'
            });
        }
        
        const favorites = await kv.get(K.FAVORITES) || {};
        const userFavorites = favorites[req.userId] || [];
        
        if (userFavorites.includes(scriptId)) {
            return res.status(400).json({
                error: 'Уже в избранном',
                code: 'ALREADY_FAVORITED'
            });
        }
        
        if (userFavorites.length >= CONFIG.MAX_FAVORITES) {
            return res.status(400).json({
                error: 'Достигнут лимит избранного',
                code: 'FAVORITES_LIMIT_REACHED'
            });
        }
        
        userFavorites.push(scriptId);
        favorites[req.userId] = userFavorites;
        await kv.set(K.FAVORITES, favorites);
        
        script.stats = script.stats || createDefaultScriptStats();
        script.stats.favorites = (script.stats.favorites || 0) + 1;
        scripts[scriptId] = script;
        await kv.set(K.SCRIPTS, scripts);
        
        res.json({ success: true });
    } catch (err) {
        console.error('[scriptblox/favorites/add]', err);
        res.status(500).json({
            error: 'Ошибка добавления в избранное',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// FAVORITES: Remove from favorites
// ------------------------------------------------------------

router.delete('/favorites/:scriptId', requireAuth, async (req, res) => {
    try {
        const { scriptId } = req.params;
        
        const favorites = await kv.get(K.FAVORITES) || {};
        const userFavorites = favorites[req.userId] || [];
        
        const index = userFavorites.indexOf(scriptId);
        if (index === -1) {
            return res.status(404).json({
                error: 'Не в избранном',
                code: 'NOT_FAVORITED'
            });
        }
        
        userFavorites.splice(index, 1);
        favorites[req.userId] = userFavorites;
        await kv.set(K.FAVORITES, favorites);
        
        const scripts = await kv.get(K.SCRIPTS) || {};
        const script = scripts[scriptId];
        if (script) {
            script.stats = script.stats || createDefaultScriptStats();
            script.stats.favorites = Math.max(0, (script.stats.favorites || 0) - 1);
            scripts[scriptId] = script;
            await kv.set(K.SCRIPTS, scripts);
        }
        
        res.json({ success: true });
    } catch (err) {
        console.error('[scriptblox/favorites/remove]', err);
        res.status(500).json({
            error: 'Ошибка удаления из избранного',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// FAVORITES: Get my favorites
// ------------------------------------------------------------

router.get('/favorites', requireAuth, async (req, res) => {
    try {
        const { page = 1, limit = CONFIG.SCRIPTS_PER_PAGE } = req.query;
        
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit) || CONFIG.SCRIPTS_PER_PAGE));
        
        const favorites = await kv.get(K.FAVORITES) || {};
        const userFavorites = favorites[req.userId] || [];
        
        const scripts = await kv.get(K.SCRIPTS) || {};
        const users = await kv.get(K.USERS) || {};
        
        const favoriteScripts = userFavorites
            .map(scriptId => scripts[scriptId])
            .filter(Boolean)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        
        const start = (pageNum - 1) * limitNum;
        const end = start + limitNum;
        const paginatedScripts = favoriteScripts.slice(start, end);
        
        const scriptsWithAuthors = paginatedScripts.map(script => {
            const author = users[script.authorId];
            return {
                ...script,
                author: author ? {
                    id: author.id,
                    username: author.username,
                    displayName: author.displayName,
                    avatar: author.avatar
                } : null
            };
        });
        
        res.json({
            scripts: scriptsWithAuthors,
            total: favoriteScripts.length,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(favoriteScripts.length / limitNum)
        });
    } catch (err) {
        console.error('[scriptblox/favorites/get]', err);
        res.status(500).json({
            error: 'Ошибка получения избранного',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// USER: Get user profile
// ------------------------------------------------------------

router.get('/users/:userId', optionalAuth, async (req, res) => {
    try {
        const { userId } = req.params;
        
        const users = await kv.get(K.USERS) || {};
        const user = users[userId];
        
        if (!user) {
            return res.status(404).json({
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }
        
        const scripts = await kv.get(K.SCRIPTS) || {};
        const userScripts = Object.values(scripts)
            .filter(script => script.authorId === userId && script.isPublic)
            .length;
        
        res.json({
            user: {
                id: user.id,
                username: user.username,
                displayName: user.displayName,
                avatar: user.avatar,
                bio: user.bio,
                createdAt: user.createdAt,
                stats: {
                    ...user.stats,
                    scriptsCount: userScripts
                }
            }
        });
    } catch (err) {
        console.error('[scriptblox/users/get]', err);
        res.status(500).json({
            error: 'Ошибка получения профиля',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// USER: Update profile
// ------------------------------------------------------------

router.patch('/users/me', requireAuth, async (req, res) => {
    try {
        const { displayName, bio } = req.body;
        
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];
        
        if (!user) {
            return res.status(404).json({
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }
        
        if (displayName !== undefined) {
            if (displayName.length < 1 || displayName.length > 50) {
                return res.status(400).json({
                    error: 'Имя должно содержать от 1 до 50 символов',
                    code: 'INVALID_DISPLAY_NAME'
                });
            }
            user.displayName = sanitizeString(displayName);
        }
        
        if (bio !== undefined) {
            if (bio.length > 500) {
                return res.status(400).json({
                    error: 'Биография не должна превышать 500 символов',
                    code: 'BIO_TOO_LONG'
                });
            }
            user.bio = sanitizeString(bio);
        }
        
        user.updatedAt = now();
        users[req.userId] = user;
        await kv.set(K.USERS, users);
        
        await logActivity(req.userId, 'profile_updated');
        
        res.json({ success: true });
    } catch (err) {
        console.error('[scriptblox/users/update]', err);
        res.status(500).json({
            error: 'Ошибка обновления профиля',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// CATEGORIES: Get all categories
// ------------------------------------------------------------

router.get('/categories', (req, res) => {
    res.json({
        categories: CONFIG.VALID_CATEGORIES.map(category => ({
            id: category,
            name: category.charAt(0).toUpperCase() + category.slice(1)
        }))
    });
});

// ------------------------------------------------------------
// LANGUAGES: Get all languages
// ------------------------------------------------------------

router.get('/languages', (req, res) => {
    res.json({
        languages: CONFIG.VALID_LANGUAGES.map(language => ({
            id: language,
            name: language.charAt(0).toUpperCase() + language.slice(1)
        }))
    });
});

// ------------------------------------------------------------
// SEARCH: Search scripts
// ------------------------------------------------------------

router.get('/search', optionalAuth, async (req, res) => {
    try {
        const { q, page = 1, limit = CONFIG.SCRIPTS_PER_PAGE } = req.query;
        
        if (!q || typeof q !== 'string') {
            return res.status(400).json({
                error: 'Параметр поиска обязателен',
                code: 'MISSING_QUERY'
            });
        }
        
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit) || CONFIG.SCRIPTS_PER_PAGE));
        
        const scripts = await kv.get(K.SCRIPTS) || {};
        const users = await kv.get(K.USERS) || {};
        
        const searchLower = q.toLowerCase();
        
        const results = Object.values(scripts)
            .filter(script => {
                if (!script.isPublic) return false;
                const titleMatch = script.title.toLowerCase().includes(searchLower);
                const descMatch = script.description?.toLowerCase().includes(searchLower);
                const tagMatch = script.tags?.some(t => t.includes(searchLower));
                const contentMatch = script.content.toLowerCase().includes(searchLower);
                return titleMatch || descMatch || tagMatch || contentMatch;
            })
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        
        const start = (pageNum - 1) * limitNum;
        const end = start + limitNum;
        const paginatedResults = results.slice(start, end);
        
        const resultsWithAuthors = paginatedResults.map(script => {
            const author = users[script.authorId];
            return {
                ...script,
                author: author ? {
                    id: author.id,
                    username: author.username,
                    displayName: author.displayName,
                    avatar: author.avatar
                } : null
            };
        });
        
        res.json({
            results: resultsWithAuthors,
            total: results.length,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(results.length / limitNum),
            query: q
        });
    } catch (err) {
        console.error('[scriptblox/search]', err);
        res.status(500).json({
            error: 'Ошибка поиска',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// REPORTS: Report script
// ------------------------------------------------------------

router.post('/reports', requireAuth, async (req, res) => {
    try {
        const { scriptId, reason, description } = req.body;
        
        if (!scriptId || !reason) {
            return res.status(400).json({
                error: 'scriptId и reason обязательны',
                code: 'MISSING_PARAMS'
            });
        }
        
        const validReasons = ['spam', 'inappropriate', 'copyright', 'other'];
        if (!validReasons.includes(reason)) {
            return res.status(400).json({
                error: 'Неверная причина жалобы',
                code: 'INVALID_REASON'
            });
        }
        
        const scripts = await kv.get(K.SCRIPTS) || {};
        const script = scripts[scriptId];
        
        if (!script) {
            return res.status(404).json({
                error: 'Скрипт не найден',
                code: 'SCRIPT_NOT_FOUND'
            });
        }
        
        const reports = await kv.get(K.REPORTS) || [];
        const existingReport = reports.find(
            r => r.reporterId === req.userId && r.scriptId === scriptId
        );
        
        if (existingReport) {
            return res.status(400).json({
                error: 'Вы уже жаловались на этот скрипт',
                code: 'DUPLICATE_REPORT'
            });
        }
        
        const report = {
            id: generateId(),
            reporterId: req.userId,
            scriptId,
            reason,
            description: description ? sanitizeString(description.slice(0, 1000)) : null,
            createdAt: now(),
            status: 'pending'
        };
        
        reports.push(report);
        await kv.set(K.REPORTS, reports);
        
        await logActivity(req.userId, 'report_submitted', { scriptId, reason });
        
        res.json({
            success: true,
            message: 'Жалоба отправлена'
        });
    } catch (err) {
        console.error('[scriptblox/reports]', err);
        res.status(500).json({
            error: 'Ошибка отправки жалобы',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// STATS: Get user statistics
// ------------------------------------------------------------

router.get('/stats/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const users = await kv.get(K.USERS) || {};
        const user = users[userId];
        
        if (!user) {
            return res.status(404).json({
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }
        
        const scripts = await kv.get(K.SCRIPTS) || {};
        const userScripts = Object.values(scripts)
            .filter(script => script.authorId === userId && script.isPublic);
        
        const totalViews = userScripts.reduce((sum, s) => sum + (s.stats?.views || 0), 0);
        const totalLikes = userScripts.reduce((sum, s) => sum + (s.stats?.likes || 0), 0);
        
        res.json({
            stats: {
                scriptsCount: userScripts.length,
                totalViews,
                totalLikes,
                joinedAt: user.createdAt
            }
        });
    } catch (err) {
        console.error('[scriptblox/stats]', err);
        res.status(500).json({
            error: 'Ошибка получения статистики',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// ERROR HANDLER
// ------------------------------------------------------------

router.use((err, req, res, next) => {
    console.error('[scriptblox error]', err);
    res.status(err.status || 500).json({
        error: err.message || 'Internal Server Error',
        code: err.code || 'INTERNAL_ERROR'
    });
});

module.exports = router;