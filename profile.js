// ============================================================
// МОДУЛЬ: ПРОФИЛИ ПОЛЬЗОВАТЕЛЕЙ
// Полноценная система профилей с авторизацией, друзьями,
// статусами, приватностью, кастомизацией и логами активности
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
    USERS: 'profile:users',
    USERNAME_MAP: 'profile:username_map',
    GOOGLE_MAP: 'profile:google_map',
    SESSIONS: 'profile:sessions',
    USERNAME_HISTORY: (userId) => `profile:username_history:${userId}`,
    NAME_HISTORY: (userId) => `profile:name_history:${userId}`,
    AVATAR_HISTORY: (userId) => `profile:avatar_history:${userId}`,
    THEME_HISTORY: (userId) => `profile:theme_history:${userId}`,
    ACTIVITY_LOG: (userId) => `profile:activity:${userId}`,
    VIEWS: (userId) => `profile:views:${userId}`,
    VIEW_IPS: (userId) => `profile:view_ips:${userId}`,
    COMPLAINTS: 'profile:complaints',
    VERIFICATION: 'profile:verification',
    LAST_ONLINE_UPDATE: 'profile:last_online_update',
    RATE_LIMIT: (ip, action) => `profile:rate:${ip}:${action}`
};

// ------------------------------------------------------------
// КОНФИГУРАЦИЯ
// ------------------------------------------------------------
const CONFIG = {
    SESSION_TTL: 30 * 24 * 60 * 60 * 1000,
    USERNAME_MIN_LENGTH: 3,
    USERNAME_MAX_LENGTH: 30,
    USERNAME_REGEX: /^[a-zA-Z0-9_]+$/,
    DISPLAY_NAME_MIN_LENGTH: 1,
    DISPLAY_NAME_MAX_LENGTH: 50,
    BIO_MAX_LENGTH: 500,
    STATUS_TEXT_MAX_LENGTH: 100,
    AVATAR_MAX_SIZE: 5 * 1024 * 1024,
    AVATAR_ALLOWED_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    RESERVED_USERNAMES: [
        'admin', 'administrator', 'root', 'system', 'moderator', 'mod',
        'support', 'help', 'api', 'auth', 'login', 'logout', 'register',
        'signup', 'signin', 'profile', 'settings', 'dashboard', 'account',
        'public', 'private', 'search', 'catalog', 'news', 'status',
        'undefined', 'null', 'true', 'false', 'index', 'home', 'main',
        'test', 'demo', 'sample', 'example', 'temp', 'tmp', 'backup',
        'new', 'old', 'default', 'user', 'guest', 'visitor', 'anonymous',
        'oris', 'getli', 'json-studio', 'calculator', 'timer', 'wheel'
    ],
    FORBIDDEN_BIO_PATTERNS: [
        /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
        /javascript\s*:/gi,
        /on\w+\s*=/gi,
        /eval\s*\(/gi,
        /document\.\w+/gi
    ],
    MAX_FRIENDS: 5000,
    MAX_FOLLOWING: 5000,
    MAX_FAVORITES: 1000,
    MAX_PINNED_FRIENDS: 10,
    MAX_SOCIAL_LINKS: 10,
    MAX_BADGES: 20,
    MAX_ACHIEVEMENTS: 50,
    ACTIVITY_LOG_LIMIT: 200,
    VIEWS_HISTORY_LIMIT: 100,
    RATE_LIMIT_WINDOW: 60 * 1000,
    RATE_LIMIT_MAX: 60,
    ONLINE_UPDATE_INTERVAL: 5 * 60 * 1000
};

// ------------------------------------------------------------
// УТИЛИТЫ
// ------------------------------------------------------------

function generateUserId() {
    return 'usr_' + crypto.randomBytes(16).toString('hex');
}

function generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
}

function generateUsernameId() {
    return crypto.randomBytes(8).toString('hex');
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

function sanitizeBio(bio) {
    if (typeof bio !== 'string') return '';
    let cleaned = bio.trim();
    for (const pattern of CONFIG.FORBIDDEN_BIO_PATTERNS) {
        cleaned = cleaned.replace(pattern, '');
    }
    return cleaned;
}

function isValidUsername(username) {
    if (typeof username !== 'string') return false;
    if (username.length < CONFIG.USERNAME_MIN_LENGTH) return false;
    if (username.length > CONFIG.USERNAME_MAX_LENGTH) return false;
    if (!CONFIG.USERNAME_REGEX.test(username)) return false;
    if (CONFIG.RESERVED_USERNAMES.includes(username.toLowerCase())) return false;
    return true;
}

function isValidDisplayName(name) {
    if (typeof name !== 'string') return false;
    if (name.length < CONFIG.DISPLAY_NAME_MIN_LENGTH) return false;
    if (name.length > CONFIG.DISPLAY_NAME_MAX_LENGTH) return false;
    return true;
}

function isValidBio(bio) {
    if (typeof bio !== 'string') return false;
    return bio.length <= CONFIG.BIO_MAX_LENGTH;
}

function isValidStatusText(text) {
    if (typeof text !== 'string') return false;
    return text.length <= CONFIG.STATUS_TEXT_MAX_LENGTH;
}

function isValidUrl(url) {
    try {
        const parsed = new URL(url);
        return ['http:', 'https:'].includes(parsed.protocol);
    } catch {
        return false;
    }
}

function isValidSocialUrl(url) {
    if (!url) return true;
    return isValidUrl(url);
}

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function getRemoteIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.ip ||
           'unknown';
}

function now() {
    return new Date().toISOString();
}

function timestamp() {
    return Date.now();
}

// ------------------------------------------------------------
// DEFAULT DATA FACTORIES
// ------------------------------------------------------------

function createDefaultSettings() {
    return {
        language: 'ru',
        notifications: {
            friendRequests: true,
            friendAccepted: true,
            profileViews: false,
            messages: true,
            mentions: true,
            email: false
        },
        display: {
            showBadges: true,
            showAchievements: true,
            showSocials: true,
            showStats: true,
            compactMode: false
        },
        autoSave: true,
        autoSaveInterval: 30000
    };
}

function createDefaultPrivacy() {
    return {
        profileVisible: true,
        showFriends: true,
        showStatus: true,
        allowSearch: true,
        allowFriendRequests: true,
        hideRegistrationDate: false,
        hideActivity: false,
        hideProfileViews: false,
        showSocials: true,
        showBadges: true,
        showAchievements: true
    };
}

function createDefaultCustomization() {
    return {
        theme: 'system',
        backgroundColor: null,
        gradient: null,
        backgroundImage: null,
        coverImage: null,
        profileBackground: null,
        textColor: null,
        linkColor: null,
        buttonColor: null,
        cardColor: null,
        borderColor: null,
        borderRadius: null,
        borderWidth: null,
        opacity: null,
        fontFamily: null,
        fontSize: null,
        hoverEffects: true,
        animations: true,
        cardStyle: 'default',
        blockStyle: 'default',
        layout: 'default',
        customCss: null
    };
}

function createDefaultStatistics() {
    return {
        profileViews: 0,
        friendCount: 0,
        followerCount: 0,
        followingCount: 0,
        postsCount: 0,
        commentsCount: 0,
        likesReceived: 0,
        likesGiven: 0,
        accountAge: 0
    };
}

function createDefaultStatus() {
    return {
        state: 'online',
        text: null,
        updatedAt: now(),
        pinned: false
    };
}

// ------------------------------------------------------------
// RATE LIMITING
// ------------------------------------------------------------

async function checkRateLimit(ip, action, maxRequests = CONFIG.RATE_LIMIT_MAX) {
    const key = K.RATE_LIMIT(ip, action);
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
    const token = req.headers.authorization?.replace('Bearer ', '') ||
                  req.cookies?.session_token;

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
    const token = req.headers.authorization?.replace('Bearer ', '') ||
                  req.cookies?.session_token;

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
    const key = K.ACTIVITY_LOG(userId);
    const log = await kv.get(key) || [];

    log.unshift({
        id: crypto.randomBytes(8).toString('hex'),
        action,
        details,
        timestamp: now(),
        ip: details.ip || null
    });

    if (log.length > CONFIG.ACTIVITY_LOG_LIMIT) {
        log.length = CONFIG.ACTIVITY_LOG_LIMIT;
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

        // Проверяем, существует ли пользователь
        const googleMap = await kv.get(K.GOOGLE_MAP) || {};
        let userId = googleMap[googleId];
        let user;

        if (userId) {
            // Существующий пользователь
            const users = await kv.get(K.USERS) || {};
            user = users[userId];

            if (!user) {
                delete googleMap[googleId];
                await kv.set(K.GOOGLE_MAP, googleMap);
                userId = null;
            }
        }

        if (!userId) {
            // Новый пользователь
            userId = generateUserId();

            // Генерируем уникальный username
            let username = name.toLowerCase()
                .replace(/[^a-z0-9_]/g, '_')
                .replace(/_+/g, '_')
                .slice(0, CONFIG.USERNAME_MAX_LENGTH);

            if (!username || username.length < CONFIG.USERNAME_MIN_LENGTH) {
                username = 'user_' + crypto.randomBytes(4).toString('hex');
            }

            // Проверяем уникальность username
            const usernameMap = await kv.get(K.USERNAME_MAP) || {};
            let finalUsername = username;
            let counter = 1;

            while (usernameMap[finalUsername]) {
                finalUsername = username + '_' + counter;
                counter++;
            }

            user = {
                id: userId,
                googleId,
                email,
                username: finalUsername,
                displayName: name,
                avatar: picture || null,
                bio: '',
                theme: 'system',
                status: createDefaultStatus(),
                visibility: 'public',
                createdAt: now(),
                updatedAt: now(),
                lastSeen: now(),
                online: true,
                friends: [],
                friendRequests: {
                    incoming: [],
                    outgoing: []
                },
                blockedUsers: [],
                followers: [],
                following: [],
                favorites: [],
                pinnedFriends: [],
                profileViews: 0,
                customization: createDefaultCustomization(),
                statistics: createDefaultStatistics(),
                settings: createDefaultSettings(),
                privacy: createDefaultPrivacy(),
                socials: {
                    github: null,
                    discord: null,
                    telegram: null,
                    youtube: null,
                    website: null
                },
                badges: [],
                achievements: [],
                verified: false,
                roles: ['user']
            };

            // Сохраняем пользователя
            const users = await kv.get(K.USERS) || {};
            users[userId] = user;
            await kv.set(K.USERS, users);

            // Сохраняем маппинги
            googleMap[googleId] = userId;
            await kv.set(K.GOOGLE_MAP, googleMap);

            usernameMap[finalUsername] = userId;
            await kv.set(K.USERNAME_MAP, usernameMap);

            // Логируем регистрацию
            await logActivity(userId, 'register', {
                email,
                username: finalUsername
            });

            // Сохраняем историю username
            const usernameHistory = await kv.get(K.USERNAME_HISTORY(userId)) || [];
            usernameHistory.push({
                username: finalUsername,
                changedAt: now(),
                previous: null
            });
            await kv.set(K.USERNAME_HISTORY(userId), usernameHistory);
        } else {
            // Обновляем lastSeen и online
            user.lastSeen = now();
            user.online = true;
            user.updatedAt = now();

            const users = await kv.get(K.USERS) || {};
            users[userId] = user;
            await kv.set(K.USERS, users);

            await logActivity(userId, 'login', {
                method: 'google'
            });
        }

        // Создаём сессию
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
        console.error('[profile/auth/google]', err);
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

        // Обновляем статус пользователя
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (user) {
            user.online = false;
            user.lastSeen = now();
            user.updatedAt = now();
            users[req.userId] = user;
            await kv.set(K.USERS, users);

            await logActivity(req.userId, 'logout');
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[profile/auth/logout]', err);
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

        res.json({ user: sanitizeUserForResponse(user, req.userId) });
    } catch (err) {
        console.error('[profile/auth/me]', err);
        res.status(500).json({
            error: 'Ошибка получения профиля',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// AUTH: Refresh session
// ------------------------------------------------------------

router.post('/auth/refresh', requireAuth, async (req, res) => {
    try {
        const sessions = await kv.get(K.SESSIONS) || {};
        const oldSession = sessions[req.sessionId];

        if (!oldSession) {
            return res.status(401).json({
                error: 'Сессия не найдена',
                code: 'SESSION_NOT_FOUND'
            });
        }

        // Удаляем старую сессию
        delete sessions[req.sessionId];

        // Создаём новую
        const newToken = generateSessionToken();
        sessions[newToken] = {
            userId: oldSession.userId,
            email: oldSession.email,
            createdAt: now(),
            expiresAt: timestamp() + CONFIG.SESSION_TTL
        };

        await kv.set(K.SESSIONS, sessions);

        res.json({
            success: true,
            token: newToken,
            expiresAt: sessions[newToken].expiresAt
        });
    } catch (err) {
        console.error('[profile/auth/refresh]', err);
        res.status(500).json({
            error: 'Ошибка обновления токена',
            code: 'REFRESH_ERROR'
        });
    }
});

// ------------------------------------------------------------
// PROFILE: Get own profile
// ------------------------------------------------------------

router.get('/', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        res.json({
            profile: sanitizeUserForResponse(user, req.userId, true)
        });
    } catch (err) {
        console.error('[profile/get]', err);
        res.status(500).json({
            error: 'Ошибка получения профиля',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// PROFILE: Get profile by username
// ------------------------------------------------------------

router.get('/@:username', optionalAuth, async (req, res) => {
    try {
        const username = req.params.username.toLowerCase();

        if (!isValidUsername(username)) {
            return res.status(400).json({
                error: 'Неверный формат username',
                code: 'INVALID_USERNAME'
            });
        }

        const usernameMap = await kv.get(K.USERNAME_MAP) || {};
        const userId = usernameMap[username];

        if (!userId) {
            return res.status(404).json({
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }

        const users = await kv.get(K.USERS) || {};
        const user = users[userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        // Проверяем приватность
        const isOwner = req.userId === userId;
        const privacy = user.privacy || createDefaultPrivacy();

        if (!isOwner && !privacy.profileVisible) {
            return res.status(403).json({
                error: 'Профиль скрыт владельцем',
                code: 'PROFILE_HIDDEN'
            });
        }

        // Регистрируем просмотр
        if (!isOwner) {
            await registerProfileView(userId, req);
        }

        res.json({
            profile: sanitizeUserForResponse(user, req.userId, isOwner)
        });
    } catch (err) {
        console.error('[profile/get-by-username]', err);
        res.status(500).json({
            error: 'Ошибка получения профиля',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// PROFILE: Update profile
// ------------------------------------------------------------

router.patch('/', requireAuth, async (req, res) => {
    try {
        const { displayName, bio, socials } = req.body;

        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        const changes = {};

        // Обновление displayName
        if (displayName !== undefined) {
            if (!isValidDisplayName(displayName)) {
                return res.status(400).json({
                    error: 'Неверное отображаемое имя (1-50 символов)',
                    code: 'INVALID_DISPLAY_NAME'
                });
            }

            const oldName = user.displayName;
            user.displayName = sanitizeString(displayName);
            user.updatedAt = now();
            changes.displayName = { from: oldName, to: user.displayName };

            // Логируем изменение имени
            const nameHistory = await kv.get(K.NAME_HISTORY(req.userId)) || [];
            nameHistory.unshift({
                name: oldName,
                changedAt: now()
            });
            if (nameHistory.length > 50) nameHistory.length = 50;
            await kv.set(K.NAME_HISTORY(req.userId), nameHistory);
        }

        // Обновление bio
        if (bio !== undefined) {
            const cleaned = sanitizeBio(bio);
            if (!isValidBio(cleaned)) {
                return res.status(400).json({
                    error: 'Биография слишком длинная (макс. 500 символов)',
                    code: 'BIO_TOO_LONG'
                });
            }

            user.bio = cleaned;
            user.updatedAt = now();
            changes.bio = true;
        }

        // Обновление соцсетей
        if (socials !== undefined) {
            if (typeof socials !== 'object' || socials === null) {
                return res.status(400).json({
                    error: 'Неверный формат socials',
                    code: 'INVALID_SOCIALS'
                });
            }

            const allowedSocials = ['github', 'discord', 'telegram', 'youtube', 'website'];
            const updatedSocials = { ...user.socials };

            for (const key of allowedSocials) {
                if (key in socials) {
                    const value = socials[key];
                    if (value !== null && !isValidSocialUrl(value) && key !== 'discord') {
                        return res.status(400).json({
                            error: `Неверный URL для ${key}`,
                            code: 'INVALID_SOCIAL_URL'
                        });
                    }
                    updatedSocials[key] = value;
                }
            }

            user.socials = updatedSocials;
            user.updatedAt = now();
            changes.socials = true;
        }

        users[req.userId] = user;
        await kv.set(K.USERS, users);

        await logActivity(req.userId, 'profile_update', { changes });

        res.json({
            success: true,
            profile: sanitizeUserForResponse(user, req.userId, true)
        });
    } catch (err) {
        console.error('[profile/update]', err);
        res.status(500).json({
            error: 'Ошибка обновления профиля',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// PROFILE: Delete profile
// ------------------------------------------------------------

router.delete('/', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        // Удаляем маппинги
        const usernameMap = await kv.get(K.USERNAME_MAP) || {};
        delete usernameMap[user.username];
        await kv.set(K.USERNAME_MAP, usernameMap);

        const googleMap = await kv.get(K.GOOGLE_MAP) || {};
        delete googleMap[user.googleId];
        await kv.set(K.GOOGLE_MAP, googleMap);

        // Удаляем сессии
        const sessions = await kv.get(K.SESSIONS) || {};
        for (const [token, session] of Object.entries(sessions)) {
            if (session.userId === req.userId) {
                delete sessions[token];
            }
        }
        await kv.set(K.SESSIONS, sessions);

        // Удаляем пользователя
        delete users[req.userId];
        await kv.set(K.USERS, users);

        // Удаляем связанные данные
        await kv.del(K.ACTIVITY_LOG(req.userId));
        await kv.del(K.VIEWS(req.userId));
        await kv.del(K.VIEW_IPS(req.userId));
        await kv.del(K.USERNAME_HISTORY(req.userId));
        await kv.del(K.NAME_HISTORY(req.userId));
        await kv.del(K.AVATAR_HISTORY(req.userId));
        await kv.del(K.THEME_HISTORY(req.userId));

        await logActivity(req.userId, 'account_deleted');

        res.json({
            success: true,
            message: 'Профиль удалён'
        });
    } catch (err) {
        console.error('[profile/delete]', err);
        res.status(500).json({
            error: 'Ошибка удаления профиля',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// PROFILE: Change username
// ------------------------------------------------------------

router.patch('/username', requireAuth, async (req, res) => {
    try {
        const { username } = req.body;

        if (!username || typeof username !== 'string') {
            return res.status(400).json({
                error: 'Username обязателен',
                code: 'MISSING_USERNAME'
            });
        }

        const newUsername = username.toLowerCase();

        if (!isValidUsername(newUsername)) {
            return res.status(400).json({
                error: 'Неверный формат username (3-30 символов, только a-z, 0-9, _)',
                code: 'INVALID_USERNAME'
            });
        }

        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        // Проверяем, не занят ли username
        const usernameMap = await kv.get(K.USERNAME_MAP) || {};

        if (usernameMap[newUsername] && usernameMap[newUsername] !== req.userId) {
            return res.status(409).json({
                error: 'Этот username уже занят',
                code: 'USERNAME_TAKEN'
            });
        }

        const oldUsername = user.username;
        user.username = newUsername;
        user.updatedAt = now();

        // Обновляем маппинг
        if (usernameMap[oldUsername] === req.userId) {
            delete usernameMap[oldUsername];
        }
        usernameMap[newUsername] = req.userId;

        users[req.userId] = user;
        await kv.set(K.USERS, users);
        await kv.set(K.USERNAME_MAP, usernameMap);

        // Сохраняем историю
        const usernameHistory = await kv.get(K.USERNAME_HISTORY(req.userId)) || [];
        usernameHistory.unshift({
            username: newUsername,
            changedAt: now(),
            previous: oldUsername
        });
        if (usernameHistory.length > 50) usernameHistory.length = 50;
        await kv.set(K.USERNAME_HISTORY(req.userId), usernameHistory);

        await logActivity(req.userId, 'username_change', {
            from: oldUsername,
            to: newUsername
        });

        res.json({
            success: true,
            username: newUsername,
            previousUsername: oldUsername
        });
    } catch (err) {
        console.error('[profile/username]', err);
        res.status(500).json({
            error: 'Ошибка смены username',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// PROFILE: Username history
// ------------------------------------------------------------

router.get('/username-history', requireAuth, async (req, res) => {
    try {
        const history = await kv.get(K.USERNAME_HISTORY(req.userId)) || [];
        res.json({ history });
    } catch (err) {
        console.error('[profile/username-history]', err);
        res.status(500).json({
            error: 'Ошибка получения истории',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// PROFILE: Name history
// ------------------------------------------------------------

router.get('/name-history', requireAuth, async (req, res) => {
    try {
        const history = await kv.get(K.NAME_HISTORY(req.userId)) || [];
        res.json({ history });
    } catch (err) {
        console.error('[profile/name-history]', err);
        res.status(500).json({
            error: 'Ошибка получения истории',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// PROFILE: Avatar history
// ------------------------------------------------------------

router.get('/avatar-history', requireAuth, async (req, res) => {
    try {
        const history = await kv.get(K.AVATAR_HISTORY(req.userId)) || [];
        res.json({ history });
    } catch (err) {
        console.error('[profile/avatar-history]', err);
        res.status(500).json({
            error: 'Ошибка получения истории',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// PROFILE: Theme history
// ------------------------------------------------------------

router.get('/theme-history', requireAuth, async (req, res) => {
    try {
        const history = await kv.get(K.THEME_HISTORY(req.userId)) || [];
        res.json({ history });
    } catch (err) {
        console.error('[profile/theme-history]', err);
        res.status(500).json({
            error: 'Ошибка получения истории',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// PROFILE: Check username availability
// ------------------------------------------------------------

router.get('/check-username/:username', async (req, res) => {
    try {
        const username = req.params.username.toLowerCase();

        if (!isValidUsername(username)) {
            return res.json({
                available: false,
                reason: 'Неверный формат (3-30 символов, только a-z, 0-9, _)'
            });
        }

        const usernameMap = await kv.get(K.USERNAME_MAP) || {};
        const taken = !!usernameMap[username];

        res.json({
            available: !taken,
            username
        });
    } catch (err) {
        console.error('[profile/check-username]', err);
        res.status(500).json({
            error: 'Ошибка проверки',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// PROFILE: Settings
// ------------------------------------------------------------

router.get('/settings', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        res.json({
            settings: user.settings || createDefaultSettings()
        });
    } catch (err) {
        console.error('[profile/settings/get]', err);
        res.status(500).json({
            error: 'Ошибка получения настроек',
            code: 'INTERNAL_ERROR'
        });
    }
});

router.patch('/settings', requireAuth, async (req, res) => {
    try {
        const { settings } = req.body;

        if (!settings || typeof settings !== 'object') {
            return res.status(400).json({
                error: 'Неверный формат настроек',
                code: 'INVALID_SETTINGS'
            });
        }

        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        // Обновляем только разрешённые поля
        const allowedSettings = ['language', 'notifications', 'display', 'autoSave', 'autoSaveInterval'];
        const updatedSettings = { ...user.settings };

        for (const key of allowedSettings) {
            if (key in settings) {
                updatedSettings[key] = settings[key];
            }
        }

        user.settings = updatedSettings;
        user.updatedAt = now();

        users[req.userId] = user;
        await kv.set(K.USERS, users);

        await logActivity(req.userId, 'settings_update');

        res.json({
            success: true,
            settings: updatedSettings
        });
    } catch (err) {
        console.error('[profile/settings/update]', err);
        res.status(500).json({
            error: 'Ошибка обновления настроек',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// PROFILE: Privacy
// ------------------------------------------------------------

router.get('/privacy', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        res.json({
            privacy: user.privacy || createDefaultPrivacy()
        });
    } catch (err) {
        console.error('[profile/privacy/get]', err);
        res.status(500).json({
            error: 'Ошибка получения настроек приватности',
            code: 'INTERNAL_ERROR'
        });
    }
});

router.patch('/privacy', requireAuth, async (req, res) => {
    try {
        const { privacy } = req.body;

        if (!privacy || typeof privacy !== 'object') {
            return res.status(400).json({
                error: 'Неверный формат настроек приватности',
                code: 'INVALID_PRIVACY'
            });
        }

        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        const allowedPrivacy = [
            'profileVisible', 'showFriends', 'showStatus',
            'allowSearch', 'allowFriendRequests',
            'hideRegistrationDate', 'hideActivity',
            'hideProfileViews', 'showSocials',
            'showBadges', 'showAchievements'
        ];

        const updatedPrivacy = { ...user.privacy };

        for (const key of allowedPrivacy) {
            if (key in privacy) {
                updatedPrivacy[key] = Boolean(privacy[key]);
            }
        }

        user.privacy = updatedPrivacy;
        user.updatedAt = now();

        users[req.userId] = user;
        await kv.set(K.USERS, users);

        await logActivity(req.userId, 'privacy_update');

        res.json({
            success: true,
            privacy: updatedPrivacy
        });
    } catch (err) {
        console.error('[profile/privacy/update]', err);
        res.status(500).json({
            error: 'Ошибка обновления приватности',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// PROFILE: Theme
// ------------------------------------------------------------

router.get('/theme', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        res.json({
            theme: user.customization?.theme || 'system'
        });
    } catch (err) {
        console.error('[profile/theme/get]', err);
        res.status(500).json({
            error: 'Ошибка получения темы',
            code: 'INTERNAL_ERROR'
        });
    }
});

router.patch('/theme', requireAuth, async (req, res) => {
    try {
        const { theme } = req.body;

        if (!theme || !['light', 'dark', 'system'].includes(theme)) {
            return res.status(400).json({
                error: 'Тема должна быть light, dark или system',
                code: 'INVALID_THEME'
            });
        }

        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        const oldTheme = user.customization?.theme || 'system';
        user.customization = user.customization || createDefaultCustomization();
        user.customization.theme = theme;
        user.updatedAt = now();

        users[req.userId] = user;
        await kv.set(K.USERS, users);

        // Сохраняем историю
        const themeHistory = await kv.get(K.THEME_HISTORY(req.userId)) || [];
        themeHistory.unshift({
            theme,
            changedAt: now(),
            previous: oldTheme
        });
        if (themeHistory.length > 50) themeHistory.length = 50;
        await kv.set(K.THEME_HISTORY(req.userId), themeHistory);

        await logActivity(req.userId, 'theme_change', {
            from: oldTheme,
            to: theme
        });

        res.json({
            success: true,
            theme
        });
    } catch (err) {
        console.error('[profile/theme/update]', err);
        res.status(500).json({
            error: 'Ошибка обновления темы',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// PROFILE: Customization
// ------------------------------------------------------------

router.get('/customization', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        res.json({
            customization: user.customization || createDefaultCustomization()
        });
    } catch (err) {
        console.error('[profile/customization/get]', err);
        res.status(500).json({
            error: 'Ошибка получения кастомизации',
            code: 'INTERNAL_ERROR'
        });
    }
});

router.patch('/customization', requireAuth, async (req, res) => {
    try {
        const { customization } = req.body;

        if (!customization || typeof customization !== 'object') {
            return res.status(400).json({
                error: 'Неверный формат кастомизации',
                code: 'INVALID_CUSTOMIZATION'
            });
        }

        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        const allowedFields = [
            'backgroundColor', 'gradient', 'backgroundImage',
            'coverImage', 'profileBackground', 'textColor',
            'linkColor', 'buttonColor', 'cardColor', 'borderColor',
            'borderRadius', 'borderWidth', 'opacity',
            'fontFamily', 'fontSize', 'hoverEffects',
            'animations', 'cardStyle', 'blockStyle',
            'layout', 'customCss'
        ];

        const updatedCustomization = {
            ...(user.customization || createDefaultCustomization())
        };

        for (const field of allowedFields) {
            if (field in customization) {
                updatedCustomization[field] = customization[field];
            }
        }

        user.customization = updatedCustomization;
        user.updatedAt = now();

        users[req.userId] = user;
        await kv.set(K.USERS, users);

        await logActivity(req.userId, 'customization_update');

        res.json({
            success: true,
            customization: updatedCustomization
        });
    } catch (err) {
        console.error('[profile/customization/update]', err);
        res.status(500).json({
            error: 'Ошибка обновления кастомизации',
            code: 'INTERNAL_ERROR'
        });
    }
});

router.post('/customization/reset', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        user.customization = createDefaultCustomization();
        user.updatedAt = now();

        users[req.userId] = user;
        await kv.set(K.USERS, users);

        await logActivity(req.userId, 'customization_reset');

        res.json({
            success: true,
            customization: user.customization
        });
    } catch (err) {
        console.error('[profile/customization/reset]', err);
        res.status(500).json({
            error: 'Ошибка сброса кастомизации',
            code: 'INTERNAL_ERROR'
        });
    }
});

router.post('/customization/export', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        const exportData = {
            version: '1.0.0',
            exportedAt: now(),
            username: user.username,
            customization: user.customization || createDefaultCustomization(),
            theme: user.theme || 'system'
        };

        res.json({
            success: true,
            data: exportData
        });
    } catch (err) {
        console.error('[profile/customization/export]', err);
        res.status(500).json({
            error: 'Ошибка экспорта',
            code: 'INTERNAL_ERROR'
        });
    }
});

router.post('/customization/import', requireAuth, async (req, res) => {
    try {
        const { data } = req.body;

        if (!data || !data.customization) {
            return res.status(400).json({
                error: 'Неверный формат данных импорта',
                code: 'INVALID_IMPORT_DATA'
            });
        }

        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        user.customization = {
            ...createDefaultCustomization(),
            ...data.customization
        };

        if (data.theme) {
            user.customization.theme = data.theme;
        }

        user.updatedAt = now();

        users[req.userId] = user;
        await kv.set(K.USERS, users);

        await logActivity(req.userId, 'customization_import');

        res.json({
            success: true,
            customization: user.customization
        });
    } catch (err) {
        console.error('[profile/customization/import]', err);
        res.status(500).json({
            error: 'Ошибка импорта',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// PROFILE: Avatar
// ------------------------------------------------------------

router.post('/avatar', requireAuth, async (req, res) => {
    try {
        const { avatar } = req.body;

        if (!avatar || typeof avatar !== 'string') {
            return res.status(400).json({
                error: 'Аватар обязателен',
                code: 'MISSING_AVATAR'
            });
        }

        // Проверяем, что это валидный URL или base64
        if (!avatar.startsWith('data:image/') && !isValidUrl(avatar)) {
            return res.status(400).json({
                error: 'Неверный формат аватара',
                code: 'INVALID_AVATAR'
            });
        }

        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        const oldAvatar = user.avatar;
        user.avatar = avatar;
        user.updatedAt = now();

        users[req.userId] = user;
        await kv.set(K.USERS, users);

        // Сохраняем историю
        const avatarHistory = await kv.get(K.AVATAR_HISTORY(req.userId)) || [];
        avatarHistory.unshift({
            avatar: avatar.slice(0, 100) + (avatar.length > 100 ? '...' : ''),
            changedAt: now(),
            previous: oldAvatar
        });
        if (avatarHistory.length > 50) avatarHistory.length = 50;
        await kv.set(K.AVATAR_HISTORY(req.userId), avatarHistory);

        await logActivity(req.userId, 'avatar_change');

        res.json({
            success: true,
            avatar
        });
    } catch (err) {
        console.error('[profile/avatar]', err);
        res.status(500).json({
            error: 'Ошибка обновления аватара',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// PROFILE: Status
// ------------------------------------------------------------

router.get('/status', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        res.json({
            status: user.status || createDefaultStatus()
        });
    } catch (err) {
        console.error('[profile/status/get]', err);
        res.status(500).json({
            error: 'Ошибка получения статуса',
            code: 'INTERNAL_ERROR'
        });
    }
});

router.patch('/status', requireAuth, async (req, res) => {
    try {
        const { state, text, pinned } = req.body;

        const validStates = ['online', 'idle', 'busy', 'dnd', 'invisible', 'offline'];

        if (state && !validStates.includes(state)) {
            return res.status(400).json({
                error: 'Неверный статус. Допустимые: online, idle, busy, dnd, invisible, offline',
                code: 'INVALID_STATUS'
            });
        }

        if (text !== undefined && !isValidStatusText(text)) {
            return res.status(400).json({
                error: 'Текст статуса слишком длинный (макс. 100 символов)',
                code: 'STATUS_TEXT_TOO_LONG'
            });
        }

        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        const oldStatus = { ...user.status };

        user.status = user.status || createDefaultStatus();

        if (state) user.status.state = state;
        if (text !== undefined) user.status.text = text;
        if (pinned !== undefined) user.status.pinned = Boolean(pinned);

        user.status.updatedAt = now();
        user.updatedAt = now();

        if (state === 'offline' || state === 'invisible') {
            user.online = false;
        } else if (state) {
            user.online = true;
        }

        users[req.userId] = user;
        await kv.set(K.USERS, users);

        await logActivity(req.userId, 'status_change', {
            from: oldStatus,
            to: user.status
        });

        res.json({
            success: true,
            status: user.status
        });
    } catch (err) {
        console.error('[profile/status/update]', err);
        res.status(500).json({
            error: 'Ошибка обновления статуса',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// PROFILE: Activity log
// ------------------------------------------------------------

router.get('/activity', requireAuth, async (req, res) => {
    try {
        const log = await kv.get(K.ACTIVITY_LOG(req.userId)) || [];
        res.json({ activity: log });
    } catch (err) {
        console.error('[profile/activity]', err);
        res.status(500).json({
            error: 'Ошибка получения активности',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// FRIENDS: Send request
// ------------------------------------------------------------

router.post('/friends/request', requireAuth, async (req, res) => {
    try {
        const { userId: targetUserId, username } = req.body;

        let targetId = targetUserId;

        if (username) {
            const usernameMap = await kv.get(K.USERNAME_MAP) || {};
            targetId = usernameMap[username.toLowerCase()];
        }

        if (!targetId) {
            return res.status(404).json({
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }

        if (targetId === req.userId) {
            return res.status(400).json({
                error: 'Нельзя отправить запрос себе',
                code: 'SELF_FRIEND_REQUEST'
            });
        }

        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];
        const target = users[targetId];

        if (!user || !target) {
            return res.status(404).json({
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }

        // Проверяем приватность
        const targetPrivacy = target.privacy || createDefaultPrivacy();
        if (!targetPrivacy.allowFriendRequests) {
            return res.status(403).json({
                error: 'Пользователь не принимает запросы в друзья',
                code: 'FRIEND_REQUESTS_DISABLED'
            });
        }

        // Проверяем, не заблокирован ли пользователь
        if (target.blockedUsers?.includes(req.userId)) {
            return res.status(403).json({
                error: 'Вы заблокированы этим пользователем',
                code: 'BLOCKED_BY_USER'
            });
        }

        // Проверяем, не являются ли уже друзьями
        if (user.friends?.includes(targetId)) {
            return res.status(400).json({
                error: 'Вы уже друзья',
                code: 'ALREADY_FRIENDS'
            });
        }

        // Проверяем исходящие заявки
        if (user.friendRequests?.outgoing?.includes(targetId)) {
            return res.status(400).json({
                error: 'Запрос уже отправлен',
                code: 'REQUEST_ALREADY_SENT'
            });
        }

        // Проверяем входящие заявки
        if (user.friendRequests?.incoming?.includes(targetId)) {
            return res.status(400).json({
                error: 'У вас уже есть запрос от этого пользователя',
                code: 'REQUEST_ALREADY_RECEIVED'
            });
        }

        // Проверяем лимит друзей
        if ((user.friends?.length || 0) >= CONFIG.MAX_FRIENDS) {
            return res.status(400).json({
                error: 'Достигнут лимит друзей',
                code: 'FRIEND_LIMIT_REACHED'
            });
        }

        // Добавляем в исходящие заявки
        user.friendRequests = user.friendRequests || { incoming: [], outgoing: [] };
        user.friendRequests.outgoing.push(targetId);

        // Добавляем во входящие заявки целевого пользователя
        target.friendRequests = target.friendRequests || { incoming: [], outgoing: [] };
        target.friendRequests.incoming.push(req.userId);

        users[req.userId] = user;
        users[targetId] = target;
        await kv.set(K.USERS, users);

        await logActivity(req.userId, 'friend_request_sent', {
            targetId,
            targetUsername: target.username
        });

        await logActivity(targetId, 'friend_request_received', {
            fromUserId: req.userId,
            fromUsername: user.username
        });

        res.json({
            success: true,
            message: 'Запрос в друзья отправлен'
        });
    } catch (err) {
        console.error('[profile/friends/request]', err);
        res.status(500).json({
            error: 'Ошибка отправки запроса',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// FRIENDS: Accept request
// ------------------------------------------------------------

router.post('/friends/accept', requireAuth, async (req, res) => {
    try {
        const { userId: requesterId, username } = req.body;

        let requesterUserId = requesterId;

        if (username) {
            const usernameMap = await kv.get(K.USERNAME_MAP) || {};
            requesterUserId = usernameMap[username.toLowerCase()];
        }

        if (!requesterUserId) {
            return res.status(404).json({
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }

        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];
        const requester = users[requesterUserId];

        if (!user || !requester) {
            return res.status(404).json({
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }

        // Проверяем, есть ли входящий запрос
        if (!user.friendRequests?.incoming?.includes(requesterUserId)) {
            return res.status(404).json({
                error: 'Запрос не найден',
                code: 'REQUEST_NOT_FOUND'
            });
        }

        // Проверяем лимит
        if ((user.friends?.length || 0) >= CONFIG.MAX_FRIENDS) {
            return res.status(400).json({
                error: 'Достигнут лимит друзей',
                code: 'FRIEND_LIMIT_REACHED'
            });
        }

        // Добавляем в друзья
        user.friends = user.friends || [];
        user.friends.push(requesterUserId);

        requester.friends = requester.friends || [];
        requester.friends.push(req.userId);

        // Удаляем из заявок
        user.friendRequests.incoming = user.friendRequests.incoming.filter(
            id => id !== requesterUserId
        );
        requester.friendRequests.outgoing = requester.friendRequests.outgoing.filter(
            id => id !== req.userId
        );

        // Обновляем статистику
        user.statistics = user.statistics || createDefaultStatistics();
        user.statistics.friendCount = user.friends.length;

        requester.statistics = requester.statistics || createDefaultStatistics();
        requester.statistics.friendCount = requester.friends.length;

        user.updatedAt = now();
        requester.updatedAt = now();

        users[req.userId] = user;
        users[requesterUserId] = requester;
        await kv.set(K.USERS, users);

        await logActivity(req.userId, 'friend_accepted', {
            userId: requesterUserId,
            username: requester.username
        });

        await logActivity(requesterUserId, 'friend_request_accepted', {
            userId: req.userId,
            username: user.username
        });

        res.json({
            success: true,
            message: 'Запрос принят, вы теперь друзья'
        });
    } catch (err) {
        console.error('[profile/friends/accept]', err);
        res.status(500).json({
            error: 'Ошибка принятия запроса',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// FRIENDS: Reject request
// ------------------------------------------------------------

router.post('/friends/reject', requireAuth, async (req, res) => {
    try {
        const { userId: requesterId, username } = req.body;

        let requesterUserId = requesterId;

        if (username) {
            const usernameMap = await kv.get(K.USERNAME_MAP) || {};
            requesterUserId = usernameMap[username.toLowerCase()];
        }

        if (!requesterUserId) {
            return res.status(404).json({
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }

        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];
        const requester = users[requesterUserId];

        if (!user || !requester) {
            return res.status(404).json({
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }

        if (!user.friendRequests?.incoming?.includes(requesterUserId)) {
            return res.status(404).json({
                error: 'Запрос не найден',
                code: 'REQUEST_NOT_FOUND'
            });
        }

        // Удаляем из заявок
        user.friendRequests.incoming = user.friendRequests.incoming.filter(
            id => id !== requesterUserId
        );
        requester.friendRequests.outgoing = requester.friendRequests.outgoing.filter(
            id => id !== req.userId
        );

        user.updatedAt = now();
        requester.updatedAt = now();

        users[req.userId] = user;
        users[requesterUserId] = requester;
        await kv.set(K.USERS, users);

        await logActivity(req.userId, 'friend_rejected', {
            userId: requesterUserId,
            username: requester.username
        });

        res.json({
            success: true,
            message: 'Запрос отклонён'
        });
    } catch (err) {
        console.error('[profile/friends/reject]', err);
        res.status(500).json({
            error: 'Ошибка отклонения запроса',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// FRIENDS: Remove friend
// ------------------------------------------------------------

router.delete('/friends/remove', requireAuth, async (req, res) => {
    try {
        const { userId: friendId, username } = req.body;

        let targetFriendId = friendId;

        if (username) {
            const usernameMap = await kv.get(K.USERNAME_MAP) || {};
            targetFriendId = usernameMap[username.toLowerCase()];
        }

        if (!targetFriendId) {
            return res.status(404).json({
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }

        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];
        const friend = users[targetFriendId];

        if (!user || !friend) {
            return res.status(404).json({
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }

        if (!user.friends?.includes(targetFriendId)) {
            return res.status(404).json({
                error: 'Пользователь не в списке друзей',
                code: 'NOT_FRIENDS'
            });
        }

        // Удаляем из друзей
        user.friends = user.friends.filter(id => id !== targetFriendId);
        friend.friends = (friend.friends || []).filter(id => id !== req.userId);

        // Удаляем из закреплённых
        user.pinnedFriends = (user.pinnedFriends || []).filter(id => id !== targetFriendId);

        // Обновляем статистику
        user.statistics = user.statistics || createDefaultStatistics();
        user.statistics.friendCount = user.friends.length;

        friend.statistics = friend.statistics || createDefaultStatistics();
        friend.statistics.friendCount = friend.friends.length;

        user.updatedAt = now();
        friend.updatedAt = now();

        users[req.userId] = user;
        users[targetFriendId] = friend;
        await kv.set(K.USERS, users);

        await logActivity(req.userId, 'friend_removed', {
            userId: targetFriendId,
            username: friend.username
        });

        res.json({
            success: true,
            message: 'Друг удалён'
        });
    } catch (err) {
        console.error('[profile/friends/remove]', err);
        res.status(500).json({
            error: 'Ошибка удаления друга',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// FRIENDS: Get friends list
// ------------------------------------------------------------

router.get('/friends', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        const friendIds = user.friends || [];
        const friends = [];

        for (const friendId of friendIds) {
            const friend = users[friendId];
            if (friend) {
                friends.push({
                    id: friend.id,
                    username: friend.username,
                    displayName: friend.displayName,
                    avatar: friend.avatar,
                    status: friend.status,
                    online: friend.online,
                    lastSeen: friend.lastSeen
                });
            }
        }

        res.json({
            friends,
            total: friends.length
        });
    } catch (err) {
        console.error('[profile/friends/list]', err);
        res.status(500).json({
            error: 'Ошибка получения списка друзей',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// FRIENDS: Get incoming requests
// ------------------------------------------------------------

router.get('/friends/requests/incoming', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        const requestIds = user.friendRequests?.incoming || [];
        const requests = [];

        for (const requesterId of requestIds) {
            const requester = users[requesterId];
            if (requester) {
                requests.push({
                    id: requester.id,
                    username: requester.username,
                    displayName: requester.displayName,
                    avatar: requester.avatar,
                    requestedAt: now()
                });
            }
        }

        res.json({
            requests,
            total: requests.length
        });
    } catch (err) {
        console.error('[profile/friends/requests/incoming]', err);
        res.status(500).json({
            error: 'Ошибка получения входящих запросов',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// FRIENDS: Get outgoing requests
// ------------------------------------------------------------

router.get('/friends/requests/outgoing', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        const requestIds = user.friendRequests?.outgoing || [];
        const requests = [];

        for (const targetId of requestIds) {
            const target = users[targetId];
            if (target) {
                requests.push({
                    id: target.id,
                    username: target.username,
                    displayName: target.displayName,
                    avatar: target.avatar
                });
            }
        }

        res.json({
            requests,
            total: requests.length
        });
    } catch (err) {
        console.error('[profile/friends/requests/outgoing]', err);
        res.status(500).json({
            error: 'Ошибка получения исходящих запросов',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// FRIENDS: Check friendship
// ------------------------------------------------------------

router.get('/friends/check/:userId', requireAuth, async (req, res) => {
    try {
        const targetId = req.params.userId;

        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        const isFriend = user.friends?.includes(targetId) || false;
        const hasPendingRequest =
            user.friendRequests?.outgoing?.includes(targetId) ||
            user.friendRequests?.incoming?.includes(targetId) ||
            false;

        res.json({
            isFriend,
            hasPendingRequest,
            userId: targetId
        });
    } catch (err) {
        console.error('[profile/friends/check]', err);
        res.status(500).json({
            error: 'Ошибка проверки дружбы',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// FRIENDS: Pin friend
// ------------------------------------------------------------

router.post('/friends/pin', requireAuth, async (req, res) => {
    try {
        const { userId: friendId } = req.body;

        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        if (!user.friends?.includes(friendId)) {
            return res.status(400).json({
                error: 'Пользователь не в списке друзей',
                code: 'NOT_FRIENDS'
            });
        }

        user.pinnedFriends = user.pinnedFriends || [];

        if (user.pinnedFriends.includes(friendId)) {
            return res.status(400).json({
                error: 'Друг уже закреплён',
                code: 'ALREADY_PINNED'
            });
        }

        if (user.pinnedFriends.length >= CONFIG.MAX_PINNED_FRIENDS) {
            return res.status(400).json({
                error: `Достигнут лимит закреплённых друзей (${CONFIG.MAX_PINNED_FRIENDS})`,
                code: 'PINNED_LIMIT_REACHED'
            });
        }

        user.pinnedFriends.push(friendId);
        user.updatedAt = now();

        users[req.userId] = user;
        await kv.set(K.USERS, users);

        res.json({
            success: true,
            pinnedFriends: user.pinnedFriends
        });
    } catch (err) {
        console.error('[profile/friends/pin]', err);
        res.status(500).json({
            error: 'Ошибка закрепления друга',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// FRIENDS: Unpin friend
// ------------------------------------------------------------

router.post('/friends/unpin', requireAuth, async (req, res) => {
    try {
        const { userId: friendId } = req.body;

        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        user.pinnedFriends = user.pinnedFriends || [];
        user.pinnedFriends = user.pinnedFriends.filter(id => id !== friendId);
        user.updatedAt = now();

        users[req.userId] = user;
        await kv.set(K.USERS, users);

        res.json({
            success: true,
            pinnedFriends: user.pinnedFriends
        });
    } catch (err) {
        console.error('[profile/friends/unpin]', err);
        res.status(500).json({
            error: 'Ошибка открепления друга',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// BLOCK: Block user
// ------------------------------------------------------------

router.post('/block', requireAuth, async (req, res) => {
    try {
        const { userId: targetId, username } = req.body;

        let blockedUserId = targetId;

        if (username) {
            const usernameMap = await kv.get(K.USERNAME_MAP) || {};
            blockedUserId = usernameMap[username.toLowerCase()];
        }

        if (!blockedUserId) {
            return res.status(404).json({
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }

        if (blockedUserId === req.userId) {
            return res.status(400).json({
                error: 'Нельзя заблокировать себя',
                code: 'SELF_BLOCK'
            });
        }

        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        user.blockedUsers = user.blockedUsers || [];

        if (user.blockedUsers.includes(blockedUserId)) {
            return res.status(400).json({
                error: 'Пользователь уже заблокирован',
                code: 'ALREADY_BLOCKED'
            });
        }

        // Удаляем из друзей, если есть
        user.friends = (user.friends || []).filter(id => id !== blockedUserId);

        // Удаляем из заявок
        user.friendRequests = user.friendRequests || { incoming: [], outgoing: [] };
        user.friendRequests.incoming = user.friendRequests.incoming.filter(
            id => id !== blockedUserId
        );
        user.friendRequests.outgoing = user.friendRequests.outgoing.filter(
            id => id !== blockedUserId
        );

        user.blockedUsers.push(blockedUserId);
        user.updatedAt = now();

        users[req.userId] = user;
        await kv.set(K.USERS, users);

        await logActivity(req.userId, 'user_blocked', {
            userId: blockedUserId
        });

        res.json({
            success: true,
            message: 'Пользователь заблокирован'
        });
    } catch (err) {
        console.error('[profile/block]', err);
        res.status(500).json({
            error: 'Ошибка блокировки',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// BLOCK: Unblock user
// ------------------------------------------------------------

router.post('/unblock', requireAuth, async (req, res) => {
    try {
        const { userId: targetId } = req.body;

        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        user.blockedUsers = user.blockedUsers || [];

        if (!user.blockedUsers.includes(targetId)) {
            return res.status(404).json({
                error: 'Пользователь не заблокирован',
                code: 'NOT_BLOCKED'
            });
        }

        user.blockedUsers = user.blockedUsers.filter(id => id !== targetId);
        user.updatedAt = now();

        users[req.userId] = user;
        await kv.set(K.USERS, users);

        await logActivity(req.userId, 'user_unblocked', {
            userId: targetId
        });

        res.json({
            success: true,
            message: 'Пользователь разблокирован'
        });
    } catch (err) {
        console.error('[profile/unblock]', err);
        res.status(500).json({
            error: 'Ошибка разблокировки',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// BLOCK: Get blocked users
// ------------------------------------------------------------

router.get('/blocked', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        const blockedIds = user.blockedUsers || [];
        const blocked = [];

        for (const blockedId of blockedIds) {
            const blockedUser = users[blockedId];
            if (blockedUser) {
                blocked.push({
                    id: blockedUser.id,
                    username: blockedUser.username,
                    displayName: blockedUser.displayName,
                    avatar: blockedUser.avatar
                });
            }
        }

        res.json({
            blocked,
            total: blocked.length
        });
    } catch (err) {
        console.error('[profile/blocked]', err);
        res.status(500).json({
            error: 'Ошибка получения списка заблокированных',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// FOLLOWERS: Follow
// ------------------------------------------------------------

router.post('/follow', requireAuth, async (req, res) => {
    try {
        const { userId: targetId } = req.body;

        if (targetId === req.userId) {
            return res.status(400).json({
                error: 'Нельзя подписаться на себя',
                code: 'SELF_FOLLOW'
            });
        }

        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];
        const target = users[targetId];

        if (!user || !target) {
            return res.status(404).json({
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }

        if (user.following?.includes(targetId)) {
            return res.status(400).json({
                error: 'Вы уже подписаны',
                code: 'ALREADY_FOLLOWING'
            });
        }

        if ((user.following?.length || 0) >= CONFIG.MAX_FOLLOWING) {
            return res.status(400).json({
                error: 'Достигнут лимит подписок',
                code: 'FOLLOWING_LIMIT_REACHED'
            });
        }

        user.following = user.following || [];
        user.following.push(targetId);

        target.followers = target.followers || [];
        target.followers.push(req.userId);

        user.statistics = user.statistics || createDefaultStatistics();
        user.statistics.followingCount = user.following.length;

        target.statistics = target.statistics || createDefaultStatistics();
        target.statistics.followerCount = target.followers.length;

        user.updatedAt = now();
        target.updatedAt = now();

        users[req.userId] = user;
        users[targetId] = target;
        await kv.set(K.USERS, users);

        await logActivity(req.userId, 'follow', {
            userId: targetId,
            username: target.username
        });

        res.json({
            success: true,
            message: 'Вы подписались на пользователя'
        });
    } catch (err) {
        console.error('[profile/follow]', err);
        res.status(500).json({
            error: 'Ошибка подписки',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// FOLLOWERS: Unfollow
// ------------------------------------------------------------

router.post('/unfollow', requireAuth, async (req, res) => {
    try {
        const { userId: targetId } = req.body;

        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];
        const target = users[targetId];

        if (!user || !target) {
            return res.status(404).json({
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }

        if (!user.following?.includes(targetId)) {
            return res.status(404).json({
                error: 'Вы не подписаны на этого пользователя',
                code: 'NOT_FOLLOWING'
            });
        }

        user.following = user.following.filter(id => id !== targetId);
        target.followers = (target.followers || []).filter(id => id !== req.userId);

        user.statistics = user.statistics || createDefaultStatistics();
        user.statistics.followingCount = user.following.length;

        target.statistics = target.statistics || createDefaultStatistics();
        target.statistics.followerCount = target.followers.length;

        user.updatedAt = now();
        target.updatedAt = now();

        users[req.userId] = user;
        users[targetId] = target;
        await kv.set(K.USERS, users);

        await logActivity(req.userId, 'unfollow', {
            userId: targetId,
            username: target.username
        });

        res.json({
            success: true,
            message: 'Вы отписались от пользователя'
        });
    } catch (err) {
        console.error('[profile/unfollow]', err);
        res.status(500).json({
            error: 'Ошибка отписки',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// FAVORITES: Add to favorites
// ------------------------------------------------------------

router.post('/favorites/add', requireAuth, async (req, res) => {
    try {
        const { userId: targetId } = req.body;

        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        user.favorites = user.favorites || [];

        if (user.favorites.includes(targetId)) {
            return res.status(400).json({
                error: 'Пользователь уже в избранном',
                code: 'ALREADY_FAVORITED'
            });
        }

        if (user.favorites.length >= CONFIG.MAX_FAVORITES) {
            return res.status(400).json({
                error: 'Достигнут лимит избранных',
                code: 'FAVORITES_LIMIT_REACHED'
            });
        }

        user.favorites.push(targetId);
        user.updatedAt = now();

        users[req.userId] = user;
        await kv.set(K.USERS, users);

        res.json({
            success: true,
            message: 'Пользователь добавлен в избранное'
        });
    } catch (err) {
        console.error('[profile/favorites/add]', err);
        res.status(500).json({
            error: 'Ошибка добавления в избранное',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// FAVORITES: Remove from favorites
// ------------------------------------------------------------

router.post('/favorites/remove', requireAuth, async (req, res) => {
    try {
        const { userId: targetId } = req.body;

        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        user.favorites = user.favorites || [];

        if (!user.favorites.includes(targetId)) {
            return res.status(404).json({
                error: 'Пользователь не в избранном',
                code: 'NOT_FAVORITED'
            });
        }

        user.favorites = user.favorites.filter(id => id !== targetId);
        user.updatedAt = now();

        users[req.userId] = user;
        await kv.set(K.USERS, users);

        res.json({
            success: true,
            message: 'Пользователь удалён из избранного'
        });
    } catch (err) {
        console.error('[profile/favorites/remove]', err);
        res.status(500).json({
            error: 'Ошибка удаления из избранного',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// FAVORITES: Get favorites
// ------------------------------------------------------------

router.get('/favorites', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        const favoriteIds = user.favorites || [];
        const favorites = [];

        for (const favoriteId of favoriteIds) {
            const favorite = users[favoriteId];
            if (favorite) {
                favorites.push({
                    id: favorite.id,
                    username: favorite.username,
                    displayName: favorite.displayName,
                    avatar: favorite.avatar,
                    online: favorite.online
                });
            }
        }

        res.json({
            favorites,
            total: favorites.length
        });
    } catch (err) {
        console.error('[profile/favorites]', err);
        res.status(500).json({
            error: 'Ошибка получения избранного',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// SEARCH: Search users
// ------------------------------------------------------------

router.get('/search', optionalAuth, async (req, res) => {
    try {
        const { q, limit = 20, offset = 0 } = req.query;

        if (!q || typeof q !== 'string') {
            return res.status(400).json({
                error: 'Параметр поиска обязателен',
                code: 'MISSING_QUERY'
            });
        }

        const searchLimit = Math.min(parseInt(limit) || 20, 100);
        const searchOffset = Math.max(parseInt(offset) || 0, 0);

        const users = await kv.get(K.USERS) || {};
        const query = q.toLowerCase();
        const results = [];

        for (const [userId, user] of Object.entries(users)) {
            if (results.length >= searchLimit) break;

            const privacy = user.privacy || createDefaultPrivacy();

            // Проверяем приватность
            if (!privacy.allowSearch) continue;
            if (!privacy.profileVisible) continue;

            // Проверяем совпадение
            const usernameMatch = user.username.toLowerCase().includes(query);
            const nameMatch = user.displayName.toLowerCase().includes(query);

            if (usernameMatch || nameMatch) {
                results.push({
                    id: user.id,
                    username: user.username,
                    displayName: user.displayName,
                    avatar: user.avatar,
                    online: user.online,
                    status: user.status,
                    friendCount: user.statistics?.friendCount || 0,
                    hasCommonFriend: false
                });
            }
        }

        res.json({
            results: results.slice(searchOffset, searchOffset + searchLimit),
            total: results.length,
            query
        });
    } catch (err) {
        console.error('[profile/search]', err);
        res.status(500).json({
            error: 'Ошибка поиска',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// CATALOG: Get user catalog
// ------------------------------------------------------------

router.get('/catalog', optionalAuth, async (req, res) => {
    try {
        const {
            sort = 'newest',
            filter = 'all',
            limit = 20,
            offset = 0
        } = req.query;

        const catalogLimit = Math.min(parseInt(limit) || 20, 100);
        const catalogOffset = Math.max(parseInt(offset) || 0, 0);

        const users = await kv.get(K.USERS) || {};
        const allUsers = [];

        for (const [userId, user] of Object.entries(users)) {
            const privacy = user.privacy || createDefaultPrivacy();

            if (!privacy.profileVisible) continue;

            const userData = {
                id: user.id,
                username: user.username,
                displayName: user.displayName,
                avatar: user.avatar,
                online: user.online,
                lastSeen: user.lastSeen,
                createdAt: user.createdAt,
                status: user.status,
                friendCount: user.statistics?.friendCount || 0,
                followerCount: user.statistics?.followerCount || 0,
                profileViews: user.statistics?.profileViews || 0,
                verified: user.verified || false,
                badges: user.badges || [],
                hasCommonFriend: false
            };

            // Проверяем общего друга
            if (req.userId && user.friends) {
                const currentUser = users[req.userId];
                if (currentUser?.friends) {
                    userData.hasCommonFriend = user.friends.some(friendId =>
                        currentUser.friends.includes(friendId)
                    );
                }
            }

            allUsers.push(userData);
        }

        // Применяем фильтр
        let filteredUsers = allUsers;

        if (filter === 'online') {
            filteredUsers = allUsers.filter(u => u.online);
        } else if (filter === 'offline') {
            filteredUsers = allUsers.filter(u => !u.online);
        } else if (filter === 'verified') {
            filteredUsers = allUsers.filter(u => u.verified);
        } else if (filter === 'popular') {
            filteredUsers = allUsers.filter(u => u.followerCount > 0);
        } else if (filter === 'has-common-friend' && req.userId) {
            filteredUsers = allUsers.filter(u => u.hasCommonFriend);
        }

        // Применяем сортировку
        if (sort === 'newest') {
            filteredUsers.sort((a, b) =>
                new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
            );
        } else if (sort === 'popular') {
            filteredUsers.sort((a, b) => b.followerCount - a.followerCount);
        } else if (sort === 'views') {
            filteredUsers.sort((a, b) => b.profileViews - a.profileViews);
        } else if (sort === 'friends') {
            filteredUsers.sort((a, b) => b.friendCount - a.friendCount);
        } else if (sort === 'name') {
            filteredUsers.sort((a, b) => a.username.localeCompare(b.username));
        }

        const paginatedUsers = filteredUsers.slice(
            catalogOffset,
            catalogOffset + catalogLimit
        );

        res.json({
            users: paginatedUsers,
            total: filteredUsers.length,
            page: Math.floor(catalogOffset / catalogLimit) + 1,
            totalPages: Math.ceil(filteredUsers.length / catalogLimit),
            sort,
            filter
        });
    } catch (err) {
        console.error('[profile/catalog]', err);
        res.status(500).json({
            error: 'Ошибка получения каталога',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// VIEWS: Register profile view
// ------------------------------------------------------------

async function registerProfileView(userId, req) {
    try {
        const ip = getRemoteIp(req);

        // Проверяем, не смотрел ли уже этот IP сегодня
        const viewIpsKey = K.VIEW_IPS(userId);
        const viewIps = await kv.get(viewIpsKey) || {};

        const today = new Date().toDateString();
        const ipKey = `${ip}:${today}`;

        if (viewIps[ipKey]) {
            return; // Уже считали просмотр сегодня
        }

        // Регистрируем просмотр
        const viewsKey = K.VIEWS(userId);
        const views = await kv.get(viewsKey) || [];

        views.unshift({
            timestamp: now(),
            ip,
            userAgent: req.headers['user-agent']?.slice(0, 100) || null
        });

        if (views.length > CONFIG.VIEWS_HISTORY_LIMIT) {
            views.length = CONFIG.VIEWS_HISTORY_LIMIT;
        }

        await kv.set(viewsKey, views);

        // Обновляем IP-список
        viewIps[ipKey] = timestamp();
        await kv.set(viewIpsKey, viewIps, { ex: 86400 });

        // Обновляем счётчик в профиле
        const users = await kv.get(K.USERS) || {};
        const user = users[userId];

        if (user) {
            user.statistics = user.statistics || createDefaultStatistics();
            user.statistics.profileViews = (user.statistics.profileViews || 0) + 1;
            users[userId] = user;
            await kv.set(K.USERS, users);
        }
    } catch (err) {
        console.error('[profile/views/register]', err);
    }
}

// ------------------------------------------------------------
// VIEWS: Get profile views
// ------------------------------------------------------------

router.get('/views', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        const privacy = user.privacy || createDefaultPrivacy();

        if (privacy.hideProfileViews) {
            return res.status(403).json({
                error: 'Просмотры профиля скрыты',
                code: 'VIEWS_HIDDEN'
            });
        }

        const views = await kv.get(K.VIEWS(req.userId)) || [];

        res.json({
            views,
            total: user.statistics?.profileViews || 0
        });
    } catch (err) {
        console.error('[profile/views]', err);
        res.status(500).json({
            error: 'Ошибка получения просмотров',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// COMPLAINTS: Submit complaint
// ------------------------------------------------------------

router.post('/complaint', requireAuth, async (req, res) => {
    try {
        const { userId: targetId, reason, description } = req.body;

        if (!targetId || !reason) {
            return res.status(400).json({
                error: 'userId и reason обязательны',
                code: 'MISSING_PARAMS'
            });
        }

        if (targetId === req.userId) {
            return res.status(400).json({
                error: 'Нельзя пожаловаться на себя',
                code: 'SELF_COMPLAINT'
            });
        }

        const validReasons = [
            'spam', 'harassment', 'inappropriate', 'impersonation',
            'copyright', 'other'
        ];

        if (!validReasons.includes(reason)) {
            return res.status(400).json({
                error: 'Неверная причина жалобы',
                code: 'INVALID_REASON'
            });
        }

        const complaints = await kv.get(K.COMPLAINTS) || [];

        // Проверяем, не жаловался ли уже
        const existingComplaint = complaints.find(
            c => c.reporterId === req.userId && c.targetId === targetId
        );

        if (existingComplaint) {
            return res.status(400).json({
                error: 'Вы уже жаловались на этого пользователя',
                code: 'DUPLICATE_COMPLAINT'
            });
        }

        complaints.push({
            id: crypto.randomBytes(8).toString('hex'),
            reporterId: req.userId,
            targetId,
            reason,
            description: description?.slice(0, 1000) || null,
            createdAt: now(),
            status: 'pending'
        });

        await kv.set(K.COMPLAINTS, complaints);

        await logActivity(req.userId, 'complaint_submitted', {
            targetId,
            reason
        });

        res.json({
            success: true,
            message: 'Жалоба отправлена'
        });
    } catch (err) {
        console.error('[profile/complaint]', err);
        res.status(500).json({
            error: 'Ошибка отправки жалобы',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// VERIFICATION: Check verification status
// ------------------------------------------------------------

router.get('/verification', async (req, res) => {
    try {
        const { userId } = req.query;

        if (!userId) {
            return res.status(400).json({
                error: 'userId обязателен',
                code: 'MISSING_USER_ID'
            });
        }

        const verification = await kv.get(K.VERIFICATION) || {};
        const isVerified = verification[userId] || false;

        res.json({
            userId,
            verified: isVerified
        });
    } catch (err) {
        console.error('[profile/verification]', err);
        res.status(500).json({
            error: 'Ошибка проверки верификации',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// BADGES: Get user badges
// ------------------------------------------------------------

router.get('/badges/:userId', async (req, res) => {
    try {
        const targetId = req.params.userId;

        const users = await kv.get(K.USERS) || {};
        const user = users[targetId];

        if (!user) {
            return res.status(404).json({
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }

        res.json({
            badges: user.badges || [],
            total: (user.badges || []).length
        });
    } catch (err) {
        console.error('[profile/badges]', err);
        res.status(500).json({
            error: 'Ошибка получения бейджей',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// ACHIEVEMENTS: Get user achievements
// ------------------------------------------------------------

router.get('/achievements/:userId', async (req, res) => {
    try {
        const targetId = req.params.userId;

        const users = await kv.get(K.USERS) || {};
        const user = users[targetId];

        if (!user) {
            return res.status(404).json({
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }

        res.json({
            achievements: user.achievements || [],
            total: (user.achievements || []).length
        });
    } catch (err) {
        console.error('[profile/achievements]', err);
        res.status(500).json({
            error: 'Ошибка получения достижений',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// ROLES: Get user roles
// ------------------------------------------------------------

router.get('/roles/:userId', async (req, res) => {
    try {
        const targetId = req.params.userId;

        const users = await kv.get(K.USERS) || {};
        const user = users[targetId];

        if (!user) {
            return res.status(404).json({
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }

        res.json({
            roles: user.roles || ['user']
        });
    } catch (err) {
        console.error('[profile/roles]', err);
        res.status(500).json({
            error: 'Ошибка получения ролей',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// ONLINE: Update online status
// ------------------------------------------------------------

router.post('/online', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        user.online = true;
        user.lastSeen = now();
        user.updatedAt = now();

        if (user.status?.state === 'offline' || user.status?.state === 'invisible') {
            // Не меняем статус, если пользователь выбрал offline/invisible
        } else {
            user.status = user.status || createDefaultStatus();
            user.status.state = 'online';
            user.status.updatedAt = now();
        }

        users[req.userId] = user;
        await kv.set(K.USERS, users);

        res.json({
            success: true,
            online: true,
            lastSeen: user.lastSeen
        });
    } catch (err) {
        console.error('[profile/online]', err);
        res.status(500).json({
            error: 'Ошибка обновления статуса онлайн',
            code: 'INTERNAL_ERROR'
        });
    }
});

router.post('/offline', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        user.online = false;
        user.lastSeen = now();
        user.updatedAt = now();

        users[req.userId] = user;
        await kv.set(K.USERS, users);

        await logActivity(req.userId, 'went_offline');

        res.json({
            success: true,
            online: false,
            lastSeen: user.lastSeen
        });
    } catch (err) {
        console.error('[profile/offline]', err);
        res.status(500).json({
            error: 'Ошибка обновления статуса оффлайн',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// NOTIFICATIONS: Get notification settings
// ------------------------------------------------------------

router.get('/notifications', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        res.json({
            notifications: user.settings?.notifications || createDefaultSettings().notifications
        });
    } catch (err) {
        console.error('[profile/notifications]', err);
        res.status(500).json({
            error: 'Ошибка получения настроек уведомлений',
            code: 'INTERNAL_ERROR'
        });
    }
});

router.patch('/notifications', requireAuth, async (req, res) => {
    try {
        const { notifications } = req.body;

        if (!notifications || typeof notifications !== 'object') {
            return res.status(400).json({
                error: 'Неверный формат настроек уведомлений',
                code: 'INVALID_NOTIFICATIONS'
            });
        }

        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        const allowedNotificationKeys = [
            'friendRequests', 'friendAccepted', 'profileViews',
            'messages', 'mentions', 'email'
        ];

        user.settings = user.settings || createDefaultSettings();
        user.settings.notifications = user.settings.notifications || {};

        for (const key of allowedNotificationKeys) {
            if (key in notifications) {
                user.settings.notifications[key] = Boolean(notifications[key]);
            }
        }

        user.updatedAt = now();

        users[req.userId] = user;
        await kv.set(K.USERS, users);

        await logActivity(req.userId, 'notifications_update');

        res.json({
            success: true,
            notifications: user.settings.notifications
        });
    } catch (err) {
        console.error('[profile/notifications/update]', err);
        res.status(500).json({
            error: 'Ошибка обновления настроек уведомлений',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// SOCIALS: Get social links
// ------------------------------------------------------------

router.get('/socials', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        res.json({
            socials: user.socials || {
                github: null,
                discord: null,
                telegram: null,
                youtube: null,
                website: null
            }
        });
    } catch (err) {
        console.error('[profile/socials]', err);
        res.status(500).json({
            error: 'Ошибка получения соцсетей',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// STATS: Get profile statistics
// ------------------------------------------------------------

router.get('/stats', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        res.json({
            statistics: user.statistics || createDefaultStatistics()
        });
    } catch (err) {
        console.error('[profile/stats]', err);
        res.status(500).json({
            error: 'Ошибка получения статистики',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// EXPORT: Export profile data
// ------------------------------------------------------------

router.get('/export', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        const usernameHistory = await kv.get(K.USERNAME_HISTORY(req.userId)) || [];
        const nameHistory = await kv.get(K.NAME_HISTORY(req.userId)) || [];
        const avatarHistory = await kv.get(K.AVATAR_HISTORY(req.userId)) || [];
        const themeHistory = await kv.get(K.THEME_HISTORY(req.userId)) || [];
        const activityLog = await kv.get(K.ACTIVITY_LOG(req.userId)) || [];

        const exportData = {
            version: '1.0.0',
            exportedAt: now(),
            profile: {
                id: user.id,
                username: user.username,
                displayName: user.displayName,
                avatar: user.avatar,
                bio: user.bio,
                email: user.email,
                createdAt: user.createdAt,
                updatedAt: user.updatedAt,
                lastSeen: user.lastSeen,
                online: user.online,
                theme: user.theme,
                status: user.status,
                visibility: user.visibility,
                customization: user.customization,
                statistics: user.statistics,
                settings: user.settings,
                privacy: user.privacy,
                socials: user.socials,
                badges: user.badges,
                achievements: user.achievements,
                verified: user.verified,
                roles: user.roles
            },
            history: {
                usernames: usernameHistory,
                names: nameHistory,
                avatars: avatarHistory,
                themes: themeHistory,
                activity: activityLog
            },
            counts: {
                friends: (user.friends || []).length,
                followers: (user.followers || []).length,
                following: (user.following || []).length,
                favorites: (user.favorites || []).length,
                pinnedFriends: (user.pinnedFriends || []).length,
                blockedUsers: (user.blockedUsers || []).length,
                incomingRequests: (user.friendRequests?.incoming || []).length,
                outgoingRequests: (user.friendRequests?.outgoing || []).length
            }
        };

        res.json({
            success: true,
            data: exportData
        });
    } catch (err) {
        console.error('[profile/export]', err);
        res.status(500).json({
            error: 'Ошибка экспорта профиля',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// QR: Generate profile QR code URL
// ------------------------------------------------------------

router.get('/qr', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        const profileUrl = `${req.protocol}://${req.get('host')}/profile/@${user.username}`;
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(profileUrl)}`;

        res.json({
            success: true,
            profileUrl,
            qrUrl,
            qrSvg: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&format=svg&data=${encodeURIComponent(profileUrl)}`
        });
    } catch (err) {
        console.error('[profile/qr]', err);
        res.status(500).json({
            error: 'Ошибка генерации QR-кода',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// COPY LINK: Get profile link
// ------------------------------------------------------------

router.get('/link', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];

        if (!user) {
            return res.status(404).json({
                error: 'Профиль не найден',
                code: 'PROFILE_NOT_FOUND'
            });
        }

        const profileUrl = `${req.protocol}://${req.get('host')}/profile/@${user.username}`;

        res.json({
            success: true,
            url: profileUrl,
            username: user.username
        });
    } catch (err) {
        console.error('[profile/link]', err);
        res.status(500).json({
            error: 'Ошибка получения ссылки',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

function sanitizeUserForResponse(user, currentUserId, isOwner = false) {
    const privacy = user.privacy || createDefaultPrivacy();
    const isFriend = user.friends?.includes(currentUserId) || false;

    const response = {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        avatar: user.avatar,
        bio: user.bio,
        theme: user.theme,
        status: user.status,
        online: user.online,
        lastSeen: user.lastSeen,
        createdAt: privacy.hideRegistrationDate ? null : user.createdAt,
        updatedAt: user.updatedAt,
        verified: user.verified,
        roles: user.roles,
        badges: privacy.showBadges ? user.badges : [],
        achievements: privacy.showAchievements ? user.achievements : [],
        socials: privacy.showSocials ? user.socials : null,
        statistics: {
            profileViews: privacy.hideProfileViews ? null : user.statistics?.profileViews || 0,
            friendCount: privacy.showFriends ? user.statistics?.friendCount || 0 : null,
            followerCount: user.statistics?.followerCount || 0,
            followingCount: user.statistics?.followingCount || 0
        },
        customization: isOwner ? user.customization : null,
        settings: isOwner ? user.settings : null,
        privacy: isOwner ? user.privacy : null,
        isFriend,
        isOwner,
        hasPendingRequest: false
    };

    if (currentUserId && currentUserId !== user.id) {
        const currentUserFriends = user.friends || [];
        response.isFriend = currentUserFriends.includes(currentUserId);

        // Проверяем заявки
        const users = {}; // Здесь должен быть доступ к KV, но для простоты опустим
        response.hasPendingRequest = false;
    }

    if (isOwner) {
        response.friends = privacy.showFriends ? user.friends : null;
        response.friendRequests = user.friendRequests;
        response.blockedUsers = user.blockedUsers;
        response.followers = user.followers;
        response.following = user.following;
        response.favorites = user.favorites;
        response.pinnedFriends = user.pinnedFriends;
    }

    return response;
}

// ------------------------------------------------------------
// ERROR HANDLER
// ------------------------------------------------------------

router.use((err, req, res, next) => {
    console.error('[profile error]', err);
    res.status(err.status || 500).json({
        error: err.message || 'Internal Server Error',
        code: err.code || 'INTERNAL_ERROR'
    });
});

module.exports = router;