const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const helmet = require('helmet');
const morgan = require('morgan');
const crypto = require('crypto');
const newsRouter = require('./news');

// -----------------------------
// Конфигурация и Безопасность
// -----------------------------
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SAITES_FILE = process.env.SAITES_FILE || path.join(__dirname, 'saites.txt');
const CHANGELOG_FILE = process.env.CHANGELOG_FILE || path.join(__dirname, 'changelog.txt');

// GitHub API Config
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'Oris';
const GITHUB_SAITES_PATH = process.env.GITHUB_SAITES_PATH || 'saites.txt';
const GITHUB_CHANGELOG_PATH = process.env.GITHUB_CHANGELOG_PATH || 'changelog.txt';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const CACHE_TTL = 5 * 60 * 1000; // 5 минут

// Проверка критических переменных окружения при старте
if (!ADMIN_TOKEN) {
    console.warn('⚠️ WARNING: ADMIN_TOKEN is not set. Admin panel will be inaccessible.');
}

// -----------------------------
// Инициализация Express
// -----------------------------
const app = express();

// Security Headers (Helmet)
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://fonts.googleapis.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
            imgSrc: ["'self'", "data:", "blob:"],
            connectSrc: ["'self'", "https://api.github.com"],
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

// Rate Limiting (Simple implementation for single instance)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 60; // requests per window

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

// Cleanup rate limit map periodically
setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of rateLimitMap.entries()) {
        if (now > record.resetTime) rateLimitMap.delete(ip);
    }
}, 60 * 1000);

app.use(morgan('tiny'));
app.use(express.json({ limit: '1mb' })); // Limit body size
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

/**
 * Безопасный парсинг saites.txt
 */
function parseSaites(content) {
    if (typeof content !== 'string') return [];
    
    const blocks = content.split('::').filter(b => b.trim());
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
            if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
                s = s.slice(1, -1);
            }
            return s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        };

        const title = clean(lines[0]);
        let url = clean(lines[1]);
        const desc = clean(lines[2]);

        try {
            if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
            new URL(url);
        } catch (e) {
            console.warn(`Invalid URL skipped: ${url}`);
            continue;
        }

        if (title && url && desc) sites.push({ title, url, desc });
    }
    return sites;
}

/**
 * Парсинг changelog.txt
 * Формат: Версия | Дата \n - [тип] описание \n ::
 */
function parseChangelog(content) {
    if (!content) return [];
    const blocks = content.split('::').filter(b => b.trim());
    
    return blocks.map(block => {
        const lines = block.trim().split('\n').map(l => l.trim()).filter(l => l);
        if (lines.length === 0) return null;

        const headerLine = lines[0];
        const [version, date] = headerLine.includes('|') 
            ? headerLine.split('|').map(s => s.trim()) 
            : [headerLine, ''];

        const changes = lines.slice(1).map(line => {
            const match = line.match(/^-\s*\[(\w+)\]\s*(.*)$/);
            if (match) return { type: match[1].toLowerCase(), text: match[2] };
            return { type: 'default', text: line.replace(/^-\s*/, '') };
        });

        return { version, date, changes };
    }).filter(Boolean);
}

/**
 * Универсальное получение содержимого файла (GitHub или локально)
 */
async function fetchFileContent(filePath, gitPath) {
    if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
        try {
            const raw = await fs.readFile(filePath, 'utf8');
            return { content: raw, sha: null };
        } catch (err) {
            if (err.code === 'ENOENT') return { content: '', sha: null };
            throw err;
        }
    }

    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${gitPath}?ref=${GITHUB_BRANCH}`;
    const res = await fetch(url, {
        headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'Oris-Server/1.0'
        },
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`GitHub fetch failed: ${res.status} ${res.statusText} - ${errText}`);
    }

    const data = await res.json();
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return { content, sha: data.sha };
}

/**
 * Загрузка сайтов с кэшированием
 */
async function loadSites() {
    const now = Date.now();
    if (sitesCache.data.length && (now - sitesCache.timestamp) < CACHE_TTL) {
        return sitesCache.data;
    }

    const { content } = await fetchFileContent(SAITES_FILE, GITHUB_SAITES_PATH);
    const data = parseSaites(content);
    sitesCache = { data, timestamp: now };
    console.log(`[Cache] Sites updated: ${data.length} loaded`);
    return data;
}

/**
 * Обновление файла через GitHub API
 */
async function updateFileViaGitHub(newContent, sha, gitPath, commitMsg) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${gitPath}`;
    const body = {
        message: commitMsg,
        content: Buffer.from(newContent, 'utf8').toString('base64'),
        branch: GITHUB_BRANCH,
        sha,
    };

    const res = await fetch(url, {
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

// -----------------------------
// Middleware проверки токена
// -----------------------------
function verifyAdminToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: Missing token' });
    }

    const token = authHeader.split(' ')[1];
    
    if (!ADMIN_TOKEN || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN))) {
        return res.status(403).json({ error: 'Forbidden: Invalid token' });
    }

    next();
}

// -----------------------------
// Маршруты API: Sites
// -----------------------------

app.get('/api/sites', async (req, res, next) => {
    try {
        const sites = await loadSites();
        res.json(sites);
    } catch (err) { next(err); }
});

app.post('/api/sites/reload', async (req, res, next) => {
    try {
        sitesCache.data = [];
        sitesCache.timestamp = 0;
        const sites = await loadSites();
        res.json({ success: true, count: sites.length });
    } catch (err) { next(err); }
});

// -----------------------------
// Маршруты API: Changelog
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
    } catch (err) { next(err); }
});

// -----------------------------
// Маршруты API: Admin
// -----------------------------

// Получение контента (sites или changelog)
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

// Сохранение контента
async function handleSave(req, res, next, filePath, gitPath, cacheRef, commitMsg) {
    try {
        const { content } = req.body;
        
        if (typeof content !== 'string') {
            return res.status(400).json({ error: 'Content must be a string' });
        }
        
        if (content.length > 500000) {
            return res.status(413).json({ error: 'Content too large' });
        }

        if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
            await fs.writeFile(filePath, content, 'utf8');
        } else {
            const { sha } = await fetchFileContent(filePath, gitPath);
            await updateFileViaGitHub(content, sha, gitPath, commitMsg);
        }

        // Инвалидация соответствующего кэша
        if (cacheRef === 'sites') {
            sitesCache.data = [];
            sitesCache.timestamp = 0;
        } else if (cacheRef === 'changelog') {
            changelogCache.data = null;
            changelogCache.timestamp = 0;
        }
        
        res.json({ success: true, message: `Saved (${GITHUB_TOKEN ? 'GitHub' : 'Local'})` });
    } catch (err) { next(err); }
}

app.post('/api/admin/save', verifyAdminToken, (req, res, next) => {
    handleSave(req, res, next, SAITES_FILE, GITHUB_SAITES_PATH, 'sites', 'chore: update saites.txt via admin');
});

app.post('/api/admin/changelog/save', verifyAdminToken, (req, res, next) => {
    handleSave(req, res, next, CHANGELOG_FILE, GITHUB_CHANGELOG_PATH, 'changelog', 'docs: update changelog via admin');
});

// -----------------------------
// Статические страницы и ошибки
// -----------------------------

app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
        if (err) res.status(404).send('Page not found');
    });
});

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
// Запуск сервера
// -----------------------------
const server = app.listen(PORT, () => {
    console.log(`🚀 Oris Server running on port ${PORT}`);
    console.log(`🔒 Security: Helmet enabled, Rate limiting active`);
    console.log(`💾 Storage: ${GITHUB_TOKEN ? 'GitHub API' : 'Local Filesystem'}`);
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