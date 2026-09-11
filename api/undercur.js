const { kv } = require("@vercel/kv");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const ADMIN_IDS = String(process.env.UNDERCUR_ADMIN_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const VERSIONS_API =
  process.env.UNDERCUR_VERSIONS_API ||
  "https://oris-flax.vercel.app/api/undercur/get-versions/";

const OFFICIAL_CHANNEL = "@undercurgame";

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function telegram(method, body = {}) {
  const response = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
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

function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📰 Новости", callback_data: "news_menu" },
        { text: "🎮 Версии игры", callback_data: "versions" },
      ],
      [
        {
          text: "💬 Написать разработчикам",
          callback_data: "developers",
        },
      ],
      [
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
          text: enabled
            ? "🔕 Выключить новости"
            : "🔔 Включить новости",
          callback_data: enabled
            ? "news_disable"
            : "news_enable",
        },
      ],
      [{ text: "⬅️ Назад", callback_data: "home" }],
    ],
  };
}

function developersKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🐞 Нашёл баг", callback_data: "developer_bug" },
      ],
      [
        {
          text: "💡 Предложить идею",
          callback_data: "developer_idea",
        },
      ],
      [{ text: "⬅️ Назад", callback_data: "home" }],
    ],
  };
}

function backKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "⬅️ Назад", callback_data: "home" }],
    ],
  };
}

function parseVersions(value) {
  if (!value) return [];

  let data = value;

  if (typeof value === "string") {
    try {
      data = JSON.parse(value);
    } catch {
      return [];
    }
  }

  const result = [];

  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === "string") {
        result.push({
          version: item,
          status: "",
          url: null,
        });
        continue;
      }

      if (item && typeof item === "object") {
        result.push({
          version: String(
            item.version ||
              item.name ||
              item.tag ||
              ""
          ),
          status: String(
            item.status ||
              item.state ||
              ""
          ),
          url:
            item.url ||
            item.path ||
            item.downloadUrl ||
            null,
        });
      }
    }

    return result.filter((item) => item.version);
  }

  if (data && typeof data === "object") {
    for (const [version, config] of Object.entries(data)) {
      if (config && typeof config === "object") {
        result.push({
          version,
          status: String(
            config.status ||
              config.state ||
              config.type ||
              ""
          ),
          url:
            config.url ||
            config.path ||
            config.downloadUrl ||
            null,
        });
      } else {
        result.push({
          version,
          status: typeof config === "string" ? config : "",
          url: null,
        });
      }
    }
  }

  return result;
}

async function getVersions() {
  try {
    const response = await fetch(VERSIONS_API, {
      headers: {
        Accept: "application/json",
      },
    });

    if (response.ok) {
      const data = await response.json();

      const source =
        data.versions ||
        data.data ||
        data;

      const versions = parseVersions(source);

      if (versions.length) return versions;
    }
  } catch (error) {
    console.error("External versions API error:", error.message);
  }

  return parseVersions(process.env.UNDERCUR_VERSIONS_JSON);
}

function versionTitle(item) {
  return item.status
    ? `${item.status} ${item.version}`
    : item.version;
}

async function versionsMessage(chatId, messageId = null) {
  const versions = await getVersions();

  if (!versions.length) {
    const text =
      "🎮 Актуальные версии пока не опубликованы.";

    if (messageId) {
      return editMessage(chatId, messageId, text, {
        reply_markup: backKeyboard(),
      });
    }

    return sendMessage(chatId, text, {
      reply_markup: backKeyboard(),
    });
  }

  const buttons = versions.map((item) => [
    {
      text: versionTitle(item),
      callback_data: `version:${item.version}`,
    },
  ]);

  buttons.push([
    {
      text: "⬅️ Назад",
      callback_data: "home",
    },
  ]);

  const text =
    "🎮 Актуальные версии UnderCur\n\n" +
    "Выберите версию:";

  const extra = {
    reply_markup: {
      inline_keyboard: buttons,
    },
  };

  if (messageId) {
    return editMessage(chatId, messageId, text, extra);
  }

  return sendMessage(chatId, text, extra);
}

async function showVersion(chatId, messageId, version) {
  const versions = await getVersions();
  const item = versions.find(
    (entry) => entry.version === version
  );

  if (!item) {
    return editMessage(
      chatId,
      messageId,
      "Версия не найдена.",
      {
        reply_markup: backKeyboard(),
      }
    );
  }

  let text =
    `🎮 Версия ${version}\n\n` +
    "Скачать игру можно только в официальном канале проекта:\n" +
    `${OFFICIAL_CHANNEL}\n\n` +
    "Для запуска игры нужен любой ПК и Microsoft PowerPoint.\n" +
    "Файл игры имеет формат .ppsx.";

  const buttons = [];

  if (item.url) {
    buttons.push([
      {
        text: "⬇️ Скачать версию",
        url: item.url,
      },
    ]);
  }

  buttons.push([
    {
      text: "⬅️ К версиям",
      callback_data: "versions",
    },
  ]);

  return editMessage(chatId, messageId, text, {
    reply_markup: {
      inline_keyboard: buttons,
    },
  });
}

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
    "Здесь можно посмотреть новости, актуальные версии игры " +
    "и связаться с разработчиками.";

  const extra = {
    reply_markup: mainKeyboard(),
  };

  if (messageId) {
    return editMessage(chatId, messageId, text, extra);
  }

  return sendMessage(chatId, text, extra);
}

async function sendHelp(chatId, messageId = null) {
  const text =
    "ℹ️ Команды UnderCur\n\n" +
    "/start — главное меню\n" +
    "/help — помощь\n" +
    "/versions — версии игры\n" +
    "/news — раздел новостей\n\n" +
    "Новости можно включить или выключить в разделе «Новости».";

  if (messageId) {
    return editMessage(chatId, messageId, text, {
      reply_markup: backKeyboard(),
    });
  }

  return sendMessage(chatId, text, {
    reply_markup: backKeyboard(),
  });
}

async function processCommand(message, text) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const command = text.split(/\s+/)[0].toLowerCase();

  if (command === "/start") {
    await saveUser(userId);
    return sendHome(chatId);
  }

  if (command === "/help") {
    return sendHelp(chatId);
  }

  if (
    command === "/versions" ||
    command === "/versoins"
  ) {
    return versionsMessage(chatId);
  }

  if (command === "/news") {
    const user = await getUser(userId);

    return sendMessage(
      chatId,
      "📰 Новости UnderCur\n\n" +
        "Здесь будут появляться новости проекта.",
      {
        reply_markup: newsKeyboard(user.news !== false),
      }
    );
  }

  if (command === "/news" && isAdmin(userId)) {
    return sendMessage(
      chatId,
      "Использование:\n/news Текст новости"
    );
  }

  if (text.startsWith("/news ") && isAdmin(userId)) {
    const newsText = text.slice(6).trim();

    if (!newsText) {
      return sendMessage(chatId, "Напишите текст новости.");
    }

    const users =
      (await kv.smembers("undercur:users")) || [];

    let sent = 0;

    for (const userId of users) {
      const user = await getUser(userId);

      if (user.news === false) continue;

      try {
        await sendMessage(
          userId,
          `📰 Новость UnderCur\n\n${newsText}`
        );

        sent++;
      } catch (error) {
        console.error(
          "News delivery error:",
          error.message
        );
      }
    }

    return sendMessage(
      chatId,
      `Новость отправлена. Получателей: ${sent}.`
    );
  }

  return sendMessage(
    chatId,
    "Используйте меню ниже.",
    {
      reply_markup: mainKeyboard(),
    }
  );
}

async function processCallback(callback) {
  const data = callback.data;
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const userId = callback.from.id;

  await answerCallback(callback.id);

  if (data === "home") {
    return sendHome(chatId, messageId);
  }

  if (data === "help") {
    return sendHelp(chatId, messageId);
  }

  if (data === "versions") {
    return versionsMessage(chatId, messageId);
  }

  if (data.startsWith("version:")) {
    const version = data.slice("version:".length);
    return showVersion(chatId, messageId, version);
  }

  if (data === "news_menu") {
    const user = await getUser(userId);

    return editMessage(
      chatId,
      messageId,
      "📰 Раздел новостей\n\n" +
        "Выберите, получать ли вам новые публикации.",
      {
        reply_markup: newsKeyboard(user.news !== false),
      }
    );
  }

  if (data === "news_enable") {
    await saveUser(userId, { news: true });

    return editMessage(
      chatId,
      messageId,
      "🔔 Получение новостей включено.",
      {
        reply_markup: newsKeyboard(true),
      }
    );
  }

  if (data === "news_disable") {
    await saveUser(userId, { news: false });

    return editMessage(
      chatId,
      messageId,
      "🔕 Получение новостей выключено.",
      {
        reply_markup: newsKeyboard(false),
      }
    );
  }

  if (data === "developers") {
    await saveUser(userId, {
      state: "choose_developer_category",
    });

    return editMessage(
      chatId,
      messageId,
      "💬 Написать разработчикам\n\n" +
        "Выберите категорию сообщения:",
      {
        reply_markup: developersKeyboard(),
      }
    );
  }

  if (
    data === "developer_bug" ||
    data === "developer_idea"
  ) {
    const category =
      data === "developer_bug"
        ? "Нашёл баг"
        : "Предложить идею";

    await saveUser(userId, {
      state: "waiting_developer_message",
      developerCategory: category,
    });

    return editMessage(
      chatId,
      messageId,
      `Категория: ${category}\n\n` +
        "Теперь отправьте одним сообщением подробное описание.",
      {
        reply_markup: backKeyboard(),
      }
    );
  }
}

async function processText(message) {
  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text || "";

  if (text.startsWith("/")) {
    return processCommand(message, text);
  }

  const user = await getUser(userId);

  if (user.state === "waiting_developer_message") {
    const category = user.developerCategory || "Без категории";

    const adminText =
      "📩 Новое сообщение разработчикам\n\n" +
      `Категория: ${category}\n` +
      `Пользователь: ${message.from.first_name || "Без имени"}\n` +
      `ID: ${userId}\n\n` +
      text;

    for (const adminId of ADMIN_IDS) {
      await sendMessage(adminId, adminText);
    }

    await saveUser(userId, {
      state: null,
      developerCategory: null,
    });

    return sendMessage(
      chatId,
      "✅ Сообщение отправлено разработчикам.",
      {
        reply_markup: mainKeyboard(),
      }
    );
  }

  return sendMessage(
    chatId,
    "Выберите действие в меню.",
    {
      reply_markup: mainKeyboard(),
    }
  );
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "UnderCur Telegram Bot",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  if (
    WEBHOOK_SECRET &&
    req.headers["x-telegram-bot-api-secret-token"] !==
      WEBHOOK_SECRET
  ) {
    return res.status(403).json({
      ok: false,
      error: "Invalid webhook secret",
    });
  }

  try {
    const update = req.body;

    if (update.callback_query) {
      await processCallback(update.callback_query);
    } else if (update.message) {
      await saveUser(update.message.from.id);

      if (update.message.text) {
        await processText(update.message);
      }
    }

    return res.status(200).json({
      ok: true,
    });
  } catch (error) {
    console.error("UnderCur handler error:", error);

    return res.status(200).json({
      ok: false,
    });
  }
};