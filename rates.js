// rates.js
const express = require('express');
const { kv } = require('@vercel/kv');
const router = express.Router();

// ============================================
// Конфигурация
// ============================================
/**
 * Конфигурация сервиса курсов валют
 * @namespace
 */
const CONFIG = {
    /** @type {string} URL для получения курсов с ЦБ РФ */
    CBR_URL: 'https://www.cbr.ru/scripts/XML_daily.asp',
    /** @type {number} TTL кэша курсов в KV (4 часа в секундах, ЦБ обновляет раз в день) */
    CACHE_TTL: 60 * 60 * 4,
    /** @type {number} Таймаут запроса к ЦБ РФ (мс) */
    REQUEST_TIMEOUT: 10000,
    /** @type {number} Максимальный возраст данных в кэше (24 часа в мс) — после этого принудительно обновляем */
    MAX_CACHE_AGE: 60 * 60 * 24 * 1000
};

/**
 * Ключи для Vercel KV
 * @namespace
 */
const K = {
    /** @type {string} Ключ для кэша курсов */
    RATES: 'rates:current',
    /** @type {string} Ключ для timestamp последнего обновления */
    RATES_UPDATED_AT: 'rates:updated_at',
    /** @type {string} Ключ для даты, на которую актуальны курсы */
    RATES_DATE: 'rates:date'
};

/**
 * Сообщения об ошибках
 * @constant {Object<string, string>}
 */
const ERROR_MESSAGES = {
    FETCH_FAILED: 'Не удалось получить курсы валют с ЦБ РФ',
    PARSE_FAILED: 'Ошибка парсинга данных курсов',
    TIMEOUT: 'Превышено время ожидания ответа от ЦБ РФ',
    LOAD_ERROR: 'Ошибка загрузки курсов',
    NOT_AVAILABLE: 'Курсы валют временно недоступны'
};

// ============================================
// Утилиты: Парсинг XML
// ============================================
/**
 * Парсинг XML ответа ЦБ РФ в объект курсов валют
 * Формат XML: https://www.cbr.ru/scripts/XML_daily.asp
 * 
 * @param {string} xmlText - XML текст ответа
 * @returns {{ rates: Object, date: string }} Объект с курсами и датой
 * @throws {Error} Если XML некорректен
 * 
 * @example
 * const { rates, date } = parseCbrXml(xmlText);
 * // rates = { USD: { charCode: 'USD', name: 'Доллар США', nominal: 1, value: 92.5 }, ... }
 * // date = '14.07.2026'
 */
function parseCbrXml(xmlText) {
    if (!xmlText || typeof xmlText !== 'string') {
        throw new Error(ERROR_MESSAGES.PARSE_FAILED);
    }

    const rates = {};

    // Извлекаем дату из корневого элемента <ValCurs Date="14.07.2026"...>
    const dateMatch = xmlText.match(/<ValCurs[^>]*Date="([^"]+)"/);
    const date = dateMatch ? dateMatch[1] : new Date().toLocaleDateString('ru-RU');

    // Регулярное выражение для извлечения данных каждой валюты
    const valuteRegex = /<Valute[^>]*>([\s\S]*?)<\/Valute>/g;
    let match;

    while ((match = valuteRegex.exec(xmlText)) !== null) {
        const block = match[1];

        // Извлекаем поля из блока
        const charCode = extractTag(block, 'CharCode');
        const nominal = extractTag(block, 'Nominal');
        const name = extractTag(block, 'Name');
        const value = extractTag(block, 'Value');

        if (!charCode || !value) continue;

        // В XML ЦБ РФ десятичный разделитель — запятая
        const nominalNum = parseFloat(String(nominal).replace(',', '.'));
        const valueNum = parseFloat(String(value).replace(',', '.'));

        if (isNaN(nominalNum) || isNaN(valueNum) || nominalNum === 0) continue;

        // Курс за 1 единицу валюты в рублях
        const rate = valueNum / nominalNum;

        rates[charCode] = {
            charCode,
            name: name || charCode,
            nominal: nominalNum,
            value: valueNum,
            rate
        };
    }

    // Добавляем российский рубль как базовую валюту
    rates['RUB'] = {
        charCode: 'RUB',
        name: 'Российский рубль',
        nominal: 1,
        value: 1,
        rate: 1
    };

    if (Object.keys(rates).length <= 1) {
        throw new Error(ERROR_MESSAGES.PARSE_FAILED);
    }

    return { rates, date };
}

/**
 * Извлечение значения XML-тега из блока
 * @param {string} block - XML блок
 * @param {string} tagName - Имя тега
 * @returns {string|null} Значение тега или null
 */
function extractTag(block, tagName) {
    const regex = new RegExp(`<${tagName}>([^<]*)</${tagName}>`);
    const m = block.match(regex);
    return m ? m[1].trim() : null;
}

// ============================================
// Утилиты: Получение курсов с кэшированием
// ============================================
/**
 * Получение курсов валют с учётом кэша в KV
 * Если кэш свежий — возвращает из него, иначе запрашивает с ЦБ РФ
 * 
 * @returns {Promise<{ rates: Object, date: string, cached: boolean }>}
 */
async function getRatesWithCache() {
    // Пробуем получить из кэша
    try {
        const [cachedRates, cachedUpdatedAt, cachedDate] = await kv.mget(
            K.RATES,
            K.RATES_UPDATED_AT,
            K.RATES_DATE
        );

        if (cachedRates && cachedUpdatedAt) {
            const age = Date.now() - Number(cachedUpdatedAt);
            if (age < CONFIG.MAX_CACHE_AGE) {
                return { rates: cachedRates, date: cachedDate || '', cached: true };
            }
        }
    } catch (error) {
        console.error('[rates] Cache read error:', error.message);
        // Игнорируем ошибки кэша, идём за свежими данными
    }

    // Запрашиваем свежие данные с ЦБ РФ
    const freshData = await fetchFromCbr();

    // Сохраняем в кэш
    try {
        await kv.set(K.RATES, freshData.rates, { ex: CONFIG.CACHE_TTL });
        await kv.set(K.RATES_UPDATED_AT, Date.now(), { ex: CONFIG.CACHE_TTL });
        await kv.set(K.RATES_DATE, freshData.date, { ex: CONFIG.CACHE_TTL });
    } catch (error) {
        console.error('[rates] Cache write error:', error.message);
    }

    return { rates: freshData.rates, date: freshData.date, cached: false };
}

/**
 * Прямой запрос к ЦБ РФ и парсинг ответа
 * @returns {Promise<{ rates: Object, date: string }>}
 * @throws {Error} Если запрос не удался
 */
async function fetchFromCbr() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);

    try {
        const response = await fetch(CONFIG.CBR_URL, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; RatesBot/1.0)',
                'Accept': 'application/xml, text/xml'
            }
        });

        if (!response.ok) {
            throw new Error(`${ERROR_MESSAGES.FETCH_FAILED}: HTTP ${response.status}`);
        }

        const xmlText = await response.text();
        return parseCbrXml(xmlText);
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(ERROR_MESSAGES.TIMEOUT);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

// ============================================
// Маршруты
// ============================================
/**
 * GET /rates — получение актуальных курсов валют
 * Возвращает все курсы с сайта ЦБ РФ
 * 
 * Response:
 * {
 *   "rates": { "USD": {...}, "EUR": {...}, ... },
 *   "date": "14.07.2026",
 *   "cached": true,
 *   "updatedAt": "2026-07-14T12:00:00.000Z"
 * }
 */
router.get('/rates', async (req, res) => {
    try {
        const data = await getRatesWithCache();

        // Получаем timestamp последнего обновления для клиента
        let updatedAt = null;
        try {
            const ts = await kv.get(K.RATES_UPDATED_AT);
            if (ts) updatedAt = new Date(Number(ts)).toISOString();
        } catch (e) {
            // ignore
        }

        // Кэшируем ответ в браузере/CDN на 1 час
        res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');

        res.json({
            rates: data.rates,
            date: data.date,
            cached: data.cached,
            updatedAt
        });
    } catch (error) {
        console.error('[rates] GET /rates error:', error.message);

        // Если свежий запрос не удался — пытаемся отдать устаревший кэш
        try {
            const fallbackRates = await kv.get(K.RATES);
            if (fallbackRates) {
                console.warn('[rates] Serving stale cache after fetch error');
                return res.status(200).json({
                    rates: fallbackRates,
                    date: null,
                    cached: true,
                    stale: true
                });
            }
        } catch (e) {
            // ignore
        }

        res.status(503).json({ error: ERROR_MESSAGES.NOT_AVAILABLE });
    }
});

/**
 * GET /rates/convert — конвертация валюты
 * Query params:
 *   - from: код исходной валюты (например, USD)
 *   - to: код целевой валюты (например, RUB)
 *   - amount: сумма (например, 100 или 100.34)
 * 
 * Response:
 * {
 *   "result": 9250.00,
 *   "rate": 92.5,
 *   "from": "USD",
 *   "to": "RUB",
 *   "amount": 100,
 *   "date": "14.07.2026"
 * }
 */
router.get('/rates/convert', async (req, res) => {
    try {
        const { from, to, amount } = req.query;

        // Валидация параметров
        if (!from || typeof from !== 'string') {
            return res.status(400).json({ error: 'Не указана исходная валюта (from)' });
        }
        if (!to || typeof to !== 'string') {
            return res.status(400).json({ error: 'Не указана целевая валюта (to)' });
        }
        if (amount === undefined || amount === null || amount === '') {
            return res.status(400).json({ error: 'Не указана сумма (amount)' });
        }

        const amountNum = parseFloat(String(amount).replace(',', '.'));
        if (isNaN(amountNum) || amountNum < 0) {
            return res.status(400).json({ error: 'Некорректная сумма' });
        }

        const fromCode = from.trim().toUpperCase();
        const toCode = to.trim().toUpperCase();

        // Получаем курсы
        const data = await getRatesWithCache();

        const fromCurrency = data.rates[fromCode];
        const toCurrency = data.rates[toCode];

        if (!fromCurrency) {
            return res.status(404).json({ error: `Валюта ${fromCode} не найдена` });
        }
        if (!toCurrency) {
            return res.status(404).json({ error: `Валюта ${toCode} не найдена` });
        }

        // Конвертация: amount в from → рубли → to
        // rate — это курс за 1 единицу валюты в рублях
        const amountInRub = amountNum * fromCurrency.rate;
        const result = amountInRub / toCurrency.rate;

        // Курс для отображения: сколько единиц to за 1 единицу from
        const displayRate = toCurrency.rate / fromCurrency.rate;

        res.json({
            result: Math.round(result * 100) / 100,
            rate: displayRate,
            from: fromCode,
            to: toCode,
            amount: amountNum,
            date: data.date
        });
    } catch (error) {
        console.error('[rates] GET /rates/convert error:', error.message);
        res.status(500).json({ error: ERROR_MESSAGES.LOAD_ERROR });
    }
});

/**
 * POST /rates/refresh — принудительное обновление кэша (для админа)
 * Требует заголовок Authorization: Bearer <ADMIN_TOKEN>
 */
router.post('/rates/refresh', async (req, res) => {
    try {
        // Проверка прав администратора
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Требуется авторизация' });
        }

        const token = authHeader.split(' ')[1];
        const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

        if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
            return res.status(403).json({ error: 'Требуются права администратора' });
        }

        // Удаляем кэш и запрашиваем заново
        await kv.del(K.RATES);
        await kv.del(K.RATES_UPDATED_AT);
        await kv.del(K.RATES_DATE);

        const freshData = await fetchFromCbr();

        await kv.set(K.RATES, freshData.rates, { ex: CONFIG.CACHE_TTL });
        await kv.set(K.RATES_UPDATED_AT, Date.now(), { ex: CONFIG.CACHE_TTL });
        await kv.set(K.RATES_DATE, freshData.date, { ex: CONFIG.CACHE_TTL });

        res.json({
            success: true,
            date: freshData.date,
            currenciesCount: Object.keys(freshData.rates).length
        });
    } catch (error) {
        console.error('[rates] POST /rates/refresh error:', error.message);
        res.status(500).json({ error: ERROR_MESSAGES.FETCH_FAILED });
    }
});

// ============================================
// Экспорт роутера
// ============================================
module.exports = router;