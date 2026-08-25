// =========================================================
// app.js — точка входа приложения
// =========================================================

import { searchExtensions, getExtension, getReadme, getTopExtensions } from 'https://oris-flax.vercel.app/open-vsx/js/api.js';
import { navigate, interceptLinks, initRouter, getCurrentRoute } from 'https://oris-flax.vercel.app/open-vsx/js/router.js';
import {
    buildSearchPath,
    safeString,
    resolveRoute,
} from 'https://oris-flax.vercel.app/open-vsx/js/utils.js';
import {
    renderHome,
    renderSearchPage,
    renderSearchLoading,
    renderSearchResults,
    renderSearchError,
    renderExtensionPage,
    renderExtensionLoading,
    renderExtensionError,
    renderExtensionCard,
    syncHeaderSearch,
    setReadmeHtml,
    setReadmeError,
} from 'https://oris-flax.vercel.app/open-vsx/js/components.js';
import { renderMarkdown } from 'https://oris-flax.vercel.app/open-vsx/js/markdown.js';

// =========================================================
// Централизованное состояние приложения
// =========================================================
const state = {
    currentPage: 'home',   // 'home' | 'search' | 'extension'
    searchQuery: '',
    searchResults: [],
    searchTotal: 0,
    searchLoading: false,
    searchError: null,
    selectedExtension: null,
    extensionLoading: false,
    extensionError: null,
};

// =========================================================
// Инициализация
// =========================================================
document.addEventListener('DOMContentLoaded', () => {
    initRouter();
    interceptLinks(document);

    bindHeaderSearch();
    bindGlobalClicks();

    // Слушаем внутренние навигационные события
    window.addEventListener('app:navigate', () => handleRoute());

    // Первоначальный рендер
    handleRoute();
});

// =========================================================
// Обработчики UI
// =========================================================

function bindHeaderSearch() {
    const input = document.getElementById('header-search-input');
    const btn = document.getElementById('header-search-btn');
    if (!input || !btn) return;

    const submit = () => {
        const q = safeString(input.value, '');
        if (!q) {
            navigate('/');
            return;
        }
        navigate(buildSearchPath(q));
    };

    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            submit();
        }
    });

    btn.addEventListener('click', submit);
}

/**
 * Глобальный делегированный обработчик кликов.
 * Перехватывает клики по карточкам расширений и внешним ссылкам.
 */
function bindGlobalClicks() {
    document.addEventListener('click', (event) => {
        // Клик по карточке расширения — переход на страницу
        const card = event.target.closest('.ext-card');
        if (card) {
            // Если клик был по кнопке/ссылке внутри карточки — не перехватываем
            if (event.target.closest('a, button')) return;
            const path = card.dataset.extPath;
            if (path) {
                event.preventDefault();
                navigate(path);
            }
            return;
        }

        // Enter на карточке (keyboard)
        if (event.target.classList?.contains('ext-card') && (event.key === 'Enter' || event.key === ' ')) {
            const path = event.target.dataset.extPath;
            if (path) {
                event.preventDefault();
                navigate(path);
            }
        }
    });

    // Обработка Enter/Space на карточках
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const card = event.target.closest('.ext-card');
        if (card && event.target === card) {
            event.preventDefault();
            const path = card.dataset.extPath;
            if (path) navigate(path);
        }
    });
}

// =========================================================
// Маршрутизация и рендер
// =========================================================

async function handleRoute() {
    const route = getCurrentRoute();

    syncHeaderSearch(route.query || '');

    switch (route.route) {
        case 'home':
            state.currentPage = 'home';
            state.searchQuery = route.query || '';
            
            if (state.searchQuery) {
                renderHome({ query: state.searchQuery });
                bindHeroSearch();
                await performSearch(state.searchQuery);
            } else {
                // 1. Сначала рендерим главную со скелетоном для топ-расширений
                renderHome({ query: '' });
                bindHeroSearch();

                // 2. Асинхронно загружаем популярные расширения
                try {
                    const topExtensions = await getTopExtensions(12);
                    // 3. Перерисовываем блок с реальными данными
                    renderHome({ query: '', topExtensions });
                } catch (error) {
                    console.error('Ошибка загрузки популярных расширений:', error);
                    // Тихо игнорируем ошибку, скелетон просто исчезнет, 
                    // пользователь все еще может пользоваться поиском.
                    renderHome({ query: '', topExtensions: [] });
                }
            }
            break;

        case 'search':
            state.currentPage = 'search';
            state.searchQuery = route.query || '';
            renderSearchPage({ query: state.searchQuery });
            if (state.searchQuery) {
                await performSearch(state.searchQuery);
            } else {
                // Пустой запрос — показываем подсказку
                const container = document.getElementById('search-results');
                if (container) {
                    container.innerHTML = `
                        <div class="state-block">
                            <h3 class="state-title">Введите запрос для поиска</h3>
                            <p class="state-text">
                                Используйте поисковую строку выше, чтобы найти нужное расширение.
                            </p>
                        </div>
                    `;
                }
            }
            break;

        case 'extension':
            state.currentPage = 'extension';
            renderExtensionLoading();
            await loadExtensionPage(route.namespace, route.name);
            break;

        default:
            navigate('/', { replace: true });
    }

    // Прокрутка вверх при смене страницы
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

/**
 * Привязывает обработчики к поисковой форме на главной.
 */
function bindHeroSearch() {
    const form = document.getElementById('hero-search-form');
    const input = document.getElementById('hero-search-input');
    if (!form || !input) return;

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        const q = safeString(input.value, '');
        if (!q) return;
        navigate(buildSearchPath(q));
    });
}

// =========================================================
// Поиск
// =========================================================

async function performSearch(query) {
    const q = safeString(query, '');
    state.searchQuery = q;
    state.searchLoading = true;
    state.searchError = null;

    renderSearchLoading();

    try {
        const { extensions, totalSize } = await searchExtensions(q, 20);
        state.searchResults = extensions;
        state.searchTotal = totalSize;
        state.searchLoading = false;
        renderSearchResults({ extensions, totalSize, query: q });
    } catch (error) {
        console.error('Ошибка поиска:', error);
        state.searchLoading = false;
        state.searchError = error?.message || 'Не удалось загрузить результаты';
        renderSearchError({
            message: state.searchError,
            onRetry: () => performSearch(q),
        });
    }
}

// =========================================================
// Страница расширения
// =========================================================

async function loadExtensionPage(namespace, name) {
    state.extensionLoading = true;
    state.extensionError = null;
    state.selectedExtension = null;

    try {
        const extension = await getExtension(namespace, name);
        state.selectedExtension = extension;
        state.extensionLoading = false;
        renderExtensionPage(extension);

        // Параллельно грузим README — не блокируем рендер страницы
        loadReadmeFor(extension);
    } catch (error) {
        console.error('Ошибка загрузки расширения:', error);
        state.extensionLoading = false;
        state.extensionError = error?.message || 'Не удалось загрузить расширение';
        renderExtensionError({
            message: state.extensionError,
            onBack: () => navigate('/'),
        });
    }
}

async function loadReadmeFor(extension) {
    // Импортируем утилиту для получения readmeUrl
    const { getReadmeUrl } = await import('./utils.js');
    const readmeUrl = getReadmeUrl(extension);
    if (!readmeUrl) {
        setReadmeHtml('');
        return;
    }
    try {
        const markdown = await getReadme(readmeUrl);
        // Определяем формат: если похоже на HTML — используем как есть (после санитизации),
        // иначе рендерим Markdown.
        const looksLikeHtml = /^\s*<[a-z][\s\S]*>/i.test(markdown || '');
        let html;
        if (looksLikeHtml) {
            html = window.DOMPurify
                ? window.DOMPurify.sanitize(markdown, { ADD_ATTR: ['target', 'rel', 'loading'] })
                : markdown;
        } else {
            html = renderMarkdown(markdown || '');
        }
        setReadmeHtml(html);
    } catch (error) {
        console.error('Ошибка загрузки README:', error);
        setReadmeError('Не удалось загрузить README');
    }
}