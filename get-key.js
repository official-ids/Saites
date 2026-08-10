const express = require('express');
const { kv } = require('@vercel/kv');
const router = express.Router();

// ============================================
// Конфигурация
// ============================================
const CONFIG = {
    KEY_LENGTH: 8,
    KEY_TTL: 24 * 60 * 60, // 24 часа в секундах
    RATE_LIMIT_WINDOW: 60 * 1000, // 1 минута
    RATE_LIMIT_MAX: 5 // максимум 5 ключей в минуту
};

// ============================================
// Утилиты
// ============================================
/**
 * Генерация случайного ключа
 * @returns {string} Случайный ключ
 */
function generateKey() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Без похожих символов (I, O, 0, 1)
    let result = '';
    for (let i = 0; i < CONFIG.KEY_LENGTH; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * Rate limiting для генерации ключей
 */
async function checkRateLimit(ip) {
    const key = `ratelimit:getkey:${ip}`;
    const data = await kv.hgetall(key);
    const now = Date.now();
    
    if (!data || !data.count) {
        await kv.hset(key, { count: '1', resetAt: String(now + CONFIG.RATE_LIMIT_WINDOW) });
        await kv.expire(key, Math.ceil(CONFIG.RATE_LIMIT_WINDOW / 1000));
        return { allowed: true, remaining: CONFIG.RATE_LIMIT_MAX - 1 };
    }
    
    const resetAt = parseInt(data.resetAt, 10);
    if (now > resetAt) {
        await kv.del(key);
        await kv.hset(key, { count: '1', resetAt: String(now + CONFIG.RATE_LIMIT_WINDOW) });
        await kv.expire(key, Math.ceil(CONFIG.RATE_LIMIT_WINDOW / 1000));
        return { allowed: true, remaining: CONFIG.RATE_LIMIT_MAX - 1 };
    }
    
    const count = parseInt(data.count, 10);
    if (count >= CONFIG.RATE_LIMIT_MAX) {
        return { 
            allowed: false, 
            retryAfter: Math.ceil((resetAt - now) / 1000),
            remaining: 0
        };
    }
    
    await kv.hincrby(key, 'count', 1);
    return { allowed: true, remaining: CONFIG.RATE_LIMIT_MAX - count - 1 };
}

// ============================================
// Routes
// ============================================

/**
 * POST /api/get-key — получение нового ключа
 */
router.post('/', async (req, res) => {
    try {
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        
        // Проверка rate limit
        const rateLimit = await checkRateLimit(ip);
        if (!rateLimit.allowed) {
            return res.status(429)
                .set('Retry-After', rateLimit.retryAfter)
                .json({ 
                    success: false, 
                    message: `Слишком много запросов. Подождите ${rateLimit.retryAfter} сек.` 
                });
        }
        
        // Генерация уникального ключа
        let key;
        let attempts = 0;
        const maxAttempts = 10;
        
        do {
            key = generateKey();
            const existing = await kv.exists(`key:${key}`);
            if (!existing) break;
            attempts++;
        } while (attempts < maxAttempts);
        
        if (attempts >= maxAttempts) {
            return res.status(500).json({ 
                success: false, 
                message: 'Не удалось сгенерировать уникальный ключ' 
            });
        }
        
        // Сохранение ключа в KV
        const keyData = {
            key,
            createdAt: Date.now(),
            expiresAt: Date.now() + (CONFIG.KEY_TTL * 1000),
            used: false,
            ip
        };
        
        await kv.setex(`key:${key}`, CONFIG.KEY_TTL, JSON.stringify(keyData));
        
        console.log(`[GetKey] Key generated: ${key} for IP: ${ip}`);
        
        res.json({ 
            success: true, 
            key,
            expiresIn: CONFIG.KEY_TTL,
            message: 'Ключ успешно сгенерирован'
        });
        
    } catch (err) {
        console.error('[GetKey] Error:', err);
        res.status(500).json({ 
            success: false, 
            message: 'Ошибка сервера при генерации ключа' 
        });
    }
});

/**
 * GET /health — проверка здоровья
 */
router.get('/health', async (req, res) => {
    try {
        await kv.exists('key:healthcheck');
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(503).json({
            status: 'unhealthy',
            error: err.message
        });
    }
});

module.exports = router;