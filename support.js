const express = require('express');
const crypto = require('crypto');
const { kv } = require('@vercel/kv');
const multer = require('multer');
const { put } = require('@vercel/blob');

const router = express.Router();

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
 * Конфигурация системы поддержки
 * @namespace
 */
const CONFIG = {
    /** @type {number} Максимальная длина имени пользователя */
    MAX_NAME_LENGTH: 40,
    
    /** @type {number} Минимальная длина имени пользователя */
    MIN_NAME_LENGTH: 2,
    
    /** @type {number} Максимальная длина темы тикета */
    MAX_SUBJECT_LENGTH: 120,
    
    /** @type {number} Минимальная длина темы тикета */
    MIN_SUBJECT_LENGTH: 3,
    
    /** @type {number} Максимальная длина сообщения */
    MAX_MESSAGE_LENGTH: 2000,
    
    /** @type {number} Минимальная длина сообщения */
    MIN_MESSAGE_LENGTH: 2,
    
    /** @type {number} Интервал rate limiting для сообщений (мс) */
    RATE_LIMIT_INTERVAL: 2000,
    
    /** @type {number} TTL ключа rate limiting (сек) */
    RATE_LIMIT_TTL: 3,
    
    /** @type {number} TTL сессии пользователя (1 год в секундах) */
    USER_SESSION_TTL: 60 * 60 * 24 * 365,
    
    /** @type {number} TTL сессии администратора (30 дней в секундах) */
    ADMIN_SESSION_TTL: 60 * 60 * 24 * 30,
    
    /** @type {number} Размер чанка для пакетной загрузки из KV */
    KV_MGET_CHUNK_SIZE: 100,
    
    /** @type {number} Максимальный размер файла (10 МБ) */
    MAX_FILE_SIZE: 10 * 1024 * 1024,
    
    /** @type {number} Длина ID тикета/сообщения в байтах */
    ID_BYTES_LENGTH: 8,
    
    /** @type {number} Длина токена сессии в байтах */
    TOKEN_BYTES_LENGTH: 32,
    
    /** @type {number} Длина случайного суффикса для имени файла в байтах */
    FILE_SUFFIX_BYTES_LENGTH: 4
};

/**
 * Сообщения об ошибках
 * @constant {Object<string, string>}
 */
const ERROR_MESSAGES = {
    // Аутентификация
    AUTH_REQUIRED: 'Требуется авторизация',
    SESSION_EXPIRED: 'Сессия истекла',
    SESSION_CHECK_ERROR: 'Ошибка проверки сессии',
    ADMIN_REQUIRED: 'Требуются права администратора',
    ADMIN_TOKEN_NOT_CONFIGURED: 'Admin token не настроен на сервере',
    INVALID_ADMIN_TOKEN: 'Неверный токен администратора',
    TOKEN_REQUIRED: 'Укажите токен',
    NAME_TOO_SHORT: `Имя должно содержать минимум ${CONFIG.MIN_NAME_LENGTH} символа`,
    NAME_TOO_LONG: 'Имя слишком длинное',
    
    // Тикеты
    TICKET_CREATE_USER_ONLY: 'Тикеты создают только пользователи',
    SUBJECT_REQUIRED: 'Тема обязательна',
    SUBJECT_TOO_SHORT: `Тема должна содержать минимум ${CONFIG.MIN_SUBJECT_LENGTH} символа`,
    SUBJECT_TOO_LONG: `Тема слишком длинная (макс. ${CONFIG.MAX_SUBJECT_LENGTH})`,
    MESSAGE_REQUIRED: 'Напишите первое сообщение',
    MESSAGE_TOO_SHORT: `Сообщение должно содержать минимум ${CONFIG.MIN_MESSAGE_LENGTH} символа`,
    MESSAGE_TOO_LONG: `Сообщение слишком длинное (макс. ${CONFIG.MAX_MESSAGE_LENGTH})`,
    ID_GENERATION_ERROR: 'Ошибка генерации ID, повторите',
    TICKET_NOT_FOUND: 'Тикет не найден',
    TICKET_ACCESS_DENIED: 'Нет доступа к этому тикету',
    TICKET_CLOSED: 'Тикет закрыт. Только администратор может переоткрыть его.',
    TICKETS_LOAD_ERROR: 'Ошибка загрузки тикетов',
    TICKET_CREATE_ERROR: 'Ошибка создания тикета',
    
    // Сообщения
    EMPTY_MESSAGE: 'Сообщение не может быть пустым',
    RATE_LIMIT_EXCEEDED: (seconds) => `Подождите ${seconds} сек.`,
    MESSAGE_SEND_ERROR: 'Ошибка отправки',
    
    // Статус
    INVALID_STATUS: 'Неверный статус. Допустимые: open, closed',
    STATUS_CHANGE_ERROR: 'Ошибка изменения статуса',
    
    // Файлы
    FILE_NOT_UPLOADED: 'Файл не загружен',
    UNSUPPORTED_FILE_TYPE: 'Неподдерживаемый тип файла',
    FILE_SAVE_ERROR: 'Не удалось сохранить файл',
    FILE_UPLOAD_ERROR: 'Ошибка загрузки файла',
    
    // Общие
    AUTH_ERROR: 'Ошибка авторизации',
    LOGOUT_ERROR: 'Ошибка выхода',
    LOAD_ERROR: 'Ошибка загрузки'
};

/**
 * Разрешённые MIME-типы для загрузки файлов
 * @constant {Array<string>}
 */
const ALLOWED_MIME_TYPES = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'application/pdf', 'text/plain',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
];

/**
 * Допустимые статусы тикета
 * @constant {Array<string>}
 */
const VALID_STATUSES = ['open', 'closed'];

// ============================================
// KV Keys
// ============================================

/**
 * Фабрика ключей для Vercel KV
 * @namespace
 */
const K = {
    /**
     * Ключ для данных тикета
     * @param {string} id - ID тикета
     * @returns {string} Ключ KV
     */
    TICKET: (id) => `support:ticket:${id}`,
    
    /** @type {string} Set всех ID тикетов */
    TICKETS: 'support:tickets',
    
    /**
     * Ключ для сессии
     * @param {string} token - Токен сессии
     * @returns {string} Ключ KV
     */
    SESSION: (token) => `support:session:${token}`,
    
    /**
     * Set тикетов пользователя
     * @param {string} token - Токен пользователя
     * @returns {string} Ключ KV
     */
    USER_TICKETS: (token) => `support:user_tickets:${token}`,
    
    /**
     * Ключ для rate limiting
     * @param {string} token - Токен пользователя
     * @returns {string} Ключ KV
     */
    RATE_LIMIT: (token) => `support:ratelimit:${token}`
};

// ============================================
// Multer Configuration
// ============================================

/**
 * Multer middleware для обработки multipart/form-data
 * @type {multer.Instance}
 */
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: CONFIG.MAX_FILE_SIZE }
});

// ============================================
// Утилиты: Генерация ID и токенов
// ============================================

/**
 * Генерация уникального ID (hex строка)
 * 
 * @returns {string} Уникальный ID длиной 16 символов
 * 
 * @example
 * generateId(); // 'a1b2c3d4e5f6g7h8'
 */
function generateId() {
    return crypto.randomBytes(CONFIG.ID_BYTES_LENGTH).toString('hex');
}

/**
 * Генерация криптографически безопасного токена сессии
 * 
 * @returns {string} Токен длиной 64 символа
 */
function generateToken() {
    return crypto.randomBytes(CONFIG.TOKEN_BYTES_LENGTH).toString('hex');
}

// ============================================
// Утилиты: Санитизация
// ============================================

/**
 * Базовая санитизация строки
 * Удаляет HTML-теги и ограничивает длину
 * 
 * @param {string|null|undefined} str - Исходная строка
 * @param {number} maxLen - Максимальная длина
 * @returns {string} Очищенная строка
 */
function sanitize(str, maxLen = 5000) {
    if (str == null) return '';
    return String(str)
        .replace(/[<>]/g, '')   // защита от HTML-инъекций
        .trim()
        .slice(0, maxLen);
}

/**
 * Санитизация имени пользователя
 * 
 * @param {string} name - Исходное имя
 * @returns {string} Очищенное имя
 */
function sanitizeName(name) {
    return sanitize(name, CONFIG.MAX_NAME_LENGTH);
}

/**
 * Санитизация темы тикета
 * 
 * @param {string} subject - Исходная тема
 * @returns {string} Очищенная тема
 */
function sanitizeSubject(subject) {
    return sanitize(subject, CONFIG.MAX_SUBJECT_LENGTH);
}

/**
 * Санитизация текста сообщения
 * 
 * @param {string} text - Исходный текст
 * @returns {string} Очищенный текст
 */
function sanitizeMessage(text) {
    return sanitize(text, CONFIG.MAX_MESSAGE_LENGTH);
}

// ============================================
// Middleware: Аутентификация
// ============================================

/**
 * Опциональная проверка сессии пользователя
 * Устанавливает req.session если токен валиден
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 * @param {express.NextFunction} next - Следующий middleware
 */
async function optionalUserSession(req, res, next) {
    const authHeader = req.headers.authorization;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        
        try {
            const session = await kv.get(K.SESSION(token));
            if (session) {
                req.session = session;
            }
        } catch (error) {
            // Игнорируем ошибки KV
        }
    }
    
    next();
}

/**
 * Обязательная авторизация (пользователь или админ)
 * Устанавливает req.session и req.authToken
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 * @param {express.NextFunction} next - Следующий middleware
 */
async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: ERROR_MESSAGES.AUTH_REQUIRED });
    }
    
    const token = authHeader.split(' ')[1];
    
    try {
        const session = await kv.get(K.SESSION(token));
        
        if (!session) {
            return res.status(401).json({ error: ERROR_MESSAGES.SESSION_EXPIRED });
        }
        
        req.session = session;
        req.authToken = token; // сохраняем токен для дальнейшего использования
        next();
        
    } catch (error) {
        console.error('[support] requireAuth error:', error.message);
        return res.status(500).json({ error: ERROR_MESSAGES.SESSION_CHECK_ERROR });
    }
}

/**
 * Middleware для проверки прав администратора
 * Должен использоваться после requireAuth
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 * @param {express.NextFunction} next - Следующий middleware
 */
function requireAdmin(req, res, next) {
    if (!req.session || req.session.role !== 'admin') {
        return res.status(403).json({ error: ERROR_MESSAGES.ADMIN_REQUIRED });
    }
    next();
}

// ============================================
// Rate Limiting
// ============================================

/**
 * Проверка и обновление rate limit для отправки сообщений
 * Использует KV для распределённого rate limiting
 * 
 * @param {string} token - Токен пользователя
 * @returns {Promise<number>} Количество секунд до следующей отправки (0 если можно отправлять)
 */
async function checkMessageRateLimit(token) {
    const key = K.RATE_LIMIT(token);
    const lastTimestamp = await kv.get(key);
    const now = Date.now();
    
    // Проверка интервала
    if (lastTimestamp && (now - lastTimestamp) < CONFIG.RATE_LIMIT_INTERVAL) {
        const remainingMs = CONFIG.RATE_LIMIT_INTERVAL - (now - lastTimestamp);
        return Math.ceil(remainingMs / 1000);
    }
    
    // Обновление timestamp с TTL
    await kv.set(key, now, { ex: CONFIG.RATE_LIMIT_TTL });
    return 0;
}

// ============================================
// Маршруты: Аутентификация
// ============================================

/**
 * POST /auth/user — создание или восстановление сессии пользователя
 * 
 * @param {express.Request} req - HTTP запрос с { name?: string, token?: string }
 * @param {express.Response} res - HTTP ответ
 */
router.post('/auth/user', async (req, res) => {
    try {
        const { name, token } = req.body;

        // Если токен передан — проверяем существующую сессию
        if (token) {
            const session = await kv.get(K.SESSION(token));
            
            if (session && session.role === 'user') {
                return res.json({ session, token });
            }
        }

        // Валидация имени
        if (!name || String(name).trim().length < CONFIG.MIN_NAME_LENGTH) {
            return res.status(400).json({ error: ERROR_MESSAGES.NAME_TOO_SHORT });
        }
        
        if (String(name).length > CONFIG.MAX_NAME_LENGTH) {
            return res.status(400).json({ error: ERROR_MESSAGES.NAME_TOO_LONG });
        }

        // Создание новой сессии
        const newToken = generateToken();
        const session = {
            role: 'user',
            name: sanitizeName(name),
            createdAt: new Date().toISOString()
        };
        
        await kv.set(K.SESSION(newToken), session, { ex: CONFIG.USER_SESSION_TTL });

        res.json({ session, token: newToken });
        
    } catch (error) {
        console.error('[support/auth/user]', error);
        res.status(500).json({ error: ERROR_MESSAGES.AUTH_ERROR });
    }
});

/**
 * POST /auth/admin — вход администратора
 * 
 * @param {express.Request} req - HTTP запрос с { token: string }
 * @param {express.Response} res - HTTP ответ
 */
router.post('/auth/admin', async (req, res) => {
    try {
        const { token } = req.body;

        // Проверка наличия ADMIN_TOKEN
        if (!ADMIN_TOKEN) {
            console.error('[support] ADMIN_TOKEN не задан в переменных окружения');
            return res.status(500).json({ error: ERROR_MESSAGES.ADMIN_TOKEN_NOT_CONFIGURED });
        }
        
        // Валидация входного токена
        if (!token || typeof token !== 'string') {
            return res.status(400).json({ error: ERROR_MESSAGES.TOKEN_REQUIRED });
        }

        // Timing-safe сравнение для защиты от timing-атак
        const isValid = token.length === ADMIN_TOKEN.length &&
            crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN));

        if (!isValid) {
            return res.status(403).json({ error: ERROR_MESSAGES.INVALID_ADMIN_TOKEN });
        }

        // Создание сессии администратора
        const sessionToken = generateToken();
        const session = {
            role: 'admin',
            name: 'Support Team',
            createdAt: new Date().toISOString()
        };
        
        await kv.set(K.SESSION(sessionToken), session, { ex: CONFIG.ADMIN_SESSION_TTL });

        res.json({ session, token: sessionToken });
        
    } catch (error) {
        console.error('[support/auth/admin]', error);
        res.status(500).json({ error: ERROR_MESSAGES.AUTH_ERROR });
    }
});

/**
 * POST /auth/logout — выход из системы
 * 
 * @param {express.Request} req - HTTP запрос (требует авторизации)
 * @param {express.Response} res - HTTP ответ
 */
router.post('/auth/logout', requireAuth, async (req, res) => {
    try {
        await kv.del(K.SESSION(req.authToken));
        res.json({ success: true });
    } catch (error) {
        console.error('[support/auth/logout]', error);
        res.status(500).json({ error: ERROR_MESSAGES.LOGOUT_ERROR });
    }
});

// ============================================
// Маршруты: Тикеты
// ============================================

/**
 * Валидация данных для создания тикета
 * 
 * @param {Object} body - Тело запроса
 * @returns {{ valid: boolean, error?: string, data?: { subject: string, firstMessage: string } }}
 */
function validateTicketCreation(body) {
    const { subject, firstMessage } = body;

    // Валидация темы
    if (!subject || typeof subject !== 'string') {
        return { valid: false, error: ERROR_MESSAGES.SUBJECT_REQUIRED };
    }
    
    const trimmedSubject = subject.trim();
    
    if (trimmedSubject.length < CONFIG.MIN_SUBJECT_LENGTH) {
        return { valid: false, error: ERROR_MESSAGES.SUBJECT_TOO_SHORT };
    }
    
    if (trimmedSubject.length > CONFIG.MAX_SUBJECT_LENGTH) {
        return { valid: false, error: ERROR_MESSAGES.SUBJECT_TOO_LONG };
    }

    // Валидация первого сообщения
    if (!firstMessage || typeof firstMessage !== 'string') {
        return { valid: false, error: ERROR_MESSAGES.MESSAGE_REQUIRED };
    }
    
    const trimmedMessage = firstMessage.trim();
    
    if (trimmedMessage.length < CONFIG.MIN_MESSAGE_LENGTH) {
        return { valid: false, error: ERROR_MESSAGES.MESSAGE_TOO_SHORT };
    }
    
    if (trimmedMessage.length > CONFIG.MAX_MESSAGE_LENGTH) {
        return { valid: false, error: ERROR_MESSAGES.MESSAGE_TOO_LONG };
    }

    return {
        valid: true,
        data: {
            subject: trimmedSubject,
            firstMessage: trimmedMessage
        }
    };
}

/**
 * Создание объекта тикета
 * 
 * @param {string} ticketId - ID тикета
 * @param {string} subject - Тема тикета
 * @param {string} firstMessage - Первое сообщение
 * @param {string} userToken - Токен пользователя
 * @param {string} userName - Имя пользователя
 * @param {string} createdAt - Timestamp создания
 * @returns {Object} Объект тикета
 */
function createTicketObject(ticketId, subject, firstMessage, userToken, userName, createdAt) {
    return {
        id: ticketId,
        subject: sanitizeSubject(subject),
        status: 'open',
        userToken: userToken,
        userName: sanitizeName(userName),
        createdAt: createdAt,
        updatedAt: createdAt,
        messages: [
            {
                id: generateId(),
                from: 'user',
                fromName: sanitizeName(userName),
                text: sanitizeMessage(firstMessage),
                createdAt: createdAt
            }
        ]
    };
}

/**
 * POST /tickets — создание нового тикета (только для пользователей)
 * 
 * @param {express.Request} req - HTTP запрос с { subject: string, firstMessage: string }
 * @param {express.Response} res - HTTP ответ
 */
router.post('/tickets', requireAuth, async (req, res) => {
    try {
        // Проверка роли
        if (req.session.role !== 'user') {
            return res.status(403).json({ error: ERROR_MESSAGES.TICKET_CREATE_USER_ONLY });
        }

        // Валидация данных
        const validation = validateTicketCreation(req.body);
        if (!validation.valid) {
            return res.status(400).json({ error: validation.error });
        }

        const { subject, firstMessage } = validation.data;
        const ticketId = generateId();
        const now = new Date().toISOString();
        const userToken = req.authToken;

        // Создание объекта тикета
        const ticket = createTicketObject(
            ticketId,
            subject,
            firstMessage,
            userToken,
            req.session.name,
            now
        );

        // Проверка на коллизию ID (маловероятно, но для надёжности)
        const existing = await kv.get(K.TICKET(ticketId));
        if (existing) {
            return res.status(500).json({ error: ERROR_MESSAGES.ID_GENERATION_ERROR });
        }

        // Сохранение в KV
        await kv.set(K.TICKET(ticketId), ticket);
        await kv.sadd(K.TICKETS, ticketId);
        await kv.sadd(K.USER_TICKETS(userToken), ticketId);

        res.json({ ticket });
        
    } catch (error) {
        console.error('[support/tickets POST]', error);
        res.status(500).json({ error: ERROR_MESSAGES.TICKET_CREATE_ERROR });
    }
});

/**
 * Загрузка тикетов из KV пакетно
 * 
 * @param {Array<string>} ticketIds - Массив ID тикетов
 * @returns {Promise<Array<Object>>} Массив объектов тикетов
 */
async function loadTicketsBatch(ticketIds) {
    const keys = ticketIds.map(id => K.TICKET(id));
    const ticketsData = [];
    
    // Пакетная загрузка чанками
    for (let i = 0; i < keys.length; i += CONFIG.KV_MGET_CHUNK_SIZE) {
        const chunk = await kv.mget(...keys.slice(i, i + CONFIG.KV_MGET_CHUNK_SIZE));
        ticketsData.push(...chunk);
    }
    
    return ticketsData;
}

/**
 * Форматирование тикета для краткого ответа
 * 
 * @param {Object} ticket - Полный объект тикета
 * @returns {Object} Краткая информация о тикете
 */
function formatTicketSummary(ticket) {
    return {
        id: ticket.id,
        subject: ticket.subject,
        status: ticket.status,
        userName: ticket.userName,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
        lastMessage: ticket.messages[ticket.messages.length - 1] || null,
        messagesCount: ticket.messages.length
    };
}

/**
 * GET /tickets — получение списка тикетов
 * Админ видит все, пользователь видит только свои
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.get('/tickets', requireAuth, async (req, res) => {
    try {
        let ticketIds = [];

        // Получение ID тикетов в зависимости от роли
        if (req.session.role === 'admin') {
            ticketIds = await kv.smembers(K.TICKETS);
        } else {
            ticketIds = await kv.smembers(K.USER_TICKETS(req.authToken));
        }

        // Дедупликация (исправление бага возможных дублей в Set)
        const uniqueIds = [...new Set(ticketIds)];

        if (!uniqueIds || uniqueIds.length === 0) {
            return res.json({ tickets: [] });
        }

        // Пакетная загрузка тикетов
        const ticketsData = await loadTicketsBatch(uniqueIds);

        // Форматирование и сортировка
        const tickets = ticketsData
            .filter(ticket => ticket && ticket.id) // отбрасываем null/undefined
            .map(formatTicketSummary)
            .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

        res.json({ tickets });
        
    } catch (error) {
        console.error('[support/tickets GET]', error);
        res.status(500).json({ error: ERROR_MESSAGES.TICKETS_LOAD_ERROR });
    }
});

/**
 * Проверка доступа к тикету
 * 
 * @param {Object} ticket - Объект тикета
 * @param {Object} session - Сессия пользователя
 * @param {string} authToken - Токен авторизации
 * @returns {boolean} true если доступ разрешён
 */
function hasTicketAccess(ticket, session, authToken) {
    // Админ имеет доступ ко всем тикетам
    if (session.role === 'admin') {
        return true;
    }
    
    // Пользователь имеет доступ только к своим тикетам
    return ticket.userToken === authToken;
}

/**
 * GET /tickets/:id — получение одного тикета с сообщениями
 * 
 * @param {express.Request} req - HTTP запрос
 * @param {express.Response} res - HTTP ответ
 */
router.get('/tickets/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const ticket = await kv.get(K.TICKET(id));

        if (!ticket) {
            return res.status(404).json({ error: ERROR_MESSAGES.TICKET_NOT_FOUND });
        }

        // Проверка доступа
        if (!hasTicketAccess(ticket, req.session, req.authToken)) {
            return res.status(403).json({ error: ERROR_MESSAGES.TICKET_ACCESS_DENIED });
        }

        res.json({ ticket });
        
    } catch (error) {
        console.error('[support/tickets GET :id]', error);
        res.status(500).json({ error: ERROR_MESSAGES.LOAD_ERROR });
    }
});

/**
 * Валидация текста сообщения
 * 
 * @param {string} text - Текст сообщения
 * @returns {{ valid: boolean, error?: string, text?: string }}
 */
function validateMessageText(text) {
    if (!text || typeof text !== 'string') {
        return { valid: false, error: ERROR_MESSAGES.EMPTY_MESSAGE };
    }
    
    const trimmedText = text.trim();
    
    if (trimmedText.length === 0) {
        return { valid: false, error: ERROR_MESSAGES.EMPTY_MESSAGE };
    }
    
    if (trimmedText.length > CONFIG.MAX_MESSAGE_LENGTH) {
        return { valid: false, error: ERROR_MESSAGES.MESSAGE_TOO_LONG };
    }
    
    return { valid: true, text: trimmedText };
}

/**
 * POST /tickets/:id/messages — отправка сообщения в тикет
 * 
 * @param {express.Request} req - HTTP запрос с { text: string }
 * @param {express.Response} res - HTTP ответ
 */
router.post('/tickets/:id/messages', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        // Валидация текста сообщения
        const validation = validateMessageText(req.body.text);
        if (!validation.valid) {
            return res.status(400).json({ error: validation.error });
        }

        // Rate limit (распределённый)
        const waitSeconds = await checkMessageRateLimit(req.authToken);
        if (waitSeconds > 0) {
            return res.status(429).json({ 
                error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED(waitSeconds) 
            });
        }

        // Загрузка тикета
        const ticket = await kv.get(K.TICKET(id));
        
        if (!ticket) {
            return res.status(404).json({ error: ERROR_MESSAGES.TICKET_NOT_FOUND });
        }

        // Проверка статуса для пользователей
        if (ticket.status === 'closed' && req.session.role !== 'admin') {
            return res.status(403).json({ error: ERROR_MESSAGES.TICKET_CLOSED });
        }

        // Проверка доступа
        if (!hasTicketAccess(ticket, req.session, req.authToken)) {
            return res.status(403).json({ error: ERROR_MESSAGES.TICKET_ACCESS_DENIED });
        }

        // Создание сообщения
        const now = new Date().toISOString();
        const message = {
            id: generateId(),
            from: req.session.role, // 'user' или 'admin'
            fromName: sanitizeName(req.session.name),
            text: sanitizeMessage(validation.text),
            createdAt: now
        };

        // Обновление тикета
        ticket.messages.push(message);
        ticket.updatedAt = now;
        
        // Пользователь переоткрывает закрытый тикет
        if (ticket.status === 'closed' && req.session.role === 'user') {
            ticket.status = 'open';
        }

        await kv.set(K.TICKET(id), ticket);

        res.json({ 
            message, 
            ticket: { 
                status: ticket.status, 
                updatedAt: now 
            } 
        });
        
    } catch (error) {
        console.error('[support/messages POST]', error);
        res.status(500).json({ error: ERROR_MESSAGES.MESSAGE_SEND_ERROR });
    }
});

/**
 * POST /tickets/:id/status — изменение статуса тикета (только админ)
 * 
 * @param {express.Request} req - HTTP запрос с { status: 'open' | 'closed' }
 * @param {express.Response} res - HTTP ответ
 */
router.post('/tickets/:id/status', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        // Валидация статуса
        if (!VALID_STATUSES.includes(status)) {
            return res.status(400).json({ error: ERROR_MESSAGES.INVALID_STATUS });
        }

        // Загрузка тикета
        const ticket = await kv.get(K.TICKET(id));
        
        if (!ticket) {
            return res.status(404).json({ error: ERROR_MESSAGES.TICKET_NOT_FOUND });
        }

        // Обновление статуса
        ticket.status = status;
        ticket.updatedAt = new Date().toISOString();
        
        await kv.set(K.TICKET(id), ticket);

        res.json({ ticket });
        
    } catch (error) {
        console.error('[support/status]', error);
        res.status(500).json({ error: ERROR_MESSAGES.STATUS_CHANGE_ERROR });
    }
});

// ============================================
// Маршруты: Загрузка файлов
// ============================================

/**
 * Генерация уникального имени файла для Blob Storage
 * 
 * @param {string} originalName - Оригинальное имя файла
 * @returns {string} Уникальное имя файла
 */
function generateUniqueFileName(originalName) {
    const ext = originalName.split('.').pop();
    const timestamp = Date.now();
    const randomSuffix = crypto.randomBytes(CONFIG.FILE_SUFFIX_BYTES_LENGTH).toString('hex');
    return `support/${timestamp}_${randomSuffix}.${ext}`;
}

/**
 * Загрузка файла в Vercel Blob Storage
 * 
 * @param {string} fileName - Имя файла в Blob
 * @param {Buffer} buffer - Буфер файла
 * @param {string} contentType - MIME тип файла
 * @returns {Promise<string>} URL загруженного файла
 */
async function uploadToBlob(fileName, buffer, contentType) {
    const blob = await put(fileName, buffer, {
        access: 'public',
        contentType: contentType
    });
    return blob.url;
}

/**
 * POST /upload — загрузка файла (только для авторизованных)
 * 
 * @param {express.Request} req - HTTP запрос с файлом в multipart/form-data
 * @param {express.Response} res - HTTP ответ
 */
router.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
    try {
        const file = req.file;
        
        if (!file) {
            return res.status(400).json({ error: ERROR_MESSAGES.FILE_NOT_UPLOADED });
        }

        // Проверка MIME типа
        if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
            return res.status(400).json({ error: ERROR_MESSAGES.UNSUPPORTED_FILE_TYPE });
        }

        // Генерация уникального имени
        const fileName = generateUniqueFileName(file.originalname);

        let blobUrl;
        
        try {
            // Загрузка в Vercel Blob
            blobUrl = await uploadToBlob(fileName, file.buffer, file.mimetype);
        } catch (blobError) {
            console.error('[support/upload] Blob error:', blobError);
            
            // Fallback для разработки (не использовать в проде)
            if (process.env.NODE_ENV !== 'production') {
                const base64 = file.buffer.toString('base64');
                blobUrl = `data:${file.mimetype};base64,${base64.substring(0, 100)}...[truncated]`;
                console.warn('[support/upload] Vercel Blob не настроен, используется data URL (только для разработки)');
            } else {
                throw new Error(ERROR_MESSAGES.FILE_SAVE_ERROR);
            }
        }

        res.json({
            url: blobUrl,
            name: file.originalname,
            size: file.size,
            contentType: file.mimetype
        });
        
    } catch (error) {
        console.error('[support/upload]', error);
        res.status(500).json({ error: ERROR_MESSAGES.FILE_UPLOAD_ERROR });
    }
});

// ============================================
// Экспорт роутера
// ============================================

module.exports = router;