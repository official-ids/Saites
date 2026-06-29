
const express = require('express');
const crypto = require('crypto');
const { kv } = require('@vercel/kv');

const router = express.Router();
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

// -----------------------------
// Константы и хранилище
// -----------------------------
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const MAX_RECENT_FILES = 50;

const K = {
    RECENT: 'json_studio:recent',
    PINNED: 'json_studio:pinned',
    SETTINGS: (userId) => `json_studio:settings:${userId}`,
    BACKUP: (path) => `json_studio:backup:${path}`
};

// In-memory хранилище файлов (для сессии)
const fileStore = new Map();

// -----------------------------
// Middleware
// -----------------------------
function verifyAdminToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.split(' ')[1];
    const isValid = ADMIN_TOKEN &&
        token &&
        token.length === ADMIN_TOKEN.length &&
        crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN));

    if (!isValid) return res.status(403).json({ error: 'Forbidden' });
    next();
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
                severity: 'error'
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
// YAML ↔ JSON (упрощённо)
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
function generateUUID() {
    return crypto.randomUUID();
}

function generateTimestamp() {
    const now = new Date();
    return {
        timestamp: Date.now(),
        unix: Math.floor(Date.now() / 1000),
        iso: now.toISOString(),
        local: now.toLocaleString('ru-RU'),
        rfc2822: now.toUTCString()
    };
}

function generateRandomData(options = {}) {
    const count = options.count || 10;
    const result = [];
    for (let i = 0; i < count; i++) {
        result.push({
            id: crypto.randomUUID(),
            name: `User_${Math.floor(Math.random() * 10000)}`,
            age: Math.floor(Math.random() * 60) + 18,
            email: `user${i}@example.com`,
            active: Math.random() > 0.5,
            score: Math.floor(Math.random() * 1000),
            createdAt: new Date(Date.now() - Math.floor(Math.random() * 10000000000)).toISOString()
        });
    }
    return result;
}

function generateJsonSchema(options = {}) {
    const fields = options.fields || ['id', 'name', 'email', 'age'];
    const schema = {
        type: 'object',
        properties: {},
        required: []
    };
    fields.forEach(f => {
        if (f === 'id') schema.properties.id = { type: 'string', format: 'uuid' };
        else if (f === 'name' || f === 'email') schema.properties[f] = { type: 'string' };
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

// -----------------------------
// API Routes
// -----------------------------

// Список файлов
router.get('/files', async (req, res) => {
    try {
        const files = Array.from(fileStore.entries()).map(([name, data]) => ({
            name,
            size: data.content.length,
            modifiedAt: data.modifiedAt
        }));
        res.json({ files });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка получения списка файлов' });
    }
});

// Открыть файл
router.post('/files/open', async (req, res) => {
    try {
        const { name, content, path: filePath } = req.body;
        if (!content && !filePath) {
            return res.status(400).json({ error: 'Укажите content или path' });
        }

        const fileName = name || filePath || `file_${Date.now()}.json`;
        const fileContent = content || (filePath ? await fs.readFile(filePath, 'utf8') : '{}');

        if (fileContent.length > MAX_FILE_SIZE) {
            return res.status(413).json({ error: 'Файл слишком большой' });
        }

        const validation = validateJson(fileContent);
        if (!validation.valid) {
            return res.status(400).json({ error: 'Невалидный JSON', details: validation.errors });
        }

        fileStore.set(fileName, {
            content: fileContent,
            createdAt: new Date().toISOString(),
            modifiedAt: new Date().toISOString()
        });

        const recent = await kv.get(K.RECENT) || [];
        const existing = recent.findIndex(f => f.name === fileName);
        if (existing !== -1) recent.splice(existing, 1);
        recent.unshift({ name: fileName, date: new Date().toISOString(), size: fileContent.length });
        if (recent.length > MAX_RECENT_FILES) recent.pop();
        await kv.set(K.RECENT, recent);

        res.json({
            name: fileName,
            content: fileContent,
            size: fileContent.length,
            valid: true
        });
    } catch (err) {
        console.error('[json-studio/open]', err);
        res.status(500).json({ error: 'Ошибка открытия файла' });
    }
});

// Сохранить файл
router.post('/files/save', async (req, res) => {
    try {
        const { path: filePath, content } = req.body;
        if (!filePath || !content) {
            return res.status(400).json({ error: 'Укажите path и content' });
        }

        const validation = validateJson(content);
        if (!validation.valid) {
            return res.status(400).json({ error: 'Невалидный JSON', details: validation.errors });
        }

        const existing = fileStore.get(filePath);
        fileStore.set(filePath, {
            content,
            createdAt: existing?.createdAt || new Date().toISOString(),
            modifiedAt: new Date().toISOString()
        });

        await kv.set(K.BACKUP(filePath), {
            content,
            timestamp: new Date().toISOString()
        }, { ex: 60 * 60 * 24 * 7 });

        const recent = await kv.get(K.RECENT) || [];
        const idx = recent.findIndex(f => f.name === filePath);
        if (idx !== -1) {
            recent[idx].date = new Date().toISOString();
            recent[idx].size = content.length;
            await kv.set(K.RECENT, recent);
        }

        res.json({ success: true, size: content.length });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка сохранения' });
    }
});

// Сохранить как...
router.post('/files/save-as', async (req, res) => {
    try {
        const { path: newPath, content, oldPath } = req.body;
        if (!newPath || !content) {
            return res.status(400).json({ error: 'Укажите path и content' });
        }

        const validation = validateJson(content);
        if (!validation.valid) {
            return res.status(400).json({ error: 'Невалидный JSON' });
        }

        fileStore.set(newPath, {
            content,
            createdAt: new Date().toISOString(),
            modifiedAt: new Date().toISOString()
        });

        if (oldPath && fileStore.has(oldPath)) {
            fileStore.delete(oldPath);
        }

        res.json({ success: true, path: newPath });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка сохранения' });
    }
});

// Закрепить файл
router.post('/files/pin', async (req, res) => {
    try {
        const { path: filePath } = req.body;
        const pinned = await kv.get(K.PINNED) || [];
        if (!pinned.includes(filePath)) {
            pinned.push(filePath);
            await kv.set(K.PINNED, pinned);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

// Валидация JSON
router.post('/validate', async (req, res) => {
    try {
        const { content } = req.body;
        if (!content) return res.status(400).json({ error: 'Укажите content' });
        const result = validateJson(content);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Ошибка валидации' });
    }
});

// Форматирование
router.post('/format', async (req, res) => {
    try {
        const { content, indent = 2, useTabs = false } = req.body;
        if (!content) return res.status(400).json({ error: 'Укажите content' });
        const formatted = formatJson(content, indent, useTabs);
        res.json({ content: formatted, size: formatted.length });
    } catch (err) {
        res.status(400).json({ error: 'Ошибка форматирования: ' + err.message });
    }
});

// Минификация
router.post('/minify', async (req, res) => {
    try {
        const { content } = req.body;
        if (!content) return res.status(400).json({ error: 'Укажите content' });
        const minified = minifyJson(content);
        res.json({ content: minified, size: minified.length });
    } catch (err) {
        res.status(400).json({ error: 'Ошибка минификации: ' + err.message });
    }
});

// Сортировка ключей
router.post('/sort', async (req, res) => {
    try {
        const { content } = req.body;
        if (!content) return res.status(400).json({ error: 'Укажите content' });
        const parsed = JSON.parse(content);
        const sorted = sortKeys(parsed);
        const result = JSON.stringify(sorted, null, 2);
        res.json({ content: result, size: result.length });
    } catch (err) {
        res.status(400).json({ error: 'Ошибка сортировки: ' + err.message });
    }
});

// Конвертация
router.post('/convert', async (req, res) => {
    try {
        const { content, from, to } = req.body;
        if (!content || !from || !to) {
            return res.status(400).json({ error: 'Укажите content, from и to' });
        }

        let intermediate;
        if (from === 'json') intermediate = JSON.parse(content);
        else if (from === 'xml') intermediate = xmlToJson(content);
        else if (from === 'yaml') intermediate = yamlToJson(content);
        else if (from === 'csv') intermediate = csvToJson(content);
        else return res.status(400).json({ error: 'Неподдерживаемый формат: ' + from });

        let result;
        if (to === 'json') result = JSON.stringify(intermediate, null, 2);
        else if (to === 'xml') result = jsonToXml(intermediate);
        else if (to === 'yaml') result = jsonToYaml(intermediate);
        else if (to === 'csv') {
            if (!Array.isArray(intermediate)) {
                return res.status(400).json({ error: 'CSV требует массив объектов' });
            }
            result = jsonToCsv(intermediate);
        }
        else return res.status(400).json({ error: 'Неподдерживаемый формат: ' + to });

        res.json({ content: result, size: result.length });
    } catch (err) {
        res.status(400).json({ error: 'Ошибка конвертации: ' + err.message });
    }
});

// Сравнение
router.post('/compare', async (req, res) => {
    try {
        const { left, right } = req.body;
        if (!left || !right) {
            return res.status(400).json({ error: 'Укажите left и right' });
        }
        const result = compareJson(left, right);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Ошибка сравнения' });
    }
});

// Валидация схемы
router.post('/schema/validate', async (req, res) => {
    try {
        const { content, schema } = req.body;
        if (!content || !schema) {
            return res.status(400).json({ error: 'Укажите content и schema' });
        }

        let data, schemaObj;
        try {
            data = JSON.parse(content);
            schemaObj = JSON.parse(schema);
        } catch (e) {
            return res.status(400).json({ error: 'Невалидный JSON: ' + e.message });
        }

        const errors = validateSchema(data, schemaObj);
        res.json({
            valid: errors.length === 0,
            errors,
            schema: schemaObj
        });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка валидации схемы' });
    }
});

// Недавние файлы
router.get('/recent', async (req, res) => {
    try {
        const files = await kv.get(K.RECENT) || [];
        const pinned = await kv.get(K.PINNED) || [];
        res.json({ files, pinned });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка загрузки' });
    }
});

// Настройки
router.get('/settings', async (req, res) => {
    try {
        const userId = req.headers['x-user-id'] || 'default';
        const settings = await kv.get(K.SETTINGS(userId)) || {
            theme: 'system',
            fontSize: 13,
            tabSize: 2,
            useTabs: false,
            autoSave: true,
            autoSaveInterval: 30000,
            language: 'ru'
        };
        res.json({ settings });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка загрузки настроек' });
    }
});

router.post('/settings', async (req, res) => {
    try {
        const { settings } = req.body;
        if (!settings || typeof settings !== 'object') {
            return res.status(400).json({ error: 'Неверный формат настроек' });
        }
        const userId = req.headers['x-user-id'] || 'default';
        await kv.set(K.SETTINGS(userId), settings);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка сохранения настроек' });
    }
});

// Генераторы
router.post('/generate', async (req, res) => {
    try {
        const { type, options = {} } = req.body;

        switch (type) {
            case 'uuid': {
                const count = options.count || 1;
                const result = Array.from({ length: count }, () => generateUUID()).join('\n');
                return res.json({ result });
            }
            case 'timestamp':
                return res.json({ result: generateTimestamp() });
            case 'random':
                return res.json({ result: generateRandomData(options) });
            case 'json':
                return res.json({ result: generateJsonSchema(options) });
            default:
                return res.status(400).json({ error: 'Неизвестный тип генератора: ' + type });
        }
    } catch (err) {
        res.status(500).json({ error: 'Ошибка генерации' });
    }
});

// Кодирование
router.post('/encode', async (req, res) => {
    try {
        const { content, type } = req.body;
        if (!content || !type) {
            return res.status(400).json({ error: 'Укажите content и type' });
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
            default:
                return res.status(400).json({ error: 'Неизвестный тип кодирования: ' + tool });
        }

        res.json({ result });
    } catch (err) {
        res.status(400).json({ error: 'Ошибка кодирования: ' + err.message });
    }
});

// Статистика
router.get('/stats', async (req, res) => {
    try {
        const recent = await kv.get(K.RECENT) || [];
        const pinned = await kv.get(K.PINNED) || [];
        res.json({
            totalFiles: fileStore.size,
            recentCount: recent.length,
            pinnedCount: pinned.length,
            memoryUsage: process.memoryUsage()
        });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

// Очистка (админ)
router.post('/admin/clear', verifyAdminToken, async (req, res) => {
    try {
        fileStore.clear();
        await kv.del(K.RECENT);
        await kv.del(K.PINNED);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка очистки' });
    }
});

module.exports = router;