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

/** @constant {string} Секретный токен для webhook (опционально) */
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

/** @constant {string} Production URL (приоритет над VERCEL_URL) */
const PRODUCTION_URL = process.env.PRODUCTION_URL || '';

/** @constant {string} Базовый URL приложения */
const BASE_URL = PRODUCTION_URL || (process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : (process.env.BASE_URL || 'http://localhost:3000'));

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
    MAX_CONTACT_LENGTH: 100,

    /** @type {number} Таймаут для Telegram API (мс) - уменьшен для скорости */
    TELEGRAM_API_TIMEOUT: 10000,

    /** @type {number} Rate limit: запросов в минуту */
    RATE_LIMIT_MAX: 60,

    /** @type {number} Rate limit: окно времени (мс) */
    RATE_LIMIT_WINDOW: 60 * 1000,

    /** @type {number} Максимальное количество заявок в /list */
    MAX_LIST_SIZE: 50,

    /** @type {number} TTL для audit log (7 дней) */
    AUDIT_LOG_TTL: 7 * 24 * 60 * 60
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
    INVALID_CODE_FORMAT: 'Неверный формат кода',

    // Авторизация
    INVALID_CREDENTIALS: 'Неверный логин или пароль',
    AUTH_REQUIRED: 'Требуется авторизация',
    SESSION_EXPIRED: 'Сессия истекла',
    ADMIN_REQUIRED: 'Требуются права администратора',
    INVALID_ADMIN_TOKEN: 'Неверный admin token',

    // Rate limiting
    RATE_LIMITED: 'Слишком много запросов. Попробуйте позже.',

    // Общие
    SERVER_ERROR: 'Ошибка сервера',

    // Telegram Bot
    BOT_NOT_CONFIGURED: 'Telegram bot не настроен',
    INVALID_SECRET: 'Неверный секретный токен webhook',
    TELEGRAM_API_TIMEOUT: 'Telegram API timeout'
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
    SESSION: (token) => `team:session:${token}`,
    /** @param {string} ip */
    RATE_LIMIT: (ip) => `team:ratelimit:${ip}`,
    /** @param {string} actionId */
    AUDIT_LOG: (actionId) => `team:audit:${actionId}`,
    AUDIT_LOG_INDEX: 'team:audit:index'
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

/**
 * Генерация ID для audit log
 * @returns {string} Уникальный ID
 */
function generateAuditId() {
    return crypto.randomBytes(8).toString('hex');
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
    if (trimmed.startsWith('@') && /^@[a-zA-Z0-9_]{3,32}$/.test(trimmed)) return true;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return true;
    return false;
}

/**
 * Валидация телефона
 * @param {string} phone - Телефон
 * @returns {boolean}
 */
function isValidPhone(phone) {
    if (!phone) return true;
    return /^\+?[\d\s\-()]{7,20}$/.test(phone.trim());
}

/**
 * Валидация кода заявки
 * @param {string} code - Код
 * @returns {boolean}
 */
function isValidCode(code) {
    if (!code) return false;
    const normalized = code.toUpperCase().trim();
    return normalized.length === CONFIG.CODE_LENGTH && 
           /^[A-Z0-9]+$/.test(normalized);
}

// ============================================
// Утилиты: Rate Limiting
// ============================================

/**
 * Проверка rate limit для IP
 * @param {string} ip - IP адрес
 * @returns {Promise<{allowed: boolean, retryAfter?: number}>}
 */
async function checkRateLimit(ip) {
    const key = K.RATE_LIMIT(ip);
    const now = Date.now();
    
    try {
        const data = await kv.hgetall(key);
        
        if (!data || !data.count) {
            // Первый запрос
            await kv.hset(key, {
                count: '1',
                resetAt: String(now + CONFIG.RATE_LIMIT_WINDOW)
            });
            await kv.expire(key, Math.ceil(CONFIG.RATE_LIMIT_WINDOW / 1000));
            return { allowed: true };
        }
        
        const resetAt = parseInt(data.resetAt, 10);
        
        // Окно истекло
        if (now > resetAt) {
            await kv.del(key);
            await kv.hset(key, {
                count: '1',
                resetAt: String(now + CONFIG.RATE_LIMIT_WINDOW)
            });
            await kv.expire(key, Math.ceil(CONFIG.RATE_LIMIT_WINDOW / 1000));
            return { allowed: true };
        }
        
        const count = parseInt(data.count, 10);
        
        // Лимит превышен
        if (count >= CONFIG.RATE_LIMIT_MAX) {
            const retryAfter = Math.ceil((resetAt - now) / 1000);
            return { allowed: false, retryAfter };
        }
        
        // Увеличиваем счётчик
        await kv.hincrby(key, 'count', 1);
        return { allowed: true };
        
    } catch (err) {
        console.error('[RateLimit] Error:', err);
        // При ошибке разрешаем запрос (fail-open)
        return { allowed: true };
    }
}

// ============================================
// Утилиты: Audit Log
// ============================================

/**
 * Запись действия в audit log
 * @param {string} action - Тип действия
 * @param {Object} details - Детали действия
 * @param {string} [userId] - ID пользователя (опционально)
 * @returns {Promise<string>} ID записи
 */
async function logAuditAction(action, details, userId = null) {
    const actionId = generateAuditId();
    const record = {
        id: actionId,
        action,
        details,
        userId,
        timestamp: new Date().toISOString()
    };
    
    try {
        await kv.hset(K.AUDIT_LOG(actionId), record);
        await kv.sadd(K.AUDIT_LOG_INDEX, actionId);
        await kv.expire(K.AUDIT_LOG(actionId), CONFIG.AUDIT_LOG_TTL);
        
        console.log(`[Audit] ${action}:`, details);
        return actionId;
    } catch (err) {
        console.error('[Audit] Failed to log:', err);
        return null;
    }
}

/**
 * Получение последних записей audit log
 * @param {number} limit - Количество записей
 * @returns {Promise<Array>} Список записей
 */
async function getAuditLog(limit = 50) {
    try {
        const actionIds = await kv.smembers(K.AUDIT_LOG_INDEX);
        if (!actionIds || actionIds.length === 0) return [];
        
        const records = [];
        for (const actionId of actionIds.slice(-limit)) {
            const record = await kv.hgetall(K.AUDIT_LOG(actionId));
            if (record && record.id) {
                records.push(record);
            }
        }
        
        // Сортировка по времени (новые первые)
        records.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        return records;
    } catch (err) {
        console.error('[Audit] Failed to get log:', err);
        return [];
    }
}

// ============================================
// Утилиты: Telegram Bot API (упрощенная версия без retry)
// ============================================

/**
 * Базовый URL Telegram Bot API
 * @constant {string}
 */
const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

/**
 * Выполнение запроса к Telegram Bot API (без retry для скорости)
 * @param {string} method - Метод API
 * @param {Object} body - Тело запроса
 * @returns {Promise<Object|null>}
 */
async function callTelegramApi(method, body) {
    if (!TELEGRAM_BOT_TOKEN) {
        console.warn('[Telegram] Bot token not configured');
        return null;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.TELEGRAM_API_TIMEOUT);

    try {
        const response = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal
            }
        );

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error(`[Telegram] ${method} failed:`, errorData);
            return null;
        }

        return await response.json();
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            console.error(`[Telegram] ${method} timeout after ${CONFIG.TELEGRAM_API_TIMEOUT}ms`);
        } else {
            console.error(`[Telegram] ${method} error:`, err.message);
        }
        return null;
    }
}

/**
 * Отправка сообщения в Telegram
 * @param {string} text - Текст сообщения (HTML)
 * @param {Object} [replyMarkup] - Inline клавиатура
 * @param {string} [chatId] - Chat ID (по умолчанию TELEGRAM_CHAT_ID)
 * @returns {Promise<Object|null>} Ответ API
 */
async function sendTelegramMessage(text, replyMarkup = null, chatId = null) {
    if (!TELEGRAM_CHAT_ID && !chatId) {
        console.warn('[Telegram] Chat ID not configured');
        return null;
    }

    const body = {
        chat_id: chatId || TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
    };

    if (replyMarkup) {
        body.reply_markup = replyMarkup;
    }

    return await callTelegramApi('sendMessage', body);
}

/**
 * Редактирование сообщения в Telegram
 * ВАЖНО: если исходное сообщение содержало inline-кнопки,
 * нужно явно передать reply_markup: {} чтобы убрать их
 * 
 * @param {number|string} chatId - ID чата
 * @param {number} messageId - ID сообщения
 * @param {string} text - Новый текст
 * @param {Object|null} [replyMarkup] - Новая inline клавиатура
 * @returns {Promise<Object|null>}
 */
async function editTelegramMessage(chatId, messageId, text, replyMarkup = {}) {
    const body = {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML'
    };

    body.reply_markup = replyMarkup;

    return await callTelegramApi('editMessageText', body);
}

/**
 * Безопасное редактирование сообщения с fallback
 * @param {number|string} chatId - ID чата
 * @param {number} messageId - ID сообщения
 * @param {string} text - Новый текст
 * @returns {Promise<void>}
 */
async function editTelegramMessageSafe(chatId, messageId, text) {
    const result = await editTelegramMessage(chatId, messageId, text, {});
    
    if (!result) {
        console.warn(`[Bot] Edit failed for message ${messageId}, sending new message`);
        await sendTelegramMessage(text, null, chatId);
    }
}

/**
 * Подтверждение callback query (убирает "часики" у кнопки)
 * @param {string} callbackQueryId - ID callback query
 * @param {string} [text] - Текст уведомления (опционально)
 * @returns {Promise<Object|null>}
 */
async function answerCallbackQuery(callbackQueryId, text = null) {
    const body = { callback_query_id: callbackQueryId };
    if (text) body.text = text;
    return await callTelegramApi('answerCallbackQuery', body);
}

/**
 * Создание inline-клавиатуры для заявки
 * @param {string} code - Код заявки
 * @returns {Object} Inline keyboard markup
 */
function createApplicationKeyboard(code) {
    return {
        inline_keyboard: [
            [
                {
                    text: '✅ Одобрить',
                    callback_data: `approve_${code}`
                },
                {
                    text: '🚫 Отклонить',
                    callback_data: `reject_${code}`
                }
            ],
            [
                {
                    text: ' Открыть заявку',
                    url: `${BASE_URL}/team?p=code`
                }
            ]
        ]
    };
}

/**
 * Отправка уведомления в Telegram с inline-кнопками
 * @param {string} text - Текст сообщения
 * @param {string} [code] - Код заявки (для кнопок)
 * @returns {Promise<Object|null>}
 */
async function sendTelegramNotification(text, code = null) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.warn('[Telegram] Credentials not configured');
        return null;
    }

    const replyMarkup = code ? createApplicationKeyboard(code) : null;
    return await sendTelegramMessage(text, replyMarkup);
}

// ============================================
// Telegram Bot: Бизнес-логика (ПРЯМЫЕ ВЫЗОВЫ)
// ============================================

/**
 * Одобрение заявки (прямой вызов, без HTTP)
 * @param {string} code - Код заявки
 * @returns {Promise<Object>} Результат { success, login?, password?, error? }
 */
async function approveApplication(code) {
    try {
        const normalizedCode = code.toUpperCase();
        const app = await kv.hgetall(K.APPLICATION(normalizedCode));
        
        if (!app || !app.code) {
            return { success: false, error: ERROR_MESSAGES.APPLICATION_NOT_FOUND };
        }
        
        // ИСПРАВЛЕНО: было app.status<think> 'approved'
        if (app.status === 'approved') {
            return { success: false, error: ERROR_MESSAGES.APPLICATION_ALREADY_APPROVED };
        }

        // Генерация учётных данных
        const login = generateLogin(app.fullName);
        const password = generatePassword();
        const passwordHash = await hashPassword(password);

        // Обновление заявки
        await kv.hset(K.APPLICATION(normalizedCode), {
            status: 'approved',
            login,
            password,
            passwordShown: 'false',
            approvedAt: new Date().toISOString()
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
            applicationCode: normalizedCode,
            createdAt: new Date().toISOString(),
            role: 'team'
        });
        await kv.sadd(K.USERS_INDEX, login);

        // Audit log
        await logAuditAction('application_approved', {
            code: normalizedCode,
            login,
            fullName: app.fullName
        });

        console.log(`[Team] Application approved: ${normalizedCode} → login: ${login}`);
        return { success: true, login, password };
    } catch (err) {
        console.error('[Team] Approve error:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Отклонение заявки (прямой вызов, без HTTP)
 * @param {string} code - Код заявки
 * @returns {Promise<Object>} Результат { success, error? }
 */
async function rejectApplication(code) {
    try {
        const normalizedCode = code.toUpperCase();
        const app = await kv.hgetall(K.APPLICATION(normalizedCode));
        
        if (!app || !app.code) {
            return { success: false, error: ERROR_MESSAGES.APPLICATION_NOT_FOUND };
        }

        await kv.hset(K.APPLICATION(normalizedCode), { 
            status: 'rejected',
            rejectedAt: new Date().toISOString()
        });

        // Audit log
        await logAuditAction('application_rejected', {
            code: normalizedCode,
            fullName: app.fullName
        });

        console.log(`[Team] Application rejected: ${normalizedCode}`);
        return { success: true };
    } catch (err) {
        console.error('[Team] Reject error:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Получение детальной информации о заявке
 * @param {string} code - Код заявки
 * @returns {Promise<Object|null>}
 */
async function getApplicationInfo(code) {
    try {
        const normalizedCode = code.toUpperCase();
        const app = await kv.hgetall(K.APPLICATION(normalizedCode));
        
        if (!app || !app.code) {
            return null;
        }

        return {
            code: app.code,
            fullName: app.fullName,
            contact: app.contact,
            phone: app.phone || 'Не указан',
            age: app.age,
            hasMicrophone: app.hasMicrophone === 'true',
            status: app.status,
            createdAt: app.createdAt,
            login: app.login || null,
            approvedAt: app.approvedAt || null,
            rejectedAt: app.rejectedAt || null
        };
    } catch (err) {
        console.error('[Team] Get application info error:', err);
        return null;
    }
}

/**
 * Получение статистики по заявкам
 * @returns {Promise<Object>}
 */
async function getApplicationsStats() {
    try {
        const codes = await kv.smembers(K.APPLICATIONS_INDEX);
        if (!codes || codes.length === 0) {
            return {
                total: 0,
                pending: 0,
                approved: 0,
                rejected: 0
            };
        }

        let pending = 0, approved = 0, rejected = 0;
        
        for (const code of codes) {
            const app = await kv.hgetall(K.APPLICATION(code));
            if (app && app.status) {
                if (app.status === 'pending') pending++;
                else if (app.status === 'approved') approved++;
                else if (app.status === 'rejected') rejected++;
            }
        }

        return {
            total: codes.length,
            pending,
            approved,
            rejected
        };
    } catch (err) {
        console.error('[Team] Get stats error:', err);
        return { total: 0, pending: 0, approved: 0, rejected: 0 };
    }
}

// ============================================
// Telegram Bot: Обработка команд
// ============================================

/**
 * Обработка команды /approve (текстовая команда)
 */
async function handleApproveCommand(chatId, messageId, code) {
    if (!code) {
        await sendTelegramMessage(
            '❌ Укажите код. Пример: <code>/approve ABC123</code>',
            null,
            chatId
        );
        return;
    }

    if (!isValidCode(code)) {
        await sendTelegramMessage(
            '❌ Неверный формат кода. Код должен содержать 6 символов (A-Z, 0-9).',
            null,
            chatId
        );
        return;
    }

    console.log(`[Bot] Processing approve for code: ${code}`);
    
    const result = await approveApplication(code);
    
    if (result.success) {
        const text =
            `✅ <b>Заявка одобрена!</b>\n\n` +
            ` <b>Код:</b> <code>${code}</code>\n` +
            ` <b>Логин:</b> <code>${result.login}</code>\n` +
            `🔐 <b>Пароль:</b> <code>${result.password}</code>\n\n` +
            `⚠️ Передайте эти данные пользователю.`;
        
        await editTelegramMessageSafe(chatId, messageId, text);
        console.log(`[Bot] Approved successfully: ${code} → ${result.login}`);
    } else {
        const text =
            `❌ <b>Ошибка одобрения</b>\n\n` +
            `🔑 <b>Код:</b> <code>${code}</code>\n` +
            `⚠️ <b>Причина:</b> ${result.error}`;
        
        await editTelegramMessageSafe(chatId, messageId, text);
        console.log(`[Bot] Approve failed: ${code} — ${result.error}`);
    }
}

/**
 * Обработка команды /reject (текстовая команда)
 */
async function handleRejectCommand(chatId, messageId, code) {
    if (!code) {
        await sendTelegramMessage(
            ' Укажите код. Пример: <code>/reject ABC123</code>',
            null,
            chatId
        );
        return;
    }

    if (!isValidCode(code)) {
        await sendTelegramMessage(
            '❌ Неверный формат кода. Код должен содержать 6 символов (A-Z, 0-9).',
            null,
            chatId
        );
        return;
    }

    console.log(`[Bot] Processing reject for code: ${code}`);
    
    const result = await rejectApplication(code);
    
    if (result.success) {
        await editTelegramMessageSafe(chatId, messageId,
            ` <b>Заявка отклонена</b>\n\nКод: <code>${code}</code>`);
        console.log(`[Bot] Rejected successfully: ${code}`);
    } else {
        await editTelegramMessageSafe(chatId, messageId,
            `❌ <b>Ошибка отклонения</b>\n\nКод: <code>${code}</code>\nПричина: ${result.error}`);
        console.log(`[Bot] Reject failed: ${code} — ${result.error}`);
    }
}

/**
 * Обработка команды /info (детальная информация о заявке)
 */
async function handleInfoCommand(chatId, code) {
    if (!code) {
        await sendTelegramMessage(
            '❌ Укажите код. Пример: <code>/info ABC123</code>',
            null,
            chatId
        );
        return;
    }

    if (!isValidCode(code)) {
        await sendTelegramMessage(
            '❌ Неверный формат кода.',
            null,
            chatId
        );
        return;
    }

    const app = await getApplicationInfo(code);
    
    if (!app) {
        await sendTelegramMessage(
            `❌ Заявка <code>${code}</code> не найдена.`,
            null,
            chatId
        );
        return;
    }

    const statusEmoji = {
        pending: '⏳',
        approved: '✅',
        rejected: '🚫'
    };

    const statusText = {
        pending: 'На рассмотрении',
        approved: 'Одобрена',
        rejected: 'Отклонена'
    };

    const text = 
        ` <b>Информация о заявке</b>\n\n` +
        `<b>Код:</b> <code>${app.code}</code>\n` +
        `<b>Статус:</b> ${statusEmoji[app.status]} ${statusText[app.status]}\n` +
        `<b>ФИО:</b> ${app.fullName}\n` +
        `<b>Возраст:</b> ${app.age}\n` +
        `<b>Контакт:</b> ${app.contact}\n` +
        `<b>Телефон:</b> ${app.phone}\n` +
        `<b>Микрофон:</b> ${app.hasMicrophone ? '✅ Да' : '❌ Нет'}\n` +
        `<b>Подана:</b> ${new Date(app.createdAt).toLocaleString('ru-RU')}\n` +
        (app.login ? `<b>Логин:</b> <code>${app.login}</code>\n` : '') +
        (app.approvedAt ? `<b>Одобрена:</b> ${new Date(app.approvedAt).toLocaleString('ru-RU')}\n` : '') +
        (app.rejectedAt ? `<b>Отклонена:</b> ${new Date(app.rejectedAt).toLocaleString('ru-RU')}\n` : '');

    await sendTelegramMessage(text, null, chatId);
}

/**
 * Обработка команды /stats (статистика)
 */
async function handleStatsCommand(chatId) {
    const stats = await getApplicationsStats();
    
    const text = 
        `📊 <b>Статистика заявок</b>\n\n` +
        `<b>Всего:</b> ${stats.total}\n` +
        `⏳ <b>На рассмотрении:</b> ${stats.pending}\n` +
        `✅ <b>Одобрено:</b> ${stats.approved}\n` +
        `🚫 <b>Отклонено:</b> ${stats.rejected}\n\n` +
        (stats.total > 0 
            ? `<b>Процент одобрения:</b> ${Math.round((stats.approved / stats.total) * 100)}%`
            : 'Заявок пока нет');

    await sendTelegramMessage(text, null, chatId);
}

/**
 * Обработка команды /help
 * @param {number|string} chatId - ID чата
 */
async function handleHelpCommand(chatId) {
    const helpText =
        `🤖 <b>Oris Team Bot</b>\n\n` +
        `<b>Команды:</b>\n\n` +
        `/approve <code>CODE</code> — одобрить заявку\n` +
        `/reject <code>CODE</code> — отклонить заявку\n` +
        `/info <code>CODE</code> — информация о заявке\n` +
        `/list — список всех заявок\n` +
        `/stats — статистика заявок\n` +
        `/help — показать справку\n\n` +
        `💡 Также можно использовать inline-кнопки в сообщениях заявок.`;

    await sendTelegramMessage(helpText, null, chatId);
}

/**
 * Обработка команды /list
 * @param {number|string} chatId - ID чата
 */
async function handleListCommand(chatId) {
    try {
        const codes = await kv.smembers(K.APPLICATIONS_INDEX);
        if (!codes || codes.length === 0) {
            await sendTelegramMessage(' Заявок пока нет.', null, chatId);
            return;
        }

        const applications = [];
        for (const code of codes) {
            const app = await kv.hgetall(K.APPLICATION(code));
            if (app && app.code) {
                applications.push(app);
            }
        }

        applications.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        const statusEmoji = {
            pending: '⏳',
            approved: '✅',
            rejected: '🚫'
        };

        const statusText = {
            pending: 'На рассмотрении',
            approved: 'Одобрена',
            rejected: 'Отклонена'
        };

        let listText = `📋 <b>Заявки (${applications.length})</b>\n\n`;

        const displayApps = applications.slice(0, CONFIG.MAX_LIST_SIZE);
        
        displayApps.forEach((app, idx) => {
            const emoji = statusEmoji[app.status] || '❓';
            const status = statusText[app.status] || app.status;
            listText += `${idx + 1}. ${emoji} <code>${app.code}</code> — ${app.fullName}\n`;
            listText += `   ${status}\n`;
        });

        if (applications.length > CONFIG.MAX_LIST_SIZE) {
            listText += `\n...и ещё ${applications.length - CONFIG.MAX_LIST_SIZE}`;
        }

        await sendTelegramMessage(listText, null, chatId);
    } catch (err) {
        console.error('[Bot] /list error:', err);
        await sendTelegramMessage('❌ Ошибка получения списка заявок.', null, chatId);
    }
}

// ============================================
// Telegram Bot: Обработка callback и update
// ============================================

/**
 * Обработка callback от inline-кнопки
 * @param {Object} callbackQuery - Callback query объект
 */
async function handleCallbackQuery(callbackQuery) {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;

    console.log(`[Bot] Callback: ${data} from chat ${chatId}`);

    // СНАЧАЛА отвечаем на callback_query (убирает "часики" в Telegram)
    try {
        await answerCallbackQuery(callbackQuery.id, '⏳ Обрабатываю...');
    } catch (err) {
        console.error('[Bot] answerCallbackQuery failed:', err.message);
    }

    // Парсинг действия
    const separatorIndex = data.indexOf('_');
    if (separatorIndex === -1) {
        await editTelegramMessageSafe(chatId, messageId, '❌ Неизвестное действие');
        return;
    }

    const action = data.substring(0, separatorIndex);
    const code = data.substring(separatorIndex + 1);

    console.log(`[Bot] Action: ${action}, code: ${code}`);

    // Выполняем действие с обработкой ошибок
    try {
        if (action === 'approve') {
            const result = await approveApplication(code);
            if (result.success) {
                const text =
                    `✅ <b>Заявка одобрена!</b>\n\n` +
                    `🔑 <b>Код:</b> <code>${code}</code>\n` +
                    `👤 <b>Логин:</b> <code>${result.login}</code>\n` +
                    `🔐 <b>Пароль:</b> <code>${result.password}</code>\n\n` +
                    `⚠️ Передайте эти данные пользователю.`;
                await editTelegramMessageSafe(chatId, messageId, text);
            } else {
                await editTelegramMessageSafe(chatId, messageId,
                    `❌ <b>Ошибка одобрения</b>\n\nКод: <code>${code}</code>\nПричина: ${result.error}`);
            }
        } else if (action === 'reject') {
            const result = await rejectApplication(code);
            if (result.success) {
                await editTelegramMessageSafe(chatId, messageId,
                    ` <b>Заявка отклонена</b>\n\nКод: <code>${code}</code>`);
            } else {
                await editTelegramMessageSafe(chatId, messageId,
                    ` <b>Ошибка отклонения</b>\n\nКод: <code>${code}</code>\nПричина: ${result.error}`);
            }
        } else {
            await editTelegramMessageSafe(chatId, messageId, '❌ Неизвестное действие');
        }
    } catch (err) {
        console.error('[Bot] Action failed:', err);
        await editTelegramMessageSafe(chatId, messageId,
            `❌ <b>Внутренняя ошибка</b>\n\n${err.message}`);
    }
}

/**
 * Обработка входящего update от Telegram
 * @param {Object} update - Update объект от Telegram
 */
async function processUpdate(update) {
    try {
        console.log('[Bot] Processing update type:', Object.keys(update).join(', '));

        // Callback query (нажатие inline кнопки)
        if (update.callback_query) {
            console.log('[Bot] Callback query received:', update.callback_query.data);
            await handleCallbackQuery(update.callback_query);
            return;
        }

        // Текстовое сообщение
        if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const messageId = update.message.message_id;
            const text = update.message.text.trim();

            console.log(`[Bot] Message from chat ${chatId}: ${text}`);

            // Проверка, что запрос от авторизованного чата
            if (String(chatId) !== String(TELEGRAM_CHAT_ID)) {
                console.warn(`[Bot] Unauthorized chat: ${chatId} (expected: ${TELEGRAM_CHAT_ID})`);
                await sendTelegramMessage(
                    '⛔ Доступ запрещён. Этот бот только для администратора.',
                    null,
                    chatId
                );
                return;
            }

            // Парсинг команд
            if (text === '/start' || text === '/help') {
                await handleHelpCommand(chatId);
                return;
            }

            if (text === '/list') {
                await handleListCommand(chatId);
                return;
            }

            if (text === '/stats') {
                await handleStatsCommand(chatId);
                return;
            }

            if (text.startsWith('/approve')) {
                const code = text.split(' ')[1]?.trim().toUpperCase();
                console.log(`[Bot] Approve command with code: ${code}`);
                await handleApproveCommand(chatId, messageId, code);
                return;
            }

            if (text.startsWith('/reject')) {
                const code = text.split(' ')[1]?.trim().toUpperCase();
                console.log(`[Bot] Reject command with code: ${code}`);
                await handleRejectCommand(chatId, messageId, code);
                return;
            }

            if (text.startsWith('/info')) {
                const code = text.split(' ')[1]?.trim().toUpperCase();
                console.log(`[Bot] Info command with code: ${code}`);
                await handleInfoCommand(chatId, code);
                return;
            }

            // Неизвестная команда
            await sendTelegramMessage(
                `Неизвестная команда: <code>${text}</code>\n\nИспользуйте /help для списка команд.`,
                null,
                chatId
            );
        }
    } catch (err) {
        console.error('[Bot] Process update error:', err);
    }
}

// ============================================
// Middleware
// ============================================

/**
 * Rate limiting middleware
 */
async function rateLimitMiddleware(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const result = await checkRateLimit(ip);
    
    if (!result.allowed) {
        res.set('Retry-After', result.retryAfter);
        return res.status(429).json({ 
            error: ERROR_MESSAGES.RATE_LIMITED,
            retryAfter: result.retryAfter
        });
    }
    
    next();
}

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
router.post('/apply', rateLimitMiddleware, async (req, res) => {
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

        // Audit log
        await logAuditAction('application_created', {
            code,
            fullName: application.fullName,
            ip: req.ip
        });

        // Уведомление в Telegram с inline-кнопками
        const notificationText =
            `<b> Новая заявка в команду</b>\n\n` +
            `<b>Код:</b> <code>${code}</code>\n` +
            `<b>ФИО:</b> ${application.fullName}\n` +
            `<b>Возраст:</b> ${application.age}\n` +
            `<b>Контакт:</b> ${application.contact}\n` +
            (application.phone ? `<b>Телефон:</b> ${application.phone}\n` : '') +
            `<b>Микрофон:</b> ${application.hasMicrophone ? 'Да' : 'Нет'}\n\n` +
            `<i>Используйте кнопки ниже или команды /approve /reject</i>`;

        await sendTelegramNotification(notificationText, code);

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
router.get('/status/:code', rateLimitMiddleware, async (req, res) => {
    try {
        const code = req.params.code.toUpperCase().trim();
        
        if (!isValidCode(code)) {
            return res.status(400).json({ error: ERROR_MESSAGES.INVALID_CODE_FORMAT });
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
router.post('/login', rateLimitMiddleware, async (req, res) => {
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
            // Audit log для неудачных попыток
            await logAuditAction('login_failed', {
                login,
                ip: req.ip
            });
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

        // Audit log
        await logAuditAction('login_success', {
            login: user.login,
            ip: req.ip
        });

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
        
        // Audit log
        await logAuditAction('logout', {
            login: req.session.login
        });
        
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

        if (!isValidCode(code)) {
            return res.status(400).json({ error: ERROR_MESSAGES.INVALID_CODE_FORMAT });
        }

        const result = await approveApplication(code);

        if (!result.success) {
            const status = result.error === ERROR_MESSAGES.APPLICATION_NOT_FOUND ? 404 : 409;
            return res.status(status).json({ error: result.error });
        }

        // Уведомление в Telegram
        const app = await kv.hgetall(K.APPLICATION(code.toUpperCase()));
        await sendTelegramMessage(
            `<b>✅ Заявка одобрена через API</b>\n\n` +
            `<b>Код:</b> <code>${code.toUpperCase()}</code>\n` +
            `<b>ФИО:</b> ${app.fullName}\n` +
            `<b>Логин:</b> <code>${result.login}</code>\n` +
            `<b>Пароль:</b> <code>${result.password}</code>`
        );

        res.json({ success: true, login: result.login, password: result.password });
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

        if (!isValidCode(code)) {
            return res.status(400).json({ error: ERROR_MESSAGES.INVALID_CODE_FORMAT });
        }

        const result = await rejectApplication(code);

        if (!result.success) {
            return res.status(404).json({ error: result.error });
        }

        const app = await kv.hgetall(K.APPLICATION(code.toUpperCase()));
        await sendTelegramMessage(
            `<b>🚫 Заявка отклонена через API</b>\n\n` +
            `<b>Код:</b> <code>${code.toUpperCase()}</code>\n` +
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

/**
 * GET /stats — статистика заявок (админ)
 */
router.get('/stats', verifyAdminToken, async (req, res) => {
    try {
        const stats = await getApplicationsStats();
        res.json(stats);
    } catch (err) {
        console.error('[Team] Stats error:', err);
        res.status(500).json({ error: ERROR_MESSAGES.SERVER_ERROR });
    }
});

/**
 * GET /audit — audit log (админ)
 */
router.get('/audit', verifyAdminToken, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        const logs = await getAuditLog(limit);
        res.json({ logs });
    } catch (err) {
        console.error('[Team] Audit error:', err);
        res.status(500).json({ error: ERROR_MESSAGES.SERVER_ERROR });
    }
});

// ============================================
// Маршруты: Telegram Bot Webhook
// ============================================

/**
 * POST /bot — webhook endpoint для Telegram Bot
 */
router.post('/bot', async (req, res) => {
    // Логирование входящего запроса для отладки
    console.log('[Bot] Webhook received:', JSON.stringify(req.body).substring(0, 500));

    // Опциональная проверка секретного токена
    if (TELEGRAM_WEBHOOK_SECRET) {
        const receivedSecret = req.headers['x-telegram-bot-api-secret-token'];
        if (receivedSecret !== TELEGRAM_WEBHOOK_SECRET) {
            console.warn('[Bot] Invalid secret token');
            return res.status(403).json({ error: ERROR_MESSAGES.INVALID_SECRET });
        }
    }

    // Проверка наличия токена бота
    if (!TELEGRAM_BOT_TOKEN) {
        console.error('[Bot] TELEGRAM_BOT_TOKEN not configured');
        return res.status(500).json({ error: ERROR_MESSAGES.BOT_NOT_CONFIGURED });
    }

    const update = req.body;

    // Асинхронная обработка (не блокируем ответ Telegram)
    processUpdate(update).catch(err => {
        console.error('[Bot] Async processing error:', err);
    });

    // Сразу отвечаем 200 OK (Telegram требует быстрый ответ)
    res.status(200).json({ ok: true });
});

/**
 * GET /bot/diagnose — диагностика webhook (только для админа)
 */
router.get('/bot/diagnose', verifyAdminToken, async (req, res) => {
    if (!TELEGRAM_BOT_TOKEN) {
        return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not set' });
    }

    try {
        // Получаем информацию о боте
        const botInfoRes = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`
        );
        const botInfo = await botInfoRes.json();

        // Получаем информацию о webhook
        const webhookInfoRes = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo`
        );
        const webhookInfo = await webhookInfoRes.json();

        // Получаем последние ошибки
        const updatesRes = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?limit=5`
        );
        const updates = await updatesRes.json();

        res.json({
            bot: botInfo.result || null,
            webhook: webhookInfo.result || null,
            recentUpdates: updates.result || [],
            config: {
                chatId: TELEGRAM_CHAT_ID,
                hasSecret: !!TELEGRAM_WEBHOOK_SECRET,
                expectedWebhookUrl: `${BASE_URL}/api/team/bot`
            }
        });
    } catch (err) {
        console.error('[Bot] Diagnose error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /bot/setup — установка webhook (только для админа)
 */
router.post('/bot/setup', verifyAdminToken, async (req, res) => {
    if (!TELEGRAM_BOT_TOKEN) {
        return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not set' });
    }

    const webhookUrl = `${BASE_URL}/api/team/bot`;

    console.log(`[Bot] Setting webhook to: ${webhookUrl}`);

    try {
        const body = { url: webhookUrl };
        if (TELEGRAM_WEBHOOK_SECRET) {
            body.secret_token = TELEGRAM_WEBHOOK_SECRET;
        }

        const response = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }
        );

        const data = await response.json();

        if (!data.ok) {
            return res.status(400).json({ error: data.description || 'Failed to set webhook' });
        }

        res.json({
            success: true,
            webhookUrl,
            description: data.description || 'Webhook установлен'
        });
    } catch (err) {
        console.error('[Bot] Setup error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;