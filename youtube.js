const express = require('express');
const crypto = require('crypto');
const { kv } = require('@vercel/kv');
const { PassThrough } = require('stream');

const router = express.Router();

const CONFIG = {
    // API
    COBALT_API: process.env.COBALT_API || 'https://api.cobalt.tools/',
    COBALT_API_KEY: process.env.COBALT_API_KEY || '',
    YOUTUBE_OEMBED: 'https://www.youtube.com/oembed',
    
    // Rate limiting
    RATE_LIMIT_WINDOW: 60 * 1000,
    RATE_LIMIT_MAX: 30,
    
    // Кэш
    CACHE_TTL: 5 * 60 * 1000,
    
    // Таймауты
    REQUEST_TIMEOUT: 30000,
    DOWNLOAD_TIMEOUT: 120000, // 2 минуты на загрузку файла
    
    // Валидация
    MAX_URL_LENGTH: 2048,
    MAX_FILE_SIZE: 500 * 1024 * 1024, // 500MB лимит
    
    // Retry
    RETRY_ATTEMPTS: 3,
    RETRY_DELAY: 1000,
    
    // Качества
    VIDEO_QUALITIES: ['2160', '1440', '1080', '720', '480', '360', '240', '144'],
    AUDIO_QUALITIES: ['320', '256', '192', '128', '96', '64'],
    SUPPORTED_FORMATS: ['mp4', 'mp3', 'webm', 'm4a', 'ogg'],
    
    // Content-Type маппинг
    MIME_TYPES: {
        'mp4': 'video/mp4',
        'webm': 'video/webm',
        'mp3': 'audio/mpeg',
        'm4a': 'audio/mp4',
        'ogg': 'audio/ogg'
    }
};

const INVIDIOUS_INSTANCES = [
    'https://invidious.snopyta.org',
    'https://invidious.kavin.rocks',
    'https://vid.puffyan.us'
];

const ERROR_MESSAGES = {
    INVALID_URL: 'Invalid YouTube URL',
    VIDEO_NOT_FOUND: 'Video not found or private',
    DOWNLOAD_FAILED: 'Download failed',
    TOO_MANY_REQUESTS: 'Too many requests, please try again later',
    SERVER_ERROR: 'Internal server error',
    TIMEOUT: 'Request timeout',
    INVALID_VIDEO_ID: 'Invalid video ID',
    INVALID_FORMAT: 'Invalid format',
    INVALID_QUALITY: 'Invalid quality',
    API_UNAVAILABLE: 'External API unavailable',
    API_KEY_MISSING: 'Cobalt API key is not configured',
    FILE_TOO_LARGE: 'File size exceeds limit',
    STREAM_ERROR: 'Stream error during download',
    NO_LINK_AVAILABLE: 'No download link available for this format/quality'
};

const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

// ============ УТИЛИТЫ ============

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

const fetchWithRetry = async (url, options = {}, attempts = CONFIG.RETRY_ATTEMPTS) => {
    let lastError;
    
    for (let i = 0; i <= attempts; i++) {
        try {
            return await fetchWithTimeout(url, options);
        } catch (error) {
            lastError = error;
            console.warn(`[Fetch] Attempt ${i + 1}/${attempts + 1} failed for ${url}:`, error.message);
            
            if (i < attempts) {
                await sleep(CONFIG.RETRY_DELAY * Math.pow(2, i)); // Exponential backoff
            }
        }
    }
    
    throw lastError;
};

// ============ ВАЛИДАЦИЯ ============

function extractVideoId(url) {
    if (!url || typeof url !== 'string') return null;
    if (url.length > CONFIG.MAX_URL_LENGTH) return null;
    
    url = url.trim();
    
    const patterns = [
        /youtu\.be\/([a-zA-Z0-9_-]{11})/,
        /[?&]v=([a-zA-Z0-9_-]{11})/,
        /shorts\/([a-zA-Z0-9_-]{11})/,
        /embed\/([a-zA-Z0-9_-]{11})/,
        /live\/([a-zA-Z0-9_-]{11})/,
        /music\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/
    ];
    
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1]) return match[1];
    }
    
    if (VIDEO_ID_REGEX.test(url)) return url;
    
    return null;
}

function isValidVideoId(videoId) {
    return VIDEO_ID_REGEX.test(videoId);
}

function isValidFormat(format) {
    return CONFIG.SUPPORTED_FORMATS.includes(format.toLowerCase());
}

function isValidQuality(quality, type = 'video') {
    const qualities = type === 'audio' ? CONFIG.AUDIO_QUALITIES : CONFIG.VIDEO_QUALITIES;
    return qualities.includes(quality);
}

// ============ МЕТАДАННЫЕ ============

async function getVideoMetadata(videoId) {
    const cacheKey = `meta:${videoId}`;
    
    try {
        const cached = await kv.get(cacheKey);
        if (cached) {
            const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
            console.log(`[Metadata] Cache hit for ${videoId}`);
            return parsed;
        }
    } catch (error) {
        console.warn('[Metadata] Cache read error:', error.message);
    }
    
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const oembedUrl = `${CONFIG.YOUTUBE_OEMBED}?url=${encodeURIComponent(url)}&format=json`;
    
    const response = await fetchWithRetry(oembedUrl, { method: 'GET' });
    
    if (!response.ok) {
        if (response.status === 404 || response.status === 401) {
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
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        thumbnailMaxRes: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
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

// ============ COBALT API ============

async function getDownloadLink(videoId, format = 'mp4', quality = '1080') {
    if (!CONFIG.COBALT_API) {
        throw new Error('Cobalt API URL is not configured');
    }
    
    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    
    // Правильный body для Cobalt API v10+
    const requestBody = {
        url: youtubeUrl,
        downloadMode: (format === 'mp3' || format === 'ogg' || format === 'wav' || format === 'opus') ? 'audio' : 'auto',
        filenameStyle: 'pretty',
        videoQuality: quality, // Правильное имя параметра!
        youtubeVideoCodec: 'h264' // Для совместимости с mp4
    };
    
    // Для аудио — audioFormat + audioBitrate
    if (format === 'mp3' || format === 'ogg' || format === 'wav' || format === 'opus') {
        requestBody.audioFormat = format;
        requestBody.audioBitrate = quality; // 320, 256, 128, 96, 64
    }
    
    const headers = {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    };
    
    if (CONFIG.COBALT_API_KEY) {
        headers['Authorization'] = `Api-Key ${CONFIG.COBALT_API_KEY}`;
    }
    
    // Endpoint теперь POST / (корень), а не /api/json
    const apiUrl = CONFIG.COBALT_API.endsWith('/') 
        ? CONFIG.COBALT_API 
        : CONFIG.COBALT_API + '/';
    
    const response = await fetchWithRetry(
        apiUrl,
        {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody)
        }
    );
    
    const responseText = await response.text();
    let data;
    
    try {
        data = JSON.parse(responseText);
    } catch (e) {
        console.error('[Cobalt] Failed to parse response:', responseText.substring(0, 500));
        throw new Error(`${ERROR_MESSAGES.API_UNAVAILABLE}: Invalid JSON response`);
    }
    
    console.log('[Cobalt] Response:', data.status, 'for', videoId, format, quality);
    
    if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
            throw new Error(ERROR_MESSAGES.API_KEY_MISSING);
        }
        if (response.status === 400) {
            const errorMsg = data.error?.code || data.error?.message || 'Bad request';
            throw new Error(`${ERROR_MESSAGES.DOWNLOAD_FAILED}: ${errorMsg}`);
        }
        throw new Error(`${ERROR_MESSAGES.API_UNAVAILABLE}: ${response.status}`);
    }
    
    // Обработка статусов ответа
    if (data.status === 'error') {
        const errorMsg = data.error?.code || 'Unknown error';
        throw new Error(`${ERROR_MESSAGES.DOWNLOAD_FAILED}: ${errorMsg}`);
    }
    
    // status: 'tunnel', 'redirect', 'picker'
    if (data.status === 'picker' && Array.isArray(data.picker) && data.picker.length > 0) {
        const item = data.picker[0];
        return {
            url: item.url,
            filename: data.filename || `video.${format}`,
            format: format,
            quality: quality,
            thumb: data.thumb
        };
    }
    
    if (data.status === 'tunnel' || data.status === 'redirect') {
        if (!data.url) {
            throw new Error(ERROR_MESSAGES.NO_LINK_AVAILABLE);
        }
        
        return {
            url: data.url,
            filename: data.filename || `video.${format}`,
            format: format,
            quality: quality
        };
    }
    
    if (data.url) {
        return {
            url: data.url,
            filename: data.filename || `video.${format}`,
            format: format,
            quality: quality
        };
    }
    
    throw new Error(ERROR_MESSAGES.NO_LINK_AVAILABLE);
}

// ============ RATE LIMITING ============

async function checkRateLimit(ip) {
    const key = `rl:youtube:${ip}`;
    const now = Date.now();
    const windowSeconds = Math.ceil(CONFIG.RATE_LIMIT_WINDOW / 1000);
    
    try {
        // Используем Redis pipeline для атомарности
        const multi = kv.multi();
        multi.incr(key);
        multi.ttl(key);
        const results = await multi.exec();
        
        let count = results[0];
        let ttl = results[1];
        
        // Если ключ только что создан
        if (count === 1 || ttl === -1) {
            await kv.expire(key, windowSeconds);
            ttl = windowSeconds;
        }
        
        const resetAt = now + (ttl * 1000);
        
        if (count > CONFIG.RATE_LIMIT_MAX) {
            return { 
                allowed: false, 
                retryAfter: ttl,
                remaining: 0,
                resetAt,
                limit: CONFIG.RATE_LIMIT_MAX
            };
        }
        
        return { 
            allowed: true, 
            remaining: CONFIG.RATE_LIMIT_MAX - count,
            resetAt,
            limit: CONFIG.RATE_LIMIT_MAX
        };
    } catch (error) {
        console.error('[RateLimit] KV error:', error.message);
        // При ошибке KV — пропускаем (fail-open)
        return { 
            allowed: true, 
            remaining: CONFIG.RATE_LIMIT_MAX,
            resetAt: now + CONFIG.RATE_LIMIT_WINDOW,
            limit: CONFIG.RATE_LIMIT_MAX,
            error: true
        };
    }
}

// ============ ПРОКСИРОВАНИЕ ФАЙЛА (РЕАЛЬНАЯ ЗАГРУЗКА) ============

async function proxyDownload(res, downloadLink, metadata, format, quality, ip) {
    const startTime = Date.now();
    const mimeType = CONFIG.MIME_TYPES[format] || 'application/octet-stream';
    
    // Формируем имя файла
    const safeTitle = (metadata.title || 'video')
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, '_')
        .substring(0, 100);
    const filename = `${safeTitle}_${quality}p.${format}`;
    
    console.log(`[Proxy] Starting download: ${filename} from ${downloadLink.url}`);
    
    try {
        // Запрашиваем файл с Cobalt с таймаутом на загрузку
        const fileResponse = await fetchWithTimeout(
            downloadLink.url,
            {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; YouTubeDownloader/1.0)',
                    'Accept': '*/*'
                }
            },
            CONFIG.DOWNLOAD_TIMEOUT
        );
        
        if (!fileResponse.ok) {
            throw new Error(`Upstream returned ${fileResponse.status}`);
        }
        
        const contentLength = fileResponse.headers.get('content-length');
        const totalBytes = contentLength ? parseInt(contentLength, 10) : null;
        
        // Проверка размера
        if (totalBytes && totalBytes > CONFIG.MAX_FILE_SIZE) {
            throw new Error(ERROR_MESSAGES.FILE_TOO_LARGE);
        }
        
        // Устанавливаем заголовки ответа
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
        res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Download-Filename', encodeURIComponent(filename));
        res.setHeader('X-Video-Id', metadata.videoId);
        res.setHeader('X-Video-Title', encodeURIComponent(metadata.title));
        res.setHeader('X-Quality', quality);
        res.setHeader('X-Format', format);
        
        if (totalBytes) {
            res.setHeader('Content-Length', totalBytes);
        }
        
        // Создаём стрим
        if (!fileResponse.body) {
            throw new Error('No response body from upstream');
        }
        
        // Используем PassThrough для контроля стрима
        const passThrough = new PassThrough();
        let downloadedBytes = 0;
        let lastProgressLog = 0;
        
        // Обработка данных для трекинга прогресса
        fileResponse.body.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            
            // Логируем прогресс каждые 10MB или каждые 5 секунд
            const now = Date.now();
            if (downloadedBytes % (10 * 1024 * 1024) < chunk.length || now - lastProgressLog > 5000) {
                const progress = totalBytes ? ((downloadedBytes / totalBytes) * 100).toFixed(1) : 'unknown';
                const speed = (downloadedBytes / ((now - startTime) / 1000) / 1024 / 1024).toFixed(2);
                console.log(`[Proxy] Progress: ${progress}% (${(downloadedBytes / 1024 / 1024).toFixed(2)} MB) at ${speed} MB/s`);
                lastProgressLog = now;
            }
            
            // Проверка лимита размера в реальном времени
            if (downloadedBytes > CONFIG.MAX_FILE_SIZE) {
                fileResponse.body.destroy();
                passThrough.destroy(new Error(ERROR_MESSAGES.FILE_TOO_LARGE));
                return;
            }
        });
        
        fileResponse.body.on('error', (err) => {
            console.error('[Proxy] Stream error:', err.message);
            passThrough.destroy(err);
        });
        
        fileResponse.body.pipe(passThrough);
        
        // Обработка ошибок клиента
        res.on('error', (err) => {
            console.error('[Proxy] Client response error:', err.message);
            fileResponse.body.destroy();
        });
        
        res.on('close', () => {
            const duration = Date.now() - startTime;
            const speed = (downloadedBytes / (duration / 1000) / 1024 / 1024).toFixed(2);
            console.log(`[Proxy] Completed: ${filename} — ${(downloadedBytes / 1024 / 1024).toFixed(2)} MB in ${duration}ms (${speed} MB/s)`);
        });
        
        // Стримим ответ
        passThrough.pipe(res);
        
    } catch (error) {
        console.error('[Proxy] Download error:', error.message);
        
        // Если заголовки ещё не отправлены — отдаём JSON ошибку
        if (!res.headersSent) {
            res.status(502).json({
                success: false,
                error: error.message || ERROR_MESSAGES.DOWNLOAD_FAILED
            });
        } else {
            // Если уже стримим — прерываем
            res.destroy(error);
        }
    }
}

// ============ MIDDLEWARE ============

router.use((req, res, next) => {
    const start = Date.now();
    const requestId = crypto.randomBytes(4).toString('hex');
    req.requestId = requestId;
    
    console.log(`[Request ${requestId}] ${req.method} ${req.path} from ${req.ip}`);
    
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`[Response ${requestId}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
    });
    
    next();
});

// ============ ROUTES ============

// GET /info/:videoId — только метаданные + список доступных форматов (без ссылок!)
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
        
        // Возвращаем только список доступных форматов, ссылки получаются отдельно
        const formats = [
            // Видео
            ...CONFIG.VIDEO_QUALITIES.map(q => ({
                type: 'video',
                format: 'mp4',
                quality: q,
                label: `MP4 ${q}p`
            })),
            // Аудио
            ...CONFIG.AUDIO_QUALITIES.map(q => ({
                type: 'audio',
                format: 'mp3',
                quality: q,
                label: `MP3 ${q}kbps`
            }))
        ];
        
        res.json({
            success: true,
            data: {
                videoId: metadata.videoId,
                title: metadata.title,
                author: metadata.author,
                authorUrl: metadata.authorUrl,
                thumbnail: metadata.thumbnail,
                thumbnailMaxRes: metadata.thumbnailMaxRes,
                provider: metadata.provider,
                formats,
                downloadEndpoint: `/download/${videoId}/{format}/{quality}`
            }
        });
        
    } catch (err) {
        console.error('[Info] Error:', err.message);
        
        const statusCode = err.message.includes('not found') ? 404 : 500;
        res.status(statusCode).json({ 
            success: false,
            error: err.message || ERROR_MESSAGES.SERVER_ERROR 
        });
    }
});

// GET /link/:videoId/:format/:quality — получение временной ссылки (без загрузки)
router.get('/link/:videoId/:format/:quality', async (req, res) => {
    try {
        const { videoId, format, quality } = req.params;
        
        if (!isValidVideoId(videoId)) {
            return res.status(400).json({ success: false, error: ERROR_MESSAGES.INVALID_VIDEO_ID });
        }
        
        if (!isValidFormat(format)) {
            return res.status(400).json({ success: false, error: ERROR_MESSAGES.INVALID_FORMAT });
        }
        
        const qualityType = (format === 'mp3' || format === 'm4a' || format === 'ogg') ? 'audio' : 'video';
        if (!isValidQuality(quality, qualityType)) {
            return res.status(400).json({ success: false, error: ERROR_MESSAGES.INVALID_QUALITY });
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
        
        const link = await getDownloadLink(videoId, format, quality);
        
        res.json({
            success: true,
            data: {
                url: link.url,
                filename: link.filename,
                format: link.format,
                quality: link.quality,
                expiresAt: Date.now() + (10 * 60 * 1000) // ~10 минут
            }
        });
        
    } catch (err) {
        console.error('[Link] Error:', err.message);
        
        let statusCode = 500;
        if (err.message.includes('timeout')) statusCode = 504;
        else if (err.message.includes('not found')) statusCode = 404;
        else if (err.message.includes('API key')) statusCode = 503;
        
        res.status(statusCode).json({ 
            success: false,
            error: err.message || ERROR_MESSAGES.DOWNLOAD_FAILED 
        });
    }
});

// GET /download/:videoId/:format/:quality — РЕАЛЬНАЯ ЗАГРУЗКА через сервер
router.get('/download/:videoId/:format/:quality', async (req, res) => {
    try {
        const { videoId, format, quality } = req.params;
        
        if (!isValidVideoId(videoId)) {
            return res.status(400).json({ success: false, error: ERROR_MESSAGES.INVALID_VIDEO_ID });
        }
        
        if (!isValidFormat(format)) {
            return res.status(400).json({ success: false, error: ERROR_MESSAGES.INVALID_FORMAT });
        }
        
        const qualityType = (format === 'mp3' || format === 'm4a' || format === 'ogg') ? 'audio' : 'video';
        if (!isValidQuality(quality, qualityType)) {
            return res.status(400).json({ success: false, error: ERROR_MESSAGES.INVALID_QUALITY });
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
        
        // Получаем метаданные для имени файла
        const metadata = await getVideoMetadata(videoId);
        
        // Получаем ссылку на файл
        const link = await getDownloadLink(videoId, format, quality);
        
        // Устанавливаем rate limit заголовки
        res.setHeader('X-RateLimit-Limit', String(rateLimit.limit));
        res.setHeader('X-RateLimit-Remaining', String(rateLimit.remaining));
        res.setHeader('X-RateLimit-Reset', String(Math.ceil(rateLimit.resetAt / 1000)));
        
        // РЕАЛЬНАЯ ЗАГРУЗКА — проксируем файл через сервер
        await proxyDownload(res, link, metadata, format, quality, ip);
        
    } catch (err) {
        console.error('[Download] Error:', err.message);
        
        let statusCode = 500;
        let errorMessage = err.message || ERROR_MESSAGES.DOWNLOAD_FAILED;
        
        if (err.message.includes('timeout')) statusCode = 504;
        else if (err.message.includes('not found') || err.message.includes('404')) statusCode = 404;
        else if (err.message.includes('API key')) statusCode = 503;
        else if (err.message.includes('size')) statusCode = 413;
        
        if (!res.headersSent) {
            res.status(statusCode).json({ 
                success: false,
                error: errorMessage 
            });
        }
    }
});

// GET /stream/:videoId/:format/:quality — то же что и download, но inline (для плеера)
router.get('/stream/:videoId/:format/:quality', async (req, res) => {
    try {
        const { videoId, format, quality } = req.params;
        
        if (!isValidVideoId(videoId) || !isValidFormat(format)) {
            return res.status(400).json({ success: false, error: 'Invalid parameters' });
        }
        
        const qualityType = (format === 'mp3' || format === 'm4a' || format === 'ogg') ? 'audio' : 'video';
        if (!isValidQuality(quality, qualityType)) {
            return res.status(400).json({ success: false, error: ERROR_MESSAGES.INVALID_QUALITY });
        }
        
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        const rateLimit = await checkRateLimit(ip);
        
        if (!rateLimit.allowed) {
            return res.status(429).json({ success: false, error: ERROR_MESSAGES.TOO_MANY_REQUESTS });
        }
        
        const metadata = await getVideoMetadata(videoId);
        const link = await getDownloadLink(videoId, format, quality);
        
        const mimeType = CONFIG.MIME_TYPES[format] || 'application/octet-stream';
        
        const fileResponse = await fetchWithTimeout(
            link.url,
            { method: 'GET' },
            CONFIG.DOWNLOAD_TIMEOUT
        );
        
        if (!fileResponse.ok) {
            throw new Error(`Upstream returned ${fileResponse.status}`);
        }
        
        // Inline — для воспроизведения в браузере
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(metadata.title)}.${format}"`);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        
        const contentLength = fileResponse.headers.get('content-length');
        if (contentLength) {
            res.setHeader('Content-Length', contentLength);
        }
        
        fileResponse.body.pipe(res);
        
    } catch (err) {
        console.error('[Stream] Error:', err.message);
        if (!res.headersSent) {
            res.status(502).json({ success: false, error: err.message });
        }
    }
});

// GET /health — проверка работоспособности
router.get('/health', async (req, res) => {
    let kvStatus = 'unknown';
    try {
        await kv.set('health:check', Date.now(), { px: 10000 });
        const val = await kv.get('health:check');
        kvStatus = val ? 'ok' : 'error';
    } catch (e) {
        kvStatus = 'error: ' + e.message;
    }
    
    res.json({
        success: true,
        data: {
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            services: {
                kv: kvStatus,
                cobaltApi: !!CONFIG.COBALT_API,
                cobaltApiKey: !!CONFIG.COBALT_API_KEY
            },
            config: {
                maxFileSize: CONFIG.MAX_FILE_SIZE,
                downloadTimeout: CONFIG.DOWNLOAD_TIMEOUT,
                rateLimitMax: CONFIG.RATE_LIMIT_MAX,
                rateLimitWindow: CONFIG.RATE_LIMIT_WINDOW
            }
        }
    });
});

// Error handling middleware
router.use((err, req, res, next) => {
    console.error('[Router] Unhandled error:', err);
    
    if (!res.headersSent) {
        res.status(500).json({ 
            success: false,
            error: ERROR_MESSAGES.SERVER_ERROR 
        });
    }
});

module.exports = router;