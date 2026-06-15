const express = require('express');
const crypto = require('crypto');
const { kv } = require('@vercel/kv');

const router = express.Router();

// ============================================
// Переменные окружения
// ============================================

/** @constant {string} Токен администратора */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

/** @constant {string} Токен Telegram-бота */
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

/** @constant {string} Chat ID для уведомлений */
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!ADMIN_TOKEN) {
    throw new Error('ADMIN_TOKEN environment variable is required');
}

// ============================================
// Конфигурация
// ============================================

/**
 * Конфигурация модуля Team
 * @namespace
 */
const CONFIG = {
    /** @type {number} Длина кода заявки */
    CODE_LENGTH: 6,
    
    /** @type {string} Символы для генерации кода */
    CODE_CHARS: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
    
    /** @type {number} Длина логина (суффикс) */
    LOGIN_SUFFIX_LENGTH: 4,
    
    /** @type {number} Длина пароля */
    PASSWORD_LENGTH: 10,
    
    /** @type {number} Длина токена сессии (байты) */
    SESSION_TOKEN_BYTES: 32,
    
    /** @type {number} Длина соли для пароля (байты) */
    PASSWORD_SALT_BYTES: 16,
    
    /** @type {number} Длина хеша пароля (байты) */
    PASSWORD_KEY_LENGTH: 64,
    
    /** @type {number} Итерации PBKDF2 */
    PASSWORD_ITERATIONS: 100000,
    
    /** @type {number} TTL сессии (30 дней) */
    SESSION_TTL: 60 * 60 * 24 * 30,
    
    /** @type {number} Минимальная длина ФИО */
    MIN_NAME_LENGTH: 2,
    
    /** @type {number} Максимальная длина ФИО */
    MAX_NAME_LENGTH: 100,
    
    /** @type {number} Минимальный возраст */
    MIN_AGE: 14,
    
    /** @type {number} Максимальный возраст */
    MAX_AGE: 100,
    
    /** @type {number} Максимальная длина телефона */
    MAX_PHONE_LENGTH: 20,
    
    /** @type {number} Максимальная длина контакта */
    MAX_CONTACT_LENGTH: 100
};

/**
 * Сообщения об ошибках
 * @constant {Object<string, string>}
 */
const ERROR_MESSAGES = {
    // Валидация
    NAME_REQUIRED: 'Укажите ФИО',
    NAME_TOO_SHORT: `ФИО должно содержать минимум ${CONFIG.MIN_NAME_LENGTH} символа`,
    NAME_TOO_LONG: `ФИО слишком длинное (макс. ${CONFIG.MAX_NAME_LENGTH})`,
    CONTACT_REQUIRED: 'Укажите Telegram или email',
    CONTACT_INVALID: 'Некорректный Telegram username или email',
    AGE_REQUIRED: 'Укажите возраст',
    AGE_INVALID: `Возраст должен быть от ${CONFIG.MIN_AGE} до ${CONFIG.MAX_AGE}`,
    PHONE_INVALID: 'Некорректный номер телефона',
    
    // Заявки
    APPLICATION_NOT_FOUND: 'Заявка не найдена',
    APPLICATION_PENDING: 'Заявка на рассмотрении',
    APPLICATION_REJECTED: 'Заявка отклонена',
    APPLICATION_ALREADY_APPROVED: 'Заявка уже одобрена',
    
    // Авторизация
    INVALID_CREDENTIALS: 'Неверный логин или пароль',
    AUTH_REQUIRED: 'Требуется авторизация',
    SESSION_EXPIRED: 'Сессия истекла',
    ADMIN_REQUIRED: 'Требуются права администратора',
    INVALID_ADMIN_TOKEN: 'Неверный admin token',
    
    // Общие
    SERVER_ERROR: 'Ошибка сервера',
    RATE_LIMITED: 'Слишком много запросов'
};

// ============================================
// KV Keys
// ============================================

/**
 * Фабрика ключей для Vercel KV
 * @namespace
 */
const K = {
    /** @param {string} code */
    APPLICATION: (code) => `team:app:${code}`,
    APPLICATIONS_INDEX: 'team:apps:index',
    /** @param {string} login */
    USER: (login) => `team:user:${login}`,
    USERS_INDEX: 'team:users:index',
    /** @param {string} token */
    SESSION: (token) => `team:session:${token}`
};

// ============================================
// Утилиты: Генерация
// ============================================

/**
 * Генерация кода заявки
 * @returns {string} 6-символьный код
 */
function generateCode() {
    let result = '';
    for (let i = 0; i < CONFIG.CODE_LENGTH; i++) {
        result += CONFIG.CODE_CHARS[Math.floor(Math.random() * CONFIG.CODE_CHARS.length)];
    }
    return result;
}

/**
 * Генерация логина на основе ФИО
 * @param {string} fullName - ФИО
 * @returns {string} Логин
 */
function generateLogin(fullName) {
    const firstName = fullName.trim().split(/\s+/)[0] || 'user';
    const translitMap = {
        'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e',
        'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
        'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
        'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch',
        'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya'
    };
    const transliterated = firstName.toLowerCase().split('').map(c => translitMap[c] !== undefined ? translitMap[c] : c).join('');
    const clean = transliterated.replace(/[^a-z0-9]/g, '') || 'user';
    const suffix = crypto.randomBytes(CONFIG.LOGIN_SUFFIX_LENGTH).toString('hex').slice(0, CONFIG.LOGIN_SUFFIX_LENGTH);
    return `${clean}_${suffix}`;
}

/**
 * Генерация пароля
 * @returns {string} Случайный пароль
 */
function generatePassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let result = '';
    const bytes = crypto.randomBytes(CONFIG.PASSWORD_LENGTH);
    for (let i = 0; i < CONFIG.PASSWORD_LENGTH; i++) {
        result += chars[bytes[i] % chars.length];
    }
    return result;
}

/**
 * Генерация токена сессии
 * @returns {string} Токен в hex формате
 */
function generateSessionToken() {
    return crypto.randomBytes(CONFIG.SESSION_TOKEN_BYTES).toString('hex');
}

// ============================================
// Утилиты: Хеширование паролей
// ============================================

/**
 * Хеширование пароля с солью
 * @param {string} password - Пароль
 * @returns {Promise<string>} Формат salt:hash
 */
async function hashPassword(password) {
    const salt = crypto.randomBytes(CONFIG.PASSWORD_SALT_BYTES).toString('hex');
    return new Promise((resolve, reject) => {
        crypto.pbkdf2(password, salt, CONFIG.PASSWORD_ITERATIONS, CONFIG.PASSWORD_KEY_LENGTH, 'sha512', (err, key) => {
            if (err) reject(err);
            else resolve(`${salt}:${key.toString('hex')}`);
        });
    });
}

/**
 * Проверка пароля
 * @param {string} password - Пароль
 * @param {string} stored - Формат salt:hash
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, stored) {
    const [salt, originalHash] = stored.split(':');
    if (!salt || !originalHash) return false;
    return new Promise((resolve) => {
        crypto.pbkdf2(password, salt, CONFIG.PASSWORD_ITERATIONS, CONFIG.PASSWORD_KEY_LENGTH, 'sha512', (err, key) => {
            if (err) return resolve(false);
            try {
                resolve(crypto.timingSafeEqual(Buffer.from(key.toString('hex'), 'hex'), Buffer.from(originalHash, 'hex')));
            } catch {
                resolve(false);
            }
        });
    });
}

// ============================================
// Утилиты: Валидация
// ============================================

/**
 * Валидация контакта (Telegram или email)
 * @param {string} contact - Контакт
 * @returns {boolean}
 */
function isValidContact(contact) {
    if (!contact) return false;
    const trimmed = contact.trim();
    // Telegram username
    if (trimmed.startsWith('@') && /^@[a-zA-Z0-9_]{3,32}$/.test(trimmed)) return true;
    // Email
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return true;
    return false;
}

/**
 * Валидация телефона
 * @param {string} phone - Телефон
 * @returns {boolean}
 */
function isValidPhone(phone) {
    if (!phone) return true; // необязательное поле
    return /^\+?[\d\s\-()]{7,20}$/.test(phone.trim());
}

// ============================================
// Утилиты: Telegram
// ============================================

/**
 * Отправка уведомления в Telegram
 * @param {string} text - Текст сообщения
 */
async function sendTelegramNotification(text) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.warn('[Team] Telegram credentials not configured');
        return;
    }
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text,
                parse_mode: 'HTML'
            })
        });
    } catch (err) {
        console.error('[Team] Telegram send error:', err.message);
    }
}

// ============================================
// Middleware
// ============================================

/**
 * Проверка токена администратора
 */
function verifyAdminToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: ERROR_MESSAGES.AUTH_REQUIRED });
    }
    const token = authHeader.split(' ')[1];
    const isValid = ADMIN_TOKEN && token &&
        token.length === ADMIN_TOKEN.length &&
        crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN));
    if (!isValid) {
        return res.status(403).json({ error: ERROR_MESSAGES.INVALID_ADMIN_TOKEN });
    }
    next();
}

/**
 * Обязательная авторизация
 */
async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: ERROR_MESSAGES.AUTH_REQUIRED });
    }
    const token = authHeader.split(' ')[1];
    try {
        const session = await kv.get(K.SESSION(token));
        if (!session) return res.status(401).json({ error: ERROR_MESSAGES.SESSION_EXPIRED });
        req.session = session;
        req.authToken = token;
        next();
    } catch {
        return res.status(500).json({ error: ERROR_MESSAGES.SERVER_ERROR });
    }
}

// ============================================
// Маршруты: Подача заявки
// ============================================

/**
 * POST /apply — создание заявки
 */
router.post('/apply', async (req, res) => {
    try {
        const { fullName, phone, contact, age, hasMicrophone } = req.body;

        // Валидация ФИО
        if (!fullName || typeof fullName !== 'string' || fullName.trim().length < CONFIG.MIN_NAME_LENGTH) {
            return res.status(400).json({ error: fullName ? ERROR_MESSAGES.NAME_TOO_SHORT : ERROR_MESSAGES.NAME_REQUIRED });
        }
        if (fullName.length > CONFIG.MAX_NAME_LENGTH) {
            return res.status(400).json({ error: ERROR_MESSAGES.NAME_TOO_LONG });
        }

        // Валидация контакта
        if (!contact || !isValidContact(contact)) {
            return res.status(400).json({ error: ERROR_MESSAGES.CONTACT_INVALID });
        }

        // Валидация возраста
        const ageNum = parseInt(age, 10);
        if (isNaN(ageNum) || ageNum < CONFIG.MIN_AGE || ageNum > CONFIG.MAX_AGE) {
            return res.status(400).json({ error: ERROR_MESSAGES.AGE_INVALID });
        }

        // Валидация телефона
        if (phone && !isValidPhone(phone)) {
            return res.status(400).json({ error: ERROR_MESSAGES.PHONE_INVALID });
        }

        // Генерация кода (с проверкой уникальности)
        let code;
        let attempts = 0;
        do {
            code = generateCode();
            const existing = await kv.get(K.APPLICATION(code));
            if (!existing) break;
            attempts++;
        } while (attempts < 10);

        const now = new Date().toISOString();
        const application = {
            code,
            fullName: fullName.trim(),
            phone: phone ? phone.trim() : '',
            contact: contact.trim(),
            age: ageNum,
            hasMicrophone: Boolean(hasMicrophone),
            status: 'pending',
            createdAt: now,
            login: null,
            password: null,
            passwordShown: false
        };

        await kv.hset(K.APPLICATION(code), application);
        await kv.sadd(K.APPLICATIONS_INDEX, code);

        // Уведомление в Telegram
        await sendTelegramNotification(
            `<b>Новая заявка в команду</b>\n\n` +
            `<b>Код:</b> <code>${code}</code>\n` +
            `<b>ФИО:</b> ${application.fullName}\n` +
            `<b>Возраст:</b> ${application.age}\n` +
            `<b>Контакт:</b> ${application.contact}\n` +
            (application.phone ? `<b>Телефон:</b> ${application.phone}\n` : '') +
            `<b>Микрофон:</b> ${application.hasMicrophone ? 'Да' : 'Нет'}\n\n` +
            `<i>Для одобрения используйте команду /approve ${code}</i>`
        );

        res.status(201).json({
            success: true,
            code,
            message: 'Заявка отправлена. Сохраните код для отслеживания статуса.'
        });
    } catch (err) {
        console.error('[Team] Apply error:', err);
        res.status(500).json({ error: ERROR_MESSAGES.SERVER_ERROR });
    }
});

/**
 * GET /status/:code — проверка статуса заявки
 */
router.get('/status/:code', async (req, res) => {
    try {
        const code = req.params.code.toUpperCase().trim();
        if (!code || code.length !== CONFIG.CODE_LENGTH) {
            return res.status(400).json({ error: ERROR_MESSAGES.APPLICATION_NOT_FOUND });
        }

        const app = await kv.hgetall(K.APPLICATION(code));
        if (!app || !app.code) {
            return res.status(404).json({ error: ERROR_MESSAGES.APPLICATION_NOT_FOUND });
        }

        const response = {
            code: app.code,
            status: app.status,
            fullName: app.fullName,
            createdAt: app.createdAt
        };

        if (app.status === 'approved') {
            response.login = app.login;
            // Пароль показываем только один раз
            if (!app.passwordShown) {
                response.password = app.password;
                await kv.hset(K.APPLICATION(code), { passwordShown: 'true' });
            }
        }

        res.json(response);
    } catch (err) {
        console.error('[Team] Status error:', err);
        res.status(500).json({ error: ERROR_MESSAGES.SERVER_ERROR });
    }
});

// ============================================
// Маршруты: Авторизация
// ============================================

/**
 * POST /login — вход в личный кабинет
 */
router.post('/login', async (req, res) => {
    try {
        const { login, password } = req.body;
        if (!login || !password) {
            return res.status(400).json({ error: ERROR_MESSAGES.INVALID_CREDENTIALS });
        }

        const user = await kv.hgetall(K.USER(login));
        if (!user || !user.login) {
            return res.status(401).json({ error: ERROR_MESSAGES.INVALID_CREDENTIALS });
        }

        const isValid = await verifyPassword(password, user.passwordHash);
        if (!isValid) {
            return res.status(401).json({ error: ERROR_MESSAGES.INVALID_CREDENTIALS });
        }

        const token = generateSessionToken();
        const session = {
            login: user.login,
            role: 'team',
            fullName: user.fullName,
            createdAt: new Date().toISOString()
        };

        await kv.set(K.SESSION(token), session, { ex: CONFIG.SESSION_TTL });

        res.json({
            session,
            token
        });
    } catch (err) {
        console.error('[Team] Login error:', err);
        res.status(500).json({ error: ERROR_MESSAGES.SERVER_ERROR });
    }
});

/**
 * POST /logout — выход
 */
router.post('/logout', requireAuth, async (req, res) => {
    try {
        await kv.del(K.SESSION(req.authToken));
        res.json({ success: true });
    } catch (err) {
        console.error('[Team] Logout error:', err);
        res.status(500).json({ error: ERROR_MESSAGES.SERVER_ERROR });
    }
});

/**
 * GET /profile — получение профиля
 */
router.get('/profile', requireAuth, async (req, res) => {
    try {
        const user = await kv.hgetall(K.USER(req.session.login));
        if (!user || !user.login) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({
            login: user.login,
            fullName: user.fullName,
            phone: user.phone || '',
            contact: user.contact,
            age: parseInt(user.age, 10),
            hasMicrophone: user.hasMicrophone === 'true',
            applicationCode: user.applicationCode,
            createdAt: user.createdAt,
            adminToken: ADMIN_TOKEN
        });
    } catch (err) {
        console.error('[Team] Profile error:', err);
        res.status(500).json({ error: ERROR_MESSAGES.SERVER_ERROR });
    }
});

// ============================================
// Маршруты: Админские (одобрение/отклонение)
// ============================================

/**
 * POST /approve — одобрение заявки (админ)
 */
router.post('/approve', verifyAdminToken, async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) return res.status(400).json({ error: 'Code required' });

        const app = await kv.hgetall(K.APPLICATION(code.toUpperCase()));
        if (!app || !app.code) {
            return res.status(404).json({ error: ERROR_MESSAGES.APPLICATION_NOT_FOUND });
        }
        if (app.status === 'approved') {
            return res.status(409).json({ error: ERROR_MESSAGES.APPLICATION_ALREADY_APPROVED });
        }

        // Генерация учётных данных
        const login = generateLogin(app.fullName);
        const password = generatePassword();
        const passwordHash = await hashPassword(password);

        // Обновление заявки
        await kv.hset(K.APPLICATION(app.code), {
            status: 'approved',
            login,
            password,
            passwordShown: 'false'
        });

        // Создание пользователя
        await kv.hset(K.USER(login), {
            login,
            passwordHash,
            fullName: app.fullName,
            phone: app.phone || '',
            contact: app.contact,
            age: String(app.age),
            hasMicrophone: String(app.hasMicrophone),
            applicationCode: app.code,
            createdAt: new Date().toISOString(),
            role: 'team'
        });
        await kv.sadd(K.USERS_INDEX, login);

        // Уведомление в Telegram
        await sendTelegramNotification(
            `<b>Заявка одобрена</b>\n\n` +
            `<b>Код:</b> <code>${app.code}</code>\n` +
            `<b>ФИО:</b> ${app.fullName}\n` +
            `<b>Логин:</b> <code>${login}</code>\n` +
            `<b>Пароль:</b> <code>${password}</code>`
        );

        res.json({ success: true, login, password });
    } catch (err) {
        console.error('[Team] Approve error:', err);
        res.status(500).json({ error: ERROR_MESSAGES.SERVER_ERROR });
    }
});

/**
 * POST /reject — отклонение заявки (админ)
 */
router.post('/reject', verifyAdminToken, async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) return res.status(400).json({ error: 'Code required' });

        const app = await kv.hgetall(K.APPLICATION(code.toUpperCase()));
        if (!app || !app.code) {
            return res.status(404).json({ error: ERROR_MESSAGES.APPLICATION_NOT_FOUND });
        }

        await kv.hset(K.APPLICATION(app.code), { status: 'rejected' });

        await sendTelegramNotification(
            `<b>Заявка отклонена</b>\n\n` +
            `<b>Код:</b> <code>${app.code}</code>\n` +
            `<b>ФИО:</b> ${app.fullName}`
        );

        res.json({ success: true });
    } catch (err) {
        console.error('[Team] Reject error:', err);
        res.status(500).json({ error: ERROR_MESSAGES.SERVER_ERROR });
    }
});

/**
 * GET /applications — список заявок (админ)
 */
router.get('/applications', verifyAdminToken, async (req, res) => {
    try {
        const codes = await kv.smembers(K.APPLICATIONS_INDEX);
        if (!codes || codes.length === 0) {
            return res.json({ applications: [] });
        }

        const applications = [];
        for (const code of codes) {
            const app = await kv.hgetall(K.APPLICATION(code));
            if (app && app.code) {
                applications.push({
                    code: app.code,
                    fullName: app.fullName,
                    contact: app.contact,
                    age: parseInt(app.age, 10),
                    status: app.status,
                    createdAt: app.createdAt,
                    login: app.login || null
                });
            }
        }

        applications.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.json({ applications });
    } catch (err) {
        console.error('[Team] Applications error:', err);
        res.status(500).json({ error: ERROR_MESSAGES.SERVER_ERROR });
    }
});

module.exports = router;