const express = require('express');
const crypto = require('crypto');
const { kv } = require('@vercel/kv');

const router = express.Router();

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

// -----------------------------
// KV Keys
// -----------------------------
const K = {
    TICKET: (id) => `support:ticket:${id}`,
    TICKETS: 'support:tickets',              // Set всех ID
    SESSION: (token) => `support:session:${token}`,
    USER_TICKETS: (token) => `support:user_tickets:${token}`, // Set тикетов пользователя
    RATE_LIMIT: (token) => `support:ratelimit:${token}`       // для распределённого rate limit
};

// -----------------------------
// Вспомогательные
// -----------------------------
function generateId() {
    return crypto.randomBytes(8).toString('hex');
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function sanitize(str, maxLen = 5000) {
    if (str == null) return '';
    return String(str)
        .replace(/[<>]/g, '')   // защита от HTML-инъекций
        .trim()
        .slice(0, maxLen);
}

// -----------------------------
// Middleware
// -----------------------------

// Опциональная проверка сессии пользователя (оставлена для совместимости, но не используется в основных маршрутах)
async function optionalUserSession(req, res, next) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        try {
            const session = await kv.get(K.SESSION(token));
            if (session) req.session = session;
        } catch (e) { /* игнор */ }
    }
    next();
}

// Обязательная авторизация (юзер или админ)
async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const session = await kv.get(K.SESSION(token));
        if (!session) return res.status(401).json({ error: 'Сессия истекла' });
        req.session = session;
        req.authToken = token; // сохраняем токен для дальнейшего использования
        next();
    } catch (e) {
        console.error('[support] requireAuth error:', e.message);
        return res.status(500).json({ error: 'Ошибка проверки сессии' });
    }
}

// Только админ
function requireAdmin(req, res, next) {
    if (!req.session || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Требуются права администратора' });
    }
    next();
}

// Rate limit: не более 1 сообщения в 2 секунды (распределённый через KV)
async function checkMessageRateLimit(token) {
    const key = K.RATE_LIMIT(token);
    const last = await kv.get(key);
    const now = Date.now();
    if (last && (now - last) < 2000) {
        return Math.ceil((2000 - (now - last)) / 1000);
    }
    await kv.set(key, now, { ex: 3 }); // TTL 3 секунды, чтобы автоматически очищалось
    return 0;
}

// -----------------------------
// Аутентификация
// -----------------------------

// Создать сессию пользователя (или вернуть существующую)
router.post('/auth/user', async (req, res) => {
    try {
        const { name, token } = req.body;

        // Если токен передан — проверяем
        if (token) {
            const session = await kv.get(K.SESSION(token));
            if (session && session.role === 'user') {
                return res.json({ session, token });
            }
        }

        // Создаём новую сессию
        if (!name || String(name).trim().length < 2) {
            return res.status(400).json({ error: 'Имя должно содержать минимум 2 символа' });
        }
        if (String(name).length > 40) {
            return res.status(400).json({ error: 'Имя слишком длинное' });
        }

        const newToken = generateToken();
        const session = {
            role: 'user',
            name: sanitize(name, 40),
            createdAt: new Date().toISOString()
        };
        await kv.set(K.SESSION(newToken), session, { ex: 60 * 60 * 24 * 365 }); // 1 год

        res.json({ session, token: newToken });
    } catch (err) {
        console.error('[support/auth/user]', err);
        res.status(500).json({ error: 'Ошибка авторизации' });
    }
});

// Вход админа
router.post('/auth/admin', async (req, res) => {
    try {
        const { token } = req.body;

        if (!ADMIN_TOKEN) {
            console.error('[support] ADMIN_TOKEN не задан в переменных окружения');
            return res.status(500).json({ error: 'Admin token не настроен на сервере' });
        }
        if (!token || typeof token !== 'string') {
            return res.status(400).json({ error: 'Укажите токен' });
        }

        const isValid = token.length === ADMIN_TOKEN.length &&
            crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN));

        if (!isValid) {
            return res.status(403).json({ error: 'Неверный токен администратора' });
        }

        const sessionToken = generateToken();
        const session = {
            role: 'admin',
            name: 'Support Team',
            createdAt: new Date().toISOString()
        };
        await kv.set(K.SESSION(sessionToken), session, { ex: 60 * 60 * 24 * 30 }); // 30 дней

        res.json({ session, token: sessionToken });
    } catch (err) {
        console.error('[support/auth/admin]', err);
        res.status(500).json({ error: 'Ошибка авторизации' });
    }
});

// Выход
router.post('/auth/logout', requireAuth, async (req, res) => {
    try {
        await kv.del(K.SESSION(req.authToken));
        // также можно удалить rate limit ключ, но он сам протухнет
        res.json({ success: true });
    } catch (err) {
        console.error('[support/auth/logout]', err);
        res.status(500).json({ error: 'Ошибка выхода' });
    }
});

// -----------------------------
// Тикеты
// -----------------------------

// Создать тикет (только для пользователя)
router.post('/tickets', requireAuth, async (req, res) => {
    try {
        if (req.session.role !== 'user') {
            return res.status(403).json({ error: 'Тикеты создают только пользователи' });
        }

        let { subject, firstMessage } = req.body;

        if (!subject || typeof subject !== 'string') {
            return res.status(400).json({ error: 'Тема обязательна' });
        }
        subject = subject.trim();
        if (subject.length < 3) {
            return res.status(400).json({ error: 'Тема должна содержать минимум 3 символа' });
        }
        if (subject.length > 120) {
            return res.status(400).json({ error: 'Тема слишком длинная (макс. 120)' });
        }

        if (!firstMessage || typeof firstMessage !== 'string') {
            return res.status(400).json({ error: 'Напишите первое сообщение' });
        }
        firstMessage = firstMessage.trim();
        if (firstMessage.length < 2) {
            return res.status(400).json({ error: 'Сообщение должно содержать минимум 2 символа' });
        }
        if (firstMessage.length > 2000) {
            return res.status(400).json({ error: 'Сообщение слишком длинное (макс. 2000)' });
        }

        const ticketId = generateId();
        const now = new Date().toISOString();
        const userToken = req.authToken;

        const ticket = {
            id: ticketId,
            subject: sanitize(subject, 120),
            status: 'open',
            userToken: userToken,
            userName: sanitize(req.session.name, 40),
            createdAt: now,
            updatedAt: now,
            messages: [
                {
                    id: generateId(),
                    from: 'user',
                    fromName: sanitize(req.session.name, 40),
                    text: sanitize(firstMessage, 2000),
                    createdAt: now
                }
            ]
        };

        // Проверка на коллизию ID (маловероятно, но для надёжности)
        const existing = await kv.get(K.TICKET(ticketId));
        if (existing) {
            // Повторная генерация ID (можно рекурсивно, но для простоты — ошибка)
            return res.status(500).json({ error: 'Ошибка генерации ID, повторите' });
        }

        await kv.set(K.TICKET(ticketId), ticket);
        await kv.sadd(K.TICKETS, ticketId);
        await kv.sadd(K.USER_TICKETS(userToken), ticketId);

        res.json({ ticket });
    } catch (err) {
        console.error('[support/tickets POST]', err);
        res.status(500).json({ error: 'Ошибка создания тикета' });
    }
});

// Список тикетов
router.get('/tickets', requireAuth, async (req, res) => {
    try {
        let ticketIds = [];

        if (req.session.role === 'admin') {
            // Админ видит все
            ticketIds = await kv.smembers(K.TICKETS);
        } else {
            // Пользователь видит только свои
            const token = req.authToken;
            ticketIds = await kv.smembers(K.USER_TICKETS(token));
        }

        // Дедупликация (исправление бага возможных дублей в Set)
        const uniqueIds = [...new Set(ticketIds)];

        if (!uniqueIds || uniqueIds.length === 0) {
            return res.json({ tickets: [] });
        }

        // Пакетная загрузка
        const keys = uniqueIds.map(id => K.TICKET(id));
        const ticketsData = [];
        for (let i = 0; i < keys.length; i += 100) {
            const chunk = await kv.mget(...keys.slice(i, i + 100));
            ticketsData.push(...chunk);
        }

        // Возвращаем краткую информацию (без всех сообщений)
        const tickets = ticketsData
            .filter(t => t && t.id) // отбрасываем null/undefined
            .map(t => ({
                id: t.id,
                subject: t.subject,
                status: t.status,
                userName: t.userName,
                createdAt: t.createdAt,
                updatedAt: t.updatedAt,
                lastMessage: t.messages[t.messages.length - 1] || null,
                messagesCount: t.messages.length
            }))
            .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

        res.json({ tickets });
    } catch (err) {
        console.error('[support/tickets GET]', err);
        res.status(500).json({ error: 'Ошибка загрузки тикетов' });
    }
});

// Один тикет с сообщениями
router.get('/tickets/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const ticket = await kv.get(K.TICKET(id));

        if (!ticket) {
            return res.status(404).json({ error: 'Тикет не найден' });
        }

        // Проверка доступа
        if (req.session.role !== 'admin' && ticket.userToken !== req.authToken) {
            return res.status(403).json({ error: 'Нет доступа к этому тикету' });
        }

        res.json({ ticket });
    } catch (err) {
        console.error('[support/tickets GET :id]', err);
        res.status(500).json({ error: 'Ошибка загрузки' });
    }
});

// Отправить сообщение
router.post('/tickets/:id/messages', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        let { text } = req.body;

        if (!text || typeof text !== 'string') {
            return res.status(400).json({ error: 'Сообщение не может быть пустым' });
        }
        text = text.trim();
        if (text.length === 0) {
            return res.status(400).json({ error: 'Сообщение не может быть пустым' });
        }
        if (text.length > 2000) {
            return res.status(400).json({ error: 'Сообщение слишком длинное (макс. 2000)' });
        }

        // Rate limit (распределённый)
        const wait = await checkMessageRateLimit(req.authToken);
        if (wait > 0) {
            return res.status(429).json({ error: `Подождите ${wait} сек.` });
        }

        const ticket = await kv.get(K.TICKET(id));
        if (!ticket) {
            return res.status(404).json({ error: 'Тикет не найден' });
        }
        if (ticket.status === 'closed' && req.session.role !== 'admin') {
            return res.status(403).json({ error: 'Тикет закрыт. Только администратор может переоткрыть его.' });
        }

        // Проверка доступа
        if (req.session.role !== 'admin' && ticket.userToken !== req.authToken) {
            return res.status(403).json({ error: 'Нет доступа' });
        }

        const now = new Date().toISOString();
        const message = {
            id: generateId(),
            from: req.session.role, // 'user' или 'admin'
            fromName: sanitize(req.session.name, 40),
            text: sanitize(text, 2000),
            createdAt: now
        };

        ticket.messages.push(message);
        ticket.updatedAt = now;
        if (ticket.status === 'closed' && req.session.role === 'user') {
            ticket.status = 'open'; // пользователь переоткрыл
        }

        await kv.set(K.TICKET(id), ticket);

        res.json({ message, ticket: { status: ticket.status, updatedAt: now } });
    } catch (err) {
        console.error('[support/messages POST]', err);
        res.status(500).json({ error: 'Ошибка отправки' });
    }
});

// Закрыть/переоткрыть тикет (только админ)
router.post('/tickets/:id/status', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!['open', 'closed'].includes(status)) {
            return res.status(400).json({ error: 'Неверный статус. Допустимые: open, closed' });
        }

        const ticket = await kv.get(K.TICKET(id));
        if (!ticket) {
            return res.status(404).json({ error: 'Тикет не найден' });
        }

        ticket.status = status;
        ticket.updatedAt = new Date().toISOString();
        await kv.set(K.TICKET(id), ticket);

        res.json({ ticket });
    } catch (err) {
        console.error('[support/status]', err);
        res.status(500).json({ error: 'Ошибка изменения статуса' });
    }
});

// -----------------------------
// Загрузка файлов (Vercel Blob)
// -----------------------------
const multer = require('multer');
const { put } = require('@vercel/blob');

// Настройка multer (память, лимит 10 MB)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10 MB
});

// Разрешённые MIME-типы
const ALLOWED_MIME = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'application/pdf', 'text/plain',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
];

router.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
    try {
        const file = req.file;
        if (!file) {
            return res.status(400).json({ error: 'Файл не загружен' });
        }

        // Проверка MIME
        if (!ALLOWED_MIME.includes(file.mimetype)) {
            return res.status(400).json({ error: 'Неподдерживаемый тип файла' });
        }

        // Генерация уникального имени
        const ext = file.originalname.split('.').pop();
        const fileName = `support/${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;

        let blobUrl;
        try {
            // Загрузка в Vercel Blob
            const blob = await put(fileName, file.buffer, {
                access: 'public',
                contentType: file.mimetype
            });
            blobUrl = blob.url;
        } catch (blobErr) {
            console.error('[support/upload] Blob error:', blobErr);
            // Fallback для разработки (не использовать в проде без хранилища)
            if (process.env.NODE_ENV !== 'production') {
                // Временно сохраняем как data URL (только для тестов)
                const base64 = file.buffer.toString('base64');
                blobUrl = `data:${file.mimetype};base64,${base64.substring(0, 100)}...[truncated]`;
                console.warn('[support/upload] Vercel Blob не настроен, используется data URL (только для разработки)');
            } else {
                throw new Error('Не удалось сохранить файл');
            }
        }

        res.json({
            url: blobUrl,
            name: file.originalname,
            size: file.size,
            contentType: file.mimetype
        });
    } catch (err) {
        console.error('[support/upload]', err);
        res.status(500).json({ error: 'Ошибка загрузки файла' });
    }
});

module.exports = router;