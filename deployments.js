const express = require('express');
const { kv } = require('@vercel/kv');
const router = express.Router();

// -----------------------------
// Конфигурация
// -----------------------------
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;
const CACHE_KEY = 'vercel:deployments:cache';
const CACHE_TTL = 300; // Кэш на 5 минут (300 секунд)

// -----------------------------
// Routes
// -----------------------------

/**
 * GET /api/deployments
 * Возвращает список последних деплоев с кэшированием
 */
router.get('/', async (req, res) => {
    try {
        // 1. Проверка наличия секретов
        if (!VERCEL_TOKEN || !VERCEL_PROJECT_ID) {
            console.error('[deployments] Missing VERCEL_TOKEN or VERCEL_PROJECT_ID');
            return res.status(500).json({ error: 'Vercel API не настроен на сервере' });
        }

        // 2. Проверяем кэш в Vercel KV
        const cachedData = await kv.get(CACHE_KEY);
        if (cachedData) {
            return res.json(cachedData);
        }

        // 3. Запрос к официальному Vercel API
        const apiUrl = `https://api.vercel.com/v9/deployments?projectId=${VERCEL_PROJECT_ID}&limit=20&state=READY`;
        
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${VERCEL_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`Vercel API responded with status ${response.status}`);
        }

        const data = await response.json();

        // 4. Форматируем данные для удобного использования на фронтенде
        const deployments = data.deployments.map(d => ({
            id: d.id,
            url: `https://${d.url}`, // Полная ссылка на превью
            createdAt: new Date(d.created).toLocaleString('ru-RU', { 
                timeZone: 'Europe/Moscow',
                day: 'numeric', month: 'long', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            }),
            state: d.state, // READY, ERROR, BUILDING и т.д.
            commitMessage: d.meta?.githubCommitMessage || 'Ручной деплой',
            branch: d.meta?.githubCommitRef || 'unknown'
        }));

        const result = { 
            success: true, 
            deployments 
        };

        // 5. Сохраняем в кэш с TTL
        await kv.set(CACHE_KEY, result, { ex: CACHE_TTL });

        res.json(result);

    } catch (err) {
        console.error('[deployments] Error fetching deployments:', err.message);
        res.status(500).json({ 
            success: false, 
            error: 'Ошибка получения истории деплоев' 
        });
    }
});

module.exports = router;