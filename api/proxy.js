const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const helmet = require('helmet');
const morgan = require('morgan');
const crypto = require('crypto');
const newsRouter = require('../news');

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

// YouTube Config
const YOUTUBE_HANDLE = 'MRPakeleksis';

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
            connectSrc: ["'self'", "https://api.github.com", "https://www.youtube.com", "https://api.telegram.org"],
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

    for (const block of blocks) {
        const lines = block
            .trim()
            .split('\n')
            .map(l => l.trim())
            .filter(l => l);

        if (lines.length < 3) continue;

        const clean = (str) => {
            let s = str.split('@:')[0].trim();
            // Убираем кавычки по краям
            if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
                s = s.slice(1, -1);
            }
            return s.trim();
        };

        const title = clean(lines[0]);
        let url = clean(lines[1]);
        const desc = clean(lines[2]);

        // Нормализация и валидация URL
        url = normalizeUrl(url);
        if (!isValidUrl(url)) {
            console.warn(`[parseSaites] Invalid URL skipped: ${url}`);
            continue;
        }

        if (title && url && desc) {
            sites.push({ title, url, desc });
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
// YouTube Integration
// -----------------------------

async function getYouTubeChannelId() {
    const response = await fetchWithRetry(`https://www.youtube.com/@${YOUTUBE_HANDLE}`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
    });

    if (!response.ok) {
        throw new Error(`YouTube page responded ${response.status}`);
    }

    const html = await response.text();

    const extractMeta = (property) => {
        const match = html.match(new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'))
                   || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i'));
        return match ? match[1] : null;
    };

    const canonical = (() => {
        const m = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
        return m ? m[1] : null;
    })();

    const channelIdMatch = canonical ? canonical.match(/\/channel\/(UC[\w-]+)/) : null;
    const channelId = channelIdMatch ? channelIdMatch[1] : null;

    let subscribers = null;
    const ytDataMatch = html.match(/var ytInitialData = ({.+?});<\/script>/s);
    if (ytDataMatch) {
        try {
            const metadataStr = ytDataMatch[1];
            const subMatch = metadataStr.match(/"subscriberCountText":\{"simpleText":"([^"]+)"/);
            if (subMatch) subscribers = subMatch[1];
        } catch (e) {
            console.warn('[YouTube] Failed to parse subscribers:', e);
        }
    }

    return {
        handle: `@${YOUTUBE_HANDLE}`,
        name: extractMeta('og:title') || YOUTUBE_HANDLE,
        description: extractMeta('og:description') || '',
        avatar: extractMeta('og:image') || '',
        channelId: channelId,
        subscribers: subscribers || '—',
        url: `https://www.youtube.com/@${YOUTUBE_HANDLE}`
    };
}

function decodeXmlEntities(str) {
    if (!str) return '';
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'");
}

app.get('/api/youtube/channel', async (req, res, next) => {
    try {
        const now = Date.now();
        if (ytChannelCache.data && (now - ytChannelCache.timestamp) < YT_CACHE_TTL) {
            return res.json(ytChannelCache.data);
        }

        const channelData = await getYouTubeChannelId();
        ytChannelCache = { data: channelData, timestamp: now };
        res.json(channelData);
    } catch (err) {
        console.error('[youtube/channel]', err.message);
        // Возвращаем кэш при ошибке если есть
        if (ytChannelCache.data) {
            return res.json(ytChannelCache.data);
        }
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/youtube/videos', async (req, res, next) => {
    try {
        const now = Date.now();
        if (ytVideosCache.data && (now - ytVideosCache.timestamp) < YT_CACHE_TTL) {
            return res.json(ytVideosCache.data);
        }

        let channelId = ytChannelCache.data?.channelId;
        
        if (!channelId) {
            const channelData = await getYouTubeChannelId();
            ytChannelCache = { data: channelData, timestamp: now };
            channelId = channelData.channelId;
        }

        if (!channelId) {
            return res.status(404).json({ error: 'Channel ID not found. Проверьте YOUTUBE_HANDLE.' });
        }

        const rssRes = await fetchWithRetry(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!rssRes.ok) {
            const errText = await rssRes.text().catch(() => '');
            throw new Error(`RSS feed failed: ${rssRes.status} — ${errText.slice(0, 200)}`);
        }
        
        const xml = await rssRes.text();
        const videos = [];
        const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
        let entryMatch;
        
        while ((entryMatch = entryRegex.exec(xml)) !== null) {
            const entry = entryMatch[1];
            
            const getTag = (tag) => {
                const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
                return m ? m[1].trim() : null;
            };

            const videoId = getTag('yt:videoId');
            const title = getTag('title');
            const published = getTag('published');
            const authorName = getTag('name');
            
            const viewsMatch = entry.match(/<media:statistics[^>]+views=["'](\d+)["']/i);
            const views = viewsMatch ? parseInt(viewsMatch[1]) : 0;

            if (videoId && title) {
                videos.push({
                    id: videoId,
                    title: decodeXmlEntities(title),
                    published: published,
                    author: decodeXmlEntities(authorName || ''),
                    views: views,
                    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                    thumbnailMaxRes: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
                    url: `https://www.youtube.com/watch?v=${videoId}`
                });
            }
        }

        console.log(`[youtube/videos] Loaded ${videos.length} videos for channel ${channelId}`);
        ytVideosCache = { data: videos, timestamp: now };
        res.json(videos);
    } catch (err) {
        console.error('[youtube/videos]', err.message);
        // Возвращаем кэш при ошибке если есть
        if (ytVideosCache.data) {
            return res.json(ytVideosCache.data);
        }
        res.status(500).json({ error: err.message });
    }
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

// -----------------------------
// Экспорт приложения для Vercel Serverless
// -----------------------------
module.exports = app;