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
    USER_SESSION: (token) => `answers:session:${token}`
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

const CATEGORIES = ['tech', 'design', 'programming', 'games', 'other'];
const CATEGORY_NAMES = {
    tech: 'Технологии',
    design: 'Дизайн',
    programming: 'Программирование',
    games: 'Игры',
    other: 'Другое'
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
            createdAt: new Date().toISOString()
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
            createdAt: new Date().toISOString()
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
// Questions
// -----------------------------
router.get('/questions', optionalAuth, async (req, res) => {
    try {
        const { category, sort = 'new', page = 1, limit = 20 } = req.query;
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

        // Фильтр по категории
        if (category && CATEGORIES.includes(category)) {
            const filtered = questions.filter(q => q.category === category);
            questions.length = 0;
            questions.push(...filtered);
        }

        // Сортировка
        if (sort === 'popular') {
            questions.sort((a, b) => (b.votes || 0) - (a.votes || 0));
        } else if (sort === 'unanswered') {
            const unanswered = questions.filter(q => (q.answersCount || 0) === 0);
            questions.length = 0;
            questions.push(...unanswered);
            questions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        } else if (sort === 'hot') {
            questions.sort((a, b) => {
                const scoreA = (a.votes || 0) + (a.answersCount || 0) * 2;
                const scoreB = (b.votes || 0) + (b.answersCount || 0) * 2;
                return scoreB - scoreA;
            });
        } else {
            questions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        }

        const total = questions.length;
        const paginated = questions.slice((pageNum - 1) * limitNum, pageNum * limitNum);

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

        // Загружаем ответы
        const answerIds = await kv.smembers(K.QUESTION_ANSWERS(req.params.id));
        const answers = [];
        for (const aid of answerIds || []) {
            const a = await kv.get(K.ANSWER(aid));
            if (a) answers.push(a);
        }

        // Сортировка: лучший ответ первым, затем по голосам
        answers.sort((a, b) => {
            if (a.isAccepted && !b.isAccepted) return -1;
            if (!a.isAccepted && b.isAccepted) return 1;
            return (b.votes || 0) - (a.votes || 0);
        });

        // Голос пользователя
        let userVote = null;
        if (req.user) {
            userVote = await kv.get(K.USER_VOTES(req.params.id, req.user.id));
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
        const { title, description, category } = req.body;

        if (!title || title.trim().length < 10) {
            return res.status(400).json({ error: 'Заголовок: минимум 10 символов' });
        }
        if (title.length > 200) {
            return res.status(400).json({ error: 'Заголовок: максимум 200 символов' });
        }
        if (!CATEGORIES.includes(category)) {
            return res.status(400).json({ error: 'Некорректная категория' });
        }

        const qid = generateId();
        const question = {
            id: qid,
            title: sanitize(title),
            description: sanitize(description || ''),
            category,
            authorId: req.user.id,
            authorName: req.user.nickname,
            votes: 0,
            answersCount: 0,
            hasAccepted: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await kv.set(K.QUESTION(qid), question);
        await kv.sadd(K.QUESTIONS_INDEX, qid);

        res.json({ question });
    } catch (err) {
        console.error('[answers/create]', err);
        res.status(500).json({ error: 'Ошибка создания' });
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
        }
        await kv.del(K.QUESTION(req.params.id));
        await kv.srem(K.QUESTIONS_INDEX, req.params.id);
        await kv.del(K.QUESTION_ANSWERS(req.params.id));

        res.json({ success: true });
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

        const aid = generateId();
        const answer = {
            id: aid,
            questionId: req.params.id,
            text: sanitize(text),
            authorId: req.user.id,
            authorName: req.user.nickname,
            votes: 0,
            isAccepted: false,
            createdAt: new Date().toISOString()
        };

        await kv.set(K.ANSWER(aid), answer);
        await kv.sadd(K.QUESTION_ANSWERS(req.params.id), aid);

        question.answersCount = (question.answersCount || 0) + 1;
        question.updatedAt = new Date().toISOString();
        await kv.set(K.QUESTION(req.params.id), question);

        // +1 репутации за ответ
        await kv.incr(K.REPUTATION(req.user.id));

        res.json({ answer });
    } catch (err) {
        console.error('[answers/answer]', err);
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

        const question = await kv.get(K.QUESTION(answer.questionId));
        if (question) {
            question.answersCount = Math.max(0, (question.answersCount || 0) - 1);
            await kv.set(K.QUESTION(answer.questionId), question);
        }

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

        res.json({ success: true, answer });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка' });
    }
});

// -----------------------------
// User stats
// -----------------------------
router.get('/me', requireAuth, async (req, res) => {
    const reputation = (await kv.get(K.REPUTATION(req.user.id))) || 0;
    res.json({ ...req.user, reputation });
});

// -----------------------------
// Categories info
// -----------------------------
router.get('/categories', (req, res) => {
    res.json({ categories: CATEGORIES.map(c => ({ id: c, name: CATEGORY_NAMES[c] })) });
});

module.exports = router;