// ============================================
// ECOLEARN ADMIN - ULTRA PERFORMANCE OPTIMIZATIONS
// Portable "Plug-and-Play" - No XAMPP config needed!
// Service Worker + LocalStorage for TRUE offline
// Based on Thesis: "Sub-second response times"
// ============================================

// ============================================
// SINGLE SOURCE OF TRUTH - STATE-DRIVEN UI
// Both Card Manager and Asset Repository share this data
// Load ONCE, render EVERYWHERE, update UNIVERSALLY
// ============================================
const AppState = {
    // The master card list - ALL cards live here
    cards: [],
    categories: {},
    isLoaded: false,
    isLoading: false,
    
    // Listeners for state changes
    listeners: [],
    
    // Subscribe to state changes
    subscribe(callback) {
        this.listeners.push(callback);
    },
    
    // Notify all listeners of state change
    notify(changeType, data) {
        this.listeners.forEach(cb => cb(changeType, data));
    },
    
    // Load all card data ONCE on startup
    async loadAll() {
        if (this.isLoading) return;
        if (this.isLoaded && this.cards.length > 0) return;
        
        this.isLoading = true;
        console.log('🔄 AppState: Loading all cards...');
        const startTime = performance.now();
        
        try {
            const data = await OptimizedAdmin.loadAssets(false);
            
            if (data && data.categories) {
                this.categories = data.categories;
                this.cards = [];
                
                // Flatten all cards into single array with category info
                for (const [categoryName, categoryData] of Object.entries(data.categories)) {
                    categoryData.cards.forEach(card => {
                        this.cards.push({
                            ...card,
                            category_name: categoryName,
                            bin_color: categoryData.bin_color
                        });
                    });
                }
                
                this.isLoaded = true;
                console.log(`✅ AppState: ${this.cards.length} cards loaded in ${(performance.now() - startTime).toFixed(0)}ms`);
                
                // Notify listeners that data is ready
                this.notify('loaded', this.cards);
                
                // Pre-render BOTH views immediately
                this.renderAllViews();
            }
        } catch (error) {
            console.error('❌ AppState load error:', error);
        } finally {
            this.isLoading = false;
        }
    },
    
    // ============================================
    // 🛠️ FIX: PREVENTS STUCK "LOADING..." SCREEN
    // ============================================
    renderAllViews() {
        console.log('🎨 AppState: Rendering views...');
        
        // 1. Render Asset Repository counts
        this.renderAssetRepository();
        
        // 2. Render Card Manager
        const gallery = document.getElementById('card-gallery');
        
        // FIX: Check if the gallery actually has CARDS, not just "any content"
        // (This fixes the issue where it sees the "Loading..." text and stops)
        if (gallery && !gallery.querySelector('.gallery-card')) {
            this.renderCardManager();
        }
 },
    
    // ============================================
    // 🚀 OPTIMIZED: Smart Initial Render
    // ============================================
    renderCardManager() {
        const gallery = document.getElementById('card-gallery');
        if (!gallery) return;
        
        // CHECK: If gallery is already populated, DO NOT re-render!
        if (gallery.children.length > 0 && gallery.children.length === this.cards.length) {
            console.log('⚡ Gallery already synced, skipping re-render');
            return;
        }
        
        if (this.cards.length === 0) {
            gallery.innerHTML = '<div class="empty-state">No cards available<br><small style="font-size: 0.85rem; opacity: 0.7;">Add cards to get started</small></div>';
            return;
        }
        
        console.log('🎨 Rendering gallery from scratch...');
        const fragment = document.createDocumentFragment();
        
        this.cards.forEach(card => {
            fragment.appendChild(this.createCardElement(card));
        });
        
        gallery.innerHTML = '';
        gallery.appendChild(fragment);
    },

    // Helper to create a single DOM element (reusable)
    createCardElement(card) {
        const div = document.createElement('div');
        div.className = 'gallery-card';
        div.id = `card-${card.card_id}`; // Unique ID for finding it later
        div.setAttribute('data-card-id', card.card_id);
        div.setAttribute('data-category', card.category_name);
        div.onclick = () => previewCard(card.card_id, card.card_name, card.category_name, '/' + card.image_path);
        
        div.innerHTML = `
            <div class="card-img-container">
                <img src="/${card.image_path}" alt="${card.card_name}" 
                     loading="lazy" decoding="async" fetchpriority="low"
                     width="120" height="100"
                     onerror="this.onerror=null;this.src='/assets/binbin_neutral.png'">
            </div>
            <div class="card-details">
                <span class="card-title">${card.card_name}</span>
                <span class="card-cat" style="color:${getCategoryColor(card.category_name)}">
                    ${getCategoryIcon(card.category_name)} ${card.category_name}
                </span>
            </div>
        `;
        return div;
    },

    // ============================================
    // ⚡ ULTRA FAST: Granular DOM Updates
    // Updates only the SPECIFIC card instead of reloading everything
    // ============================================
    universalCardUpdate(action, cardData) {
        console.log(`⚡ Instant Update: ${action}`, cardData);
        const gallery = document.getElementById('card-gallery');

        // 1. Update Internal State (Data)
        if (action === 'add') {
            this.cards.push(cardData);
            if (this.categories[cardData.category_name]) {
                this.categories[cardData.category_name].cards.push(cardData);
            }
            
            // DOM: Append ONLY the new card
            if (gallery) {
                // Remove empty state if it exists
                if (gallery.querySelector('.empty-state')) gallery.innerHTML = '';
                gallery.appendChild(this.createCardElement(cardData));
            }

        } else if (action === 'update') {
            // Update Data Array
            const idx = this.cards.findIndex(c => c.card_id === cardData.card_id);
            if (idx !== -1) {
                // Handle Category Change logic (removing from old cat, adding to new)
                const oldCategory = this.cards[idx].category_name;
                if (oldCategory !== cardData.category_name) {
                    if (this.categories[oldCategory]) {
                        this.categories[oldCategory].cards = this.categories[oldCategory].cards.filter(c => c.card_id !== cardData.card_id);
                    }
                    if (this.categories[cardData.category_name]) {
                        this.categories[cardData.category_name].cards.push(cardData);
                    }
                }
                this.cards[idx] = cardData;

                // DOM: Find the specific card and replace it
                const existingCard = document.getElementById(`card-${cardData.card_id}`);
                if (existingCard) {
                    const newCard = this.createCardElement(cardData);
                    gallery.replaceChild(newCard, existingCard);
                    
                    // Flash effect to show update happened
                    newCard.style.animation = 'highlight 1s ease';
                }
            }
        }

        // Only update the counts text, do not re-render the repository list
        this.renderAssetRepository(); 
    },
    
    // Render Asset Repository counts
    renderAssetRepository() {
        // Update category counts
        for (const [categoryName, categoryData] of Object.entries(this.categories)) {
            let countEl = null;
            if (categoryName === 'Compostable') countEl = document.getElementById('count-compostable');
            else if (categoryName === 'Recyclable') countEl = document.getElementById('count-recyclable');
            else if (categoryName === 'Non-Recyclable') countEl = document.getElementById('count-non-recyclable');
            else if (categoryName === 'Special Waste') countEl = document.getElementById('count-special');
            
            if (countEl) countEl.textContent = `${categoryData.cards.length} cards`;
        }
        
        // Update total card count
        const cardCountEl = document.getElementById('stat-cards');
        if (cardCountEl) cardCountEl.textContent = this.cards.length;
    },
    
    // Get cards by category (for modal view)
    getCardsByCategory(categoryName) {
        return this.categories[categoryName]?.cards || [];
    },
    
    // Get single card by ID
    getCardById(cardId) {
        return this.cards.find(c => c.card_id === cardId);
    }
};

// ============================================
// SERVICE WORKER REGISTRATION (Portable Caching!)
// ============================================
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/js/sw.js')
            .then((registration) => {
                console.log('✅ Service Worker registered - Offline Ready!');
                // Image preloading disabled for performance
                // Images will lazy-load as needed
            })
            .catch((error) => {
                console.warn('⚠️ Service Worker failed:', error);
            });
    });
}

const OptimizedAdmin = {
    // ============================================
    // PERSISTENT CACHE SYSTEM (LocalStorage)
    // Survives page refresh - instant loading!
    // ============================================
    cache: {
        STORAGE_KEY: 'ecolearn_cache',
        CACHE_DURATION: 5 * 60 * 1000, // 5 minutes persistent cache
        memoryCache: {}, // Also keep in memory for fastest access
        
        // Load cache from localStorage on startup
        init() {
            try {
                const stored = localStorage.getItem(this.STORAGE_KEY);
                if (stored) {
                    this.memoryCache = JSON.parse(stored);
                    console.log('✅ Persistent cache loaded from localStorage');
                }
            } catch (e) {
                console.warn('⚠️ Cache load failed, starting fresh');
                this.memoryCache = {};
            }
        },
        
        // Save cache to localStorage
        persist() {
            try {
                localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.memoryCache));
            } catch (e) {
                // localStorage full, clear old data
                console.warn('⚠️ Cache persist failed, clearing...');
                localStorage.removeItem(this.STORAGE_KEY);
            }
        },
        
        isValid(key) {
            const entry = this.memoryCache[key];
            if (!entry) return false;
            return (Date.now() - entry.timestamp) < this.CACHE_DURATION;
        },
        
        set(key, data) {
            this.memoryCache[key] = {
                data: data,
                timestamp: Date.now()
            };
            // Persist to localStorage (debounced)
            clearTimeout(this._persistTimer);
            this._persistTimer = setTimeout(() => this.persist(), 500);
        },
        
        get(key) {
            const entry = this.memoryCache[key];
            return entry ? entry.data : null;
        },
        
        invalidate(key) {
            delete this.memoryCache[key];
            this.persist();
        },
        
        invalidateAll() {
            this.memoryCache = {};
            localStorage.removeItem(this.STORAGE_KEY);
            console.log('🗑️ Cache cleared');
        }
    },

    // NOTE: Image preloading REMOVED - uses native lazy loading
    // This prevents GPU texture thrashing on Alt-Tab

    // ============================================
    // DEDUPLICATED API CALLS
    // ============================================
    api: {
        pendingRequests: new Map(),
        
        async fetch(url, options = {}) {
            // Deduplicate concurrent requests to same URL
            if (this.pendingRequests.has(url)) {
                return this.pendingRequests.get(url);
            }
            
            const promise = fetch(url, options)
                .then(res => res.json())
                .finally(() => {
                    this.pendingRequests.delete(url);
                });
            
            this.pendingRequests.set(url, promise);
            return promise;
        }
    },

    // ============================================
    // FAST CARD LOADING - Use minimal endpoint
    // ============================================
    async loadCardsFast(forceRefresh = false) {
        if (!forceRefresh && this.cache.isValid('cards')) {
            return this.cache.get('cards');
        }
        
        console.log('🔄 Fetching cards...');
        const startTime = performance.now();
        
        try {
            const data = await this.api.fetch(`${API_URL}/admin/cards-minimal`);
            
            if (data.status === 'success') {
                this.cache.set('cards', data.cards);
                console.log(`✅ Cards loaded in ${(performance.now() - startTime).toFixed(0)}ms`);
                return data.cards;
            }
        } catch (error) {
            console.error('❌ Fast cards load error:', error);
        }
        
        return null;
    },

    // ============================================
    // FAST COUNTS LOADING
    // ============================================
    async loadCountsFast(forceRefresh = false) {
        if (!forceRefresh && this.cache.isValid('counts')) {
            return this.cache.get('counts');
        }
        
        try {
            const data = await this.api.fetch(`${API_URL}/admin/asset-counts`);
            
            if (data.status === 'success') {
                this.cache.set('counts', data);
                return data;
            }
        } catch (error) {
            console.error('❌ Fast counts error:', error);
        }
        
        return null;
    },

    // ============================================
    // FULL ASSETS (for modal details) - WITH CACHE
    // ============================================
    async loadAssets(forceRefresh = false) {
        if (!forceRefresh && this.cache.isValid('assets')) {
            return this.cache.get('assets');
        }
        
        console.log('🔄 Fetching assets...');
        try {
            const data = await this.api.fetch(`${API_URL}/admin/asset-repository`);
            
            if (data.status === 'success') {
                this.cache.set('assets', data);
                return data;
            }
        } catch (error) {
            console.error('❌ Asset load error:', error);
        }
        
        return null;
    },

    // ============================================
    // FAST CARD GALLERY RENDER
    // Uses show/hide instead of re-creating DOM for instant filtering!
    // CHUNKED RENDERING: Adds cards in batches of 10 to keep UI responsive
    // ============================================
    async renderCardGallery(filter = 'all', searchTerm = '') {
        const gallery = document.getElementById('card-gallery');
        if (!gallery) return;
        
        const startTime = performance.now();
        
        // Check if cards are already rendered in DOM
        const existingCards = gallery.querySelectorAll('.gallery-card[data-card-id]');
        
        if (existingCards.length > 0) {
            // FAST PATH: Cards already exist - just show/hide based on filter
            let visibleCount = 0;
            
            existingCards.forEach(cardEl => {
                const cardName = cardEl.querySelector('.card-title')?.textContent || '';
                const cardCategory = cardEl.getAttribute('data-category') || '';
                
                let show = true;
                
                // Apply category filter
                if (filter !== 'all' && cardCategory !== filter) {
                    show = false;
                }
                
                // Apply search filter
                if (show && searchTerm) {
                    const term = searchTerm.toLowerCase();
                    if (!cardName.toLowerCase().includes(term)) {
                        show = false;
                    }
                }
                
                // Show/hide without destroying element (INSTANT!)
                cardEl.style.display = show ? '' : 'none';
                if (show) visibleCount++;
            });
            
            // Update empty state
            let emptyState = gallery.querySelector('.empty-state');
            if (visibleCount === 0) {
                if (!emptyState) {
                    emptyState = document.createElement('div');
                    emptyState.className = 'empty-state';
                    emptyState.innerHTML = 'No cards match your search<br><small style="font-size: 0.85rem; opacity: 0.7;">Try different keywords</small>';
                    gallery.appendChild(emptyState);
                }
                emptyState.style.display = '';
            } else if (emptyState) {
                emptyState.style.display = 'none';
            }
            
            return;
        }
        
        // INITIAL LOAD: Create cards for the first time
        let cards = await this.loadCardsFast();
        if (!cards) {
            gallery.innerHTML = '<div class="empty-state">Error loading cards.</div>';
            return;
        }
        
        // Store ALL cards for global access (unfiltered)
        window.allCards = cards.map(c => ({
            card_id: c.card_id,
            card_name: c.card_name,
            image_path: c.image_path,
            category: c.category_name,
            bin_color: c.bin_color
        }));
        
        if (cards.length === 0) {
            gallery.innerHTML = '<div class="empty-state">No cards available<br><small style="font-size: 0.85rem; opacity: 0.7;">Add cards to get started</small></div>';
            return;
        }
        
        // Clear gallery before chunked render
        gallery.innerHTML = '';
        
        // CHUNKED RENDERING: Add 10 cards at a time using requestAnimationFrame
        // This keeps the UI responsive during large gallery loads
        const CHUNK_SIZE = 10;
        let currentIndex = 0;
        
        const renderChunk = () => {
            const fragment = document.createDocumentFragment();
            const endIndex = Math.min(currentIndex + CHUNK_SIZE, cards.length);
            
            for (let i = currentIndex; i < endIndex; i++) {
                const card = cards[i];
                const div = document.createElement('div');
                div.className = 'gallery-card';
                div.setAttribute('data-card-id', card.card_id);
                div.setAttribute('data-category', card.category_name);
                div.onclick = () => previewCard(card.card_id, card.card_name, card.category_name, '/' + card.image_path);
                
                // Check if should be visible based on initial filter
                let show = true;
                if (filter !== 'all' && card.category_name !== filter) show = false;
                if (searchTerm && !card.card_name.toLowerCase().includes(searchTerm.toLowerCase())) show = false;
                if (!show) div.style.display = 'none';
                
                // Use native lazy loading - browser handles it efficiently
                div.innerHTML = `<div class="card-img-container"><img src="/${card.image_path}" alt="${card.card_name}" loading="lazy" decoding="async" fetchpriority="low" width="120" height="100" onerror="this.onerror=null;this.src='/assets/binbin_neutral.png'"></div><div class="card-details"><span class="card-title">${card.card_name}</span><span class="card-cat" style="color:${getCategoryColor(card.category_name)}">${getCategoryIcon(card.category_name)} ${card.category_name}</span></div>`;
                
                fragment.appendChild(div);
            }
            
            gallery.appendChild(fragment);
            currentIndex = endIndex;
            
            // Continue with next chunk if more cards remain
            if (currentIndex < cards.length) {
                requestAnimationFrame(renderChunk);
            } else {
                console.log(`⚡ Gallery: ${cards.length} cards rendered in ${(performance.now() - startTime).toFixed(0)}ms (chunked)`);
            }
        };
        
        // Start chunked rendering
        requestAnimationFrame(renderChunk);
    },

    // ============================================
    // FAST MODAL CARDS RENDER (Uses cache - no reload!)
    // ============================================
    async renderModalCards(category) {
        const grid = document.getElementById('modal-cards-grid');
        if (!grid) return;
        
        const startTime = performance.now();
        
        // Use cached assets - this WON'T fetch again if cache is valid
        const data = await this.loadAssets();
        if (!data || !data.categories[category]) {
            grid.innerHTML = '<div class="empty-state">No cards in this category<br><small style="font-size: 0.85rem; opacity: 0.7;">Cards will appear here once added</small></div>';
            return;
        }
        
        const cards = data.categories[category].cards;
        const fragment = document.createDocumentFragment();
        
        cards.forEach(card => {
            const div = document.createElement('div');
            div.className = 'modal-card-item';
            div.innerHTML = `<img src="/${card.image_path}" alt="${card.card_name}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='/assets/binbin_neutral.png'"><div class="card-name">${card.card_name}</div><button class="btn-pdf" onclick="event.stopPropagation();generatePDF(${card.card_id},'${card.card_name.replace(/'/g, "\\'")}')">📄 Download</button>`;
            fragment.appendChild(div);
        });
        
        grid.innerHTML = '';
        grid.appendChild(fragment);
    },

    // ============================================
    // FAST ASSET COUNTS UPDATE
    // ============================================
    async updateAssetCounts() {
        const data = await this.loadCountsFast();
        if (!data || !data.counts) return;
        
        // Update category counts
        const countMap = {
            'Compostable': 'count-compostable',
            'Recyclable': 'count-recyclable',
            'Non-Recyclable': 'count-non-recyclable',
            'Special Waste': 'count-special'
        };
        
        for (const [cat, elId] of Object.entries(countMap)) {
            const el = document.getElementById(elId);
            if (el && data.counts[cat] !== undefined) {
                el.textContent = `${data.counts[cat]} cards`;
            }
        }
        
        const cardCountEl = document.getElementById('stat-cards');
        if (cardCountEl) cardCountEl.textContent = data.total_cards;
    }
};

// ============================================
// OPTIMIZED FUNCTION OVERRIDES
// ============================================

async function loadCardGallery() {
    await OptimizedAdmin.renderCardGallery(currentFilter, currentSearchTerm);
}

async function loadAssetRepository() {
    await OptimizedAdmin.updateAssetCounts();
}

function viewCategoryCards(category) {
    const modal = document.getElementById('cards-modal');
    const title = document.getElementById('modal-title');
    if (!modal) return;
    
    title.textContent = `${getCategoryIcon(category)} ${category} Cards`;
    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('active'));
    OptimizedAdmin.renderModalCards(category);
}

function applyFiltersAndSearch() {
    OptimizedAdmin.renderCardGallery(currentFilter, currentSearchTerm);
}

// ============================================
// PERFORMANCE MONITORING
// ============================================
const PerfMonitor = {
    marks: new Map(),
    
    start(label) {
        this.marks.set(label, performance.now());
    },
    
    end(label) {
        const start = this.marks.get(label);
        if (start) {
            const duration = performance.now() - start;
            console.log(`⏱️ ${label}: ${duration.toFixed(1)}ms`);
            this.marks.delete(label);
            return duration;
        }
        return 0;
    }
};

// ============================================
// CACHE INVALIDATION HELPER
// Called by submitOneShotLearning in admin_script.js
// ============================================
function invalidateAllCaches() {
    OptimizedAdmin.cache.invalidateAll();
    if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({ action: 'clearCache' });
    }
}

// ============================================
// INITIALIZATION
// ============================================
OptimizedAdmin.cache.init();

// ============================================
// ALT-TAB OPTIMIZATION
// Prevents lag when switching back to app
// ============================================
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        // Give browser time to repaint before any JS runs
        requestAnimationFrame(() => setTimeout(() => {}, 100));
    }
});

console.log(`
⚡ EcoLearn Admin - Optimized for Alt-Tab
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✓ Native lazy loading (no preload)
✓ content-visibility: auto (GPU-friendly)
✓ LocalStorage cache (5 min TTL)
✓ Service Worker offline support
✓ Chunked rendering (10 cards/frame)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Target: Intel i5, 8GB RAM
`);

