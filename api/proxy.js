// -----------------------------
// Модули и Зависимости
// -----------------------------

// -----------------------------
// Node.js Core Modules
// -----------------------------


/**
 * Работа с файловой системой (асинхронный API)
 */
const fs = require('fs').promises;

/**
 * Утилиты для работы с путями файлов и директорий
 */
const path = require('path');

/**
 * Криптографические функции (используется для безопасного сравнения токенов)
 */
const crypto = require('crypto');

// -----------------------------
// Third-Party Dependencies
// -----------------------------

/**
 * Веб-фреймворк для создания HTTP-сервера и маршрутизации
 */
const express = require('express');

/**
 * Middleware для установки HTTP-заголовков безопасности
 */
const helmet = require('helmet');

/**
 * Middleware для логирования HTTP-запросов
 */
const morgan = require('morgan');

/**
 * Redis-совместимое key-value хранилище от Vercel
 */
const { kv } = require('@vercel/kv');

/**
 * waitUntil из @vercel/functions продлевает жизнь serverless-функции до
 * завершения фоновой задачи. Вне Vercel-рантайма пакет/контекст может
 * отсутствовать, поэтому подключаем его защищённо.
 */
let vercelWaitUntil = null;
try {
    ({ waitUntil: vercelWaitUntil } = require('@vercel/functions'));
} catch (_) {
    vercelWaitUntil = null;
}

// -----------------------------
// Internal Application Modules
// -----------------------------

/**
 * Пути к внутренним модулям приложения
 */
const MODULE_PATHS = {
    NEWS: '../news',
    SUPPORT: '../support',
    DOWNLOADER: '../downloader',
    REDIRECTS: '../redirects',
    NOTIFICATIONS: '../notifications',
    ROBLOX: '../roblox',
    YOUTUBE: '../youtube',
    MONITOR: '../monitor',
    JSON_STUDIO: '../json_studio',
    GETLI: '../getli'
};

/**
 * Роутер для работы с новостями
 */
const newsRouter = require(MODULE_PATHS.NEWS);

/**
 * Роутер для технической поддержки
 */
const supportRouter = require(MODULE_PATHS.SUPPORT);

/**
 * Роутер для загрузчика файлов
 */
const downloaderRouter = require(MODULE_PATHS.DOWNLOADER);

/**
 * Роутер для управления редиректами
 */
const redirectsRouter = require(MODULE_PATHS.REDIRECTS);

/**
 * Роутер для уведомлений
 */
const notificationsRouter = require(MODULE_PATHS.NOTIFICATIONS);

/**
 * Роутер для уведомлений
 */
const getliRouter = require(MODULE_PATHS.GETLI);

/**
 * Роутер для roblox
 */
const robloxRouter = require(MODULE_PATHS.ROBLOX);

/**
 * Роутер для youtube
 */
const youtubeRouter = require(MODULE_PATHS.YOUTUBE);

/**
 * Роутер для monitor
 */
const monitorRouter = require(MODULE_PATHS.MONITOR);

/**
 * Роутер для monitor
 */
const jsonStudioRouter = require(MODULE_PATHS.JSON_STUDIO);

// -----------------------------
// Константы и Конфигурация
// -----------------------------

// -----------------------------
// Server Configuration
// -----------------------------

/**
 * Базовая конфигурация сервера
 */
const SERVER_CONFIG = {
    PORT: process.env.PORT || 3000
};

// -----------------------------
// Path Configuration
// -----------------------------

/**
 * Конфигурация путей к файлам и директориям
 * Пути скорректированы для расположения в api/
 * __dirname указывает на /api, поэтому добавляем ..
 */
class PathConfig {
    /**
     * Путь к директории public
     * @returns {string}
     */
    static get PUBLIC_DIR() {
        return path.join(__dirname, '..', 'public');
    }

    /**
     * Путь к файлу saites.txt
     * @returns {string}
     */
    static get SAITES_FILE() {
        return process.env.SAITES_FILE || path.join(__dirname, '..', 'saites.txt');
    }

    /**
     * Путь к файлу changelog.txt
     * @returns {string}
     */
    static get CHANGELOG_FILE() {
        return process.env.CHANGELOG_FILE || path.join(__dirname, '..', 'changelog.txt');
    }
}

// -----------------------------
// GitHub API Configuration
// -----------------------------

/**
 * Конфигурация GitHub API для работы с репозиторием
 */
class GitHubConfig {
    /**
     * Владелец репозитория
     * @returns {string|undefined}
     */
    static get OWNER() {
        return process.env.GITHUB_OWNER;
    }

    /**
     * Имя репозитория
     * @returns {string|undefined}
     */
    static get REPO() {
        return process.env.GITHUB_REPO;
    }

    /**
     * Ветка репозитория
     * @returns {string}
     */
    static get BRANCH() {
        return process.env.GITHUB_BRANCH || 'Oris';
    }

    /**
     * Путь к файлу saites.txt в репозитории
     * @returns {string}
     */
    static get SAITES_PATH() {
        return process.env.GITHUB_SAITES_PATH || 'saites.txt';
    }

    /**
     * Путь к файлу changelog.txt в репозитории
     * @returns {string}
     */
    static get CHANGELOG_PATH() {
        return process.env.GITHUB_CHANGELOG_PATH || 'changelog.txt';
    }

    /**
     * Токен для аутентификации в GitHub API
     * @returns {string|undefined}
     */
    static get TOKEN() {
        return process.env.GITHUB_TOKEN;
    }

    /**
     * Проверка, настроен ли GitHub
     * @returns {boolean}
     */
    static isConfigured() {
        return !!(this.OWNER && this.REPO && this.TOKEN);
    }
}

// -----------------------------
// Telegram Configuration
// -----------------------------

/**
 * Конфигурация Telegram Bot API
 */
class TelegramConfig {
    /**
     * Токен бота
     * @returns {string|undefined}
     */
    static get BOT_TOKEN() {
        return process.env.TELEGRAM_BOT_TOKEN;
    }

    /**
     * ID чата для отправки сообщений
     * @returns {string|undefined}
     */
    static get CHAT_ID() {
        return process.env.TELEGRAM_CHAT_ID;
    }

    /**
     * Проверка, настроен ли Telegram
     * @returns {boolean}
     */
    static isConfigured() {
        return !!(this.BOT_TOKEN && this.CHAT_ID);
    }
}

// -----------------------------
// Admin Configuration
// -----------------------------

/**
 * Конфигурация административного доступа
 */
class AdminConfig {
    /**
     * Токен для аутентификации администратора
     * @returns {string|undefined}
     */
    static get TOKEN() {
        return process.env.ADMIN_TOKEN;
    }

    /**
     * Проверка, настроен ли административный токен
     * @returns {boolean}
     */
    static isConfigured() {
        return !!this.TOKEN;
    }
}

// -----------------------------
// Timeout and Retry Configuration
// -----------------------------

/**
 * Конфигурация таймаутов и повторных попыток
 */
class TimeoutConfig {
    /**
     * Таймаут HTTP запросов (10 секунд)
     * @returns {number}
     */
    static get FETCH_TIMEOUT() {
        return 10000;
    }

    /**
     * Максимальное количество повторных попыток
     * @returns {number}
     */
    static get FETCH_MAX_RETRIES() {
        return 3;
    }

    /**
     * Время жизни кэша (5 минут)
     * @returns {number}
     */
    static get CACHE_TTL() {
        return 5 * 60 * 1000;
    }

    /**
     * Время жизни кэша YouTube (5 минут)
     * @returns {number}
     */
    static get YT_CACHE_TTL() {
        return 5 * 60 * 1000;
    }
}

// -----------------------------
// Rate Limiting Configuration
// -----------------------------

/**
 * Конфигурация ограничения запросов
 */
class RateLimitConfig {
    /**
     * Окно времени для rate limiting (1 минута)
     * @returns {number}
     */
    static get WINDOW() {
        return 60 * 1000;
    }

    /**
     * Максимальное количество запросов в окне
     * @returns {number}
     */
    static get MAX() {
        return 60;
    }

    /**
     * Кулдаун между отправками форм (30 секунд)
     * @returns {number}
     */
    static get FORM_COOLDOWN() {
        return 30 * 1000;
    }
}

// -----------------------------
// Validation Configuration
// -----------------------------

/**
 * Конфигурация ограничений валидации
 */
class ValidationConfig {
    /**
     * Максимальная длина контента
     * @returns {number}
     */
    static get MAX_CONTENT_LENGTH() {
        return 500000;
    }

    /**
     * Максимальная длина заголовка
     * @returns {number}
     */
    static get MAX_TITLE_LENGTH() {
        return 200;
    }

    /**
     * Максимальная длина описания
     * @returns {number}
     */
    static get MAX_DESCRIPTION_LENGTH() {
        return 1000;
    }

    /**
     * Минимальная длина заголовка
     * @returns {number}
     */
    static get MIN_TITLE_LENGTH() {
        return 3;
    }

    /**
     * Минимальная длина описания
     * @returns {number}
     */
    static get MIN_DESCRIPTION_LENGTH() {
        return 20;
    }
}

// -----------------------------
// Category Metadata
// -----------------------------

/**
 * Метаданные категорий с SVG иконками и цветами
 */
class CategoryMetadata {
    /**
     * Данные категорий
     * @returns {Object}
     */
    static get DATA() {
        return {
            tools: {
                label: 'Инструменты',
                icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
                color: '#FF9F0A'
            },
            dev: {
                label: 'Для разработчиков',
                icon: 'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4',
                color: '#0071E3'
            },
            design: {
                label: 'Дизайн',
                icon: 'M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01',
                color: '#AF52DE'
            },
            education: {
                label: 'Образование',
                icon: 'M12 14l9-5-9-5-9 5 9 5z M12 14l6.16-3.422a12.083 12.083 0 01.665 6.479A11.952 11.952 0 0012 20.055a11.952 11.952 0 00-6.824-2.998 12.078 12.078 0 01.665-6.479L12 14z',
                color: '#34C759'
            },
            games: {
                label: 'Игры',
                icon: 'M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
                color: '#FF3B30'
            },
            media: {
                label: 'Медиа',
                icon: 'M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z',
                color: '#FF9F0A'
            },
            social: {
                label: 'Соцсети',
                icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z',
                color: '#5E5CE6'
            },
            other: {
                label: 'Другое',
                icon: 'M5 12h.01M12 12h.01M19 12h.01M6 12a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0z',
                color: '#8E8E93'
            }
        };
    }

    /**
     * Получение метаданных категории
     * @param {string} category - Идентификатор категории
     * @returns {Object|null} - Метаданные категории или null
     */
    static get(category) {
        return this.DATA[category] || null;
    }

    /**
     * Получение метки категории
     * @param {string} category - Идентификатор категории
     * @returns {string} - Метка категории
     */
    static getLabel(category) {
        const metadata = this.get(category);
        return metadata ? metadata.label : 'Другое';
    }

    /**
     * Получение иконки категории
     * @param {string} category - Идентификатор категории
     * @returns {string} - SVG path иконки
     */
    static getIcon(category) {
        const metadata = this.get(category);
        return metadata ? metadata.icon : '';
    }

    /**
     * Получение цвета категории
     * @param {string} category - Идентификатор категории
     * @returns {string} - HEX цвет
     */
    static getColor(category) {
        const metadata = this.get(category);
        return metadata ? metadata.color : '#8E8E93';
    }

    /**
     * Получение списка всех категорий
     * @returns {Array<string>} - Массив идентификаторов категорий
     */
    static getAllCategories() {
        return Object.keys(this.DATA);
    }

    /**
     * Проверка валидности категории
     * @param {string} category - Идентификатор категории
     * @returns {boolean} - true если категория валидна
     */
    static isValid(category) {
        return category in this.DATA;
    }
}

// -----------------------------
// Legacy Variables (Backward Compatibility)
// -----------------------------

/**
 * Порт сервера (обратная совместимость)
 */
const PORT = SERVER_CONFIG.PORT;

/**
 * Путь к директории public (обратная совместимость)
 */
const PUBLIC_DIR = PathConfig.PUBLIC_DIR;

/**
 * Путь к файлу saites.txt (обратная совместимость)
 */
const SAITES_FILE = PathConfig.SAITES_FILE;

/**
 * Путь к файлу changelog.txt (обратная совместимость)
 */
const CHANGELOG_FILE = PathConfig.CHANGELOG_FILE;

/**
 * GitHub конфигурация (обратная совместимость)
 */
const GITHUB_OWNER = GitHubConfig.OWNER;
const GITHUB_REPO = GitHubConfig.REPO;
const GITHUB_BRANCH = GitHubConfig.BRANCH;
const GITHUB_SAITES_PATH = GitHubConfig.SAITES_PATH;
const GITHUB_CHANGELOG_PATH = GitHubConfig.CHANGELOG_PATH;
const GITHUB_TOKEN = GitHubConfig.TOKEN;

/**
 * Telegram конфигурация (обратная совместимость)
 */
const TELEGRAM_BOT_TOKEN = TelegramConfig.BOT_TOKEN;
const TELEGRAM_CHAT_ID = TelegramConfig.CHAT_ID;

/**
 * Admin конфигурация (обратная совместимость)
 */
const ADMIN_TOKEN = AdminConfig.TOKEN;

/**
 * Timeout конфигурация (обратная совместимость)
 */
const FETCH_TIMEOUT = TimeoutConfig.FETCH_TIMEOUT;
const FETCH_MAX_RETRIES = TimeoutConfig.FETCH_MAX_RETRIES;
const CACHE_TTL = TimeoutConfig.CACHE_TTL;
const YT_CACHE_TTL = TimeoutConfig.YT_CACHE_TTL;

/**
 * Rate Limit конфигурация (обратная совместимость)
 */
const RATE_LIMIT_WINDOW = RateLimitConfig.WINDOW;
const RATE_LIMIT_MAX = RateLimitConfig.MAX;
const FORM_COOLDOWN = RateLimitConfig.FORM_COOLDOWN;

/**
 * Validation конфигурация (обратная совместимость)
 */
const MAX_CONTENT_LENGTH = ValidationConfig.MAX_CONTENT_LENGTH;
const MAX_TITLE_LENGTH = ValidationConfig.MAX_TITLE_LENGTH;
const MAX_DESCRIPTION_LENGTH = ValidationConfig.MAX_DESCRIPTION_LENGTH;
const MIN_TITLE_LENGTH = ValidationConfig.MIN_TITLE_LENGTH;
const MIN_DESCRIPTION_LENGTH = ValidationConfig.MIN_DESCRIPTION_LENGTH;

/**
 * Метаданные категорий (обратная совместимость)
 */
const CATEGORY_META = CategoryMetadata.DATA;

// -----------------------------
// Инициализация Express
// -----------------------------

const app = express();

// -----------------------------
// CSP Domain Constants
// -----------------------------

// Self and inline resources
const CSP_SELF = "'self'";
const CSP_UNSAFE_INLINE = "'unsafe-inline'";
const CSP_NONE = "'none'";

// CDN and external resources
const CSP_TAILWIND_CDN = "https://cdn.tailwindcss.com";
const CSP_UNPKG = "https://unpkg.com";
const CSP_CLOUDFLARE = "https://cdnjs.cloudflare.com";

// Google Fonts
const CSP_GOOGLE_FONTS = "https://fonts.googleapis.com";
const CSP_GOOGLE_FONTS_STATIC = "https://fonts.gstatic.com";

// Notifications
const CSP_FIREFOX = "https://push.services.mozilla.com";
const CSP_GOOGLE_notifications = "https://fcm.googleapis.com";

// YouTube resources
const CSP_YOUTUBE_THUMBNAILS = "https://i.ytimg.com";
const CSP_YOUTUBE_CHANNEL = "https://yt3.ggpht.com";
const CSP_YOUTUBE_USER_CONTENT = "https://yt3.googleusercontent.com";
const CSP_YOUTUBE_API = "https://www.youtube.com";

// Vercel Blob Storage
const CSP_VERCEL_BLOB = "https://*.blob.vercel-storage.com";
const CSP_VERCEL_PUBLIC_BLOB = "https://*.public.blob.vercel-storage.com";

// PeerJS WebRTC
const CSP_PEERJS_WS = "wss://0.peerjs.com";
const CSP_PEERJS_WS_1 = "wss://1.peerjs.com";
const CSP_PEERJS_WS_WILDCARD = "wss://*.peerjs.com";
const CSP_PEERJS_HTTPS = "https://*.peerjs.com";

// Hosting platforms (Railway, Render, Glitch)
const CSP_RAILWAY_HTTPS = "https://*.railway.app";
const CSP_RAILWAY_WSS = "wss://*.railway.app";
const CSP_RENDER_HTTPS = "https://*.onrender.com";
const CSP_RENDER_WSS = "wss://*.onrender.com";
const CSP_GLITCH_HTTPS = "https://*.glitch.me";
const CSP_GLITCH_WSS = "wss://*.glitch.me";

// External APIs
const CSP_GITHUB_API = "https://api.github.com";
const CSP_TELEGRAM_API = "https://api.telegram.org";

// Data and blob URLs
const CSP_DATA = "data:";
const CSP_BLOB = "blob:";

// -----------------------------
// CSP Configuration
// -----------------------------

const CSP_DIRECTIVES = {
    defaultSrc: [CSP_SELF],
    
    scriptSrc: [
        CSP_SELF,
        CSP_UNSAFE_INLINE,
        CSP_TAILWIND_CDN,
        CSP_GOOGLE_FONTS,
        CSP_UNPKG,
        CSP_CLOUDFLARE
    ],
    
    styleSrc: [
        CSP_SELF,
        CSP_UNSAFE_INLINE,
        CSP_GOOGLE_FONTS,
        CSP_CLOUDFLARE
    ],
    
    fontSrc: [
        CSP_SELF,
        CSP_GOOGLE_FONTS_STATIC,
        CSP_DATA,
        CSP_CLOUDFLARE
    ],
    
    imgSrc: [
        CSP_SELF,
        CSP_DATA,
        CSP_BLOB,
        CSP_YOUTUBE_THUMBNAILS,
        CSP_YOUTUBE_CHANNEL,
        CSP_YOUTUBE_USER_CONTENT,
        CSP_VERCEL_BLOB,
        CSP_VERCEL_PUBLIC_BLOB
    ],
    
    mediaSrc: [
        CSP_SELF,
        CSP_BLOB,
        CSP_VERCEL_BLOB,
        CSP_VERCEL_PUBLIC_BLOB
    ],
    
    connectSrc: [
        CSP_FIREFOX,
        CSP_GOOGLE_notifications,
        CSP_SELF,
        CSP_GITHUB_API,
        CSP_YOUTUBE_API,
        CSP_TELEGRAM_API,
        CSP_PEERJS_WS,
        CSP_PEERJS_WS_1,
        CSP_PEERJS_WS_WILDCARD,
        CSP_PEERJS_HTTPS,
        CSP_RAILWAY_HTTPS,
        CSP_RAILWAY_WSS,
        CSP_RENDER_HTTPS,
        CSP_RENDER_WSS,
        CSP_GLITCH_HTTPS,
        CSP_GLITCH_WSS,
        CSP_VERCEL_BLOB,
        CSP_VERCEL_PUBLIC_BLOB,
        'https://fcm.googleapis.com/fcm/send',
        'https://android.googleapis.com',    // Android GCM
        'https://push.apple.com' 
    ],
    
    objectSrc: [CSP_NONE],
    baseUri: [CSP_SELF],
    formAction: [CSP_SELF]
};

// -----------------------------
// Helmet Configuration
// -----------------------------

const HELMET_CONFIG = {
    contentSecurityPolicy: {
        directives: CSP_DIRECTIVES
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: { 
        policy: "same-origin" 
    },
    referrerPolicy: { 
        policy: "strict-origin-when-cross-origin" 
    }
};

// -----------------------------
// Security Middleware
// -----------------------------

app.use(helmet(HELMET_CONFIG));

// -----------------------------
// Вспомогательные функции
// -----------------------------

// -----------------------------
// Constants
// -----------------------------

const HTTP_RETRY_DELAY = 1000; // 1 секунда между попытками
const HTTP_RETRYABLE_ERRORS = ['AbortError', 'FetchError'];

const SANITIZE_PATTERNS = {
    TAGS: /[<>]/g,
    AMPERSAND: /&/g,
    DOUBLE_QUOTE: /"/g,
    SINGLE_QUOTE: /'/g
};

const URL_PROTOCOL_REGEX = /^https?:\/\//i;
const VALID_URL_PROTOCOLS = ['http:', 'https:'];

// -----------------------------
// HTTP Service
// -----------------------------

/**
 * Сервис для выполнения HTTP запросов с повторными попытками
 */
class HttpService {
    /**
     * Выполнение fetch запроса с таймаутом
     * @param {string} url - URL для запроса
     * @param {Object} options - Опции fetch
     * @param {number} timeout - Таймаут в миллисекундах
     * @returns {Promise<Response>} - Response объект
     */
    async fetchWithTimeout(url, options, timeout) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            return response;
        } catch (error) {
            clearTimeout(timeoutId);
            throw error;
        }
    }

    /**
     * Проверка, является ли ошибка повторной
     * @param {Error} error - Объект ошибки
     * @returns {boolean} - true если можно повторить запрос
     */
    isRetryableError(error) {
        return HTTP_RETRYABLE_ERRORS.includes(error.name);
    }

    /**
     * Задержка перед повторной попыткой
     * @param {number} delay - Задержка в миллисекундах
     * @returns {Promise<void>}
     */
    async delay(delay) {
        return new Promise(resolve => setTimeout(resolve, delay));
    }

    /**
     * Fetch с таймаутом и повторными попытками
     * @param {string} url - URL для запроса
     * @param {Object} options - Опции fetch
     * @param {number} retries - Количество оставшихся попыток
     * @returns {Promise<Response>} - Response объект
     * @throws {Error} - Если все попытки исчерпаны
     */
    async fetchWithRetry(url, options = {}, retries = FETCH_MAX_RETRIES) {
        try {
            const response = await this.fetchWithTimeout(url, options, FETCH_TIMEOUT);
            return response;
        } catch (error) {
            // Проверка возможности повтора
            if (retries > 0 && this.isRetryableError(error)) {
                await this.delay(HTTP_RETRY_DELAY);
                return this.fetchWithRetry(url, options, retries - 1);
            }
            throw error;
        }
    }
}

// Инициализация сервиса
const httpService = new HttpService();

// -----------------------------
// Sanitize Service
// -----------------------------

/**
 * Сервис для безопасной очистки строк
 */
class SanitizeService {
    /**
     * Проверка наличия значения
     * @param {any} value - Значение для проверки
     * @returns {boolean} - true если значение существует
     */
    hasValue(value) {
        return value !== null && value !== undefined && value !== '';
    }

    /**
     * Преобразование в строку
     * @param {any} value - Значение для преобразования
     * @returns {string} - Строковое представление
     */
    toString(value) {
        return String(value);
    }

    /**
     * Удаление HTML тегов
     * @param {string} str - Исходная строка
     * @returns {string} - Строка без тегов
     */
    removeTags(str) {
        return str.replace(SANITIZE_PATTERNS.TAGS, '');
    }

    /**
     * Экранирование специальных символов
     * @param {string} str - Исходная строка
     * @returns {string} - Экранированная строка
     */
    escapeSpecialChars(str) {
        return str
            .replace(SANITIZE_PATTERNS.AMPERSAND, '&amp;')
            .replace(SANITIZE_PATTERNS.DOUBLE_QUOTE, '&quot;')
            .replace(SANITIZE_PATTERNS.SINGLE_QUOTE, '&#x27;');
    }

    /**
     * Безопасная очистка строки для HTML-контекста
     * Примечание: экранирование должно выполняться на клиенте.
     * Эта функция только удаляет опасные символы для предотвращения инъекций.
     * @param {any} str - Строка для очистки
     * @returns {string} - Очищенная строка
     */
    sanitize(str) {
        if (!this.hasValue(str)) {
            return '';
        }

        let cleaned = this.toString(str);
        cleaned = this.removeTags(cleaned);
        cleaned = this.escapeSpecialChars(cleaned);
        
        return cleaned.trim();
    }
}

// Инициализация сервиса
const sanitizeService = new SanitizeService();

// -----------------------------
// URL Service
// -----------------------------

/**
 * Сервис для работы с URL
 */
class UrlService {
    /**
     * Проверка наличия значения
     * @param {any} url - URL для проверки
     * @returns {boolean} - true если URL существует
     */
    hasValue(url) {
        return url !== null && url !== undefined && url !== '';
    }

    /**
     * Обрезка пробелов
     * @param {string} url - URL для обрезки
     * @returns {string} - Обрезанный URL
     */
    trim(url) {
        return url.trim();
    }

    /**
     * Проверка наличия протокола
     * @param {string} url - URL для проверки
     * @returns {boolean} - true если протокол присутствует
     */
    hasProtocol(url) {
        return URL_PROTOCOL_REGEX.test(url);
    }

    /**
     * Добавление протокола https://
     * @param {string} url - URL без протокола
     * @returns {string} - URL с протоколом
     */
    addHttpsProtocol(url) {
        return `https://${url}`;
    }

    /**
     * Парсинг URL
     * @param {string} url - URL для парсинга
     * @returns {URL|null} - URL объект или null при ошибке
     */
    parseUrl(url) {
        try {
            return new URL(url);
        } catch {
            return null;
        }
    }

    /**
     * Проверка валидности протокола
     * @param {string} protocol - Протокол для проверки
     * @returns {boolean} - true если протокол валиден
     */
    isValidProtocol(protocol) {
        return VALID_URL_PROTOCOLS.includes(protocol);
    }

    /**
     * Валидация URL
     * @param {string} url - URL для проверки
     * @returns {boolean} - true если URL валиден
     */
    isValidUrl(url) {
        const parsed = this.parseUrl(url);
        if (!parsed) {
            return false;
        }
        return this.isValidProtocol(parsed.protocol);
    }

    /**
     * Нормализация URL (добавление https:// если нет протокола)
     * @param {string} url - URL для нормализации
     * @returns {string} - Нормализованный URL
     */
    normalizeUrl(url) {
        if (!this.hasValue(url)) {
            return url;
        }

        const trimmed = this.trim(url);
        
        if (this.hasProtocol(trimmed)) {
            return trimmed;
        }

        return this.addHttpsProtocol(trimmed);
    }
}

// Инициализация сервиса
const urlService = new UrlService();

// -----------------------------
// Legacy Functions (Backward Compatibility)
// -----------------------------

/**
 * Fetch с таймаутом и повторными попытками (обратная совместимость)
 * @param {string} url - URL для запроса
 * @param {Object} options - Опции fetch
 * @param {number} retries - Количество оставшихся попыток
 * @returns {Promise<Response>} - Response объект
 */
async function fetchWithRetry(url, options = {}, retries = FETCH_MAX_RETRIES) {
    return httpService.fetchWithRetry(url, options, retries);
}

/**
 * Безопасная очистка строки для HTML-контекста (обратная совместимость)
 * @param {any} str - Строка для очистки
 * @returns {string} - Очищенная строка
 */
function sanitize(str) {
    return sanitizeService.sanitize(str);
}

/**
 * Валидация URL (обратная совместимость)
 * @param {string} url - URL для проверки
 * @returns {boolean} - true если URL валиден
 */
function isValidUrl(url) {
    return urlService.isValidUrl(url);
}

/**
 * Нормализация URL (обратная совместимость)
 * @param {string} url - URL для нормализации
 * @returns {string} - Нормализованный URL
 */
function normalizeUrl(url) {
    return urlService.normalizeUrl(url);
}

// -----------------------------
// Rate Limiting Middleware
// -----------------------------

// -----------------------------
// Constants
// -----------------------------

const RATE_LIMIT_CLEANUP_INTERVAL = 60 * 1000; // 1 минута
const RATE_LIMIT_ERROR_MESSAGE = 'Too many requests, please try again later.';

// -----------------------------
// Global Rate Limit Service
// -----------------------------

/**
 * Сервис для управления глобальным rate limiting запросов
 */
class GlobalRateLimitService {
    constructor() {
        this.rateLimitMap = new Map();
        this.startCleanupInterval();
    }

    /**
     * Получение или создание записи для IP
     * @param {string} ip - IP адрес клиента
     * @param {number} now - Текущее время в миллисекундах
     * @returns {Object} - Запись rate limit { count, resetTime }
     */
    getOrCreateRecord(ip, now) {
        if (!this.rateLimitMap.has(ip)) {
            const record = {
                count: 1,
                resetTime: now + RATE_LIMIT_WINDOW
            };
            this.rateLimitMap.set(ip, record);
            return record;
        }
        return this.rateLimitMap.get(ip);
    }

    /**
     * Сброс счетчика при истечении окна
     * @param {Object} record - Запись rate limit
     * @param {number} now - Текущее время в миллисекундах
     */
    resetIfExpired(record, now) {
        if (now > record.resetTime) {
            record.count = 1;
            record.resetTime = now + RATE_LIMIT_WINDOW;
        }
    }

    /**
     * Проверка превышения лимита
     * @param {Object} record - Запись rate limit
     * @returns {boolean} - true если лимит превышен
     */
    isLimitExceeded(record) {
        return record.count >= RATE_LIMIT_MAX;
    }

    /**
     * Инкремент счетчика запросов
     * @param {Object} record - Запись rate limit
     */
    incrementCount(record) {
        record.count++;
    }

    /**
     * Очистка устаревших записей
     */
    cleanupExpiredRecords() {
        const now = Date.now();
        for (const [ip, record] of this.rateLimitMap.entries()) {
            if (now > record.resetTime) {
                this.rateLimitMap.delete(ip);
            }
        }
    }

    /**
     * Запуск периодической очистки устаревших записей
     */
    startCleanupInterval() {
        setInterval(() => {
            this.cleanupExpiredRecords();
        }, RATE_LIMIT_CLEANUP_INTERVAL);
    }

    /**
     * Middleware для rate limiting
     * @param {Request} req - Express request объект
     * @param {Response} res - Express response объект
     * @param {Function} next - Express next функция
     */
    middleware(req, res, next) {
        const ip = req.ip;
        const now = Date.now();

        const record = this.getOrCreateRecord(ip, now);
        this.resetIfExpired(record, now);

        if (this.isLimitExceeded(record)) {
            return res.status(429).json({ 
                error: RATE_LIMIT_ERROR_MESSAGE 
            });
        }

        this.incrementCount(record);
        next();
    }
}

// Инициализация сервиса
const globalRateLimitService = new GlobalRateLimitService();

// -----------------------------
// Legacy Variables (Backward Compatibility)
// -----------------------------

/**
 * Map для глобального rate limiting (обратная совместимость)
 */
const rateLimitMap = globalRateLimitService.rateLimitMap;

// -----------------------------
// Middleware Application
// -----------------------------

/**
 * Глобальный middleware для rate limiting всех запросов
 */
app.use((req, res, next) => {
    globalRateLimitService.middleware(req, res, next);
});

// -----------------------------
// Core Middleware
// -----------------------------

/**
 * Логирование запросов
 */
app.use(morgan('tiny'));

/**
 * Парсинг JSON body с ограничением размера
 */
app.use(express.json({ limit: '4.4mb' }));

/**
 * Парсинг binary data с ограничением размера
 */
app.use(express.raw({ type: 'application/octet-stream', limit: '4.4mb' }));

// -----------------------------
// Router Mounting
// -----------------------------

/**
 * Подключение роутеров API
 */
app.use('/api/news', newsRouter);
app.use('/go', redirectsRouter);
app.use('/api/redirects', redirectsRouter);
app.use('/api/support', supportRouter);
app.use('/api/downloader', downloaderRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/roblox', robloxRouter);
app.use('/api/youtube', youtubeRouter);
app.use('/api/monitor', monitorRouter);
app.use('/api/json_studio', jsonStudioRouter);
app.use('/api/hetli', getliRouter);

// -----------------------------
// Dynamic Page: Downloader
// -----------------------------

// -----------------------------
// Constants
// -----------------------------

const DOWNLOADER_DIR = 'downloader';
const DOWNLOADER_HTML_FILE = 'index.html';
const HASH_INJECTION_POINT = '</head>';
const HASH_SCRIPT_TEMPLATE = '<script>window.__FILE_HASH__ = "${hash}";</script>';

const HASH_REGEX = /^[a-f0-9]{64}$/i;
const HASH_LENGTH = 64;

const DOWNLOADER_CACHE_CONTROL = 'public, max-age=60, s-maxage=300';
const STATIC_CACHE_CONTROL = '1d';

const ERROR_MESSAGES = {
    INVALID_HASH: 'Invalid hash format',
    FILE_NOT_FOUND: 'Downloader page not found',
    INTERNAL_ERROR: 'Internal server error'
};

// -----------------------------
// Dynamic Page Service
// -----------------------------

/**
 * Сервис для управления динамическими HTML-страницами
 */
class DynamicPageService {
    /**
     * Валидация SHA-256 хеша
     * @param {string} hash - Хеш для проверки
     * @returns {boolean} - true если хеш валиден
     */
    isValidHash(hash) {
        return hash && HASH_REGEX.test(hash);
    }

    /**
     * Нормализация хеша к нижнему регистру
     * @param {string} hash - Хеш для нормализации
     * @returns {string} - Хеш в нижнем регистре
     */
    normalizeHash(hash) {
        return hash ? hash.toLowerCase() : '';
    }

    /**
     * Формирование пути к HTML-файлу
     * @param {string} pageDir - Директория страницы
     * @param {string} fileName - Имя файла
     * @returns {string} - Полный путь к файлу
     */
    buildHtmlPath(pageDir, fileName) {
        return path.join(PUBLIC_DIR, pageDir, fileName);
    }

    /**
     * Чтение HTML-файла
     * @param {string} filePath - Путь к файлу
     * @returns {Promise<string>} - Содержимое файла
     * @throws {Error} - Если файл не найден
     */
    async readHtmlFile(filePath) {
        try {
            return await fs.readFile(filePath, 'utf8');
        } catch (err) {
            if (err.code === 'ENOENT') {
                throw new Error(ERROR_MESSAGES.FILE_NOT_FOUND);
            }
            throw err;
        }
    }

    /**
     * Внедрение хеша в HTML-страницу
     * @param {string} html - Исходный HTML
     * @param {string} hash - Хеш для внедрения
     * @returns {string} - Модифицированный HTML
     */
    injectHashIntoHtml(html, hash) {
        const scriptTag = HASH_SCRIPT_TEMPLATE.replace('${hash}', hash);
        return html.replace(HASH_INJECTION_POINT, `${scriptTag}${HASH_INJECTION_POINT}`);
    }

    /**
     * Установка заголовков кэширования для динамических страниц
     * @param {Response} res - Express response объект
     */
    setDynamicPageHeaders(res) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', DOWNLOADER_CACHE_CONTROL);
    }

    /**
     * Обработка запроса динамической страницы
     * @param {string} hash - Хеш файла
     * @param {string} pageDir - Директория страницы
     * @param {string} fileName - Имя файла
     * @returns {Promise<string>} - Готовый HTML
     */
    async processDynamicPage(hash, pageDir, fileName) {
        const normalizedHash = this.normalizeHash(hash);
        
        if (!this.isValidHash(normalizedHash)) {
            throw new Error(ERROR_MESSAGES.INVALID_HASH);
        }

        const htmlPath = this.buildHtmlPath(pageDir, fileName);
        const html = await this.readHtmlFile(htmlPath);
        
        return this.injectHashIntoHtml(html, normalizedHash);
    }
}

// Инициализация сервиса
const dynamicPageService = new DynamicPageService();

// -----------------------------
// Route Handlers: Downloader
// -----------------------------

/**
 * GET /downloader/:hash — динамическая страница загрузчика
 */
app.get('/downloader/:hash', async (req, res) => {
    try {
        const hash = req.params.hash;
        
        // Обработка динамической страницы
        const html = await dynamicPageService.processDynamicPage(
            hash,
            DOWNLOADER_DIR,
            DOWNLOADER_HTML_FILE
        );

        // Установка заголовков и отправка
        dynamicPageService.setDynamicPageHeaders(res);
        res.status(200).send(html);
        
    } catch (err) {
        handleDownloaderError(err, res);
    }
});

// -----------------------------
// Static Files Middleware
// -----------------------------

/**
 * Middleware для раздачи статических файлов
 */
app.use(express.static(PUBLIC_DIR, {
    maxAge: STATIC_CACHE_CONTROL,
    etag: true,
    setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
    }
}));

// -----------------------------
// Helper Functions
// -----------------------------

/**
 * Обработчик ошибок для Downloader routes
 * @param {Error} err - Объект ошибки
 * @param {Response} res - Express response объект
 */
const handleDownloaderError = (err, res) => {
    console.error('[downloader/page]', err);
    
    // Определение статуса на основе типа ошибки
    if (err.message === ERROR_MESSAGES.INVALID_HASH) {
        return res.status(400).send(ERROR_MESSAGES.INVALID_HASH);
    }
    
    if (err.message === ERROR_MESSAGES.FILE_NOT_FOUND) {
        return res.status(404).send(ERROR_MESSAGES.FILE_NOT_FOUND);
    }
    
    res.status(500).send(ERROR_MESSAGES.INTERNAL_ERROR);
};

// -----------------------------
// Кэш и Данные
// -----------------------------

// -----------------------------
// Constants
// -----------------------------

const CACHE_KEYS = {
    SITES: 'sites',
    CHANGELOG: 'changelog'
};

// -----------------------------
// Cache Service
// -----------------------------

/**
 * Универсальный сервис для управления кэшем
 */
class CacheService {
    constructor() {
        this.caches = new Map();
    }

    /**
     * Инициализация кэша
     * @param {string} key - Ключ кэша
     * @param {any} initialValue - Начальное значение
     */
    initCache(key, initialValue = null) {
        if (!this.caches.has(key)) {
            this.caches.set(key, {
                data: initialValue,
                timestamp: 0
            });
        }
    }

    /**
     * Получение данных из кэша
     * @param {string} key - Ключ кэша
     * @returns {any} - Данные из кэша
     */
    getData(key) {
        const cache = this.caches.get(key);
        return cache ? cache.data : null;
    }

    /**
     * Получение timestamp кэша
     * @param {string} key - Ключ кэша
     * @returns {number} - Timestamp последнего обновления
     */
    getTimestamp(key) {
        const cache = this.caches.get(key);
        return cache ? cache.timestamp : 0;
    }

    /**
     * Обновление кэша
     * @param {string} key - Ключ кэша
     * @param {any} data - Новые данные
     */
    updateCache(key, data) {
        this.caches.set(key, {
            data: data,
            timestamp: Date.now()
        });
    }

    /**
     * Инвалидация кэша
     * @param {string} key - Ключ кэша
     * @param {any} emptyValue - Пустое значение для кэша
     */
    invalidateCache(key, emptyValue = null) {
        this.caches.set(key, {
            data: emptyValue,
            timestamp: 0
        });
    }

    /**
     * Проверка актуальности кэша
     * @param {string} key - Ключ кэша
     * @param {number} ttl - Время жизни кэша в миллисекундах
     * @returns {boolean} - true если кэш актуален
     */
    isCacheValid(key, ttl) {
        const cache = this.caches.get(key);
        if (!cache || !cache.data) {
            return false;
        }
        
        const now = Date.now();
        return (now - cache.timestamp) < ttl;
    }

    /**
     * Проверка наличия данных в кэше
     * @param {string} key - Ключ кэша
     * @returns {boolean} - true если данные есть
     */
    hasData(key) {
        const cache = this.caches.get(key);
        if (!cache || !cache.data) {
            return false;
        }
        
        // Для массивов проверяем длину
        if (Array.isArray(cache.data)) {
            return cache.data.length > 0;
        }
        
        return true;
    }
}

// Инициализация сервиса кэша
const cacheService = new CacheService();

// Инициализация всех кэшей
cacheService.initCache(CACHE_KEYS.SITES, []);
cacheService.initCache(CACHE_KEYS.CHANGELOG, null);

// -----------------------------
// Rate Limit Service
// -----------------------------

/**
 * Сервис для управления rate limiting
 */
class RateLimitService {
    constructor() {
        this.rateLimitMap = new Map();
    }

    /**
     * Проверка rate limit для IP адреса
     * @param {string} ip - IP адрес клиента
     * @param {number} cooldown - Время кулдауна в миллисекундах
     * @returns {number} - Время ожидания в секундах (0 если лимит не превышен)
     */
    checkLimit(ip, cooldown) {
        const now = Date.now();
        const lastRequest = this.rateLimitMap.get(ip);
        
        if (lastRequest && (now - lastRequest) < cooldown) {
            const waitTime = cooldown - (now - lastRequest);
            return Math.ceil(waitTime / 1000);
        }
        
        this.rateLimitMap.set(ip, now);
        return 0;
    }

    /**
     * Сброс rate limit для IP адреса
     * @param {string} ip - IP адрес клиента
     */
    resetLimit(ip) {
        this.rateLimitMap.delete(ip);
    }

    /**
     * Очистка всех записей rate limit
     */
    clearAll() {
        this.rateLimitMap.clear();
    }
}

// Инициализация сервиса rate limiting
const rateLimitService = new RateLimitService();

// -----------------------------
// Legacy Variables (Backward Compatibility)
// -----------------------------

/**
 * Кэш сайтов (обратная совместимость)
 */
let sitesCache = { data: [], timestamp: 0 };
let changelogCache = { data: null, timestamp: 0 };

/**
 * Map для rate limiting форм (обратная совместимость)
 */
const formRateLimitMap = rateLimitService.rateLimitMap;

// -----------------------------
// Legacy Functions (Backward Compatibility)
// -----------------------------

/**
 * Проверка rate limit для форм (обратная совместимость)
 * @param {string} ip - IP адрес клиента
 * @returns {number} - Время ожидания в секундах
 */
function checkFormRateLimit(ip) {
    return rateLimitService.checkLimit(ip, FORM_COOLDOWN);
}

// -----------------------------
// Парсеры
// -----------------------------

// -----------------------------
// Constants
// -----------------------------

const VALID_CATEGORIES = ['tools', 'dev', 'design', 'education', 'games', 'media', 'social', 'other'];
const BLOCK_SEPARATOR = '::';
const METADATA_SEPARATOR = '@:';
const MIN_SITE_LINES = 3;

const CHANGELOG_CHANGE_REGEX = /^-\s*\[(\w+)\]\s*(.*)$/;
const CHANGELOG_VERSION_SEPARATOR = '|';

// -----------------------------
// Saite Parser Service
// -----------------------------

/**
 * Сервис для парсинга данных сайтов
 */
class SaiteParserService {
    /**
     * Очистка строки от метаданных и кавычек
     * @param {string} str - Строка для очистки
     * @returns {string} - Очищенная строка
     */
    cleanString(str) {
        // Удаление метаданных после @:
        let cleaned = str.split(METADATA_SEPARATOR)[0].trim();
        
        // Удаление кавычек
        if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || 
            (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
            cleaned = cleaned.slice(1, -1);
        }
        
        return cleaned.trim();
    }

    /**
     * Парсинг одного блока сайта
     * @param {string} block - Блок текста с данными сайта
     * @returns {Object|null} - Объект сайта или null при ошибке
     */
    parseSiteBlock(block) {
        const lines = block
            .trim()
            .split('\n')
            .map(line => line.trim())
            .filter(line => line);

        // Проверка минимального количества строк
        if (lines.length < MIN_SITE_LINES) {
            return null;
        }

        // Извлечение основных полей
        const title = this.cleanString(lines[0]);
        let url = this.cleanString(lines[1]);
        const desc = this.cleanString(lines[2]);
        
        // Извлечение опциональной категории
        let category = 'other';
        if (lines.length >= 4) {
            const rawCategory = this.cleanString(lines[3]).toLowerCase();
            if (VALID_CATEGORIES.includes(rawCategory)) {
                category = rawCategory;
            }
        }

        // Нормализация и валидация URL
        url = normalizeUrl(url);
        if (!isValidUrl(url)) {
            console.warn(`[SaiteParser] Invalid URL skipped: ${url}`);
            return null;
        }

        // Проверка наличия всех обязательных полей
        if (!title || !url || !desc) {
            return null;
        }

        return { title, url, desc, category };
    }

    /**
     * Парсинг всего контента с сайтами
     * @param {string} content - Контент файла
     * @returns {Array} - Массив объектов сайтов
     */
    parse(content) {
        if (typeof content !== 'string') {
            return [];
        }

        const blocks = content
            .split(BLOCK_SEPARATOR)
            .filter(block => block?.trim());

        const sites = [];
        
        for (const block of blocks) {
            const site = this.parseSiteBlock(block);
            if (site) {
                sites.push(site);
            }
        }

        return sites;
    }
}

// Инициализация сервиса
const saiteParserService = new SaiteParserService();

// -----------------------------
// Changelog Parser Service
// -----------------------------

/**
 * Сервис для парсинга changelog
 */
class ChangelogParserService {
    /**
     * Парсинг заголовка версии
     * @param {string} headerLine - Строка заголовка
     * @returns {Object} - Объект { version, date }
     */
    parseVersionHeader(headerLine) {
        if (headerLine.includes(CHANGELOG_VERSION_SEPARATOR)) {
            const parts = headerLine
                .split(CHANGELOG_VERSION_SEPARATOR)
                .map(part => part.trim());
            
            return {
                version: parts[0] || '',
                date: parts[1] || ''
            };
        }

        return {
            version: headerLine.trim(),
            date: ''
        };
    }

    /**
     * Парсинг одного изменения
     * @param {string} line - Строка с изменением
     * @returns {Object|null} - Объект изменения или null
     */
    parseChangeLine(line) {
        const match = line.match(CHANGELOG_CHANGE_REGEX);
        
        if (match) {
            return {
                type: match[1].toLowerCase(),
                text: match[2].trim()
            };
        }

        // Изменение без типа
        const text = line.replace(/^-\s*/, '').trim();
        if (!text) {
            return null;
        }

        return {
            type: 'default',
            text: text
        };
    }

    /**
     * Парсинг одного блока changelog
     * @param {string} block - Блок текста с версией
     * @returns {Object|null} - Объект версии или null
     */
    parseChangelogBlock(block) {
        const lines = block
            .trim()
            .split('\n')
            .map(line => line.trim())
            .filter(line => line);

        if (lines.length === 0) {
            return null;
        }

        // Парсинг заголовка
        const { version, date } = this.parseVersionHeader(lines[0]);

        // Парсинг изменений
        const changes = lines
            .slice(1)
            .map(line => this.parseChangeLine(line))
            .filter(change => change && change.text);

        return {
            version: version?.trim() || '',
            date: date?.trim() || '',
            changes: changes
        };
    }

    /**
     * Парсинг всего контента changelog
     * @param {string} content - Контент файла
     * @returns {Array} - Массив объектов версий
     */
    parse(content) {
        if (!content || typeof content !== 'string') {
            return [];
        }

        const blocks = content
            .split(BLOCK_SEPARATOR)
            .filter(block => block?.trim());

        return blocks
            .map(block => this.parseChangelogBlock(block))
            .filter(Boolean);
    }
}

// Инициализация сервиса
const changelogParserService = new ChangelogParserService();

// -----------------------------
// Legacy Functions (Backward Compatibility)
// -----------------------------

/**
 * Парсинг данных сайтов (обратная совместимость)
 * @param {string} content - Контент файла
 * @returns {Array} - Массив объектов сайтов
 */
function parseSaites(content) {
    return saiteParserService.parse(content);
}

/**
 * Парсинг changelog (обратная совместимость)
 * @param {string} content - Контент файла
 * @returns {Array} - Массив объектов версий
 */
function parseChangelog(content) {
    return changelogParserService.parse(content);
}

// -----------------------------
// GitHub Integration
// -----------------------------

// -----------------------------
// Constants
// -----------------------------

const GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_USER_AGENT = 'Oris-Server/1.0';
const GITHUB_ACCEPT_HEADER = 'application/vnd.github.v3+json';

const GITHUB_ERROR_MESSAGES = {
    FETCH_FAILED: 'GitHub fetch failed',
    UPDATE_FAILED: 'GitHub update failed',
    FILE_NOT_FOUND: 'File not found'
};

// -----------------------------
// GitHub Service
// -----------------------------

/**
 * Сервис для работы с GitHub API
 */
class GitHubService {
    /**
     * Проверка, настроен ли GitHub
     * @returns {boolean} - true если GitHub настроен
     */
    isConfigured() {
        return !!(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);
    }

    /**
     * Формирование URL для GitHub API
     * @param {string} gitPath - Путь к файлу в репозитории
     * @param {boolean} includeRef - Включить ли параметр ref
     * @returns {string} - Полный URL
     */
    buildApiUrl(gitPath, includeRef = true) {
        let url = `${GITHUB_API_BASE_URL}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${gitPath}`;
        if (includeRef && GITHUB_BRANCH) {
            url += `?ref=${GITHUB_BRANCH}`;
        }
        return url;
    }

    /**
     * Формирование заголовков для GitHub API
     * @param {boolean} includeContentType - Включить ли Content-Type
     * @returns {Object} - Заголовки запроса
     */
    buildHeaders(includeContentType = false) {
        const headers = {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept: GITHUB_ACCEPT_HEADER,
            'User-Agent': GITHUB_USER_AGENT
        };
        
        if (includeContentType) {
            headers['Content-Type'] = 'application/json';
        }
        
        return headers;
    }

    /**
     * Получение контента файла из GitHub
     * @param {string} gitPath - Путь к файлу в репозитории
     * @returns {Promise<Object>} - Объект { content, sha }
     * @throws {Error} - Если запрос не удался
     */
    async fetchFile(gitPath) {
        const url = this.buildApiUrl(gitPath);
        
        const response = await fetchWithRetry(url, {
            headers: this.buildHeaders()
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            const errorMessage = `${GITHUB_ERROR_MESSAGES.FETCH_FAILED}: ${response.status} ${response.statusText} - ${errorText.slice(0, 200)}`;
            throw new Error(errorMessage);
        }

        const data = await response.json();
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        
        return { 
            content, 
            sha: data.sha 
        };
    }

    /**
     * Обновление файла в GitHub
     * @param {string} newContent - Новый контент файла
     * @param {string} sha - SHA текущего файла
     * @param {string} gitPath - Путь к файлу в репозитории
     * @param {string} commitMessage - Сообщение коммита
     * @returns {Promise<Object>} - Ответ от GitHub API
     * @throws {Error} - Если обновление не удалось
     */
    async updateFile(newContent, sha, gitPath, commitMessage) {
        const url = this.buildApiUrl(gitPath, false);
        
        const body = {
            message: commitMessage,
            content: Buffer.from(newContent, 'utf8').toString('base64'),
            branch: GITHUB_BRANCH,
            sha
        };

        const response = await fetchWithRetry(url, {
            method: 'PUT',
            headers: this.buildHeaders(true),
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = `${GITHUB_ERROR_MESSAGES.UPDATE_FAILED}: ${response.status} - ${errorData.message || 'Unknown error'}`;
            throw new Error(errorMessage);
        }

        return await response.json();
    }
}

// Инициализация сервиса
const gitHubService = new GitHubService();

// -----------------------------
// File Service
// -----------------------------

/**
 * Сервис для работы с файлами (локально и через GitHub)
 */
class FileService {
    /**
     * Получение контента файла
     * @param {string} localPath - Локальный путь к файлу
     * @param {string} gitPath - Путь к файлу в GitHub
     * @returns {Promise<Object>} - Объект { content, sha }
     */
    async getContent(localPath, gitPath) {
        // Локальный режим
        if (!gitHubService.isConfigured()) {
            return await this.getLocalFileContent(localPath);
        }

        // GitHub режим
        return await gitHubService.fetchFile(gitPath);
    }

    /**
     * Получение контента локального файла
     * @param {string} filePath - Путь к файлу
     * @returns {Promise<Object>} - Объект { content, sha: null }
     */
    async getLocalFileContent(filePath) {
        try {
            const content = await fs.readFile(filePath, 'utf8');
            return { content, sha: null };
        } catch (err) {
            if (err.code === 'ENOENT') {
                return { content: '', sha: null };
            }
            throw err;
        }
    }

    /**
     * Обновление файла
     * @param {string} newContent - Новый контент
     * @param {string} sha - SHA файла (для GitHub)
     * @param {string} localPath - Локальный путь
     * @param {string} gitPath - Путь в GitHub
     * @param {string} commitMessage - Сообщение коммита
     * @returns {Promise<Object>} - Результат обновления
     */
    async updateContent(newContent, sha, localPath, gitPath, commitMessage) {
        // Локальный режим
        if (!gitHubService.isConfigured()) {
            await fs.writeFile(localPath, newContent, 'utf8');
            return { success: true, method: 'Local' };
        }

        // GitHub режим
        const result = await gitHubService.updateFile(newContent, sha, gitPath, commitMessage);
        return { ...result, method: 'GitHub' };
    }
}

// Инициализация сервиса
const fileService = new FileService();

// -----------------------------
// Sites Cache Service
// -----------------------------

/**
 * Сервис для управления кэшем сайтов
 */
class SitesCacheService {
    /**
     * Проверка актуальности кэша
     * @returns {boolean} - true если кэш актуален
     */
    isCacheValid() {
        const now = Date.now();
        return sitesCache.data.length > 0 && 
               (now - sitesCache.timestamp) < CACHE_TTL;
    }

    /**
     * Обновление кэша
     * @param {Array} data - Новые данные
     */
    updateCache(data) {
        sitesCache = { 
            data, 
            timestamp: Date.now() 
        };
    }

    /**
     * Инвалидация кэша
     */
    invalidateCache() {
        sitesCache.data = [];
        sitesCache.timestamp = 0;
    }

    /**
     * Получение данных из кэша (возможно устаревших)
     * @returns {Array} - Данные из кэша
     */
    getStaleCache() {
        return sitesCache.data;
    }
}

// Инициализация сервиса
const sitesCacheService = new SitesCacheService();

// -----------------------------
// Legacy Functions (Backward Compatibility)
// -----------------------------

/**
 * Получение контента файла (обратная совместимость)
 * @param {string} filePath - Локальный путь к файлу
 * @param {string} gitPath - Путь к файлу в GitHub
 * @returns {Promise<Object>} - Объект { content, sha }
 */
async function fetchFileContent(filePath, gitPath) {
    return await fileService.getContent(filePath, gitPath);
}

/**
 * Обновление файла через GitHub (обратная совместимость)
 * @param {string} newContent - Новый контент
 * @param {string} sha - SHA файла
 * @param {string} gitPath - Путь в GitHub
 * @param {string} commitMsg - Сообщение коммита
 * @returns {Promise<Object>} - Ответ от GitHub API
 */
async function updateFileViaGitHub(newContent, sha, gitPath, commitMsg) {
    return await gitHubService.updateFile(newContent, sha, gitPath, commitMsg);
}

/**
 * Загрузка списка сайтов с кэшированием
 * @returns {Promise<Array>} - Массив сайтов
 */
async function loadSites() {
    // Проверка кэша
    if (sitesCacheService.isCacheValid()) {
        return sitesCacheService.getStaleCache();
    }

    try {
        const { content } = await fetchFileContent(SAITES_FILE, GITHUB_SAITES_PATH);
        const data = parseSaites(content);
        
        sitesCacheService.updateCache(data);
        console.log(`[Cache] Sites updated: ${data.length} loaded`);
        
        return data;
    } catch (err) {
        console.error('[loadSites] Failed to load sites:', err.message);
        
        // Возвращаем старый кэш при ошибке, если он есть
        const staleCache = sitesCacheService.getStaleCache();
        if (staleCache.length > 0) {
            console.log('[loadSites] Using stale cache due to error');
            return staleCache;
        }
        
        throw err;
    }
}

// -----------------------------
// Admin Token Middleware
// -----------------------------

// -----------------------------
// Constants
// -----------------------------

const AUTH_ERROR_MESSAGES = {
    MISSING_HEADER: 'Unauthorized: Missing token',
    INVALID_FORMAT: 'Unauthorized: Invalid token format',
    INVALID_TOKEN: 'Forbidden: Invalid token'
};

const BEARER_PREFIX = 'Bearer ';

// -----------------------------
// Admin Auth Service
// -----------------------------

/**
 * Сервис для проверки админских токенов
 */
class AdminAuthService {
    /**
     * Извлечение токена из заголовка Authorization
     * @param {string} authHeader - Значение заголовка Authorization
     * @returns {string|null} - Извлеченный токен или null
     */
    extractToken(authHeader) {
        if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
            return null;
        }
        return authHeader.split(' ')[1];
    }

    /**
     * Проверка валидности токена с использованием timing-safe сравнения
     * @param {string} token - Токен для проверки
     * @returns {boolean} - true если токен валиден
     */
    isValidToken(token) {
        // Проверка наличия админского токена в конфигурации
        if (!ADMIN_TOKEN || !token) {
            return false;
        }

        // Проверка длины для предотвращения timing attacks
        if (token.length !== ADMIN_TOKEN.length) {
            return false;
        }

        // Безопасное сравнение с защитой от timing attacks
        try {
            return crypto.timingSafeEqual(
                Buffer.from(token), 
                Buffer.from(ADMIN_TOKEN)
            );
        } catch (err) {
            console.error('[AdminAuth] Token comparison error:', err);
            return false;
        }
    }

    /**
     * Middleware для проверки админского токена
     * @param {Request} req - Express request объект
     * @param {Response} res - Express response объект
     * @param {Function} next - Express next функция
     */
    verify(req, res, next) {
        const authHeader = req.headers.authorization;

        // Проверка наличия заголовка и формата Bearer
        const token = this.extractToken(authHeader);
        if (!token) {
            return res.status(401).json({ 
                error: AUTH_ERROR_MESSAGES.MISSING_HEADER 
            });
        }

        // Проверка валидности токена
        if (!this.isValidToken(token)) {
            return res.status(403).json({ 
                error: AUTH_ERROR_MESSAGES.INVALID_TOKEN 
            });
        }

        // Токен валиден — продолжаем обработку
        next();
    }
}

// Инициализация сервиса
const adminAuthService = new AdminAuthService();

// -----------------------------
// Middleware Export
// -----------------------------

/**
 * Middleware для проверки админского токена
 * Используется в Express маршрутах: app.get('/admin', verifyAdminToken, ...)
 */
const verifyAdminToken = (req, res, next) => {
    adminAuthService.verify(req, res, next);
};

// -----------------------------
// Telegram Integration
// -----------------------------

// -----------------------------
// Telegram Service
// -----------------------------

/**
 * Сервис для работы с Telegram Bot API
 */
class TelegramService {
    /**
     * Валидация конфигурации Telegram
     * @throws {Error} - Если конфигурация не настроена
     */
    validateConfig() {
        if (!TELEGRAM_CHAT_ID) {
            console.error('[Telegram] TELEGRAM_CHAT_ID is not set');
            throw new Error('Telegram не настроен');
        }
        if (!TELEGRAM_BOT_TOKEN) {
            console.error('[Telegram] TELEGRAM_BOT_TOKEN is not set');
            throw new Error('Telegram токен не настроен');
        }
    }

    /**
     * Отправка сообщения в Telegram
     * @param {string} text - Текст сообщения (HTML)
     * @returns {Promise<Object>} - Ответ от Telegram API
     * @throws {Error} - Если отправка не удалась
     */
    async sendMessage(text) {
        this.validateConfig();

        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        
        const response = await fetchWithRetry(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: text,
                parse_mode: 'HTML',
                disable_web_page_preview: true
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('[Telegram] Send failed:', errorData);
            throw new Error('Не удалось отправить сообщение');
        }

        return await response.json();
    }
}

// Инициализация сервиса
const telegramService = new TelegramService();

// -----------------------------
// Form Labels Constants
// -----------------------------

/**
 * Метки категорий для формы добавления сайта
 */
const CATEGORY_LABELS = {
    other: 'Другое',
    tools: 'Инструменты',
    dev: 'Для разработчиков',
    design: 'Дизайн',
    education: 'Образование',
    games: 'Игры',
    media: 'Медиа',
    social: 'Соцсети'
};

/**
 * Метки типов сотрудничества
 */
const CORP_TYPE_LABELS = {
    partnership: 'Партнёрство',
    advertising: 'Реклама / Спонсорство',
    integration: 'Техническая интеграция',
    content: 'Контент / Публикации',
    other: 'Другое'
};

/**
 * Метки бюджетов
 */
const BUDGET_LABELS = {
    free: 'Без бюджета',
    small: 'До 50 000 ₽',
    medium: '50 000 — 300 000 ₽',
    large: '300 000 — 1 000 000 ₽',
    enterprise: 'Более 1 000 000 ₽'
};

// -----------------------------
// Sites Service
// -----------------------------

/**
 * Сервис для работы с каталогом сайтов
 */
class SitesService {
    /**
     * Получение списка сайтов
     * @returns {Promise<Array>} - Массив сайтов
     */
    async getSites() {
        return await loadSites();
    }

    /**
     * Принудительная перезагрузка списка сайтов
     * @returns {Promise<Array>} - Обновленный массив сайтов
     */
    async reloadSites() {
        // Инвалидация кэша
        sitesCache.data = [];
        sitesCache.timestamp = 0;
        
        return await loadSites();
    }
}

// Инициализация сервиса
const sitesService = new SitesService();

// -----------------------------
// Route Handlers: Sites
// -----------------------------

/**
 * GET /api/sites — получение списка всех сайтов
 */
app.get('/api/sites', async (req, res, next) => {
    try {
        const sites = await sitesService.getSites();
        res.json(sites);
    } catch (err) {
        handleSitesApiError('GET /api/sites', err, next);
    }
});

/**
 * POST /api/sites/reload — принудительная перезагрузка кэша сайтов
 */
app.post('/api/sites/reload', async (req, res, next) => {
    try {
        const sites = await sitesService.reloadSites();
        res.json({ 
            success: true, 
            count: sites.length 
        });
    } catch (err) {
        handleSitesApiError('POST /api/sites/reload', err, next);
    }
});

// -----------------------------
// Helper Functions
// -----------------------------

/**
 * Обработчик ошибок API для Sites routes
 * @param {string} endpoint - Название endpoint
 * @param {Error} err - Объект ошибки
 * @param {Function} next - Express next функция
 */
const handleSitesApiError = (endpoint, err, next) => {
    console.error(`[${endpoint}]`, err);
    next(err);
};

// -----------------------------
// API Routes: Changelog
// -----------------------------

// -----------------------------
// Changelog Service
// -----------------------------

/**
 * Сервис для работы с changelog
 */
class ChangelogService {
    /**
     * Получение changelog с учетом кэширования
     * @returns {Promise<Object>} - Распарсенные данные changelog
     */
    async getChangelog() {
        const now = Date.now();
        
        // Проверка кэша
        if (changelogCache.data && (now - changelogCache.timestamp) < CACHE_TTL) {
            return changelogCache.data;
        }

        // Получение свежего контента
        const { content } = await fetchFileContent(CHANGELOG_FILE, GITHUB_CHANGELOG_PATH);
        const data = parseChangelog(content);
        
        // Обновление кэша
        changelogCache = { data, timestamp: now };
        
        return data;
    }

    /**
     * Получение сырого контента changelog
     * @returns {Promise<string>} - Сырой контент файла
     */
    async getRawContent() {
        const { content } = await fetchFileContent(CHANGELOG_FILE, GITHUB_CHANGELOG_PATH);
        return content;
    }
}

// Инициализация сервиса
const changelogService = new ChangelogService();

// -----------------------------
// Content Service
// -----------------------------

/**
 * Сервис для работы с контентом (получение и сохранение)
 */
class ContentService {
    /**
     * Получение контента файла
     * @param {string} localPath - Локальный путь к файлу
     * @param {string} gitPath - Путь в GitHub
     * @returns {Promise<string>} - Контент файла
     */
    async getContent(localPath, gitPath) {
        const { content } = await fetchFileContent(localPath, gitPath);
        return content;
    }

    /**
     * Валидация контента перед сохранением
     * @param {any} content - Контент для проверки
     * @returns {Object} - Результат валидации { valid: boolean, error?: string }
     */
    validateContent(content) {
        if (typeof content !== 'string') {
            return { valid: false, error: 'Content must be a string' };
        }
        
        if (content.length > MAX_CONTENT_LENGTH) {
            return { valid: false, error: 'Content too large' };
        }
        
        return { valid: true };
    }

    /**
     * Сохранение контента (GitHub или локально)
     * @param {string} content - Контент для сохранения
     * @param {string} localPath - Локальный путь к файлу
     * @param {string} gitPath - Путь в GitHub
     * @param {string} commitMessage - Сообщение коммита
     * @returns {Promise<Object>} - Результат сохранения { method: string }
     */
    async saveContent(content, localPath, gitPath, commitMessage) {
        // Локальное сохранение если нет GitHub токена
        if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
            await fs.writeFile(localPath, content, 'utf8');
            return { method: 'Local' };
        }

        // Сохранение через GitHub API
        const { sha } = await fetchFileContent(localPath, gitPath);
        await updateFileViaGitHub(content, sha, gitPath, commitMessage);
        return { method: 'GitHub' };
    }

    /**
     * Инвалидация кэша
     * @param {string} cacheType - Тип кэша для инвалидации ('sites' или 'changelog')
     */
    invalidateCache(cacheType) {
        if (cacheType === 'sites') {
            sitesCache.data = [];
            sitesCache.timestamp = 0;
        } else if (cacheType === 'changelog') {
            changelogCache.data = null;
            changelogCache.timestamp = 0;
        }
    }
}

// Инициализация сервиса
const contentService = new ContentService();

// -----------------------------
// Route Handlers: Changelog
// -----------------------------

/**
 * GET /api/changelog — публичный эндпоинт для получения changelog
 */
app.get('/api/changelog', async (req, res, next) => {
    try {
        const data = await changelogService.getChangelog();
        res.json(data);
    } catch (err) {
        handleChangelogApiError('GET /api/changelog', err, next);
    }
});

// -----------------------------
// Route Handlers: Admin Content
// -----------------------------

/**
 * GET /api/admin/content — получение контента saites.txt
 */
app.get('/api/admin/content', verifyAdminToken, async (req, res, next) => {
    try {
        const content = await contentService.getContent(SAITES_FILE, GITHUB_SAITES_PATH);
        res.json({ content });
    } catch (err) {
        handleChangelogApiError('GET /api/admin/content', err, next);
    }
});

/**
 * GET /api/admin/changelog — получение контента changelog
 */
app.get('/api/admin/changelog', verifyAdminToken, async (req, res, next) => {
    try {
        const content = await changelogService.getRawContent();
        res.json({ content });
    } catch (err) {
        handleChangelogApiError('GET /api/admin/changelog', err, next);
    }
});

// -----------------------------
// Route Handlers: Admin Save
// -----------------------------

/**
 * POST /api/admin/save — сохранение контента saites.txt
 */
app.post('/api/admin/save', verifyAdminToken, async (req, res, next) => {
    await handleContentSave(
        req, 
        res, 
        next, 
        SAITES_FILE, 
        GITHUB_SAITES_PATH, 
        'sites', 
        'chore: update saites.txt via admin'
    );
});

/**
 * POST /api/admin/changelog/save — сохранение контента changelog
 */
app.post('/api/admin/changelog/save', verifyAdminToken, async (req, res, next) => {
    await handleContentSave(
        req, 
        res, 
        next, 
        CHANGELOG_FILE, 
        GITHUB_CHANGELOG_PATH, 
        'changelog', 
        'docs: update changelog via admin'
    );
});

// -----------------------------
// Helper Functions
// -----------------------------

/**
 * Обработка сохранения контента
 * @param {Request} req - Express request объект
 * @param {Response} res - Express response объект
 * @param {Function} next - Express next функция
 * @param {string} filePath - Локальный путь к файлу
 * @param {string} gitPath - Путь в GitHub
 * @param {string} cacheType - Тип кэша для инвалидации
 * @param {string} commitMessage - Сообщение коммита
 */
const handleContentSave = async (req, res, next, filePath, gitPath, cacheType, commitMessage) => {
    try {
        const { content } = req.body;
        
        // Валидация контента
        const validation = contentService.validateContent(content);
        if (!validation.valid) {
            const statusCode = validation.error === 'Content too large' ? 413 : 400;
            return res.status(statusCode).json({ error: validation.error });
        }

        // Сохранение контента
        const result = await contentService.saveContent(content, filePath, gitPath, commitMessage);

        // Инвалидация кэша
        contentService.invalidateCache(cacheType);
        
        // Успешный ответ
        res.json({ 
            success: true, 
            message: `Saved (${result.method})` 
        });
    } catch (err) {
        handleChangelogApiError('handleContentSave', err, next);
    }
};

/**
 * Обработчик ошибок API для Changelog routes
 * @param {string} endpoint - Название endpoint
 * @param {Error} err - Объект ошибки
 * @param {Function} next - Express next функция
 */
const handleChangelogApiError = (endpoint, err, next) => {
    console.error(`[${endpoint}]`, err);
    next(err);
};

// -----------------------------
// API Routes: Dynamic Configs for Status & API (KV)
// -----------------------------
const STATUS_CONFIG_KEY = 'admin:status_config';
const API_CONFIG_KEY = 'admin:api_config';


const DEFAULT_STATUS_CONFIG = [
  {
    "id": "website",
    "name": "Website Frontend",
    "category": "Core",
    "icon": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9\"/>",
    "color": "#0071E3",
    "check": { "method": "GET", "path": "/", "expectedStatuses": [200,304], "timeout": 3000 }
  },
  {
    "id": "sites-api",
    "name": "Sites API",
    "category": "Content · proxy.js",
    "icon": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z\"/>",
    "color": "#34C759",
    "check": { "method": "GET", "path": "/api/sites", "expectedStatuses": [200], "timeout": 5000 }
  },
  {
    "id": "changelog-api",
    "name": "Changelog API",
    "category": "Content · proxy.js",
    "icon": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z\"/>",
    "color": "#AF52DE",
    "check": { "method": "GET", "path": "/api/changelog", "expectedStatuses": [200], "timeout": 5000 }
  },
  {
    "id": "form-saite",
    "name": "Add Site Form",
    "category": "Forms · proxy.js",
    "icon": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z\"/>",
    "color": "#FF9F0A",
    "check": { "method": "POST", "path": "/api/add/saite", "expectedStatuses": [400,429], "timeout": 3000, "body": "{}" }
  },
  {
    "id": "form-corp",
    "name": "Cooperation Form",
    "category": "Forms · proxy.js",
    "icon": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z\"/>",
    "color": "#FF9F0A",
    "check": { "method": "POST", "path": "/api/add/corp", "expectedStatuses": [400,429], "timeout": 3000, "body": "{}" }
  },
  {
    "id": "admin-api",
    "name": "Admin Panel",
    "category": "Protected · proxy.js",
    "icon": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z\"/>",
    "color": "#FF3B30",
    "check": { "method": "GET", "path": "/api/admin/content", "expectedStatuses": [401,403], "timeout": 3000 }
  },
  {
    "id": "news-posts",
    "name": "News Posts API",
    "category": "News · news.js",
    "icon": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z\"/>",
    "color": "#0071E3",
    "check": { "method": "GET", "path": "/api/news/posts", "expectedStatuses": [200], "timeout": 5000 }
  },
  {
    "id": "news-auth",
    "name": "News Auth",
    "category": "Auth · news.js",
    "icon": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z\"/>",
    "color": "#34C759",
    "check": { "method": "GET", "path": "/api/news/auth/me", "expectedStatuses": [401], "timeout": 3000 }
  },
  {
    "id": "news-register",
    "name": "Registration",
    "category": "Auth · news.js",
    "icon": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z\"/>",
    "color": "#AF52DE",
    "check": { "method": "POST", "path": "/api/news/auth/register", "expectedStatuses": [400,500], "timeout": 3000, "body": "{}" }
  },
  {
    "id": "news-login",
    "name": "Reader Login",
    "category": "Auth · news.js",
    "icon": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1\"/>",
    "color": "#AF52DE",
    "check": { "method": "POST", "path": "/api/news/auth/login", "expectedStatuses": [400,404], "timeout": 3000, "body": "{}" }
  },
  {
    "id": "news-upload",
    "name": "File Upload",
    "category": "Storage · news.js",
    "icon": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12\"/>",
    "color": "#FF3B30",
    "check": { "method": "POST", "path": "/api/news/upload", "expectedStatuses": [400,401], "timeout": 3000 }
  },
  {
    "id": "vercel-kv",
    "name": "Vercel KV (Redis)",
    "category": "Database · External",
    "icon": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4\"/>",
    "color": "#FF3B30",
    "check": { "type": "custom", "name": "checkKV" }
  },
  {
    "id": "telegram",
    "name": "Telegram Bot API",
    "category": "External",
    "icon": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M12 19l9 2-9-18-9 18 9-2zm0 0v-8\"/>",
    "color": "#0088CC",
    "check": { "type": "external", "url": "https://api.telegram.org", "timeout": 5000 }
  },
  {
    "id": "github",
    "name": "GitHub API",
    "category": "External",
    "icon": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4\"/>",
    "color": "#1D1D1F",
    "check": { "type": "external", "url": "https://api.github.com", "timeout": 5000 }
  }
];

const DEFAULT_API_CONFIG = [
    {
        id: 'sites',
        title: 'Проекты (Sites)',
        source: 'proxy.js',
        icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>',
        iconColor: '#0071E3',
        description: 'Управление каталогом проектов. Данные читаются из saites.txt (локально или через GitHub API) и кэшируются на 5 минут.',
        endpoints: [
            {
                method: 'GET',
                path: '/api/sites',
                desc: 'Получить список всех проектов',
                auth: null,
                details: 'Возвращает массив проектов, распарсенных из saites.txt. Использует in-memory кэш с TTL 5 минут. При сбое источника возвращает устаревший кэш (stale-while-revalidate).',
                response: `[
  {
    "title": "Example Project",
    "url": "https://example.com",
    "desc": "Описание проекта"
  }
]`
            },
            {
                method: 'POST',
                path: '/api/sites/reload',
                desc: 'Принудительно перезагрузить кэш',
                auth: null,
                details: 'Инвалидирует кэш и заново загружает данные из источника (файл или GitHub).',
                response: `{ "success": true, "count": 42 }`
            }
        ]
    },
    {
        id: 'changelog',
        title: 'История изменений',
        source: 'proxy.js',
        icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>',
        iconColor: '#34C759',
        description: 'Получение истории версий и изменений платформы из changelog.txt.',
        endpoints: [
            {
                method: 'GET',
                path: '/api/changelog',
                desc: 'Получить историю версий',
                auth: null,
                details: 'Парсит changelog.txt в структурированный формат с группировкой по версиям. Кэшируется на 5 минут.',
                response: `[
  {
    "version": "v2.4.1",
    "date": "3 Июня 2026",
    "changes": [
      { "type": "fix", "text": "Исправлен баг с лайками" },
      { "type": "feat", "text": "Добавлена новая функция" }
    ]
  }
]`
            }
        ]
    },
    {
        id: 'forms',
        title: 'Формы обратной связи',
        source: 'proxy.js',
        icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>',
        iconColor: '#AF52DE',
        description: 'Эндпоинты для отправки заявок с форм сайта. Сообщения доставляются в Telegram администратору. Имеют rate limit 30 секунд между заявками с одного IP.',
        endpoints: [
            {
                method: 'POST',
                path: '/api/add/saite',
                desc: 'Заявка на добавление сайта',
                auth: null,
                details: 'Отправляет заявку на добавление проекта в каталог. Минимальная длина описания — 20 символов.',
                params: [
                    { name: 'title', type: 'string', required: true, desc: 'Название проекта (мин. 3 символа)' },
                    { name: 'url', type: 'string', required: true, desc: 'URL сайта (http/https)' },
                    { name: 'description', type: 'string', required: true, desc: 'Описание (мин. 20 символов)' },
                    { name: 'category', type: 'string', required: false, desc: 'Категория: tools|dev|design|education|games|media|social|other' },
                    { name: 'authorName', type: 'string', required: true, desc: 'Имя отправителя' },
                    { name: 'email', type: 'string', required: true, desc: 'Email для связи' },
                    { name: 'telegram', type: 'string', required: false, desc: 'Telegram username' }
                ],
                response: `{ "success": true, "message": "Заявка отправлена" }`
            },
            {
                method: 'POST',
                path: '/api/add/corp',
                desc: 'Заявка на сотрудничество',
                auth: null,
                details: 'Отправляет коммерческое предложение. Поддерживает выбор типа сотрудничества и бюджета.',
                params: [
                    { name: 'name', type: 'string', required: true, desc: 'Имя контактного лица' },
                    { name: 'company', type: 'string', required: false, desc: 'Название компании' },
                    { name: 'email', type: 'string', required: true, desc: 'Email' },
                    { name: 'telegram', type: 'string', required: false, desc: 'Telegram' },
                    { name: 'type', type: 'string', required: true, desc: 'Тип: partnership|advertising|integration|content|other' },
                    { name: 'message', type: 'string', required: true, desc: 'Сообщение (мин. 20 символов)' },
                    { name: 'budget', type: 'string', required: false, desc: 'Бюджет: free|small|medium|large|enterprise' },
                    { name: 'website', type: 'string', required: false, desc: 'URL сайта компании' }
                ],
                response: `{ "success": true, "message": "Заявка отправлена" }`
            }
        ]
    },
    {
        id: 'admin',
        title: 'Административная панель',
        source: 'proxy.js',
        icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>',
        iconColor: '#FF9F0A',
        description: 'Управление контентом saites.txt и changelog.txt через админ-панель. Все эндпоинты требуют Bearer-токен в заголовке Authorization.',
        endpoints: [
            {
                method: 'GET',
                path: '/api/admin/content',
                desc: 'Получить saites.txt',
                auth: 'admin',
                details: 'Возвращает сырое содержимое файла saites.txt для редактирования.',
                response: `{ "content": "Title\\nURL\\nDescription\\n::\\n..." }`
            },
            {
                method: 'GET',
                path: '/api/admin/changelog',
                desc: 'Получить changelog.txt',
                auth: 'admin',
                details: 'Возвращает сырое содержимое changelog.txt.',
                response: `{ "content": "v2.4.1 | 3 Июня 2026\\n- [fix] ...\\n::\\n..." }`
            },
            {
                method: 'POST',
                path: '/api/admin/save',
                desc: 'Сохранить saites.txt',
                auth: 'admin',
                details: 'Сохраняет изменения в saites.txt (через GitHub API или локально). Инвалидирует кэш сайтов.',
                params: [
                    { name: 'content', type: 'string', required: true, desc: 'Новое содержимое файла (макс. 500 KB)' }
                ],
                response: `{ "success": true, "message": "Saved (GitHub)" }`
            },
            {
                method: 'POST',
                path: '/api/admin/changelog/save',
                desc: 'Сохранить changelog.txt',
                auth: 'admin',
                details: 'Сохраняет изменения в changelog.txt. Инвалидирует кэш истории версий.',
                params: [
                    { name: 'content', type: 'string', required: true, desc: 'Новое содержимое файла (макс. 500 KB)' }
                ],
                response: `{ "success": true, "message": "Saved (GitHub)" }`
            }
        ]
    },
    {
        id: 'news-auth',
        title: 'Новости · Аутентификация',
        source: 'news.js',
        icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>',
        iconColor: '#0071E3',
        description: 'Система аутентификации: читатели и администраторы. Уровни читателей: newbie, active, expert, plus — зависят от количества комментариев и лайков и влияют на бейдж.',
        endpoints: [
            {
                method: 'POST',
                path: '/api/news/auth/register',
                desc: 'Регистрация пользователя',
                auth: null,
                details: 'Создаёт нового читателя или администратора. Для админа требуется ADMIN_TOKEN. Сессия действует 1 год (reader) или 30 дней (admin).',
                params: [
                    { name: 'nickname', type: 'string', required: false, desc: 'Имя (только для reader, 2-30 символов)' },
                    { name: 'role', type: 'string', required: true, desc: 'Роль: reader или admin' },
                    { name: 'adminToken', type: 'string', required: false, desc: 'Admin token (только для role=admin)' }
                ],
                response: `{
  "user": {
    "id": "1001",
    "role": "reader",
    "nickname": "Alex",
    "level": "newbie",
    "createdAt": "2026-06-03T12:00:00.000Z",
    "token": "abc123..."
  }
}`
            },
            {
                method: 'POST',
                path: '/api/news/auth/login',
                desc: 'Вход читателя по ID',
                auth: null,
                details: 'Аутентифицирует существующего читателя по 4-значному ID и выдаёт новую сессию. Уровень берётся из сохранённых данных.',
                params: [
                    { name: 'readerId', type: 'string', required: true, desc: 'ID читателя (4 цифры, например "1001")' }
                ],
                response: `{
  "user": {
    "id": "1001",
    "role": "reader",
    "nickname": "Alex",
    "level": "active",
    "token": "xyz789..."
  }
}`
            },
            {
                method: 'GET',
                path: '/api/news/auth/me',
                desc: 'Текущий пользователь',
                auth: 'user',
                details: 'Возвращает данные текущего аутентифицированного пользователя. Уровень вычисляется на основе статистики (комментарии и полученные лайки) и может измениться со временем.',
                response: `{
  "id": "1001",
  "role": "reader",
  "nickname": "Alex",
  "level": "expert",
  "createdAt": "2026-06-01T10:00:00.000Z"
}`
            }
        ]
    },
    {
        id: 'news-posts',
        title: 'Новости · Посты',
        source: 'news.js',
        icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z"/>',
        iconColor: '#34C759',
        description: 'CRUD-операции для новостных постов с поддержкой Markdown (GitHub Flavored). Посты могут содержать прикреплённые файлы.',
        endpoints: [
            {
                method: 'GET',
                path: '/api/news/posts',
                desc: 'Список постов',
                auth: 'optional',
                details: 'Возвращает посты с пагинацией. Поддерживает поиск (q) по заголовку, тексту и автору и сортировку (sort): newest — по дате (новые сверху, по умолчанию), popular — по сумме лайков и комментариев. Закреплённые посты всегда вверху. Для аутентифицированных пользователей добавляются флаги isLiked/isFavorited.',
                params: [
                    { name: 'q', type: 'string', required: false, desc: 'Поиск по заголовку, тексту и автору (регистронезависимо)' },
                    { name: 'sort', type: 'string', required: false, desc: 'Сортировка: newest (по умолчанию) или popular' },
                    { name: 'page', type: 'number', required: false, desc: 'Номер страницы (по умолчанию 1)' },
                    { name: 'limit', type: 'number', required: false, desc: 'Постов на странице (макс. 100, по умолчанию 20)' }
                ],
                response: `{
  "posts": [
    {
      "id": "uuid",
      "title": "Заголовок",
      "content": "**Markdown** content",
      "files": [],
      "authorId": "admin",
      "authorRole": "admin",
      "authorName": "Oris",
      "createdAt": "2026-06-03T...",
      "updatedAt": "2026-06-03T...",
      "isPinned": false,
      "likes": 5,
      "dislikes": 0,
      "commentsCount": 12,
      "isLiked": false,
      "isDisliked": false,
      "isFavorited": false
    }
  ],
  "total": 42,
  "page": 1,
  "limit": 20
}`
            },
            {
                method: 'POST',
                path: '/api/news/posts',
                desc: 'Создать пост',
                auth: 'admin',
                details: 'Создаёт новый пост. Контент поддерживает Markdown. Файлы должны быть предварительно загружены через /upload.',
                params: [
                    { name: 'title', type: 'string', required: true, desc: 'Заголовок (макс. 200 символов)' },
                    { name: 'content', type: 'string', required: true, desc: 'Содержимое в Markdown (макс. 100 KB)' },
                    { name: 'files', type: 'array', required: false, desc: 'Массив объектов {name, size, url}' }
                ],
                response: `{ "post": { "id": "uuid", "title": "...", ... } }`
            },
            {
                method: 'PUT',
                path: '/api/news/posts/:id',
                desc: 'Обновить пост',
                auth: 'admin',
                details: 'Обновляет заголовок и содержимое существующего поста. Обновляет поле updatedAt.',
                params: [
                    { name: 'title', type: 'string', required: true, desc: 'Новый заголовок' },
                    { name: 'content', type: 'string', required: true, desc: 'Новое содержимое' },
                    { name: 'files', type: 'array', required: false, desc: 'Обновлённый список файлов' }
                ],
                response: `{ "post": { "id": "...", "updatedAt": "..." } }`
            },
            {
                method: 'DELETE',
                path: '/api/news/posts/:id',
                desc: 'Удалить пост',
                auth: 'admin',
                details: 'Удаляет пост вместе со всеми комментариями, лайками и дизлайками.',
                response: `{ "success": true }`
            },
            {
                method: 'POST',
                path: '/api/news/posts/:id/like',
                desc: 'Лайк поста',
                auth: 'user',
                details: 'Переключает лайк. Если был дизлайк — он автоматически убирается. Возвращает обновлённые счётчики.',
                response: `{ "likes": 6, "dislikes": 0, "isLiked": true, "isDisliked": false }`
            },
            {
                method: 'POST',
                path: '/api/news/posts/:id/dislike',
                desc: 'Дизлайк поста',
                auth: 'user',
                details: 'Переключает дизлайк. Если был лайк — он автоматически убирается.',
                response: `{ "likes": 5, "dislikes": 1, "isLiked": false, "isDisliked": true }`
            },
            {
                method: 'POST',
                path: '/api/news/posts/:id/favorite',
                desc: 'Избранное',
                auth: 'user',
                details: 'Добавляет или убирает пост из избранного текущего пользователя.',
                response: `{ "isFavorited": true }`
            },
            {
                method: 'POST',
                path: '/api/news/posts/:id/pin',
                desc: 'Закрепить/открепить',
                auth: 'admin',
                details: 'Переключает статус закрепления. Закреплённые посты отображаются вверху ленты.',
                response: `{ "isPinned": true }`
            },
            {
                method: 'GET',
                path: '/api/news/rss',
                desc: 'RSS-лента новостей',
                auth: null,
                details: 'Возвращает последние посты в формате RSS 2.0 (application/rss+xml): заголовок, ссылку на пост, автора, дату публикации и краткое описание. Используется агрегаторами и автодискавери на странице /news.',
                response: `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"> ... </rss>`
            }
        ]
    },
    {
        id: 'news-comments',
        title: 'Новости · Комментарии',
        source: 'news.js',
        icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>',
        iconColor: '#AF52DE',
        description: 'Система древовидных комментариев с поддержкой ответов (до 3 уровней вложенности), лайков и модерации.',
        endpoints: [
            {
                method: 'GET',
                path: '/api/news/posts/:postId/comments',
                desc: 'Комментарии поста',
                auth: 'optional',
                details: 'Возвращает все комментарии поста. Клиент строит дерево на основе поля parentId.',
                response: `{
  "comments": [
    {
      "id": "uuid",
      "postId": "...",
      "parentId": null,
      "text": "Текст комментария",
      "authorId": "1001",
      "authorRole": "reader",
      "authorName": "Alex",
      "authorLevel": "expert",
      "createdAt": "2026-06-03T...",
      "isEdited": false,
      "isPinned": false,
      "likes": 3,
      "dislikes": 0,
      "isLiked": false,
      "isDisliked": false
    }
  ]
}`
            },
            {
                method: 'POST',
                path: '/api/news/posts/:postId/comments',
                desc: 'Создать комментарий',
                auth: 'user',
                details: 'Создаёт новый комментарий. При указании parentId создаёт ответ на другой комментарий. Начисляет статистику автору.',
                params: [
                    { name: 'text', type: 'string', required: true, desc: 'Текст (макс. 2000 символов)' },
                    { name: 'parentId', type: 'string', required: false, desc: 'ID родительского комментария' }
                ],
                response: `{ "comment": { "id": "...", "authorLevel": "active", ... } }`
            },
            {
                method: 'PUT',
                path: '/api/news/comments/:id',
                desc: 'Редактировать комментарий',
                auth: 'user',
                details: 'Редактирование доступно только автору комментария. Устанавливает флаг isEdited.',
                params: [
                    { name: 'text', type: 'string', required: true, desc: 'Новый текст (макс. 2000 символов)' }
                ],
                response: `{ "comment": { "id": "...", "isEdited": true, ... } }`
            },
            {
                method: 'DELETE',
                path: '/api/news/comments/:id',
                desc: 'Удалить комментарий',
                auth: 'user',
                details: 'Удалить может автор или администратор. Рекурсивно удаляет все ответы.',
                response: `{ "success": true, "deletedCount": 3 }`
            },
            {
                method: 'POST',
                path: '/api/news/comments/:id/like',
                desc: 'Лайк комментария',
                auth: 'user',
                details: 'Переключает лайк. Начисляет/списывает likesReceived автору комментария (влияет на уровень пользователя). Обратите внимание: дизлайк автоматически снимается при повторном лайке.',
                response: `{ "likes": 4, "dislikes": 0, "isLiked": true, "isDisliked": false }`
            },
            {
                method: 'POST',
                path: '/api/news/comments/:id/dislike',
                desc: 'Дизлайк комментария',
                auth: 'user',
                details: 'Переключает дизлайк. Не влияет на статистику автора.',
                response: `{ "likes": 3, "dislikes": 1, "isLiked": false, "isDisliked": true }`
            },
            {
                method: 'POST',
                path: '/api/news/comments/:id/pin',
                desc: 'Закрепить комментарий',
                auth: 'admin',
                details: 'Переключает статус закрепления. Закреплённые комментарии отображаются вверху списка.',
                response: `{ "isPinned": true }`
            }
        ]
    },


    {
        id: 'status-page',
        title: 'Статус систем',
        source: 'status.html',
        icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>',
        iconColor: '#FF9F0A',
        description: 'Страница реального мониторинга (<code>/status</code>) проверяет все API-эндпоинты платформы каждые 30 секунд, отображает задержки, коды ответов и автоматически регистрирует инциденты. Это клиентский инструмент для визуального контроля состояния.',
        endpoints: [
            {
                method: 'GET',
                path: '/status',
                desc: 'HTML-страница мониторинга',
                auth: null,
                details: 'Возвращает страницу с индикаторами доступности, графиком uptime, списком сервисов и активными инцидентами. Данные собираются через вызовы API из этой документации.',
                response: 'text/html — интерфейс наблюдения'
            }
        ]
    },

    {
        id: 'news-upload',
        title: 'Новости · Загрузка файлов',
        source: 'news.js',
        icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/>',
        iconColor: '#FF3B30',
        description: 'Загрузка файлов в Vercel Blob для прикрепления к постам.',
        endpoints: [
            {
                method: 'POST',
                path: '/api/news/upload',
                desc: 'Загрузить файл',
                auth: 'admin',
                details: 'Принимает multipart/form-data с одним файлом (поле "file"). Максимальный размер — 50 МБ. Разрешены: JPEG, PNG, GIF, WebP, PDF, MP4.',
                params: [
                    { name: 'file', type: 'file', required: true, desc: 'Загружаемый файл (multipart/form-data)' }
                ],
                response: `{
  "url": "https://...blob.vercel-storage.com/...",
  "name": "document.pdf",
  "size": 123456,
  "contentType": "application/pdf"
}`
            }
        ]
    },
    {
        "id": "notifications",
        "title": "Push-уведомления",
        "source": "notifications.js",
        "icon": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9\"/>",
        "iconColor": "#AF52DE",
        "description": "Система веб-push уведомлений на базе VAPID (Web Push API). Поддерживает публичные и приватные каналы, подписки браузеров, пакетную рассылку и доступ для внешних сервисов по ключу <code>svc_*</code> (заголовок <code>X-API-Key</code>).",
        "endpoints": [
            {
                "method": "GET",
                "path": "/api/notifications/vapid-public-key",
                "desc": "Публичный VAPID-ключ",
                "auth": null,
                "details": "Возвращает публичный VAPID-ключ, необходимый браузеру для оформления push-подписки (PushManager.subscribe).",
                "response": "{\n  \"publicKey\": \"BPx...base64url\"\n}"
            },
            {
                "method": "GET",
                "path": "/api/notifications/channels",
                "desc": "Список публичных каналов",
                "auth": null,
                "details": "Возвращает доступные для подписки публичные каналы (например, news, support). Приватные каналы в выдачу не попадают.",
                "response": "{\n  \"channels\": [\n    { \"id\": \"news\", \"name\": \"Новости\", \"public\": true }\n  ],\n  \"total\": 1\n}"
            },
            {
                "method": "POST",
                "path": "/api/notifications/subscribe",
                "desc": "Подписка на каналы",
                "auth": null,
                "details": "Сохраняет push-подписку браузера и привязывает её к одному или нескольким публичным каналам. Повторный вызов с тем же endpoint обновляет список каналов. По умолчанию подписывает на канал news.",
                "params": [
                    {
                        "name": "subscription",
                        "type": "object",
                        "required": true,
                        "desc": "Объект PushSubscription { endpoint, keys: { p256dh, auth } }"
                    },
                    {
                        "name": "channels",
                        "type": "string[]",
                        "required": false,
                        "desc": "ID каналов для подписки (по умолчанию ['news'])"
                    },
                    {
                        "name": "userId",
                        "type": "string",
                        "required": false,
                        "desc": "Необязательная привязка к пользователю"
                    }
                ],
                "response": "{\n  \"success\": true,\n  \"message\": \"Subscription saved\",\n  \"channels\": [\"news\"]\n}"
            },
            {
                "method": "POST",
                "path": "/api/notifications/unsubscribe",
                "desc": "Отписка",
                "auth": null,
                "details": "Отписывает браузер от указанных каналов. Если каналы не переданы, подписка удаляется полностью.",
                "params": [
                    {
                        "name": "endpoint",
                        "type": "string",
                        "required": true,
                        "desc": "Endpoint push-подписки"
                    },
                    {
                        "name": "channels",
                        "type": "string[]",
                        "required": false,
                        "desc": "Каналы для отписки (пусто = удалить подписку целиком)"
                    }
                ],
                "response": "{\n  \"success\": true,\n  \"message\": \"Unsubscribed\"\n}"
            },
            {
                "method": "POST",
                "path": "/api/notifications/subscribe-private",
                "desc": "Подписка на приватный канал",
                "auth": "user",
                "details": "Подписка на приватный канал. Требует пользовательский токен (userToken) для авторизации доступа к каналу.",
                "params": [
                    {
                        "name": "subscription",
                        "type": "object",
                        "required": true,
                        "desc": "Объект PushSubscription"
                    },
                    {
                        "name": "channelId",
                        "type": "string",
                        "required": true,
                        "desc": "ID приватного канала"
                    },
                    {
                        "name": "userToken",
                        "type": "string",
                        "required": true,
                        "desc": "Токен пользователя для доступа к каналу"
                    }
                ],
                "response": "{\n  \"success\": true,\n  \"message\": \"Subscribed to private channel \\\"...\\\"\"\n}"
            },
            {
                "method": "GET",
                "path": "/api/notifications/stats",
                "desc": "Публичная статистика",
                "auth": null,
                "details": "Возвращает агрегированную статистику: общее число подписок, число отправленных уведомлений и разбивку подписчиков по каналам.",
                "response": "{\n  \"totalSubscriptions\": 42,\n  \"totalSent\": 1337,\n  \"channels\": {\n    \"news\": { \"name\": \"Новости\", \"subscribers\": 42, \"public\": true }\n  },\n  \"timestamp\": \"2026-06-18T16:00:00.000Z\"\n}"
            },
            {
                "method": "POST",
                "path": "/api/notifications/api/send",
                "desc": "Отправка в канал (сервис)",
                "auth": "user",
                "details": "Отправляет push-уведомление всем подписчикам канала. Требует сервисный ключ в заголовке X-API-Key (формат svc_*).",
                "params": [
                    {
                        "name": "X-API-Key",
                        "type": "header",
                        "required": true,
                        "desc": "Сервисный ключ доступа (svc_*)"
                    },
                    {
                        "name": "channel",
                        "type": "string",
                        "required": true,
                        "desc": "ID канала-получателя"
                    },
                    {
                        "name": "notification",
                        "type": "object",
                        "required": true,
                        "desc": "{ title, body, icon?, url?, data? }"
                    }
                ],
                "response": "{\n  \"success\": true,\n  \"serviceId\": \"svc-123\",\n  \"channel\": \"news\",\n  \"results\": { \"total\": 42, \"sent\": 40, \"failed\": 2 }\n}"
            },
            {
                "method": "POST",
                "path": "/api/notifications/api/send-batch",
                "desc": "Пакетная отправка (сервис)",
                "auth": "user",
                "details": "Отправляет несколько уведомлений в разные каналы за один запрос. Требует сервисный ключ X-API-Key.",
                "params": [
                    {
                        "name": "X-API-Key",
                        "type": "header",
                        "required": true,
                        "desc": "Сервисный ключ доступа (svc_*)"
                    },
                    {
                        "name": "messages",
                        "type": "object[]",
                        "required": true,
                        "desc": "Массив { channel, notification }"
                    }
                ],
                "response": "{\n  \"success\": true,\n  \"results\": [ { \"channel\": \"news\", \"sent\": 40 } ]\n}"
            },
            {
                "method": "POST",
                "path": "/api/notifications/api/send-to-user",
                "desc": "Отправка пользователю (сервис)",
                "auth": "user",
                "details": "Отправляет push-уведомление всем подпискам конкретного пользователя по userId. Требует сервисный ключ X-API-Key.",
                "params": [
                    {
                        "name": "X-API-Key",
                        "type": "header",
                        "required": true,
                        "desc": "Сервисный ключ доступа (svc_*)"
                    },
                    {
                        "name": "userId",
                        "type": "string",
                        "required": true,
                        "desc": "ID пользователя-получателя"
                    },
                    {
                        "name": "notification",
                        "type": "object",
                        "required": true,
                        "desc": "{ title, body, icon?, url?, data? }"
                    }
                ],
                "response": "{\n  \"success\": true,\n  \"userId\": \"1001\",\n  \"results\": { \"total\": 2, \"sent\": 2 }\n}"
            },
            {
                "method": "POST",
                "path": "/api/notifications/admin/send",
                "desc": "Ручная отправка (админ)",
                "auth": "admin",
                "details": "Ручная отправка уведомления в канал из админ-панели. Требует ADMIN_TOKEN.",
                "params": [
                    {
                        "name": "channel",
                        "type": "string",
                        "required": true,
                        "desc": "ID канала"
                    },
                    {
                        "name": "notification",
                        "type": "object",
                        "required": true,
                        "desc": "{ title, body, icon?, url? }"
                    }
                ],
                "response": "{\n  \"success\": true,\n  \"results\": { \"sent\": 40, \"failed\": 0 }\n}"
            },
            {
                "method": "GET",
                "path": "/api/notifications/admin/subscriptions",
                "desc": "Список подписок (админ)",
                "auth": "admin",
                "details": "Возвращает все push-подписки с метаданными (каналы, userAgent, дата создания). Требует ADMIN_TOKEN.",
                "response": "{\n  \"subscriptions\": [ { \"endpoint\": \"https://...\", \"channels\": [\"news\"] } ],\n  \"total\": 42\n}"
            },
            {
                "method": "POST",
                "path": "/api/notifications/admin/services",
                "desc": "Выпуск сервисного ключа (админ)",
                "auth": "admin",
                "details": "Создаёт сервисный API-ключ (svc_*) для внешней интеграции. Ключ показывается один раз. Требует ADMIN_TOKEN.",
                "params": [
                    {
                        "name": "name",
                        "type": "string",
                        "required": true,
                        "desc": "Имя сервиса"
                    }
                ],
                "response": "{\n  \"success\": true,\n  \"apiKey\": \"svc_xxxxxxxx\",\n  \"serviceId\": \"...\"\n}"
            }
        ]
    },
    {
        "id": "notifications-reminders",
        "title": "Напоминания (Reminders)",
        "source": "notifications.js",
        "icon": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z\"/>",
        "iconColor": "#34C759",
        "description": "Подсистема напоминаний поверх push-уведомлений: пользователь создаёт напоминание на время, а сервер при наступлении срока рассылает push на его подписки.",
        "endpoints": [
            {
                "method": "POST",
                "path": "/api/notifications/reminders",
                "desc": "Создать напоминание",
                "auth": null,
                "details": "Создаёт напоминание с текстом и временем срабатывания, привязанное к подписке/пользователю.",
                "params": [
                    {
                        "name": "title",
                        "type": "string",
                        "required": true,
                        "desc": "Текст напоминания"
                    },
                    {
                        "name": "remindAt",
                        "type": "string",
                        "required": true,
                        "desc": "Время срабатывания (ISO 8601)"
                    },
                    {
                        "name": "endpoint",
                        "type": "string",
                        "required": true,
                        "desc": "Endpoint push-подписки получателя"
                    }
                ],
                "response": "{\n  \"success\": true,\n  \"reminder\": { \"id\": \"...\", \"remindAt\": \"...\" }\n}"
            },
            {
                "method": "GET",
                "path": "/api/notifications/reminders",
                "desc": "Список напоминаний",
                "auth": null,
                "details": "Возвращает напоминания (с фильтрацией по endpoint/пользователю).",
                "response": "{\n  \"reminders\": [ { \"id\": \"...\", \"title\": \"...\", \"remindAt\": \"...\" } ]\n}"
            },
            {
                "method": "DELETE",
                "path": "/api/notifications/reminders/:id",
                "desc": "Удалить напоминание",
                "auth": null,
                "details": "Удаляет напоминание по идентификатору.",
                "response": "{\n  \"success\": true\n}"
            },
            {
                "method": "POST",
                "path": "/api/notifications/reminders/check",
                "desc": "Проверка и рассылка",
                "auth": null,
                "details": "Служебный вызов (cron): находит наступившие напоминания и отправляет push, помечая их выполненными.",
                "response": "{\n  \"success\": true,\n  \"sent\": 3\n}"
            }
        ]
    },
    {
        "id": "downloader",
        "title": "Файлообменник (Downloader)",
        "source": "downloader.js",
        "icon": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4\"/>",
        "iconColor": "#0071E3",
        "description": "Сервис хранения и раздачи файлов через Vercel Blob с дедупликацией по SHA-256. Публичное скачивание по хэшу; загрузка и управление — только для администратора.",
        "endpoints": [
            {
                "method": "GET",
                "path": "/api/downloader/health",
                "desc": "Проверка работоспособности",
                "auth": null,
                "details": "Возвращает состояние сервиса и аптайм процесса. Используется мониторингом.",
                "response": "{\n  \"status\": \"healthy\",\n  \"timestamp\": \"2026-06-18T16:00:00.000Z\",\n  \"uptime\": 1234.5\n}"
            },
            {
                "method": "GET",
                "path": "/api/downloader/info/:hash",
                "desc": "Метаданные файла",
                "auth": null,
                "details": "Возвращает метаданные файла по SHA-256 хэшу (имя, размер, тип, число скачиваний). Хэш проверяется на валидность.",
                "response": "{\n  \"hash\": \"a1b2...\",\n  \"name\": \"file.pdf\",\n  \"size\": 123456,\n  \"contentType\": \"application/pdf\",\n  \"downloads\": 12\n}"
            },
            {
                "method": "GET",
                "path": "/api/downloader/:hash",
                "desc": "Скачать файл",
                "auth": null,
                "details": "Отдаёт файл по SHA-256 хэшу и инкрементирует счётчик скачиваний.",
                "response": "Бинарный поток файла (Content-Disposition: attachment)"
            },
            {
                "method": "POST",
                "path": "/api/downloader/",
                "desc": "Загрузить файл (админ)",
                "auth": "admin",
                "details": "Принимает multipart/form-data с одним файлом, проверяет MIME-тип, сохраняет в Vercel Blob с дедупликацией по хэшу. Требует ADMIN_TOKEN.",
                "params": [
                    {
                        "name": "file",
                        "type": "file",
                        "required": true,
                        "desc": "Загружаемый файл (multipart/form-data)"
                    }
                ],
                "response": "{\n  \"hash\": \"a1b2...\",\n  \"url\": \"/downloader/a1b2...\",\n  \"name\": \"file.pdf\",\n  \"size\": 123456\n}"
            },
            {
                "method": "GET",
                "path": "/api/downloader/list",
                "desc": "Список файлов (админ)",
                "auth": "admin",
                "details": "Возвращает список всех загруженных файлов с метаданными. Требует ADMIN_TOKEN.",
                "response": "{\n  \"files\": [ { \"hash\": \"...\", \"name\": \"...\", \"size\": 123 } ],\n  \"total\": 1\n}"
            },
            {
                "method": "DELETE",
                "path": "/api/downloader/:hash",
                "desc": "Удалить файл (админ)",
                "auth": "admin",
                "details": "Удаляет файл из Vercel Blob и его метаданные по хэшу. Требует ADMIN_TOKEN.",
                "response": "{\n  \"success\": true\n}"
            }
        ]
    },
    {
        "id": "redirects",
        "title": "Короткие ссылки (Redirects)",
        "source": "redirects.js",
        "icon": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M13.828 10.172a4 4 0 010 5.656l-3 3a4 4 0 01-5.656-5.656l1.5-1.5m6.656-1.828a4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5\"/>",
        "iconColor": "#FF9F0A",
        "description": "Управление короткими ссылками и редиректами с подсчётом кликов. Переход по слагу — публичный; создание и управление ссылками — только для администратора.",
        "endpoints": [
            {
                "method": "GET",
                "path": "/go/:slug",
                "desc": "Переход по короткой ссылке",
                "auth": null,
                "details": "Выполняет редирект (302) на целевой URL по слагу и увеличивает счётчик кликов. Также доступно как /api/redirects/:slug.",
                "response": "302 Redirect → целевой URL"
            },
            {
                "method": "GET",
                "path": "/api/redirects/stats/:slug",
                "desc": "Статистика кликов",
                "auth": null,
                "details": "Возвращает статистику по короткой ссылке: целевой URL, количество переходов, дату создания.",
                "response": "{\n  \"slug\": \"ch\",\n  \"target\": \"https://...\",\n  \"clicks\": 128\n}"
            },
            {
                "method": "POST",
                "path": "/api/redirects/admin",
                "desc": "Создать/обновить ссылку (админ)",
                "auth": "admin",
                "details": "Создаёт новую короткую ссылку или обновляет существующую. Требует ADMIN_TOKEN.",
                "params": [
                    {
                        "name": "slug",
                        "type": "string",
                        "required": true,
                        "desc": "Короткий идентификатор ссылки"
                    },
                    {
                        "name": "target",
                        "type": "string",
                        "required": true,
                        "desc": "Целевой URL"
                    }
                ],
                "response": "{\n  \"success\": true,\n  \"slug\": \"ch\"\n}"
            },
            {
                "method": "GET",
                "path": "/api/redirects/admin",
                "desc": "Список ссылок (админ)",
                "auth": "admin",
                "details": "Возвращает все короткие ссылки с их статистикой. Требует ADMIN_TOKEN.",
                "response": "{\n  \"links\": [ { \"slug\": \"ch\", \"target\": \"https://...\", \"clicks\": 128 } ]\n}"
            },
            {
                "method": "DELETE",
                "path": "/api/redirects/admin/:slug",
                "desc": "Удалить ссылку (админ)",
                "auth": "admin",
                "details": "Удаляет короткую ссылку и её статистику. Требует ADMIN_TOKEN.",
                "response": "{\n  \"success\": true\n}"
            },
            {
                "method": "POST",
                "path": "/api/redirects/admin/:slug/reset-stats",
                "desc": "Сбросить статистику (админ)",
                "auth": "admin",
                "details": "Обнуляет счётчик кликов короткой ссылки. Требует ADMIN_TOKEN.",
                "response": "{\n  \"success\": true\n}"
            }
        ]
    },
    {
        "id": "call",
        "title": "Видеозвонки (Call)",
        "source": "proxy.js",
        "icon": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z\"/>",
        "iconColor": "#34C759",
        "description": "Сигнализация для P2P видеозвонков на базе PeerJS (WebRTC). Сервер управляет временными комнатами; сам медиапоток идёт напрямую между участниками.",
        "endpoints": [
            {
                "method": "POST",
                "path": "/api/call/room",
                "desc": "Создать комнату",
                "auth": null,
                "details": "Создаёт временную комнату с уникальным ID и сроком жизни. Возвращает roomId и время истечения.",
                "response": "{\n  \"roomId\": \"abc123\",\n  \"expiresAt\": 1781800000000\n}"
            },
            {
                "method": "GET",
                "path": "/api/call/check/:id",
                "desc": "Проверить комнату",
                "auth": null,
                "details": "Проверяет, существует ли комната с указанным ID и не истекла ли она.",
                "response": "{\n  \"exists\": true,\n  \"roomId\": \"abc123\",\n  \"createdAt\": 1781790000000\n}"
            },
            {
                "method": "POST",
                "path": "/api/call/join",
                "desc": "Войти в комнату",
                "auth": null,
                "details": "Регистрирует участника в комнате. Возвращает актуальное число участников.",
                "params": [
                    {
                        "name": "roomId",
                        "type": "string",
                        "required": true,
                        "desc": "ID комнаты"
                    }
                ],
                "response": "{\n  \"success\": true,\n  \"participants\": 2\n}"
            },
            {
                "method": "POST",
                "path": "/api/call/leave",
                "desc": "Выйти из комнаты",
                "auth": null,
                "details": "Отмечает выход участника из комнаты.",
                "params": [
                    {
                        "name": "roomId",
                        "type": "string",
                        "required": true,
                        "desc": "ID комнаты"
                    }
                ],
                "response": "{\n  \"success\": true\n}"
            }
        ]
    },
    {
        "id": "status-monitor",
        "title": "Мониторинг статуса · API",
        "source": "proxy.js",
        "icon": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M3 12h4l3 8 4-16 3 8h4\"/>",
        "iconColor": "#FF3B30",
        "description": "Серверный мониторинг доступности сервисов с постоянной историей в Vercel KV. Снимки собираются по расписанию (Vercel Cron) и при заходах на страницу /status; агрегаты аптайма считаются за 24ч/7д/30д.",
        "endpoints": [
            {
                "method": "GET",
                "path": "/api/status-config",
                "desc": "Конфигурация сервисов",
                "auth": null,
                "details": "Возвращает список отслеживаемых сервисов с их проверками (метод, путь, ожидаемые коды).",
                "response": "[ { \"id\": \"website\", \"name\": \"Website Frontend\", \"check\": { \"method\": \"GET\", \"path\": \"/\" } } ]"
            },
            {
                "method": "GET",
                "path": "/api/status-check",
                "desc": "Запустить проверку и записать снимок",
                "auth": null,
                "details": "Пингует все сервисы и записывает снимок в KV. По умолчанию срабатывает не чаще раза в 5 минут; ?force=1 игнорирует троттлинг. Дёргается Vercel Cron.",
                "params": [
                    {
                        "name": "force",
                        "type": "query",
                        "required": false,
                        "desc": "force=1 — записать снимок, игнорируя троттлинг"
                    }
                ],
                "response": "{\n  \"recorded\": true,\n  \"snapshot\": { \"timestamp\": 1781800000000, \"services\": [] }\n}"
            },
            {
                "method": "GET",
                "path": "/api/status-history",
                "desc": "История и аптайм",
                "auth": null,
                "details": "Возвращает снимки и агрегаты аптайма за 24ч/7д/30д (общий и по каждому сервису). При устаревших данных запускает фоновую запись снимка (через waitUntil).",
                "params": [
                    {
                        "name": "limit",
                        "type": "query",
                        "required": false,
                        "desc": "Сколько последних снимков вернуть (по умолчанию 120)"
                    }
                ],
                "response": "{\n  \"snapshots\": [],\n  \"uptime\": { \"24h\": 100, \"7d\": 99.8, \"30d\": 99.5 },\n  \"lastCheck\": 1781800000000\n}"
            }
        ]
    }
];

// ---- Админские эндпоинты (требуют токен) ----
app.get('/api/admin/status-config', verifyAdminToken, async (req, res, next) => {
    try {
        let config = await kv.get(STATUS_CONFIG_KEY);
        if (!config) config = DEFAULT_STATUS_CONFIG;
        res.json({ content: config });
    } catch (err) { next(err); }
});

app.post('/api/admin/status-config/save', verifyAdminToken, async (req, res, next) => {
    try {
        const { content } = req.body;
        if (!Array.isArray(content)) return res.status(400).json({ error: 'Must be an array of services' });
        await kv.set(STATUS_CONFIG_KEY, content);
        res.json({ success: true });
    } catch (err) { next(err); }
});

app.get('/api/admin/api-config', verifyAdminToken, async (req, res, next) => {
    try {
        let config = await kv.get(API_CONFIG_KEY);
        if (!config) config = DEFAULT_API_CONFIG;
        res.json({ content: config });
    } catch (err) { next(err); }
});

app.post('/api/admin/api-config/save', verifyAdminToken, async (req, res, next) => {
    try {
        const { content } = req.body;
        if (!Array.isArray(content)) return res.status(400).json({ error: 'Must be an array of API sections' });
        await kv.set(API_CONFIG_KEY, content);
        res.json({ success: true });
    } catch (err) { next(err); }
});

// ---- Публичные эндпоинты (для страниц status.html и api.html) ----
app.get('/api/status-config', async (req, res, next) => {
    try {
        let config = await kv.get(STATUS_CONFIG_KEY);
        if (!config) config = DEFAULT_STATUS_CONFIG;
        res.json(config);
    } catch (err) { next(err); }
});

app.get('/api/api-config', async (req, res, next) => {
    try {
        let config = await kv.get(API_CONFIG_KEY);
        if (!config) config = DEFAULT_API_CONFIG;
        res.json(config);
    } catch (err) { next(err); }
});

// -----------------------------
// API Routes: Server-side Uptime Monitoring (KV)
// -----------------------------

/**
 * Ключ KV для хранения истории снимков мониторинга
 * @constant {string}
 */
const STATUS_HISTORY_KEY = 'status:history';

/**
 * Ключ KV для метки времени последней записи (троттлинг)
 * @constant {string}
 */
const STATUS_LAST_CHECK_KEY = 'status:last_check';

/**
 * Параметры серверного мониторинга
 * @constant {Object}
 */
const STATUS_MONITOR = {
    /** Максимальное число хранимых снимков */
    MAX_SNAPSHOTS: 1000,
    /** Срок хранения снимков (мс) — 30 дней */
    RETENTION_MS: 30 * 24 * 60 * 60 * 1000,
    /** Минимальный интервал между «ленивыми» записями (мс) — 5 минут */
    MIN_RECORD_INTERVAL_MS: 5 * 60 * 1000,
    /** Таймаут по умолчанию для одной проверки (мс) */
    DEFAULT_TIMEOUT: 5000
};

/**
 * Определение базового URL текущего деплоя из запроса или окружения.
 *
 * @param {express.Request} [req] - HTTP-запрос (опционально)
 * @returns {string} Базовый URL без завершающего слэша
 */
function resolveBaseUrl(req) {
    if (req) {
        const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
        const host = req.headers['x-forwarded-host'] || req.get('host');
        if (host) return `${proto}://${host}`;
    }
    if (process.env.STATUS_BASE_URL) return process.env.STATUS_BASE_URL.replace(/\/$/, '');
    if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
    return `http://localhost:${PORT}`;
}

/**
 * Серверная проверка одного сервиса по его конфигурации.
 *
 * @param {string} baseUrl - Базовый URL деплоя
 * @param {Object} service - Описание сервиса из status-config
 * @returns {Promise<Object>} Результат проверки { id, status, latency, statusCode, error }
 */
async function checkServiceServerSide(baseUrl, service) {
    const check = service.check || {};
    const timeout = check.timeout || STATUS_MONITOR.DEFAULT_TIMEOUT;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const start = Date.now();

    const finish = (extra) => {
        clearTimeout(timer);
        return { id: service.id, latency: Date.now() - start, statusCode: '—', error: null, ...extra };
    };

    try {
        if (check.type === 'external' && check.url) {
            await fetch(check.url, { method: 'GET', signal: controller.signal, redirect: 'manual' });
            return finish({ status: 'operational' });
        }

        let path = check.path || '/';
        let expected = check.expectedStatuses || [200];
        if (check.type === 'custom' && check.name === 'checkKV') {
            path = '/api/news/posts';
            expected = [200];
        }

        const options = {
            method: check.method || 'GET',
            signal: controller.signal,
            redirect: 'manual',
            headers: { 'X-Status-Check': '1' }
        };
        if (check.body) {
            options.headers['Content-Type'] = 'application/json';
            options.body = check.body;
        }

        const response = await fetch(`${baseUrl}${path}`, options);
        const ok = expected.includes(response.status);
        return finish({
            status: ok ? 'operational' : 'outage',
            statusCode: response.status,
            error: ok ? null : `Unexpected status ${response.status} (expected ${expected.join('|')})`
        });
    } catch (err) {
        const aborted = err && err.name === 'AbortError';
        return finish({
            status: aborted ? 'degraded' : 'outage',
            error: aborted ? `Timeout after ${timeout}ms` : (err.message || 'Connection failed')
        });
    }
}

/**
 * Выполнение полного цикла проверок и формирование снимка.
 *
 * @param {string} baseUrl - Базовый URL деплоя
 * @returns {Promise<Object>} Снимок мониторинга
 */
async function performStatusChecks(baseUrl) {
    let services = await kv.get(STATUS_CONFIG_KEY);
    if (!Array.isArray(services) || services.length === 0) services = DEFAULT_STATUS_CONFIG;

    const results = await Promise.all(services.map(s => checkServiceServerSide(baseUrl, s)));

    const operational = results.filter(r => r.status === 'operational').length;
    const latencies = results.map(r => r.latency || 0);
    const avgLatency = results.length
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / results.length)
        : 0;

    let overall = 'operational';
    if (results.some(r => r.status === 'outage')) overall = 'outage';
    else if (results.some(r => r.status === 'degraded')) overall = 'degraded';

    const perService = {};
    for (const r of results) {
        perService[r.id] = { status: r.status, latency: r.latency, statusCode: r.statusCode, error: r.error };
    }

    return {
        timestamp: Date.now(),
        status: overall,
        operational,
        total: results.length,
        avgLatency,
        services: perService
    };
}

/**
 * Сохранение снимка в KV с обрезкой по размеру и сроку хранения.
 *
 * @param {Object} snapshot - Снимок мониторинга
 * @returns {Promise<void>}
 */
async function recordSnapshot(snapshot) {
    let history = await kv.get(STATUS_HISTORY_KEY);
    if (!Array.isArray(history)) history = [];

    history.push(snapshot);

    const cutoff = Date.now() - STATUS_MONITOR.RETENTION_MS;
    history = history.filter(s => s && s.timestamp >= cutoff);
    if (history.length > STATUS_MONITOR.MAX_SNAPSHOTS) {
        history = history.slice(-STATUS_MONITOR.MAX_SNAPSHOTS);
    }

    await kv.set(STATUS_HISTORY_KEY, history);
    await kv.set(STATUS_LAST_CHECK_KEY, snapshot.timestamp);
}

/**
 * Запускает фоновую задачу так, чтобы она надёжно завершилась.
 * На Vercel передаёт промис в waitUntil (функция не «замораживается» до
 * завершения записи). Вне Vercel-контекста промис просто остаётся работать
 * в живущем процессе. Ошибки гасятся, чтобы не уронить запрос.
 *
 * @param {Promise<unknown>} promise - Фоновая задача
 */
function scheduleBackground(promise) {
    const safe = Promise.resolve(promise).catch(err =>
        console.error('[status] background task failed:', err && err.message));
    if (typeof vercelWaitUntil === 'function') {
        try {
            vercelWaitUntil(safe);
        } catch (_) {
            // Нет активного контекста запроса — промис уже выполняется.
        }
    }
}

/**
 * Подсчёт процента аптайма по снимкам за указанное окно.
 *
 * @param {Array<Object>} snapshots - Список снимков
 * @param {number} windowMs - Размер окна (мс)
 * @param {string|null} [serviceId] - ID сервиса или null для общего аптайма
 * @returns {number|null} Процент аптайма (0-100) или null если нет данных
 */
function computeUptime(snapshots, windowMs, serviceId) {
    const cutoff = Date.now() - windowMs;
    const inWindow = snapshots.filter(s => s.timestamp >= cutoff);
    if (inWindow.length === 0) return null;

    let ok = 0;
    for (const snap of inWindow) {
        const status = serviceId
            ? (snap.services && snap.services[serviceId] && snap.services[serviceId].status)
            : snap.status;
        if (status === 'operational') ok++;
    }
    return Math.round((ok / inWindow.length) * 1000) / 10;
}

const STATUS_WINDOWS = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000
};

/**
 * Эндпоинт записи проверки. Вызывается Vercel Cron или вручную.
 * Троттлится: повторный вызов в пределах MIN_RECORD_INTERVAL_MS пропускается.
 */
app.get('/api/status-check', async (req, res, next) => {
    try {
        const force = req.query.force === '1';
        const lastCheck = await kv.get(STATUS_LAST_CHECK_KEY);
        if (!force && lastCheck && (Date.now() - lastCheck) < STATUS_MONITOR.MIN_RECORD_INTERVAL_MS) {
            return res.json({ recorded: false, reason: 'throttled', lastCheck });
        }

        const snapshot = await performStatusChecks(resolveBaseUrl(req));
        await recordSnapshot(snapshot);
        res.json({ recorded: true, snapshot });
    } catch (err) { next(err); }
});

/**
 * Публичный эндпоинт истории аптайма для страницы /status.
 * Возвращает снимки, агрегаты аптайма (24h/7d/30d) и метку последней проверки.
 * При устаревших данных запускает «ленивую» фоновую запись снимка.
 */
app.get('/api/status-history', async (req, res, next) => {
    try {
        let history = await kv.get(STATUS_HISTORY_KEY);
        if (!Array.isArray(history)) history = [];

        const lastCheck = await kv.get(STATUS_LAST_CHECK_KEY);
        const stale = !lastCheck || (Date.now() - lastCheck) >= STATUS_MONITOR.MIN_RECORD_INTERVAL_MS;

        if (stale) {
            // Оптимистично помечаем время проверки, чтобы конкурентные
            // запросы не запускали дублирующий «лавинный» сбор.
            await kv.set(STATUS_LAST_CHECK_KEY, Date.now());
            const baseUrl = resolveBaseUrl(req);
            scheduleBackground(performStatusChecks(baseUrl).then(recordSnapshot));
        }

        const limit = Math.min(parseInt(req.query.limit, 10) || 120, STATUS_MONITOR.MAX_SNAPSHOTS);
        const snapshots = history.slice(-limit);

        const overall = {};
        for (const [key, ms] of Object.entries(STATUS_WINDOWS)) {
            overall[key] = computeUptime(history, ms, null);
        }

        const serviceIds = new Set();
        for (const snap of history) {
            if (snap.services) Object.keys(snap.services).forEach(id => serviceIds.add(id));
        }
        const services = {};
        for (const id of serviceIds) {
            services[id] = {};
            for (const [key, ms] of Object.entries(STATUS_WINDOWS)) {
                services[id][key] = computeUptime(history, ms, id);
            }
        }

        res.json({ lastCheck: lastCheck || null, uptime: overall, services, snapshots });
    } catch (err) { next(err); }
});

// -----------------------------
// API Routes: FAQ (Help Center)
// -----------------------------
const FAQ_CONFIG_KEY = 'admin:faq_config';

const DEFAULT_FAQ_CONFIG = [
    {
        id: 'general',
        category: 'general',
        items: [
            { q: 'Что такое платформа Oris?', a: 'Oris — это каталог избранных веб-проектов с новостным разделом, системой комментариев и технической поддержкой.' },
            { q: 'Как добавить свой сайт в каталог?', a: 'Перейдите на страницу <a href="/add">/add</a>, заполните форму. Заявка отправляется администратору через Telegram для ручной модерации.' },
            { q: 'Где посмотреть историю изменений?', a: 'Вся история версий доступна на странице <a href="/changelog">/changelog</a>.' }
        ]
    },
    {
        id: 'account',
        category: 'account',
        items: [
            { q: 'Как зарегистрироваться в новостях?', a: 'Нажмите «Войти» на <a href="/news">/news</a>, выберите «Читатель» и введите имя. Сохраните 4-значный ID — он нужен для повторного входа.' },
            { q: 'Что делать, если я потерял ID?', a: 'К сожалению, восстановить ID невозможно — он не привязан к email. Создайте новый аккаунт.' }
        ]
    },
    {
        id: 'support',
        category: 'support',
        items: [
            { q: 'Как создать тикет в поддержку?', a: 'Перейдите на <a href="/support">/support</a>, введите имя и создайте тикет. Команда поддержки ответит в чате.' },
            { q: 'Сколько времени занимает ответ?', a: 'Стандартное время ответа — до 24 часов в рабочие дни.' }
        ]
    }
];

// Публичный эндпоинт — для страницы /help
app.get('/api/faq', async (req, res, next) => {
    try {
        let config = await kv.get(FAQ_CONFIG_KEY);
        if (!config) config = DEFAULT_FAQ_CONFIG;
        res.json(config);
    } catch (err) { next(err); }
});

// Админский GET
app.get('/api/admin/faq-config', verifyAdminToken, async (req, res, next) => {
    try {
        let config = await kv.get(FAQ_CONFIG_KEY);
        if (!config) config = DEFAULT_FAQ_CONFIG;
        res.json({ content: config });
    } catch (err) { next(err); }
});

// Админский POST
app.post('/api/admin/faq-config/save', verifyAdminToken, async (req, res, next) => {
    try {
        const { content } = req.body;
        if (!Array.isArray(content)) {
            return res.status(400).json({ error: 'Must be an array of FAQ sections' });
        }
        await kv.set(FAQ_CONFIG_KEY, content);
        res.json({ success: true });
    } catch (err) { next(err); }
});

// -----------------------------
// API Routes: Forms
// -----------------------------

/**
 * Обработчик rate limiting для форм
 * @param {Request} req - Express request объект
 * @param {Response} res - Express response объект
 * @returns {number|null} - Время ожидания в секундах или null, если лимит не превышен
 */
const handleRateLimit = (req, res) => {
    const waitSeconds = checkFormRateLimit(req.ip);
    if (waitSeconds > 0) {
        res.status(429).json({
            error: `Подождите ${waitSeconds} сек. перед следующей заявкой`
        });
        return waitSeconds;
    }
    return null;
};

/**
 * Валидатор email адреса
 * @param {string} email - Email для проверки
 * @returns {boolean} - true если email корректен
 */
const isValidEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return email && emailRegex.test(email);
};

/**
 * Форматирование даты для сообщений
 * @returns {string} - Отформатированная дата и время
 */
const formatDateTime = () => {
    return new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
};

/**
 * Обработчик ошибок API
 * @param {string} endpoint - Название endpoint
 * @param {Error} err - Объект ошибки
 * @param {Function} next - Express next функция
 */
const handleApiError = (endpoint, err, next) => {
    console.error(`[${endpoint}]`, err);
    next(err);
};

// -----------------------------
// Route: Добавление сайта
// -----------------------------

app.post('/api/add/saite', async (req, res, next) => {
    try {
        // Проверка rate limit
        if (handleRateLimit(req, res)) return;

        const { title, url, description, category, authorName, email, telegram } = req.body;

        // Валидация обязательных полей
        if (!title || title.trim().length < MIN_TITLE_LENGTH) {
            return res.status(400).json({ 
                error: 'Название должно содержать минимум 3 символа' 
            });
        }
        
        if (!url || !isValidUrl(normalizeUrl(url))) {
            return res.status(400).json({ 
                error: 'Некорректный URL' 
            });
        }
        
        if (!description || description.trim().length < MIN_DESCRIPTION_LENGTH) {
            return res.status(400).json({ 
                error: 'Описание слишком короткое (минимум 20 символов)' 
            });
        }
        
        if (!authorName || authorName.trim().length < 2) {
            return res.status(400).json({ 
                error: 'Укажите имя' 
            });
        }
        
        if (!isValidEmail(email)) {
            return res.status(400).json({ 
                error: 'Некорректный email' 
            });
        }

        // Формирование сообщения для Telegram
        const message = buildSiteSubmissionMessage({
            title,
            url,
            description,
            category,
            authorName,
            email,
            telegram
        });

        // Отправка сообщения
        await sendTelegramMessage(message);

        // Успешный ответ
        res.json({ 
            success: true, 
            message: 'Заявка отправлена' 
        });
        
    } catch (err) {
        handleApiError('api/add/saite', err, next);
    }
});

/**
 * Построение сообщения для заявки на добавление сайта
 * @param {Object} data - Данные формы
 * @returns {string} - Отформатированное HTML сообщение
 */
const buildSiteSubmissionMessage = ({ title, url, description, category, authorName, email, telegram }) => {
    const normalizedUrl = normalizeUrl(url);
    const categoryLabel = CATEGORY_LABELS[category] || 'Другое';
    const telegramLine = telegram ? `\n💬 ${telegram}` : '';
    const dateTime = formatDateTime();

    return `🌐 <b>НОВАЯ ЗАЯВКА: Добавление сайта</b>

<b>Название:</b> ${title}
<b>URL:</b> ${normalizedUrl}
<b>Категория:</b> ${categoryLabel}

<b>Описание:</b>
${description}

━━━━━━━━━━━━━━━━━

<b>Контакты:</b>
👤 ${authorName}
📧 ${email}${telegramLine}

🕐 ${dateTime}`;
};

// -----------------------------
// Route: Сотрудничество
// -----------------------------

app.post('/api/add/corp', async (req, res, next) => {
    try {
        // Проверка rate limit
        if (handleRateLimit(req, res)) return;

        const { name, company, email, telegram, type, message, budget, website } = req.body;

        // Валидация обязательных полей
        if (!name || name.trim().length < 2) {
            return res.status(400).json({ 
                error: 'Укажите имя' 
            });
        }
        
        if (!isValidEmail(email)) {
            return res.status(400).json({ 
                error: 'Некорректный email' 
            });
        }
        
        if (!type || !CORP_TYPE_LABELS[type]) {
            return res.status(400).json({ 
                error: 'Выберите тип сотрудничества' 
            });
        }
        
        if (!message || message.trim().length < MIN_DESCRIPTION_LENGTH) {
            return res.status(400).json({ 
                error: 'Сообщение слишком короткое (минимум 20 символов)' 
            });
        }
        
        if (website && !isValidUrl(normalizeUrl(website))) {
            return res.status(400).json({ 
                error: 'Некорректный URL сайта' 
            });
        }

        // Формирование сообщения для Telegram
        const tgMessage = buildCorpCollaborationMessage({
            name,
            company,
            email,
            telegram,
            type,
            message,
            budget,
            website
        });

        // Отправка сообщения
        await sendTelegramMessage(tgMessage);

        // Успешный ответ
        res.json({ 
            success: true, 
            message: 'Заявка отправлена' 
        });
        
    } catch (err) {
        handleApiError('api/add/corp', err, next);
    }
});

/**
 * Построение сообщения для заявки на сотрудничество
 * @param {Object} data - Данные формы
 * @returns {string} - Отформатированное HTML сообщение
 */
const buildCorpCollaborationMessage = ({ name, company, email, telegram, type, message, budget, website }) => {
    const typeLabel = CORP_TYPE_LABELS[type];
    const budgetLine = budget && BUDGET_LABELS[budget] ? `<b>Бюджет:</b> ${BUDGET_LABELS[budget]}` : '';
    const normalizedWebsite = website ? normalizeUrl(website) : null;
    const companyLine = company ? `\n🏢 ${company}` : '';
    const websiteLine = normalizedWebsite ? `\n🌐 ${normalizedWebsite}` : '';
    const telegramLine = telegram ? `\n💬 ${telegram}` : '';
    const dateTime = formatDateTime();

    return `🤝 <b>НОВАЯ ЗАЯВКА: Сотрудничество</b>

<b>Тип:</b> ${typeLabel}
${budgetLine}

<b>От кого:</b>
👤 ${name}${companyLine}${websiteLine}

<b>Сообщение:</b>
${message}

━━━━━━━━━━━━━━━━━

<b>Контакты:</b>
📧 ${email}${telegramLine}

🕐 ${dateTime}`;
};


// -----------------------------
// API Routes: Call (WebRTC)
// -----------------------------

// -----------------------------
// Constants
// -----------------------------

const ROOM_TTL = 4 * 60 * 60 * 1000; // 4 часа
const ROOM_CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 минут
const ROOM_ID_LENGTH = 6;
const MAX_PARTICIPANTS = 2;
const MAX_ROOM_GENERATION_ATTEMPTS = 10;

// Хранилище активных комнат (in-memory, сбрасывается при холодном старте)
const activeRooms = new Map();

// -----------------------------
// Room Management
// -----------------------------

/**
 * Класс для управления комнатами звонков
 */
class RoomManager {
    constructor() {
        this.rooms = new Map();
        this.startCleanupInterval();
    }

    /**
     * Генерация читаемого ID комнаты (без I, O, 0, 1)
     * @returns {string} - Сгенерированный ID комнаты
     */
    generateRoomId() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let result = '';
        for (let i = 0; i < ROOM_ID_LENGTH; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    /**
     * Создание новой комнаты с уникальным ID
     * @returns {Object|null} - Объект комнаты или null при ошибке
     */
    createRoom() {
        let roomId;
        let attempts = 0;

        do {
            roomId = this.generateRoomId();
            attempts++;
            if (attempts > MAX_ROOM_GENERATION_ATTEMPTS) {
                return null;
            }
        } while (this.rooms.has(roomId));

        const room = {
            id: roomId,
            createdAt: Date.now(),
            expiresAt: Date.now() + ROOM_TTL,
            participants: 0
        };

        this.rooms.set(roomId, room);
        return room;
    }

    /**
     * Проверка существования комнаты
     * @param {string} roomId - ID комнаты
     * @returns {Object|null} - Объект комнаты или null
     */
    getRoom(roomId) {
        return this.rooms.get(roomId) || null;
    }

    /**
     * Добавление участника в комнату
     * @param {string} roomId - ID комнаты
     * @returns {Object|null} - Обновленный объект комнаты или null
     */
    addParticipant(roomId) {
        const room = this.rooms.get(roomId);
        if (!room) return null;

        room.participants = Math.min(room.participants + 1, MAX_PARTICIPANTS);
        return room;
    }

    /**
     * Удаление участника из комнаты
     * @param {string} roomId - ID комнаты
     * @returns {boolean} - true если комната существует
     */
    removeParticipant(roomId) {
        const room = this.rooms.get(roomId);
        if (!room) return false;

        room.participants = Math.max(room.participants - 1, 0);
        
        // Удаляем комнату, если участников не осталось
        if (room.participants === 0) {
            this.rooms.delete(roomId);
        }
        
        return true;
    }

    /**
     * Очистка устаревших комнат
     */
    cleanupExpiredRooms() {
        const now = Date.now();
        for (const [id, room] of this.rooms.entries()) {
            if (now - room.createdAt > ROOM_TTL) {
                this.rooms.delete(id);
            }
        }
    }

    /**
     * Запуск периодической очистки устаревших комнат
     */
    startCleanupInterval() {
        setInterval(() => {
            this.cleanupExpiredRooms();
        }, ROOM_CLEANUP_INTERVAL);
    }
}

// Инициализация менеджера комнат
const roomManager = new RoomManager();

// -----------------------------
// Validation Helpers
// -----------------------------

/**
 * Валидация формата ID комнаты
 * @param {string} roomId - ID комнаты для проверки
 * @returns {boolean} - true если формат корректен
 */
const isValidRoomId = (roomId) => {
    return roomId && /^[A-Z0-9]{6}$/.test(roomId.toUpperCase());
};

/**
 * Нормализация ID комнаты к верхнему регистру
 * @param {string} roomId - ID комнаты
 * @returns {string} - ID в верхнем регистре
 */
const normalizeRoomId = (roomId) => {
    return roomId ? roomId.toUpperCase() : '';
};

// -----------------------------
// Route Handlers
// -----------------------------

/**
 * GET /call — отдаём HTML-страницу звонка
 */
app.get('/call', (req, res) => {
    serveCallPage(res);
});

/**
 * GET /call/:id — вход в комнату по ID (для share-ссылок)
 */
app.get('/call/:id', (req, res) => {
    const roomId = normalizeRoomId(req.params.id);
    
    if (!isValidRoomId(roomId)) {
        return res.status(400).json({ error: 'Invalid room ID' });
    }
    
    serveCallPage(res);
});

/**
 * POST /api/call/room — создать новую комнату
 */
app.post('/api/call/room', (req, res) => {
    try {
        const room = roomManager.createRoom();
        
        if (!room) {
            return res.status(500).json({ 
                error: 'Could not generate unique room ID' 
            });
        }

        res.json({ 
            roomId: room.id, 
            expiresAt: room.expiresAt 
        });
    } catch (err) {
        handleCallApiError('POST /api/call/room', err, res);
    }
});

/**
 * GET /api/call/check/:id — проверить, существует ли комната
 */
app.get('/api/call/check/:id', (req, res) => {
    const roomId = normalizeRoomId(req.params.id);
    
    if (!isValidRoomId(roomId)) {
        return res.status(400).json({ error: 'Invalid room ID' });
    }
    
    const room = roomManager.getRoom(roomId);
    
    res.json({
        exists: !!room,
        roomId,
        createdAt: room?.createdAt || null
    });
});

/**
 * POST /api/call/join — отметить, что пользователь вошёл в комнату
 */
app.post('/api/call/join', (req, res) => {
    const { roomId } = req.body;
    const normalizedRoomId = normalizeRoomId(roomId);
    
    if (!isValidRoomId(normalizedRoomId)) {
        return res.status(400).json({ error: 'Invalid room ID' });
    }
    
    const room = roomManager.addParticipant(normalizedRoomId);
    
    if (!room) {
        return res.status(404).json({ 
            error: 'Room not found or expired' 
        });
    }
    
    res.json({ 
        success: true, 
        participants: room.participants 
    });
});

/**
 * POST /api/call/leave — отметить выход из комнаты
 */
app.post('/api/call/leave', (req, res) => {
    const { roomId } = req.body;
    
    if (!roomId) {
        return res.status(400).json({ error: 'roomId required' });
    }
    
    const normalizedRoomId = normalizeRoomId(roomId);
    const success = roomManager.removeParticipant(normalizedRoomId);
    
    res.json({ success });
});

// -----------------------------
// Helper Functions
// -----------------------------

/**
 * Отдача HTML-страницы звонка с нужными заголовками
 * @param {Response} res - Express response объект
 */
const serveCallPage = (res) => {
    const filePath = path.join(PUBLIC_DIR, 'call', 'index.html');
    
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), autoplay=(self), display-capture=(self)');
    res.setHeader('Cache-Control', 'no-store');
    
    res.sendFile(filePath, (err) => {
        if (err) {
            res.status(404).json({ error: 'Call page not found' });
        }
    });
};

/**
 * Обработчик ошибок API для Call routes
 * @param {string} endpoint - Название endpoint
 * @param {Error} err - Объект ошибки
 * @param {Response} res - Express response объект
 */
const handleCallApiError = (endpoint, err, res) => {
    console.error(`[${endpoint}]`, err);
    res.status(500).json({ error: 'Internal server error' });
};

// -----------------------------
// Error Handling & Server Lifecycle
// -----------------------------

// -----------------------------
// Constants
// -----------------------------

const HTTP_ERROR_MESSAGES = {
    NOT_FOUND: 'Not found',
    INTERNAL_ERROR: 'Internal server error'
};

const HTTP_STATUS = {
    NOT_FOUND: 404,
    INTERNAL_ERROR: 500
};

const ENVIRONMENT = {
    PRODUCTION: 'production'
};

const SHUTDOWN_TIMEOUT = 10000; // 10 секунд на graceful shutdown

const STARTUP_MESSAGES = {
    SERVER_RUNNING: (port) => `Oris Server running on port ${port}`,
    SECURITY_INFO: 'Security: Helmet enabled, Rate limiting active',
    STORAGE_INFO: (useGitHub) => `Storage: ${useGitHub ? 'GitHub API' : 'Local Filesystem'}`,
    SHUTDOWN_START: '\nShutting down gracefully...',
    SHUTDOWN_COMPLETE: 'Server closed',
    SHUTDOWN_FORCED: 'Forced shutdown',
    WARNING_NO_ADMIN_TOKEN: 'WARNING: ADMIN_TOKEN is not set. Admin panel will be inaccessible.',
    WARNING_NO_TELEGRAM: 'WARNING: Telegram is not fully configured. Notifications will be disabled.',
    WARNING_NO_GITHUB: 'WARNING: GitHub is not configured. Using local filesystem for storage.'
};

const LOG_PREFIXES = {
    ERROR: '[Error]',
    UNCAUGHT_EXCEPTION: '[Uncaught Exception]',
    UNHANDLED_REJECTION: '[Unhandled Rejection]'
};

// -----------------------------
// Error Handler Service
// -----------------------------

/**
 * Сервис для обработки HTTP ошибок
 */
class ErrorHandlerService {
    /**
     * Проверка, является ли окружение разработческим
     * @returns {boolean} - true если NODE_ENV !== 'production'
     */
    isDevelopment() {
        return process.env.NODE_ENV !== ENVIRONMENT.PRODUCTION;
    }

    /**
     * Получение сообщения об ошибке для ответа клиенту
     * В dev-режиме возвращается оригинальное сообщение, в production — общее
     * @param {Error} err - Объект ошибки
     * @returns {string} - Сообщение для отправки клиенту
     */
    getClientErrorMessage(err) {
        if (this.isDevelopment()) {
            return err.message || HTTP_ERROR_MESSAGES.INTERNAL_ERROR;
        }
        return HTTP_ERROR_MESSAGES.INTERNAL_ERROR;
    }

    /**
     * Получение HTTP статуса ошибки
     * @param {Error} err - Объект ошибки
     * @returns {number} - HTTP статус код
     */
    getErrorStatus(err) {
        return err.status || HTTP_STATUS.INTERNAL_ERROR;
    }

    /**
     * Логирование ошибки
     * @param {Error} err - Объект ошибки
     */
    logError(err) {
        console.error(LOG_PREFIXES.ERROR, err.stack || err);
    }

    /**
     * Middleware для обработки 404 ошибок
     * @param {Request} req - Express request объект
     * @param {Response} res - Express response объект
     */
    handleNotFound(req, res) {
        res.status(HTTP_STATUS.NOT_FOUND).json({ 
            error: HTTP_ERROR_MESSAGES.NOT_FOUND 
        });
    }

    /**
     * Middleware для обработки общих ошибок
     * @param {Error} err - Объект ошибки
     * @param {Request} req - Express request объект
     * @param {Response} res - Express response объект
     * @param {Function} next - Express next функция
     */
    handleError(err, req, res, next) {
        this.logError(err);

        const statusCode = this.getErrorStatus(err);
        const message = this.getClientErrorMessage(err);

        res.status(statusCode).json({ 
            error: message 
        });
    }
}

// Инициализация сервиса
const errorHandlerService = new ErrorHandlerService();

// -----------------------------
// Startup Validator Service
// -----------------------------

/**
 * Сервис для проверки критических переменных окружения при старте
 */
class StartupValidatorService {
    /**
     * Проверка наличия критических переменных окружения
     * Выводит предупреждения в консоль при их отсутствии
     */
    validateEnvironment() {
        this.checkAdminToken();
        this.checkTelegramConfig();
        this.checkGitHubConfig();
    }

    /**
     * Проверка наличия ADMIN_TOKEN
     */
    checkAdminToken() {
        if (!ADMIN_TOKEN) {
            console.warn(STARTUP_MESSAGES.WARNING_NO_ADMIN_TOKEN);
        }
    }

    /**
     * Проверка конфигурации Telegram
     */
    checkTelegramConfig() {
        if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
            console.warn(STARTUP_MESSAGES.WARNING_NO_TELEGRAM);
        }
    }

    /**
     * Проверка конфигурации GitHub
     */
    checkGitHubConfig() {
        if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
            console.warn(STARTUP_MESSAGES.WARNING_NO_GITHUB);
        }
    }
}

// Инициализация сервиса
const startupValidatorService = new StartupValidatorService();

// -----------------------------
// Server Lifecycle Service
// -----------------------------

/**
 * Сервис для управления жизненным циклом сервера
 */
class ServerLifecycleService {
    constructor() {
        this.server = null;
        this.isShuttingDown = false;
    }

    /**
     * Запуск сервера
     * @param {Object} app - Express приложение
     * @param {number} port - Порт для прослушивания
     */
    start(app, port) {
        this.server = app.listen(port, () => {
            this.logStartupInfo(port);
        });

        this.registerShutdownHandlers();
    }

    /**
     * Логирование информации о запуске
     * @param {number} port - Порт сервера
     */
    logStartupInfo(port) {
        console.log(STARTUP_MESSAGES.SERVER_RUNNING(port));
        console.log(STARTUP_MESSAGES.SECURITY_INFO);
        console.log(STARTUP_MESSAGES.STORAGE_INFO(!!GITHUB_TOKEN));
    }

    /**
     * Регистрация обработчиков завершения работы
     */
    registerShutdownHandlers() {
        process.on('SIGTERM', () => this.shutdown());
        process.on('SIGINT', () => this.shutdown());
    }

    /**
     * Graceful shutdown сервера
     */
    shutdown() {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        console.log(STARTUP_MESSAGES.SHUTDOWN_START);

        // Закрытие HTTP-сервера
        if (this.server) {
            this.server.close(() => {
                console.log(STARTUP_MESSAGES.SHUTDOWN_COMPLETE);
                process.exit(0);
            });
        }

        // Принудительное завершение по таймауту
        setTimeout(() => {
            console.error(STARTUP_MESSAGES.SHUTDOWN_FORCED);
            process.exit(1);
        }, SHUTDOWN_TIMEOUT);
    }

    /**
     * Проверка, запущен ли файл напрямую (не через require)
     * @returns {boolean} - true если файл запущен напрямую
     */
    isMainModule() {
        return require.main === module;
    }
}

// Инициализация сервиса
const serverLifecycleService = new ServerLifecycleService();

// -----------------------------
// Global Error Handler Service
// -----------------------------

/**
 * Сервис для обработки глобальных необработанных ошибок
 */
class GlobalErrorHandlerService {
    /**
     * Регистрация глобальных обработчиков ошибок
     */
    registerHandlers() {
        this.handleUncaughtException();
        this.handleUnhandledRejection();
    }

    /**
     * Обработка неперехваченных исключений
     */
    handleUncaughtException() {
        process.on('uncaughtException', (err) => {
            console.error(LOG_PREFIXES.UNCAUGHT_EXCEPTION, err);
            process.exit(1);
        });
    }

    /**
     * Обработка необработанных отклонений промисов
     */
    handleUnhandledRejection() {
        process.on('unhandledRejection', (reason, promise) => {
            console.error(LOG_PREFIXES.UNHANDLED_REJECTION, reason);
            process.exit(1);
        });
    }
}

// Инициализация сервиса
const globalErrorHandlerService = new GlobalErrorHandlerService();


// -----------------------------
// Error Handling Middleware
// -----------------------------

/**
 * Middleware для обработки 404 (Not Found) ошибок
 * Срабатывает, когда ни один маршрут не совпал
 */
app.use((req, res) => {
    errorHandlerService.handleNotFound(req, res);
});

/**
 * Middleware для обработки общих ошибок сервера
 * Срабатывает при вызове next(err) в любом маршруте
 */
app.use((err, req, res, next) => {
    errorHandlerService.handleError(err, req, res, next);
});

// -----------------------------
// Route: Categories
// -----------------------------

/**
 * GET /api/categories — получение метаданных всех категорий
 */
app.get('/api/categories', (req, res) => {
    res.json(CategoryMetadata.DATA);
});

// -----------------------------
// Application Initialization
// -----------------------------

/**
 * Инициализация приложения
 * Выполняется при загрузке модуля
 */
const initializeApplication = () => {
    // Проверка критических переменных окружения
    startupValidatorService.validateEnvironment();

    // Регистрация глобальных обработчиков ошибок
    globalErrorHandlerService.registerHandlers();

    // Запуск сервера только при прямом запуске (не в serverless)
    if (serverLifecycleService.isMainModule()) {
        serverLifecycleService.start(app, PORT);
    }
};

// Запуск инициализации
initializeApplication();

// -----------------------------
// Экспорт приложения для Vercel Serverless
// -----------------------------

/**
 * Экспорт Express-приложения для использования в Vercel Serverless
 * В serverless-окружении сервер не запускается, обрабатываются только запросы
 */
module.exports = app;