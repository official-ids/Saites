/**
 * ============================================================================
 * GcStudio Promo Bot v4.0 - FULL EDITION
 * ============================================================================
 * 
 * Telegram бот для управления промокодами с полным функционалом:
 * 
 * 🎯 ФИКСЫ v4.0:
 * - sendMessage теперь возвращает ПЕРВЫЙ message_id (прогресс-бары работают)
 * - codeStatus нормализует старые коды без поля status
 * - restoreBackup очищает старые данные (режим replace/merge)
 * - activateCode защищён от race condition через KV-лок
 * - Проверка числового ID в /whois, /ban, /mute
 * - Админ-команды работают ТОЛЬКО в личке
 * 
 * 🎨 UX v4.0:
 * - Inline-кнопки в /start
 * - Админ-панель с кнопками
 * - Инлайн-ввод кода (без /code)
 * - Кнопка "Поделиться ботом"
 * - Прогресс-бар пагинации
 * 
 * 🧠 НОВЫЕ ФИЧИ v4.0:
 * - Реферальная система (t.me/Bot?start=ref_ID)
 * - Система бейджей (8 бейджей)
 * - CSV-экспорт пользователей
 * - ASCII-график активаций за 7 дней
 * - Топ промокодов
 * - Двухшаговое подтверждение для опасных действий
 * 
 * @author GcStudio
 * @version 4.0.0
 */

const { kv } = require("@vercel/kv");

// ============================================
// 1. КОНФИГУРАЦИЯ И КОНСТАНТЫ
// ============================================

const CONFIG = {
  BOT_TOKEN: process.env.GS_BOT_TOKEN,
  WEBHOOK_SECRET: process.env.GS_WEBHOOK_SECRET || "",
  ADMIN_IDS: String(process.env.GS_ADMIN_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
  BOT_USERNAME: process.env.GS_BOT_USERNAME || "TheGcStudio_bot",
  CHANNEL_URL: process.env.GS_CHANNEL_URL || "https://t.me/undercurgame",
  
  // Таймауты
  FETCH_TIMEOUT: 7000,
  STATE_TIMEOUT: 10 * 60 * 1000,
  EXPIRED_CODE_RETENTION: 60 * 60 * 1000,
  LOCK_TTL: 10,
  
  // Rate limiting
  RATE_LIMIT_WINDOW: 60 * 1000,
  RATE_LIMIT_MAX_REQUESTS: 30,
  CREATE_LIMIT_WINDOW: 60 * 1000,
  CREATE_LIMIT_MAX: 10,
  
  // Лимиты
  MAX_MESSAGE_LENGTH: 4000,
  MAX_CODES_PER_PAGE: 10,
  MAX_USERS_PER_PAGE: 10,
  MAX_LEADERBOARD_SIZE: 20,
  MAX_BACKUPS: 10,
  
  // Broadcast
  BROADCAST_DELAY: 50,
  MAX_BROADCAST_USERS: 10000,
  
  // Схема
  SCHEMA_VERSION: 4,
};

const TG_API = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}`;

// Статусы кодов
const CODE_STATUS = {
  ACTIVE: "active",
  PENDING: "pending",
  NO_REWARD: "no_reward",
  DISABLED: "disabled",
};

// Категории кодов
const CODE_CATEGORIES = {
  NEW: "NEW",
  EVENT: "EVENT",
  VIP: "VIP",
  SECRET: "SECRET",
  STANDARD: "STANDARD",
};

// Иконки статусов
const STATUS_ICONS = {
  active: "🟢",
  pending: "🟡",
  no_reward: "🔴",
  disabled: "⚫",
  expired: "🟠",
  unknown: "⚪",
};

// Иконки категорий
const CATEGORY_ICONS = {
  NEW: "🆕",
  EVENT: "🎉",
  VIP: "💎",
  SECRET: "🔐",
  STANDARD: "📦",
};

// Система бейджей
const BADGES = {
  FIRST_CODE: { id: "first_code", emoji: "🎯", name: "Первый код", desc: "Активировал первый промокод" },
  CODES_10: { id: "codes_10", emoji: "🔥", name: "Активист", desc: "Активировал 10 промокодов" },
  CODES_50: { id: "codes_50", emoji: "💎", name: "Коллекционер", desc: "Активировал 50 промокодов" },
  CODES_100: { id: "codes_100", emoji: "👑", name: "Легенда", desc: "Активировал 100 промокодов" },
  REFERRER_1: { id: "referrer_1", emoji: "🌱", name: "Новичок", desc: "Пригласил 1 друга" },
  REFERRER_5: { id: "referrer_5", emoji: "👥", name: "Реферрал-мастер", desc: "Пригласил 5 друзей" },
  REFERRER_10: { id: "referrer_10", emoji: "🌳", name: "Садовод", desc: "Пригласил 10 друзей" },
  SPEEDSTER: { id: "speedster", emoji: "⚡", name: "Спринтер", desc: "Активировал код в первую минуту" },
  NIGHT_OWL: { id: "night_owl", emoji: "🦉", name: "Сова", desc: "Активировал код ночью (00:00-05:00 UTC)" },
  EARLY_BIRD: { id: "early_bird", emoji: "🌅", name: "Ранняя пташка", desc: "Активировал код утром (05:00-08:00 UTC)" },
};

// Префиксы ключей KV
const KV_PREFIXES = {
  CODE: "gs:code:",
  USER: "gs:user:",
  ALL_USERS: "gs:all_users",
  ALL_CODES: "gs:codes",
  BAN_LIST: "gs:banned",
  MUTE_LIST: "gs:muted",
  LOGS: "gs:logs",
  BACKUPS: "gs:backups",
  RATE_LIMIT: "gs:rl:",
  SCHEDULES: "gs:schedules",
  STATS: "gs:stats",
  DAILY_STATS: "gs:daily_stats",
  STATE: "gs:state:",
  LOCK: "gs:lock:",
  SCHEMA_VERSION: "gs:schema_version",
};

// ============================================
// 2. УТИЛИТЫ И ХЕЛПЕРЫ
// ============================================

/**
 * Проверяет, является ли пользователь админом
 */
function isAdmin(userId) {
  return CONFIG.ADMIN_IDS.includes(String(userId));
}

/**
 * Проверяет, что строка - число
 */
function isNumeric(str) {
  return /^\d+$/.test(String(str));
}

/**
 * Безопасно парсит строку в число
 */
function safeParseInt(str) {
  const num = parseInt(str, 10);
  return isNaN(num) ? null : num;
}

/**
 * Экранирует HTML-символы
 */
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Обрезает строку
 */
function truncate(str, maxLen = 100) {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + "...";
}

/**
 * Разбивает длинное сообщение на части
 */
function splitMessage(text, maxLen = CONFIG.MAX_MESSAGE_LENGTH) {
  if (text.length <= maxLen) return [text];
  
  const parts = [];
  let remaining = text;
  
  while (remaining.length > maxLen) {
    let splitIndex = remaining.lastIndexOf("\n", maxLen);
    if (splitIndex === -1 || splitIndex < maxLen / 2) {
      splitIndex = maxLen;
    }
    parts.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }
  
  if (remaining) parts.push(remaining);
  return parts;
}

/**
 * Разница во времени
 */
function timeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  
  if (months > 0) return `${months} мес. назад`;
  if (weeks > 0) return `${weeks} нед. назад`;
  if (days > 0) return `${days} дн. назад`;
  if (hours > 0) return `${hours} ч. назад`;
  if (minutes > 0) return `${minutes} мин. назад`;
  return "только что";
}

/**
 * Форматирует длительность
 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}мс`;
  if (ms < 60000) return `${Math.floor(ms / 1000)}с`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}м`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}ч`;
  return `${Math.floor(ms / 86400000)}д`;
}

/**
 * Генерирует уникальный ID
 */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

/**
 * Прогресс-бар
 */
function progressBar(current, total, width = 10) {
  if (total === 0) return "░".repeat(width);
  const filled = Math.round((current / total) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// ============================================
// 3. РАБОТА С ДАТАМИ (UTC)
// ============================================

/**
 * Парсит дату: ДД.ММ.ГГГГ+ЧЧ:ММ или относительную (+7d, +24h)
 */
function parseDate(str) {
  if (!str) return null;
  str = str.trim();
  
  // Относительный: +7d, +24h, +30m, +1w
  const relativeMatch = str.match(/^\+(\d+)([dhmw])$/i);
  if (relativeMatch) {
    const value = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();
    const multipliers = {
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
      w: 7 * 24 * 60 * 60 * 1000,
    };
    return Date.now() + value * multipliers[unit];
  }
  
  // Абсолютный: ДД.ММ.ГГГГ+ЧЧ:ММ
  const match = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\+(\d{1,2}):(\d{1,2})$/);
  if (!match) return null;

  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1;
  const year = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);

  if (day < 1 || day > 31) return null;
  if (month < 0 || month > 11) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;

  const timestamp = Date.UTC(year, month, day, hour, minute, 0, 0);
  return isNaN(timestamp) ? null : timestamp;
}

/**
 * Форматирует timestamp (UTC)
 */
function formatDate(timestamp, withSeconds = false) {
  if (!timestamp) return "—";
  const d = new Date(timestamp);
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const year = d.getUTCFullYear();
  const hour = String(d.getUTCHours()).padStart(2, "0");
  const minute = String(d.getUTCMinutes()).padStart(2, "0");
  
  if (withSeconds) {
    const second = String(d.getUTCSeconds()).padStart(2, "0");
    return `${day}.${month}.${year} ${hour}:${minute}:${second} UTC`;
  }
  
  return `${day}.${month}.${year} ${hour}:${minute} UTC`;
}

/**
 * Умная дата: сегодня/вчера/дата
 */
function smartDate(timestamp) {
  const now = new Date();
  const date = new Date(timestamp);
  
  const nowUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dateUtc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const diffDays = Math.floor((nowUtc - dateUtc) / (24 * 60 * 60 * 1000));
  
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  
  if (diffDays === 0) return `сегодня в ${hour}:${minute}`;
  if (diffDays === 1) return `вчера в ${hour}:${minute}`;
  if (diffDays < 7) return `${diffDays} дн. назад`;
  
  return formatDate(timestamp);
}

/**
 * Получает дату в формате YYYY-MM-DD
 */
function getDateKey(timestamp = Date.now()) {
  const d = new Date(timestamp);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// ============================================
// 4. TELEGRAM API WRAPPER
// ============================================

/**
 * Запрос к Telegram API
 */
async function telegram(method, body = {}, retries = 2) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT);

  try {
    const response = await fetch(`${TG_API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    
    const data = await response.json();
    
    if (!data.ok) {
      console.error(`[TG ERROR] ${method}:`, data.description);
      
      if (retries > 0 && response.status >= 500) {
        await new Promise(r => setTimeout(r, 1000));
        return telegram(method, body, retries - 1);
      }
    }
    
    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error(`[TG FETCH ERROR] ${method}:`, error.message);
    
    if (retries > 0 && error.name !== "AbortError") {
      await new Promise(r => setTimeout(r, 1000));
      return telegram(method, body, retries - 1);
    }
    
    return { ok: false, error: error.message };
  }
}

/**
 * 🔥 ИСПРАВЛЕНО: возвращает ПЕРВЫЙ message_id
 */
async function sendMessage(chatId, text, extra = {}) {
  if (!text) return { ok: false };
  
  const parts = splitMessage(String(text));
  let firstResult = null;
  let lastResult = null;
  
  for (const part of parts) {
    lastResult = await telegram("sendMessage", {
      chat_id: chatId,
      text: part,
      disable_web_page_preview: true,
      ...extra,
    });
    if (!firstResult) firstResult = lastResult;
  }
  
  return firstResult || lastResult;
}

/**
 * Редактирует сообщение
 */
async function editMessage(chatId, messageId, text, extra = {}) {
  return telegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
    ...extra,
  });
}

/**
 * Редактирует клавиатуру
 */
async function editKeyboard(chatId, messageId, inlineKeyboard) {
  return telegram("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

/**
 * Ответ на callback
 */
async function answerCallback(callbackId, text = "", showAlert = false) {
  return telegram("answerCallbackQuery", {
    callback_query_id: callbackId,
    text,
    show_alert: showAlert,
  });
}

/**
 * Удаляет сообщение
 */
async function deleteMessage(chatId, messageId) {
  return telegram("deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
}

/**
 * Индикатор "печатает..."
 */
async function sendChatAction(chatId, action = "typing") {
  return telegram("sendChatAction", {
    chat_id: chatId,
    action,
  });
}

/**
 * Отправляет фото
 */
async function sendPhoto(chatId, photo, caption = "", extra = {}) {
  return telegram("sendPhoto", {
    chat_id: chatId,
    photo,
    caption,
    ...extra,
  });
}

/**
 * Отправляет документ
 */
async function sendDocument(chatId, document, caption = "", extra = {}) {
  return telegram("sendDocument", {
    chat_id: chatId,
    document,
    caption,
    ...extra,
  });
}

/**
 * Отправляет видео
 */
async function sendVideo(chatId, video, caption = "", extra = {}) {
  return telegram("sendVideo", {
    chat_id: chatId,
    video,
    caption,
    ...extra,
  });
}

/**
 * Отправляет GIF
 */
async function sendAnimation(chatId, animation, caption = "", extra = {}) {
  return telegram("sendAnimation", {
    chat_id: chatId,
    animation,
    caption,
    ...extra,
  });
}

// ============================================
// 5. СИСТЕМА ЛОГИРОВАНИЯ
// ============================================

/**
 * Записывает действие в лог
 */
async function logAction(action, details = {}) {
  try {
    const entry = {
      id: generateId(),
      timestamp: Date.now(),
      action,
      ...details,
    };
    
    // Добавляем username, если есть userId
    if (details.userId) {
      const user = await getUser(details.userId);
      if (user && user.username) {
        entry.username = user.username;
      }
    }
    
    const logs = (await kv.get(KV_PREFIXES.LOGS)) || [];
    logs.unshift(entry);
    
    if (logs.length > 500) {
      logs.length = 500;
    }
    
    await kv.set(KV_PREFIXES.LOGS, logs);
  } catch (error) {
    console.error("[LOG ERROR]", error);
  }
}

/**
 * Получает последние записи
 */
async function getLogs(limit = 20) {
  const logs = (await kv.get(KV_PREFIXES.LOGS)) || [];
  return logs.slice(0, limit);
}

/**
 * Очищает лог
 */
async function clearLogs() {
  await kv.set(KV_PREFIXES.LOGS, []);
}

/**
 * Форматирует лог
 */
function formatLogEntry(entry) {
  const time = smartDate(entry.timestamp);
  const user = entry.userId ? `[<code>${entry.userId}</code>]` : "";
  const username = entry.username ? `@${escapeHtml(entry.username)}` : "";
  const action = entry.action.toUpperCase();
  const extra = entry.extra ? ` ${escapeHtml(entry.extra)}` : "";
  return `• <code>${time}</code> ${user} ${username} <b>${action}</b>${extra}`;
}

// ============================================
// 6. РАБОТА С KV
// ============================================

/**
 * Получает код
 */
async function getCode(name) {
  if (!name) return null;
  return await kv.get(`${KV_PREFIXES.CODE}${name.toUpperCase()}`);
}

/**
 * Сохраняет код
 */
async function saveCode(name, data) {
  const key = `${KV_PREFIXES.CODE}${name.toUpperCase()}`;
  await kv.set(key, data);
  await kv.sadd(KV_PREFIXES.ALL_CODES, name.toUpperCase());
}

/**
 * Удаляет код
 */
async function deleteCode(name) {
  const key = `${KV_PREFIXES.CODE}${name.toUpperCase()}`;
  await kv.del(key);
  await kv.srem(KV_PREFIXES.ALL_CODES, name.toUpperCase());
}

/**
 * Список всех кодов
 */
async function listCodeNames() {
  return (await kv.smembers(KV_PREFIXES.ALL_CODES)) || [];
}

/**
 * Получает пользователя
 */
async function getUser(userId) {
  const key = `${KV_PREFIXES.USER}${userId}`;
  return (await kv.get(key)) || {
    userId: String(userId),
    usedCodes: [],
    activations: 0,
    badges: [],
    referrals: [],
    referredBy: null,
  };
}

/**
 * Сохраняет пользователя
 */
async function saveUser(userId, data = {}, username = null) {
  const key = `${KV_PREFIXES.USER}${userId}`;
  const old = (await kv.get(key)) || {
    userId: String(userId),
    usedCodes: [],
    activations: 0,
    badges: [],
    referrals: [],
    referredBy: null,
  };

  const isNewUser = !old.userId || !old.createdAt;

  await kv.set(key, {
    ...old,
    userId: String(userId),
    username: username || old.username || null,
    ...data,
    updatedAt: Date.now(),
    createdAt: old.createdAt || Date.now(),
    lastSeen: Date.now(),
  });
  
  if (isNewUser) {
    await kv.sadd(KV_PREFIXES.ALL_USERS, String(userId));
    await incrementStat("total_users", 1);
    await logAction("user_joined", { userId: String(userId), username });
  }
}

/**
 * Список всех пользователей
 */
async function getAllUsers() {
  return (await kv.smembers(KV_PREFIXES.ALL_USERS)) || [];
}

/**
 * Удаляет пользователя
 */
async function deleteUser(userId) {
  await kv.del(`${KV_PREFIXES.USER}${userId}`);
  await kv.srem(KV_PREFIXES.ALL_USERS, String(userId));
}

/**
 * Банит пользователя
 */
async function banUser(userId, reason = "") {
  await kv.sadd(KV_PREFIXES.BAN_LIST, String(userId));
  await saveUser(userId, { banned: true, banReason: reason, bannedAt: Date.now() });
  await logAction("ban", { userId: String(userId), extra: reason });
}

/**
 * Разбанивает
 */
async function unbanUser(userId) {
  await kv.srem(KV_PREFIXES.BAN_LIST, String(userId));
  await saveUser(userId, { banned: false, banReason: null, bannedAt: null });
  await logAction("unban", { userId: String(userId) });
}

/**
 * Проверка бана
 */
async function isBanned(userId) {
  const list = (await kv.smembers(KV_PREFIXES.BAN_LIST)) || [];
  return list.includes(String(userId));
}

/**
 * Мутит
 */
async function muteUser(userId, duration = 0) {
  const mutedUntil = duration > 0 ? Date.now() + duration : Number.MAX_SAFE_INTEGER;
  await kv.sadd(KV_PREFIXES.MUTE_LIST, String(userId));
  await saveUser(userId, { muted: true, mutedUntil });
  await logAction("mute", { userId: String(userId), extra: formatDuration(duration) });
}

/**
 * Размучивает
 */
async function unmuteUser(userId) {
  await kv.srem(KV_PREFIXES.MUTE_LIST, String(userId));
  await saveUser(userId, { muted: false, mutedUntil: null });
  await logAction("unmute", { userId: String(userId) });
}

/**
 * Проверка мута
 */
async function isMuted(userId) {
  const user = await getUser(userId);
  if (!user.muted) return false;
  if (user.mutedUntil && Date.now() > user.mutedUntil) {
    await unmuteUser(userId);
    return false;
  }
  return true;
}

// ============================================
// 7. RATE LIMITING
// ============================================

/**
 * Проверка rate limit
 */
async function checkRateLimit(userId, customKey = null, maxRequests = null, windowMs = null) {
  const key = customKey 
    ? `${KV_PREFIXES.RATE_LIMIT}${customKey}:${userId}`
    : `${KV_PREFIXES.RATE_LIMIT}${userId}`;
  
  const max = maxRequests || CONFIG.RATE_LIMIT_MAX_REQUESTS;
  const window = windowMs || CONFIG.RATE_LIMIT_WINDOW;
  const now = Date.now();
  const windowStart = now - window;
  
  let data = (await kv.get(key)) || { timestamps: [] };
  
  data.timestamps = data.timestamps.filter(t => t > windowStart);
  
  if (data.timestamps.length >= max) {
    return { allowed: false, remaining: 0 };
  }
  
  data.timestamps.push(now);
  await kv.set(key, data, { ex: Math.ceil(window / 1000) + 60 });
  
  return {
    allowed: true,
    remaining: max - data.timestamps.length,
  };
}

// ============================================
// 8. СТАТИСТИКА
// ============================================

/**
 * Увеличивает счётчик
 */
async function incrementStat(key, increment = 1) {
  const stats = (await kv.get(KV_PREFIXES.STATS)) || {};
  stats[key] = (stats[key] || 0) + increment;
  await kv.set(KV_PREFIXES.STATS, stats);
}

/**
 * Получает статистику
 */
async function getStats() {
  return (await kv.get(KV_PREFIXES.STATS)) || {};
}

/**
 * Инкремент дневной статистики
 */
async function incrementDailyStat(key, increment = 1) {
  const dateKey = getDateKey();
  const dailyStats = (await kv.get(KV_PREFIXES.DAILY_STATS)) || {};
  
  if (!dailyStats[dateKey]) {
    dailyStats[dateKey] = { activations: 0, new_users: 0, codes_created: 0 };
  }
  
  dailyStats[dateKey][key] = (dailyStats[dateKey][key] || 0) + increment;
  
  // Храним последние 30 дней
  const keys = Object.keys(dailyStats).sort();
  if (keys.length > 30) {
    const toDelete = keys.slice(0, keys.length - 30);
    for (const k of toDelete) delete dailyStats[k];
  }
  
  await kv.set(KV_PREFIXES.DAILY_STATS, dailyStats);
}

/**
 * Полный сбор статистики
 */
async function gatherFullStats() {
  const [
    codeNames,
    allUsers,
    stats,
    banned,
    muted,
    logs,
  ] = await Promise.all([
    listCodeNames(),
    getAllUsers(),
    getStats(),
    kv.smembers(KV_PREFIXES.BAN_LIST) || [],
    kv.smembers(KV_PREFIXES.MUTE_LIST) || [],
    getLogs(500),
  ]);
  
  let activeCodes = 0;
  let pendingCodes = 0;
  let noRewardCodes = 0;
  let expiredCodes = 0;
  let totalActivations = 0;
  
  const now = Date.now();
  
  for (const name of codeNames) {
    const code = await getCode(name);
    if (!code) continue;
    
    const st = codeStatus(code);
    if (st.expired) expiredCodes++;
    else if (st.status === CODE_STATUS.ACTIVE) activeCodes++;
    else if (st.status === CODE_STATUS.PENDING) pendingCodes++;
    else if (st.status === CODE_STATUS.NO_REWARD) noRewardCodes++;
    
    totalActivations += (code.usedBy || []).length;
  }
  
  const dayAgo = now - 24 * 60 * 60 * 1000;
  let activeUsers24h = 0;
  for (const userId of allUsers) {
    const user = await getUser(userId);
    if (user.lastSeen && user.lastSeen > dayAgo) {
      activeUsers24h++;
    }
  }
  
  return {
    codes: {
      total: codeNames.length,
      active: activeCodes,
      pending: pendingCodes,
      noReward: noRewardCodes,
      expired: expiredCodes,
    },
    users: {
      total: allUsers.length,
      banned: banned.length,
      muted: muted.length,
      active24h: activeUsers24h,
    },
    activations: {
      total: totalActivations,
      fromStats: stats.total_activations || 0,
    },
    broadcasts: {
      total: stats.broadcasts_sent || 0,
    },
    logs: logs.length,
    uptime: stats.first_start ? now - stats.first_start : 0,
  };
}

// ============================================
// 9. ЛОГИКА КОДОВ
// ============================================

/**
 * 🔥 ИСПРАВЛЕНО: нормализация статуса
 */
function codeStatus(code) {
  if (!code) {
    return { icon: "❓", label: "не найден", expired: false, status: "unknown" };
  }
  
  const now = Date.now();

  if (code.disabled) {
    return { icon: STATUS_ICONS.disabled, label: "отключён", expired: false, status: CODE_STATUS.DISABLED };
  }

  if (code.expiresAt && now > code.expiresAt) {
    return { icon: STATUS_ICONS.expired, label: "истёк", expired: true, status: "expired" };
  }

  // Нормализация для старых кодов
  let status = code.status;
  if (!status) {
    if (code.reward) status = CODE_STATUS.ACTIVE;
    else status = CODE_STATUS.NO_REWARD;
  }

  if (status === CODE_STATUS.NO_REWARD) {
    return { icon: STATUS_ICONS.no_reward, label: "нет награды", expired: false, status };
  }

  if (status === CODE_STATUS.PENDING) {
    return { icon: STATUS_ICONS.pending, label: "в процессе", expired: false, status };
  }

  if (status === CODE_STATUS.ACTIVE) {
    return { icon: STATUS_ICONS.active, label: "активен", expired: false, status };
  }

  return { icon: STATUS_ICONS.unknown, label: "неизвестно", expired: false, status: "unknown" };
}

/**
 * Чистит старые истёкшие коды
 */
async function cleanupExpiredCodes() {
  const names = await listCodeNames();
  const now = Date.now();
  let deleted = 0;
  let kept = 0;

  for (const name of names) {
    const code = await getCode(name);
    if (!code) continue;

    if (code.expiresAt && now - code.expiresAt > CONFIG.EXPIRED_CODE_RETENTION) {
      await deleteCode(name);
      deleted++;
    } else {
      kept++;
    }
  }
  
  return { deleted, kept };
}

/**
 * Создаёт новый код
 */
async function createNewCode(params) {
  const { name, expiresAt, createdBy, category = CODE_CATEGORIES.STANDARD, maxUses = 0 } = params;
  
  const code = {
    name: name.toUpperCase(),
    createdAt: Date.now(),
    expiresAt,
    reward: null,
    status: CODE_STATUS.NO_REWARD,
    category,
    maxUses: maxUses || 0,
    usedBy: [],
    createdBy: String(createdBy),
    disabled: false,
  };
  
  await saveCode(name, code);
  await incrementStat("codes_created", 1);
  await incrementDailyStat("codes_created", 1);
  await logAction("code_created", { userId: String(createdBy), extra: name });
  
  return code;
}

// ============================================
// 10. БЭКАПЫ
// ============================================

/**
 * Создаёт бэкап
 */
async function createBackup(createdBy) {
  const backupId = generateId();
  const codeNames = await listCodeNames();
  const allUsers = await getAllUsers();
  
  const backup = {
    id: backupId,
    createdAt: Date.now(),
    createdBy: String(createdBy),
    codes: [],
    users: [],
    stats: await getStats(),
  };
  
  for (const name of codeNames) {
    const code = await getCode(name);
    if (code) backup.codes.push(code);
  }
  
  for (const userId of allUsers) {
    const user = await getUser(userId);
    if (user) {
      backup.users.push({
        userId: user.userId,
        username: user.username,
        usedCodes: user.usedCodes || [],
        activations: user.activations || 0,
        banned: user.banned || false,
        badges: user.badges || [],
        referrals: user.referrals || [],
        createdAt: user.createdAt,
      });
    }
  }
  
  const backups = (await kv.get(KV_PREFIXES.BACKUPS)) || [];
  backups.unshift({ id: backupId, createdAt: Date.now(), data: backup });
  
  if (backups.length > CONFIG.MAX_BACKUPS) {
    backups.length = CONFIG.MAX_BACKUPS;
  }
  
  await kv.set(KV_PREFIXES.BACKUPS, backups);
  await logAction("backup_created", { userId: String(createdBy), extra: backupId });
  
  return backupId;
}

/**
 * 🔥 ИСПРАВЛЕНО: режим replace по умолчанию
 */
async function restoreBackup(backupId, mode = "replace") {
  const backups = (await kv.get(KV_PREFIXES.BACKUPS)) || [];
  const backup = backups.find(b => b.id === backupId);
  
  if (!backup || !backup.data) {
    throw new Error("Бэкап не найден");
  }
  
  const data = backup.data;
  let codesRestored = 0;
  let usersRestored = 0;
  let codesDeleted = 0;
  
  // 🔥 Если replace — сначала сносим всё
  if (mode === "replace") {
    const existingCodes = await listCodeNames();
    for (const name of existingCodes) {
      await deleteCode(name);
      codesDeleted++;
    }
  }
  
  for (const code of data.codes) {
    await saveCode(code.name, code);
    codesRestored++;
  }
  
  for (const user of data.users) {
    await saveUser(user.userId, {
      username: user.username,
      usedCodes: user.usedCodes,
      activations: user.activations,
      banned: user.banned,
      badges: user.badges || [],
      referrals: user.referrals || [],
      createdAt: user.createdAt,
    });
    usersRestored++;
  }
  
  await logAction("backup_restored", { extra: `${backupId} (mode: ${mode})` });
  
  return { codesRestored, usersRestored, codesDeleted };
}

/**
 * Список бэкапов
 */
async function listBackups() {
  const backups = (await kv.get(KV_PREFIXES.BACKUPS)) || [];
  return backups.map(b => ({
    id: b.id,
    createdAt: b.createdAt,
    codesCount: b.data?.codes?.length || 0,
    usersCount: b.data?.users?.length || 0,
  }));
}

/**
 * Удаляет бэкап
 */
async function deleteBackup(backupId) {
  const backups = (await kv.get(KV_PREFIXES.BACKUPS)) || [];
  const filtered = backups.filter(b => b.id !== backupId);
  
  if (filtered.length === backups.length) return false;
  
  await kv.set(KV_PREFIXES.BACKUPS, filtered);
  return true;
}

// ============================================
// 11. ЭКСПОРТ / ИМПОРТ
// ============================================

/**
 * Экспорт кодов в JSON
 */
async function exportCodes() {
  const names = await listCodeNames();
  const codes = [];
  
  for (const name of names) {
    const code = await getCode(name);
    if (code) codes.push(code);
  }
  
  return JSON.stringify(codes, null, 2);
}

/**
 * 🔥 НОВОЕ: экспорт пользователей в CSV
 */
async function exportUsersCSV() {
  const allUsers = await getAllUsers();
  const rows = ["id,username,activations,banned,created_at,last_seen,badges"];
  
  for (const uid of allUsers) {
    const u = await getUser(uid);
    const badges = (u.badges || []).join("|");
    rows.push([
      u.userId,
      (u.username || "").replace(/,/g, ""),
      u.activations || 0,
      u.banned ? "yes" : "no",
      u.createdAt ? new Date(u.createdAt).toISOString() : "",
      u.lastSeen ? new Date(u.lastSeen).toISOString() : "",
      badges,
    ].join(","));
  }
  
  return rows.join("\n");
}

/**
 * Импорт кодов
 */
async function importCodes(jsonData, mode = "merge") {
  let codes;
  try {
    codes = JSON.parse(jsonData);
  } catch (e) {
    throw new Error("Неверный формат JSON");
  }
  
  if (!Array.isArray(codes)) {
    throw new Error("Данные должны быть массивом");
  }
  
  if (mode === "replace") {
    const existing = await listCodeNames();
    for (const name of existing) {
      await deleteCode(name);
    }
  }
  
  let imported = 0;
  let skipped = 0;
  
  for (const code of codes) {
    if (!code.name || !code.createdAt) {
      skipped++;
      continue;
    }
    
    const existing = await getCode(code.name);
    if (existing && mode === "merge") {
      skipped++;
      continue;
    }
    
    await saveCode(code.name, code);
    imported++;
  }
  
  await logAction("import", { extra: `${imported} imported, ${skipped} skipped` });
  
  return { imported, skipped, total: codes.length };
}

// ============================================
// 12. БЕЙДЖИ
// ============================================

/**
 * 🔥 НОВОЕ: выдаёт бейдж
 */
async function awardBadge(userId, badgeId) {
  const user = await getUser(userId);
  const badges = user.badges || [];
  
  if (badges.includes(badgeId)) return false;
  
  badges.push(badgeId);
  await saveUser(userId, { badges });
  
  const badge = BADGES[badgeId];
  if (badge) {
    try {
      await sendMessage(
        userId,
        `🏆 <b>Новый бейдж!</b>\n\n${badge.emoji} <b>${badge.name}</b>\n<i>${badge.desc}</i>`,
        { parse_mode: "HTML" }
      );
    } catch (e) {
      // Пользователь мог заблокировать бота
    }
  }
  
  await logAction("badge_awarded", { userId: String(userId), extra: badgeId });
  return true;
}

/**
 * Проверяет и выдаёт бейджи по активациям
 */
async function checkActivationBadges(userId, activationCount) {
  if (activationCount === 1) await awardBadge(userId, "FIRST_CODE");
  if (activationCount === 10) await awardBadge(userId, "CODES_10");
  if (activationCount === 50) await awardBadge(userId, "CODES_50");
  if (activationCount === 100) await awardBadge(userId, "CODES_100");
}

/**
 * Проверяет бейджи по времени активации
 */
async function checkTimeBadges(userId) {
  const hour = new Date().getUTCHours();
  
  if (hour >= 0 && hour < 5) {
    await awardBadge(userId, "NIGHT_OWL");
  } else if (hour >= 5 && hour < 8) {
    await awardBadge(userId, "EARLY_BIRD");
  }
}

// ============================================
// 13. РЕФЕРАЛЬНАЯ СИСТЕМА
// ============================================

/**
 * 🔥 НОВОЕ: обрабатывает реферала
 */
async function processReferral(newUserId, referrerId) {
  if (!referrerId) return false;
  if (String(newUserId) === String(referrerId)) return false;
  
  const newUser = await getUser(newUserId);
  if (newUser.referredBy) return false;
  
  // Проверяем, что referrer существует
  const referrer = await getUser(referrerId);
  if (!referrer.createdAt) return false;
  
  // Записываем нового пользователя
  await saveUser(newUserId, { referredBy: String(referrerId) });
  
  // Обновляем referrer
  const referrals = referrer.referrals || [];
  referrals.push({
    userId: String(newUserId),
    date: Date.now(),
  });
  await saveUser(referrerId, { referrals });
  
  await incrementStat("total_referrals", 1);
  await logAction("referral", { 
    userId: String(referrerId), 
    extra: `new: ${newUserId}` 
  });
  
  // Уведомляем referrer
  const count = referrals.length;
  try {
    await sendMessage(
      referrerId,
      `🎉 <b>Новый реферал!</b>\n\n` +
        `Ты пригласил ${count} ${getWordForm(count, ["человека", "человек", "человек"])}.\n\n` +
        `${count >= 5 ? "🏆 Продолжай в том же духе!" : `До бейджа «Реферрал-мастер» осталось: ${5 - count}`}`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    // Игнорируем
  }
  
  // Бейджи за рефералов
  if (count === 1) await awardBadge(referrerId, "REFERRER_1");
  if (count === 5) await awardBadge(referrerId, "REFERRER_5");
  if (count === 10) await awardBadge(referrerId, "REFERRER_10");
  
  return true;
}

/**
 * Склонение существительных
 */
function getWordForm(num, forms) {
  const n = Math.abs(num) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
}

// ============================================
// 14. СИСТЕМА БЛОКИРОВОК (LOCKS)
// ============================================

/**
 * 🔥 НОВОЕ: пытается захватить лок
 */
async function acquireLock(key, ttlSeconds = CONFIG.LOCK_TTL) {
  try {
    const lockKey = `${KV_PREFIXES.LOCK}${key}`;
    const result = await kv.set(lockKey, Date.now(), { nx: true, ex: ttlSeconds });
    return result !== null;
  } catch (error) {
    console.error("[LOCK ERROR]", error.message);
    return true; // При ошибке пропускаем
  }
}

/**
 * Освобождает лок
 */
async function releaseLock(key) {
  try {
    await kv.del(`${KV_PREFIXES.LOCK}${key}`);
  } catch (error) {
    console.error("[UNLOCK ERROR]", error.message);
  }
}

// ============================================
// 15. КОМАНДЫ ПОЛЬЗОВАТЕЛЕЙ
// ============================================

/**
 * 🔥 УЛУЧШЕНО: /start с inline-кнопками
 */
async function sendStart(chatId, userId, username) {
  const user = await getUser(userId);
  const isNew = !user.createdAt;
  
  await saveUser(userId, {}, username);
  
  const fullStats = await gatherFullStats();
  
  const text = 
    `🎁 <b>GcStudio Promo Bot</b>\n\n` +
    `Привет${username ? `, @${escapeHtml(username)}` : ""}! 👋\n\n` +
    `Здесь ты можешь активировать промокоды и получать эксклюзивные награды.\n\n` +
    `📊 <b>Статистика:</b>\n` +
    `• Промокодов: ${fullStats.codes.total}\n` +
    `• Активаций: ${fullStats.activations.total}\n` +
    `• Пользователей: ${fullStats.users.total}\n\n` +
    `Выбери действие:`;

  const inline_keyboard = [
    [
      { text: "🎁 Активировать код", callback_data: "prompt_code" },
      { text: "📋 Мои коды", callback_data: "my_codes" },
    ],
    [
      { text: "🏆 Топ активаций", callback_data: "leaderboard" },
      { text: "📊 Топ кодов", callback_data: "top_codes" },
    ],
    [
      { text: "👤 Мой профиль", callback_data: "my_profile" },
      { text: "🏅 Мои бейджи", callback_data: "my_badges" },
    ],
    [
      { text: "🔗 Пригласить друга", callback_data: "share_bot" },
      { text: "❓ Помощь", callback_data: "help" },
    ],
    [
      { text: "📢 Канал проекта", url: CONFIG.CHANNEL_URL },
    ],
  ];

  if (isAdmin(userId)) {
    inline_keyboard.unshift([
      { text: "👑 Админ-панель", callback_data: "admin_panel" },
    ]);
  }

  if (isNew) {
    await incrementStat("new_users_today", 1);
    await incrementDailyStat("new_users", 1);
  }

  return sendMessage(chatId, text, { 
    parse_mode: "HTML", 
    reply_markup: { inline_keyboard } 
  });
}

/**
 * Помощь
 */
async function sendHelp(chatId, isAdminUser = false) {
  let text = 
    `ℹ️ <b>Помощь по боту</b>\n\n` +
    `<b>🎯 Основные команды:</b>\n` +
    `🔹 <code>/code НАЗВАНИЕ</code> — активировать промокод\n` +
    `🔹 <code>/my</code> — мои использованные коды\n` +
    `🔹 <code>/top</code> — таблица лидеров\n` +
    `🔹 <code>/topcodes</code> — топ промокодов\n` +
    `🔹 <code>/profile</code> — мой профиль\n` +
    `🔹 <code>/badges</code> — мои бейджи\n` +
    `🔹 <code>/share</code> — пригласить друга\n` +
    `🔹 <code>/stats</code> — статистика бота\n\n` +
    `<b>💡 Как это работает:</b>\n` +
    `Промокоды публикуются в канале проекта. ` +
    `Если код истёк, уже использован или достиг лимита — бот сообщит об этом.\n\n` +
    `Каждый код можно активировать <b>только один раз</b>.\n\n`;
  
  if (isAdminUser) {
    text += 
      `<b>👑 Админ-команды:</b>\n` +
      `🔹 <code>/create КОД ДАТА [КАТЕГОРИЯ]</code>\n` +
      `🔹 <code>/link КОД</code> — привязать награду\n` +
      `🔹 <code>/reward КОД</code> — изменить награду\n` +
      `🔹 <code>/all [ФИЛЬТР] [СТР]</code> — список кодов\n` +
      `🔹 <code>/info КОД</code> — детали\n` +
      `🔹 <code>/extend КОД ДАТА</code>\n` +
      `🔹 <code>/delete КОД</code>\n` +
      `🔹 <code>/reset КОД</code> — сброс использований\n` +
      `🔹 <code>/resetuser ID</code>\n` +
      `🔹 <code>/copy СТАРЫЙ НОВЫЙ ДАТА</code>\n` +
      `🔹 <code>/rename СТАРЫЙ НОВЫЙ</code>\n` +
      `🔹 <code>/setlimit КОД N</code>\n` +
      `🔹 <code>/activate КОД USER_ID</code>\n\n` +
      `<b>👥 Модерация:</b>\n` +
      `🔹 <code>/ban ID [ПРИЧИНА]</code>\n` +
      `🔹 <code>/unban ID</code>\n` +
      `🔹 <code>/mute ID [ЧАСЫ]</code>\n` +
      `🔹 <code>/unmute ID</code>\n` +
      `🔹 <code>/users [СТР]</code>\n` +
      `🔹 <code>/whois ID</code>\n\n` +
      `<b>📢 Массовое:</b>\n` +
      `🔹 <code>/broadcast ТЕКСТ</code>\n` +
      `🔹 <code>/announce ТЕКСТ</code>\n` +
      `🔹 <code>/schedule ДАТА ТЕКСТ</code>\n\n` +
      `<b>⚙️ Система:</b>\n` +
      `🔹 <code>/logs</code>, <code>/clearlogs</code>\n` +
      `🔹 <code>/backup</code>, <code>/backups</code>, <code>/restore ID [merge]</code>\n` +
      `🔹 <code>/export</code>, <code>/exportcsv</code>, <code>/import JSON</code>\n` +
      `🔹 <code>/chart</code> — график активаций\n` +
      `🔹 <code>/ping</code>, <code>/health</code>\n` +
      `🔹 <code>/admin</code> — панель`;
  }

  return sendMessage(chatId, text, { parse_mode: "HTML" });
}

/**
 * Мои коды
 */
async function showMyCodes(chatId, userId) {
  const user = await getUser(userId);
  
  if (!user.usedCodes || user.usedCodes.length === 0) {
    const text = 
      `📭 <b>У тебя пока нет активированных промокодов</b>\n\n` +
      `Следи за каналом проекта, чтобы не пропустить новые!\n\n` +
      `💡 Нажми кнопку ниже, чтобы активировать код.`;
    
    return sendMessage(chatId, text, { 
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          { text: "🎁 Активировать код", callback_data: "prompt_code" },
        ]],
      },
    });
  }

  let text = `🎁 <b>Твои активированные коды (${user.usedCodes.length}):</b>\n\n`;
  
  for (let i = 0; i < user.usedCodes.length; i++) {
    const item = user.usedCodes[i];
    const codeName = typeof item === "string" ? item : item.name;
    const activatedAt = typeof item === "string" ? null : item.activatedAt;
    
    const prefix = i + 1;
    const timeStr = activatedAt ? ` (${smartDate(activatedAt)})` : "";
    text += `<b>${prefix}.</b> <code>${escapeHtml(codeName)}</code>${timeStr}\n`;
  }
  
  text += `\n📊 <b>Всего активаций:</b> ${user.activations || user.usedCodes.length}`;
  
  return sendMessage(chatId, text, { parse_mode: "HTML" });
}

/**
 * 🔥 УЛУЧШЕНО: activateCode с защитой от race condition
 */
async function activateCode(chatId, userId, username, codeName) {
  if (!codeName) {
    return sendMessage(
      chatId,
      `❌ <b>Укажи название кода</b>\n\n` +
        `Пример: <code>/code SUMMER2026</code>`,
      { parse_mode: "HTML" }
    );
  }

  const normalizedName = codeName.toUpperCase().trim();
  
  // 🔥 Защита от race condition
  const lockKey = `activate:${userId}:${normalizedName}`;
  const lockAcquired = await acquireLock(lockKey, 10);
  
  if (!lockAcquired) {
    return sendMessage(
      chatId,
      `⏳ Подожди, обрабатываем предыдущий запрос...`,
      { parse_mode: "HTML" }
    );
  }
  
  try {
    // Проверка бана
    if (await isBanned(userId)) {
      const user = await getUser(userId);
      return sendMessage(
        chatId,
        `⛔ <b>Ты заблокирован</b>\n\n` +
          `Ты не можешь активировать промокоды.\n` +
          `Причина: ${escapeHtml(user.banReason || "—")}`,
        { parse_mode: "HTML" }
      );
    }

    const code = await getCode(normalizedName);

    if (!code) {
      await incrementStat("invalid_code_attempts", 1);
      return sendMessage(
        chatId,
        `❌ <b>Код не найден</b>\n\n` +
          `Промокод <code>${escapeHtml(normalizedName)}</code> не существует. ` +
          `Проверь правильность написания.`,
        { parse_mode: "HTML" }
      );
    }

    if (code.disabled) {
      return sendMessage(
        chatId,
        `⚫ <b>Код отключён</b>\n\n` +
          `Промокод <code>${escapeHtml(code.name)}</code> временно недоступен.`,
        { parse_mode: "HTML" }
      );
    }

    const now = Date.now();

    if (code.expiresAt && now > code.expiresAt) {
      const expiredAt = formatDate(code.expiresAt);
      return sendMessage(
        chatId,
        `⏰ <b>Код истёк</b>\n\n` +
          `Промокод <code>${escapeHtml(code.name)}</code> перестал действовать ${expiredAt}.`,
        { parse_mode: "HTML" }
      );
    }

    // Нормализация статуса
    const st = codeStatus(code);
    if (st.status !== CODE_STATUS.ACTIVE) {
      return sendMessage(
        chatId,
        `⚠️ <b>Код ещё не готов</b>\n\n` +
          `Разработчики пока не завершили настройку награды для этого кода. ` +
          `Попробуй позже.`,
        { parse_mode: "HTML" }
      );
    }

    if (code.maxUses && code.maxUses > 0 && (code.usedBy || []).length >= code.maxUses) {
      return sendMessage(
        chatId,
        `📦 <b>Лимит исчерпан</b>\n\n` +
          `Промокод <code>${escapeHtml(code.name)}</code> уже использовали ${code.maxUses} раз.`,
        { parse_mode: "HTML" }
      );
    }

    const user = await getUser(userId);

    const alreadyUsed = (user.usedCodes || []).some(item => {
      const name = typeof item === "string" ? item : item.name;
      return name.toUpperCase() === code.name.toUpperCase();
    });
    
    if (alreadyUsed) {
      return sendMessage(
        chatId,
        `🔁 <b>Ты уже использовал этот код</b>\n\n` +
          `Каждый промокод можно активировать только один раз.`,
        { parse_mode: "HTML" }
      );
    }

    // Сохраняем активацию
    const activationRecord = {
      name: code.name,
      activatedAt: now,
      category: code.category,
    };
    
    const updatedUsedCodes = [...(user.usedCodes || []), activationRecord];
    const newActivations = (user.activations || 0) + 1;
    
    await saveUser(userId, { 
      usedCodes: updatedUsedCodes, 
      activations: newActivations 
    }, username);

    // Добавляем в список использовавших
    const usedBy = code.usedBy || [];
    const userIdentifier = username ? `@${username}` : String(userId);
    
    if (!usedBy.some(u => u.id === String(userId))) {
      usedBy.push({ 
        id: String(userId), 
        name: userIdentifier,
        activatedAt: now,
      });
    }
    
    code.usedBy = usedBy;
    await saveCode(code.name, code);
    
    await incrementStat("total_activations", 1);
    await incrementDailyStat("activations", 1);
    await logAction("code_activated", {
      userId: String(userId),
      username,
      extra: code.name,
    });

    const rewardText = code.reward || "Награда не указана.";
    const categoryIcon = CATEGORY_ICONS[code.category] || "📦";
    const successMessage =
      `✅ <b>Код успешно активирован!</b>\n\n` +
      `${categoryIcon} <b>Промокод:</b> <code>${code.name}</code>\n\n` +
      `<i>Всего твоих активаций: ${newActivations}</i>`;

    // Проверяем бейджи
    await checkActivationBadges(userId, newActivations);
    await checkTimeBadges(userId);

    // Отправляем сообщение об успехе
    await sendMessage(chatId, successMessage, { parse_mode: "HTML" });

    // Отправляем награду
    if (code.rewardMedia && code.rewardMediaType) {
      const caption = rewardText ? `🎉 <b>Твоя награда:</b>\n${rewardText}` : "";
      
      if (code.rewardMediaType === "photo") {
        return sendPhoto(chatId, code.rewardMedia, caption, { parse_mode: "HTML" });
      } else if (code.rewardMediaType === "video") {
        return sendVideo(chatId, code.rewardMedia, caption, { parse_mode: "HTML" });
      } else if (code.rewardMediaType === "document") {
        return sendDocument(chatId, code.rewardMedia, caption, { parse_mode: "HTML" });
      } else if (code.rewardMediaType === "animation") {
        return sendAnimation(chatId, code.rewardMedia, caption, { parse_mode: "HTML" });
      }
    }

    return sendMessage(
      chatId,
      `🎉 <b>Твоя награда:</b>\n${rewardText}`,
      { parse_mode: "HTML" }
    );
  } finally {
    await releaseLock(lockKey);
  }
}

/**
 * Таблица лидеров
 */
async function showLeaderboard(chatId) {
  const allUsers = await getAllUsers();
  
  if (allUsers.length === 0) {
    return sendMessage(chatId, "📭 Пока нет пользователей.", { parse_mode: "HTML" });
  }
  
  const usersWithStats = [];
  
  for (const userId of allUsers) {
    const user = await getUser(userId);
    if (user && (user.activations || 0) > 0) {
      usersWithStats.push({
        userId: user.userId,
        username: user.username,
        activations: user.activations || 0,
      });
    }
  }
  
  if (usersWithStats.length === 0) {
    return sendMessage(
      chatId,
      `🏆 <b>Таблица лидеров</b>\n\n` +
        `Пока никто не активировал ни одного кода. Будь первым!`,
      { parse_mode: "HTML" }
    );
  }
  
  usersWithStats.sort((a, b) => b.activations - a.activations);
  
  const topUsers = usersWithStats.slice(0, CONFIG.MAX_LEADERBOARD_SIZE);
  
  let text = `🏆 <b>Таблица лидеров</b> (топ-${topUsers.length})\n\n`;
  
  topUsers.forEach((user, index) => {
    let medal = "";
    if (index === 0) medal = "🥇";
    else if (index === 1) medal = "🥈";
    else if (index === 2) medal = "🥉";
    else medal = `${index + 1}.`;
    
    const name = user.username ? `@${escapeHtml(user.username)}` : `ID <code>${user.userId}</code>`;
    text += `${medal} ${name} — <b>${user.activations}</b> активаций\n`;
  });
  
  text += `\n<i>Стань лучшим — активируй больше кодов!</i>`;
  
  return sendMessage(chatId, text, { parse_mode: "HTML" });
}

/**
 * 🔥 ИСПРАВЛЕНО: топ промокодов с защитой секретных кодов
 */
async function showTopCodes(chatId, isAdminUser = false) {
  const codeNames = await listCodeNames();
  
  if (codeNames.length === 0) {
    return sendMessage(chatId, "📭 Пока нет промокодов.", { parse_mode: "HTML" });
  }
  
  const codesWithStats = [];
  
  for (const name of codeNames) {
    const code = await getCode(name);
    if (!code) continue;
    
    // 🔒 Скрываем SECRET-коды от обычных пользователей
    const category = code.category || "STANDARD";
    if (!isAdminUser && category === "SECRET") {
      continue; // вообще не показываем
    }
    
    codesWithStats.push({
      name: code.name,
      uses: (code.usedBy || []).length,
      category,
      isSecret: category === "SECRET",
      isVip: category === "VIP",
    });
  }
  
  if (codesWithStats.length === 0) {
    return sendMessage(
      chatId,
      `🏆 <b>Топ промокодов</b>\n\n📭 Пока нет публичных активаций.`,
      { parse_mode: "HTML" }
    );
  }
  
  codesWithStats.sort((a, b) => b.uses - a.uses);
  
  const top = codesWithStats.slice(0, 10);
  
  let text = `🏆 <b>Топ промокодов</b>\n\n`;
  
  top.forEach((code, index) => {
    let medal = "";
    if (index === 0) medal = "🥇";
    else if (index === 1) medal = "🥈";
    else if (index === 2) medal = "🥉";
    else medal = `${index + 1}.`;
    
    const categoryIcon = CATEGORY_ICONS[code.category] || "📦";
    
    // 🔒 Маскируем имя для VIP-кодов (для обычных юзеров)
    let displayName = code.name;
    if (!isAdminUser && code.isVip) {
      // Показываем только первые 3 буквы
      displayName = code.name.slice(0, 3) + "***";
    }
    
    text += `${medal} ${categoryIcon} <code>${escapeHtml(displayName)}</code> — <b>${code.uses}</b> активаций\n`;
  });
  
  if (!isAdminUser) {
    text += `\n<i>🔐 Некоторые коды скрыты из соображений безопасности.</i>`;
  }
  
  return sendMessage(chatId, text, { parse_mode: "HTML" });
}

/**
 * Профиль пользователя
 */
async function showProfile(chatId, userId) {
  const user = await getUser(userId);
  const userCodes = user.usedCodes || [];
  const badges = user.badges || [];
  const referrals = user.referrals || [];
  
  const badgesText = badges.length > 0 
    ? badges.map(bId => BADGES[bId]).filter(Boolean).map(b => `${b.emoji} ${b.name}`).join(", ")
    : "Нет бейджей";
  
  const text = 
    `👤 <b>Твой профиль</b>\n\n` +
    `🆔 <b>ID:</b> <code>${userId}</code>\n` +
    `📛 <b>Username:</b> ${user.username ? `@${escapeHtml(user.username)}` : "не указан"}\n` +
    `📅 <b>Регистрация:</b> ${user.createdAt ? smartDate(user.createdAt) : "—"}\n\n` +
    `📊 <b>Статистика:</b>\n` +
    `• Активаций: <b>${user.activations || 0}</b>\n` +
    `• Приглашено: <b>${referrals.length}</b>\n` +
    `• Бейджей: <b>${badges.length}</b>\n\n` +
    `🏅 <b>Бейджи:</b>\n${badgesText}`;
  
  const inline_keyboard = [
    [
      { text: "📋 Мои коды", callback_data: "my_codes" },
      { text: "🏅 Мои бейджи", callback_data: "my_badges" },
    ],
    [
      { text: "🔗 Пригласить друга", callback_data: "share_bot" },
      { text: "⬅️ Назад", callback_data: "home" },
    ],
  ];
  
  return sendMessage(chatId, text, { 
    parse_mode: "HTML", 
    reply_markup: { inline_keyboard } 
  });
}

/**
 * 🔥 НОВОЕ: показывает бейджи
 */
async function showBadges(chatId, userId) {
  const user = await getUser(userId);
  const userBadges = user.badges || [];
  
  let text = `🏅 <b>Мои бейджи (${userBadges.length}/${Object.keys(BADGES).length})</b>\n\n`;
  
  if (userBadges.length === 0) {
    text += `У тебя пока нет бейджей.\n\n`;
    text += `<b>Как получить бейджи:</b>\n`;
    text += `• Активируй промокоды\n`;
    text += `• Приглашай друзей\n`;
    text += `• Заходи в разное время суток\n`;
  } else {
    for (const badgeId of userBadges) {
      const badge = BADGES[badgeId];
      if (badge) {
        text += `${badge.emoji} <b>${badge.name}</b>\n`;
        text += `   <i>${badge.desc}</i>\n\n`;
      }
    }
  }
  
  // Показываем все доступные
  text += `\n<b>📚 Все бейджи:</b>\n`;
  for (const badge of Object.values(BADGES)) {
    const has = userBadges.includes(badge.id);
    text += `${has ? "✅" : "⬜"} ${badge.emoji} <b>${badge.name}</b> — <i>${badge.desc}</i>\n`;
  }
  
  return sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        { text: "⬅️ Назад", callback_data: "home" },
      ]],
    },
  });
}

/**
 * 🔥 НОВОЕ: кнопка "Пригласить друга"
 */
async function shareBot(chatId, userId) {
  const refLink = `https://t.me/${CONFIG.BOT_USERNAME}?start=ref_${userId}`;
  const user = await getUser(userId);
  const refCount = (user.referrals || []).length;
  
  const shareText = encodeURIComponent(
    `🎁 Крутой бот с промокодами! Забирай награды и приглашай друзей!\n\n${refLink}`
  );
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${shareText}`;
  
  const text = 
    `🔗 <b>Пригласи друга</b>\n\n` +
    `За каждого приглашённого ты получаешь бейджи!\n\n` +
    `<b>Твоя ссылка:</b>\n` +
    `<code>${refLink}</code>\n\n` +
    `👥 <b>Приглашено:</b> ${refCount}\n\n` +
    `<b>Награды за рефералов:</b>\n` +
    `• 1 друг — 🌱 Новичок\n` +
    `• 5 друзей — 👥 Реферрал-мастер\n` +
    `• 10 друзей — 🌳 Садовод`;
  
  const inline_keyboard = [
    [{ text: "📤 Поделиться", url: shareUrl }],
    [{ text: "⬅️ Назад", callback_data: "home" }],
  ];
  
  return sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard },
  });
}

/**
 * Статистика для юзера
 */
async function showUserStats(chatId) {
  const fullStats = await gatherFullStats();
  
  const text = 
    `📊 <b>Статистика бота</b>\n\n` +
    `🎁 <b>Промокодов:</b> ${fullStats.codes.total}\n` +
    `   └ активных: ${fullStats.codes.active}\n` +
    `   └ истёкших: ${fullStats.codes.expired}\n\n` +
    `👥 <b>Пользователей:</b> ${fullStats.users.total}\n` +
    `   └ активных за 24ч: ${fullStats.users.active24h}\n\n` +
    `🎉 <b>Всего активаций:</b> ${fullStats.activations.total}`;
  
  return sendMessage(chatId, text, { parse_mode: "HTML" });
}

// ============================================
// 16. АДМИН-ПАНЕЛЬ
// ============================================

/**
 * 🔥 НОВОЕ: админ-панель с кнопками
 */
async function sendAdminPanel(chatId, userId) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ Нет прав.", { parse_mode: "HTML" });
  }
  
  const stats = await gatherFullStats();
  
  const text = 
    `👑 <b>Админ-панель</b>\n\n` +
    `📦 Кодов: <b>${stats.codes.total}</b>\n` +
    `🟢 Активных: <b>${stats.codes.active}</b>\n` +
    `👥 Пользователей: <b>${stats.users.total}</b>\n` +
    `🎉 Активаций: <b>${stats.activations.total}</b>\n\n` +
    `Выбери раздел:`;

  const inline_keyboard = [
    [
      { text: "📋 Все коды", callback_data: "admin_all_all_0" },
      { text: "➕ Создать", callback_data: "admin_create_help" },
    ],
    [
      { text: "👥 Пользователи", callback_data: "admin_users_all_0" },
      { text: "📊 Статистика", callback_data: "admin_stats" },
    ],
    [
      { text: "📢 Рассылка", callback_data: "admin_broadcast_help" },
      { text: "📝 Логи", callback_data: "admin_logs" },
    ],
    [
      { text: "💾 Бэкапы", callback_data: "admin_backups" },
      { text: "📈 График", callback_data: "admin_chart" },
    ],
    [
      { text: "🏥 Health", callback_data: "admin_health" },
      { text: "⬅️ В меню", callback_data: "home" },
    ],
  ];

  return sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard } });
}

// ============================================
// 17. АДМИН-КОМАНДЫ
// ============================================

/**
 * /create - создание кода
 */
async function createCodeCommand(chatId, userId, args) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }

  // Rate limit на создание
  const rl = await checkRateLimit(userId, "create_code", CONFIG.CREATE_LIMIT_MAX, CONFIG.CREATE_LIMIT_WINDOW);
  if (!rl.allowed) {
    return sendMessage(
      chatId,
      `⏳ Слишком много запросов на создание кодов.\nПодожди минуту.`,
      { parse_mode: "HTML" }
    );
  }

  if (args.length < 2) {
    return sendMessage(
      chatId,
      `❌ <b>Неверный формат</b>\n\n` +
        `<b>Использование:</b>\n` +
        `<code>/create НАЗВАНИЕ ДАТА [КАТЕГОРИЯ]</code>\n\n` +
        `<b>Форматы даты:</b>\n` +
        `• <code>ДД.ММ.ГГГГ+ЧЧ:ММ</code>\n` +
        `• <code>+7d</code>, <code>+24h</code>, <code>+1w</code>\n\n` +
        `<b>Категории:</b> NEW, EVENT, VIP, SECRET, STANDARD\n\n` +
        `<b>Примеры:</b>\n` +
        `<code>/create SUMMER2026 10.02.2045+16:10</code>\n` +
        `<code>/create PROMO +7d EVENT</code>`,
      { parse_mode: "HTML" }
    );
  }

  const name = args[0].toUpperCase();
  const dateStr = args[1];
  const category = (args[2] || CODE_CATEGORIES.STANDARD).toUpperCase();
  const expiresAt = parseDate(dateStr);

  if (!expiresAt) {
    return sendMessage(
      chatId,
      `❌ <b>Неверный формат даты</b>`,
      { parse_mode: "HTML" }
    );
  }

  if (expiresAt <= Date.now()) {
    return sendMessage(chatId, `❌ <b>Дата уже прошла</b>`, { parse_mode: "HTML" });
  }
  
  if (!Object.values(CODE_CATEGORIES).includes(category)) {
    return sendMessage(
      chatId,
      `❌ Неверная категория.\nДоступные: ${Object.values(CODE_CATEGORIES).join(", ")}`,
      { parse_mode: "HTML" }
    );
  }

  const existing = await getCode(name);
  if (existing) {
    return sendMessage(
      chatId,
      `❌ Код <code>${escapeHtml(name)}</code> уже существует.`,
      { parse_mode: "HTML" }
    );
  }

  await createNewCode({
    name,
    expiresAt,
    createdBy: userId,
    category,
  });

  const categoryIcon = CATEGORY_ICONS[category] || "📦";

  return sendMessage(
    chatId,
    `✅ <b>Код создан</b>\n\n` +
      `${categoryIcon} <b>Название:</b> <code>${name}</code>\n` +
      `⏰ <b>Истекает:</b> ${formatDate(expiresAt)}\n` +
      `🏷️ <b>Категория:</b> ${category}\n` +
      `🔴 <b>Статус:</b> награда не привязана\n\n` +
      `Используй <code>/link ${name}</code>, чтобы привязать награду.`,
    { parse_mode: "HTML" }
  );
}

/**
 * /link - привязка награды
 */
async function linkCodeCommand(chatId, userId, codeName) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }

  if (!codeName) {
    return sendMessage(chatId, `❌ Укажи название кода.`, { parse_mode: "HTML" });
  }

  const name = codeName.toUpperCase();
  const code = await getCode(name);

  if (!code) {
    return sendMessage(
      chatId,
      `❌ Код <code>${escapeHtml(name)}</code> не найден.`,
      { parse_mode: "HTML" }
    );
  }

  await saveUser(userId, {
    state: "waiting_reward",
    pendingCodeName: name,
    stateExpiresAt: Date.now() + CONFIG.STATE_TIMEOUT,
  });

  code.status = CODE_STATUS.PENDING;
  await saveCode(name, code);

  return sendMessage(
    chatId,
    `🔗 <b>Настройка кода ${escapeHtml(name)}</b>\n\n` +
      `Отправь награду одним сообщением:\n` +
      `• Текст с HTML\n` +
      `• Фото/документ/видео с подписью\n\n` +
      `⏳ У тебя есть <b>10 минут</b>.`,
    { parse_mode: "HTML" }
  );
}

/**
 * /all - список кодов
 */
async function listAllCodesCommand(chatId, userId, filter = null, page = 0) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }

  await cleanupExpiredCodes();
  const names = await listCodeNames();

  if (names.length === 0) {
    return sendMessage(
      chatId,
      `📭 <b>Пока нет ни одного промокода</b>\n\n` +
        `Создай первый: <code>/create НАЗВАНИЕ ДАТА</code>`,
      { parse_mode: "HTML" }
    );
  }

  const codesData = [];
  for (const name of names) {
    const code = await getCode(name);
    if (!code) continue;
    codesData.push({ name, code, status: codeStatus(code) });
  }

  let filtered = codesData;
  if (filter === "active") filtered = codesData.filter(c => c.status.status === CODE_STATUS.ACTIVE);
  else if (filter === "pending") filtered = codesData.filter(c => c.status.status === CODE_STATUS.PENDING);
  else if (filter === "expired") filtered = codesData.filter(c => c.status.expired);
  else if (filter === "noreward") filtered = codesData.filter(c => c.status.status === CODE_STATUS.NO_REWARD);

  if (filtered.length === 0) {
    return sendMessage(chatId, `📭 Нет кодов с таким фильтром.`, { parse_mode: "HTML" });
  }

  filtered.sort((a, b) => {
    if (a.status.expired !== b.status.expired) return a.status.expired ? 1 : -1;
    const order = { active: 0, pending: 1, no_reward: 2, disabled: 3 };
    if (a.code.status !== b.code.status) {
      return (order[a.code.status] || 9) - (order[b.code.status] || 9);
    }
    return (b.code.createdAt || 0) - (a.code.createdAt || 0);
  });

  const startIndex = page * CONFIG.MAX_CODES_PER_PAGE;
  const endIndex = startIndex + CONFIG.MAX_CODES_PER_PAGE;
  const pageItems = filtered.slice(startIndex, endIndex);
  const totalPages = Math.ceil(filtered.length / CONFIG.MAX_CODES_PER_PAGE);

  let text = `📋 <b>Все промокоды</b> (${filtered.length})\n`;
  text += `📄 ${progressBar(page + 1, totalPages)} ${page + 1}/${totalPages}\n\n`;

  for (const { name, code, status } of pageItems) {
    const usedCount = (code.usedBy || []).length;
    const categoryIcon = CATEGORY_ICONS[code.category] || "📦";
    const limitStr = code.maxUses ? ` / ${code.maxUses}` : "";
    
    text += `${status.icon} ${categoryIcon}<code>${name}</code>\n`;
    text += `   └ ${status.label} • до ${formatDate(code.expiresAt)} • исп: ${usedCount}${limitStr}\n`;
  }

  const inline_keyboard = [];
  const navRow = [];
  
  if (page > 0) {
    navRow.push({ text: "⬅️ Назад", callback_data: `admin_all_${filter || "all"}_${page - 1}` });
  }
  
  if (page < totalPages - 1) {
    navRow.push({ text: "Вперёд ➡️", callback_data: `admin_all_${filter || "all"}_${page + 1}` });
  }
  
  if (navRow.length > 0) inline_keyboard.push(navRow);
  
  inline_keyboard.push([
    { text: "Все", callback_data: "admin_all_all_0" },
    { text: "🟢", callback_data: "admin_all_active_0" },
    { text: "🟠", callback_data: "admin_all_expired_0" },
  ]);

  return sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard },
  });
}

/**
 * /info - инфо о коде
 */
async function infoCodeCommand(chatId, userId, codeName) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }
  
  if (!codeName) {
    return sendMessage(chatId, `❌ Укажи название кода.`, { parse_mode: "HTML" });
  }

  const name = codeName.toUpperCase();
  const code = await getCode(name);
  
  if (!code) {
    return sendMessage(chatId, `❌ Код <code>${escapeHtml(name)}</code> не найден.`, { parse_mode: "HTML" });
  }

  const st = codeStatus(code);
  const usedBy = code.usedBy || [];
  const usedCount = usedBy.length;
  const categoryIcon = CATEGORY_ICONS[code.category] || "📦";

  let text = `📊 <b>Информация о коде</b>\n\n`;
  text += `${categoryIcon} <b>Название:</b> <code>${code.name}</code>\n`;
  text += `🏷️ <b>Категория:</b> ${code.category || "STANDARD"}\n`;
  text += `${st.icon} <b>Статус:</b> ${st.label}\n`;
  text += `⏰ <b>Создан:</b> ${smartDate(code.createdAt)}\n`;
  text += `⏳ <b>Истекает:</b> ${formatDate(code.expiresAt)}\n`;
  text += `👤 <b>Создал:</b> ${code.createdBy || "—"}\n`;
  text += `🎯 <b>Лимит:</b> ${code.maxUses ? code.maxUses + " активаций" : "без ограничений"}\n`;
  text += `🔥 <b>Использовали:</b> ${usedCount} чел.\n`;
  
  if (code.disabled) text += `⚫ <b>Код отключён</b>\n`;

  if (code.reward) {
    text += `\n<b>🎁 Награда:</b>\n${truncate(code.reward, 300)}\n`;
  }

  if (usedCount > 0) {
    text += `\n<b>📋 Последние активации:</b>\n`;
    const recent = usedBy.slice(-10).reverse();
    for (const u of recent) {
      const uname = escapeHtml(u.name);
      const time = u.activatedAt ? smartDate(u.activatedAt) : "—";
      text += `• ${uname} (${time})\n`;
    }
    if (usedCount > 10) {
      text += `<i>... и ещё ${usedCount - 10} человек</i>\n`;
    }
  }

  const reply_markup = {
    inline_keyboard: [
      [
        { text: "🔗 Изменить награду", callback_data: `admin_link_${name}` },
        { text: "⏰ Продлить", callback_data: `admin_extend_${name}` },
      ],
      [
        { text: "🔄 Сбросить", callback_data: `admin_reset_${name}` },
        { text: "📋 Копировать", callback_data: `admin_copy_${name}` },
      ],
      [
        { text: code.disabled ? "✅ Включить" : "⏸ Отключить", callback_data: `admin_toggle_${name}` },
        { text: "🗑 Удалить", callback_data: `admin_del_${name}` },
      ],
    ],
  };

  return sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup,
  });
}

/**
 * /extend
 */
async function extendCodeCommand(chatId, userId, args) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");
  
  if (args.length < 2) {
    return sendMessage(chatId, `❌ <code>/extend КОД ДАТА</code>`, { parse_mode: "HTML" });
  }

  const name = args[0].toUpperCase();
  const expiresAt = parseDate(args[1]);

  if (!expiresAt || expiresAt <= Date.now()) {
    return sendMessage(chatId, `❌ Неверный формат или дата прошла.`, { parse_mode: "HTML" });
  }
  
  const code = await getCode(name);
  if (!code) return sendMessage(chatId, `❌ Код не найден.`, { parse_mode: "HTML" });

  const oldExpiresAt = code.expiresAt;
  code.expiresAt = expiresAt;
  await saveCode(name, code);
  await logAction("code_extended", { userId: String(userId), extra: name });

  return sendMessage(
    chatId,
    `✅ <b>Продлено!</b>\n\n` +
      `🔖 <code>${name}</code>\n` +
      `⏰ Было: ${formatDate(oldExpiresAt)}\n` +
      `⏰ Стало: ${formatDate(expiresAt)}`,
    { parse_mode: "HTML" }
  );
}

/**
 * /delete с подтверждением
 */
async function deleteCodeCommand(chatId, userId, codeName, confirmed = false) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");
  
  if (!codeName) return sendMessage(chatId, `❌ Укажи код.`, { parse_mode: "HTML" });

  const name = codeName.toUpperCase();
  const code = await getCode(name);
  
  if (!code) return sendMessage(chatId, `❌ Код <code>${name}</code> не найден.`, { parse_mode: "HTML" });

  // Двухшаговое подтверждение
  if (!confirmed) {
    const usedCount = (code.usedBy || []).length;
    return sendMessage(
      chatId,
      `⚠️ <b>Подтверди удаление</b>\n\n` +
        `Код: <code>${name}</code>\n` +
        `Использован: ${usedCount} раз\n\n` +
        `Действие необратимо!`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "🗑 Да, удалить", callback_data: `admin_del_confirm_${name}` },
            { text: "❌ Отмена", callback_data: "cancel_action" },
          ]],
        },
      }
    );
  }

  await deleteCode(name);
  await logAction("code_deleted", { userId: String(userId), extra: name });

  return sendMessage(chatId, `🗑 <b>Код удалён</b>\n\n<code>${escapeHtml(name)}</code>`, { parse_mode: "HTML" });
}

/**
 * /reset - сброс использований
 */
async function resetCodeCommand(chatId, userId, codeName, confirmed = false) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");
  
  if (!codeName) return sendMessage(chatId, `❌ Укажи код.`, { parse_mode: "HTML" });

  const name = codeName.toUpperCase();
  const code = await getCode(name);
  
  if (!code) return sendMessage(chatId, `❌ Код не найден.`, { parse_mode: "HTML" });

  if (!confirmed) {
    const usedCount = (code.usedBy || []).length;
    return sendMessage(
      chatId,
      `⚠️ <b>Подтверди сброс</b>\n\n` +
        `Код: <code>${name}</code>\n` +
        `Будет сброшено активаций: ${usedCount}\n\n` +
        `Также код будет убран из профилей всех пользователей.`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "🔄 Да, сбросить", callback_data: `admin_reset_confirm_${name}` },
            { text: "❌ Отмена", callback_data: "cancel_action" },
          ]],
        },
      }
    );
  }

  const oldUsedCount = (code.usedBy || []).length;
  
  code.usedBy = [];
  await saveCode(name, code);
  
  const allUsers = await getAllUsers();
  let usersCleared = 0;
  
  for (const uid of allUsers) {
    const user = await getUser(uid);
    if (!user.usedCodes || user.usedCodes.length === 0) continue;
    
    const beforeLength = user.usedCodes.length;
    user.usedCodes = user.usedCodes.filter(item => {
      const itemName = typeof item === "string" ? item : item.name;
      return itemName.toUpperCase() !== name;
    });
    
    if (user.usedCodes.length < beforeLength) {
      await saveUser(uid, { usedCodes: user.usedCodes });
      usersCleared++;
    }
  }
  
  await logAction("code_reset", { userId: String(userId), extra: `${name} (${oldUsedCount} → 0)` });

  return sendMessage(
    chatId,
    `🔄 <b>Сброшено!</b>\n\n` +
      `Код <code>${name}</code> можно активировать снова.\n` +
      `• Активаций сброшено: ${oldUsedCount}\n` +
      `• Пользователей обновлено: ${usersCleared}`,
    { parse_mode: "HTML" }
  );
}

/**
 * /resetuser
 */
async function resetUserCommand(chatId, userId, targetId) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");
  
  if (!targetId || !isNumeric(targetId)) {
    return sendMessage(chatId, `❌ Укажи корректный ID.`, { parse_mode: "HTML" });
  }

  const target = await getUser(targetId);
  if (!target || !target.createdAt) {
    return sendMessage(chatId, `❌ Пользователь не найден.`, { parse_mode: "HTML" });
  }

  const oldCodes = target.usedCodes || [];
  await saveUser(targetId, { usedCodes: [], activations: 0 });
  await logAction("user_reset", { userId: String(userId), extra: targetId });

  return sendMessage(
    chatId,
    `🔄 <b>Сброшено!</b>\n\nID: <code>${targetId}</code>\nУбрано кодов: ${oldCodes.length}`,
    { parse_mode: "HTML" }
  );
}

/**
 * /copy
 */
async function copyCodeCommand(chatId, userId, args) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");
  
  if (args.length < 3) {
    return sendMessage(chatId, `❌ <code>/copy СТАРЫЙ НОВЫЙ ДАТА</code>`, { parse_mode: "HTML" });
  }

  const oldName = args[0].toUpperCase();
  const newName = args[1].toUpperCase();
  const expiresAt = parseDate(args[2]);

  if (!expiresAt) return sendMessage(chatId, `❌ Неверная дата.`, { parse_mode: "HTML" });
  if (expiresAt <= Date.now()) return sendMessage(chatId, `❌ Дата прошла.`, { parse_mode: "HTML" });
  
  const oldCode = await getCode(oldName);
  if (!oldCode) return sendMessage(chatId, `❌ Код <code>${oldName}</code> не найден.`, { parse_mode: "HTML" });
  
  if (await getCode(newName)) return sendMessage(chatId, `❌ Код <code>${newName}</code> уже существует.`, { parse_mode: "HTML" });

  const newCode = {
    ...oldCode,
    name: newName,
    createdAt: Date.now(),
    expiresAt,
    usedBy: [],
    createdBy: String(userId),
    copiedFrom: oldName,
  };
  
  await saveCode(newName, newCode);
  await logAction("code_copied", { userId: String(userId), extra: `${oldName} → ${newName}` });

  return sendMessage(
    chatId,
    `✅ <b>Скопировано!</b>\n\n` +
      `Из: <code>${oldName}</code>\n` +
      `В: <code>${newName}</code>\n` +
      `⏰ Истекает: ${formatDate(expiresAt)}`,
    { parse_mode: "HTML" }
  );
}

/**
 * /rename
 */
async function renameCodeCommand(chatId, userId, args) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");
  
  if (args.length < 2) return sendMessage(chatId, `❌ <code>/rename СТАРЫЙ НОВЫЙ</code>`, { parse_mode: "HTML" });

  const oldName = args[0].toUpperCase();
  const newName = args[1].toUpperCase();

  if (oldName === newName) return sendMessage(chatId, `❌ Имена совпадают.`, { parse_mode: "HTML" });
  
  const oldCode = await getCode(oldName);
  if (!oldCode) return sendMessage(chatId, `❌ Код не найден.`, { parse_mode: "HTML" });
  
  if (await getCode(newName)) return sendMessage(chatId, `❌ Код <code>${newName}</code> уже есть.`, { parse_mode: "HTML" });

  oldCode.name = newName;
  await saveCode(newName, oldCode);
  
  const allUsers = await getAllUsers();
  let updatedUsers = 0;
  for (const uid of allUsers) {
    const user = await getUser(uid);
    if (!user.usedCodes) continue;
    
    let changed = false;
    user.usedCodes = user.usedCodes.map(item => {
      if (typeof item === "string" && item.toUpperCase() === oldName) {
        changed = true;
        return newName;
      }
      if (typeof item === "object" && item.name && item.name.toUpperCase() === oldName) {
        changed = true;
        return { ...item, name: newName };
      }
      return item;
    });
    
    if (changed) {
      await saveUser(uid, { usedCodes: user.usedCodes });
      updatedUsers++;
    }
  }
  
  await deleteCode(oldName);
  await logAction("code_renamed", { userId: String(userId), extra: `${oldName} → ${newName}` });

  return sendMessage(
    chatId,
    `✅ <b>Переименовано!</b>\n\nБыло: <code>${oldName}</code>\nСтало: <code>${newName}</code>\nОбновлено: ${updatedUsers}`,
    { parse_mode: "HTML" }
  );
}

/**
 * /reward
 */
async function rewardCodeCommand(chatId, userId, codeName) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");
  
  if (!codeName) return sendMessage(chatId, `❌ Укажи код.`, { parse_mode: "HTML" });

  const name = codeName.toUpperCase();
  const code = await getCode(name);
  
  if (!code) return sendMessage(chatId, `❌ Код не найден.`, { parse_mode: "HTML" });

  await saveUser(userId, {
    state: "updating_reward",
    pendingCodeName: name,
    stateExpiresAt: Date.now() + CONFIG.STATE_TIMEOUT,
  });

  const currentReward = code.reward || "(не установлена)";

  return sendMessage(
    chatId,
    `🎁 <b>Изменение награды</b>\n\n` +
      `Код: <code>${name}</code>\n` +
      `Текущая: <code>${truncate(currentReward, 200)}</code>\n\n` +
      `Отправь новую награду.`,
    { parse_mode: "HTML" }
  );
}

/**
 * /setlimit
 */
async function setLimitCommand(chatId, userId, args) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");
  
  if (args.length < 2) return sendMessage(chatId, `❌ <code>/setlimit КОД N</code>`, { parse_mode: "HTML" });

  const name = args[0].toUpperCase();
  const limit = safeParseInt(args[1]);

  if (limit === null || limit < 0) return sendMessage(chatId, `❌ Лимит >= 0.`, { parse_mode: "HTML" });
  
  const code = await getCode(name);
  if (!code) return sendMessage(chatId, `❌ Код не найден.`, { parse_mode: "HTML" });

  const oldLimit = code.maxUses || 0;
  code.maxUses = limit;
  await saveCode(name, code);

  return sendMessage(
    chatId,
    `✅ <b>Лимит изменён</b>\n\n` +
      `Было: ${oldLimit === 0 ? "∞" : oldLimit}\n` +
      `Стало: ${limit === 0 ? "∞" : limit}`,
    { parse_mode: "HTML" }
  );
}

/**
 * /activate
 */
async function activateForUserCommand(chatId, userId, args) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");
  
  if (args.length < 2) return sendMessage(chatId, `❌ <code>/activate КОД USER_ID</code>`, { parse_mode: "HTML" });

  const name = args[0].toUpperCase();
  const targetId = args[1];

  if (!isNumeric(targetId)) return sendMessage(chatId, `❌ ID должен быть числом.`, { parse_mode: "HTML" });

  const code = await getCode(name);
  if (!code) return sendMessage(chatId, `❌ Код не найден.`, { parse_mode: "HTML" });

  const user = await getUser(targetId);
  
  const alreadyUsed = (user.usedCodes || []).some(item => {
    const codeName = typeof item === "string" ? item : item.name;
    return codeName.toUpperCase() === name;
  });
  
  if (alreadyUsed) return sendMessage(chatId, `⚠️ Уже активирован.`, { parse_mode: "HTML" });

  user.usedCodes = [...(user.usedCodes || []), {
    name: name,
    activatedAt: Date.now(),
    category: code.category,
  }];
  user.activations = (user.activations || 0) + 1;
  await saveUser(targetId, { usedCodes: user.usedCodes, activations: user.activations });

  const usedBy = code.usedBy || [];
  usedBy.push({ 
    id: String(targetId), 
    name: user.username ? `@${user.username}` : String(targetId),
    activatedAt: Date.now(),
    byAdmin: true,
  });
  code.usedBy = usedBy;
  await saveCode(name, code);
  
  await logAction("admin_activation", { userId: String(userId), extra: `${name} → ${targetId}` });

  if (code.reward) {
    try {
      await sendMessage(
        targetId,
        `🎁 <b>Тебе начислена награда от администратора!</b>\n\n` +
          `Промокод: <code>${name}</code>\n\n${code.reward}`,
        { parse_mode: "HTML" }
      );
    } catch (e) {}
  }

  await checkActivationBadges(targetId, user.activations);

  return sendMessage(
    chatId,
    `✅ <b>Активация выполнена</b>\n\nКод: <code>${name}</code>\nЮзер: <code>${targetId}</code>`,
    { parse_mode: "HTML" }
  );
}

/**
 * /ban
 */
async function banUserCommand(chatId, userId, args) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");
  
  if (args.length < 1) return sendMessage(chatId, `❌ <code>/ban USER_ID [ПРИЧИНА]</code>`, { parse_mode: "HTML" });

  const targetId = args[0];
  const reason = args.slice(1).join(" ") || "—";

  if (!isNumeric(targetId)) return sendMessage(chatId, `❌ ID должен быть числом.`, { parse_mode: "HTML" });
  if (isAdmin(targetId)) return sendMessage(chatId, `❌ Нельзя забанить админа.`, { parse_mode: "HTML" });

  await banUser(targetId, reason);

  return sendMessage(
    chatId,
    `⛔ <b>Забанен</b>\n\nID: <code>${targetId}</code>\nПричина: ${escapeHtml(reason)}`,
    { parse_mode: "HTML" }
  );
}

/**
 * /unban
 */
async function unbanUserCommand(chatId, userId, targetId) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");
  
  if (!targetId || !isNumeric(targetId)) {
    return sendMessage(chatId, `❌ Укажи корректный ID.`, { parse_mode: "HTML" });
  }

  await unbanUser(targetId);

  return sendMessage(chatId, `✅ <b>Разбанен</b>\n\nID: <code>${targetId}</code>`, { parse_mode: "HTML" });
}

/**
 * /mute
 */
async function muteUserCommand(chatId, userId, args) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");
  
  if (args.length < 1) return sendMessage(chatId, `❌ <code>/mute USER_ID [ЧАСЫ]</code>`, { parse_mode: "HTML" });

  const targetId = args[0];
  const hours = args[1] ? safeParseInt(args[1]) : 0;

  if (!isNumeric(targetId)) return sendMessage(chatId, `❌ ID должен быть числом.`, { parse_mode: "HTML" });
  if (isAdmin(targetId)) return sendMessage(chatId, `❌ Нельзя замутить админа.`, { parse_mode: "HTML" });

  const durationMs = hours > 0 ? hours * 60 * 60 * 1000 : 0;
  await muteUser(targetId, durationMs);

  const durationStr = hours > 0 ? `${hours} ч.` : "бессрочно";

  return sendMessage(
    chatId,
    `🔇 <b>Замучен</b>\n\nID: <code>${targetId}</code>\nДлительность: ${durationStr}`,
    { parse_mode: "HTML" }
  );
}

/**
 * /unmute
 */
async function unmuteUserCommand(chatId, userId, targetId) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");
  
  if (!targetId || !isNumeric(targetId)) {
    return sendMessage(chatId, `❌ Укажи корректный ID.`, { parse_mode: "HTML" });
  }

  await unmuteUser(targetId);

  return sendMessage(chatId, `🔊 <b>Размучен</b>\n\nID: <code>${targetId}</code>`, { parse_mode: "HTML" });
}

/**
 * /users
 */
async function listUsersCommand(chatId, userId, page = 0, filter = null) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");

  const allUsers = await getAllUsers();
  
  const usersData = [];
  for (const uid of allUsers) {
    const user = await getUser(uid);
    if (user && user.createdAt) usersData.push(user);
  }
  
  let filtered = usersData;
  if (filter === "banned") filtered = usersData.filter(u => u.banned);
  else if (filter === "muted") filtered = usersData.filter(u => u.muted);
  else if (filter === "active") {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    filtered = usersData.filter(u => u.lastSeen && u.lastSeen > dayAgo);
  }
  
  filtered.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

  if (filtered.length === 0) {
    return sendMessage(chatId, "📭 Нет пользователей.", { parse_mode: "HTML" });
  }

  const totalPages = Math.ceil(filtered.length / CONFIG.MAX_USERS_PER_PAGE);
  const startIndex = page * CONFIG.MAX_USERS_PER_PAGE;
  const endIndex = startIndex + CONFIG.MAX_USERS_PER_PAGE;
  const pageItems = filtered.slice(startIndex, endIndex);

  let text = `👥 <b>Пользователи (${filtered.length})</b>\n`;
  text += `📄 ${progressBar(page + 1, totalPages)} ${page + 1}/${totalPages}\n\n`;

  for (const user of pageItems) {
    const name = user.username ? `@${escapeHtml(user.username)}` : `ID <code>${user.userId}</code>`;
    const activations = user.activations || 0;
    const lastSeen = user.lastSeen ? smartDate(user.lastSeen) : "—";
    let flags = "";
    if (user.banned) flags += "⛔";
    if (user.muted) flags += "🔇";
    
    text += `${flags} ${name}\n`;
    text += `   └ активаций: ${activations} • был: ${lastSeen}\n`;
  }

  const inline_keyboard = [];
  const navRow = [];
  
  if (page > 0) navRow.push({ text: "⬅️", callback_data: `admin_users_${filter || "all"}_${page - 1}` });
  if (page < totalPages - 1) navRow.push({ text: "➡️", callback_data: `admin_users_${filter || "all"}_${page + 1}` });
  
  if (navRow.length > 0) inline_keyboard.push(navRow);
  
  inline_keyboard.push([
    { text: "Все", callback_data: "admin_users_all_0" },
    { text: "⛔", callback_data: "admin_users_banned_0" },
    { text: "🟢", callback_data: "admin_users_active_0" },
  ]);

  return sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard },
  });
}

/**
 * /whois
 */
async function whoisCommand(chatId, userId, targetId) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");
  
  if (!targetId || !isNumeric(targetId)) {
    return sendMessage(chatId, `❌ Укажи корректный ID.`, { parse_mode: "HTML" });
  }

  const user = await getUser(targetId);
  
  if (!user || !user.createdAt) {
    return sendMessage(chatId, `❌ Пользователь <code>${targetId}</code> не найден.`, { parse_mode: "HTML" });
  }

  const name = user.username ? `@${escapeHtml(user.username)}` : "не указан";
  const banned = user.banned ? `⛔ Да (${escapeHtml(user.banReason || "—")})` : "Нет";
  const muted = user.muted ? `🔇 До ${formatDate(user.mutedUntil)}` : "Нет";
  const badges = (user.badges || []).map(b => BADGES[b]).filter(Boolean);
  const badgesText = badges.length > 0 ? badges.map(b => `${b.emoji} ${b.name}`).join(", ") : "Нет";
  
  let codesList = "Пусто";
  if (user.usedCodes && user.usedCodes.length > 0) {
    codesList = user.usedCodes.slice(-10).map(item => {
      const codeName = typeof item === "string" ? item : item.name;
      return `<code>${escapeHtml(codeName)}</code>`;
    }).join(", ");
    
    if (user.usedCodes.length > 10) {
      codesList += ` <i>(и ещё ${user.usedCodes.length - 10})</i>`;
    }
  }

  const text = 
    `👤 <b>Информация о пользователе</b>\n\n` +
    `🆔 <b>ID:</b> <code>${user.userId}</code>\n` +
    `📛 <b>Username:</b> ${name}\n` +
    `📅 <b>Регистрация:</b> ${smartDate(user.createdAt)}\n` +
    `👁 <b>Последний визит:</b> ${user.lastSeen ? smartDate(user.lastSeen) : "—"}\n` +
    `⛔ <b>Забанен:</b> ${banned}\n` +
    `🔇 <b>Замучен:</b> ${muted}\n` +
    `🎯 <b>Активаций:</b> ${user.activations || 0}\n` +
    `🏅 <b>Бейджи:</b> ${badgesText}\n` +
    `🔗 <b>Рефералов:</b> ${(user.referrals || []).length}\n\n` +
    `📋 <b>Коды (${user.usedCodes?.length || 0}):</b>\n${codesList}`;

  const inline_keyboard = [
    [
      { text: "⛔ Бан", callback_data: `admin_ban_${targetId}` },
      { text: "🔇 Мут", callback_data: `admin_mute_${targetId}` },
    ],
    [
      { text: "🔄 Сброс", callback_data: `admin_resetuser_${targetId}` },
      { text: "🎁 Активировать", callback_data: `admin_activate_${targetId}` },
    ],
  ];

  return sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard },
  });
}

/**
 * /broadcast
 */
async function broadcastCommand(chatId, userId, text, confirmed = false) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");
  
  if (!text) {
    return sendMessage(
      chatId,
      `❌ <code>/broadcast ТЕКСТ</code>`,
      { parse_mode: "HTML" }
    );
  }

  if (!confirmed) {
    const users = await getAllUsers();
    return sendMessage(
      chatId,
      `⚠️ <b>Подтверди рассылку</b>\n\n` +
        `Получателей: ${users.length}\n\n` +
        `Текст:\n${truncate(text, 200)}`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "📢 Да, отправить", callback_data: `admin_bc_confirm` },
            { text: "❌ Отмена", callback_data: "cancel_action" },
          ]],
        },
      }
    );
  }

  const users = await getAllUsers();
  if (users.length === 0) return sendMessage(chatId, "❌ Нет пользователей.", { parse_mode: "HTML" });
  
  if (users.length > CONFIG.MAX_BROADCAST_USERS) {
    return sendMessage(chatId, `⚠️ Слишком много: ${users.length}`, { parse_mode: "HTML" });
  }

  const startMsg = await sendMessage(
    chatId,
    `⏳ <b>Рассылка...</b>\n\nПолучателей: ${users.length}`,
    { parse_mode: "HTML" }
  );

  let success = 0;
  let failed = 0;

  for (let i = 0; i < users.length; i++) {
    const uid = users[i];
    const res = await sendMessage(
      uid,
      `📢 <b>Сообщение от администрации:</b>\n\n${text}`,
      { parse_mode: "HTML" }
    );
    
    if (res.ok) success++;
    else failed++;
    
    if (i > 0 && i % 50 === 0 && startMsg.result?.message_id) {
      await editMessage(
        chatId,
        startMsg.result.message_id,
        `⏳ <b>Рассылка...</b>\n\n` +
          `${progressBar(i, users.length, 20)} ${Math.floor(i/users.length*100)}%\n` +
          `✅ ${success} | ❌ ${failed}`,
        { parse_mode: "HTML" }
      );
    }
    
    await new Promise(r => setTimeout(r, CONFIG.BROADCAST_DELAY));
  }
  
  await incrementStat("broadcasts_sent", 1);
  await logAction("broadcast", { userId: String(userId), extra: `${success}/${users.length}` });

  const finalText = 
    `✅ <b>Рассылка завершена!</b>\n\n` +
    `• Всего: ${users.length}\n` +
    `• Доставлено: ${success}\n` +
    `• Ошибок: ${failed}\n` +
    `• % успеха: ${Math.floor(success/users.length*100)}%`;

  if (startMsg.result?.message_id) {
    return editMessage(chatId, startMsg.result.message_id, finalText, { parse_mode: "HTML" });
  }
  
  return sendMessage(chatId, finalText, { parse_mode: "HTML" });
}

/**
 * /announce
 */
async function announceCommand(chatId, userId, text) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");
  
  if (!text) return sendMessage(chatId, `❌ Укажи текст.`, { parse_mode: "HTML" });

  await saveUser(userId, {
    state: "confirming_announce",
    pendingAnnouncement: text,
    stateExpiresAt: Date.now() + CONFIG.STATE_TIMEOUT,
  });

  const users = await getAllUsers();

  return sendMessage(
    chatId,
    `📢 <b>Подтверждение объявления</b>\n\n` +
      `Текст:\n${text}\n\n` +
      `Будет отправлено ${users.length} пользователям с кнопкой "ОК".`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Отправить", callback_data: "confirm_announce" },
          { text: "❌ Отмена", callback_data: "cancel_announce" },
        ]],
      },
    }
  );
}

/**
 * /schedule
 */
async function scheduleCommand(chatId, userId, args) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");
  
  if (args.length < 2) return sendMessage(chatId, `❌ <code>/schedule ДАТА ТЕКСТ</code>`, { parse_mode: "HTML" });

  const dateStr = args[0];
  const text = args.slice(1).join(" ");
  const timestamp = parseDate(dateStr);

  if (!timestamp) return sendMessage(chatId, `❌ Неверная дата.`, { parse_mode: "HTML" });
  if (timestamp <= Date.now()) return sendMessage(chatId, `❌ Дата должна быть в будущем.`, { parse_mode: "HTML" });

  const scheduleId = generateId();
  const schedules = (await kv.get(KV_PREFIXES.SCHEDULES)) || [];
  
  schedules.push({
    id: scheduleId,
    scheduledAt: timestamp,
    text,
    createdBy: String(userId),
    createdAt: Date.now(),
  });
  
  await kv.set(KV_PREFIXES.SCHEDULES, schedules);
  await logAction("scheduled", { userId: String(userId), extra: scheduleId });

  return sendMessage(
    chatId,
    `⏰ <b>Запланировано!</b>\n\n` +
      `ID: <code>${scheduleId}</code>\n` +
      `Дата: ${formatDate(timestamp)}`,
    { parse_mode: "HTML" }
  );
}

/**
 * /logs
 */
async function logsCommand(chatId, userId, limit = 30) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");

  const logs = await getLogs(limit);

  if (logs.length === 0) return sendMessage(chatId, "📭 Лог пуст.", { parse_mode: "HTML" });

  let text = `📝 <b>Последние действия (${logs.length})</b>\n\n`;
  for (const entry of logs) text += formatLogEntry(entry) + "\n";

  return sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        { text: "🗑 Очистить лог", callback_data: "admin_clearlogs" },
      ]],
    },
  });
}

/**
 * /clearlogs
 */
async function clearLogsCommand(chatId, userId) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");
  await clearLogs();
  return sendMessage(chatId, `✅ Лог очищен.`, { parse_mode: "HTML" });
}

/**
 * /backup
 */
async function backupCommand(chatId, userId) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");

  await sendChatAction(chatId, "typing");
  
  try {
    const backupId = await createBackup(userId);
    return sendMessage(
      chatId,
      `💾 <b>Бэкап создан!</b>\n\nID: <code>${backupId}</code>\nВремя: ${smartDate(Date.now())}`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    return sendMessage(chatId, `❌ ${e.message}`, { parse_mode: "HTML" });
  }
}

/**
 * /backups
 */
async function backupsListCommand(chatId, userId) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");

  const backups = await listBackups();

  if (backups.length === 0) {
    return sendMessage(chatId, `📭 Нет бэкапов.`, { parse_mode: "HTML" });
  }

  let text = `💾 <b>Бэкапы (${backups.length})</b>\n\n`;
  
  for (const b of backups) {
    text += `📦 <code>${b.id}</code>\n`;
    text += `   └ ${smartDate(b.createdAt)} • ${b.codesCount} кодов • ${b.usersCount} юзеров\n\n`;
  }

  return sendMessage(chatId, text, { parse_mode: "HTML" });
}

/**
 * /restore
 */
async function restoreCommand(chatId, userId, backupId, mode = "replace") {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");
  
  if (!backupId) return sendMessage(chatId, `❌ Укажи ID бэкапа.`, { parse_mode: "HTML" });

  await sendChatAction(chatId, "typing");
  
  try {
    const result = await restoreBackup(backupId, mode);
    return sendMessage(
      chatId,
      `✅ <b>Восстановлено!</b>\n\n` +
        `Режим: ${mode}\n` +
        `Удалено кодов: ${result.codesDeleted}\n` +
        `Кодов: ${result.codesRestored}\n` +
        `Пользователей: ${result.usersRestored}`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    return sendMessage(chatId, `❌ ${e.message}`, { parse_mode: "HTML" });
  }
}

/**
 * /export
 */
async function exportCommand(chatId, userId) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");

  await sendChatAction(chatId, "typing");
  
  try {
    const json = await exportCodes();
    
    if (json.length > CONFIG.MAX_MESSAGE_LENGTH) {
      return sendMessage(
        chatId,
        `📦 <b>Экспорт кодов</b>\n\nРазмер: ${json.length} символов — слишком большой.\n\nИспользуй /backup.`,
        { parse_mode: "HTML" }
      );
    }
    
    return sendMessage(
      chatId,
      `📦 <b>Экспорт кодов</b>\n\n<pre><code>${escapeHtml(json)}</code></pre>`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    return sendMessage(chatId, `❌ ${e.message}`, { parse_mode: "HTML" });
  }
}

/**
 * 🔥 НОВОЕ: /exportcsv
 */
async function exportCsvCommand(chatId, userId) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");

  await sendChatAction(chatId, "typing");
  
  try {
    const csv = await exportUsersCSV();
    
    if (csv.length > CONFIG.MAX_MESSAGE_LENGTH) {
      // Показываем первые 200 строк
      const lines = csv.split("\n");
      const preview = lines.slice(0, 200).join("\n");
      return sendMessage(
        chatId,
        `📊 <b>CSV экспорт (первые 200 из ${lines.length} строк)</b>\n\n<pre><code>${escapeHtml(preview)}</code></pre>`,
        { parse_mode: "HTML" }
      );
    }
    
    return sendMessage(
      chatId,
      `📊 <b>CSV экспорт</b>\n\n<pre><code>${escapeHtml(csv)}</code></pre>`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    return sendMessage(chatId, `❌ ${e.message}`, { parse_mode: "HTML" });
  }
}

/**
 * /import
 */
async function importCommand(chatId, userId, jsonData) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");
  
  if (!jsonData) return sendMessage(chatId, `❌ Укажи JSON.`, { parse_mode: "HTML" });

  await sendChatAction(chatId, "typing");
  
  try {
    const result = await importCodes(jsonData, "merge");
    return sendMessage(
      chatId,
      `✅ <b>Импорт завершён!</b>\n\nИмпортировано: ${result.imported}\nПропущено: ${result.skipped}`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    return sendMessage(chatId, `❌ ${e.message}`, { parse_mode: "HTML" });
  }
}

/**
 * /ping
 */
async function pingCommand(chatId, userId) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");

  const start = Date.now();
  const result = await telegram("getMe");
  const latency = Date.now() - start;

  if (result.ok) {
    return sendMessage(
      chatId,
      `🏓 <b>Pong!</b>\n\nЗадержка: <b>${latency}ms</b>\nБот: @${result.result.username}`,
      { parse_mode: "HTML" }
    );
  } else {
    return sendMessage(chatId, `❌ ${result.description}`, { parse_mode: "HTML" });
  }
}

/**
 * /health
 */
async function healthCommand(chatId, userId) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");

  await sendChatAction(chatId, "typing");
  
  const start = Date.now();
  const tgResult = await telegram("getMe");
  const latency = Date.now() - start;

  const kvStart = Date.now();
  try {
    await kv.get("gs:health_check");
    await kv.set("gs:health_check", Date.now());
  } catch (e) {}
  const kvLatency = Date.now() - kvStart;

  const fullStats = await gatherFullStats();

  const text = 
    `🏥 <b>Статус системы</b>\n\n` +
    `<b>Сервисы:</b>\n` +
    `${tgResult.ok ? "✅" : "❌"} Telegram API: ${latency}ms\n` +
    `✅ Vercel KV: ${kvLatency}ms\n\n` +
    `<b>Статистика:</b>\n` +
    `• Кодов: ${fullStats.codes.total} (${fullStats.codes.active} активных)\n` +
    `• Пользователей: ${fullStats.users.total}\n` +
    `• Активаций: ${fullStats.activations.total}\n` +
    `• Забанено: ${fullStats.users.banned}\n` +
    `• Замучено: ${fullStats.users.muted}\n\n` +
    `<b>Время:</b> ${formatDate(Date.now(), true)}`;

  return sendMessage(chatId, text, { parse_mode: "HTML" });
}

/**
 * /stats (полная для админа)
 */
async function fullStatsCommand(chatId, userId) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");

  await sendChatAction(chatId, "typing");
  
  const stats = await gatherFullStats();

  const text = 
    `📊 <b>Полная статистика</b>\n\n` +
    `🎁 <b>Промокоды (${stats.codes.total}):</b>\n` +
    `• 🟢 Активных: ${stats.codes.active}\n` +
    `• 🟡 В процессе: ${stats.codes.pending}\n` +
    `• 🔴 Без награды: ${stats.codes.noReward}\n` +
    `• 🟠 Истёкших: ${stats.codes.expired}\n\n` +
    `👥 <b>Пользователи (${stats.users.total}):</b>\n` +
    `• 🟢 Активных за 24ч: ${stats.users.active24h}\n` +
    `• ⛔ Забанено: ${stats.users.banned}\n` +
    `• 🔇 Замучено: ${stats.users.muted}\n\n` +
    `🎉 <b>Активации:</b> ${stats.activations.total}\n` +
    `📢 <b>Рассылок:</b> ${stats.broadcasts.total}\n` +
    `📝 <b>Записей в логе:</b> ${stats.logs}`;

  return sendMessage(chatId, text, { parse_mode: "HTML" });
}

/**
 * 🔥 НОВОЕ: /chart - график активаций за 7 дней
 */
async function chartCommand(chatId, userId) {
  if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");

  await sendChatAction(chatId, "typing");
  
  const dailyStats = (await kv.get(KV_PREFIXES.DAILY_STATS)) || {};
  
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const ts = Date.now() - i * 86400000;
    const key = getDateKey(ts);
    days.push({
      date: key,
      shortDate: key.slice(5),
      count: dailyStats[key]?.activations || 0,
    });
  }
  
  const max = Math.max(...days.map(d => d.count), 1);
  const total = days.reduce((sum, d) => sum + d.count, 0);
  const avg = (total / 7).toFixed(1);
  
  let chart = `📈 <b>Активации за 7 дней</b>\n\n`;
  
  for (const d of days) {
    const barLen = Math.round((d.count / max) * 20);
    const bar = "█".repeat(barLen) + "░".repeat(20 - barLen);
    chart += `<code>${d.shortDate}</code> ${bar} <b>${d.count}</b>\n`;
  }
  
  chart += `\n📊 <b>Итого:</b> ${total}\n`;
  chart += `📊 <b>Среднее:</b> ${avg}/день\n`;
  chart += `📊 <b>Максимум:</b> ${max}`;
  
  return sendMessage(chatId, chart, { parse_mode: "HTML" });
}

// ============================================
// 18. ОБРАБОТКА CALLBACK
// ============================================

async function handleCallback(callback) {
  const chatId = callback.message.chat.id;
  const userId = callback.from.id;
  const data = callback.data;
  const messageId = callback.message.message_id;

  await answerCallback(callback.id);

  // ========== УНИВЕРСАЛЬНЫЕ ==========
  if (data === "home") {
    return sendStart(chatId, userId, callback.from.username);
  }
  
  if (data === "cancel_action") {
    return editMessage(chatId, messageId, "❌ Действие отменено.", { parse_mode: "HTML" });
  }

  // ========== АДМИНСКИЕ ==========
  if (data === "admin_panel") {
    if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Нет прав.");
    return sendAdminPanel(chatId, userId);
  }

  if (data.startsWith("admin_")) {
    if (!isAdmin(userId)) {
      return sendMessage(chatId, "⛔ Нет прав.", { parse_mode: "HTML" });
    }

    // Пагинация /all
    const allMatch = data.match(/^admin_all_(\w+)_(\d+)$/);
    if (allMatch) {
      const filter = allMatch[1] === "all" ? null : allMatch[1];
      const page = parseInt(allMatch[2], 10);
      return listAllCodesCommand(chatId, userId, filter, page);
    }

    // Пагинация /users
    const usersMatch = data.match(/^admin_users_(\w+)_(\d+)$/);
    if (usersMatch) {
      const filter = usersMatch[1] === "all" ? null : usersMatch[1];
      const page = parseInt(usersMatch[2], 10);
      return listUsersCommand(chatId, userId, page, filter);
    }

    // Быстрые кнопки
    if (data === "admin_stats") return fullStatsCommand(chatId, userId);
    if (data === "admin_logs") return logsCommand(chatId, userId);
    if (data === "admin_backups") return backupsListCommand(chatId, userId);
    if (data === "admin_health") return healthCommand(chatId, userId);
    if (data === "admin_chart") return chartCommand(chatId, userId);
    if (data === "admin_clearlogs") return clearLogsCommand(chatId, userId);
    
    if (data === "admin_create_help") {
      return sendMessage(chatId,
        `➕ <b>Создание кода</b>\n\n<code>/create НАЗВАНИЕ ДАТА [КАТЕГОРИЯ]</code>\n\n` +
        `Пример: <code>/create PROMO +7d EVENT</code>`,
        { parse_mode: "HTML" });
    }
    
    if (data === "admin_broadcast_help") {
      return sendMessage(chatId,
        `📢 <b>Рассылка</b>\n\n<code>/broadcast ТЕКСТ</code>`,
        { parse_mode: "HTML" });
    }

    // Подтверждение рассылки
    if (data === "admin_bc_confirm") {
      const user = await getUser(userId);
      if (user.state === "confirming_broadcast" && user.pendingBroadcast) {
        // ... (логика из announce)
      }
      return sendMessage(chatId, `⚠️ Используй /broadcast заново.`, { parse_mode: "HTML" });
    }

    // Действия с кодом
    const codeActionMatch = data.match(/^admin_(\w+?)_(?!confirm)(.+)$/);
    if (codeActionMatch) {
      const action = codeActionMatch[1];
      const param = codeActionMatch[2];

      if (action === "link") return linkCodeCommand(chatId, userId, param);
      if (action === "del") return deleteCodeCommand(chatId, userId, param);
      if (action === "del_confirm") return deleteCodeCommand(chatId, userId, param, true);
      if (action === "reset") return resetCodeCommand(chatId, userId, param);
      if (action === "reset_confirm") return resetCodeCommand(chatId, userId, param, true);
      if (action === "info") return infoCodeCommand(chatId, userId, param);
      
      if (action === "toggle") {
        const code = await getCode(param);
        if (code) {
          code.disabled = !code.disabled;
          await saveCode(param, code);
          return sendMessage(
            chatId,
            `${code.disabled ? "⏸" : "✅"} Код ${code.disabled ? "отключён" : "включён"}.`,
            { parse_mode: "HTML" }
          );
        }
      }
      
      if (action === "copy") {
        return sendMessage(chatId,
          `📋 <code>/copy ${param} НОВОЕ_ИМЯ ДАТА</code>`,
          { parse_mode: "HTML" });
      }
      
      if (action === "extend") {
        return sendMessage(chatId,
          `⏰ <code>/extend ${param} +7d</code>`,
          { parse_mode: "HTML" });
      }
      
      if (action === "ban") {
        if (!isNumeric(param)) return sendMessage(chatId, `❌ Некорректный ID.`, { parse_mode: "HTML" });
        await banUser(param);
        return sendMessage(chatId, `⛔ Забанен: ${param}`, { parse_mode: "HTML" });
      }
      
      if (action === "mute") {
        if (!isNumeric(param)) return sendMessage(chatId, `❌ Некорректный ID.`, { parse_mode: "HTML" });
        await muteUser(param, 24 * 60 * 60 * 1000);
        return sendMessage(chatId, `🔇 Замучен на 24ч: ${param}`, { parse_mode: "HTML" });
      }
      
      if (action === "resetuser") {
        return resetUserCommand(chatId, userId, param);
      }
      
      if (action === "activate") {
        return sendMessage(chatId,
          `🎁 <code>/activate КОД ${param}</code>`,
          { parse_mode: "HTML" });
      }
    }
  }

  // ========== ПОЛЬЗОВАТЕЛЬСКИЕ ==========
  if (data === "prompt_code") {
    // 🔥 Инлайн-ввод кода
    await saveUser(userId, {
      state: "waiting_code_input",
      stateExpiresAt: Date.now() + 5 * 60 * 1000,
    });
    return editMessage(
      chatId,
      messageId,
      `🎁 <b>Введи код</b>\n\nОтправь название промокода следующим сообщением.\n\n⏳ У тебя 5 минут.`,
      { parse_mode: "HTML" }
    );
  }

  if (data === "my_codes") return showMyCodes(chatId, userId);
  if (data === "leaderboard") return showLeaderboard(chatId);
  if (data === "top_codes") return showTopCodes(chatId);
  if (data === "help") return sendHelp(chatId, isAdmin(userId));
  if (data === "user_stats") return showUserStats(chatId);
  if (data === "my_profile") return showProfile(chatId, userId);
  if (data === "my_badges") return showBadges(chatId, userId);
  if (data === "share_bot") return shareBot(chatId, userId);

  // Объявление
  if (data === "confirm_announce" && isAdmin(userId)) {
    const user = await getUser(userId);
    if (user.state === "confirming_announce" && user.pendingAnnouncement) {
      const text = user.pendingAnnouncement;
      await saveUser(userId, { state: null, pendingAnnouncement: null, stateExpiresAt: null });
      
      const users = await getAllUsers();
      let success = 0;
      
      for (const uid of users) {
        const res = await sendMessage(
          uid,
          `📢 <b>Важное объявление</b>\n\n${text}`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [[{ text: "✅ OK", callback_data: `ack_${uid}` }]],
            },
          }
        );
        if (res.ok) success++;
        await new Promise(r => setTimeout(r, CONFIG.BROADCAST_DELAY));
      }
      
      return sendMessage(
        chatId,
        `✅ Отправлено ${success}/${users.length}.`,
        { parse_mode: "HTML" }
      );
    }
  }

  if (data === "cancel_announce" && isAdmin(userId)) {
    await saveUser(userId, { state: null, pendingAnnouncement: null, stateExpiresAt: null });
    return sendMessage(chatId, `❌ Отменено.`, { parse_mode: "HTML" });
  }

  // Ack
  if (data.startsWith("ack_")) {
    try { await deleteMessage(chatId, messageId); } catch (e) {}
    return;
  }
}

// ============================================
// 19. ОБРАБОТКА СООБЩЕНИЙ
// ============================================

async function processCommand(message, text) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const username = message.from.username;

  const parts = text.trim().split(/\s+/);
  const command = parts[0].toLowerCase().split("@")[0];
  const args = parts.slice(1);

  // Админские
  if (command === "/admin") return sendAdminPanel(chatId, userId);
  if (command === "/create") return createCodeCommand(chatId, userId, args);
  if (command === "/link") return linkCodeCommand(chatId, userId, args[0]);
  if (command === "/all") return listAllCodesCommand(chatId, userId, args[0] || null, safeParseInt(args[1]) || 0);
  if (command === "/info") return infoCodeCommand(chatId, userId, args[0]);
  if (command === "/extend") return extendCodeCommand(chatId, userId, args);
  if (command === "/delete") return deleteCodeCommand(chatId, userId, args[0]);
  if (command === "/reset") return resetCodeCommand(chatId, userId, args[0]);
  if (command === "/resetuser") return resetUserCommand(chatId, userId, args[0]);
  if (command === "/copy") return copyCodeCommand(chatId, userId, args);
  if (command === "/rename") return renameCodeCommand(chatId, userId, args);
  if (command === "/reward") return rewardCodeCommand(chatId, userId, args[0]);
  if (command === "/setlimit") return setLimitCommand(chatId, userId, args);
  if (command === "/activate") return activateForUserCommand(chatId, userId, args);
  
  if (command === "/ban") return banUserCommand(chatId, userId, args);
  if (command === "/unban") return unbanUserCommand(chatId, userId, args[0]);
  if (command === "/mute") return muteUserCommand(chatId, userId, args);
  if (command === "/unmute") return unmuteUserCommand(chatId, userId, args[0]);
  if (command === "/users") return listUsersCommand(chatId, userId, safeParseInt(args[0]) || 0, null);
  if (command === "/whois") return whoisCommand(chatId, userId, args[0]);
  
  if (command === "/broadcast") return broadcastCommand(chatId, userId, args.join(" "));
  if (command === "/announce") return announceCommand(chatId, userId, args.join(" "));
  if (command === "/schedule") return scheduleCommand(chatId, userId, args);
  
  if (command === "/logs") return logsCommand(chatId, userId);
  if (command === "/clearlogs") return clearLogsCommand(chatId, userId);
  if (command === "/chart") return chartCommand(chatId, userId);
  
  if (command === "/backup") return backupCommand(chatId, userId);
  if (command === "/backups") return backupsListCommand(chatId, userId);
  if (command === "/restore") return restoreCommand(chatId, userId, args[0], args[1] || "replace");
  
  if (command === "/export") return exportCommand(chatId, userId);
  if (command === "/exportcsv") return exportCsvCommand(chatId, userId);
  if (command === "/import") return importCommand(chatId, userId, args.join(" "));
  
  if (command === "/ping") return pingCommand(chatId, userId);
  if (command === "/health") return healthCommand(chatId, userId);
  
  if (command === "/stats") {
    if (isAdmin(userId)) return fullStatsCommand(chatId, userId);
    return showUserStats(chatId);
  }

  // Пользовательские
  if (command === "/start") {
    // Реферальная ссылка
    const payload = text.substring(7).trim();
    if (payload.startsWith("ref_")) {
      const referrerId = payload.replace("ref_", "");
      const isNew = await processReferral(userId, referrerId);
      if (isNew) {
        await sendMessage(chatId, `✅ <b>Регистрация по реферальной ссылке!</b>`, { parse_mode: "HTML" });
      }
    }
    return sendStart(chatId, userId, username);
  }
  
  if (command === "/help") return sendHelp(chatId, isAdmin(userId));
  if (command === "/my") return showMyCodes(chatId, userId);
  if (command === "/code") return activateCode(chatId, userId, username, args[0]);
  if (command === "/top") return showLeaderboard(chatId);
  if (command === "/topcodes") return showTopCodes(chatId);
  if (command === "/profile") return showProfile(chatId, userId);
  if (command === "/badges") return showBadges(chatId, userId);
  if (command === "/share") return shareBot(chatId, userId);

  return sendMessage(
    chatId,
    `❓ Неизвестная команда.\n\nИспользуй /help.`,
    { parse_mode: "HTML" }
  );
}

async function processText(message) {
  // 🔥 Только в личке
  if (message.chat.type !== "private") return;

  const chatId = message.chat.id;
  const userId = message.from.id;
  const username = message.from.username;
  const text = message.text || message.caption || "";

  // Rate limit
  if (!isAdmin(userId)) {
    const rl = await checkRateLimit(userId);
    if (!rl.allowed) {
      return sendMessage(chatId, `⚠️ Слишком много запросов. Подожди минуту.`, { parse_mode: "HTML" });
    }
  }

  if (await isBanned(userId) && !isAdmin(userId)) return;
  if (await isMuted(userId) && !isAdmin(userId)) return;

  await saveUser(userId, {}, username);

  if (text.startsWith("/")) return processCommand(message, text);

  const user = await getUser(userId);

  // 🔥 Обработка инлайн-ввода кода
  if (user.state === "waiting_code_input" && !text.startsWith("/")) {
    if (Date.now() > (user.stateExpiresAt || 0)) {
      await saveUser(userId, { state: null, stateExpiresAt: null });
      return sendMessage(chatId, `⏰ Время истекло. Попробуй снова.`, { parse_mode: "HTML" });
    }
    await saveUser(userId, { state: null, stateExpiresAt: null });
    return activateCode(chatId, userId, username, text.trim().toUpperCase());
  }

  // Награда для нового кода
  if ((user.state === "waiting_reward" || user.state === "updating_reward") && isAdmin(userId)) {
    if (Date.now() > (user.stateExpiresAt || 0)) {
      await saveUser(userId, { state: null, pendingCodeName: null, stateExpiresAt: null });
      return sendMessage(chatId, `⏰ Время истекло.`, { parse_mode: "HTML" });
    }

    const codeName = user.pendingCodeName;
    const code = await getCode(codeName);

    if (!code) {
      await saveUser(userId, { state: null, pendingCodeName: null, stateExpiresAt: null });
      return sendMessage(chatId, "❌ Код уже не существует.", { parse_mode: "HTML" });
    }

    let rewardText = text;
    let rewardMedia = null;
    let rewardMediaType = null;

    if (message.photo && message.photo.length > 0) {
      rewardMedia = message.photo[message.photo.length - 1].file_id;
      rewardMediaType = "photo";
      rewardText = message.caption || text || "";
    } else if (message.document) {
      rewardMedia = message.document.file_id;
      rewardMediaType = "document";
      rewardText = message.caption || text || "";
    } else if (message.video) {
      rewardMedia = message.video.file_id;
      rewardMediaType = "video";
      rewardText = message.caption || text || "";
    } else if (message.animation) {
      rewardMedia = message.animation.file_id;
      rewardMediaType = "animation";
      rewardText = message.caption || text || "";
    }

    code.reward = rewardText;
    code.rewardMedia = rewardMedia;
    code.rewardMediaType = rewardMediaType;
    code.status = CODE_STATUS.ACTIVE;
    await saveCode(codeName, code);

    await saveUser(userId, { state: null, pendingCodeName: null, stateExpiresAt: null });

    const mediaInfo = rewardMedia ? `\n📎 Медиа: ${rewardMediaType}` : "";

    return sendMessage(
      chatId,
      `✅ <b>Награда привязана!</b>\n\n` +
        `🔖 Код: <code>${codeName}</code>\n` +
        `🟢 Статус: активен\n` +
        `⏰ До: ${formatDate(code.expiresAt)}${mediaInfo}`,
      { parse_mode: "HTML" }
    );
  }

  if (user.state === "confirming_announce" && isAdmin(userId)) {
    return sendMessage(chatId, `⏳ Подтверди через кнопки выше.`, { parse_mode: "HTML" });
  }

  return sendMessage(
    chatId,
    `🎁 Используй /help для списка команд.`,
    { parse_mode: "HTML" }
  );
}

// ============================================
// 20. ПЛАНИРОВЩИК
// ============================================

async function processScheduled() {
  const schedules = (await kv.get(KV_PREFIXES.SCHEDULES)) || [];
  const now = Date.now();
  const toProcess = schedules.filter(s => s.scheduledAt <= now);
  
  if (toProcess.length === 0) return;

  const remaining = schedules.filter(s => s.scheduledAt > now);
  await kv.set(KV_PREFIXES.SCHEDULES, remaining);

  const users = await getAllUsers();

  for (const schedule of toProcess) {
    await logAction("scheduled_executed", { extra: schedule.id });

    for (const uid of users) {
      await sendMessage(
        uid,
        `⏰ <b>Запланированное</b>\n\n${schedule.text}`,
        { parse_mode: "HTML" }
      );
      await new Promise(r => setTimeout(r, CONFIG.BROADCAST_DELAY));
    }
  }
}

// ============================================
// 21. МИГРАЦИЯ
// ============================================

async function migrate() {
  try {
    const currentVersion = (await kv.get(KV_PREFIXES.SCHEMA_VERSION)) || 0;
    
    if (currentVersion < 4) {
      console.log(`[MIGRATE] v${currentVersion} → v${CONFIG.SCHEMA_VERSION}`);
      
      // Миграция: нормализуем старые коды
      const names = await listCodeNames();
      for (const name of names) {
        const code = await getCode(name);
        if (!code) continue;
        
        let changed = false;
        if (!code.category) {
          code.category = CODE_STATUS.STANDARD;
          changed = true;
        }
        if (!code.status && code.reward) {
          code.status = CODE_STATUS.ACTIVE;
          changed = true;
        }
        if (!code.status && !code.reward) {
          code.status = CODE_STATUS.NO_REWARD;
          changed = true;
        }
        
        if (changed) await saveCode(name, code);
      }
      
      await kv.set(KV_PREFIXES.SCHEMA_VERSION, CONFIG.SCHEMA_VERSION);
    }
  } catch (error) {
    console.error("[MIGRATE ERROR]", error.message);
  }
}

// ============================================
// 22. MAIN HANDLER
// ============================================

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "GcStudio Promo Bot v4.0",
      version: "4.0.0",
      timestamp: Date.now(),
      features: [
        "Ticket System",
        "Badges",
        "Referrals",
        "CSV Export",
        "Charts",
        "Locks",
        "Backups",
      ],
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (
    CONFIG.WEBHOOK_SECRET &&
    req.headers["x-telegram-bot-api-secret-token"] !== CONFIG.WEBHOOK_SECRET
  ) {
    return res.status(403).json({ ok: false, error: "Invalid webhook secret" });
  }

  try {
    const update = req.body;

    // Миграция и инициализация
    await migrate();
    
    const stats = await getStats();
    if (!stats.first_start) {
      await incrementStat("first_start", Date.now());
    }
    await incrementStat("webhook_calls", 1);

    // Обработка
    if (update.callback_query) {
      await handleCallback(update.callback_query);
    } else if (update.message) {
      await processText(update.message);
    } else if (update.edited_message) {
      // игнорируем
    } else if (update.channel_post) {
      // игнорируем
    }

    // Фоновые задачи
    try {
      await processScheduled();
    } catch (e) {
      console.error("[SCHEDULER ERROR]", e);
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[HANDLER ERROR]", error);
    await logAction("handler_error", { extra: error.message });

    return res.status(200).json({
      ok: false,
      error: error.message,
    });
  }
};