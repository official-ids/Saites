const CACHE_NAME = 'push-notifications-v1';

// Установка Service Worker
self.addEventListener('install', event => {
    console.log('[SW] Install');
    self.skipWaiting();
});

// Активация
self.addEventListener('activate', event => {
    console.log('[SW] Activate');
    event.waitUntil(clients.claim());
});

// Обработка push-уведомлений
self.addEventListener('push', event => {
    console.log('[SW] Push received');
    
    let data = {};
    
    if (event.data) {
        try {
            data = event.data.json();
        } catch (e) {
            data = { title: 'Уведомление', body: event.data.text() };
        }
    }

    const title = data.title || 'Новое уведомление';
    const options = {
        body: data.body || '',
        icon: data.icon || '/favicon.ico',
        badge: data.badge || '/favicon.ico',
        image: data.image,
        data: data.data || {},
        requireInteraction: data.requireInteraction || false,
        actions: data.actions || [
            { action: 'open', title: 'Открыть' },
            { action: 'close', title: 'Закрыть' }
        ],
        tag: data.tag || 'default',
        renotify: data.renotify || false
    };

    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

// Обработка клика по уведомлению
self.addEventListener('notificationclick', event => {
    console.log('[SW] Notification click', event.action);
    
    event.notification.close();

    if (event.action === 'close') {
        return;
    }

    const urlToOpen = event.notification.data?.url || '/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then(windowClients => {
                // Проверяем, есть ли уже открытая вкладка
                for (let client of windowClients) {
                    if (client.url === urlToOpen && 'focus' in client) {
                        return client.focus();
                    }
                }
                // Открываем новую вкладку
                if (clients.openWindow) {
                    return clients.openWindow(urlToOpen);
                }
            })
    );
});

// Обработка сообщений от страницы
self.addEventListener('message', event => {
    console.log('[SW] Message from client', event.data);
    
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});