const { put } = require('@vercel/blob');
const crypto = require('crypto');
const { kv } = require('@vercel/kv');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Проверка токена
    const authHeader = req.headers.authorization;
    const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
    
    if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== ADMIN_TOKEN) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    try {
        // Получаем файл из multipart/form-data
        const busboy = require('busboy');
        const bb = busboy({ headers: req.headers, limits: { fileSize: 100 * 1024 * 1024 } });
        
        let fileBuffer = null;
        let fileName = null;
        let contentType = null;

        await new Promise((resolve, reject) => {
            bb.on('file', (name, file, info) => {
                fileName = info.filename;
                contentType = info.mimeType;
                const chunks = [];
                
                file.on('data', (data) => {
                    chunks.push(data);
                });
                
                file.on('end', () => {
                    fileBuffer = Buffer.concat(chunks);
                });
            });
            
            bb.on('finish', resolve);
            bb.on('error', reject);
            
            req.pipe(bb);
        });

        if (!fileBuffer) {
            return res.status(400).json({ error: 'No file provided' });
        }

        // Вычисляем SHA-256
        const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

        // Проверяем, существует ли файл
        const existing = await kv.hgetall(`download:sha256:${hash}`);
        if (existing && existing.hash) {
            return res.json({
                existed: true,
                hash,
                url: `/downloader/${hash}`,
                name: existing.name,
                size: parseInt(existing.size, 10),
                sizeFormatted: formatSize(parseInt(existing.size, 10))
            });
        }

        // Загружаем в Blob
        const ext = (fileName.match(/\.[a-z0-9]+$/i) || ['.bin'])[0];
        const blobPath = `downloads/${hash}${ext}`;
        
        const blob = await put(blobPath, fileBuffer, {
            access: 'public',
            addRandomSuffix: false,
            contentType: contentType
        });

        // Сохраняем метаданные в KV
        const meta = {
            hash,
            url: blob.url,
            name: fileName,
            size: String(fileBuffer.length),
            contentType: contentType,
            uploadedAt: new Date().toISOString(),
            downloads: '0'
        };

        await kv.hset(`download:sha256:${hash}`, meta);
        await kv.sadd('download:files:index', hash);

        res.json({
            existed: false,
            hash,
            url: `/downloader/${hash}`,
            name: meta.name,
            size: fileBuffer.length,
            sizeFormatted: formatSize(fileBuffer.length)
        });

    } catch (err) {
        console.error('[downloader-upload]', err);
        res.status(500).json({ error: err.message });
    }
};

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}