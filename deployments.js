const express = require('express');
const { kv } = require('@vercel/kv');
const router = express.Router();

// -----------------------------
// Конфигурация и Константы
// -----------------------------
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEFAULT_STATE = 'READY';
const CACHE_TTL = 300; // 5 минут

// -----------------------------
// Вспомогательные функции
// -----------------------------
const formatMoscowDate = (timestamp) => {
    // Vercel API возвращает 'created' как строку-таймстамп (например, "1609492210000")
    const date = new Date(Number(timestamp));
    return date.toLocaleString('ru-RU', {
        timeZone: 'Europe/Moscow',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
};

// -----------------------------
// Routes
// -----------------------------
router.get('/', async (req, res) => {
    try {
        // 1. Валидация конфигурации
        if (!VERCEL_TOKEN || !VERCEL_PROJECT_ID) {
            console.error('[Vercel Deployments] Missing environment variables: VERCEL_TOKEN or VERCEL_PROJECT_ID');
            return res.status(500).json({ 
                success: false, 
                error: 'Vercel API не настроен на сервере (отсутствуют переменные окружения)' 
            });
        }

        // 2. Парсинг query-параметров
        const requestedLimit = Math.min(Math.max(parseInt(req.query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
        const requestedState = (typeof req.query.state === 'string' ? req.query.state.toUpperCase() : DEFAULT_STATE) || DEFAULT_STATE;

        // 3. Динамический ключ кэша
        const CACHE_KEY = `vercel:deployments:${VERCEL_PROJECT_ID}:${requestedLimit}:${requestedState}`;

        // 4. Проверка кэша
        const cachedData = await kv.get(CACHE_KEY);
        if (cachedData) {
            return res.json({ ...cachedData, cached: true });
        }

        // 5. Запрос к Vercel API (ИСПРАВЛЕНО: v7 вместо v9)
        const apiUrl = `https://api.vercel.com/v7/deployments?projectId=${VERCEL_PROJECT_ID}&limit=${requestedLimit}&state=${requestedState}`;
        
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${VERCEL_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        // 6. Обработка ошибок API
        if (!response.ok) {
            let errorDetail = `Vercel API responded with status ${response.status}`;
            try {
                const errorBody = await response.json();
                errorDetail = errorBody.error?.message || errorDetail;
            } catch (e) {
                // Игнорируем, если ответ не JSON
            }

            console.error(`[Vercel Deployments] API Error ${response.status}:`, errorDetail);
            
            const status = response.status === 401 || response.status === 403 ? 403 : 502;
            return res.status(status).json({ 
                success: false, 
                error: `Ошибка Vercel API: ${errorDetail}` 
            });
        }

        const data = await response.json();

        // 7. Форматирование данных (ИСПРАВЛЕНО: маппинг полей согласно документации Vercel API v7)
        const deployments = (data.deployments || []).map(d => ({
            id: d.uid || d.id, // Vercel использует 'uid' для деплоев
            url: d.url ? `https://${d.url}` : null,
            createdAt: formatMoscowDate(d.created),
            state: d.state || d.readyState, // Vercel использует 'state' или 'readyState'
            commitMessage: d.meta?.githubCommitMessage || d.meta?.commitMessage || 'Ручной деплой',
            branch: d.meta?.githubCommitRef || d.meta?.branch || 'unknown',
            author: d.attribution?.gitUser?.login || d.meta?.githubCommitAuthorLogin || 'unknown'
        }));

        const result = { 
            success: true, 
            cached: false,
            count: deployments.length,
            deployments 
        };

        // 8. Сохранение в кэш
        await kv.set(CACHE_KEY, result, { ex: CACHE_TTL }).catch(err => {
            console.warn('[Vercel Deployments] Failed to write to cache:', err.message);
        });

        res.json(result);

    } catch (err) {
        console.error('[Vercel Deployments] Unexpected server error:', err.message);
        res.status(500).json({ 
            success: false, 
            error: 'Внутренняя ошибка сервера при получении истории деплоев' 
        });
    }
});

module.exports = router;