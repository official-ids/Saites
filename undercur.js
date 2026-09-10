const { kv } = require("@vercel/kv");
const express = require("express");

const router = express.Router();

// ============================================
// Конфигурация
// ============================================

const CONFIG = {
  VERSIONS_KEY: "undercur:versions",

  RATE_LIMIT_WINDOW: 60 * 1000,
  RATE_LIMIT_MAX: 30,

  DEFAULT_FILE_BASE_URL:
    process.env.UNDERCUR_FILE_BASE_URL ||
    "https://oris-flax.vercel.app/~/",
};

// ============================================
// Утилиты
// ============================================

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];

  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }

  return (
    req.ip ||
    req.connection?.remoteAddress ||
    "unknown"
  );
}

function normalizeVersionName(value, index) {
  if (
    value !== undefined &&
    value !== null &&
    String(value).trim().length > 0
  ) {
    return String(value).trim();
  }

  return `unknown-${index + 1}`;
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" ||
      url.protocol === "http:"
    );
  } catch {
    return false;
  }
}

function getFileUrl(version, value) {
  if (typeof value === "string") {
    if (isValidHttpUrl(value)) {
      return value;
    }

    return null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const possibleUrls = [
    value.path,
    value.url,
    value.downloadUrl,
    value.download_url,
    value.file,
    value.href,
  ];

  for (const possibleUrl of possibleUrls) {
    if (
      typeof possibleUrl === "string" &&
      isValidHttpUrl(possibleUrl)
    ) {
      return possibleUrl;
    }
  }

  if (
    typeof value.fileName === "string" &&
    value.fileName.trim()
  ) {
    return buildFileUrl(value.fileName);
  }

  return null;
}

function buildFileUrl(fileName) {
  const cleanFileName = String(fileName)
    .replace(/^\/+/, "")
    .replace(/\.\.+/g, "");

  return `${CONFIG.DEFAULT_FILE_BASE_URL}${cleanFileName}`;
}

function compareVersions(a, b) {
  const parseVersion = (value) => {
    const match = String(value).match(
      /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/
    );

    if (!match) {
      return null;
    }

    return [
      Number(match[1] || 0),
      Number(match[2] || 0),
      Number(match[3] || 0),
    ];
  };

  const left = parseVersion(a.version);
  const right = parseVersion(b.version);

  if (left && right) {
    for (let index = 0; index < 3; index++) {
      if (left[index] !== right[index]) {
        return left[index] - right[index];
      }
    }

    return 0;
  }

  return a.version.localeCompare(b.version, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function normalizeVersions(input) {
  const versions = [];

  if (!input) {
    return [];
  }

  // Формат:
  // {
  //   "1.0.0": {
  //     "path": "https://..."
  //   }
  // }
  if (
    typeof input === "object" &&
    !Array.isArray(input)
  ) {
    Object.entries(input).forEach(([version, value], index) => {
      const url = getFileUrl(version, value);

      if (!url) {
        return;
      }

      versions.push({
        version: normalizeVersionName(version, index),
        path: url,
      });
    });

    return versions.sort(compareVersions);
  }

  // Формат:
  // [
  //   {
  //     "version": "1.0.0",
  //     "path": "https://..."
  //   }
  // ]
  if (Array.isArray(input)) {
    input.forEach((item, index) => {
      if (typeof item === "string") {
        const version = normalizeVersionName(item, index);
        const url = getFileUrl(version, item);

        if (url) {
          versions.push({
            version,
            path: url,
          });
        }

        return;
      }

      if (!item || typeof item !== "object") {
        return;
      }

      const version = normalizeVersionName(
        item.version ??
          item.name ??
          item.tag ??
          item.id,
        index
      );

      const url = getFileUrl(version, item);

      if (!url) {
        return;
      }

      versions.push({
        version,
        path: url,
      });
    });
  }

  return versions.sort(compareVersions);
}

function parseVersionsConfig(config) {
  if (!config) {
    return [];
  }

  if (typeof config === "string") {
    try {
      const parsed = JSON.parse(config);
      return normalizeVersions(parsed);
    } catch (error) {
      console.error("[UnderCur] Failed to parse JSON config:", {
        message: error.message,
      });

      return [];
    }
  }

  return normalizeVersions(config);
}

async function checkRateLimit(ip) {
  const key = `ratelimit:undercur:${ip}`;
  const now = Date.now();

  const data = await kv.hgetall(key);

  if (!data || !data.count || !data.resetAt) {
    await kv.hset(key, {
      count: "1",
      resetAt: String(now + CONFIG.RATE_LIMIT_WINDOW),
    });

    await kv.expire(
      key,
      Math.ceil(CONFIG.RATE_LIMIT_WINDOW / 1000)
    );

    return {
      allowed: true,
      remaining: CONFIG.RATE_LIMIT_MAX - 1,
    };
  }

  const resetAt = Number(data.resetAt);
  const count = Number(data.count);

  if (!Number.isFinite(resetAt) || now >= resetAt) {
    await kv.del(key);

    await kv.hset(key, {
      count: "1",
      resetAt: String(now + CONFIG.RATE_LIMIT_WINDOW),
    });

    await kv.expire(
      key,
      Math.ceil(CONFIG.RATE_LIMIT_WINDOW / 1000)
    );

    return {
      allowed: true,
      remaining: CONFIG.RATE_LIMIT_MAX - 1,
    };
  }

  if (count >= CONFIG.RATE_LIMIT_MAX) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil((resetAt - now) / 1000),
    };
  }

  await kv.hincrby(key, "count", 1);

  return {
    allowed: true,
    remaining: Math.max(
      CONFIG.RATE_LIMIT_MAX - count - 1,
      0
    ),
  };
}

async function getConfiguredVersions() {
  const storedVersions = await kv.get(CONFIG.VERSIONS_KEY);

  if (storedVersions) {
    const normalized = normalizeVersions(storedVersions);

    if (normalized.length > 0) {
      return normalized;
    }
  }

  const envVersions =
    process.env.UNDERCUR_VERSIONS_JSON;

  const parsedEnvVersions = parseVersionsConfig(envVersions);

  if (parsedEnvVersions.length > 0) {
    return parsedEnvVersions;
  }

  return [];
}

async function saveVersions(versions) {
  const normalized = normalizeVersions(versions);

  if (!normalized.length) {
    throw new Error("Cannot save an empty versions list");
  }

  await kv.set(CONFIG.VERSIONS_KEY, normalized);

  return normalized;
}

// ============================================
// Middleware
// ============================================

router.use(express.json({ limit: "100kb" }));

async function rateLimitMiddleware(req, res, next) {
  try {
    const ip = getClientIp(req);
    const rateLimit = await checkRateLimit(ip);

    res.set(
      "X-RateLimit-Remaining",
      String(rateLimit.remaining)
    );

    if (!rateLimit.allowed) {
      res.set(
        "Retry-After",
        String(rateLimit.retryAfter)
      );

      return res.status(429).json({
        success: false,
        message: `Слишком много запросов. Повторите через ${rateLimit.retryAfter} сек.`,
      });
    }

    next();
  } catch (error) {
    console.error("[UnderCur] Rate limit error:", {
      message: error.message,
      stack: error.stack,
    });

    return res.status(500).json({
      success: false,
      message: "Ошибка проверки ограничения запросов",
    });
  }
}

// ============================================
// Routes
// ============================================

/**
 * GET /api/undercur/
 *
 * Информация об API
 */
router.get("/", (req, res) => {
  res.json({
    success: true,
    service: "UnderCur API",
    endpoints: {
      versions: "/api/undercur/get-versions/",
      health: "/api/undercur/health/",
    },
  });
});

/**
 * GET /api/undercur/get-versions/
 *
 * Получение списка версий
 */
router.get(
  "/get-versions/",
  rateLimitMiddleware,
  async (req, res) => {
    try {
      const versions = await getConfiguredVersions();

      if (!versions.length) {
        return res.status(404).json({
          success: false,
          message: "Список версий UnderCur пока пуст",
          versions: {},
        });
      }

      const versionsObject = {};

      for (const item of versions) {
        versionsObject[item.version] = {
          path: item.path,
        };
      }

      return res.status(200).json({
        success: true,
        versions: versionsObject,
      });
    } catch (error) {
      console.error("[UnderCur] Failed to get versions:", {
        message: error.message,
        stack: error.stack,
      });

      return res.status(500).json({
        success: false,
        message: "Не удалось получить список версий",
      });
    }
  }
);

/**
 * POST /api/undercur/get-versions/
 *
 * POST поддерживается для совместимости.
 */
router.post(
  "/get-versions/",
  rateLimitMiddleware,
  async (req, res) => {
    try {
      const versions = await getConfiguredVersions();

      if (!versions.length) {
        return res.status(404).json({
          success: false,
          message: "Список версий UnderCur пока пуст",
          versions: {},
        });
      }

      const versionsObject = {};

      for (const item of versions) {
        versionsObject[item.version] = {
          path: item.path,
        };
      }

      return res.status(200).json({
        success: true,
        versions: versionsObject,
      });
    } catch (error) {
      console.error("[UnderCur] Failed to get versions:", {
        message: error.message,
        stack: error.stack,
      });

      return res.status(500).json({
        success: false,
        message: "Не удалось получить список версий",
      });
    }
  }
);

/**
 * GET /api/undercur/health/
 */
router.get("/health/", async (req, res) => {
  try {
    await kv.get(CONFIG.VERSIONS_KEY);

    return res.status(200).json({
      status: "healthy",
      service: "undercur",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[UnderCur] Health check failed:", {
      message: error.message,
    });

    return res.status(503).json({
      status: "unhealthy",
      service: "undercur",
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /api/undercur/admin/versions/
 *
 * Получение текущей конфигурации.
 *
 * Защищено ADMIN_API_TOKEN.
 */
router.get(
  "/admin/versions/",
  async (req, res) => {
    const adminToken = process.env.ADMIN_API_TOKEN;
    const receivedToken =
      req.headers["x-admin-token"];

    if (
      !adminToken ||
      receivedToken !== adminToken
    ) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    try {
      const versions = await getConfiguredVersions();

      return res.status(200).json({
        success: true,
        versions,
      });
    } catch (error) {
      console.error("[UnderCur] Admin read error:", {
        message: error.message,
      });

      return res.status(500).json({
        success: false,
        message: "Не удалось получить версии",
      });
    }
  }
);

/**
 * PUT /api/undercur/admin/versions/
 *
 * Сохранение списка релизов в Vercel KV.
 *
 * Ожидаемое тело:
 * {
 *   "versions": {
 *     "1.0.0": {
 *       "path": "https://example.com/v1.0.ppsx"
 *     }
 *   }
 * }
 */
router.put(
  "/admin/versions/",
  async (req, res) => {
    const adminToken = process.env.ADMIN_API_TOKEN;
    const receivedToken =
      req.headers["x-admin-token"];

    if (
      !adminToken ||
      receivedToken !== adminToken
    ) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    try {
      const input =
        req.body?.versions ?? req.body;

      const versions = normalizeVersions(input);

      if (!versions.length) {
        return res.status(400).json({
          success: false,
          message: "Передан пустой или некорректный список версий",
        });
      }

      await saveVersions(versions);

      return res.status(200).json({
        success: true,
        message: "Список версий сохранён",
        count: versions.length,
        versions,
      });
    } catch (error) {
      console.error("[UnderCur] Admin save error:", {
        message: error.message,
        stack: error.stack,
      });

      return res.status(500).json({
        success: false,
        message: "Не удалось сохранить список версий",
      });
    }
  }
);

module.exports = router;
