const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Раздаем статический HTML-файл (если он лежит в той же папке)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

/**
 * Проверка цепочки редиректов
 */
app.post('/check-redirect', async (req, res) => {
    try {
        let { url } = req.body;

        if (!url || typeof url !== 'string') {
            return res.status(400).json({ error: 'Необходимо указать корректный URL' });
        }

        // Добавляем протокол, если он отсутствует
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }

        // Базовая валидация URL
        let parsedUrl;
        try {
            parsedUrl = new URL(url);
        } catch {
            return res.status(400).json({ error: 'Некорректный формат URL' });
        }

        const chain = [];
        let currentUrl = parsedUrl.href;
        const maxRedirects = 10; // Защита от бесконечных циклов

        for (let i = 0; i < maxRedirects; i++) {
            const startTime = Date.now();
            
            try {
                // redirect: 'manual' критически важен для отслеживания цепочки
                const response = await fetch(currentUrl, {
                    method: 'GET',
                    redirect: 'manual',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                });
                
                const endTime = Date.now();
                const duration = endTime - startTime;
                const location = response.headers.get('location');

                chain.push({
                    url: currentUrl,
                    status: response.status,
                    statusText: response.statusText,
                    location: location,
                    time: duration
                });

                // Если это редирект и есть заголовок Location, продолжаем цепочку
                if (response.status >= 300 && response.status < 400 && location) {
                    // new URL корректно обрабатывает относительные пути редиректа
                    currentUrl = new URL(location, currentUrl).href;
                } else {
                    // Цепочка завершена (200 OK, 404, 500 и т.д.)
                    break;
                }
            } catch (error) {
                chain.push({
                    url: currentUrl,
                    status: 0,
                    statusText: error.message || 'Network Error',
                    location: null,
                    time: Date.now() - startTime
                });
                break;
            }
        }

        res.json({ chain });

    } catch (error) {
        console.error('[check-redirect]', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера при проверке URL' });
    }
});

app.listen(PORT, () => {
    console.log(`Сервер запущен: http://localhost:${PORT}`);
});