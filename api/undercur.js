const { kv } = require("@vercel/kv");

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

// Доступные реакции (все кроме отрицательных)
const AVAILABLE_REACTIONS = [
  "👍", "🔥", "❤️", "🎉", "💯", "🤩", "😍", "🥰",
  "😎", "🙌", "💪", "✨", "🌟", "⭐", "🚀", "💎",
  "🎮", "🎯", "🏆", "👏", "🤝", "💫", "🌈", "🦄",
  "🐱", "🐶", "🦊", "🐻", "🐼", "🐨", "🦁", "🐸",
  "🍕", "🍔", "🍟", "🌮", "🍩", "🎂", "🍰", "☕",
  "🎵", "🎶", "🎸", "🎹", "🥁", "🎺", "🎻", "🎤",
  "💡", "💭", "🔔", "📢", "📣", "📯", "🎪", "🎨"
];

async function telegram(method, body = {}) {
  const response = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!data.ok) {
    console.error("Telegram API error:", method, data);
  }
  return data;
}

async function sendMessage(chatId, text, extra = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...extra,
  });
}

async function forwardMessage(toChatId, fromChatId, messageId, extra = {}) {
  return telegram("forwardMessage", {
    chat_id: toChatId,
    from_chat_id: fromChatId,
    message_id: messageId,
    ...extra,
  });
}

async function copyMessage(toChatId, fromChatId, messageId, extra = {}) {
  return telegram("copyMessage", {
    chat_id: toChatId,
    from_chat_id: fromChatId,
    message_id: messageId,
    ...extra,
  });
}

async function editMessage(chatId, messageId, text, extra = {}) {
  return telegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
    ...extra,
  });
}

async function answerCallback(callbackId, text = "") {
  return telegram("answerCallbackQuery", {
    callback_query_id: callbackId,
    text,
  });
}

async function setMessageReaction(chatId, messageId, emoji = "👍") {
  return telegram("setMessageReaction", {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: "emoji", emoji }],
    is_big: false,
  });
}

async function setMultipleReactions(chatId, messageId, emojis = []) {
  if (!emojis.length) return;
  return telegram("setMessageReaction", {
    chat_id: chatId,
    message_id: messageId,
    reaction: emojis.map(e => ({ type: "emoji", emoji: e })),
    is_big: false,
  });
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

function getRandomReactions(count = 2) {
  const shuffled = [...AVAILABLE_REACTIONS].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📰 Новости", callback_data: "news_menu" },
        { text: "🎮 Версии игры", callback_data: "versions" },
      ],
      [
        { text: "💬 Написать разработчикам", callback_data: "developers" },
      ],
      [
        { text: "📥 Скачать игру", callback_data: "download_info" },
        { text: "ℹ️ Помощь", callback_data: "help" },
      ],
    ],
  };
}

function newsKeyboard(enabled) {
  return {
    inline_keyboard: [
      [
        {
          text: enabled ? "🔕 Выключить новости" : "🔔 Включить новости",
          callback_data: enabled ? "news_disable" : "news_enable",
        },
      ],
      [{ text: "⬅️ Назад", callback_data: "home" }],
    ],
  };
}

function developersKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🐞 Нашёл баг", callback_data: "developer_bug" }],
      [{ text: "💡 Предложить идею", callback_data: "developer_idea" }],
      [{ text: "💬 Другое", callback_data: "developer_other" }],
      [{ text: "⬅️ Назад", callback_data: "home" }],
    ],
  };
}

function downloadKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📢 Telegram канал", url: CHANNEL_URL },
        { text: "🎮 itch.io", url: ITCH_IO_URL },
      ],
      [{ text: "🎮 Все версии", callback_data: "versions" }],
      [{ text: "⬅️ Назад", callback_data: "home" }],
    ],
  };
}

function backKeyboard() {
  return {
    inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "home" }]],
  };
}

// ========== Управление версиями через KV ==========

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

function parseVersionString(str) {
  const trimmed = str.trim();
  if (!trimmed) return null;

  // Формат: "1.0.1 (beta)" или "1.0.1 beta" или просто "1.0.1"
  const match = trimmed.match(/^([\d][\d\w.\-]*)\s*(?:\(([^)]+)\)|(\S+))?$/);
  if (!match) return null;

  const version = match[1];
  const status = (match[2] || match[3] || "").trim();

  return { version, status, url: null, addedAt: Date.now() };
}

function parseMultipleVersions(input) {
  // Поддерживаем разделители: запятая, новая строка, точка с запятой
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
    "beta": "🧪",
    "fix": "🔧",
    "stable": "✅",
    "alpha": "🔬",
    "dev": "🛠️",
    "rc": "📦",
    "hotfix": "🚑",
    "patch": "🩹",
  };

  const emoji = item.status ? (statusEmoji[item.status.toLowerCase()] || "📌") : "";
  const statusText = item.status ? ` (${item.status})` : "";
  return `${emoji} ${item.version}${statusText}`.trim();
}

async function getVersions() {
  // Сначала пробуем KV
  const stored = await getStoredVersions();
  if (stored.length) return stored;

  // Затем внешний API
  try {
    const response = await fetch(VERSIONS_API, { headers: { Accept: "application/json" } });
    if (response.ok) {
      const data = await response.json();
      const source = data.versions || data.data || data;
      const versions = parseVersions(source);
      if (versions.length) return versions;
    }
  } catch (error) {
    console.error("External versions API error:", error.message);
  }

  // Затем env
  return parseVersions(process.env.UNDERCUR_VERSIONS_JSON);
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
        result.push({ version: item, status: "", url: null });
        continue;
      }
      if (item && typeof item === "object") {
        result.push({
          version: String(item.version || item.name || item.tag || ""),
          status: String(item.status || item.state || ""),
          url: item.url || item.path || item.downloadUrl || null,
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
        });
      } else {
        result.push({ version, status: typeof config === "string" ? config : "", url: null });
      }
    }
  }

  return result;
}

async function versionsMessage(chatId, messageId = null) {
  const versions = await getVersions();

  if (!versions.length) {
    const text = "🎮 Актуальные версии пока не опубликованы.";
    if (messageId) {
      return editMessage(chatId, messageId, text, { reply_markup: backKeyboard() });
    }
    return sendMessage(chatId, text, { reply_markup: backKeyboard() });
  }

  const buttons = versions.map((item) => [
    { text: versionTitle(item), callback_data: `version:${item.version}|${item.status || ""}` },
  ]);

  buttons.push(
    [{ text: "📥 Скачать игру", callback_data: "download_info" }],
    [{ text: "⬅️ Назад", callback_data: "home" }]
  );

  const text =
    "🎮 Актуальные версии UnderCur\n\n" +
    "Выберите версию для получения информации:\n\n" +
    `📢 Канал: ${OFFICIAL_CHANNEL}\n` +
    `🎮 itch.io: ivtt.itch.io/undercur`;

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
    return editMessage(chatId, messageId, "Версия не найдена.", {
      reply_markup: backKeyboard(),
    });
  }

  const statusText = item.status ? `\n📌 Статус: ${item.status}` : "";

  let text =
    `🎮 Версия ${item.version}${statusText}\n\n` +
    "📥 Скачать версию можно в этих источниках:\n\n" +
    `1️⃣ Telegram канал: ${OFFICIAL_CHANNEL}\n` +
    `2️⃣ itch.io: ${ITCH_IO_URL}\n\n` +
    "💻 Для запуска нужен любой ПК и Microsoft PowerPoint.\n" +
    "📄 Файл игры имеет формат .ppsx.\n\n" +
    `🔍 Узнать актуальные версии можно в этом боте.`;

  const buttons = [
    [
      { text: "📢 Открыть канал", url: CHANNEL_URL },
      { text: "🎮 Открыть itch.io", url: ITCH_IO_URL },
    ],
  ];

  if (item.url) {
    buttons.unshift([{ text: "⬇️ Прямая ссылка", url: item.url }]);
  }

  buttons.push(
    [{ text: "⬅️ К версиям", callback_data: "versions" }],
    [{ text: "🏠 Главное меню", callback_data: "home" }]
  );

  return editMessage(chatId, messageId, text, {
    reply_markup: { inline_keyboard: buttons },
  });
}

async function sendDownloadInfo(chatId, messageId = null) {
  const text =
    "📥 Скачать UnderCur\n\n" +
    "Игра доступна в двух источниках:\n\n" +
    `1️⃣ Telegram канал: ${OFFICIAL_CHANNEL}\n` +
    `   → ${CHANNEL_URL}\n\n` +
    `2️⃣ itch.io: ivtt.itch.io/undercur\n` +
    `   → ${ITCH_IO_URL}\n\n` +
    "💻 Требования:\n" +
    "• Любой ПК (Windows/Mac/Linux)\n" +
    "• Microsoft PowerPoint (для запуска .ppsx)\n\n" +
    "🔍 Узнать актуальные версии можно через кнопку «🎮 Версии игры».";

  if (messageId) {
    return editMessage(chatId, messageId, text, {
      reply_markup: downloadKeyboard(),
    });
  }
  return sendMessage(chatId, text, { reply_markup: downloadKeyboard() });
}

// ========== Пользователи ==========

async function saveUser(userId, data = {}) {
  const key = `undercur:user:${userId}`;
  const old = (await kv.get(key)) || {};
  await kv.set(key, {
    ...old,
    userId: String(userId),
    news: old.news !== false,
    ...data,
    updatedAt: Date.now(),
  });
  await kv.sadd("undercur:users", String(userId));
}

async function getUser(userId) {
  return (
    (await kv.get(`undercur:user:${userId}`)) || {
      userId: String(userId),
      news: true,
    }
  );
}

async function sendHome(chatId, messageId = null) {
  const text =
    "👋 Добро пожаловать в UnderCur!\n\n" +
    "Здесь можно посмотреть новости, актуальные версии игры, " +
    "скачать игру и связаться с разработчиками.\n\n" +
    "📢 Канал: @undercurgame\n" +
    "🎮 itch.io: ivtt.itch.io/undercur";

  const extra = { reply_markup: mainKeyboard() };

  if (messageId) {
    return editMessage(chatId, messageId, text, extra);
  }
  return sendMessage(chatId, text, extra);
}

async function sendHelp(chatId, messageId = null) {
  const text =
    "ℹ️ Команды UnderCur\n\n" +
    "📋 Основные:\n" +
    "/start — главное меню\n" +
    "/help — помощь\n" +
    "/versions — версии игры\n" +
    "/news — раздел новостей\n" +
    "/download — скачать игру\n\n" +
    "🔧 Для администраторов:\n" +
    "/add <версии> — добавить версии\n" +
    "/delete <версия> — удалить версию\n" +
    "/all — все версии\n" +
    "/stats — статистика\n\n" +
    "💡 Пример: /add 1.0.1, 1.0.2 (beta), 1.0.3 (fix)\n" +
    "💡 Пример: /delete 1.0.2 (beta)\n\n" +
    "📰 Новости можно включить или выключить в разделе «Новости».";

  if (messageId) {
    return editMessage(chatId, messageId, text, { reply_markup: backKeyboard() });
  }
  return sendMessage(chatId, text, { reply_markup: backKeyboard() });
}

// ========== Публикация новостей ==========

async function publishNews(message) {
  const users = (await kv.smembers("undercur:users")) || [];
  let channelSent = false;
  let sent = 0;

  const rawContent = message.caption || message.text || "";
  const commandMatch = rawContent.match(/^\/news(?:@\w+)?\s*/i);
  const commandLength = commandMatch ? commandMatch[0].length : 0;

  const prefix = "📰 Новость UnderCur\n\n";
  const cleanedContent = rawContent.slice(commandLength).trim();
  const finalContent = prefix + cleanedContent;

  const isMedia = message.photo || message.animation || message.voice || message.video || message.document;

  const extra = {};

  if (!isMedia) {
    extra.parse_mode = "HTML";
    extra.disable_web_page_preview = false;
  }

  if (isMedia) {
    extra.caption = finalContent;
    const entities = message.caption_entities || message.entities;
    if (entities) {
      extra.caption_entities = entities
        .map((entity) => ({
          ...entity,
          offset: Math.max(0, entity.offset - commandLength + prefix.length),
        }))
        .filter((entity) => entity.length > 0);
    }
    if (message.video_note) {
      delete extra.caption;
      delete extra.caption_entities;
    }
  } else {
    if (message.entities) {
      extra.entities = message.entities
        .map((entity) => ({
          ...entity,
          offset: Math.max(0, entity.offset - commandLength + prefix.length),
        }))
        .filter((entity) => entity.length > 0);
    }
  }

  const channelUsername = NEWS_CHANNEL.replace(/^@/, "");
  extra.reply_markup = {
    inline_keyboard: [
      [{ text: "📢 Поделиться новостью", url: `https://t.me/${channelUsername}` }],
    ],
  };

  // Публикация в канал — используем forwardMessage для сохранения премиум-эмоджи
  try {
    let result;
    if (isMedia) {
      // Для медиа используем forwardMessage чтобы сохранить премиум-эмоджи
      result = await forwardMessage(NEWS_CHANNEL, message.chat.id, message.message_id);
      if (result.ok) {
        // Если нужно добавить кнопку — редактируем сообщение
        try {
          await telegram("editMessageReplyMarkup", {
            chat_id: NEWS_CHANNEL,
            message_id: result.result.message_id,
            reply_markup: extra.reply_markup,
          });
        } catch (e) {
          console.error("Не удалось добавить кнопку к forwarded:", e.message);
        }
      }
    } else {
      result = await sendMessage(NEWS_CHANNEL, finalContent, extra);
    }
    channelSent = result.ok === true;
  } catch (error) {
    console.error("Ошибка публикации в канал:", error.message);
  }

  // Рассылка пользователям — используем forwardMessage для сохранения премиум-эмоджи
  for (const recipientId of users) {
    const recipient = await getUser(recipientId);
    if (recipient.news === false) continue;

    try {
      let result;
      if (isMedia) {
        // Используем forwardMessage для сохранения премиум-эмоджи
        result = await forwardMessage(recipientId, message.chat.id, message.message_id);
      } else {
        result = await sendMessage(recipientId, finalContent, extra);
      }
      if (result.ok) sent++;
    } catch (error) {
      console.error("Ошибка рассылки пользователю:", error.message);
    }
  }

  return { channelSent, sent };
}

// ========== Команды ==========

async function processCommand(message, text) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const command = text.split(/\s+/)[0].toLowerCase();
  const args = text.slice(command.length).trim();

  if (command === "/start") {
    await saveUser(userId);
    return sendHome(chatId);
  }

  if (command === "/help") {
    return sendHelp(chatId);
  }

  if (command === "/download") {
    return sendDownloadInfo(chatId);
  }

  if (command === "/stats") {
    if (!isAdmin(userId)) {
      return sendMessage(chatId, "⛔ У вас нет прав для использования этой команды.");
    }
    const users = (await kv.smembers("undercur:users")) || [];
    let newsEnabled = 0;
    for (const uId of users) {
      const user = await getUser(uId);
      if (user.news !== false) newsEnabled++;
    }
    const versions = await getStoredVersions();
    return sendMessage(
      chatId,
      `📊 Статистика UnderCur\n\n` +
      `👥 Всего пользователей: ${users.length}\n` +
      `🔔 Подписано на новости: ${newsEnabled}\n` +
      `🔕 Отписано от новостей: ${users.length - newsEnabled}\n` +
      `🎮 Версий в базе: ${versions.length}\n` +
      `📅 Дата: ${new Date().toLocaleDateString("ru-RU")}`
    );
  }

  if (command === "/versions" || command === "/versoins") {
    return versionsMessage(chatId);
  }

  // ========== Управление версиями ==========

  if (command === "/add") {
    if (!isAdmin(userId)) {
      return sendMessage(chatId, "⛔ У вас нет прав для добавления версий.");
    }

    if (!args) {
      return sendMessage(
        chatId,
        "❌ Укажите версии для добавления.\n\n" +
        "💡 Примеры:\n" +
        "`/add 1.0.1, 1.0.2 (beta), 1.0.3 (fix)`\n" +
        "`/add 2.0.0 (stable)`\n" +
        "`/add 1.5.0 (alpha)`",
        { parse_mode: "Markdown" }
      );
    }

    const newVersions = parseMultipleVersions(args);

    if (!newVersions.length) {
      return sendMessage(
        chatId,
        "❌ Не удалось распознать ни одной версии.\n\n" +
        "💡 Формат: номер версии и статус в скобках\n" +
        "Пример: `1.0.1, 1.0.2 (beta), 1.0.3 (fix)`",
        { parse_mode: "Markdown" }
      );
    }

    const existing = await getStoredVersions();
    let added = 0;
    let updated = 0;

    for (const newVer of newVersions) {
      const idx = existing.findIndex(v => v.version === newVer.version);
      if (idx >= 0) {
        existing[idx] = { ...existing[idx], ...newVer };
        updated++;
      } else {
        existing.push(newVer);
        added++;
      }
    }

    await setStoredVersions(existing);

    const list = newVersions.map(v => versionTitle(v)).join("\n");

    return sendMessage(
      chatId,
      `✅ Версии обработаны!\n\n` +
      `➕ Добавлено: ${added}\n` +
      `🔄 Обновлено: ${updated}\n\n` +
      `📋 Список:\n${list}`
    );
  }

  if (command === "/delete") {
    if (!isAdmin(userId)) {
      return sendMessage(chatId, "⛔ У вас нет прав для удаления версий.");
    }

    if (!args) {
      return sendMessage(
        chatId,
        "❌ Укажите версию для удаления.\n\n" +
        "💡 Примеры:\n" +
        "`/delete 1.0.1`\n" +
        "`/delete 1.0.2 (beta)`",
        { parse_mode: "Markdown" }
      );
    }

    const parsed = parseVersionString(args);
    if (!parsed) {
      return sendMessage(chatId, "❌ Неверный формат версии.");
    }

    const existing = await getStoredVersions();
    const before = existing.length;

    const filtered = existing.filter(v => {
      if (v.version !== parsed.version) return true;
      if (parsed.status && v.status !== parsed.status) return true;
      return false;
    });

    if (filtered.length === before) {
      return sendMessage(chatId, `❌ Версия "${args}" не найдена.`);
    }

    await setStoredVersions(filtered);

    return sendMessage(
      chatId,
      `✅ Версия удалена!\n\n` +
      `🗑️ Удалено: ${versionTitle(parsed)}\n` +
      `📦 Осталось версий: ${filtered.length}`
    );
  }

  if (command === "/all") {
    if (!isAdmin(userId)) {
      return sendMessage(chatId, "⛔ У вас нет прав для просмотра всех версий.");
    }

    const versions = await getStoredVersions();

    if (!versions.length) {
      return sendMessage(chatId, "📭 Версий пока нет. Добавьте через /add");
    }

    const list = versions
      .map((v, i) => `${i + 1}. ${versionTitle(v)}`)
      .join("\n");

    const text =
      `📋 Все версии (${versions.length}):\n\n${list}\n\n` +
      `💡 Управление:\n` +
      `/add — добавить\n` +
      `/delete — удалить`;

    return sendMessage(chatId, text);
  }

  // ========== Новости ==========

  if (/^\/news(?:@\w+)?(?:\s|$)/i.test(text)) {
    if (!isAdmin(userId)) {
      return sendMessage(chatId, "⛔ У вас нет прав для публикации новостей.");
    }

    const result = await publishNews(message);

    return sendMessage(
      chatId,
      "✅ Новость обработана.\n\n" +
      `📢 Канал: ${result.channelSent ? "опубликовано" : "ошибка публикации"}\n` +
      `👤 Получателей: ${result.sent}.`
    );
  }

  if (command === "/news") {
    const user = await getUser(userId);
    return sendMessage(
      chatId,
      "📰 Новости UnderCur\n\n" +
      "Здесь будут появляться новости проекта.\n" +
      "Настройте получение уведомлений:",
      { reply_markup: newsKeyboard(user.news !== false) }
    );
  }

  return sendMessage(chatId, "Используйте меню ниже.", {
    reply_markup: mainKeyboard(),
  });
}

// ========== Callback ==========

async function processCallback(callback) {
  const data = callback.data;
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const userId = callback.from.id;

  await answerCallback(callback.id);

  if (data === "home") return sendHome(chatId, messageId);
  if (data === "help") return sendHelp(chatId, messageId);
  if (data === "versions") return versionsMessage(chatId, messageId);
  if (data === "download_info") return sendDownloadInfo(chatId, messageId);

  if (data.startsWith("version:")) {
    const payload = data.slice("version:".length);
    const [version, status] = payload.split("|");
    return showVersion(chatId, messageId, version, status);
  }

  if (data === "news_menu") {
    const user = await getUser(userId);
    return editMessage(
      chatId, messageId,
      "📰 Раздел новостей\n\nВыберите, получать ли вам новые публикации.",
      { reply_markup: newsKeyboard(user.news !== false) }
    );
  }

  if (data === "news_enable") {
    await saveUser(userId, { news: true });
    return editMessage(chatId, messageId, "🔔 Получение новостей включено.", {
      reply_markup: newsKeyboard(true),
    });
  }

  if (data === "news_disable") {
    await saveUser(userId, { news: false });
    return editMessage(chatId, messageId, "🔕 Получение новостей выключено.", {
      reply_markup: newsKeyboard(false),
    });
  }

  if (data === "developers") {
    await saveUser(userId, { state: "choose_developer_category" });
    return editMessage(
      chatId, messageId,
      "💬 Написать разработчикам\n\nВыберите категорию сообщения:",
      { reply_markup: developersKeyboard() }
    );
  }

  if (data === "developer_bug" || data === "developer_idea" || data === "developer_other") {
    const categories = {
      developer_bug: "🐞 Нашёл баг",
      developer_idea: "💡 Предложить идею",
      developer_other: "💬 Другое",
    };
    const category = categories[data] || "Без категории";

    await saveUser(userId, {
      state: "waiting_developer_message",
      developerCategory: category,
    });

    return editMessage(
      chatId, messageId,
      `Категория: ${category}\n\nТеперь отправьте одним сообщением подробное описание.\n\n` +
      `💡 Можете прикрепить скриншоты или файлы.`,
      { reply_markup: backKeyboard() }
    );
  }
}

// ========== Текст ==========

async function processText(message) {
  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text || message.caption || "";

  if (text.startsWith("/")) {
    return processCommand(message, text);
  }

  const user = await getUser(userId);

  if (user.state === "waiting_developer_message") {
    const category = user.developerCategory || "Без категории";

    const adminText =
      "📩 Новое сообщение разработчикам\n\n" +
      `🏷️ Категория: ${category}\n` +
      `👤 Пользователь: ${message.from.first_name || "Без имени"}${message.from.last_name ? " " + message.from.last_name : ""}\n` +
      `🆔 ID: ${userId}\n` +
      `📅 Время: ${new Date().toLocaleString("ru-RU")}\n\n` +
      `💬 Сообщение:\n${text}`;

    for (const adminId of ADMIN_IDS) {
      try {
        await sendMessage(adminId, adminText);
        // Пересылаем оригинальное сообщение админам
        if (message.photo || message.document || message.animation || message.video) {
          await forwardMessage(adminId, chatId, message.message_id);
        }
      } catch (e) {
        console.error("Ошибка отправки админу:", e.message);
      }
    }

    await saveUser(userId, { state: null, developerCategory: null });

    return sendMessage(
      chatId,
      "✅ Сообщение отправлено разработчикам!\n\nМы рассмотрим его в ближайшее время. Спасибо за обратную связь! 🙏",
      { reply_markup: mainKeyboard() }
    );
  }

  return sendMessage(chatId, "Выберите действие в меню.", {
    reply_markup: mainKeyboard(),
  });
}

// ========== Handler ==========

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "UnderCur Telegram Bot",
      version: "2.0",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (WEBHOOK_SECRET && req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET) {
    return res.status(403).json({ ok: false, error: "Invalid webhook secret" });
  }

  try {
    const update = req.body;

    // 1. Обработка callback
    if (update.callback_query) {
      await processCallback(update.callback_query);
    }
    // 2. Обработка сообщений
    else if (update.message) {
      await saveUser(update.message.from.id);
      await processText(update.message);
    }
    // 3. Обработка постов в канале
    else if (update.channel_post) {
      const post = update.channel_post;
      const targetChannel = NEWS_CHANNEL.replace(/^@/, "");

      if (post.chat.username === targetChannel) {
        // Ставим случайные реакции на пост
        const reactions = getRandomReactions(2);
        await setMultipleReactions(post.chat.id, post.message_id, reactions);

        // Логируем новый пост
        console.log(`📢 Новый пост в канале: ${post.message_id}`);
      }
    }
    // 4. Обработка редактирования сообщений бота (реакции на свои)
    else if (update.edited_message) {
      const msg = update.edited_message;
      if (msg.from && msg.from.is_bot) {
        // Ставим реакцию на отредактированное сообщение бота
        const reaction = AVAILABLE_REACTIONS[Math.floor(Math.random() * AVAILABLE_REACTIONS.length)];
        await setMessageReaction(msg.chat.id, msg.message_id, reaction);
      }
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("UnderCur handler error:", error);
    return res.status(200).json({ ok: false });
  }
};