// ============================================================================
// SITEMAP & ROBOTS.TXT GENERATOR
// ============================================================================
// Version: 1.0.0
// Description: Генератор sitemap.xml и robots.txt для платформы Oris
// Platform: Vercel / Node.js
// Domain: https://oris-flax.vercel.app
// ============================================================================

'use strict';

// ============================================================================
// МОДУЛИ И ЗАВИСИМОСТИ
// ============================================================================

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================================
// КОНФИГУРАЦИЯ
// ============================================================================

const CONFIG = {
    // Домен и протокол
    DOMAIN: process.env.DOMAIN || 'oris-flax.vercel.app',
    PROTOCOL: 'https',
    
    // Пути
    PUBLIC_DIR: path.join(__dirname, 'public'),
    OUTPUT_DIR: path.join(__dirname, 'public'),
    
    // Имена файлов
    SITEMAP_FILENAME: 'sitemap.xml',
    ROBOTS_FILENAME: 'robots.txt',
    
    // Приоритеты по умолчанию
    DEFAULT_PRIORITY: 0.5,
    HOMEPAGE_PRIORITY: 1.0,
    IMPORTANT_PAGES_PRIORITY: 0.8,
    
    // Частота изменений
    DEFAULT_CHANGEFREQ: 'monthly',
    HOMEPAGE_CHANGEFREQ: 'daily',
    DYNAMIC_CONTENT_CHANGEFREQ: 'weekly',
    
    // Исключения для robots.txt
    DISALLOWED_PATHS: [
        '/api/',
        '/admin/',
        '/private/',
        '/*.json$',
        '/*.txt$',
        '/downloader/',
        '/temp/',
        '/cache/'
    ],
    
    // Sitemap настройки
    SITEMAP_INDEX_LIMIT: 50000, // Максимум URL на один sitemap
    INCLUDE_LASTMOD: true,
    INCLUDE_CHANGEFREQ: true,
    INCLUDE_PRIORITY: true,
    
    // Логирование
    LOG_LEVEL: process.env.LOG_LEVEL || 'info', // debug, info, warn, error
    LOG_FILE: path.join(__dirname, 'logs', 'sitemap-generator.log'),
    
    // Кэширование
    CACHE_TTL: 300000, // 5 минут
    ENABLE_CACHE: true
};

// ============================================================================
// СИСТЕМА ЛОГИРОВАНИЯ
// ============================================================================

class Logger {
    constructor(config) {
        this.config = config;
        this.logLevels = {
            debug: 0,
            info: 1,
            warn: 2,
            error: 3
        };
        this.currentLevel = this.logLevels[config.LOG_LEVEL] || 1;
        this.ensureLogDirectory();
    }
    
    ensureLogDirectory() {
        const logDir = path.dirname(this.config.LOG_FILE);
        if (!fsSync.existsSync(logDir)) {
            try {
                fsSync.mkdirSync(logDir, { recursive: true });
                this.writeToConsole('info', `[Logger] Log directory created: ${logDir}`);
            } catch (err) {
                this.writeToConsole('error', `[Logger] Failed to create log directory: ${err.message}`);
            }
        }
    }
    
    writeToConsole(level, message) {
        const timestamp = new Date().toISOString();
        const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
        
        switch (level) {
            case 'error':
                console.error(`${prefix} ${message}`);
                break;
            case 'warn':
                console.warn(`${prefix} ${message}`);
                break;
            default:
                console.log(`${prefix} ${message}`);
        }
    }
    
    async writeToFile(message) {
        try {
            await fs.appendFile(this.config.LOG_FILE, message + '\n', 'utf8');
        } catch (err) {
            this.writeToConsole('error', `[Logger] Failed to write to log file: ${err.message}`);
        }
    }
    
    async log(level, message, data = null) {
        if (this.logLevels[level] < this.currentLevel) {
            return;
        }
        
        let formattedMessage = message;
        if (data !== null) {
            formattedMessage += ` ${JSON.stringify(data, null, 2)}`;
        }
        
        this.writeToConsole(level, formattedMessage);
        await this.writeToFile(formattedMessage);
    }
    
    async debug(message, data = null) {
        await this.log('debug', message, data);
    }
    
    async info(message, data = null) {
        await this.log('info', message, data);
    }
    
    async warn(message, data = null) {
        await this.log('warn', message, data);
    }
    
    async error(message, data = null) {
        await this.log('error', message, data);
    }
}

// ============================================================================
// СЕРВИС КЭШИРОВАНИЯ
// ============================================================================

class CacheService {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.cache = new Map();
        this.enabled = config.ENABLE_CACHE;
    }
    
    generateKey(...args) {
        const keyString = args.join(':');
        return crypto.createHash('sha256').update(keyString).digest('hex');
    }
    
    async get(key) {
        if (!this.enabled) {
            await this.logger.debug('Cache disabled, skipping get');
            return null;
        }
        
        const cacheKey = this.generateKey(key);
        const cached = this.cache.get(cacheKey);
        
        if (!cached) {
            await this.logger.debug(`Cache miss for key: ${key}`);
            return null;
        }
        
        const now = Date.now();
        const age = now - cached.timestamp;
        
        if (age > this.config.CACHE_TTL) {
            await this.logger.debug(`Cache expired for key: ${key}, age: ${age}ms`);
            this.cache.delete(cacheKey);
            return null;
        }
        
        await this.logger.debug(`Cache hit for key: ${key}, age: ${age}ms`);
        return cached.data;
    }
    
    async set(key, data) {
        if (!this.enabled) {
            await this.logger.debug('Cache disabled, skipping set');
            return;
        }
        
        const cacheKey = this.generateKey(key);
        this.cache.set(cacheKey, {
            data: data,
            timestamp: Date.now()
        });
        
        await this.logger.debug(`Cache set for key: ${key}`);
    }
    
    async clear() {
        const size = this.cache.size;
        this.cache.clear();
        await this.logger.info(`Cache cleared, removed ${size} entries`);
    }
    
    async getStats() {
        return {
            size: this.cache.size,
            enabled: this.enabled,
            ttl: this.config.CACHE_TTL
        };
    }
}

// ============================================================================
// СЕРВИС РАБОТЫ С ФАЙЛОВОЙ СИСТЕМОЙ
// ============================================================================

class FileSystemService {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
    }
    
    async ensureDirectoryExists(dirPath) {
        try {
            await fs.mkdir(dirPath, { recursive: true });
            await this.logger.debug(`Directory ensured: ${dirPath}`);
        } catch (err) {
            await this.logger.error(`Failed to create directory: ${dirPath}`, { error: err.message });
            throw err;
        }
    }
    
    async readFile(filePath, encoding = 'utf8') {
        try {
            const content = await fs.readFile(filePath, encoding);
            await this.logger.debug(`File read successfully: ${filePath}`);
            return content;
        } catch (err) {
            await this.logger.error(`Failed to read file: ${filePath}`, { error: err.message });
            throw err;
        }
    }
    
    async writeFile(filePath, content, encoding = 'utf8') {
        try {
            await this.ensureDirectoryExists(path.dirname(filePath));
            await fs.writeFile(filePath, content, encoding);
            await this.logger.info(`File written successfully: ${filePath}`);
        } catch (err) {
            await this.logger.error(`Failed to write file: ${filePath}`, { error: err.message });
            throw err;
        }
    }
    
    async fileExists(filePath) {
        try {
            await fs.access(filePath, fsSync.constants.F_OK);
            return true;
        } catch (err) {
            return false;
        }
    }
    
    async getFileInfo(filePath) {
        try {
            const stats = await fs.stat(filePath);
            return {
                size: stats.size,
                modified: stats.mtime,
                created: stats.birthtime,
                isFile: stats.isFile(),
                isDirectory: stats.isDirectory()
            };
        } catch (err) {
            await this.logger.error(`Failed to get file info: ${filePath}`, { error: err.message });
            return null;
        }
    }
    
    async deleteFile(filePath) {
        try {
            await fs.unlink(filePath);
            await this.logger.debug(`File deleted: ${filePath}`);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                await this.logger.error(`Failed to delete file: ${filePath}`, { error: err.message });
                throw err;
            }
        }
    }
    
    async readDirectory(dirPath, options = { recursive: false }) {
        try {
            if (options.recursive) {
                return await this.readDirectoryRecursive(dirPath);
            }
            
            const items = await fs.readdir(dirPath, { withFileTypes: true });
            await this.logger.debug(`Directory read: ${dirPath}, items: ${items.length}`);
            return items;
        } catch (err) {
            await this.logger.error(`Failed to read directory: ${dirPath}`, { error: err.message });
            throw err;
        }
    }
    
    async readDirectoryRecursive(dirPath, basePath = '') {
        const results = [];
        
        try {
            const items = await fs.readdir(dirPath, { withFileTypes: true });
            
            for (const item of items) {
                const fullPath = path.join(dirPath, item.name);
                const relativePath = basePath ? path.join(basePath, item.name) : item.name;
                
                if (item.isDirectory()) {
                    const subItems = await this.readDirectoryRecursive(fullPath, relativePath);
                    results.push(...subItems);
                } else {
                    results.push({
                        name: item.name,
                        path: fullPath,
                        relativePath: relativePath,
                        isDirectory: false
                    });
                }
            }
            
            return results;
        } catch (err) {
            await this.logger.error(`Failed to read directory recursively: ${dirPath}`, { error: err.message });
            throw err;
        }
    }
}

// ============================================================================
// СЕРВИС ПАРСИНГА HTML
// ============================================================================

class HTMLParserService {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
    }
    
    async extractMetadata(htmlContent) {
        const metadata = {
            title: null,
            description: null,
            keywords: null,
            lastModified: null,
            changefreq: null,
            priority: null,
            robots: null
        };
        
        try {
            // Извлечение title
            const titleMatch = htmlContent.match(/<title[^>]*>([^<]*)<\/title>/i);
            if (titleMatch && titleMatch[1]) {
                metadata.title = this.cleanText(titleMatch[1]);
            }
            
            // Извлечение meta description
            const descMatch = htmlContent.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i);
            if (descMatch && descMatch[1]) {
                metadata.description = this.cleanText(descMatch[1]);
            }
            
            // Альтернативный формат meta description
            if (!metadata.description) {
                const altDescMatch = htmlContent.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i);
                if (altDescMatch && altDescMatch[1]) {
                    metadata.description = this.cleanText(altDescMatch[1]);
                }
            }
            
            // Извлечение meta keywords
            const keywordsMatch = htmlContent.match(/<meta[^>]*name=["']keywords["'][^>]*content=["']([^"']*)["'][^>]*>/i);
            if (keywordsMatch && keywordsMatch[1]) {
                metadata.keywords = this.cleanText(keywordsMatch[1]);
            }
            
            // Извлечение last-modified
            const lastModMatch = htmlContent.match(/<meta[^>]*name=["']last-modified["'][^>]*content=["']([^"']*)["'][^>]*>/i);
            if (lastModMatch && lastModMatch[1]) {
                metadata.lastModified = this.parseDate(lastModMatch[1]);
            }
            
            // Извлечение robots
            const robotsMatch = htmlContent.match(/<meta[^>]*name=["']robots["'][^>]*content=["']([^"']*)["'][^>]*>/i);
            if (robotsMatch && robotsMatch[1]) {
                metadata.robots = this.cleanText(robotsMatch[1]);
            }
            
            await this.logger.debug('Metadata extracted', { metadata });
            
            return metadata;
        } catch (err) {
            await this.logger.error('Failed to extract metadata', { error: err.message });
            return metadata;
        }
    }
    
    cleanText(text) {
        return text
            .replace(/\s+/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .trim();
    }
    
    parseDate(dateString) {
        try {
            const date = new Date(dateString);
            if (isNaN(date.getTime())) {
                return null;
            }
            return date.toISOString().split('T')[0]; // YYYY-MM-DD
        } catch (err) {
            return null;
        }
    }
    
    hasNoIndex(htmlContent) {
        const robotsMatch = htmlContent.match(/<meta[^>]*name=["']robots["'][^>]*content=["']([^"']*)["'][^>]*>/i);
        if (robotsMatch && robotsMatch[1]) {
            const content = robotsMatch[1].toLowerCase();
            return content.includes('noindex') || content.includes('none');
        }
        return false;
    }
}

// ============================================================================
// СЕРВИС ГЕНЕРАЦИИ SITEMAP
// ============================================================================

class SitemapGeneratorService {
    constructor(config, logger, fileSystem, htmlParser) {
        this.config = config;
        this.logger = logger;
        this.fileSystem = fileSystem;
        this.htmlParser = htmlParser;
    }
    
    async generate() {
        await this.logger.info('Starting sitemap generation');
        
        try {
            const pages = await this.scanPages();
            await this.logger.info(`Found ${pages.length} pages`);
            
            const sitemapXml = this.buildSitemap(pages);
            
            const outputPath = path.join(this.config.OUTPUT_DIR, this.config.SITEMAP_FILENAME);
            await this.fileSystem.writeFile(outputPath, sitemapXml);
            
            await this.logger.info('Sitemap generation completed', { 
                outputPath, 
                pagesCount: pages.length 
            });
            
            return {
                success: true,
                pagesCount: pages.length,
                outputPath: outputPath
            };
        } catch (err) {
            await this.logger.error('Sitemap generation failed', { error: err.message });
            throw err;
        }
    }
    
    async scanPages() {
        const pages = [];
        const publicDir = this.config.PUBLIC_DIR;
        
        await this.logger.debug('Scanning public directory', { publicDir });
        
        try {
            const allFiles = await this.fileSystem.readDirectory(publicDir, { recursive: true });
            
            for (const file of allFiles) {
                if (file.name.toLowerCase() === 'index.html') {
                    const pageData = await this.processIndexFile(file);
                    if (pageData) {
                        pages.push(pageData);
                    }
                }
            }
            
            // Сортировка: главная страница первая, затем по алфавиту
            pages.sort((a, b) => {
                if (a.url === '/') return -1;
                if (b.url === '/') return 1;
                return a.url.localeCompare(b.url);
            });
            
            return pages;
        } catch (err) {
            await this.logger.error('Failed to scan pages', { error: err.message });
            throw err;
        }
    }
    
    async processIndexFile(fileInfo) {
        try {
            const relativePath = fileInfo.relativePath;
            
            // Преобразование пути в URL
            let url = this.convertPathToUrl(relativePath);
            
            // Чтение HTML файла для извлечения метаданных
            let metadata = {};
            let fileModified = null;
            
            try {
                const htmlContent = await this.fileSystem.readFile(fileInfo.path);
                metadata = await this.htmlParser.extractMetadata(htmlContent);
                
                // Проверка на noindex
                if (this.htmlParser.hasNoIndex(htmlContent)) {
                    await this.logger.debug(`Page marked as noindex, skipping: ${url}`);
                    return null;
                }
                
                // Получение информации о файле
                const fileInfo = await this.fileSystem.getFileInfo(fileInfo.path);
                if (fileInfo && fileInfo.modified) {
                    fileModified = fileInfo.modified.toISOString().split('T')[0];
                }
            } catch (err) {
                await this.logger.warn(`Failed to read HTML file: ${fileInfo.path}`, { error: err.message });
            }
            
            // Определение приоритета и частоты изменений
            const priority = this.determinePriority(url);
            const changefreq = this.determineChangefreq(url);
            
            // Использование lastmod из метаданных или из даты модификации файла
            const lastmod = metadata.lastModified || fileModified || new Date().toISOString().split('T')[0];
            
            return {
                url: url,
                lastmod: lastmod,
                changefreq: changefreq,
                priority: priority,
                metadata: metadata
            };
        } catch (err) {
            await this.logger.error(`Failed to process index file: ${fileInfo.path}`, { error: err.message });
            return null;
        }
    }
    
    convertPathToUrl(relativePath) {
        // Убираем index.html из пути
        let urlPath = relativePath.replace(/index\.html$/i, '');
        
        // Убираем trailing slash
        urlPath = urlPath.replace(/\/$/, '');
        
        // Добавляем leading slash если нет
        if (!urlPath.startsWith('/')) {
            urlPath = '/' + urlPath;
        }
        
        // Если это главная страница
        if (urlPath === '/') {
            return '/';
        }
        
        return urlPath;
    }
    
    determinePriority(url) {
        // Главная страница
        if (url === '/') {
            return this.config.HOMEPAGE_PRIORITY;
        }
        
        // Важные страницы
        const importantPages = [
            '/news',
            '/about',
            '/info',
            '/catalog',
            '/projects',
            '/sites'
        ];
        
        if (importantPages.some(page => url.startsWith(page))) {
            return this.config.IMPORTANT_PAGES_PRIORITY;
        }
        
        // Страницы политик и условий
        if (url.includes('/privacy') || url.includes('/terms')) {
            return 0.3;
        }
        
        // Страницы инструментов (как 2545 и подстраницы)
        if (/^\/\d+$/.test(url) || /^\/\d+\//.test(url)) {
            return 0.6;
        }
        
        // По умолчанию
        return this.config.DEFAULT_PRIORITY;
    }
    
    determineChangefreq(url) {
        // Главная страница
        if (url === '/') {
            return this.config.HOMEPAGE_CHANGEFREQ;
        }
        
        // Страницы с динамическим контентом
        if (url.includes('/news') || url.includes('/changelog')) {
            return this.config.DYNAMIC_CONTENT_CHANGEFREQ;
        }
        
        // Статические страницы
        if (url.includes('/privacy') || url.includes('/terms')) {
            return 'yearly';
        }
        
        // По умолчанию
        return this.config.DEFAULT_CHANGEFREQ;
    }
    
    buildSitemap(pages) {
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n';
        xml += '        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n';
        xml += '        xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9\n';
        xml += '        http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">\n';
        
        for (const page of pages) {
            xml += '  <url>\n';
            xml += `    <loc>${this.escapeXml(`${this.config.PROTOCOL}://${this.config.DOMAIN}${page.url}`)}</loc>\n`;
            
            if (this.config.INCLUDE_LASTMOD && page.lastmod) {
                xml += `    <lastmod>${page.lastmod}</lastmod>\n`;
            }
            
            if (this.config.INCLUDE_CHANGEFREQ && page.changefreq) {
                xml += `    <changefreq>${page.changefreq}</changefreq>\n`;
            }
            
            if (this.config.INCLUDE_PRIORITY && page.priority !== undefined) {
                xml += `    <priority>${page.priority.toFixed(1)}</priority>\n`;
            }
            
            xml += '  </url>\n';
        }
        
        xml += '</urlset>';
        
        return xml;
    }
    
    escapeXml(text) {
        if (typeof text !== 'string') {
            return text;
        }
        
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }
}

// ============================================================================
// СЕРВИС ГЕНЕРАЦИИ ROBOTS.TXT
// ============================================================================

class RobotsGeneratorService {
    constructor(config, logger, fileSystem) {
        this.config = config;
        this.logger = logger;
        this.fileSystem = fileSystem;
    }
    
    async generate() {
        await this.logger.info('Starting robots.txt generation');
        
        try {
            const robotsContent = this.buildRobots();
            
            const outputPath = path.join(this.config.OUTPUT_DIR, this.config.ROBOTS_FILENAME);
            await this.fileSystem.writeFile(outputPath, robotsContent);
            
            await this.logger.info('Robots.txt generation completed', { outputPath });
            
            return {
                success: true,
                outputPath: outputPath
            };
        } catch (err) {
            await this.logger.error('Robots.txt generation failed', { error: err.message });
            throw err;
        }
    }
    
    buildRobots() {
        let content = '# robots.txt for Oris Platform\n';
        content += `# Generated: ${new Date().toISOString()}\n`;
        content += `# Domain: ${this.config.PROTOCOL}://${this.config.DOMAIN}\n`;
        content += '\n';
        
        // Sitemap
        content += `Sitemap: ${this.config.PROTOCOL}://${this.config.DOMAIN}/sitemap.xml\n`;
        content += '\n';
        
        // User-agent: *
        content += 'User-agent: *\n';
        
        // Allow все кроме указанных
        content += 'Allow: /\n';
        
        // Disallow paths
        if (this.config.DISALLOWED_PATHS && this.config.DISALLOWED_PATHS.length > 0) {
            content += '\n';
            for (const path of this.config.DISALLOWED_PATHS) {
                content += `Disallow: ${path}\n`;
            }
        }
        
        content += '\n';
        
        // Crawl-delay (для некоторых поисковиков)
        content += 'Crawl-delay: 1\n';
        content += '\n';
        
        // Google specific
        content += 'User-agent: Googlebot\n';
        content += 'Allow: /\n';
        content += `Disallow: /api/\n`;
        content += `Disallow: /admin/\n`;
        content += '\n';
        
        // Google Images
        content += 'User-agent: Googlebot-Image\n';
        content += 'Allow: /\n';
        content += `Disallow: /api/\n`;
        content += '\n';
        
        // Bing
        content += 'User-agent: bingbot\n';
        content += 'Allow: /\n';
        content += `Disallow: /api/\n`;
        content += `Disallow: /admin/\n`;
        content += 'Crawl-delay: 2\n';
        content += '\n';
        
        // Yandex
        content += 'User-agent: Yandex\n';
        content += 'Allow: /\n';
        content += `Disallow: /api/\n`;
        content += `Disallow: /admin/\n`;
        content += 'Crawl-delay: 1\n';
        content += '\n';
        
        // Yandex Images
        content += 'User-agent: YandexImages\n';
        content += 'Allow: /\n';
        content += `Disallow: /api/\n`;
        content += '\n';
        
        // Bad bots
        content += 'User-agent: AhrefsBot\n';
        content += 'Disallow: /\n';
        content += '\n';
        
        content += 'User-agent: SemrushBot\n';
        content += 'Disallow: /\n';
        content += '\n';
        
        content += 'User-agent: MJ12bot\n';
        content += 'Disallow: /\n';
        content += '\n';
        
        return content;
    }
}

// ============================================================================
// СЕРВИС МИГРАЦИИ
// ============================================================================

class MigrationService {
    constructor(config, logger, fileSystem) {
        this.config = config;
        this.logger = logger;
        this.fileSystem = fileSystem;
    }
    
    async checkAndMigrate() {
        await this.logger.info('Checking for migrations');
        
        try {
            const migrations = await this.getPendingMigrations();
            
            if (migrations.length === 0) {
                await this.logger.info('No pending migrations');
                return { success: true, migrated: false };
            }
            
            await this.logger.info(`Found ${migrations.length} pending migrations`);
            
            for (const migration of migrations) {
                await this.executeMigration(migration);
            }
            
            return { success: true, migrated: true, count: migrations.length };
        } catch (err) {
            await this.logger.error('Migration check failed', { error: err.message });
            throw err;
        }
    }
    
    async getPendingMigrations() {
        const migrations = [];
        
        // Проверка на старую структуру файлов
        const oldSitemapPath = path.join(this.config.PUBLIC_DIR, 'sitemap.xml');
        const oldRobotsPath = path.join(this.config.PUBLIC_DIR, 'robots.txt');
        
        const sitemapExists = await this.fileSystem.fileExists(oldSitemapPath);
        const robotsExists = await this.fileSystem.fileExists(oldRobotsPath);
        
        if (sitemapExists || robotsExists) {
            migrations.push({
                name: 'backup_old_files',
                description: 'Backup old sitemap.xml and robots.txt files',
                execute: async () => await this.backupOldFiles()
            });
        }
        
        // Проверка на необходимость создания директории логов
        const logDir = path.dirname(this.config.LOG_FILE);
        const logDirExists = fsSync.existsSync(logDir);
        
        if (!logDirExists) {
            migrations.push({
                name: 'create_log_directory',
                description: 'Create log directory',
                execute: async () => await this.fileSystem.ensureDirectoryExists(logDir)
            });
        }
        
        return migrations;
    }
    
    async executeMigration(migration) {
        await this.logger.info(`Executing migration: ${migration.name}`, { description: migration.description });
        
        try {
            await migration.execute();
            await this.logger.info(`Migration completed: ${migration.name}`);
        } catch (err) {
            await this.logger.error(`Migration failed: ${migration.name}`, { error: err.message });
            throw err;
        }
    }
    
    async backupOldFiles() {
        const timestamp = Date.now();
        const backupDir = path.join(this.config.OUTPUT_DIR, 'backup', timestamp.toString());
        
        await this.fileSystem.ensureDirectoryExists(backupDir);
        
        const oldSitemapPath = path.join(this.config.PUBLIC_DIR, 'sitemap.xml');
        const oldRobotsPath = path.join(this.config.PUBLIC_DIR, 'robots.txt');
        
        if (await this.fileSystem.fileExists(oldSitemapPath)) {
            const content = await this.fileSystem.readFile(oldSitemapPath);
            await this.fileSystem.writeFile(
                path.join(backupDir, 'sitemap.xml'),
                content
            );
        }
        
        if (await this.fileSystem.fileExists(oldRobotsPath)) {
            const content = await this.fileSystem.readFile(oldRobotsPath);
            await this.fileSystem.writeFile(
                path.join(backupDir, 'robots.txt'),
                content
            );
        }
        
        await this.logger.info('Old files backed up', { backupDir });
    }
}

// ============================================================================
// СЕРВИС ВАЛИДАЦИИ
// ============================================================================

class ValidationService {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
    }
    
    async validateSitemap(filePath) {
        await this.logger.info('Validating sitemap', { filePath });
        
        const errors = [];
        const warnings = [];
        
        try {
            const content = await fs.readFile(filePath, 'utf8');
            
            // Проверка XML declaration
            if (!content.startsWith('<?xml version="1.0"')) {
                errors.push('Missing XML declaration');
            }
            
            // Проверка encoding
            if (!content.includes('encoding="UTF-8"')) {
                warnings.push('Missing or incorrect encoding declaration');
            }
            
            // Проверка urlset элемента
            if (!content.includes('<urlset')) {
                errors.push('Missing <urlset> element');
            }
            
            // Проверка xmlns
            if (!content.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"')) {
                errors.push('Missing or incorrect xmlns attribute');
            }
            
            // Подсчет URL
            const urlMatches = content.match(/<url>/g);
            const urlCount = urlMatches ? urlMatches.length : 0;
            
            if (urlCount === 0) {
                warnings.push('Sitemap contains no URLs');
            }
            
            if (urlCount > this.config.SITEMAP_INDEX_LIMIT) {
                errors.push(`Sitemap exceeds URL limit: ${urlCount} > ${this.config.SITEMAP_INDEX_LIMIT}`);
            }
            
            // Проверка обязательных элементов
            const locMatches = content.match(/<loc>([^<]*)<\/loc>/g);
            if (locMatches) {
                for (const loc of locMatches) {
                    const url = loc.replace(/<\/?loc>/g, '');
                    
                    // Проверка на абсолютный URL
                    if (!url.startsWith('http://') && !url.startsWith('https://')) {
                        errors.push(`URL is not absolute: ${url}`);
                    }
                    
                    // Проверка на правильный домен
                    if (!url.includes(this.config.DOMAIN)) {
                        warnings.push(`URL does not match domain: ${url}`);
                    }
                }
            }
            
            const result = {
                valid: errors.length === 0,
                errors: errors,
                warnings: warnings,
                urlCount: urlCount
            };
            
            await this.logger.info('Sitemap validation completed', result);
            
            return result;
        } catch (err) {
            await this.logger.error('Sitemap validation failed', { error: err.message });
            throw err;
        }
    }
    
    async validateRobots(filePath) {
        await this.logger.info('Validating robots.txt', { filePath });
        
        const errors = [];
        const warnings = [];
        
        try {
            const content = await fs.readFile(filePath, 'utf8');
            
            // Проверка на User-agent
            if (!content.includes('User-agent:')) {
                errors.push('Missing User-agent directive');
            }
            
            // Проверка на Sitemap
            if (!content.includes('Sitemap:')) {
                warnings.push('Missing Sitemap directive');
            } else {
                const sitemapMatch = content.match(/Sitemap:\s*(https?:\/\/[^\s]+)/i);
                if (sitemapMatch) {
                    const sitemapUrl = sitemapMatch[1];
                    if (!sitemapUrl.includes(this.config.DOMAIN)) {
                        warnings.push(`Sitemap URL does not match domain: ${sitemapUrl}`);
                    }
                }
            }
            
            // Проверка на пустые Disallow
            const emptyDisallow = content.match(/Disallow:\s*$/gm);
            if (emptyDisallow && emptyDisallow.length > 0) {
                warnings.push('Empty Disallow directives found');
            }
            
            const result = {
                valid: errors.length === 0,
                errors: errors,
                warnings: warnings
            };
            
            await this.logger.info('Robots.txt validation completed', result);
            
            return result;
        } catch (err) {
            await this.logger.error('Robots.txt validation failed', { error: err.message });
            throw err;
        }
    }
}

// ============================================================================
// ОСНОВНОЙ КЛАСС ГЕНЕРАТОРА
// ============================================================================

class SitemapRobotsGenerator {
    constructor(customConfig = {}) {
        // Объединение конфигураций
        this.config = { ...CONFIG, ...customConfig };
        
        // Инициализация сервисов
        this.logger = new Logger(this.config);
        this.cacheService = new CacheService(this.config, this.logger);
        this.fileSystem = new FileSystemService(this.config, this.logger);
        this.htmlParser = new HTMLParserService(this.config, this.logger);
        this.sitemapGenerator = new SitemapGeneratorService(
            this.config, 
            this.logger, 
            this.fileSystem, 
            this.htmlParser
        );
        this.robotsGenerator = new RobotsGeneratorService(
            this.config, 
            this.logger, 
            this.fileSystem
        );
        this.migrationService = new MigrationService(
            this.config, 
            this.logger, 
            this.fileSystem
        );
        this.validationService = new ValidationService(this.config, this.logger);
        
        // Статистика
        this.stats = {
            startTime: null,
            endTime: null,
            duration: null,
            pagesScanned: 0,
            errors: 0
        };
    }
    
    async generate(options = {}) {
        this.stats.startTime = Date.now();
        
        const {
            skipMigration = false,
            skipValidation = false,
            forceRegenerate = false,
            clearCache = false
        } = options;
        
        await this.logger.info('========================================');
        await this.logger.info('Sitemap & Robots.txt Generator Started');
        await this.logger.info('========================================');
        await this.logger.info('Configuration', this.config);
        
        try {
            // Очистка кэша если требуется
            if (clearCache) {
                await this.cacheService.clear();
            }
            
            // Миграция
            if (!skipMigration) {
                await this.migrationService.checkAndMigrate();
            }
            
            // Проверка кэша
            if (!forceRegenerate && this.config.ENABLE_CACHE) {
                const cachedResult = await this.cacheService.get('generation_result');
                if (cachedResult) {
                    await this.logger.info('Using cached result');
                    return cachedResult;
                }
            }
            
            // Генерация sitemap
            await this.logger.info('Generating sitemap...');
            const sitemapResult = await this.sitemapGenerator.generate();
            this.stats.pagesScanned = sitemapResult.pagesCount;
            
            // Генерация robots.txt
            await this.logger.info('Generating robots.txt...');
            const robotsResult = await this.robotsGenerator.generate();
            
            // Валидация
            let validationResult = null;
            if (!skipValidation) {
                await this.logger.info('Validating generated files...');
                
                const sitemapValidation = await this.validationService.validateSitemap(
                    sitemapResult.outputPath
                );
                
                const robotsValidation = await this.validationService.validateRobots(
                    robotsResult.outputPath
                );
                
                validationResult = {
                    sitemap: sitemapValidation,
                    robots: robotsValidation
                };
                
                if (!sitemapValidation.valid || !robotsValidation.valid) {
                    await this.logger.warn('Validation found issues', validationResult);
                }
            }
            
            // Сохранение в кэш
            const result = {
                success: true,
                sitemap: sitemapResult,
                robots: robotsResult,
                validation: validationResult,
                stats: this.getStats()
            };
            
            if (this.config.ENABLE_CACHE) {
                await this.cacheService.set('generation_result', result);
            }
            
            await this.logger.info('========================================');
            await this.logger.info('Generation Completed Successfully');
            await this.logger.info('========================================');
            await this.logger.info('Results', result);
            
            return result;
            
        } catch (err) {
            this.stats.errors++;
            await this.logger.error('Generation failed', { error: err.message, stack: err.stack });
            
            return {
                success: false,
                error: err.message,
                stats: this.getStats()
            };
        } finally {
            this.stats.endTime = Date.now();
            this.stats.duration = this.stats.endTime - this.stats.startTime;
        }
    }
    
    async generateOnlySitemap(options = {}) {
        await this.logger.info('Generating only sitemap...');
        
        try {
            const result = await this.sitemapGenerator.generate();
            return result;
        } catch (err) {
            await this.logger.error('Sitemap generation failed', { error: err.message });
            throw err;
        }
    }
    
    async generateOnlyRobots(options = {}) {
        await this.logger.info('Generating only robots.txt...');
        
        try {
            const result = await this.robotsGenerator.generate();
            return result;
        } catch (err) {
            await this.logger.error('Robots.txt generation failed', { error: err.message });
            throw err;
        }
    }
    
    async validate(options = {}) {
        await this.logger.info('Validating existing files...');
        
        const sitemapPath = path.join(this.config.OUTPUT_DIR, this.config.SITEMAP_FILENAME);
        const robotsPath = path.join(this.config.OUTPUT_DIR, this.config.ROBOTS_FILENAME);
        
        const result = {
            sitemap: null,
            robots: null
        };
        
        if (await this.fileSystem.fileExists(sitemapPath)) {
            result.sitemap = await this.validationService.validateSitemap(sitemapPath);
        } else {
            result.sitemap = { valid: false, errors: ['File not found'], warnings: [] };
        }
        
        if (await this.fileSystem.fileExists(robotsPath)) {
            result.robots = await this.validationService.validateRobots(robotsPath);
        } else {
            result.robots = { valid: false, errors: ['File not found'], warnings: [] };
        }
        
        return result;
    }
    
    getStats() {
        return {
            ...this.stats,
            cacheStats: this.cacheService.getStats()
        };
    }
    
    async clearCache() {
        await this.cacheService.clear();
    }
    
    async getConfiguration() {
        return {
            ...this.config,
            logLevel: this.logger.currentLevel
        };
    }
}

// ============================================================================
// ЭКСПОРТ И УТИЛИТЫ
// ============================================================================

/**
 * Создает экземпляр генератора с кастомной конфигурацией
 * @param {Object} customConfig - Пользовательская конфигурация
 * @returns {SitemapRobotsGenerator}
 */
function createGenerator(customConfig = {}) {
    return new SitemapRobotsGenerator(customConfig);
}

/**
 * Быстрая генерация sitemap и robots.txt
 * @param {Object} options - Опции генерации
 * @returns {Promise<Object>}
 */
async function generate(options = {}) {
    const generator = createGenerator(options.config);
    return await generator.generate(options);
}

/**
 * Middleware для Express
 * @returns {Function}
 */
function createExpressMiddleware() {
    const generator = createGenerator();
    
    return async (req, res) => {
        try {
            const { action = 'generate' } = req.query;
            
            switch (action) {
                case 'generate':
                    const result = await generator.generate({
                        forceRegenerate: req.query.force === 'true',
                        clearCache: req.query.clearCache === 'true'
                    });
                    res.json(result);
                    break;
                    
                case 'validate':
                    const validation = await generator.validate();
                    res.json(validation);
                    break;
                    
                case 'stats':
                    const stats = await generator.getStats();
                    res.json(stats);
                    break;
                    
                case 'clear-cache':
                    await generator.clearCache();
                    res.json({ success: true, message: 'Cache cleared' });
                    break;
                    
                case 'config':
                    const config = await generator.getConfiguration();
                    res.json(config);
                    break;
                    
                default:
                    res.status(400).json({ 
                        error: 'Invalid action', 
                        availableActions: ['generate', 'validate', 'stats', 'clear-cache', 'config'] 
                    });
            }
        } catch (err) {
            res.status(500).json({ 
                error: 'Generation failed', 
                message: err.message 
            });
        }
    };
}

/**
 * CLI интерфейс
 */
async function runCLI() {
    const args = process.argv.slice(2);
    const command = args[0] || 'generate';
    
    const generator = createGenerator();
    
    switch (command) {
        case 'generate':
            await generator.generate({
                forceRegenerate: args.includes('--force'),
                clearCache: args.includes('--clear-cache'),
                skipValidation: args.includes('--no-validate')
            });
            break;
            
        case 'validate':
            const validation = await generator.validate();
            console.log(JSON.stringify(validation, null, 2));
            break;
            
        case 'stats':
            const stats = await generator.getStats();
            console.log(JSON.stringify(stats, null, 2));
            break;
            
        case 'clear-cache':
            await generator.clearCache();
            console.log('Cache cleared');
            break;
            
        case 'help':
        default:
            console.log(`
Sitemap & Robots.txt Generator

Usage:
  node sitemap-generator.js [command] [options]

Commands:
  generate        Generate sitemap.xml and robots.txt (default)
  validate        Validate existing files
  stats           Show generation statistics
  clear-cache     Clear generation cache
  help            Show this help message

Options:
  --force         Force regeneration even if cached
  --clear-cache   Clear cache before generation
  --no-validate   Skip validation after generation

Examples:
  node sitemap-generator.js generate
  node sitemap-generator.js generate --force --clear-cache
  node sitemap-generator.js validate
  node sitemap-generator.js stats
            `);
            break;
    }
}

// ============================================================================
// ЭКСПОРТ МОДУЛЯ
// ============================================================================

module.exports = {
    SitemapRobotsGenerator,
    createGenerator,
    generate,
    createExpressMiddleware,
    runCLI,
    
    // Сервисы для прямого использования
    Logger,
    CacheService,
    FileSystemService,
    HTMLParserService,
    SitemapGeneratorService,
    RobotsGeneratorService,
    MigrationService,
    ValidationService,
    
    // Константы
    CONFIG
};

// ============================================================================
// ЗАПУСК CLI ЕСЛИ ФАЙЛ ЗАПУЩЕН НАПРЯМУЮ
// ============================================================================

if (require.main === module) {
    runCLI().catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}

// ============================================================================
// КОНЕЦ ФАЙЛА
// ============================================================================