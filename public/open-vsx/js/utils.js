// =========================================================
// utils.js — вспомогательные функции
// =========================================================

/**
 * Безопасно возвращает строковое значение.
 * Если значение отсутствует или не является строкой, возвращает fallback.
 */
export const safeString = (value, fallback = '') => {
    if (value === null || value === undefined) return fallback;
    const str = String(value).trim();
    return str.length > 0 ? str : fallback;
};

/**
 * Экранирование HTML-сущностей для безопасной вставки в текст.
 */
export const escapeHtml = (str) => {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

/**
 * Возвращает первую букву названия для fallback-иконки.
 */
export const getInitial = (name) => {
    const safe = safeString(name, '?');
    const ch = safe.charAt(0).toUpperCase();
    return /^[A-ZА-ЯЁ0-9]$/i.test(ch) ? ch : '#';
};

/**
 * Детерминированный цвет для fallback-иконки по строке.
 */
export const colorFromString = (str) => {
    const s = safeString(str, 'x');
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
        hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    }
    // Приглушённые оттенки, гармонирующие с темной темой
    const palette = [
        '#2d5f8a', '#6a4b8a', '#3a7d5c',
        '#8a5a2d', '#8a2d5f', '#2d7d7d',
        '#4a6a8a', '#7d5a3a'
    ];
    return palette[hash % palette.length];
};

/**
 * Получает URL иконки расширения из различных возможных полей API.
 */
export const getIconUrl = (extension) => {
    if (!extension) return null;
    if (typeof extension.icon === 'string' && extension.icon) return extension.icon;
    if (extension.files && typeof extension.files.icon === 'string') {
        return extension.files.icon;
    }
    return null;
};

/**
 * Получает URL скачивания .vsix.
 */
export const getDownloadUrl = (extension) => {
    if (!extension) return null;
    if (typeof extension.downloadUrl === 'string' && extension.downloadUrl) {
        return extension.downloadUrl;
    }
    if (extension.files && typeof extension.files.download === 'string') {
        return extension.files.download;
    }
    return null;
};

/**
 * Получает URL README.
 */
export const getReadmeUrl = (extension) => {
    if (!extension) return null;
    if (typeof extension.readmeUrl === 'string' && extension.readmeUrl) {
        return extension.readmeUrl;
    }
    if (extension.files && typeof extension.files.readme === 'string') {
        return extension.files.readme;
    }
    return null;
};

/**
 * Формирует путь к странице расширения.
 */
export const buildExtensionPath = (namespace, name) => {
    const ns = safeString(namespace, 'unknown');
    const n = safeString(name, 'unknown');
    return `/extension/${encodeURIComponent(ns)}/${encodeURIComponent(n)}`;
};

/**
 * Формирует путь поиска с query-параметром.
 */
export const buildSearchPath = (query) => {
    const q = safeString(query, '');
    if (!q) return '/';
    return `/search?q=${encodeURIComponent(q)}`;
};

/**
 * Извлекает query-параметр q из URL.
 */
export const getQueryFromUrl = (url = window.location.href) => {
    try {
        const u = new URL(url, window.location.origin);
        return u.searchParams.get('q') || '';
    } catch {
        return '';
    }
};

/**
 * Парсит путь /extension/:namespace/:name.
 * Возвращает { namespace, name } или null.
 */
export const parseExtensionPath = (pathname) => {
    const match = /^\/extension\/([^/]+)\/([^/]+)\/?$/.exec(pathname || '');
    if (!match) return null;
    try {
        return {
            namespace: decodeURIComponent(match[1]),
            name: decodeURIComponent(match[2]),
        };
    } catch {
        return null;
    }
};

/**
 * Определяет тип текущего маршрута.
 */
export const resolveRoute = (pathname, search) => {
    const p = pathname || '/';
    if (p === '/' || p === '') {
        const q = getQueryFromUrl(window.location.origin + p + (search || ''));
        return { route: 'home', query: q };
    }
    if (p === '/search') {
        const q = getQueryFromUrl(window.location.origin + p + (search || ''));
        return { route: 'search', query: q };
    }
    const ext = parseExtensionPath(p);
    if (ext) {
        return { route: 'extension', ...ext };
    }
    // Fallback: 404 не делаем, возвращаем на главную
    return { route: 'home', query: '' };
};

/**
 * Простая задержка (для skeleton-эффектов).
 */
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));