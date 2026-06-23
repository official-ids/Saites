const express = require('express');
const crypto = require('crypto');
const { kv } = require('@vercel/kv');

const router = express.Router();
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

// -----------------------------
// KV Keys
// -----------------------------
const K = {
    QUESTION: (id) => `answers:question:${id}`,
    QUESTIONS_INDEX: 'answers:questions:index',
    ANSWER: (id) => `answers:answer:${id}`,
    QUESTION_ANSWERS: (qid) => `answers:q_answers:${qid}`,
    USER_VOTES: (qid, userId) => `answers:votes:${qid}:${userId}`,
    REPUTATION: (userId) => `answers:rep:${userId}`,
    USER_SESSION: (token) => `answers:session:${token}`,
    
    // Новые ключи
    COMMENT: (id) => `answers:comment:${id}`,
    QUESTION_COMMENTS: (qid) => `answers:q_comments:${qid}`,
    ANSWER_COMMENTS: (aid) => `answers:a_comments:${aid}`,
    USER_FAVORITES: (userId) => `answers:favorites:${userId}`,
    QUESTION_VIEWS: (qid) => `answers:views:${qid}`,
    USER_QUESTIONS: (userId) => `answers:user_questions:${userId}`,
    USER_ANSWERS: (userId) => `answers:user_answers:${userId}`,
    REPORTS: 'answers:reports:index',
    REPORT: (id) => `answers:report:${id}`,
    PINNED_QUESTIONS: 'answers:pinned:index',
    TAGS_INDEX: 'answers:tags:index',
    TAG_QUESTIONS: (tag) => `answers:tag:${tag}`,
    BADGES: (userId) => `answers:badges:${userId}`,
    NOTIFICATIONS: (userId) => `answers:notif:${userId}`,
    SEARCH_INDEX: 'answers:search:index',
    EDIT_HISTORY: (type, id) => `answers:edithistory:${type}:${id}`,
    BLOCKED_USERS: 'answers:blocked:index'
};

// -----------------------------
// Helpers
// -----------------------------
function generateId() {
    return crypto.randomBytes(8).toString('hex');
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function sanitize(str) {
    if (!str) return '';
    return String(str).replace(/[<>]/g, '').trim().slice(0, 5000);
}

function sanitizeShort(str) {
    if (!str) return '';
    return String(str).replace(/[<>]/g, '').trim().slice(0, 500);
}

const CATEGORIES = ['tech', 'design', 'programming', 'games', 'other'];
const CATEGORY_NAMES = {
    tech: 'Технологии',
    design: 'Дизайн',
    programming: 'Программирование',
    games: 'Игры',
    other: 'Другое'
};

const BADGE_TYPES = {
    FIRST_QUESTION: { id: 'first_question', name: 'Первый вопрос', desc: 'Задал первый вопрос', icon: '❓' },
    FIRST_ANSWER: { id: 'first_answer', name: 'Первый ответ', desc: 'Дал первый ответ', icon: '💬' },
    HELPFUL: { id: 'helpful', name: 'Полезный', desc: '10+ голосов на ответе', icon: '⭐' },
    EXPERT: { id: 'expert', name: 'Эксперт', desc: '5 принятых ответов', icon: '🏆' },
    ACTIVE: { id: 'active', name: 'Активный', desc: '50+ действий', icon: '🔥' },
    POPULAR: { id: 'popular', name: 'Популярный', desc: 'Вопрос с 20+ голосами', icon: '📈' }
};

// -----------------------------
// Middleware
// -----------------------------
async function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        try {
            const session = await kv.get(K.USER_SESSION(token));
            if (session) req.user = session;
        } catch (e) {}
    }
    next();
}

async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const session = await kv.get(K.USER_SESSION(token));
        if (!session) return res.status(401).json({ error: 'Сессия истекла' });
        req.user = session;
        next();
    } catch (e) {
        return res.status(500).json({ error: 'Ошибка сессии' });
    }
}

function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Требуются права администратора' });
    }
    next();
}

// -----------------------------
// Badge System
// -----------------------------
async function checkAndAwardBadge(userId, badgeId) {
    try {
        const badges = (await kv.smembers(K.BADGES(userId))) || [];
        if (badges.includes(badgeId)) return false;
        
        await kv.sadd(K.BADGES(userId), badgeId);
        return true;
    } catch (e) {
        return false;
    }
}

async function sendNotification(userId, type, data) {
    try {
        const notif = {
            id: generateId(),
            type,
            data,
            read: false,
            createdAt: new Date().toISOString()
        };
        await kv.lpush(K.NOTIFICATIONS(userId), JSON.stringify(notif));
        await kv.ltrim(K.NOTIFICATIONS(userId), 0, 49); // Храним максимум 50
    } catch (e) {}
}

// -----------------------------
// Auth
// -----------------------------
router.post('/auth/register', async (req, res) => {
    try {
        const { nickname, token: existingToken } = req.body;
        
        if (existingToken) {
            const session = await kv.get(K.USER_SESSION(existingToken));
            if (session) return res.json({ session, token: existingToken });
        }

        if (!nickname || String(nickname).trim().length < 2) {
            return res.status(400).json({ error: 'Имя: минимум 2 символа' });
        }
        if (String(nickname).length > 30) {
            return res.status(400).json({ error: 'Имя: максимум 30 символов' });
        }

        const userId = 'u_' + crypto.randomBytes(6).toString('hex');
        const newToken = generateToken();
        const session = {
            id: userId,
            nickname: sanitize(nickname),
            role: 'user',
            reputation: 0,
            createdAt: new Date().toISOString(),
            bio: ''
        };
        await kv.set(K.USER_SESSION(newToken), session, { ex: 60 * 60 * 24 * 365 });
        await kv.set(K.REPUTATION(userId), 0);

        res.json({ session, token: newToken });
    } catch (err) {
        console.error('[answers/register]', err);
        res.status(500).json({ error: 'Ошибка регистрации' });
    }
});

router.post('/auth/admin', async (req, res) => {
    try {
        const { token } = req.body;
        if (!ADMIN_TOKEN || !token || token.length !== ADMIN_TOKEN.length ||
            !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN))) {
            return res.status(403).json({ error: 'Неверный токен' });
        }
        const userId = 'admin';
        const sessionToken = generateToken();
        const session = {
            id: userId,
            nickname: 'Oris Team',
            role: 'admin',
            reputation: 9999,
            createdAt: new Date().toISOString(),
            bio: 'Официальный аккаунт команды Oris'
        };
        await kv.set(K.USER_SESSION(sessionToken), session, { ex: 60 * 60 * 24 * 30 });
        res.json({ session, token: sessionToken });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

router.post('/auth/logout', requireAuth, async (req, res) => {
    const token = req.headers.authorization.split(' ')[1];
    await kv.del(K.USER_SESSION(token));
    res.json({ success: true });
});

// -----------------------------
// Profile & Settings
// -----------------------------
router.get('/me', requireAuth, async (req, res) => {
    const reputation = (await kv.get(K.REPUTATION(req.user.id))) || 0;
    const badges = (await kv.smembers(K.BADGES(req.user.id))) || [];
    const questionsCount = await kv.scard(K.USER_QUESTIONS(req.user.id)) || 0;
    const answersCount = await kv.scard(K.USER_ANSWERS(req.user.id)) || 0;
    
    res.json({ 
        ...req.user, 
        reputation, 
        badges: badges.map(b => BADGE_TYPES[b.toUpperCase()] || b),
        stats: { questionsCount, answersCount }
    });
});

router.put('/me', requireAuth, async (req, res) => {
    try {
        const { nickname, bio } = req.body;
        
        const token = req.headers.authorization.split(' ')[1];
        const session = await kv.get(K.USER_SESSION(token));
        
        if (nickname) {
            if (nickname.trim().length < 2) return res.status(400).json({ error: 'Имя: минимум 2 символа' });
            if (nickname.length > 30) return res.status(400).json({ error: 'Имя: максимум 30 символов' });
            session.nickname = sanitize(nickname);
        }
        
        if (bio !== undefined) {
            session.bio = sanitizeShort(bio);
        }
        
        await kv.set(K.USER_SESSION(token), session, { ex: 60 * 60 * 24 * 365 });
        res.json({ session });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

router.get('/users/:id/profile', optionalAuth, async (req, res) => {
    try {
        const reputation = (await kv.get(K.REPUTATION(req.params.id))) || 0;
        const badges = (await kv.smembers(K.BADGES(req.params.id))) || [];
        const questionIds = (await kv.smembers(K.USER_QUESTIONS(req.params.id))) || [];
        const answerIds = (await kv.smembers(K.USER_ANSWERS(req.params.id))) || [];
        
        // Получаем последние вопросы
        const questions = [];
        for (const qid of questionIds.slice(0, 5)) {
            const q = await kv.get(K.QUESTION(qid));
            if (q) questions.push(q);
        }
        
        res.json({
            userId: req.params.id,
            reputation,
            badges: badges.map(b => BADGE_TYPES[b.toUpperCase()] || b),
            stats: {
                questionsCount: questionIds.length,
                answersCount: answerIds.length
            },
            recentQuestions: questions
        });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

// -----------------------------
// Notifications
// -----------------------------
router.get('/notifications', requireAuth, async (req, res) => {
    try {
        const notifs = (await kv.lrange(K.NOTIFICATIONS(req.user.id), 0, 49)) || [];
        const notifications = notifs.map(n => JSON.parse(n));
        res.json({ notifications });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

router.post('/notifications/read', requireAuth, async (req, res) => {
    try {
        const notifs = (await kv.lrange(K.NOTIFICATIONS(req.user.id), 0, 49)) || [];
        const updated = notifs.map(n => {
            const obj = JSON.parse(n);
            obj.read = true;
            return JSON.stringify(obj);
        });
        
        await kv.del(K.NOTIFICATIONS(req.user.id));
        if (updated.length > 0) {
            await kv.rpush(K.NOTIFICATIONS(req.user.id), ...updated);
        }
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

router.get('/notifications/unread-count', requireAuth, async (req, res) => {
    try {
        const notifs = (await kv.lrange(K.NOTIFICATIONS(req.user.id), 0, 49)) || [];
        const unread = notifs.filter(n => !JSON.parse(n).read).length;
        res.json({ count: unread });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

// -----------------------------
// Questions
// -----------------------------
router.get('/questions', optionalAuth, async (req, res) => {
    try {
        const { category, tag, sort = 'new', page = 1, limit = 20, search } = req.query;
        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

        let questionIds = await kv.smembers(K.QUESTIONS_INDEX);
        if (!questionIds || questionIds.length === 0) {
            return res.json({ questions: [], total: 0, page: pageNum, limit: limitNum });
        }

        // Загружаем все вопросы
        const questions = [];
        for (const id of questionIds) {
            const q = await kv.get(K.QUESTION(id));
            if (q) questions.push(q);
        }

        // Поиск
        if (search) {
            const searchLower = search.toLowerCase();
            const filtered = questions.filter(q => 
                q.title.toLowerCase().includes(searchLower) ||
                (q.description && q.description.toLowerCase().includes(searchLower))
            );
            questions.length = 0;
            questions.push(...filtered);
        }

        // Фильтр по категории
        if (category && CATEGORIES.includes(category)) {
            const filtered = questions.filter(q => q.category === category);
            questions.length = 0;
            questions.push(...filtered);
        }

        // Фильтр по тегу
        if (tag) {
            const filtered = questions.filter(q => q.tags && q.tags.includes(tag));
            questions.length = 0;
            questions.push(...filtered);
        }

        // Закреплённые вопросы
        const pinnedIds = (await kv.smembers(K.PINNED_QUESTIONS)) || [];
        const pinned = questions.filter(q => pinnedIds.includes(q.id));
        const unpinned = questions.filter(q => !pinnedIds.includes(q.id));

        // Сортировка
        if (sort === 'popular') {
            unpinned.sort((a, b) => (b.votes || 0) - (a.votes || 0));
        } else if (sort === 'unanswered') {
            const unanswered = unpinned.filter(q => (q.answersCount || 0) === 0);
            unpinned.length = 0;
            unpinned.push(...unanswered);
            unpinned.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        } else if (sort === 'hot') {
            unpinned.sort((a, b) => {
                const scoreA = (a.votes || 0) + (a.answersCount || 0) * 2;
                const scoreB = (b.votes || 0) + (b.answersCount || 0) * 2;
                return scoreB - scoreA;
            });
        } else if (sort === 'views') {
            unpinned.sort((a, b) => (b.views || 0) - (a.views || 0));
        } else {
            unpinned.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        }

        const combined = [...pinned, ...unpinned];
        const total = combined.length;
        const paginated = combined.slice((pageNum - 1) * limitNum, pageNum * limitNum);

        res.json({ questions: paginated, total, page: pageNum, limit: limitNum });
    } catch (err) {
        console.error('[answers/questions]', err);
        res.status(500).json({ error: 'Ошибка загрузки' });
    }
});

router.get('/questions/:id', optionalAuth, async (req, res) => {
    try {
        const question = await kv.get(K.QUESTION(req.params.id));
        if (!question) return res.status(404).json({ error: 'Вопрос не найден' });

        // Увеличиваем счётчик просмотров
        if (req.user?.id !== question.authorId) {
            const views = (await kv.incr(K.QUESTION_VIEWS(req.params.id))) || 1;
            question.views = views;
            await kv.set(K.QUESTION(req.params.id), question);
        } else {
            question.views = (await kv.get(K.QUESTION_VIEWS(req.params.id))) || 0;
        }

        // Загружаем ответы
        const answerIds = await kv.smembers(K.QUESTION_ANSWERS(req.params.id));
        const answers = [];
        for (const aid of answerIds || []) {
            const a = await kv.get(K.ANSWER(aid));
            if (a) {
                // Загружаем комментарии ответа
                const commentIds = (await kv.lrange(K.ANSWER_COMMENTS(aid), 0, 9)) || [];
                a.comments = [];
                for (const cid of commentIds) {
                    const c = await kv.get(K.COMMENT(cid));
                    if (c) a.comments.push(c);
                }
                answers.push(a);
            }
        }

        // Сортировка: лучший ответ первым, затем по голосам
        answers.sort((a, b) => {
            if (a.isAccepted && !b.isAccepted) return -1;
            if (!a.isAccepted && b.isAccepted) return 1;
            return (b.votes || 0) - (a.votes || 0);
        });

        // Загружаем комментарии вопроса
        const qCommentIds = (await kv.lrange(K.QUESTION_COMMENTS(req.params.id), 0, 9)) || [];
        question.comments = [];
        for (const cid of qCommentIds) {
            const c = await kv.get(K.COMMENT(cid));
            if (c) question.comments.push(c);
        }

        // Голос пользователя
        let userVote = null;
        if (req.user) {
            userVote = await kv.get(K.USER_VOTES(req.params.id, req.user.id));
            
            // Избранное
            const isFav = await kv.sismember(K.USER_FAVORITES(req.user.id), req.params.id);
            question.isFavorite = isFav === 1;
        }

        question.answers = answers;
        question.userVote = userVote;

        res.json({ question });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

router.post('/questions', requireAuth, async (req, res) => {
    try {
        const { title, description, category, tags } = req.body;

        if (!title || title.trim().length < 10) {
            return res.status(400).json({ error: 'Заголовок: минимум 10 символов' });
        }
        if (title.length > 200) {
            return res.status(400).json({ error: 'Заголовок: максимум 200 символов' });
        }
        if (!CATEGORIES.includes(category)) {
            return res.status(400).json({ error: 'Некорректная категория' });
        }

        // Обработка тегов
        let cleanTags = [];
        if (tags && Array.isArray(tags)) {
            cleanTags = tags
                .map(t => String(t).toLowerCase().replace(/[^a-zа-яё0-9]/gi, '').slice(0, 20))
                .filter(t => t.length >= 2)
                .slice(0, 5);
        }

        const qid = generateId();
        const question = {
            id: qid,
            title: sanitize(title),
            description: sanitize(description || ''),
            category,
            tags: cleanTags,
            authorId: req.user.id,
            authorName: req.user.nickname,
            votes: 0,
            answersCount: 0,
            views: 0,
            hasAccepted: false,
            isLocked: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await kv.set(K.QUESTION(qid), question);
        await kv.sadd(K.QUESTIONS_INDEX, qid);
        await kv.sadd(K.USER_QUESTIONS(req.user.id), qid);
        await kv.set(K.QUESTION_VIEWS(qid), 0);

        // Добавляем теги в индекс
        for (const tag of cleanTags) {
            await kv.sadd(K.TAGS_INDEX, tag);
            await kv.sadd(K.TAG_QUESTIONS(tag), qid);
        }

        // Бейдж за первый вопрос
        const userQCount = await kv.scard(K.USER_QUESTIONS(req.user.id));
        if (userQCount === 1) {
            await checkAndAwardBadge(req.user.id, 'FIRST_QUESTION');
            sendNotification(req.user.id, 'badge', { badge: BADGE_TYPES.FIRST_QUESTION });
        }

        res.json({ question });
    } catch (err) {
        console.error('[answers/create]', err);
        res.status(500).json({ error: 'Ошибка создания' });
    }
});

router.put('/questions/:id', requireAuth, async (req, res) => {
    try {
        const question = await kv.get(K.QUESTION(req.params.id));
        if (!question) return res.status(404).json({ error: 'Не найден' });
        if (question.authorId !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Нет прав' });
        }

        const { title, description, tags } = req.body;
        const edits = [];

        if (title && title !== question.title) {
            if (title.trim().length < 10) return res.status(400).json({ error: 'Заголовок: минимум 10 символов' });
            if (title.length > 200) return res.status(400).json({ error: 'Заголовок: максимум 200 символов' });
            edits.push({ field: 'title', old: question.title, new: title });
            question.title = sanitize(title);
        }

        if (description !== undefined && description !== question.description) {
            edits.push({ field: 'description', old: question.description, new: description });
            question.description = sanitize(description || '');
        }

        if (tags && Array.isArray(tags)) {
            const cleanTags = tags
                .map(t => String(t).toLowerCase().replace(/[^a-zа-яё0-9]/gi, '').slice(0, 20))
                .filter(t => t.length >= 2)
                .slice(0, 5);
            
            // Удаляем старые теги
            for (const tag of (question.tags || [])) {
                await kv.srem(K.TAG_QUESTIONS(tag), req.params.id);
            }
            // Добавляем новые
            for (const tag of cleanTags) {
                await kv.sadd(K.TAGS_INDEX, tag);
                await kv.sadd(K.TAG_QUESTIONS(tag), req.params.id);
            }
            
            edits.push({ field: 'tags', old: question.tags, new: cleanTags });
            question.tags = cleanTags;
        }

        if (edits.length > 0) {
            question.updatedAt = new Date().toISOString();
            question.editCount = (question.editCount || 0) + 1;
            await kv.set(K.QUESTION(req.params.id), question);

            // Сохраняем историю изменений
            await kv.lpush(K.EDIT_HISTORY('question', req.params.id), JSON.stringify({
                edits,
                editedBy: req.user.id,
                editedAt: new Date().toISOString()
            }));
            await kv.ltrim(K.EDIT_HISTORY('question', req.params.id), 0, 9);
        }

        res.json({ question, edits });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

router.delete('/questions/:id', requireAuth, async (req, res) => {
    try {
        const q = await kv.get(K.QUESTION(req.params.id));
        if (!q) return res.status(404).json({ error: 'Не найден' });
        if (q.authorId !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Нет прав' });
        }

        // Удаляем ответы
        const answerIds = await kv.smembers(K.QUESTION_ANSWERS(req.params.id));
        for (const aid of answerIds || []) {
            await kv.del(K.ANSWER(aid));
            await kv.srem(K.USER_ANSWERS(q.authorId), aid);
            
            // Удаляем комментарии ответов
            const cIds = await kv.lrange(K.ANSWER_COMMENTS(aid), 0, -1);
            for (const cid of cIds) {
                await kv.del(K.COMMENT(cid));
            }
            await kv.del(K.ANSWER_COMMENTS(aid));
        }
        
        // Удаляем комментарии вопроса
        const qCommentIds = await kv.lrange(K.QUESTION_COMMENTS(req.params.id), 0, -1);
        for (const cid of qCommentIds) {
            await kv.del(K.COMMENT(cid));
        }

        await kv.del(K.QUESTION(req.params.id));
        await kv.srem(K.QUESTIONS_INDEX, req.params.id);
        await kv.del(K.QUESTION_ANSWERS(req.params.id));
        await kv.srem(K.USER_QUESTIONS(q.authorId), req.params.id);
        await kv.del(K.QUESTION_VIEWS(req.params.id));
        await kv.srem(K.PINNED_QUESTIONS, req.params.id);

        // Удаляем из тегов
        for (const tag of (q.tags || [])) {
            await kv.srem(K.TAG_QUESTIONS(tag), req.params.id);
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

// -----------------------------
// Edit History
// -----------------------------
router.get('/questions/:id/history', optionalAuth, async (req, res) => {
    try {
        const history = (await kv.lrange(K.EDIT_HISTORY('question', req.params.id), 0, 9)) || [];
        res.json({ history: history.map(h => JSON.parse(h)) });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

router.get('/answers/:id/history', optionalAuth, async (req, res) => {
    try {
        const history = (await kv.lrange(K.EDIT_HISTORY('answer', req.params.id), 0, 9)) || [];
        res.json({ history: history.map(h => JSON.parse(h)) });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

// -----------------------------
// Answers
// -----------------------------
router.post('/questions/:id/answers', requireAuth, async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || text.trim().length < 10) {
            return res.status(400).json({ error: 'Ответ: минимум 10 символов' });
        }
        if (text.length > 5000) {
            return res.status(400).json({ error: 'Ответ: максимум 5000 символов' });
        }

        const question = await kv.get(K.QUESTION(req.params.id));
        if (!question) return res.status(404).json({ error: 'Вопрос не найден' });
        if (question.isLocked) return res.status(403).json({ error: 'Вопрос заблокирован' });

        const aid = generateId();
        const answer = {
            id: aid,
            questionId: req.params.id,
            text: sanitize(text),
            authorId: req.user.id,
            authorName: req.user.nickname,
            votes: 0,
            isAccepted: false,
            editCount: 0,
            createdAt: new Date().toISOString()
        };

        await kv.set(K.ANSWER(aid), answer);
        await kv.sadd(K.QUESTION_ANSWERS(req.params.id), aid);
        await kv.sadd(K.USER_ANSWERS(req.user.id), aid);

        question.answersCount = (question.answersCount || 0) + 1;
        question.updatedAt = new Date().toISOString();
        await kv.set(K.QUESTION(req.params.id), question);

        // +1 репутации за ответ
        await kv.incr(K.REPUTATION(req.user.id));

        // Бейдж за первый ответ
        const userACount = await kv.scard(K.USER_ANSWERS(req.user.id));
        if (userACount === 1) {
            await checkAndAwardBadge(req.user.id, 'FIRST_ANSWER');
            sendNotification(req.user.id, 'badge', { badge: BADGE_TYPES.FIRST_ANSWER });
        }

        // Уведомление автору вопроса
        if (question.authorId !== req.user.id) {
            sendNotification(question.authorId, 'new_answer', {
                questionId: req.params.id,
                questionTitle: question.title,
                answerBy: req.user.nickname
            });
        }

        res.json({ answer });
    } catch (err) {
        console.error('[answers/answer]', err);
        res.status(500).json({ error: 'Ошибка' });
    }
});

router.put('/answers/:id', requireAuth, async (req, res) => {
    try {
        const answer = await kv.get(K.ANSWER(req.params.id));
        if (!answer) return res.status(404).json({ error: 'Не найден' });
        if (answer.authorId !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Нет прав' });
        }

        const { text } = req.body;
        if (!text || text.trim().length < 10) {
            return res.status(400).json({ error: 'Ответ: минимум 10 символов' });
        }
        if (text.length > 5000) {
            return res.status(400).json({ error: 'Ответ: максимум 5000 символов' });
        }

        if (text !== answer.text) {
            const oldText = answer.text;
            answer.text = sanitize(text);
            answer.editCount = (answer.editCount || 0) + 1;
            await kv.set(K.ANSWER(req.params.id), answer);

            await kv.lpush(K.EDIT_HISTORY('answer', req.params.id), JSON.stringify({
                oldText,
                newText: answer.text,
                editedBy: req.user.id,
                editedAt: new Date().toISOString()
            }));
            await kv.ltrim(K.EDIT_HISTORY('answer', req.params.id), 0, 9);
        }

        res.json({ answer });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

router.delete('/answers/:id', requireAuth, async (req, res) => {
    try {
        const answer = await kv.get(K.ANSWER(req.params.id));
        if (!answer) return res.status(404).json({ error: 'Не найден' });
        if (answer.authorId !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Нет прав' });
        }

        await kv.del(K.ANSWER(req.params.id));
        await kv.srem(K.QUESTION_ANSWERS(answer.questionId), req.params.id);
        await kv.srem(K.USER_ANSWERS(answer.authorId), req.params.id);

        // Удаляем комментарии
        const cIds = await kv.lrange(K.ANSWER_COMMENTS(req.params.id), 0, -1);
        for (const cid of cIds) {
            await kv.del(K.COMMENT(cid));
        }
        await kv.del(K.ANSWER_COMMENTS(req.params.id));

        const question = await kv.get(K.QUESTION(answer.questionId));
        if (question) {
            question.answersCount = Math.max(0, (question.answersCount || 0) - 1);
            if (question.acceptedAnswerId === req.params.id) {
                question.acceptedAnswerId = null;
                question.hasAccepted = false;
            }
            await kv.set(K.QUESTION(answer.questionId), question);
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

// -----------------------------
// Comments
// -----------------------------
router.post('/questions/:id/comments', requireAuth, async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || text.trim().length < 1) {
            return res.status(400).json({ error: 'Комментарий не может быть пустым' });
        }
        if (text.length > 500) {
            return res.status(400).json({ error: 'Комментарий: максимум 500 символов' });
        }

        const question = await kv.get(K.QUESTION(req.params.id));
        if (!question) return res.status(404).json({ error: 'Вопрос не найден' });

        const cid = generateId();
        const comment = {
            id: cid,
            text: sanitizeShort(text),
            authorId: req.user.id,
            authorName: req.user.nickname,
            createdAt: new Date().toISOString()
        };

        await kv.set(K.COMMENT(cid), comment);
        await kv.lpush(K.QUESTION_COMMENTS(req.params.id), cid);
        await kv.ltrim(K.QUESTION_COMMENTS(req.params.id), 0, 9); // Максимум 10 комментариев

        res.json({ comment });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

router.post('/answers/:id/comments', requireAuth, async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || text.trim().length < 1) {
            return res.status(400).json({ error: 'Комментарий не может быть пустым' });
        }
        if (text.length > 500) {
            return res.status(400).json({ error: 'Комментарий: максимум 500 символов' });
        }

        const answer = await kv.get(K.ANSWER(req.params.id));
        if (!answer) return res.status(404).json({ error: 'Ответ не найден' });

        const cid = generateId();
        const comment = {
            id: cid,
            text: sanitizeShort(text),
            authorId: req.user.id,
            authorName: req.user.nickname,
            createdAt: new Date().toISOString()
        };

        await kv.set(K.COMMENT(cid), comment);
        await kv.lpush(K.ANSWER_COMMENTS(req.params.id), cid);
        await kv.ltrim(K.ANSWER_COMMENTS(req.params.id), 0, 9);

        res.json({ comment });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

router.delete('/comments/:id', requireAuth, async (req, res) => {
    try {
        const comment = await kv.get(K.COMMENT(req.params.id));
        if (!comment) return res.status(404).json({ error: 'Не найден' });
        if (comment.authorId !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Нет прав' });
        }

        await kv.del(K.COMMENT(req.params.id));
        // Примечание: комментарий останется в списке, но при загрузке будет пропущен
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

// -----------------------------
// Voting
// -----------------------------
router.post('/questions/:id/vote', requireAuth, async (req, res) => {
    try {
        const { direction } = req.body; // 'up' or 'down'
        if (!['up', 'down'].includes(direction)) {
            return res.status(400).json({ error: 'Некорректное направление' });
        }

        const question = await kv.get(K.QUESTION(req.params.id));
        if (!question) return res.status(404).json({ error: 'Не найден' });
        if (question.authorId === req.user.id) {
            return res.status(400).json({ error: 'Нельзя голосовать за свой вопрос' });
        }

        const currentVote = await kv.get(K.USER_VOTES(req.params.id, req.user.id));
        let delta = 0;

        if (currentVote === direction) {
            // Отмена голоса
            await kv.del(K.USER_VOTES(req.params.id, req.user.id));
            delta = direction === 'up' ? -1 : 1;
        } else {
            if (currentVote) {
                // Смена голоса
                delta = direction === 'up' ? 2 : -2;
            } else {
                delta = direction === 'up' ? 1 : -1;
            }
            await kv.set(K.USER_VOTES(req.params.id, req.user.id), direction);
        }

        question.votes = (question.votes || 0) + delta;
        await kv.set(K.QUESTION(req.params.id), question);

        // Репутация автору
        await kv.incrby(K.REPUTATION(question.authorId), delta);

        // Бейдж за популярный вопрос
        if (question.votes >= 20) {
            const awarded = await checkAndAwardBadge(question.authorId, 'POPULAR');
            if (awarded) {
                sendNotification(question.authorId, 'badge', { badge: BADGE_TYPES.POPULAR });
            }
        }

        res.json({ votes: question.votes, userVote: currentVote === direction ? null : direction });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

router.post('/answers/:id/vote', requireAuth, async (req, res) => {
    try {
        const { direction } = req.body;
        if (!['up', 'down'].includes(direction)) {
            return res.status(400).json({ error: 'Некорректное направление' });
        }

        const answer = await kv.get(K.ANSWER(req.params.id));
        if (!answer) return res.status(404).json({ error: 'Не найден' });
        if (answer.authorId === req.user.id) {
            return res.status(400).json({ error: 'Нельзя голосовать за свой ответ' });
        }

        const voteKey = `answers:avotes:${req.params.id}:${req.user.id}`;
        const currentVote = await kv.get(voteKey);
        let delta = 0;

        if (currentVote === direction) {
            await kv.del(voteKey);
            delta = direction === 'up' ? -1 : 1;
        } else {
            if (currentVote) delta = direction === 'up' ? 2 : -2;
            else delta = direction === 'up' ? 1 : -1;
            await kv.set(voteKey, direction);
        }

        answer.votes = (answer.votes || 0) + delta;
        await kv.set(K.ANSWER(req.params.id), answer);

        await kv.incrby(K.REPUTATION(answer.authorId), delta);

        // Бейдж за полезный ответ
        if (answer.votes >= 10) {
            const awarded = await checkAndAwardBadge(answer.authorId, 'HELPFUL');
            if (awarded) {
                sendNotification(answer.authorId, 'badge', { badge: BADGE_TYPES.HELPFUL });
            }
        }

        res.json({ votes: answer.votes, userVote: currentVote === direction ? null : direction });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

// -----------------------------
// Accept answer
// -----------------------------
router.post('/answers/:id/accept', requireAuth, async (req, res) => {
    try {
        const answer = await kv.get(K.ANSWER(req.params.id));
        if (!answer) return res.status(404).json({ error: 'Не найден' });

        const question = await kv.get(K.QUESTION(answer.questionId));
        if (!question) return res.status(404).json({ error: 'Вопрос не найден' });
        if (question.authorId !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Только автор вопроса может принять ответ' });
        }

        // Снимаем предыдущий принятый ответ, если есть
        if (question.acceptedAnswerId) {
            const prev = await kv.get(K.ANSWER(question.acceptedAnswerId));
            if (prev) {
                prev.isAccepted = false;
                await kv.set(K.ANSWER(question.acceptedAnswerId), prev);
            }
        }

        answer.isAccepted = true;
        await kv.set(K.ANSWER(req.params.id), answer);

        question.acceptedAnswerId = req.params.id;
        question.hasAccepted = true;
        await kv.set(K.QUESTION(answer.questionId), question);

        // +15 репутации за принятый ответ
        await kv.incrby(K.REPUTATION(answer.authorId), 15);

        // Проверяем бейдж "Эксперт" (5 принятых ответов)
        const userAnswerIds = (await kv.smembers(K.USER_ANSWERS(answer.authorId))) || [];
        let acceptedCount = 0;
        for (const aid of userAnswerIds) {
            const a = await kv.get(K.ANSWER(aid));
            if (a && a.isAccepted) acceptedCount++;
        }
        if (acceptedCount >= 5) {
            const awarded = await checkAndAwardBadge(answer.authorId, 'EXPERT');
            if (awarded) {
                sendNotification(answer.authorId, 'badge', { badge: BADGE_TYPES.EXPERT });
            }
        }

        // Уведомление автору ответа
        if (answer.authorId !== question.authorId) {
            sendNotification(answer.authorId, 'answer_accepted', {
                questionId: question.id,
                questionTitle: question.title
            });
        }

        res.json({ success: true, answer });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

// -----------------------------
// Favorites
// -----------------------------
router.post('/questions/:id/favorite', requireAuth, async (req, res) => {
    try {
        const question = await kv.get(K.QUESTION(req.params.id));
        if (!question) return res.status(404).json({ error: 'Не найден' });

        const isMember = await kv.sismember(K.USER_FAVORITES(req.user.id), req.params.id);
        
        if (isMember === 1) {
            await kv.srem(K.USER_FAVORITES(req.user.id), req.params.id);
            res.json({ isFavorite: false });
        } else {
            await kv.sadd(K.USER_FAVORITES(req.user.id), req.params.id);
            res.json({ isFavorite: true });
        }
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

router.get('/favorites', requireAuth, async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

        const favIds = (await kv.smembers(K.USER_FAVORITES(req.user.id))) || [];
        const questions = [];
        for (const qid of favIds) {
            const q = await kv.get(K.QUESTION(qid));
            if (q) questions.push(q);
        }

        questions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const total = questions.length;
        const paginated = questions.slice((pageNum - 1) * limitNum, pageNum * limitNum);

        res.json({ questions: paginated, total, page: pageNum, limit: limitNum });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

// -----------------------------
// User content
// -----------------------------
router.get('/users/:id/questions', optionalAuth, async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

        const questionIds = (await kv.smembers(K.USER_QUESTIONS(req.params.id))) || [];
        const questions = [];
        for (const qid of questionIds) {
            const q = await kv.get(K.QUESTION(qid));
            if (q) questions.push(q);
        }

        questions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const total = questions.length;
        const paginated = questions.slice((pageNum - 1) * limitNum, pageNum * limitNum);

        res.json({ questions: paginated, total, page: pageNum, limit: limitNum });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

router.get('/users/:id/answers', optionalAuth, async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

        const answerIds = (await kv.smembers(K.USER_ANSWERS(req.params.id))) || [];
        const answers = [];
        for (const aid of answerIds) {
            const a = await kv.get(K.ANSWER(aid));
            if (a) answers.push(a);
        }

        answers.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const total = answers.length;
        const paginated = answers.slice((pageNum - 1) * limitNum, pageNum * limitNum);

        res.json({ answers: paginated, total, page: pageNum, limit: limitNum });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

// -----------------------------
// Tags
// -----------------------------
router.get('/tags', async (req, res) => {
    try {
        const tags = (await kv.smembers(K.TAGS_INDEX)) || [];
        const tagsWithCount = [];
        
        for (const tag of tags) {
            const count = await kv.scard(K.TAG_QUESTIONS(tag));
            tagsWithCount.push({ tag, count: count || 0 });
        }
        
        tagsWithCount.sort((a, b) => b.count - a.count);
        res.json({ tags: tagsWithCount });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

// -----------------------------
// Reports
// -----------------------------
router.post('/reports', requireAuth, async (req, res) => {
    try {
        const { targetType, targetId, reason } = req.body;
        
        if (!['question', 'answer', 'comment'].includes(targetType)) {
            return res.status(400).json({ error: 'Некорректный тип' });
        }
        if (!reason || reason.trim().length < 10) {
            return res.status(400).json({ error: 'Причина: минимум 10 символов' });
        }
        if (reason.length > 500) {
            return res.status(400).json({ error: 'Причина: максимум 500 символов' });
        }

        const reportId = generateId();
        const report = {
            id: reportId,
            targetType,
            targetId,
            reason: sanitizeShort(reason),
            reportedBy: req.user.id,
            reportedByName: req.user.nickname,
            status: 'pending',
            createdAt: new Date().toISOString()
        };

        await kv.set(K.REPORT(reportId), report);
        await kv.sadd(K.REPORTS, reportId);

        res.json({ success: true, reportId });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

router.get('/reports', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { status = 'pending' } = req.query;
        const reportIds = (await kv.smembers(K.REPORTS)) || [];
        const reports = [];
        
        for (const rid of reportIds) {
            const r = await kv.get(K.REPORT(rid));
            if (r && (!status || r.status === status)) {
                reports.push(r);
            }
        }

        reports.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.json({ reports });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

router.put('/reports/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { status, action } = req.body; // status: 'resolved', 'dismissed'
        const report = await kv.get(K.REPORT(req.params.id));
        if (!report) return res.status(404).json({ error: 'Не найдена' });

        report.status = status || 'resolved';
        report.resolvedBy = req.user.id;
        report.resolvedAt = new Date().toISOString();
        report.action = action; // 'delete', 'warn', 'none'
        
        await kv.set(K.REPORT(req.params.id), report);

        // Если действие - удалить контент
        if (action === 'delete') {
            if (report.targetType === 'question') {
                const q = await kv.get(K.QUESTION(report.targetId));
                if (q) {
                    await kv.del(K.QUESTION(report.targetId));
                    await kv.srem(K.QUESTIONS_INDEX, report.targetId);
                }
            } else if (report.targetType === 'answer') {
                await kv.del(K.ANSWER(report.targetId));
            } else if (report.targetType === 'comment') {
                await kv.del(K.COMMENT(report.targetId));
            }
        }

        res.json({ success: true, report });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

// -----------------------------
// Admin: Pin/Lock questions
// -----------------------------
router.post('/questions/:id/pin', requireAuth, requireAdmin, async (req, res) => {
    try {
        const question = await kv.get(K.QUESTION(req.params.id));
        if (!question) return res.status(404).json({ error: 'Не найден' });

        const isPinned = await kv.sismember(K.PINNED_QUESTIONS, req.params.id);
        if (isPinned === 1) {
            await kv.srem(K.PINNED_QUESTIONS, req.params.id);
            res.json({ isPinned: false });
        } else {
            await kv.sadd(K.PINNED_QUESTIONS, req.params.id);
            res.json({ isPinned: true });
        }
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

router.post('/questions/:id/lock', requireAuth, async (req, res) => {
    try {
        const question = await kv.get(K.QUESTION(req.params.id));
        if (!question) return res.status(404).json({ error: 'Не найден' });
        if (question.authorId !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Нет прав' });
        }

        question.isLocked = !question.isLocked;
        await kv.set(K.QUESTION(req.params.id), question);

        res.json({ isLocked: question.isLocked });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

// -----------------------------
// Admin: User management
// -----------------------------
router.get('/admin/users', requireAuth, requireAdmin, async (req, res) => {
    try {
        // Получаем всех пользователей через сессии (упрощённо)
        // В реальном приложении нужен отдельный индекс пользователей
        res.json({ message: 'Используйте поиск по конкретному пользователю' });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

router.post('/admin/users/:id/ban', requireAuth, requireAdmin, async (req, res) => {
    try {
        await kv.sadd(K.BLOCKED_USERS, req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

router.post('/admin/users/:id/unban', requireAuth, requireAdmin, async (req, res) => {
    try {
        await kv.srem(K.BLOCKED_USERS, req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

// -----------------------------
// Categories info
// -----------------------------
router.get('/categories', (req, res) => {
    res.json({ categories: CATEGORIES.map(c => ({ id: c, name: CATEGORY_NAMES[c] })) });
});

// -----------------------------
// Stats
// -----------------------------
router.get('/stats', async (req, res) => {
    try {
        const questionsCount = await kv.scard(K.QUESTIONS_INDEX) || 0;
        const tagsCount = await kv.scard(K.TAGS_INDEX) || 0;
        const reportsCount = await kv.scard(K.REPORTS) || 0;
        const pinnedCount = await kv.scard(K.PINNED_QUESTIONS) || 0;

        res.json({
            questionsCount,
            tagsCount,
            reportsCount,
            pinnedCount
        });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

module.exports = router;