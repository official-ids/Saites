// sitemap-generator.js
// Генератор sitemap.xml для статических сайтов
// Сканирует папку public/ и генерирует sitemap.xml на основе структуры папок

const fs = require('fs');
const path = require('path');

// ============================================
// КОНСТАНТЫ
// ============================================

/**
 * Базовая конфигурация генератора sitemap.
 *
 * @typedef {Object} AppConstants
 * @property {string} PUBLIC_DIR       — папка со статикой сайта
 * @property {string} SITEMAP_FILE     — имя файла sitemap
 * @property {string} ROBOTS_FILE      — имя файла robots.txt
 * @property {string} INDEX_FILE       — главная страница
 * @property {string} BASE_URL         — корневой домен
 * @property {string[]} EXCLUDED_PATTERNS — маски путей, исключаемых из обхода
 * @property {string} CHANGEFREQ       — частота обновления по умолчанию
 * @property {number} PRIORITY         — приоритет URL по умолчанию
 * @property {number} MAX_URLS         — лимит URL в одном sitemap
 * @property {Object} LOG_LEVELS       — уровни логирования
 * @property {string} VERSION          — версия скрипта
 * @property {string} AUTHOR           — автор
 * @property {string} DESCRIPTION      — описание
 */

/** @type {AppConstants} */
const CONSTANTS = Object.freeze({
    // ---------- Пути и файлы ----------
    PUBLIC_DIR:   'public',
    SITEMAP_FILE: 'sitemap.xml',
    ROBOTS_FILE:  'robots.txt',
    INDEX_FILE:   'index.html',

    // ---------- Домен ----------
    BASE_URL: 'https://example.com',

    // ---------- Исключения ----------
    EXCLUDED_PATTERNS: [
        '/api/*',

        // статические ресурсы
        '/*.js',
        '/*.json',
        '/*.css',
        '/*.png',
        '/*.jpg',
        '/*.jpeg',
        '/*.gif',
        '/*.svg',
        '/*.ico',

        // шрифты
        '/*.woff',
        '/*.woff2',
        '/*.ttf',
        '/*.eot',

        // служебные директории
        '/_next/*',
        '/_vercel/*',
        '/node_modules/*'
    ],

    // ---------- Параметры sitemap ----------
    CHANGEFREQ: 'weekly',
    PRIORITY:   0.8,
    MAX_URLS:   50000,

    // ---------- Логирование ----------
    LOG_LEVELS: Object.freeze({
        ERROR: 'ERROR',
        WARN:  'WARN',
        INFO:  'INFO',
        DEBUG: 'DEBUG'
    }),

    // ---------- Мета ----------
    VERSION:     '1.0.0',
    AUTHOR:      'Oris',
    DESCRIPTION: 'Sitemap generator for static sites'
});

// ============================================
// КЛАСС LOGGER
// ============================================

class Logger {
    constructor(level = 'INFO') {
        this.level = level;
        this.levels = CONSTANTS.LOG_LEVELS;
        this.logs = [];
        this.startTime = Date.now();
        this.logCount = 0;
    }

    log(message, level = 'INFO') {
        const timestamp = new Date().toISOString();
        const elapsed = Date.now() - this.startTime;
        const logEntry = `[${timestamp}] [+${elapsed}ms] [${level}] ${message}`;
        this.logs.push(logEntry);
        this.logCount++;

        if (this.shouldLog(level)) {
            console.log(logEntry);
        }
    }

    error(message) {
        this.log(message, this.levels.ERROR);
    }

    warn(message) {
        this.log(message, this.levels.WARN);
    }

    info(message) {
        this.log(message, this.levels.INFO);
    }

    debug(message) {
        this.log(message, this.levels.DEBUG);
    }

    shouldLog(level) {
        const levelOrder = [
            this.levels.DEBUG,
            this.levels.INFO,
            this.levels.WARN,
            this.levels.ERROR
        ];
        const currentLevelIndex = levelOrder.indexOf(this.level);
        const messageLevelIndex = levelOrder.indexOf(level);
        return messageLevelIndex >= currentLevelIndex;
    }

    getLogs() {
        return this.logs;
    }

    getLogCount() {
        return this.logCount;
    }

    clearLogs() {
        this.logs = [];
        this.logCount = 0;
    }

    getElapsedTime() {
        return Date.now() - this.startTime;
    }

    resetTimer() {
        this.startTime = Date.now();
    }
}

// ============================================
// КЛАСС VALIDATOR
// ============================================

/**
 * Валидатор путей, URL, файлов и директорий.
 *
 * Ведёт статистику проверок и ошибок, логирует все действия через Logger.
 */
class Validator {
    /** @type {number} Максимальная допустимая длина пути */
    static #MAX_PATH_LENGTH = 1000;

    /** @private @type {Logger} */
    #logger;

    /** @private @type {number} */
    #validationCount;

    /** @private @type {number} */
    #errorCount;

    /**
     * Создаёт экземпляр валидатора.
     *
     * @param {Logger} logger — экземпляр логгера
     */
    constructor(logger) {
        if (!logger || typeof logger.log !== 'function') {
            throw new Error('Logger instance is required');
        }

        this.#logger          = logger;
        this.#validationCount = 0;
        this.#errorCount      = 0;
    }

    // ---------- ВАЛИДАЦИЯ ПУТЕЙ ----------

    /**
     * Проверяет корректность файлового пути.
     *
     * @param {string} inputPath — путь для проверки
     * @returns {boolean} true, если путь валиден
     */
    validatePath(inputPath) {
        this.#validationCount++;
        this.#logger.debug(`Validating path: ${inputPath}`);

        if (!this.#validateString(inputPath, 'Path')) {
            return false;
        }

        if (inputPath.length > Validator.#MAX_PATH_LENGTH) {
            this.#logger.warn(`Path is too long (max ${Validator.#MAX_PATH_LENGTH} characters)`);
            this.#errorCount++;
            return false;
        }

        if (inputPath.includes('\0')) {
            this.#logger.error('Path contains null byte');
            this.#errorCount++;
            return false;
        }

        this.#logger.debug(`Path validation passed: ${inputPath}`);
        return true;
    }

    // ---------- ВАЛИДАЦИЯ URL ----------

    /**
     * Проверяет корректность URL.
     *
     * @param {string} url — URL для проверки
     * @returns {boolean} true, если URL валиден
     */
    validateUrl(url) {
        this.#validationCount++;
        this.#logger.debug(`Validating URL: ${url}`);

        if (!this.#validateString(url, 'URL')) {
            return false;
        }

        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            this.#logger.error('URL must start with http:// or https://');
            this.#errorCount++;
            return false;
        }

        try {
            new URL(url);
        } catch (error) {
            this.#logger.error(`Invalid URL format: ${error.message}`);
            this.#errorCount++;
            return false;
        }

        this.#logger.debug(`URL validation passed: ${url}`);
        return true;
    }

    // ---------- ВАЛИДАЦИЯ ФАЙЛОВ ----------

    /**
     * Проверяет существование и корректность файла.
     *
     * @param {string} filePath — путь к файлу
     * @returns {boolean} true, если файл существует и является файлом
     */
    validateFile(filePath) {
        this.#validationCount++;
        this.#logger.debug(`Validating file: ${filePath}`);

        if (!this.validatePath(filePath)) {
            return false;
        }

        return this.#validateFileSystemEntry(filePath, 'file', (stats) => stats.isFile());
    }

    // ---------- ВАЛИДАЦИЯ ДИРЕКТОРИЙ ----------

    /**
     * Проверяет существование и корректность директории.
     *
     * @param {string} dirPath — путь к директории
     * @returns {boolean} true, если директория существует и является директорией
     */
    validateDirectory(dirPath) {
        this.#validationCount++;
        this.#logger.debug(`Validating directory: ${dirPath}`);

        if (!this.validatePath(dirPath)) {
            return false;
        }

        return this.#validateFileSystemEntry(dirPath, 'directory', (stats) => stats.isDirectory());
    }

    // ---------- ВАЛИДАЦИЯ ПАТТЕРНОВ ----------

    /**
     * Проверяет корректность паттерна.
     *
     * @param {string} pattern — паттерн для проверки
     * @returns {boolean} true, если паттерн валиден
     */
    validatePattern(pattern) {
        this.#validationCount++;

        return this.#validateString(pattern, 'Pattern', false);
    }

    // ---------- СТАТИСТИКА ----------

    /**
     * Возвращает статистику валидаций.
     *
     * @returns {{validationCount: number, errorCount: number}}
     */
    getStats() {
        return {
            validationCount: this.#validationCount,
            errorCount: this.#errorCount
        };
    }

    // ---------- ПРИВАТНЫЕ ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ----------

    /**
     * Проверяет, что значение является непустой строкой.
     *
     * @private
     * @param {*} value — значение для проверки
     * @param {string} label — название поля для логов
     * @param {boolean} [countError=true] — учитывать ли ошибку в статистике
     * @returns {boolean}
     */
    #validateString(value, label, countError = true) {
        if (!value) {
            this.#logger.error(`${label} is empty or undefined`);
            if (countError) this.#errorCount++;
            return false;
        }

        if (typeof value !== 'string') {
            this.#logger.error(`${label} must be a string`);
            if (countError) this.#errorCount++;
            return false;
        }

        if (value.length === 0) {
            this.#logger.error(`${label} is empty string`);
            if (countError) this.#errorCount++;
            return false;
        }

        return true;
    }

    /**
     * Проверяет существование и тип файловой сущности.
     *
     * @private
     * @param {string} path — путь для проверки
     * @param {string} type — тип ('file' или 'directory')
     * @param {function} typeCheck — функция проверки типа из stats
     * @returns {boolean}
     */
    #validateFileSystemEntry(path, type, typeCheck) {
        if (!fs.existsSync(path)) {
            this.#logger.error(`${type.charAt(0).toUpperCase() + type.slice(1)} does not exist: ${path}`);
            this.#errorCount++;
            return false;
        }

        let stats;
        try {
            stats = fs.statSync(path);
        } catch (error) {
            this.#logger.error(`Cannot stat ${type}: ${error.message}`);
            this.#errorCount++;
            return false;
        }

        if (!typeCheck(stats)) {
            this.#logger.error(`Path is not a ${type}: ${path}`);
            this.#errorCount++;
            return false;
        }

        if (type === 'file' && stats.size === 0) {
            this.#logger.warn(`File is empty: ${path}`);
        }

        this.#logger.debug(`${type.charAt(0).toUpperCase() + type.slice(1)} validation passed: ${path}`);
        return true;
    }
}

// ============================================
// КЛАСС SCANNER
// ============================================

/**
 * @typedef {Object} ScanEntry
 * @property {string} name        — имя файла или директории
 * @property {string} path        — полный путь
 * @property {string} [indexPath] — путь к index.html (только для директорий)
 * @property {'file'|'directory'} type — тип записи
 * @property {number} depth       — глубина вложенности
 */

/**
 * Сканер файловой системы.
 *
 * Выполняет линейное или рекурсивное сканирование директорий,
 * собирая информацию о файлах и директориях с `index.html`.
 */
class Scanner {
    /** @private @type {number} Максимальная глубина рекурсии по умолчанию */
    static #DEFAULT_MAX_DEPTH = 10;

    /** @private @type {string} Префикс скрытых файлов/директорий */
    static #HIDDEN_PREFIX = '.';

    /** @private @type {Logger} */
    #logger;

    /** @private @type {Validator} */
    #validator;

    /** @private @type {number} Счётчик выполненных сканирований */
    #scanCount;

    /**
     * Создаёт экземпляр сканера.
     *
     * @param {Logger}    logger    — экземпляр логгера
     * @param {Validator} validator — экземпляр валидатора
     */
    constructor(logger, validator) {
        if (!logger || typeof logger.info !== 'function') {
            throw new Error('Logger instance is required');
        }
        if (!validator || typeof validator.validateDirectory !== 'function') {
            throw new Error('Validator instance is required');
        }

        this.#logger    = logger;
        this.#validator = validator;
        this.#scanCount = 0;
    }

    // ---------- ЛИНЕЙНОЕ СКАНИРОВАНИЕ ----------

    /**
     * Сканирует директорию (без рекурсии) и собирает информацию о файлах
     * и директориях с `index.html`.
     *
     * @param {string} dirPath — путь к директории
     * @returns {ScanEntry[]} массив найденных записей
     */
    scanDirectory(dirPath) {
        this.#scanCount++;
        this.#logger.info(`Scanning directory: ${dirPath}`);

        if (!this.#validator.validateDirectory(dirPath)) {
            this.#logger.error(`Cannot scan invalid directory: ${dirPath}`);
            return [];
        }

        const items = this.#readDirectoryItems(dirPath);
        const entries = this.#processDirectoryItems(items, dirPath);

        this.#logger.info(`Scan complete. Found ${entries.length} entries`);
        return entries;
    }

    // ---------- РЕКУРСИВНОЕ СКАНИРОВАНИЕ ----------

    /**
     * Рекурсивно сканирует директорию и её поддиректории.
     *
     * @param {string} dirPath  — путь к корневой директории
     * @param {number} [depth=0]    — текущая глубина вложенности
     * @param {number} [maxDepth]   — максимальная глубина рекурсии
     * @returns {ScanEntry[]} массив найденных записей
     */
    scanRecursive(dirPath, depth = 0, maxDepth = Scanner.#DEFAULT_MAX_DEPTH) {
        this.#scanCount++;
        this.#logger.info(`Scanning directory recursively: ${dirPath} (depth: ${depth})`);

        if (!this.#validator.validateDirectory(dirPath)) {
            return [];
        }

        if (depth > maxDepth) {
            this.#logger.warn(`Max depth reached: ${depth}`);
            return [];
        }

        const items = this.#readDirectoryItems(dirPath);
        const entries = this.#processDirectoryItemsRecursive(items, dirPath, depth, maxDepth);

        return entries;
    }

    // ---------- СТАТИСТИКА ----------

    /**
     * Возвращает количество выполненных сканирований.
     *
     * @returns {number}
     */
    getScanCount() {
        return this.#scanCount;
    }

    // ---------- ПРИВАТНЫЕ ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ----------

    /**
     * Читает содержимое директории с обработкой ошибок.
     *
     * @private
     * @param {string} dirPath — путь к директории
     * @returns {string[]} имена элементов директории
     */
    #readDirectoryItems(dirPath) {
        try {
            const items = fs.readdirSync(dirPath);
            this.#logger.debug(`Found ${items.length} items in ${dirPath}`);
            return items;
        } catch (error) {
            this.#logger.error(`Error reading directory ${dirPath}: ${error.message}`);
            return [];
        }
    }

    /**
     * Обрабатывает элементы директории (линейное сканирование).
     *
     * @private
     * @param {string[]} items   — список имен элементов
     * @param {string}   dirPath — родительская директория
     * @returns {ScanEntry[]}
     */
    #processDirectoryItems(items, dirPath) {
        const entries = [];

        for (const item of items) {
            const itemPath = path.join(dirPath, item);
            const stats = this.#safeStat(itemPath, item);

            if (!stats) continue;

            if (stats.isDirectory()) {
                this.#logger.debug(`Found directory: ${item}`);
                const entry = this.#buildDirectoryEntry(item, itemPath, 0);
                if (entry) entries.push(entry);
            } else if (stats.isFile()) {
                this.#logger.debug(`Found file: ${item}`);
                entries.push({
                    name: item,
                    path: itemPath,
                    type: 'file',
                    depth: 0
                });
            }
        }

        return entries;
    }

    /**
     * Обрабатывает элементы директории (рекурсивное сканирование).
     *
     * @private
     * @param {string[]} items    — список имен элементов
     * @param {string}   dirPath  — родительская директория
     * @param {number}   depth    — текущая глубина
     * @param {number}   maxDepth — максимальная глубина
     * @returns {ScanEntry[]}
     */
    #processDirectoryItemsRecursive(items, dirPath, depth, maxDepth) {
        const entries = [];

        for (const item of items) {
            if (item.startsWith(Scanner.#HIDDEN_PREFIX)) {
                this.#logger.debug(`Skipping hidden item: ${item}`);
                continue;
            }

            const itemPath = path.join(dirPath, item);
            const stats = this.#safeStat(itemPath, item);

            if (!stats || !stats.isDirectory()) continue;

            const entry = this.#buildDirectoryEntry(item, itemPath, depth);
            if (entry) entries.push(entry);

            const subEntries = this.scanRecursive(itemPath, depth + 1, maxDepth);
            entries.push(...subEntries);
        }

        return entries;
    }

    /**
     * Формирует запись для директории с проверкой наличия `index.html`.
     *
     * @private
     * @param {string} name     — имя директории
     * @param {string} dirPath  — путь к директории
     * @param {number} depth    — глубина вложенности
     * @returns {ScanEntry|null} запись, если найден index.html, иначе null
     */
    #buildDirectoryEntry(name, dirPath, depth) {
        const indexPath = path.join(dirPath, CONSTANTS.INDEX_FILE);

        if (!fs.existsSync(indexPath)) {
            this.#logger.debug(`No ${CONSTANTS.INDEX_FILE} in: ${name}`);
            return null;
        }

        this.#logger.info(`Found ${CONSTANTS.INDEX_FILE} in: ${name}`);
        return {
            name: name,
            path: dirPath,
            indexPath: indexPath,
            type: 'directory',
            depth: depth
        };
    }

    /**
     * Безопасно получает информацию об элементе файловой системы.
     *
     * @private
     * @param {string} itemPath — путь к элементу
     * @param {string} itemName — имя элемента (для логов)
     * @returns {fs.Stats|null} статистика или null при ошибке
     */
    #safeStat(itemPath, itemName) {
        try {
            return fs.statSync(itemPath);
        } catch (error) {
            this.#logger.warn(`Cannot stat item ${itemName}: ${error.message}`);
            return null;
        }
    }
}

// ============================================
// КЛАСС FILTER
// ============================================

/**
 * Фильтр записей файловой системы.
 *
 * Поддерживает фильтрацию по паттернам (glob-стиль), расширениям и типам.
 * Ведёт статистику выполненных фильтраций.
 */
class Filter {
    /** @private @type {Logger} */
    #logger;

    /** @private @type {number} Счётчик выполненных фильтраций */
    #filterCount;

    /**
     * Создаёт экземпляр фильтра.
     *
     * @param {Logger} logger — экземпляр логгера
     */
    constructor(logger) {
        if (!logger || typeof logger.info !== 'function') {
            throw new Error('Logger instance is required');
        }

        this.#logger      = logger;
        this.#filterCount = 0;
    }

    // ---------- ФИЛЬТРАЦИЯ ПО ПАТТЕРНАМ ----------

    /**
     * Фильтрует записи, исключая совпадающие с паттернами.
     *
     * @param {ScanEntry[]} entries           — массив записей для фильтрации
     * @param {string[]}    excludedPatterns  — массив паттернов исключений
     * @returns {ScanEntry[]} отфильтрованный массив записей
     */
    filterEntries(entries, excludedPatterns) {
        this.#filterCount++;
        this.#logger.info(`Filtering ${entries.length} entries`);

        const filtered = [];
        let excludedCount = 0;

        for (const entry of entries) {
            if (this.shouldInclude(entry, excludedPatterns)) {
                filtered.push(entry);
            } else {
                excludedCount++;
                this.#logger.debug(`Excluded: ${entry.name}`);
            }
        }

        this.#logger.info(`Filtered to ${filtered.length} entries (excluded ${excludedCount})`);
        return filtered;
    }

    /**
     * Проверяет, должна ли запись быть включена (не совпадает с паттернами).
     *
     * @param {ScanEntry} entry             — запись для проверки
     * @param {string[]}  excludedPatterns  — массив паттернов исключений
     * @returns {boolean} true, если запись должна быть включена
     */
    shouldInclude(entry, excludedPatterns) {
        for (const pattern of excludedPatterns) {
            if (this.matchesPattern(entry.name, pattern)) {
                return false;
            }
        }
        return true;
    }

    // ---------- ФИЛЬТРАЦИЯ ПО РАСШИРЕНИЯМ ----------

    /**
     * Фильтрует записи по списку разрешённых расширений.
     *
     * @param {ScanEntry[]} entries              — массив записей для фильтрации
     * @param {string[]}    allowedExtensions    — массив разрешённых расширений (с точкой)
     * @returns {ScanEntry[]} отфильтрованный массив записей
     */
    filterByExtension(entries, allowedExtensions) {
        this.#filterCount++;
        this.#logger.info(`Filtering by extensions: ${allowedExtensions.join(', ')}`);

        return entries.filter(entry => {
            const ext = path.extname(entry.name).toLowerCase();
            return allowedExtensions.includes(ext);
        });
    }

    // ---------- ФИЛЬТРАЦИЯ ПО ТИПУ ----------

    /**
     * Фильтрует записи по типу (file или directory).
     *
     * @param {ScanEntry[]} entries — массив записей для фильтрации
     * @param {'file'|'directory'} type — тип для фильтрации
     * @returns {ScanEntry[]} отфильтрованный массив записей
     */
    filterByType(entries, type) {
        this.#filterCount++;
        this.#logger.info(`Filtering by type: ${type}`);

        return entries.filter(entry => entry.type === type);
    }

    // ---------- СТАТИСТИКА ----------

    /**
     * Возвращает количество выполненных фильтраций.
     *
     * @returns {number}
     */
    getFilterCount() {
        return this.#filterCount;
    }

    // ---------- ПРИВАТНЫЕ ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ----------

    /**
     * Проверяет соответствие имени паттерну (поддержка glob-стиля с *).
     *
     * @private
     * @param {string} name    — имя для проверки
     * @param {string} pattern — паттерн для сравнения
     * @returns {boolean} true, если имя соответствует паттерну
     */
    matchesPattern(name, pattern) {
        if (!this.#validatePatternInputs(name, pattern)) {
            return false;
        }

        if (pattern.includes('*')) {
            const regex = this.#buildRegexFromPattern(pattern);
            return regex.test(name);
        }

        return name === pattern;
    }

    /**
     * Проверяет корректность входных данных для проверки паттерна.
     *
     * @private
     * @param {*} name    — имя для проверки
     * @param {*} pattern — паттерн для проверки
     * @returns {boolean} true, если оба параметра являются непустыми строками
     */
    #validatePatternInputs(name, pattern) {
        return typeof name === 'string' && name.length > 0 &&
               typeof pattern === 'string' && pattern.length > 0;
    }

    /**
     * Создаёт регулярное выражение из паттерна с поддержкой *.
     *
     * @private
     * @param {string} pattern — паттерн (может содержать *)
     * @returns {RegExp} регулярное выражение для проверки
     */
    #buildRegexFromPattern(pattern) {
        const regexPattern = pattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*');
        return new RegExp(`^${regexPattern}$`);
    }
}

// ============================================
// КЛАСС SORTER
// ============================================

/**
 * Сортировщик записей файловой системы.
 *
 * Поддерживает сортировку по имени, пути, глубине и типу
 * в возрастающем или убывающем порядке.
 */
class Sorter {
    /** @private @type {string[]} Допустимые критерии сортировки */
    static #SORT_CRITERIA = ['name', 'path', 'depth', 'type'];

    /** @private @type {string[]} Допустимые порядки сортировки */
    static #SORT_ORDERS = ['asc', 'desc'];

    /** @private @type {Logger} */
    #logger;

    /** @private @type {number} Счётчик выполненных сортировок */
    #sortCount;

    /**
     * Создаёт экземпляр сортировщика.
     *
     * @param {Logger} logger — экземпляр логгера
     */
    constructor(logger) {
        if (!logger || typeof logger.info !== 'function') {
            throw new Error('Logger instance is required');
        }

        this.#logger    = logger;
        this.#sortCount = 0;
    }

    // ---------- СОРТИРОВКА ----------

    /**
     * Сортирует записи по указанному критерию и порядку.
     *
     * @param {ScanEntry[]} entries      — массив записей для сортировки
     * @param {string}      [sortBy='name']  — критерий сортировки (name, path, depth, type)
     * @param {string}      [order='asc']    — порядок сортировки (asc, desc)
     * @returns {ScanEntry[]} отсортированный массив записей
     */
    sortEntries(entries, sortBy = 'name', order = 'asc') {
        this.#sortCount++;
        this.#logger.info(`Sorting ${entries.length} entries by ${sortBy} (${order})`);

        if (!Sorter.#SORT_CRITERIA.includes(sortBy)) {
            this.#logger.warn(`Unknown sort criteria: ${sortBy}`);
            return [...entries];
        }

        if (!Sorter.#SORT_ORDERS.includes(order)) {
            this.#logger.warn(`Unknown sort order: ${order}`);
            return [...entries];
        }

        const sorted = [...entries];
        sorted.sort((a, b) => this.#compareEntries(a, b, sortBy, order));

        this.#logger.info(`Sorting complete`);
        return sorted;
    }

    // ---------- СТАТИСТИКА ----------

    /**
     * Возвращает количество выполненных сортировок.
     *
     * @returns {number}
     */
    getSortCount() {
        return this.#sortCount;
    }

    // ---------- ПРИВАТНЫЕ ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ----------

    /**
     * Сравнивает две записи по указанному критерию.
     *
     * @private
     * @param {ScanEntry} a       — первая запись
     * @param {ScanEntry} b       — вторая запись
     * @param {string}    sortBy  — критерий сортировки
     * @param {string}    order   — порядок сортировки
     * @returns {number} результат сравнения (-1, 0, 1)
     */
    #compareEntries(a, b, sortBy, order) {
        const multiplier = order === 'asc' ? 1 : -1;

        switch (sortBy) {
            case 'name':
                return multiplier * a.name.localeCompare(b.name);

            case 'path':
                return multiplier * a.path.localeCompare(b.path);

            case 'depth':
                return multiplier * ((a.depth || 0) - (b.depth || 0));

            case 'type':
                return multiplier * a.type.localeCompare(b.type);

            default:
                return 0;
        }
    }
}

// ============================================
// КЛАСС GENERATOR
// ============================================

/**
 * @typedef {Object} SitemapUrl
 * @property {string} loc        — полный URL страницы
 * @property {string} lastmod    — дата последнего изменения (YYYY-MM-DD)
 * @property {string} changefreq — частота обновления
 * @property {number} priority   — приоритет (0.0 - 1.0)
 */

/**
 * Генератор URL для sitemap.
 *
 * Преобразует записи файловой системы в структуру sitemap URL
 * с метаданными (дата модификации, частота, приоритет).
 */
class Generator {
    /** @private @type {string} Формат даты для lastmod (ISO без времени) */
    static #DATE_FORMAT_REGEX = /T.*$/;

    /** @private @type {Logger} */
    #logger;

    /** @private @type {string} Базовый URL сайта */
    #baseUrl;

    /** @private @type {number} Счётчик сгенерированных URL */
    #generatedCount;

    /**
     * Создаёт экземпляр генератора.
     *
     * @param {Logger} logger  — экземпляр логгера
     * @param {string} baseUrl — базовый URL сайта (например, https://example.com)
     */
    constructor(logger, baseUrl) {
        if (!logger || typeof logger.info !== 'function') {
            throw new Error('Logger instance is required');
        }

        if (!baseUrl || typeof baseUrl !== 'string') {
            throw new Error('Base URL is required and must be a string');
        }

        try {
            new URL(baseUrl);
        } catch (error) {
            throw new Error(`Invalid base URL format: ${baseUrl}`);
        }

        this.#logger         = logger;
        this.#baseUrl        = baseUrl;
        this.#generatedCount = 0;
    }

    // ---------- ГЕНЕРАЦИЯ URL ----------

    /**
     * Генерирует URL для всех записей.
     *
     * @param {ScanEntry[]} entries — массив записей для обработки
     * @returns {SitemapUrl[]} массив сгенерированных URL
     */
    generateUrls(entries) {
        this.#logger.info(`Generating URLs for ${entries.length} entries`);

        const urls = [];

        for (const entry of entries) {
            const url = this.generateUrl(entry);
            if (url) {
                urls.push(url);
                this.#generatedCount++;
            }
        }

        this.#logger.info(`Generated ${urls.length} URLs`);
        return urls;
    }

    /**
     * Генерирует URL для одной записи.
     *
     * @param {ScanEntry} entry — запись для обработки
     * @returns {SitemapUrl|null} сгенерированный URL или null
     */
    generateUrl(entry) {
        if (entry.type !== 'directory') {
            return null;
        }

        const urlPath = `/${entry.name}`;
        const fullUrl = `${this.#baseUrl}${urlPath}`;

        if (!this.#validateGeneratedUrl(fullUrl)) {
            return null;
        }

        return {
            loc: fullUrl,
            lastmod: this.#getLastMod(entry.indexPath),
            changefreq: CONSTANTS.CHANGEFREQ,
            priority: CONSTANTS.PRIORITY
        };
    }

    // ---------- СТАТИСТИКА ----------

    /**
     * Возвращает количество сгенерированных URL.
     *
     * @returns {number}
     */
    getGeneratedCount() {
        return this.#generatedCount;
    }

    // ---------- ПРИВАТНЫЕ ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ----------

    /**
     * Проверяет корректность сгенерированного URL.
     *
     * @private
     * @param {string} url — URL для проверки
     * @returns {boolean} true, если URL валиден
     */
    #validateGeneratedUrl(url) {
        try {
            new URL(url);
            return true;
        } catch (error) {
            this.#logger.error(`Invalid generated URL: ${url}`);
            return false;
        }
    }

    /**
     * Получает дату последнего изменения файла.
     *
     * @private
     * @param {string} filePath — путь к файлу
     * @returns {string} дата в формате YYYY-MM-DD
     */
    #getLastMod(filePath) {
        try {
            const stats = fs.statSync(filePath);
            return this.#formatDate(stats.mtime);
        } catch (error) {
            this.#logger.error(`Error getting last mod: ${error.message}`);
            return this.#formatDate(new Date());
        }
    }

    /**
     * Форматирует дату в формат YYYY-MM-DD.
     *
     * @private
     * @param {Date} date — дата для форматирования
     * @returns {string} дата в формате YYYY-MM-DD
     */
    #formatDate(date) {
        return date.toISOString().replace(Generator.#DATE_FORMAT_REGEX, '');
    }
}

// ============================================
// КЛАСС FORMATTER
// ============================================

/**
 * Форматировщик sitemap в XML-формат.
 *
 * Преобразует массив URL в валидный XML согласно спецификации sitemap.org.
 * Поддерживает экранирование/деэкранирование XML-сущностей.
 */
class Formatter {
    /** @private @type {string} XML-декларация */
    static #XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

    /** @private @type {string} Открывающий тег urlset */
    static #URLSET_OPEN = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';

    /** @private @type {string} Закрывающий тег urlset */
    static #URLSET_CLOSE = '</urlset>';

    /** @private @type {string} Отступ для вложенных элементов */
    static #INDENT = '  ';

    /** @private @type {Logger} */
    #logger;

    /** @private @type {number} Счётчик выполненных форматирований */
    #formatCount;

    /**
     * Создаёт экземпляр форматировщика.
     *
     * @param {Logger} logger — экземпляр логгера
     */
    constructor(logger) {
        if (!logger || typeof logger.info !== 'function') {
            throw new Error('Logger instance is required');
        }

        this.#logger      = logger;
        this.#formatCount = 0;
    }

    // ---------- ФОРМАТИРОВАНИЕ SITEMAP ----------

    /**
     * Форматирует массив URL в XML-строку sitemap.
     *
     * @param {SitemapUrl[]} urls — массив URL для форматирования
     * @returns {string} XML-строка sitemap
     */
    formatSitemap(urls) {
        this.#formatCount++;
        this.#logger.info(`Formatting sitemap with ${urls.length} URLs`);

        const lines = [
            Formatter.#XML_DECLARATION,
            Formatter.#URLSET_OPEN
        ];

        for (const url of urls) {
            lines.push(...this.#formatUrlEntry(url));
        }

        lines.push(Formatter.#URLSET_CLOSE);

        this.#logger.info(`Sitemap formatted successfully`);
        return lines.join('\n');
    }

    // ---------- ЭКРАНИРОВАНИЕ XML ----------

    /**
     * Экранирует специальные символы XML в строке.
     *
     * @param {string} str — строка для экранирования
     * @returns {string} экранированная строка
     */
    escapeXml(str) {
        if (!this.#isValidString(str)) {
            return '';
        }

        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    /**
     * Деэксирует XML-сущности обратно в специальные символы.
     *
     * @param {string} str — строка с XML-сущностями
     * @returns {string} деэкранированная строка
     */
    unescapeXml(str) {
        if (!this.#isValidString(str)) {
            return '';
        }

        return str
            .replace(/&apos;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/&gt;/g, '>')
            .replace(/&lt;/g, '<')
            .replace(/&amp;/g, '&');
    }

    // ---------- СТАТИСТИКА ----------

    /**
     * Возвращает количество выполненных форматирований.
     *
     * @returns {number}
     */
    getFormatCount() {
        return this.#formatCount;
    }

    // ---------- ПРИВАТНЫЕ ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ----------

    /**
     * Форматирует одну запись URL в массив XML-строк.
     *
     * @private
     * @param {SitemapUrl} url — запись URL для форматирования
     * @returns {string[]} массив строк XML для этой записи
     */
    #formatUrlEntry(url) {
        const lines = [`${Formatter.#INDENT}<url>`];
        const indent = Formatter.#INDENT + Formatter.#INDENT;

        lines.push(`${indent}<loc>${this.escapeXml(url.loc)}</loc>`);

        if (url.lastmod) {
            lines.push(`${indent}<lastmod>${url.lastmod}</lastmod>`);
        }

        if (url.changefreq) {
            lines.push(`${indent}<changefreq>${url.changefreq}</changefreq>`);
        }

        if (url.priority !== undefined && url.priority !== null) {
            lines.push(`${indent}<priority>${url.priority}</priority>`);
        }

        lines.push(`${Formatter.#INDENT}</url>`);

        return lines;
    }

    /**
     * Проверяет, является ли значение непустой строкой.
     *
     * @private
     * @param {*} value — значение для проверки
     * @returns {boolean} true, если значение является непустой строкой
     */
    #isValidString(value) {
        return typeof value === 'string' && value.length > 0;
    }
}

// ============================================
// КЛАСС WRITER
// ============================================

/**
 * Записыватель sitemap в файл.
 *
 * Отвечает за запись XML-контента sitemap в файловую систему
 * с автоматическим созданием необходимых директорий.
 */
class Writer {
    /** @private @type {Logger} */
    #logger;

    /** @private @type {number} Счётчик выполненных записей */
    #writeCount;

    /**
     * Создаёт экземпляр записывателя.
     *
     * @param {Logger} logger — экземпляр логгера
     */
    constructor(logger) {
        if (!logger || typeof logger.info !== 'function') {
            throw new Error('Logger instance is required');
        }

        this.#logger     = logger;
        this.#writeCount = 0;
    }

    // ---------- ЗАПИСЬ SITEMAP ----------

    /**
     * Записывает контент sitemap в файл.
     *
     * @param {string} content    — XML-контент sitemap
     * @param {string} outputPath — путь к файлу для записи
     * @returns {boolean} true, если запись успешна
     */
    writeSitemap(content, outputPath) {
        this.#writeCount++;
        this.#logger.info(`Writing sitemap to: ${outputPath}`);

        if (!this.#validateWriteParameters(content, outputPath)) {
            return false;
        }

        try {
            this.#ensureDirectoryExists(outputPath);
            this.#writeFile(outputPath, content);
            
            this.#logger.info(`Sitemap written successfully (${content.length} bytes)`);
            return true;
        } catch (error) {
            this.#logger.error(`Error writing sitemap: ${error.message}`);
            return false;
        }
    }

    // ---------- СТАТИСТИКА ----------

    /**
     * Возвращает количество выполненных записей.
     *
     * @returns {number}
     */
    getWriteCount() {
        return this.#writeCount;
    }

    // ---------- ПРИВАТНЫЕ ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ----------

    /**
     * Проверяет корректность параметров для записи.
     *
     * @private
     * @param {string} content    — контент для записи
     * @param {string} outputPath — путь к файлу
     * @returns {boolean} true, если параметры валидны
     */
    #validateWriteParameters(content, outputPath) {
        if (!content) {
            this.#logger.error('Content is empty');
            return false;
        }

        if (!outputPath) {
            this.#logger.error('Output path is empty');
            return false;
        }

        return true;
    }

    /**
     * Создаёт директорию для файла, если она не существует.
     *
     * @private
     * @param {string} filePath — путь к файлу
     */
    #ensureDirectoryExists(filePath) {
        const dir = path.dirname(filePath);
        
        if (!fs.existsSync(dir)) {
            this.#logger.info(`Creating directory: ${dir}`);
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    /**
     * Записывает контент в файл.
     *
     * @private
     * @param {string} filePath — путь к файлу
     * @param {string} content  — контент для записи
     */
    #writeFile(filePath, content) {
        fs.writeFileSync(filePath, content, 'utf8');
    }
}

// ============================================
// КЛАСС HANDLER
// ============================================

/**
 * Обработчик событий и ошибок.
 *
 * Централизованная обработка ошибок, успешных операций и предупреждений
 * с ведением статистики и логированием через Logger.
 */
class Handler {
    /** @private @type {Logger} */
    #logger;

    /** @private @type {number} Счётчик обработанных ошибок */
    #errorCount;

    /** @private @type {number} Счётчик успешных операций */
    #successCount;

    /**
     * Создаёт экземпляр обработчика.
     *
     * @param {Logger} logger — экземпляр логгера
     */
    constructor(logger) {
        if (!logger || typeof logger.error !== 'function') {
            throw new Error('Logger instance is required');
        }

        this.#logger       = logger;
        this.#errorCount   = 0;
        this.#successCount = 0;
    }

    // ---------- ОБРАБОТКА ОШИБОК ----------

    /**
     * Обрабатывает ошибку с логированием и инкрементом счётчика.
     *
     * @param {Error}  error   — объект ошибки
     * @param {string} [context=''] — контекст возникновения ошибки
     */
    handleError(error, context = '') {
        if (!this.#isValidError(error)) {
            this.#logger.error('Invalid error object provided');
            return;
        }

        this.#errorCount++;
        
        const contextInfo = context ? ` in ${context}` : '';
        this.#logger.error(`Error${contextInfo}: ${error.message}`);
        this.#logger.debug(`Stack trace: ${error.stack}`);
    }

    // ---------- ОБРАБОТКА УСПЕШНЫХ ОПЕРАЦИЙ ----------

    /**
     * Обрабатывает успешную операцию с логированием и инкрементом счётчика.
     *
     * @param {string} message — сообщение об успехе
     */
    handleSuccess(message) {
        if (!this.#isValidMessage(message)) {
            this.#logger.warn('Invalid success message provided');
            return;
        }

        this.#successCount++;
        this.#logger.info(`Success: ${message}`);
    }

    // ---------- ОБРАБОТКА ПРЕДУПРЕЖДЕНИЙ ----------

    /**
     * Обрабатывает предупреждение с логированием.
     *
     * @param {string} message — текст предупреждения
     */
    handleWarning(message) {
        if (!this.#isValidMessage(message)) {
            this.#logger.warn('Invalid warning message provided');
            return;
        }

        this.#logger.warn(`Warning: ${message}`);
    }

    // ---------- СТАТИСТИКА ----------

    /**
     * Возвращает статистику обработанных событий.
     *
     * @returns {{errorCount: number, successCount: number}}
     */
    getStats() {
        return {
            errorCount: this.#errorCount,
            successCount: this.#successCount
        };
    }

    // ---------- ПРИВАТНЫЕ ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ----------

    /**
     * Проверяет корректность объекта ошибки.
     *
     * @private
     * @param {*} error — объект для проверки
     * @returns {boolean} true, если объект является Error
     */
    #isValidError(error) {
        return error instanceof Error;
    }

    /**
     * Проверяет корректность сообщения.
     *
     * @private
     * @param {*} message — сообщение для проверки
     * @returns {boolean} true, если сообщение является непустой строкой
     */
    #isValidMessage(message) {
        return typeof message === 'string' && message.length > 0;
    }
}

// ============================================
// КЛАСС FALLBACK
// ============================================

/**
 * Обработчик fallback-значений.
 *
 * Предоставляет методы для получения значений с резервными вариантами
 * на случай null, undefined или некорректного типа данных.
 */
class Fallback {
    /** @private @type {Logger} */
    #logger;

    /** @private @type {number} Счётчик использованных fallback-значений */
    #fallbackCount;

    /**
     * Создаёт экземпляр обработчика fallback-значений.
     *
     * @param {Logger} logger — экземпляр логгера
     */
    constructor(logger) {
        if (!logger || typeof logger.debug !== 'function') {
            throw new Error('Logger instance is required');
        }

        this.#logger        = logger;
        this.#fallbackCount = 0;
    }

    // ---------- БАЗОВЫЕ FALLBACK ----------

    /**
     * Возвращает значение или fallback, если значение null/undefined.
     *
     * @param {*}      value    — значение для проверки
     * @param {*}      fallback — резервное значение
     * @returns {*} значение или fallback
     */
    getFallbackValue(value, fallback) {
        if (this.#isNullish(value)) {
            this.#fallbackCount++;
            this.#logger.debug(`Using fallback value: ${fallback}`);
            return fallback;
        }
        return value;
    }

    /**
     * Возвращает базовый URL или резервный URL.
     *
     * @param {string} baseUrl    — базовый URL
     * @param {string} fallbackUrl — резервный URL
     * @returns {string} базовый или резервный URL
     */
    getFallbackUrl(baseUrl, fallbackUrl) {
        return this.getFallbackValue(baseUrl, fallbackUrl);
    }

    // ---------- FALLBACK ПО ТИПАМ ----------

    /**
     * Возвращает строку или fallback, если значение не является непустой строкой.
     *
     * @param {string} value    — строка для проверки
     * @param {string} fallback — резервная строка
     * @returns {string} строка или fallback
     */
    getFallbackString(value, fallback) {
        if (!this.#isNonEmptyString(value)) {
            this.#fallbackCount++;
            this.#logger.debug(`Using fallback string: ${fallback}`);
            return fallback;
        }
        return value;
    }

    /**
     * Возвращает число или fallback, если значение не является валидным числом.
     *
     * @param {number} value    — число для проверки
     * @param {number} fallback — резервное число
     * @returns {number} число или fallback
     */
    getFallbackNumber(value, fallback) {
        if (!this.#isValidNumber(value)) {
            this.#fallbackCount++;
            this.#logger.debug(`Using fallback number: ${fallback}`);
            return fallback;
        }
        return value;
    }

    /**
     * Возвращает массив или fallback, если значение не является массивом.
     *
     * @param {Array} value    — массив для проверки
     * @param {Array} fallback — резервный массив
     * @returns {Array} массив или fallback
     */
    getFallbackArray(value, fallback) {
        if (!Array.isArray(value)) {
            this.#fallbackCount++;
            this.#logger.debug(`Using fallback array`);
            return fallback;
        }
        return value;
    }

    // ---------- СТАТИСТИКА ----------

    /**
     * Возвращает количество использованных fallback-значений.
     *
     * @returns {number}
     */
    getFallbackCount() {
        return this.#fallbackCount;
    }

    // ---------- ПРИВАТНЫЕ ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ----------

    /**
     * Проверяет, является ли значение null или undefined.
     *
     * @private
     * @param {*} value — значение для проверки
     * @returns {boolean} true, если значение null или undefined
     */
    #isNullish(value) {
        return value === null || value === undefined;
    }

    /**
     * Проверяет, является ли значение непустой строкой.
     *
     * @private
     * @param {*} value — значение для проверки
     * @returns {boolean} true, если значение является непустой строкой
     */
    #isNonEmptyString(value) {
        return typeof value === 'string' && value.length > 0;
    }

    /**
     * Проверяет, является ли значение валидным числом.
     *
     * @private
     * @param {*} value — значение для проверки
     * @returns {boolean} true, если значение является валидным числом
     */
    #isValidNumber(value) {
        return !this.#isNullish(value) && !isNaN(value);
    }
}

// ============================================
// КЛАСС HELP
// ============================================

/**
 * Модуль отображения справочной информации.
 *
 * Предоставляет методы для вывода помощи по использованию скрипта
 * и краткой инструкции по синтаксису командной строки.
 */
class Help {
    /** @private @type {string} Текст полной справки */
    static #HELP_TEXT = `
╔════════════════════════════════════════════════════════════╗
║              SITEMAP GENERATOR - HELP                      ║
╚════════════════════════════════════════════════════════════╝

USAGE:
  node sitemap-generator.js [options]

OPTIONS:
  --help, -h          Show this help message
  --version, -v       Show version information
  --faq               Show frequently asked questions
  --base-url <url>    Set base URL (default: https://example.com)
  --output <path>     Set output path (default: sitemap.xml)
  --public <path>     Set public directory (default: public)
  --verbose           Enable verbose logging (DEBUG level)
  --recursive         Scan directories recursively
  --max-depth <n>     Max depth for recursive scan (default: 10)

EXAMPLES:
  node sitemap-generator.js
  node sitemap-generator.js --base-url https://mysite.com
  node sitemap-generator.js --output public/sitemap.xml
  node sitemap-generator.js --public ./dist
  node sitemap-generator.js --verbose --recursive

HOW IT WORKS:
  1. Scans the public/ directory
  2. Finds all folders containing index.html
  3. Generates URLs based on folder names
  4. Filters out excluded patterns (from robots.txt logic)
  5. Writes sitemap.xml

FOR MORE INFO:
  node sitemap-generator.js --faq
        `;

    /** @private @type {string} Краткое сообщение об использовании */
    static #USAGE_MESSAGE = 'Usage: node sitemap-generator.js [options]';

    /** @private @type {string} Подсказка для получения помощи */
    static #HELP_HINT = 'Try --help for more information.';

    /** @private @type {Logger} */
    #logger;

    /**
     * Создаёт экземпляр модуля помощи.
     *
     * @param {Logger} logger — экземпляр логгера
     */
    constructor(logger) {
        if (!logger || typeof logger.info !== 'function') {
            throw new Error('Logger instance is required');
        }

        this.#logger = logger;
    }

    // ---------- ОТОБРАЖЕНИЕ СПРАВКИ ----------

    /**
     * Отображает полную справку по использованию скрипта.
     */
    showHelp() {
        console.log(Help.#HELP_TEXT);
    }

    // ---------- ОТОБРАЖЕНИЕ ИСПОЛЬЗОВАНИЯ ----------

    /**
     * Отображает краткую инструкцию по синтаксису командной строки.
     */
    showUsage() {
        console.log(Help.#USAGE_MESSAGE);
        console.log(Help.#HELP_HINT);
    }
}

// ============================================
// КЛАСС FAQ
// ============================================

/**
 * Модуль отображения часто задаваемых вопросов.
 *
 * Предоставляет метод для вывода справочной информации
 * по работе генератора sitemap и типичным вопросам.
 */
class FAQ {
    /** @private @type {string} Текст часто задаваемых вопросов */
    static #FAQ_TEXT = `
╔════════════════════════════════════════════════════════════╗
║           FREQUENTLY ASKED QUESTIONS                       ║
╚════════════════════════════════════════════════════════════╝

Q: What is a sitemap?
A: A sitemap is an XML file that lists all the URLs of your website.
   It helps search engines discover and index your pages more efficiently.

Q: How does this generator work?
A: It scans the public/ directory for folders containing index.html files
   and generates a sitemap.xml with all the URLs.

Q: Can I exclude certain paths?
A: Yes, you can modify the EXCLUDED_PATTERNS in the CONSTANTS section
   of the code. By default it excludes /api/*, /*.js, /*.json, etc.

Q: What about robots.txt?
A: The generator respects the logic of robots.txt. Pages that would be
   blocked by robots.txt are not included in the sitemap.

Q: How often should I regenerate the sitemap?
A: You should regenerate the sitemap whenever you add or remove pages
   from your website. Consider running it as part of your build process.

Q: Can I customize the priority and changefreq?
A: Yes, you can modify the PRIORITY and CHANGEFREQ values in the
   CONSTANTS section. Valid changefreq values: always, hourly, daily,
   weekly, monthly, yearly, never.

Q: What if I have more than 50,000 URLs?
A: The sitemap protocol limits each file to 50,000 URLs. You'll need
   to create multiple sitemap files and a sitemap index file.

Q: Does this work with dynamic routes?
A: No, this generator only works with static files. For dynamic routes,
   you'll need a different solution (e.g., generate at build time).

Q: Can I use this with Vercel?
A: Yes! This generator works well with Vercel. Just run it before
   deploying, or add it to your build script in package.json.

Q: What if a folder doesn't have index.html?
A: It will be skipped. Only folders with index.html are included
   in the sitemap.

Q: Can I include files, not just folders?
A: The current version focuses on folders with index.html. You can
   extend the Scanner class to include individual files if needed.

Q: Is the sitemap valid XML?
A: Yes, the generated sitemap follows the sitemaps.org schema and
   is valid XML that search engines can parse.

Q: How do I submit the sitemap to search engines?
A: You can submit it via Google Search Console, Yandex Webmaster,
   or add it to your robots.txt: Sitemap: https://yoursite.com/sitemap.xml
        `;

    /** @private @type {Logger} */
    #logger;

    /**
     * Создаёт экземпляр модуля FAQ.
     *
     * @param {Logger} logger — экземпляр логгера
     */
    constructor(logger) {
        if (!logger || typeof logger.info !== 'function') {
            throw new Error('Logger instance is required');
        }

        this.#logger = logger;
    }

    // ---------- ОТОБРАЖЕНИЕ FAQ ----------

    /**
     * Отображает часто задаваемые вопросы.
     */
    showFAQ() {
        console.log(FAQ.#FAQ_TEXT);
    }
}

// ============================================
// КЛАСС ROBOTS PARSER
// ============================================

/**
 * Парсер файла robots.txt.
 *
 * Анализирует директивы Allow и Disallow из robots.txt
 * и предоставляет методы для проверки доступности путей.
 */
class RobotsParser {
    /** @private @type {string} Префикс директивы Disallow */
    static #DISALLOW_PREFIX = 'disallow:';

    /** @private @type {string} Префикс директивы Allow */
    static #ALLOW_PREFIX = 'allow:';

    /** @private @type {number} Длина префикса Disallow */
    static #DISALLOW_PREFIX_LENGTH = 9;

    /** @private @type {number} Длина префикса Allow */
    static #ALLOW_PREFIX_LENGTH = 6;

    /** @private @type {Logger} */
    #logger;

    /** @private @type {string[]} Список запрещённых путей */
    #disallowed;

    /** @private @type {string[]} Список разрешённых путей */
    #allowed;

    /**
     * Создаёт экземпляр парсера robots.txt.
     *
     * @param {Logger} logger — экземпляр логгера
     */
    constructor(logger) {
        if (!logger || typeof logger.info !== 'function') {
            throw new Error('Logger instance is required');
        }

        this.#logger     = logger;
        this.#disallowed = [];
        this.#allowed    = [];
    }

    // ---------- ПАРСИНГ ФАЙЛА ----------

    /**
     * Парсит файл robots.txt по указанному пути.
     *
     * @param {string} robotsPath — путь к файлу robots.txt
     * @returns {{disallowed: string[], allowed: string[]}} результат парсинга
     */
    parseRobotsFile(robotsPath) {
        this.#logger.info(`Parsing robots.txt: ${robotsPath}`);

        if (!fs.existsSync(robotsPath)) {
            this.#logger.warn(`robots.txt not found: ${robotsPath}`);
            return this.#getEmptyResult();
        }

        try {
            const content = fs.readFileSync(robotsPath, 'utf8');
            return this.parseContent(content);
        } catch (error) {
            this.#logger.error(`Error reading robots.txt: ${error.message}`);
            return this.#getEmptyResult();
        }
    }

    /**
     * Парсит содержимое robots.txt из строки.
     *
     * @param {string} content — содержимое файла robots.txt
     * @returns {{disallowed: string[], allowed: string[]}} результат парсинга
     */
    parseContent(content) {
        const lines = content.split('\n');
        const disallowed = [];
        const allowed = [];

        for (const line of lines) {
            this.#parseLine(line, disallowed, allowed);
        }

        this.#disallowed = disallowed;
        this.#allowed    = allowed;

        this.#logger.info(`Parsed ${disallowed.length} disallowed, ${allowed.length} allowed`);
        return { disallowed, allowed };
    }

    // ---------- ПРОВЕРКА ДОСТУПНОСТИ ----------

    /**
     * Проверяет, запрещён ли указанный путь согласно robots.txt.
     *
     * @param {string} path — путь для проверки
     * @returns {boolean} true, если путь запрещён
     */
    isDisallowed(path) {
        for (const pattern of this.#disallowed) {
            if (this.#matchesPattern(path, pattern)) {
                return true;
            }
        }
        return false;
    }

    // ---------- ДОСТУП К ДАННЫМ ----------

    /**
     * Возвращает список запрещённых путей.
     *
     * @returns {string[]} массив запрещённых путей
     */
    getDisallowed() {
        return [...this.#disallowed];
    }

    /**
     * Возвращает список разрешённых путей.
     *
     * @returns {string[]} массив разрешённых путей
     */
    getAllowed() {
        return [...this.#allowed];
    }

    // ---------- ПРИВАТНЫЕ ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ----------

    /**
     * Парсит одну строку robots.txt.
     *
     * @private
     * @param {string}   line       — строка для парсинга
     * @param {string[]} disallowed — массив для запрещённых путей
     * @param {string[]} allowed    — массив для разрешённых путей
     */
    #parseLine(line, disallowed, allowed) {
        const trimmed = line.trim();

        if (this.#isCommentOrEmpty(trimmed)) {
            return;
        }

        const lowerLine = trimmed.toLowerCase();

        if (lowerLine.startsWith(RobotsParser.#DISALLOW_PREFIX)) {
            this.#extractDirective(trimmed, RobotsParser.#DISALLOW_PREFIX_LENGTH, disallowed, 'disallowed');
        } else if (lowerLine.startsWith(RobotsParser.#ALLOW_PREFIX)) {
            this.#extractDirective(trimmed, RobotsParser.#ALLOW_PREFIX_LENGTH, allowed, 'allowed');
        }
    }

    /**
     * Проверяет, является ли строка комментарием или пустой.
     *
     * @private
     * @param {string} line — строка для проверки
     * @returns {boolean} true, если строка комментарий или пустая
     */
    #isCommentOrEmpty(line) {
        return line.startsWith('#') || line.length === 0;
    }

    /**
     * Извлекает директиву из строки и добавляет в соответствующий массив.
     *
     * @private
     * @param {string}   line        — строка с директивой
     * @param {number}   prefixLength — длина префикса директивы
     * @param {string[]} targetArray — массив для добавления пути
     * @param {string}   type        — тип директивы (для логов)
     */
    #extractDirective(line, prefixLength, targetArray, type) {
        const path = line.substring(prefixLength).trim();

        if (path && path !== '/') {
            targetArray.push(path);
            this.#logger.debug(`Found ${type}: ${path}`);
        }
    }

    /**
     * Проверяет соответствие пути паттерну (поддержка glob-стиля с *).
     *
     * @private
     * @param {string} path    — путь для проверки
     * @param {string} pattern — паттерн для сравнения
     * @returns {boolean} true, если путь соответствует паттерну
     */
    #matchesPattern(path, pattern) {
        if (pattern.includes('*')) {
            const regex = this.#buildRegexFromPattern(pattern);
            return regex.test(path);
        }
        return path.startsWith(pattern);
    }

    /**
     * Создаёт регулярное выражение из паттерна с поддержкой *.
     *
     * @private
     * @param {string} pattern — паттерн (может содержать *)
     * @returns {RegExp} регулярное выражение для проверки
     */
    #buildRegexFromPattern(pattern) {
        const regexPattern = pattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*');
        return new RegExp(`^${regexPattern}`);
    }

    /**
     * Возвращает пустой результат парсинга.
     *
     * @private
     * @returns {{disallowed: string[], allowed: string[]}} пустой результат
     */
    #getEmptyResult() {
        return { disallowed: [], allowed: [] };
    }
}

// ============================================
// КЛАСС UTILS
// ============================================

/**
 * Набор утилитарных методов.
 *
 * Предоставляет вспомогательные функции для работы с датами, путями,
 * файлами и другие полезные утилиты.
 */
class Utils {
    /** @private @type {number} Размер килобайта в байтах */
    static #BYTES_IN_KB = 1024;

    /** @private @type {string[]} Единицы измерения размера файла */
    static #SIZE_UNITS = ['Bytes', 'KB', 'MB', 'GB'];

    /** @private @type {Logger} */
    #logger;

    /**
     * Создаёт экземпляр утилит.
     *
     * @param {Logger} logger — экземпляр логгера
     */
    constructor(logger) {
        if (!logger || typeof logger.debug !== 'function') {
            throw new Error('Logger instance is required');
        }

        this.#logger = logger;
    }

    // ---------- РАБОТА С ДАТАМИ ----------

    /**
     * Форматирует дату в формат YYYY-MM-DD.
     *
     * @param {Date|string|number} date — дата для форматирования
     * @returns {string} дата в формате YYYY-MM-DD
     */
    formatDate(date) {
        if (!(date instanceof Date)) {
            date = new Date(date);
        }
        return date.toISOString().split('T')[0];
    }

    /**
     * Возвращает текущую дату в формате YYYY-MM-DD.
     *
     * @returns {string} текущая дата
     */
    getCurrentDate() {
        return this.formatDate(new Date());
    }

    // ---------- РАБОТА С ПУТЯМИ ----------

    /**
     * Нормализует путь, заменяя обратные слэши на прямые.
     *
     * @param {string} inputPath — путь для нормализации
     * @returns {string} нормализованный путь
     */
    normalizePath(inputPath) {
        if (!inputPath) return '';
        return inputPath.replace(/\\/g, '/');
    }

    /**
     * Удаляет завершающий слэш из пути.
     *
     * @param {string} inputPath — путь для обработки
     * @returns {string} путь без завершающего слэша
     */
    removeTrailingSlash(inputPath) {
        if (!inputPath) return '';
        if (inputPath.endsWith('/')) {
            return inputPath.slice(0, -1);
        }
        return inputPath;
    }

    /**
     * Добавляет начальный слэш к пути, если его нет.
     *
     * @param {string} inputPath — путь для обработки
     * @returns {string} путь с начальным слэшем
     */
    addLeadingSlash(inputPath) {
        if (!inputPath) return '/';
        if (!inputPath.startsWith('/')) {
            return '/' + inputPath;
        }
        return inputPath;
    }

    /**
     * Удаляет начальный слэш из пути.
     *
     * @param {string} inputPath — путь для обработки
     * @returns {string} путь без начального слэша
     */
    removeLeadingSlash(inputPath) {
        if (!inputPath) return '';
        if (inputPath.startsWith('/')) {
            return inputPath.slice(1);
        }
        return inputPath;
    }

    /**
     * Объединяет базовый URL и путь.
     *
     * @param {string} base — базовый URL
     * @param {string} path — путь для добавления
     * @returns {string} объединённый URL
     */
    joinUrl(base, path) {
        base = this.removeTrailingSlash(base);
        path = this.addLeadingSlash(path);
        return base + path;
    }

    // ---------- ФАЙЛОВЫЕ ОПЕРАЦИИ ----------

    /**
     * Получает размер файла в байтах.
     *
     * @param {string} filePath — путь к файлу
     * @returns {number} размер файла в байтах (0 при ошибке)
     */
    getFileSize(filePath) {
        try {
            const stats = fs.statSync(filePath);
            return stats.size;
        } catch (error) {
            return 0;
        }
    }

    /**
     * Форматирует размер файла в человекочитаемый вид.
     *
     * @param {number} bytes — размер в байтах
     * @returns {string} форматированный размер (например, "1.5 MB")
     */
    formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';
        
        const i = Math.floor(Math.log(bytes) / Math.log(Utils.#BYTES_IN_KB));
        const size = Math.round(bytes / Math.pow(Utils.#BYTES_IN_KB, i) * 100) / 100;
        
        return `${size} ${Utils.#SIZE_UNITS[i]}`;
    }

    // ---------- ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ----------

    /**
     * Создаёт задержку выполнения.
     *
     * @param {number} ms — время задержки в миллисекундах
     * @returns {Promise<void>} промис, который разрешится через указанное время
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Генерирует уникальный идентификатор.
     *
     * @returns {string} случайный идентификатор
     */
    generateId() {
        return Math.random().toString(36).substring(2, 15);
    }
}

// ============================================
// ОСНОВНОЙ КЛАСС SITEMAP GENERATOR
// ============================================

/**
 * @typedef {Object} SitemapConfig
 * @property {string}   [publicDir]        — директория со статикой
 * @property {string}   [outputFile]       — путь к выходному файлу sitemap
 * @property {string}   [baseUrl]          — базовый URL сайта
 * @property {string}   [logLevel]         — уровень логирования
 * @property {string[]} [excludedPatterns] — паттерны исключений
 * @property {boolean}  [recursive]        — рекурсивное сканирование
 * @property {number}   [maxDepth]         — максимальная глубина рекурсии
 */

/**
 * Основной генератор sitemap.
 *
 * Координирует работу всех компонентов: сканирование, фильтрацию,
 * сортировку, генерацию URL, форматирование и запись sitemap.xml.
 */
class SitemapGenerator {
    /** @private @type {SitemapConfig} Конфигурация генератора */
    #config;

    /** @private @type {Logger} */
    #logger;

    /** @private @type {Validator} */
    #validator;

    /** @private @type {Scanner} */
    #scanner;

    /** @private @type {Filter} */
    #filter;

    /** @private @type {Sorter} */
    #sorter;

    /** @private @type {Generator} */
    #generator;

    /** @private @type {Formatter} */
    #formatter;

    /** @private @type {Writer} */
    #writer;

    /** @private @type {Handler} */
    #handler;

    /** @private @type {Fallback} */
    #fallback;

    /** @private @type {Help} */
    #help;

    /** @private @type {FAQ} */
    #faq;

    /** @private @type {Utils} */
    #utils;

    /** @private @type {RobotsParser} */
    #robotsParser;

    /**
     * Создаёт экземпляр генератора sitemap.
     *
     * @param {SitemapConfig} [config={}] — конфигурация генератора
     */
    constructor(config = {}) {
        this.#config = this.#buildConfig(config);
        this.#initializeComponents();

        this.#logger.info('SitemapGenerator initialized');
        this.#logger.debug(`Config: ${JSON.stringify(this.#config)}`);
    }

    // ---------- ГЕНЕРАЦИЯ SITEMAP ----------

    /**
     * Запускает процесс генерации sitemap.
     *
     * @returns {boolean} true, если генерация успешна
     */
    generate() {
        this.#logger.info('Starting sitemap generation');
        this.#logConfig();

        try {
            if (!this.#validateBaseUrl()) {
                return false;
            }

            const allExcluded = this.#mergeExcludedPatterns();
            const entries = this.#scanEntries();

            if (entries.length === 0) {
                this.#logger.warn('No entries found');
                return false;
            }

            const filtered = this.#processEntries(entries, allExcluded);

            if (filtered.length === 0) {
                this.#logger.warn('No entries after filtering');
                return false;
            }

            const urls = this.#generateUrls(filtered);

            if (urls.length === 0) {
                this.#logger.warn('No URLs generated');
                return false;
            }

            this.#checkUrlLimit(urls.length);

            return this.#formatAndWrite(urls);
        } catch (error) {
            this.#handler.handleError(error, 'generate');
            return false;
        }
    }

    // ---------- СТАТИСТИКА ----------

    /**
     * Выводит статистику генерации в лог.
     */
    printStats() {
        this.#logger.info('=== GENERATION STATS ===');
        this.#logger.info(`Scans: ${this.#scanner.getScanCount()}`);
        this.#logger.info(`Validations: ${this.#validator.getStats().validationCount}`);
        this.#logger.info(`Validation errors: ${this.#validator.getStats().errorCount}`);
        this.#logger.info(`Filters: ${this.#filter.getFilterCount()}`);
        this.#logger.info(`Sorts: ${this.#sorter.getSortCount()}`);
        this.#logger.info(`Generated URLs: ${this.#generator.getGeneratedCount()}`);
        this.#logger.info(`Formats: ${this.#formatter.getFormatCount()}`);
        this.#logger.info(`Writes: ${this.#writer.getWriteCount()}`);
        this.#logger.info(`Fallbacks: ${this.#fallback.getFallbackCount()}`);
        this.#logger.info(`Log entries: ${this.#logger.getLogCount()}`);
        this.#logger.info(`Elapsed time: ${this.#logger.getElapsedTime()}ms`);
        this.#logger.info('========================');
    }

    // ---------- ПРИВАТНЫЕ ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ----------

    /**
     * Строит конфигурацию с дефолтными значениями.
     *
     * @private
     * @param {SitemapConfig} config — пользовательская конфигурация
     * @returns {SitemapConfig} полная конфигурация
     */
    #buildConfig(config) {
        return {
            publicDir: config.publicDir || CONSTANTS.PUBLIC_DIR,
            outputFile: config.outputFile || CONSTANTS.SITEMAP_FILE,
            baseUrl: config.baseUrl || CONSTANTS.BASE_URL,
            logLevel: config.logLevel || 'INFO',
            excludedPatterns: config.excludedPatterns || CONSTANTS.EXCLUDED_PATTERNS,
            recursive: config.recursive || false,
            maxDepth: config.maxDepth || 10
        };
    }

    /**
     * Инициализирует все компоненты генератора.
     *
     * @private
     */
    #initializeComponents() {
        this.#logger       = new Logger(this.#config.logLevel);
        this.#validator    = new Validator(this.#logger);
        this.#scanner      = new Scanner(this.#logger, this.#validator);
        this.#filter       = new Filter(this.#logger);
        this.#sorter       = new Sorter(this.#logger);
        this.#generator    = new Generator(this.#logger, this.#config.baseUrl);
        this.#formatter    = new Formatter(this.#logger);
        this.#writer       = new Writer(this.#logger);
        this.#handler      = new Handler(this.#logger);
        this.#fallback     = new Fallback(this.#logger);
        this.#help         = new Help(this.#logger);
        this.#faq          = new FAQ(this.#logger);
        this.#utils        = new Utils(this.#logger);
        this.#robotsParser = new RobotsParser(this.#logger);
    }

    /**
     * Логирует конфигурацию генератора.
     *
     * @private
     */
    #logConfig() {
        this.#logger.info(`Public directory: ${this.#config.publicDir}`);
        this.#logger.info(`Output file: ${this.#config.outputFile}`);
        this.#logger.info(`Base URL: ${this.#config.baseUrl}`);
        this.#logger.info(`Recursive: ${this.#config.recursive}`);
    }

    /**
     * Валидирует базовый URL.
     *
     * @private
     * @returns {boolean} true, если URL валиден
     */
    #validateBaseUrl() {
        if (!this.#validator.validateUrl(this.#config.baseUrl)) {
            this.#logger.error('Invalid base URL');
            return false;
        }
        return true;
    }

    /**
     * Объединяет паттерны исключений из конфигурации и robots.txt.
     *
     * @private
     * @returns {string[]} объединённый массив паттернов
     */
    #mergeExcludedPatterns() {
        const robotsPath = path.join(this.#config.publicDir, CONSTANTS.ROBOTS_FILE);
        const robotsData = this.#robotsParser.parseRobotsFile(robotsPath);

        return [
            ...this.#config.excludedPatterns,
            ...robotsData.disallowed
        ];
    }

    /**
     * Сканирует директорию в соответствии с конфигурацией.
     *
     * @private
     * @returns {ScanEntry[]} массив найденных записей
     */
    #scanEntries() {
        if (this.#config.recursive) {
            return this.#scanner.scanRecursive(
                this.#config.publicDir,
                0,
                this.#config.maxDepth
            );
        }
        return this.#scanner.scanDirectory(this.#config.publicDir);
    }

    /**
     * Обрабатывает записи: фильтрует по типу и паттернам, сортирует.
     *
     * @private
     * @param {ScanEntry[]} entries      — массив записей
     * @param {string[]}    allExcluded  — паттерны исключений
     * @returns {ScanEntry[]} обработанные записи
     */
    #processEntries(entries, allExcluded) {
        const directories = this.#filter.filterByType(entries, 'directory');
        const filtered = this.#filter.filterEntries(directories, allExcluded);
        return this.#sorter.sortEntries(filtered, 'name', 'asc');
    }

    /**
     * Генерирует URL для записей.
     *
     * @private
     * @param {ScanEntry[]} entries — массив записей
     * @returns {SitemapUrl[]} массив сгенерированных URL
     */
    #generateUrls(entries) {
        return this.#generator.generateUrls(entries);
    }

    /**
     * Проверяет, не превышает ли количество URL лимит.
     *
     * @private
     * @param {number} urlCount — количество URL
     */
    #checkUrlLimit(urlCount) {
        if (urlCount > CONSTANTS.MAX_URLS) {
            this.#logger.warn(`URL count (${urlCount}) exceeds limit (${CONSTANTS.MAX_URLS})`);
        }
    }

    /**
     * Форматирует sitemap и записывает в файл.
     *
     * @private
     * @param {SitemapUrl[]} urls — массив URL
     * @returns {boolean} true, если запись успешна
     */
    #formatAndWrite(urls) {
        const sitemap = this.#formatter.formatSitemap(urls);
        const success = this.#writer.writeSitemap(sitemap, this.#config.outputFile);

        if (success) {
            const fileSize = this.#utils.getFileSize(this.#config.outputFile);
            this.#handler.handleSuccess(
                `Sitemap generated with ${urls.length} URLs (${this.#utils.formatBytes(fileSize)})`
            );
            this.printStats();
            return true;
        }

        this.#logger.error('Failed to write sitemap');
        return false;
    }
}

// ============================================
// ОБРАБОТКА АРГУМЕНТОВ КОМАНДНОЙ СТРОКИ
// ============================================

/**
 * Парсер аргументов командной строки.
 *
 * Анализирует аргументы командной строки и формирует конфигурацию
 * для генератора sitemap. Поддерживает флаги и аргументы со значениями.
 */
class ArgsParser {
    /** @private @type {Object} Маппинг аргументов командной строки */
    static #ARGS = {
        HELP: { short: '-h', long: '--help', hasValue: false },
        VERSION: { short: '-v', long: '--version', hasValue: false },
        FAQ: { short: null, long: '--faq', hasValue: false },
        BASE_URL: { short: null, long: '--base-url', hasValue: true },
        OUTPUT: { short: null, long: '--output', hasValue: true },
        PUBLIC: { short: null, long: '--public', hasValue: true },
        MAX_DEPTH: { short: null, long: '--max-depth', hasValue: true },
        VERBOSE: { short: null, long: '--verbose', hasValue: false },
        RECURSIVE: { short: null, long: '--recursive', hasValue: false }
    };

    /** @private @type {Logger} */
    #logger;

    /**
     * Создаёт экземпляр парсера аргументов.
     *
     * @param {Logger} [logger] — экземпляр логгера (опционально)
     */
    constructor(logger = null) {
        this.#logger = logger;
    }

    // ---------- ПУБЛИЧНЫЕ МЕТОДЫ ----------

    /**
     * Парсит аргументы командной строки и возвращает конфигурацию.
     *
     * @returns {SitemapConfig} конфигурация генератора
     */
    parse() {
        const args = process.argv.slice(2);
        const config = {};

        for (let i = 0; i < args.length; i++) {
            const arg = args[i];

            if (this.#isHelpFlag(arg)) {
                this.#showHelpAndExit();
            }

            if (this.#isVersionFlag(arg)) {
                this.#showVersionAndExit();
            }

            if (this.#isFaqFlag(arg)) {
                this.#showFaqAndExit();
            }

            if (this.#isBaseUrlArg(arg, args, i)) {
                config.baseUrl = args[i + 1];
                i++;
                continue;
            }

            if (this.#isOutputArg(arg, args, i)) {
                config.outputFile = args[i + 1];
                i++;
                continue;
            }

            if (this.#isPublicArg(arg, args, i)) {
                config.publicDir = args[i + 1];
                i++;
                continue;
            }

            if (this.#isMaxDepthArg(arg, args, i)) {
                const depth = this.#parseMaxDepth(args[i + 1]);
                if (depth !== null) {
                    config.maxDepth = depth;
                }
                i++;
                continue;
            }

            if (this.#isVerboseFlag(arg)) {
                config.logLevel = 'DEBUG';
                continue;
            }

            if (this.#isRecursiveFlag(arg)) {
                config.recursive = true;
                continue;
            }

            this.#logUnknownArg(arg);
        }

        return config;
    }

    // ---------- ПРИВАТНЫЕ МЕТОДЫ ПРОВЕРКИ ФЛАГОВ ----------

    /**
     * Проверяет, является ли аргумент флагом помощи.
     *
     * @private
     * @param {string} arg — аргумент для проверки
     * @returns {boolean}
     */
    #isHelpFlag(arg) {
        return arg === ArgsParser.#ARGS.HELP.short || 
               arg === ArgsParser.#ARGS.HELP.long;
    }

    /**
     * Проверяет, является ли аргумент флагом версии.
     *
     * @private
     * @param {string} arg — аргумент для проверки
     * @returns {boolean}
     */
    #isVersionFlag(arg) {
        return arg === ArgsParser.#ARGS.VERSION.short || 
               arg === ArgsParser.#ARGS.VERSION.long;
    }

    /**
     * Проверяет, является ли аргумент флагом FAQ.
     *
     * @private
     * @param {string} arg — аргумент для проверки
     * @returns {boolean}
     */
    #isFaqFlag(arg) {
        return arg === ArgsParser.#ARGS.FAQ.long;
    }

    /**
     * Проверяет, является ли аргумент флагом verbose.
     *
     * @private
     * @param {string} arg — аргумент для проверки
     * @returns {boolean}
     */
    #isVerboseFlag(arg) {
        return arg === ArgsParser.#ARGS.VERBOSE.long;
    }

    /**
     * Проверяет, является ли аргумент флагом recursive.
     *
     * @private
     * @param {string} arg — аргумент для проверки
     * @returns {boolean}
     */
    #isRecursiveFlag(arg) {
        return arg === ArgsParser.#ARGS.RECURSIVE.long;
    }

    // ---------- ПРИВАТНЫЕ МЕТОДЫ ПРОВЕРКИ АРГУМЕНТОВ СО ЗНАЧЕНИЯМИ ----------

    /**
     * Проверяет, является ли аргумент флагом base-url с значением.
     *
     * @private
     * @param {string}   arg   — текущий аргумент
     * @param {string[]} args  — все аргументы
     * @param {number}   index — текущий индекс
     * @returns {boolean}
     */
    #isBaseUrlArg(arg, args, index) {
        return this.#hasValueArg(arg, args, index, ArgsParser.#ARGS.BASE_URL.long);
    }

    /**
     * Проверяет, является ли аргумент флагом output с значением.
     *
     * @private
     * @param {string}   arg   — текущий аргумент
     * @param {string[]} args  — все аргументы
     * @param {number}   index — текущий индекс
     * @returns {boolean}
     */
    #isOutputArg(arg, args, index) {
        return this.#hasValueArg(arg, args, index, ArgsParser.#ARGS.OUTPUT.long);
    }

    /**
     * Проверяет, является ли аргумент флагом public с значением.
     *
     * @private
     * @param {string}   arg   — текущий аргумент
     * @param {string[]} args  — все аргументы
     * @param {number}   index — текущий индекс
     * @returns {boolean}
     */
    #isPublicArg(arg, args, index) {
        return this.#hasValueArg(arg, args, index, ArgsParser.#ARGS.PUBLIC.long);
    }

    /**
     * Проверяет, является ли аргумент флагом max-depth с значением.
     *
     * @private
     * @param {string}   arg   — текущий аргумент
     * @param {string[]} args  — все аргументы
     * @param {number}   index — текущий индекс
     * @returns {boolean}
     */
    #isMaxDepthArg(arg, args, index) {
        return this.#hasValueArg(arg, args, index, ArgsParser.#ARGS.MAX_DEPTH.long);
    }

    /**
     * Проверяет, является ли аргумент флагом с ожидаемым значением.
     *
     * @private
     * @param {string}   arg          — текущий аргумент
     * @param {string[]} args         — все аргументы
     * @param {number}   index        — текущий индекс
     * @param {string}   expectedFlag — ожидаемый флаг
     * @returns {boolean}
     */
    #hasValueArg(arg, args, index, expectedFlag) {
        return arg === expectedFlag && index + 1 < args.length;
    }

    // ---------- ПРИВАТНЫЕ МЕТОДЫ ДЕЙСТВИЙ ----------

    /**
     * Показывает справку и завершает программу.
     *
     * @private
     */
    #showHelpAndExit() {
        const help = new Help(this.#getOrCreateLogger());
        help.showHelp();
        process.exit(0);
    }

    /**
     * Показывает версию и завершает программу.
     *
     * @private
     */
    #showVersionAndExit() {
        console.log(`Sitemap Generator v${CONSTANTS.VERSION}`);
        console.log(`Author: ${CONSTANTS.AUTHOR}`);
        console.log(`Description: ${CONSTANTS.DESCRIPTION}`);
        process.exit(0);
    }

    /**
     * Показывает FAQ и завершает программу.
     *
     * @private
     */
    #showFaqAndExit() {
        const faq = new FAQ(this.#getOrCreateLogger());
        faq.showFAQ();
        process.exit(0);
    }

    /**
     * Парсит значение максимальной глубины.
     *
     * @private
     * @param {string} value — строковое значение
     * @returns {number|null} число или null при ошибке
     */
    #parseMaxDepth(value) {
        const depth = parseInt(value, 10);
        
        if (isNaN(depth) || depth < 0) {
            this.#logInvalidMaxDepth(value);
            return null;
        }
        
        return depth;
    }

    /**
     * Логирует неизвестный аргумент.
     *
     * @private
     * @param {string} arg — неизвестный аргумент
     */
    #logUnknownArg(arg) {
        if (this.#logger) {
            this.#logger.warn(`Unknown argument: ${arg}`);
        }
    }

    /**
     * Логирует некорректное значение max-depth.
     *
     * @private
     * @param {string} value — некорректное значение
     */
    #logInvalidMaxDepth(value) {
        if (this.#logger) {
            this.#logger.warn(`Invalid max-depth value: ${value}. Must be a non-negative integer.`);
        }
    }

    /**
     * Возвращает существующий логгер или создаёт новый.
     *
     * @private
     * @returns {Logger} экземпляр логгера
     */
    #getOrCreateLogger() {
        return this.#logger || new Logger();
    }
}

/**
 * Парсит аргументы командной строки и возвращает конфигурацию.
 *
 * @returns {SitemapConfig} конфигурация генератора
 */
function parseArgs() {
    const parser = new ArgsParser();
    return parser.parse();
}

// ============================================
// ТОЧКА ВХОДА
// ============================================

/**
 * Точка входа в приложение.
 *
 * Координирует запуск генератора sitemap: отображает баннер,
 * парсит аргументы командной строки, запускает генерацию
 * и обрабатывает результат.
 */
class EntryPoint {
    /** @private @type {string} Ширина баннера */
    static #BANNER_WIDTH = 60;

    /** @private @type {number} Код успешного завершения */
    static #EXIT_SUCCESS = 0;

    /** @private @type {number} Код завершения с ошибкой */
    static #EXIT_FAILURE = 1;

    /**
     * Создаёт экземпляр точки входа.
     */
    constructor() {
        // Конструктор пуст, так как все методы статические
    }

    // ---------- ПУБЛИЧНЫЕ МЕТОДЫ ----------

    /**
     * Запускает приложение.
     */
    run() {
        this.#displayBanner();
        
        const config = this.#parseArguments();
        const generator = this.#createGenerator(config);
        const success = this.#runGenerator(generator);
        
        this.#handleResult(success);
    }

    // ---------- ПРИВАТНЫЕ МЕТОДЫ ОТОБРАЖЕНИЯ ----------

    /**
     * Отображает стартовый баннер приложения.
     *
     * @private
     */
    #displayBanner() {
        console.log('');
        console.log('╔════════════════════════════════════════════════════════════╗');
        console.log(`║  Sitemap Generator v${CONSTANTS.VERSION}                               ║`);
        console.log('╚════════════════════════════════════════════════════════════╝');
        console.log('');
    }

    // ---------- ПРИВАТНЫЕ МЕТОДЫ ИНИЦИАЛИЗАЦИИ ----------

    /**
     * Парсит аргументы командной строки.
     *
     * @private
     * @returns {SitemapConfig} конфигурация генератора
     */
    #parseArguments() {
        return parseArgs();
    }

    /**
     * Создаёт экземпляр генератора sitemap.
     *
     * @private
     * @param {SitemapConfig} config — конфигурация генератора
     * @returns {SitemapGenerator} экземпляр генератора
     */
    #createGenerator(config) {
        return new SitemapGenerator(config);
    }

    /**
     * Запускает процесс генерации sitemap.
     *
     * @private
     * @param {SitemapGenerator} generator — экземпляр генератора
     * @returns {boolean} true, если генерация успешна
     */
    #runGenerator(generator) {
        return generator.generate();
    }

    // ---------- ПРИВАТНЫЕ МЕТОДЫ ОБРАБОТКИ РЕЗУЛЬТАТА ----------

    /**
     * Обрабатывает результат генерации и завершает программу.
     *
     * @private
     * @param {boolean} success — флаг успешности генерации
     */
    #handleResult(success) {
        console.log('');

        if (success) {
            this.#exitWithSuccess();
        } else {
            this.#exitWithFailure();
        }
    }

    /**
     * Завершает программу с кодом успеха.
     *
     * @private
     */
    #exitWithSuccess() {
        console.log('✓ Sitemap generated successfully');
        process.exit(EntryPoint.#EXIT_SUCCESS);
    }

    /**
     * Завершает программу с кодом ошибки.
     *
     * @private
     */
    #exitWithFailure() {
        console.log('✗ Failed to generate sitemap');
        process.exit(EntryPoint.#EXIT_FAILURE);
    }
}

/**
 * Основная функция запуска приложения.
 *
 * Создаёт точку входа и запускает приложение.
 */
function main() {
    const entryPoint = new EntryPoint();
    entryPoint.run();
}

// ============================================
// ЗАПУСК ПРИЛОЖЕНИЯ
// ============================================

// Запуск, если файл выполняется напрямую
if (require.main === module) {
    main();
}

// ============================================
// ЭКСПОРТ МОДУЛЕЙ
// ============================================

/**
 * @exports SitemapGenerator Основной генератор sitemap
 * @exports Logger Логгер с уровнями важности
 * @exports Validator Валидатор путей, URL, файлов и директорий
 * @exports Scanner Сканер файловой системы
 * @exports Filter Фильтр записей файловой системы
 * @exports Sorter Сортировщик записей
 * @exports Generator Генератор URL для sitemap
 * @exports Formatter Форматировщик sitemap в XML
 * @exports Writer Записыватель sitemap в файл
 * @exports Handler Обработчик событий и ошибок
 * @exports Fallback Обработчик fallback-значений
 * @exports Help Модуль отображения справочной информации
 * @exports FAQ Модуль отображения часто задаваемых вопросов
 * @exports RobotsParser Парсер файла robots.txt
 * @exports Utils Набор утилитарных методов
 * @exports CONSTANTS Константы приложения
 */
module.exports = {
    SitemapGenerator,
    Logger,
    Validator,
    Scanner,
    Filter,
    Sorter,
    Generator,
    Formatter,
    Writer,
    Handler,
    Fallback,
    Help,
    FAQ,
    RobotsParser,
    Utils,
    CONSTANTS
};