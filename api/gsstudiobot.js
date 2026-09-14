const { kv } = require("@vercel/kv");

const BOT_TOKEN = process.env.GS_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.GS_WEBHOOK_SECRET || "";
const ADMIN_IDS = String(process.env.GS_ADMIN_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

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

// Парсим дату формата: 10.02.2045+16:10
function parseDate(str) {
  if (!str) return null;

  const match = str.match(
    /^(\d{1,2})\.(\d{1,2})\.(\d{4})\+(\d{1,2}):(\d{1,2})$/
  );

  if (!match) return null;

  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1; // месяц с 0
  const year = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);

  const date = new Date(year, month, day, hour, minute, 0, 0);

  if (isNaN(date.getTime())) return null;

  return date.getTime();
}

function formatDate(timestamp) {
  const d = new Date(timestamp);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  const hour = String(d.getHours()).padStart(2, "0");
  const minute = String(d.getMinutes()).padStart(2, "0");

  return `${day}.${month}.${year} ${hour}:${minute}`;
}

// Получаем код из базы
async function getCode(name) {
  return await kv.get(`gs:code:${name}`);
}

// Сохраняем код
async function saveCode(name, data) {
  await kv.set(`gs:code:${name}`, data);
  await kv.sadd("gs:codes", name);
}

// Удаляем код
async function deleteCode(name) {
  await kv.del(`gs:code:${name}`);
  await kv.srem("gs:codes", name);
}

// Список всех имён кодов
async function listCodeNames() {
  return (await kv.smembers("gs:codes")) || [];
}

// Получаем данные пользователя
async function getUser(userId) {
  return (
    (await kv.get(`gs:user:${userId}`)) || {
      userId: String(userId),
      usedCodes: [],
    }
  );
}

// Сохраняем пользователя
async function saveUser(userId, data = {}) {
  const key = `gs:user:${userId}`;
  const old = (await kv.get(key)) || {
    userId: String(userId),
    usedCodes: [],
  };

  await kv.set(key, {
    ...old,
    userId: String(userId),
    ...data,
    updatedAt: Date.now(),
  });
}

// Чистим старые истекшие коды (прошло больше часа с момента истечения)
async function cleanupExpiredCodes() {
  const names = await listCodeNames();
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;

  for (const name of names) {
    const code = await getCode(name);
    if (!code) continue;

    if (code.expiresAt && now - code.expiresAt > hourMs) {
      await deleteCode(name);
    }
  }
}

// Определяем цветной индикатор для /all
function codeStatus(code) {
  const now = Date.now();

  if (code.expiresAt && now > code.expiresAt) {
    return {
      icon: "🟠",
      label: "истёк",
      expired: true,
    };
  }

  if (code.status === "no_reward") {
    return {
      icon: "🔴",
      label: "нет награды",
      expired: false,
    };
  }

  if (code.status === "pending") {
    return {
      icon: "🟡",
      label: "в процессе",
      expired: false,
    };
  }

  if (code.status === "active") {
    return {
      icon: "🟢",
      label: "активен",
      expired: false,
    };
  }

  return {
    icon: "⚪",
    label: "неизвестно",
    expired: false,
  };
}

async function sendStart(chatId) {
  const text =
    "🎁 <b>GcStudio Промокоды</b>\n\n" +
    "Здесь ты можешь активировать секретные коды и получать награды от разработчиков.\n\n" +
    "<b>Команды:</b>\n" +
    "/code <код> — активировать промокод\n" +
    "/my — мои использованные коды\n" +
    "/help — помощь";

  return sendMessage(chatId, text, {
    parse_mode: "HTML",
  });
}

async function sendHelp(chatId) {
  const text =
    "ℹ️ <b>Помощь</b>\n\n" +
    "🔹 <b>/code &lt;название&gt;</b> — активировать промокод\n" +
    "🔹 <b>/my</b> — список твоих активированных кодов\n\n" +
    "Промокоды публикуются в канале проекта. " +
    "Если код истёк или уже использован — бот сообщит об этом.";

  return sendMessage(chatId, text, {
    parse_mode: "HTML",
  });
}

// Активация промокода пользователем
async function activateCode(chatId, userId, codeName) {
  if (!codeName) {
    return sendMessage(
      chatId,
      "❌ Укажи название кода.\n\nПример: <code>/code SUMMER2026</code>",
      { parse_mode: "HTML" }
    );
  }

  const code = await getCode(codeName);

  if (!code) {
    return sendMessage(
      chatId,
      "❌ <b>Код не найден</b>\n\n" +
        "Такого промокода не существует. Проверь правильность написания.",
      { parse_mode: "HTML" }
    );
  }

  const now = Date.now();

  if (code.expiresAt && now > code.expiresAt) {
    const expiredAt = formatDate(code.expiresAt);
    return sendMessage(
      chatId,
      `⏰ <b>Код истёк</b>\n\n` +
        `Промокод <code>${codeName}</code> перестал действовать ${expiredAt}.`,
      { parse_mode: "HTML" }
    );
  }

  if (code.status !== "active") {
    return sendMessage(
      chatId,
      "⚠️ <b>Код ещё не готов</b>\n\n" +
        "Разработчики пока не завершили настройку награды для этого кода. Попробуй позже.",
      { parse_mode: "HTML" }
    );
  }

  const user = await getUser(userId);

  if (user.usedCodes.includes(codeName)) {
    return sendMessage(
      chatId,
      "🔁 <b>Ты уже использовал этот код</b>\n\n" +
        "Каждый промокод можно активировать только один раз.",
      { parse_mode: "HTML" }
    );
  }

  // Выдаём награду
  user.usedCodes.push(codeName);
  await saveUser(userId, { usedCodes: user.usedCodes });

  // Добавляем пользователя в список использовавших
  const usedBy = code.usedBy || [];
  if (!usedBy.includes(String(userId))) {
    usedBy.push(String(userId));
  }
  code.usedBy = usedBy;
  await saveCode(codeName, code);

  const rewardText = code.reward || "Награда не указана.";

  const message =
    `✅ <b>Код активирован!</b>\n\n` +
    `🎁 <b>Промокод:</b> <code>${codeName}</code>\n\n` +
    `🎉 <b>Твоя награда:</b>\n${rewardText}`;

  return sendMessage(chatId, message, {
    parse_mode: "HTML",
  });
}

// Список использованных кодов у пользователя
async function showMyCodes(chatId, userId) {
  const user = await getUser(userId);

  if (!user.usedCodes || user.usedCodes.length === 0) {
    return sendMessage(
      chatId,
      "📭 У тебя пока нет активированных промокодов.\n\n" +
        "Следи за каналом проекта, чтобы не пропустить новые!",
      { parse_mode: "HTML" }
    );
  }

  let text = "🎁 <b>Твои активированные коды:</b>\n\n";

  for (const name of user.usedCodes) {
    text += `• <code>${name}</code>\n`;
  }

  return sendMessage(chatId, text, {
    parse_mode: "HTML",
  });
}

// Создание кода (админ)
async function createCode(chatId, userId, args) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }

  if (args.length < 2) {
    return sendMessage(
      chatId,
      "❌ <b>Неверный формат</b>\n\n" +
        "Используй: <code>/create НАЗВАНИЕ ДД.ММ.ГГГГ+ЧЧ:ММ</code>\n\n" +
        "Пример: <code>/create SUMMER2026 10.02.2045+16:10</code>",
      { parse_mode: "HTML" }
    );
  }

  const name = args[0].toUpperCase();
  const dateStr = args[1];
  const expiresAt = parseDate(dateStr);

  if (!expiresAt) {
    return sendMessage(
      chatId,
      "❌ <b>Неверный формат даты</b>\n\n" +
        "Используй формат: <code>ДД.ММ.ГГГГ+ЧЧ:ММ</code>\n" +
        "Пример: <code>10.02.2045+16:10</code>",
      { parse_mode: "HTML" }
    );
  }

  if (expiresAt <= Date.now()) {
    return sendMessage(
      chatId,
      "❌ <b>Дата уже прошла</b>\n\n" +
        "Укажи дату в будущем.",
      { parse_mode: "HTML" }
    );
  }

  const existing = await getCode(name);

  if (existing) {
    return sendMessage(
      chatId,
      `❌ Код <code>${name}</code> уже существует.\nИспользуй другое название.`,
      { parse_mode: "HTML" }
    );
  }

  await saveCode(name, {
    name,
    createdAt: Date.now(),
    expiresAt,
    reward: null,
    status: "no_reward",
    usedBy: [],
    createdBy: String(userId),
  });

  return sendMessage(
    chatId,
    `✅ <b>Код создан</b>\n\n` +
      `🔖 Название: <code>${name}</code>\n` +
      `⏰ Истекает: ${formatDate(expiresAt)}\n` +
      `🔴 Статус: награда не привязана\n\n` +
      `Используй /link ${name}, чтобы привязать награду.`,
    { parse_mode: "HTML" }
  );
}

// Привязка награды к коду (админ)
async function linkCode(chatId, userId, codeName) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }

  if (!codeName) {
    return sendMessage(
      chatId,
      "❌ Укажи название кода.\n\nПример: <code>/link SUMMER2026</code>",
      { parse_mode: "HTML" }
    );
  }

  const name = codeName.toUpperCase();
  const code = await getCode(name);

  if (!code) {
    return sendMessage(
      chatId,
      `❌ Код <code>${name}</code> не найден.`,
      { parse_mode: "HTML" }
    );
  }

  // Переводим в состояние ожидания награды
  await saveUser(userId, {
    state: "waiting_reward",
    pendingCodeName: name,
  });

  // Меняем статус на "в процессе"
  code.status = "pending";
  await saveCode(name, code);

  return sendMessage(
    chatId,
    `🔗 <b>Код ${name} привязан к настройке</b>\n\n` +
      `Теперь напиши одним сообщением <b>награду</b> для этого кода.\n\n` +
      `Это может быть:\n` +
      `• Просто текст\n` +
      `• Ссылка на файл или ресурс\n` +
      `• Описание подарка\n` +
      `• Любая комбинация\n\n` +
      `Поддерживается HTML-форматирование: <code>&lt;b&gt;</code>, <code>&lt;i&gt;</code>, <code>&lt;a href="..."&gt;</code>.`,
    { parse_mode: "HTML" }
  );
}

// Список всех кодов (админ)
async function listAllCodes(chatId, userId) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }

  // Сначала чистим старые
  await cleanupExpiredCodes();

  const names = await listCodeNames();

  if (names.length === 0) {
    return sendMessage(
      chatId,
      "📭 Пока нет ни одного промокода.\n\n" +
        "Создай первый: <code>/create НАЗВАНИЕ ДД.ММ.ГГГГ+ЧЧ:ММ</code>",
      { parse_mode: "HTML" }
    );
  }

  let text = "📋 <b>Все промокоды</b>\n\n";
  text += "🟢 — активен (награда готова)\n";
  text += "🟡 — в процессе (настраивается награда)\n";
  text += "🔴 — нет награды\n";
  text += "🟠 — истёк (будет удалён через час)\n\n";

  for (const name of names) {
    const code = await getCode(name);
    if (!code) continue;

    const st = codeStatus(code);
    const usedCount = (code.usedBy || []).length;
    const expires = formatDate(code.expiresAt);

    text += `${st.icon} <code>${name}</code>\n`;
    text += `   └ ${st.label} • до ${expires} • использовали: ${usedCount}\n\n`;
  }

  return sendMessage(chatId, text, {
    parse_mode: "HTML",
  });
}

// Удаление кода (админ)
async function deleteCodeCommand(chatId, userId, codeName) {
  if (!isAdmin(userId)) {
    return sendMessage(chatId, "⛔ У тебя нет прав администратора.");
  }

  if (!codeName) {
    return sendMessage(
      chatId,
      "❌ Укажи название кода.\n\nПример: <code>/delete SUMMER2026</code>",
      { parse_mode: "HTML" }
    );
  }

  const name = codeName.toUpperCase();
  const code = await getCode(name);

  if (!code) {
    return sendMessage(
      chatId,
      `❌ Код <code>${name}</code> не найден.`,
      { parse_mode: "HTML" }
    );
  }

  await deleteCode(name);

  return sendMessage(
    chatId,
    `🗑 Код <code>${name}</code> удалён.`,
    { parse_mode: "HTML" }
  );
}

// Обработка команд
async function processCommand(message, text) {
  const chatId = message.chat.id;
  const userId = message.from.id;

  const parts = text.trim().split(/\s+/);
  const command = parts[0].toLowerCase().split("@")[0];
  const args = parts.slice(1);

  if (command === "/start") {
    return sendStart(chatId);
  }

  if (command === "/help") {
    return sendHelp(chatId);
  }

  if (command === "/my") {
    return showMyCodes(chatId, userId);
  }

  if (command === "/code") {
    return activateCode(chatId, userId, args[0]);
  }

  if (command === "/create") {
    return createCode(chatId, userId, args);
  }

  if (command === "/link") {
    return linkCode(chatId, userId, args[0]);
  }

  if (command === "/all") {
    return listAllCodes(chatId, userId);
  }

  if (command === "/delete") {
    return deleteCodeCommand(chatId, userId, args[0]);
  }

  return sendMessage(
    chatId,
    "Неизвестная команда. Используй /help.",
  );
}

// Обработка обычных сообщений (для ввода награды админом)
async function processText(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text || "";

  if (text.startsWith("/")) {
    return processCommand(message, text);
  }

  const user = await getUser(userId);

  if (user.state === "waiting_reward" && isAdmin(userId)) {
    const codeName = user.pendingCodeName;
    const code = await getCode(codeName);

    if (!code) {
      await saveUser(userId, {
        state: null,
        pendingCodeName: null,
      });
      return sendMessage(chatId, "❌ Код уже не существует.");
    }

    const rewardText = text;

    code.reward = rewardText;
    code.status = "active";
    await saveCode(codeName, code);

    await saveUser(userId, {
      state: null,
      pendingCodeName: null,
    });

    return sendMessage(
      chatId,
      `✅ <b>Награда привязана!</b>\n\n` +
        `🔖 Код: <code>${codeName}</code>\n` +
        `🟢 Статус: активен\n` +
        `⏰ Истекает: ${formatDate(code.expiresAt)}\n\n` +
        `Теперь пользователи могут активировать его командой /code ${codeName}`,
      { parse_mode: "HTML" }
    );
  }

  return sendMessage(
    chatId,
    "🎁 Используй меню команд слева.\n\n" +
      "Основная команда: /code НАЗВАНИЕ",
  );
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "GcStudio Promo Bot",
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
      await answerCallback(update.callback_query.id);
    } else if (update.message) {
      await processText(update.message);
    }

    return res.status(200).json({
      ok: true,
    });
  } catch (error) {
    console.error("GcStudio handler error:", error);

    return res.status(200).json({
      ok: false,
    });
  }
};