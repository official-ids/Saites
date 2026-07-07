// ============================================================
// МОДУЛЬ: СИСТЕМА ОЦЕНОК И ОТЗЫВОВ
// Авторизация через Google, профили, отзывы
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
    USERS: 'grade:users',
    GOOGLE_MAP: 'grade:google_map',
    SESSIONS: 'grade:sessions',
    REVIEWS: (userId) => `grade:reviews:${userId}`,
    REVIEW_COUNT: (userId) => `grade:review_count:${userId}`
};

// ------------------------------------------------------------
// КОНФИГУРАЦИЯ
// ------------------------------------------------------------
const CONFIG = {
    SESSION_TTL: 30 * 24 * 60 * 60 * 1000, // 30 дней
    MIN_RATING: 1,
    MAX_RATING: 5,
    MIN_REVIEW_LENGTH: 10,
    MAX_REVIEW_LENGTH: 1000,
    MAX_REVIEWS_PER_USER: 1000
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

function now() {
    return new Date().toISOString();
}

function timestamp() {
    return Date.now();
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
            
            user = {
                id: userId,
                googleId,
                email,
                nickname: name,
                avatar: picture || null,
                createdAt: now(),
                updatedAt: now(),
                reviewCount: 0,
                averageRating: 0
            };
            
            const users = await kv.get(K.USERS) || {};
            users[userId] = user;
            await kv.set(K.USERS, users);
            
            googleMap[googleId] = userId;
            await kv.set(K.GOOGLE_MAP, googleMap);
        } else {
            // Обновляем lastSeen
            user.updatedAt = now();
            const users = await kv.get(K.USERS) || {};
            users[userId] = user;
            await kv.set(K.USERS, users);
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
                nickname: user.nickname,
                avatar: user.avatar,
                email: user.email
            }
        });
    } catch (err) {
        console.error('[grade/auth/google]', err);
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
        
        res.json({ success: true });
    } catch (err) {
        console.error('[grade/auth/logout]', err);
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
        console.error('[grade/auth/me]', err);
        res.status(500).json({
            error: 'Ошибка получения профиля',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// USER: Get user profile
// ------------------------------------------------------------

router.get('/user/:userId', async (req, res) => {
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
        
        // Получаем статистику отзывов
        const reviewCount = await kv.get(K.REVIEW_COUNT(userId)) || 0;
        
        res.json({
            user: {
                id: user.id,
                nickname: user.nickname,
                avatar: user.avatar,
                createdAt: user.createdAt,
                reviewCount,
                averageRating: user.averageRating || 0
            }
        });
    } catch (err) {
        console.error('[grade/user]', err);
        res.status(500).json({
            error: 'Ошибка получения профиля',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// REVIEWS: Get reviews for user
// ------------------------------------------------------------

router.get('/reviews/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { page = 1, limit = 20 } = req.query;
        
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
        
        const reviews = await kv.get(K.REVIEWS(userId)) || [];
        
        // Сортируем по дате (новые сверху)
        const sortedReviews = reviews.sort((a, b) => 
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        
        // Пагинация
        const start = (pageNum - 1) * limitNum;
        const end = start + limitNum;
        const paginatedReviews = sortedReviews.slice(start, end);
        
        // Получаем данные авторов отзывов
        const users = await kv.get(K.USERS) || {};
        const reviewsWithAuthors = paginatedReviews.map(review => {
            const author = users[review.authorId];
            return {
                ...review,
                authorNickname: author?.nickname || 'Unknown',
                authorAvatar: author?.avatar || null
            };
        });
        
        res.json({
            reviews: reviewsWithAuthors,
            total: reviews.length,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(reviews.length / limitNum)
        });
    } catch (err) {
        console.error('[grade/reviews]', err);
        res.status(500).json({
            error: 'Ошибка получения отзывов',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// REVIEWS: Create review
// ------------------------------------------------------------

router.post('/reviews/:userId', requireAuth, async (req, res) => {
    try {
        const { userId } = req.params;
        const { rating, text } = req.body;
        
        // Проверка: нельзя комментировать себя
        if (userId === req.userId) {
            return res.status(400).json({
                error: 'Нельзя оставить отзыв себе',
                code: 'SELF_REVIEW'
            });
        }
        
        // Валидация рейтинга
        if (!rating || rating < CONFIG.MIN_RATING || rating > CONFIG.MAX_RATING) {
            return res.status(400).json({
                error: `Рейтинг должен быть от ${CONFIG.MIN_RATING} до ${CONFIG.MAX_RATING}`,
                code: 'INVALID_RATING'
            });
        }
        
        // Валидация текста
        if (!text || typeof text !== 'string') {
            return res.status(400).json({
                error: 'Текст отзыва обязателен',
                code: 'MISSING_TEXT'
            });
        }
        
        const cleanedText = sanitizeString(text);
        
        if (cleanedText.length < CONFIG.MIN_REVIEW_LENGTH) {
            return res.status(400).json({
                error: `Текст должен содержать минимум ${CONFIG.MIN_REVIEW_LENGTH} символов`,
                code: 'TEXT_TOO_SHORT'
            });
        }
        
        if (cleanedText.length > CONFIG.MAX_REVIEW_LENGTH) {
            return res.status(400).json({
                error: `Текст не должен превышать ${CONFIG.MAX_REVIEW_LENGTH} символов`,
                code: 'TEXT_TOO_LONG'
            });
        }
        
        // Проверяем, существует ли пользователь
        const users = await kv.get(K.USERS) || {};
        const targetUser = users[userId];
        
        if (!targetUser) {
            return res.status(404).json({
                error: 'Пользователь не найден',
                code: 'USER_NOT_FOUND'
            });
        }
        
        // Проверяем, не оставлял ли уже отзыв
        const reviews = await kv.get(K.REVIEWS(userId)) || [];
        const existingReview = reviews.find(r => r.authorId === req.userId);
        
        if (existingReview) {
            return res.status(400).json({
                error: 'Вы уже оставляли отзыв этому пользователю',
                code: 'DUPLICATE_REVIEW'
            });
        }
        
        // Проверяем лимит отзывов
        if (reviews.length >= CONFIG.MAX_REVIEWS_PER_USER) {
            return res.status(400).json({
                error: 'Достигнут лимит отзывов',
                code: 'REVIEW_LIMIT_REACHED'
            });
        }
        
        // Создаём отзыв
        const review = {
            id: crypto.randomBytes(8).toString('hex'),
            authorId: req.userId,
            rating,
            text: cleanedText,
            createdAt: now(),
            updatedAt: now()
        };
        
        reviews.push(review);
        await kv.set(K.REVIEWS(userId), reviews);
        
        // Обновляем счётчик отзывов
        const reviewCount = reviews.length;
        await kv.set(K.REVIEW_COUNT(userId), reviewCount);
        
        // Пересчитываем средний рейтинг
        const totalRating = reviews.reduce((sum, r) => sum + r.rating, 0);
        const averageRating = Math.round((totalRating / reviewCount) * 10) / 10;
        
        targetUser.averageRating = averageRating;
        targetUser.reviewCount = reviewCount;
        targetUser.updatedAt = now();
        users[userId] = targetUser;
        await kv.set(K.USERS, users);
        
        res.json({
            success: true,
            review,
            averageRating
        });
    } catch (err) {
        console.error('[grade/reviews/create]', err);
        res.status(500).json({
            error: 'Ошибка создания отзыва',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// REVIEWS: Update review
// ------------------------------------------------------------

router.put('/reviews/:userId/:reviewId', requireAuth, async (req, res) => {
    try {
        const { userId, reviewId } = req.params;
        const { rating, text } = req.body;
        
        const reviews = await kv.get(K.REVIEWS(userId)) || [];
        const reviewIndex = reviews.findIndex(r => r.id === reviewId);
        
        if (reviewIndex === -1) {
            return res.status(404).json({
                error: 'Отзыв не найден',
                code: 'REVIEW_NOT_FOUND'
            });
        }
        
        const review = reviews[reviewIndex];
        
        // Проверка: только автор может редактировать
        if (review.authorId !== req.userId) {
            return res.status(403).json({
                error: 'Нет доступа',
                code: 'FORBIDDEN'
            });
        }
        
        // Валидация
        if (rating !== undefined && (rating < CONFIG.MIN_RATING || rating > CONFIG.MAX_RATING)) {
            return res.status(400).json({
                error: `Рейтинг должен быть от ${CONFIG.MIN_RATING} до ${CONFIG.MAX_RATING}`,
                code: 'INVALID_RATING'
            });
        }
        
        if (text !== undefined) {
            const cleanedText = sanitizeString(text);
            
            if (cleanedText.length < CONFIG.MIN_REVIEW_LENGTH) {
                return res.status(400).json({
                    error: `Текст должен содержать минимум ${CONFIG.MIN_REVIEW_LENGTH} символов`,
                    code: 'TEXT_TOO_SHORT'
                });
            }
            
            if (cleanedText.length > CONFIG.MAX_REVIEW_LENGTH) {
                return res.status(400).json({
                    error: `Текст не должен превышать ${CONFIG.MAX_REVIEW_LENGTH} символов`,
                    code: 'TEXT_TOO_LONG'
                });
            }
            
            review.text = cleanedText;
        }
        
        if (rating !== undefined) {
            review.rating = rating;
        }
        
        review.updatedAt = now();
        reviews[reviewIndex] = review;
        
        await kv.set(K.REVIEWS(userId), reviews);
        
        // Пересчитываем средний рейтинг
        const totalRating = reviews.reduce((sum, r) => sum + r.rating, 0);
        const averageRating = Math.round((totalRating / reviews.length) * 10) / 10;
        
        const users = await kv.get(K.USERS) || {};
        const targetUser = users[userId];
        
        if (targetUser) {
            targetUser.averageRating = averageRating;
            targetUser.updatedAt = now();
            users[userId] = targetUser;
            await kv.set(K.USERS, users);
        }
        
        res.json({
            success: true,
            review,
            averageRating
        });
    } catch (err) {
        console.error('[grade/reviews/update]', err);
        res.status(500).json({
            error: 'Ошибка обновления отзыва',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// REVIEWS: Delete review
// ------------------------------------------------------------

router.delete('/reviews/:userId/:reviewId', requireAuth, async (req, res) => {
    try {
        const { userId, reviewId } = req.params;
        
        const reviews = await kv.get(K.REVIEWS(userId)) || [];
        const reviewIndex = reviews.findIndex(r => r.id === reviewId);
        
        if (reviewIndex === -1) {
            return res.status(404).json({
                error: 'Отзыв не найден',
                code: 'REVIEW_NOT_FOUND'
            });
        }
        
        const review = reviews[reviewIndex];
        
        // Проверка: только автор может удалить
        if (review.authorId !== req.userId) {
            return res.status(403).json({
                error: 'Нет доступа',
                code: 'FORBIDDEN'
            });
        }
        
        reviews.splice(reviewIndex, 1);
        await kv.set(K.REVIEWS(userId), reviews);
        
        // Обновляем счётчик
        const reviewCount = reviews.length;
        await kv.set(K.REVIEW_COUNT(userId), reviewCount);
        
        // Пересчитываем средний рейтинг
        const users = await kv.get(K.USERS) || {};
        const targetUser = users[userId];
        
        if (targetUser) {
            if (reviewCount === 0) {
                targetUser.averageRating = 0;
            } else {
                const totalRating = reviews.reduce((sum, r) => sum + r.rating, 0);
                targetUser.averageRating = Math.round((totalRating / reviewCount) * 10) / 10;
            }
            targetUser.reviewCount = reviewCount;
            targetUser.updatedAt = now();
            users[userId] = targetUser;
            await kv.set(K.USERS, users);
        }
        
        res.json({
            success: true,
            message: 'Отзыв удалён'
        });
    } catch (err) {
        console.error('[grade/reviews/delete]', err);
        res.status(500).json({
            error: 'Ошибка удаления отзыва',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ------------------------------------------------------------
// ERROR HANDLER
// ------------------------------------------------------------

router.use((err, req, res, next) => {
    console.error('[grade error]', err);
    res.status(err.status || 500).json({
        error: err.message || 'Internal Server Error',
        code: err.code || 'INTERNAL_ERROR'
    });
});

module.exports = router;