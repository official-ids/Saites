const express = require('express');
const { kv } = require('@vercel/kv');
const router = express.Router();

// ============================================
// Конфигурация
// ============================================
const CONFIG = {
    SECRET_KEY: 'ORIS_SECRET_2026_X' // Должен совпадать с Lua скриптом
};

// ============================================
// Routes
// ============================================

/**
 * POST /api/verify-key — проверка и активация ключа
 */
router.post('/', async (req, res) => {
    try {
        const { key } = req.body;
        
        // Валидация ключа
        if (!key || typeof key !== 'string' || key.length !== 8) {
            return res.status(400).json({ 
                success: false, 
                message: 'Неверный формат ключа' 
            });
        }
        
        const normalizedKey = key.toUpperCase();
        
        // Поиск ключа в KV
        const keyDataRaw = await kv.get(`key:${normalizedKey}`);
        
        if (!keyDataRaw) {
            return res.status(403).json({ 
                success: false, 
                message: 'Ключ не найден или истёк' 
            });
        }
        
        // Парсинг данных ключа
        const keyData = typeof keyDataRaw === 'string' 
            ? JSON.parse(keyDataRaw) 
            : keyDataRaw;
        
        // Проверка, не использован ли ключ
        if (keyData.used) {
            return res.status(403).json({ 
                success: false, 
                message: 'Этот ключ уже был использован' 
            });
        }
        
        // Проверка срока действия
        if (Date.now() > keyData.expiresAt) {
            await kv.del(`key:${normalizedKey}`);
            return res.status(403).json({ 
                success: false, 
                message: 'Срок действия ключа истёк' 
            });
        }
        
        // Помечаем ключ как использованный
        keyData.used = true;
        keyData.usedAt = Date.now();
        await kv.set(`key:${normalizedKey}`, JSON.stringify(keyData));
        
        console.log(`[VerifyKey] Key verified: ${normalizedKey} for IP: ${keyData.ip}`);
        
        // Возвращаем секрет для расшифровки
        res.json({ 
            success: true, 
            decryptSecret: CONFIG.SECRET_KEY,
            message: 'Ключ успешно активирован'
        });
        
    } catch (err) {
        console.error('[VerifyKey] Error:', err);
        res.status(500).json({ 
            success: false, 
            message: 'Ошибка сервера при проверке ключа' 
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