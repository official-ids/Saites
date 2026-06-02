const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { put } = require('@vercel/blob');
const { kv } = require('@vercel/kv');

// -----------------------------
// Конфигурация
// -----------------------------
const router = express.Router();
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 } // 50 MB
});

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const READER_ID_MIN = 1000;
const READER_ID_MAX = 9999;

// -----------------------------
// Префиксы ключей KV
// -----------------------------
const K = {
    USER: (id) => `news:user:${id}`,
    SESSION: (token) => `news:session:${token}`,
    POST: (id) => `news:post:${id}`,
    COMMENT: (id) => `news:comment:${id}`,
    COUNTER: (name) => `news:counter:${name}`,
    POST_LIKES: (id) => `news:post_likes:${id}`,
    POST_DISLIKES: (id) => `news:post_dislikes:${id}`,
    POST_FAV: (userId) => `news:favorites:${userId}`,
    COMMENT_LIKES: (id) => `news:comment_likes:${id}`,
    COMMENT_DISLIKES: (id) => `news:comment_dislikes:${id}`,
    POST_COMMENTS: (postId) => `news:post_comments:${postId}`,
    USER_COMMENTS: (userId) => `news:user_comments:${userId}`,
    POSTS_INDEX: 'news:posts:index'  // ← ДОБАВИТЬ ЭТУ СТРОКУ
};

// -----------------------------
// Middleware: Аутентификация (опциональная)
// -----------------------------
async function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        try {
            const session = await kv.get(K.SESSION(token));
            if (session) {
                req.user = session;
            }
        } catch (e) {
            // Игнорируем ошибки KV при опциональной авторизации
        }
    }
    next();
}

// -----------------------------
// Middleware: Обязательная аутентификация
// -----------------------------
async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }

    const token = authHeader.split(' ')[1];
    try {
        const session = await kv.get(K.SESSION(token));
        if (!session) {
            return res.status(401).json({ error: 'Сессия истекла' });
        }
        req.user = session;
        next();
    } catch (e) {
        return res.status(500).json({ error: 'Ошибка проверки сессии' });
    }
}

// -----------------------------
// Middleware: Только администратор
// -----------------------------
function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Требуются права администратора' });
    }
    next();
}

// -----------------------------
// Генераторы ID
// -----------------------------
function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

async function generateReaderId() {
    // Атомарный инкремент счётчика читателей
    const counter = await kv.incr(K.COUNTER('readers'));
    // Первый читатель получает 1000
    const id = READER_ID_MIN + counter - 1;
    
    if (id > READER_ID_MAX) {
        throw new Error('Достигнут лимит пользователей. Обратитесь к администратору.');
    }
    
    return String(id).padStart(4, '0');
}

// -----------------------------
// Вспомогательные функции
// -----------------------------
async function getPostWithUserData(postId, userId) {
    const post = await kv.get(K.POST(postId));
    if (!post) return null;

    // Счётчики likes/dislikes/commentsCount уже есть в объекте поста
    if (post.likes === undefined) post.likes = 0;
    if (post.dislikes === undefined) post.dislikes = 0;
    if (post.commentsCount === undefined) post.commentsCount = 0;

    if (userId) {
        const [likesSet, dislikesSet, favorites] = await Promise.all([
            kv.sismember(K.POST_LIKES(postId), userId),
            kv.sismember(K.POST_DISLIKES(postId), userId),
            kv.sismember(K.POST_FAV(userId), postId)
        ]);
        post.isLiked = !!likesSet;
        post.isDisliked = !!dislikesSet;
        post.isFavorited = !!favorites;
    } else {
        post.isLiked = false;
        post.isDisliked = false;
        post.isFavorited = false;
    }

    return post;
}

async function getCommentWithUserData(commentId, userId) {
    const comment = await kv.get(K.COMMENT(commentId));
    if (!comment) return null;

    const [likesSet, dislikesSet] = await Promise.all([
        kv.smembers(K.COMMENT_LIKES(commentId)),
        kv.smembers(K.COMMENT_DISLIKES(commentId))
    ]);

    comment.likes = likesSet.length;
    comment.dislikes = dislikesSet.length;
    comment.isLiked = userId ? likesSet.includes(userId) : false;
    comment.isDisliked = userId ? dislikesSet.includes(userId) : false;

    return comment;
}

// -----------------------------
// МАРШРУТЫ: Аутентификация
// -----------------------------

// Регистрация (читатель или администратор)
router.post('/auth/register', async (req, res) => {
    try {
        const { nickname, role, adminToken } = req.body;

        if (role === 'admin') {
            // Проверка admin token
            if (!ADMIN_TOKEN) {
                return res.status(500).json({ error: 'Admin token не настроен на сервере' });
            }
            if (!adminToken || !crypto.timingSafeEqual(
                Buffer.from(adminToken), 
                Buffer.from(ADMIN_TOKEN)
            )) {
                return res.status(403).json({ error: 'Неверный admin token' });
            }

            // Проверяем, существует ли уже админ
            const existingAdmin = await kv.get(K.USER('admin'));
            const adminId = 'admin';
            
            const adminUser = {
                id: adminId,
                role: 'admin',
                nickname: 'Oris',
                avatar: '/favicon.svg',
                createdAt: new Date().toISOString()
            };

            if (!existingAdmin) {
                await kv.set(K.USER(adminId), adminUser);
            }

            // Создаём сессию
            const token = generateToken();
            await kv.set(K.SESSION(token), adminUser, { ex: 60 * 60 * 24 * 30 }); // 30 дней

            return res.json({ user: { ...adminUser, token } });
        }

        if (role === 'reader') {
            if (!nickname || typeof nickname !== 'string') {
                return res.status(400).json({ error: 'Укажите имя пользователя' });
            }
            const cleanNickname = nickname.trim().slice(0, 30);
            if (cleanNickname.length < 2) {
                return res.status(400).json({ error: 'Имя должно содержать минимум 2 символа' });
            }

            // Генерируем уникальный ID
            const readerId = await generateReaderId();

            const readerUser = {
                id: readerId,
                role: 'reader',
                nickname: cleanNickname,
                createdAt: new Date().toISOString()
            };

            await kv.set(K.USER(readerId), readerUser);

            // Создаём сессию
            const token = generateToken();
            await kv.set(K.SESSION(token), readerUser, { ex: 60 * 60 * 24 * 365 }); // 1 год

            return res.json({ user: { ...readerUser, token } });
        }

        return res.status(400).json({ error: 'Неверная роль' });
    } catch (err) {
        console.error('[news/auth/register]', err);
        return res.status(500).json({ error: err.message || 'Ошибка регистрации' });
    }
});

// Вход читателя по ID
router.post('/auth/login', async (req, res) => {
    try {
        const { readerId } = req.body;

        if (!readerId || !/^\d{4}$/.test(readerId)) {
            return res.status(400).json({ error: 'ID должен состоять из 4 цифр' });
        }

        const user = await kv.get(K.USER(readerId));
        if (!user) {
            return res.status(404).json({ error: 'Пользователь с таким ID не найден' });
        }

        // Создаём новую сессию
        const token = generateToken();
        await kv.set(K.SESSION(token), user, { ex: 60 * 60 * 24 * 365 });

        return res.json({ user: { ...user, token } });
    } catch (err) {
        console.error('[news/auth/login]', err);
        return res.status(500).json({ error: 'Ошибка входа' });
    }
});

// Текущий пользователь
router.get('/auth/me', requireAuth, async (req, res) => {
    try {
        const user = await kv.get(K.USER(req.user.id));
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        return res.json(user);
    } catch (err) {
        console.error('[news/auth/me]', err);
        return res.status(500).json({ error: 'Ошибка получения профиля' });
    }
});

// -----------------------------
// МАРШРУТЫ: Посты
// -----------------------------

// Получить все посты
router.get('/posts', optionalAuth, async (req, res) => {
    try {
        // Получаем все ID постов из индекса (быстро, 1 запрос)
        const postIds = await kv.smembers(K.POSTS_INDEX);
        
        if (!postIds || postIds.length === 0) {
            return res.json({ posts: [] });
        }

        // Массовое получение всех постов одним запросом (вместо N запросов)
        const keys = postIds.map(id => K.POST(id));
        const postsData = await kv.mget(...keys);

        const posts = [];
        const userId = req.user?.id;

        for (const post of postsData) {
            if (post) {
                const enriched = await getPostWithUserData(post.id, userId);
                if (enriched) posts.push(enriched);
            }
        }

        return res.json({ posts });
    } catch (err) {
        console.error('[news/posts GET]', err);
        return res.status(500).json({ error: 'Ошибка загрузки постов' });
    }
});

// Создать пост (только админ)
router.post('/posts', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { title, content, files } = req.body;

        if (!title || typeof title !== 'string' || !title.trim()) {
            return res.status(400).json({ error: 'Укажите заголовок' });
        }
        if (!content || typeof content !== 'string' || !content.trim()) {
            return res.status(400).json({ error: 'Укажите содержание' });
        }
        if (title.length > 200) {
            return res.status(400).json({ error: 'Заголовок слишком длинный' });
        }
        if (content.length > 100000) {
            return res.status(400).json({ error: 'Содержание слишком длинное' });
        }

        const postId = crypto.randomUUID();
        const now = new Date().toISOString();

        const post = {
            id: postId,
            title: title.trim(),
            content: content,
            files: Array.isArray(files) ? files : [],
            authorId: req.user.id,
            authorRole: req.user.role,
            authorName: req.user.nickname,
            createdAt: now,
            updatedAt: now,
            isPinned: false,
            likes: 0,           // ← ДОБАВИТЬ
            dislikes: 0,        // ← ДОБАВИТЬ
            commentsCount: 0    // ← ДОБАВИТЬ
        };

        await kv.set(K.POST(postId), post);
        await kv.sadd(K.POSTS_INDEX, postId); 

        const enriched = await getPostWithUserData(postId, req.user.id);
        return res.json({ post: enriched });
    } catch (err) {
        console.error('[news/posts POST]', err);
        return res.status(500).json({ error: 'Ошибка создания поста' });
    }
});

// Обновить пост (только админ)
router.put('/posts/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, content, files } = req.body;

        const existing = await kv.get(K.POST(id));
        if (!existing) {
            return res.status(404).json({ error: 'Пост не найден' });
        }

        if (!title || !title.trim()) {
            return res.status(400).json({ error: 'Укажите заголовок' });
        }
        if (!content || !content.trim()) {
            return res.status(400).json({ error: 'Укажите содержание' });
        }

        const updated = {
            ...existing,
            title: title.trim(),
            content: content,
            files: Array.isArray(files) ? files : existing.files,
            updatedAt: new Date().toISOString()
        };

        await kv.set(K.POST(id), updated);

        const enriched = await getPostWithUserData(id, req.user.id);
        return res.json({ post: enriched });
    } catch (err) {
        console.error('[news/posts PUT]', err);
        return res.status(500).json({ error: 'Ошибка обновления поста' });
    }
});

// Удалить пост (только админ)
router.delete('/posts/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const existing = await kv.get(K.POST(id));
        if (!existing) {
            return res.status(404).json({ error: 'Пост не найден' });
        }

        // Удаляем все комментарии поста
        const commentIds = await kv.smembers(K.POST_COMMENTS(id));
        for (const cid of commentIds) {
            await kv.del(K.COMMENT(cid));
            await kv.del(K.COMMENT_LIKES(cid));
            await kv.del(K.COMMENT_DISLIKES(cid));
        }

        // Удаляем сам пост и связанные данные
        await kv.del(K.POST(id));
        await kv.srem(K.POSTS_INDEX, id);
        await kv.del(K.POST_LIKES(id));
        await kv.del(K.POST_DISLIKES(id));
        await kv.del(K.POST_COMMENTS(id));

        return res.json({ success: true });
    } catch (err) {
        console.error('[news/posts DELETE]', err);
        return res.status(500).json({ error: 'Ошибка удаления поста' });
    }
});

// Лайк поста
router.post('/posts/:id/like', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const post = await kv.get(K.POST(id));
        if (!post) return res.status(404).json({ error: 'Пост не найден' });

        // Используем транзакцию для атомарности
        const alreadyLiked = await kv.sismember(K.POST_LIKES(id), userId);
        const wasDisliked = await kv.sismember(K.POST_DISLIKES(id), userId);
        
        let newLikes = post.likes || 0;
        let newDislikes = post.dislikes || 0;

        if (alreadyLiked) {
            await kv.srem(K.POST_LIKES(id), userId);
            newLikes = Math.max(0, newLikes - 1);
        } else {
            await kv.sadd(K.POST_LIKES(id), userId);
            newLikes += 1;
            if (wasDisliked) {
                await kv.srem(K.POST_DISLIKES(id), userId);
                newDislikes = Math.max(0, newDislikes - 1);
            }
        }

        // Обновляем пост
        post.likes = newLikes;
        post.dislikes = newDislikes;
        await kv.set(K.POST(id), post);

        return res.json({
            likes: newLikes,
            dislikes: newDislikes,
            isLiked: !alreadyLiked,
            isDisliked: false
        });
    } catch (err) {
        console.error('[news/posts/like]', err);
        return res.status(500).json({ error: 'Ошибка лайка' });
    }
});

router.post('/posts/:id/dislike', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const post = await kv.get(K.POST(id));
        if (!post) return res.status(404).json({ error: 'Пост не найден' });

        const alreadyDisliked = await kv.sismember(K.POST_DISLIKES(id), userId);
        const wasLiked = await kv.sismember(K.POST_LIKES(id), userId);

        let newLikes = post.likes || 0;
        let newDislikes = post.dislikes || 0;

        if (alreadyDisliked) {
            await kv.srem(K.POST_DISLIKES(id), userId);
            newDislikes = Math.max(0, newDislikes - 1);
        } else {
            await kv.sadd(K.POST_DISLIKES(id), userId);
            newDislikes += 1;
            if (wasLiked) {
                await kv.srem(K.POST_LIKES(id), userId);
                newLikes = Math.max(0, newLikes - 1);
            }
        }

        post.likes = newLikes;
        post.dislikes = newDislikes;
        await kv.set(K.POST(id), post);

        return res.json({
            likes: newLikes,
            dislikes: newDislikes,
            isLiked: false,
            isDisliked: !alreadyDisliked
        });
    } catch (err) {
        console.error('[news/posts/dislike]', err);
        return res.status(500).json({ error: 'Ошибка дизлайка' });
    }
});

// Избранное
router.post('/posts/:id/favorite', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const post = await kv.get(K.POST(id));
        if (!post) {
            return res.status(404).json({ error: 'Пост не найден' });
        }

        const isFav = await kv.sismember(K.POST_FAV(userId), id);

        if (isFav) {
            await kv.srem(K.POST_FAV(userId), id);
        } else {
            await kv.sadd(K.POST_FAV(userId), id);
        }

        return res.json({ isFavorited: !isFav });
    } catch (err) {
        console.error('[news/posts/favorite]', err);
        return res.status(500).json({ error: 'Ошибка избранного' });
    }
});

// Закрепить/открепить пост (только админ)
router.post('/posts/:id/pin', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const post = await kv.get(K.POST(id));
        if (!post) {
            return res.status(404).json({ error: 'Пост не найден' });
        }

        post.isPinned = !post.isPinned;
        await kv.set(K.POST(id), post);

        return res.json({ isPinned: post.isPinned });
    } catch (err) {
        console.error('[news/posts/pin]', err);
        return res.status(500).json({ error: 'Ошибка закрепления' });
    }
});

// -----------------------------
// МАРШРУТЫ: Комментарии
// -----------------------------

// Получить комментарии поста
router.get('/posts/:postId/comments', optionalAuth, async (req, res) => {
    try {
        const { postId } = req.params;

        const post = await kv.get(K.POST(postId));
        if (!post) {
            return res.status(404).json({ error: 'Пост не найден' });
        }

        const commentIds = await kv.smembers(K.POST_COMMENTS(postId));
        const comments = [];

        for (const cid of commentIds) {
            const comment = await getCommentWithUserData(cid, req.user?.id);
            if (comment) comments.push(comment);
        }

        return res.json({ comments });
    } catch (err) {
        console.error('[news/comments GET]', err);
        return res.status(500).json({ error: 'Ошибка загрузки комментариев' });
    }
});

// Создать комментарий
router.post('/posts/:postId/comments', requireAuth, async (req, res) => {
    try {
        const { postId } = req.params;
        const { text, parentId } = req.body;

        if (!text || typeof text !== 'string' || !text.trim()) {
            return res.status(400).json({ error: 'Текст комментария не может быть пустым' });
        }
        if (text.length > 2000) {
            return res.status(400).json({ error: 'Комментарий слишком длинный (макс. 2000 символов)' });
        }

        const post = await kv.get(K.POST(postId));
        if (!post) {
            return res.status(404).json({ error: 'Пост не найден' });
        }

        // Если это ответ, проверяем что родительский комментарий существует
        if (parentId) {
            const parent = await kv.get(K.COMMENT(parentId));
            if (!parent || parent.postId !== postId) {
                return res.status(400).json({ error: 'Родительский комментарий не найден' });
            }
        }

        const commentId = crypto.randomUUID();
        const now = new Date().toISOString();

        const comment = {
            id: commentId,
            postId: postId,
            parentId: parentId || null,
            text: text.trim(),
            authorId: req.user.id,
            authorRole: req.user.role,
            authorName: req.user.nickname,
            createdAt: now,
            isEdited: false,
            isPinned: false
        };

        await kv.set(K.COMMENT(commentId), comment);
        await kv.sadd(K.POST_COMMENTS(postId), commentId);
                // Обновляем счётчик комментариев в посте
        const postForCount = await kv.get(K.POST(postId));
        if (postForCount) {
            postForCount.commentsCount = (postForCount.commentsCount || 0) + 1;
            await kv.set(K.POST(postId), postForCount);
        }
        await kv.sadd(K.USER_COMMENTS(req.user.id), commentId);

        const enriched = await getCommentWithUserData(commentId, req.user.id);
        return res.json({ comment: enriched });
    } catch (err) {
        console.error('[news/comments POST]', err);
        return res.status(500).json({ error: 'Ошибка создания комментария' });
    }
});

// Обновить комментарий (только автор)
router.put('/comments/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { text } = req.body;

        if (!text || !text.trim()) {
            return res.status(400).json({ error: 'Текст не может быть пустым' });
        }
        if (text.length > 2000) {
            return res.status(400).json({ error: 'Комментарий слишком длинный' });
        }

        const comment = await kv.get(K.COMMENT(id));
        if (!comment) {
            return res.status(404).json({ error: 'Комментарий не найден' });
        }

        if (comment.authorId !== req.user.id) {
            return res.status(403).json({ error: 'Можно редактировать только свои комментарии' });
        }

        comment.text = text.trim();
        comment.isEdited = true;
        await kv.set(K.COMMENT(id), comment);

        const enriched = await getCommentWithUserData(id, req.user.id);
        return res.json({ comment: enriched });
    } catch (err) {
        console.error('[news/comments PUT]', err);
        return res.status(500).json({ error: 'Ошибка редактирования' });
    }
});

// Удалить комментарий (автор или админ)
router.delete('/comments/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        const comment = await kv.get(K.COMMENT(id));
        if (!comment) {
            return res.status(404).json({ error: 'Комментарий не найден' });
        }

        const isOwner = comment.authorId === req.user.id;
        const isAdmin = req.user.role === 'admin';

        if (!isOwner && !isAdmin) {
            return res.status(403).json({ error: 'Недостаточно прав' });
        }

        // Рекурсивно удаляем ответы
        async function deleteWithReplies(commentId) {
            const allComments = await kv.smembers(K.POST_COMMENTS(comment.postId));
            for (const cid of allComments) {
                const c = await kv.get(K.COMMENT(cid));
                if (c && c.parentId === commentId) {
                    await deleteWithReplies(cid);
                }
            }
            await kv.del(K.COMMENT(commentId));
            await kv.del(K.COMMENT_LIKES(commentId));
            await kv.del(K.COMMENT_DISLIKES(commentId));
            await kv.srem(K.POST_COMMENTS(comment.postId), commentId);
                        // Уменьшаем счётчик в посте
            const pForCount = await kv.get(K.POST(comment.postId));
            if (pForCount) {
                pForCount.commentsCount = Math.max(0, (pForCount.commentsCount || 0) - 1);
                await kv.set(K.POST(comment.postId), pForCount);
            }
            if (comment.authorId) {
                await kv.srem(K.USER_COMMENTS(comment.authorId), commentId);
            }
        }

        await deleteWithReplies(id);

        return res.json({ success: true });
    } catch (err) {
        console.error('[news/comments DELETE]', err);
        return res.status(500).json({ error: 'Ошибка удаления' });
    }
});

// Лайк комментария
router.post('/comments/:id/like', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const comment = await kv.get(K.COMMENT(id));
        if (!comment) {
            return res.status(404).json({ error: 'Комментарий не найден' });
        }

        const alreadyLiked = await kv.sismember(K.COMMENT_LIKES(id), userId);

        if (alreadyLiked) {
            await kv.srem(K.COMMENT_LIKES(id), userId);
        } else {
            await kv.sadd(K.COMMENT_LIKES(id), userId);
            await kv.srem(K.COMMENT_DISLIKES(id), userId);
        }

        const likes = await kv.smembers(K.COMMENT_LIKES(id));
        const dislikes = await kv.smembers(K.COMMENT_DISLIKES(id));

        return res.json({
            likes: likes.length,
            dislikes: dislikes.length,
            isLiked: !alreadyLiked,
            isDisliked: false
        });
    } catch (err) {
        console.error('[news/comments/like]', err);
        return res.status(500).json({ error: 'Ошибка лайка' });
    }
});

// Дизлайк комментария
router.post('/comments/:id/dislike', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const comment = await kv.get(K.COMMENT(id));
        if (!comment) {
            return res.status(404).json({ error: 'Комментарий не найден' });
        }

        const alreadyDisliked = await kv.sismember(K.COMMENT_DISLIKES(id), userId);

        if (alreadyDisliked) {
            await kv.srem(K.COMMENT_DISLIKES(id), userId);
        } else {
            await kv.sadd(K.COMMENT_DISLIKES(id), userId);
            await kv.srem(K.COMMENT_LIKES(id), userId);
        }

        const likes = await kv.smembers(K.COMMENT_LIKES(id));
        const dislikes = await kv.smembers(K.COMMENT_DISLIKES(id));

        return res.json({
            likes: likes.length,
            dislikes: dislikes.length,
            isLiked: false,
            isDisliked: !alreadyDisliked
        });
    } catch (err) {
        console.error('[news/comments/dislike]', err);
        return res.status(500).json({ error: 'Ошибка дизлайка' });
    }
});

// Закрепить/открепить комментарий (только админ)
router.post('/comments/:id/pin', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const comment = await kv.get(K.COMMENT(id));
        if (!comment) {
            return res.status(404).json({ error: 'Комментарий не найден' });
        }

        comment.isPinned = !comment.isPinned;
        await kv.set(K.COMMENT(id), comment);

        return res.json({ isPinned: comment.isPinned });
    } catch (err) {
        console.error('[news/comments/pin]', err);
        return res.status(500).json({ error: 'Ошибка закрепления' });
    }
});

// -----------------------------
// МАРШРУТ: Загрузка файлов
// -----------------------------
router.post('/upload', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Файл не загружен' });
        }

        if (req.file.size > MAX_FILE_SIZE) {
            return res.status(413).json({ error: 'Файл превышает 50 МБ' });
        }

        // Генерируем уникальное имя
        const ext = req.file.originalname.split('.').pop() || 'bin';
        const uniqueName = `${crypto.randomUUID()}.${ext}`;
        const blobPath = `news-files/${uniqueName}`;

        // Загружаем в Vercel Blob
        const blob = await put(blobPath, req.file.buffer, {
            access: 'public',
            addRandomSuffix: false,
            contentType: req.file.mimetype || 'application/octet-stream'
        });

        return res.json({
            url: blob.url,
            name: req.file.originalname,
            size: req.file.size,
            contentType: req.file.mimetype
        });
    } catch (err) {
        console.error('[news/upload]', err);
        return res.status(500).json({ error: 'Ошибка загрузки файла: ' + err.message });
    }
});

// -----------------------------
// Экспорт
// -----------------------------
module.exports = router;