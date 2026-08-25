// =========================================================
// components.js — UI-компоненты приложения
// =========================================================

import {
    safeString,
    escapeHtml,
    getInitial,
    colorFromString,
    getIconUrl,
    getDownloadUrl,
    buildExtensionPath,
} from './utils.js';
import { renderMarkdown } from './markdown.js';

const appRoot = document.getElementById('app');

/**
 * Устанавливает HTML главного контейнера.
 */
const setRoot = (html) => {
    appRoot.innerHTML = html;
};

/**
 * Обновляет поисковый input в header.
 */
export const syncHeaderSearch = (query) => {
    const input = document.getElementById('header-search-input');
    if (input && document.activeElement !== input) {
        input.value = safeString(query, '');
    }
};

/**
 * Рендерит иконку расширения (с fallback).
 */
const renderIcon = (extension, size = 48) => {
    const url = getIconUrl(extension);
    const name = safeString(extension?.displayName || extension?.name, '?');
    const initial = getInitial(name);
    const color = colorFromString(safeString(extension?.namespace, '') + '/' + name);

    if (url) {
        return `
            <div class="ext-icon" style="width:${size}px;height:${size}px;">
                <img src="${escapeHtml(url)}" alt="" loading="lazy"
                     onerror="this.parentNode.classList.add('ext-icon--fallback');this.replaceWith(document.createTextNode('${escapeHtml(initial)}'));">
            </div>
        `;
    }
    return `
        <div class="ext-icon ext-icon--fallback" style="width:${size}px;height:${size}px;background:linear-gradient(135deg, ${color} 0%, #1a1a1a 100%);">
            ${escapeHtml(initial)}
        </div>
    `;
};

/**
 * Обёртка для результатов поиска (без самих карточек).
 */
const renderSearchResultsShell = (query) => `
    <div class="search-header">
        <h2 class="search-title">Результаты по запросу: <span class="query">${escapeHtml(query)}</span></h2>
        <span class="search-count" id="search-count"></span>
    </div>
    <div id="search-results" aria-live="polite"></div>
`;

/**
 * Рендерит главную страницу.
 * @param {Object} params
 * @param {string} params.query — текущий поисковый запрос (если есть)
 * @param {Array|null} params.topExtensions — массив популярных расширений или null (состояние загрузки)
 */
export function renderHome({ query = '', topExtensions = null } = {}) {
    const safeQuery = escapeHtml(safeString(query, ''));
    
    let topSection = '';
    
    if (topExtensions && topExtensions.length > 0) {
        const cards = topExtensions.map(renderExtensionCard).join('');
        topSection = `
            <section class="container" style="padding-top: 48px;" aria-labelledby="top-extensions-title">
                <h2 class="section-title" id="top-extensions-title">Популярные расширения</h2>
                <div class="extensions-grid">
                    ${cards}
                </div>
            </section>
        `;
    } else if (topExtensions === null && !safeQuery) {
        // Показываем скелетон, пока данные грузятся (только если это чистая главная)
        topSection = `
            <section class="container" style="padding-top: 48px;" aria-labelledby="top-extensions-title">
                <h2 class="section-title" id="top-extensions-title">Популярные расширения</h2>
                <div class="skeleton-grid">
                    ${Array.from({ length: 6 }, () => `
                        <article class="skeleton-card" aria-hidden="true">
                            <div class="skeleton-head">
                                <div class="skeleton-icon"></div>
                                <div class="skeleton-head-lines">
                                    <div class="skeleton-line skeleton-line--title"></div>
                                    <div class="skeleton-line skeleton-line--subtitle"></div>
                                </div>
                            </div>
                            <div class="skeleton-line skeleton-line--text"></div>
                            <div class="skeleton-line skeleton-line--text-short"></div>
                            <div class="skeleton-line skeleton-line--btn"></div>
                        </article>
                    `).join('')}
                </div>
            </section>
        `;
    }

    setRoot(`
        <section class="hero" aria-labelledby="hero-title">
            <div class="container">
                <h1 class="hero-title" id="hero-title">Маркетплейс расширений Open VSX</h1>
                <p class="hero-subtitle">
                    Поиск, просмотр и скачивание расширений для редакторов кода.
                    Используйте реальный реестр Open VSX.
                </p>
                <form class="hero-search" role="search" id="hero-search-form" aria-label="Поиск расширений">
                    <label for="hero-search-input" class="sr-only">Поисковый запрос</label>
                    <input
                        type="search"
                        id="hero-search-input"
                        class="hero-search-input"
                        placeholder="Например: python, java, themes..."
                        value="${safeQuery}"
                        autocomplete="off"
                        spellcheck="false"
                    >
                    <button type="submit" class="hero-search-btn">Поиск</button>
                </form>
                <div class="hero-tags" aria-label="Популярные запросы">
                    <a href="/search?q=python" class="hero-tag" data-link>python</a>
                    <a href="/search?q=java" class="hero-tag" data-link>java</a>
                    <a href="/search?q=themes" class="hero-tag" data-link>themes</a>
                    <a href="/search?q=typescript" class="hero-tag" data-link>typescript</a>
                    <a href="/search?q=eslint" class="hero-tag" data-link>eslint</a>
                    <a href="/search?q=docker" class="hero-tag" data-link>docker</a>
                </div>
            </div>
        </section>
        ${topSection}
        ${safeQuery ? `<section class="container" style="padding-top:32px;">${renderSearchResultsShell(safeQuery)}</section>` : ''}
    `);
}

// =========================================================
// Результаты поиска
// =========================================================

export function renderSearchPage({ query = '' } = {}) {
    setRoot(`
        <section class="container">
            ${renderSearchResultsShell(query)}
        </section>
    `);
}

export function renderSearchLoading() {
    const container = document.getElementById('search-results');
    if (!container) return;
    const skeletons = Array.from({ length: 9 }, () => `
        <article class="skeleton-card" aria-hidden="true">
            <div class="skeleton-head">
                <div class="skeleton-icon"></div>
                <div class="skeleton-head-lines">
                    <div class="skeleton-line skeleton-line--title"></div>
                    <div class="skeleton-line skeleton-line--subtitle"></div>
                </div>
            </div>
            <div class="skeleton-line skeleton-line--text"></div>
            <div class="skeleton-line skeleton-line--text-short"></div>
            <div class="skeleton-line skeleton-line--btn"></div>
        </article>
    `).join('');
    container.innerHTML = `<div class="skeleton-grid">${skeletons}</div>`;

    const count = document.getElementById('search-count');
    if (count) count.textContent = '';
}

export function renderExtensionCard(extension) {
    const name = safeString(extension.displayName || extension.name, 'Без названия');
    const namespace = safeString(extension.namespace, 'unknown');
    const description = safeString(extension.description, 'Описание отсутствует');
    const version = safeString(extension.version, '');
    const path = buildExtensionPath(namespace, extension.name);
    const downloadUrl = getDownloadUrl(extension);

    const downloadBtn = downloadUrl
        ? `<a class="ext-dl-btn" href="${escapeHtml(downloadUrl)}" target="_blank" rel="noopener noreferrer"
              data-link-external aria-label="Скачать .VSIX">Скачать .VSIX</a>`
        : `<span class="ext-dl-btn ext-dl-btn--disabled" aria-disabled="true">Скачать .VSIX</span>`;

    return `
        <article class="ext-card" data-ext-path="${escapeHtml(path)}" tabindex="0"
                 role="link" aria-label="${escapeHtml(name)} — ${escapeHtml(namespace)}">
            <div class="ext-card-head">
                ${renderIcon(extension, 48)}
                <div style="min-width:0;flex:1;">
                    <h3 class="ext-card-title">${escapeHtml(name)}</h3>
                    <p class="ext-card-namespace">${escapeHtml(namespace)}</p>
                </div>
            </div>
            <p class="ext-card-desc">${escapeHtml(description)}</p>
            <div class="ext-card-foot">
                ${version ? `<span class="ext-version">v${escapeHtml(version)}</span>` : '<span></span>'}
                ${downloadBtn}
            </div>
        </article>
    `;
}

export function renderSearchResults({ extensions = [], totalSize = 0, query = '' } = {}) {
    const container = document.getElementById('search-results');
    const countEl = document.getElementById('search-count');
    if (!container) return;

    if (extensions.length === 0) {
        container.innerHTML = `
            <div class="state-block">
                <h3 class="state-title">Расширения не найдены</h3>
                <p class="state-text">
                    По запросу «${escapeHtml(query)}» ничего не найдено.
                    Попробуйте изменить формулировку.
                </p>
            </div>
        `;
        if (countEl) countEl.textContent = '';
        return;
    }

    const cards = extensions.map(renderExtensionCard).join('');
    container.innerHTML = `<div class="extensions-grid">${cards}</div>`;

    if (countEl) {
        const shown = extensions.length;
        countEl.textContent = totalSize > shown
            ? `Показано ${shown} из ${totalSize}`
            : `Найдено: ${shown}`;
    }
}

export function renderSearchError({ message = 'Не удалось загрузить результаты', onRetry } = {}) {
    const container = document.getElementById('search-results');
    if (!container) return;
    container.innerHTML = `
        <div class="state-block">
            <h3 class="state-title">Произошла ошибка</h3>
            <p class="state-text">${escapeHtml(message)}</p>
            <button type="button" class="state-btn" id="search-retry-btn">Повторить</button>
        </div>
    `;
    if (typeof onRetry === 'function') {
        const btn = document.getElementById('search-retry-btn');
        if (btn) btn.addEventListener('click', onRetry);
    }
}

// =========================================================
// Страница расширения
// =========================================================

export function renderExtensionLoading() {
    setRoot(`
        <section class="container">
            <div class="skeleton-detail-head">
                <div class="skeleton-detail-icon"></div>
                <div class="skeleton-detail-info">
                    <div class="skeleton-line skeleton-line--title" style="width:60%;"></div>
                    <div class="skeleton-line skeleton-line--subtitle" style="width:30%;"></div>
                    <div class="skeleton-line skeleton-line--text" style="width:90%;margin-top:8px;"></div>
                    <div class="skeleton-line skeleton-line--text-short" style="width:70%;"></div>
                </div>
            </div>
            <div class="skeleton-detail-layout">
                <div class="skeleton-readme">
                    <div class="skeleton-line skeleton-line--title" style="width:40%;"></div>
                    <div class="skeleton-line skeleton-line--text"></div>
                    <div class="skeleton-line skeleton-line--text"></div>
                    <div class="skeleton-line skeleton-line--text-short"></div>
                    <div class="skeleton-line skeleton-line--title" style="width:30%;margin-top:10px;"></div>
                    <div class="skeleton-line skeleton-line--text"></div>
                    <div class="skeleton-line skeleton-line--text-short"></div>
                </div>
                <div class="skeleton-sidebar">
                    <div class="skeleton-sidebar-card">
                        <div class="skeleton-line skeleton-line--btn" style="width:100%;"></div>
                        <div class="skeleton-line skeleton-line--text-short"></div>
                    </div>
                    <div class="skeleton-sidebar-card">
                        <div class="skeleton-line skeleton-line--subtitle" style="width:50%;"></div>
                        <div class="skeleton-line skeleton-line--text"></div>
                        <div class="skeleton-line skeleton-line--subtitle" style="width:40%;margin-top:6px;"></div>
                        <div class="skeleton-line skeleton-line--text"></div>
                    </div>
                </div>
            </div>
        </section>
    `);
}

export function renderExtensionError({ message = 'Не удалось загрузить расширение', onBack } = {}) {
    setRoot(`
        <section class="container">
            <div class="state-block">
                <h3 class="state-title">Произошла ошибка</h3>
                <p class="state-text">${escapeHtml(message)}</p>
                <button type="button" class="state-btn" id="ext-back-btn">Вернуться на главную</button>
            </div>
        </section>
    `);
    if (typeof onBack === 'function') {
        const btn = document.getElementById('ext-back-btn');
        if (btn) btn.addEventListener('click', onBack);
    }
}

export function renderExtensionPage(extension) {
    const name = safeString(extension.displayName || extension.name, 'Без названия');
    const namespace = safeString(extension.namespace, 'unknown');
    const description = safeString(extension.description, 'Описание отсутствует');
    const version = safeString(extension.version, '');
    const license = safeString(extension.license, '');
    const publisher = safeString(
        extension.publishedBy?.displayName ||
        extension.publishedBy?.loginName ||
        extension.namespace,
        ''
    );

    const downloadUrl = getDownloadUrl(extension);

    const downloadBlock = downloadUrl
        ? `
            <div class="sidebar-card sidebar-download">
                <a class="sidebar-download-btn" href="${escapeHtml(downloadUrl)}"
                   target="_blank" rel="noopener noreferrer" data-link-external>
                    Скачать .VSIX
                </a>
                <p class="sidebar-download-hint">
                    Файл расширения для установки в редактор кода.
                </p>
            </div>
        `
        : `
            <div class="sidebar-card sidebar-download">
                <span class="sidebar-download-btn sidebar-download-btn--disabled" aria-disabled="true">
                    Скачать .VSIX
                </span>
                <p class="sidebar-download-hint">
                    Файл расширения сейчас недоступен.
                </p>
            </div>
        `;

    const metaRows = [
        { label: 'Версия', value: version ? `v${version}` : '', mono: true },
        { label: 'Лицензия', value: license },
        { label: 'Издатель', value: publisher },
        { label: 'Namespace', value: namespace, mono: true },
    ].filter(r => r.value);

    const metaHtml = metaRows.length
        ? metaRows.map(r => `
            <div class="sidebar-meta-row">
                <span class="sidebar-meta-label">${escapeHtml(r.label)}</span>
                <span class="sidebar-meta-value ${r.mono ? 'sidebar-meta-value--mono' : ''}">
                    ${escapeHtml(r.value)}
                </span>
            </div>
        `).join('')
        : `<p class="sidebar-meta-value sidebar-meta-value--muted">Дополнительная информация не указана</p>`;

    setRoot(`
        <section class="container">
            <header class="ext-header">
                ${renderIcon(extension, 80).replace('class="ext-icon"', 'class="ext-header-icon"')}
                <div class="ext-header-info">
                    <h1 class="ext-header-title">${escapeHtml(name)}</h1>
                    <p class="ext-header-namespace">
                        <a href="/search?q=${encodeURIComponent(namespace)}" data-link>${escapeHtml(namespace)}</a>
                    </p>
                    <p class="ext-header-desc">${escapeHtml(description)}</p>
                </div>
            </header>

            <div class="ext-layout">
                <div class="ext-content">
                    <div class="ext-content-tabs" role="tablist" aria-label="Разделы страницы">
                        <button type="button" class="ext-content-tab is-active" role="tab"
                                aria-selected="true" data-tab="readme">README</button>
                        <button type="button" class="ext-content-tab" role="tab"
                                aria-selected="false" data-tab="details">Описание</button>
                    </div>
                    <div id="tab-readme" class="tab-panel" role="tabpanel">
                        <div id="readme-container" class="readme">
                            <div class="skeleton-line skeleton-line--title" style="width:30%;"></div>
                            <div class="skeleton-line skeleton-line--text"></div>
                            <div class="skeleton-line skeleton-line--text"></div>
                            <div class="skeleton-line skeleton-line--text-short"></div>
                        </div>
                    </div>
                    <div id="tab-details" class="tab-panel" role="tabpanel" hidden>
                        <div class="ext-description">
                            <p>${escapeHtml(description)}</p>
                            ${version ? `<p><strong>Версия:</strong> v${escapeHtml(version)}</p>` : ''}
                            ${license ? `<p><strong>Лицензия:</strong> ${escapeHtml(license)}</p>` : ''}
                            ${publisher ? `<p><strong>Издатель:</strong> ${escapeHtml(publisher)}</p>` : ''}
                        </div>
                    </div>
                </div>

                <aside class="ext-sidebar" aria-label="Информация о расширении">
                    ${downloadBlock}
                    <div class="sidebar-card sidebar-meta">
                        ${metaHtml}
                    </div>
                </aside>
            </div>
        </section>
    `);

    // Переключение вкладок
    const tabs = document.querySelectorAll('.ext-content-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.tab;
            tabs.forEach(t => {
                const isActive = t.dataset.tab === target;
                t.classList.toggle('is-active', isActive);
                t.setAttribute('aria-selected', String(isActive));
            });
            document.querySelectorAll('.tab-panel').forEach(panel => {
                panel.hidden = panel.id !== `tab-${target}`;
            });
        });
    });
}

export function setReadmeHtml(html) {
    const container = document.getElementById('readme-container');
    if (!container) return;
    if (!html || !html.trim()) {
        container.innerHTML = `<p class="readme-empty">README недоступен для этого расширения.</p>`;
        return;
    }
    container.innerHTML = html;
}

export function setReadmeError(message = 'Не удалось загрузить README') {
    const container = document.getElementById('readme-container');
    if (!container) return;
    container.innerHTML = `<p class="readme-empty">${escapeHtml(message)}</p>`;
}