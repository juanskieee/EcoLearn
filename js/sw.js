// ============================================
// ECOLEARN SERVICE WORKER
// True Offline Caching - "Plug-and-Play" Portable
// No XAMPP configuration needed!
// ============================================

const CACHE_NAME = 'ecolearn-cache-v2';
const CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

// Core assets to cache immediately on install
const CORE_ASSETS = [
    '/',
    '/index.html',
    '/admin/index.html',
    '/js/admin_script.js',
    '/js/admin_optimized.js',
    '/js/script.js',
    '/js/sw.js',
    '/css/admin_style.css',
    '/css/style.css',
    '/assets/binbin_neutral.png'
];

// Install event - cache core assets
self.addEventListener('install', (event) => {
    console.log('⚡ EcoLearn Service Worker: Installing...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('📦 Caching core assets...');
                return cache.addAll(CORE_ASSETS);
            })
            .then(() => {
                console.log('✅ Core assets cached');
                return self.skipWaiting();
            })
            .catch((error) => {
                console.error('❌ Cache failed:', error);
            })
    );
});

// Activate event - clean old caches
self.addEventListener('activate', (event) => {
    console.log('⚡ EcoLearn Service Worker: Activating...');
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('🗑️ Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => {
            return self.clients.claim();
        })
    );
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // Only handle same-origin requests
    if (url.origin !== location.origin) {
        return;
    }
    
    // For images in assets folder - Cache First strategy (FAST!)
    if (url.pathname.startsWith('/assets/')) {
        event.respondWith(
            caches.match(event.request)
                .then((cachedResponse) => {
                    if (cachedResponse) {
                        // Return cached image immediately (instant!)
                        return cachedResponse;
                    }
                    
                    // Not in cache - fetch and cache for next time
                    return fetch(event.request)
                        .then((response) => {
                            // Don't cache if not successful
                            if (!response || response.status !== 200) {
                                return response;
                            }
                            
                            // Clone and cache the response
                            const responseToCache = response.clone();
                            caches.open(CACHE_NAME)
                                .then((cache) => {
                                    cache.put(event.request, responseToCache);
                                });
                            
                            return response;
                        })
                        .catch(() => {
                            // Offline fallback for images
                            return caches.match('/assets/binbin_neutral.png');
                        });
                })
        );
        return;
    }
    
    // For API calls - Network First (always fresh data)
    if (url.pathname.startsWith('/admin/') || url.pathname.includes('api')) {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    return response;
                })
                .catch(() => {
                    // API failed - could return cached data if available
                    return caches.match(event.request);
                })
        );
        return;
    }
    
    // For HTML/CSS/JS - Stale While Revalidate (fast + fresh)
    event.respondWith(
        caches.match(event.request)
            .then((cachedResponse) => {
                const fetchPromise = fetch(event.request)
                    .then((networkResponse) => {
                        // Update cache in background
                        if (networkResponse && networkResponse.status === 200) {
                            const responseToCache = networkResponse.clone();
                            caches.open(CACHE_NAME)
                                .then((cache) => {
                                    cache.put(event.request, responseToCache);
                                });
                        }
                        return networkResponse;
                    })
                    .catch(() => cachedResponse);
                
                // Return cached version immediately, update in background
                return cachedResponse || fetchPromise;
            })
    );
});

// Message handler for cache management
self.addEventListener('message', (event) => {
    if (event.data.action === 'clearCache') {
        caches.delete(CACHE_NAME).then(() => {
            console.log('🗑️ Cache cleared by admin');
        });
    }
});

// NOTE: Image preloading REMOVED - using native lazy loading instead
// This prevents GPU texture thrashing on Alt-Tab
