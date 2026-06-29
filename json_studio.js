const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const { kv } = require('@vercel/kv');

const router = express.Router();
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

// -----------------------------
// Middleware
// -----------------------------
router.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true
}));
router.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
router.use(compression());
router.use(express.json({ limit: '100mb' }));
router.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Логирование запросов
router.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`[${req.method}] ${req.path} - ${res.statusCode} (${duration}ms)`);
    });
    next();
});

// -----------------------------
// Константы и хранилище
// -----------------------------
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const MAX_RECENT_FILES = 50;
const MAX_BACKUPS = 10;

const K = {
    RECENT: 'json_studio:recent',
    PINNED: 'json_studio:pinned',
    SETTINGS: (userId) => `json_studio:settings:${userId}`,
    BACKUP: (path) => `json_studio:backup:${path}`,
    BACKUPS_LIST: 'json_studio:backups:list',
    METRICS: 'json_studio:metrics',
    SESSIONS: 'json_studio:sessions'
};

// In-memory хранилище файлов (для сессии)
const fileStore = new Map();

// Metrics
const metrics = {
    totalRequests: 0,
    totalFiles: 0,
    totalConversions: 0,
    errors: 0,
    startTime: Date.now()
};

// -----------------------------
// Middleware
// -----------------------------
function verifyAdminToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized', code: 'NO_TOKEN' });
    }
    const token = authHeader.split(' ')[1];
    const isValid = ADMIN_TOKEN &&
        token &&
        token.length === ADMIN_TOKEN.length &&
        crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN));

    if (!isValid) return res.status(403).json({ error: 'Forbidden', code: 'INVALID_TOKEN' });
    next();
}

function trackMetric(type) {
    metrics.totalRequests++;
    if (type === 'conversion') metrics.totalConversions++;
    if (type === 'error') metrics.errors++;
    if (type === 'file') metrics.totalFiles++;
    
    // Сохраняем метрики в KV (асинхронно, без ожидания)
    kv.set(K.METRICS, metrics).catch(() => {});
}

// Обработчик ошибок
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

// -----------------------------
// Утилиты JSON
// -----------------------------
function validateJson(content) {
    try {
        JSON.parse(content);
        return { valid: true, errors: [] };
    } catch (e) {
        const match = e.message.match(/position (\d+)/);
        const pos = match ? parseInt(match[1]) : 0;
        const lines = content.slice(0, pos).split('\n');
        return {
            valid: false,
            errors: [{
                message: e.message,
                line: lines.length,
                column: lines[lines.length - 1].length + 1,
                severity: 'error',
                type: 'SyntaxError'
            }]
        };
    }
}

function formatJson(content, indent = 2, useTabs = false) {
    const parsed = JSON.parse(content);
    const tab = useTabs ? '\t' : ' '.repeat(indent);
    return JSON.stringify(parsed, null, tab);
}

function minifyJson(content) {
    return JSON.stringify(JSON.parse(content));
}

function sortKeys(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(sortKeys);
    return Object.keys(obj).sort().reduce((acc, key) => {
        acc[key] = sortKeys(obj[key]);
        return acc;
    }, {});
}

// -----------------------------
// XML ↔ JSON
// -----------------------------
function escapeXml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function jsonToXml(obj, rootName = 'root', indent = 0) {
    const tab = '  '.repeat(indent);
    if (obj === null || obj === undefined) {
        return `${tab}<${rootName}/>`;
    }
    if (typeof obj !== 'object') {
        return `${tab}<${rootName}>${escapeXml(String(obj))}</${rootName}>`;
    }
    if (Array.isArray(obj)) {
        return obj.map(item => jsonToXml(item, rootName, indent)).join('\n');
    }
    const children = Object.entries(obj).map(([key, value]) => {
        if (value === null || value === undefined) {
            return `${tab}  <${key}/>`;
        }
        if (typeof value !== 'object' || Array.isArray(value)) {
            return `${tab}  <${key}>${escapeXml(String(value))}</${key}>`;
        }
        const inner = jsonToXml(value, key, indent + 2);
        return `${tab}  <${key}>\n${inner}\n${tab}  </${key}>`;
    }).join('\n');
    return `${tab}<${rootName}>\n${children}\n${tab}</${rootName}>`;
}

function xmlToJson(xml) {
    const result = {};
    const stack = [{ obj: result, tag: 'root' }];
    const regex = /<\/?([a-zA-Z0-9_-]+)[^>]*\/?>/g;
    let match;
    let lastTag = null;
    let textContent = '';

    while ((match = regex.exec(xml)) !== null) {
        const full = match[0];
        const tag = match[1];
        const isClosing = full.startsWith('</');
        const isSelfClosing = full.endsWith('/>');

        if (isClosing) {
            if (textContent.trim()) {
                const parent = stack[stack.length - 1];
                const val = parseValue(textContent.trim());
                if (parent.obj[lastTag] !== undefined) {
                    if (!Array.isArray(parent.obj[lastTag])) {
                        parent.obj[lastTag] = [parent.obj[lastTag]];
                    }
                    parent.obj[lastTag].push(val);
                } else {
                    parent.obj[lastTag] = val;
                }
            }
            textContent = '';
            stack.pop();
            lastTag = null;
        } else if (!isSelfClosing) {
            const current = stack[stack.length - 1];
            if (!current.obj[tag]) {
                current.obj[tag] = {};
            }
            stack.push({ obj: current.obj[tag], tag });
            lastTag = tag;
            textContent = '';
        } else {
            const current = stack[stack.length - 1];
            current.obj[tag] = null;
        }
    }
    return result;
}

function parseValue(str) {
    if (str === 'true') return true;
    if (str === 'false') return false;
    if (str === 'null') return null;
    if (!isNaN(str) && str !== '') return Number(str);
    return str;
}

// -----------------------------
// YAML ↔ JSON
// -----------------------------
function jsonToYaml(obj, indent = 0) {
    const spaces = '  '.repeat(indent);
    if (obj === null) return `${spaces}null`;
    if (typeof obj === 'boolean') return `${spaces}${obj}`;
    if (typeof obj === 'number') return `${spaces}${obj}`;
    if (typeof obj === 'string') {
        if (obj.includes('\n') || obj.includes(':') || obj.includes('#')) {
            return `${spaces}|\n${obj.split('\n').map(l => `${spaces}  ${l}`).join('\n')}`;
        }
        return `${spaces}"${obj.replace(/"/g, '\\"')}"`;
    }
    if (Array.isArray(obj)) {
        if (obj.length === 0) return `${spaces}[]`;
        return obj.map(item => {
            if (typeof item === 'object' && item !== null) {
                const inner = jsonToYaml(item, indent + 1).trim();
                return `${spaces}- ${inner}`;
            }
            return `${spaces}- ${jsonToYaml(item, 0).trim()}`;
        }).join('\n');
    }
    if (typeof obj === 'object') {
        const keys = Object.keys(obj);
        if (keys.length === 0) return `${spaces}{}`;
        return keys.map(key => {
            const value = obj[key];
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                return `${spaces}${key}:\n${jsonToYaml(value, indent + 1)}`;
            }
            if (Array.isArray(value)) {
                return `${spaces}${key}:\n${jsonToYaml(value, indent + 1)}`;
            }
            return `${spaces}${key}: ${jsonToYaml(value, 0).trim()}`;
        }).join('\n');
    }
    return `${spaces}${obj}`;
}

function yamlToJson(yaml) {
    const lines = yaml.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
    const result = {};
    const stack = [{ obj: result, indent: -1 }];

    for (const line of lines) {
        const indent = line.search(/\S/);
        const content = line.trim();

        while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
            stack.pop();
        }

        if (content.startsWith('- ')) {
            const parent = stack[stack.length - 1].obj;
            const key = Object.keys(parent).pop();
            if (!Array.isArray(parent[key])) parent[key] = [];
            const value = content.slice(2).trim();
            if (value.includes(':')) {
                const obj = {};
                const [k, ...rest] = value.split(':');
                obj[k.trim()] = parseValue(rest.join(':').trim());
                parent[key].push(obj);
                stack.push({ obj: parent[key][parent[key].length - 1], indent });
            } else {
                parent[key].push(parseValue(value));
            }
        } else if (content.includes(':')) {
            const [key, ...rest] = content.split(':');
            const value = rest.join(':').trim();
            const current = stack[stack.length - 1].obj;
            if (value) {
                current[key.trim()] = parseValue(value);
            } else {
                current[key.trim()] = {};
                stack.push({ obj: current[key.trim()], indent });
            }
        }
    }
    return result;
}

// -----------------------------
// CSV ↔ JSON
// -----------------------------
function parseCsvLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"' && line[i + 1] === '"') {
                current += '"';
                i++;
            } else if (ch === '"') {
                inQuotes = false;
            } else {
                current += ch;
            }
        } else {
            if (ch === '"') inQuotes = true;
            else if (ch === ',') {
                result.push(current);
                current = '';
            } else {
                current += ch;
            }
        }
    }
    result.push(current);
    return result;
}

function jsonToCsv(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return '';
    const headers = Object.keys(arr[0]);
    const rows = arr.map(obj =>
        headers.map(h => {
            const val = obj[h] ?? '';
            const str = String(val);
            return str.includes(',') || str.includes('"') || str.includes('\n')
                ? `"${str.replace(/"/g, '""')}"`
                : str;
        }).join(',')
    );
    return [headers.join(','), ...rows].join('\n');
}

function csvToJson(csv) {
    const lines = csv.trim().split('\n');
    if (lines.length < 2) return [];
    const headers = parseCsvLine(lines[0]);
    return lines.slice(1).map(line => {
        const values = parseCsvLine(line);
        const obj = {};
        headers.forEach((h, i) => {
            obj[h] = parseValue(values[i] || '');
        });
        return obj;
    });
}

// -----------------------------
// Сравнение JSON
// -----------------------------
function compareJson(left, right) {
    try {
        const l = JSON.parse(left);
        const r = JSON.parse(right);
        const ls = JSON.stringify(l, null, 2);
        const rs = JSON.stringify(r, null, 2);

        const lLines = ls.split('\n');
        const rLines = rs.split('\n');
        const changes = [];

        const maxLen = Math.max(lLines.length, rLines.length);
        for (let i = 0; i < maxLen; i++) {
            if (lLines[i] !== rLines[i]) {
                changes.push({
                    line: i + 1,
                    left: lLines[i] || null,
                    right: rLines[i] || null,
                    type: !lLines[i] ? 'added' : !rLines[i] ? 'removed' : 'modified'
                });
            }
        }

        return {
            identical: ls === rs,
            leftLines: lLines.length,
            rightLines: rLines.length,
            changes,
            summary: ls === rs
                ? 'Файлы идентичны'
                : `Найдено изменений: ${changes.length}`
        };
    } catch (e) {
        return { error: e.message };
    }
}

// -----------------------------
// JSON Schema валидация
// -----------------------------
function validateSchema(data, schema, path = '') {
    const errors = [];

    if (schema.type) {
        const actual = Array.isArray(data) ? 'array' : typeof data;
        if (actual !== schema.type) {
            errors.push({
                message: `Ожидался тип "${schema.type}", получен "${actual}"`,
                path: path || '/',
                severity: 'error'
            });
            return errors;
        }
    }

    if (schema.required && typeof data === 'object' && data !== null) {
        for (const key of schema.required) {
            if (!(key in data)) {
                errors.push({
                    message: `Отсутствует обязательное поле "${key}"`,
                    path: `${path}/${key}`,
                    severity: 'error'
                });
            }
        }
    }

    if (schema.properties && typeof data === 'object' && data !== null) {
        for (const [key, propSchema] of Object.entries(schema.properties)) {
            if (key in data) {
                errors.push(...validateSchema(data[key], propSchema, `${path}/${key}`));
            }
        }
    }

    if (schema.enum && !schema.enum.includes(data)) {
        errors.push({
            message: `Значение должно быть одним из: ${schema.enum.join(', ')}`,
            path: path || '/',
            severity: 'error'
        });
    }

    if (typeof data === 'string') {
        if (schema.minLength && data.length < schema.minLength) {
            errors.push({ message: `Строка слишком короткая (мин. ${schema.minLength})`, path, severity: 'error' });
        }
        if (schema.maxLength && data.length > schema.maxLength) {
            errors.push({ message: `Строка слишком длинная (макс. ${schema.maxLength})`, path, severity: 'error' });
        }
        if (schema.pattern && !new RegExp(schema.pattern).test(data)) {
            errors.push({ message: `Не соответствует паттерну: ${schema.pattern}`, path, severity: 'error' });
        }
    }

    if (typeof data === 'number') {
        if (schema.minimum !== undefined && data < schema.minimum) {
            errors.push({ message: `Число меньше минимума (${schema.minimum})`, path, severity: 'error' });
        }
        if (schema.maximum !== undefined && data > schema.maximum) {
            errors.push({ message: `Число больше максимума (${schema.maximum})`, path, severity: 'error' });
        }
    }

    if (Array.isArray(data)) {
        if (schema.minItems && data.length < schema.minItems) {
            errors.push({ message: `Массив слишком короткий (мин. ${schema.minItems})`, path, severity: 'error' });
        }
        if (schema.maxItems && data.length > schema.maxItems) {
            errors.push({ message: `Массив слишком длинный (макс. ${schema.maxItems})`, path, severity: 'error' });
        }
        if (schema.items) {
            data.forEach((item, i) => {
                errors.push(...validateSchema(item, schema.items, `${path}[${i}]`));
            });
        }
    }

    return errors;
}

// -----------------------------
// Генераторы
// -----------------------------
function generateUUID(count = 1) {
    return Array.from({ length: count }, () => crypto.randomUUID());
}

function generateTimestamp() {
    const now = new Date();
    return {
        timestamp: Date.now(),
        unix: Math.floor(Date.now() / 1000),
        iso: now.toISOString(),
        local: now.toLocaleString('ru-RU'),
        rfc2822: now.toUTCString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    };
}

function generateRandomData(options = {}) {
    const count = options.count || 10;
    const result = [];
    const names = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Henry'];
    const domains = ['gmail.com', 'yahoo.com', 'outlook.com', 'example.com'];
    
    for (let i = 0; i < count; i++) {
        const name = names[Math.floor(Math.random() * names.length)];
        const domain = domains[Math.floor(Math.random() * domains.length)];
        result.push({
            id: crypto.randomUUID(),
            name: `${name}_${Math.floor(Math.random() * 10000)}`,
            age: Math.floor(Math.random() * 60) + 18,
            email: `${name.toLowerCase()}${i}@${domain}`,
            active: Math.random() > 0.5,
            score: Math.floor(Math.random() * 1000),
            createdAt: new Date(Date.now() - Math.floor(Math.random() * 10000000000)).toISOString(),
            tags: Array.from({ length: Math.floor(Math.random() * 5) }, () => 
                ['admin', 'user', 'premium', 'vip'][Math.floor(Math.random() * 4)]
            )
        });
    }
    return result;
}

function generateJsonSchema(options = {}) {
    const fields = options.fields || ['id', 'name', 'email', 'age'];
    const schema = {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false
    };
    fields.forEach(f => {
        if (f === 'id') schema.properties.id = { type: 'string', format: 'uuid', description: 'Unique identifier' };
        else if (f === 'name') schema.properties.name = { type: 'string', minLength: 1, maxLength: 100 };
        else if (f === 'email') schema.properties.email = { type: 'string', format: 'email' };
        else if (f === 'age') schema.properties.age = { type: 'integer', minimum: 0, maximum: 150 };
        else schema.properties[f] = { type: 'string' };
        schema.required.push(f);
    });
    return schema;
}

// -----------------------------
// Кодирование
// -----------------------------
function encodeBase64(str) { return Buffer.from(str, 'utf8').toString('base64'); }
function decodeBase64(str) { return Buffer.from(str, 'base64').toString('utf8'); }
function encodeUrl(str) { return encodeURIComponent(str); }
function decodeUrl(str) { return decodeURIComponent(str); }
function escapeJson(str) { return JSON.stringify(str); }
function unescapeJson(str) { try { return JSON.parse(str); } catch { return str; } }
function toUnicode(str) { return str.split('').map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join(''); }
function fromUnicode(str) { return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))); }
function hashString(str, algorithm = 'sha256') { return crypto.createHash(algorithm).update(str).digest('hex'); }

// -----------------------------
// API Routes
// -----------------------------

// Health check
router.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: Math.floor((Date.now() - metrics.startTime) / 1000),
        memory: process.memoryUsage()
    });
});

// Metrics
router.get('/metrics', async (req, res) => {
    try {
        const storedMetrics = await kv.get(K.METRICS) || metrics;
        res.json({
            ...storedMetrics,
            uptime: Math.floor((Date.now() - storedMetrics.startTime) / 1000),
            uptimeFormatted: new Date(storedMetrics.uptime * 1000).toISOString().substr(11, 8)
        });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка получения метрик' });
    }
});

// Список файлов
router.get('/files', asyncHandler(async (req, res) => {
    trackMetric('file');
    const files = Array.from(fileStore.entries()).map(([name, data]) => ({
        name,
        size: data.content.length,
        modifiedAt: data.modifiedAt,
        createdAt: data.createdAt
    }));
    res.json({ files, total: files.length });
}));

// Открыть файл
router.post('/files/open', asyncHandler(async (req, res) => {
    trackMetric('file');
    const { name, content, path: filePath } = req.body;
    
    if (!content && !filePath) {
        return res.status(400).json({ error: 'Укажите content или path', code: 'MISSING_CONTENT' });
    }

    const fileName = name || filePath || `file_${Date.now()}.json`;
    const fileContent = content || '{}';

    if (fileContent.length > MAX_FILE_SIZE) {
        return res.status(413).json({ error: 'Файл слишком большой', code: 'FILE_TOO_LARGE', maxSize: MAX_FILE_SIZE });
    }

    const validation = validateJson(fileContent);
    if (!validation.valid) {
        return res.status(400).json({ error: 'Невалидный JSON', code: 'INVALID_JSON', details: validation.errors });
    }

    fileStore.set(fileName, {
        content: fileContent,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString()
    });

    // Обновляем recent files
    const recent = await kv.get(K.RECENT) || [];
    const existing = recent.findIndex(f => f.name === fileName);
    if (existing !== -1) recent.splice(existing, 1);
    recent.unshift({ 
        name: fileName, 
        date: new Date().toISOString(), 
        size: fileContent.length,
        path: fileName
    });
    if (recent.length > MAX_RECENT_FILES) recent.pop();
    await kv.set(K.RECENT, recent);

    res.json({
        name: fileName,
        content: fileContent,
        size: fileContent.length,
        valid: true,
        message: 'Файл успешно открыт'
    });
}));

// Сохранить файл
router.post('/files/save', asyncHandler(async (req, res) => {
    trackMetric('file');
    const { path: filePath, content } = req.body;
    
    if (!filePath || !content) {
        return res.status(400).json({ error: 'Укажите path и content', code: 'MISSING_PARAMS' });
    }

    const validation = validateJson(content);
    if (!validation.valid) {
        return res.status(400).json({ error: 'Невалидный JSON', code: 'INVALID_JSON', details: validation.errors });
    }

    const existing = fileStore.get(filePath);
    fileStore.set(filePath, {
        content,
        createdAt: existing?.createdAt || new Date().toISOString(),
        modifiedAt: new Date().toISOString()
    });

    // Создаем backup
    const backupKey = K.BACKUP(`${filePath}_${Date.now()}`);
    await kv.set(backupKey, {
        content,
        timestamp: new Date().toISOString(),
        path: filePath
    }, { ex: 60 * 60 * 24 * 7 });

    // Обновляем список backups
    const backups = await kv.get(K.BACKUPS_LIST) || [];
    backups.unshift({ key: backupKey, path: filePath, timestamp: new Date().toISOString() });
    if (backups.length > MAX_BACKUPS) backups.pop();
    await kv.set(K.BACKUPS_LIST, backups);

    // Обновляем recent
    const recent = await kv.get(K.RECENT) || [];
    const idx = recent.findIndex(f => f.name === filePath);
    if (idx !== -1) {
        recent[idx].date = new Date().toISOString();
        recent[idx].size = content.length;
    } else {
        recent.unshift({ name: filePath, date: new Date().toISOString(), size: content.length, path: filePath });
        if (recent.length > MAX_RECENT_FILES) recent.pop();
    }
    await kv.set(K.RECENT, recent);

    res.json({ success: true, size: content.length, message: 'Файл сохранён' });
}));

// Сохранить как...
router.post('/files/save-as', asyncHandler(async (req, res) => {
    trackMetric('file');
    const { path: newPath, content, oldPath } = req.body;
    
    if (!newPath || !content) {
        return res.status(400).json({ error: 'Укажите path и content', code: 'MISSING_PARAMS' });
    }

    const validation = validateJson(content);
    if (!validation.valid) {
        return res.status(400).json({ error: 'Невалидный JSON', code: 'INVALID_JSON' });
    }

    fileStore.set(newPath, {
        content,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString()
    });

    if (oldPath && fileStore.has(oldPath)) {
        fileStore.delete(oldPath);
    }

    res.json({ success: true, path: newPath, message: 'Файл сохранён под новым именем' });
}));

// Удалить файл
router.delete('/files/:path', asyncHandler(async (req, res) => {
    trackMetric('file');
    const { path } = req.params;
    
    if (!fileStore.has(path)) {
        return res.status(404).json({ error: 'Файл не найден', code: 'FILE_NOT_FOUND' });
    }

    fileStore.delete(path);
    
    // Удаляем из recent
    const recent = await kv.get(K.RECENT) || [];
    const idx = recent.findIndex(f => f.name === path);
    if (idx !== -1) {
        recent.splice(idx, 1);
        await kv.set(K.RECENT, recent);
    }

    res.json({ success: true, message: 'Файл удалён' });
}));

// Закрепить файл
router.post('/files/pin', asyncHandler(async (req, res) => {
    trackMetric('file');
    const { path: filePath } = req.body;
    
    const pinned = await kv.get(K.PINNED) || [];
    if (!pinned.includes(filePath)) {
        pinned.push(filePath);
        await kv.set(K.PINNED, pinned);
    }
    
    res.json({ success: true, pinned, message: 'Файл закреплён' });
}));

// Открепить файл
router.delete('/files/unpin/:path', asyncHandler(async (req, res) => {
    trackMetric('file');
    const { path } = req.params;
    
    const pinned = await kv.get(K.PINNED) || [];
    const idx = pinned.indexOf(path);
    if (idx !== -1) {
        pinned.splice(idx, 1);
        await kv.set(K.PINNED, pinned);
    }
    
    res.json({ success: true, pinned, message: 'Файл откреплён' });
}));

// Получить закреплённые файлы
router.get('/files/pinned', asyncHandler(async (req, res) => {
    trackMetric('file');
    const pinned = await kv.get(K.PINNED) || [];
    const files = pinned.map(path => {
        const data = fileStore.get(path);
        return {
            path,
            size: data?.content.length || 0,
            modifiedAt: data?.modifiedAt
        };
    });
    res.json({ files: files.filter(f => f.size > 0), total: files.length });
}));

// Валидация JSON
router.post('/validate', asyncHandler(async (req, res) => {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Укажите content', code: 'MISSING_CONTENT' });
    
    const result = validateJson(content);
    res.json(result);
}));

// Форматирование
router.post('/format', asyncHandler(async (req, res) => {
    trackMetric('conversion');
    const { content, indent = 2, useTabs = false } = req.body;
    if (!content) return res.status(400).json({ error: 'Укажите content', code: 'MISSING_CONTENT' });
    
    const formatted = formatJson(content, indent, useTabs);
    res.json({ content: formatted, size: formatted.length, message: 'JSON отформатирован' });
}));

// Минификация
router.post('/minify', asyncHandler(async (req, res) => {
    trackMetric('conversion');
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Укажите content', code: 'MISSING_CONTENT' });
    
    const minified = minifyJson(content);
    res.json({ content: minified, size: minified.length, originalSize: content.length, reduction: `${((1 - minified.length / content.length) * 100).toFixed(1)}%` });
}));

// Сортировка ключей
router.post('/sort', asyncHandler(async (req, res) => {
    trackMetric('conversion');
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Укажите content', code: 'MISSING_CONTENT' });
    
    const parsed = JSON.parse(content);
    const sorted = sortKeys(parsed);
    const result = JSON.stringify(sorted, null, 2);
    res.json({ content: result, size: result.length, message: 'Ключи отсортированы' });
}));

// Конвертация
router.post('/convert', asyncHandler(async (req, res) => {
    trackMetric('conversion');
    const { content, from, to } = req.body;
    if (!content || !from || !to) {
        return res.status(400).json({ error: 'Укажите content, from и to', code: 'MISSING_PARAMS' });
    }

    let intermediate;
    try {
        if (from === 'json') intermediate = JSON.parse(content);
        else if (from === 'xml') intermediate = xmlToJson(content);
        else if (from === 'yaml') intermediate = yamlToJson(content);
        else if (from === 'csv') intermediate = csvToJson(content);
        else return res.status(400).json({ error: 'Неподдерживаемый формат: ' + from, code: 'UNSUPPORTED_FORMAT' });
    } catch (e) {
        return res.status(400).json({ error: `Ошибка парсинга ${from}: ${e.message}`, code: 'PARSE_ERROR' });
    }

    let result;
    try {
        if (to === 'json') result = JSON.stringify(intermediate, null, 2);
        else if (to === 'xml') result = jsonToXml(intermediate);
        else if (to === 'yaml') result = jsonToYaml(intermediate);
        else if (to === 'csv') {
            if (!Array.isArray(intermediate)) {
                return res.status(400).json({ error: 'CSV требует массив объектов', code: 'CSV_REQUIRES_ARRAY' });
            }
            result = jsonToCsv(intermediate);
        }
        else return res.status(400).json({ error: 'Неподдерживаемый формат: ' + to, code: 'UNSUPPORTED_FORMAT' });
    } catch (e) {
        return res.status(400).json({ error: `Ошибка конвертации в ${to}: ${e.message}`, code: 'CONVERT_ERROR' });
    }

    res.json({ 
        content: result, 
        size: result.length, 
        originalSize: content.length,
        from,
        to,
        message: `Конвертация ${from} → ${to} выполнена`
    });
}));

// Сравнение
router.post('/compare', asyncHandler(async (req, res) => {
    const { left, right } = req.body;
    if (!left || !right) {
        return res.status(400).json({ error: 'Укажите left и right', code: 'MISSING_PARAMS' });
    }
    const result = compareJson(left, right);
    res.json(result);
}));

// Валидация схемы
router.post('/schema/validate', asyncHandler(async (req, res) => {
    const { content, schema } = req.body;
    if (!content || !schema) {
        return res.status(400).json({ error: 'Укажите content и schema', code: 'MISSING_PARAMS' });
    }

    let data, schemaObj;
    try {
        data = JSON.parse(content);
        schemaObj = JSON.parse(schema);
    } catch (e) {
        return res.status(400).json({ error: 'Невалидный JSON: ' + e.message, code: 'INVALID_JSON' });
    }

    const errors = validateSchema(data, schemaObj);
    res.json({
        valid: errors.length === 0,
        errors,
        schema: schemaObj,
        message: errors.length === 0 ? 'Схема валидна' : `Найдено ошибок: ${errors.length}`
    });
}));

// Недавние файлы
router.get('/recent', asyncHandler(async (req, res) => {
    const files = await kv.get(K.RECENT) || [];
    const pinned = await kv.get(K.PINNED) || [];
    res.json({ 
        files, 
        pinned,
        total: files.length,
        pinnedCount: pinned.length
    });
}));

// Очистить недавние файлы
router.delete('/recent/clear', asyncHandler(async (req, res) => {
    await kv.del(K.RECENT);
    res.json({ success: true, message: 'История очищена' });
}));

// Настройки
router.get('/settings', asyncHandler(async (req, res) => {
    const userId = req.headers['x-user-id'] || req.query.userId || 'default';
    const settings = await kv.get(K.SETTINGS(userId)) || {
        theme: 'system',
        fontSize: 13,
        tabSize: 2,
        useTabs: false,
        autoSave: true,
        autoSaveInterval: 30000,
        language: 'ru',
        wordWrap: true,
        minimap: true
    };
    res.json({ settings, userId });
}));

router.post('/settings', asyncHandler(async (req, res) => {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') {
        return res.status(400).json({ error: 'Неверный формат настроек', code: 'INVALID_SETTINGS' });
    }
    const userId = req.headers['x-user-id'] || req.query.userId || 'default';
    await kv.set(K.SETTINGS(userId), settings);
    res.json({ success: true, message: 'Настройки сохранены' });
}));

// Генераторы
router.post('/generate', asyncHandler(async (req, res) => {
    const { type, options = {} } = req.body;

    switch (type) {
        case 'uuid': {
            const count = options.count || 1;
            const result = generateUUID(count);
            return res.json({ 
                result: count === 1 ? result[0] : result, 
                count,
                message: `Сгенерировано ${count} UUID`
            });
        }
        case 'timestamp':
            return res.json({ result: generateTimestamp() });
        case 'random':
            return res.json({ 
                result: generateRandomData(options), 
                count: options.count || 10,
                message: 'Случайные данные сгенерированы'
            });
        case 'json':
            return res.json({ 
                result: generateJsonSchema(options),
                message: 'JSON схема сгенерирована'
            });
        default:
            return res.status(400).json({ error: 'Неизвестный тип генератора: ' + type, code: 'UNKNOWN_GENERATOR' });
    }
}));

// Кодирование
router.post('/encode', asyncHandler(async (req, res) => {
    const { content, type } = req.body;
    if (!content || !type) {
        return res.status(400).json({ error: 'Укажите content и type', code: 'MISSING_PARAMS' });
    }

    const [tool, action] = type.split('/');
    let result;

    switch (tool) {
        case 'base64':
            result = action === 'encode' ? encodeBase64(content) : decodeBase64(content);
            break;
        case 'url':
            result = action === 'encode' ? encodeUrl(content) : decodeUrl(content);
            break;
        case 'escape':
            result = action === 'encode' ? escapeJson(content) : unescapeJson(content);
            break;
        case 'unicode':
            result = action === 'encode' ? toUnicode(content) : fromUnicode(content);
            break;
        case 'hash':
            result = hashString(content, options.algorithm || 'sha256');
            break;
        default:
            return res.status(400).json({ error: 'Неизвестный тип кодирования: ' + tool, code: 'UNKNOWN_ENCODING' });
    }

    res.json({ 
        result, 
        originalLength: content.length,
        resultLength: result.length,
        type,
        message: `${action} ${tool} выполнен`
    });
}));

// Статистика
router.get('/stats', asyncHandler(async (req, res) => {
    const recent = await kv.get(K.RECENT) || [];
    const pinned = await kv.get(K.PINNED) || [];
    const backups = await kv.get(K.BACKUPS_LIST) || [];
    const storedMetrics = await kv.get(K.METRICS) || metrics;
    
    res.json({
        files: {
            total: fileStore.size,
            recent: recent.length,
            pinned: pinned.length,
            backups: backups.length
        },
        metrics: {
            totalRequests: storedMetrics.totalRequests,
            totalConversions: storedMetrics.totalConversions,
            errors: storedMetrics.errors,
            uptime: Math.floor((Date.now() - storedMetrics.startTime) / 1000)
        },
        memory: process.memoryUsage()
    });
}));

// Очистка (админ)
router.post('/admin/clear', verifyAdminToken, asyncHandler(async (req, res) => {
    fileStore.clear();
    await kv.del(K.RECENT);
    await kv.del(K.PINNED);
    await kv.del(K.METRICS);
    
    res.json({ 
        success: true, 
        message: 'Все данные очищены',
        cleared: ['files', 'recent', 'pinned', 'metrics']
    });
}));

// Очистка старых backups
router.post('/admin/cleanup-backups', verifyAdminToken, asyncHandler(async (req, res) => {
    const backups = await kv.get(K.BACKUPS_LIST) || [];
    let deleted = 0;
    
    for (const backup of backups) {
        try {
            await kv.del(backup.key);
            deleted++;
        } catch (e) {
            console.error('Error deleting backup:', backup.key, e);
        }
    }
    
    await kv.del(K.BACKUPS_LIST);
    
    res.json({ 
        success: true, 
        message: `Удалено ${deleted} backup'ов`,
        deleted
    });
}));

// Список backups
router.get('/admin/backups', verifyAdminToken, asyncHandler(async (req, res) => {
    const backups = await kv.get(K.BACKUPS_LIST) || [];
    res.json({ backups, total: backups.length });
}));

// Восстановить из backup
router.post('/admin/restore/:backupKey', verifyAdminToken, asyncHandler(async (req, res) => {
    const { backupKey } = req.params;
    const backup = await kv.get(backupKey);
    
    if (!backup) {
        return res.status(404).json({ error: 'Backup не найден', code: 'BACKUP_NOT_FOUND' });
    }
    
    fileStore.set(backup.path, {
        content: backup.content,
        createdAt: backup.timestamp,
        modifiedAt: new Date().toISOString()
    });
    
    res.json({ 
        success: true, 
        message: 'Файл восстановлен из backup',
        path: backup.path,
        timestamp: backup.timestamp
    });
}));

// Error handler
router.use((err, req, res, next) => {
    console.error('[json-studio error]', err);
    trackMetric('error');
    
    res.status(err.status || 500).json({
        error: err.message || 'Internal Server Error',
        code: err.code || 'INTERNAL_ERROR',
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});

module.exports = router;