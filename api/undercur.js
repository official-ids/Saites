/**
 * UnderCur Telegram Bot - Advanced Community & Game Management System
 * Version: 3.0.0
 * Environment: Vercel Serverless Functions with @vercel/kv
 * 
 * Features:
 * - Advanced Version Management with KV persistence
 * - Robust News Publishing with Reply support and Channel Auto-Reactions
 * - Comprehensive User Profile & Activity Tracking
 * - Full Ticket/Feedback System with Admin Reply capabilities
 * - Dynamic FAQ Management System
 * - Interactive Multi-page Game Guide & Troubleshooting
 * - Moderation Tools (Ban, Unban, Mute, Unmute)
 * - Scheduled Announcements
 * - Detailed Analytics & Statistics
 * - Anti-Spam Rate Limiting
 */

const { kv } = require("@vercel/kv");

// ==========================================
// CONFIGURATION & ENVIRONMENT VARIABLES
// ==========================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN1;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const ADMIN_IDS = String(process.env.UNDERCUR_ADMIN_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const VERSIONS_API =
  process.env.UNDERCUR_VERSIONS_API ||
  "https://oris-flax.vercel.app/api/undercur/get-versions/";

const OFFICIAL_CHANNEL = "@undercurgame";
const NEWS_CHANNEL = process.env.UNDERCUR_NEWS_CHANNEL || "@undercurgame";
const ITCH_IO_URL = "https://ivtt.itch.io/undercur";
const CHANNEL_URL = "https://t.me/undercurgame";

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Auto-reaction emoji for new channel posts
const CHANNEL_POST_REACTION_EMOJI = "🔥";

// ==========================================
// BADGE SYSTEM CONFIGURATION
// ==========================================

const BADGES = {
  // Реферальные бейджи
  "ref_1": { id: "ref_1", emoji: "🌱", name: "Новичок", desc: "Пригласил 1 друга" },
  "ref_5": { id: "ref_5", emoji: "", name: "Садовод", desc: "Пригласил 5 друзей" },
  "ref_10": { id: "ref_10", emoji: "🌳", name: "Дерево", desc: "Пригласил 10 друзей" },
  "ref_25": { id: "ref_25", emoji: "", name: "Лесник", desc: "Пригласил 25 друзей" },
  "ref_50": { id: "ref_50", emoji: "🌍", name: "Популярный", desc: "Пригласил 50 друзей" },
  
  // Бейджи активности
  "early_adopter": { id: "early_adopter", emoji: "🏆", name: "Первопроходец", desc: "Один из первых пользователей" },
  "active_7": { id: "active_7", emoji: "📅", name: "Неделька", desc: "Активен 7 дней" },
  "active_30": { id: "active_30", emoji: "🗓️", name: "Месяц", desc: "Активен 30 дней" },
  "active_90": { id: "active_90", emoji: "📆", name: "Квартал", desc: "Активен 90 дней" },
  "active_365": { id: "active_365", emoji: "🎉", name: "Годовалый", desc: "Активен 365 дней" },
  
  // Бейджи взаимодействия
  "bug_hunter_1": { id: "bug_hunter_1", emoji: "", name: "Охотник", desc: "Нашёл 1 баг" },
  "bug_hunter_5": { id: "bug_hunter_5", emoji: "️", name: "Паук", desc: "Нашёл 5 багов" },
  "bug_hunter_10": { id: "bug_hunter_10", emoji: "🦂", name: "Скорпион", desc: "Нашёл 10 багов" },
  "idea_master_1": { id: "idea_master_1", emoji: "💡", name: "Идейный", desc: "Предложил 1 идею" },
  "idea_master_5": { id: "idea_master_5", emoji: "✨", name: "Генератор", desc: "Предложил 5 идей" },
  
  // Бейджи версий
  "beta_tester": { id: "beta_tester", emoji: "🧪", name: "Тестировщик", desc: "Участвовал в бета-тесте" },
  "version_collector": { id: "version_collector", emoji: "📦", name: "Коллекционер", desc: "Скачал 5 версий" },
  
  // Специальные бейджи
  "supporter": { id: "supporter", emoji: "❤️", name: "Поддержавший", desc: "Поддержал проект" },
  "legend": { id: "legend", emoji: "👑", name: "Легенда", desc: "Особый статус" },
  "helper": { id: "helper", emoji: "", name: "Помощник", desc: "Помог другим пользователям" },
  "speedster": { id: "speedster", emoji: "⚡", name: "Спринтер", desc: "Быстрый ответ" },
  "night_owl": { id: "night_owl", emoji: "", name: "Сова", desc: "Активен ночью" },
};

// ==========================================
// PROMO/SERVICE CONFIGURATION
// ==========================================

const PROMO_SERVICES = {
  "itch_io": { 
    id: "itch_io", 
    name: "🎮 Страница на itch.io", 
    url: ITCH_IO_URL,
    desc: "Наша игра на платформе itch.io"
  },
  "community": { 
    id: "community", 
    name: " Наше сообщество", 
    url: "https://t.me/undercurcommunity", // ЗАМЕНИ НА СВОЮ ССЫЛКУ
    desc: "Присоединяйся к нашему комьюнити"
  },
  "tg_channel": { 
    id: "tg_channel", 
    name: "📢 Telegram канал", 
    url: CHANNEL_URL,
    desc: "Подпишись на наш канал"
  },
  "promo_code": { 
    id: "promo_code", 
    name: "🎁 Промокод", 
    url: null, // Будет генерироваться
    desc: "Получи промокод на бонусы"
  },
};

// ==========================================
// TELEGRAM API WRAPPERS
// ==========================================

/**
 * Makes a request to the Telegram Bot API.
 * @param {string} method - The API method name (e.g., 'sendMessage').
 * @param {object} body - The request payload.
 * @returns {Promise<object>} The API response.
 */
async function telegram(method, body = {}) {
  try {
    const response = await fetch(`${TG_API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!data.ok) {
      console.error(`[Telegram API Error] Method: ${method}`, data);
    }
    return data;
  } catch (error) {
    console.error(`[Telegram Network Error] Method: ${method}`, error.message);
    return { ok: false, error: error.message };
  }
}

/**
 * Sends a text message to a specified chat.
 */
async function sendMessage(chatId, text, extra = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    parse_mode: "HTML",
    ...extra,
  });
}

/**
 * Forwards a message from one chat to another.
 */
async function forwardMessage(toChatId, fromChatId, messageId, extra = {}) {
  return telegram("forwardMessage", {
    chat_id: toChatId,
    from_chat_id: fromChatId,
    message_id: messageId,
    ...extra,
  });
}

/**
 * Copies a message from one chat to another (preserves formatting).
 */
async function copyMessage(toChatId, fromChatId, messageId, extra = {}) {
  return telegram("copyMessage", {
    chat_id: toChatId,
    from_chat_id: fromChatId,
    message_id: messageId,
    ...extra,
  });
}

/**
 * Edits an existing text message.
 */
async function editMessage(chatId, messageId, text, extra = {}) {
  return telegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
    parse_mode: "HTML",
    ...extra,
  });
}

/**
 * Answers a callback query, optionally with a toast notification.
 */
async function answerCallback(callbackId, text = "", showAlert = false) {
  return telegram("answerCallbackQuery", {
    callback_query_id: callbackId,
    text,
    show_alert: showAlert,
  });
}

/**
 * Sets a reaction on a message (e.g., in a channel).
 */
async function setMessageReaction(chatId, messageId, emoji, isBig = true) {
  return telegram("setMessageReaction", {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: "emoji", emoji: emoji }],
    is_big: isBig,
  });
}

/**
 * Deletes a message.
 */
async function deleteMessage(chatId, messageId) {
  return telegram("deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
}

// ==========================================
// UTILITY & HELPER FUNCTIONS
// ==========================================

/**
 * Checks if a user ID is in the admin list.
 */
function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

/**
 * Escapes HTML special characters to prevent formatting injection.
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
 * Formats a timestamp into a readable Russian date string.
 */
function formatDate(timestamp) {
  if (!timestamp) return "Неизвестно";
  return new Date(timestamp).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Generates a unique ticket ID.
 */
function generateTicketId() {
  return "TKT-" + Math.random().toString(36).substr(2, 6).toUpperCase();
}

// ==========================================
// INLINE KEYBOARD BUILDERS
// ==========================================

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📰 Новости", callback_data: "news_menu" },
        { text: "🎮 Версии игры", callback_data: "versions" },
      ],
      [
        { text: "📖 Гайд и FAQ", callback_data: "guide_menu" },
        { text: "📥 Скачать игру", callback_data: "download_info" },
      ],
      [
        { text: "💬 Написать разработчикам", callback_data: "developers" },
        { text: "🏆 Достижения", callback_data: "my_badges" },
      ],
      [
        { text: "🎁 Промокоды", callback_data: "promo_list" },
        { text: "ℹ️ Помощь / Команды", callback_data: "help" },
      ],
    ],
  };
}

function newsKeyboard(enabled) {
  return {
    inline_keyboard: [
      [
        {
          text: enabled ? "🔕 Выключить уведомления" : "🔔 Включить уведомления",
          callback_data: enabled ? "news_disable" : "news_enable",
        },
      ],
      [{ text: "⬅️ Назад в главное меню", callback_data: "home" }],
    ],
  };
}

function developersKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🐞 Сообщить о баге", callback_data: "developer_bug" }],
      [{ text: "💡 Предложить идею", callback_data: "developer_idea" }],
      [{ text: "💬 Другой вопрос", callback_data: "developer_other" }],
      [{ text: "📋 Мои тикеты", callback_data: "my_tickets" }],
      [{ text: "⬅️ Назад", callback_data: "home" }],
    ],
  };
}

function downloadKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📢 Telegram канал", url: CHANNEL_URL },
        { text: "🎮 itch.io страница", url: ITCH_IO_URL },
      ],
      [{ text: "🎮 Все версии игры", callback_data: "versions" }],
      [{ text: "📖 Как запустить? (Гайд)", callback_data: "guide_launch" }],
      [{ text: "⬅️ Назад", callback_data: "home" }],
    ],
  };
}

function backKeyboard(target = "home") {
  return {
    inline_keyboard: [[{ text: "⬅️ Назад", callback_data: target }]],
  };
}

function paginationKeyboard(currentPage, totalPages, targetPrefix, extraData = "") {
  const buttons = [];
  const row = [];
  
  if (currentPage > 1) {
    row.push({ text: "⬅️ Назад", callback_data: `${targetPrefix}_page_${currentPage - 1}${extraData}` });
  }
  
  row.push({ text: `${currentPage} / ${totalPages}`, callback_data: "ignore" });
  
  if (currentPage < totalPages) {
    row.push({ text: "Вперед ➡️", callback_data: `${targetPrefix}_page_${currentPage + 1}${extraData}` });
  }
  
  buttons.push(row);
  buttons.push([{ text: "🏠 В главное меню", callback_data: "home" }]);
  
  return { inline_keyboard: buttons };
}

function ticketActionKeyboard(ticketId, isAdmin = false) {
  const keyboard = { inline_keyboard: [] };
  
  if (isAdmin) {
    keyboard.inline_keyboard.push([
      { text: "✏️ Ответить", callback_data: `admin_reply_ticket_${ticketId}` },
      { text: "✅ Закрыть", callback_data: `admin_close_ticket_${ticketId}` }
    ]);
  } else {
    keyboard.inline_keyboard.push([
      { text: "🔄 Обновить статус", callback_data: `check_ticket_${ticketId}` }
    ]);
  }
  
  keyboard.inline_keyboard.push([{ text: "⬅️ Назад", callback_data: "developers" }]);
  return keyboard;
}

function shareBotKeyboard(userId) {
  const botUsername = process.env.BOT_USERNAME || "undercur_bot";
  const refLink = `https://t.me/${botUsername}?start=ref_${userId}`;
  
  return {
    inline_keyboard: [
      [
        { text: "📋 Скопировать ссылку", url: refLink },
      ],
      [
        { text: " Мои достижения", callback_data: "my_badges" },
      ],
      [{ text: "⬅️ Назад", callback_data: "home" }],
    ],
  };
}

function versionSubscribeKeyboard(version, isSubscribed) {
  return {
    inline_keyboard: [
      [
        {
          text: isSubscribed ? "🔕 Отписаться" : "🔔 Подписаться",
          callback_data: isSubscribed ? `unwatch_${version}` : `watch_${version}`,
        },
      ],
      [{ text: "⬅️ Назад к версиям", callback_data: "versions" }],
    ],
  };
}

function promoKeyboard() {
  const buttons = Object.values(PROMO_SERVICES).map(service => [
    { text: service.name, url: service.url || `https://t.me/${process.env.BOT_USERNAME || "undercur_bot"}?start=promo_${service.id}` },
  ]);
  
  buttons.push([{ text: "️ Назад", callback_data: "home" }]);
  
  return { inline_keyboard: buttons };
}

function badgeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: " Все бейджи", callback_data: "all_badges_list" }],
      [{ text: "🔗 Пригласить друга", callback_data: "share_bot" }],
      [{ text: "⬅️ Назад", callback_data: "home" }],
    ],
  };
}

// ==========================================
// KV DATABASE MANAGEMENT
// ==========================================

// --- Users ---
async function saveUser(userId, data = {}) {
  const key = `undercur:user:${userId}`;
  const old = (await kv.get(key)) || {};
  const now = Date.now();
  
  await kv.set(key, {
    ...old,
    userId: String(userId),
    news: old.news !== undefined ? old.news : true,
    lang: old.lang || "ru",
    createdAt: old.createdAt || now,
    lastSeen: now,
    messageCount: (old.messageCount || 0) + 1,
    badges: old.badges || [],
    referrals: old.referrals || [],
    referredBy: old.referredBy || null,
    versionSubscriptions: old.versionSubscriptions || [],
    ...data,
    updatedAt: now,
  });
  
  await kv.sadd("undercur:users", String(userId));
}

async function getUser(userId) {
  const user = await kv.get(`undercur:user:${userId}`);
  if (!user) {
    return {
      userId: String(userId),
      news: true,
      lang: "ru",
      createdAt: Date.now(),
      lastSeen: Date.now(),
      messageCount: 0,
      ticketsCreated: 0,
      badges: [],
      referrals: [],
      referredBy: null,
      versionSubscriptions: [],
    };
  }
  return user;
}

async function updateUserStats(userId, updates) {
  const key = `undercur:user:${userId}`;
  const user = await getUser(userId);
  await kv.set(key, { ...user, ...updates, updatedAt: Date.now() });
}

// --- Badges ---
async function awardBadge(userId, badgeId) {
  const user = await getUser(userId);
  if (!user.badges.includes(badgeId)) {
    user.badges.push(badgeId);
    await kv.set(`undercur:user:${userId}`, user);
    return true;
  }
  return false;
}

async function getUserBadges(userId) {
  const user = await getUser(userId);
  return user.badges.map(bid => BADGES[bid]).filter(Boolean);
}

// --- Referrals ---
async function processReferral(newUserId, referrerId) {
  if (!referrerId || String(newUserId) === String(referrerId)) return false;
  
  const newUser = await getUser(newUserId);
  if (newUser.referredBy) return false; // Уже есть реферер
  
  const referrer = await getUser(referrerId);
  
  // Записываем реферера
  newUser.referredBy = String(referrerId);
  await kv.set(`undercur:user:${newUserId}`, newUser);
  
  // Добавляем в список рефералов
  referrer.referrals.push({
    userId: String(newUserId),
    date: Date.now(),
  });
  await kv.set(`undercur:user:${referrerId}`, referrer);
  
  // Проверяем и выдаём бейджи
  const refCount = referrer.referrals.length;
  if (refCount >= 1) await awardBadge(referrerId, "ref_1");
  if (refCount >= 5) await awardBadge(referrerId, "ref_5");
  if (refCount >= 10) await awardBadge(referrerId, "ref_10");
  if (refCount >= 25) await awardBadge(referrerId, "ref_25");
  if (refCount >= 50) await awardBadge(referrerId, "ref_50");
  
  return true;
}

// --- Version Subscriptions ---
async function subscribeToVersion(userId, version) {
  const user = await getUser(userId);
  const subs = user.versionSubscriptions || [];
  
  if (!subs.includes(version)) {
    subs.push(version);
    user.versionSubscriptions = subs;
    await kv.set(`undercur:user:${userId}`, user);
    return true;
  }
  return false;
}

async function unsubscribeFromVersion(userId, version) {
  const user = await getUser(userId);
  const subs = user.versionSubscriptions || [];
  const idx = subs.indexOf(version);
  
  if (idx >= 0) {
    subs.splice(idx, 1);
    user.versionSubscriptions = subs;
    await kv.set(`undercur:user:${userId}`, user);
    return true;
  }
  return false;
}

async function notifyVersionSubscribers(version, versionData) {
  const users = (await kv.smembers("undercur:users")) || [];
  console.log(`[DEBUG notify] Проверка подписчиков для версии: ${version}. Всего пользователей в БД: ${users.length}`);
  
  let notified = 0;
  
  for (const uId of users) {
    const user = await getUser(uId);
    const subs = user.versionSubscriptions || [];
    
    console.log(`[DEBUG notify] Пользователь ${uId} имеет подписки:`, subs);

    if (subs.includes(version) || subs.includes("*")) {
      try {
        const statusText = (versionData && versionData.status) ? ` (${versionData.status})` : "";
        await sendMessage(uId, 
          `🚀 <b>Вышла новая версия!</b>\n\n` +
          `Версия: <b>${version}${statusText}</b>\n` +
          `Дата: ${formatDate(Date.now())}\n\n` +
          `📥 Скачать: ${ITCH_IO_URL}\n` +
          `📢 Канал: ${CHANNEL_URL}\n\n` +
          `<i>Чтобы отписаться: /unwatch ${version}</i>`
        );
        notified++;
      } catch (e) {
        console.error(`[Notify Error] Не удалось отправить пользователю ${uId}:`, e.message);
      }
    }
  }
  
  console.log(`[DEBUG notify] Итого успешно уведомлено пользователей: ${notified}`);
  return notified;
}

// --- Scheduled Posts ---
async function schedulePost(date, time, text, channelId = NEWS_CHANNEL) {
  const scheduledPosts = (await kv.get("undercur:scheduled_posts")) || [];
  const post = {
    id: Date.now().toString(36),
    date,
    time,
    text,
    channelId,
    createdAt: Date.now(),
    status: "pending",
  };
  scheduledPosts.push(post);
  await kv.set("undercur:scheduled_posts", scheduledPosts);
  return post;
}

async function getScheduledPosts() {
  return (await kv.get("undercur:scheduled_posts")) || [];
}

async function cancelScheduledPost(postId) {
  let posts = await getScheduledPosts();
  const before = posts.length;
  posts = posts.filter(p => p.id !== postId);
  await kv.set("undercur:scheduled_posts", posts);
  return before - posts.length;
}

async function checkAndPublishScheduledPosts() {
  const posts = await getScheduledPosts();
  const now = new Date();
  const published = [];
  
  for (const post of posts) {
    if (post.status === "pending") {
      const postDate = new Date(`${post.date}T${post.time}`);
      if (postDate <= now) {
        try {
          await sendMessage(post.channelId, post.text);
          post.status = "published";
          post.publishedAt = Date.now();
          published.push(post);
        } catch (e) {
          console.error("Ошибка публикации запланированного поста:", e.message);
          post.status = "failed";
        }
      }
    }
  }
  
  if (published.length > 0) {
    await kv.set("undercur:scheduled_posts", posts);
  }
  
  return published;
}

// --- Moderation ---
async function isBanned(userId) {
  return await kv.sismember("undercur:banned_users", String(userId));
}

async function banUser(userId, adminId, reason = "Не указана") {
  await kv.sadd("undercur:banned_users", String(userId));
  await kv.set(`undercur:ban_reason:${userId}`, { adminId, reason, date: Date.now() });
}

async function unbanUser(userId) {
  await kv.srem("undercur:banned_users", String(userId));
  await kv.del(`undercur:ban_reason:${userId}`);
}

async function isMuted(userId) {
  const muteData = await kv.get(`undercur:muted:${userId}`);
  if (!muteData) return false;
  if (muteData.expiresAt && Date.now() > muteData.expiresAt) {
    await kv.del(`undercur:muted:${userId}`);
    return false;
  }
  return true;
}

async function muteUser(userId, durationMs, adminId, reason = "Не указана") {
  await kv.set(`undercur:muted:${userId}`, {
    adminId,
    reason,
    mutedAt: Date.now(),
    expiresAt: Date.now() + durationMs,
  });
}

async function unmuteUser(userId) {
  await kv.del(`undercur:muted:${userId}`);
}

// --- Versions ---
async function getStoredVersions() {
  const versions = await kv.get("undercur:versions");
  if (!versions) return [];
  if (typeof versions === "string") {
    try { return JSON.parse(versions); } catch { return []; }
  }
  return Array.isArray(versions) ? versions : [];
}

async function setStoredVersions(versions) {
  await kv.set("undercur:versions", JSON.stringify(versions));
}

// --- Tickets ---
async function createTicket(userId, category, message, messageId, chatId) {
  const ticketId = generateTicketId();
  const ticket = {
    id: ticketId,
    userId: String(userId),
    category,
    message,
    messageId,
    chatId,
    status: "open",
    createdAt: Date.now(),
    replies: [],
  };
  
  await kv.set(`undercur:ticket:${ticketId}`, ticket);
  await kv.sadd(`undercur:user_tickets:${userId}`, ticketId);
  await kv.sadd("undercur:all_tickets", ticketId);
  
  const user = await getUser(userId);
  await updateUserStats(userId, { ticketsCreated: (user.ticketsCreated || 0) + 1 });
  
  // Проверяем бейджи за тикеты
  const ticketCount = (user.ticketsCreated || 0) + 1;
  if (category === "🐞 Сообщить о баге") {
    if (ticketCount >= 1) await awardBadge(userId, "bug_hunter_1");
    if (ticketCount >= 5) await awardBadge(userId, "bug_hunter_5");
    if (ticketCount >= 10) await awardBadge(userId, "bug_hunter_10");
  } else if (category === "💡 Предложить идею") {
    if (ticketCount >= 1) await awardBadge(userId, "idea_master_1");
    if (ticketCount >= 5) await awardBadge(userId, "idea_master_5");
  }
  
  return ticket;
}

async function getTicket(ticketId) {
  return await kv.get(`undercur:ticket:${ticketId}`);
}

async function updateTicket(ticketId, updates) {
  const ticket = await getTicket(ticketId);
  if (!ticket) return null;
  
  const updated = { ...ticket, ...updates };
  await kv.set(`undercur:ticket:${ticketId}`, updated);
  return updated;
}

async function getUserTickets(userId) {
  const ticketIds = await kv.smembers(`undercur:user_tickets:${userId}`) || [];
  const tickets = [];
  for (const id of ticketIds) {
    const t = await getTicket(id);
    if (t) tickets.push(t);
  }
  return tickets.sort((a, b) => b.createdAt - a.createdAt);
}

// --- FAQ ---
async function getAllFaqs() {
  const faqs = await kv.get("undercur:faqs") || [];
  return Array.isArray(faqs) ? faqs : [];
}

async function addFaq(question, answer) {
  const faqs = await getAllFaqs();
  const newFaq = {
    id: Date.now().toString(36),
    question: question.trim(),
    answer: answer.trim(),
    createdAt: Date.now(),
  };
  faqs.push(newFaq);
  await kv.set("undercur:faqs", faqs);
  return newFaq;
}

async function deleteFaq(faqId) {
  let faqs = await getAllFaqs();
  faqs = faqs.filter(f => f.id !== faqId);
  await kv.set("undercur:faqs", faqs);
}

async function searchFaqs(query) {
  const faqs = await getAllFaqs();
  const lowerQuery = query.toLowerCase();
  
  return faqs.filter(faq => 
    faq.question.toLowerCase().includes(lowerQuery) ||
    faq.answer.toLowerCase().includes(lowerQuery)
  );
}

// --- Promo Codes ---
async function generatePromoCode(code, reward, maxUses = 100) {
  const promo = {
    code: code.toUpperCase(),
    reward,
    maxUses,
    usedBy: [],
    createdAt: Date.now(),
    active: true,
  };
  
  await kv.set(`undercur:promo:${code.toUpperCase()}`, promo);
  return promo;
}

async function usePromoCode(userId, code) {
  const promo = await kv.get(`undercur:promo:${code.toUpperCase()}`);
  if (!promo) return { success: false, error: "not_found" };
  if (!promo.active) return { success: false, error: "inactive" };
  if (promo.usedBy.includes(String(userId))) return { success: false, error: "already_used" };
  if (promo.usedBy.length >= promo.maxUses) return { success: false, error: "max_uses" };
  
  promo.usedBy.push(String(userId));
  await kv.set(`undercur:promo:${code.toUpperCase()}`, promo);
  
  // Награждаем пользователя (можно расширить)
  await awardBadge(userId, "supporter");
  
  return { success: true, reward: promo.reward };
}

async function getAllPromoCodes() {
  // Получаем все ключи с префиксом undercur:promo:
  const keys = await kv.keys("undercur:promo:*");
  const promos = [];
  for (const key of keys) {
    const promo = await kv.get(key);
    if (promo) promos.push(promo);
  }
  return promos;
}

// ==========================================
// VERSION PARSING & MANAGEMENT
// ==========================================

function parseVersionString(str) {
  const trimmed = str.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^([\d][\d\w.\-]*)\s*(?:\(([^)]+)\)|(\S+))?$/);
  if (!match) return null;

  const version = match[1];
  const status = (match[2] || match[3] || "").trim();

  return { version, status, url: null, addedAt: Date.now() };
}

function parseMultipleVersions(input) {
  const parts = input.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
  const results = [];

  for (const part of parts) {
    const parsed = parseVersionString(part);
    if (parsed) results.push(parsed);
  }

  return results;
}

function versionTitle(item) {
  const statusEmoji = {
    "beta": "🧪", "fix": "🔧", "stable": "✅", "alpha": "🔬",
    "dev": "🛠️", "rc": "📦", "hotfix": "🚑", "patch": "🩹",
  };

  const emoji = item.status ? (statusEmoji[item.status.toLowerCase()] || "📌") : "📌";
  const statusText = item.status ? ` (${item.status})` : "";
  return `${emoji} ${item.version}${statusText}`.trim();
}

function parseVersions(value) {
  if (!value) return [];
  let data = value;
  if (typeof value === "string") {
    try { data = JSON.parse(value); } catch { return []; }
  }

  const result = [];

  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === "string") {
        result.push({ version: item, status: "", url: null, addedAt: Date.now() });
        continue;
      }
      if (item && typeof item === "object") {
        result.push({
          version: String(item.version || item.name || item.tag || ""),
          status: String(item.status || item.state || ""),
          url: item.url || item.path || item.downloadUrl || null,
          addedAt: item.addedAt || Date.now(),
        });
      }
    }
    return result.filter(item => item.version);
  }

  if (data && typeof data === "object") {
    for (const [version, config] of Object.entries(data)) {
      if (config && typeof config === "object") {
        result.push({
          version,
          status: String(config.status || config.state || config.type || ""),
          url: config.url || config.path || config.downloadUrl || null,
          addedAt: Date.now(),
        });
      } else {
        result.push({ version, status: typeof config === "string" ? config : "", url: null, addedAt: Date.now() });
      }
    }
  }

  return result;
}

async function getVersions() {
  const stored = await getStoredVersions();
  if (stored.length) return stored;

  try {
    const response = await fetch(VERSIONS_API, { headers: { Accept: "application/json" } });
    if (response.ok) {
      const data = await response.json();
      const source = data.versions || data.data || data;
      const versions = parseVersions(source);
      if (versions.length) {
        await setStoredVersions(versions);
        return versions;
      }
    }
  } catch (error) {
    console.error("External versions API error:", error.message);
  }

  return parseVersions(process.env.UNDERCUR_VERSIONS_JSON);
}

// ==========================================
// MESSAGE GENERATORS
// ==========================================

async function sendHome(chatId, messageId = null) {
  const text =
    "👋 <b>Добро пожаловать в UnderCur!</b>\n\n" +
    "Это официальный бот-помощник проекта UnderCur.\n" +
    "Здесь вы можете узнать о последних обновлениях, скачать игру, " +
    "прочитать гайд по запуску или связаться с командой разработки.\n\n" +
    "📢 <b>Наш канал:</b> @undercurgame\n" +
    "🎮 <b>Страница itch.io:</b> ivtt.itch.io/undercur\n\n" +
    "Выберите нужный раздел в меню ниже:";

  const extra = { reply_markup: mainKeyboard() };

  if (messageId) {
    return editMessage(chatId, messageId, text, extra);
  }
  return sendMessage(chatId, text, extra);
}

async function sendHelp(chatId, messageId = null) {
  const text =
    "ℹ️ <b>Список доступных команд</b>\n\n" +
    "<b>📋 Основные:</b>\n" +
    "/start — Главное меню бота\n" +
    "/help — Показать это сообщение\n" +
    "/profile — Мой профиль и статистика\n" +
    "/guide — Интерактивный гайд по игре\n" +
    "/faq [запрос] — Часто задаваемые вопросы (с поиском)\n\n" +
    
    "<b>🎮 Версии и скачивание:</b>\n" +
    "/versions — Список актуальных версий\n" +
    "/download — Ссылки для скачивания игры\n" +
    "/watch <code>версия</code> — Подписаться на выход версии (или *)\n" +
    "/unwatch <code>версия</code> — Отписаться от версии\n" +
    "/mysubs — Мои активные подписки на версии\n\n" +
    
    "<b>🏆 Сообщество и бонусы:</b>\n" +
    "/badges — Мои достижения и бейджи\n" +
    "/share — Получить реферальную ссылку для приглашения\n" +
    "/promolist — Список доступных промокодов и акций\n" +
    "/promo <code>код</code> — Активировать промокод\n" +
    "/news — Настройка уведомлений о новостях\n\n" +
    
    "<b>🔧 Команды для администраторов:</b>\n" +
    "/add <code>версии</code> — Добавить новые версии\n" +
    "/delete <code>версия</code> — Удалить версию из списка\n" +
    "/all — Полный список сохраненных версий\n" +
    "/clearversions — Полная очистка списка версий\n" +
    "/news <code>текст</code> — Опубликовать новость (или ответ на сообщение)\n" +
    "/schedule <code>ГГГГ-ММ-ДД ЧЧ:ММ текст</code> — Запланировать пост\n" +
    "/unschedule <code>id</code> — Отменить запланированный пост\n" +
    "/scheduled — Список запланированных постов\n" +
    "/genpromo <code>КОД награда [лимит]</code> — Создать новый промокод\n" +
    "/promos — Список всех созданных промокодов\n" +
    "/sendall <code>текст</code> — Массовая рассылка всем пользователям\n" +
    "/stats — Подробная статистика бота\n" +
    "/ban <code>id</code> [причина] — Заблокировать пользователя\n" +
    "/unban <code>id</code> — Разблокировать пользователя\n" +
    "/finduser <code>id</code> — Информация о пользователе\n\n" +
    
    "💡 <i>Пример:</i> /add 1.0.1, 1.0.2 (beta)\n" +
    "💡 <i>Пример:</i> /watch 2.0\n" +
    "💡 <i>Пример:</i> /faq как запустить\n" +
    "💡 <i>Пример:</i> /schedule 2026-10-01 15:00 Релиз новой версии!";

  if (messageId) {
    return editMessage(chatId, messageId, text, { reply_markup: backKeyboard() });
  }
  return sendMessage(chatId, text, { reply_markup: backKeyboard() });
}

async function versionsMessage(chatId, messageId = null, page = 1) {
  const versions = await getVersions();
  const itemsPerPage = 8;
  const totalPages = Math.ceil(versions.length / itemsPerPage) || 1;
  const currentPage = Math.min(Math.max(1, page), totalPages);

  if (!versions.length) {
    const text = "🎮 Актуальные версии пока не опубликованы.\nСледите за новостями в нашем канале!";
    if (messageId) {
      return editMessage(chatId, messageId, text, { reply_markup: backKeyboard() });
    }
    return sendMessage(chatId, text, { reply_markup: backKeyboard() });
  }

  const startIdx = (currentPage - 1) * itemsPerPage;
  const endIdx = startIdx + itemsPerPage;
  const pageVersions = versions.slice(startIdx, endIdx);

  const buttons = pageVersions.map((item) => [
    { text: versionTitle(item), callback_data: `version:${item.version}|${item.status || ""}` },
  ]);

  buttons.push(
    [{ text: "📥 Скачать игру", callback_data: "download_info" }]
  );

  if (totalPages > 1) {
    buttons.push([
      { text: "⬅️ Назад", callback_data: currentPage > 1 ? `versions_page_${currentPage - 1}` : "home" },
      { text: `${currentPage} / ${totalPages}`, callback_data: "ignore" },
      { text: "Вперед ➡️", callback_data: currentPage < totalPages ? `versions_page_${currentPage + 1}` : "download_info" }
    ]);
  } else {
    buttons.push([{ text: "⬅️ Назад в главное меню", callback_data: "home" }]);
  }

  const text =
    "🎮 <b>Актуальные версии UnderCur</b>\n\n" +
    "Выберите версию из списка ниже для получения подробной информации и ссылок на скачивание.\n\n" +
    `📢 Официальный канал: ${OFFICIAL_CHANNEL}\n` +
    `🎮 Страница itch.io: ivtt.itch.io/undercur`;

  const extra = {
    reply_markup: { inline_keyboard: buttons },
  };

  if (messageId) {
    return editMessage(chatId, messageId, text, extra);
  }
  return sendMessage(chatId, text, extra);
}

async function showVersion(chatId, messageId, version, status) {
  const versions = await getVersions();
  const item = versions.find(
    (entry) => entry.version === version && (!status || entry.status === status)
  ) || versions.find((entry) => entry.version === version);

  if (!item) {
    return editMessage(chatId, messageId, "❌ Версия не найдена в базе данных.", {
      reply_markup: backKeyboard("versions"),
    });
  }

  const statusText = item.status ? `\n📌 <b>Статус:</b> ${item.status}` : "";
  const addedDate = item.addedAt ? `\n📅 <b>Добавлена:</b> ${formatDate(item.addedAt)}` : "";

  let text =
    `🎮 <b>Версия ${item.version}</b>${statusText}${addedDate}\n\n` +
    "📥 <b>Скачать эту версию можно в следующих источниках:</b>\n\n" +
    `1️⃣ Telegram канал: ${OFFICIAL_CHANNEL}\n` +
    `2️⃣ itch.io: ${ITCH_IO_URL}\n\n` +
    "💻 <b>Требования для запуска:</b>\n" +
    "• Любой ПК (Windows / macOS / Linux)\n" +
    "• Установленный Microsoft PowerPoint\n" +
    "• Файл игры имеет формат <code>.ppsx</code>\n\n" +
    "🔍 Чтобы узнать о других версиях, используйте кнопку ниже.";

  const buttons = [
    [
      { text: "📢 Открыть канал", url: CHANNEL_URL },
      { text: "🎮 Открыть itch.io", url: ITCH_IO_URL },
    ],
  ];

  if (item.url) {
    buttons.unshift([{ text: "⬇️ Прямая ссылка на скачивание", url: item.url }]);
  }

  buttons.push(
    [{ text: "⬅️ К списку версий", callback_data: "versions" }],
    [{ text: "🏠 Главное меню", callback_data: "home" }]
  );

  return editMessage(chatId, messageId, text, {
    reply_markup: { inline_keyboard: buttons },
  });
}

async function sendDownloadInfo(chatId, messageId = null) {
  const text =
    "📥 <b>Скачать UnderCur</b>\n\n" +
    "Игра доступна для бесплатного скачивания в двух основных источниках:\n\n" +
    `1️⃣ <b>Telegram канал:</b> ${OFFICIAL_CHANNEL}\n` +
    `   → ${CHANNEL_URL}\n\n` +
    `2️⃣ <b>itch.io:</b> ivtt.itch.io/undercur\n` +
    `   → ${ITCH_IO_URL}\n\n` +
    "💻 <b>Системные требования:</b>\n" +
    "• Операционная система: Windows, macOS или Linux\n" +
    "• Программное обеспечение: Microsoft PowerPoint (для запуска .ppsx файлов)\n\n" +
    "🔍 Узнать список всех актуальных версий можно через кнопку «🎮 Версии игры».";

  if (messageId) {
    return editMessage(chatId, messageId, text, {
      reply_markup: downloadKeyboard(),
    });
  }
  return sendMessage(chatId, text, { reply_markup: downloadKeyboard() });
}

// ==========================================
// NEWS PUBLISHING SYSTEM (BUG FIXED: copyMessage instead of forwardMessage)
// ==========================================

async function publishNews(message, adminUserId) {
  const users = (await kv.smembers("undercur:users")) || [];
  let channelSent = false;
  let sentCount = 0;
  let error = null;

  // 1. Надежное извлечение текста или подписи (caption)
  let rawContent = message.text || message.caption || "";
  
  if (message.reply_to_message) {
    rawContent = message.reply_to_message.text || message.reply_to_message.caption || rawContent;
  }

  // 2. Максимально надежное удаление команды /news
  let cleanedContent = rawContent;
  const commandRegex = /^\/news(?:@\w+)?[\s\n\r]+/i;
  
  if (commandRegex.test(rawContent)) {
    cleanedContent = rawContent.replace(commandRegex, "").trim();
  } else {
    cleanedContent = rawContent.replace(/^\/news(?:@\w+)?/i, "").trim();
  }

  // Если после удаления команды ничего не осталось (и это не просто медиа без текста)
  if (!cleanedContent && !message.photo && !message.video && !message.document && !message.animation && !message.voice) {
    return { channelSent: false, sentCount: 0, error: "empty" };
  }

  const prefix = "📰 <b>Новость UnderCur</b>\n\n";
  const finalContent = cleanedContent ? prefix + cleanedContent : prefix + "Новость без текста (медиа)";

  // 3. Определяем, есть ли медиа
  const isMedia = message.photo || message.animation || message.voice || message.video || message.document || message.video_note || 
                  (message.reply_to_message && (message.reply_to_message.photo || message.reply_to_message.document || message.reply_to_message.video || message.reply_to_message.animation));
  
  const extra = {};

  if (!isMedia) {
    // Текстовое сообщение
    extra.parse_mode = "HTML";
    extra.disable_web_page_preview = false;
    const sourceEntities = message.reply_to_message ? message.reply_to_message.entities : message.entities;
    if (sourceEntities) {
      const commandLength = rawContent.length - cleanedContent.length;
      extra.entities = sourceEntities
        .map((entity) => ({
          ...entity,
          offset: Math.max(0, entity.offset - commandLength + (cleanedContent ? prefix.length : 0)),
        }))
        .filter((entity) => entity.offset >= 0 && entity.length > 0);
    }
  } else {
    // Медиа-сообщение (используем caption)
    extra.caption = finalContent;
    extra.parse_mode = "HTML";
    const sourceCaptionEntities = message.reply_to_message ? message.reply_to_message.caption_entities : message.caption_entities;
    if (sourceCaptionEntities) {
      const commandLength = rawContent.length - cleanedContent.length;
      extra.caption_entities = sourceCaptionEntities
        .map((entity) => ({
          ...entity,
          offset: Math.max(0, entity.offset - commandLength + (cleanedContent ? prefix.length : 0)),
        }))
        .filter((entity) => entity.offset >= 0 && entity.length > 0);
    }
  }

  const channelUsername = NEWS_CHANNEL.replace(/^@/, "");
  extra.reply_markup = {
    inline_keyboard: [
      [{ text: "📢 Поделиться новостью / Обсудить", url: `https://t.me/${channelUsername}` }],
    ],
  };

  try {
    let result;
    const targetChatId = message.reply_to_message ? message.reply_to_message.chat.id : message.chat.id;
    const targetMsgId = message.reply_to_message ? message.reply_to_message.message_id : message.message_id;

    if (isMedia) {
      // ИСПРАВЛЕНИЕ: Используем copyMessage вместо forwardMessage, чтобы заменить caption
      result = await copyMessage(NEWS_CHANNEL, targetChatId, targetMsgId, {
        caption: extra.caption,
        parse_mode: extra.parse_mode,
        caption_entities: extra.caption_entities,
        reply_markup: extra.reply_markup,
      });
    } else {
      result = await sendMessage(NEWS_CHANNEL, finalContent, extra);
    }
    channelSent = result.ok === true;
  } catch (error) {
    console.error("Ошибка публикации в канал:", error.message);
    error = error.message;
  }

  // Рассылка пользователям
  for (const recipientId of users) {
    if (String(recipientId) === String(adminUserId)) continue;
    
    const recipient = await getUser(recipientId);
    if (recipient.news === false) continue;

    try {
      let result;
      if (isMedia) {
        const targetChatId = message.reply_to_message ? message.reply_to_message.chat.id : message.chat.id;
        const targetMsgId = message.reply_to_message ? message.reply_to_message.message_id : message.message_id;
        
        // ИСПРАВЛЕНИЕ: Используем copyMessage и для рассылки, чтобы убрать /news из caption
        result = await copyMessage(recipientId, targetChatId, targetMsgId, {
          caption: extra.caption,
          parse_mode: extra.parse_mode,
          caption_entities: extra.caption_entities,
        });
      } else {
        result = await sendMessage(recipientId, finalContent, extra);
      }
      
      if (result.ok) sentCount++;
      
      // Небольшая задержка для предотвращения flood control
      await new Promise(resolve => setTimeout(resolve, 30));
    } catch (error) {
      if (!error.message.includes("Forbidden") && !error.message.includes("blocked")) {
        console.error("Ошибка рассылки пользователю:", error.message);
      }
    }
  }

  return { channelSent, sentCount, error };
}

// ==========================================
// GUIDE & FAQ SYSTEMS (ВОССТАНОВЛЕНО)
// ==========================================

async function sendGuideMenu(chatId, messageId = null) {
  const text = "📖 <b>Гайд по UnderCur</b>\n\nВыберите раздел, который вас интересует:";
  const keyboard = {
    inline_keyboard: [
      [{ text: "🚀 Как запустить игру?", callback_data: "guide_launch" }],
      [{ text: "⚙️ Решение частых проблем", callback_data: "guide_troubleshoot" }],
      [{ text: "🎮 Управление в игре", callback_data: "guide_controls" }],
      [{ text: "⬅️ Назад", callback_data: "home" }]
    ]
  };
  
  if (messageId) {
    return editMessage(chatId, messageId, text, { reply_markup: keyboard });
  }
  return sendMessage(chatId, text, { reply_markup: keyboard });
}

async function sendFaqList(chatId, messageId = null) {
  const faqs = await getAllFaqs();
  
  if (!faqs.length) {
    const text = "❓ <b>Часто задаваемые вопросы</b>\n\nПока здесь пусто. Если у вас есть вопрос, напишите разработчикам через меню!";
    if (messageId) return editMessage(chatId, messageId, text, { reply_markup: backKeyboard() });
    return sendMessage(chatId, text, { reply_markup: backKeyboard() });
  }

  let text = "❓ <b>Часто задаваемые вопросы (FAQ)</b>\n\n";
  const keyboard = { inline_keyboard: [] };
  
  faqs.forEach((faq, index) => {
    text += `<b>${index + 1}.</b> ${escapeHtml(faq.question)}\n`;
    keyboard.inline_keyboard.push([{ text: `👁️ Показать ответ #${index + 1}`, callback_data: `faq_show_${faq.id}` }]);
  });
  
  keyboard.inline_keyboard.push([{ text: "⬅️ Назад", callback_data: "home" }]);
  
  if (messageId) {
    return editMessage(chatId, messageId, text, { reply_markup: keyboard });
  }
  return sendMessage(chatId, text, { reply_markup: keyboard });
}

// ==========================================
// NEW FEATURE MESSAGE GENERATORS
// ==========================================

async function sendBadgesMenu(chatId, messageId = null) {
  const user = await getUser(chatId);
  const userBadges = await getUserBadges(chatId);
  
  let text = "🏆 <b>Ваши достижения</b>\n\n";
  
  if (userBadges.length === 0) {
    text += "Пока нет полученных бейджей.\n\n";
    text += "<b>Как получить:</b>\n";
    text += "• Пригласи друзей (реферальная система)\n";
    text += "• Будь активен в боте\n";
    text += "• Находи баги и предлагай идеи\n";
    text += "• Участвуй в бета-тестах\n";
  } else {
    text += `<b>Получено: ${userBadges.length}</b>\n\n`;
    userBadges.forEach(badge => {
      text += `${badge.emoji} <b>${badge.name}</b>\n<i>${badge.desc}</i>\n\n`;
    });
  }
  
  if (messageId) {
    return editMessage(chatId, messageId, text, { reply_markup: badgeKeyboard() });
  }
  return sendMessage(chatId, text, { reply_markup: badgeKeyboard() });
}

async function sendShareBot(chatId, messageId = null) {
  const user = await getUser(chatId);
  const botUsername = process.env.BOT_USERNAME || "undercur_bot";
  const refLink = `https://t.me/${botUsername}?start=ref_${chatId}`;
  const refCount = user.referrals ? user.referrals.length : 0;
  
  const text = 
    "🔗 <b>Пригласи друзей и получи награды!</b>\n\n" +
    "Отправь эту ссылку друзьям:\n" +
    `<code>${refLink}</code>\n\n` +
    "🎁 <b>Награды за приглашения:</b>\n" +
    "🌱 1 друг — бейдж «Новичок»\n" +
    "🌿 5 друзей — бейдж «Садовод»\n" +
    "🌳 10 друзей — бейдж «Дерево»\n" +
    "🌲 25 друзей — бейдж «Лесник»\n" +
    "🌍 50 друзей — бейдж «Популярный»\n\n" +
    `📊 <b>Твои приглашения:</b> ${refCount}\n\n` +
    "<b>📝 Готовое сообщение для отправки:</b>\n" +
    "🎮 Привет! Играю в UnderCur — крутая игра на PowerPoint!\n" +
    "Присоединяйся: " + refLink;
  
  if (messageId) {
    return editMessage(chatId, messageId, text, { reply_markup: backKeyboard("home") });
  }
  return sendMessage(chatId, text, { reply_markup: backKeyboard("home") });
}

async function sendPromoList(chatId, messageId = null) {
  const text = 
    "🎁 <b>Промокоды и акции</b>\n\n" +
    "📝 <b>Как использовать:</b>\n" +
    "Отправь команду: <code>/promo CODE</code>\n\n" +
    "🔗 <b>Наши ресурсы:</b>\n" +
    `• itch.io: ${ITCH_IO_URL}\n` +
    `• Telegram: ${CHANNEL_URL}\n\n` +
    "💡 <i>Следи за новостями — там появляются промокоды!</i>";
  
  if (messageId) {
    return editMessage(chatId, messageId, text, { reply_markup: promoKeyboard() });
  }
  return sendMessage(chatId, text, { reply_markup: promoKeyboard() });
}

async function sendScheduledPostsList(chatId, messageId = null, isAdmin = false) {
  if (!isAdmin) {
    return sendMessage(chatId, "⛔ У вас нет прав для просмотра запланированных постов.");
  }
  
  const posts = await getScheduledPosts();
  
  if (posts.length === 0) {
    const text = "📅 <b>Запланированные посты</b>\n\nПока нет запланированных публикаций.\n\n" +
      "<b>Как создать:</b>\n" +
      "<code>/schedule 2026-09-25 12:00 Текст новости</code>";
    
    if (messageId) {
      return editMessage(chatId, messageId, text, { reply_markup: backKeyboard() });
    }
    return sendMessage(chatId, text, { reply_markup: backKeyboard() });
  }
  
  let text = "📅 <b>Запланированные посты</b>\n\n";
  const keyboard = { inline_keyboard: [] };
  
  posts.forEach((post, idx) => {
    const statusEmoji = post.status === "pending" ? "⏳" : post.status === "published" ? "✅" : "❌";
    text += `${idx + 1}. ${statusEmoji} <b>${post.date} ${post.time}</b>\n`;
    text += `<i>${escapeHtml(post.text.substring(0, 50))}...</i>\n\n`;
    
    if (post.status === "pending") {
      keyboard.inline_keyboard.push([{ 
        text: `❌ Отменить #${post.id}`, 
        callback_data: `unschedule_${post.id}` 
      }]);
    }
  });
  
  keyboard.inline_keyboard.push([{ text: "⬅️ Назад", callback_data: "home" }]);
  
  if (messageId) {
    return editMessage(chatId, messageId, text, { reply_markup: keyboard });
  }
  return sendMessage(chatId, text, { reply_markup: keyboard });
}

async function sendFaqSearch(chatId, query, messageId = null) {
  const results = await searchFaqs(query);
  
  if (results.length === 0) {
    const text = `🔍 <b>Поиск по FAQ: "${escapeHtml(query)}"</b>\n\n` +
      "Ничего не найдено. Попробуйте другой запрос или задайте вопрос разработчикам.";
    
    if (messageId) {
      return editMessage(chatId, messageId, text, { reply_markup: backKeyboard("home") });
    }
    return sendMessage(chatId, text, { reply_markup: backKeyboard("home") });
  }
  
  let text = `🔍 <b>Результаты поиска: "${escapeHtml(query)}"</b>\n\n`;
  const keyboard = { inline_keyboard: [] };
  
  results.slice(0, 5).forEach((faq, idx) => {
    text += `<b>${idx + 1}.</b> ${escapeHtml(faq.question)}\n`;
    keyboard.inline_keyboard.push([{ 
      text: `👁️ Показать #${idx + 1}`, 
      callback_data: `faq_show_${faq.id}` 
    }]);
  });
  
  keyboard.inline_keyboard.push([{ text: "⬅️ Назад к списку FAQ", callback_data: "home" }]);
  
  if (messageId) {
    return editMessage(chatId, messageId, text, { reply_markup: keyboard });
  }
  return sendMessage(chatId, text, { reply_markup: keyboard });
}

// ==========================================
// COMMAND PROCESSORS
// ==========================================

// ==========================================
// COMMAND PROCESSORS
// ==========================================

async function processCommand(message, text) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const command = text.split(/\s+/)[0].toLowerCase();
  const args = text.slice(command.length).trim();

  // Проверка на бан
  if (await isBanned(userId)) {
    return sendMessage(chatId, " Ваш аккаунт заблокирован в этом боте. Обратитесь к администрации.");
  }

  // Проверка на мут (для текстовых команд, кроме /start и /help)
  if (command !== "/start" && command !== "/help" && await isMuted(userId)) {
    return sendMessage(chatId, "🔇 Вы временно ограничены в использовании команд бота.");
  }

  // Проверяем запланированные посты
  await checkAndPublishScheduledPosts();

  await saveUser(userId);

  // Обработка реферальной ссылки в /start
  if (command === "/start") {
    if (args.startsWith("ref_")) {
      const referrerId = args.replace("ref_", "");
      const isNewUser = await processReferral(userId, referrerId);
      
      if (isNewUser) {
        await sendMessage(chatId, " <b>Вы зарегистрировались по реферальной ссылке!</b>\n\n" +
          "Теперь вы будете получать уведомления, а ваш друг получит бейдж за приглашение.");
        
        // Уведомляем реферера
        try {
          await sendMessage(referrerId, 
            `🎊 <b>Новый реферал!</b>\n\n` +
            `Пользователь <code>${userId}</code> зарегистрировался по вашей ссылке.\n` +
            `Всего приглашений: ${(await getUser(referrerId)).referrals.length}`
          );
        } catch (e) {
          // Игнорируем ошибки
        }
      }
    } else if (args.startsWith("promo_")) {
      const promoId = args.replace("promo_", "");
      const service = PROMO_SERVICES[promoId];
      if (service) {
        return sendMessage(chatId, 
          `🎁 <b>${service.name}</b>\n\n` +
          `${service.desc}\n\n` +
          `🔗 <b>Ссылка:</b> ${service.url || "Доступно в боте"}`
        );
      }
    }
    
    return sendHome(chatId);
  }

  if (command === "/help") {
    return sendHelp(chatId);
  }

  if (command === "/profile" || command === "/mydata") {
    const user = await getUser(userId);
    const joinDate = formatDate(user.createdAt);
    const lastSeen = formatDate(user.lastSeen);
    const ticketsCount = (await getUserTickets(userId)).length;
    const badgeCount = user.badges ? user.badges.length : 0;
    const refCount = user.referrals ? user.referrals.length : 0;
    const subCount = user.versionSubscriptions ? user.versionSubscriptions.length : 0;

    return sendMessage(
      chatId,
      `👤 <b>Ваш профиль UnderCur</b>\n\n` +
      `🆔 <b>ID:</b> <code>${userId}</code>\n` +
      `🔔 <b>Новости:</b> ${user.news !== false ? "✅ Включены" : "❌ Выключены"}\n` +
      `📅 <b>Дата регистрации:</b> ${joinDate}\n` +
      `🕒 <b>Последняя активность:</b> ${lastSeen}\n` +
      `💬 <b>Сообщений отправлено:</b> ${user.messageCount || 0}\n` +
      `🎫 <b>Создано тикетов:</b> ${ticketsCount}\n` +
      `🏆 <b>Бейджей:</b> ${badgeCount}\n` +
      `👥 <b>Приглашено друзей:</b> ${refCount}\n` +
      `🔔 <b>Подписок на версии:</b> ${subCount}\n\n` +
      `<b>Команды:</b>\n` +
      `/badges — мои достижения\n` +
      `/share — пригласить друга\n` +
      `/promolist — промокоды`,
      { reply_markup: backKeyboard() }
    );
  }

  if (command === "/badges" || command === "/achievements") {
    return sendBadgesMenu(chatId);
  }

  if (command === "/share" || command === "/invite") {
    return sendShareBot(chatId);
  }

  if (command === "/promolist" || command === "/promos") {
    return sendPromoList(chatId);
  }

  if (command === "/promo") {
    if (!args) {
      return sendMessage(chatId, "❌ Использование: <code>/promo CODE</code>\n\n" +
        "Пример: <code>/promo SUMMER2026</code>");
    }
    
    const result = await usePromoCode(userId, args);
    
    if (result.success) {
      return sendMessage(chatId, 
        `✅ <b>Промокод активирован!</b>\n\n` +
        `🎁 <b>Награда:</b> ${result.reward}\n\n` +
        "Проверьте свои бейджи: /badges");
    } else {
      const errors = {
        "not_found": "Промокод не найден",
        "inactive": "Промокод неактивен",
        "already_used": "Вы уже использовали этот промокод",
        "max_uses": "Промокод больше недоступен",
      };
      return sendMessage(chatId, `❌ ${errors[result.error] || "Ошибка активации"}`);
    }
  }

  if (command === "/watch") {
    if (!args) {
      return sendMessage(chatId, "❌ Использование: <code>/watch VERSION</code>\n\n" +
        "Пример: <code>/watch 2.0</code>\n" +
        "Или: <code>/watch *</code> — подписаться на все версии");
    }
    
    const subscribed = await subscribeToVersion(userId, args);
    
    if (subscribed) {
      return sendMessage(chatId, 
        `✅ <b>Подписка оформлена!</b>\n\n` +
        `Вы будете получать уведомления о версии: <code>${args}</code>\n\n` +
        `<i>Чтобы отписаться: /unwatch ${args}</i>`);
    } else {
      return sendMessage(chatId, "Вы уже подписаны на эту версию.");
    }
  }

  if (command === "/unwatch") {
    if (!args) {
      return sendMessage(chatId, "❌ Использование: <code>/unwatch VERSION</code>");
    }
    
    const unsubscribed = await unsubscribeFromVersion(userId, args);
    
    if (unsubscribed) {
      return sendMessage(chatId, `✅ Вы отписались от версии: <code>${args}</code>`);
    } else {
      return sendMessage(chatId, "Вы не были подписаны на эту версию.");
    }
  }

  if (command === "/mysubs" || command === "/subscriptions") {
    const user = await getUser(userId);
    const subs = user.versionSubscriptions || [];
    
    if (subs.length === 0) {
      return sendMessage(chatId, "🔔 <b>Ваши подписки</b>\n\n" +
        "Вы не подписаны ни на одну версию.\n\n" +
        "Используйте: <code>/watch VERSION</code>");
    }
    
    let text = " <b>Ваши подписки на версии:</b>\n\n";
    subs.forEach((v, i) => {
      text += `${i + 1}. <code>${v}</code>\n`;
    });
    
    return sendMessage(chatId, text);
  }

  if (command === "/schedule") {
    if (!isAdmin(userId)) {
      return sendMessage(chatId, "⛔ У вас нет прав для этой команды.");
    }
    
    // Формат: /schedule 2026-09-25 12:00 Текст новости
    const parts = args.split(/\s+/);
    if (parts.length < 3) {
      return sendMessage(chatId, 
        "❌ Использование: <code>/schedule DATE TIME TEXT</code>\n\n" +
        "Пример: <code>/schedule 2026-09-25 12:00 Новая версия игры!</code>");
    }
    
    const date = parts[0];
    const time = parts[1];
    const text = parts.slice(2).join(" ");
    
    const post = await schedulePost(date, time, text);
    
    return sendMessage(chatId, 
      `✅ <b>Пост запланирован!</b>\n\n` +
      `📅 Дата: ${date}\n` +
      ` Время: ${time}\n` +
      `📝 ID: <code>${post.id}</code>\n\n` +
      `<i>Отменить: /unschedule ${post.id}</i>`);
  }

  if (command === "/unschedule") {
    if (!isAdmin(userId)) {
      return sendMessage(chatId, "⛔ У вас нет прав для этой команды.");
    }
    
    if (!args) {
      return sendMessage(chatId, "❌ Использование: <code>/unschedule POST_ID</code>");
    }
    
    const deleted = await cancelScheduledPost(args);
    
    if (deleted > 0) {
      return sendMessage(chatId, `✅ Пост отменён.`);
    } else {
      return sendMessage(chatId, "Пост не найден или уже опубликован.");
    }
  }

  if (command === "/scheduled") {
    if (!isAdmin(userId)) {
      return sendMessage(chatId, "⛔ У вас нет прав для этой команды.");
    }
    return sendScheduledPostsList(chatId, null, true);
  }

  if (command === "/faq") {
    if (args) {
      return sendFaqSearch(chatId, args);
    }
    return sendFaqList(chatId);
  }
  

  if (command === "/stats") {
    if (!isAdmin(userId)) {
      return sendMessage(chatId, "⛔ У вас нет прав для использования этой команды.");
    }
    
    const users = (await kv.smembers("undercur:users")) || [];
    const bannedCount = (await kv.smembers("undercur:banned_users")) || [];
    const allTickets = (await kv.smembers("undercur:all_tickets")) || [];
    const versions = await getStoredVersions();
    const faqs = await getAllFaqs();
    const scheduledPosts = await getScheduledPosts();
    
    let newsEnabledCount = 0;
    let activeToday = 0;
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;

    for (const uId of users) {
      const user = await getUser(uId);
      if (user.news !== false) newsEnabledCount++;
      if (now - user.lastSeen < oneDayMs) activeToday++;
    }

    return sendMessage(
      chatId,
      `📊 <b>Статистика UnderCur Bot</b>\n\n` +
      `👥 <b>Всего пользователей:</b> ${users.length}\n` +
      ` <b>Активных за 24 часа:</b> ${activeToday}\n` +
      `🔔 <b>Подписано на новости:</b> ${newsEnabledCount}\n` +
      `⛔ <b>Заблокировано:</b> ${bannedCount.length}\n` +
      `🎫 <b>Всего тикетов:</b> ${allTickets.length}\n` +
      ` <b>Версий в базе:</b> ${versions.length}\n` +
      `❓ <b>Статей в FAQ:</b> ${faqs.length}\n` +
      ` <b>Запланировано постов:</b> ${scheduledPosts.length}\n\n` +
      `<i>Данные актуальны на ${formatDate(now)}</i>`
    );
  }

  if (command === "/versions" || command === "/versoins") {
    return versionsMessage(chatId);
  }

  if (command === "/download") {
    return sendDownloadInfo(chatId);
  }

  // --- Управление версиями ---
  if (command === "/add") {
    if (!isAdmin(userId)) {
      return sendMessage(chatId, "⛔ У вас нет прав для добавления версий.");
    }
    if (!args) {
      return sendMessage(chatId, "❌ Укажите версии для добавления.\n\n💡 Пример: `/add 1.0.1, 1.0.2 (beta), 1.0.3 (fix)`", { parse_mode: "Markdown" });
    }

    const newVersions = parseMultipleVersions(args);
    if (!newVersions.length) {
      return sendMessage(chatId, "❌ Не удалось распознать ни одной версии.\n\n Пример: `1.0.1, 1.0.2 (beta)`", { parse_mode: "Markdown" });
    }

    const existing = await getStoredVersions();
    let added = 0;
    let updated = 0;

    for (const newVer of newVersions) {
      const idx = existing.findIndex(v => v.version === newVer.version);
      if (idx >= 0) {
        existing[idx] = { ...existing[idx], ...newVer, addedAt: existing[idx].addedAt || Date.now() };
        updated++;
      } else {
        existing.push({ ...newVer, addedAt: Date.now() });
        added++;
      }
    }

    await setStoredVersions(existing);
    const list = newVersions.map(v => versionTitle(v)).join("\n");

    // Уведомляем подписчиков и считаем реальное количество
    let totalNotified = 0;
    for (const newVer of newVersions) {
      totalNotified += await notifyVersionSubscribers(newVer.version, newVer);
    }

    return sendMessage(chatId, `✅ <b>Версии обработаны!</b>\n\n➕ <b>Добавлено:</b> ${added}\n🔄 <b>Обновлено:</b> ${updated}\n\n📋 <b>Список:</b>\n${list}\n\n🔔 <b>Уведомлено подписчиков:</b> ${totalNotified}`);
  }

  if (command === "/delete") {
    if (!isAdmin(userId)) {
      return sendMessage(chatId, " У вас нет прав для удаления версий.");
    }
    if (!args) {
      return sendMessage(chatId, "❌ Укажите версию для удаления.\n\n💡 Пример: `/delete 1.0.2 (beta)`", { parse_mode: "Markdown" });
    }

    const parsed = parseVersionString(args);
    if (!parsed) {
      return sendMessage(chatId, "❌ Неверный формат версии. Используйте формат: <code>1.0.0</code> или <code>1.0.0 (beta)</code>");
    }

    const existing = await getStoredVersions();
    const before = existing.length;

    const filtered = existing.filter(v => {
      if (v.version !== parsed.version) return true;
      if (parsed.status && v.status !== parsed.status) return true;
      return false;
    });

    if (filtered.length === before) {
      return sendMessage(chatId, `❌ Версия "<code>${args}</code>" не найдена в базе.`);
    }

    await setStoredVersions(filtered);
    return sendMessage(chatId, `✅ <b>Версия удалена!</b>\n\n🗑️ <b>Удалено:</b> ${versionTitle(parsed)}\n <b>Осталось версий:</b> ${filtered.length}`);
  }

  if (command === "/all") {
    if (!isAdmin(userId)) {
      return sendMessage(chatId, " У вас нет прав для просмотра всех версий.");
    }
    const versions = await getStoredVersions();
    if (!versions.length) {
      return sendMessage(chatId, "📭 Версий пока нет. Добавьте через команду /add");
    }

    const list = versions.map((v, i) => `${i + 1}. ${versionTitle(v)}`).join("\n");
    return sendMessage(chatId, `📋 <b>Все версии (${versions.length}):</b>\n\n${list}\n\n💡 <b>Управление:</b>\n/add — добавить\n/delete — удалить`);
  }

  if (command === "/clearversions") {
    if (!isAdmin(userId)) {
      return sendMessage(chatId, "⛔ У вас нет прав для этой команды.");
    }
    await kv.set("undercur:versions", "[]");
    return sendMessage(chatId, "🗑️ <b>Список версий полностью очищен.</b>\nТеперь можно добавить новые через команду /add");
  }

  // --- Массовая рассылка ---
  if (command === "/sendall") {
    if (!isAdmin(userId)) {
      return sendMessage(chatId, " У вас нет прав для этой команды.");
    }
    if (!args) {
      return sendMessage(chatId, "❌ Используйте: <code>/sendall &lt;текст сообщения&gt;</code>");
    }
    
    const users = (await kv.smembers("undercur:users")) || [];
    let sent = 0;
    let failed = 0;
    
    await sendMessage(chatId, `⏳ <b>Начало рассылки...</b>\nВсего получателей: ${users.length}`);
    
    for (const uId of users) {
      try {
        await sendMessage(uId, `📢 <b>Важное сообщение от администрации:</b>\n\n${args}`);
        sent++;
        await new Promise(resolve => setTimeout(resolve, 40)); // Anti-flood delay
      } catch (e) {
        failed++;
      }
    }
    return sendMessage(chatId, `✅ <b>Рассылка завершена!</b>\n\n📤 Отправлено: ${sent}\n❌ Ошибок: ${failed}`);
  }

  // --- Модерация ---
  if (command === "/ban") {
    if (!isAdmin(userId)) return sendMessage(chatId, " Недостаточно прав.");
    const parts = args.split(/\s+/);
    const targetId = parts[0];
    const reason = parts.slice(1).join(" ") || "Не указана";
    
    if (!targetId || isNaN(targetId)) {
      return sendMessage(chatId, "❌ Использование: <code>/ban &lt;user_id&gt; [причина]</code>");
    }
    
    await banUser(targetId, userId, reason);
    return sendMessage(chatId, `✅ Пользователь <code>${targetId}</code> заблокирован.\nПричина: ${reason}`);
  }

  if (command === "/unban") {
    if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Недостаточно прав.");
    const targetId = args.trim();
    
    if (!targetId || isNaN(targetId)) {
      return sendMessage(chatId, " Использование: <code>/unban &lt;user_id&gt;</code>");
    }
    
    await unbanUser(targetId);
    return sendMessage(chatId, `✅ Пользователь <code>${targetId}</code> разблокирован.`);
  }

  if (command === "/finduser") {
    if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Недостаточно прав.");
    const targetId = args.trim();
    
    if (!targetId || isNaN(targetId)) {
      return sendMessage(chatId, "❌ Использование: <code>/finduser &lt;user_id&gt;</code>");
    }
    
    const user = await getUser(targetId);
    if (!user || !user.createdAt) {
      return sendMessage(chatId, `❌ Пользователь с ID <code>${targetId}</code> не найден в базе.`);
    }
    
    const badgeCount = user.badges ? user.badges.length : 0;
    const refCount = user.referrals ? user.referrals.length : 0;
    
    return sendMessage(chatId, 
      `🔍 <b>Информация о пользователе</b>\n\n` +
      `🆔 ID: <code>${user.userId}</code>\n` +
      `📅 Регистрация: ${formatDate(user.createdAt)}\n` +
      ` Последняя активность: ${formatDate(user.lastSeen)}\n` +
      `💬 Сообщений: ${user.messageCount || 0}\n` +
      `🔔 Новости: ${user.news !== false ? "Вкл" : "Выкл"}\n` +
      `🏆 Бейджей: ${badgeCount}\n` +
      `👥 Рефералов: ${refCount}`
    );
  }

  // --- Новости ---
  if (command === "/news") {
    if (args.length > 0 || message.reply_to_message) {
      // ЕСТЬ ТЕКСТ ИЛИ ОТВЕТ НА СООБЩЕНИЕ -> ПУБЛИКАЦИЯ
      if (!isAdmin(userId)) {
        return sendMessage(chatId, "⛔ У вас нет прав для публикации новостей.");
      }
      
      await sendMessage(chatId, "⏳ <b>Публикация новости...</b>");
      const result = await publishNews(message, userId);
      
      if (result.error === "empty") {
        return sendMessage(chatId, "❌ После команды /news должен быть текст новости, или используйте эту команду как ответ на сообщение с новостью.");
      }
      
      return sendMessage(chatId, 
        "✅ <b>Новость обработана.</b>\n\n" +
        `📢 <b>Канал:</b> ${result.channelSent ? "опубликовано" : "ошибка публикации"}\n` +
        `👤 <b>Получателей (рассылка):</b> ${result.sentCount}` +
        (result.error ? `\n⚠️ <b>Ошибка:</b> ${result.error}` : "")
      );
    } else {
      // НЕТ ТЕКСТА -> НАСТРОЙКИ
      const user = await getUser(userId);
      return sendMessage(chatId, "📰 <b>Новости UnderCur</b>\n\nЗдесь будут появляться новости проекта.\nНастройте получение уведомлений:", {
        reply_markup: newsKeyboard(user.news !== false),
      });
    }
  }

  // --- Гайд и FAQ ---
  if (command === "/guide") {
    return sendGuideMenu(chatId);
  }

  if (command === "/addfaq") {
    if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Недостаточно прав.");
    const parts = args.split("|");
    if (parts.length < 2) {
      return sendMessage(chatId, "❌ Использование: <code>/addfaq &lt;вопрос&gt; | &lt;ответ&gt;</code>");
    }
    const faq = await addFaq(parts[0], parts.slice(1).join("|"));
    return sendMessage(chatId, `✅ FAQ добавлен!\nID: <code>${faq.id}</code>\nВопрос: ${escapeHtml(faq.question)}`);
  }

  if (command === "/delfaq") {
    if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Недостаточно прав.");
    await deleteFaq(args.trim());
    return sendMessage(chatId, "✅ FAQ удален (если существовал).");
  }

  // --- Promo Codes Admin ---
  if (command === "/genpromo") {
    if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Недостаточно прав.");
    
    const parts = args.split(/\s+/);
    if (parts.length < 2) {
      return sendMessage(chatId, 
        "❌ Использование: <code>/genpromo CODE REWARD [MAX_USES]</code>\n\n" +
        "Пример: <code>/genpromo SUMMER2026 \"Бонус 100 монет\" 100</code>");
    }
    
    const code = parts[0];
    const reward = parts[1];
    const maxUses = parseInt(parts[2]) || 100;
    
    const promo = await generatePromoCode(code, reward, maxUses);
    
    return sendMessage(chatId, 
      `✅ <b>Промокод создан!</b>\n\n` +
      `🎁 <b>Код:</b> <code>${promo.code}</code>\n` +
      `💰 <b>Награда:</b> ${promo.reward}\n` +
      ` <b>Лимит:</b> ${promo.maxUses} использований`);
  }

  if (command === "/promos") {
    if (!isAdmin(userId)) return sendMessage(chatId, "⛔ Недостаточно прав.");
    
    const promos = await getAllPromoCodes();
    
    if (promos.length === 0) {
      return sendMessage(chatId, " <b>Промокоды</b>\n\nПока нет созданных промокодов.");
    }
    
    let text = " <b>Все промокоды:</b>\n\n";
    promos.forEach((p, i) => {
      const status = p.active ? "✅" : "❌";
      text += `${i + 1}. ${status} <code>${p.code}</code> — ${p.reward}\n`;
      text += `<i>Использовано: ${p.usedBy.length}/${p.maxUses}</i>\n\n`;
    });
    
    return sendMessage(chatId, text);
  }

  // FALLBACK
  return sendMessage(chatId, "Неизвестная команда. Используйте меню ниже или /help для списка команд.", {
    reply_markup: mainKeyboard(),
  });
}

// ==========================================
// CALLBACK QUERY PROCESSOR
// ==========================================

async function processCallback(callback) {
  const data = callback.data;
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const userId = callback.from.id;

  // Игнорируем нажатия на неактивные кнопки
  if (data === "ignore") {
    return answerCallback(callback.id);
  }

  await answerCallback(callback.id);

  if (data === "home") return sendHome(chatId, messageId);
  if (data === "help") return sendHelp(chatId, messageId);
  if (data === "download_info") return sendDownloadInfo(chatId, messageId);
  if (data === "guide_menu") return sendGuideMenu(chatId, messageId);

  if (data.startsWith("versions")) {
    const pageMatch = data.match(/versions_page_(\d+)/);
    const page = pageMatch ? parseInt(pageMatch[1]) : 1;
    return versionsMessage(chatId, messageId, page);
  }

  if (data.startsWith("version:")) {
    const payload = data.slice("version:".length);
    const [version, status] = payload.split("|");
    return showVersion(chatId, messageId, version, status);
  }

  if (data === "news_menu") {
    const user = await getUser(userId);
    return editMessage(chatId, messageId, "📰 <b>Раздел новостей</b>\n\nВыберите, получать ли вам уведомления о новых публикациях проекта.", {
      reply_markup: newsKeyboard(user.news !== false)
    });
  }

  if (data === "news_enable") {
    await saveUser(userId, { news: true });
    return editMessage(chatId, messageId, "✅ <b>Получение новостей включено.</b>\nТеперь вы будете получать уведомления о важных обновлениях.", { reply_markup: newsKeyboard(true) });
  }

  if (data === "news_disable") {
    await saveUser(userId, { news: false });
    return editMessage(chatId, messageId, "🔕 <b>Получение новостей выключено.</b>\nВы больше не будете получать рассылку новостей (но можете проверить их в канале).", { reply_markup: newsKeyboard(false) });
  }

  if (data === "developers") {
    await saveUser(userId, { state: "choose_developer_category" });
    return editMessage(chatId, messageId, "💬 <b>Написать разработчикам</b>\n\nВыберите категорию вашего обращения, чтобы мы могли обработать его быстрее:", {
      reply_markup: developersKeyboard()
    });
  }

  if (data === "promo_list") {
    return sendPromoList(chatId, messageId);
  }

  if (data === "my_tickets") {
    const tickets = await getUserTickets(userId);
    if (!tickets.length) {
      return editMessage(chatId, messageId, "🎫 <b>Мои тикеты</b>\n\nВы еще не создавали обращений к разработчикам.", {
        reply_markup: backKeyboard("developers")
      });
    }
    
    let text = "🎫 <b>Ваши обращения:</b>\n\n";
    const keyboard = { inline_keyboard: [] };
    
    tickets.slice(0, 5).forEach(t => {
      const statusEmoji = t.status === "open" ? "🟢" : "✅";
      text += `${statusEmoji} <code>${t.id}</code> - ${t.category}\n`;
      keyboard.inline_keyboard.push([{ text: `👁️ ${t.id}`, callback_data: `check_ticket_${t.id}` }]);
    });
    
    keyboard.inline_keyboard.push([{ text: "⬅️ Назад", callback_data: "developers" }]);
    return editMessage(chatId, messageId, text, { reply_markup: keyboard });
  }

  if (data.startsWith("check_ticket_")) {
    const ticketId = data.replace("check_ticket_", "");
    const ticket = await getTicket(ticketId);
    
    if (!ticket) {
      return answerCallback(callback.id, "Тикет не найден", true);
    }
    
    const statusText = ticket.status === "open" ? "🟢 Открыт" : "✅ Закрыт";
    let text = `🎫 <b>Тикет ${ticket.id}</b>\n`;
    text += `<b>Статус:</b> ${statusText}\n`;
    text += `<b>Категория:</b> ${ticket.category}\n`;
    text += `<b>Создан:</b> ${formatDate(ticket.createdAt)}\n\n`;
    text += `<b>Ваше сообщение:</b>\n${escapeHtml(ticket.message)}\n\n`;
    
    if (ticket.replies && ticket.replies.length > 0) {
      text += `<b>Ответы администрации:</b>\n`;
      ticket.replies.forEach((reply, idx) => {
        text += `${idx + 1}. ${escapeHtml(reply.text)}\n<i>(${formatDate(reply.date)})</i>\n`;
      });
    } else {
      text += "<i>Ответов пока нет. Ожидайте!</i>";
    }
    
    return editMessage(chatId, messageId, text, { reply_markup: ticketActionKeyboard(ticketId, false) });
  }

  if (data === "developer_bug" || data === "developer_idea" || data === "developer_other") {
    const categories = {
      developer_bug: "🐞 Сообщить о баге",
      developer_idea: "💡 Предложить идею",
      developer_other: "💬 Другой вопрос",
    };
    const category = categories[data] || "Без категории";

    await saveUser(userId, { state: "waiting_developer_message", developerCategory: category });

    return editMessage(chatId, messageId, 
      `✅ <b>Категория выбрана:</b> ${category}\n\n` +
      `Теперь отправьте <b>одним сообщением</b> подробное описание вашей проблемы или предложения.\n\n` +
      `💡 <i>Вы можете прикрепить скриншоты или файлы к этому сообщению.</i>`, 
      { reply_markup: backKeyboard("developers") }
    );
  }

  if (data === "guide_launch") {
    const text = "🚀 <b>Как запустить UnderCur?</b>\n\n" +
      "1️⃣ Скачайте файл игры (формат <code>.ppsx</code>) из нашего канала или с itch.io.\n" +
      "2️⃣ Убедитесь, что на вашем компьютере установлен <b>Microsoft PowerPoint</b> (входит в Microsoft Office).\n" +
      "3️⃣ Дважды кликните по скачанному файлу.\n" +
      "4️⃣ Если PowerPoint спросит разрешение на включение макросов или содержимого — нажмите <b>«Включить содержимое»</b> или <b>«Разрешить»</b>.\n" +
      "5️⃣ Игра запустится автоматически в режиме демонстрации!\n\n" +
      "⚠️ <i>Программа для презентаций PowerPoint необходима, так как игра создана на его базе.</i>";
    return editMessage(chatId, messageId, text, { reply_markup: backKeyboard("guide_menu") });
  }

  if (data === "guide_troubleshoot") {
    const text = "⚙️ <b>Решение частых проблем</b>\n\n" +
      "❓ <b>Игра не запускается, открывается как обычный файл:</b>\n" +
      "Убедитесь, что расширение файла именно <code>.ppsx</code>, а не <code>.pptx</code>. Кликните правой кнопкой мыши → «Открыть с помощью» → PowerPoint.\n\n" +
      "❓ <b>Вылетает ошибка макросов:</b>\n" +
      "В настройках PowerPoint (Файл → Параметры → Центр управления безопасностью) убедитесь, что не стоит блокировка всех макросов без уведомления.\n\n" +
      "❓ <b>Не работает на Mac/Linux:</b>\n" +
      "Убедитесь, что установлена совместимая версия Office или LibreOffice Impress (хотя полная совместимость гарантирована только с MS PowerPoint).";
    return editMessage(chatId, messageId, text, { reply_markup: backKeyboard("guide_menu") });
  }

  if (data === "guide_controls") {
    const text = "🎮 <b>Управление в игре</b>\n\n" +
      "UnderCur использует стандартное управление презентациями:\n\n" +
      "• <b>Красный круг</b> — как только вы видите этот яркий маркер, сразу наводите курсор прямо в центр круга!" +
      "• <b>Esc</b> — Выход из режима демонстрации (пауза/меню)\n\n" +
      "<i>Конкретные механики могут отличаться в зависимости от уровня.</i>";
    return editMessage(chatId, messageId, text, { reply_markup: backKeyboard("guide_menu") });
  }

  if (data.startsWith("faq_show_")) {
    const faqId = data.replace("faq_show_", "");
    const faqs = await getAllFaqs();
    const faq = faqs.find(f => f.id === faqId);
    
    if (!faq) {
      return answerCallback(callback.id, "Статья не найдена", true);
    }
    
    const text = `❓ <b>Вопрос:</b> ${escapeHtml(faq.question)}\n\n` +
                 ` <b>Ответ:</b>\n${escapeHtml(faq.answer)}`;
                 
    return editMessage(chatId, messageId, text, { reply_markup: backKeyboard("faq") });
  }

  // --- Badge System Callbacks ---
  if (data === "my_badges") {
    return sendBadgesMenu(chatId, messageId);
  }

  if (data === "all_badges_list") {
    const allBadges = Object.values(BADGES);
    let text = "🏆 <b>Все доступные бейджи</b>\n\n";
    
    const userBadges = await getUserBadges(userId);
    const userBadgeIds = userBadges.map(b => b.id);
    
    allBadges.forEach((badge, idx) => {
      const obtained = userBadgeIds.includes(badge.id) ? "✅" : "⬜";
      text += `${obtained} ${badge.emoji} <b>${badge.name}</b>\n<i>${badge.desc}</i>\n\n`;
    });
    
    return editMessage(chatId, messageId, text, { reply_markup: backKeyboard("my_badges") });
  }

  if (data === "share_bot") {
    return sendShareBot(chatId, messageId);
  }

  // --- Version Subscription Callbacks ---
  if (data.startsWith("watch_")) {
    const version = data.replace("watch_", "");
    const subscribed = await subscribeToVersion(userId, version);
    
    if (subscribed) {
      await answerCallback(callback.id, `Подписан на ${version}`);
      // Обновляем сообщение с версиями
      return versionsMessage(chatId, messageId);
    } else {
      await answerCallback(callback.id, "Вы уже подписаны", true);
    }
  }

  if (data.startsWith("unwatch_")) {
    const version = data.replace("unwatch_", "");
    const unsubscribed = await unsubscribeFromVersion(userId, version);
    
    if (unsubscribed) {
      await answerCallback(callback.id, `Отписан от ${version}`);
      return versionsMessage(chatId, messageId);
    } else {
      await answerCallback(callback.id, "Вы не были подписаны", true);
    }
  }

  // --- Scheduled Posts Callbacks ---
  if (data.startsWith("unschedule_")) {
    if (!isAdmin(userId)) {
      return answerCallback(callback.id, "Нет прав", true);
    }
    
    const postId = data.replace("unschedule_", "");
    const deleted = await cancelScheduledPost(postId);
    
    if (deleted > 0) {
      await answerCallback(callback.id, "Пост отменён");
      return sendScheduledPostsList(chatId, messageId, true);
    } else {
      await answerCallback(callback.id, "Ошибка отмены", true);
    }
  }
}

// ==========================================
// TEXT MESSAGE PROCESSOR
// ==========================================

async function processText(message) {
  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text || message.caption || "";

  // Если это команда, передаем управление процессору команд
  if (text.startsWith("/")) {
    return processCommand(message, text);
  }

  // Проверка на мут
  if (await isMuted(userId)) {
    return sendMessage(chatId, "🔇 Вы временно ограничены в отправке сообщений боту.");
  }

  // Обновляем статистику пользователя
  await updateUserStats(userId, { lastSeen: Date.now() });

  const user = await getUser(userId);

  // Обработка состояния ожидания сообщения для тикета
  if (user.state === "waiting_developer_message") {
    const category = user.developerCategory || "Без категории";
    
    // Создаем тикет в базе
    const ticket = await createTicket(
      userId,
      category,
      text,
      message.message_id,
      chatId
    );

    // Формируем сообщение для админов
    const adminText =
      `🎫 <b>Новый тикет: ${ticket.id}</b>\n\n` +
      `🏷️ <b>Категория:</b> ${category}\n` +
      `👤 <b>Пользователь:</b> ${escapeHtml(message.from.first_name || "Без имени")}${message.from.last_name ? " " + escapeHtml(message.from.last_name) : ""}\n` +
      `🆔 <b>ID:</b> <code>${userId}</code>\n` +
      `📅 <b>Время:</b> ${formatDate(Date.now())}\n\n` +
      `💬 <b>Сообщение:</b>\n${escapeHtml(text)}`;

    // Отправляем всем админам
    for (const adminId of ADMIN_IDS) {
      try {
        await sendMessage(adminId, adminText, {
          reply_markup: ticketActionKeyboard(ticket.id, true)
        });
        
        // Если есть вложения, пересылаем их админу
        if (message.photo || message.document || message.animation || message.video) {
          await forwardMessage(adminId, chatId, message.message_id);
        }
      } catch (e) {
        console.error(`Ошибка отправки тикета админу ${adminId}:`, e.message);
      }
    }

    // Сбрасываем состояние пользователя
    await saveUser(userId, { state: null, developerCategory: null });

    return sendMessage(chatId, 
      `✅ <b>Сообщение отправлено разработчикам!</b>\n\n` +
      `Ваш идентификатор обращения: <code>${ticket.id}</code>\n` +
      `Мы рассмотрим его в ближайшее время. Вы можете проверить статус, нажав "💬 Написать разработчикам" -> "📋 Мои тикеты".\n\n` +
      `Спасибо за обратную связь! 🙏`,
      { reply_markup: mainKeyboard() }
    );
  }

  // Умный авто-ответчик на частые вопросы (если пользователь не в состоянии тикета)
  const lowerText = text.toLowerCase();
  if (lowerText.includes("powerpoint") || lowerText.includes("ppsx") || lowerText.includes("как запустить") || lowerText.includes("как играть") || lowerText.includes("не работает")) {
    return sendMessage(chatId, 
      "💡 <b>Для запуска игры UnderCur вам потребуется:</b>\n\n" +
      "1️⃣ Любой компьютер (Windows, macOS или Linux).\n" +
      "2️⃣ Установленный Microsoft PowerPoint.\n\n" +
      "📄 Просто откройте скачанный файл с расширением <code>.ppsx</code> через PowerPoint, и игра запустится автоматически в режиме демонстрации!\n\n" +
      "📥 Скачать актуальные версии можно по кнопке «📥 Скачать игру» ниже, а подробный гайд доступен в разделе «📖 Гайд и FAQ».",
      { reply_markup: mainKeyboard() }
    );
  }

  // Если пользователь просто пишет что-то непонятное, предлагаем меню
  return sendMessage(chatId, "Выберите действие в главном меню или используйте /help для списка команд.", {
    reply_markup: mainKeyboard(),
  });
}

// ==========================================
// MAIN WEBHOOK HANDLER
// ==========================================

module.exports = async function handler(req, res) {
  // Разрешаем GET запросы для проверки работоспособности (health check)
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "UnderCur Telegram Bot",
      version: "3.0.0",
      timestamp: new Date().toISOString(),
    });
  }

  // Принимаем только POST запросы от Telegram
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // Проверка секретного токена вебхука (если настроен)
  if (WEBHOOK_SECRET && req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET) {
    console.warn("Попытка доступа к вебхуку с неверным секретным токеном");
    return res.status(403).json({ ok: false, error: "Invalid webhook secret" });
  }

  try {
    const update = req.body;

    // 1. Обработка нажатий на инлайн-кнопки (Callback Query)
    if (update.callback_query) {
      await processCallback(update.callback_query);
    }
    // 2. Обработка обычных сообщений и команд
    else if (update.message) {
      // Игнорируем сообщения из каналов, если они вдруг попадают сюда (должны идти в channel_post)
      if (update.message.chat.type === "channel") {
        // Ничего не делаем
      } else {
        await saveUser(update.message.from.id);
        await processText(update.message);
      }
    }
    // 3. Обработка постов в канале (АВТО-РЕАКЦИЯ)
    else if (update.channel_post) {
      const chatId = update.channel_post.chat.id;
      const messageId = update.channel_post.message_id;
      
      // Проверяем, что это наш канал (сравниваем ID или username, если ID недоступен)
      // Для надежности реагируем на все channel_post, так как бот получает только те, где он админ
      try {
        await setMessageReaction(chatId, messageId, CHANNEL_POST_REACTION_EMOJI, true);
        console.log(`[Auto-Reaction] Реакция ${CHANNEL_POST_REACTION_EMOJI} поставлена на пост ${messageId} в канале ${chatId}`);
      } catch (e) {
        // Игнорируем ошибки, если бот не имеет прав на реакции или это старый пост
        console.log(`[Auto-Reaction] Не удалось поставить реакцию:`, e.message);
      }
    }
    // 4. Обработка редактирования постов в канале (опционально, можно игнорировать)
    else if (update.edited_channel_post) {
      // Можно добавить логику при необходимости
    }

    // Всегда возвращаем 200 OK Telegram API, чтобы он не считал доставку неудачной
    return res.status(200).json({ ok: true });
    
  } catch (error) {
    console.error("[UnderCur Handler Critical Error]:", error);
    // Даже при ошибке возвращаем 200, чтобы Telegram не отключал вебхук
    return res.status(200).json({ ok: false, error: "Internal handler error" });
  }
};