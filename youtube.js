const express = require('express');
const crypto = require('crypto');
const { kv } = require('@vercel/kv');

const router = express.Router();

const CONFIG = {
    COBALT_API: 'https://api.cobalt.tools',
    YOUTUBE_OEMBED: 'https://www.youtube.com/oembed',
    RATE_LIMIT_WINDOW: 60 * 1000,
    RATE_LIMIT_MAX: 30,
    CACHE_TTL: 5 * 60 * 1000,
    REQUEST_TIMEOUT: 15000,
    MAX_URL_LENGTH: 2048,
    RETRY_ATTEMPTS: 2,
    RETRY_DELAY: 1000,
    VIDEO_QUALITIES: ['1080', '720', '480', '360'],
    AUDIO_QUALITIES: ['320', '256', '192', '128'],
    SUPPORTED_FORMATS: ['mp4', 'mp3', 'webm']
};

const ERROR_MESSAGES = {
    INVALID_URL: 'Invalid YouTube URL',
    VIDEO_NOT_FOUND: 'Video not found',
    DOWNLOAD_FAILED: 'Download failed',
    TOO_MANY_REQUESTS: 'Too many requests',
    SERVER_ERROR: 'Internal server error',
    TIMEOUT: 'Request timeout',
    INVALID_VIDEO_ID: 'Invalid video ID',
    INVALID_FORMAT: 'Invalid format',
    INVALID_QUALITY: 'Invalid quality',
    API_UNAVAILABLE: 'External API unavailable'
};

const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

// Утилита для задержки
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Утилита для fetch с таймаутом
const fetchWithTimeout = async (url, options = {}, timeout = CONFIG.REQUEST_TIMEOUT) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error(ERROR_MESSAGES.TIMEOUT);
        }
        throw error;
    }
};

// Утилита для fetch с retry
const fetchWithRetry = async (url, options = {}, attempts = CONFIG.RETRY_ATTEMPTS) => {
    let lastError;
    
    for (let i = 0; i <= attempts; i++) {
        try {
            return await fetchWithTimeout(url, options);
        } catch (error) {
            lastError = error;
            console.warn(`[Fetch] Attempt ${i + 1} failed for ${url}:`, error.message);
            
            if (i < attempts) {
                await sleep(CONFIG.RETRY_DELAY * (i + 1));
            }
        }
    }
    
    throw lastError;
};

// Извлечение videoId из URL
function extractVideoId(url) {
    if (!url || typeof url !== 'string') return null;
    if (url.length > CONFIG.MAX_URL_LENGTH) return null;
    
    url = url.trim();
    
    const patterns = [
        /youtu\.be\/([a-zA-Z0-9_-]{11})/,
        /[?&]v=([a-zA-Z0-9_-]{11})/,
        /shorts\/([a-zA-Z0-9_-]{11})/,
        /embed\/([a-zA-Z0-9_-]{11})/,
        /live\/([a-zA-Z0-9_-]{11})/
    ];
    
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1]) return match[1];
    }
    
    if (VIDEO_ID_REGEX.test(url)) return url;
    
    return null;
}

// Валидация videoId
function isValidVideoId(videoId) {
    return VIDEO_ID_REGEX.test(videoId);
}

// Валидация формата
function isValidFormat(format) {
    return CONFIG.SUPPORTED_FORMATS.includes(format);
}

// Валидация качества
function isValidQuality(quality, type = 'video') {
    const qualities = type === 'audio' ? CONFIG.AUDIO_QUALITIES : CONFIG.VIDEO_QUALITIES;
    return qualities.includes(quality);
}

// Получение метаданных через YouTube oEmbed с кэшированием
async function getVideoMetadata(videoId) {
    const cacheKey = `meta:${videoId}`;
    
    try {
        const cached = await kv.get(cacheKey);
        if (cached) {
            console.log(`[Metadata] Cache hit for ${videoId}`);
            return cached;
        }
    } catch (error) {
        console.warn('[Metadata] Cache read error:', error.message);
    }
    
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const oembedUrl = `${CONFIG.YOUTUBE_OEMBED}?url=${encodeURIComponent(url)}&format=json`;
    
    const response = await fetchWithRetry(oembedUrl, { method: 'GET' });
    
    if (!response.ok) {
        if (response.status === 404) {
            throw new Error(ERROR_MESSAGES.VIDEO_NOT_FOUND);
        }
        throw new Error(`${ERROR_MESSAGES.API_UNAVAILABLE}: ${response.status}`);
    }
    
    const data = await response.json();
    
    const metadata = {
        videoId,
        title: data.title || 'Unknown',
        author: data.author_name || 'Unknown',
        authorUrl: data.author_url,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
        provider: data.provider_name || 'YouTube'
    };
    
    try {
        await kv.set(cacheKey, metadata, { px: CONFIG.CACHE_TTL });
        console.log(`[Metadata] Cached for ${videoId}`);
    } catch (error) {
        console.warn('[Metadata] Cache write error:', error.message);
    }
    
    return metadata;
}

// Получение ссылки на скачивание через Cobalt API
async function getDownloadLink(videoId, format = 'mp4', quality = '1080') {
    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    
    const requestBody = {
        url: youtubeUrl,
        downloadMode: format === 'mp3' ? 'audio' : 'auto',
        audioFormat: 'mp3',
        videoQuality: quality,
        filenameStyle: 'pretty',
        youtubeVideoQuality: quality
    };
    
    const response = await fetchWithRetry(
        `${CONFIG.COBALT_API}/`,
        {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        }
    );
    
    if (!response.ok) {
        throw new Error(`${ERROR_MESSAGES.API_UNAVAILABLE}: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.status === 'error') {
        const errorMsg = data.error?.code || data.text || ERROR_MESSAGES.DOWNLOAD_FAILED;
        throw new Error(errorMsg);
    }
    
    if (!data.url) {
        throw new Error(ERROR_MESSAGES.DOWNLOAD_FAILED);
    }
    
    return {
        url: data.url,
        filename: data.filename,
        format: format,
        quality: quality
    };
}

// Rate limiting с улучшенной логикой
async function checkRateLimit(ip) {
    const key = `rl:youtube:${ip}`;
    const now = Date.now();
    
    try {
        const data = await kv.hgetall(key);
        
        if (!data || !data.count) {
            await kv.hset(key, { 
                count: '1', 
                resetAt: String(now + CONFIG.RATE_LIMIT_WINDOW),
                createdAt: String(now)
            });
            await kv.expire(key, Math.ceil(CONFIG.RATE_LIMIT_WINDOW / 1000));
            
            return { 
                allowed: true, 
                remaining: CONFIG.RATE_LIMIT_MAX - 1,
                resetAt: now + CONFIG.RATE_LIMIT_WINDOW
            };
        }
        
        const resetAt = parseInt(data.resetAt, 10);
        
        if (now > resetAt) {
            await kv.del(key);
            await kv.hset(key, { 
                count: '1', 
                resetAt: String(now + CONFIG.RATE_LIMIT_WINDOW),
                createdAt: String(now)
            });
            await kv.expire(key, Math.ceil(CONFIG.RATE_LIMIT_WINDOW / 1000));
            
            return { 
                allowed: true, 
                remaining: CONFIG.RATE_LIMIT_MAX - 1,
                resetAt: now + CONFIG.RATE_LIMIT_WINDOW
            };
        }
        
        const count = parseInt(data.count, 10);
        
        if (count >= CONFIG.RATE_LIMIT_MAX) {
            return { 
                allowed: false, 
                retryAfter: Math.ceil((resetAt - now) / 1000),
                remaining: 0,
                resetAt
            };
        }
        
        await kv.hincrby(key, 'count', 1);
        
        return { 
            allowed: true, 
            remaining: CONFIG.RATE_LIMIT_MAX - count - 1,
            resetAt
        };
    } catch (error) {
        console.error('[RateLimit] KV error:', error);
        return { 
            allowed: true, 
            remaining: CONFIG.RATE_LIMIT_MAX,
            error: true
        };
    }
}

// Middleware для логирования запросов
router.use((req, res, next) => {
    const start = Date.now();
    console.log(`[Request] ${req.method} ${req.path}`);
    
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`[Response] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
    });
    
    next();
});

// GET /info/:videoId — получение информации и ссылок
router.get('/info/:videoId', async (req, res) => {
    try {
        const { videoId } = req.params;
        
        if (!isValidVideoId(videoId)) {
            return res.status(400).json({ 
                success: false,
                error: ERROR_MESSAGES.INVALID_VIDEO_ID 
            });
        }
        
        console.log(`[Info] Request for video ${videoId}`);
        
        const metadata = await getVideoMetadata(videoId);
        
        const formats = [
            { label: 'MP4 1080p', quality: '1080', type: 'video', format: 'mp4' },
            { label: 'MP4 720p', quality: '720', type: 'video', format: 'mp4' },
            { label: 'MP4 480p', quality: '480', type: 'video', format: 'mp4' },
            { label: 'MP4 360p', quality: '360', type: 'video', format: 'mp4' },
            { label: 'MP3 320kbps', quality: '320', type: 'audio', format: 'mp3' },
            { label: 'MP3 256kbps', quality: '256', type: 'audio', format: 'mp3' },
            { label: 'MP3 192kbps', quality: '192', type: 'audio', format: 'mp3' }
        ];
        
        const downloadLinks = [];
        
        for (const format of formats) {
            try {
                const link = await getDownloadLink(videoId, format.format, format.quality);
                downloadLinks.push({
                    label: format.label,
                    type: format.type,
                    format: format.format,
                    quality: format.quality,
                    url: link.url,
                    filename: link.filename
                });
            } catch (err) {
                console.warn(`[Info] Failed to get ${format.label}:`, err.message);
                downloadLinks.push({
                    label: format.label,
                    type: format.type,
                    format: format.format,
                    quality: format.quality,
                    error: err.message
                });
            }
        }
        
        res.json({
            success: true,
            data: {
                videoId: metadata.videoId,
                title: metadata.title,
                author: metadata.author,
                authorUrl: metadata.authorUrl,
                thumbnail: metadata.thumbnail,
                provider: metadata.provider,
                formats: downloadLinks
            }
        });
        
    } catch (err) {
        console.error('[Info] Error:', err);
        
        const statusCode = err.message.includes('not found') ? 404 : 500;
        res.status(statusCode).json({ 
            success: false,
            error: err.message || ERROR_MESSAGES.SERVER_ERROR 
        });
    }
});

// GET /download/:videoId/:format/:quality — редирект на файл
router.get('/download/:videoId/:format/:quality', async (req, res) => {
    try {
        const { videoId, format, quality } = req.params;
        
        if (!isValidVideoId(videoId)) {
            return res.status(400).json({ 
                success: false,
                error: ERROR_MESSAGES.INVALID_VIDEO_ID 
            });
        }
        
        if (!isValidFormat(format)) {
            return res.status(400).json({ 
                success: false,
                error: ERROR_MESSAGES.INVALID_FORMAT 
            });
        }
        
        const qualityType = format === 'mp3' ? 'audio' : 'video';
        if (!isValidQuality(quality, qualityType)) {
            return res.status(400).json({ 
                success: false,
                error: ERROR_MESSAGES.INVALID_QUALITY 
            });
        }
        
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        const rateLimit = await checkRateLimit(ip);
        
        if (!rateLimit.allowed) {
            return res.status(429)
                .set('Retry-After', String(rateLimit.retryAfter))
                .json({ 
                    success: false,
                    error: ERROR_MESSAGES.TOO_MANY_REQUESTS,
                    retryAfter: rateLimit.retryAfter
                });
        }
        
        console.log(`[Download] Request for ${videoId} in ${format} ${quality}`);
        
        const link = await getDownloadLink(videoId, format, quality);
        
        res.setHeader('X-RateLimit-Remaining', String(rateLimit.remaining));
        res.setHeader('X-RateLimit-Reset', String(Math.ceil(rateLimit.resetAt / 1000)));
        
        res.redirect(302, link.url);
        
    } catch (err) {
        console.error('[Download] Error:', err);
        
        let statusCode = 500;
        let errorMessage = err.message || ERROR_MESSAGES.DOWNLOAD_FAILED;
        
        if (err.message.includes('timeout')) {
            statusCode = 504;
        } else if (err.message.includes('not found')) {
            statusCode = 404;
        }
        
        res.status(statusCode).json({ 
            success: false,
            error: errorMessage 
        });
    }
});

// GET /health — проверка работоспособности
router.get('/health', (req, res) => {
    res.json({
        success: true,
        data: {
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: process.uptime()
        }
    });
});

// Error handling middleware
router.use((err, req, res, next) => {
    console.error('[Router] Unhandled error:', err);
    res.status(500).json({ 
        success: false,
        error: ERROR_MESSAGES.SERVER_ERROR 
    });
});

module.exports = router;