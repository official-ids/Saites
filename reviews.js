// reviews.js (разместить в корне проекта, рядом с news.js)
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { kv } = require('@vercel/kv');
const { put } = require('@vercel/blob');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

// -----------------------------
// KV Keys
// -----------------------------
const K = {
  USER: (id) => `reviews:user:${id}`,
  USERS_INDEX: 'reviews:users:index',
  REVIEW: (id) => `reviews:review:${id}`,
  REVIEWS_INDEX: 'reviews:reviews:index',
  SESSION: (token) => `reviews:session:${token}`,
  BAN: (userId) => `reviews:ban:${userId}`
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

function hashPassword(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

// -----------------------------
// Middleware
// -----------------------------
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  const token = authHeader.split(' ')[1];
  const session = await kv.get(K.SESSION(token));
  if (!session) return res.status(401).json({ error: 'Сессия истекла' });
  
  const isBanned = await kv.get(K.BAN(session.id));
  if (isBanned) return res.status(403).json({ error: 'Аккаунт заблокирован' });

  req.user = session;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Требуются права администратора' });
  }
  next();
}

// -----------------------------
// Auth Routes
// -----------------------------
router.post('/auth/register', async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: 'Имя пользователя: 3-20 символов' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Пароль: минимум 6 символов' });
    }

    const existing = await kv.hget(K.USERS_INDEX, username.toLowerCase());
    if (existing) return res.status(409).json({ error: 'Имя пользователя занято' });

    const userId = generateId();
    const user = {
      id: userId,
      username: username.toLowerCase(),
      nickname: username,
      passwordHash: hashPassword(password),
      role: role === 'admin' && password === ADMIN_TOKEN ? 'admin' : 'user',
      avatar: null,
      createdAt: new Date().toISOString()
    };

    await kv.hset(K.USERS_INDEX, { [user.username]: userId });
    await kv.set(K.USER(userId), user);

    const token = generateToken();
    await kv.set(K.SESSION(token), { id: user.id, username: user.username, role: user.role, nickname: user.nickname, avatar: user.avatar }, { ex: 60 * 60 * 24 * 30 });

    res.json({ token, user: { id: user.id, username: user.username, nickname: user.nickname, role: user.role, avatar: user.avatar } });
  } catch (err) {
    console.error('[reviews/register]', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const userId = await kv.hget(K.USERS_INDEX, username.toLowerCase());
    if (!userId) return res.status(401).json({ error: 'Неверный логин или пароль' });

    const user = await kv.get(K.USER(userId));
    if (!user || user.passwordHash !== hashPassword(password)) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const isBanned = await kv.get(K.BAN(userId));
    if (isBanned) return res.status(403).json({ error: 'Аккаунт заблокирован: ' + isBanned.reason });

    const token = generateToken();
    await kv.set(K.SESSION(token), { id: user.id, username: user.username, role: user.role, nickname: user.nickname, avatar: user.avatar }, { ex: 60 * 60 * 24 * 30 });

    res.json({ token, user: { id: user.id, username: user.username, nickname: user.nickname, role: user.role, avatar: user.avatar } });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.post('/auth/logout', requireAuth, async (req, res) => {
  const token = req.headers.authorization.split(' ')[1];
  await kv.del(K.SESSION(token));
  res.json({ success: true });
});

// -----------------------------
// User Profile Routes
// -----------------------------
router.get('/me', requireAuth, async (req, res) => {
  const user = await kv.get(K.USER(req.user.id));
  res.json({ id: user.id, username: user.username, nickname: user.nickname, role: user.role, avatar: user.avatar });
});

router.put('/me', requireAuth, upload.single('avatar'), async (req, res) => {
  try {
    const { nickname, avatarUrl } = req.body;
    const user = await kv.get(K.USER(req.user.id));
    
    let newAvatar = user.avatar;
    if (req.file) {
      const ext = req.file.originalname.match(/\.[a-z0-9]+$/i)?.[0] || '.jpg';
      const blob = await put(`reviews/avatars/${req.user.id}${ext}`, req.file.buffer, { access: 'public' });
      newAvatar = blob.url;
    } else if (avatarUrl) {
      newAvatar = avatarUrl;
    }

    user.nickname = nickname || user.nickname;
    user.avatar = newAvatar;
    
    await kv.set(K.USER(req.user.id), user);
    
    // Обновляем сессию
    const token = req.headers.authorization.split(' ')[1];
    const session = await kv.get(K.SESSION(token));
    session.nickname = user.nickname;
    session.avatar = user.avatar;
    await kv.set(K.SESSION(token), session);

    res.json({ success: true, user: { id: user.id, username: user.username, nickname: user.nickname, role: user.role, avatar: user.avatar } });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка обновления профиля' });
  }
});

// -----------------------------
// Review Routes
// -----------------------------
router.get('/', async (req, res) => {
  try {
    const reviewIds = await kv.smembers(K.REVIEWS_INDEX);
    const reviews = [];
    for (const id of reviewIds) {
      const review = await kv.get(K.REVIEW(id));
      if (review) reviews.push(review);
    }
    // Сортировка: закрепленные первыми, затем по дате
    reviews.sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
    res.json({ reviews });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки отзывов' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const { rating, title, text } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Оценка от 1 до 5' });
    if (!text || text.trim().length < 10) return res.status(400).json({ error: 'Текст отзыва: мин. 10 символов' });

    const reviewId = generateId();
    const review = {
      id: reviewId,
      userId: req.user.id,
      userNickname: req.user.nickname,
      userAvatar: req.user.avatar,
      rating: parseInt(rating),
      title: title.trim(),
      text: text.trim(),
      likes: 0,
      isPinned: false,
      createdAt: new Date().toISOString(),
      ip: req.ip, // Для админа
      userAgent: req.headers['user-agent'] // Для админа
    };

    await kv.set(K.REVIEW(reviewId), review);
    await kv.sadd(K.REVIEWS_INDEX, reviewId);

    res.json({ success: true, review });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка создания отзыва' });
  }
});

router.post('/:id/like', requireAuth, async (req, res) => {
  try {
    const review = await kv.get(K.REVIEW(req.params.id));
    if (!review) return res.status(404).json({ error: 'Отзыв не найден' });
    
    // Простая реализация лайков (без защиты от повторных для краткости, можно добавить Set likes)
    review.likes = (review.likes || 0) + 1;
    await kv.set(K.REVIEW(req.params.id), review);
    res.json({ likes: review.likes });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// -----------------------------
// Admin Routes
// -----------------------------
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await kv.del(K.REVIEW(req.params.id));
    await kv.srem(K.REVIEWS_INDEX, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

router.post('/:id/pin', requireAuth, requireAdmin, async (req, res) => {
  try {
    const review = await kv.get(K.REVIEW(req.params.id));
    if (!review) return res.status(404).json({ error: 'Отзыв не найден' });
    review.isPinned = !review.isPinned;
    await kv.set(K.REVIEW(req.params.id), review);
    res.json({ success: true, isPinned: review.isPinned });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

router.post('/users/:id/ban', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    await kv.set(K.BAN(req.params.id), { reason: reason || 'Нарушение правил', date: new Date().toISOString() });
    
    // Удаляем все сессии пользователя (принудительный выход)
    // В реальном приложении нужен индекс сессий, здесь упрощенно
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка бана' });
  }
});

router.get('/users/:id/info', requireAuth, requireAdmin, async (req, res) => {
  try {
    const user = await kv.get(K.USER(req.params.id));
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    
    // Собираем статистику по отзывам
    const reviewIds = await kv.smembers(K.REVIEWS_INDEX);
    let userReviews = 0;
    let lastIp = 'Неизвестно';
    let lastUa = 'Неизвестно';

    for (const id of reviewIds) {
      const review = await kv.get(K.REVIEW(id));
      if (review && review.userId === user.id) {
        userReviews++;
        lastIp = review.ip || lastIp;
        lastUa = review.userAgent || lastUa;
      }
    }

    res.json({ 
      user: { id: user.id, username: user.username, nickname: user.nickname, role: user.role, createdAt: user.createdAt },
      stats: { reviewsCount: userReviews, lastIp, lastUa }
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

module.exports = router;