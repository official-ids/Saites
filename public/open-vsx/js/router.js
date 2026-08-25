// =========================================================
// router.js — клиентский SPA-роутер на History API
// =========================================================

import { resolveRoute } from './utils.js';

/**
 * Переход по внутреннему пути без перезагрузки страницы.
 */
export function navigate(path, { replace = false } = {}) {
    const target = path || '/';
    if (replace) {
        history.replaceState({ path: target }, '', target);
    } else {
        history.pushState({ path: target }, '', target);
    }
    // Диспатчим событие, чтобы app.js отреагировал
    window.dispatchEvent(new CustomEvent('app:navigate', { detail: { path: target } }));
}

/**
 * Перехватываем клики по ссылкам с атрибутом data-link,
 * чтобы не давать браузеру выполнять полную перезагрузку.
 */
export function interceptLinks(root = document) {
    root.addEventListener('click', (event) => {
        const target = event.target.closest('a[data-link]');
        if (!target) return;

        // Игнорируем модификаторы (Ctrl/Shift/средняя кнопка)
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
            return;
        }

        const href = target.getAttribute('href');
        if (!href) return;

        // Только внутренние ссылки
        try {
            const url = new URL(href, window.location.origin);
            if (url.origin !== window.location.origin) return;
            event.preventDefault();
            navigate(url.pathname + url.search);
        } catch {
            return;
        }
    });
}

/**
 * Возвращает текущий разобранный маршрут.
 */
export function getCurrentRoute() {
    return resolveRoute(window.location.pathname, window.location.search);
}

/**
 * Инициализирует обработку popstate (кнопки Back/Forward).
 */
export function initRouter() {
    window.addEventListener('popstate', () => {
        window.dispatchEvent(new CustomEvent('app:navigate', {
            detail: { path: window.location.pathname + window.location.search },
        }));
    });
}