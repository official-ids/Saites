// =========================================================
// markdown.js — рендеринг Markdown в безопасный HTML
// =========================================================

import { escapeHtml } from './utils.js';

/**
 * Рендерит Markdown в безопасный HTML.
 * Использует marked.js и DOMPurify (подключены глобально через CDN).
 */
export function renderMarkdown(markdown) {
    if (typeof markdown !== 'string' || markdown.length === 0) {
        return '';
    }

    if (typeof window.marked === 'undefined') {
        // Если marked ещё не загрузился — возвращаем экранированный текст
        return `<pre class="readme-empty">${escapeHtml(markdown)}</pre>`;
    }

    // Настраиваем marked: внешние ссылки открывать в новой вкладке
    try {
        if (window.marked.use) {
            window.marked.use({
                breaks: false,
                gfm: true,
                renderer: {
                    link({ href, title, tokens }) {
                        const text = this.parser.parseInline(tokens);
                        const safeHref = href == null ? '' : String(href);
                        const safeTitle = title ? ` title="${escapeHtml(title)}"` : '';
                        const isExternal = /^(https?:|mailto:|ftp:)/i.test(safeHref);
                        if (isExternal) {
                            return `<a href="${escapeHtml(safeHref)}"${safeTitle} target="_blank" rel="noopener noreferrer">${text}</a>`;
                        }
                        return `<a href="${escapeHtml(safeHref)}"${safeTitle}>${text}</a>`;
                    },
                    image({ href, title, text }) {
                        const safeHref = href == null ? '' : String(href);
                        const safeTitle = title ? ` title="${escapeHtml(title)}"` : '';
                        const safeAlt = text ? ` alt="${escapeHtml(text)}"` : ' alt=""';
                        return `<img src="${escapeHtml(safeHref)}"${safeAlt}${safeTitle} loading="lazy">`;
                    },
                },
            });
        }
    } catch {
        // Игнорируем ошибки настройки marked — продолжим с дефолтами
    }

    let html = '';
    try {
        html = window.marked.parse(markdown);
    } catch {
        return `<pre class="readme-empty">${escapeHtml(markdown)}</pre>`;
    }

    // Санитизация через DOMPurify
    if (typeof window.DOMPurify !== 'undefined' && typeof window.DOMPurify.sanitize === 'function') {
        html = window.DOMPurify.sanitize(html, {
            ADD_ATTR: ['target', 'rel', 'loading'],
            ALLOW_UNKNOWN_PROTOCOLS: false,
        });
    }

    return html;
}