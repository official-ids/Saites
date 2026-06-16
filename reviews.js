// ============================================
// Reviews API - Express Router
// ============================================

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { kv } = require('@vercel/kv');
const { put } = require('@vercel/blob');

const router = express.Router();

// ============================================
// Configuration
// ============================================

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DAYS_PER_MONTH = 30;
const MILLISECONDS_PER_SECOND = 1000;

const CONFIG = Object.freeze({
  security: Object.freeze({
    ADMIN_TOKEN: process.env.ADMIN_TOKEN,
    PASSWORD_ITERATIONS: 100000,
    PASSWORD_KEY_LENGTH: 64,
    PASSWORD_SALT_BYTES: 16,
    SESSION_TTL_SECONDS: SECONDS_PER_MINUTE * MINUTES_PER_HOUR * HOURS_PER_DAY * DAYS_PER_MONTH,
  }),
  rateLimit: Object.freeze({
    WINDOW_MILLISECONDS: SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND,
    MAX_REGISTRATION_REQUESTS: 5,
    MAX_REVIEWS_REQUESTS: 10,
  }),
  telegram: Object.freeze({
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  }),
});

const validateEnvironment = () => {
  const requiredVariables = [
    { name: 'ADMIN_TOKEN', value: CONFIG.security.ADMIN_TOKEN },
    { name: 'TELEGRAM_BOT_TOKEN', value: CONFIG.telegram.BOT_TOKEN },
    { name: 'TELEGRAM_CHAT_ID', value: CONFIG.telegram.CHAT_ID },
  ];

  const missingVariables = requiredVariables
    .filter(({ value }) => !value)
    .map(({ name }) => name);

  if (missingVariables.length > 0) {
    throw new Error(
      `[Configuration] FATAL: Missing required environment variables: ${missingVariables.join(', ')}`
    );
  }
};

validateEnvironment();

// ============================================
// KV Keys
// ============================================

const APP_PREFIX = 'reviews';

const normalize = (value) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('[KV Keys] Identifier must be a non-empty string');
  }
  return value.toLowerCase().trim();
};

const K = Object.freeze({
  user: Object.freeze({
    byId: (id) => `${APP_PREFIX}:user:${normalize(id)}`,
    byUsername: (username) => `${APP_PREFIX}:user:by_username:${normalize(username)}`,
    index: `${APP_PREFIX}:users:index`,
  }),
  review: Object.freeze({
    byId: (id) => `${APP_PREFIX}:review:${normalize(id)}`,
    index: `${APP_PREFIX}:reviews:index`,
  }),
  session: Object.freeze({
    byToken: (token) => `${APP_PREFIX}:session:${normalize(token)}`,
  }),
  moderation: Object.freeze({
    ban: (userId) => `${APP_PREFIX}:ban:${normalize(userId)}`,
    report: (id) => `${APP_PREFIX}:report:${normalize(id)}`,
    reportsIndex: `${APP_PREFIX}:reports:index`,
  }),
  audit: Object.freeze({
    byId: (id) => `${APP_PREFIX}:audit:${normalize(id)}`,
    index: `${APP_PREFIX}:audit:index`,
  }),
  rateLimit: Object.freeze({
    byKey: (key) => `${APP_PREFIX}:ratelimit:${normalize(key)}`,
  }),
  admin: Object.freeze({
    id: `${APP_PREFIX}:admin_id`,
  }),
});

// ============================================
// Constants
// ============================================

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const ID_BYTES = 8;
const TOKEN_BYTES = 32;
const AUDIT_TTL_DAYS = 90;

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;

const MIN_PASSWORD_LENGTH = 6;
const MIN_NICKNAME_LENGTH = 2;
const MAX_NICKNAME_LENGTH = 30;
const ADMIN_USERNAME = 'admin';
const ADMIN_NICKNAME = 'Администратор';

const MIN_REVIEW_TEXT_LENGTH = 10;
const MAX_REVIEW_TEXT_LENGTH = 2000;
const MAX_REVIEW_TITLE_LENGTH = 100;
const MIN_REPLY_LENGTH = 5;
const MAX_REPLY_LENGTH = 1000;
const MIN_RATING = 1;
const MAX_RATING = 5;

const AUDIT_LOG_LIMIT = 100;

// ============================================
// Multer Configuration
// ============================================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Недопустимый тип файла. Разрешены только: ${ALLOWED_MIME_TYPES.join(', ')}.`));
    }
  },
});

// ============================================
// Utilities
// ============================================

function generateId() {
  return crypto.randomBytes(ID_BYTES).toString('hex');
}

function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

async function hashPassword(password) {
  if (typeof password !== 'string' || password.trim() === '') {
    throw new Error('[Utilities] Password must be a non-empty string');
  }

  const salt = crypto.randomBytes(CONFIG.security.PASSWORD_SALT_BYTES).toString('hex');
  
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(
      password,
      salt,
      CONFIG.security.PASSWORD_ITERATIONS,
      CONFIG.security.PASSWORD_KEY_LENGTH,
      'sha512',
      (err, key) => {
        if (err) reject(err);
        else resolve(`${salt}:${key.toString('hex')}`);
      }
    );
  });
}

async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') {
    throw new Error('[Utilities] Password and stored hash must be strings');
  }

  if (!stored.includes(':')) return false;
  
  const [salt, originalHash] = stored.split(':');
  
  return new Promise((resolve) => {
    crypto.pbkdf2(
      password,
      salt,
      CONFIG.security.PASSWORD_ITERATIONS,
      CONFIG.security.PASSWORD_KEY_LENGTH,
      'sha512',
      (err, key) => {
        if (err) return resolve(false);
        
        try {
          const computedHash = key.toString('hex');
          const computedBuffer = Buffer.from(computedHash, 'hex');
          const originalBuffer = Buffer.from(originalHash, 'hex');
          
          resolve(crypto.timingSafeEqual(computedBuffer, originalBuffer));
        } catch {
          resolve(false);
        }
      }
    );
  });
}

async function initializeRateLimitCounter(rlKey, resetAt) {
  const ttlSeconds = Math.ceil(CONFIG.rateLimit.WINDOW_MILLISECONDS / 1000);
  
  await kv.hset(rlKey, {
    count: '1',
    resetAt: String(resetAt)
  });
  await kv.expire(rlKey, ttlSeconds);
}

async function checkRateLimit(key, max) {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new Error('[Utilities] Rate limit key must be a non-empty string');
  }
  
  if (typeof max !== 'number' || max < 1) {
    throw new Error('[Utilities] Rate limit max must be a positive number');
  }

  const rlKey = K.rateLimit.byKey(key);
  const data = await kv.hgetall(rlKey);
  const now = Date.now();
  const resetAt = now + CONFIG.rateLimit.WINDOW_MILLISECONDS;
  
  if (!data || !data.count || now > parseInt(data.resetAt, 10)) {
    if (data) await kv.del(rlKey);
    await initializeRateLimitCounter(rlKey, resetAt);
    return true;
  }
  
  const count = parseInt(data.count, 10);
  if (count >= max) return false;
  
  await kv.hincrby(rlKey, 'count', 1);
  return true;
}

/**
 * Запись в audit log с автоматическим TTL
 * @param {string} action - Тип действия (create, update, delete, ban, etc.)
 * @param {string} [userId='system'] - ID пользователя или 'system' для системных событий
 * @param {string} [target=''] - ID целевого объекта (опционально)
 * @param {string} [details=''] - Дополнительная информация (опционально)
 */
async function auditLog(action, userId = 'system', target = '', details = '') {
  if (typeof action !== 'string' || action.trim() === '') {
    throw new Error('[Utilities] Audit action must be a non-empty string');
  }
  
  // Нормализация userId: если пустой или не строка, используем 'system'
  const normalizedUserId = (typeof userId === 'string' && userId.trim() !== '') 
    ? userId.trim() 
    : 'system';

  const id = generateId();
  const ttlSeconds = AUDIT_TTL_DAYS * 24 * 60 * 60;
  
  const record = {
    id,
    action,
    userId: normalizedUserId,
    target: target || '',
    details: details || '',
    timestamp: new Date().toISOString()
  };
  
  try {
    await kv.hset(K.audit.byId(id), record);
    await kv.sadd(K.audit.index, id);
    await kv.expire(K.audit.byId(id), ttlSeconds);
  } catch (err) {
    console.error('[Audit] Failed to write audit log:', err.message);
    // Не прерываем выполнение, если audit log не записался
  }
}

async function sendTelegramNotification(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('[Utilities] Notification text must be a non-empty string');
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${CONFIG.telegram.BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CONFIG.telegram.CHAT_ID,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        })
      }
    );

    if (!response.ok) {
      console.error(
        `[Utilities] Telegram API error: ${response.status} ${response.statusText}`
      );
    }
  } catch (err) {
    console.error('[Utilities] Telegram notification error:', err.message);
  }
}

function isValidUsername(username) {
  if (typeof username !== 'string') {
    throw new Error('[Utilities] Username must be a string');
  }
  
  return USERNAME_PATTERN.test(username);
}

// ============================================
// Helper Functions
// ============================================

function createSessionObject(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    nickname: user.nickname,
    avatar: user.avatar
  };
}

function formatAuthResponse(token, user) {
  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      role: user.role,
      avatar: user.avatar
    }
  };
}

function formatUserResponse(user) {
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    role: user.role,
    avatar: user.avatar
  };
}

async function getUserById(userId) {
  return await kv.get(K.user.byId(userId));
}

async function getReviewById(reviewId) {
  return await kv.get(K.review.byId(reviewId));
}

async function getAllReviewIds() {
  return await kv.smembers(K.review.index);
}

async function getAllReviews() {
  const reviewIds = await getAllReviewIds();
  const reviews = [];
  
  for (const id of reviewIds) {
    const review = await getReviewById(id);
    if (review) {
      const user = await getUserById(review.userId);
      if (user) {
        review.userNickname = user.nickname;
        review.userAvatar = user.avatar;
        review.userRole = user.role;
      }
      reviews.push(review);
    }
  }
  
  return reviews;
}

async function getUserReviewsCount(userId) {
  const reviewIds = await getAllReviewIds();
  let count = 0;
  
  for (const id of reviewIds) {
    const review = await getReviewById(id);
    if (review && review.userId === userId) {
      count++;
    }
  }
  
  return count;
}

function validateRegistrationData({ username, password, nickname }) {
  if (!username || typeof username !== 'string' || !isValidUsername(username)) {
    return { 
      valid: false, 
      error: 'Имя пользователя: 3-20 символов (латиница, цифры, _)' 
    };
  }
  
  if (!password || typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return { 
      valid: false, 
      error: `Пароль: минимум ${MIN_PASSWORD_LENGTH} символов` 
    };
  }
  
  if (!nickname || typeof nickname !== 'string' || 
      nickname.trim().length < MIN_NICKNAME_LENGTH || 
      nickname.length > MAX_NICKNAME_LENGTH) {
    return { 
      valid: false, 
      error: `Ник: ${MIN_NICKNAME_LENGTH}-${MAX_NICKNAME_LENGTH} символов` 
    };
  }
  
  return { valid: true };
}

function validateReviewData({ rating, title, text }) {
  const ratingNum = parseInt(rating);
  
  if (!rating || isNaN(ratingNum) || ratingNum < MIN_RATING || ratingNum > MAX_RATING) {
    return { 
      valid: false, 
      error: `Оценка от ${MIN_RATING} до ${MAX_RATING}` 
    };
  }
  
  if (!text || typeof text !== 'string' || text.trim().length < MIN_REVIEW_TEXT_LENGTH) {
    return { 
      valid: false, 
      error: `Текст отзыва: мин. ${MIN_REVIEW_TEXT_LENGTH} символов` 
    };
  }
  
  if (text.length > MAX_REVIEW_TEXT_LENGTH) {
    return { 
      valid: false, 
      error: `Текст отзыва: макс. ${MAX_REVIEW_TEXT_LENGTH} символов` 
    };
  }
  
  if (title && title.length > MAX_REVIEW_TITLE_LENGTH) {
    return { 
      valid: false, 
      error: `Заголовок: макс. ${MAX_REVIEW_TITLE_LENGTH} символов` 
    };
  }
  
  return { valid: true, rating: ratingNum };
}

// ============================================
// Middleware
// ============================================

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || typeof authHeader !== 'string') {
      console.warn('[Auth] Missing authorization header');
      return res.status(401).json({ 
        error: 'Требуется авторизация',
        code: 'AUTH_HEADER_MISSING'
      });
    }
    
    if (!authHeader.startsWith('Bearer ')) {
      console.warn('[Auth] Invalid authorization scheme');
      return res.status(401).json({ 
        error: 'Неверный формат авторизации. Используйте Bearer token',
        code: 'AUTH_SCHEME_INVALID'
      });
    }
    
    const token = authHeader.slice(7).trim();
    
    if (!token) {
      console.warn('[Auth] Empty bearer token');
      return res.status(401).json({ 
        error: 'Токен авторизации пуст',
        code: 'AUTH_TOKEN_EMPTY'
      });
    }
    
    const session = await kv.get(K.session.byToken(token));
    
    if (!session) {
      console.warn('[Auth] Invalid or expired session token');
      return res.status(401).json({ 
        error: 'Сессия истекла или недействительна',
        code: 'SESSION_EXPIRED'
      });
    }
    
    const banInfo = await kv.get(K.moderation.ban(session.id));
    
    if (banInfo) {
      console.warn(`[Auth] Banned user attempted access: ${session.id}`);
      return res.status(403).json({ 
        error: `Аккаунт заблокирован: ${banInfo.reason || 'Не указана причина'}`,
        code: 'ACCOUNT_BANNED',
        bannedAt: banInfo.timestamp,
        reason: banInfo.reason
      });
    }
    
    req.user = session;
    req.authToken = token;
    
    next();
  } catch (err) {
    console.error('[Auth] Authorization middleware error:', err.message);
    return res.status(500).json({ 
      error: 'Внутренняя ошибка сервера при проверке авторизации',
      code: 'AUTH_INTERNAL_ERROR'
    });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    console.warn('[Admin] requireAdmin called without authentication');
    return res.status(401).json({ 
      error: 'Требуется авторизация',
      code: 'AUTH_REQUIRED'
    });
  }
  
  if (req.user.role !== 'admin') {
    console.warn(`[Admin] Non-admin user attempted admin action: ${req.user.id}`);
    return res.status(403).json({ 
      error: 'Требуются права администратора',
      code: 'INSUFFICIENT_PRIVILEGES'
    });
  }
  
  next();
}

// ============================================
// Auth Routes
// ============================================

router.post('/auth/register', async (req, res) => {
  try {
    console.log('[Auth/Register] Registration attempt from IP:', req.ip);
    
    const ip = req.ip;
    const rateLimitKey = `reg:${ip}`;
    
    if (!await checkRateLimit(rateLimitKey, CONFIG.rateLimit.MAX_REGISTRATION_REQUESTS)) {
      console.warn('[Auth/Register] Rate limit exceeded for IP:', ip);
      return res.status(429).json({ 
        error: 'Слишком много попыток регистрации. Попробуйте позже.',
        code: 'RATE_LIMIT_EXCEEDED'
      });
    }

    const { username, password, nickname } = req.body;
    console.log('[Auth/Register] Received data:', { 
      username: username ? 'present' : 'missing',
      password: password ? 'present' : 'missing',
      nickname: nickname ? 'present' : 'missing'
    });
    
    const validation = validateRegistrationData({ username, password, nickname });
    if (!validation.valid) {
      console.warn('[Auth/Register] Validation failed:', validation.error);
      return res.status(400).json({ 
        error: validation.error,
        code: 'VALIDATION_ERROR'
      });
    }

    const normalizedUsername = username.toLowerCase().trim();
    console.log('[Auth/Register] Normalized username:', normalizedUsername);
    
    const existingId = await kv.get(K.user.byUsername(normalizedUsername));
    if (existingId) {
      console.warn('[Auth/Register] Username already taken:', normalizedUsername);
      return res.status(409).json({ 
        error: 'Имя пользователя занято',
        code: 'USERNAME_TAKEN'
      });
    }

    const userId = generateId();
    const passwordHash = await hashPassword(password);
    
    const user = {
      id: userId,
      username: normalizedUsername,
      nickname: nickname.trim(),
      passwordHash,
      role: 'user',
      avatar: null,
      createdAt: new Date().toISOString()
    };

    await kv.set(K.user.byId(userId), user);
    await kv.set(K.user.byUsername(normalizedUsername), userId);
    await kv.sadd(K.user.index, userId);

    const token = generateToken();
    const session = createSessionObject(user);
    await kv.set(K.session.byToken(token), session, { 
      ex: CONFIG.security.SESSION_TTL_SECONDS 
    });

    await auditLog('user_registered', userId, '', `Username: ${normalizedUsername}`);
    
    await sendTelegramNotification(
      `👤 <b>Новая регистрация</b>\n\n` +
      `Ник: ${nickname.trim()}\n` +
      `Username: @${normalizedUsername}\n` +
      `ID: <code>${userId}</code>`
    );

    console.log('[Auth/Register] User registered successfully:', userId);

    res.status(201).json(formatAuthResponse(token, user));
  } catch (err) {
    console.error('[Auth/Register] Error:', err.message);
    console.error('[Auth/Register] Stack:', err.stack);
    res.status(500).json({ 
      error: 'Ошибка сервера при регистрации',
      code: 'REGISTRATION_ERROR',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

router.post('/auth/login', async (req, res) => {
  try {
    const ip = req.ip;
    const rateLimitKey = `login:${ip}`;
    
    if (!await checkRateLimit(rateLimitKey, CONFIG.rateLimit.MAX_REVIEWS_REQUESTS)) {
      console.warn(`[Auth/Login] Rate limit exceeded for IP: ${ip}`);
      return res.status(429).json({ 
        error: 'Слишком много попыток входа. Попробуйте позже.',
        code: 'RATE_LIMIT_EXCEEDED'
      });
    }

    const { username, password } = req.body;
    
    if (!username || typeof username !== 'string' || 
        !password || typeof password !== 'string') {
      return res.status(400).json({ 
        error: 'Укажите логин и пароль',
        code: 'MISSING_CREDENTIALS'
      });
    }

    const normalizedUsername = username.toLowerCase().trim();
    const userId = await kv.get(K.user.byUsername(normalizedUsername));
    
    if (!userId) {
      console.warn(`[Auth/Login] User not found: ${normalizedUsername}`);
      return res.status(401).json({ 
        error: 'Неверный логин или пароль',
        code: 'INVALID_CREDENTIALS'
      });
    }

    const user = await kv.get(K.user.byId(userId));
    
    if (!user || !await verifyPassword(password, user.passwordHash)) {
      console.warn(`[Auth/Login] Invalid password for user: ${userId}`);
      return res.status(401).json({ 
        error: 'Неверный логин или пароль',
        code: 'INVALID_CREDENTIALS'
      });
    }

    const banInfo = await kv.get(K.moderation.ban(userId));
    if (banInfo) {
      console.warn(`[Auth/Login] Banned user attempted login: ${userId}`);
      return res.status(403).json({ 
        error: `Аккаунт заблокирован: ${banInfo.reason || 'Не указана причина'}`,
        code: 'ACCOUNT_BANNED',
        bannedAt: banInfo.timestamp,
        reason: banInfo.reason
      });
    }

    const token = generateToken();
    const session = createSessionObject(user);
    await kv.set(K.session.byToken(token), session, { 
      ex: CONFIG.security.SESSION_TTL_SECONDS 
    });

    await auditLog('user_login', userId);
    console.log(`[Auth/Login] User logged in: ${userId} (${normalizedUsername})`);

    res.json(formatAuthResponse(token, user));
  } catch (err) {
    console.error('[Auth/Login] Error:', err.message);
    res.status(500).json({ 
      error: 'Ошибка сервера при входе',
      code: 'LOGIN_ERROR'
    });
  }
});

router.post('/auth/admin', async (req, res) => {
  try {
    console.log('[Auth/Admin] Admin login attempt from IP:', req.ip);
    
    const { adminToken } = req.body;
    
    if (!CONFIG.security.ADMIN_TOKEN) {
      console.error('[Auth/Admin] ADMIN_TOKEN not configured in environment');
      return res.status(500).json({ 
        error: 'Admin token не настроен на сервере',
        code: 'ADMIN_TOKEN_NOT_CONFIGURED'
      });
    }
    
    if (!adminToken) {
      console.warn('[Auth/Admin] Missing admin token in request');
      return res.status(400).json({ 
        error: 'Admin token не предоставлен',
        code: 'ADMIN_TOKEN_MISSING'
      });
    }

    if (typeof adminToken !== 'string') {
      console.warn('[Auth/Admin] Invalid admin token type:', typeof adminToken);
      return res.status(400).json({ 
        error: 'Admin token должен быть строкой',
        code: 'INVALID_TOKEN_TYPE'
      });
    }

    const tokenBuffer = Buffer.from(adminToken);
    const configBuffer = Buffer.from(CONFIG.security.ADMIN_TOKEN);
    
    const isValid = tokenBuffer.length === configBuffer.length &&
      crypto.timingSafeEqual(tokenBuffer, configBuffer);
    
    if (!isValid) {
      console.warn('[Auth/Admin] Invalid admin token attempt from IP:', req.ip);
      await auditLog('admin_login_failed', 'system', req.ip, 'Invalid admin token');
      return res.status(403).json({ 
        error: 'Неверный admin token',
        code: 'INVALID_ADMIN_TOKEN'
      });
    }

    console.log('[Auth/Admin] Valid admin token, checking for existing admin account');
    
    let adminId = await kv.get(K.admin.id);
    let user;
    
    if (adminId) {
      console.log('[Auth/Admin] Found existing admin ID:', adminId);
      user = await kv.get(K.user.byId(adminId));
      if (!user) {
        console.warn('[Auth/Admin] Admin ID exists but user not found, will create new');
      }
    }
    
    if (!user) {
      console.log('[Auth/Admin] Creating new admin account');
      adminId = generateId();
      const randomPassword = crypto.randomBytes(32).toString('hex');
      
      user = {
        id: adminId,
        username: ADMIN_USERNAME,
        nickname: ADMIN_NICKNAME,
        passwordHash: await hashPassword(randomPassword),
        role: 'admin',
        avatar: null,
        createdAt: new Date().toISOString()
      };
      
      await kv.set(K.user.byId(adminId), user);
      await kv.set(K.user.byUsername(ADMIN_USERNAME), adminId);
      await kv.sadd(K.user.index, adminId);
      await kv.set(K.admin.id, adminId);
      
      await auditLog('admin_account_created', adminId, '', 'Автоматическое создание при первом входе');
      console.log('[Auth/Admin] Admin account created:', adminId);
    }

    const token = generateToken();
    const session = createSessionObject(user);
    await kv.set(K.session.byToken(token), session, { 
      ex: CONFIG.security.SESSION_TTL_SECONDS 
    });

    await auditLog('admin_login', user.id);
    console.log('[Auth/Admin] Admin logged in successfully:', user.id);

    res.json(formatAuthResponse(token, user));
  } catch (err) {
    console.error('[Auth/Admin] Error:', err.message);
    console.error('[Auth/Admin] Stack:', err.stack);
    res.status(500).json({ 
      error: 'Ошибка сервера при входе администратора',
      code: 'ADMIN_LOGIN_ERROR',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

router.post('/auth/logout', requireAuth, async (req, res) => {
  try {
    await kv.del(K.session.byToken(req.authToken));
    await auditLog('user_logout', req.user.id);
    console.log(`[Auth/Logout] User logged out: ${req.user.id}`);
    
    res.json({ 
      success: true,
      message: 'Выход выполнен успешно'
    });
  } catch (err) {
    console.error('[Auth/Logout] Error:', err.message);
    res.status(500).json({ 
      error: 'Ошибка сервера при выходе',
      code: 'LOGOUT_ERROR'
    });
  }
});

// ============================================
// User Profile Routes
// ============================================

router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await getUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ 
        error: 'Пользователь не найден',
        code: 'USER_NOT_FOUND'
      });
    }
    
    res.json(formatUserResponse(user));
  } catch (err) {
    console.error('[Profile/Get] Error:', err.message);
    res.status(500).json({ 
      error: 'Ошибка сервера при получении профиля',
      code: 'PROFILE_GET_ERROR'
    });
  }
});

router.put('/me', requireAuth, upload.single('avatar'), async (req, res) => {
  try {
    const { nickname, avatarUrl } = req.body;
    const user = await getUserById(req.user.id);
    
    if (!user) {
      return res.status(404).json({ 
        error: 'Пользователь не найден',
        code: 'USER_NOT_FOUND'
      });
    }
    
    let newAvatar = user.avatar;
    
    if (req.file) {
      const ext = req.file.originalname.match(/\.[a-z0-9]+$/i)?.[0] || '.jpg';
      const blob = await put(`reviews/avatars/${req.user.id}${ext}`, req.file.buffer, { 
        access: 'public' 
      });
      newAvatar = blob.url;
    } else if (avatarUrl && typeof avatarUrl === 'string') {
      newAvatar = avatarUrl;
    }

    if (nickname && typeof nickname === 'string') {
      const trimmedNickname = nickname.trim();
      if (trimmedNickname.length >= MIN_NICKNAME_LENGTH && 
          trimmedNickname.length <= MAX_NICKNAME_LENGTH) {
        user.nickname = trimmedNickname;
      }
    }
    
    user.avatar = newAvatar;
    
    await kv.set(K.user.byId(req.user.id), user);
    
    const session = await kv.get(K.session.byToken(req.authToken));
    if (session) {
      session.nickname = user.nickname;
      session.avatar = user.avatar;
      await kv.set(K.session.byToken(req.authToken), session);
    }

    await auditLog('profile_updated', user.id);
    console.log(`[Profile/Update] User profile updated: ${user.id}`);

    res.json({ 
      success: true, 
      user: formatUserResponse(user)
    });
  } catch (err) {
    console.error('[Profile/Update] Error:', err.message);
    res.status(500).json({ 
      error: 'Ошибка обновления профиля',
      code: 'PROFILE_UPDATE_ERROR'
    });
  }
});

router.post('/me/password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    if (!newPassword || typeof newPassword !== 'string' || 
        newPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ 
        error: `Новый пароль: минимум ${MIN_PASSWORD_LENGTH} символов`,
        code: 'INVALID_NEW_PASSWORD'
      });
    }

    const user = await getUserById(req.user.id);
    
    if (!user) {
      return res.status(404).json({ 
        error: 'Пользователь не найден',
        code: 'USER_NOT_FOUND'
      });
    }
    
    if (!await verifyPassword(currentPassword, user.passwordHash)) {
      console.warn(`[Profile/Password] Invalid current password for user: ${user.id}`);
      return res.status(401).json({ 
        error: 'Неверный текущий пароль',
        code: 'INVALID_CURRENT_PASSWORD'
      });
    }

    user.passwordHash = await hashPassword(newPassword);
    await kv.set(K.user.byId(req.user.id), user);

    await auditLog('password_changed', user.id);
    console.log(`[Profile/Password] Password changed for user: ${user.id}`);

    res.json({ 
      success: true,
      message: 'Пароль успешно изменен'
    });
  } catch (err) {
    console.error('[Profile/Password] Error:', err.message);
    res.status(500).json({ 
      error: 'Ошибка смены пароля',
      code: 'PASSWORD_CHANGE_ERROR'
    });
  }
});

// ============================================
// Review Routes
// ============================================

router.get('/', async (req, res) => {
  try {
    const reviews = await getAllReviews();
    res.json({ reviews });
  } catch (err) {
    console.error('[Reviews/List] Error:', err.message);
    res.status(500).json({ 
      error: 'Ошибка загрузки отзывов',
      code: 'REVIEWS_LIST_ERROR'
    });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const rateLimitKey = `review:${req.user.id}`;
    
    if (!await checkRateLimit(rateLimitKey, CONFIG.rateLimit.MAX_REVIEWS_REQUESTS)) {
      console.warn(`[Reviews/Create] Rate limit exceeded for user: ${req.user.id}`);
      return res.status(429).json({ 
        error: 'Слишком много отзывов. Попробуйте позже.',
        code: 'RATE_LIMIT_EXCEEDED'
      });
    }

    const { rating, title, text } = req.body;
    
    const validation = validateReviewData({ rating, title, text });
    if (!validation.valid) {
      return res.status(400).json({ 
        error: validation.error,
        code: 'VALIDATION_ERROR'
      });
    }

    const reviewId = generateId();
    const review = {
      id: reviewId,
      userId: req.user.id,
      rating: validation.rating,
      title: title ? title.trim().substring(0, MAX_REVIEW_TITLE_LENGTH) : '',
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

    await kv.set(K.review.byId(reviewId), review);
    await kv.sadd(K.review.index, reviewId);

    await auditLog('review_created', req.user.id, reviewId);

    await sendTelegramNotification(
      `⭐ <b>Новый отзыв</b> (${'★'.repeat(review.rating)})\n\n` +
      `<b>${review.title || '(без заголовка)'}</b>\n` +
      `${review.text.substring(0, 200)}${review.text.length > 200 ? '...' : ''}\n\n` +
      `Автор: ${req.user.nickname}`
    );

    console.log(`[Reviews/Create] New review created: ${reviewId} by user ${req.user.id}`);

    res.status(201).json({ 
      success: true, 
      review 
    });
  } catch (err) {
    console.error('[Reviews/Create] Error:', err.message);
    res.status(500).json({ 
      error: 'Ошибка создания отзыва',
      code: 'REVIEW_CREATE_ERROR'
    });
  }
});

router.put('/:id', requireAuth, async (req, res) => {
  try {
    const review = await getReviewById(req.params.id);
    
    if (!review) {
      return res.status(404).json({ 
        error: 'Отзыв не найден',
        code: 'REVIEW_NOT_FOUND'
      });
    }
    
    if (review.userId !== req.user.id && req.user.role !== 'admin') {
      console.warn(`[Reviews/Update] Unauthorized edit attempt by user ${req.user.id} on review ${req.params.id}`);
      return res.status(403).json({ 
        error: 'Нет прав на редактирование',
        code: 'INSUFFICIENT_PRIVILEGES'
      });
    }

    const { title, text } = req.body;
    
    if (text !== undefined) {
      if (typeof text !== 'string' || text.trim().length < MIN_REVIEW_TEXT_LENGTH) {
        return res.status(400).json({ 
          error: `Текст отзыва: мин. ${MIN_REVIEW_TEXT_LENGTH} символов`,
          code: 'TEXT_TOO_SHORT'
        });
      }
      if (text.length > MAX_REVIEW_TEXT_LENGTH) {
        return res.status(400).json({ 
          error: `Текст отзыва: макс. ${MAX_REVIEW_TEXT_LENGTH} символов`,
          code: 'TEXT_TOO_LONG'
        });
      }
      review.text = text.trim();
    }
    
    if (title !== undefined) {
      if (typeof title === 'string') {
        review.title = title.trim().substring(0, MAX_REVIEW_TITLE_LENGTH);
      }
    }
    
    review.isEdited = true;
    review.editedAt = new Date().toISOString();

    await kv.set(K.review.byId(req.params.id), review);

    await auditLog('review_updated', req.user.id, review.id);
    console.log(`[Reviews/Update] Review updated: ${review.id} by user ${req.user.id}`);

    res.json({ 
      success: true, 
      review 
    });
  } catch (err) {
    console.error('[Reviews/Update] Error:', err.message);
    res.status(500).json({ 
      error: 'Ошибка обновления отзыва',
      code: 'REVIEW_UPDATE_ERROR'
    });
  }
});

router.post('/:id/like', requireAuth, async (req, res) => {
  try {
    const review = await getReviewById(req.params.id);
    
    if (!review) {
      return res.status(404).json({ 
        error: 'Отзыв не найден',
        code: 'REVIEW_NOT_FOUND'
      });
    }
    
    review.likedBy = review.likedBy || [];
    const idx = review.likedBy.indexOf(req.user.id);
    
    if (idx >= 0) {
      review.likedBy.splice(idx, 1);
      review.likes = Math.max(0, (review.likes || 1) - 1);
    } else {
      review.likedBy.push(req.user.id);
      review.likes = (review.likes || 0) + 1;
    }
    
    await kv.set(K.review.byId(req.params.id), review);
    
    console.log(`[Reviews/Like] Review ${req.params.id} ${idx >= 0 ? 'unliked' : 'liked'} by user ${req.user.id}`);
    
    res.json({ 
      likes: review.likes, 
      liked: idx < 0 
    });
  } catch (err) {
    console.error('[Reviews/Like] Error:', err.message);
    res.status(500).json({ 
      error: 'Ошибка при постановке лайка',
      code: 'REVIEW_LIKE_ERROR'
    });
  }
});

router.post('/:id/report', requireAuth, async (req, res) => {
  try {
    const review = await getReviewById(req.params.id);
    
    if (!review) {
      return res.status(404).json({ 
        error: 'Отзыв не найден',
        code: 'REVIEW_NOT_FOUND'
      });
    }
    
    if (review.userId === req.user.id) {
      return res.status(400).json({ 
        error: 'Нельзя пожаловаться на свой отзыв',
        code: 'SELF_REPORT_NOT_ALLOWED'
      });
    }

    review.reportedBy = review.reportedBy || [];
    
    if (review.reportedBy.includes(req.user.id)) {
      return res.status(400).json({ 
        error: 'Вы уже жаловались на этот отзыв',
        code: 'ALREADY_REPORTED'
      });
    }

    const { reason, comment } = req.body;
    
    if (!reason || typeof reason !== 'string') {
      return res.status(400).json({ 
        error: 'Укажите причину жалобы',
        code: 'MISSING_REASON'
      });
    }

    review.reportedBy.push(req.user.id);
    review.reportsCount = (review.reportsCount || 0) + 1;
    await kv.set(K.review.byId(req.params.id), review);

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
    
    await kv.set(K.moderation.report(reportId), report);
    await kv.sadd(K.moderation.reportsIndex, reportId);

    await auditLog('review_reported', req.user.id, review.id, `Причина: ${reason}`);

    await sendTelegramNotification(
      `🚨 <b>Новая жалоба</b>\n\n` +
      `Причина: ${reason}\n` +
      `От: ${req.user.nickname}\n` +
      `На отзыв: ${review.title || review.text.substring(0, 100)}`
    );

    console.log(`[Reviews/Report] Review ${review.id} reported by user ${req.user.id}`);

    res.json({ 
      success: true,
      reportId 
    });
  } catch (err) {
    console.error('[Reviews/Report] Error:', err.message);
    res.status(500).json({ 
      error: 'Ошибка при отправке жалобы',
      code: 'REVIEW_REPORT_ERROR'
    });
  }
});

router.post('/:id/reply', requireAuth, requireAdmin, async (req, res) => {
  try {
    const review = await getReviewById(req.params.id);
    
    if (!review) {
      return res.status(404).json({ 
        error: 'Отзыв не найден',
        code: 'REVIEW_NOT_FOUND'
      });
    }

    const { text } = req.body;
    
    if (!text || typeof text !== 'string' || text.trim().length < MIN_REPLY_LENGTH) {
      return res.status(400).json({ 
        error: `Ответ: мин. ${MIN_REPLY_LENGTH} символов`,
        code: 'REPLY_TOO_SHORT'
      });
    }
    
    if (text.length > MAX_REPLY_LENGTH) {
      return res.status(400).json({ 
        error: `Ответ: макс. ${MAX_REPLY_LENGTH} символов`,
        code: 'REPLY_TOO_LONG'
      });
    }

    review.reply = {
      text: text.trim(),
      authorId: req.user.id,
      authorName: req.user.nickname,
      isAdmin: true,
      createdAt: new Date().toISOString()
    };

    await kv.set(K.review.byId(req.params.id), review);
    
    await auditLog('review_replied', req.user.id, review.id);
    console.log(`[Reviews/Reply] Review ${review.id} replied by admin ${req.user.id}`);

    res.json({ 
      success: true,
      reply: review.reply
    });
  } catch (err) {
    console.error('[Reviews/Reply] Error:', err.message);
    res.status(500).json({ 
      error: 'Ошибка при создании ответа',
      code: 'REVIEW_REPLY_ERROR'
    });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const review = await getReviewById(req.params.id);
    
    if (!review) {
      return res.status(404).json({ 
        error: 'Отзыв не найден',
        code: 'REVIEW_NOT_FOUND'
      });
    }
    
    if (review.userId !== req.user.id && req.user.role !== 'admin') {
      console.warn(`[Reviews/Delete] Unauthorized delete attempt by user ${req.user.id} on review ${req.params.id}`);
      return res.status(403).json({ 
        error: 'Нет прав на удаление',
        code: 'INSUFFICIENT_PRIVILEGES'
      });
    }

    await kv.del(K.review.byId(req.params.id));
    await kv.srem(K.review.index, req.params.id);

    if (req.user.role === 'admin') {
      await auditLog('review_deleted', req.user.id, review.id, `Автор: ${review.userId}`);
      console.log(`[Reviews/Delete] Review ${req.params.id} deleted by admin ${req.user.id}`);
    } else {
      await auditLog('review_deleted_by_author', req.user.id, review.id);
      console.log(`[Reviews/Delete] Review ${req.params.id} deleted by author ${req.user.id}`);
    }

    res.json({ 
      success: true,
      message: 'Отзыв успешно удален'
    });
  } catch (err) {
    console.error('[Reviews/Delete] Error:', err.message);
    res.status(500).json({ 
      error: 'Ошибка удаления отзыва',
      code: 'REVIEW_DELETE_ERROR'
    });
  }
});

// ============================================
// Admin Routes
// ============================================

router.post('/admin/:id/pin', requireAuth, requireAdmin, async (req, res) => {
  try {
    const review = await getReviewById(req.params.id);
    
    if (!review) {
      return res.status(404).json({ 
        error: 'Отзыв не найден',
        code: 'REVIEW_NOT_FOUND'
      });
    }
    
    review.isPinned = !review.isPinned;
    await kv.set(K.review.byId(req.params.id), review);
    
    await auditLog('review_pinned', req.user.id, review.id, review.isPinned ? 'pinned' : 'unpinned');
    console.log(`[Admin/Pin] Review ${review.id} ${review.isPinned ? 'pinned' : 'unpinned'} by admin ${req.user.id}`);

    res.json({ 
      success: true, 
      isPinned: review.isPinned 
    });
  } catch (err) {
    console.error('[Admin/Pin] Error:', err.message);
    res.status(500).json({ 
      error: 'Ошибка при закреплении отзыва',
      code: 'REVIEW_PIN_ERROR'
    });
  }
});

router.get('/admin/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userIds = await kv.smembers(K.user.index);
    const reviewIds = await getAllReviewIds();
    const reportIds = await kv.smembers(K.moderation.reportsIndex);

    let totalLikes = 0;
    let totalRating = 0;
    let reviewsCount = 0;
    let bannedCount = 0;
    let pendingReports = 0;

    for (const id of reviewIds) {
      const review = await getReviewById(id);
      if (review) {
        totalLikes += review.likes || 0;
        totalRating += review.rating || 0;
        reviewsCount++;
        
        if ((review.reportsCount || 0) > 0) {
          for (const rid of reportIds) {
            const report = await kv.get(K.moderation.report(rid));
            if (report && report.reviewId === id && report.status === 'pending') {
              pendingReports++;
              break;
            }
          }
        }
      }
    }

    for (const id of userIds) {
      const user = await getUserById(id);
      if (user) {
        const isBanned = await kv.get(K.moderation.ban(id));
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
    console.error('[Admin/Stats] Error:', err.message);
    res.status(500).json({ 
      error: 'Ошибка при получении статистики',
      code: 'STATS_ERROR'
    });
  }
});

router.get('/admin/reports', requireAuth, requireAdmin, async (req, res) => {
  try {
    const reportIds = await kv.smembers(K.moderation.reportsIndex);
    const reports = [];
    
    for (const id of reportIds) {
      const report = await kv.get(K.moderation.report(id));
      if (report && report.status === 'pending') {
        reports.push(report);
      }
    }
    
    reports.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json({ reports });
  } catch (err) {
    console.error('[Admin/Reports] Error:', err.message);
    res.status(500).json({ 
      error: 'Ошибка при получении списка жалоб',
      code: 'REPORTS_LIST_ERROR'
    });
  }
});

router.post('/admin/reports/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const report = await kv.get(K.moderation.report(req.params.id));
    
    if (!report) {
      return res.status(404).json({ 
        error: 'Жалоба не найдена',
        code: 'REPORT_NOT_FOUND'
      });
    }

    const { action } = req.body;
    
    if (!action || !['dismiss', 'delete'].includes(action)) {
      return res.status(400).json({ 
        error: 'Действие должно быть "dismiss" или "delete"',
        code: 'INVALID_ACTION'
      });
    }
    
    if (action === 'delete') {
      await kv.del(K.review.byId(report.reviewId));
      await kv.srem(K.review.index, report.reviewId);
      await auditLog('review_deleted_by_report', req.user.id, report.reviewId, `Жалоба: ${report.id}`);
      console.log(`[Admin/Reports] Review ${report.reviewId} deleted due to report ${report.id}`);
    }
    
    report.status = action === 'delete' ? 'resolved_deleted' : 'resolved_dismissed';
    report.resolvedAt = new Date().toISOString();
    report.resolvedBy = req.user.id;
    await kv.set(K.moderation.report(report.id), report);

    await auditLog('report_resolved', req.user.id, report.id, action);
    console.log(`[Admin/Reports] Report ${report.id} resolved with action: ${action}`);

    res.json({ 
      success: true,
      status: report.status
    });
  } catch (err) {
    console.error('[Admin/Reports] Error:', err.message);
    res.status(500).json({ 
      error: 'Ошибка при обработке жалобы',
      code: 'REPORT_RESOLVE_ERROR'
    });
  }
});

router.get('/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userIds = await kv.smembers(K.user.index);
    const users = [];
    
    for (const id of userIds) {
      const user = await getUserById(id);
      if (user) {
        const isBanned = await kv.get(K.moderation.ban(id));
        const reviewsCount = await getUserReviewsCount(id);
        
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
    console.error('[Admin/Users] Error:', err.message);
    res.status(500).json({ 
      error: 'Ошибка при получении списка пользователей',
      code: 'USERS_LIST_ERROR'
    });
  }
});

router.get('/admin/users/:id/info', requireAuth, requireAdmin, async (req, res) => {
  try {
    const user = await getUserById(req.params.id);
    
    if (!user) {
      return res.status(404).json({ 
        error: 'Пользователь не найден',
        code: 'USER_NOT_FOUND'
      });
    }
    
    const reviewIds = await getAllReviewIds();
    let userReviews = 0;
    let totalLikesReceived = 0;
    let totalRating = 0;
    let reportsCount = 0;
    let lastIp = 'Неизвестно';
    let lastUa = 'Неизвестно';

    for (const id of reviewIds) {
      const review = await getReviewById(id);
      if (review && review.userId === user.id) {
        userReviews++;
        totalLikesReceived += review.likes || 0;
        totalRating += review.rating || 0;
        reportsCount += review.reportsCount || 0;
        lastIp = review.ip || lastIp;
        lastUa = review.userAgent || lastUa;
      }
    }

    const isBanned = await kv.get(K.moderation.ban(user.id));

    res.json({ 
      user: formatUserResponse(user),
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
    console.error('[Admin/UserInfo] Error:', err.message);
    res.status(500).json({ 
      error: 'Ошибка при получении информации о пользователе',
      code: 'USER_INFO_ERROR'
    });
  }
});

router.post('/admin/users/:id/ban', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    
    const banInfo = { 
      reason: reason || 'Нарушение правил', 
      date: new Date().toISOString(),
      bannedBy: req.user.id
    };
    
    await kv.set(K.moderation.ban(req.params.id), banInfo);
    
    await auditLog('user_banned', req.user.id, req.params.id, reason || 'Нарушение правил');
    console.log(`[Admin/Ban] User ${req.params.id} banned by admin ${req.user.id}`);

    res.json({ 
      success: true,
      message: 'Пользователь заблокирован',
      banInfo
    });
  } catch (err) {
    console.error('[Admin/Ban] Error:', err.message);
    res.status(500).json({ 
      error: 'Ошибка блокировки пользователя',
      code: 'USER_BAN_ERROR'
    });
  }
});

router.delete('/admin/users/:id/ban', requireAuth, requireAdmin, async (req, res) => {
  try {
    await kv.del(K.moderation.ban(req.params.id));
    
    await auditLog('user_unbanned', req.user.id, req.params.id);
    console.log(`[Admin/Unban] User ${req.params.id} unbanned by admin ${req.user.id}`);
    
    res.json({ 
      success: true,
      message: 'Пользователь разблокирован'
    });
  } catch (err) {
    console.error('[Admin/Unban] Error:', err.message);
    res.status(500).json({ 
      error: 'Ошибка разблокировки пользователя',
      code: 'USER_UNBAN_ERROR'
    });
  }
});

router.get('/admin/audit', requireAuth, requireAdmin, async (req, res) => {
  try {
    const logIds = await kv.smembers(K.audit.index);
    const logs = [];
    
    for (const id of logIds) {
      const log = await kv.get(K.audit.byId(id));
      if (log) logs.push(log);
    }
    
    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    res.json({ 
      logs: logs.slice(0, AUDIT_LOG_LIMIT),
      total: logs.length
    });
  } catch (err) {
    console.error('[Admin/Audit] Error:', err.message);
    res.status(500).json({ 
      error: 'Ошибка при получении журнала аудита',
      code: 'AUDIT_LOG_ERROR'
    });
  }
});

// ============================================
// Export
// ============================================

module.exports = router;