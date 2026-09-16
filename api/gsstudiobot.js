/**
 * GcStudio Promo Bot v3.0 - Production Edition
 * 
 * Telegram бот для управления промокодами с полным функционалом:
 * - Активация кодов пользователями
 * - Админ-панель с 30+ командами
 * - Система логирования
 * - Бэкапы и восстановление
 * - Статистика и аналитика
 * - Управление пользователями (бан/мут)
 * - Rate limiting и защита от спама
 * 
 * @author GcStudio
 * @version 3.0.0
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
  BOT_USERNAME: process.env.GS_BOT_USERNAME || "GcStudioPromoBot",
  
  // Таймауты
  FETCH_TIMEOUT: 7000,
  STATE_TIMEOUT: 10 * 60 * 1000,
  EXPIRED_CODE_RETENTION: 60 * 60 * 1000,
  
  // Rate limiting
  RATE_LIMIT_WINDOW: 60 * 1000,
  RATE_LIMIT_MAX_REQUESTS: 30,
  
  // Лимиты
  MAX_MESSAGE_LENGTH: 4000,
  MAX_CODES_PER_PAGE: 10,
  MAX_USERS_PER_PAGE: 10,
  MAX_LEADERBOARD_SIZE: 20,
  MAX_BACKUPS: 10,
  
  // Broadcast
  BROADCAST_DELAY: 50,
  MAX_BROADCAST_USERS: 10000,
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
};

const CATEGORY_ICONS = {
  NEW: "🆕",
  EVENT: "🎉",
  VIP: "💎",
  SECRET: "🔐",
  STANDARD: "📦",
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
  STATE: "gs:state:",
};

// ============================================
// 2. УТИЛИТЫ И ХЕЛПЕРЫ
// ============================================

/**
 * Проверяет, является ли пользователь админом
 * @param {string|number} userId
 * @returns {boolean}
 */
function isAdmin(userId) {
  return CONFIG.ADMIN_IDS.includes(String(userId));
}

/**
 * Безопасно парсит строку в число
 * @param {string} str
 * @returns {number|null}
 */
function safeParseInt(str) {
  const num = parseInt(str, 10);
  return isNaN(num) ? null : num;
}

/**
 * Экранирует HTML-символы
 * @param {string} str
 * @returns {string}
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
 * Обрезает строку до максимальной длины с троеточием
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
function truncate(str, maxLen = 100) {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + "...";
}

/**
 * Разбивает длинное сообщение на части
 * @param {string} text
 * @param {number} maxLen
 * @returns {string[]}
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
 * Вычисляет человеко-понятную разницу во времени
 * @param {number} timestamp
 * @returns {string}
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
 * @param {number} ms
 * @returns {string}
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
 * @returns {string}
 */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

// ============================================
// 3. РАБОТА С ДАТАМИ (UTC)
// ============================================

/**
 * Парсит дату формата: ДД.ММ.ГГГГ+ЧЧ:ММ или относительную (+7d, +24h)
 * @param {string} str
 * @returns {number|null} timestamp
 */
function parseDate(str) {
  if (!str) return null;
  str = str.trim();
  
  // Относительный формат: +7d, +24h, +30m, +1w
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
  
  // Абсолютный формат: ДД.ММ.ГГГГ+ЧЧ:ММ
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
 * Форматирует timestamp в читаемую строку (UTC)
 * @param {number} timestamp
 * @param {boolean} withSeconds
 * @returns {string}
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
 * Возвращает "сегодня", "вчера" или дату
 * @param {number} timestamp
 * @returns {string}
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

// ============================================
// 4. TELEGRAM API WRAPPER
// ============================================

/**
 * Делает запрос к Telegram API с retry и таймаутом
 * @param {string} method
 * @param {object} body
 * @param {number} retries
 * @returns {Promise<object>}
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
      
      // Retry для некоторых ошибок
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
 * Отправляет текстовое сообщение
 * @param {number|string} chatId
 * @param {string} text
 * @param {object} extra
 * @returns {Promise<object>}
 */
async function sendMessage(chatId, text, extra = {}) {
  if (!text) return { ok: false };
  
  // Разбиваем длинные сообщения
  const parts = splitMessage(String(text));
  let lastResult;
  
  for (const part of parts) {
    lastResult = await telegram("sendMessage", {
      chat_id: chatId,
      text: part,
      disable_web_page_preview: true,
      ...extra,
    });
  }
  
  return lastResult;
}

/**
 * Редактирует существующее сообщение
 * @param {number|string} chatId
 * @param {number} messageId
 * @param {string} text
 * @param {object} extra
 * @returns {Promise<object>}
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
 * Отвечает на callback query
 * @param {string} callbackId
 * @param {string} text
 * @param {boolean} showAlert
 * @returns {Promise<object>}
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
 * @param {number|string} chatId
 * @param {number} messageId
 * @returns {Promise<object>}
 */
async function deleteMessage(chatId, messageId) {
  return telegram("deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
}

/**
 * Отправляет "печатает..." индикатор
 * @param {number|string} chatId
 * @returns {Promise<object>}
 */
async function sendChatAction(chatId, action = "typing") {
  return telegram("sendChatAction", {
    chat_id: chatId,
    action,
  });
}

/**
 * Отправляет фото с подписью
 * @param {number|string} chatId
 * @param {string} photo
 * @param {string} caption
 * @param {object} extra
 * @returns {Promise<object>}
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
 * @param {number|string} chatId
 * @param {string} document
 * @param {string} caption
 * @param {object} extra
 * @returns {Promise<object>}
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
 * Отправляет GIF/анимацию
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
 * @param {string} action
 * @param {object} details
 * @returns {Promise<void>}
 */
async function logAction(action, details = {}) {
  try {
    const entry = {
      id: generateId(),
      timestamp: Date.now(),
      action,
      ...details,
    };
    
    const logs = (await kv.get(KV_PREFIXES.LOGS)) || [];
    logs.unshift(entry);
    
    // Храним максимум 500 записей
    if (logs.length > 500) {
      logs.length = 500;
    }
    
    await kv.set(KV_PREFIXES.LOGS, logs);
  } catch (error) {
    console.error("[LOG ERROR]", error);
  }
}

/**
 * Получает последние записи лога
 * @param {number} limit
 * @returns {Promise<Array>}
 */
async function getLogs(limit = 20) {
  const logs = (await kv.get(KV_PREFIXES.LOGS)) || [];
  return logs.slice(0, limit);
}

/**
 * Очищает лог
 * @returns {Promise<void>}
 */
async function clearLogs() {
  await kv.set(KV_PREFIXES.LOGS, []);
}

/**
 * Форматирует лог для отображения
 * @param {object} entry
 * @returns {string}
 */
function formatLogEntry(entry) {
  const time = smartDate(entry.timestamp);
  const user = entry.userId ? `[${entry.userId}]` : "";
  const action = entry.action.toUpperCase();
  const extra = entry.extra ? ` ${entry.extra}` : "";
  return `• <code>${time}</code> ${user} <b>${action}</b>${extra}`;
}

// ============================================
// 6. РАБОТА С KV (база данных)
// ============================================

/**
 * Получает код по имени
 * @param {string} name
 * @returns {Promise<object|null>}
 */
async function getCode(name) {
  if (!name) return null;
  return await kv.get(`${KV_PREFIXES.CODE}${name.toUpperCase()}`);
}

/**
 * Сохраняет код
 * @param {string} name
 * @param {object} data
 * @returns {Promise<void>}
 */
async function saveCode(name, data) {
  const key = `${KV_PREFIXES.CODE}${name.toUpperCase()}`;
  await kv.set(key, data);
  await kv.sadd(KV_PREFIXES.ALL_CODES, name.toUpperCase());
}

/**
 * Удаляет код
 * @param {string} name
 * @returns {Promise<void>}
 */
async function deleteCode(name) {
  const key = `${KV_PREFIXES.CODE}${name.toUpperCase()}`;
  await kv.del(key);
  await kv.srem(KV_PREFIXES.ALL_CODES, name.toUpperCase());
}

/**
 * Список всех имён кодов
 * @returns {Promise<Array>}
 */
async function listCodeNames() {
  return (await kv.smembers(KV_PREFIXES.ALL_CODES)) || [];
}

/**
 * Получает пользователя
 * @param {number|string} userId
 * @returns {Promise<object>}
 */
async function getUser(userId) {
  const key = `${KV_PREFIXES.USER}${userId}`;
  return (await kv.get(key)) || {
    userId: String(userId),
    usedCodes: [],
    activations: 0,
  };
}

/**
 * Сохраняет пользователя
 * @param {number|string} userId
 * @param {object} data
 * @param {string|null} username
 * @returns {Promise<void>}
 */
async function saveUser(userId, data = {}, username = null) {
  const key = `${KV_PREFIXES.USER}${userId}`;
  const old = (await kv.get(key)) || {
    userId: String(userId),
    usedCodes: [],
    activations: 0,
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
  
  // Добавляем в общий список новых пользователей
  if (isNewUser) {
    await kv.sadd(KV_PREFIXES.ALL_USERS, String(userId));
    await incrementStat("total_users", 1);
    await logAction("user_joined", { userId: String(userId), username });
  }
}

/**
 * Получает список всех пользователей
 * @returns {Promise<Array>}
 */
async function getAllUsers() {
  return (await kv.smembers(KV_PREFIXES.ALL_USERS)) || [];
}

/**
 * Удаляет пользователя из базы
 * @param {number|string} userId
 * @returns {Promise<void>}
 */
async function deleteUser(userId) {
  await kv.del(`${KV_PREFIXES.USER}${userId}`);
  await kv.srem(KV_PREFIXES.ALL_USERS, String(userId));
}

/**
 * Банит пользователя
 * @param {number|string} userId
 * @param {string} reason
 * @returns {Promise<void>}
 */
async function banUser(userId, reason = "") {
  await kv.sadd(KV_PREFIXES.BAN_LIST, String(userId));
  await saveUser(userId, { banned: true, banReason: reason, bannedAt: Date.now() });
  await logAction("ban", { userId: String(userId), reason });
}

/**
 * Разбанивает пользователя
 * @param {number|string} userId
 * @returns {Promise<void>}
 */
async function unbanUser(userId) {
  await kv.srem(KV_PREFIXES.BAN_LIST, String(userId));
  await saveUser(userId, { banned: false, banReason: null, bannedAt: null });
  await logAction("unban", { userId: String(userId) });
}

/**
 * Проверяет, забанен ли пользователь
 * @param {number|string} userId
 * @returns {Promise<boolean>}
 */
async function isBanned(userId) {
  const list = (await kv.smembers(KV_PREFIXES.BAN_LIST)) || [];
  return list.includes(String(userId));
}

/**
 * Мутит пользователя
 * @param {number|string} userId
 * @param {number} duration
 * @returns {Promise<void>}
 */
async function muteUser(userId, duration = 0) {
  const mutedUntil = duration > 0 ? Date.now() + duration : Number.MAX_SAFE_INTEGER;
  await kv.sadd(KV_PREFIXES.MUTE_LIST, String(userId));
  await saveUser(userId, { muted: true, mutedUntil });
  await logAction("mute", { userId: String(userId), duration });
}

/**
 * Размучивает пользователя
 * @param {number|string} userId
 * @returns {Promise<void>}
 */
async function unmuteUser(userId) {
  await kv.srem(KV_PREFIXES.MUTE_LIST, String(userId));
  await saveUser(userId, { muted: false, mutedUntil: null });
  await logAction("unmute", { userId: String(userId) });
}

/**
 * Проверяет, замучен ли пользователь
 * @param {number|string} userId
 * @returns {Promise<boolean>}
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
 * Проверяет, может ли пользователь делать запросы
 * @param {number|string} userId
 * @returns {Promise<{allowed: boolean, remaining: number}>}
 */
async function checkRateLimit(userId) {
  const key = `${KV_PREFIXES.RATE_LIMIT}${userId}`;
  const now = Date.now();
  const windowStart = now - CONFIG.RATE_LIMIT_WINDOW;
  
  let data = (await kv.get(key)) || { timestamps: [] };
  
  // Убираем старые записи
  data.timestamps = data.timestamps.filter(t => t > windowStart);
  
  if (data.timestamps.length >= CONFIG.RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, remaining: 0 };
  }
  
  data.timestamps.push(now);
  await kv.set(key, data, { ex: 120 });
  
  return {
    allowed: true,
    remaining: CONFIG.RATE_LIMIT_MAX_REQUESTS - data.timestamps.length,
  };
}

// ============================================
// 8. СТАТИСТИКА
// ============================================

/**
 * Увеличивает счётчик статистики
 * @param {string} key
 * @param {number} increment
 * @returns {Promise<void>}
 */
async function incrementStat(key, increment = 1) {
  const stats = (await kv.get(KV_PREFIXES.STATS)) || {};
  stats[key] = (stats[key] || 0) + increment;
  await kv.set(KV_PREFIXES.STATS, stats);
}

/**
 * Получает всю статистику
 * @returns {Promise<object>}
 */
async function getStats() {
  return (await kv.get(KV_PREFIXES.STATS)) || {};
}

/**
 * Собирает полную статистику системы
 * @returns {Promise<object>}
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
  
  // Собираем детальную статистику по кодам
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
    else if (code.status === CODE_STATUS.ACTIVE) activeCodes++;
    else if (code.status === CODE_STATUS.PENDING) pendingCodes++;
    else if (code.status === CODE_STATUS.NO_REWARD) noRewardCodes++;
    
    totalActivations += (code.usedBy || []).length;
  }
  
  // Считаем активных пользователей за 24 часа
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
 * Определяет статус кода с учётом времени и флага
 * @param {object} code
 * @returns {object}
 */
function codeStatus(code) {
  const now = Date.now();

  if (code.disabled) {
    return {
      icon: STATUS_ICONS.disabled,
      label: "отключен",
      expired: false,
      status: CODE_STATUS.DISABLED,
    };
  }

  if (code.expiresAt && now > code.expiresAt) {
    return {
      icon: STATUS_ICONS.expired,
      label: "истёк",
      expired: true,
      status: "expired",
    };
  }

  if (code.status === CODE_STATUS.NO_REWARD) {
    return {
      icon: STATUS_ICONS.no_reward,
      label: "нет награды",
      expired: false,
      status: CODE_STATUS.NO_REWARD,
    };
  }

  if (code.status === CODE_STATUS.PENDING) {
    return {
      icon: STATUS_ICONS.pending,
      label: "в процессе",
      expired: false,
      status: CODE_STATUS.PENDING,
    };
  }

  if (code.status === CODE_STATUS.ACTIVE) {
    return {
      icon: STATUS_ICONS.active,
      label: "активен",
      expired: false,
      status: CODE_STATUS.ACTIVE,
    };
  }

  return {
    icon: "⚪",
    label: "неизвестно",
    expired: false,
    status: "unknown",
  };
}

/**
 * Чистит истёкшие коды (старше часа после истечения)
 * @returns {Promise<{deleted: number, kept: number}>}
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
 * @param {object} params
 * @returns {Promise<object>}
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
  await logAction("code_created", { 
    userId: String(createdBy), 
    extra: name 
  });
  
  return code;
}

// ============================================
// 10. СИСТЕМА БЭКАПОВ
// ============================================

/**
 * Создаёт полный бэкап базы
 * @param {number|string} createdBy
 * @returns {Promise<string>} ID бэкапа
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
  
  // Копируем все коды
  for (const name of codeNames) {
    const code = await getCode(name);
    if (code) backup.codes.push(code);
  }
  
  // Копируем всех пользователей (только мета-данные)
  for (const userId of allUsers) {
    const user = await getUser(userId);
    if (user) {
      backup.users.push({
        userId: user.userId,
        username: user.username,
        usedCodes: user.usedCodes || [],
        activations: user.activations || 0,
        banned: user.banned || false,
        createdAt: user.createdAt,
      });
    }
  }
  
  // Сохраняем бэкап
  const backups = (await kv.get(KV_PREFIXES.BACKUPS)) || [];
  backups.unshift({ id: backupId, createdAt: Date.now(), data: backup });
  
  // Ограничиваем количество бэкапов
  if (backups.length > CONFIG.MAX_BACKUPS) {
    backups.length = CONFIG.MAX_BACKUPS;
  }
  
  await kv.set(KV_PREFIXES.BACKUPS, backups);
  await logAction("backup_created", { userId: String(createdBy), extra: backupId });
  
  return backupId;
}

/**
 * Восстанавливает бэкап по ID
 * @param {string} backupId
 * @returns {Promise<object>}
 */
async function restoreBackup(backupId) {
  const backups = (await kv.get(KV_PREFIXES.BACKUPS)) || [];
  const backup = backups.find(b => b.id === backupId);
  
  if (!backup || !backup.data) {
    throw new Error("Бэкап не найден");
  }
  
  const data = backup.data;
  let codesRestored = 0;
  let usersRestored = 0;
  
  // Восстанавливаем коды
  for (const code of data.codes) {
    await saveCode(code.name, code);
    codesRestored++;
  }
  
  // Восстанавливаем пользователей
  for (const user of data.users) {
    await saveUser(user.userId, {
      username: user.username,
      usedCodes: user.usedCodes,
      activations: user.activations,
      banned: user.banned,
      createdAt: user.createdAt,
    });
    usersRestored++;
  }
  
  await logAction("backup_restored", { extra: backupId });
  
  return { codesRestored, usersRestored };
}

/**
 * Список всех бэкапов
 * @returns {Promise<Array>}
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
 * @param {string} backupId
 * @returns {Promise<boolean>}
 */
async function deleteBackup(backupId) {
  const backups = (await kv.get(KV_PREFIXES.BACKUPS)) || [];
  const filtered = backups.filter(b => b.id !== backupId);
  
  if (filtered.length === backups.length) {
    return false;
  }
  
  await kv.set(KV_PREFIXES.BACKUPS, filtered);
  return true;
}

// ============================================
// 11. ЭКСПОРТ / ИМПОРТ
// ============================================

/**
 * Экспортирует все коды в JSON
 * @returns {Promise<string>}
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
 * Импортирует коды из JSON
 * @param {string} jsonData
 * @param {string} mode - "merge" или "replace"
 * @returns {Promise<object>}
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
// 12. КОМАНДЫ ПОЛЬЗОВАТЕЛЕЙ
// ============================================

/**
 * Команда /start
 */
async function sendStart(chatId, userId, username) {
  const user = await getUser(userId);
  const isNew = !user.createdAt;
  
  await saveUser(userId, {}, username);
  
  const text = 
    `🎁 <b>Добро пожаловать в GcStudio Promo Bot!</b>\n\n` +
    `Здесь ты можешь активировать секретные коды и получать награды от разработчиков.\n\n` +
    `<b>Основные команды:</b>\n` +
    `🔹 <code>/code НАЗВАНИЕ</code> — активировать промокод\n` +
    `🔹 <code>/my</code> — мои использованные коды\n` +
    `🔹 <code>/top</code> — таблица лидеров\n` +
    `🔹 <code>/help</code> — помощь\n\n` +
    `📢 <i>Следи за каналом проекта, чтобы не пропустить новые коды!</i>`;

  const reply_markup = {
    inline_keyboard: [
      [
        { text: "🎁 Активировать код", callback_data: "prompt_code" },
        { text: "📋 Мои коды", callback_data: "my_codes" },
      ],
      [
        { text: "🏆 Топ пользователей", callback_data: "leaderboard" },
        { text: "ℹ️ Помощь", callback_data: "help" },
      ],
    ],
  };

  if (isNew) {
    await incrementStat("new_users_today", 1);
  }

  return sendMessage(chatId, text, { 
    parse_mode: "HTML", 
    reply_markup 
  });
}

/**
 * Команда /help
 */
async function sendHelp(chatId, isAdminUser = false) {
  let text = 
    `ℹ️ <b>Помощь по боту</b>\n\n` +
    `<b>🎯 Основные команды:</b>\n` +
    `🔹 <code>/code НАЗВАНИЕ</code> — активировать промокод\n` +
    `🔹 <code>/my</code> — список твоих активированных кодов\n` +
    `🔹 <code>/top</code> — таблица лидеров\n` +
    `🔹 <code>/stats</code> — краткая статистика\n\n` +
    `<b>💡 Как это работает:</b>\n` +
    `Промокоды публикуются в канале проекта. ` +
    `Если код истёк, уже использован или достиг лимита — бот сообщит об этом.\n\n` +
    `Каждый код можно активировать <b>только один раз</b>.\n\n`;
  
  if (isAdminUser) {
    text += 
      `<b>👑 Админ-команды:</b>\n` +
      `🔹 <code>/create КОД ДАТА</code> — создать код\n` +
      `🔹 <code>/link КОД</code> — привязать награду\n` +
      `🔹 <code>/all</code> — список всех кодов\n` +
      `🔹 <code>/info КОД</code> — детали кода\n` +
      `🔹 <code>/extend КОД ДАТА</code> — продлить код\n` +
      `🔹 <code>/reward КОД</code> — изменить награду\n` +
      `🔹 <code>/copy СТАРЫЙ НОВЫЙ</code> — скопировать код\n` +
      `🔹 <code>/rename СТАРЫЙ НОВЫЙ</code> — переименовать\n` +
      `🔹 <code>/delete КОД</code> — удалить код\n` +
      `🔹 <code>/setlimit КОД N</code> — лимит активаций\n` +
      `🔹 <code>/reset КОД</code> — сбросить использования\n` +
      `🔹 <code>/resetuser ID</code> — сбросить юзеру\n` +
      `🔹 <code>/activate КОД ID</code> — активировать юзеру\n\n` +
      `<b>📢 Массовые действия:</b>\n` +
      `🔹 <code>/broadcast ТЕКСТ</code> — рассылка\n` +
      `🔹 <code>/announce ТЕКСТ</code> — объявление\n` +
      `🔹 <code>/schedule ДАТА ТЕКСТ</code> — отложенная рассылка\n\n` +
      `<b>👥 Управление пользователями:</b>\n` +
      `🔹 <code>/ban ID ПРИЧИНА</code> — забанить\n` +
      `🔹 <code>/unban ID</code> — разбанить\n` +
      `🔹 <code>/mute ID ЧАСЫ</code> — замутить\n` +
      `🔹 <code>/unmute ID</code> — размутить\n` +
      `🔹 <code>/users [PAGE]</code> — список юзеров\n` +
      `🔹 <code>/whois ID</code> — инфо о юзере\n` +
      `🔹 <code>/leaderboard</code> — топ активаций\n\n` +
      `<b>⚙️ Система:</b>\n` +
      `🔹 <code>/stats</code> — полная статистика\n` +
      `🔹 <code>/logs</code> — лог действий\n` +
      `🔹 <code>/clearlogs</code> — очистить лог\n` +
      `🔹 <code>/backup</code> — создать бэкап\n` +
      `🔹 <code>/backups</code> — список бэкапов\n` +
      `🔹 <code>/restore ID</code> — восстановить\n` +
      `🔹 <code>/export</code> — экспорт кодов\n` +
      `🔹 <code>/import JSON</code> — импорт\n` +
      `🔹 <code>/ping</code> — проверка связи\n` +
      `🔹 <code>/health</code> — статус системы\n` +
      `🔹 <code>/admin</code> — эта справка`;
  }

  return sendMessage(chatId, text, { parse_mode: "HTML" });
}

/**
 * Команда /my - список использованных кодов пользователя
 */
async function showMyCodes(chatId, userId) {
  const user = await getUser(userId);
  
  if (!user.usedCodes || user.usedCodes.length === 0) {
    const text = 
      `📭 <b>У тебя пока нет активированных промокодов</b>\n\n` +
      `Следи за каналом проекта, чтобы не пропустить новые!\n\n` +
      `💡 Используй команду <code>/code НАЗВАНИЕ</code>, чтобы активировать код.`;
    
    return sendMessage(chatId, text, { parse_mode: "HTML" });
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
 * Команда /code - активация промокода
 */
async function activateCode(chatId, userId, username, codeName) {
  if (!codeName) {
    return sendMessage(
      chatId,
      `❌ <b>Укажи название кода</b>\n\n` +
        `Пример: <code>/code SUMMER2026</code>\n\n` +
        `💡 Коды публикуются в канале проекта.`,
      { parse_mode: "HTML" }
    );
  }

  // Проверяем бан
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

  const code = await getCode(codeName);

  if (!code) {
    await incrementStat("invalid_code_attempts", 1);
    return sendMessage(
      chatId,
      `❌ <b>Код не найден</b>\n\n` +
        `Промокод <code>${escapeHtml(codeName)}</code> не существует. ` +
        `Проверь правильность написания.`,
      { parse_mode: "HTML" }
    );
  }

  // Проверяем отключён ли код
  if (code.disabled) {
    return sendMessage(
      chatId,
      `⚫ <b>Код отключен</b>\n\n` +
        `Промокод <code>${code.name}</code> временно недоступен.`,
      { parse_mode: "HTML" }
    );
  }

  const now = Date.now();

  if (code.expiresAt && now > code.expiresAt) {
    const expiredAt = formatDate(code.expiresAt);
    return sendMessage(
      chatId,
      `⏰ <b>Код истёк</b>\n\n` +
        `Промокод <code>${code.name}</code> перестал действовать ${expiredAt}.`,
      { parse_mode: "HTML" }
    );
  }

  if (code.status !== CODE_STATUS.ACTIVE) {
    return sendMessage(
      chatId,
      `⚠️ <b>Код ещё не готов</b>\n\n` +
        `Разработчики пока не завершили настройку награды для этого кода. ` +
        `Попробуй позже.`,
      { parse_mode: "HTML" }
    );
  }

  // Проверяем лимит активаций
  if (code.maxUses && code.maxUses > 0 && (code.usedBy || []).length >= code.maxUses) {
    return sendMessage(
      chatId,
      `📦 <b>Лимит исчерпан</b>\n\n` +
        `Промокод <code>${code.name}</code> уже использовали ${code.maxUses} раз.`,
      { parse_mode: "HTML" }
    );
  }

  const user = await getUser(userId);

  // Проверяем, использовал ли уже этот код
  const alreadyUsed = user.usedCodes.some(item => {
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
  
  user.usedCodes.push(activationRecord);
  user.activations = (user.activations || 0) + 1;
  await saveUser(userId, { 
    usedCodes: user.usedCodes, 
    activations: user.activations 
  }, username);

  // Добавляем пользователя в список использовавших
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
  await logAction("code_activated", {
    userId: String(userId),
    username,
    extra: code.name,
  });

const rewardText = code.reward || "Награда не указана.";
const categoryIcon = CATEGORY_ICONS[code.category] || "";
const successMessage =
  `✅ <b>Код успешно активирован!</b>\n\n` +
  `${categoryIcon} <b>Промокод:</b> <code>${code.name}</code>\n\n` +
  `<i>Всего твоих активаций: ${user.activations}</i>`;

// Сначала отправляем сообщение об успешной активации
await sendMessage(chatId, successMessage, { parse_mode: "HTML" });

// Затем отправляем награду (медиа или текст)
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

// Если медиа нет, отправляем просто текст
return sendMessage(
  chatId,
  `🎉 <b>Твоя награда:</b>\n${rewardText}`,
  { parse_mode: "HTML" }
);
}

/**
 * Команда /top - таблица лидеров
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
  
  // Сортируем по убыванию активаций
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
 * Команда /stats для обычного пользователя
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
// 13. АДМИН-КОМАНДЫ
// ============================================

/**
 * Команда /create - создание кода
 */
async function createCodeCommand(chatId, userId, args) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }

  if (args.length < 2) {
    return sendMessage(
      chatId,
      `❌ <b>Неверный формат</b>\n\n` +
        `<b>Использование:</b>\n` +
        `<code>/create НАЗВАНИЕ ДАТА [КАТЕГОРИЯ]</code>\n\n` +
        `<b>Форматы даты:</b>\n` +
        `• <code>ДД.ММ.ГГГГ+ЧЧ:ММ</code> (абсолютная)\n` +
        `• <code>+7d</code>, <code>+24h</code>, <code>+1w</code> (относительная)\n\n` +
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
      `❌ <b>Неверный формат даты</b>\n\n` +
        `Поддерживаются:\n` +
        `• <code>ДД.ММ.ГГГГ+ЧЧ:ММ</code>\n` +
        `• <code>+7d</code>, <code>+24h</code>, <code>+1w</code>`,
      { parse_mode: "HTML" }
    );
  }

  if (expiresAt <= Date.now()) {
    return sendMessage(
      chatId,
      `❌ <b>Дата уже прошла</b>\n\nУкажи дату в будущем.`,
      { parse_mode: "HTML" }
    );
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
      `❌ Код <code>${escapeHtml(name)}</code> уже существует.\n` +
        `Используй другое название, /extend или /rename.`,
      { parse_mode: "HTML" }
    );
  }

  await createNewCode({
    name,
    expiresAt,
    createdBy: userId,
    category,
  });

  const categoryIcon = CATEGORY_ICONS[category] || "";

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
 * Команда /link - привязка награды
 */
async function linkCodeCommand(chatId, userId, codeName) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }

  if (!codeName) {
    return sendMessage(
      chatId,
      `❌ Укажи название кода.\n\nПример: <code>/link SUMMER2026</code>`,
      { parse_mode: "HTML" }
    );
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
      `Теперь отправь <b>одним сообщением</b> награду для этого кода.\n\n` +
      `<b>Что можно отправить:</b>\n` +
      `• Текст с HTML-форматированием\n` +
      `• Фото с подписью (caption)\n` +
      `• Документ с подписью\n` +
      `• Видео с подписью\n\n` +
      `<b>Поддерживаемые теги:</b>\n` +
      `<code>&lt;b&gt;</code>, <code>&lt;i&gt;</code>, <code>&lt;code&gt;</code>, <code>&lt;a href="..."&gt;</code>\n\n` +
      `⏳ У тебя есть <b>10 минут</b>.`,
    { parse_mode: "HTML" }
  );
}

/**
 * Команда /all - список всех кодов
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

  // Собираем все коды с их статусами
  const codesData = [];
  for (const name of names) {
    const code = await getCode(name);
    if (!code) continue;
    codesData.push({ name, code, status: codeStatus(code) });
  }

  // Фильтруем если нужно
  let filtered = codesData;
  if (filter === "active") filtered = codesData.filter(c => c.status.status === CODE_STATUS.ACTIVE);
  else if (filter === "pending") filtered = codesData.filter(c => c.status.status === CODE_STATUS.PENDING);
  else if (filter === "expired") filtered = codesData.filter(c => c.status.expired);
  else if (filter === "noreward") filtered = codesData.filter(c => c.status.status === CODE_STATUS.NO_REWARD);

  if (filtered.length === 0) {
    return sendMessage(
      chatId,
      `📭 Нет кодов с таким фильтром.`,
      { parse_mode: "HTML" }
    );
  }

  // Сортируем: сначала активные, потом по дате создания
  filtered.sort((a, b) => {
    if (a.status.expired !== b.status.expired) return a.status.expired ? 1 : -1;
    if (a.code.status !== b.code.status) {
      const order = { active: 0, pending: 1, no_reward: 2, disabled: 3 };
      return (order[a.code.status] || 9) - (order[b.code.status] || 9);
    }
    return (b.code.createdAt || 0) - (a.code.createdAt || 0);
  });

  // Пагинация
  const startIndex = page * CONFIG.MAX_CODES_PER_PAGE;
  const endIndex = startIndex + CONFIG.MAX_CODES_PER_PAGE;
  const pageItems = filtered.slice(startIndex, endIndex);
  const totalPages = Math.ceil(filtered.length / CONFIG.MAX_CODES_PER_PAGE);

  let text = `📋 <b>Все промокоды</b> (${filtered.length})\n`;
  text += `📄 Страница ${page + 1}/${totalPages}\n\n`;
  text += `${STATUS_ICONS.active} активен • ${STATUS_ICONS.pending} процесс • ${STATUS_ICONS.no_reward} без награды • ${STATUS_ICONS.expired} истёк\n\n`;

  for (const { name, code, status } of pageItems) {
    const usedCount = (code.usedBy || []).length;
    const categoryIcon = CATEGORY_ICONS[code.category] || "";
    const limitStr = code.maxUses ? ` / ${code.maxUses}` : "";
    
    text += `${status.icon} ${categoryIcon}<code>${name}</code>\n`;
    text += `   └ ${status.label} • до ${formatDate(code.expiresAt)} • исп: ${usedCount}${limitStr}\n`;
  }

  // Навигация
  const inline_keyboard = [];
  const navRow = [];
  
  if (page > 0) {
    navRow.push({ text: "⬅️ Назад", callback_data: `admin_all_${filter || "all"}_${page - 1}` });
  }
  
  if (page < totalPages - 1) {
    navRow.push({ text: "Вперёд ➡️", callback_data: `admin_all_${filter || "all"}_${page + 1}` });
  }
  
  if (navRow.length > 0) {
    inline_keyboard.push(navRow);
  }
  
  // Фильтры
  inline_keyboard.push([
    { text: "Все", callback_data: "admin_all_all_0" },
    { text: "🟢 Активные", callback_data: "admin_all_active_0" },
    { text: "🟠 Истёкшие", callback_data: "admin_all_expired_0" },
  ]);

  return sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard },
  });
}

/**
 * Команда /info - детальная инфа о коде
 */
async function infoCodeCommand(chatId, userId, codeName) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }
  
  if (!codeName) {
    return sendMessage(
      chatId,
      `❌ Укажи название кода.\nПример: <code>/info SUMMER2026</code>`,
      { parse_mode: "HTML" }
    );
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
  
  if (code.disabled) {
    text += `⚫ <b>Код отключён</b>\n`;
  }

  if (code.reward) {
    text += `\n<b>🎁 Награда:</b>\n${truncate(code.reward, 300)}\n`;
  }

  if (usedCount > 0) {
    text += `\n<b>📋 Последние активации:</b>\n`;
    const recent = usedBy.slice(-10).reverse();
    for (const u of recent) {
      const name = escapeHtml(u.name);
      const time = u.activatedAt ? smartDate(u.activatedAt) : "—";
      text += `• ${name} (${time})\n`;
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
        { text: "🔄 Сбросить исп.", callback_data: `admin_reset_${name}` },
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
 * Команда /extend - продление кода
 */
async function extendCodeCommand(chatId, userId, args) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }
  
  if (args.length < 2) {
    return sendMessage(
      chatId,
      `❌ <b>Неверный формат</b>\n\n` +
        `<code>/extend КОД ДАТА</code>\n\n` +
        `<b>Примеры:</b>\n` +
        `<code>/extend SUMMER2026 15.03.2025+12:00</code>\n` +
        `<code>/extend SUMMER2026 +7d</code>`,
      { parse_mode: "HTML" }
    );
  }

  const name = args[0].toUpperCase();
  const expiresAt = parseDate(args[1]);

  if (!expiresAt) {
    return sendMessage(
      chatId,
      `❌ Неверный формат даты.`,
      { parse_mode: "HTML" }
    );
  }

  if (expiresAt <= Date.now()) {
    return sendMessage(
      chatId,
      `❌ Дата уже прошла.`,
      { parse_mode: "HTML" }
    );
  }
  
  const code = await getCode(name);
  if (!code) {
    return sendMessage(
      chatId,
      `❌ Код <code>${escapeHtml(name)}</code> не найден.`,
      { parse_mode: "HTML" }
    );
  }

  const oldExpiresAt = code.expiresAt;
  code.expiresAt = expiresAt;
  await saveCode(name, code);
  
  await logAction("code_extended", { userId: String(userId), extra: name });

  return sendMessage(
    chatId,
    `✅ <b>Срок действия продлён!</b>\n\n` +
      `🔖 <code>${name}</code>\n` +
      `⏰ Было: ${formatDate(oldExpiresAt)}\n` +
      `⏰ Стало: ${formatDate(expiresAt)}`,
    { parse_mode: "HTML" }
  );
}

/**
 * Команда /delete - удаление кода
 */
async function deleteCodeCommand(chatId, userId, codeName) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }
  
  if (!codeName) {
    return sendMessage(
      chatId,
      `❌ Укажи название кода.\nПример: <code>/delete SUMMER2026</code>`,
      { parse_mode: "HTML" }
    );
  }

  const name = codeName.toUpperCase();
  if (!(await getCode(name))) {
    return sendMessage(
      chatId,
      `❌ Код <code>${escapeHtml(name)}</code> не найден.`,
      { parse_mode: "HTML" }
    );
  }

  await deleteCode(name);
  await logAction("code_deleted", { userId: String(userId), extra: name });

  return sendMessage(
    chatId,
    `🗑 <b>Код удалён</b>\n\n<code>${escapeHtml(name)}</code> полностью удалён из базы.`,
    { parse_mode: "HTML" }
  );
}

/**
 * Команда /reset - сброс использований кода
 */
async function resetCodeCommand(chatId, userId, codeName) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }
  
  if (!codeName) {
    return sendMessage(
      chatId,
      `❌ Укажи название кода.\nПример: <code>/reset SUMMER2026</code>`,
      { parse_mode: "HTML" }
    );
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

  const count = (code.usedBy || []).length;
  code.usedBy = [];
  await saveCode(name, code);
  
  await logAction("code_reset", { userId: String(userId), extra: `${name} (${count})` });

  return sendMessage(
    chatId,
    `🔄 <b>Использования сброшены!</b>\n\n` +
      `Код <code>${name}</code> можно активировать снова.\n` +
      `Сброшено активаций: ${count}`,
    { parse_mode: "HTML" }
  );
}

/**
 * Команда /resetuser - сброс пользователя
 */
async function resetUserCommand(chatId, userId, targetId) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }
  
  if (!targetId) {
    return sendMessage(
      chatId,
      `❌ Укажи ID пользователя.\nПример: <code>/resetuser 123456789</code>`,
      { parse_mode: "HTML" }
    );
  }

  const target = await getUser(targetId);
  if (!target || !target.createdAt) {
    return sendMessage(
      chatId,
      `❌ Пользователь <code>${targetId}</code> не найден.`,
      { parse_mode: "HTML" }
    );
  }

  const oldCodes = target.usedCodes || [];
  await saveUser(targetId, { usedCodes: [], activations: 0 });
  
  await logAction("user_reset", { userId: String(userId), extra: `${targetId} (${oldCodes.length})` });

  return sendMessage(
    chatId,
    `🔄 <b>Пользователь сброшен!</b>\n\n` +
      `ID: <code>${targetId}</code>\n` +
      `Убрано кодов: ${oldCodes.length}`,
    { parse_mode: "HTML" }
  );
}

/**
 * Команда /copy - копирование кода
 */
async function copyCodeCommand(chatId, userId, args) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }
  
  if (args.length < 3) {
    return sendMessage(
      chatId,
      `❌ <b>Неверный формат</b>\n\n` +
        `<code>/copy СТАРЫЙ НОВЫЙ ДАТА</code>\n\n` +
        `Пример: <code>/copy PROMO1 PROMO2 +7d</code>`,
      { parse_mode: "HTML" }
    );
  }

  const oldName = args[0].toUpperCase();
  const newName = args[1].toUpperCase();
  const expiresAt = parseDate(args[2]);

  if (!expiresAt) {
    return sendMessage(chatId, `❌ Неверный формат даты.`, { parse_mode: "HTML" });
  }

  if (expiresAt <= Date.now()) {
    return sendMessage(chatId, `❌ Дата уже прошла.`, { parse_mode: "HTML" });
  }
  
  const oldCode = await getCode(oldName);
  if (!oldCode) {
    return sendMessage(
      chatId,
      `❌ Код <code>${escapeHtml(oldName)}</code> не найден.`,
      { parse_mode: "HTML" }
    );
  }
  
  if (await getCode(newName)) {
    return sendMessage(
      chatId,
      `❌ Код <code>${escapeHtml(newName)}</code> уже существует.`,
      { parse_mode: "HTML" }
    );
  }

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
    `✅ <b>Код скопирован!</b>\n\n` +
      `Из: <code>${oldName}</code>\n` +
      `В: <code>${newName}</code>\n` +
      `⏰ Истекает: ${formatDate(expiresAt)}\n` +
      `🎁 Награда скопирована`,
    { parse_mode: "HTML" }
  );
}

/**
 * Команда /rename - переименование кода
 */
async function renameCodeCommand(chatId, userId, args) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }
  
  if (args.length < 2) {
    return sendMessage(
      chatId,
      `❌ <b>Неверный формат</b>\n\n` +
        `<code>/rename СТАРЫЙ НОВЫЙ</code>`,
      { parse_mode: "HTML" }
    );
  }

  const oldName = args[0].toUpperCase();
  const newName = args[1].toUpperCase();

  if (oldName === newName) {
    return sendMessage(chatId, `❌ Имена совпадают.`, { parse_mode: "HTML" });
  }
  
  const oldCode = await getCode(oldName);
  if (!oldCode) {
    return sendMessage(
      chatId,
      `❌ Код <code>${escapeHtml(oldName)}</code> не найден.`,
      { parse_mode: "HTML" }
    );
  }
  
  if (await getCode(newName)) {
    return sendMessage(
      chatId,
      `❌ Код <code>${escapeHtml(newName)}</code> уже существует.`,
      { parse_mode: "HTML" }
    );
  }

  // Создаём новый с новым именем
  oldCode.name = newName;
  await saveCode(newName, oldCode);
  
  // Обновляем ссылки у пользователей
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
  
  // Удаляем старый
  await deleteCode(oldName);
  
  await logAction("code_renamed", { userId: String(userId), extra: `${oldName} → ${newName}` });

  return sendMessage(
    chatId,
    `✅ <b>Код переименован!</b>\n\n` +
      `Было: <code>${oldName}</code>\n` +
      `Стало: <code>${newName}</code>\n` +
      `Обновлено пользователей: ${updatedUsers}`,
    { parse_mode: "HTML" }
  );
}

/**
 * Команда /reward - изменение награды существующего кода
 */
async function rewardCodeCommand(chatId, userId, codeName) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }
  
  if (!codeName) {
    return sendMessage(
      chatId,
      `❌ Укажи название кода.\nПример: <code>/reward SUMMER2026</code>`,
      { parse_mode: "HTML" }
    );
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
    state: "updating_reward",
    pendingCodeName: name,
    stateExpiresAt: Date.now() + CONFIG.STATE_TIMEOUT,
  });

  const currentReward = code.reward || "(не установлена)";

  return sendMessage(
    chatId,
    `🎁 <b>Изменение награды</b>\n\n` +
      `Код: <code>${name}</code>\n` +
      `Текущая награда:\n<code>${truncate(currentReward, 200)}</code>\n\n` +
      `Отправь <b>новую награду</b> одним сообщением (текст или медиа).\n` +
      `⏳ У тебя 10 минут.`,
    { parse_mode: "HTML" }
  );
}

/**
 * Команда /setlimit - установка лимита активаций
 */
async function setLimitCommand(chatId, userId, args) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }
  
  if (args.length < 2) {
    return sendMessage(
      chatId,
      `❌ <b>Неверный формат</b>\n\n` +
        `<code>/setlimit КОД N</code>\n\n` +
        `Пример: <code>/setlimit PROMO 100</code>\n` +
        `Укажи 0 для отмены лимита.`,
      { parse_mode: "HTML" }
    );
  }

  const name = args[0].toUpperCase();
  const limit = safeParseInt(args[1]);

  if (limit === null || limit < 0) {
    return sendMessage(chatId, `❌ Лимит должен быть числом >= 0.`, { parse_mode: "HTML" });
  }
  
  const code = await getCode(name);
  if (!code) {
    return sendMessage(
      chatId,
      `❌ Код <code>${escapeHtml(name)}</code> не найден.`,
      { parse_mode: "HTML" }
    );
  }

  const oldLimit = code.maxUses || 0;
  code.maxUses = limit;
  await saveCode(name, code);

  const limitStr = limit === 0 ? "без ограничений" : `${limit} активаций`;
  const oldStr = oldLimit === 0 ? "без ограничений" : `${oldLimit} активаций`;

  return sendMessage(
    chatId,
    `✅ <b>Лимит изменён!</b>\n\n` +
      `Код: <code>${name}</code>\n` +
      `Было: ${oldStr}\n` +
      `Стало: ${limitStr}`,
    { parse_mode: "HTML" }
  );
}

/**
 * Команда /activate - принудительная активация кода для юзера
 */
async function activateForUserCommand(chatId, userId, args) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }
  
  if (args.length < 2) {
    return sendMessage(
      chatId,
      `❌ <b>Неверный формат</b>\n\n` +
        `<code>/activate КОД USER_ID</code>\n\n` +
        `Пример: <code>/activate PROMO 123456789</code>`,
      { parse_mode: "HTML" }
    );
  }

  const name = args[0].toUpperCase();
  const targetId = args[1];

  const code = await getCode(name);
  if (!code) {
    return sendMessage(
      chatId,
      `❌ Код <code>${escapeHtml(name)}</code> не найден.`,
      { parse_mode: "HTML" }
    );
  }

  const user = await getUser(targetId);
  
  // Проверяем, не использовал ли уже
  const alreadyUsed = user.usedCodes.some(item => {
    const codeName = typeof item === "string" ? item : item.name;
    return codeName.toUpperCase() === name;
  });
  
  if (alreadyUsed) {
    return sendMessage(
      chatId,
      `⚠️ Пользователь уже активировал этот код.`,
      { parse_mode: "HTML" }
    );
  }

  // Активируем
  user.usedCodes.push({
    name: name,
    activatedAt: Date.now(),
    category: code.category,
  });
  user.activations = (user.activations || 0) + 1;
  await saveUser(targetId, { 
    usedCodes: user.usedCodes, 
    activations: user.activations 
  });

  // Обновляем код
  const usedBy = code.usedBy || [];
  usedBy.push({ 
    id: String(targetId), 
    name: user.username ? `@${user.username}` : String(targetId),
    activatedAt: Date.now(),
    byAdmin: true,
  });
  code.usedBy = usedBy;
  await saveCode(name, code);
  
  await logAction("admin_activation", { 
    userId: String(userId), 
    extra: `${name} → ${targetId}` 
  });

  // Отправляем награду пользователю
  if (code.reward) {
    try {
      await sendMessage(
        targetId,
        `🎁 <b>Тебе начислена награда от администратора!</b>\n\n` +
          `Промокод: <code>${name}</code>\n\n` +
          `${code.reward}`,
        { parse_mode: "HTML" }
      );
    } catch (e) {
      // Пользователь мог заблокировать бота
    }
  }

  return sendMessage(
    chatId,
    `✅ <b>Активация выполнена!</b>\n\n` +
      `Код: <code>${name}</code>\n` +
      `Пользователь: <code>${targetId}</code>\n` +
      `Награда отправлена в личку.`,
    { parse_mode: "HTML" }
  );
}

/**
 * Команда /ban
 */
async function banUserCommand(chatId, userId, args) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }
  
  if (args.length < 1) {
    return sendMessage(
      chatId,
      `❌ <b>Неверный формат</b>\n\n` +
        `<code>/ban USER_ID [ПРИЧИНА]</code>`,
      { parse_mode: "HTML" }
    );
  }

  const targetId = args[0];
  const reason = args.slice(1).join(" ") || "—";

  if (isAdmin(targetId)) {
    return sendMessage(chatId, `❌ Нельзя забанить другого админа.`, { parse_mode: "HTML" });
  }

  await banUser(targetId, reason);

  return sendMessage(
    chatId,
    `⛔ <b>Пользователь забанен</b>\n\n` +
      `ID: <code>${targetId}</code>\n` +
      `Причина: ${escapeHtml(reason)}`,
    { parse_mode: "HTML" }
  );
}

/**
 * Команда /unban
 */
async function unbanUserCommand(chatId, userId, targetId) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }
  
  if (!targetId) {
    return sendMessage(
      chatId,
      `❌ Укажи ID пользователя.\nПример: <code>/unban 123456789</code>`,
      { parse_mode: "HTML" }
    );
  }

  await unbanUser(targetId);

  return sendMessage(
    chatId,
    `✅ <b>Пользователь разбанен</b>\n\nID: <code>${targetId}</code>`,
    { parse_mode: "HTML" }
  );
}

/**
 * Команда /mute
 */
async function muteUserCommand(chatId, userId, args) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }
  
  if (args.length < 1) {
    return sendMessage(
      chatId,
      `❌ <b>Неверный формат</b>\n\n` +
        `<code>/mute USER_ID [ЧАСЫ]</code>\n\n` +
        `Пример: <code>/mute 123456789 24</code>`,
      { parse_mode: "HTML" }
    );
  }

  const targetId = args[0];
  const hours = args[1] ? safeParseInt(args[1]) : 0;

  if (isAdmin(targetId)) {
    return sendMessage(chatId, `❌ Нельзя замутить админа.`, { parse_mode: "HTML" });
  }

  const durationMs = hours > 0 ? hours * 60 * 60 * 1000 : 0;
  await muteUser(targetId, durationMs);

  const durationStr = hours > 0 ? `на ${hours} ч.` : "бессрочно";

  return sendMessage(
    chatId,
    `🔇 <b>Пользователь замучен</b>\n\n` +
      `ID: <code>${targetId}</code>\n` +
      `Длительность: ${durationStr}`,
    { parse_mode: "HTML" }
  );
}

/**
 * Команда /unmute
 */
async function unmuteUserCommand(chatId, userId, targetId) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }
  
  if (!targetId) {
    return sendMessage(
      chatId,
      `❌ Укажи ID.\nПример: <code>/unmute 123456789</code>`,
      { parse_mode: "HTML" }
    );
  }

  await unmuteUser(targetId);

  return sendMessage(
    chatId,
    `🔊 <b>Пользователь размучен</b>\n\nID: <code>${targetId}</code>`,
    { parse_mode: "HTML" }
  );
}

/**
 * Команда /users - список пользователей
 */
async function listUsersCommand(chatId, userId, page = 0, filter = null) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }

  const allUsers = await getAllUsers();
  
  // Собираем данные
  const usersData = [];
  for (const uid of allUsers) {
    const user = await getUser(uid);
    if (user && user.createdAt) {
      usersData.push(user);
    }
  }
  
  // Фильтруем
  let filtered = usersData;
  if (filter === "banned") filtered = usersData.filter(u => u.banned);
  else if (filter === "muted") filtered = usersData.filter(u => u.muted);
  else if (filter === "active") {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    filtered = usersData.filter(u => u.lastSeen && u.lastSeen > dayAgo);
  }
  
  // Сортируем по последнему визиту
  filtered.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

  if (filtered.length === 0) {
    return sendMessage(chatId, "📭 Нет пользователей.", { parse_mode: "HTML" });
  }

  const totalPages = Math.ceil(filtered.length / CONFIG.MAX_USERS_PER_PAGE);
  const startIndex = page * CONFIG.MAX_USERS_PER_PAGE;
  const endIndex = startIndex + CONFIG.MAX_USERS_PER_PAGE;
  const pageItems = filtered.slice(startIndex, endIndex);

  let text = `👥 <b>Пользователи (${filtered.length})</b>\n`;
  text += `📄 Страница ${page + 1}/${totalPages}\n\n`;

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
  
  if (page > 0) {
    navRow.push({ text: "⬅️", callback_data: `admin_users_${filter || "all"}_${page - 1}` });
  }
  if (page < totalPages - 1) {
    navRow.push({ text: "➡️", callback_data: `admin_users_${filter || "all"}_${page + 1}` });
  }
  
  if (navRow.length > 0) inline_keyboard.push(navRow);
  
  inline_keyboard.push([
    { text: "Все", callback_data: "admin_users_all_0" },
    { text: "⛔ Бан", callback_data: "admin_users_banned_0" },
    { text: "🟢 Активные", callback_data: "admin_users_active_0" },
  ]);

  return sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard },
  });
}

/**
 * Команда /whois - инфа о конкретном пользователе
 */
async function whoisCommand(chatId, userId, targetId) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }
  
  if (!targetId) {
    return sendMessage(
      chatId,
      `❌ Укажи ID пользователя.\nПример: <code>/whois 123456789</code>`,
      { parse_mode: "HTML" }
    );
  }

  const user = await getUser(targetId);
  
  if (!user || !user.createdAt) {
    return sendMessage(
      chatId,
      `❌ Пользователь <code>${targetId}</code> не найден.`,
      { parse_mode: "HTML" }
    );
  }

  const name = user.username ? `@${escapeHtml(user.username)}` : "не указан";
  const banned = user.banned ? `⛔ Да (${escapeHtml(user.banReason || "—")})` : "Нет";
  const muted = user.muted ? `🔇 До ${formatDate(user.mutedUntil)}` : "Нет";
  
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
    `🎯 <b>Активаций:</b> ${user.activations || 0}\n\n` +
    `📋 <b>Активированные коды (${user.usedCodes?.length || 0}):</b>\n${codesList}`;

  const inline_keyboard = [
    [
      { text: "⛔ Бан", callback_data: `admin_ban_${targetId}` },
      { text: "🔇 Мут", callback_data: `admin_mute_${targetId}` },
    ],
    [
      { text: "🔄 Сбросить коды", callback_data: `admin_resetuser_${targetId}` },
      { text: "🎁 Активировать код", callback_data: `admin_activate_${targetId}` },
    ],
  ];

  return sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard },
  });
}

/**
 * Команда /broadcast - массовая рассылка
 */
async function broadcastCommand(chatId, userId, text) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }
  
  if (!text) {
    return sendMessage(
      chatId,
      `❌ <b>Неверный формат</b>\n\n` +
        `<code>/broadcast Текст рассылки</code>\n\n` +
        `Поддерживается HTML-форматирование.`,
      { parse_mode: "HTML" }
    );
  }

  const users = await getAllUsers();
  if (users.length === 0) {
    return sendMessage(chatId, "❌ Нет пользователей для рассылки.", { parse_mode: "HTML" });
  }
  
  if (users.length > CONFIG.MAX_BROADCAST_USERS) {
    return sendMessage(
      chatId,
      `⚠️ Слишком много пользователей (${users.length}). Макс: ${CONFIG.MAX_BROADCAST_USERS}`,
      { parse_mode: "HTML" }
    );
  }

  const startMsg = await sendMessage(
    chatId,
    `⏳ <b>Запуск рассылки...</b>\n\n` +
      `Получателей: ${users.length}\n` +
      `Ожидаемое время: ~${Math.ceil(users.length * CONFIG.BROADCAST_DELAY / 1000)}с`,
    { parse_mode: "HTML" }
  );

  let success = 0;
  let failed = 0;
  const failedIds = [];

  for (let i = 0; i < users.length; i++) {
    const uid = users[i];
    const res = await sendMessage(
      uid,
      `📢 <b>Сообщение от администрации:</b>\n\n${text}`,
      { parse_mode: "HTML" }
    );
    
    if (res.ok) {
      success++;
    } else {
      failed++;
      failedIds.push(uid);
    }
    
    // Обновляем прогресс каждые 50 пользователей
    if (i > 0 && i % 50 === 0 && startMsg.result?.message_id) {
      await editMessage(
        chatId,
        startMsg.result.message_id,
        `⏳ <b>Рассылка...</b>\n\n` +
          `Прогресс: ${i}/${users.length} (${Math.floor(i/users.length*100)}%)\n` +
          `✅ Доставлено: ${success}\n` +
          `❌ Ошибок: ${failed}`,
        { parse_mode: "HTML" }
      );
    }
    
    await new Promise(r => setTimeout(r, CONFIG.BROADCAST_DELAY));
  }
  
  await incrementStat("broadcasts_sent", 1);
  await logAction("broadcast", { 
    userId: String(userId), 
    extra: `${success}/${users.length}` 
  });

  const finalText = 
    `✅ <b>Рассылка завершена!</b>\n\n` +
    `📊 <b>Статистика:</b>\n` +
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
 * Команда /announce - объявление с подтверждением
 */
async function announceCommand(chatId, userId, text) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }
  
  if (!text) {
    return sendMessage(
      chatId,
      `❌ Укажи текст объявления.`,
      { parse_mode: "HTML" }
    );
  }

  // Сохраняем текст и просим подтверждение
  await saveUser(userId, {
    state: "confirming_announce",
    pendingAnnouncement: text,
    stateExpiresAt: Date.now() + CONFIG.STATE_TIMEOUT,
  });

  const reply_markup = {
    inline_keyboard: [
      [
        { text: "✅ Отправить", callback_data: "confirm_announce" },
        { text: "❌ Отмена", callback_data: "cancel_announce" },
      ],
    ],
  };

  return sendMessage(
    chatId,
    `📢 <b>Подтверждение объявления</b>\n\n` +
      `Текст:\n${text}\n\n` +
      `Это сообщение будет отправлено всем ${await (await getAllUsers()).length} пользователям с кнопкой "ОК".`,
    { parse_mode: "HTML", reply_markup }
  );
}

/**
 * Команда /schedule - отложенная рассылка
 */
async function scheduleCommand(chatId, userId, args) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }
  
  if (args.length < 2) {
    return sendMessage(
      chatId,
      `❌ <b>Неверный формат</b>\n\n` +
        `<code>/schedule ДАТА ТЕКСТ</code>\n\n` +
        `Пример: <code>/schedule +1d Напоминание о конкурсе!</code>`,
      { parse_mode: "HTML" }
    );
  }

  const dateStr = args[0];
  const text = args.slice(1).join(" ");
  const timestamp = parseDate(dateStr);

  if (!timestamp) {
    return sendMessage(chatId, `❌ Неверный формат даты.`, { parse_mode: "HTML" });
  }

  if (timestamp <= Date.now()) {
    return sendMessage(chatId, `❌ Дата должна быть в будущем.`, { parse_mode: "HTML" });
  }

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
    `⏰ <b>Рассылка запланирована!</b>\n\n` +
      `ID: <code>${scheduleId}</code>\n` +
      `Дата: ${formatDate(timestamp)}\n` +
      `Через: ${timeAgo(timestamp).replace("назад", "")}\n\n` +
      `<i>Для отмены: /cancelschedule ${scheduleId}</i>`,
    { parse_mode: "HTML" }
  );
}

/**
 * Команда /logs - просмотр логов
 */
async function logsCommand(chatId, userId, limit = 30) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }

  const logs = await getLogs(limit);

  if (logs.length === 0) {
    return sendMessage(chatId, "📭 Лог пуст.", { parse_mode: "HTML" });
  }

  let text = `📝 <b>Последние действия (${logs.length})</b>\n\n`;
  
  for (const entry of logs) {
    text += formatLogEntry(entry) + "\n";
  }

  const reply_markup = {
    inline_keyboard: [
      [{ text: "🗑 Очистить лог", callback_data: "admin_clearlogs" }],
    ],
  };

  return sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup,
  });
}

/**
 * Команда /clearlogs
 */
async function clearLogsCommand(chatId, userId) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }

  await clearLogs();
  return sendMessage(chatId, `✅ Лог очищен.`, { parse_mode: "HTML" });
}

/**
 * Команда /backup - создание бэкапа
 */
async function backupCommand(chatId, userId) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }

  await sendChatAction(chatId, "typing");
  
  try {
    const backupId = await createBackup(userId);
    
    return sendMessage(
      chatId,
      `💾 <b>Бэкап создан!</b>\n\n` +
        `ID: <code>${backupId}</code>\n` +
        `Время: ${smartDate(Date.now())}\n\n` +
        `<i>Для восстановления: /restore ${backupId}</i>`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    return sendMessage(
      chatId,
      `❌ Ошибка при создании бэкапа: ${e.message}`,
      { parse_mode: "HTML" }
    );
  }
}

/**
 * Команда /backups - список бэкапов
 */
async function backupsListCommand(chatId, userId) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }

  const backups = await listBackups();

  if (backups.length === 0) {
    return sendMessage(
      chatId,
      `📭 Нет бэкапов.\n\nСоздай: <code>/backup</code>`,
      { parse_mode: "HTML" }
    );
  }

  let text = `💾 <b>Список бэкапов (${backups.length})</b>\n\n`;
  
  for (const b of backups) {
    text += `📦 <code>${b.id}</code>\n`;
    text += `   └ ${smartDate(b.createdAt)} • ${b.codesCount} кодов • ${b.usersCount} юзеров\n\n`;
  }
  
  text += `<i>Для восстановления: <code>/restore ID</code></i>`;

  return sendMessage(chatId, text, { parse_mode: "HTML" });
}

/**
 * Команда /restore - восстановление из бэкапа
 */
async function restoreCommand(chatId, userId, backupId) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }
  
  if (!backupId) {
    return sendMessage(
      chatId,
      `❌ Укажи ID бэкапа.\nПример: <code>/restore abc123</code>\n\n` +
        `Список бэкапов: <code>/backups</code>`,
      { parse_mode: "HTML" }
    );
  }

  await sendChatAction(chatId, "typing");
  
  try {
    const result = await restoreBackup(backupId);
    
    return sendMessage(
      chatId,
      `✅ <b>Бэкап восстановлен!</b>\n\n` +
        `ID: <code>${backupId}</code>\n` +
        `Кодов: ${result.codesRestored}\n` +
        `Пользователей: ${result.usersRestored}`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    return sendMessage(
      chatId,
      `❌ Ошибка: ${e.message}`,
      { parse_mode: "HTML" }
    );
  }
}

/**
 * Команда /export
 */
async function exportCommand(chatId, userId) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }

  await sendChatAction(chatId, "typing");
  
  try {
    const json = await exportCodes();
    
    // Отправляем как документ
    const blob = new Blob([json], { type: "application/json" });
    const fileId = `export_${Date.now()}.json`;
    
    // В Vercel нет прямого доступа к отправке файла через blob,
    // поэтому отправляем как код
    if (json.length > CONFIG.MAX_MESSAGE_LENGTH) {
      // Разбиваем на части или отправляем ссылку
      return sendMessage(
        chatId,
        `📦 <b>Экспорт кодов</b>\n\n` +
          `Размер: ${json.length} символов\n` +
          `Слишком большой для отправки в сообщении.\n\n` +
          `Используй <code>/backup</code> для полного бэкапа.`,
        { parse_mode: "HTML" }
      );
    }
    
    return sendMessage(
      chatId,
      `📦 <b>Экспорт кодов</b>\n\n` +
        `<pre><code>${escapeHtml(json)}</code></pre>`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    return sendMessage(chatId, `❌ Ошибка: ${e.message}`, { parse_mode: "HTML" });
  }
}

/**
 * Команда /import
 */
async function importCommand(chatId, userId, jsonData) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }
  
  if (!jsonData) {
    return sendMessage(
      chatId,
      `❌ <b>Неверный формат</b>\n\n` +
        `<code>/import JSON</code>\n\n` +
        `Передай JSON-строку как параметр.`,
      { parse_mode: "HTML" }
    );
  }

  await sendChatAction(chatId, "typing");
  
  try {
    const result = await importCodes(jsonData, "merge");
    
    return sendMessage(
      chatId,
      `✅ <b>Импорт завершён!</b>\n\n` +
        `Импортировано: ${result.imported}\n` +
        `Пропущено: ${result.skipped}\n` +
        `Всего: ${result.total}`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    return sendMessage(chatId, `❌ Ошибка: ${e.message}`, { parse_mode: "HTML" });
  }
}

/**
 * Команда /ping
 */
async function pingCommand(chatId, userId) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }

  const start = Date.now();
  const result = await telegram("getMe");
  const latency = Date.now() - start;

  if (result.ok) {
    return sendMessage(
      chatId,
      `🏓 <b>Ping-Pong!</b>\n\n` +
        `Задержка до Telegram API: <b>${latency}ms</b>\n` +
        `Бот: @${result.result.username}\n` +
        `Статус: ✅ OK`,
      { parse_mode: "HTML" }
    );
  } else {
    return sendMessage(
      chatId,
      `❌ Ошибка связи с Telegram API: ${result.description}`,
      { parse_mode: "HTML" }
    );
  }
}

/**
 * Команда /health - статус системы
 */
async function healthCommand(chatId, userId) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }

  await sendChatAction(chatId, "typing");
  
  const start = Date.now();
  const tgResult = await telegram("getMe");
  const latency = Date.now() - start;

  const kvStart = Date.now();
  try {
    await kv.get("gs:health_check");
    await kv.set("gs:health_check", Date.now());
  } catch (e) {
    // ignore
  }
  const kvLatency = Date.now() - kvStart;

  const fullStats = await gatherFullStats();

  const tgStatus = tgResult.ok ? "✅" : "❌";
  const kvStatus = "✅";

  const text = 
    `🏥 <b>Статус системы</b>\n\n` +
    `<b>Сервисы:</b>\n` +
    `${tgStatus} Telegram API: ${latency}ms\n` +
    `${kvStatus} Vercel KV: ${kvLatency}ms\n\n` +
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
 * Полная статистика для админа
 */
async function fullStatsCommand(chatId, userId) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }

  await sendChatAction(chatId, "typing");
  
  const stats = await gatherFullStats();

  const text = 
    `📊 <b>Полная статистика</b>\n\n` +
    `🎁 <b>Промокоды (${stats.codes.total}):</b>\n` +
    `• ${STATUS_ICONS.active} Активных: ${stats.codes.active}\n` +
    `• ${STATUS_ICONS.pending} В процессе: ${stats.codes.pending}\n` +
    `• ${STATUS_ICONS.no_reward} Без награды: ${stats.codes.noReward}\n` +
    `• ${STATUS_ICONS.expired} Истёкших: ${stats.codes.expired}\n\n` +
    `👥 <b>Пользователи (${stats.users.total}):</b>\n` +
    `• 🟢 Активных за 24ч: ${stats.users.active24h}\n` +
    `• ⛔ Забанено: ${stats.users.banned}\n` +
    `• 🔇 Замучено: ${stats.users.muted}\n\n` +
    `🎉 <b>Активации:</b> ${stats.activations.total}\n` +
    `📢 <b>Рассылок отправлено:</b> ${stats.broadcasts.total}\n` +
    `📝 <b>Записей в логе:</b> ${stats.logs}`;

  return sendMessage(chatId, text, { parse_mode: "HTML" });
}

// ============================================
// 14. ОБРАБОТКА CALLBACK QUERY
// ============================================

async function handleCallback(callback) {
  const chatId = callback.message.chat.id;
  const userId = callback.from.id;
  const data = callback.data;
  const messageId = callback.message.message_id;

  // Подтверждаем получение
  await answerCallback(callback.id);

  // Админские коллбеки
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

    // Конкретные действия с кодом
    const codeActionMatch = data.match(/^admin_(\w+)_(.+)$/);
    if (codeActionMatch) {
      const action = codeActionMatch[1];
      const param = codeActionMatch[2];

      if (action === "link") return linkCodeCommand(chatId, userId, param);
      if (action === "del") return deleteCodeCommand(chatId, userId, param);
      if (action === "reset") return resetCodeCommand(chatId, userId, param);
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
        return sendMessage(
          chatId,
          `📋 Используй команду:\n<code>/copy ${param} НОВОЕ_ИМЯ ДАТА</code>`,
          { parse_mode: "HTML" }
        );
      }
      
      if (action === "extend") {
        return sendMessage(
          chatId,
          `⏰ Используй команду:\n<code>/extend ${param} +7d</code> или <code>/extend ${param} ДАТА</code>`,
          { parse_mode: "HTML" }
        );
      }
      
      if (action === "ban") {
        await banUser(param);
        return sendMessage(chatId, `⛔ Забанен: ${param}`, { parse_mode: "HTML" });
      }
      
      if (action === "mute") {
        await muteUser(param, 24 * 60 * 60 * 1000);
        return sendMessage(chatId, `🔇 Замучен на 24ч: ${param}`, { parse_mode: "HTML" });
      }
      
      if (action === "resetuser") {
        return resetUserCommand(chatId, userId, param);
      }
      
      if (action === "activate") {
        return sendMessage(
          chatId,
          `🎁 Используй команду:\n<code>/activate КОД ${param}</code>`,
          { parse_mode: "HTML" }
        );
      }
    }

    if (data === "admin_clearlogs") {
      return clearLogsCommand(chatId, userId);
    }
  }

  // Пользовательские коллбеки
  if (data === "prompt_code") {
    return sendMessage(
      chatId,
      `🎁 <b>Активация кода</b>\n\n` +
        `Отправь команду:\n<code>/code НАЗВАНИЕ</code>\n\n` +
        `💡 Коды публикуются в канале проекта.`,
      { parse_mode: "HTML" }
    );
  }

  if (data === "my_codes") {
    return showMyCodes(chatId, userId);
  }

  if (data === "leaderboard") {
    return showLeaderboard(chatId);
  }

  if (data === "help") {
    return sendHelp(chatId, isAdmin(userId));
  }

  // Подтверждение объявления
  if (data === "confirm_announce" && isAdmin(userId)) {
    const user = await getUser(userId);
    if (user.state === "confirming_announce" && user.pendingAnnouncement) {
      const text = user.pendingAnnouncement;
      await saveUser(userId, { state: null, pendingAnnouncement: null, stateExpiresAt: null });
      
      // Сразу запускаем рассылку с кнопкой подтверждения
      const users = await getAllUsers();
      let success = 0;
      
      for (const uid of users) {
        const reply_markup = {
          inline_keyboard: [[{ text: "✅ OK, прочитал", callback_data: `ack_${uid}` }]],
        };
        
        const res = await sendMessage(
          uid,
          `📢 <b>Важное объявление</b>\n\n${text}`,
          { parse_mode: "HTML", reply_markup }
        );
        
        if (res.ok) success++;
        await new Promise(r => setTimeout(r, CONFIG.BROADCAST_DELAY));
      }
      
      return sendMessage(
        chatId,
        `✅ Объявление отправлено ${success}/${users.length} пользователям.`,
        { parse_mode: "HTML" }
      );
    }
  }

  if (data === "cancel_announce" && isAdmin(userId)) {
    await saveUser(userId, { state: null, pendingAnnouncement: null, stateExpiresAt: null });
    return sendMessage(chatId, `❌ Объявление отменено.`, { parse_mode: "HTML" });
  }

  // Ack - пользователь подтвердил прочтение объявления
  if (data.startsWith("ack_")) {
    await answerCallback(callback.id, "Спасибо!", false);
    try {
      await deleteMessage(chatId, messageId);
    } catch (e) {
      // ignore
    }
    return;
  }
}

// ============================================
// 15. ОБРАБОТКА СООБЩЕНИЙ
// ============================================

async function processCommand(message, text) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const username = message.from.username;

  const parts = text.trim().split(/\s+/);
  const command = parts[0].toLowerCase().split("@")[0];
  const args = parts.slice(1);

  // Админские команды
  if (command === "/create") return createCodeCommand(chatId, userId, args);
  if (command === "/link") return linkCodeCommand(chatId, userId, args[0]);
  if (command === "/all") {
    const filter = args[0] || null;
    return listAllCodesCommand(chatId, userId, filter, 0);
  }
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
  if (command === "/users") {
    const page = safeParseInt(args[0]) || 0;
    return listUsersCommand(chatId, userId, page, null);
  }
  if (command === "/whois") return whoisCommand(chatId, userId, args[0]);
  
  if (command === "/broadcast") return broadcastCommand(chatId, userId, args.join(" "));
  if (command === "/announce") return announceCommand(chatId, userId, args.join(" "));
  if (command === "/schedule") return scheduleCommand(chatId, userId, args);
  
  if (command === "/logs") return logsCommand(chatId, userId);
  if (command === "/clearlogs") return clearLogsCommand(chatId, userId);
  
  if (command === "/backup") return backupCommand(chatId, userId);
  if (command === "/backups") return backupsListCommand(chatId, userId);
  if (command === "/restore") return restoreCommand(chatId, userId, args[0]);
  
  if (command === "/export") return exportCommand(chatId, userId);
  if (command === "/import") return importCommand(chatId, userId, args.join(" "));
  
  if (command === "/ping") return pingCommand(chatId, userId);
  if (command === "/health") return healthCommand(chatId, userId);
  if (command === "/admin") return sendHelp(chatId, true);
  
  // Статистика доступна всем, но админам — полная
  if (command === "/stats") {
    if (isAdmin(userId)) return fullStatsCommand(chatId, userId);
    return showUserStats(chatId);
  }

  // Пользовательские команды
  if (command === "/start") return sendStart(chatId, userId, username);
  if (command === "/help") return sendHelp(chatId, isAdmin(userId));
  if (command === "/my") return showMyCodes(chatId, userId);
  if (command === "/code") return activateCode(chatId, userId, username, args[0]);
  if (command === "/top") return showLeaderboard(chatId);

  return sendMessage(
    chatId,
    `❓ Неизвестная команда.\n\nИспользуй /help для списка команд.`,
    { parse_mode: "HTML" }
  );
}

async function processText(message) {
  // Работаем только в личке
  if (message.chat.type !== "private") return;

  const chatId = message.chat.id;
  const userId = message.from.id;
  const username = message.from.username;
  const text = message.text || message.caption || "";

  // Rate limiting для не-админов
  if (!isAdmin(userId)) {
    const rl = await checkRateLimit(userId);
    if (!rl.allowed) {
      return sendMessage(
        chatId,
        `⚠️ <b>Слишком много запросов</b>\n\nПодожди минуту и попробуй снова.`,
        { parse_mode: "HTML" }
      );
    }
  }

  // Проверяем бан
  if (await isBanned(userId) && !isAdmin(userId)) {
    // Игнорируем или показываем короткое сообщение
    return;
  }

  // Проверяем мут
  if (await isMuted(userId) && !isAdmin(userId)) {
    return;
  }

  // Обновляем lastSeen для всех
  await saveUser(userId, {}, username);

  // Обрабатываем команды
  if (text.startsWith("/")) {
    return processCommand(message, text);
  }

  const user = await getUser(userId);

  // Состояние: ждём награду для нового кода
  if ((user.state === "waiting_reward" || user.state === "updating_reward") && isAdmin(userId)) {
    if (Date.now() > (user.stateExpiresAt || 0)) {
      await saveUser(userId, { state: null, pendingCodeName: null, stateExpiresAt: null }, username);
      return sendMessage(
        chatId,
        `⏰ Время истекло. Используй /link или /reward снова.`,
        { parse_mode: "HTML" }
      );
    }

    const codeName = user.pendingCodeName;
    const code = await getCode(codeName);

    if (!code) {
      await saveUser(userId, { state: null, pendingCodeName: null, stateExpiresAt: null }, username);
      return sendMessage(chatId, "❌ Код уже не существует.", { parse_mode: "HTML" });
    }

    // Определяем тип награды (текст, фото, документ)
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

    await saveUser(userId, { state: null, pendingCodeName: null, stateExpiresAt: null }, username);

    const mediaInfo = rewardMedia ? `\n📎 Прикреплён медиа-файл (${rewardMediaType})` : "";

    return sendMessage(
      chatId,
      `✅ <b>Награда привязана!</b>\n\n` +
        `🔖 Код: <code>${codeName}</code>\n` +
        `🟢 Статус: активен\n` +
        `⏰ Истекает: ${formatDate(code.expiresAt)}${mediaInfo}\n\n` +
        `Пользователи могут активировать командой /code ${codeName}`,
      { parse_mode: "HTML" }
    );
  }

  // Состояние: подтверждение объявления
  if (user.state === "confirming_announce" && isAdmin(userId)) {
    return sendMessage(
      chatId,
      `⏳ Сначала подтверди объявление через кнопки выше.`,
      { parse_mode: "HTML" }
    );
  }

  return sendMessage(
    chatId,
    `🎁 Используй меню команд слева.\n\nОсновная команда: <code>/code НАЗВАНИЕ</code>`,
    { parse_mode: "HTML" }
  );
}

// ============================================
// 16. ПЛАНИРОВЩИК (SCHEDULER)
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
        `⏰ <b>Запланированное сообщение</b>\n\n${schedule.text}`,
        { parse_mode: "HTML" }
      );
      await new Promise(r => setTimeout(r, CONFIG.BROADCAST_DELAY));
    }
  }
}

// ============================================
// 17. MAIN HANDLER (Vercel)
// ============================================

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "GcStudio Promo Bot v3.0",
      timestamp: Date.now(),
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  if (
    CONFIG.WEBHOOK_SECRET &&
    req.headers["x-telegram-bot-api-secret-token"] !== CONFIG.WEBHOOK_SECRET
  ) {
    return res.status(403).json({
      ok: false,
      error: "Invalid webhook secret",
    });
  }

  try {
    const update = req.body;

    // Инициализируем статистику при первом запуске
    const stats = await getStats();
    if (!stats.first_start) {
      await incrementStat("first_start", Date.now());
    }
    await incrementStat("webhook_calls", 1);

    if (update.callback_query) {
      await handleCallback(update.callback_query);
    } else if (update.message) {
      await processText(update.message);
    } else if (update.edited_message) {
      // Можно игнорировать редактирования
    } else if (update.channel_post) {
      // Игнорируем посты в каналах
    }

    // Выполняем фоновые задачи
    try {
      await processScheduled();
    } catch (e) {
      console.error("[SCHEDULER ERROR]", e);
    }

    return res.status(200).json({
      ok: true,
    });
  } catch (error) {
    console.error("[HANDLER ERROR]", error);
    await logAction("handler_error", { extra: error.message });

    return res.status(200).json({
      ok: false,
      error: error.message,
    });
  }
};