const express = require('express');
const crypto = require('crypto');
const { kv } = require('@vercel/kv');

const router = express.Router();
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// -----------------------------
// KV Keys
// -----------------------------
const K = {
    HISTORY: (id) => `monitor:history:${id}`,
    ALERTS: (id) => `monitor:alerts:${id}`,
    CONFIG: (id) => `monitor:config:${id}`,
    STATS: 'monitor:global_stats',
    SESSION: (token) => `monitor:session:${token}`
};

// -----------------------------
// Helpers
// -----------------------------
function generateId() {
    return crypto.randomBytes(8).toString('hex');
}

function isValidUrl(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

// -----------------------------
// Middleware
// -----------------------------
function verifyAdminToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.split(' ')[1];
    const isValid = ADMIN_TOKEN && 
                    token && 
                    token.length === ADMIN_TOKEN.length &&
                    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN));
    
    if (!isValid) return res.status(403).json({ error: 'Forbidden' });
    next();
}

// -----------------------------
// Server-side check (обход CORS)
// -----------------------------
router.post('/check', async (req, res) => {
    try {
        const { url, method = 'GET', expected = 200 } = req.body;
        
        if (!url || !isValidUrl(url)) {
            return res.status(400).json({ error: 'Неверный URL' });
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const start = Date.now();

        try {
            const response = await fetch(url, {
                method: method.toUpperCase(),
                signal: controller.signal,
                headers: { 'User-Agent': 'Oris-Monitor/1.0' },
                cache: 'no-store'
            });
            clearTimeout(timeout);
            const latency = Date.now() - start;
            
            const ok = expected === 'any' 
                ? response.status >= 200 && response.status < 400
                : response.status === parseInt(expected);

            res.json({
                status: ok ? (latency > 2000 ? 'degraded' : 'up') : 'down',
                latency,
                statusCode: response.status,
                timestamp: Date.now()
            });
        } catch (err) {
            clearTimeout(timeout);
            const latency = Date.now() - start;
            res.json({
                status: 'down',
                latency,
                error: err.name === 'AbortError' ? 'Timeout' : err.message,
                timestamp: Date.now()
            });
        }
    } catch (err) {
        console.error('[monitor/check]', err);
        res.status(500).json({ error: 'Ошибка проверки' });
    }
});

// -----------------------------
// Save history
// -----------------------------
router.post('/history/:monitorId', async (req, res) => {
    try {
        const { monitorId } = req.params;
        const { status, latency, statusCode, timestamp } = req.body;

        // Сохраняем в KV (последние 100 записей)
        const history = await kv.get(K.HISTORY(monitorId)) || [];
        history.push({ status, latency, statusCode, timestamp });
        if (history.length > 100) {
            history.shift();
        }
        await kv.set(K.HISTORY(monitorId), history, { ex: 60 * 60 * 24 * 7 }); // 7 дней TTL

        // Обновляем глобальную статистику
        const stats = await kv.get(K.STATS) || { totalChecks: 0, upChecks: 0, downChecks: 0 };
        stats.totalChecks++;
        if (status === 'up') stats.upChecks++;
        if (status === 'down') stats.downChecks++;
        await kv.set(K.STATS, stats);

        res.json({ success: true });
    } catch (err) {
        console.error('[monitor/history]', err);
        res.status(500).json({ error: 'Ошибка сохранения' });
    }
});

// -----------------------------
// Get history
// -----------------------------
router.get('/history/:monitorId', async (req, res) => {
    try {
        const { monitorId } = req.params;
        const history = await kv.get(K.HISTORY(monitorId)) || [];
        res.json({ history });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка загрузки' });
    }
});

// -----------------------------
// Alert (Telegram)
// -----------------------------
router.post('/alert', async (req, res) => {
    try {
        const { monitorName, monitorUrl, status, from, to } = req.body;

        if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
            return res.status(500).json({ error: 'Telegram не настроен' });
        }

        const statusEmoji = status === 'down' ? '🔴' : '';
        const statusText = status === 'down' ? 'НЕДОСТУПЕН' : 'Восстановлен';
        
        let message = `${statusEmoji} <b>Мониторинг: ${monitorName}</b>\n\n`;
        message += `URL: ${monitorUrl}\n`;
        message += `Статус: <b>${statusText}</b>\n`;
        
        if (from) {
            const duration = Math.round((Date.now() - from) / 1000);
            message += `Длительность: ${duration}с\n`;
        }
        
        message += `\n⏰ ${new Date().toLocaleString('ru-RU')}`;

        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'HTML'
            })
        });

        // Сохраняем инцидент
        const incident = {
            monitorName,
            monitorUrl,
            status,
            from: from || Date.now(),
            to: to || Date.now(),
            timestamp: Date.now()
        };
        
        const alerts = await kv.get(K.ALERTS(monitorName)) || [];
        alerts.push(incident);
        if (alerts.length > 50) alerts.shift();
        await kv.set(K.ALERTS(monitorName), alerts, { ex: 60 * 60 * 24 * 30 });

        res.json({ success: true });
    } catch (err) {
        console.error('[monitor/alert]', err);
        res.status(500).json({ error: 'Ошибка отправки' });
    }
});

// -----------------------------
// Get alerts
// -----------------------------
router.get('/alerts/:monitorName', async (req, res) => {
    try {
        const { monitorName } = req.params;
        const alerts = await kv.get(K.ALERTS(monitorName)) || [];
        res.json({ alerts });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка загрузки' });
    }
});

// -----------------------------
// Global stats
// -----------------------------
router.get('/stats', async (req, res) => {
    try {
        const stats = await kv.get(K.STATS) || { totalChecks: 0, upChecks: 0, downChecks: 0 };
        res.json({ stats });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка загрузки' });
    }
});

module.exports = router;