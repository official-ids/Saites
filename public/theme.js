/**
 * Oris — управление темой (светлая/тёмная) с сохранением выбора.
 *
 * Значения localStorage['oris-theme']:
 *   'light' | 'dark' — явный выбор пользователя
 *   отсутствует      — следовать системной теме (prefers-color-scheme)
 *
 * Страница, подключающая этот скрипт, должна объявить в CSS переменные темы
 * для селекторов :root[data-theme="light"] и :root[data-theme="dark"], а
 * системную media-проверку ограничить через :root:not([data-theme]).
 *
 * Чтобы избежать мигания, до загрузки скрипта рекомендуется в <head> выставить
 * атрибут заранее:
 *   <script>try{var t=localStorage.getItem('oris-theme');if(t)document.documentElement.dataset.theme=t;}catch(e){}</script>
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'oris-theme';
    var root = document.documentElement;

    function stored() {
        try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
    }

    function systemPrefersDark() {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    /** Текущая активная тема (с учётом системной). */
    function effectiveTheme() {
        var s = stored();
        if (s === 'light' || s === 'dark') return s;
        return systemPrefersDark() ? 'dark' : 'light';
    }

    function apply(theme) {
        if (theme === 'light' || theme === 'dark') {
            root.dataset.theme = theme;
        } else {
            delete root.dataset.theme;
        }
        updateMeta();
        updateButton();
    }

    function updateMeta() {
        var meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', effectiveTheme() === 'dark' ? '#000000' : '#ffffff');
    }

    var SUN = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/>';
    var MOON = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/>';

    function updateButton() {
        var btn = document.getElementById('orisThemeToggle');
        if (!btn) return;
        var isDark = effectiveTheme() === 'dark';
        btn.querySelector('svg').innerHTML = isDark ? SUN : MOON;
        btn.setAttribute('aria-label', isDark ? 'Светлая тема' : 'Тёмная тема');
        btn.setAttribute('title', isDark ? 'Светлая тема' : 'Тёмная тема');
    }

    function setTheme(theme) {
        try {
            if (theme === 'light' || theme === 'dark') localStorage.setItem(STORAGE_KEY, theme);
            else localStorage.removeItem(STORAGE_KEY);
        } catch (e) { /* ignore */ }
        apply(theme);
    }

    function toggle() {
        setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark');
    }

    function injectStyles() {
        if (document.getElementById('orisThemeToggleStyle')) return;
        var css = '' +
            '#orisThemeToggle{position:fixed;right:20px;bottom:20px;z-index:1000;width:44px;height:44px;' +
            'border-radius:50%;border:1px solid var(--border,rgba(0,0,0,0.1));background:var(--bg-card,#fff);' +
            'color:var(--text-primary,#1d1d1f);cursor:pointer;display:flex;align-items:center;justify-content:center;' +
            'box-shadow:var(--shadow-md,0 8px 24px rgba(0,0,0,0.12));transition:transform .2s ease,background-color .3s ease,color .3s ease;}' +
            '#orisThemeToggle:hover{transform:scale(1.08);}' +
            '#orisThemeToggle:active{transform:scale(0.96);}' +
            '#orisThemeToggle svg{width:22px;height:22px;fill:none;stroke:currentColor;}' +
            '@media (max-width:600px){#orisThemeToggle{right:14px;bottom:14px;width:40px;height:40px;}#orisThemeToggle svg{width:20px;height:20px;}}';
        var style = document.createElement('style');
        style.id = 'orisThemeToggleStyle';
        style.textContent = css;
        document.head.appendChild(style);
    }

    function injectButton() {
        if (document.getElementById('orisThemeToggle')) return;
        injectStyles();
        var btn = document.createElement('button');
        btn.id = 'orisThemeToggle';
        btn.type = 'button';
        btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"></svg>';
        btn.addEventListener('click', toggle);
        document.body.appendChild(btn);
        updateButton();
    }

    // Применить сохранённую тему сразу.
    apply(stored());

    // Реакция на смену системной темы, когда явный выбор не задан.
    if (window.matchMedia) {
        var mq = window.matchMedia('(prefers-color-scheme: dark)');
        var onChange = function () { if (!stored()) { updateMeta(); updateButton(); } };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectButton);
    } else {
        injectButton();
    }

    window.OrisTheme = { set: setTheme, toggle: toggle, get: effectiveTheme };
})();
