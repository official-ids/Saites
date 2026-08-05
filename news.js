const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const { put } = require('@vercel/blob');
const { kv } = require('@vercel/kv');

// ============================================
// Инициализация роутера
// ============================================

/**
 * Express роутер для новостной системы
 * @type {express.Router}
 */
const router = express.Router();

/**
 * Multer middleware для обработки загрузки файлов
 * Хранит файлы в памяти для последующей обработки
 * @type {multer.Instance}
 */
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }
});

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
 * Конфигурация загрузки файлов
 * @namespace
 */
const FILE_CONFIG = {
    /** @type {number} Максимальный размер файла (50 МБ) */
    MAX_SIZE: 50 * 1024 * 1024,
    
    /** @type {Array<string>} Разрешённые MIME-типы */
    ALLOWED_MIMETYPES: [
        'image/jpeg', 'image/png', 'image/gif', 'image/webp',
        'application/pdf', 'video/mp4'
    ],
    
    /** @type {string} Директория для загрузки в Blob Storage */
    UPLOAD_DIR: 'news-files'
};

/**
 * Конфигурация аутентификации
 * @namespace
 */
const AUTH_CONFIG = {
    /** @type {number} TTL сессии администратора (30 дней в секундах) */
    SESSION_TTL_ADMIN: 60 * 60 * 24 * 30,
    
    /** @type {number} TTL сессии читателя (1 год в секундах) */
    SESSION_TTL_READER: 60 * 60 * 24 * 365,
    
    /** @type {number} Длина токена сессии в байтах */
    TOKEN_LENGTH: 32,
    
    /** @type {number} Длина соли для пароля в байтах */
    PASSWORD_SALT_LENGTH: 16,
    
    /** @type {number} Длина производного ключа в байтах */
    PASSWORD_KEY_LENGTH: 64,
    
    /** @type {number} Количество итераций PBKDF2 */
    PASSWORD_ITERATIONS: 100000,
    
    /** @type {string} Алгоритм хеширования для PBKDF2 */
    PASSWORD_DIGEST: 'sha512',
    
    /** @type {number} Минимальная длина логина */
    LOGIN_MIN_LENGTH: 3,
    
    /** @type {number} Максимальная длина логина */
    LOGIN_MAX_LENGTH: 30,
    
    /** @type {number} Минимальная длина пароля */
    PASSWORD_MIN_LENGTH: 6,
    
    /** @type {number} Минимальная длина никнейма */
    NICKNAME_MIN_LENGTH: 2,
    
    /** @type {number} Максимальная длина никнейма */
    NICKNAME_MAX_LENGTH: 30
};

/**
 * Лимиты контента
 * @namespace
 */
const CONTENT_LIMITS = {
    /** @type {number} Максимальная длина заголовка поста */
    TITLE_MAX: 200,
    
    /** @type {number} Максимальная длина содержания поста */
    CONTENT_MAX: 100000,
    
    /** @type {number} Максимальная длина комментария */
    COMMENT_MAX: 2000,
    
    /** @type {number} Максимальное количество постов на странице */
    POSTS_PAGE_MAX: 100,
    
    /** @type {number} Количество постов по умолчанию на странице */
    POSTS_PAGE_DEFAULT: 20,

    /** @type {number} Количество постов в RSS-ленте */
    RSS_ITEMS: 30,

    /** @type {number} Максимальная длина описания записи в RSS */
    RSS_DESCRIPTION_MAX: 500
};

/**
 * Пороги уровней пользователей
 * @constant {Object<string, {comments: number, likesReceived: number}>}
 */
const LEVEL_THRESHOLDS = {
    newbie: { comments: 0, likesReceived: 0 },
    active: { comments: 10, likesReceived: 20 },
    expert: { comments: 50, likesReceived: 100 },
    plus: { comments: 200, likesReceived: 500 }
};

/**
 * HTTP статус коды
 * @constant {Object<string, number>}
 */
const HTTP_STATUS = {
    OK: 200,
    CREATED: 201,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    PAYLOAD_TOO_LARGE: 413,
    SERVER_ERROR: 500
};

/**
 * Сообщения об ошибках
 * @constant {Object<string, string>}
 */
const ERROR_MESSAGES = {
    // Auth
    ADMIN_TOKEN_NOT_CONFIGURED: 'Admin token не настроен',
    INVALID_ADMIN_TOKEN: 'Неверный admin token',
    INVALID_ROLE: 'Неверная роль',
    LOGIN_REQUIRED: 'Укажите логин',
    LOGIN_TOO_SHORT: `Логин должен содержать минимум ${AUTH_CONFIG.LOGIN_MIN_LENGTH} символа`,
    LOGIN_TOO_LONG: `Логин не должен превышать ${AUTH_CONFIG.LOGIN_MAX_LENGTH} символов`,
    LOGIN_INVALID_CHARS: 'Логин может содержать только латинские буквы, цифры и символы _ -',
    PASSWORD_REQUIRED: 'Укажите пароль',
    PASSWORD_TOO_SHORT: `Пароль должен содержать минимум ${AUTH_CONFIG.PASSWORD_MIN_LENGTH} символов`,
    NICKNAME_REQUIRED: 'Укажите имя пользователя',
    NICKNAME_TOO_SHORT: `Имя должно содержать минимум ${AUTH_CONFIG.NICKNAME_MIN_LENGTH} символа`,
    LOGIN_ALREADY_TAKEN: 'Этот логин уже занят',
    INVALID_CREDENTIALS: 'Неверный логин или пароль',
    USER_NOT_FOUND: 'Пользователь не найден',
    SESSION_EXPIRED: 'Сессия истекла',
    SESSION_CHECK_ERROR: 'Ошибка проверки сессии',
    AUTH_REQUIRED: 'Требуется авторизация',
    ADMIN_REQUIRED: 'Требуются права администратора',
    PROFILE_ERROR: 'Ошибка получения профиля',

    // Posts
    TITLE_REQUIRED: 'Укажите заголовок',
    TITLE_TOO_LONG: 'Заголовок слишком длинный',
    CONTENT_REQUIRED: 'Укажите содержание',
    CONTENT_TOO_LONG: 'Содержание слишком длинное',
    POST_NOT_FOUND: 'Пост не найден',
    POSTS_LOAD_ERROR: 'Ошибка загрузки постов',
    POST_CREATE_ERROR: 'Ошибка создания поста',
    POST_UPDATE_ERROR: 'Ошибка обновления поста',
    POST_DELETE_ERROR: 'Ошибка удаления поста',
    LIKE_ERROR: 'Ошибка лайка',
    DISLIKE_ERROR: 'Ошибка дизлайка',
    FAVORITE_ERROR: 'Ошибка избранного',
    PIN_ERROR: 'Ошибка закрепления',

    // Comments
    COMMENT_TEXT_REQUIRED: 'Текст не может быть пустым',
    COMMENT_TOO_LONG: 'Комментарий слишком длинный',
    PARENT_COMMENT_NOT_FOUND: 'Родительский комментарий не найден',
    COMMENT_NOT_FOUND: 'Комментарий не найден',
    COMMENT_OWN_ONLY: 'Можно редактировать только свои комментарии',
    INSUFFICIENT_PERMISSIONS: 'Недостаточно прав',
    COMMENTS_LOAD_ERROR: 'Ошибка загрузки комментариев',
    COMMENT_CREATE_ERROR: 'Ошибка создания комментария',
    COMMENT_UPDATE_ERROR: 'Ошибка редактирования',
    COMMENT_DELETE_ERROR: 'Ошибка удаления',

    // Upload
    FILE_NOT_UPLOADED: 'Файл не загружен',
    FILE_TOO_LARGE: `Файл превышает ${FILE_CONFIG.MAX_SIZE / 1024 / 1024} МБ`,
    FILE_UNSUPPORTED: 'Неподдерживаемый формат файла',
    UPLOAD_ERROR: 'Ошибка загрузки файла',

    // General
    REGISTRATION_ERROR: 'Ошибка регистрации',
    LOGIN_ERROR: 'Ошибка входа'
};

// ============================================
// KV Key Prefixes
// ============================================

/**
 * Фабрика ключей для Vercel KV
 * @namespace
 */
const K = {
    /**
     * Ключ для данных пользователя
     * @param {string} id - ID пользователя
     * @returns {string} Ключ KV
     */
    USER: (id) => `news:user:${id}`,
    
    /**
     * Ключ для поиска пользователя по логину
     * @param {string} login - Логин пользователя
     * @returns {string} Ключ KV
     */
    USER_BY_LOGIN: (login) => `news:login:${login.toLowerCase()}`,
    
    /**
     * Ключ для сессии
     * @param {string} token - Токен сессии
     * @returns {string} Ключ KV
     */
    SESSION: (token) => `news:session:${token}`,
    
    /**
     * Ключ для данных поста
     * @param {string} id - ID поста
     * @returns {string} Ключ KV
     */
    POST: (id) => `news:post:${id}`,
    
    /**
     * Ключ для данных комментария
     * @param {string} id - ID комментария
     * @returns {string} Ключ KV
     */
    COMMENT: (id) => `news:comment:${id}`,
    
    /**
     * Set лайков поста
     * @param {string} id - ID поста
     * @returns {string} Ключ KV
     */
    POST_LIKES: (id) => `news:post_likes:${id}`,
    
    /**
     * Set дизлайков поста
     * @param {string} id - ID поста
     * @returns {string} Ключ KV
     */
    POST_DISLIKES: (id) => `news:post_dislikes:${id}`,
    
    /**
     * Set избранных постов пользователя
     * @param {string} userId - ID пользователя
     * @returns {string} Ключ KV
     */
    POST_FAV: (userId) => `news:favorites:${userId}`,
    
    /**
     * Set лайков комментария
     * @param {string} id - ID комментария
     * @returns {string} Ключ KV
     */
    COMMENT_LIKES: (id) => `news:comment_likes:${id}`,
    
    /**
     * Set дизлайков комментария
     * @param {string} id - ID комментария
     * @returns {string} Ключ KV
     */
    COMMENT_DISLIKES: (id) => `news:comment_dislikes:${id}`,
    
    /**
     * Set комментариев поста
     * @param {string} postId - ID поста
     * @returns {string} Ключ KV
     */
    POST_COMMENTS: (postId) => `news:post_comments:${postId}`,
    
    /**
     * Set комментариев пользователя
     * @param {string} userId - ID пользователя
     * @returns {string} Ключ KV
     */
    USER_COMMENTS: (userId) => `news:user_comments:${userId}`,
    
    /**
     * Ключ для статистики пользователя
     * @param {string} id - ID пользователя
     * @returns {string} Ключ KV
     */
    USER_STATS: (id) => `news:stats:${id}`,
    
    /**
     * Ключ для уровня пользователя
     * @param {string} id - ID пользователя
     * @returns {string} Ключ KV
     */
    USER_LEVEL: (id) => `news:level:${id}`,
    
    /** @type {string} Индекс всех постов (Set) */
    POSTS_INDEX: 'news:posts:index'
};

// ============================================
// Password Service
// ============================================

/**
 * Сервис для работы с паролями (хеширование и верификация)
 * @namespace
 */
class PasswordService {
    /**
     * Генерация случайной соли
     * @returns {string} Соль в hex формате
     */
    generateSalt() {
        return crypto.randomBytes(AUTH_CONFIG.PASSWORD_SALT_LENGTH).toString('hex');
    }

    /**
     * Хеширование пароля с использованием PBKDF2
     * 
     * @param {string} password - Пароль
     * @param {string} salt - Соль
     * @returns {Promise<string>} Хеш в hex формате
     */
    hashPassword(password, salt) {
        return new Promise((resolve, reject) => {
            crypto.pbkdf2(
                password,
                salt,
                AUTH_CONFIG.PASSWORD_ITERATIONS,
                AUTH_CONFIG.PASSWORD_KEY_LENGTH,
                AUTH_CONFIG.PASSWORD_DIGEST,
                (err, derivedKey) => {
                    if (err) return reject(err);
                    resolve(derivedKey.toString('hex'));
                }
            );
        });
    }

    /**
     * Создание полного хеша пароля (соль + хеш)
     * 
     * @param {string} password - Пароль
     * @returns {Promise<string>} Формат: salt:hash
     */
    async createPasswordHash(password) {
        const salt = this.generateSalt();
        const hash = await this.hashPassword(password, salt);
        return `${salt}:${hash}`;
    }

    /**
     * Проверка пароля
     * 
     * @param {string} password - Пароль для проверки
     * @param {string} storedHash - Сохраненный хеш (salt:hash)
     * @returns {Promise<boolean>} true если пароль верный
     */
    async verifyPassword(password, storedHash) {
        const [salt, originalHash] = storedHash.split(':');
        if (!salt || !originalHash) return false;

        const hash = await this.hashPassword(password, salt);
        
        // Timing-safe сравнение для защиты от timing-атак
        try {
            return crypto.timingSafeEqual(
                Buffer.from(hash, 'hex'),
                Buffer.from(originalHash, 'hex')
            );
        } catch {
            return false;
        }
    }
}

/**
 * Экземпляр сервиса паролей
 * @type {PasswordService}
 */
const passwordService = new PasswordService();

// ============================================
// Validation Service
// ============================================

/**
 * Сервис для валидации входных данных
 * @namespace
 */
class ValidationService {
    /**
     * Валидация логина
     * 
     * @param {string} login - Логин
     * @returns {{ valid: boolean, error?: string, value?: string }}
     */
    validateLogin(login) {
        if (!login || typeof login !== 'string') {
            return { valid: false, error: ERROR_MESSAGES.LOGIN_REQUIRED };
        }

        const trimmed = login.trim();

        if (trimmed.length < AUTH_CONFIG.LOGIN_MIN_LENGTH) {
            return { valid: false, error: ERROR_MESSAGES.LOGIN_TOO_SHORT };
        }

        if (trimmed.length > AUTH_CONFIG.LOGIN_MAX_LENGTH) {
            return { valid: false, error: ERROR_MESSAGES.LOGIN_TOO_LONG };
        }

        if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
            return { valid: false, error: ERROR_MESSAGES.LOGIN_INVALID_CHARS };
        }

        return { valid: true, value: trimmed };
    }

    /**
     * Валидация пароля
     * 
     * @param {string} password - Пароль
     * @returns {{ valid: boolean, error?: string }}
     */
    validatePassword(password) {
        if (!password || typeof password !== 'string') {
            return { valid: false, error: ERROR_MESSAGES.PASSWORD_REQUIRED };
        }

        if (password.length < AUTH_CONFIG.PASSWORD_MIN_LENGTH) {
            return { valid: false, error: ERROR_MESSAGES.PASSWORD_TOO_SHORT };
        }

        return { valid: true };
    }

    /**
     * Валидация никнейма
     * 
     * @param {string} nickname - Никнейм
     * @returns {{ valid: boolean, error?: string, value?: string }}
     */
    validateNickname(nickname) {
        if (!nickname || typeof nickname !== 'string') {
            return { valid: false, error: ERROR_MESSAGES.NICKNAME_REQUIRED };
        }

        const trimmed = nickname.trim();

        if (trimmed.length < AUTH_CONFIG.NICKNAME_MIN_LENGTH) {
            return { valid: false, error: ERROR_MESSAGES.NICKNAME_TOO_SHORT };
        }

        const value = trimmed.slice(0, AUTH_CONFIG.NICKNAME_MAX_LENGTH);
        return { valid: true, value };
    }
}

/**
 * Экземпляр сервиса валидации
 * @type {ValidationService}
 */
const validationService = new ValidationService();

// ============================================
// KV Helper Service
// ============================================

/**
 * Сервис для работы с Vercel KV
 * @namespace
 */
class KVService {
    /**
     * Пакетное получение ключей с учетом лимитов Vercel KV
     * 
     * @param {Array<string>} keys - Массив ключей
     * @param {number} chunkSize - Размер чанка
     * @returns {Promise<Array>} Массив значений
     */
    async mgetChunked(keys, chunkSize = 100) {
        const results = [];
        for (let i = 0; i < keys.length; i += chunkSize) {
            const chunk = keys.slice(i, i + chunkSize);
            if (chunk.length > 0) {
                const res = await kv.mget(...chunk);
                results.push(...res);
            }
        }
        return results;
    }
}

/**
 * Экземпляр сервиса KV
 * @type {KVService}
 */
const kvService = new KVService();

// ============================================
// User Level Service
// ============================================

/**
 * Сервис для управления уровнями пользователей
 * @namespace
 */
class UserLevelService {
    /**
     * Вычисление уровня пользователя на основе статистики
     * 
     * @param {string} userId - ID пользователя
     * @returns {Promise<string>} Уровень пользователя
     */
    async calculate(userId) {
        if (!userId || userId === 'admin') return 'admin';

        const currentLevel = await kv.get(K.USER_LEVEL(userId)) || 'newbie';
        if (currentLevel === 'plus') return 'plus';

        const stats = await kv.get(K.USER_STATS(userId)) || { comments: 0, likesReceived: 0 };

        let newLevel = 'newbie';
        if (stats.comments >= LEVEL_THRESHOLDS.active.comments &&
            stats.likesReceived >= LEVEL_THRESHOLDS.active.likesReceived) {
            newLevel = 'active';
        }
        if (stats.comments >= LEVEL_THRESHOLDS.expert.comments &&
            stats.likesReceived >= LEVEL_THRESHOLDS.expert.likesReceived) {
            newLevel = 'expert';
        }
        if (stats.comments >= LEVEL_THRESHOLDS.plus.comments &&
            stats.likesReceived >= LEVEL_THRESHOLDS.plus.likesReceived) {
            newLevel = 'plus';
        }

        if (newLevel !== currentLevel) {
            await kv.set(K.USER_LEVEL(userId), newLevel);
        }

        return newLevel;
    }

    /**
     * Получение текущего уровня пользователя
     * 
     * @param {string} userId - ID пользователя
     * @returns {Promise<string>} Уровень
     */
    async get(userId) {
        if (!userId) return 'newbie';
        if (userId === 'admin') return 'admin';
        return await kv.get(K.USER_LEVEL(userId)) || 'newbie';
    }

    /**
     * Инкремент статистики пользователя
     * 
     * @param {string} userId - ID пользователя
     * @param {string} field - Поле статистики ('comments' | 'likesReceived')
     * @param {number} delta - Изменение
     * @returns {Promise<Object>} Обновленная статистика
     */
    async incrementStats(userId, field, delta = 1) {
        if (!userId || userId === 'admin') return null;

        const stats = await kv.get(K.USER_STATS(userId)) || { comments: 0, likesReceived: 0 };
        stats[field] = (stats[field] || 0) + delta;
        await kv.set(K.USER_STATS(userId), stats);
        await this.calculate(userId);

        return stats;
    }
}

/**
 * Экземпляр сервиса уровней
 * @type {UserLevelService}
 */
const userLevelService = new UserLevelService();

// ============================================
// Token Generator
// ============================================

/**
 * Генерация криптографически безопасного токена сессии
 * 
 * @returns {string} Токен в hex формате
 */
function generateSessionToken() {
    return crypto.randomBytes(AUTH_CONFIG.TOKEN_LENGTH).toString('hex');
}

// ============================================
// Auth Middleware
// ============================================

/**
 * Опциональная аутентификация
 * Устанавливает req.user если токен валиден, но не блокирует запрос
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 * @param {express.NextFunction} next - Следующий middleware
 */
async function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        try {
            const session = await kv.get(K.SESSION(token));
            if (session) req.user = session;
        } catch { /* Игнорируем ошибки KV */ }
    }
    next();
}

/**
 * Обязательная аутентификация
 * Блокирует запрос если токен невалиден
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 * @param {express.NextFunction} next - Следующий middleware
 */
async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: ERROR_MESSAGES.AUTH_REQUIRED });
    }

    const token = authHeader.split(' ')[1];
    try {
        const session = await kv.get(K.SESSION(token));
        if (!session) {
            return res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: ERROR_MESSAGES.SESSION_EXPIRED });
        }
        req.user = session;
        next();
    } catch {
        return res.status(HTTP_STATUS.SERVER_ERROR).json({ error: ERROR_MESSAGES.SESSION_CHECK_ERROR });
    }
}

/**
 * Проверка прав администратора
 * Должен использоваться после requireAuth
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 * @param {express.NextFunction} next - Следующий middleware
 */
function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(HTTP_STATUS.FORBIDDEN).json({ error: ERROR_MESSAGES.ADMIN_REQUIRED });
    }
    next();
}

// ============================================
// Data Enrichment Service
// ============================================

/**
 * Сервис для обогащения данных поста/комментария пользовательскими флагами
 * @namespace
 */
class DataEnrichmentService {
    /**
     * Обогащение поста данными о лайках и избранном
     * 
     * @param {string} postId - ID поста
     * @param {string|null} userId - ID текущего пользователя
     * @returns {Promise<Object|null>} Обогащенный пост
     */
    async enrichPost(postId, userId) {
        const post = await kv.get(K.POST(postId));
        if (!post) return null;

        if (post.likes === undefined) post.likes = 0;
        if (post.dislikes === undefined) post.dislikes = 0;
        if (post.commentsCount === undefined) post.commentsCount = 0;

        if (userId) {
            const [likesSet, dislikesSet, favorites] = await Promise.all([
                kv.sismember(K.POST_LIKES(postId), userId),
                kv.sismember(K.POST_DISLIKES(postId), userId),
                kv.sismember(K.POST_FAV(userId), postId)
            ]);
            post.isLiked = !!likesSet;
            post.isDisliked = !!dislikesSet;
            post.isFavorited = !!favorites;
        } else {
            post.isLiked = false;
            post.isDisliked = false;
            post.isFavorited = false;
        }

        return post;
    }

    /**
     * Обогащение комментария данными о лайках и уровне автора
     * 
     * @param {string} commentId - ID комментария
     * @param {string|null} userId - ID текущего пользователя
     * @returns {Promise<Object|null>} Обогащенный комментарий
     */
    async enrichComment(commentId, userId) {
        const comment = await kv.get(K.COMMENT(commentId));
        if (!comment) return null;

        const [likesCount, dislikesCount, isLiked, isDisliked] = await Promise.all([
            kv.scard(K.COMMENT_LIKES(commentId)),
            kv.scard(K.COMMENT_DISLIKES(commentId)),
            userId ? kv.sismember(K.COMMENT_LIKES(commentId), userId) : Promise.resolve(0),
            userId ? kv.sismember(K.COMMENT_DISLIKES(commentId), userId) : Promise.resolve(0)
        ]);

        comment.likes = likesCount;
        comment.dislikes = dislikesCount;
        comment.isLiked = isLiked === 1;
        comment.isDisliked = isDisliked === 1;
        comment.authorLevel = await userLevelService.get(comment.authorId);

        return comment;
    }
}

/**
 * Экземпляр сервиса обогащения данных
 * @type {DataEnrichmentService}
 */
const dataEnrichmentService = new DataEnrichmentService();

// ============================================
// Утилиты для работы с пользователем
// ============================================

/**
 * Удаление passwordHash из объекта пользователя перед отправкой
 * 
 * @param {Object} user - Объект пользователя
 * @returns {Object} Безопасный объект пользователя без passwordHash
 */
function sanitizeUser(user) {
    const { passwordHash: _, ...safeUser } = user;
    return safeUser;
}

/**
 * Экранирование спецсимволов для безопасной вставки в XML/RSS.
 *
 * @param {string} value - Исходная строка
 * @returns {string} Экранированная строка
 */
function escapeXml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Формирование краткого описания поста для RSS:
 * убирает базовую Markdown-разметку, схлопывает пробелы и обрезает по длине.
 *
 * @param {string} content - Содержание поста (Markdown)
 * @returns {string} Текстовое описание
 */
function buildRssDescription(content) {
    const text = String(content || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[#>*_~-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (text.length <= CONTENT_LIMITS.RSS_DESCRIPTION_MAX) return text;
    return text.slice(0, CONTENT_LIMITS.RSS_DESCRIPTION_MAX).trimEnd() + '…';
}

/**
 * Определение базового URL сайта по заголовкам запроса (учитывает прокси Vercel).
 *
 * @param {express.Request} req - HTTP запрос
 * @returns {string} Базовый URL вида https://host
 */
function resolveSiteBaseUrl(req) {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    return host ? `${proto}://${host}` : '';
}

/**
 * Валидация заголовка поста
 * 
 * @param {string} title - Заголовок
 * @returns {{ valid: boolean, error?: string, value?: string }}
 */
function validateTitle(title) {
    if (!title || typeof title !== 'string' || !title.trim()) {
        return { valid: false, error: ERROR_MESSAGES.TITLE_REQUIRED };
    }
    if (title.length > CONTENT_LIMITS.TITLE_MAX) {
        return { valid: false, error: ERROR_MESSAGES.TITLE_TOO_LONG };
    }
    return { valid: true, value: title.trim() };
}

/**
 * Валидация содержания поста
 * 
 * @param {string} content - Содержание
 * @returns {{ valid: boolean, error?: string, value?: string }}
 */
function validateContent(content) {
    if (!content || typeof content !== 'string' || !content.trim()) {
        return { valid: false, error: ERROR_MESSAGES.CONTENT_REQUIRED };
    }
    if (content.length > CONTENT_LIMITS.CONTENT_MAX) {
        return { valid: false, error: ERROR_MESSAGES.CONTENT_TOO_LONG };
    }
    return { valid: true, value: content };
}

// ============================================
// Routes: Authentication
// ============================================

/**
 * POST /auth/register — регистрация нового пользователя
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.post('/auth/register', async (req, res) => {
    try {
        const { login, password, nickname, role, adminToken } = req.body;

        // --- Регистрация администратора ---
        if (role === 'admin') {
            if (!ADMIN_TOKEN) {
                return res.status(HTTP_STATUS.SERVER_ERROR).json({ 
                    error: ERROR_MESSAGES.ADMIN_TOKEN_NOT_CONFIGURED 
                });
            }

            const isTokenValid = adminToken
                && adminToken.length === ADMIN_TOKEN.length
                && crypto.timingSafeEqual(Buffer.from(adminToken), Buffer.from(ADMIN_TOKEN));

            if (!isTokenValid) {
                return res.status(HTTP_STATUS.FORBIDDEN).json({ 
                    error: ERROR_MESSAGES.INVALID_ADMIN_TOKEN 
                });
            }

            const existingAdmin = await kv.get(K.USER('admin'));
            const adminUser = {
                id: 'admin',
                role: 'admin',
                nickname: 'Oris',
                avatar: '/favicon.svg',
                createdAt: new Date().toISOString()
            };

            if (!existingAdmin) {
                await kv.set(K.USER('admin'), adminUser);
            }

            const token = generateSessionToken();
            await kv.set(K.SESSION(token), adminUser, { ex: AUTH_CONFIG.SESSION_TTL_ADMIN });

            return res.json({ user: { ...adminUser, token } });
        }

        // --- Регистрация читателя ---
        if (role === 'reader') {
            // Валидация логина
            const loginValidation = validationService.validateLogin(login);
            if (!loginValidation.valid) {
                return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: loginValidation.error });
            }
            const cleanLogin = loginValidation.value;

            // Валидация пароля
            const passwordValidation = validationService.validatePassword(password);
            if (!passwordValidation.valid) {
                return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: passwordValidation.error });
            }

            // Валидация никнейма
            const nicknameValidation = validationService.validateNickname(nickname);
            if (!nicknameValidation.valid) {
                return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: nicknameValidation.error });
            }
            const cleanNickname = nicknameValidation.value;

            // Проверка уникальности логина
            const existingLogin = await kv.get(K.USER_BY_LOGIN(cleanLogin));
            if (existingLogin) {
                return res.status(HTTP_STATUS.CONFLICT).json({ error: ERROR_MESSAGES.LOGIN_ALREADY_TAKEN });
            }

            // Хеширование пароля
            const passwordHash = await passwordService.createPasswordHash(password);

            // Создание ID на основе логина
            const readerId = cleanLogin.toLowerCase();

            const readerUser = {
                id: readerId,
                role: 'reader',
                login: cleanLogin,
                nickname: cleanNickname,
                passwordHash: passwordHash,
                level: 'newbie',
                createdAt: new Date().toISOString()
            };

            await kv.set(K.USER(readerId), readerUser);
            await kv.set(K.USER_BY_LOGIN(cleanLogin), readerId);
            await kv.set(K.USER_LEVEL(readerId), 'newbie');
            await kv.set(K.USER_STATS(readerId), { comments: 0, likesReceived: 0 });

            const token = generateSessionToken();
            await kv.set(K.SESSION(token), readerUser, { ex: AUTH_CONFIG.SESSION_TTL_READER });

            return res.json({ user: { ...sanitizeUser(readerUser), token } });
        }

        return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: ERROR_MESSAGES.INVALID_ROLE });
    } catch (err) {
        console.error('[news/auth/register]', err);
        return res.status(HTTP_STATUS.SERVER_ERROR).json({ 
            error: err.message || ERROR_MESSAGES.REGISTRATION_ERROR 
        });
    }
});

/**
 * POST /auth/login — вход по логину и паролю
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.post('/auth/login', async (req, res) => {
    try {
        const { login, password } = req.body;

        // Валидация входных данных
        if (!login || !password) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: ERROR_MESSAGES.INVALID_CREDENTIALS });
        }

        // Поиск пользователя по логину
        const userId = await kv.get(K.USER_BY_LOGIN(login.trim().toLowerCase()));
        if (!userId) {
            return res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: ERROR_MESSAGES.INVALID_CREDENTIALS });
        }

        const user = await kv.get(K.USER(userId));
        if (!user || !user.passwordHash) {
            return res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: ERROR_MESSAGES.INVALID_CREDENTIALS });
        }

        // Проверка пароля
        const isPasswordValid = await passwordService.verifyPassword(password, user.passwordHash);
        if (!isPasswordValid) {
            return res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: ERROR_MESSAGES.INVALID_CREDENTIALS });
        }

        // Обновление уровня
        user.level = await userLevelService.get(user.id);

        // Создание сессии
        const token = generateSessionToken();
        await kv.set(K.SESSION(token), user, { ex: AUTH_CONFIG.SESSION_TTL_READER });

        return res.json({ user: { ...sanitizeUser(user), token } });
    } catch (err) {
        console.error('[news/auth/login]', err);
        return res.status(HTTP_STATUS.SERVER_ERROR).json({ error: ERROR_MESSAGES.LOGIN_ERROR });
    }
});

/**
 * GET /auth/me — текущий пользователь
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.get('/auth/me', requireAuth, async (req, res) => {
    try {
        const user = await kv.get(K.USER(req.user.id));
        if (!user) {
            return res.status(HTTP_STATUS.NOT_FOUND).json({ error: ERROR_MESSAGES.USER_NOT_FOUND });
        }
        user.level = await userLevelService.get(req.user.id);

        return res.json(sanitizeUser(user));
    } catch (err) {
        console.error('[news/auth/me]', err);
        return res.status(HTTP_STATUS.SERVER_ERROR).json({ error: ERROR_MESSAGES.PROFILE_ERROR });
    }
});

// ============================================
// Routes: Posts
// ============================================

/**
 * GET /posts — список постов с пагинацией
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.get('/posts', optionalAuth, async (req, res) => {
    try {
        const limit = Math.min(
            parseInt(req.query.limit) || CONTENT_LIMITS.POSTS_PAGE_DEFAULT, 
            CONTENT_LIMITS.POSTS_PAGE_MAX
        );
        const page = Math.max(parseInt(req.query.page) || 1, 1);

        const query = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
        const sort = req.query.sort === 'popular' ? 'popular' : 'newest';

        const postIds = await kv.smembers(K.POSTS_INDEX);
        if (!postIds || postIds.length === 0) {
            return res.json({ posts: [], total: 0, page, limit, query, sort });
        }

        const keys = postIds.map(id => K.POST(id));
        const postsData = await kvService.mgetChunked(keys);

        let validPosts = postsData.filter(p => p && p.id);

        if (query) {
            validPosts = validPosts.filter(p => {
                const haystack = `${p.title || ''} ${p.content || ''} ${p.authorName || ''}`.toLowerCase();
                return haystack.includes(query);
            });
        }

        const popularity = (p) => (p.likes || 0) + (p.commentsCount || 0);
        validPosts.sort((a, b) => {
            if (a.isPinned && !b.isPinned) return -1;
            if (!a.isPinned && b.isPinned) return 1;
            if (sort === 'popular') {
                const diff = popularity(b) - popularity(a);
                if (diff !== 0) return diff;
            }
            return new Date(b.createdAt) - new Date(a.createdAt);
        });

        const total = validPosts.length;
        const startIndex = (page - 1) * limit;
        const paginatedPosts = validPosts.slice(startIndex, startIndex + limit);

        const posts = [];
        const userId = req.user?.id;

        for (const post of paginatedPosts) {
            const enriched = await dataEnrichmentService.enrichPost(post.id, userId);
            if (enriched) posts.push(enriched);
        }

        return res.json({ posts, total, page, limit, query, sort });
    } catch (err) {
        console.error('[news/posts GET]', err);
        return res.status(HTTP_STATUS.SERVER_ERROR).json({ error: ERROR_MESSAGES.POSTS_LOAD_ERROR });
    }
});

/**
 * GET /rss — RSS 2.0 лента последних постов.
 * Отдаёт валидный XML для агрегаторов: заголовок, ссылку на пост,
 * автора, дату публикации и краткое описание.
 *
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.get('/rss', async (req, res) => {
    try {
        const baseUrl = resolveSiteBaseUrl(req) || 'https://oris-flax.vercel.app';

        const postIds = await kv.smembers(K.POSTS_INDEX);
        let posts = [];
        if (postIds && postIds.length > 0) {
            const keys = postIds.map(id => K.POST(id));
            const postsData = await kvService.mgetChunked(keys);
            posts = postsData
                .filter(p => p && p.id)
                .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
                .slice(0, CONTENT_LIMITS.RSS_ITEMS);
        }

        const items = posts.map(p => {
            const link = `${baseUrl}/news?shared=${p.id}`;
            const pubDate = new Date(p.createdAt || Date.now()).toUTCString();
            return [
                '        <item>',
                `            <title>${escapeXml(p.title || 'Без названия')}</title>`,
                `            <link>${escapeXml(link)}</link>`,
                `            <guid isPermaLink="true">${escapeXml(link)}</guid>`,
                `            <dc:creator>${escapeXml(p.authorName || 'Oris')}</dc:creator>`,
                `            <pubDate>${pubDate}</pubDate>`,
                `            <description>${escapeXml(buildRssDescription(p.content))}</description>`,
                '        </item>'
            ].join('\n');
        }).join('\n');

        const feedUrl = `${baseUrl}/api/news/rss`;
        const xml = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">',
            '    <channel>',
            '        <title>Новости Oris</title>',
            `        <link>${escapeXml(`${baseUrl}/news`)}</link>`,
            `        <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />`,
            '        <description>Обновления, релизы и технические статьи от команды разработки.</description>',
            '        <language>ru</language>',
            `        <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`,
            items,
            '    </channel>',
            '</rss>'
        ].filter(Boolean).join('\n');

        res.set('Content-Type', 'application/rss+xml; charset=utf-8');
        res.set('Cache-Control', 'public, max-age=300');
        return res.send(xml);
    } catch (err) {
        console.error('[news/rss GET]', err);
        return res.status(HTTP_STATUS.SERVER_ERROR).send('Failed to generate RSS feed');
    }
});

/**
 * POST /posts — создание поста (только админ)
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.post('/posts', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { title, content, files } = req.body;

        // Валидация заголовка
        const titleValidation = validateTitle(title);
        if (!titleValidation.valid) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: titleValidation.error });
        }

        // Валидация содержания
        const contentValidation = validateContent(content);
        if (!contentValidation.valid) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: contentValidation.error });
        }

        const postId = crypto.randomUUID();
        const now = new Date().toISOString();

        const post = {
            id: postId,
            title: titleValidation.value,
            content: contentValidation.value,
            files: Array.isArray(files) ? files : [],
            authorId: req.user.id,
            authorRole: req.user.role,
            authorName: req.user.nickname,
            createdAt: now,
            updatedAt: now,
            isPinned: false,
            likes: 0,
            dislikes: 0,
            commentsCount: 0
        };

        await kv.set(K.POST(postId), post);
        await kv.sadd(K.POSTS_INDEX, postId);

        const enriched = await dataEnrichmentService.enrichPost(postId, req.user.id);
        return res.json({ post: enriched });
    } catch (err) {
        console.error('[news/posts POST]', err);
        return res.status(HTTP_STATUS.SERVER_ERROR).json({ error: ERROR_MESSAGES.POST_CREATE_ERROR });
    }
});

/**
 * PUT /posts/:id — обновление поста (только админ)
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.put('/posts/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, content, files } = req.body;

        const existing = await kv.get(K.POST(id));
        if (!existing) {
            return res.status(HTTP_STATUS.NOT_FOUND).json({ error: ERROR_MESSAGES.POST_NOT_FOUND });
        }

        // Валидация заголовка
        const titleValidation = validateTitle(title);
        if (!titleValidation.valid) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: titleValidation.error });
        }

        // Валидация содержания
        const contentValidation = validateContent(content);
        if (!contentValidation.valid) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: contentValidation.error });
        }

        const updated = {
            ...existing,
            title: titleValidation.value,
            content: contentValidation.value,
            files: Array.isArray(files) ? files : existing.files,
            updatedAt: new Date().toISOString()
        };

        await kv.set(K.POST(id), updated);
        const enriched = await dataEnrichmentService.enrichPost(id, req.user.id);
        return res.json({ post: enriched });
    } catch (err) {
        console.error('[news/posts PUT]', err);
        return res.status(HTTP_STATUS.SERVER_ERROR).json({ error: ERROR_MESSAGES.POST_UPDATE_ERROR });
    }
});

/**
 * DELETE /posts/:id — удаление поста со всеми комментариями (только админ)
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.delete('/posts/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const existing = await kv.get(K.POST(id));
        if (!existing) {
            return res.status(HTTP_STATUS.NOT_FOUND).json({ error: ERROR_MESSAGES.POST_NOT_FOUND });
        }

        const commentIds = await kv.smembers(K.POST_COMMENTS(id));
        const deletePromises = [];

        // Удаление всех комментариев и их лайков
        for (const cid of commentIds) {
            deletePromises.push(kv.del(K.COMMENT(cid)));
            deletePromises.push(kv.del(K.COMMENT_LIKES(cid)));
            deletePromises.push(kv.del(K.COMMENT_DISLIKES(cid)));
        }

        // Удаление поста и связанных данных
        deletePromises.push(kv.del(K.POST(id)));
        deletePromises.push(kv.srem(K.POSTS_INDEX, id));
        deletePromises.push(kv.del(K.POST_LIKES(id)));
        deletePromises.push(kv.del(K.POST_DISLIKES(id)));
        deletePromises.push(kv.del(K.POST_COMMENTS(id)));

        await Promise.all(deletePromises);

        return res.json({ success: true });
    } catch (err) {
        console.error('[news/posts DELETE]', err);
        return res.status(HTTP_STATUS.SERVER_ERROR).json({ error: ERROR_MESSAGES.POST_DELETE_ERROR });
    }
});

/**
 * POST /posts/:id/like — лайк/анлайк поста
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.post('/posts/:id/like', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const post = await kv.get(K.POST(id));
        if (!post) {
            return res.status(HTTP_STATUS.NOT_FOUND).json({ error: ERROR_MESSAGES.POST_NOT_FOUND });
        }

        const alreadyLiked = await kv.sismember(K.POST_LIKES(id), userId);
        const wasDisliked = await kv.sismember(K.POST_DISLIKES(id), userId);

        let newLikes = post.likes || 0;
        let newDislikes = post.dislikes || 0;

        if (alreadyLiked) {
            await kv.srem(K.POST_LIKES(id), userId);
            newLikes = Math.max(0, newLikes - 1);
        } else {
            await kv.sadd(K.POST_LIKES(id), userId);
            newLikes += 1;
            if (wasDisliked) {
                await kv.srem(K.POST_DISLIKES(id), userId);
                newDislikes = Math.max(0, newDislikes - 1);
            }
        }

        post.likes = newLikes;
        post.dislikes = newDislikes;
        await kv.set(K.POST(id), post);

        return res.json({ 
            likes: newLikes, 
            dislikes: newDislikes, 
            isLiked: !alreadyLiked, 
            isDisliked: false 
        });
    } catch (err) {
        console.error('[news/posts/like]', err);
        return res.status(HTTP_STATUS.SERVER_ERROR).json({ error: ERROR_MESSAGES.LIKE_ERROR });
    }
});

/**
 * POST /posts/:id/dislike — дизлайк/андизлайк поста
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.post('/posts/:id/dislike', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const post = await kv.get(K.POST(id));
        if (!post) {
            return res.status(HTTP_STATUS.NOT_FOUND).json({ error: ERROR_MESSAGES.POST_NOT_FOUND });
        }

        const alreadyDisliked = await kv.sismember(K.POST_DISLIKES(id), userId);
        const wasLiked = await kv.sismember(K.POST_LIKES(id), userId);

        let newLikes = post.likes || 0;
        let newDislikes = post.dislikes || 0;

        if (alreadyDisliked) {
            await kv.srem(K.POST_DISLIKES(id), userId);
            newDislikes = Math.max(0, newDislikes - 1);
        } else {
            await kv.sadd(K.POST_DISLIKES(id), userId);
            newDislikes += 1;
            if (wasLiked) {
                await kv.srem(K.POST_LIKES(id), userId);
                newLikes = Math.max(0, newLikes - 1);
            }
        }

        post.likes = newLikes;
        post.dislikes = newDislikes;
        await kv.set(K.POST(id), post);

        return res.json({ 
            likes: newLikes, 
            dislikes: newDislikes, 
            isLiked: false, 
            isDisliked: !alreadyDisliked 
        });
    } catch (err) {
        console.error('[news/posts/dislike]', err);
        return res.status(HTTP_STATUS.SERVER_ERROR).json({ error: ERROR_MESSAGES.DISLIKE_ERROR });
    }
});

/**
 * POST /posts/:id/favorite — добавить/убрать из избранного
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.post('/posts/:id/favorite', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const post = await kv.get(K.POST(id));
        if (!post) {
            return res.status(HTTP_STATUS.NOT_FOUND).json({ error: ERROR_MESSAGES.POST_NOT_FOUND });
        }

        const isFav = await kv.sismember(K.POST_FAV(userId), id);

        if (isFav) {
            await kv.srem(K.POST_FAV(userId), id);
        } else {
            await kv.sadd(K.POST_FAV(userId), id);
        }

        return res.json({ isFavorited: !isFav });
    } catch (err) {
        console.error('[news/posts/favorite]', err);
        return res.status(HTTP_STATUS.SERVER_ERROR).json({ error: ERROR_MESSAGES.FAVORITE_ERROR });
    }
});

/**
 * POST /posts/:id/pin — закрепить/открепить пост (только админ)
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.post('/posts/:id/pin', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const post = await kv.get(K.POST(id));
        if (!post) {
            return res.status(HTTP_STATUS.NOT_FOUND).json({ error: ERROR_MESSAGES.POST_NOT_FOUND });
        }

        post.isPinned = !post.isPinned;
        await kv.set(K.POST(id), post);

        return res.json({ isPinned: post.isPinned });
    } catch (err) {
        console.error('[news/posts/pin]', err);
        return res.status(HTTP_STATUS.SERVER_ERROR).json({ error: ERROR_MESSAGES.PIN_ERROR });
    }
});

// ============================================
// Routes: Comments
// ============================================

/**
 * GET /posts/:postId/comments — комментарии поста
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.get('/posts/:postId/comments', optionalAuth, async (req, res) => {
    try {
        const { postId } = req.params;
        const post = await kv.get(K.POST(postId));
        if (!post) {
            return res.status(HTTP_STATUS.NOT_FOUND).json({ error: ERROR_MESSAGES.POST_NOT_FOUND });
        }

        const commentIds = await kv.smembers(K.POST_COMMENTS(postId));
        const keys = commentIds.map(cid => K.COMMENT(cid));
        const commentsData = await kvService.mgetChunked(keys);

        const comments = [];
        for (const comment of commentsData) {
            if (comment && comment.id) {
                const enriched = await dataEnrichmentService.enrichComment(comment.id, req.user?.id);
                if (enriched) comments.push(enriched);
            }
        }

        return res.json({ comments });
    } catch (err) {
        console.error('[news/comments GET]', err);
        return res.status(HTTP_STATUS.SERVER_ERROR).json({ error: ERROR_MESSAGES.COMMENTS_LOAD_ERROR });
    }
});

/**
 * POST /posts/:postId/comments — создать комментарий
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.post('/posts/:postId/comments', requireAuth, async (req, res) => {
    try {
        const { postId } = req.params;
        const { text, parentId } = req.body;

        // Валидация текста
        if (!text || typeof text !== 'string' || !text.trim()) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: ERROR_MESSAGES.COMMENT_TEXT_REQUIRED });
        }
        if (text.length > CONTENT_LIMITS.COMMENT_MAX) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: ERROR_MESSAGES.COMMENT_TOO_LONG });
        }

        const post = await kv.get(K.POST(postId));
        if (!post) {
            return res.status(HTTP_STATUS.NOT_FOUND).json({ error: ERROR_MESSAGES.POST_NOT_FOUND });
        }

        // Проверка родительского комментария
        if (parentId) {
            const parent = await kv.get(K.COMMENT(parentId));
            if (!parent || parent.postId !== postId) {
                return res.status(HTTP_STATUS.BAD_REQUEST).json({ 
                    error: ERROR_MESSAGES.PARENT_COMMENT_NOT_FOUND 
                });
            }
        }

        const commentId = crypto.randomUUID();
        const now = new Date().toISOString();

        const comment = {
            id: commentId,
            postId: postId,
            parentId: parentId || null,
            text: text.trim(),
            authorId: req.user.id,
            authorRole: req.user.role,
            authorName: req.user.nickname,
            createdAt: now,
            isEdited: false,
            isPinned: false
        };

        await kv.set(K.COMMENT(commentId), comment);
        await kv.sadd(K.POST_COMMENTS(postId), commentId);

        // Обновление счётчика комментариев поста
        const postForCount = await kv.get(K.POST(postId));
        if (postForCount) {
            postForCount.commentsCount = (postForCount.commentsCount || 0) + 1;
            await kv.set(K.POST(postId), postForCount);
        }

        // Обновление статистики пользователя
        await kv.sadd(K.USER_COMMENTS(req.user.id), commentId);
        await userLevelService.incrementStats(req.user.id, 'comments', 1);

        const enriched = await dataEnrichmentService.enrichComment(commentId, req.user.id);
        return res.json({ comment: enriched });
    } catch (err) {
        console.error('[news/comments POST]', err);
        return res.status(HTTP_STATUS.SERVER_ERROR).json({ error: ERROR_MESSAGES.COMMENT_CREATE_ERROR });
    }
});

/**
 * PUT /comments/:id — редактировать комментарий
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.put('/comments/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { text } = req.body;

        // Валидация текста
        if (!text || !text.trim()) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: ERROR_MESSAGES.COMMENT_TEXT_REQUIRED });
        }
        if (text.length > CONTENT_LIMITS.COMMENT_MAX) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: ERROR_MESSAGES.COMMENT_TOO_LONG });
        }

        const comment = await kv.get(K.COMMENT(id));
        if (!comment) {
            return res.status(HTTP_STATUS.NOT_FOUND).json({ error: ERROR_MESSAGES.COMMENT_NOT_FOUND });
        }
        if (comment.authorId !== req.user.id) {
            return res.status(HTTP_STATUS.FORBIDDEN).json({ error: ERROR_MESSAGES.COMMENT_OWN_ONLY });
        }

        comment.text = text.trim();
        comment.isEdited = true;
        await kv.set(K.COMMENT(id), comment);

        const enriched = await dataEnrichmentService.enrichComment(id, req.user.id);
        return res.json({ comment: enriched });
    } catch (err) {
        console.error('[news/comments PUT]', err);
        return res.status(HTTP_STATUS.SERVER_ERROR).json({ error: ERROR_MESSAGES.COMMENT_UPDATE_ERROR });
    }
});

/**
 * DELETE /comments/:id — удалить комментарий (рекурсивно)
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.delete('/comments/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        const comment = await kv.get(K.COMMENT(id));
        if (!comment) {
            return res.status(HTTP_STATUS.NOT_FOUND).json({ error: ERROR_MESSAGES.COMMENT_NOT_FOUND });
        }

        const isOwner = comment.authorId === req.user.id;
        const isAdmin = req.user.role === 'admin';

        if (!isOwner && !isAdmin) {
            return res.status(HTTP_STATUS.FORBIDDEN).json({ error: ERROR_MESSAGES.INSUFFICIENT_PERMISSIONS });
        }

        // Сбор всех ID для удаления (рекурсивно)
        const allCommentIds = await kv.smembers(K.POST_COMMENTS(comment.postId));
        const commentKeys = allCommentIds.map(cid => K.COMMENT(cid));
        const allCommentsData = await kvService.mgetChunked(commentKeys);

        const commentsMap = {};
        for (const c of allCommentsData) {
            if (c && c.id) commentsMap[c.id] = c;
        }

        const idsToDelete = [];

        /**
         * Рекурсивный сбор ID для удаления
         * @param {string} currentId - ID текущего комментария
         */
        function collectIds(currentId) {
            idsToDelete.push(currentId);
            for (const c of Object.values(commentsMap)) {
                if (c.parentId === currentId) {
                    collectIds(c.id);
                }
            }
        }

        collectIds(id);

        // Удаление всех найденных комментариев
        const deletePromises = [];
        for (const cid of idsToDelete) {
            deletePromises.push(kv.del(K.COMMENT(cid)));
            deletePromises.push(kv.del(K.COMMENT_LIKES(cid)));
            deletePromises.push(kv.del(K.COMMENT_DISLIKES(cid)));
            deletePromises.push(kv.srem(K.POST_COMMENTS(comment.postId), cid));

            if (commentsMap[cid]?.authorId) {
                deletePromises.push(kv.srem(K.USER_COMMENTS(commentsMap[cid].authorId), cid));
            }
        }
        await Promise.all(deletePromises);

        // Обновление счётчика комментариев поста
        const postForCount = await kv.get(K.POST(comment.postId));
        if (postForCount) {
            postForCount.commentsCount = Math.max(0, (postForCount.commentsCount || 0) - idsToDelete.length);
            await kv.set(K.POST(comment.postId), postForCount);
        }

        return res.json({ success: true, deletedCount: idsToDelete.length });
    } catch (err) {
        console.error('[news/comments DELETE]', err);
        return res.status(HTTP_STATUS.SERVER_ERROR).json({ error: ERROR_MESSAGES.COMMENT_DELETE_ERROR });
    }
});

/**
 * POST /comments/:id/like — лайк комментария
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.post('/comments/:id/like', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const comment = await kv.get(K.COMMENT(id));
        if (!comment) {
            return res.status(HTTP_STATUS.NOT_FOUND).json({ error: ERROR_MESSAGES.COMMENT_NOT_FOUND });
        }

        const alreadyLiked = await kv.sismember(K.COMMENT_LIKES(id), userId);
        const wasDisliked = await kv.sismember(K.COMMENT_DISLIKES(id), userId);

        if (alreadyLiked) {
            await kv.srem(K.COMMENT_LIKES(id), userId);
            if (comment.authorId && comment.authorId !== userId) {
                await userLevelService.incrementStats(comment.authorId, 'likesReceived', -1);
            }
        } else {
            await kv.sadd(K.COMMENT_LIKES(id), userId);
            if (wasDisliked) {
                await kv.srem(K.COMMENT_DISLIKES(id), userId);
            }
            if (comment.authorId && comment.authorId !== userId) {
                await userLevelService.incrementStats(comment.authorId, 'likesReceived', 1);
            }
        }

        const likesCount = await kv.scard(K.COMMENT_LIKES(id));
        const dislikesCount = await kv.scard(K.COMMENT_DISLIKES(id));

        return res.json({ 
            likes: likesCount, 
            dislikes: dislikesCount, 
            isLiked: !alreadyLiked, 
            isDisliked: false 
        });
    } catch (err) {
        console.error('[news/comments/like]', err);
        return res.status(HTTP_STATUS.SERVER_ERROR).json({ error: ERROR_MESSAGES.LIKE_ERROR });
    }
});

/**
 * POST /comments/:id/dislike — дизлайк комментария
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.post('/comments/:id/dislike', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const comment = await kv.get(K.COMMENT(id));
        if (!comment) {
            return res.status(HTTP_STATUS.NOT_FOUND).json({ error: ERROR_MESSAGES.COMMENT_NOT_FOUND });
        }

        const alreadyDisliked = await kv.sismember(K.COMMENT_DISLIKES(id), userId);
        const wasLiked = await kv.sismember(K.COMMENT_LIKES(id), userId);

        if (alreadyDisliked) {
            await kv.srem(K.COMMENT_DISLIKES(id), userId);
        } else {
            await kv.sadd(K.COMMENT_DISLIKES(id), userId);
            if (wasLiked) {
                await kv.srem(K.COMMENT_LIKES(id), userId);
                if (comment.authorId && comment.authorId !== userId) {
                    await userLevelService.incrementStats(comment.authorId, 'likesReceived', -1);
                }
            }
        }

        const likesCount = await kv.scard(K.COMMENT_LIKES(id));
        const dislikesCount = await kv.scard(K.COMMENT_DISLIKES(id));

        return res.json({ 
            likes: likesCount, 
            dislikes: dislikesCount, 
            isLiked: false, 
            isDisliked: !alreadyDisliked 
        });
    } catch (err) {
        console.error('[news/comments/dislike]', err);
        return res.status(HTTP_STATUS.SERVER_ERROR).json({ error: ERROR_MESSAGES.DISLIKE_ERROR });
    }
});

/**
 * POST /comments/:id/pin — закрепить комментарий (только админ)
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.post('/comments/:id/pin', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const comment = await kv.get(K.COMMENT(id));
        if (!comment) {
            return res.status(HTTP_STATUS.NOT_FOUND).json({ error: ERROR_MESSAGES.COMMENT_NOT_FOUND });
        }

        comment.isPinned = !comment.isPinned;
        await kv.set(K.COMMENT(id), comment);

        return res.json({ isPinned: comment.isPinned });
    } catch (err) {
        console.error('[news/comments/pin]', err);
        return res.status(HTTP_STATUS.SERVER_ERROR).json({ error: ERROR_MESSAGES.PIN_ERROR });
    }
});

// ============================================
// Route: File Upload
// ============================================

/**
 * POST /upload — загрузка файла в Vercel Blob (только админ)
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.post('/upload', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: ERROR_MESSAGES.FILE_NOT_UPLOADED });
        }
        if (req.file.size > FILE_CONFIG.MAX_SIZE) {
            return res.status(HTTP_STATUS.PAYLOAD_TOO_LARGE).json({ error: ERROR_MESSAGES.FILE_TOO_LARGE });
        }

        if (!FILE_CONFIG.ALLOWED_MIMETYPES.includes(req.file.mimetype)) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: ERROR_MESSAGES.FILE_UNSUPPORTED });
        }

        const ext = path.extname(req.file.originalname).toLowerCase() || '.bin';
        const uniqueName = `${crypto.randomUUID()}${ext}`;
        const blobPath = `${FILE_CONFIG.UPLOAD_DIR}/${uniqueName}`;

        const blob = await put(blobPath, req.file.buffer, {
            access: 'public',
            addRandomSuffix: false,
            contentType: req.file.mimetype
        });

        return res.json({
            url: blob.url,
            name: req.file.originalname,
            size: req.file.size,
            contentType: req.file.mimetype
        });
    } catch (err) {
        console.error('[news/upload]', err);
        return res.status(HTTP_STATUS.SERVER_ERROR).json({ 
            error: `${ERROR_MESSAGES.UPLOAD_ERROR}: ${err.message}` 
        });
    }
});

// ============================================
// Экспорт роутера
// ============================================

module.exports = router;