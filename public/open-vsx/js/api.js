// =========================================================
// api.js — работа с Open VSX REST API
// =========================================================

const BASE_URL = 'https://open-vsx.org';
const SEARCH_ENDPOINT = `${BASE_URL}/api/-/search`;

// In-memory кэш для повторных запросов
const extensionCache = new Map();
const readmeCache = new Map();

const requestJson = async (url) => {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} для ${url}`);
    }
    return response.json();
};

const requestText = async (url) => {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} для ${url}`);
    }
    return response.text();
};

export async function searchExtensions(query, size = 20) {
    const encodedQuery = encodeURIComponent(query || '');
    const url = `${SEARCH_ENDPOINT}?query=${encodedQuery}&size=${size}`;
    const data = await requestJson(url);

    const extensions = Array.isArray(data?.extensions) ? data.extensions : [];
    return {
        extensions,
        totalSize: typeof data?.totalSize === 'number' ? data.totalSize : extensions.length,
    };
}

/**
 * Получение популярных расширений (сортировка по количеству скачиваний).
 */
export async function getTopExtensions(size = 12) {
    // Пустой query + сортировка по downloadCount дает список самых популярных
    const url = `${SEARCH_ENDPOINT}?query=&size=${size}&sortBy=downloadCount&sortOrder=desc`;
    try {
        const data = await requestJson(url);
        return Array.isArray(data?.extensions) ? data.extensions : [];
    } catch (error) {
        console.warn('Не удалось загрузить популярные расширения по сортировке, используем fallback:', error);
        // Fallback: обычный поиск без сортировки, если параметр sortBy вдруг изменится в API
        const fallbackUrl = `${SEARCH_ENDPOINT}?query=&size=${size}`;
        const fallbackData = await requestJson(fallbackUrl);
        return Array.isArray(fallbackData?.extensions) ? fallbackData.extensions : [];
    }
}

export async function getExtension(namespace, name) {
    const key = `${namespace}/${name}`;
    if (extensionCache.has(key)) {
        return extensionCache.get(key);
    }
    const url = `${BASE_URL}/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
    const data = await requestJson(url);
    extensionCache.set(key, data);
    return data;
}

export async function getReadme(readmeUrl) {
    if (!readmeUrl) {
        throw new Error('README URL не указан');
    }
    if (readmeCache.has(readmeUrl)) {
        return readmeCache.get(readmeUrl);
    }
    const text = await requestText(readmeUrl);
    readmeCache.set(readmeUrl, text);
    return text;
}

export function clearCache() {
    extensionCache.clear();
    readmeCache.clear();
}