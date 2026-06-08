const express = require('express');
const crypto = require('crypto');
const { kv } = require('@vercel/kv');

const router = express.Router();
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

// -----------------------------
// KV Keys
// -----------------------------
const K = {
    REDIRECT: (slug) => `redirect:${slug.toLowerCase()}`,
    REDIRECTS_INDEX: 'redirects:index'
};

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
                    token.length === ADMIN_TOKEN.length && 
                    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN));
    
    if (!isValid) return res.status(403).json({ error: 'Forbidden' });
    next();
}

function isValidUrl(string) {
    try {
        const url = new URL(string);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

// ====================================
// Админские эндпоинты (СТАТИЧЕСКИЕ — ДО ДИНАМИЧЕСКОГО!)
// ====================================

// Получить список всех редиректов
router.get('/admin', verifyAdminToken, async (req, res) => {
    try {
        const slugs = await kv.smembers(K.REDIRECTS_INDEX);
        const redirects = [];
        
        for (const slug of slugs) {
            const data = await kv.get(K.REDIRECT(slug));
            if (data) redirects.push(data);
        }

        redirects.sort((a, b) => b.clicks - a.clicks);
        res.json({ redirects });
    } catch (err) {
        console.error('[redirects GET admin]', err);
        res.status(500).json({ error: 'Ошибка получения списка' });
    }
});

// Создать редирект
router.post('/admin', verifyAdminToken, async (req, res) => {
    try {
        const { slug, url, description } = req.body;
        
        if (!slug || !/^[a-z0-9_-]{2,32}$/.test(slug)) {
            return res.status(400).json({ error: 'Slug: 2-32 символов (a-z, 0-9, -, _)' });
        }
        if (!url || !isValidUrl(url)) {
            return res.status(400).json({ error: 'Требуется корректный HTTP/HTTPS URL' });
        }

        const existing = await kv.get(K.REDIRECT(slug));
        if (existing) {
            return res.status(409).json({ error: 'Такой slug уже существует' });
        }

        const redirectData = {
            slug: slug.toLowerCase(),
            url: url.trim(),
            description: description ? String(description).slice(0, 200) : '',
            clicks: 0,
            createdAt: new Date().toISOString()
        };

        await kv.set(K.REDIRECT(slug), redirectData);
        await kv.sadd(K.REDIRECTS_INDEX, slug.toLowerCase());

        res.json({ success: true, redirect: redirectData });
    } catch (err) {
        console.error('[redirects POST admin]', err);
        res.status(500).json({ error: 'Ошибка создания редиректа' });
    }
});

// Удалить редирект
router.delete('/admin/:slug', verifyAdminToken, async (req, res) => {
    try {
        const slug = req.params.slug.toLowerCase().trim();
        await kv.del(K.REDIRECT(slug));
        await kv.srem(K.REDIRECTS_INDEX, slug);
        res.json({ success: true });
    } catch (err) {
        console.error('[redirects DELETE admin]', err);
        res.status(500).json({ error: 'Ошибка удаления' });
    }
});

// ====================================
// Публичный эндпоинт (ДИНАМИЧЕСКИЙ — ПОСЛЕ АДМИНСКИХ)
// ====================================
router.get('/:slug', async (req, res) => {
    try {
        const slug = req.params.slug.toLowerCase().trim();
        
        if (!/^[a-z0-9_-]{2,32}$/.test(slug)) {
            return res.status(400).send('Invalid redirect slug');
        }

        const redirectData = await kv.get(K.REDIRECT(slug));
        if (!redirectData) {
            return res.status(404).send('Redirect not found');
        }

        // Асинхронный инкремент счётчика кликов
        kv.hincrby(K.REDIRECT(slug), 'clicks', 1).catch(() => {});

        res.redirect(302, redirectData.url);
    } catch (err) {
        console.error('[redirects GET]', err);
        res.status(500).send('Internal server error');
    }
});

module.exports = router;