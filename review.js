// ============================================================
// МОДУЛЬ: СИСТЕМА ОЦЕНОК (REVIEW)
// Пользователи оценивают друг друга лайками/дизлайками
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
router.use(express.json({ limit: '1mb' }));

// ------------------------------------------------------------
// КОНСТАНТЫ ХРАНИЛИЩА
// ------------------------------------------------------------
const K = {
    USERS: 'profile:users',
    USERNAME_MAP: 'profile:username_map',
    GOOGLE_MAP: 'profile:google_map',
    SESSIONS: 'profile:sessions',
    RATINGS: (userId) => `review:ratings:${userId}`
};

const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;

// ------------------------------------------------------------
// УТИЛИТЫ
// ------------------------------------------------------------
function generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
}

function now() {
    return new Date().toISOString();
}

function timestamp() {
    return Date.now();
}

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
// GOOGLE OAUTH
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
            userId = 'usr_' + crypto.randomBytes(16).toString('hex');
            
            const usernameMap = await kv.get(K.USERNAME_MAP) || {};
            let username = name.toLowerCase()
                .replace(/[^a-z0-9_]/g, '_')
                .replace(/_+/g, '_')
                .slice(0, 30);
            
            if (!username || username.length < 3) {
                username = 'user_' + crypto.randomBytes(4).toString('hex');
            }
            
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
                createdAt: now(),
                updatedAt: now(),
                lastSeen: now(),
                online: true
            };
            
            const users = await kv.get(K.USERS) || {};
            users[userId] = user;
            await kv.set(K.USERS, users);
            
            googleMap[googleId] = userId;
            await kv.set(K.GOOGLE_MAP, googleMap);
            
            usernameMap[finalUsername] = userId;
            await kv.set(K.USERNAME_MAP, usernameMap);
        } else {
            user.lastSeen = now();
            user.online = true;
            user.updatedAt = now();
            const users = await kv.get(K.USERS) || {};
            users[userId] = user;
            await kv.set(K.USERS, users);
        }
        
        const sessions = await kv.get(K.SESSIONS) || {};
        const sessionToken = generateSessionToken();
        sessions[sessionToken] = {
            userId,
            email: user.email,
            createdAt: now(),
            expiresAt: timestamp() + SESSION_TTL
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
        console.error('[review/auth/google]', err);
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
        
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];
        if (user) {
            user.online = false;
            user.lastSeen = now();
            users[req.userId] = user;
            await kv.set(K.USERS, users);
        }
        
        res.json({ success: true });
    } catch (err) {
        console.error('[review/auth/logout]', err);
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
        
        res.json({
            user: {
                id: user.id,
                username: user.username,
                displayName: user.displayName,
                avatar: user.avatar,
                email: user.email
            }
        });
    } catch (err) {
        console.error('[review/auth/me]', err);
        res.status(500).json({
            error: 'Ошибка получения профиля',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// REVIEW: Get user profile with ratings
// ------------------------------------------------------------
router.get('/user/:userId', optionalAuth, async (req, res) => {
    try {
        const { userId } = req.params;
        
        const users = await kv.get(K.USERS) || {};
        const targetUser = users[userId];
        
        if (!targetUser) {
            return res.status(404).json({
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }
        
        const ratings = await kv.get(K.RATINGS(userId)) || {
            likes: [],
            dislikes: [],
            createdAt: now()
        };
        
        const likeCount = ratings.likes.length;
        const dislikeCount = ratings.dislikes.length;
        const totalVotes = likeCount + dislikeCount;
        const likePercent = totalVotes > 0 ? Math.round((likeCount / totalVotes) * 100) : 50;
        
        // Проверяем, оценил ли текущий пользователь
        let userRating = null;
        if (req.userId && req.userId !== userId) {
            if (ratings.likes.includes(req.userId)) {
                userRating = 'like';
            } else if (ratings.dislikes.includes(req.userId)) {
                userRating = 'dislike';
            }
        }
        
        res.json({
            user: {
                id: targetUser.id,
                username: targetUser.username,
                displayName: targetUser.displayName,
                avatar: targetUser.avatar,
                createdAt: targetUser.createdAt
            },
            ratings: {
                likes: likeCount,
                dislikes: dislikeCount,
                total: totalVotes,
                likePercent,
                dislikePercent: 100 - likePercent
            },
            userRating,
            isOwnProfile: req.userId === userId,
            isAuthenticated: !!req.userId
        });
    } catch (err) {
        console.error('[review/user]', err);
        res.status(500).json({
            error: 'Ошибка получения профиля',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// REVIEW: Like user
// ------------------------------------------------------------
router.post('/user/:userId/like', requireAuth, async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Нельзя оценивать себя
        if (req.userId === userId) {
            return res.status(400).json({
                error: 'Нельзя оценивать себя',
                code: 'SELF_RATING'
            });
        }
        
        const users = await kv.get(K.USERS) || {};
        if (!users[userId]) {
            return res.status(404).json({
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }
        
        const ratings = await kv.get(K.RATINGS(userId)) || {
            likes: [],
            dislikes: [],
            createdAt: now()
        };
        
        // Если уже лайкнул — убираем лайк (toggle)
        if (ratings.likes.includes(req.userId)) {
            ratings.likes = ratings.likes.filter(id => id !== req.userId);
        } else {
            // Убираем дизлайк если был
            ratings.dislikes = ratings.dislikes.filter(id => id !== req.userId);
            ratings.likes.push(req.userId);
        }
        
        await kv.set(K.RATINGS(userId), ratings);
        
        const likeCount = ratings.likes.length;
        const dislikeCount = ratings.dislikes.length;
        const totalVotes = likeCount + dislikeCount;
        const likePercent = totalVotes > 0 ? Math.round((likeCount / totalVotes) * 100) : 50;
        
        res.json({
            success: true,
            action: ratings.likes.includes(req.userId) ? 'liked' : 'unliked',
            ratings: {
                likes: likeCount,
                dislikes: dislikeCount,
                total: totalVotes,
                likePercent,
                dislikePercent: 100 - likePercent
            },
            userRating: ratings.likes.includes(req.userId) ? 'like' : null
        });
    } catch (err) {
        console.error('[review/like]', err);
        res.status(500).json({
            error: 'Ошибка оценки',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// REVIEW: Dislike user
// ------------------------------------------------------------
router.post('/user/:userId/dislike', requireAuth, async (req, res) => {
    try {
        const { userId } = req.params;
        
        if (req.userId === userId) {
            return res.status(400).json({
                error: 'Нельзя оценивать себя',
                code: 'SELF_RATING'
            });
        }
        
        const users = await kv.get(K.USERS) || {};
        if (!users[userId]) {
            return res.status(404).json({
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }
        
        const ratings = await kv.get(K.RATINGS(userId)) || {
            likes: [],
            dislikes: [],
            createdAt: now()
        };
        
        // Если уже дизлайкнул — убираем дизлайк (toggle)
        if (ratings.dislikes.includes(req.userId)) {
            ratings.dislikes = ratings.dislikes.filter(id => id !== req.userId);
        } else {
            ratings.likes = ratings.likes.filter(id => id !== req.userId);
            ratings.dislikes.push(req.userId);
        }
        
        await kv.set(K.RATINGS(userId), ratings);
        
        const likeCount = ratings.likes.length;
        const dislikeCount = ratings.dislikes.length;
        const totalVotes = likeCount + dislikeCount;
        const likePercent = totalVotes > 0 ? Math.round((likeCount / totalVotes) * 100) : 50;
        
        res.json({
            success: true,
            action: ratings.dislikes.includes(req.userId) ? 'disliked' : 'undisliked',
            ratings: {
                likes: likeCount,
                dislikes: dislikeCount,
                total: totalVotes,
                likePercent,
                dislikePercent: 100 - likePercent
            },
            userRating: ratings.dislikes.includes(req.userId) ? 'dislike' : null
        });
    } catch (err) {
        console.error('[review/dislike]', err);
        res.status(500).json({
            error: 'Ошибка оценки',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// REVIEW: Remove rating
// ------------------------------------------------------------
router.post('/user/:userId/remove', requireAuth, async (req, res) => {
    try {
        const { userId } = req.params;
        
        const ratings = await kv.get(K.RATINGS(userId)) || {
            likes: [],
            dislikes: [],
            createdAt: now()
        };
        
        ratings.likes = ratings.likes.filter(id => id !== req.userId);
        ratings.dislikes = ratings.dislikes.filter(id => id !== req.userId);
        
        await kv.set(K.RATINGS(userId), ratings);
        
        const likeCount = ratings.likes.length;
        const dislikeCount = ratings.dislikes.length;
        const totalVotes = likeCount + dislikeCount;
        const likePercent = totalVotes > 0 ? Math.round((likeCount / totalVotes) * 100) : 50;
        
        res.json({
            success: true,
            ratings: {
                likes: likeCount,
                dislikes: dislikeCount,
                total: totalVotes,
                likePercent,
                dislikePercent: 100 - likePercent
            },
            userRating: null
        });
    } catch (err) {
        console.error('[review/remove]', err);
        res.status(500).json({
            error: 'Ошибка удаления оценки',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// REVIEW: Get my profile link
// ------------------------------------------------------------
router.get('/my-link', requireAuth, async (req, res) => {
    try {
        const users = await kv.get(K.USERS) || {};
        const user = users[req.userId];
        
        if (!user) {
            return res.status(404).json({
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }
        
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const reviewUrl = `${baseUrl}/review?account=${user.id}`;
        
        res.json({
            userId: user.id,
            reviewUrl,
            username: user.username
        });
    } catch (err) {
        console.error('[review/my-link]', err);
        res.status(500).json({
            error: 'Ошибка получения ссылки',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// ERROR HANDLER
// ------------------------------------------------------------
router.use((err, req, res, next) => {
    console.error('[review error]', err);
    res.status(err.status || 500).json({
        error: err.message || 'Internal Server Error',
        code: err.code || 'INTERNAL_ERROR'
    });
});

module.exports = router;