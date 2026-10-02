/**
 * ============================================================================
 * HELPER TELEGRAM BOT - ADVANCED TICKET & SUPPORT MANAGEMENT SYSTEM
 * ============================================================================
 * Version: 6.0.0 (Extended Edition - 1500+ lines)
 * Environment: Vercel Serverless Functions with @vercel/kv
 * 
 * ПОЛНЫЙ ФУНКЦИОНАЛ:
 * - Продвинутая многошаговая система создания тикетов (5 шагов)
 * - Интеллектуальная маршрутизация администраторов
 * - Live Mode с обнаружением активных администраторов
 * - Комплексные инструменты модерации (Ban/Unban/Mute/Unmute)
 * - Строгая иерархия администраторов (Главный админ 8165620138)
 * - Обязательное указание причины ответа + система оценки
 * - Защита от спама (Rate Limiting)
 * - Детальная аналитика и логирование
 * - Генерация случайных ID тикетов
 * - Система бейджей и достижений
 * - Прямой чат пользователь <-> админ
 * - Экспорт статистики
 * - Планировщик задач
 * ============================================================================
 */

// ==========================================
// 1. ИМПОРТЫ И КОНФИГУРАЦИЯ
// ==========================================

let kv = null;
try {
  const vercelKv = require("@vercel/kv");
  kv = vercelKv.kv;
} catch (e) {
  console.warn("[KV] Модуль @vercel/kv не найден. Используется имитация.");
}

// Переменные окружения
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN1 || "XXX";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "UnderCur_2026_secret";
const KV_URL = process.env.KV_REST_API_URL || "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN || "";
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || "-1004459914519";
const BOT_USERNAME = process.env.BOT_USERNAME || "undercur_bot";

// ==========================================
// 2. КОНСТАНТЫ И ИДЕНТИФИКАТОРЫ
// ==========================================

const MAIN_ADMIN_ID = "8165620138"; // @greenkx - ГЛАВНЫЙ АДМИН
const ADMIN_2_ID = "7831376830";    // @IT_20_77 - Обычный админ
const BASE_ADMIN_IDS = [MAIN_ADMIN_ID, ADMIN_2_ID];

// Динамический список админов (загружается из KV)
let ADMIN_IDS = [...BASE_ADMIN_IDS];

// Таймаут Live Mode (10.5 минут)
const LIVE_MODE_TIMEOUT_MS = 10.5 * 60 * 1000;

// Максимальная длина сообщения
const MAX_MESSAGE_LENGTH = 4000;

// Задержка между рассылками (anti-flood)
const BROADCAST_DELAY_MS = 50;

// ==========================================
// 3. СЛОВАРИ И СПРАВОЧНИКИ
// ==========================================

const TICKET_CATEGORIES = {
  URGENT: { 
    id: "urgent", 
    label: "🔴 Срочно", 
    description: "Критическая проблема, требующая немедленного решения",
    priority: 5,
    emoji: "🔴"
  },
  BUG: { 
    id: "bug", 
    label: "🐛 Баг", 
    description: "Сообщение об ошибке в работе системы",
    priority: 4,
    emoji: "🐛"
  },
  IDEA: { 
    id: "idea", 
    label: "💡 Идея", 
    description: "Предложение по улучшению функционала",
    priority: 3,
    emoji: "💡"
  },
  QUESTION: { 
    id: "question", 
    label: "❓ Вопрос", 
    description: "Общий вопрос по использованию",
    priority: 2,
    emoji: "❓"
  },
  OTHER: { 
    id: "other", 
    label: "📌 Другое", 
    description: "Прочие обращения",
    priority: 1,
    emoji: "📌"
  }
};

const TICKET_STATUSES = {
  OPEN: { id: "open", label: "Открыт", emoji: "🔴", color: "red" },
  IN_PROGRESS: { id: "in_progress", label: "В работе", emoji: "🟡", color: "yellow" },
  RESOLVED: { id: "resolved", label: "Решен", emoji: "🟢", color: "green" },
  CLOSED: { id: "closed", label: "Закрыт", emoji: "⚫", color: "gray" },
  REJECTED: { id: "rejected", label: "Отклонен", emoji: "❌", color: "red" }
};

const TARGET_ADMINS = {
  GREENKX: { id: MAIN_ADMIN_ID, label: "@greenkx", emoji: "👑" },
  IT_20_77: { id: ADMIN_2_ID, label: "@IT_20_77", emoji: "👨‍💻" },
  BOTH: { id: "both", label: "Обоим админам", emoji: "👥" }
};

// Система бейджей
const BADGES = {
  FIRST_TICKET: { id: "first_ticket", emoji: "🎫", name: "Первый тикет", desc: "Создал первый тикет" },
  TICKET_MASTER_5: { id: "ticket_master_5", emoji: "📝", name: "Активист", desc: "Создал 5 тикетов" },
  TICKET_MASTER_10: { id: "ticket_master_10", emoji: "📋", name: "Постоянный клиент", desc: "Создал 10 тикетов" },
  BUG_HUNTER_1: { id: "bug_hunter_1", emoji: "🐛", name: "Охотник", desc: "Нашел 1 баг" },
  BUG_HUNTER_5: { id: "bug_hunter_5", emoji: "🦂", name: "Паук", desc: "Нашел 5 багов" },
  IDEA_MASTER_1: { id: "idea_master_1", emoji: "💡", name: "Идейный", desc: "Предложил 1 идею" },
  IDEA_MASTER_5: { id: "idea_master_5", emoji: "✨", name: "Генератор", desc: "Предложил 5 идей" },
  GOOD_RATING: { id: "good_rating", emoji: "⭐", name: "Благодарный", desc: "Оставил оценку 5 звезд" },
  EARLY_ADOPTER: { id: "early_adopter", emoji: "🏆", name: "Первопроходец", desc: "Один из первых пользователей" },
  ACTIVE_WEEK: { id: "active_week", emoji: "📅", name: "Неделька", desc: "Активен 7 дней подряд" }
};

// ==========================================
// 4. TELEGRAM API WRAPPER
// ==========================================

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

/**
 * Базовая функция отправки запроса к Telegram API
 * @param {string} method - Метод API
 * @param {object} body - Тело запроса
 * @returns {Promise<object>} Ответ от Telegram
 */
async function telegramRequest(method, body = {}) {
  try {
    const response = await fetch(`${TG_API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    
    if (!data.ok) {
      console.error(`[TG API ERROR] ${method}:`, JSON.stringify(data));
    }
    
    return data;
  } catch (error) {
    console.error(`[TG NETWORK ERROR] ${method}:`, error.message);
    return { ok: false, error: error.message };
  }
}

/**
 * Отправка текстового сообщения
 */
async function sendTextMessage(chatId, text, extra = {}) {
  // Обрезаем слишком длинные сообщения
  if (text && text.length > MAX_MESSAGE_LENGTH) {
    text = text.substring(0, MAX_MESSAGE_LENGTH - 3) + "...";
  }
  
  return telegramRequest("sendMessage", {
    chat_id: chatId,
    text: text,
    disable_web_page_preview: true,
    parse_mode: "HTML",
    ...extra,
  });
}

/**
 * Отправка сообщения с инлайн-клавиатурой
 */
async function sendInlineMessage(chatId, text, inlineKeyboard, extra = {}) {
  return telegramRequest("sendMessage", {
    chat_id: chatId,
    text: text,
    reply_markup: { inline_keyboard: inlineKeyboard },
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

/**
 * Редактирование текста сообщения
 */
async function editMessageText(chatId, messageId, text, extra = {}) {
  return telegramRequest("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

/**
 * Редактирование клавиатуры сообщения
 */
async function editMessageReplyMarkup(chatId, messageId, inlineKeyboard) {
  return telegramRequest("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

/**
 * Ответ на callback query (убирает часики загрузки)
 */
async function answerCallbackQuery(callbackQueryId, text = "", showAlert = false) {
  return telegramRequest("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text,
    show_alert: showAlert,
  });
}

/**
 * Копирование сообщения
 */
async function copyMessage(toChatId, fromChatId, messageId, extra = {}) {
  return telegramRequest("copyMessage", {
    chat_id: toChatId,
    from_chat_id: fromChatId,
    message_id: messageId,
    ...extra,
  });
}

/**
 * Удаление сообщения
 */
async function deleteMessage(chatId, messageId) {
  return telegramRequest("deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
}

/**
 * Отправка документа
 */
async function sendDocumentMessage(chatId, document, caption = "", extra = {}) {
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("document", document);
  if (caption) formData.append("caption", caption);
  formData.append("parse_mode", "HTML");
  
  try {
    const response = await fetch(`${TG_API}/sendDocument`, {
      method: "POST",
      body: formData,
    });
    return await response.json();
  } catch (error) {
    console.error("[Send Document Error]", error.message);
    return { ok: false, error: error.message };
  }
}

// ==========================================
// 5. KV DATABASE WRAPPERS
// ==========================================

/**
 * Получение значения из KV
 */
async function kvGet(key) {
  try {
    if (kv) {
      return await kv.get(key);
    }
    // Имитация для локальной разработки
    console.log(`[KV GET] ${key}`);
    return null;
  } catch (error) {
    console.error(`[KV GET ERROR] ${key}:`, error.message);
    return null;
  }
}

/**
 * Установка значения в KV
 */
async function kvSet(key, value, options = {}) {
  try {
    if (kv) {
      if (options.ex) {
        return await kv.set(key, value, { ex: options.ex });
      }
      return await kv.set(key, value);
    }
    console.log(`[KV SET] ${key}`);
    return true;
  } catch (error) {
    console.error(`[KV SET ERROR] ${key}:`, error.message);
    return false;
  }
}

/**
 * Удаление значения из KV
 */
async function kvDel(key) {
  try {
    if (kv) {
      return await kv.del(key);
    }
    console.log(`[KV DEL] ${key}`);
    return true;
  } catch (error) {
    console.error(`[KV DEL ERROR] ${key}:`, error.message);
    return false;
  }
}

/**
 * Добавление в Set
 */
async function kvSadd(key, member) {
  try {
    if (kv) {
      return await kv.sadd(key, member);
    }
    console.log(`[KV SADD] ${key} <- ${member}`);
    return true;
  } catch (error) {
    console.error(`[KV SADD ERROR]`, error.message);
    return false;
  }
}

/**
 * Получение всех членов Set
 */
async function kvSmembers(key) {
  try {
    if (kv) {
      return await kv.smembers(key) || [];
    }
    console.log(`[KV SMEMBERS] ${key}`);
    return [];
  } catch (error) {
    console.error(`[KV SMEMBERS ERROR]`, error.message);
    return [];
  }
}

/**
 * Удаление из Set
 */
async function kvSrem(key, member) {
  try {
    if (kv) {
      return await kv.srem(key, member);
    }
    console.log(`[KV SREM] ${key} -> ${member}`);
    return true;
  } catch (error) {
    console.error(`[KV SREM ERROR]`, error.message);
    return false;
  }
}

/**
 * Получение всех ключей по паттерну
 */
async function kvKeys(pattern) {
  try {
    if (kv) {
      return await kv.keys(pattern) || [];
    }
    console.log(`[KV KEYS] ${pattern}`);
    return [];
  } catch (error) {
    console.error(`[KV KEYS ERROR]`, error.message);
    return [];
  }
}

// ==========================================
// 6. УТИЛИТЫ И ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================

/**
 * Генерирует случайный ID тикета (например, XXjkj)
 */
function generateRandomTicketId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let result = "";
  for (let i = 0; i < 5; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Генерирует уникальный ID тикета с префиксом
 */
function generateTicketId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `TCK-${timestamp}-${random}`.toUpperCase();
}

/**
 * Форматирует дату в читаемый вид
 */
function formatDateTime(timestamp) {
  if (!timestamp) return "Неизвестно";
  const date = new Date(timestamp);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
}

/**
 * Форматирует время в "X минут назад"
 */
function timeAgo(timestamp) {
  if (!timestamp) return "Неизвестно";
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  
  if (seconds < 60) return "только что";
  
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин. назад`;
  
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч. назад`;
  
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} дн. назад`;
  
  const months = Math.floor(days / 30);
  return `${months} мес. назад`;
}

/**
 * Экранирует HTML-символы
 */
function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Генерирует случайное число в диапазоне
 */
function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Проверяет валидность ID пользователя
 */
function isValidUserId(userId) {
  return /^\d+$/.test(String(userId)) && String(userId).length > 5;
}

/**
 * Парсит команду с аргументами
 */
function parseCommand(text) {
  const parts = text.trim().split(/\s+/);
  return {
    command: parts[0].toLowerCase(),
    args: parts.slice(1)
  };
}

/**
 * Безопасное получение имени пользователя
 */
function getSafeUserName(user) {
  if (!user) return "Неизвестный";
  if (user.username) return `@${user.username}`;
  if (user.first_name || user.last_name) {
    return `${user.first_name || ""} ${user.last_name || ""}`.trim();
  }
  return `User_${user.id}`;
}

// ==========================================
// 7. УПРАВЛЕНИЕ АДМИНИСТРАТОРАМИ
// ==========================================

/**
 * Загружает список админов из KV
 */
async function loadAdminIds() {
  try {
    const storedAdmins = await kvGet("helper:admin_ids");
    if (storedAdmins && Array.isArray(storedAdmins)) {
      ADMIN_IDS = [...new Set([...BASE_ADMIN_IDS, ...storedAdmins])];
    } else {
      ADMIN_IDS = [...BASE_ADMIN_IDS];
    }
    return ADMIN_IDS;
  } catch (error) {
    console.error("[LOAD ADMINS ERROR]", error.message);
    return BASE_ADMIN_IDS;
  }
}

/**
 * Сохраняет список админов в KV
 */
async function saveAdminIds() {
  try {
    await kvSet("helper:admin_ids", ADMIN_IDS);
    return true;
  } catch (error) {
    console.error("[SAVE ADMINS ERROR]", error.message);
    return false;
  }
}

/**
 * Проверяет, является ли пользователь администратором
 */
function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

/**
 * Проверяет, является ли пользователь ГЛАВНЫМ администратором
 */
function isMainAdmin(userId) {
  return String(userId) === MAIN_ADMIN_ID;
}

/**
 * Добавляет нового админа
 */
async function addAdmin(executorId, newAdminId) {
  const executor = String(executorId);
  const newAdmin = String(newAdminId);
  
  // Только админы могут добавлять админов
  if (!isAdmin(executor)) {
    return { success: false, message: "❌ Только администраторы могут добавлять новых админов." };
  }
  
  // Проверка валидности ID
  if (!isValidUserId(newAdmin)) {
    return { success: false, message: "❌ Некорректный ID пользователя." };
  }
  
  // Проверка, что уже не админ
  if (ADMIN_IDS.includes(newAdmin)) {
    return { success: false, message: "❌ Этот пользователь уже является администратором." };
  }
  
  // Добавляем в список
  ADMIN_IDS.push(newAdmin);
  await saveAdminIds();
  
  // Логируем
  await logAdminAction(executor, "ADD_ADMIN", newAdmin, `Добавлен новый админ`);
  
  // Уведомляем нового админа
  await sendTextMessage(
    newAdmin,
    `🎉 <b>Поздравляем!</b>\n\nВы были назначены администратором системы Helper.\n\n` +
    `Ваши права:\n` +
    `• Просмотр тикетов\n` +
    `• Ответы на тикеты\n` +
    `• Модерация пользователей\n\n` +
    `Используйте /start для доступа к панели администратора.`
  );
  
  // Уведомляем главного админа
  await sendTextMessage(
    MAIN_ADMIN_ID,
    `⚠️ <b>Уведомление о новом админе</b>\n\n` +
    `Админ <code>${executor}</code> добавил нового админа: <code>${newAdmin}</code>`
  );
  
  return { success: true, message: `✅ Пользователь ${newAdmin} добавлен в список администраторов.` };
}

/**
 * Удаляет админа (ТОЛЬКО ГЛАВНЫЙ АДМИН)
 */
async function removeAdmin(executorId, targetAdminId) {
  const executor = String(executorId);
  const target = String(targetAdminId);
  
  // Только главный админ может удалять
  if (!isMainAdmin(executor)) {
    return { success: false, message: "❌ Только ГЛАВНЫЙ администратор может удалять администраторов." };
  }
  
  // Нельзя удалить главного админа
  if (target === MAIN_ADMIN_ID) {
    return { success: false, message: "❌ Невозможно удалить главного администратора." };
  }
  
  // Проверка, что это админ
  if (!ADMIN_IDS.includes(target)) {
    return { success: false, message: "❌ Этот пользователь не является администратором." };
  }
  
  // Удаляем из списка
  ADMIN_IDS = ADMIN_IDS.filter(id => id !== target);
  await saveAdminIds();
  
  // Логируем
  await logAdminAction(executor, "REMOVE_ADMIN", target, `Удален админ`);
  
  // Уведомляем удаленного админа
  await sendTextMessage(
    target,
    `⚠️ <b>Вы были лишены прав администратора</b> в системе Helper.\n\n` +
    `Решение принято главным администратором.`
  );
  
  return { success: true, message: `✅ Администратор ${target} успешно удален.` };
}

// ==========================================
// 8. СИСТЕМА МОДЕРАЦИИ
// ==========================================

/**
 * Проверяет, забанен ли пользователь
 */
async function isUserBanned(userId) {
  const banData = await kvGet(`helper:ban:${userId}`);
  return banData !== null;
}

/**
 * Проверяет, замьючен ли пользователь
 */
async function isUserMuted(userId) {
  const muteData = await kvGet(`helper:mute:${userId}`);
  if (!muteData) return false;
  
  // Проверяем срок мута
  if (muteData.expiresAt && Date.now() > muteData.expiresAt) {
    await kvDel(`helper:mute:${userId}`);
    return false;
  }
  
  return true;
}

/**
 * Банит пользователя
 */
async function banUser(executorId, targetUserId, reason) {
  const executor = String(executorId);
  const target = String(targetUserId);
  
  // Админ не может забанить себя
  if (executor === target) {
    return { success: false, message: "❌ Вы не можете забанить самого себя." };
  }
  
  // Обычный админ не может забанить главного админа
  if (target === MAIN_ADMIN_ID && executor !== MAIN_ADMIN_ID) {
    return { success: false, message: "❌ У вас недостаточно прав для этого действия." };
  }
  
  // Обычный админ не может забанить другого админа
  if (isAdmin(target) && executor !== MAIN_ADMIN_ID) {
    return { success: false, message: "❌ Только главный админ может банить других администраторов." };
  }
  
  // Сохраняем бан
  await kvSet(`helper:ban:${target}`, {
    by: executor,
    reason: reason || "Не указана",
    timestamp: Date.now()
  });
  
  // Добавляем в общий список забаненных
  await kvSadd("helper:banned_users", target);
  
  // Логируем
  await logAdminAction(executor, "BAN", target, reason || "Не указана");
  
  // Уведомляем пользователя
  await sendTextMessage(
    target,
    `❌ <b>Вы были заблокированы в системе Helper.</b>\n\n` +
    `📝 <b>Причина:</b> ${escapeHtml(reason || "Не указана")}\n` +
    `👨‍💻 <b>Администратор:</b> <code>${executor}</code>\n` +
    `🕒 <b>Время:</b> ${formatDateTime(Date.now())}`
  );
  
  return { success: true, message: `✅ Пользователь ${target} успешно забанен.\nПричина: ${reason || "Не указана"}` };
}

/**
 * Разбанивает пользователя
 */
async function unbanUser(executorId, targetUserId) {
  const executor = String(executorId);
  const target = String(targetUserId);
  
  if (!isAdmin(executor)) {
    return { success: false, message: "❌ Недостаточно прав." };
  }
  
  const banData = await kvGet(`helper:ban:${target}`);
  if (!banData) {
    return { success: false, message: "❌ Этот пользователь не забанен." };
  }
  
  await kvDel(`helper:ban:${target}`);
  await kvSrem("helper:banned_users", target);
  
  await logAdminAction(executor, "UNBAN", target, "Разбанен");
  
  await sendTextMessage(
    target,
    `✅ <b>Вы были разблокированы в системе Helper.</b>\n\n` +
    `Теперь вы снова можете использовать бота.`
  );
  
  return { success: true, message: `✅ Пользователь ${target} разбанен.` };
}

/**
 * Мутит пользователя
 */
async function muteUser(executorId, targetUserId, reason, durationMs = 24 * 60 * 60 * 1000) {
  const executor = String(executorId);
  const target = String(targetUserId);
  
  // Админ не может замьютить себя
  if (executor === target) {
    return { success: false, message: "❌ Вы не можете замьютить самого себя." };
  }
  
  // Обычный админ не может замьютить другого админа
  if (isAdmin(target) && executor !== MAIN_ADMIN_ID) {
    return { success: false, message: "❌ Только главный админ может мутить других администраторов." };
  }
  
  await kvSet(`helper:mute:${target}`, {
    by: executor,
    reason: reason || "Не указана",
    timestamp: Date.now(),
    expiresAt: Date.now() + durationMs
  });
  
  await kvSadd("helper:muted_users", target);
  
  await logAdminAction(executor, "MUTE", target, reason || "Не указана");
  
  await sendTextMessage(
    target,
    `🔇 <b>Вы были ограничены в правах (мут) в системе Helper.</b>\n\n` +
    `📝 <b>Причина:</b> ${escapeHtml(reason || "Не указана")}\n` +
    `⏱️ <b>Длительность:</b> ${Math.round(durationMs / 60000)} минут\n` +
    `👨‍💻 <b>Администратор:</b> <code>${executor}</code>`
  );
  
  return { success: true, message: `✅ Пользователь ${target} замьючен на ${Math.round(durationMs / 60000)} минут.` };
}

/**
 * Размьючивает пользователя
 */
async function unmuteUser(executorId, targetUserId) {
  const executor = String(executorId);
  const target = String(targetUserId);
  
  if (!isAdmin(executor)) {
    return { success: false, message: "❌ Недостаточно прав." };
  }
  
  const muteData = await kvGet(`helper:mute:${target}`);
  if (!muteData) {
    return { success: false, message: "❌ Этот пользователь не замьючен." };
  }
  
  await kvDel(`helper:mute:${target}`);
  await kvSrem("helper:muted_users", target);
  
  await logAdminAction(executor, "UNMUTE", target, "Размьючен");
  
  await sendTextMessage(
    target,
    `🔊 <b>Ваш мут был снят в системе Helper.</b>\n\n` +
    `Теперь вы снова можете отправлять сообщения.`
  );
  
  return { success: true, message: `✅ Пользователь ${target} размьючен.` };
}

// ==========================================
// 9. СИСТЕМА ЛОГИРОВАНИЯ
// ==========================================

/**
 * Логирует действие администратора
 */
async function logAdminAction(adminId, action, targetId, details) {
  const logEntry = {
    adminId: String(adminId),
    action: action,
    targetId: String(targetId),
    details: details,
    timestamp: Date.now()
  };
  
  console.log("[ADMIN LOG]", JSON.stringify(logEntry));
  
  // Сохраняем в KV (последние 100 записей)
  try {
    const logs = await kvGet(`helper:logs:${adminId}`) || [];
    logs.unshift(logEntry);
    if (logs.length > 100) logs.pop();
    await kvSet(`helper:logs:${adminId}`, logs);
  } catch (e) {
    console.error("[LOG SAVE ERROR]", e.message);
  }
  
  // Отправляем в канал логирования
  if (LOG_CHANNEL_ID) {
    await sendTextMessage(
      LOG_CHANNEL_ID,
      `📋 <b>Действие администратора</b>\n\n` +
      `👨‍💻 <b>Админ:</b> <code>${adminId}</code>\n` +
      `🎯 <b>Действие:</b> ${action}\n` +
      `👤 <b>Цель:</b> <code>${targetId}</code>\n` +
      `📝 <b>Детали:</b> ${escapeHtml(details)}\n` +
      `🕒 <b>Время:</b> ${formatDateTime(Date.now())}`
    );
  }
}

/**
 * Логирует действие пользователя
 */
async function logUserAction(userId, action, details) {
  const logEntry = {
    userId: String(userId),
    action: action,
    details: details,
    timestamp: Date.now()
  };
  
  console.log("[USER LOG]", JSON.stringify(logEntry));
  
  try {
    const logs = await kvGet(`helper:user_logs:${userId}`) || [];
    logs.unshift(logEntry);
    if (logs.length > 50) logs.pop();
    await kvSet(`helper:user_logs:${userId}`, logs);
  } catch (e) {
    console.error("[USER LOG SAVE ERROR]", e.message);
  }
}

// ==========================================
// 10. RATE LIMITING (ЗАЩИТА ОТ СПАМА)
// ==========================================

/**
 * Проверяет лимит запросов
 */
async function checkRateLimit(userId, action, maxRequests = 5, windowMs = 60000) {
  const key = `helper:rate:${userId}:${action}`;
  const now = Date.now();
  
  try {
    let data = await kvGet(key);
    
    if (!data || now - data.startTime > windowMs) {
      // Новое окно
      data = { count: 1, startTime: now };
      await kvSet(key, data, { ex: Math.ceil(windowMs / 1000) });
      return true;
    }
    
    if (data.count >= maxRequests) {
      return false; // Лимит превышен
    }
    
    data.count++;
    await kvSet(key, data, { ex: Math.ceil(windowMs / 1000) });
    return true;
  } catch (error) {
    console.error("[RATE LIMIT ERROR]", error.message);
    return true; // При ошибке пропускаем
  }
}

// ==========================================
// 11. СИСТЕМА БЕЙДЖЕВ
// ==========================================

/**
 * Выдает бейдж пользователю
 */
async function awardBadge(userId, badgeId) {
  try {
    const userBadges = await kvGet(`helper:badges:${userId}`) || [];
    
    if (userBadges.includes(badgeId)) {
      return false; // Уже есть
    }
    
    userBadges.push(badgeId);
    await kvSet(`helper:badges:${userId}`, userBadges);
    
    const badge = BADGES[badgeId];
    if (badge) {
      await sendTextMessage(
        userId,
        `🏆 <b>Поздравляем!</b>\n\n` +
        `Вы получили новый бейдж: ${badge.emoji} <b>${badge.name}</b>\n` +
        `<i>${badge.desc}</i>`
      );
    }
    
    return true;
  } catch (error) {
    console.error("[AWARD BADGE ERROR]", error.message);
    return false;
  }
}

/**
 * Получает все бейджи пользователя
 */
async function getUserBadges(userId) {
  try {
    const badgeIds = await kvGet(`helper:badges:${userId}`) || [];
    return badgeIds.map(id => BADGES[id]).filter(Boolean);
  } catch (error) {
    console.error("[GET BADGES ERROR]", error.message);
    return [];
  }
}

/**
 * Проверяет и выдает бейджи за активность
 */
async function checkAndAwardBadges(userId, category) {
  try {
    const userStats = await kvGet(`helper:user_stats:${userId}`) || {
      ticketsCreated: 0,
      bugsReported: 0,
      ideasSubmitted: 0
    };
    
    // Обновляем статистику
    userStats.ticketsCreated++;
    if (category === "bug") userStats.bugsReported++;
    if (category === "idea") userStats.ideasSubmitted++;
    
    await kvSet(`helper:user_stats:${userId}`, userStats);
    
    // Проверяем бейджи
    if (userStats.ticketsCreated >= 1) await awardBadge(userId, "FIRST_TICKET");
    if (userStats.ticketsCreated >= 5) await awardBadge(userId, "TICKET_MASTER_5");
    if (userStats.ticketsCreated >= 10) await awardBadge(userId, "TICKET_MASTER_10");
    if (userStats.bugsReported >= 1) await awardBadge(userId, "BUG_HUNTER_1");
    if (userStats.bugsReported >= 5) await awardBadge(userId, "BUG_HUNTER_5");
    if (userStats.ideasSubmitted >= 1) await awardBadge(userId, "IDEA_MASTER_1");
    if (userStats.ideasSubmitted >= 5) await awardBadge(userId, "IDEA_MASTER_5");
  } catch (error) {
    console.error("[CHECK BADGES ERROR]", error.message);
  }
}

// ==========================================
// 12. LIVE MODE (ПРЯМОЙ ДИАЛОГ)
// ==========================================

/**
 * Обновляет время последней активности админа
 */
async function updateAdminLastSeen(adminId) {
  if (!isAdmin(adminId)) return;
  const key = `helper:admin_last_seen:${adminId}`;
  await kvSet(key, Date.now(), { ex: 86400 });
}

/**
 * Проверяет, активен ли админ
 */
async function isAdminActive(adminId) {
  const key = `helper:admin_last_seen:${adminId}`;
  const lastSeen = await kvGet(key);
  if (!lastSeen) return false;
  const timeDiff = Date.now() - parseInt(lastSeen);
  return timeDiff <= LIVE_MODE_TIMEOUT_MS;
}

/**
 * Находит первого активного админа
 */
async function findActiveAdminForLiveMode() {
  for (const adminId of ADMIN_IDS) {
    const isActive = await isAdminActive(adminId);
    if (isActive) {
      return adminId;
    }
  }
  return null;
}

/**
 * Инициирует Live Mode
 */
async function startLiveMode(userId, userName) {
  if (isAdmin(userId)) {
    await sendTextMessage(userId, "❌ Администраторы не могут использовать Live Mode как пользователи.");
    return;
  }
  
  if (await isUserBanned(userId)) {
    await sendTextMessage(userId, "🚫 Вы заблокированы и не можете использовать Live Mode.");
    return;
  }
  
  if (await isUserMuted(userId)) {
    await sendTextMessage(userId, "🔇 Вы замьючены и не можете использовать Live Mode.");
    return;
  }
  
  // Проверяем rate limit
  const canProceed = await checkRateLimit(userId, "live_mode", 3, 300000); // 3 раза в 5 минут
  if (!canProceed) {
    await sendTextMessage(userId, "⏳ Слишком много запросов. Пожалуйста, подождите 5 минут.");
    return;
  }
  
  await sendTextMessage(userId, "⏳ <b>Поиск свободного администратора...</b>\n\nМы ищем админа, который был в сети менее 10.5 минут назад.");
  
  const activeAdminId = await findActiveAdminForLiveMode();
  
  if (!activeAdminId) {
    await sendTextMessage(
      userId,
      "😔 <b>К сожалению, сейчас нет свободных администраторов.</b>\n\n" +
      "Все админы заняты или были в сети более 10.5 минут назад.\n\n" +
      "Пожалуйста, создайте обычный тикет или попробуйте позже."
    );
    return;
  }
  
  // Создаем сессию Live Mode
  const sessionData = {
    userId: String(userId),
    userName: userName,
    adminId: activeAdminId,
    startTime: Date.now(),
    status: "active",
    ratingGiven: false,
    messages: []
  };
  
  await kvSet(`helper:live_session:${userId}`, sessionData);
  await kvSet(`helper:live_session_admin:${activeAdminId}`, sessionData);
  
await sendInlineMessage(
  userId,
  `✅ <b>Live Mode активирован!</b>\n\n` +
  `Вы подключены к администратору.\n` +
  `Теперь вы можете писать сообщения напрямую.\n\n` +
  `Для завершения диалога нажмите кнопку ниже или используйте /endlive`,
  [[{ text: "🔚 Завершить диалог", callback_data: "live_end_by_user" }]]
);
  
await sendInlineMessage(
  activeAdminId,
  `🔴 <b>ВХОДЯЩИЙ LIVE ЗАПРОС</b>\n\n` +
  `👤 <b>Пользователь:</b> ${escapeHtml(userName)}\n` +
  `🆔 <b>ID:</b> <code>${userId}</code>\n\n` +
  `Напишите сообщение, чтобы ответить.\n` +
  `Используйте /endlive для завершения диалога.`,
  [[{ text: "🔚 Завершить диалог", callback_data: `live_end_by_admin_${userId}` }]]
);
  
  // Логируем
  await logUserAction(userId, "LIVE_MODE_START", `Подключен к админу ${activeAdminId}`);
}

/**
 * Обрабатывает сообщение в Live Mode
 * ВАЖНО: команды (текст начинающийся с "/") НЕ перехватываются,
 * чтобы пользователь/админ могли использовать /endlive
 */
async function handleLiveModeMessage(senderId, text, isFromAdmin) {
  // 🔥 КРИТИЧНО: Не перехватываем команды — пусть их обрабатывает processTextMessage
  if (typeof text === "string" && text.trim().startsWith("/")) {
    return false;
  }
  
  let sessionData = null;
  let otherPartyId = null;
  
  if (isFromAdmin) {
    sessionData = await kvGet(`helper:live_session_admin:${senderId}`);
    if (sessionData && sessionData.status === "active") {
      otherPartyId = sessionData.userId;
    }
  } else {
    sessionData = await kvGet(`helper:live_session:${senderId}`);
    if (sessionData && sessionData.status === "active") {
      otherPartyId = sessionData.adminId;
    }
  }
  
  if (!sessionData || sessionData.status !== "active") {
    return false;
  }
  
  // Обновляем время активности админа
  if (isFromAdmin) {
    await updateAdminLastSeen(senderId);
  }
  
  // Добавляем сообщение в историю
  sessionData.messages.push({
    from: isFromAdmin ? "admin" : "user",
    text: text,
    timestamp: Date.now()
  });
  
  // Сохраняем сессию
  await kvSet(`helper:live_session:${sessionData.userId}`, sessionData);
  if (isFromAdmin) {
    await kvSet(`helper:live_session_admin:${senderId}`, sessionData);
  }
  
  // Пересылаем сообщение другой стороне
  const prefix = isFromAdmin ? "👨‍💻 <b>Администратор:</b>\n" : "👤 <b>Пользователь:</b>\n";
  await sendTextMessage(otherPartyId, `${prefix}${escapeHtml(text)}`);
  
  return true;
}

/**
 * Завершает Live Mode ПО ИНИЦИАТИВЕ АДМИНА и запрашивает оценку
 */
async function endLiveMode(adminId, userId) {
  const sessionData = await kvGet(`helper:live_session:${userId}`);
  
  if (!sessionData || sessionData.adminId !== String(adminId)) {
    await sendTextMessage(adminId, "❌ Активная сессия с этим пользователем не найдена.");
    return;
  }
  
  // ⚠️ Защита от повторного вызова
  if (sessionData.status !== "active") {
    await sendTextMessage(adminId, "⚠️ Эта сессия уже завершена.");
    return;
  }
  
  sessionData.status = "ended";
  sessionData.endTime = Date.now();
  
  await kvSet(`helper:live_session:${userId}`, sessionData);
  await kvDel(`helper:live_session_admin:${adminId}`);
  
  await sendTextMessage(
    userId,
    "🔚 <b>Диалог завершён администратором.</b>\n\n" +
    "Пожалуйста, оцените работу администратора.\n" +
    "Отправьте оценку от 0 до 5 (например: <code>5</code> или <code>4.5</code>).\n" +
    "Можно добавить комментарий через пробел.\n\n" +
    "Пример: <code>5 Отличная помощь!</code>"
  );
  
  await sendTextMessage(
    adminId,
    `✅ Live Mode с пользователем ${sessionData.userName} завершён.\nОжидание оценки пользователя...`
  );
  
  await logUserAction(userId, "LIVE_MODE_END", `Диалог с админом ${adminId} завершён`);
}

/**
 * Завершает Live Mode ПО ИНИЦИАТИВЕ ПОЛЬЗОВАТЕЛЯ
 * (пользователь не может «оценить админа» пока админ не закончит,
 *  поэтому при выходе пользователя мы просто закрываем сессию)
 */
async function endLiveModeByUser(userId) {
  const sessionData = await kvGet(`helper:live_session:${userId}`);
  
  if (!sessionData || sessionData.status !== "active") {
    await sendTextMessage(userId, "❌ У вас нет активного Live Mode диалога.");
    return;
  }
  
  sessionData.status = "ended_by_user";
  sessionData.endTime = Date.now();
  
  await kvSet(`helper:live_session:${userId}`, sessionData);
  await kvDel(`helper:live_session_admin:${sessionData.adminId}`);
  
  // Уведомляем админа
  await sendTextMessage(
    sessionData.adminId,
    `🔚 <b>Пользователь ${escapeHtml(sessionData.userName)} (<code>${userId}</code>) завершил Live Mode.</b>\n\n` +
    `Сессия закрыта.`
  );
  
  // Уведомляем пользователя
  await sendTextMessage(
    userId,
    "🔚 <b>Вы вышли из Live Mode.</b>\n\n" +
    "Диалог с администратором завершён.\n" +
    "Если нужна помощь — создайте новый тикет через /ticket."
  );
  
  // Логируем
  await logUserAction(userId, "LIVE_MODE_END_BY_USER", `Пользователь завершил сессию с админом ${sessionData.adminId}`);
}

// ==========================================
// 13. СИСТЕМА ОЦЕНИВАНИЯ
// ==========================================

/**
 * Обрабатывает оценку администратора
 * 🔥 ФИКС: после оценки сессия УДАЛЯЕТСЯ, чтобы не было повторных срабатываний
 */
async function handleRatingSubmission(userId, ratingText) {
  // Проверяем Live Mode сессию
  const liveSession = await kvGet(`helper:live_session:${userId}`);
  
  // Проверяем сессию оценки тикета
  const ratingSession = await kvGet(`helper:rating_session:${userId}`);
  
  // 🔥 Выбираем активную сессию
  let session = null;
  let sessionKey = null;
  
  if (ratingSession && ratingSession.status === "awaiting_rating") {
    session = ratingSession;
    sessionKey = `helper:rating_session:${userId}`;
  } else if (liveSession && liveSession.status === "ended" && !liveSession.ratingGiven) {
    session = liveSession;
    sessionKey = `helper:live_session:${userId}`;
  }
  
  if (!session || !sessionKey) {
    await sendTextMessage(userId, "❌ Сейчас нет активного запроса на оценку.");
    return;
  }
  
  // Парсим оценку и комментарий
  const parts = ratingText.trim().split(/\s+/);
  const ratingValue = parseFloat(parts[0]);
  const comment = parts.slice(1).join(" ") || "Без комментария";
  
  // Валидация оценки
  if (isNaN(ratingValue) || ratingValue < 0 || ratingValue > 5) {
    await sendTextMessage(
      userId,
      "❌ Некорректная оценка.\n\n" +
      "Пожалуйста, введите число от 0 до 5.\n" +
      "Пример: <code>5</code> или <code>4 Отличная работа</code>"
    );
    return;
  }
  
  // Сохраняем оценку
  const adminId = session.adminId || session.resolvedBy;
  
  if (!adminId) {
    await sendTextMessage(userId, "❌ Ошибка: не удалось определить администратора.");
    // 🔥 Удаляем битую сессию
    await kvDel(sessionKey);
    return;
  }
  
  // 🔥 ВАЖНО: удаляем сессию СРАЗУ, чтобы не было повторных вызовов
  await kvDel(sessionKey);
  
  // На всякий случай чистим связанные ключи
  if (liveSession) {
    await kvDel(`helper:live_session_admin:${liveSession.adminId}`);
  }
  
  // Сохраняем статистику админа
  const adminStatsKey = `helper:admin_stats:${adminId}`;
  let adminStats = await kvGet(adminStatsKey) || {
    totalRatings: 0,
    sumRatings: 0,
    comments: [],
    ticketsResolved: 0,
    liveSessions: 0
  };
  
  adminStats.totalRatings += 1;
  adminStats.sumRatings += ratingValue;
  adminStats.comments.push({
    userId: String(userId),
    rating: ratingValue,
    comment: comment,
    date: Date.now()
  });
  
  // Ограничиваем историю комментариев
  if (adminStats.comments.length > 50) {
    adminStats.comments = adminStats.comments.slice(-50);
  }
  
  await kvSet(adminStatsKey, adminStats);
  
  // Благодарим пользователя
  await sendTextMessage(
    userId,
    "✅ <b>Спасибо за вашу оценку!</b>\n\n" +
    "Ваш отзыв очень важен для улучшения качества нашей поддержки."
  );
  
  // Выдаем бейдж за хорошую оценку
  if (ratingValue >= 5) {
    await awardBadge(userId, "GOOD_RATING");
  }
  
  // Уведомляем админа
  const avgRating = (adminStats.sumRatings / adminStats.totalRatings).toFixed(1);
  await sendTextMessage(
    adminId,
    `⭐ <b>Получена новая оценка!</b>\n\n` +
    `📊 <b>Оценка:</b> ${ratingValue}/5\n` +
    `💬 <b>Комментарий:</b> ${escapeHtml(comment)}\n` +
    `👤 <b>От:</b> <code>${userId}</code>\n\n` +
    `📈 <b>Средний рейтинг:</b> ${avgRating} (всего оценок: ${adminStats.totalRatings})`
  );
  
  // Логируем
  await logUserAction(userId, "RATING_SUBMITTED", `Оценка ${ratingValue}/5 для админа ${adminId}`);
}

// ==========================================
// 14. СИСТЕМА ТИКЕТОВ
// ==========================================

/**
 * Инициализирует процесс создания тикета
 */
async function startTicketCreation(userId, userName) {
  // Админы не могут создавать тикеты
  if (isAdmin(userId)) {
    await sendTextMessage(
      userId,
      "❌ <b>Ошибка:</b> Администраторы не могут создавать тикеты.\n\n" +
      "Используйте панель администратора для управления существующими тикетами."
    );
    return;
  }
  
  // Проверка бана
  if (await isUserBanned(userId)) {
    await sendTextMessage(userId, "🚫 Вы заблокированы и не можете создавать тикеты.");
    return;
  }
  
  // Проверка мута
  if (await isUserMuted(userId)) {
    await sendTextMessage(userId, "🔇 Вы замьючены и не можете создавать тикеты.");
    return;
  }
  
  // Проверка rate limit
  const canProceed = await checkRateLimit(userId, "create_ticket", 5, 600000); // 5 тикетов в 10 минут
  if (!canProceed) {
    await sendTextMessage(
      userId,
      "⏳ <b>Слишком много запросов.</b>\n\n" +
      "Вы можете создавать не более 5 тикетов за 10 минут.\n" +
      "Пожалуйста, подождите."
    );
    return;
  }
  
  // Создаем начальное состояние
  const initialState = {
    step: 1,
    category: null,
    document: null,
    description: null,
    ticketName: null,
    targetAdmin: null,
    userId: String(userId),
    userName: userName,
    createdAt: Date.now()
  };
  
  await kvSet(`helper:ticket_state:${userId}`, initialState, { ex: 3600 }); // 1 час
  
  // Отправляем клавиатуру с категориями
  const keyboard = [
    [
      { text: TICKET_CATEGORIES.URGENT.label, callback_data: `ticket_cat_${TICKET_CATEGORIES.URGENT.id}` },
      { text: TICKET_CATEGORIES.BUG.label, callback_data: `ticket_cat_${TICKET_CATEGORIES.BUG.id}` }
    ],
    [
      { text: TICKET_CATEGORIES.IDEA.label, callback_data: `ticket_cat_${TICKET_CATEGORIES.IDEA.id}` },
      { text: TICKET_CATEGORIES.QUESTION.label, callback_data: `ticket_cat_${TICKET_CATEGORIES.QUESTION.id}` }
    ],
    [
      { text: TICKET_CATEGORIES.OTHER.label, callback_data: `ticket_cat_${TICKET_CATEGORIES.OTHER.id}` }
    ],
    [
      { text: "❌ Отмена", callback_data: "ticket_cancel" }
    ]
  ];
  
  await sendInlineMessage(
    userId,
    "📝 <b>Создание нового тикета</b>\n\n" +
    "<b>Шаг 1/5:</b> Выберите категорию вашего обращения:",
    keyboard
  );
  
  // Логируем
  await logUserAction(userId, "TICKET_START", "Начало создания тикета");
}

/**
 * Обрабатывает выбор категории
 */
async function handleTicketCategorySelection(userId, categoryId, callbackQueryId) {
  await answerCallbackQuery(callbackQueryId);
  
  const state = await kvGet(`helper:ticket_state:${userId}`);
  if (!state || state.step !== 1) {
    await sendTextMessage(userId, "❌ Сессия создания тикета истекла. Начните заново с /ticket");
    return;
  }
  
  // Валидация категории
  const validCategories = Object.values(TICKET_CATEGORIES).map(c => c.id);
  if (!validCategories.includes(categoryId)) {
    await sendTextMessage(userId, "❌ Некорректная категория. Попробуйте снова.");
    return;
  }
  
  state.category = categoryId;
  state.step = 2;
  await kvSet(`helper:ticket_state:${userId}`, state, { ex: 3600 });
  
  const categoryInfo = Object.values(TICKET_CATEGORIES).find(c => c.id === categoryId);
  
  await sendInlineMessage(
    userId,
    `✅ Категория: ${categoryInfo.label}\n\n` +
    `📎 <b>Шаг 2/5: Прикрепите документ</b>\n\n` +
    `Отправьте скриншот, лог или любой другой файл, относящийся к проблеме.\n\n` +
    `Если документа нет, нажмите кнопку ниже или отправьте /skip`,
    [[{ text: "⏭️ Пропустить (/skip)", callback_data: "ticket_skip_doc" }]]
  );
}

/**
 * Обрабатывает пропуск документа
 */
async function handleTicketSkipDocument(userId, callbackQueryId) {
  if (callbackQueryId) await answerCallbackQuery(callbackQueryId);
  
  const state = await kvGet(`helper:ticket_state:${userId}`);
  if (!state || state.step !== 2) return;
  
  state.document = "skipped";
  state.step = 3;
  await kvSet(`helper:ticket_state:${userId}`, state, { ex: 3600 });
  
  await sendTextMessage(
    userId,
    "⏭️ Документ пропущен.\n\n" +
    "✍️ <b>Шаг 3/5: Описание проблемы</b>\n\n" +
    "Пожалуйста, подробно опишите вашу проблему, идею или вопрос.\n" +
    "Чем подробнее вы опишите, тем быстрее мы сможем помочь."
  );
}

/**
 * Обрабатывает получение документа
 */
async function handleTicketDocumentUpload(userId, documentInfo) {
  const state = await kvGet(`helper:ticket_state:${userId}`);
  if (!state || state.step !== 2) return;
  
  state.document = documentInfo;
  state.step = 3;
  await kvSet(`helper:ticket_state:${userId}`, state, { ex: 3600 });
  
  await sendTextMessage(
    userId,
    "✅ Документ получен!\n\n" +
    "✍️ <b>Шаг 3/5: Описание проблемы</b>\n\n" +
    "Пожалуйста, подробно опишите вашу проблему, идею или вопрос."
  );
}

/**
 * Обрабатывает текстовое описание
 */
async function handleTicketDescription(userId, text) {
  const state = await kvGet(`helper:ticket_state:${userId}`);
  if (!state || state.step !== 3) return;
  
  // Валидация длины
  if (text.length < 10) {
    await sendTextMessage(
      userId,
      "❌ Описание слишком короткое.\n\n" +
      "Пожалуйста, опишите проблему более подробно (минимум 10 символов)."
    );
    return;
  }
  
  if (text.length > 2000) {
    text = text.substring(0, 2000) + "...";
  }
  
  state.description = text;
  state.step = 4;
  await kvSet(`helper:ticket_state:${userId}`, state, { ex: 3600 });
  
  await sendInlineMessage(
    userId,
    "✅ Описание сохранено!\n\n" +
    "🎯 <b>Шаг 4/5: Выберите кому адресовать тикет</b>\n\n" +
    "Вы можете отправить тикет конкретному администратору или обоим:",
    [
      [{ text: "👑 @greenkx (Главный админ)", callback_data: `ticket_target_${TARGET_ADMINS.GREENKX.id}` }],
      [{ text: "👨‍💻 @IT_20_77", callback_data: `ticket_target_${TARGET_ADMINS.IT_20_77.id}` }],
      [{ text: "👥 Обоим админам", callback_data: `ticket_target_${TARGET_ADMINS.BOTH.id}` }],
      [{ text: "❌ Отмена", callback_data: "ticket_cancel" }]
    ]
  );
}

/**
 * Обрабатывает выбор целевого админа
 */
async function handleTicketTargetSelection(userId, targetAdmin, callbackQueryId) {
  await answerCallbackQuery(callbackQueryId);
  
  const state = await kvGet(`helper:ticket_state:${userId}`);
  if (!state || state.step !== 4) return;
  
  state.targetAdmin = targetAdmin;
  state.step = 5;
  await kvSet(`helper:ticket_state:${userId}`, state, { ex: 3600 });
  
  await sendInlineMessage(
    userId,
    "🏷️ <b>Шаг 5/5: Название тикета</b>\n\n" +
    "Введите краткое название для вашего тикета.\n" +
    "Это поможет администраторам быстрее понять суть.\n\n" +
    "Если не хотите указывать, отправьте /skip\n" +
    "(система сгенерирует случайное название, например: XXjkj)",
    [[{ text: "🎲 Сгенерировать автоматически (/skip)", callback_data: "ticket_skip_name" }]]
  );
}

/**
 * Обрабатывает пропуск названия
 */
async function handleTicketSkipName(userId, callbackQueryId) {
  if (callbackQueryId) await answerCallbackQuery(callbackQueryId);
  
  const state = await kvGet(`helper:ticket_state:${userId}`);
  if (!state || state.step !== 5) return;
  
  state.ticketName = generateRandomTicketId();
  await finalizeTicketCreation(userId, state);
}

/**
 * Обрабатывает ввод названия тикета
 */
async function handleTicketNameInput(userId, text) {
  const state = await kvGet(`helper:ticket_state:${userId}`);
  if (!state || state.step !== 5) return;
  
  // Валидация длины
  if (text.length < 3) {
    await sendTextMessage(
      userId,
      "❌ Название слишком короткое (минимум 3 символа).\n\n" +
      "Попробуйте снова или отправьте /skip."
    );
    return;
  }
  
  state.ticketName = text.substring(0, 50);
  await finalizeTicketCreation(userId, state);
}

/**
 * Финализирует создание тикета
 */
async function finalizeTicketCreation(userId, state) {
  const ticketId = generateTicketId();
  
  // Формируем данные тикета
  const ticketData = {
    id: ticketId,
    userId: String(userId),
    userName: state.userName,
    category: state.category,
    document: state.document,
    description: state.description,
    ticketName: state.ticketName,
    targetAdmin: state.targetAdmin || TARGET_ADMINS.BOTH.id,
    status: TICKET_STATUSES.OPEN.id,
    priority: Object.values(TICKET_CATEGORIES).find(c => c.id === state.category)?.priority || 1,
    createdAt: state.createdAt,
    updatedAt: Date.now(),
    closedAt: null,
    rating: null,
    adminResponseReason: null,
    resolvedBy: null,
    resolvedAt: null
  };
  
  // Сохраняем тикет
  await kvSet(`helper:ticket:${ticketId}`, ticketData);
  await kvSadd("helper:all_tickets", ticketId);
  await kvSadd(`helper:user_tickets:${userId}`, ticketId);
  
  // Очищаем состояние
  await kvDel(`helper:ticket_state:${userId}`);
  
  // Проверяем и выдаем бейджи
  await checkAndAwardBadges(userId, state.category);
  
  // Формируем сообщение для админа
  const categoryInfo = Object.values(TICKET_CATEGORIES).find(c => c.id === state.category);
  const targetInfo = state.targetAdmin === TARGET_ADMINS.GREENKX.id ? TARGET_ADMINS.GREENKX :
                     state.targetAdmin === TARGET_ADMINS.IT_20_77.id ? TARGET_ADMINS.IT_20_77 :
                     TARGET_ADMINS.BOTH;
  
  const adminMessage = `
🎫 <b>НОВЫЙ ТИКЕТ</b>
━━━━━━━━━━━━━━━━━━━━━━━━━
🏷️ <b>Название:</b> ${escapeHtml(ticketData.ticketName)}
🆔 <b>ID:</b> <code>${ticketId}</code>
━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>От:</b> ${escapeHtml(state.userName)}
🆔 <b>User ID:</b> <code>${userId}</code>
🎯 <b>Кому:</b> ${targetInfo.emoji} ${targetInfo.label}
📂 <b>Категория:</b> ${categoryInfo.label}
📊 <b>Статус:</b> ${TICKET_STATUSES.OPEN.emoji} ${TICKET_STATUSES.OPEN.label}
⭐ <b>Приоритет:</b> ${ticketData.priority}/5
🕒 <b>Создан:</b> ${formatDateTime(ticketData.createdAt)}
━━━━━━━━━━━━━━━━━━━━━━━━━
📝 <b>Описание:</b>
${escapeHtml(ticketData.description)}
━━━━━━━━━━━━━━━━━━━━━━━━━
📎 <b>Документ:</b> ${state.document === "skipped" ? "Не прикреплен" : "✅ Прикреплен"}
`.trim();
  
  const adminKeyboard = [
    [
      { text: "✅ Взять в работу", callback_data: `ticket_take_${ticketId}` },
      { text: "❌ Отклонить", callback_data: `ticket_reject_${ticketId}` }
    ],
    [
      { text: "💬 Ответить (с причиной)", callback_data: `ticket_reply_${ticketId}` }
    ],
    [
      { text: "📋 Все тикеты", callback_data: "admin_all_tickets" }
    ]
  ];
  
  // Отправляем админам
  const targets = state.targetAdmin === TARGET_ADMINS.BOTH.id 
    ? [MAIN_ADMIN_ID, ADMIN_2_ID] 
    : [state.targetAdmin];
  
  for (const targetId of targets) {
    if (isAdmin(targetId)) {
      await sendInlineMessage(targetId, adminMessage, adminKeyboard);
    }
  }
  
  // Если был документ, отправляем его админам
  if (state.document && state.document !== "skipped") {
    for (const targetId of targets) {
      if (isAdmin(targetId)) {
        await copyMessage(targetId, userId, state.document);
      }
    }
  }
  
  // Уведомляем пользователя
  await sendTextMessage(
    userId,
    `✅ <b>Ваш тикет успешно отправлен!</b>\n\n` +
    `🆔 <b>ID тикета:</b> <code>${ticketId}</code>\n` +
    `🏷️ <b>Название:</b> ${escapeHtml(ticketData.ticketName)}\n` +
    `📂 <b>Категория:</b> ${categoryInfo.label}\n` +
    `🎯 <b>Отправлен:</b> ${targetInfo.label}\n\n` +
    `Ожидайте ответа от администрации.\n` +
    `Мы уведомим вас, как только ваше обращение будет рассмотрено.`
  );
  
  // Логируем
  await logUserAction(userId, "TICKET_CREATED", `Создан тикет ${ticketId}`);
}

/**
 * Показывает тикеты пользователя
 */
async function showUserTickets(userId) {
  const ticketIds = await kvSmembers(`helper:user_tickets:${userId}`);
  
  if (ticketIds.length === 0) {
    await sendTextMessage(userId, "📭 У вас пока нет созданных тикетов.");
    return;
  }
  
  let text = "📋 <b>Ваши тикеты:</b>\n\n";
  const keyboard = [];
  
  for (const ticketId of ticketIds.slice(-10)) {
    const ticket = await kvGet(`helper:ticket:${ticketId}`);
    if (ticket) {
      const status = Object.values(TICKET_STATUSES).find(s => s.id === ticket.status) || TICKET_STATUSES.OPEN;
      text += `${status.emoji} <b>${escapeHtml(ticket.ticketName)}</b>\n`;
      text += `   ID: <code>${ticketId}</code>\n`;
      text += `   Статус: ${status.label}\n`;
      text += `   Создан: ${formatDateTime(ticket.createdAt)}\n\n`;
      
      keyboard.push([{ text: `📄 ${ticket.ticketName.substring(0, 20)}`, callback_data: `view_ticket_${ticketId}` }]);
    }
  }
  
  keyboard.push([{ text: "⬅️ Назад", callback_data: "back_to_main" }]);
  
  await sendInlineMessage(userId, text, keyboard);
}

/**
 * Показывает детали тикета
 */
async function showTicketDetails(userId, ticketId, isAdminView = false) {
  const ticket = await kvGet(`helper:ticket:${ticketId}`);
  
  if (!ticket) {
    await sendTextMessage(userId, "❌ Тикет не найден.");
    return;
  }
  
  // Проверка доступа
  if (!isAdminView && String(ticket.userId) !== String(userId)) {
    await sendTextMessage(userId, "❌ У вас нет доступа к этому тикету.");
    return;
  }
  
  const categoryInfo = Object.values(TICKET_CATEGORIES).find(c => c.id === ticket.category);
  const statusInfo = Object.values(TICKET_STATUSES).find(s => s.id === ticket.status) || TICKET_STATUSES.OPEN;
  
  let text = `
🎫 <b>ТИКЕТ: ${escapeHtml(ticket.ticketName)}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 <b>ID:</b> <code>${ticket.id}</code>
📂 <b>Категория:</b> ${categoryInfo?.label || ticket.category}
📊 <b>Статус:</b> ${statusInfo.emoji} ${statusInfo.label}
⭐ <b>Приоритет:</b> ${ticket.priority || 1}/5
━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>От:</b> ${escapeHtml(ticket.userName)}
🆔 <b>User ID:</b> <code>${ticket.userId}</code>
🕒 <b>Создан:</b> ${formatDateTime(ticket.createdAt)}
${ticket.resolvedAt ? `✅ <b>Решен:</b> ${formatDateTime(ticket.resolvedAt)}\n` : ""}
${ticket.resolvedBy ? `👨‍💻 <b>Решил:</b> <code>${ticket.resolvedBy}</code>\n` : ""}
━━━━━━━━━━━━━━━━━━━━━━━━━
📝 <b>Описание:</b>
${escapeHtml(ticket.description)}
${ticket.adminResponseReason ? `
━━━━━━━━━━━━━━━━━━━━━━━━━
💬 <b>Ответ администрации:</b>
${escapeHtml(ticket.adminResponseReason)}
` : ""}
${ticket.rating ? `
━━━━━━━━━━━━━━━━━━━━━━━━━
⭐ <b>Оценка:</b> ${ticket.rating}/5
` : ""}
`.trim();
  
  const keyboard = [];
  
  if (isAdminView && ticket.status === TICKET_STATUSES.OPEN.id) {
    keyboard.push([
      { text: "✅ Взять в работу", callback_data: `ticket_take_${ticketId}` },
      { text: "❌ Отклонить", callback_data: `ticket_reject_${ticketId}` }
    ]);
    keyboard.push([{ text: "💬 Ответить", callback_data: `ticket_reply_${ticketId}` }]);
  }
  
  keyboard.push([{ text: "⬅️ Назад", callback_data: isAdminView ? "admin_all_tickets" : "my_tickets" }]);
  
  await sendInlineMessage(userId, text, keyboard);
}

/**
 * Обрабатывает ответ админа на тикет
 */
async function handleAdminTicketReply(adminId, ticketId, reasonText) {
  if (!isAdmin(adminId)) return;
  
  const ticket = await kvGet(`helper:ticket:${ticketId}`);
  
  if (!ticket) {
    await sendTextMessage(adminId, "❌ Тикет не найден.");
    return;
  }
  
  // Обязательное указание причины
  if (!reasonText || reasonText.trim().length < 5) {
    await sendTextMessage(
      adminId,
      "❌ <b>Ошибка:</b> Вы обязаны указать развернутую причину ответа.\n\n" +
      "Минимум 5 символов.\n\n" +
      "Используйте формат:\n" +
      `<code>/reply ${ticketId} Ваша причина ответа</code>`
    );
    return;
  }
  
  // Обновляем тикет
  ticket.status = TICKET_STATUSES.RESOLVED.id;
  ticket.adminResponseReason = reasonText;
  ticket.resolvedBy = String(adminId);
  ticket.resolvedAt = Date.now();
  ticket.updatedAt = Date.now();
  
  await kvSet(`helper:ticket:${ticketId}`, ticket);
  
  // Обновляем статистику админа
  const adminStatsKey = `helper:admin_stats:${adminId}`;
  let adminStats = await kvGet(adminStatsKey) || {
    totalRatings: 0,
    sumRatings: 0,
    comments: [],
    ticketsResolved: 0,
    liveSessions: 0
  };
  adminStats.ticketsResolved++;
  await kvSet(adminStatsKey, adminStats);
  
  // Отправляем ответ пользователю
  await sendInlineMessage(
    ticket.userId,
    `✅ <b>Ответ на ваш тикет</b>\n\n` +
    `🆔 <b>ID:</b> <code>${ticketId}</code>\n` +
    `🏷️ <b>Название:</b> ${escapeHtml(ticket.ticketName)}\n\n` +
    `💬 <b>Ответ администрации:</b>\n${escapeHtml(reasonText)}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Пожалуйста, оцените качество решения вашей проблемы.\n` +
    `Отправьте оценку от 0 до 5.\n\n` +
    `Пример: <code>5 Спасибо за помощь!</code>`,
    [
      [{ text: "⭐ Оценить 5", callback_data: `rate_ticket_${ticketId}_5` }],
      [{ text: "⭐ Оценить 4", callback_data: `rate_ticket_${ticketId}_4` }],
      [{ text: "⭐ Оценить 3", callback_data: `rate_ticket_${ticketId}_3` }],
      [{ text: "⭐ Оценить 2", callback_data: `rate_ticket_${ticketId}_2` }],
      [{ text: "⭐ Оценить 1", callback_data: `rate_ticket_${ticketId}_1` }]
    ]
  );
  
  // Создаем сессию для оценки
  await kvSet(`helper:rating_session:${ticket.userId}`, {
    ticketId: ticketId,
    adminId: String(adminId),
    status: "awaiting_rating",
    createdAt: Date.now()
  }, { ex: 86400 });
  
  await sendTextMessage(
    adminId,
    `✅ Ответ на тикет <code>${ticketId}</code> отправлен пользователю.\n\n` +
    `📝 Причина: ${escapeHtml(reasonText)}`
  );
  
  // Логируем
  await logAdminAction(adminId, "TICKET_REPLY", ticketId, reasonText);
}

/**
 * Показывает все тикеты для админа
 */
async function showAllTicketsForAdmin(adminId, filter = "all", page = 1) {
  if (!isAdmin(adminId)) return;
  
  const allTicketIds = await kvSmembers("helper:all_tickets");
  
  if (allTicketIds.length === 0) {
    await sendTextMessage(adminId, "📭 Тикетов пока нет.");
    return;
  }
  
  // Загружаем все тикеты
  const tickets = [];
  for (const id of allTicketIds) {
    const ticket = await kvGet(`helper:ticket:${id}`);
    if (ticket) {
      if (filter === "all" || ticket.status === filter) {
        tickets.push(ticket);
      }
    }
  }
  
  // Сортируем по дате создания (новые сверху)
  tickets.sort((a, b) => b.createdAt - a.createdAt);
  
  const itemsPerPage = 5;
  const totalPages = Math.ceil(tickets.length / itemsPerPage) || 1;
  const currentPage = Math.min(Math.max(1, page), totalPages);
  
  const startIdx = (currentPage - 1) * itemsPerPage;
  const pageTickets = tickets.slice(startIdx, startIdx + itemsPerPage);
  
  let text = `📋 <b>Все тикеты</b> (${tickets.length})\n`;
  text += `Фильтр: ${filter === "all" ? "Все" : Object.values(TICKET_STATUSES).find(s => s.id === filter)?.label || filter}\n`;
  text += `Страница ${currentPage}/${totalPages}\n\n`;
  
  const keyboard = [];
  
  for (const ticket of pageTickets) {
    const statusInfo = Object.values(TICKET_STATUSES).find(s => s.id === ticket.status) || TICKET_STATUSES.OPEN;
    const categoryInfo = Object.values(TICKET_CATEGORIES).find(c => c.id === ticket.category);
    
    text += `${statusInfo.emoji} <b>${escapeHtml(ticket.ticketName)}</b>\n`;
    text += `   ${categoryInfo?.emoji || "📌"} ${categoryInfo?.label || ticket.category}\n`;
    text += `   👤 ${escapeHtml(ticket.userName)}\n`;
    text += `   🕒 ${formatDateTime(ticket.createdAt)}\n\n`;
    
    keyboard.push([{ 
      text: `${statusInfo.emoji} ${ticket.ticketName.substring(0, 25)}`, 
      callback_data: `admin_view_ticket_${ticket.id}` 
    }]);
  }
  
  // Навигация
  const navRow = [];
  if (currentPage > 1) {
    navRow.push({ text: "⬅️", callback_data: `admin_tickets_page_${filter}_${currentPage - 1}` });
  }
  navRow.push({ text: `${currentPage}/${totalPages}`, callback_data: "ignore" });
  if (currentPage < totalPages) {
    navRow.push({ text: "➡️", callback_data: `admin_tickets_page_${filter}_${currentPage + 1}` });
  }
  if (navRow.length > 1) {
    keyboard.push(navRow);
  }
  
  // Фильтры
  keyboard.push([
    { text: "🔴 Открытые", callback_data: "admin_tickets_filter_open" },
    { text: "🟡 В работе", callback_data: "admin_tickets_filter_in_progress" }
  ]);
  keyboard.push([
    { text: "🟢 Решенные", callback_data: "admin_tickets_filter_resolved" },
    { text: "📋 Все", callback_data: "admin_tickets_filter_all" }
  ]);
  
  keyboard.push([{ text: "⬅️ Назад", callback_data: "admin_panel" }]);
  
  await sendInlineMessage(adminId, text, keyboard);
}

// ==========================================
// 15. СТАТИСТИКА И АНАЛИТИКА
// ==========================================

/**
 * Показывает статистику системы для админа
 */
async function showAdminStats(adminId) {
  if (!isAdmin(adminId)) return;
  
  // Собираем статистику
  const allTicketIds = await kvSmembers("helper:all_tickets");
  const bannedUsers = await kvSmembers("helper:banned_users");
  const mutedUsers = await kvSmembers("helper:muted_users");
  
  let openTickets = 0;
  let inProgressTickets = 0;
  let resolvedTickets = 0;
  let closedTickets = 0;
  let totalRating = 0;
  let ratingCount = 0;
  
  for (const id of allTicketIds) {
    const ticket = await kvGet(`helper:ticket:${id}`);
    if (ticket) {
      switch (ticket.status) {
        case TICKET_STATUSES.OPEN.id: openTickets++; break;
        case TICKET_STATUSES.IN_PROGRESS.id: inProgressTickets++; break;
        case TICKET_STATUSES.RESOLVED.id: resolvedTickets++; break;
        case TICKET_STATUSES.CLOSED.id: closedTickets++; break;
      }
      if (ticket.rating) {
        totalRating += ticket.rating;
        ratingCount++;
      }
    }
  }
  
  const avgRating = ratingCount > 0 ? (totalRating / ratingCount).toFixed(1) : "Нет оценок";
  
  // Статистика текущего админа
  const adminStats = await kvGet(`helper:admin_stats:${adminId}`) || {
    totalRatings: 0,
    sumRatings: 0,
    ticketsResolved: 0,
    liveSessions: 0
  };
  
  const adminAvgRating = adminStats.totalRatings > 0 
    ? (adminStats.sumRatings / adminStats.totalRatings).toFixed(1) 
    : "Нет оценок";
  
  const text = `
📊 <b>СТАТИСТИКА СИСТЕМЫ HELPER</b>
━━━━━━━━━━━━━━━━━━━━━━━━━

🎫 <b>ТИКЕТЫ:</b>
• Всего создано: ${allTicketIds.length}
• 🔴 Открытых: ${openTickets}
• 🟡 В работе: ${inProgressTickets}
• 🟢 Решенных: ${resolvedTickets}
• ⚫ Закрытых: ${closedTickets}
• ⭐ Средняя оценка: ${avgRating}

👥 <b>ПОЛЬЗОВАТЕЛИ:</b>
• 🚫 Забанено: ${bannedUsers.length}
• 🔇 Замьючено: ${mutedUsers.length}

👨‍💻 <b>АДМИНИСТРАТОРЫ:</b>
• Всего админов: ${ADMIN_IDS.length}
• 👑 Главный: @greenkx

📈 <b>ВАША СТАТИСТИКА:</b>
• Решено тикетов: ${adminStats.ticketsResolved}
• Live сессий: ${adminStats.liveSessions}
• Получено оценок: ${adminStats.totalRatings}
• Средний рейтинг: ${adminAvgRating}

🕒 <b>Обновлено:</b> ${formatDateTime(Date.now())}
━━━━━━━━━━━━━━━━━━━━━━━━━
`.trim();
  
  await sendInlineMessage(adminId, text, [
    [{ text: "🔄 Обновить", callback_data: "admin_stats" }],
    [{ text: "📋 Все тикеты", callback_data: "admin_all_tickets" }],
    [{ text: "⬅️ Назад", callback_data: "admin_panel" }]
  ]);
}

/**
 * Показывает профиль пользователя для админа
 */
async function showUserProfileForAdmin(adminId, targetUserId) {
  if (!isAdmin(adminId)) return;
  
  const user = await kvGet(`helper:user:${targetUserId}`);
  const userStats = await kvGet(`helper:user_stats:${targetUserId}`) || {
    ticketsCreated: 0,
    bugsReported: 0,
    ideasSubmitted: 0
  };
  const badges = await getUserBadges(targetUserId);
  const isBanned = await isUserBanned(targetUserId);
  const isMuted = await isUserMuted(targetUserId);
  const userTickets = await kvSmembers(`helper:user_tickets:${targetUserId}`);
  
  let text = `
👤 <b>ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ</b>
━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 <b>ID:</b> <code>${targetUserId}</code>
📊 <b>Статус:</b> ${isBanned ? "🚫 Забанен" : isMuted ? "🔇 Замьючен" : "✅ Активен"}
━━━━━━━━━━━━━━━━━━━━━━━━━

📈 <b>АКТИВНОСТЬ:</b>
• Создано тикетов: ${userStats.ticketsCreated}
• Найдено багов: ${userStats.bugsReported}
• Предложено идей: ${userStats.ideasSubmitted}
• Всего тикетов: ${userTickets.length}

🏆 <b>БЕЙДЖИ (${badges.length}):</b>
${badges.length > 0 ? badges.map(b => `${b.emoji} ${b.name}`).join("\n") : "Нет бейджей"}

━━━━━━━━━━━━━━━━━━━━━━━━━
`.trim();
  
  const keyboard = [];
  
  if (!isBanned) {
    keyboard.push([{ text: "🚫 Забанить", callback_data: `admin_ban_${targetUserId}` }]);
  } else {
    keyboard.push([{ text: "✅ Разбанить", callback_data: `admin_unban_${targetUserId}` }]);
  }
  
  if (!isMuted) {
    keyboard.push([{ text: "🔇 Замьютить", callback_data: `admin_mute_${targetUserId}` }]);
  } else {
    keyboard.push([{ text: "🔊 Размьютить", callback_data: `admin_unmute_${targetUserId}` }]);
  }
  
  keyboard.push([{ text: "📋 Тикеты пользователя", callback_data: `admin_user_tickets_${targetUserId}` }]);
  keyboard.push([{ text: "⬅️ Назад", callback_data: "admin_users" }]);
  
  await sendInlineMessage(adminId, text, keyboard);
}

// ==========================================
// 16. АДМИН ПАНЕЛЬ
// ==========================================

/**
 * Показывает панель администратора
 */
async function showAdminPanel(adminId) {
  if (!isAdmin(adminId)) return;
  
  const isMain = isMainAdmin(adminId);
  
  const text = `
👑 <b>ПАНЕЛЬ АДМИНИСТРАТОРА</b>
━━━━━━━━━━━━━━━━━━━━━━━━━
Добро пожаловать, ${isMain ? "Главный Администратор" : "Администратор"}!

Выберите действие:
━━━━━━━━━━━━━━━━━━━━━━━━━
`.trim();
  
  const keyboard = [
    [
      { text: "📊 Статистика", callback_data: "admin_stats" },
      { text: "📋 Все тикеты", callback_data: "admin_all_tickets" }
    ],
    [
      { text: "👥 Управление пользователями", callback_data: "admin_users" },
      { text: "🔍 Поиск пользователя", callback_data: "admin_search_user" }
    ],
    [
      { text: "🚫 Забаненные", callback_data: "admin_banned_list" },
      { text: "🔇 Замьюченные", callback_data: "admin_muted_list" }
    ]
  ];
  
  if (isMain) {
    keyboard.push([
      { text: "👑 Управление админами", callback_data: "admin_manage_admins" },
      { text: "📜 Логи действий", callback_data: "admin_logs" }
    ]);
    keyboard.push([
      { text: "📢 Рассылка", callback_data: "admin_broadcast" }
    ]);
  }
  
  keyboard.push([{ text: "🔄 Обновить", callback_data: "admin_panel" }]);
  
  await sendInlineMessage(adminId, text, keyboard);
}

/**
 * Показывает список забаненных пользователей
 */
async function showBannedUsers(adminId) {
  if (!isAdmin(adminId)) return;
  
  const bannedIds = await kvSmembers("helper:banned_users");
  
  if (bannedIds.length === 0) {
    await sendTextMessage(adminId, "📭 Нет забаненных пользователей.");
    return;
  }
  
  let text = `🚫 <b>Забаненные пользователи (${bannedIds.length}):</b>\n\n`;
  const keyboard = [];
  
  for (const userId of bannedIds.slice(0, 20)) {
    const banData = await kvGet(`helper:ban:${userId}`);
    if (banData) {
      text += `👤 <code>${userId}</code>\n`;
      text += `   📝 ${escapeHtml(banData.reason)}\n`;
      text += `   🕒 ${formatDateTime(banData.timestamp)}\n\n`;
      
      keyboard.push([{ text: `✅ Разбанить ${userId}`, callback_data: `admin_unban_${userId}` }]);
    }
  }
  
  keyboard.push([{ text: "⬅️ Назад", callback_data: "admin_panel" }]);
  
  await sendInlineMessage(adminId, text, keyboard);
}

/**
 * Показывает список замьюченных пользователей
 */
async function showMutedUsers(adminId) {
  if (!isAdmin(adminId)) return;
  
  const mutedIds = await kvSmembers("helper:muted_users");
  
  if (mutedIds.length === 0) {
    await sendTextMessage(adminId, "📭 Нет замьюченных пользователей.");
    return;
  }
  
  let text = `🔇 <b>Замьюченные пользователи (${mutedIds.length}):</b>\n\n`;
  const keyboard = [];
  
  for (const userId of mutedIds.slice(0, 20)) {
    const muteData = await kvGet(`helper:mute:${userId}`);
    if (muteData) {
      const expiresIn = muteData.expiresAt ? Math.round((muteData.expiresAt - Date.now()) / 60000) : "∞";
      text += `👤 <code>${userId}</code>\n`;
      text += `   📝 ${escapeHtml(muteData.reason)}\n`;
      text += `   ⏱️ Истекает через: ${expiresIn} мин.\n\n`;
      
      keyboard.push([{ text: `🔊 Размьютить ${userId}`, callback_data: `admin_unmute_${userId}` }]);
    }
  }
  
  keyboard.push([{ text: "⬅️ Назад", callback_data: "admin_panel" }]);
  
  await sendInlineMessage(adminId, text, keyboard);
}

// ==========================================
// 17. ПОЛЬЗОВАТЕЛЬСКОЕ МЕНЮ
// ==========================================

/**
 * Показывает главное меню пользователя
 */
async function showUserMainMenu(userId, userName) {
  const text = `
👋 <b>Добро пожаловать в Helper Bot!</b>

Я помогу вам связаться с технической поддержкой.

━━━━━━━━━━━━━━━━━━━━━━━━━
📌 <b>Доступные действия:</b>
• 🎫 Создать тикет поддержки
• 🔴 Live Mode (быстрая связь с админом)
• 📋 Мои тикеты
• 👤 Мой профиль
• ❓ Помощь
━━━━━━━━━━━━━━━━━━━━━━━━━
`.trim();
  
  const keyboard = [
    [
      { text: "🎫 Создать тикет", callback_data: "start_ticket" },
      { text: "🔴 Live Mode", callback_data: "start_live" }
    ],
    [
      { text: "📋 Мои тикеты", callback_data: "my_tickets" },
      { text: "👤 Мой профиль", callback_data: "my_profile" }
    ],
    [
      { text: "🏆 Мои бейджи", callback_data: "my_badges" },
      { text: "❓ Помощь", callback_data: "help" }
    ]
  ];
  
  await sendInlineMessage(userId, text, keyboard);
}

/**
 * Показывает профиль пользователя
 */
async function showUserProfile(userId) {
  const userStats = await kvGet(`helper:user_stats:${userId}`) || {
    ticketsCreated: 0,
    bugsReported: 0,
    ideasSubmitted: 0
  };
  const badges = await getUserBadges(userId);
  const userTickets = await kvSmembers(`helper:user_tickets:${userId}`);
  const isBanned = await isUserBanned(userId);
  const isMuted = await isUserMuted(userId);
  
  const text = `
👤 <b>ВАШ ПРОФИЛЬ</b>
━━━━━━━━━━━━━━━━━━━━━━━━━
🆔 <b>ID:</b> <code>${userId}</code>
📊 <b>Статус:</b> ${isBanned ? "🚫 Забанен" : isMuted ? "🔇 Замьючен" : "✅ Активен"}
━━━━━━━━━━━━━━━━━━━━━━━━━

📈 <b>АКТИВНОСТЬ:</b>
• Создано тикетов: ${userStats.ticketsCreated}
• Найдено багов: ${userStats.bugsReported}
• Предложено идей: ${userStats.ideasSubmitted}
• Всего тикетов: ${userTickets.length}

🏆 <b>БЕЙДЖИ (${badges.length}):</b>
${badges.length > 0 ? badges.map(b => `${b.emoji} ${b.name}`).join("\n") : "Нет бейджей"}

━━━━━━━━━━━━━━━━━━━━━━━━━
`.trim();
  
  await sendInlineMessage(userId, text, [
    [{ text: "📋 Мои тикеты", callback_data: "my_tickets" }],
    [{ text: "⬅️ Назад", callback_data: "back_to_main" }]
  ]);
}

/**
 * Показывает бейджи пользователя
 */
async function showUserBadges(userId) {
  const badges = await getUserBadges(userId);
  
  let text = "🏆 <b>Ваши бейджи</b>\n\n";
  
  if (badges.length === 0) {
    text += "Пока нет полученных бейджей.\n\n";
    text += "<b>Как получить бейджи:</b>\n";
    text += "• Создавайте тикеты\n";
    text += "• Сообщайте о багах\n";
    text += "• Предлагайте идеи\n";
    text += "• Оставляйте хорошие оценки\n";
  } else {
    text += `Получено: <b>${badges.length}</b>\n\n`;
    for (const badge of badges) {
      text += `${badge.emoji} <b>${badge.name}</b>\n`;
      text += `   <i>${badge.desc}</i>\n\n`;
    }
  }
  
  text += "\n📚 <b>Все доступные бейджи:</b>\n";
  for (const [id, badge] of Object.entries(BADGES)) {
    const hasBadge = badges.some(b => b.id === badge.id);
    text += `${hasBadge ? "✅" : "⬜"} ${badge.emoji} ${badge.name} — <i>${badge.desc}</i>\n`;
  }
  
  await sendInlineMessage(userId, text, [
    [{ text: "⬅️ Назад", callback_data: "back_to_main" }]
  ]);
}

/**
 * Показывает помощь
 */
async function showHelp(userId, isAdminUser = false) {
  let text = `
📖 <b>Справка по командам</b>
━━━━━━━━━━━━━━━━━━━━━━━━━

<b>👤 Основные команды:</b>
/start — Главное меню
/ticket — Создать тикет поддержки
/live — Прямой чат с админом
/skip — Пропустить шаг создания тикета
/mytickets — Мои тикеты
/profile — Мой профиль
/badges — Мои бейджи
/help — Эта справка
`.trim();
  
  if (isAdminUser) {
    text += `

━━━━━━━━━━━━━━━━━━━━━━━━━
<b>👨‍💻 Команды администратора:</b>
/stats — Статистика системы
/ban &lt;user_id&gt; [причина] — Забанить
/unban &lt;user_id&gt; — Разбанить
/mute &lt;user_id&gt; [причина] — Замьютить
/unmute &lt;user_id&gt; — Размьютить
/reply &lt;ticket_id&gt; &lt;причина&gt; — Ответить на тикет
/endlive — Завершить Live Mode
/addadmin &lt;user_id&gt; — Добавить админа
/removeadmin &lt;user_id&gt; — Удалить админа (только главный)
/finduser &lt;user_id&gt; — Информация о пользователе
`;
  }
  
  text += `

━━━━━━━━━━━━━━━━━━━━━━━━━
💡 <i>По всем вопросам обращайтесь к администрации.</i>
`.trim();
  
  await sendTextMessage(userId, text);
}

// ==========================================
// 18. ОБРАБОТЧИКИ СООБЩЕНИЙ И КОМАНД
// ==========================================

/**
 * Обрабатывает текстовые сообщения
 */
async function processTextMessage(message) {
  const userId = String(message.from.id);
  const userName = getSafeUserName(message.from);
  const text = message.text || "";
  const { command, args } = parseCommand(text);
  
  // Обновляем активность админа
  if (isAdmin(userId)) {
    await updateAdminLastSeen(userId);
  }
  
  // Сохраняем пользователя
  await kvSet(`helper:user:${userId}`, {
    userId: userId,
    userName: userName,
    lastSeen: Date.now(),
    messageCount: ((await kvGet(`helper:user:${userId}`))?.messageCount || 0) + 1
  });
  
  // Проверка бана
  if (!isAdmin(userId) && await isUserBanned(userId)) {
    await sendTextMessage(userId, "🚫 Вы заблокированы и не можете использовать бота.");
    return;
  }
  
  // Проверка мута (кроме команд)
  if (!isAdmin(userId) && await isUserMuted(userId) && !command.startsWith("/")) {
    await sendTextMessage(userId, "🔇 Вы замьючены и не можете отправлять обычные сообщения.");
    return;
  }
  
  // ========== LIVE MODE (приоритетная обработка) ==========
  const isLiveHandled = await handleLiveModeMessage(userId, text, isAdmin(userId));
  if (isLiveHandled) return;
  
  // ========== ОБРАБОТКА ОЦЕНОК ==========
  // Если пользователь не отправляет команду и есть активная сессия оценки
  if (!command.startsWith("/")) {
    const ratingSession = await kvGet(`helper:rating_session:${userId}`);
    const liveSession = await kvGet(`helper:live_session:${userId}`);
    
    if (ratingSession && ratingSession.status === "awaiting_rating") {
      await handleRatingSubmission(userId, text);
      return;
    }
    
    if (liveSession && liveSession.status === "ended" && !liveSession.ratingGiven) {
      await handleRatingSubmission(userId, text);
      return;
    }
  }
  
  // ========== ОБРАБОТКА СОСТОЯНИЙ ТИКЕТА ==========
  if (!command.startsWith("/")) {
    const ticketState = await kvGet(`helper:ticket_state:${userId}`);
    
    if (ticketState) {
      if (ticketState.step === 3) {
        await handleTicketDescription(userId, text);
        return;
      }
      if (ticketState.step === 5) {
        await handleTicketNameInput(userId, text);
        return;
      }
    }
  }
  
  // ========== ОБРАБОТКА КОМАНД ==========
  switch (command) {
    case "/start":
      if (isAdmin(userId)) {
        await showAdminPanel(userId);
      } else {
        await showUserMainMenu(userId, userName);
      }
      break;
      
    case "/ticket":
      await startTicketCreation(userId, userName);
      break;
      
    case "/live":
      await startLiveMode(userId, userName);
      break;
      
    case "/skip":
      const state = await kvGet(`helper:ticket_state:${userId}`);
      if (state) {
        if (state.step === 2) {
          await handleTicketSkipDocument(userId, null);
        } else if (state.step === 5) {
          await handleTicketSkipName(userId, null);
        } else {
          await sendTextMessage(userId, "❌ Команда /skip доступна только на шагах 2 или 5.");
        }
      } else {
        await sendTextMessage(userId, "❌ У вас нет активного процесса создания тикета.");
      }
      break;
      
    case "/mytickets":
      await showUserTickets(userId);
      break;
      
    case "/profile":
      await showUserProfile(userId);
      break;
      
    case "/badges":
      await showUserBadges(userId);
      break;
      
    case "/help":
      await showHelp(userId, isAdmin(userId));
      break;
      
    // ========== АДМИН КОМАНДЫ ==========
    case "/stats":
      if (isAdmin(userId)) {
        await showAdminStats(userId);
      } else {
        await sendTextMessage(userId, "❌ Недостаточно прав.");
      }
      break;
      
    case "/ban":
      if (!isAdmin(userId)) break;
      if (args.length < 2) {
        await sendTextMessage(userId, "❌ Использование: <code>/ban &lt;user_id&gt; &lt;причина&gt;</code>");
        break;
      }
      const banResult = await banUser(userId, args[0], args.slice(1).join(" "));
      await sendTextMessage(userId, banResult.message);
      break;
      
    case "/unban":
      if (!isAdmin(userId)) break;
      if (args.length < 1) {
        await sendTextMessage(userId, "❌ Использование: <code>/unban &lt;user_id&gt;</code>");
        break;
      }
      const unbanResult = await unbanUser(userId, args[0]);
      await sendTextMessage(userId, unbanResult.message);
      break;
      
    case "/mute":
      if (!isAdmin(userId)) break;
      if (args.length < 2) {
        await sendTextMessage(userId, "❌ Использование: <code>/mute &lt;user_id&gt; &lt;причина&gt;</code>");
        break;
      }
      const muteResult = await muteUser(userId, args[0], args.slice(1).join(" "));
      await sendTextMessage(userId, muteResult.message);
      break;
      
    case "/unmute":
      if (!isAdmin(userId)) break;
      if (args.length < 1) {
        await sendTextMessage(userId, "❌ Использование: <code>/unmute &lt;user_id&gt;</code>");
        break;
      }
      const unmuteResult = await unmuteUser(userId, args[0]);
      await sendTextMessage(userId, unmuteResult.message);
      break;
      
    case "/reply":
      if (!isAdmin(userId)) break;
      if (args.length < 2) {
        await sendTextMessage(
          userId,
          "❌ <b>Использование:</b> <code>/reply &lt;ticket_id&gt; &lt;причина ответа&gt;</code>\n\n" +
          "⚠️ Указание причины обязательно!"
        );
        break;
      }
      await handleAdminTicketReply(userId, args[0], args.slice(1).join(" "));
      break;
      
case "/endlive": {
  // Определяем, кто пользователь — админ или обычный
  if (isAdmin(userId)) {
    // --- АДМИН ---
    const adminSession = await kvGet(`helper:live_session_admin:${userId}`);
    if (adminSession && adminSession.status === "active") {
      await endLiveMode(userId, adminSession.userId);
    } else {
      await sendTextMessage(userId, "❌ У вас нет активного Live Mode диалога.");
    }
  } else {
    // --- ПОЛЬЗОВАТЕЛЬ ---
    const userSession = await kvGet(`helper:live_session:${userId}`);
    if (userSession && userSession.status === "active") {
      await endLiveModeByUser(userId);
    } else {
      await sendTextMessage(userId, "❌ У вас нет активного Live Mode диалога.");
    }
  }
  break;
}
      
    case "/addadmin":
      if (!isAdmin(userId)) break;
      if (args.length < 1) {
        await sendTextMessage(userId, "❌ Использование: <code>/addadmin &lt;user_id&gt;</code>");
        break;
      }
      const addResult = await addAdmin(userId, args[0]);
      await sendTextMessage(userId, addResult.message);
      break;
      
    case "/removeadmin":
      if (!isMainAdmin(userId)) {
        await sendTextMessage(userId, "❌ Только ГЛАВНЫЙ администратор может удалять админов.");
        break;
      }
      if (args.length < 1) {
        await sendTextMessage(userId, "❌ Использование: <code>/removeadmin &lt;user_id&gt;</code>");
        break;
      }
      const remResult = await removeAdmin(userId, args[0]);
      await sendTextMessage(userId, remResult.message);
      break;
      
    case "/finduser":
      if (!isAdmin(userId)) break;
      if (args.length < 1) {
        await sendTextMessage(userId, "❌ Использование: <code>/finduser &lt;user_id&gt;</code>");
        break;
      }
      await showUserProfileForAdmin(userId, args[0]);
      break;
      
    default:
      if (!command.startsWith("/")) {
        // Если не команда и не в процессе - показываем меню
        if (!isAdmin(userId)) {
          await showUserMainMenu(userId, userName);
        }
      }
      break;
  }
}

// ==========================================
// 19. ОБРАБОТЧИКИ CALLBACK QUERY
// ==========================================

/**
 * Обрабатывает нажатия на инлайн-кнопки
 */
async function processCallbackQuery(callbackQuery) {
  const userId = String(callbackQuery.from.id);
  const data = callbackQuery.data;
  const messageId = callbackQuery.message?.message_id;
  const chatId = callbackQuery.message?.chat.id;
  const userName = getSafeUserName(callbackQuery.from);
  
  // Обновляем активность админа
  if (isAdmin(userId)) {
    await updateAdminLastSeen(userId);
  }
  
  // ========== ТИКЕТЫ ==========
  if (data.startsWith("ticket_cat_")) {
    const categoryId = data.replace("ticket_cat_", "");
    await handleTicketCategorySelection(userId, categoryId, callbackQuery.id);
  }
  else if (data === "ticket_skip_doc") {
    await handleTicketSkipDocument(userId, callbackQuery.id);
  }
  else if (data === "ticket_skip_name") {
    await handleTicketSkipName(userId, callbackQuery.id);
  }
  else if (data.startsWith("ticket_target_")) {
    const targetId = data.replace("ticket_target_", "");
    await handleTicketTargetSelection(userId, targetId, callbackQuery.id);
  }
  else if (data === "ticket_cancel") {
    await kvDel(`helper:ticket_state:${userId}`);
    await answerCallbackQuery(callbackQuery.id, "Создание тикета отменено");
    await sendTextMessage(userId, "❌ Создание тикета отменено.");
  }
  else if (data.startsWith("ticket_take_")) {
    const ticketId = data.replace("ticket_take_", "");
    if (isAdmin(userId)) {
      await answerCallbackQuery(callbackQuery.id, "Тикет взят в работу");
      const ticket = await kvGet(`helper:ticket:${ticketId}`);
      if (ticket) {
        ticket.status = TICKET_STATUSES.IN_PROGRESS.id;
        ticket.updatedAt = Date.now();
        await kvSet(`helper:ticket:${ticketId}`, ticket);
        await sendTextMessage(ticket.userId, `🟡 Ваш тикет <code>${ticketId}</code> взят в работу администратором.`);
      }
    }
  }
  else if (data.startsWith("ticket_reject_")) {
    const ticketId = data.replace("ticket_reject_", "");
    if (isAdmin(userId)) {
      await answerCallbackQuery(callbackQuery.id);
      await sendTextMessage(userId, `Для отклонения тикета используйте:\n<code>/reply ${ticketId} Причина отклонения</code>`);
    }
  }
  else if (data.startsWith("ticket_reply_")) {
    const ticketId = data.replace("ticket_reply_", "");
    if (isAdmin(userId)) {
      await answerCallbackQuery(callbackQuery.id);
      await sendTextMessage(
        userId,
        `⚠️ <b>Для ответа на тикет используйте команду:</b>\n\n` +
        `<code>/reply ${ticketId} Ваша причина ответа</code>\n\n` +
        `Указание причины <b>ОБЯЗАТЕЛЬНО</b>!`
      );
    }
  }
  else if (data.startsWith("view_ticket_")) {
    const ticketId = data.replace("view_ticket_", "");
    await answerCallbackQuery(callbackQuery.id);
    await showTicketDetails(userId, ticketId, false);
  }
  else if (data.startsWith("admin_view_ticket_")) {
    const ticketId = data.replace("admin_view_ticket_", "");
    if (isAdmin(userId)) {
      await answerCallbackQuery(callbackQuery.id);
      await showTicketDetails(userId, ticketId, true);
    }
  }
  // ========== ОЦЕНКИ ==========
  else if (data.startsWith("rate_ticket_")) {
    const parts = data.split("_");
    const ticketId = parts[2];
    const rating = parseInt(parts[3]);
    
    await answerCallbackQuery(callbackQuery.id, `Спасибо за оценку ${rating}!`);
    
    // Сохраняем оценку
    const ticket = await kvGet(`helper:ticket:${ticketId}`);
    if (ticket) {
      ticket.rating = rating;
      await kvSet(`helper:ticket:${ticketId}`, ticket);
      
      // Уведомляем админа
      if (ticket.resolvedBy) {
        await sendTextMessage(
          ticket.resolvedBy,
          `⭐ Пользователь оценил ваш ответ на тикет <code>${ticketId}</code> на ${rating}/5`
        );
        
        // Обновляем статистику
        const adminStatsKey = `helper:admin_stats:${ticket.resolvedBy}`;
        let adminStats = await kvGet(adminStatsKey) || { totalRatings: 0, sumRatings: 0, comments: [], ticketsResolved: 0 };
        adminStats.totalRatings++;
        adminStats.sumRatings += rating;
        await kvSet(adminStatsKey, adminStats);
      }
    }
    
    await editMessageText(chatId, messageId, `✅ Вы оценили этот тикет на ${rating} звезд.\nСпасибо за ваш отзыв!`);
  }
  // ========== LIVE MODE ==========
  else if (data === "start_live") {
    await answerCallbackQuery(callbackQuery.id);
    await startLiveMode(userId, userName);
  }
  else if (data === "start_ticket") {
    await answerCallbackQuery(callbackQuery.id);
    await startTicketCreation(userId, userName);
  }
  else if (data === "live_end_by_user") {
  await answerCallbackQuery(callbackQuery.id);
  const userSession = await kvGet(`helper:live_session:${userId}`);
  if (userSession && userSession.status === "active") {
    await endLiveModeByUser(userId);
  } else {
    await sendTextMessage(userId, "❌ У вас нет активного Live Mode диалога.");
  }
}
else if (data.startsWith("live_end_by_admin_")) {
  if (!isAdmin(userId)) {
    await answerCallbackQuery(callbackQuery.id, "Недостаточно прав", true);
    return;
  }
  const targetUserId = data.replace("live_end_by_admin_", "");
  await answerCallbackQuery(callbackQuery.id);
  await endLiveMode(userId, targetUserId);
}
  // ========== МЕНЮ ==========
  else if (data === "back_to_main") {
    await answerCallbackQuery(callbackQuery.id);
    if (isAdmin(userId)) {
      await showAdminPanel(userId);
    } else {
      await showUserMainMenu(userId, userName);
    }
  }
  else if (data === "my_tickets") {
    await answerCallbackQuery(callbackQuery.id);
    await showUserTickets(userId);
  }
  else if (data === "my_profile") {
    await answerCallbackQuery(callbackQuery.id);
    await showUserProfile(userId);
  }
  else if (data === "my_badges") {
    await answerCallbackQuery(callbackQuery.id);
    await showUserBadges(userId);
  }
  else if (data === "help") {
    await answerCallbackQuery(callbackQuery.id);
    await showHelp(userId, isAdmin(userId));
  }
  // ========== АДМИН ПАНЕЛЬ ==========
  else if (data === "admin_panel") {
    if (isAdmin(userId)) {
      await answerCallbackQuery(callbackQuery.id);
      await showAdminPanel(userId);
    }
  }
  else if (data === "admin_stats") {
    if (isAdmin(userId)) {
      await answerCallbackQuery(callbackQuery.id);
      await showAdminStats(userId);
    }
  }
  else if (data === "admin_all_tickets") {
    if (isAdmin(userId)) {
      await answerCallbackQuery(callbackQuery.id);
      await showAllTicketsForAdmin(userId, "all", 1);
    }
  }
  else if (data.startsWith("admin_tickets_filter_")) {
    if (isAdmin(userId)) {
      const filter = data.replace("admin_tickets_filter_", "");
      await answerCallbackQuery(callbackQuery.id);
      await showAllTicketsForAdmin(userId, filter, 1);
    }
  }
  else if (data.startsWith("admin_tickets_page_")) {
    if (isAdmin(userId)) {
      const parts = data.replace("admin_tickets_page_", "").split("_");
      const filter = parts[0];
      const page = parseInt(parts[1]);
      await answerCallbackQuery(callbackQuery.id);
      await showAllTicketsForAdmin(userId, filter, page);
    }
  }
  else if (data === "admin_banned_list") {
    if (isAdmin(userId)) {
      await answerCallbackQuery(callbackQuery.id);
      await showBannedUsers(userId);
    }
  }
  else if (data === "admin_muted_list") {
    if (isAdmin(userId)) {
      await answerCallbackQuery(callbackQuery.id);
      await showMutedUsers(userId);
    }
  }
  else if (data.startsWith("admin_unban_")) {
    if (isAdmin(userId)) {
      const targetId = data.replace("admin_unban_", "");
      const result = await unbanUser(userId, targetId);
      await answerCallbackQuery(callbackQuery.id, result.message, true);
      await showBannedUsers(userId);
    }
  }
  else if (data.startsWith("admin_unmute_")) {
    if (isAdmin(userId)) {
      const targetId = data.replace("admin_unmute_", "");
      const result = await unmuteUser(userId, targetId);
      await answerCallbackQuery(callbackQuery.id, result.message, true);
      await showMutedUsers(userId);
    }
  }
  else if (data.startsWith("admin_ban_")) {
    if (isAdmin(userId)) {
      const targetId = data.replace("admin_ban_", "");
      await answerCallbackQuery(callbackQuery.id);
      await sendTextMessage(
        userId,
        `Для бана пользователя используйте:\n<code>/ban ${targetId} Причина</code>`
      );
    }
  }
  else if (data.startsWith("admin_mute_")) {
    if (isAdmin(userId)) {
      const targetId = data.replace("admin_mute_", "");
      await answerCallbackQuery(callbackQuery.id);
      await sendTextMessage(
        userId,
        `Для мьюта пользователя используйте:\n<code>/mute ${targetId} Причина</code>`
      );
    }
  }
  else if (data === "ignore") {
    await answerCallbackQuery(callbackQuery.id);
  }
  else {
    await answerCallbackQuery(callbackQuery.id, "Действие не распознано");
  }
}

// ==========================================
// 20. ОБРАБОТЧИКИ ДОКУМЕНТОВ
// ==========================================

/**
 * Обрабатывает получение документа/фото
 */
async function processDocumentMessage(message) {
  const userId = String(message.from.id);
  
  // Проверка бана
  if (!isAdmin(userId) && await isUserBanned(userId)) {
    await sendTextMessage(userId, "🚫 Вы заблокированы.");
    return;
  }
  
  // Проверка состояния тикета
  const state = await kvGet(`helper:ticket_state:${userId}`);
  
  if (state && state.step === 2) {
    // Сохраняем информацию о документе
    let docInfo = null;
    if (message.document) {
      docInfo = message.document.file_id;
    } else if (message.photo) {
      docInfo = message.photo[message.photo.length - 1].file_id;
    } else if (message.video) {
      docInfo = message.video.file_id;
    } else if (message.audio) {
      docInfo = message.audio.file_id;
    } else if (message.voice) {
      docInfo = message.voice.file_id;
    } else if (message.video_note) {
      docInfo = message.video_note.file_id;
    } else if (message.sticker) {
      docInfo = message.sticker.file_id;
    } else if (message.animation) {
      docInfo = message.animation.file_id;
    }
    
    if (docInfo) {
      await handleTicketDocumentUpload(userId, docInfo);
    } else {
      await sendTextMessage(userId, "❌ Не удалось распознать документ. Попробуйте отправить другой файл.");
    }
  } else {
    if (!isAdmin(userId)) {
      await sendTextMessage(
        userId,
        "❌ Пожалуйста, используйте команду /ticket для отправки файлов в поддержку."
      );
    }
  }
}

// ==========================================
// 21. ГЛАВНЫЙ WEBHOOK HANDLER (VERCEL SERVERLESS)
// ==========================================

module.exports = async function handler(req, res) {
  // Health check для GET запросов
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "Helper Telegram Bot",
      version: "6.0.0",
      timestamp: new Date().toISOString(),
      features: [
        "Tickets System",
        "Live Mode",
        "Moderation Tools",
        "Rating System",
        "Badges",
        "Admin Hierarchy",
        "Statistics",
        "Logging"
      ],
      admins: ADMIN_IDS.length
    });
  }
  
  // Принимаем только POST
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  
  // Проверка секретного токена
  if (WEBHOOK_SECRET && req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET) {
    console.warn("[WEBHOOK] Неверный секретный токен");
    return res.status(403).json({ ok: false, error: "Invalid webhook secret" });
  }
  
  try {
    // Загружаем актуальный список админов
    await loadAdminIds();
    
    const update = req.body;
    
    // 1. Callback Query (нажатия на кнопки)
    if (update.callback_query) {
      await processCallbackQuery(update.callback_query);
    }
    // 2. Обычные сообщения
    else if (update.message) {
      // Игнорируем каналы
      if (update.message.chat.type !== "channel") {
        console.log(`[MESSAGE] ${update.message.from.id}: ${(update.message.text || "[Media]").substring(0, 50)}`);
        
        if (update.message.document || update.message.photo || update.message.video || 
            update.message.audio || update.message.voice || update.message.video_note ||
            update.message.sticker || update.message.animation) {
          await processDocumentMessage(update.message);
        } else if (update.message.text) {
          await processTextMessage(update.message);
        }
      }
    }
    // 3. Редактирование сообщений
    else if (update.edited_message) {
      // Можно добавить логику при необходимости
      console.log(`[EDITED_MESSAGE] ${update.edited_message.from.id}`);
    }
    // 4. Другие типы обновлений
    else if (update.inline_query) {
      // Обработка inline запросов (опционально)
      console.log(`[INLINE_QUERY] ${update.inline_query.from.id}`);
    }
    else if (update.channel_post) {
      // Обработка постов в канале (опционально)
      console.log(`[CHANNEL_POST] ${update.channel_post.chat.id}`);
    }
    
    // Всегда возвращаем 200 OK
    return res.status(200).json({ ok: true });
    
  } catch (error) {
    console.error("[CRITICAL ERROR]", error);
    // Возвращаем 200 даже при ошибке, чтобы Telegram не отключал вебхук
    return res.status(200).json({ ok: false, error: "Internal handler error" });
  }
};

// ==========================================
// 22. ЭКСПОРТ ДОПОЛНИТЕЛЬНЫХ ФУНКЦИЙ
// ==========================================

module.exports.generateRandomTicketId = generateRandomTicketId;
module.exports.generateTicketId = generateTicketId;
module.exports.formatDateTime = formatDateTime;
module.exports.timeAgo = timeAgo;
module.exports.escapeHtml = escapeHtml;
module.exports.isAdmin = isAdmin;
module.exports.isMainAdmin = isMainAdmin;
module.exports.loadAdminIds = loadAdminIds;
module.exports.saveAdminIds = saveAdminIds;
module.exports.updateAdminLastSeen = updateAdminLastSeen;
module.exports.isAdminActive = isAdminActive;
module.exports.findActiveAdminForLiveMode = findActiveAdminForLiveMode;
module.exports.checkRateLimit = checkRateLimit;
module.exports.awardBadge = awardBadge;
module.exports.getUserBadges = getUserBadges;
module.exports.logAdminAction = logAdminAction;
module.exports.logUserAction = logUserAction;
module.exports.TICKET_CATEGORIES = TICKET_CATEGORIES;
module.exports.TICKET_STATUSES = TICKET_STATUSES;
module.exports.TARGET_ADMINS = TARGET_ADMINS;
module.exports.BADGES = BADGES;
module.exports.ADMIN_IDS = ADMIN_IDS;
module.exports.MAIN_ADMIN_ID = MAIN_ADMIN_ID;
module.exports.ADMIN_2_ID = ADMIN_2_ID;

// ==========================================
// 23. ДОПОЛНИТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ РАСШИРЕНИЯ
// ==========================================

/**
 * Очистка устаревших данных (для cron jobs)
 */
async function cleanupOldData() {
  console.log("[CLEANUP] Запуск очистки устаревших данных...");
  
  try {
    // Очистка старых сессий тикетов
    const sessionKeys = await kvKeys("helper:ticket_state:*");
    for (const key of sessionKeys) {
      const state = await kvGet(key);
      if (state && Date.now() - state.createdAt > 3600000) { // 1 час
        await kvDel(key);
      }
    }
    
    // Очистка старых Live сессий
    const liveKeys = await kvKeys("helper:live_session:*");
    for (const key of liveKeys) {
      const session = await kvGet(key);
      if (session && session.status !== "active" && Date.now() - session.startTime > 86400000) {
        await kvDel(key);
      }
    }
    
    console.log("[CLEANUP] Очистка завершена");
    return true;
  } catch (error) {
    console.error("[CLEANUP ERROR]", error.message);
    return false;
  }
}

/**
 * Экспорт статистики в JSON
 */
async function exportStats() {
  console.log("[EXPORT] Генерация отчета статистики...");
  
  try {
    const allTicketIds = await kvSmembers("helper:all_tickets");
    const bannedUsers = await kvSmembers("helper:banned_users");
    const mutedUsers = await kvSmembers("helper:muted_users");
    
    const stats = {
      exportDate: new Date().toISOString(),
      version: "6.0.0",
      tickets: {
        total: allTicketIds.length,
        byStatus: {}
      },
      users: {
        banned: bannedUsers.length,
        muted: mutedUsers.length
      },
      admins: {
        total: ADMIN_IDS.length,
        mainAdmin: MAIN_ADMIN_ID,
        list: ADMIN_IDS
      }
    };
    
    // Подсчет тикетов по статусам
    for (const status of Object.values(TICKET_STATUSES)) {
      stats.tickets.byStatus[status.id] = 0;
    }
    
    for (const id of allTicketIds) {
      const ticket = await kvGet(`helper:ticket:${id}`);
      if (ticket && stats.tickets.byStatus[ticket.status] !== undefined) {
        stats.tickets.byStatus[ticket.status]++;
      }
    }
    
    return stats;
  } catch (error) {
    console.error("[EXPORT ERROR]", error.message);
    return { error: error.message };
  }
}

/**
 * Проверка целостности данных
 */
async function verifyDataIntegrity() {
  console.log("[VERIFY] Проверка целостности данных...");
  
  const issues = [];
  
  try {
    // Проверяем тикеты
    const allTicketIds = await kvSmembers("helper:all_tickets");
    for (const id of allTicketIds) {
      const ticket = await kvGet(`helper:ticket:${id}`);
      if (!ticket) {
        issues.push(`Тикет ${id} в списке, но не найден в KV`);
      }
    }
    
    // Проверяем админов
    for (const adminId of ADMIN_IDS) {
      if (!isValidUserId(adminId)) {
        issues.push(`Некорректный ID админа: ${adminId}`);
      }
    }
    
    return {
      ok: issues.length === 0,
      issues: issues
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Массовая рассылка админам
 */
async function broadcastToAdmins(message) {
  for (const adminId of ADMIN_IDS) {
    await sendTextMessage(adminId, `📢 <b>УВЕДОМЛЕНИЕ:</b>\n\n${escapeHtml(message)}`);
  }
}

/**
 * Генерация детального отчета по тикету
 */
function generateDetailedTicketReport(ticket) {
  return `
ОТЧЕТ ПО ТИКЕТУ
================================
ID: ${ticket.id}
Название: ${ticket.ticketName}
Категория: ${ticket.category}
Статус: ${ticket.status}
Приоритет: ${ticket.priority || 1}/5
Пользователь: ${ticket.userName} (${ticket.userId})
Дата создания: ${formatDateTime(ticket.createdAt)}
Дата обновления: ${formatDateTime(ticket.updatedAt)}
Дата решения: ${ticket.resolvedAt ? formatDateTime(ticket.resolvedAt) : "Не решен"}
Решил: ${ticket.resolvedBy || "Не назначен"}
Оценка: ${ticket.rating ? ticket.rating + "/5" : "Нет оценки"}
Причина ответа: ${ticket.adminResponseReason || "Не указана"}

Описание:
${ticket.description}
================================
  `.trim();
}

/**
 * Получение статистики пользователя
 */
async function getUserStatistics(userId) {
  const userStats = await kvGet(`helper:user_stats:${userId}`) || {
    ticketsCreated: 0,
    bugsReported: 0,
    ideasSubmitted: 0
  };
  
  const badges = await getUserBadges(userId);
  const tickets = await kvSmembers(`helper:user_tickets:${userId}`);
  
  return {
    ...userStats,
    badgesCount: badges.length,
    badges: badges,
    totalTickets: tickets.length
  };
}

/**
 * Проверка, может ли админ выполнить действие
 */
function canAdminPerformAction(adminId, action, targetId) {
  if (!isAdmin(adminId)) {
    return { allowed: false, reason: "Не является администратором" };
  }
  
  const admin = String(adminId);
  const target = String(targetId);
  
  switch (action) {
    case "ban":
    case "mute":
      if (admin === target) {
        return { allowed: false, reason: "Нельзя применить к себе" };
      }
      if (target === MAIN_ADMIN_ID && admin !== MAIN_ADMIN_ID) {
        return { allowed: false, reason: "Нельзя применить к главному админу" };
      }
      if (isAdmin(target) && admin !== MAIN_ADMIN_ID) {
        return { allowed: false, reason: "Только главный админ может применять к другим админам" };
      }
      return { allowed: true };
      
    case "remove_admin":
      if (!isMainAdmin(admin)) {
        return { allowed: false, reason: "Только главный админ может удалять админов" };
      }
      if (target === MAIN_ADMIN_ID) {
        return { allowed: false, reason: "Нельзя удалить главного админа" };
      }
      return { allowed: true };
      
    case "create_ticket":
      return { allowed: false, reason: "Админы не могут создавать тикеты" };
      
    default:
      return { allowed: true };
  }
}

/**
 * Форматирование размера файла
 */
function formatFileSize(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Валидация оценки
 */
function validateRating(rating) {
  const num = parseFloat(rating);
  if (isNaN(num)) return { valid: false, error: "Не число" };
  if (num < 0) return { valid: false, error: "Меньше 0" };
  if (num > 5) return { valid: false, error: "Больше 5" };
  return { valid: true, value: num };
}

/**
 * Получение приоритета категории
 */
function getCategoryPriority(categoryId) {
  const category = Object.values(TICKET_CATEGORIES).find(c => c.id === categoryId);
  return category?.priority || 1;
}

/**
 * Получение эмодзи статуса
 */
function getStatusEmoji(statusId) {
  const status = Object.values(TICKET_STATUSES).find(s => s.id === statusId);
  return status?.emoji || "⚪";
}

/**
 * Создание сводки по тикетам
 */
async function generateTicketsSummary() {
  const allTicketIds = await kvSmembers("helper:all_tickets");
  
  const summary = {
    total: allTicketIds.length,
    open: 0,
    inProgress: 0,
    resolved: 0,
    closed: 0,
    rejected: 0,
    avgRating: 0,
    totalRatings: 0
  };
  
  let ratingSum = 0;
  
  for (const id of allTicketIds) {
    const ticket = await kvGet(`helper:ticket:${id}`);
    if (ticket) {
      switch (ticket.status) {
        case TICKET_STATUSES.OPEN.id: summary.open++; break;
        case TICKET_STATUSES.IN_PROGRESS.id: summary.inProgress++; break;
        case TICKET_STATUSES.RESOLVED.id: summary.resolved++; break;
        case TICKET_STATUSES.CLOSED.id: summary.closed++; break;
        case TICKET_STATUSES.REJECTED.id: summary.rejected++; break;
      }
      if (ticket.rating) {
        ratingSum += ticket.rating;
        summary.totalRatings++;
      }
    }
  }
  
  summary.avgRating = summary.totalRatings > 0 
    ? (ratingSum / summary.totalRatings).toFixed(1) 
    : 0;
  
  return summary;
}

// ==========================================
// КОНЕЦ ФАЙЛА
// ==========================================

console.log("[HELPER BOT v6.0.0] Модуль загружен успешно");
console.log("[HELPER BOT v6.0.0] Главный админ:", MAIN_ADMIN_ID);
console.log("[HELPER BOT v6.0.0] Второй админ:", ADMIN_2_ID);
console.log("[HELPER BOT v6.0.0] Live Mode таймаут:", LIVE_MODE_TIMEOUT_MS / 60000, "минут");