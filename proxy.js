const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const helmet = require('helmet');
const morgan = require('morgan');

// -----------------------------
// Конфигурация
// -----------------------------
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SAITES_FILE = process.env.SAITES_FILE || path.join(__dirname, 'saites.txt');

// GitHub API
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'Oris';
const GITHUB_PATH = process.env.GITHUB_PATH || 'saites.txt';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const CACHE_TTL = 5 * 60 * 1000;

// -----------------------------
// Инициализация приложения
// -----------------------------
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('tiny'));
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// -----------------------------
// Кэш
// -----------------------------
let sitesCache = {
    data: [],
    timestamp: 0,
};

/**
 * Парсинг saites.txt
 */
function parseSaites(content) {
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
            return s;
        };

        const title = clean(lines[0]);
        let url = clean(lines[1]);
        const desc = clean(lines[2]);

        if (url && !/^https?:\/\//i.test(url)) {
            url = 'https://' + url;
        }

        if (title && url && desc) {
            sites.push({ title, url, desc });
        }
    }
    return sites;
}

/**
 * Получить текущее содержимое файла (GitHub или локально)
 */
async function fetchFileContent() {
    if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
        const raw = await fs.readFile(SAITES_FILE, 'utf8');
        return { content: raw, sha: null };
    }

    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_PATH}?ref=${GITHUB_BRANCH}`;
    const res = await fetch(url, {
        headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
        },
    });

    if (!res.ok) {
        throw new Error(`GitHub fetch failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return { content, sha: data.sha };
}

/**
 * Загрузить данные с кэшированием
 */
async function loadSites() {
    const now = Date.now();
    if (sitesCache.data.length && (now - sitesCache.timestamp) < CACHE_TTL) {
        return sitesCache.data;
    }

    const { content } = await fetchFileContent();
    const data = parseSaites(content);
    sitesCache = { data, timestamp: now };
    console.log(`Cache updated: ${data.length} sites loaded`);
    return data;
}

/**
 * Обновить файл через GitHub API
 */
async function updateFileViaGitHub(newContent, sha) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_PATH}`;
    const body = {
        message: 'Update saites.txt via admin panel',
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
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const err = await res.json();
        throw new Error(`GitHub update failed: ${res.status} - ${err.message}`);
    }
    return await res.json();
}

// -----------------------------
// Маршруты
// -----------------------------

app.get('/api/sites', async (req, res, next) => {
    try {
        const sites = await loadSites();
        res.json(sites);
    } catch (err) {
        next(err);
    }
});

// Принудительное обновление кэша
app.post('/api/sites/reload', async (req, res, next) => {
    try {
        sitesCache.data = [];
        const sites = await loadSites();
        res.json({ success: true, count: sites.length });
    } catch (err) {
        next(err);
    }
});

// Админ-сохранение
app.post('/api/admin/save', async (req, res, next) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const { content } = req.body;
        if (typeof content !== 'string' || !content.trim()) {
            return res.status(400).json({ error: 'Content is required' });
        }

        if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
            // Локальное сохранение
            await fs.writeFile(SAITES_FILE, content, 'utf8');
            sitesCache.data = []; // инвалидируем кэш
            return res.json({ success: true, message: 'Saved locally' });
        }

        // Получаем sha текущего файла
        const { sha } = await fetchFileContent();
        await updateFileViaGitHub(content, sha);

        // Инвалидация кэша
        sitesCache.data = [];
        res.json({ success: true, message: 'Saved to GitHub' });
    } catch (err) {
        next(err);
    }
});

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
        if (err) res.status(404).send('Page not found');
    });
});

// Админ: получить сырое содержимое saites.txt
app.get('/api/admin/content', async (req, res, next) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const { content } = await fetchFileContent();
        res.json({ content });
    } catch (err) {
        next(err);
    }
});

// 404
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// Центральный обработчик ошибок
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// -----------------------------
// Запуск
// -----------------------------
const server = app.listen(PORT, () => {
    console.log(`Oris Server running on port ${PORT}`);
});

process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
    server.close(() => process.exit(0));
});