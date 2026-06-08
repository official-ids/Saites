const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const helmet = require('helmet');
const morgan = require('morgan');
const crypto = require('crypto');
const newsRouter = require('../news');
const supportRouter = require('../support');
const downloaderRouter = require('../downloader');
const redirectsRouter = require('../redirects');
const { kv } = require('@vercel/kv');

// -----------------------------
// Константы и Конфигурация
// -----------------------------
const PORT = process.env.PORT || 3000;

// Пути скорректированы для расположения в api/
// __dirname теперь указывает на /api, поэтому добавляем ..
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SAITES_FILE = process.env.SAITES_FILE || path.join(__dirname, '..', 'saites.txt');
const CHANGELOG_FILE = process.env.CHANGELOG_FILE || path.join(__dirname, '..', 'changelog.txt');

// GitHub API Config
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'Oris';
const GITHUB_SAITES_PATH = process.env.GITHUB_SAITES_PATH || 'saites.txt';
const GITHUB_CHANGELOG_PATH = process.env.GITHUB_CHANGELOG_PATH || 'changelog.txt';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

// Telegram Config (без fallback-значения)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;


// Timeouts & Retries
const FETCH_TIMEOUT = 10000; // 10 секунд
const FETCH_MAX_RETRIES = 3;
const CACHE_TTL = 5 * 60 * 1000; // 5 минут
const YT_CACHE_TTL = 5 * 60 * 1000;

// Rate Limiting Config
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 60;
const FORM_COOLDOWN = 30 * 1000;

// Validation Limits
const MAX_CONTENT_LENGTH = 500000;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 1000;
const MIN_TITLE_LENGTH = 3;
const MIN_DESCRIPTION_LENGTH = 20;

const CATEGORY_META = {
    tools:      { label: 'Инструменты',    icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z', color: '#FF9F0A' },
    dev:        { label: 'Для разработчиков', icon: 'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4', color: '#0071E3' },
    design:     { label: 'Дизайн',          icon: 'M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01', color: '#AF52DE' },
    education:  { label: 'Образование',     icon: 'M12 14l9-5-9-5-9 5 9 5z M12 14l6.16-3.422a12.083 12.083 0 01.665 6.479A11.952 11.952 0 0012 20.055a11.952 11.952 0 00-6.824-2.998 12.078 12.078 0 01.665-6.479L12 14z', color: '#34C759' },
    games:      { label: 'Игры',            icon: 'M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z M21 12a9 9 0 11-18 0 9 9 0 0118 0z', color: '#FF3B30' },
    media:      { label: 'Медиа',           icon: 'M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z', color: '#FF9F0A' },
    social:     { label: 'Соцсети',         icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z', color: '#5E5CE6' },
    other:      { label: 'Другое',          icon: 'M5 12h.01M12 12h.01M19 12h.01M6 12a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0z', color: '#8E8E93' }
};

// -----------------------------
// Инициализация Express
// -----------------------------
const app = express();

// Security Headers (Helmet)
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'", 
                "'unsafe-inline'", 
                "https://cdn.tailwindcss.com", 
                "https://fonts.googleapis.com",
                "https://unpkg.com",
                "https://cdnjs.cloudflare.com"
            ],
            styleSrc: [
                "'self'", 
                "'unsafe-inline'", 
                "https://fonts.googleapis.com",
                "https://cdnjs.cloudflare.com"
            ],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "data:", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "blob:", "https://i.ytimg.com", "https://yt3.ggpht.com", "https://yt3.googleusercontent.com"],
            connectSrc: [
    "'self'", 
    "https://api.github.com", 
    "https://www.youtube.com", 
    "https://api.telegram.org", 
    "wss://0.peerjs.com", 
    "wss://1.peerjs.com", 
    "wss://*.peerjs.com", 
    "https://*.peerjs.com",
    "https://*.railway.app",
    "wss://*.railway.app",
    "https://*.onrender.com",
    "wss://*.onrender.com",
    "https://*.glitch.me",
    "wss://*.glitch.me"
],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"]
        }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: { policy: "same-origin" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" }
}));

// -----------------------------
// Вспомогательные функции
// -----------------------------

/**
 * Fetch с таймаутом и повторными попытками
 */
async function fetchWithRetry(url, options = {}, retries = FETCH_MAX_RETRIES) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeout);
        return response;
    } catch (error) {
        clearTimeout(timeout);
        if (retries > 0 && (error.name === 'AbortError' || error.name === 'FetchError')) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            return fetchWithRetry(url, options, retries - 1);
        }
        throw error;
    }
}

/**
 * Безопасная очистка строки для HTML-контекста
 * Примечание: экранирование должно выполняться на клиенте.
 * Эта функция только удаляет опасные символы для предотвращения инъекций.
 */
function sanitize(str) {
    if (!str) return '';
    return String(str)
        .replace(/[<>]/g, '') // Удаляем теги полностью
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .trim();
}

/**
 * Валидация URL
 */
function isValidUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Нормализация URL (добавление https:// если нет протокола)
 */
function normalizeUrl(url) {
    if (!url) return url;
    const trimmed = url.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
}

// -----------------------------
// Rate Limiting Middleware
// -----------------------------
const rateLimitMap = new Map();

app.use((req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    
    if (!rateLimitMap.has(ip)) {
        rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
        return next();
    }

    const record = rateLimitMap.get(ip);
    if (now > record.resetTime) {
        record.count = 1;
        record.resetTime = now + RATE_LIMIT_WINDOW;
        return next();
    }

    if (record.count >= RATE_LIMIT_MAX) {
        return res.status(429).json({ error: 'Too many requests, please try again later.' });
    }

    record.count++;
    next();
});

// Очистка rate limit map
setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of rateLimitMap.entries()) {
        if (now > record.resetTime) rateLimitMap.delete(ip);
    }
}, 60 * 1000);

// -----------------------------
// Middleware
// -----------------------------
app.use(morgan('tiny'));
app.use(express.json({ limit: '1mb' }));
app.use('/api/news', newsRouter);
app.use('/go', redirectsRouter);
app.use('/api/redirects', redirectsRouter);
app.use('/api/support', supportRouter);
app.use('/api/downloader', downloaderRouter);
app.use(express.static(PUBLIC_DIR, {
    maxAge: '1d', 
    etag: true,
    setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
    }
}));

// -----------------------------
// Кэш и Данные
// -----------------------------
let sitesCache = { data: [], timestamp: 0 };
let changelogCache = { data: null, timestamp: 0 };
let ytChannelCache = { data: null, timestamp: 0 };
let ytVideosCache = { data: null, timestamp: 0 };

// Rate limit для форм
const formRateLimitMap = new Map();

function checkFormRateLimit(ip) {
    const now = Date.now();
    const last = formRateLimitMap.get(ip);
    if (last && (now - last) < FORM_COOLDOWN) {
        return Math.ceil((FORM_COOLDOWN - (now - last)) / 1000);
    }
    formRateLimitMap.set(ip, now);
    return 0;
}

// -----------------------------
// Парсеры
// -----------------------------

function parseSaites(content) {
    if (typeof content !== 'string') return [];
    const blocks = content.split('::').filter(b => b?.trim());
    const sites = [];
    const VALID_CATEGORIES = ['tools', 'dev', 'design', 'education', 'games', 'media', 'social', 'other'];

    for (const block of blocks) {
        const lines = block
            .trim()
            .split('\n')
            .map(l => l.trim())
            .filter(l => l);

        if (lines.length < 3) continue;

        const clean = (str) => {
            let s = str.split('@:')[0].trim();
            if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
                s = s.slice(1, -1);
            }
            return s.trim();
        };

        const title = clean(lines[0]);
        let url = clean(lines[1]);
        const desc = clean(lines[2]);
        
        // Опциональная 4-я строка — категория
        let category = 'other';
        if (lines.length >= 4) {
            const rawCat = clean(lines[3]).toLowerCase();
            if (VALID_CATEGORIES.includes(rawCat)) {
                category = rawCat;
            }
        }

        url = normalizeUrl(url);
        if (!isValidUrl(url)) {
            console.warn(`[parseSaites] Invalid URL skipped: ${url}`);
            continue;
        }

        if (title && url && desc) {
            sites.push({ title, url, desc, category });
        }
    }
    return sites;
}

function parseChangelog(content) {
    if (!content || typeof content !== 'string') return [];
    
    const blocks = content.split('::').filter(b => b?.trim());
    
    return blocks.map(block => {
        const lines = block.trim().split('\n').map(l => l.trim()).filter(l => l);
        if (lines.length === 0) return null;

        const headerLine = lines[0];
        const [version, date] = headerLine.includes('|') 
            ? headerLine.split('|').map(s => s.trim()) 
            : [headerLine, ''];

        const changes = lines.slice(1).map(line => {
            const match = line.match(/^-\s*\[(\w+)\]\s*(.*)$/);
            if (match) {
                return { type: match[1].toLowerCase(), text: match[2].trim() };
            }
            return { type: 'default', text: line.replace(/^-\s*/, '').trim() };
        });

        return { 
            version: version?.trim(), 
            date: date?.trim() || '', 
            changes: changes.filter(c => c.text)
        };
    }).filter(Boolean);
}

// -----------------------------
// GitHub Integration
// -----------------------------

async function fetchFileContent(filePath, gitPath) {
    // Локальный режим
    if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
        try {
            const raw = await fs.readFile(filePath, 'utf8');
            return { content: raw, sha: null };
        } catch (err) {
            if (err.code === 'ENOENT') return { content: '', sha: null };
            throw err;
        }
    }

    // GitHub режим с повторными попытками
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${gitPath}?ref=${GITHUB_BRANCH}`;
    
    const res = await fetchWithRetry(url, {
        headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'Oris-Server/1.0'
        },
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => 'Unknown error');
        throw new Error(`GitHub fetch failed: ${res.status} ${res.statusText} - ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return { content, sha: data.sha };
}

async function updateFileViaGitHub(newContent, sha, gitPath, commitMsg) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${gitPath}`;
    const body = {
        message: commitMsg,
        content: Buffer.from(newContent, 'utf8').toString('base64'),
        branch: GITHUB_BRANCH,
        sha,
    };

    const res = await fetchWithRetry(url, {
        method: 'PUT',
        headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'User-Agent': 'Oris-Server/1.0'
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`GitHub update failed: ${res.status} - ${err.message || 'Unknown error'}`);
    }
    return await res.json();
}

async function loadSites() {
    const now = Date.now();
    // Возвращаем кэш если он актуален
    if (sitesCache.data.length > 0 && (now - sitesCache.timestamp) < CACHE_TTL) {
        return sitesCache.data;
    }

    try {
        const { content } = await fetchFileContent(SAITES_FILE, GITHUB_SAITES_PATH);
        const data = parseSaites(content);
        sitesCache = { data, timestamp: now };
        console.log(`[Cache] Sites updated: ${data.length} loaded`);
        return data;
    } catch (err) {
        console.error('[loadSites] Failed to load sites:', err.message);
        // Возвращаем старый кэш при ошибке, если он есть
        if (sitesCache.data.length > 0) {
            console.log('[loadSites] Using stale cache due to error');
            return sitesCache.data;
        }
        throw err;
    }
}

// -----------------------------
// Admin Token Middleware
// -----------------------------
function verifyAdminToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: Missing token' });
    }

    const token = authHeader.split(' ')[1];
    
    // Безопасное сравнение с проверкой длины
    const isValid = ADMIN_TOKEN 
        && token 
        && token.length === ADMIN_TOKEN.length
        && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN));
    
    if (!isValid) {
        return res.status(403).json({ error: 'Forbidden: Invalid token' });
    }

    next();
}

// -----------------------------
// Telegram Integration
// -----------------------------

async function sendTelegramMessage(text) {
    if (!TELEGRAM_CHAT_ID) {
        console.error('[Telegram] TELEGRAM_CHAT_ID is not set');
        throw new Error('Telegram не настроен');
    }
    if (!TELEGRAM_BOT_TOKEN) {
        console.error('[Telegram] TELEGRAM_BOT_TOKEN is not set');
        throw new Error('Telegram токен не настроен');
    }

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    
    const res = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text: text,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        })
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error('[Telegram] Send failed:', err);
        throw new Error('Не удалось отправить сообщение');
    }
    return await res.json();
}

// Labels для форм
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

const CORP_TYPE_LABELS = {
    partnership: 'Партнёрство',
    advertising: 'Реклама / Спонсорство',
    integration: 'Техническая интеграция',
    content: 'Контент / Публикации',
    other: 'Другое'
};

const BUDGET_LABELS = {
    free: 'Без бюджета',
    small: 'До 50 000 ₽',
    medium: '50 000 — 300 000 ₽',
    large: '300 000 — 1 000 000 ₽',
    enterprise: 'Более 1 000 000 ₽'
};

// -----------------------------
// API Routes: Sites
// -----------------------------

app.get('/api/sites', async (req, res, next) => {
    try {
        const sites = await loadSites();
        res.json(sites);
    } catch (err) { 
        console.error('[GET /api/sites]', err);
        next(err); 
    }
});

app.post('/api/sites/reload', async (req, res, next) => {
    try {
        // Принудительная инвалидация кэша
        sitesCache.data = [];
        sitesCache.timestamp = 0;
        const sites = await loadSites();
        res.json({ success: true, count: sites.length });
    } catch (err) { 
        console.error('[POST /api/sites/reload]', err);
        next(err); 
    }
});

// -----------------------------
// API Routes: Changelog
// -----------------------------

app.get('/api/changelog', async (req, res, next) => {
    try {
        const now = Date.now();
        if (changelogCache.data && (now - changelogCache.timestamp) < CACHE_TTL) {
            return res.json(changelogCache.data);
        }

        const { content } = await fetchFileContent(CHANGELOG_FILE, GITHUB_CHANGELOG_PATH);
        const data = parseChangelog(content);
        
        changelogCache = { data, timestamp: now };
        res.json(data);
    } catch (err) { 
        console.error('[GET /api/changelog]', err);
        next(err); 
    }
});

// -----------------------------
// API Routes: Admin
// -----------------------------

app.get('/api/admin/content', verifyAdminToken, async (req, res, next) => {
    try {
        const { content } = await fetchFileContent(SAITES_FILE, GITHUB_SAITES_PATH);
        res.json({ content });
    } catch (err) { next(err); }
});

app.get('/api/admin/changelog', verifyAdminToken, async (req, res, next) => {
    try {
        const { content } = await fetchFileContent(CHANGELOG_FILE, GITHUB_CHANGELOG_PATH);
        res.json({ content });
    } catch (err) { next(err); }
});

async function handleSave(req, res, next, filePath, gitPath, cacheRef, commitMsg) {
    try {
        const { content } = req.body;
        
        if (typeof content !== 'string') {
            return res.status(400).json({ error: 'Content must be a string' });
        }
        
        if (content.length > MAX_CONTENT_LENGTH) {
            return res.status(413).json({ error: 'Content too large' });
        }

        if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
            await fs.writeFile(filePath, content, 'utf8');
        } else {
            const { sha } = await fetchFileContent(filePath, gitPath);
            await updateFileViaGitHub(content, sha, gitPath, commitMsg);
        }

        // Инвалидация кэша
        if (cacheRef === 'sites') {
            sitesCache.data = [];
            sitesCache.timestamp = 0;
        } else if (cacheRef === 'changelog') {
            changelogCache.data = null;
            changelogCache.timestamp = 0;
        }
        
        res.json({ success: true, message: `Saved (${GITHUB_TOKEN ? 'GitHub' : 'Local'})` });
    } catch (err) { 
        console.error('[handleSave]', err);
        next(err); 
    }
}

app.post('/api/admin/save', verifyAdminToken, (req, res, next) => {
    handleSave(req, res, next, SAITES_FILE, GITHUB_SAITES_PATH, 'sites', 'chore: update saites.txt via admin');
});

app.post('/api/admin/changelog/save', verifyAdminToken, (req, res, next) => {
    handleSave(req, res, next, CHANGELOG_FILE, GITHUB_CHANGELOG_PATH, 'changelog', 'docs: update changelog via admin');
});

// -----------------------------
// API Routes: Dynamic Configs for Status & API (KV)
// -----------------------------
const STATUS_CONFIG_KEY = 'admin:status_config';
const API_CONFIG_KEY = 'admin:api_config';

// ⚠️ ВНИМАНИЕ: сюда скопируйте реальные массивы из ваших HTML-файлов!
// 1. Из status.html возьмите массив SERVICES (от const SERVICES = [ ... ];)
// 2. Из api.html возьмите массив API_SECTIONS (от const API_SECTIONS = [ ... ];)

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
                details: 'Возвращает посты, отсортированные по дате (новые сверху). Поддерживает пагинацию. Для аутентифицированных пользователей добавляются флаги isLiked/isFavorited.',
                params: [
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

app.post('/api/add/saite', async (req, res, next) => {
    try {
        const waitSeconds = checkFormRateLimit(req.ip);
        if (waitSeconds > 0) {
            return res.status(429).json({
                error: `Подождите ${waitSeconds} сек. перед следующей заявкой`
            });
        }

        const { title, url, description, category, authorName, email, telegram } = req.body;

        // Валидация
        if (!title || title.trim().length < MIN_TITLE_LENGTH) {
            return res.status(400).json({ error: 'Название должно содержать минимум 3 символа' });
        }
        if (!url || !isValidUrl(normalizeUrl(url))) {
            return res.status(400).json({ error: 'Некорректный URL' });
        }
        if (!description || description.trim().length < MIN_DESCRIPTION_LENGTH) {
            return res.status(400).json({ error: 'Описание слишком короткое (минимум 20 символов)' });
        }
        if (!authorName || authorName.trim().length < 2) {
            return res.status(400).json({ error: 'Укажите имя' });
        }
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Некорректный email' });
        }

        // Формирование сообщения (данные не экранируются сервером, клиент должен делать это при отображении)
        const message =
`🌐 <b>НОВАЯ ЗАЯВКА: Добавление сайта</b>

<b>Название:</b> ${title}
<b>URL:</b> ${normalizeUrl(url)}
<b>Категория:</b> ${CATEGORY_LABELS[category] || 'Другое'}

<b>Описание:</b>
${description}

━━━━━━━━━━━━━━━━━

<b>Контакты:</b>
👤 ${authorName}
📧 ${email}${telegram ? `\n💬 ${telegram}` : ''}

🕐 ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`;

        await sendTelegramMessage(message);

        res.json({ success: true, message: 'Заявка отправлена' });
    } catch (err) {
        console.error('[api/add/saite]', err);
        next(err);
    }
});

app.post('/api/add/corp', async (req, res, next) => {
    try {
        const waitSeconds = checkFormRateLimit(req.ip);
        if (waitSeconds > 0) {
            return res.status(429).json({
                error: `Подождите ${waitSeconds} сек. перед следующей заявкой`
            });
        }

        const { name, company, email, telegram, type, message, budget, website } = req.body;

        // Валидация
        if (!name || name.trim().length < 2) {
            return res.status(400).json({ error: 'Укажите имя' });
        }
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Некорректный email' });
        }
        if (!type || !CORP_TYPE_LABELS[type]) {
            return res.status(400).json({ error: 'Выберите тип сотрудничества' });
        }
        if (!message || message.trim().length < MIN_DESCRIPTION_LENGTH) {
            return res.status(400).json({ error: 'Сообщение слишком короткое (минимум 20 символов)' });
        }
        if (website && !isValidUrl(normalizeUrl(website))) {
            return res.status(400).json({ error: 'Некорректный URL сайта' });
        }

        // Формирование сообщения
        const tgMessage =
`🤝 <b>НОВАЯ ЗАЯВКА: Сотрудничество</b>

<b>Тип:</b> ${CORP_TYPE_LABELS[type]}
${budget && BUDGET_LABELS[budget] ? `<b>Бюджет:</b> ${BUDGET_LABELS[budget]}` : ''}

<b>От кого:</b>
👤 ${name}${company ? `\n🏢 ${company}` : ''}${website ? `\n🌐 ${normalizeUrl(website)}` : ''}

<b>Сообщение:</b>
${message}

━━━━━━━━━━━━━━━━━

<b>Контакты:</b>
📧 ${email}${telegram ? `\n💬 ${telegram}` : ''}

🕐 ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`;

        await sendTelegramMessage(tgMessage);

        res.json({ success: true, message: 'Заявка отправлена' });
    } catch (err) {
        console.error('[api/add/corp]', err);
        next(err);
    }
});


// -----------------------------
// API Routes: Call (WebRTC)
// -----------------------------

// Хранилище активных комнат (in-memory, сбрасывается при холодном старте)
const activeRooms = new Map();
const ROOM_TTL = 4 * 60 * 60 * 1000; // 4 часа

// Очистка устаревших комнат каждые 10 минут
setInterval(() => {
    const now = Date.now();
    for (const [id, room] of activeRooms.entries()) {
        if (now - room.createdAt > ROOM_TTL) {
            activeRooms.delete(id);
        }
    }
}, 10 * 60 * 1000);

/**
 * Генерация читаемого ID комнаты (без I, O, 0, 1)
 */
function generateCallRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * GET /call — отдаём HTML-страницу звонка
 * (дублирует express.static, но явно и с нужными заголовками)
 */
app.get('/call', (req, res) => {
    const filePath = path.join(PUBLIC_DIR, 'call', 'index.html');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), autoplay=(self), display-capture=(self)');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(filePath, (err) => {
        if (err) {
            res.status(404).json({ error: 'Call page not found' });
        }
    });
});

/**
 * GET /call/:id — вход в комнату по ID (для share-ссылок)
 */
app.get('/call/:id', (req, res) => {
    const roomId = req.params.id.toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(roomId)) {
        return res.status(400).json({ error: 'Invalid room ID' });
    }
    const filePath = path.join(PUBLIC_DIR, 'call', 'index.html');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), autoplay=(self), display-capture=(self)');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(filePath);
});

/**
 * POST /api/call/room — создать новую комнату
 * Возвращает уникальный ID, который гарантированно не занят
 */
app.post('/api/call/room', (req, res) => {
    try {
        let roomId;
        let attempts = 0;
        do {
            roomId = generateCallRoomId();
            attempts++;
            if (attempts > 10) {
                return res.status(500).json({ error: 'Could not generate unique room ID' });
            }
        } while (activeRooms.has(roomId));

        activeRooms.set(roomId, {
            createdAt: Date.now(),
            participants: 0
        });

        res.json({ roomId, expiresAt: Date.now() + ROOM_TTL });
    } catch (err) {
        console.error('[POST /api/call/room]', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/call/check/:id — проверить, существует ли комната
 * Используется клиентом перед попыткой подключения
 */
app.get('/api/call/check/:id', (req, res) => {
    const roomId = req.params.id.toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(roomId)) {
        return res.status(400).json({ error: 'Invalid room ID' });
    }
    const room = activeRooms.get(roomId);
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
    if (!roomId || !/^[A-Z0-9]{6}$/.test(roomId)) {
        return res.status(400).json({ error: 'Invalid room ID' });
    }
    const room = activeRooms.get(roomId);
    if (!room) {
        return res.status(404).json({ error: 'Room not found or expired' });
    }
    room.participants = Math.min((room.participants || 0) + 1, 2);
    res.json({ success: true, participants: room.participants });
});

/**
 * POST /api/call/leave — отметить выход из комнаты
 */
app.post('/api/call/leave', (req, res) => {
    const { roomId } = req.body;
    if (!roomId) return res.status(400).json({ error: 'roomId required' });
    const room = activeRooms.get(roomId);
    if (room) {
        room.participants = Math.max((room.participants || 0) - 1, 0);
        if (room.participants === 0) {
            activeRooms.delete(roomId);
        }
    }
    res.json({ success: true });
});

// -----------------------------
// Error Handling & 404
// -----------------------------

app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
    console.error('[Error]', err.stack || err);
    const isDev = process.env.NODE_ENV !== 'production';
    res.status(err.status || 500).json({ 
        error: isDev ? err.message : 'Internal server error' 
    });
});

// -----------------------------
// Server Startup & Shutdown
// -----------------------------

// Проверка критических переменных при старте
if (!ADMIN_TOKEN) {
    console.warn('WARNING: ADMIN_TOKEN is not set. Admin panel will be inaccessible.');
}

// Разделение локальной и serverless-среды
if (require.main === module) {
    // Локальный запуск (node proxy.js)
    const server = app.listen(PORT, () => {
        console.log(`Oris Server running on port ${PORT}`);
        console.log(`Security: Helmet enabled, Rate limiting active`);
        console.log(`Storage: ${GITHUB_TOKEN ? 'GitHub API' : 'Local Filesystem'}`);
    });

    const shutdown = () => {
        console.log('\nShutting down gracefully...');
        server.close(() => {
            console.log('Server closed');
            process.exit(0);
        });
        setTimeout(() => {
            console.error('Forced shutdown');
            process.exit(1);
        }, 10000);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

// Глобальные обработчики ошибок
process.on('uncaughtException', (err) => {
    console.error('[Uncaught Exception]', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[Unhandled Rejection]', reason);
    process.exit(1);
});

app.get('/api/categories', (req, res) => {
    res.json(CATEGORY_META);
});


// -----------------------------
// Экспорт приложения для Vercel Serverless
// -----------------------------
module.exports = app;