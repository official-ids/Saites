const express = require('express');
const crypto = require('crypto');
const { kv } = require('@vercel/kv');

const router = express.Router();

const CONFIG = {
    COBALT_API: 'https://api.cobalt.tools',
    YOUTUBE_OEMBED: 'https://www.youtube.com/oembed',
    RATE_LIMIT_WINDOW: 60 * 1000,
    RATE_LIMIT_MAX: 30,
    CACHE_TTL: 5 * 60 * 1000
};

const ERROR_MESSAGES = {
    INVALID_URL: 'Invalid YouTube URL',
    VIDEO_NOT_FOUND: 'Video not found',
    DOWNLOAD_FAILED: 'Download failed',
    TOO_MANY_REQUESTS: 'Too many requests'
};

// Извлечение videoId
function extractVideoId(url) {
    if (!url) return null;
    url = url.trim();
    
    let m = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (m) return m[1];
    
    m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (m) return m[1];
    
    m = url.match(/shorts\/([a-zA-Z0-9_-]{11})/);
    if (m) return m[1];
    
    if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
    
    return null;
}

// Получение метаданных через YouTube oEmbed
async function getVideoMetadata(videoId) {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const oembedUrl = `${CONFIG.YOUTUBE_OEMBED}?url=${encodeURIComponent(url)}&format=json`;
    
    const response = await fetch(oembedUrl);
    
    if (!response.ok) {
        throw new Error('Failed to get video metadata');
    }
    
    const data = await response.json();
    
    return {
        videoId,
        title: data.title || 'Unknown',
        author: data.author_name || 'Unknown',
        thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`
    };
}

// Получение ссылки на скачивание через Cobalt API
async function getDownloadLink(videoId, format = 'mp4', quality = '1080') {
    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    
    const requestBody = {
        url: youtubeUrl,
        downloadMode: format === 'mp3' ? 'audio' : 'auto',
        audioFormat: 'mp3',
        videoQuality: quality
    };
    
    const response = await fetch(`${CONFIG.COBALT_API}/`, {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
        throw new Error(`Cobalt API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.status === 'error') {
        throw new Error(data.error?.code || 'Download failed');
    }
    
    return {
        url: data.url,
        filename: data.filename,
        format: format
    };
}

// Rate limiting
async function checkRateLimit(ip) {
    const key = `rl:youtube:${ip}`;
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

// GET /info/:videoId — получение информации и ссылок
router.get('/info/:videoId', async (req, res) => {
    try {
        const videoId = req.params.videoId;
        
        if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
            return res.status(400).json({ error: 'Invalid video ID' });
        }
        
        // Получаем метаданные видео
        const metadata = await getVideoMetadata(videoId);
        
        // Получаем ссылки для разных форматов
        const formats = [
            { label: 'MP4 1080p', quality: '1080', type: 'video' },
            { label: 'MP4 720p', quality: '720', type: 'video' },
            { label: 'MP4 480p', quality: '480', type: 'video' },
            { label: 'MP3 320kbps', quality: '320', type: 'audio' }
        ];
        
        const downloadLinks = [];
        
        for (const format of formats) {
            try {
                const link = await getDownloadLink(
                    videoId, 
                    format.type === 'audio' ? 'mp3' : 'mp4',
                    format.quality
                );
                downloadLinks.push({
                    ...format,
                    url: link.url,
                    filename: link.filename
                });
            } catch (err) {
                console.warn(`Failed to get ${format.label}:`, err.message);
            }
        }
        
        res.json({
            videoId: metadata.videoId,
            title: metadata.title,
            author: metadata.author,
            thumbnail: metadata.thumbnail,
            formats: downloadLinks
        });
        
    } catch (err) {
        console.error('Failed to get info:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

// GET /download/:videoId/:format/:quality — редирект на файл
router.get('/download/:videoId/:format/:quality', async (req, res) => {
    try {
        const { videoId, format, quality } = req.params;
        
        if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
            return res.status(400).json({ error: 'Invalid video ID' });
        }
        
        // Rate limiting
        const ip = req.ip || req.connection.remoteAddress;
        const rateLimit = await checkRateLimit(ip);
        
        if (!rateLimit.allowed) {
            return res.status(429)
                .set('Retry-After', rateLimit.retryAfter)
                .json({ error: ERROR_MESSAGES.TOO_MANY_REQUESTS });
        }
        
        // Получаем ссылку на скачивание
        const link = await getDownloadLink(
            videoId,
            format === 'mp3' ? 'mp3' : 'mp4',
            quality
        );
        
        res.setHeader('X-RateLimit-Remaining', String(rateLimit.remaining));
        res.redirect(302, link.url);
        
    } catch (err) {
        console.error('Download failed:', err);
        res.status(500).json({ error: err.message || ERROR_MESSAGES.DOWNLOAD_FAILED });
    }
});

module.exports = router;