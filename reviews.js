const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { kv } = require('@vercel/kv');
const { put } = require('@vercel/blob');

const router = express.Router();
const upload = multer({ 
  storage: multer.memoryStorage(), 
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Только изображения'));
  }
});

// ============================================
// Configuration
// ============================================
const CONFIG = {
  ADMIN_TOKEN: process.env.ADMIN_TOKEN,
  SESSION_TTL: 60 * 60 * 24 * 30, // 30 days
  PASSWORD_ITERATIONS: 100000,
  PASSWORD_KEY_LENGTH: 64,
  PASSWORD_SALT_BYTES: 16,
  RATE_LIMIT_WINDOW: 60 * 1000,
  RATE_LIMIT_MAX_REGISTRATION: 5,
  RATE_LIMIT_MAX_REVIEWS: 10,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID
};

if (!CONFIG.ADMIN_TOKEN) {
  console.warn('[Reviews] WARNING: ADMIN_TOKEN not set');
}

// ============================================
// KV Keys
// ============================================
const K = {
  USER: (id) => `reviews:user:${id}`,
  USERS_INDEX: 'reviews:users:index',
  USER_BY_USERNAME: (username) => `reviews:user:by_username:${username.toLowerCase()}`,
  REVIEW: (id) => `reviews:review:${id}`,
  REVIEWS_INDEX: 'reviews:reviews:index',
  SESSION: (token) => `reviews:session:${token}`,
  BAN: (userId) => `reviews:ban:${userId}`,
  REPORT: (id) => `reviews:report:${id}`,
  REPORTS_INDEX: 'reviews:reports:index',
  AUDIT: (id) => `reviews:audit:${id}`,
  AUDIT_INDEX: 'reviews:audit:index',
  RATE_LIMIT: (key) => `reviews:ratelimit:${key}`
};

// ============================================
// Utilities
// ============================================

/**
 * Генерация уникального ID
 * @returns {string}
 */
function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Генерация токена сессии
 * @returns {string}
 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Хеширование пароля с солью (PBKDF2)
 * @param {string} password
 * @returns {Promise<string>} Формат salt:hash
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(CONFIG.PASSWORD_SALT_BYTES).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, CONFIG.PASSWORD_ITERATIONS, CONFIG.PASSWORD_KEY_LENGTH, 'sha512', (err, key) => {
      if (err) reject(err);
      else resolve(`${salt}:${key.toString('hex')}`);
    });
  });
}

/**
 * Проверка пароля
 * @param {string} password
 * @param {string} stored - salt:hash
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, originalHash] = stored.split(':');
  return new Promise((resolve) => {
    crypto.pbkdf2(password, salt, CONFIG.PASSWORD_ITERATIONS, CONFIG.PASSWORD_KEY_LENGTH, 'sha512', (err, key) => {
      if (err) return resolve(false);
      try {
        resolve(crypto.timingSafeEqual(Buffer.from(key.toString('hex'), 'hex'), Buffer.from(originalHash, 'hex')));
      } catch {
        resolve(false);
      }
    });
  });
}

/**
 * Проверка rate limit
 * @param {string} key
 * @param {number} max
 * @returns {Promise<boolean>} true если разрешено
 */
async function checkRateLimit(key, max) {
  const rlKey = K.RATE_LIMIT(key);
  const data = await kv.hgetall(rlKey);
  const now = Date.now();
  
  if (!data || !data.count) {
    await kv.hset(rlKey, { count: '1', resetAt: String(now + CONFIG.RATE_LIMIT_WINDOW) });
    await kv.expire(rlKey, Math.ceil(CONFIG.RATE_LIMIT_WINDOW / 1000));
    return true;
  }
  
  const resetAt = parseInt(data.resetAt, 10);
  if (now > resetAt) {
    await kv.del(rlKey);
    await kv.hset(rlKey, { count: '1', resetAt: String(now + CONFIG.RATE_LIMIT_WINDOW) });
    await kv.expire(rlKey, Math.ceil(CONFIG.RATE_LIMIT_WINDOW / 1000));
    return true;
  }
  
  const count = parseInt(data.count, 10);
  if (count >= max) return false;
  
  await kv.hincrby(rlKey, 'count', 1);
  return true;
}

/**
 * Запись в audit log
 * @param {string} action
 * @param {string} userId
 * @param {string} target
 * @param {string} details
 */
async function auditLog(action, userId, target = '', details = '') {
  const id = generateId();
  const record = {
    id,
    action,
    userId,
    target,
    details,
    timestamp: new Date().toISOString()
  };
  await kv.hset(K.AUDIT(id), record);
  await kv.sadd(K.AUDIT_INDEX, id);
  await kv.expire(K.AUDIT(id), 60 * 60 * 24 * 90); // 90 дней
}

/**
 * Отправка уведомления в Telegram
 * @param {string} text
 */
async function sendTelegramNotification(text) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CONFIG.TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
  } catch (err) {
    console.error('[Reviews] Telegram notification error:', err.message);
  }
}

/**
 * Валидация username
 * @param {string} username
 * @returns {boolean}
 */
function isValidUsername(username) {
  return /^[a-zA-Z0-9_]{3,20}$/.test(username);
}

// ============================================
// Middleware
// ============================================

/**
 * Обязательная авторизация
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  const token = authHeader.split(' ')[1];
  const session = await kv.get(K.SESSION(token));
  if (!session) return res.status(401).json({ error: 'Сессия истекла' });
  
  const isBanned = await kv.get(K.BAN(session.id));
  if (isBanned) return res.status(403).json({ error: 'Аккаунт заблокирован: ' + isBanned.reason });

  req.user = session;
  req.authToken = token;
  next();
}

/**
 * Требуются права администратора
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Требуются права администратора' });
  }
  next();
}

// ============================================
// Auth Routes
// ============================================

/**
 * POST /auth/register — регистрация пользователя
 */
router.post('/auth/register', async (req, res) => {
  try {
    // Rate limit
    const ip = req.ip;
    if (!await checkRateLimit(`reg:${ip}`, CONFIG.RATE_LIMIT_MAX_REGISTRATION)) {
      return res.status(429).json({ error: 'Слишком много попыток регистрации. Попробуйте позже.' });
    }

    const { username, password, nickname } = req.body;
    
    if (!username || !isValidUsername(username)) {
      return res.status(400).json({ error: 'Имя пользователя: 3-20 символов (латиница, цифры, _)' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Пароль: минимум 6 символов' });
    }
    if (!nickname || nickname.trim().length < 2 || nickname.length > 30) {
      return res.status(400).json({ error: 'Ник: 2-30 символов' });
    }

    // Проверка уникальности
    const existingId = await kv.get(K.USER_BY_USERNAME(username.toLowerCase()));
    if (existingId) return res.status(409).json({ error: 'Имя пользователя занято' });

    const userId = generateId();
    const passwordHash = await hashPassword(password);
    
    const user = {
      id: userId,
      username: username.toLowerCase(),
      nickname: nickname.trim(),
      passwordHash,
      role: 'user',
      avatar: null,
      createdAt: new Date().toISOString()
    };

    // Сохранение
    await kv.set(K.USER(userId), user);
    await kv.set(K.USER_BY_USERNAME(username.toLowerCase()), userId);
    await kv.sadd(K.USERS_INDEX, userId);

    // Создание сессии
    const token = generateToken();
    const session = { 
      id: user.id, 
      username: user.username, 
      role: user.role, 
      nickname: user.nickname, 
      avatar: user.avatar 
    };
    await kv.set(K.SESSION(token), session, { ex: CONFIG.SESSION_TTL });

    // Telegram уведомление
    await sendTelegramNotification(
      `👤 <b>Новая регистрация</b>\n\n` +
      `Ник: ${nickname}\n` +
      `Username: @${username}\n` +
      `ID: <code>${userId}</code>`
    );

    res.json({ 
      token, 
      user: { 
        id: user.id, 
        username: user.username, 
        nickname: user.nickname, 
        role: user.role, 
        avatar: user.avatar 
      } 
    });
  } catch (err) {
    console.error('[reviews/register]', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

/**
 * POST /auth/login — вход пользователя
 */
router.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Укажите логин и пароль' });
    }

    const userId = await kv.get(K.USER_BY_USERNAME(username.toLowerCase()));
    if (!userId) return res.status(401).json({ error: 'Неверный логин или пароль' });

    const user = await kv.get(K.USER(userId));
    if (!user || !await verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const isBanned = await kv.get(K.BAN(userId));
    if (isBanned) return res.status(403).json({ error: 'Аккаунт заблокирован: ' + isBanned.reason });

    const token = generateToken();
    const session = { 
      id: user.id, 
      username: user.username, 
      role: user.role, 
      nickname: user.nickname, 
      avatar: user.avatar 
    };
    await kv.set(K.SESSION(token), session, { ex: CONFIG.SESSION_TTL });

    res.json({ 
      token, 
      user: { 
        id: user.id, 
        username: user.username, 
        nickname: user.nickname, 
        role: user.role, 
        avatar: user.avatar 
      } 
    });
  } catch (err) {
    console.error('[reviews/login]', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

/**
 * POST /auth/admin — вход администратора через ADMIN_TOKEN
 */
router.post('/auth/admin', async (req, res) => {
  try {
    const { adminToken } = req.body;
    if (!CONFIG.ADMIN_TOKEN || !adminToken) {
      return res.status(400).json({ error: 'Admin token не настроен' });
    }

    // Timing-safe сравнение
    const isValid = adminToken.length === CONFIG.ADMIN_TOKEN.length &&
      crypto.timingSafeEqual(Buffer.from(adminToken), Buffer.from(CONFIG.ADMIN_TOKEN));
    
    if (!isValid) {
      return res.status(403).json({ error: 'Неверный admin token' });
    }

    // Поиск или создание админ-аккаунта
    let adminId = await kv.get('reviews:admin_id');
    let user;
    
    if (adminId) {
      user = await kv.get(K.USER(adminId));
    }
    
    if (!user) {
      // Создаём админ-аккаунт
      adminId = generateId();
      user = {
        id: adminId,
        username: 'admin',
        nickname: 'Администратор',
        passwordHash: await hashPassword(crypto.randomBytes(32).toString('hex')), // случайный пароль
        role: 'admin',
        avatar: null,
        createdAt: new Date().toISOString()
      };
      await kv.set(K.USER(adminId), user);
      await kv.set(K.USER_BY_USERNAME('admin'), adminId);
      await kv.sadd(K.USERS_INDEX, adminId);
      await kv.set('reviews:admin_id', adminId);
      
      await auditLog('admin_account_created', adminId, '', 'Автоматическое создание при первом входе');
    }

    const token = generateToken();
    const session = { 
      id: user.id, 
      username: user.username, 
      role: user.role, 
      nickname: user.nickname, 
      avatar: user.avatar 
    };
    await kv.set(K.SESSION(token), session, { ex: CONFIG.SESSION_TTL });

    await auditLog('admin_login', user.id);

    res.json({ 
      token, 
      user: { 
        id: user.id, 
        username: user.username, 
        nickname: user.nickname, 
        role: user.role, 
        avatar: user.avatar 
      } 
    });
  } catch (err) {
    console.error('[reviews/admin]', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

/**
 * POST /auth/logout — выход
 */
router.post('/auth/logout', requireAuth, async (req, res) => {
  await kv.del(K.SESSION(req.authToken));
  res.json({ success: true });
});

// ============================================
// User Profile Routes
// ============================================

/**
 * GET /me — получение профиля
 */
router.get('/me', requireAuth, async (req, res) => {
  const user = await kv.get(K.USER(req.user.id));
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({ 
    id: user.id, 
    username: user.username, 
    nickname: user.nickname, 
    role: user.role, 
    avatar: user.avatar 
  });
});

/**
 * PUT /me — обновление профиля
 */
router.put('/me', requireAuth, upload.single('avatar'), async (req, res) => {
  try {
    const { nickname, avatarUrl } = req.body;
    const user = await kv.get(K.USER(req.user.id));
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    
    let newAvatar = user.avatar;
    if (req.file) {
      const ext = req.file.originalname.match(/\.[a-z0-9]+$/i)?.[0] || '.jpg';
      const blob = await put(`reviews/avatars/${req.user.id}${ext}`, req.file.buffer, { access: 'public' });
      newAvatar = blob.url;
    } else if (avatarUrl) {
      newAvatar = avatarUrl;
    }

    if (nickname && nickname.trim().length >= 2 && nickname.length <= 30) {
      user.nickname = nickname.trim();
    }
    user.avatar = newAvatar;
    
    await kv.set(K.USER(req.user.id), user);
    
    // Обновляем сессию
    const session = await kv.get(K.SESSION(req.authToken));
    session.nickname = user.nickname;
    session.avatar = user.avatar;
    await kv.set(K.SESSION(req.authToken), session);

    res.json({ 
      success: true, 
      user: { 
        id: user.id, 
        username: user.username, 
        nickname: user.nickname, 
        role: user.role, 
        avatar: user.avatar 
      } 
    });
  } catch (err) {
    console.error('[reviews/profile]', err);
    res.status(500).json({ error: 'Ошибка обновления профиля' });
  }
});

/**
 * POST /me/password — смена пароля
 */
router.post('/me/password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Новый пароль: минимум 6 символов' });
    }

    const user = await kv.get(K.USER(req.user.id));
    if (!await verifyPassword(currentPassword, user.passwordHash)) {
      return res.status(401).json({ error: 'Неверный текущий пароль' });
    }

    user.passwordHash = await hashPassword(newPassword);
    await kv.set(K.USER(req.user.id), user);

    await auditLog('password_changed', user.id);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка смены пароля' });
  }
});

// ============================================
// Review Routes
// ============================================

/**
 * GET / — список всех отзывов
 */
router.get('/', async (req, res) => {
  try {
    const reviewIds = await kv.smembers(K.REVIEWS_INDEX);
    const reviews = [];
    
    for (const id of reviewIds) {
      const review = await kv.get(K.REVIEW(id));
      if (review) {
        // Добавляем информацию о пользователе
        const user = await kv.get(K.USER(review.userId));
        if (user) {
          review.userNickname = user.nickname;
          review.userAvatar = user.avatar;
          review.userRole = user.role;
          // Подсчёт отзывов пользователя
          const userReviews = reviews.filter(r => r.userId === user.id).length + 
            (await kv.smembers(K.REVIEWS_INDEX)).filter(async rid => {
              const r = await kv.get(K.REVIEW(rid));
              return r && r.userId === user.id;
            }).length;
          review.userReviewCount = userReviews;
        }
        reviews.push(review);
      }
    }
    
    res.json({ reviews });
  } catch (err) {
    console.error('[reviews/list]', err);
    res.status(500).json({ error: 'Ошибка загрузки отзывов' });
  }
});

/**
 * POST / — создание отзыва
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    // Rate limit
    if (!await checkRateLimit(`review:${req.user.id}`, CONFIG.RATE_LIMIT_MAX_REVIEWS)) {
      return res.status(429).json({ error: 'Слишком много отзывов. Попробуйте позже.' });
    }

    const { rating, title, text } = req.body;
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Оценка от 1 до 5' });
    }
    if (!text || text.trim().length < 10) {
      return res.status(400).json({ error: 'Текст отзыва: мин. 10 символов' });
    }
    if (text.length > 2000) {
      return res.status(400).json({ error: 'Текст отзыва: макс. 2000 символов' });
    }
    if (title && title.length > 100) {
      return res.status(400).json({ error: 'Заголовок: макс. 100 символов' });
    }

    const reviewId = generateId();
    const review = {
      id: reviewId,
      userId: req.user.id,
      rating: parseInt(rating),
      title: title ? title.trim() : '',
      text: text.trim(),
      likes: 0,
      likedBy: [],
      reportedBy: [],
      reportsCount: 0,
      isPinned: false,
      isEdited: false,
      reply: null,
      createdAt: new Date().toISOString(),
      ip: req.ip,
      userAgent: req.headers['user-agent']
    };

    await kv.set(K.REVIEW(reviewId), review);
    await kv.sadd(K.REVIEWS_INDEX, reviewId);

    // Telegram уведомление
    await sendTelegramNotification(
      `⭐ <b>Новый отзыв</b> (${'★'.repeat(review.rating)})\n\n` +
      `<b>${review.title || '(без заголовка)'}</b>\n` +
      `${review.text.substring(0, 200)}${review.text.length > 200 ? '...' : ''}\n\n` +
      `Автор: ${req.user.nickname}`
    );

    res.json({ success: true, review });
  } catch (err) {
    console.error('[reviews/create]', err);
    res.status(500).json({ error: 'Ошибка создания отзыва' });
  }
});

/**
 * PUT /:id — редактирование отзыва (только автор)
 */
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const review = await kv.get(K.REVIEW(req.params.id));
    if (!review) return res.status(404).json({ error: 'Отзыв не найден' });
    if (review.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Нет прав на редактирование' });
    }

    const { title, text } = req.body;
    if (text && text.trim().length < 10) {
      return res.status(400).json({ error: 'Текст отзыва: мин. 10 символов' });
    }
    if (text && text.length > 2000) {
      return res.status(400).json({ error: 'Текст отзыва: макс. 2000 символов' });
    }

    if (title !== undefined) review.title = title.trim().substring(0, 100);
    if (text !== undefined) review.text = text.trim();
    review.isEdited = true;
    review.editedAt = new Date().toISOString();

    await kv.set(K.REVIEW(req.params.id), review);

    res.json({ success: true, review });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка обновления' });
  }
});

/**
 * POST /:id/like — лайк отзыва (1 лайк на пользователя)
 */
router.post('/:id/like', requireAuth, async (req, res) => {
  try {
    const review = await kv.get(K.REVIEW(req.params.id));
    if (!review) return res.status(404).json({ error: 'Отзыв не найден' });
    
    review.likedBy = review.likedBy || [];
    const idx = review.likedBy.indexOf(req.user.id);
    
    if (idx >= 0) {
      // Убираем лайк
      review.likedBy.splice(idx, 1);
      review.likes = Math.max(0, (review.likes || 1) - 1);
    } else {
      // Добавляем лайк
      review.likedBy.push(req.user.id);
      review.likes = (review.likes || 0) + 1;
    }
    
    await kv.set(K.REVIEW(req.params.id), review);
    res.json({ likes: review.likes, liked: idx < 0 });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

/**
 * POST /:id/report — жалоба на отзыв
 */
router.post('/:id/report', requireAuth, async (req, res) => {
  try {
    const review = await kv.get(K.REVIEW(req.params.id));
    if (!review) return res.status(404).json({ error: 'Отзыв не найден' });
    if (review.userId === req.user.id) {
      return res.status(400).json({ error: 'Нельзя пожаловаться на свой отзыв' });
    }

    review.reportedBy = review.reportedBy || [];
    if (review.reportedBy.includes(req.user.id)) {
      return res.status(400).json({ error: 'Вы уже жаловались на этот отзыв' });
    }

    const { reason, comment } = req.body;
    if (!reason) return res.status(400).json({ error: 'Укажите причину жалобы' });

    review.reportedBy.push(req.user.id);
    review.reportsCount = (review.reportsCount || 0) + 1;
    await kv.set(K.REVIEW(req.params.id), review);

    // Создаём запись жалобы
    const reportId = generateId();
    const report = {
      id: reportId,
      reviewId: review.id,
      reviewAuthorId: review.userId,
      reviewTitle: review.title,
      reviewText: review.text,
      reporterId: req.user.id,
      reporterName: req.user.nickname,
      reason,
      comment: comment || '',
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    await kv.set(K.REPORT(reportId), report);
    await kv.sadd(K.REPORTS_INDEX, reportId);

    // Telegram уведомление
    await sendTelegramNotification(
      `🚨 <b>Новая жалоба</b>\n\n` +
      `Причина: ${reason}\n` +
      `От: ${req.user.nickname}\n` +
      `На отзыв: ${review.title || review.text.substring(0, 100)}`
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

/**
 * POST /:id/reply — ответ на отзыв (только админ)
 */
router.post('/:id/reply', requireAuth, requireAdmin, async (req, res) => {
  try {
    const review = await kv.get(K.REVIEW(req.params.id));
    if (!review) return res.status(404).json({ error: 'Отзыв не найден' });

    const { text } = req.body;
    if (!text || text.trim().length < 5) {
      return res.status(400).json({ error: 'Ответ: мин. 5 символов' });
    }
    if (text.length > 1000) {
      return res.status(400).json({ error: 'Ответ: макс. 1000 символов' });
    }

    review.reply = {
      text: text.trim(),
      authorId: req.user.id,
      authorName: req.user.nickname,
      isAdmin: true,
      createdAt: new Date().toISOString()
    };

    await kv.set(K.REVIEW(req.params.id), review);
    await auditLog('review_replied', req.user.id, review.id);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// ============================================
// Admin Routes
// ============================================

/**
 * DELETE /:id — удаление отзыва (админ или автор)
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const review = await kv.get(K.REVIEW(req.params.id));
    if (!review) return res.status(404).json({ error: 'Отзыв не найден' });
    
    if (review.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Нет прав' });
    }

    await kv.del(K.REVIEW(req.params.id));
    await kv.srem(K.REVIEWS_INDEX, req.params.id);

    if (req.user.role === 'admin') {
      await auditLog('review_deleted', req.user.id, review.id, `Автор: ${review.userId}`);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

/**
 * POST /admin/:id/pin — закрепить/открепить отзыв
 */
router.post('/admin/:id/pin', requireAuth, requireAdmin, async (req, res) => {
  try {
    const review = await kv.get(K.REVIEW(req.params.id));
    if (!review) return res.status(404).json({ error: 'Отзыв не найден' });
    
    review.isPinned = !review.isPinned;
    await kv.set(K.REVIEW(req.params.id), review);
    
    await auditLog('review_pinned', req.user.id, review.id, review.isPinned ? 'pinned' : 'unpinned');

    res.json({ success: true, isPinned: review.isPinned });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

/**
 * GET /admin/stats — статистика
 */
router.get('/admin/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userIds = await kv.smembers(K.USERS_INDEX);
    const reviewIds = await kv.smembers(K.REVIEWS_INDEX);
    const reportIds = await kv.smembers(K.REPORTS_INDEX);

    let totalLikes = 0;
    let totalRating = 0;
    let reviewsCount = 0;
    let bannedCount = 0;
    let pendingReports = 0;

    for (const id of reviewIds) {
      const review = await kv.get(K.REVIEW(id));
      if (review) {
        totalLikes += review.likes || 0;
        totalRating += review.rating || 0;
        reviewsCount++;
        if ((review.reportsCount || 0) > 0) {
          // Проверяем статус жалоб
          for (const rid of reportIds) {
            const report = await kv.get(K.REPORT(rid));
            if (report && report.reviewId === id && report.status === 'pending') {
              pendingReports++;
              break;
            }
          }
        }
      }
    }

    for (const id of userIds) {
      const user = await kv.get(K.USER(id));
      if (user) {
        const isBanned = await kv.get(K.BAN(id));
        if (isBanned) bannedCount++;
      }
    }

    res.json({
      totalUsers: userIds.length,
      totalReviews: reviewsCount,
      avgRating: reviewsCount > 0 ? totalRating / reviewsCount : 0,
      totalLikes,
      pendingReports,
      bannedUsers: bannedCount
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

/**
 * GET /admin/reports — список жалоб
 */
router.get('/admin/reports', requireAuth, requireAdmin, async (req, res) => {
  try {
    const reportIds = await kv.smembers(K.REPORTS_INDEX);
    const reports = [];
    
    for (const id of reportIds) {
      const report = await kv.get(K.REPORT(id));
      if (report && report.status === 'pending') {
        reports.push(report);
      }
    }
    
    reports.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ reports });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

/**
 * POST /admin/reports/:id — обработка жалобы
 */
router.post('/admin/reports/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const report = await kv.get(K.REPORT(req.params.id));
    if (!report) return res.status(404).json({ error: 'Жалоба не найдена' });

    const { action } = req.body; // 'dismiss' или 'delete'
    
    if (action === 'delete') {
      await kv.del(K.REVIEW(report.reviewId));
      await kv.srem(K.REVIEWS_INDEX, report.reviewId);
      await auditLog('review_deleted_by_report', req.user.id, report.reviewId, `Жалоба: ${report.id}`);
    }
    
    report.status = action === 'delete' ? 'resolved_deleted' : 'resolved_dismissed';
    report.resolvedAt = new Date().toISOString();
    report.resolvedBy = req.user.id;
    await kv.set(K.REPORT(report.id), report);

    await auditLog('report_resolved', req.user.id, report.id, action);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

/**
 * GET /admin/users — список пользователей
 */
router.get('/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userIds = await kv.smembers(K.USERS_INDEX);
    const users = [];
    
    for (const id of userIds) {
      const user = await kv.get(K.USER(id));
      if (user) {
        const isBanned = await kv.get(K.BAN(id));
        const reviewIds = await kv.smembers(K.REVIEWS_INDEX);
        let reviewsCount = 0;
        for (const rid of reviewIds) {
          const review = await kv.get(K.REVIEW(rid));
          if (review && review.userId === id) reviewsCount++;
        }
        users.push({
          id: user.id,
          username: user.username,
          nickname: user.nickname,
          role: user.role,
          avatar: user.avatar,
          createdAt: user.createdAt,
          reviewsCount,
          isBanned: !!isBanned
        });
      }
    }
    
    users.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

/**
 * GET /admin/users/:id/info — детальная информация о пользователе
 */
router.get('/admin/users/:id/info', requireAuth, requireAdmin, async (req, res) => {
  try {
    const user = await kv.get(K.USER(req.params.id));
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    
    const reviewIds = await kv.smembers(K.REVIEWS_INDEX);
    let userReviews = 0;
    let totalLikesReceived = 0;
    let totalRating = 0;
    let reportsCount = 0;
    let lastIp = 'Неизвестно';
    let lastUa = 'Неизвестно';

    for (const id of reviewIds) {
      const review = await kv.get(K.REVIEW(id));
      if (review && review.userId === user.id) {
        userReviews++;
        totalLikesReceived += review.likes || 0;
        totalRating += review.rating || 0;
        reportsCount += review.reportsCount || 0;
        lastIp = review.ip || lastIp;
        lastUa = review.userAgent || lastUa;
      }
    }

    const isBanned = await kv.get(K.BAN(user.id));

    res.json({ 
      user: { 
        id: user.id, 
        username: user.username, 
        nickname: user.nickname, 
        role: user.role, 
        avatar: user.avatar,
        createdAt: user.createdAt 
      },
      stats: { 
        reviewsCount: userReviews, 
        totalLikesReceived, 
        avgRating: userReviews > 0 ? totalRating / userReviews : 0,
        reportsCount,
        lastIp, 
        lastUa 
      },
      isBanned: !!isBanned,
      banInfo: isBanned
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

/**
 * POST /admin/users/:id/ban — бан пользователя
 */
router.post('/admin/users/:id/ban', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    const banInfo = { 
      reason: reason || 'Нарушение правил', 
      date: new Date().toISOString(),
      bannedBy: req.user.id
    };
    await kv.set(K.BAN(req.params.id), banInfo);
    
    await auditLog('user_banned', req.user.id, req.params.id, reason);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка бана' });
  }
});

/**
 * DELETE /admin/users/:id/ban — разбан пользователя
 */
router.delete('/admin/users/:id/ban', requireAuth, requireAdmin, async (req, res) => {
  try {
    await kv.del(K.BAN(req.params.id));
    await auditLog('user_unbanned', req.user.id, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

/**
 * GET /admin/audit — audit log
 */
router.get('/admin/audit', requireAuth, requireAdmin, async (req, res) => {
  try {
    const logIds = await kv.smembers(K.AUDIT_INDEX);
    const logs = [];
    
    for (const id of logIds) {
      const log = await kv.get(K.AUDIT(id));
      if (log) logs.push(log);
    }
    
    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json({ logs: logs.slice(0, 100) });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

module.exports = router;