const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
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

// Разрешенные MIME-типы для загрузки
const ALLOWED_MIMETYPES = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 
    'application/pdf', 'video/mp4'
];

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
    USER_STATS: (id) => `news:stats:${id}`,
    USER_LEVEL: (id) => `news:level:${id}`,
    POSTS_INDEX: 'news:posts:index'
};

// -----------------------------
// Вспомогательные функции работы с KV
// -----------------------------

/**
 * Пакетное получение ключей с учетом лимитов Vercel KV
 */
async function mgetChunked(keys, chunkSize = 100) {
    const results = [];
    for (let i = 0; i < keys.length; i += chunkSize) {
        const chunk = keys.slice(i, i + chunkSize);
        if (chunk.length > 0) {
            const res = await kv.mget(...chunk);
            results.push(...res);
        }
    }
    return results;
}

// -----------------------------
// Система уровней
// -----------------------------
const LEVEL_THRESHOLDS = {
    newbie: { comments: 0, likesReceived: 0 },
    active: { comments: 10, likesReceived: 20 },
    expert: { comments: 50, likesReceived: 100 },
    plus: { comments: 200, likesReceived: 500 }
};

async function calculateUserLevel(userId) {
    if (!userId || userId === 'admin') return 'admin';
    
    const currentLevel = await kv.get(K.USER_LEVEL(userId)) || 'newbie';
    if (currentLevel === 'plus') return 'plus';
    
    const stats = await kv.get(K.USER_STATS(userId)) || { comments: 0, likesReceived: 0 };
    
    let newLevel = 'newbie';
    if (stats.comments >= LEVEL_THRESHOLDS.active.comments && stats.likesReceived >= LEVEL_THRESHOLDS.active.likesReceived) newLevel = 'active';
    if (stats.comments >= LEVEL_THRESHOLDS.expert.comments && stats.likesReceived >= LEVEL_THRESHOLDS.expert.likesReceived) newLevel = 'expert';
    if (stats.comments >= LEVEL_THRESHOLDS.plus.comments && stats.likesReceived >= LEVEL_THRESHOLDS.plus.likesReceived) newLevel = 'plus';
    
    if (newLevel !== currentLevel) {
        await kv.set(K.USER_LEVEL(userId), newLevel);
    }
    
    return newLevel;
}

async function getUserLevel(userId) {
    if (!userId) return 'newbie';
    if (userId === 'admin') return 'admin';
    return await kv.get(K.USER_LEVEL(userId)) || 'newbie';
}

async function incrementUserStats(userId, field, delta = 1) {
    if (!userId || userId === 'admin') return;
    const stats = await kv.get(K.USER_STATS(userId)) || { comments: 0, likesReceived: 0 };
    stats[field] = (stats[field] || 0) + delta;
    await kv.set(K.USER_STATS(userId), stats);
    await calculateUserLevel(userId);
    return stats;
}

// -----------------------------
// Middleware: Аутентификация
// -----------------------------
async function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        try {
            const session = await kv.get(K.SESSION(token));
            if (session) req.user = session;
        } catch (e) { /* Игнорируем ошибки KV */ }
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
        const session = await kv.get(K.SESSION(token));
        if (!session) return res.status(401).json({ error: 'Сессия истекла' });
        req.user = session;
        next();
    } catch (e) {
        return res.status(500).json({ error: 'Ошибка проверки сессии' });
    }
}

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
    const counter = await kv.incr(K.COUNTER('readers'));
    const id = READER_ID_MIN + counter - 1;
    
    if (id > READER_ID_MAX) {
        throw new Error('Достигнут лимит пользователей.');
    }
    
    return String(id).padStart(4, '0');
}

// -----------------------------
// Формирование объектов с данными пользователя
// -----------------------------
async function getPostWithUserData(postId, userId) {
    const post = await kv.get(K.POST(postId));
    if (!post) return null;

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

    const [likesCount, dislikesCount, isLiked, isDisliked] = await Promise.all([
        kv.scard(K.COMMENT_LIKES(commentId)),
        kv.scard(K.COMMENT_DISLIKES(commentId)),
        userId ? kv.sismember(K.COMMENT_LIKES(commentId), userId) : Promise.resolve(0),
        userId ? kv.sismember(K.COMMENT_DISLIKES(commentId), userId) : Promise.resolve(0)
    ]);

    comment.likes = likesCount;
    comment.dislikes = dislikesCount;
    comment.isLiked = isLiked === 1;
    comment.isDisliked = isDisliked === 1;
    comment.authorLevel = await getUserLevel(comment.authorId);

    return comment;
}

// -----------------------------
// МАРШРУТЫ: Аутентификация
// -----------------------------

router.post('/auth/register', async (req, res) => {
    try {
        const { nickname, role, adminToken } = req.body;

        if (role === 'admin') {
            if (!ADMIN_TOKEN) return res.status(500).json({ error: 'Admin token не настроен' });
            
            const isTokenValid = adminToken 
                && adminToken.length === ADMIN_TOKEN.length
                && crypto.timingSafeEqual(Buffer.from(adminToken), Buffer.from(ADMIN_TOKEN));
            
            if (!isTokenValid) return res.status(403).json({ error: 'Неверный admin token' });

            const existingAdmin = await kv.get(K.USER('admin'));
            const adminId = 'admin';
            
            const adminUser = {
                id: adminId,
                role: 'admin',
                nickname: 'Oris',
                avatar: '/favicon.svg',
                createdAt: new Date().toISOString()
            };

            if (!existingAdmin) await kv.set(K.USER(adminId), adminUser);

            const token = generateToken();
            await kv.set(K.SESSION(token), adminUser, { ex: 60 * 60 * 24 * 30 });

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

            const readerId = await generateReaderId();

            const readerUser = {
                id: readerId,
                role: 'reader',
                nickname: cleanNickname,
                level: 'newbie',
                createdAt: new Date().toISOString()
            };

            await kv.set(K.USER(readerId), readerUser);
            await kv.set(K.USER_LEVEL(readerId), 'newbie');
            await kv.set(K.USER_STATS(readerId), { comments: 0, likesReceived: 0 });

            const token = generateToken();
            await kv.set(K.SESSION(token), readerUser, { ex: 60 * 60 * 24 * 365 });

            return res.json({ user: { ...readerUser, token } });
        }

        return res.status(400).json({ error: 'Неверная роль' });
    } catch (err) {
        console.error('[news/auth/register]', err);
        return res.status(500).json({ error: err.message || 'Ошибка регистрации' });
    }
});

router.post('/auth/login', async (req, res) => {
    try {
        const { readerId } = req.body;

        if (!readerId || !/^\d{4}$/.test(readerId)) {
            return res.status(400).json({ error: 'ID должен состоять из 4 цифр' });
        }

        const user = await kv.get(K.USER(readerId));
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

        const token = generateToken();
        await kv.set(K.SESSION(token), user, { ex: 60 * 60 * 24 * 365 });

        return res.json({ user: { ...user, token } });
    } catch (err) {
        console.error('[news/auth/login]', err);
        return res.status(500).json({ error: 'Ошибка входа' });
    }
});

router.get('/auth/me', requireAuth, async (req, res) => {
    try {
        const user = await kv.get(K.USER(req.user.id));
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
        user.level = await getUserLevel(req.user.id);
        return res.json(user);
    } catch (err) {
        console.error('[news/auth/me]', err);
        return res.status(500).json({ error: 'Ошибка получения профиля' });
    }
});

// -----------------------------
// МАРШРУТЫ: Посты
// -----------------------------

router.get('/posts', optionalAuth, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const page = Math.max(parseInt(req.query.page) || 1, 1);

        const postIds = await kv.smembers(K.POSTS_INDEX);
        if (!postIds || postIds.length === 0) {
            return res.json({ posts: [], total: 0, page, limit });
        }

        const keys = postIds.map(id => K.POST(id));
        const postsData = await mgetChunked(keys);

        // Фильтрация и сортировка по дате создания (новые сверху)
        const validPosts = postsData
            .filter(p => p && p.id)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        const total = validPosts.length;
        const startIndex = (page - 1) * limit;
        const paginatedPosts = validPosts.slice(startIndex, startIndex + limit);

        const posts = [];
        const userId = req.user?.id;

        for (const post of paginatedPosts) {
            const enriched = await getPostWithUserData(post.id, userId);
            if (enriched) posts.push(enriched);
        }

        return res.json({ posts, total, page, limit });
    } catch (err) {
        console.error('[news/posts GET]', err);
        return res.status(500).json({ error: 'Ошибка загрузки постов' });
    }
});

router.post('/posts', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { title, content, files } = req.body;

        if (!title || typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'Укажите заголовок' });
        if (!content || typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: 'Укажите содержание' });
        if (title.length > 200) return res.status(400).json({ error: 'Заголовок слишком длинный' });
        if (content.length > 100000) return res.status(400).json({ error: 'Содержание слишком длинное' });

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
            likes: 0,
            dislikes: 0,
            commentsCount: 0
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

router.put('/posts/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, content, files } = req.body;

        const existing = await kv.get(K.POST(id));
        if (!existing) return res.status(404).json({ error: 'Пост не найден' });

        if (!title || !title.trim()) return res.status(400).json({ error: 'Укажите заголовок' });
        if (!content || !content.trim()) return res.status(400).json({ error: 'Укажите содержание' });

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

router.delete('/posts/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const existing = await kv.get(K.POST(id));
        if (!existing) return res.status(404).json({ error: 'Пост не найден' });

        const commentIds = await kv.smembers(K.POST_COMMENTS(id));
        const deletePromises = [];
        
        for (const cid of commentIds) {
            deletePromises.push(kv.del(K.COMMENT(cid)));
            deletePromises.push(kv.del(K.COMMENT_LIKES(cid)));
            deletePromises.push(kv.del(K.COMMENT_DISLIKES(cid)));
        }

        deletePromises.push(kv.del(K.POST(id)));
        deletePromises.push(kv.srem(K.POSTS_INDEX, id));
        deletePromises.push(kv.del(K.POST_LIKES(id)));
        deletePromises.push(kv.del(K.POST_DISLIKES(id)));
        deletePromises.push(kv.del(K.POST_COMMENTS(id)));

        await Promise.all(deletePromises);

        return res.json({ success: true });
    } catch (err) {
        console.error('[news/posts DELETE]', err);
        return res.status(500).json({ error: 'Ошибка удаления поста' });
    }
});

router.post('/posts/:id/like', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const post = await kv.get(K.POST(id));
        if (!post) return res.status(404).json({ error: 'Пост не найден' });

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

        post.likes = newLikes;
        post.dislikes = newDislikes;
        await kv.set(K.POST(id), post);

        return res.json({ likes: newLikes, dislikes: newDislikes, isLiked: !alreadyLiked, isDisliked: false });
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

        return res.json({ likes: newLikes, dislikes: newDislikes, isLiked: false, isDisliked: !alreadyDisliked });
    } catch (err) {
        console.error('[news/posts/dislike]', err);
        return res.status(500).json({ error: 'Ошибка дизлайка' });
    }
});

router.post('/posts/:id/favorite', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const post = await kv.get(K.POST(id));
        if (!post) return res.status(404).json({ error: 'Пост не найден' });

        const isFav = await kv.sismember(K.POST_FAV(userId), id);

        if (isFav) await kv.srem(K.POST_FAV(userId), id);
        else await kv.sadd(K.POST_FAV(userId), id);

        return res.json({ isFavorited: !isFav });
    } catch (err) {
        console.error('[news/posts/favorite]', err);
        return res.status(500).json({ error: 'Ошибка избранного' });
    }
});

router.post('/posts/:id/pin', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const post = await kv.get(K.POST(id));
        if (!post) return res.status(404).json({ error: 'Пост не найден' });

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

router.get('/posts/:postId/comments', optionalAuth, async (req, res) => {
    try {
        const { postId } = req.params;
        const post = await kv.get(K.POST(postId));
        if (!post) return res.status(404).json({ error: 'Пост не найден' });

        const commentIds = await kv.smembers(K.POST_COMMENTS(postId));
        const keys = commentIds.map(cid => K.COMMENT(cid));
        const commentsData = await mgetChunked(keys);
        
        const comments = [];
        for (const comment of commentsData) {
            if (comment && comment.id) {
                const enriched = await getCommentWithUserData(comment.id, req.user?.id);
                if (enriched) comments.push(enriched);
            }
        }

        return res.json({ comments });
    } catch (err) {
        console.error('[news/comments GET]', err);
        return res.status(500).json({ error: 'Ошибка загрузки комментариев' });
    }
});

router.post('/posts/:postId/comments', requireAuth, async (req, res) => {
    try {
        const { postId } = req.params;
        const { text, parentId } = req.body;

        if (!text || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Текст не может быть пустым' });
        if (text.length > 2000) return res.status(400).json({ error: 'Комментарий слишком длинный' });

        const post = await kv.get(K.POST(postId));
        if (!post) return res.status(404).json({ error: 'Пост не найден' });

        if (parentId) {
            const parent = await kv.get(K.COMMENT(parentId));
            if (!parent || parent.postId !== postId) return res.status(400).json({ error: 'Родительский комментарий не найден' });
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
        
        const postForCount = await kv.get(K.POST(postId));
        if (postForCount) {
            postForCount.commentsCount = (postForCount.commentsCount || 0) + 1;
            await kv.set(K.POST(postId), postForCount);
        }
        
        await kv.sadd(K.USER_COMMENTS(req.user.id), commentId);
        await incrementUserStats(req.user.id, 'comments', 1);

        const enriched = await getCommentWithUserData(commentId, req.user.id);
        return res.json({ comment: enriched });
    } catch (err) {
        console.error('[news/comments POST]', err);
        return res.status(500).json({ error: 'Ошибка создания комментария' });
    }
});

router.put('/comments/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { text } = req.body;

        if (!text || !text.trim()) return res.status(400).json({ error: 'Текст не может быть пустым' });
        if (text.length > 2000) return res.status(400).json({ error: 'Комментарий слишком длинный' });

        const comment = await kv.get(K.COMMENT(id));
        if (!comment) return res.status(404).json({ error: 'Комментарий не найден' });
        if (comment.authorId !== req.user.id) return res.status(403).json({ error: 'Можно редактировать только свои комментарии' });

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

router.delete('/comments/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        const comment = await kv.get(K.COMMENT(id));
        if (!comment) return res.status(404).json({ error: 'Комментарий не найден' });

        const isOwner = comment.authorId === req.user.id;
        const isAdmin = req.user.role === 'admin';

        if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Недостаточно прав' });

        // Получаем все комментарии поста одним запросом для построения дерева в памяти
        const allCommentIds = await kv.smembers(K.POST_COMMENTS(comment.postId));
        const commentKeys = allCommentIds.map(cid => K.COMMENT(cid));
        const allCommentsData = await mgetChunked(commentKeys);
        
        const commentsMap = {};
        for (const c of allCommentsData) {
            if (c && c.id) commentsMap[c.id] = c;
        }

        const idsToDelete = [];
        
        // Рекурсивный сбор ID в памяти (без запросов к БД)
        function collectIds(currentId) {
            idsToDelete.push(currentId);
            for (const c of Object.values(commentsMap)) {
                if (c.parentId === currentId) {
                    collectIds(c.id);
                }
            }
        }
        
        collectIds(id);

        // Пакетное удаление
        const deletePromises = [];
        for (const cid of idsToDelete) {
            deletePromises.push(kv.del(K.COMMENT(cid)));
            deletePromises.push(kv.del(K.COMMENT_LIKES(cid)));
            deletePromises.push(kv.del(K.COMMENT_DISLIKES(cid)));
            deletePromises.push(kv.srem(K.POST_COMMENTS(comment.postId), cid));
            
            if (commentsMap[cid]?.authorId) {
                deletePromises.push(kv.srem(K.USER_COMMENTS(commentsMap[cid].authorId), cid));
            }
        }
        await Promise.all(deletePromises);

        // Корректировка счетчика в посте
        const postForCount = await kv.get(K.POST(comment.postId));
        if (postForCount) {
            postForCount.commentsCount = Math.max(0, (postForCount.commentsCount || 0) - idsToDelete.length);
            await kv.set(K.POST(comment.postId), postForCount);
        }

        return res.json({ success: true, deletedCount: idsToDelete.length });
    } catch (err) {
        console.error('[news/comments DELETE]', err);
        return res.status(500).json({ error: 'Ошибка удаления' });
    }
});

router.post('/comments/:id/like', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const comment = await kv.get(K.COMMENT(id));
        if (!comment) return res.status(404).json({ error: 'Комментарий не найден' });

        const alreadyLiked = await kv.sismember(K.COMMENT_LIKES(id), userId);
        const wasDisliked = await kv.sismember(K.COMMENT_DISLIKES(id), userId);

        if (alreadyLiked) {
            await kv.srem(K.COMMENT_LIKES(id), userId);
            if (comment.authorId && comment.authorId !== userId) {
                await incrementUserStats(comment.authorId, 'likesReceived', -1);
            }
        } else {
            await kv.sadd(K.COMMENT_LIKES(id), userId);
            if (wasDisliked) {
                await kv.srem(K.COMMENT_DISLIKES(id), userId);
            }
            if (comment.authorId && comment.authorId !== userId) {
                await incrementUserStats(comment.authorId, 'likesReceived', 1);
            }
        }

        const likesCount = await kv.scard(K.COMMENT_LIKES(id));
        const dislikesCount = await kv.scard(K.COMMENT_DISLIKES(id));

        return res.json({ likes: likesCount, dislikes: dislikesCount, isLiked: !alreadyLiked, isDisliked: false });
    } catch (err) {
        console.error('[news/comments/like]', err);
        return res.status(500).json({ error: 'Ошибка лайка' });
    }
});

router.post('/comments/:id/dislike', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const comment = await kv.get(K.COMMENT(id));
        if (!comment) return res.status(404).json({ error: 'Комментарий не найден' });

        const alreadyDisliked = await kv.sismember(K.COMMENT_DISLIKES(id), userId);
        const wasLiked = await kv.sismember(K.COMMENT_LIKES(id), userId);

        if (alreadyDisliked) {
            await kv.srem(K.COMMENT_DISLIKES(id), userId);
        } else {
            await kv.sadd(K.COMMENT_DISLIKES(id), userId);
            if (wasLiked) {
                await kv.srem(K.COMMENT_LIKES(id), userId);
                if (comment.authorId && comment.authorId !== userId) {
                    await incrementUserStats(comment.authorId, 'likesReceived', -1);
                }
            }
        }

        const likesCount = await kv.scard(K.COMMENT_LIKES(id));
        const dislikesCount = await kv.scard(K.COMMENT_DISLIKES(id));

        return res.json({ likes: likesCount, dislikes: dislikesCount, isLiked: false, isDisliked: !alreadyDisliked });
    } catch (err) {
        console.error('[news/comments/dislike]', err);
        return res.status(500).json({ error: 'Ошибка дизлайка' });
    }
});

router.post('/comments/:id/pin', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const comment = await kv.get(K.COMMENT(id));
        if (!comment) return res.status(404).json({ error: 'Комментарий не найден' });

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
        if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
        if (req.file.size > MAX_FILE_SIZE) return res.status(413).json({ error: 'Файл превышает 50 МБ' });
        
        // Проверка MIME-типа
        if (!ALLOWED_MIMETYPES.includes(req.file.mimetype)) {
            return res.status(400).json({ error: 'Неподдерживаемый формат файла' });
        }

        const ext = path.extname(req.file.originalname).toLowerCase() || '.bin';
        const uniqueName = `${crypto.randomUUID()}${ext}`;
        const blobPath = `news-files/${uniqueName}`;

        const blob = await put(blobPath, req.file.buffer, {
            access: 'public',
            addRandomSuffix: false,
            contentType: req.file.mimetype
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
// Экспорт маршрутизатора
// -----------------------------
module.exports = router;