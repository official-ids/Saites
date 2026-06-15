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

/** @constant {string} Базовый URL приложения */
const BASE_URL = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : (process.env.BASE_URL || 'http://localhost:3000');

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
    RATE_LIMITED: 'Слишком много запросов',

    // Telegram Bot
    BOT_NOT_CONFIGURED: 'Telegram bot не настроен',
    INVALID_SECRET: 'Неверный секретный токен webhook'
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

// ============================================
// Утилиты: Telegram Bot API
// ============================================

/**
 * Базовый URL Telegram Bot API
 * @constant {string}
 */
const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

/**
 * Выполнение запроса к Telegram Bot API
 * @param {string} method - Метод API (sendMessage, editMessageText и т.д.)
 * @param {Object} body - Тело запроса
 * @returns {Promise<Object|null>} Ответ API или null при ошибке
 */
async function callTelegramApi(method, body) {
    if (!TELEGRAM_BOT_TOKEN) {
        console.warn('[Telegram] Bot token not configured');
        return null;
    }

    try {
        const response = await fetch(`${TELEGRAM_API_BASE}${TELEGRAM_BOT_TOKEN}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error(`[Telegram] ${method} failed:`, errorData);
            return null;
        }

        return await response.json();
    } catch (err) {
        console.error(`[Telegram] ${method} error:`, err.message);
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
 * @param {number|string} chatId - ID чата
 * @param {number} messageId - ID сообщения
 * @param {string} text - Новый текст
 * @param {Object} [replyMarkup] - Новая inline клавиатура
 * @returns {Promise<Object|null>}
 */
async function editTelegramMessage(chatId, messageId, text, replyMarkup = null) {
    const body = {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML'
    };

    if (replyMarkup) {
        body.reply_markup = replyMarkup;
    }

    return await callTelegramApi('editMessageText', body);
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
                    text: '📋 Открыть заявку',
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

    const body = {
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
    };

    // Добавляем inline кнопки если есть код
    if (code) {
        body.reply_markup = {
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
                ]
            ]
        };
    }

    try {
        const response = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }
        );

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('[Telegram] Send failed:', errorData);
            return null;
        }

        return await response.json();
    } catch (err) {
        console.error('[Telegram] Network error:', err.message);
        return null;
    }
}

// ============================================
// Telegram Bot: Обработка команд
// ============================================

/**
 * Обработка команды /approve
 * @param {number|string} chatId - ID чата
 * @param {number} messageId - ID сообщения
 * @param {string} code - Код заявки
 */
async function handleApproveCommand(chatId, messageId, code) {
    if (!code) {
        await sendTelegramMessage(
            '❌ Укажите код заявки. Пример: <code>/approve ABC123</code>',
            null,
            chatId
        );
        return;
    }

    // Показываем "в процессе"
    await editTelegramMessage(chatId, messageId, '⏳ Обработка заявки...');

    const result = await approveApplication(code);

    if (result.success) {
        const successText =
            `✅ <b>Заявка одобрена!</b>\n\n` +
            `🔑 <b>Код:</b> <code>${code}</code>\n` +
            `👤 <b>Логин:</b> <code>${result.login}</code>\n` +
            `🔐 <b>Пароль:</b> <code>${result.password}</code>\n\n` +
            `⚠️ Передайте эти данные пользователю.`;

        await editTelegramMessage(chatId, messageId, successText);
    } else {
        const errorText =
            `❌ <b>Ошибка одобрения</b>\n\n` +
            `🔑 <b>Код:</b> <code>${code}</code>\n` +
            `⚠️ <b>Причина:</b> ${result.error}`;

        await editTelegramMessage(chatId, messageId, errorText);
    }
}

/**
 * Обработка команды /reject
 * @param {number|string} chatId - ID чата
 * @param {number} messageId - ID сообщения
 * @param {string} code - Код заявки
 */
async function handleRejectCommand(chatId, messageId, code) {
    if (!code) {
        await sendTelegramMessage(
            '❌ Укажите код заявки. Пример: <code>/reject ABC123</code>',
            null,
            chatId
        );
        return;
    }

    await editTelegramMessage(chatId, messageId, '⏳ Обработка заявки...');

    const result = await rejectApplication(code);

    if (result.success) {
        const successText =
            `🚫 <b>Заявка отклонена</b>\n\n` +
            `🔑 <b>Код:</b> <code>${code}</code>\n` +
            `Пользователь получит уведомление об отказе.`;

        await editTelegramMessage(chatId, messageId, successText);
    } else {
        const errorText =
            `❌ <b>Ошибка отклонения</b>\n\n` +
            `🔑 <b>Код:</b> <code>${code}</code>\n` +
            `⚠️ <b>Причина:</b> ${result.error}`;

        await editTelegramMessage(chatId, messageId, errorText);
    }
}

/**
 * Обработка команды /help
 * @param {number|string} chatId - ID чата
 */
async function handleHelpCommand(chatId) {
    const helpText =
        `🤖 <b>Oris Team Bot</b>\n\n` +
        `Доступные команды:\n\n` +
        `/approve <code>CODE</code> — одобрить заявку\n` +
        `/reject <code>CODE</code> — отклонить заявку\n` +
        `/list — список всех заявок\n` +
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
            await sendTelegramMessage('📭 Заявок пока нет.', null, chatId);
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

        applications.slice(0, 10).forEach((app, idx) => {
            const emoji = statusEmoji[app.status] || '❓';
            const status = statusText[app.status] || app.status;
            listText += `${idx + 1}. ${emoji} <code>${app.code}</code> — ${app.fullName}\n`;
            listText += `   ${status}\n`;
        });

        if (applications.length > 10) {
            listText += `\n...и ещё ${applications.length - 10}`;
        }

        await sendTelegramMessage(listText, null, chatId);
    } catch (err) {
        console.error('[Bot] /list error:', err);
        await sendTelegramMessage('❌ Ошибка получения списка заявок.', null, chatId);
    }
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
            applicationCode: normalizedCode,
            createdAt: new Date().toISOString(),
            role: 'team'
        });
        await kv.sadd(K.USERS_INDEX, login);

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

        await kv.hset(K.APPLICATION(normalizedCode), { status: 'rejected' });
        console.log(`[Team] Application rejected: ${normalizedCode}`);
        return { success: true };
    } catch (err) {
        console.error('[Team] Reject error:', err);
        return { success: false, error: err.message };
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

    // Формат: "approve_CODE" или "reject_CODE"
    const separatorIndex = data.indexOf('_');
    if (separatorIndex === -1) {
        await answerCallbackQuery(callbackQuery.id, '❌ Неизвестное действие');
        return;
    }

    const action = data.substring(0, separatorIndex);
    const code = data.substring(separatorIndex + 1);

    console.log(`[Bot] Parsed action: ${action}, code: ${code}`);

    if (action === 'approve') {
        await handleApproveCommand(chatId, messageId, code);
        await answerCallbackQuery(callbackQuery.id, '✅ Заявка одобрена');
    } else if (action === 'reject') {
        await handleRejectCommand(chatId, messageId, code);
        await answerCallbackQuery(callbackQuery.id, '🚫 Заявка отклонена');
    } else {
        await answerCallbackQuery(callbackQuery.id, '❌ Неизвестное действие');
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

        // Уведомление в Telegram с inline-кнопками
        const notificationText =
            `<b>📝 Новая заявка в команду</b>\n\n` +
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
 * GET /bot/info — информация о webhook (для отладки)
 */
router.get('/bot/info', verifyAdminToken, async (req, res) => {
    if (!TELEGRAM_BOT_TOKEN) {
        return res.status(500).json({ error: ERROR_MESSAGES.BOT_NOT_CONFIGURED });
    }

    try {
        const response = await fetch(`${TELEGRAM_API_BASE}${TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
        const data = await response.json();
        res.json({
            configured: !!TELEGRAM_CHAT_ID,
            chatId: TELEGRAM_CHAT_ID,
            webhookUrl: `${BASE_URL}/api/team/bot`,
            webhookInfo: data.result || null
        });
    } catch (err) {
        console.error('[Bot] Info error:', err);
        res.status(500).json({ error: ERROR_MESSAGES.SERVER_ERROR });
    }
});

/**
 * POST /bot/setup — установка webhook (админ)
 * Вызывается один раз после деплоя
 */
router.post('/bot/setup', verifyAdminToken, async (req, res) => {
    if (!TELEGRAM_BOT_TOKEN) {
        return res.status(500).json({ error: ERROR_MESSAGES.BOT_NOT_CONFIGURED });
    }

    const webhookUrl = `${BASE_URL}/api/team/bot`;

    try {
        const body = { url: webhookUrl };
        if (TELEGRAM_WEBHOOK_SECRET) {
            body.secret_token = TELEGRAM_WEBHOOK_SECRET;
        }

        const response = await fetch(`${TELEGRAM_API_BASE}${TELEGRAM_BOT_TOKEN}/setWebhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

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
        res.status(500).json({ error: ERROR_MESSAGES.SERVER_ERROR });
    }
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
                expectedWebhookUrl: `${req.protocol}://${req.get('host')}/api/team/bot`
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

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const webhookUrl = `${baseUrl}/api/team/bot`;

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