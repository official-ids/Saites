const express = require('express');
const { kv } = require('@vercel/kv');
const router = express.Router();

// -----------------------------
// Конфигурация и Константы
// -----------------------------
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;

// Базовые настройки по умолчанию
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50; // Защита от чрезмерных запросов к Vercel API
const DEFAULT_STATE = 'READY';
const CACHE_TTL = 300; // 5 минут

// -----------------------------
// Вспомогательные функции
// -----------------------------

/**
 * Форматирует дату в московском времени
 */
const formatMoscowDate = (dateString) => {
    return new Date(dateString).toLocaleString('ru-RU', {
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

/**
 * GET /api/deployments
 * Возвращает список деплоев с поддержкой пагинации, фильтрации и умного кэширования.
 * Query params:
 *  - limit: число (по умолчанию 20, макс 50)
 *  - state: строка (по умолчанию 'READY', например: 'BUILDING', 'ERROR', 'READY')
 */
router.get('/', async (req, res) => {
    try {
        // 1. Валидация конфигурации (Fail Fast)
        if (!VERCEL_TOKEN || !VERCEL_PROJECT_ID) {
            console.error('[Vercel Deployments] Missing environment variables: VERCEL_TOKEN or VERCEL_PROJECT_ID');
            return res.status(500).json({ 
                success: false, 
                error: 'Vercel API не настроен на сервере (отсутствуют переменные окружения)' 
            });
        }

        // 2. Парсинг и валидация query-параметров (Гибкость)
        const requestedLimit = Math.min(Math.max(parseInt(req.query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
        const requestedState = (typeof req.query.state === 'string' ? req.query.state.toUpperCase() : DEFAULT_STATE) || DEFAULT_STATE;

        // 3. Динамический ключ кэша (Предотвращение коллизий)
        // Если запрошен другой лимит или статус, кэш должен быть отдельным
        const CACHE_KEY = `vercel:deployments:${VERCEL_PROJECT_ID}:${requestedLimit}:${requestedState}`;

        // 4. Проверка кэша
        const cachedData = await kv.get(CACHE_KEY);
        if (cachedData) {
            return res.json({ ...cachedData, cached: true }); // Флаг cached полезен для отладки на фронтенде
        }

        // 5. Запрос к Vercel API
        const apiUrl = `https://api.vercel.com/v9/deployments?projectId=${VERCEL_PROJECT_ID}&limit=${requestedLimit}&state=${requestedState}`;
        
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${VERCEL_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        // 6. Продвинутая обработка ошибок API
        if (!response.ok) {
            let errorDetail = `Vercel API responded with status ${response.status}`;
            try {
                const errorBody = await response.json();
                errorDetail = errorBody.error?.message || errorDetail;
            } catch (e) {
                // Игнорируем, если ответ не JSON
            }

            console.error(`[Vercel Deployments] API Error ${response.status}:`, errorDetail);
            
            // Возвращаем корректный HTTP-статус клиенту (например, 401 при плохом токене)
            const status = response.status === 401 || response.status === 403 ? 403 : 502;
            return res.status(status).json({ 
                success: false, 
                error: `Ошибка Vercel API: ${errorDetail}` 
            });
        }

        const data = await response.json();

        // 7. Безопасное форматирование данных (защита от undefined/null)
        const deployments = (data.deployments || []).map(d => ({
            id: d.id,
            url: d.url ? `https://${d.url}` : null,
            createdAt: formatMoscowDate(d.created),
            state: d.state,
            commitMessage: d.meta?.githubCommitMessage || d.meta?.commitMessage || 'Ручной деплой',
            branch: d.meta?.githubCommitRef || d.meta?.branch || 'unknown',
            author: d.meta?.githubCommitAuthorLogin || 'unknown' // Бонус: автор коммита
        }));

        const result = { 
            success: true, 
            cached: false,
            count: deployments.length,
            deployments 
        };

        // 8. Сохранение в кэш с TTL
        // Используем .catch, чтобы ошибка записи в кэш не ломала успешный ответ клиенту
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