// ============================================
// ADMIN DASHBOARD LOGIC
// EcoLearn - Interactive Waste Segregation Tool
// ============================================

const API_URL = 'http://localhost:5000';
let allLogs = [];
let chartInstance = null;
let categoryChartInstance = null;
let allCards = []; // For card gallery
let currentFilter = 'all';
let currentSearchTerm = '';
let refreshTimer = null;
let isAddCardModalLocked = false;
let proficiencyReportData = [];
const ADD_CARD_UI_STATE_KEY = 'ecolearn_admin_add_card_ui_state_v1';
const ADMIN_LAST_TAB_KEY = 'ecolearn_admin_last_tab_v1';
const ADMIN_TAB_IDS = new Set([
    'overview',
    'confusion-matrix',
    'leaderboard',
    'proficiency-reports',
    'asset-repository',
    'one-shot',
    'config',
    'logs',
    'nicknames'
]);

function getSavedAdminTab() {
    const savedTab = localStorage.getItem(ADMIN_LAST_TAB_KEY);
    if (savedTab && ADMIN_TAB_IDS.has(savedTab)) {
        return savedTab;
    }
    return 'overview';
}

function restoreAdminTabAfterReload() {
    const targetTab = getSavedAdminTab();
    if (targetTab !== 'overview') {
        showTab(targetTab);
        setActiveNavItemByTab(targetTab);
    }
}

function getAddCardUiState() {
    try {
        const raw = sessionStorage.getItem(ADD_CARD_UI_STATE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (error) {
        console.warn('Failed to parse add-card UI state:', error);
        return null;
    }
}

function clearAddCardUiState() {
    sessionStorage.removeItem(ADD_CARD_UI_STATE_KEY);
}

function saveAddCardUiState(partial = {}) {
    const state = {
        ...(getAddCardUiState() || {}),
        ...partial,
        updatedAt: Date.now(),
    };
    sessionStorage.setItem(ADD_CARD_UI_STATE_KEY, JSON.stringify(state));
}

function setActiveNavItemByTab(tabId) {
    document.querySelectorAll('.nav-item').forEach((item) => item.classList.remove('active'));

    const navItems = Array.from(document.querySelectorAll('.nav-item'));
    const navItem = navItems.find((item) => {
        const onclickAttr = item.getAttribute('onclick') || '';
        return onclickAttr.includes(`'${tabId}'`) || onclickAttr.includes(`"${tabId}"`);
    });

    if (navItem) {
        navItem.classList.add('active');
    }
}

async function restoreAddCardUiStateAfterReload() {
    const state = getAddCardUiState();
    if (!state || !state.modalOpen) return;

    try {
        const response = await fetch(`${API_URL}/admin/cnn-training-status`);
        const data = await response.json();
        const training = data && data.status === 'success' ? data.training : null;
        const isTrainingActive = training && (training.state === 'queued' || training.state === 'running');

        if (!isTrainingActive) {
            clearAddCardUiState();
            return;
        }
    } catch (error) {
        console.warn('Unable to validate training status on restore:', error);
    }

    showTab('one-shot');
    setActiveNavItemByTab('one-shot');

    const modal = document.getElementById('add-card-modal');
    if (!modal) return;

    const replaceCardInput = document.getElementById('replace-card-id');
    const nameInput = document.getElementById('one-shot-name');
    const categorySelect = document.getElementById('one-shot-category');
    const preview = document.getElementById('image-preview');
    const formTitle = document.getElementById('form-title');
    const submitText = document.getElementById('submit-btn-text');
    const cancelReplaceBtn = document.getElementById('cancel-replace-btn');
    const resultDiv = document.getElementById('one-shot-result');

    if (replaceCardInput) replaceCardInput.value = state.replaceCardId || '';
    if (nameInput) nameInput.value = state.cardName || '';
    if (categorySelect && state.categoryId) categorySelect.value = String(state.categoryId);

    if (state.previewHtml && preview) {
        preview.innerHTML = state.previewHtml;
        preview.classList.toggle('has-image', Boolean(state.previewHasImage));
    }

    const isReplacement = Boolean(state.isReplacement || state.replaceCardId);
    if (formTitle) formTitle.innerHTML = isReplacement ? '🔄 Replace Card' : 'Add New Card';
    if (submitText) submitText.textContent = isReplacement ? 'Update Card' : 'Register New Card';
    if (cancelReplaceBtn) cancelReplaceBtn.style.display = isReplacement ? 'block' : 'none';

    if (resultDiv) {
        resultDiv.style.display = 'block';
        resultDiv.style.background = state.resultBackground || '#FEF3C7';
        resultDiv.style.color = state.resultColor || '#92400E';
        resultDiv.innerHTML = state.resultHtml || '<div class="result-title">⏳ Restored session</div><span class="result-subline">ORB retraining is still running...</span>';
    }

    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('active'));
    setAddCardModalLocked(true);

    if (resultDiv) {
        await monitorCnnRetrainProgress(resultDiv, !isReplacement);
    }
}

// Debounce utility for performance
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Toast notification system
function showNotification(message, type = 'info') {
    // Remove existing notifications
    document.querySelectorAll('.toast-notification').forEach(n => n.remove());
    
    const toast = document.createElement('div');
    toast.className = `toast-notification toast-${type}`;
    toast.innerHTML = message;
    document.body.appendChild(toast);
    
    // Animate in
    requestAnimationFrame(() => toast.classList.add('show'));
    
    // Auto remove after 3 seconds
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Alias for showNotification
const showToast = showNotification;

// ============================================
// INITIALIZATION
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    // Initialize persistent cache first
    if (typeof OptimizedAdmin !== 'undefined') {
        OptimizedAdmin.cache.init();
    }
    
    loadDashboard();
    restoreAdminTabAfterReload();
    restoreAddCardUiStateAfterReload();
    
    // Event delegation for nickname removal
    document.addEventListener('click', function(event) {
        const removeButton = event.target.closest('[data-action="remove"]');
        if (removeButton) {
            const tag = removeButton.closest('.tag');
            if (tag && tag.dataset.nickname) {
                showRemoveNicknameModal(tag.dataset.nickname);
            }
        }
    });
    
    // ESC key to close modals (highest z-index first)
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const deleteModal = document.getElementById('delete-card-modal');
            const downloadModal = document.getElementById('download-confirm-modal');
            const previewModal = document.getElementById('card-preview-modal');
            const confirmModal = document.getElementById('confirmationModal');
            const logoutModal = document.getElementById('logoutModal');
            const removeNicknameModal = document.getElementById('remove-nickname-modal');
            const addNicknameModal = document.getElementById('add-nickname-modal');
            const cardsModal = document.getElementById('cards-modal');
            const addCardModal = document.getElementById('add-card-modal');
            
            if (deleteModal && deleteModal.classList.contains('active')) {
                closeDeleteCardModal();
            } else if (downloadModal && downloadModal.classList.contains('active')) {
                closeDownloadConfirmModal();
            } else if (previewModal && previewModal.classList.contains('active')) {
                closeCardPreview();
            } else if (removeNicknameModal && removeNicknameModal.classList.contains('active')) {
                closeRemoveNicknameModal();
            } else if (addNicknameModal && addNicknameModal.classList.contains('active')) {
                closeAddNicknameModal();
            } else if (logoutModal && logoutModal.classList.contains('active')) {
                closeLogoutModal();
            } else if (confirmModal && confirmModal.classList.contains('active')) {
                closeConfirmationModal();
            } else if (cardsModal && cardsModal.classList.contains('active')) {
                closeCardsModal();
            } else if (addCardModal && addCardModal.classList.contains('active')) {
                closeAddCardModal();
            }
        }
    });
    
    // OPTIMIZED auto-refresh - 60 seconds instead of 15
    // Card gallery and asset repo use cache, so no lag
    setInterval(() => {
        const activeTab = document.querySelector('.tab-content.active');
        if (activeTab && document.visibilityState === 'visible') {
            const tabId = activeTab.id;
            // Only refresh data-critical tabs, others use cache
            switch(tabId) {
                case 'overview':
                    loadStats();
                    break;
                case 'leaderboard':
                    loadLeaderboard();
                    break;
                case 'proficiency-reports':
                    loadProficiencyReports();
                    break;
                // Asset tabs use AppState - no refresh needed
                // They're pre-rendered and update universally
            }
        }
    }, 60000);
});

async function loadDashboard() {
    try {
        // Load all data in parallel for faster load time
        // AppState.loadAll() pre-renders Card Manager AND Asset Repository
        await Promise.all([
            loadStats(),
            loadNicknames(),
            loadConfusionMatrix(),
            loadLeaderboard(),
            loadProficiencyReports(),
            AppState.loadAll(),  // Single Source of Truth - renders BOTH views
            loadSystemConfig()
        ]);
    } catch (error) {
        console.error('❌ Dashboard load error:', error);
    }
}

// ============================================
// TAB SYSTEM - INSTANT CSS SWITCHING
// No data fetching! Both views are pre-rendered by AppState
// ============================================

function showTab(tabId, evt = null) {
    if (!ADMIN_TAB_IDS.has(tabId)) {
        tabId = 'overview';
    }

    // Get current active tab before switching
    const currentTab = document.querySelector('.tab-content.active');
    
    // If leaving System Config tab, reset any unsaved changes
    if (currentTab && currentTab.id === 'config' && tabId !== 'config') {
        resetUnsavedChanges();
    }
    
    // Hide all tabs (pure CSS toggle - INSTANT)
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });
    
    // Remove active from all nav items
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
    });
    
    // Show selected tab
    const selectedTab = document.getElementById(tabId);
    if (selectedTab) {
        selectedTab.classList.add('active');
        localStorage.setItem(ADMIN_LAST_TAB_KEY, tabId);
    }
    
    // Add active to clicked nav item; fallback to tab id mapping for programmatic calls.
    const targetEl = evt && evt.target && typeof evt.target.closest === 'function' ? evt.target : null;
    const navItem = targetEl ? targetEl.closest('.nav-item') : null;
    if (navItem) {
        navItem.classList.add('active');
    } else {
        setActiveNavItemByTab(tabId);
    }

    // Update top-header title based on active tab
    const tabTitles = {
        'overview':         'Overview',
        'confusion-matrix': 'Confusion Matrix',
        'leaderboard':      'Leaderboard',
        'proficiency-reports': 'Proficiency Reports',
        'asset-repository': 'Asset Repository',
        'one-shot':         'Card Manager',
        'config':           'System Config',
        'logs':             'Scan Logs',
        'nicknames':        'Students'
    };
    const pageTitle = document.getElementById('page-title');
    if (pageTitle && tabTitles[tabId]) {
        pageTitle.textContent = tabTitles[tabId];
    }

    // Re-trigger popIn animation on the top-header and section-card
    const header = document.querySelector('.top-header');
    if (header) {
        header.style.animation = 'none';
        header.offsetHeight; // force reflow
        header.style.animation = '';
    }
    
    if (selectedTab) {
        selectedTab.style.animation = 'none';
        selectedTab.offsetHeight; // force reflow
        selectedTab.style.animation = '';
    }
    
    // NO DATA FETCHING HERE!
    // Card Manager and Asset Repository are already pre-rendered by AppState
    // This is pure CSS visibility switching = INSTANT
}

// ============================================
// STATISTICS & LOGS
// ============================================

async function loadStats() {
    try {
        const response = await fetch(`${API_URL}/admin/stats`);
        const data = await response.json();
        
        // Update counters
        document.getElementById('stat-total').textContent = data.total_scans || 0;
        document.getElementById('stat-accuracy').textContent = (data.accuracy || 0) + '%';
        
        // Update session count
        const sessionsEl = document.getElementById('stat-sessions');
        if (sessionsEl) sessionsEl.textContent = data.total_sessions || 0;
        
        // Keep logs for filtering
        allLogs = data.recent_logs || [];
        renderLogs(allLogs);
        
        // Update Chart (if we have historical data in the future)
        updateChart(data);
        
    } catch (error) {
        console.error('Stats load error:', error);
    }
}

function renderLogs(logs) {
    const tbody = document.getElementById('logs-body');
    const container = document.querySelector('.logs-table-container');

    // Remove any existing empty overlay
    container && container.querySelectorAll('.logs-empty').forEach(el => el.remove());

    if (!logs || logs.length === 0) {
        tbody.innerHTML = '';
        if (container) {
            const activePill = document.querySelector('.logs-pill.active');
            const activeFilter = activePill ? activePill.getAttribute('data-filter') : 'all';
            const emptyMessages = {
                'all':    { icon: '📋', title: 'No scan logs yet',             sub: 'Scans will appear here when students start scanning' },
                'high':   { icon: '🟢', title: 'No high-confidence scans yet', sub: 'No scans with ≥80% confidence have been recorded' },
                'medium': { icon: '🟡', title: 'No medium-confidence scans',   sub: 'No scans between 60–79% confidence have been recorded' },
                'low':    { icon: '🔴', title: 'No low-confidence scans',      sub: 'No scans below 60% confidence have been recorded' },
            };
            const msg = emptyMessages[activeFilter] || emptyMessages['all'];
            container.insertAdjacentHTML('beforeend', `
                <div class="empty-state logs-empty">
                    <span class="empty-icon">${msg.icon}</span>
                    <strong>${msg.title}</strong>
                    <small>${msg.sub}</small>
                </div>`);
        }
        return;
    }
    
    tbody.innerHTML = logs.map(log => {
        const conf = parseFloat(log.confidence);
        let resultBadge;
        if (conf >= 90)      resultBadge = '<span class="badge-excellent">Excellent</span>';
        else if (conf >= 80) resultBadge = '<span class="badge-great">Great</span>';
        else if (conf >= 60) resultBadge = '<span class="badge-good">Good</span>';
        else if (conf >= 45) resultBadge = '<span class="badge-fair">Fair</span>';
        else if (conf >= 30) resultBadge = '<span class="badge-bad">Weak</span>';
        else if (conf >= 15) resultBadge = '<span class="badge-worse">Poor</span>';
        else                 resultBadge = '<span class="badge-worst">Very Poor</span>';
        const timeStr = log.time || '—';
        // Build image thumbnail (image_path is relative to htdocs, e.g. assets/Recyclable/bottle.webp)
        const imgSrc = log.image_path
            ? `../${log.image_path}`
            : null;
        const thumbHtml = imgSrc
            ? `<img src="${imgSrc}" alt="${log.card}" class="log-card-thumb"
                    onerror="this.style.display='none'">`
            : `<div class="log-card-thumb log-card-thumb--placeholder">📦</div>`;
        return `
        <tr>
            <td>${timeStr}</td>
            <td>
                <span class="log-nickname">
                    ${log.nickname || 'Guest'}
                </span>
            </td>
            <td>
                <div class="log-item-cell">
                    ${thumbHtml}
                    <div class="log-item-info">
                        <p>${log.card}</p>
                        <span class="log-item-category">${log.category}</span>
                    </div>
                </div>
            </td>
            <td>${log.confidence}%</td>
            <td>${resultBadge}</td>
        </tr>`;
    }).join('');
}

function filterLogs(filterType, btnElement) {
    // UI toggle
    document.querySelectorAll('.logs-pill').forEach(b => b.classList.remove('active'));
    btnElement.classList.add('active');
    
    // Filter by confidence tier
    let filtered = allLogs;
    if (filterType === 'high')   filtered = allLogs.filter(l => parseFloat(l.confidence) >= 80);
    if (filterType === 'medium') filtered = allLogs.filter(l => parseFloat(l.confidence) >= 60 && parseFloat(l.confidence) < 80);
    if (filterType === 'low')    filtered = allLogs.filter(l => parseFloat(l.confidence) < 60);
    
    renderLogs(filtered);
}

// ============================================
// NICKNAMES
// ============================================

// Helper function to format relative time
function formatRelativeTime(dateString) {
    if (!dateString) return null;
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    
    // Format as date for older entries
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Check if student is "new" (created within last 24 hours and no sessions)
function isNewStudent(student) {
    if (student.sessions > 0) return false;
    if (!student.created_at) return true; // No timestamp = treat as new
    
    const created = new Date(student.created_at);
    const now = new Date();
    const hoursSinceCreated = (now - created) / 3600000;
    
    return hoursSinceCreated < 24; // New for first 24 hours
}

async function loadNicknames() {
    try {
        const res = await fetch(`${API_URL}/admin/nicknames`);
        const data = await res.json();
        const list = document.getElementById('nickname-list');
        
        if (data.nicknames && data.nicknames.length > 0) {
            // Check if we have detailed data or just names
            if (typeof data.nicknames[0] === 'object') {
                // Rich data with stats - show ALL stats at once
                list.innerHTML = data.nicknames.map((student, index) => {
                    const isNew = isNewStudent(student);
                    const createdTime = formatRelativeTime(student.created_at);
                    
                    return `
                    <div class="tag" data-nickname="${(student.nickname || student).toString().replace(/"/g, '&quot;')}">
                        <div class="tag-info">
                            <div class="tag-av-name">
                            <span class="tag-avatar">👤</span>
                            <span class="tag-name">${student.nickname || student}</span>
                            </div>
                            <span class="tag-stats">
                                <span class="stat-chip sessions">📊 ${student.sessions || 0} session${student.sessions !== 1 ? 's' : ''}</span>
                                <span class="stat-chip accuracy">🎯 ${student.accuracy ? student.accuracy + '% accuracy' : '0% accuracy'}</span>
                                <span class="stat-chip created">⏱️ ${createdTime || 'N/A'}</span>
                                ${isNew ? '<span class="stat-chip new">✨ New</span>' : ''}
                            </span>
                        </div>
                        <span class="remove" data-action="remove">×</span>
                    </div>
                `}).join('');
            } else {
                // Simple string list (fallback)
                list.innerHTML = data.nicknames.map((name, index) => `
                    <div class="tag" data-nickname="${name.replace(/"/g, '&quot;')}">
                        <span class="tag-avatar">👤</span>
                        <div class="tag-info">
                            <span class="tag-name">${name}</span>
                            <span class="tag-stats">
                                <span class="stat-chip sessions">📊 0 sessions</span>
                                <span class="stat-chip accuracy">🎯 N/A</span>
                                <span class="stat-chip created">⏱️ N/A</span>
                                <span class="stat-chip new">✨ New</span>
                            </span>
                        </div>
                        <span class="remove" data-action="remove">×</span>
                    </div>
                `).join('');
            }
        } else {
            list.innerHTML = `<div class="empty-state">
                <span class="empty-icon">👥</span>
                <strong>No students added yet</strong>
                <small>Click "Add Student" to get started</small>
            </div>`;
        }
    } catch (e) {
        console.error(e);
        const list = document.getElementById('nickname-list');
        if (list) {
            list.innerHTML = `<div class="empty-state">
                <span class="empty-icon">⚠️</span>
                <strong>Error loading students</strong>
                <small>Please refresh the page</small>
            </div>`;
        }
    }
}

async function addNickname() {
    const input = document.getElementById('new-nickname');
    const name = input.value.trim();
    if (!name) return;

    await fetch(`${API_URL}/admin/nicknames`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ nickname: name })
    });
    
    input.value = '';
    loadNicknames();
}

async function removeNickname(name) {
    try {
        // Actually call the DELETE endpoint
        const response = await fetch(`${API_URL}/admin/nicknames/${encodeURIComponent(name)}`, {
            method: 'DELETE',
            headers: {'Content-Type': 'application/json'}
        });
        
        if (response.ok) {
            showNotification(`Student "${name}" removed successfully`, 'success');
            // Reload the nicknames list to reflect the change
            await loadNicknames();
        } else {
            showNotification('Error removing student', 'error');
        }
    } catch (error) {
        console.error('Remove nickname error:', error);
        showNotification('Error removing student', 'error');
    }
}

// ============================================
// REMOVE NICKNAME MODAL
// ============================================

let nicknameToRemove = null;

function showRemoveNicknameModal(name) {
    if (!name) {
        showNotification('Error: Invalid student name', 'error');
        return;
    }
    
    nicknameToRemove = name;
    const modal = document.getElementById('remove-nickname-modal');
    const nameDisplay = document.getElementById('remove-nickname-name');
    
    if (modal && nameDisplay) {
        nameDisplay.textContent = `"${name}"`;
        modal.style.display = 'flex';
        requestAnimationFrame(() => {
            modal.classList.add('active');
        });
    }
}

function closeRemoveNicknameModal() {
    const modal = document.getElementById('remove-nickname-modal');
    if (modal) {
        modal.classList.remove('active');
        setTimeout(() => {
            modal.style.display = 'none';
            nicknameToRemove = null;
        }, 200);
    }
}

function handleRemoveNicknameBackdropClick(event) {
    if (event.target.id === 'remove-nickname-modal') {
        closeRemoveNicknameModal();
    }
}

async function confirmRemoveNickname() {
    if (!nicknameToRemove) {
        showNotification('Error: No student selected', 'error');
        closeRemoveNicknameModal();
        return;
    }
    
    const nameToRemove = nicknameToRemove;
    closeRemoveNicknameModal();
    
    // Add slight delay for smooth transition
    setTimeout(async () => {
        await removeNickname(nameToRemove);
    }, 200);
}

// ============================================
// NICKNAME MODAL & SEARCH
// ============================================

function openAddNicknameModal() {
    const modal = document.getElementById('add-nickname-modal');
    const input = document.getElementById('modal-nickname-input');
    const result = document.getElementById('nickname-result');
    
    if (modal && input && result) {
        input.value = '';
        result.style.display = 'none';
        modal.style.display = 'flex';
        requestAnimationFrame(() => {
            modal.classList.add('active');
            input.focus();
        });
    }
}

function closeAddNicknameModal() {
    const modal = document.getElementById('add-nickname-modal');
    if (modal) {
        modal.classList.remove('active');
        setTimeout(() => {
            modal.style.display = 'none';
        }, 200);
    }
}

async function submitNickname() {
    const input = document.getElementById('modal-nickname-input');
    const result = document.getElementById('nickname-result');
    const name = input.value.trim();
    
    if (!name) {
        result.textContent = '⚠️ Please enter a nickname';
        result.style.display = 'block';
        result.style.background = '#FEE2E2';
        result.style.color = '#991B1B';
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/admin/nicknames`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ nickname: name })
        });
        
        const data = await response.json();
        
        // Close modal immediately
        closeAddNicknameModal();
        
        // Refresh the list
        await loadNicknames();
        
        // Show success toast notification
        showNotification(`Student "${name}" added successfully`, 'success');
        
    } catch (error) {
        result.textContent = '❌ Error adding student';
        result.style.display = 'block';
        result.style.background = '#FEE2E2';
        result.style.color = '#991B1B';
    }
}

function searchNicknames(searchTerm) {
    const list = document.getElementById('nickname-list');
    const clearBtn = document.getElementById('nickname-search-clear');
    const tags = list.querySelectorAll('.tag');
    
    // Show/hide clear button
    if (clearBtn) {
        clearBtn.style.display = searchTerm ? 'flex' : 'none';
    }
    
    if (!tags.length) return;
    
    const term = searchTerm.toLowerCase().trim();
    let visibleCount = 0;
    
    tags.forEach(tag => {
        const text = tag.textContent.toLowerCase();
        if (text.includes(term)) {
            tag.style.display = 'flex';
            visibleCount++;
        } else {
            tag.style.display = 'none';
        }
    });
    
    // Show "no results" message if needed
    let emptyState = list.querySelector('.empty-state');
    if (visibleCount === 0 && term) {
        if (!emptyState) {
            emptyState = document.createElement('div');
            emptyState.className = 'empty-state';
            emptyState.innerHTML = '<span class="empty-icon">🔍</span><strong>No students match your search</strong><small>Try different keywords</small>';
            list.appendChild(emptyState);
        }
        emptyState.style.display = 'flex';
    } else if (emptyState) {
        emptyState.style.display = 'none';
    }
}

function clearNicknameSearch() {
    const searchInput = document.getElementById('nickname-search');
    const clearBtn = document.getElementById('nickname-search-clear');
    
    if (searchInput) {
        searchInput.value = '';
        searchNicknames('');
    }
    
    if (clearBtn) {
        clearBtn.style.display = 'none';
    }
}

// ============================================
// LEADERBOARD SEARCH
// ============================================

function searchLeaderboard(searchTerm) {
    const tbody = document.getElementById('leaderboard-body');
    const clearBtn = document.getElementById('leaderboard-search-clear');
    const rows = tbody.querySelectorAll('tr:not(.empty-row)');
    
    // Show/hide clear button
    if (clearBtn) {
        clearBtn.style.display = searchTerm ? 'flex' : 'none';
    }
    
    // Skip if only empty state row exists
    if (rows.length === 0 || (rows.length === 1 && rows[0].querySelector('.empty-state'))) {
        return;
    }
    
    const term = searchTerm.toLowerCase().trim();
    let visibleCount = 0;
    
    rows.forEach(row => {
        // Skip empty state rows
        if (row.querySelector('.empty-state') || row.querySelector('.empty-state-cell')) {
            return;
        }
        
        const nickname = row.querySelector('td:nth-child(2)')?.textContent.toLowerCase() || '';
        const rank = row.querySelector('td:nth-child(1)')?.textContent.toLowerCase() || '';
        
        if (nickname.includes(term) || rank.includes(term)) {
            row.style.display = '';
            visibleCount++;
        } else {
            row.style.display = 'none';
        }
    });
    
    // Handle no results message
    let emptyRow = tbody.querySelector('.search-empty-row');
    if (visibleCount === 0 && term) {
        if (!emptyRow) {
            emptyRow = document.createElement('tr');
            emptyRow.className = 'search-empty-row';
            emptyRow.innerHTML = `
                <td colspan="7" class="empty-state-cell">
                    <div class="empty-state">
                        <span class="empty-icon">🔍</span>
                        <strong>No students match "${searchTerm}"</strong>
                        <small>Try different keywords</small>
                    </div>
                </td>
            `;
            tbody.appendChild(emptyRow);
        } else {
            emptyRow.querySelector('strong').textContent = `No students match "${searchTerm}"`;
            emptyRow.style.display = '';
        }
    } else if (emptyRow) {
        emptyRow.style.display = 'none';
    }
}

function clearLeaderboardSearch() {
    const searchInput = document.getElementById('leaderboard-search');
    const clearBtn = document.getElementById('leaderboard-search-clear');
    
    if (searchInput) {
        searchInput.value = '';
        searchLeaderboard('');
    }
    
    if (clearBtn) {
        clearBtn.style.display = 'none';
    }
}

// ============================================
// SYSTEM HEALTH
// ============================================

async function checkHealth() {
    const setStatus = (id, isOk, text) => {
        const el = document.getElementById(id);
        const dot = document.getElementById('dot-' + id.split('-')[0]); // server-status -> dot-server
        if (el) el.textContent = text;
        if (dot) dot.className = `dot ${isOk ? 'ok' : 'err'}`;
    };

    try {
        const res = await fetch(`${API_URL}/health`);
        const data = await res.json();
        
        setStatus('server-status', true, 'Online');
        setStatus('model-status', data.model_loaded, data.model_loaded ? 'Ready' : 'Not Loaded');
        setStatus('db-status', true, 'Connected');
        document.getElementById('last-update').textContent = new Date().toLocaleTimeString();
        
    } catch (e) {
        setStatus('server-status', false, 'Offline');
        setStatus('model-status', false, 'Unknown');
        setStatus('db-status', false, 'Unknown');
    }
}

// ============================================
// CHART (Placeholder)
// ============================================

function updateChart(data) {
    // --- Activity Trends (line chart) ---
    const ctx = document.getElementById('performanceChart');
    if (ctx) {
        if (!chartInstance) {
            chartInstance = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: ['10m ago', '5m ago', 'Now'],
                    datasets: [{
                        label: 'Scans per minute',
                        data: [2, 5, 3],
                        borderColor: '#1CB0F6',
                        tension: 0.4,
                        fill: true,
                        backgroundColor: 'rgba(28, 176, 246, 0.1)'
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: { y: { beginAtZero: true } }
                }
            });
        }
    }

    // --- Category Distribution (doughnut chart) ---
    const ctxCat = document.getElementById('categoryChart');
    if (!ctxCat) return;

    const logs = data.recent_logs || [];
    const counts = { 'Compostable': 0, 'Recyclable': 0, 'Non-Recyclable': 0, 'Special Waste': 0 };
    logs.forEach(log => {
        const cat = log.category;
        if (cat && counts.hasOwnProperty(cat)) counts[cat]++;
        else if (cat) counts[cat] = (counts[cat] || 0) + 1;
    });

    const labels = Object.keys(counts);
    const values = Object.values(counts);
    const colors = {
        'Compostable':    'rgba(236, 253, 245, 0.9)',
        'Recyclable':     'rgba(239, 246, 255, 0.9)',
        'Non-Recyclable': 'rgba(254, 242, 242, 0.9)',
        'Special Waste':  'rgba(255, 251, 235, 0.9)'
    };
    const borders = {
        'Compostable':    'rgba(52,  211, 153, 0.7)',
        'Recyclable':     'rgba(96,  165, 250, 0.7)',
        'Non-Recyclable': 'rgba(248, 113, 113, 0.7)',
        'Special Waste':  'rgba(251, 211, 141, 0.7)'
    };
    const bgColors     = labels.map(l => colors[l]  || 'rgba(200, 200, 200, 0.6)');
    const borderColors = labels.map(l => borders[l] || 'rgba(150, 150, 150, 0.6)');

    const total = values.reduce((a, b) => a + b, 0);

    if (categoryChartInstance) {
        categoryChartInstance.data.labels = labels;
        categoryChartInstance.data.datasets[0].data = values;
        categoryChartInstance.update();
        return;
    }

    categoryChartInstance = new Chart(ctxCat, {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{
                data: values,
                backgroundColor: bgColors,
                borderColor: borderColors,
                borderWidth: 2,
                hoverOffset: 8
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '60%',
            plugins: {
                legend: {
                    display: true,
                    position: 'bottom',
                    labels: {
                        font: { family: 'Fredoka', size: 13 },
                        padding: 12,
                        usePointStyle: true
                    }
                },
                tooltip: {
                    callbacks: {
                        label: ctx => {
                            const val = ctx.parsed;
                            const pct = total > 0 ? ((val / total) * 100).toFixed(1) : 0;
                            return ` ${ctx.label}: ${val} scan${val !== 1 ? 's' : ''} (${pct}%)`;
                        }
                    }
                }
            }
        }
    });
}

// ============================================
// CONFUSION MATRIX (From Thesis Proposal)
// ============================================

async function loadConfusionMatrix() {
    const container = document.getElementById('confusion-matrix-container');
    const accuracyContainer = document.getElementById('category-accuracy');
    
    if (!container) return;
    
    try {
        const response = await fetch(`${API_URL}/admin/confusion-matrix`);
        const data = await response.json();
        
        if (data.status !== 'success') {
            container.innerHTML = `<div class="empty-state">
                <span class="empty-icon">📊</span>
                <strong>No classification data available yet</strong>
                <small>Data will appear after students complete scanning sessions</small>
            </div>`;
            return;
        }
        
        const { categories, matrix, category_stats } = data;
        
        // Build confusion matrix table
        const catImg = {
            'Compostable':    '../assets/compostable_icon.png',
            'Recyclable':     '../assets/recyclable_icon.png',
            'Non-Recyclable': '../assets/non_recyclable_icon.png',
            'Special Waste':  '../assets/special_waste_icon.png'
        };

        let html = `
            <table class="confusion-matrix-table">
                <thead>
                    <tr>
                        <th class="corner-cell">Actual ↓ / Predicted →</th>
                        ${categories.map(c => `<th class="pred-header">${c}</th>`).join('')}
                        <th class="total-header">Total</th>
                    </tr>
                </thead>
                <tbody>
        `;
        
        categories.forEach(actual => {
            const rowTotal = Object.values(matrix[actual]).reduce((a, b) => a + b, 0);
            html += `<tr>
                <th class="actual-header">${actual}</th>
                ${categories.map(predicted => {
                    const count = matrix[actual][predicted];
                    const isCorrect = actual === predicted;
                    const cellClass = isCorrect ? 'cell-correct' : (count > 0 ? 'cell-error' : 'cell-zero');
                    return `<td class="${cellClass}">${count}</td>`;
                }).join('')}
                <td class="row-total">${rowTotal}</td>
            </tr>`;
        });
        
        html += `</tbody></table>`;
        container.innerHTML = html;
        
        // Build per-category accuracy cards
        if (accuracyContainer && category_stats) {
            accuracyContainer.innerHTML = category_stats.map(stat => {
            const categoryClass = stat.category === 'Compostable' ? 'compostable' 
                : stat.category === 'Recyclable' ? 'recyclable'
                : stat.category === 'Non-Recyclable' ? 'non-recyclable'
                : 'special';
            
            return `
                <div class="category-stat-card ${categoryClass}">
                <img src="${catImg[stat.category] || ''}" alt="${stat.category}" class="cat-stat-img">
                <div class="cat-name">${stat.category}</div>
                <div class="cat-accuracy">${stat.accuracy}%</div>
                <div class="cat-detail">${stat.correct}/${stat.total} correct</div>
                </div>
            `;
            }).join('');
        }
    } catch (error) {
        console.error('Confusion matrix error:', error);
        container.innerHTML = `<div class="empty-state">
            <span class="empty-icon">⚠️</span>
            <strong>Error loading confusion matrix</strong>
            <small>Please refresh the page or check your connection</small>
        </div>`;
    }
}

function getCategoryColor(category) {
    const colors = {
        'Compostable':    'rgba(236, 253, 245, 0.9)',
        'Recyclable':     'rgba(239, 246, 255, 0.9)',
        'Non-Recyclable': 'rgba(254, 242, 242, 0.9)',
        'Special Waste':  'rgba(255, 251, 235, 0.9)'
    };
    return colors[category] || 'rgba(243, 244, 246, 0.9)';
}

function getCategoryTextColor(category) {
    const colors = {
        'Compostable':    '#065F46',
        'Recyclable':     '#1e40af',
        'Non-Recyclable': '#991B1B',
        'Special Waste':  '#92400E'
    };
    return colors[category] || '#374151';
}

function getCategoryBorderColor(category) {
    const colors = {
        'Compostable':    'rgba(52,  211, 153, 0.55)',
        'Recyclable':     'rgba(96,  165, 250, 0.55)',
        'Non-Recyclable': 'rgba(248, 113, 113, 0.55)',
        'Special Waste':  'rgba(251, 211, 141, 0.6)'
    };
    return colors[category] || 'rgba(165, 214, 167, 0.45)';
}

function getCatClass(category) {
    const classes = {
        'Compostable':    'cat-compostable',
        'Recyclable':     'cat-recyclable',
        'Non-Recyclable': 'cat-non-recyclable',
        'Special Waste':  'cat-special'
    };
    return classes[category] || '';
}

// ============================================
// STUDENT LEADERBOARD (Comparative Dashboard)
// ============================================

async function loadLeaderboard() {
    const tbody    = document.getElementById('leaderboard-body');
    const podium   = document.getElementById('lb-podium');
    const tableWrap = document.getElementById('lb-table-wrapper');
    if (!tbody) return;

    try {
        const response = await fetch(`${API_URL}/admin/student-proficiency`);
        const data = await response.json();

        if (data.status !== 'success' || !data.leaderboard || data.leaderboard.length === 0) {
            if (podium) {
                const emptySlots = [
                    { rank: 1, medal: '🥇', cls: 'lb-podium-gold',   baseCls: 'lb-base-1', suffix: 'st' },
                    { rank: 2, medal: '🥈', cls: 'lb-podium-silver', baseCls: 'lb-base-2', suffix: 'nd' },
                    { rank: 3, medal: '🥉', cls: 'lb-podium-bronze', baseCls: 'lb-base-3', suffix: 'rd' },
                ];
                podium.innerHTML = emptySlots.map(s => `
                    <div class="lb-podium-slot ${s.cls}">
                        <div class="lb-podium-card lb-podium-card--empty">
                            <div class="lb-podium-empty-slot-icon">${s.medal}</div>
                            <div class="lb-podium-empty-slot-label">No entry</div>
                        </div>
                        <div class="lb-podium-base ${s.baseCls}">${s.rank}${s.suffix}</div>
                    </div>`).join('');
            }
            tbody.innerHTML = '';
            if (tableWrap) tableWrap.insertAdjacentHTML('beforeend', `
                <div class="empty-state lb-table-empty">
                    <span class="empty-icon">🏆</span>
                    <strong>No rankings yet</strong>
                    <small>Students need to complete sessions in Assessment Mode to appear on the leaderboard</small>
                </div>`);
            return;
        }

        const lb = data.leaderboard;

        // Clear any existing empty overlay
        tableWrap && tableWrap.querySelectorAll('.lb-table-empty').forEach(el => el.remove());

        // ---- Podium (top 3) ----
        if (podium) {
            // order: 1st | 2nd | 3rd  top-to-bottom vertical column
            const slots = [
                { data: lb[0], rank: 1, medal: '🥇', cls: 'lb-podium-gold',   baseCls: 'lb-base-1' },
                { data: lb[1], rank: 2, medal: '🥈', cls: 'lb-podium-silver', baseCls: 'lb-base-2' },
                { data: lb[2], rank: 3, medal: '🥉', cls: 'lb-podium-bronze', baseCls: 'lb-base-3' },
            ];
            podium.innerHTML = slots.map(slot => {
                if (!slot.data) return `
                <div class="lb-podium-slot ${slot.cls}">
                    <div class="lb-podium-card lb-podium-card--empty">
                        <div class="lb-podium-empty-slot-icon">${slot.medal}</div>
                        <div class="lb-podium-empty-slot-label">No entry</div>
                    </div>
                    <div class="lb-podium-base ${slot.baseCls}">${slot.rank}${slot.rank===1?'st':slot.rank===2?'nd':'rd'}</div>
                </div>`;
                const acc = parseFloat(slot.data.avg_accuracy);
                return `
                <div class="lb-podium-slot ${slot.cls}">
                    <div class="lb-podium-card">
                        <div class="lb-podium-medal">${slot.medal}</div>
                        <div class="lb-podium-name">${slot.data.nickname}</div>
                        <div class="lb-podium-score">${slot.data.best_accuracy}%</div>
                        <div class="lb-podium-meta">
                            <span>${slot.data.sessions} sessions</span>
                            <span class="accuracy-badge" style="background:${getAccuracyColor(acc)}">${acc}% avg</span>
                        </div>
                    </div>
                    <div class="lb-podium-base ${slot.baseCls}">${slot.rank}${slot.rank===1?'st':slot.rank===2?'nd':'rd'}</div>
                </div>`;
            }).join('');
        }

        // ---- Table (ALL students) ----
        const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
        tbody.innerHTML = lb.map(student => `
            <tr>
                <td class="rank-cell">${medals[student.rank] || student.rank}</td>
                <td class="lb-name-cell"><strong>${student.nickname}</strong></td>
                <td class="lb-num-cell">${student.sessions}</td>
                <td class="lb-num-cell">${student.total_scans}</td>
                <td class="lb-num-cell">${student.correct}</td>
                <td class="lb-num-cell">${student.avg_accuracy}%</td>
                <td><span class="accuracy-badge" style="background:${getAccuracyColor(student.best_accuracy)}">${student.best_accuracy}%</span></td>
            </tr>`).join('');

    } catch (error) {
        console.error('Leaderboard error:', error);
        tbody.innerHTML = '';
        if (tableWrap) tableWrap.insertAdjacentHTML('beforeend', `
            <div class="empty-state lb-table-empty">
                <span class="empty-icon">⚠️</span>
                <strong>Error loading leaderboard</strong>
                <small>Please refresh the page or check your connection</small>
            </div>`);
    }
}

function getAccuracyColor(accuracy) {
    if (accuracy >= 90) return '#A0E1C8';
    if (accuracy >= 75) return '#BFDBFE';
    if (accuracy >= 50) return '#FCC8C8';
    return '#FCC8C8';
}

async function loadProficiencyReports() {
    const tbody = document.getElementById('proficiency-report-body');
    if (!tbody) return;

    try {
        const response = await fetch(`${API_URL}/admin/proficiency-reports`);
        const data = await response.json();

        const reports = Array.isArray(data.reports) ? data.reports : [];

        if (data.status !== 'success' || reports.length === 0) {
            proficiencyReportData = [];
            updateProficiencySummary([]);
            tbody.innerHTML = `
                <tr>
                    <td colspan="8" class="empty-state-cell">
                        <div class="empty-state">
                        <span class="empty-icon">📑</span>
                        <strong>No proficiency reports yet</strong>
                        <small>Assessment sessions are required to generate student proficiency reports</small>
                        </div>
                    </td>
                </tr>`;
            return;
        }

        proficiencyReportData = reports;
        updateProficiencySummary(proficiencyReportData);

        tbody.innerHTML = proficiencyReportData.map((row) => `
            <tr>
                <td class="rank-cell">${row.rank}</td>
                <td class="lb-name-cell"><strong>${row.nickname}</strong></td>
                <td class="lb-num-cell">${row.sessions}</td>
                <td class="lb-num-cell">${row.total_scans}</td>
                <td class="lb-num-cell">${row.correct}</td>
                <td class="lb-num-cell">${row.avg_accuracy}%</td>
                <td><span class="accuracy-badge" style="background:${getAccuracyColor(row.best_accuracy)}">${row.best_accuracy}%</span></td>
                <td class="lb-num-cell">${row.last_session || 'N/A'}</td>
            </tr>`).join('');
    } catch (error) {
        console.error('Proficiency report load error:', error);
        proficiencyReportData = [];
        updateProficiencySummary([]);
        tbody.innerHTML = `
            <tr>
                <td colspan="8" class="empty-state-cell">
                    <div class="empty-state">
                        <span class="empty-icon">⚠️</span>
                        <strong>Error loading proficiency reports</strong>
                        <small>Please refresh the page or check backend connection</small>
                    </div>
                </td>
            </tr>`;
    }
}

function updateProficiencySummary(rows) {
    const totalStudentsEl = document.getElementById('report-total-students');
    const totalSessionsEl = document.getElementById('report-total-sessions');
    const averageAccuracyEl = document.getElementById('report-average-accuracy');
    const totalScansEl = document.getElementById('report-total-scans');

    const totalStudents = rows.length;
    const totalSessions = rows.reduce((sum, row) => sum + Number(row.sessions || 0), 0);
    const totalScans = rows.reduce((sum, row) => sum + Number(row.total_scans || 0), 0);
    const accuracyAvg = totalStudents > 0
        ? (rows.reduce((sum, row) => sum + Number(row.avg_accuracy || 0), 0) / totalStudents)
        : 0;

    if (totalStudentsEl) totalStudentsEl.textContent = totalStudents;
    if (totalSessionsEl) totalSessionsEl.textContent = totalSessions;
    if (averageAccuracyEl) averageAccuracyEl.textContent = `${accuracyAvg.toFixed(1)}%`;
    if (totalScansEl) totalScansEl.textContent = totalScans;
}

function searchProficiencyReports(searchTerm) {
    const tbody = document.getElementById('proficiency-report-body');
    if (!tbody) return;

    const clearBtn = document.getElementById('proficiency-search-clear');
    const term = String(searchTerm || '').toLowerCase().trim();
    if (clearBtn) clearBtn.style.display = term ? 'flex' : 'none';

    const rows = tbody.querySelectorAll('tr');

    // If table is in no-data/error empty mode, avoid injecting another empty state.
    if (rows.length === 1 && rows[0].querySelector('.empty-state')) {
        return;
    }

    let visibleCount = 0;

    rows.forEach((row) => {
        if (row.querySelector('.empty-state')) return;
        const nickname = row.querySelector('td:nth-child(2)')?.textContent.toLowerCase() || '';
        const rank = row.querySelector('td:nth-child(1)')?.textContent.toLowerCase() || '';
        const isVisible = !term || nickname.includes(term) || rank.includes(term);
        row.style.display = isVisible ? '' : 'none';
        if (isVisible) visibleCount += 1;
    });

    let emptyRow = tbody.querySelector('.proficiency-search-empty-row');
    if (visibleCount === 0 && term) {
        if (!emptyRow) {
            emptyRow = document.createElement('tr');
            emptyRow.className = 'proficiency-search-empty-row';
            emptyRow.innerHTML = `
                <td colspan="8" class="empty-state-cell">
                    <div class="empty-state">
                        <span class="empty-icon">🔍</span>
                        <strong>No report entries match "${searchTerm}"</strong>
                        <small>Try another nickname keyword</small>
                    </div>
                </td>
            `;
            tbody.appendChild(emptyRow);
        } else {
            emptyRow.style.display = '';
            const title = emptyRow.querySelector('strong');
            if (title) title.textContent = `No report entries match "${searchTerm}"`;
        }
    } else if (emptyRow) {
        emptyRow.style.display = 'none';
    }
}

function clearProficiencySearch() {
    const searchInput = document.getElementById('proficiency-search');
    const clearBtn = document.getElementById('proficiency-search-clear');

    if (searchInput) {
        searchInput.value = '';
        searchProficiencyReports('');
    }
    if (clearBtn) clearBtn.style.display = 'none';
}

function openProficiencyReportPrintPreview() {
    if (!Array.isArray(proficiencyReportData) || proficiencyReportData.length === 0) {
        showNotification('No proficiency report data available for preview yet', 'info');
        return;
    }

    try {
        const jsPdfRef = window.jspdf && window.jspdf.jsPDF;
        if (!jsPdfRef) {
            showNotification('Print preview library is unavailable', 'error');
            return;
        }

        const tableName = 'Student Proficiency Reports';
        const printedBy = document.body?.dataset?.adminUsername || 'Admin';
        const printedAt = new Date().toLocaleString();

        const summaryStudents = proficiencyReportData.length;
        const summarySessions = proficiencyReportData.reduce((sum, row) => sum + Number(row.sessions || 0), 0);
        const summaryScans = proficiencyReportData.reduce((sum, row) => sum + Number(row.total_scans || 0), 0);
        const summaryAvgAccuracy = summaryStudents > 0
            ? (proficiencyReportData.reduce((sum, row) => sum + Number(row.avg_accuracy || 0), 0) / summaryStudents)
            : 0;

        const doc = new jsPdfRef({
            orientation: 'portrait',
            unit: 'mm',
            format: 'a4'
        });

        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        const marginX = 10;

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(16);
        doc.text(tableName, marginX, 16);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.text(`Table Name: ${tableName}`, marginX, 23);
        doc.text(`Printed By: ${printedBy}`, marginX, 28);
        doc.text(`Printed On: ${printedAt}`, marginX, 33);

        doc.setDrawColor(31, 41, 55);
        doc.setLineWidth(0.5);
        doc.line(marginX, 36, pageWidth - marginX, 36);

        const summaryY = 40;
        const summaryGap = 2;
        const summaryBoxWidth = (pageWidth - (marginX * 2) - (summaryGap * 3)) / 4;
        const summaryBoxHeight = 14;
        const summaryItems = [
            { label: 'Students', value: String(summaryStudents) },
            { label: 'Assessment Sessions', value: String(summarySessions) },
            { label: 'Average Accuracy', value: `${summaryAvgAccuracy.toFixed(1)}%` },
            { label: 'Total Scans', value: String(summaryScans) }
        ];

        summaryItems.forEach((item, index) => {
            const x = marginX + index * (summaryBoxWidth + summaryGap);
            doc.setDrawColor(203, 213, 225);
            doc.setLineWidth(0.2);
            doc.roundedRect(x, summaryY, summaryBoxWidth, summaryBoxHeight, 1.5, 1.5);
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8);
            doc.text(item.label, x + 2, summaryY + 5);
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(11);
            doc.text(item.value, x + 2, summaryY + 11);
        });

        const headers = ['#', 'Nickname', 'Sessions', 'Total Scans', 'Correct', 'Avg Accuracy', 'Best Accuracy', 'Last Session'];
    const widthRatios = [0.55, 2.2, 1.0, 1.35, 1.0, 1.35, 1.45, 1.9];
    const ratioTotal = widthRatios.reduce((sum, value) => sum + value, 0);
    const usableTableWidth = pageWidth - (marginX * 2);
    const colWidths = widthRatios.map((ratio) => (usableTableWidth * ratio) / ratioTotal);
    const startX = marginX;
        const rowHeight = 7;
    const pageBottom = pageHeight - 12;

        const drawTableHeader = (y) => {
            let x = startX;
            doc.setFillColor(15, 23, 42);
            doc.setDrawColor(15, 23, 42);
            doc.rect(startX, y, usableTableWidth, rowHeight, 'F');

            doc.setTextColor(255, 255, 255);
            doc.setDrawColor(148, 163, 184);
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(7.5);

            headers.forEach((header, i) => {
                doc.rect(x, y, colWidths[i], rowHeight, 'D');
                doc.text(String(header), x + (colWidths[i] / 2), y + 4.6, { align: 'center' });
                x += colWidths[i];
            });
        };

        let currentY = summaryY + summaryBoxHeight + 5;
        drawTableHeader(currentY);
        currentY += rowHeight;

        doc.setTextColor(17, 24, 39);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);

        proficiencyReportData.forEach((row) => {
            if (currentY + rowHeight > pageBottom) {
                doc.addPage();
                currentY = 15;
                drawTableHeader(currentY);
                currentY += rowHeight;
                doc.setTextColor(17, 24, 39);
                doc.setFont('helvetica', 'normal');
                doc.setFontSize(8);
            }

            const rowData = [
                String(row.rank ?? ''),
                String(row.nickname ?? ''),
                String(row.sessions ?? ''),
                String(row.total_scans ?? ''),
                String(row.correct ?? ''),
                `${String(row.avg_accuracy ?? '')}%`,
                `${String(row.best_accuracy ?? '')}%`,
                String(row.last_session || 'N/A')
            ];

            let x = startX;
            rowData.forEach((cell, i) => {
                doc.setDrawColor(226, 232, 240);
                doc.rect(x, currentY, colWidths[i], rowHeight);
                const maxWidth = colWidths[i] - 2;
                const text = doc.splitTextToSize(cell, maxWidth);
                doc.text(text[0] || '', x + 1, currentY + 4.5);
                x += colWidths[i];
            });

            currentY += rowHeight;
        });

        const pdfUrl = doc.output('bloburl');
        const previewWindow = window.open(pdfUrl, '_blank');
        if (!previewWindow) {
            showNotification('Please allow pop-ups to open print preview', 'error');
            return;
        }

        showNotification('🖨️ Print preview opened', 'success');

        setTimeout(() => {
            URL.revokeObjectURL(pdfUrl);
        }, 120000);
    } catch (error) {
        console.error('Proficiency print preview error:', error);
        showNotification('❌ Unable to open print preview', 'error');
    }
}

// ============================================
// ASSET REPOSITORY (PDF Generation)
// NOTE: loadAssetRepository() and viewCategoryCards() are
// OVERRIDDEN by admin_optimized.js for better performance
// ============================================

let assetData = null; // Used by PDF generation

// Bond paper (8.5x11in) with a true-size 4x5in EcoCard centered on each page.
const PDF_PAGE = {
    width: 8.5,
    height: 11,
    cardWidth: 4,
    cardHeight: 5
};

function getCardOrigin() {
    return {
        x: (PDF_PAGE.width - PDF_PAGE.cardWidth) / 2,
        y: (PDF_PAGE.height - PDF_PAGE.cardHeight) / 2
    };
}

function drawEcoCardToPdf(pdf, imageData) {
    const origin = getCardOrigin();

    // Card base
    pdf.setFillColor(255, 255, 255);
    pdf.roundedRect(origin.x + 0.06, origin.y + 0.06, 3.88, 4.88, 0.16, 0.16, 'F');

    // Main card border
    pdf.setDrawColor(51, 51, 51);
    pdf.setLineWidth(0.022);
    pdf.roundedRect(origin.x + 0.1, origin.y + 0.1, 3.8, 4.8, 0.15, 0.15, 'S');

    // Image panel
    pdf.setFillColor(247, 247, 247);
    pdf.roundedRect(origin.x + 0.35, origin.y + 0.35, 3.3, 3.48, 0.14, 0.14, 'F');

    if (imageData) {
        pdf.addImage(imageData.dataUrl, imageData.format, origin.x + 0.5, origin.y + 0.5, 3, 3.1, undefined, 'MEDIUM');
    }

    // Footer brand lockup
    pdf.setDrawColor(220, 220, 220);
    pdf.setLineWidth(0.01);
    pdf.line(origin.x + 0.45, origin.y + 4.28, origin.x + 3.55, origin.y + 4.28);

    pdf.setFontSize(9);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(90, 90, 90);
    pdf.text('EcoLearn Eco-Card', origin.x + 2, origin.y + 4.56, { align: 'center' });

    pdf.setFontSize(7);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(145, 145, 145);
    pdf.text('Scan to identify and sort correctly', origin.x + 2, origin.y + 4.76, { align: 'center' });
}

function getHighQualityImagePath(imagePath) {
    if (!imagePath || typeof imagePath !== 'string') return imagePath;
    return imagePath
        .replace(/^assets\//i, 'assets_png/')
        .replace(/\.webp$/i, '.png');
}

// Stub - overridden by admin_optimized.js
async function loadAssetRepository() {
    // Actual implementation in admin_optimized.js
}

// Stub - overridden by admin_optimized.js  
function viewCategoryCards(category) {
    // Actual implementation in admin_optimized.js
}

function closeCardsModal() {
    const modal = document.getElementById('cards-modal');
    modal.classList.remove('active');
    
    // Fast hide after animation
    setTimeout(() => {
        modal.style.display = 'none';
    }, 200);
}

function downloadCategoryPDF(category) {
    // Show confirmation modal
    showDownloadConfirmModal(category, null, null);
}

// ============================================
// DOWNLOAD CONFIRMATION MODAL
// ============================================
function showDownloadConfirmModal(category, cardId, cardName) {
    const isAllCards = cardId === null;
    const title = isAllCards ? `Download All ${category} Cards` : `Download "${cardName}"`;
    const message = isAllCards 
        ? `This will generate a printable PDF containing all cards in the ${category} category.`
        : `This will generate a printable 4×5 inch PDF card for "${cardName}".`;
    
    // Create modal if it doesn't exist
    let modal = document.getElementById('download-confirm-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'download-confirm-modal';
        modal.className = 'cards-modal';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 450px; text-align: center;">
                <img src="/assets/leafframe.png" class="preview-frame-overlay" alt="Leaf Frame">
                <button class="modal-close" onclick="closeDownloadConfirmModal()">✕</button>
                <div class="modal-header">
                    <h4 id="download-modal-title">Download</h4>
                </div>
                <div style="padding: 1.5rem;">
                    <div style="font-size: 3rem; margin-bottom: 1rem;">📄</div>
                    <p id="download-modal-message" style="margin-bottom: 1.5rem; color: #64748b;"></p>
                    <div style="background: #f1f5f9; border-radius: 8px; padding: 1rem; margin-bottom: 1.5rem; text-align: left;">
                        <div style="font-weight: 600; color: #334155; margin-bottom: 0.5rem;">📁 Download Location:</div>
                        <div style="color: #64748b; font-size: 0.9rem;">Your browser's default <strong>Downloads</strong> folder</div>
                        <div style="color: #94a3b8; font-size: 0.8rem; margin-top: 0.5rem;">File: <span id="download-filename" style="font-family:'Fredoka', sans-serif;"></span></div>
                    </div>
                    <div style="display: flex; gap: 1rem; justify-content: center;">
                        <button class="btn-secondary" onclick="closeDownloadConfirmModal()">Cancel</button>
                        <button id="download-confirm-btn" class="btn-primary">📥 Download PDF</button>
                    </div>
                </div>
            </div>
        `;
        // Close on backdrop click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeDownloadConfirmModal();
        });
        document.body.appendChild(modal);
    }
    
    // Update modal content
    document.getElementById('download-modal-title').textContent = title;
    document.getElementById('download-modal-message').textContent = message;
    
    // Show expected filename
    const filename = isAllCards ? `EcoLearn_${category.replace(/\\s+/g, '_')}_Cards.pdf` : `EcoLearn_${cardName.replace(/\\s+/g, '_')}.pdf`;
    document.getElementById('download-filename').textContent = filename;
    
    // Set up confirm button action
    const confirmBtn = document.getElementById('download-confirm-btn');
    confirmBtn.onclick = () => {
        closeDownloadConfirmModal();
        if (isAllCards) {
            executeDownloadAllPDF(category);
        } else {
            executeDownloadSinglePDF(cardId, cardName);
        }
    };
    
    // Show modal
    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('active'));
}

function closeDownloadConfirmModal() {
    const modal = document.getElementById('download-confirm-modal');
    if (modal) {
        modal.classList.remove('active');
        setTimeout(() => modal.style.display = 'none', 200);
    }
}

// Execute Download All PDF for a category - Creates ACTUAL downloadable PDF file
async function executeDownloadAllPDF(category) {
    // Close modal and show loading state
    closeDownloadConfirmModal();
    showNotification('Generating PDF...', 'info');
    
    try {
        // Get cards from cache
        const data = await OptimizedAdmin.loadAssets();
        if (!data || !data.categories[category]) {
            alert('❌ Error: Could not load cards for this category.');
            return;
        }
        
        const cards = data.categories[category].cards;
        const { jsPDF } = window.jspdf;
        
        // Create bond-paper PDF and place true-size 4x5in card in the center.
        const pdf = new jsPDF({
            orientation: 'portrait',
            unit: 'in',
            format: [PDF_PAGE.width, PDF_PAGE.height]
        });
        
        // Process each card
        for (let i = 0; i < cards.length; i++) {
            const card = cards[i];
            
            if (i > 0) {
                pdf.addPage([PDF_PAGE.width, PDF_PAGE.height]);
            }

            let imgData = null;
            // Load and add image
            try {
                const highQualityPath = getHighQualityImagePath(card.image_path);
                imgData = await loadImageAsBase64('/' + highQualityPath, '/' + card.image_path);
            } catch (e) {
                console.warn('Image load failed for:', card.card_name);
            }

            drawEcoCardToPdf(pdf, imgData);
        }
        
        // Download the PDF
        const filename = `EcoLearn_${category.replace(/\\s+/g, '_')}_Cards.pdf`;
        pdf.save(filename);
        showNotification(`Downloaded ${cards.length} cards!`, 'success');
        
    } catch (error) {
        console.error('Download all error:', error);
        showNotification('❌ Error generating PDF', 'error');
    }
}

// Execute single card PDF download - Creates ACTUAL downloadable PDF file
async function executeDownloadSinglePDF(cardId, cardName) {
    // Close modal and show loading state
    closeDownloadConfirmModal();
    showNotification('📄 Generating PDF...', 'info');
    
    try {
        const response = await fetch(`${API_URL}/admin/generate-pdf/${cardId}`);
        const data = await response.json();
        
        if (data.status === 'success') {
            const { jsPDF } = window.jspdf;
            
            // Create bond-paper PDF and place true-size 4x5in card in the center.
            const pdf = new jsPDF({
                orientation: 'portrait',
                unit: 'in',
                format: [PDF_PAGE.width, PDF_PAGE.height]
            });

            let imgData = null;
            // Load and add image
            try {
                const highQualityPath = getHighQualityImagePath(data.card.image_path);
                imgData = await loadImageAsBase64('/' + highQualityPath, '/' + data.card.image_path);
            } catch (e) {
                console.warn('Image load failed');
            }

            drawEcoCardToPdf(pdf, imgData);
            
            // Download the PDF
            const filename = `EcoLearn_${cardName.replace(/\\s+/g, '_')}.pdf`;
            pdf.save(filename);
            showNotification('✅ PDF downloaded!', 'success');
        } else {
            showNotification('❌ Error: ' + data.message, 'error');
        }
    } catch (error) {
        console.error('PDF generation error:', error);
        showNotification('❌ Error generating PDF', 'error');
    }
}

// Helper: Load image as base64 for jsPDF (optimized for speed)
function loadImageAsBase64(primaryImagePath, fallbackImagePath = null) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            // Keep high quality for print output (~300 DPI target area).
            const maxSize = 1200;
            let width = img.width;
            let height = img.height;
            
            if (width > maxSize || height > maxSize) {
                const ratio = Math.min(maxSize / width, maxSize / height);
                width = Math.floor(width * ratio);
                height = Math.floor(height * ratio);
            }
            
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, width, height);
            ctx.drawImage(img, 0, 0, width, height);
            resolve({
                dataUrl: canvas.toDataURL('image/png'),
                format: 'PNG'
            });
        };
        img.onerror = () => {
            if (fallbackImagePath && img.src !== fallbackImagePath) {
                img.src = fallbackImagePath;
                return;
            }
            resolve(null);
        };
        img.src = primaryImagePath;
    });
}

// Helper: Get category color as RGB for jsPDF
function getCategoryColorRGB(category) {
    const colors = {
        'Compostable': { r: 34, g: 197, b: 94 },      // Green
        'Recyclable': { r: 59, g: 130, b: 246 },       // Blue
        'Non-Recyclable': { r: 239, g: 68, b: 68 },    // Red
        'Special Waste': { r: 245, g: 158, b: 11 }     // Orange
    };
    return colors[category] || { r: 100, g: 100, b: 100 };
}

function getCategoryIcon(category) {
    const icons = {
        'Compostable': '',
        'Recyclable': '',
        'Non-Recyclable': '',
        'Special Waste': ''
    };
    return icons[category] || '';
}

async function generatePDF(cardId, cardName) {
    // Show confirmation modal instead of direct print
    showDownloadConfirmModal(null, cardId, cardName);
}

// ============================================
// CARD GALLERY
// NOTE: These functions are OVERRIDDEN by admin_optimized.js
// The stubs exist for fallback compatibility only
// ============================================

// Stub - overridden by admin_optimized.js
async function loadCardGallery() {
    // Actual implementation uses OptimizedAdmin.renderCardGallery()
}

// Stub - overridden by admin_optimized.js
function applyFiltersAndSearch() {
    // Actual implementation uses OptimizedAdmin.renderCardGallery()
}

// Debounced search for better performance
const debouncedSearch = debounce(() => {
    if (typeof OptimizedAdmin !== 'undefined') {
        OptimizedAdmin.renderCardGallery(currentFilter, currentSearchTerm);
    }
}, 150);

function searchCards(searchTerm) {
    currentSearchTerm = searchTerm;
    
    // Show/hide clear button
    const clearBtn = document.getElementById('card-search-clear');
    if (clearBtn) {
        clearBtn.style.display = searchTerm ? 'flex' : 'none';
    }
    
    debouncedSearch();
}

function clearSearch() {
    const searchInput = document.getElementById('card-search');
    if (searchInput) {
        searchInput.value = '';
        searchCards('');
    }
}

function filterCardGallery(category) {
    currentFilter = category;
    
    // Update active filter button
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    event.target.classList.add('active');
    
    // Use optimized filtering
    if (typeof OptimizedAdmin !== 'undefined') {
        OptimizedAdmin.renderCardGallery(currentFilter, currentSearchTerm);
    }
}

// Preview card in modal - optimized to reuse modal and preloaded images
function previewCard(cardId, cardName, category, imagePath) {
    // Create modal once and reuse
    let modal = document.getElementById('card-preview-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'card-preview-modal';
        modal.className = 'card-preview-modal';
        modal.innerHTML = `
            <div class="preview-modal-content">
                <img src="/assets/leafframe.png" class="preview-frame-overlay" alt="Leaf Frame">
                <button class="preview-modal-close" onclick="closeCardPreview()">✕</button>
                <div class="preview-modal-header">
                    <h4 id="preview-modal-name"></h4>
                </div>
                <div class="preview-modal-body">
                    <div class="preview-image">
                        <img id="preview-modal-img" src="" alt="">
                    </div>
                    <div class="preview-info">
                        <span id="preview-modal-category" class="preview-cat-badge"></span>
                        <div class="preview-actions">
                            <button class="btn-replace" id="preview-modal-replace-btn">
                                ✏️                            
                            </button>
                            <button class="btn-delete" id="preview-modal-delete-btn">
                                🗑️                            
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        
        // Add click outside to close
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeCardPreview();
        });
    }
    
    // Update modal content (much faster than rebuilding HTML)
    const img = document.getElementById('preview-modal-img');
    const nameEl = document.getElementById('preview-modal-name');
    const categoryEl = document.getElementById('preview-modal-category');
    const replaceBtn = document.getElementById('preview-modal-replace-btn');
    
    // Use the same image path that's already cached/loaded in the gallery
    img.src = imagePath;
    img.alt = cardName;
    img.onerror = function() { this.onerror=null; this.src = '/assets/binbin_neutral.png'; };
    nameEl.textContent = cardName;
    categoryEl.textContent = `${getCategoryIcon(category)} ${category}`;
    categoryEl.style.background  = getCategoryColor(category);
    categoryEl.style.color       = getCategoryTextColor(category);
    categoryEl.style.borderColor = getCategoryBorderColor(category);
    categoryEl.style.border      = `1px solid ${getCategoryBorderColor(category)}`;
    replaceBtn.onclick = () => {
        closeCardPreview();
        selectCardForReplacement(cardId, cardName, category, imagePath);
    };

    const deleteBtn = document.getElementById('preview-modal-delete-btn');
    deleteBtn.onclick = () => {
        closeCardPreview();
        showDeleteCardModal(cardId, cardName);
    };
    
    // Show modal immediately
    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('active'));
}

// ============================================
// DELETE CARD
// ============================================

function showDeleteCardModal(cardId, cardName) {
    let modal = document.getElementById('delete-card-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'delete-card-modal';
        modal.className = 'confirmation-modal';
        modal.innerHTML = `
            <div class="confirmation-content" onclick="event.stopPropagation()">
                <img src="/assets/leafframe.png" class="preview-frame-overlay" alt="Leaf Frame">
                <div class="confirmation-header">
                    <h3>🗑️ Delete Card</h3>
                </div>
                <div class="confirmation-body">
                    <p>Are you sure you want to delete <strong id="delete-card-name"></strong>?</p>
                    <p style="font-size:0.85rem; color:#ef4444; margin-top:0.5rem;">This will permanently remove the card and its recognition data.</p>
                </div>
                <div class="confirmation-actions">
                    <button class="btn-confirm-cancel" onclick="closeDeleteCardModal()">Cancel</button>
                    <button class="btn-confirm-save danger" id="delete-card-confirm-btn">🗑️ Delete</button>
                </div>
            </div>
        `;
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeDeleteCardModal();
        });
        document.body.appendChild(modal);
    }

    document.getElementById('delete-card-name').textContent = `"${cardName}"`;
    document.getElementById('delete-card-confirm-btn').onclick = () => confirmDeleteCard(cardId, cardName);

    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('active'));
}

function closeDeleteCardModal() {
    const modal = document.getElementById('delete-card-modal');
    if (modal) {
        modal.classList.remove('active');
        setTimeout(() => modal.style.display = 'none', 200);
    }
}

async function confirmDeleteCard(cardId, cardName) {
    closeDeleteCardModal();
    showNotification('Deleting card...', 'info');

    try {
        const response = await fetch(`${API_URL}/admin/cards/${cardId}`, { method: 'DELETE' });
        const data = await response.json();

        if (data.status === 'success') {
            showNotification(`🗑️ "${cardName}" deleted`, 'success');
            // Bust caches and re-render gallery
            if (typeof invalidateAllCaches === 'function') invalidateAllCaches();
            if (typeof OptimizedAdmin !== 'undefined') {
                await OptimizedAdmin.loadCardsFast(true);
                await OptimizedAdmin.loadAssets(true);
                OptimizedAdmin.renderCardGallery(currentFilter, currentSearchTerm);
            }
            setTimeout(() => smoothReloadPage(), 220);
        } else {
            showNotification(`❌ ${data.message}`, 'error');
        }
    } catch (error) {
        console.error('Delete card error:', error);
        showNotification('❌ Error deleting card', 'error');
    }
}

function closeCardPreview() {
    const modal = document.getElementById('card-preview-modal');
    if (modal) {
        modal.classList.remove('active');
        setTimeout(() => {
            modal.style.display = 'none';
        }, 200);
    }
}

function selectCardForReplacement(cardId, cardName, category, imagePath) {
    // Show the modal first
    const modal = document.getElementById('add-card-modal');
    modal.style.display = 'flex';
    
    // Use requestAnimationFrame to ensure modal is visible before populating
    requestAnimationFrame(() => {
        modal.classList.add('active');
        
        // Populate form for replacement mode
        document.getElementById('replace-card-id').value = cardId;
        document.getElementById('one-shot-name').value = cardName;
        
        // Set category dropdown
        const categoryMap = {
            'Compostable': '1',
            'Recyclable': '2',
            'Non-Recyclable': '3',
            'Special Waste': '4'
        };
        document.getElementById('one-shot-category').value = categoryMap[category] || '1';
        
        // Update UI to replacement mode
        document.getElementById('form-title').innerHTML = '🔄 Replace Card';
        document.getElementById('submit-btn-text').textContent = 'Update Card';
        document.getElementById('cancel-replace-btn').style.display = 'block';
        
        // Show current image in preview
        const preview = document.getElementById('image-preview');
        preview.innerHTML = `
            <div style="text-align:center;">
                <p style="font-size:0.85rem; margin-bottom:0.5rem; color:#64748b;">Current Image:</p>
                <img src="${imagePath}" style="max-width:150px; max-height:150px; border-radius:8px;" onerror="this.onerror=null;this.src='/assets/binbin_neutral.png'">
                <p style="font-size:0.8rem; margin-top:0.5rem; color:#64748b;">Upload a new image to replace</p>
            </div>
        `;
    });
}

function resetCardForm() {
    // Reset form to default "Add New Card" state
    document.getElementById('form-title').innerHTML = 'Add New Card';
    document.getElementById('replace-card-id').value = '';
    document.getElementById('one-shot-name').value = '';
    document.getElementById('one-shot-image').value = '';
    document.getElementById('image-preview').innerHTML = '<div class="image-preview-placeholder">Upload an image to preview</div>';
    document.getElementById('image-preview').classList.remove('has-image');
    document.getElementById('submit-btn-text').textContent = 'Register New Card';
    document.getElementById('cancel-replace-btn').style.display = 'none';
    
    const resultDiv = document.getElementById('one-shot-result');
    resultDiv.style.display = 'none';
    resultDiv.innerHTML = '';
    clearAddCardUiState();
}

function setAddCardModalLocked(locked) {
    const modal = document.getElementById('add-card-modal');
    if (!modal) return;

    isAddCardModalLocked = Boolean(locked);
    modal.classList.toggle('is-locked', isAddCardModalLocked);

    const controlIds = [
        'one-shot-name',
        'one-shot-category',
        'one-shot-image',
        'submit-card-btn',
        'cancel-replace-btn'
    ];

    controlIds.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = isAddCardModalLocked;
    });

    const closeBtn = modal.querySelector('.modal-close');
    if (closeBtn) closeBtn.disabled = isAddCardModalLocked;
}

function smoothReloadPage(delayMs = 420) {
    if (document.body.classList.contains('smooth-reloading')) return;

    document.body.classList.add('smooth-reloading');
    setTimeout(() => {
        window.location.reload();
    }, delayMs);
}

function cancelCardEdit() {
    if (isAddCardModalLocked) return;

    // Close the modal first, then reset form after it's hidden
    const modal = document.getElementById('add-card-modal');
    modal.classList.remove('active');
    setTimeout(() => {
        modal.style.display = 'none';
        setAddCardModalLocked(false);
        resetCardForm();
    }, 200);
}

function openAddCardModal() {
    const modal = document.getElementById('add-card-modal');
    setAddCardModalLocked(false);
    // Reset form when opening fresh
    resetCardForm();
    modal.style.display = 'flex';
    requestAnimationFrame(() => {
        modal.classList.add('active');
        saveAddCardUiState({
            modalOpen: true,
            tabId: 'one-shot',
            isReplacement: false,
            replaceCardId: '',
            cardName: '',
            categoryId: document.getElementById('one-shot-category')?.value || '1',
            previewHtml: document.getElementById('image-preview')?.innerHTML || '',
            previewHasImage: false,
            resultHtml: '',
            resultBackground: '',
            resultColor: '',
        });
    });
}

function closeAddCardModal(forceClose = false) {
    if (isAddCardModalLocked && !forceClose) return;

    const modal = document.getElementById('add-card-modal');
    modal.classList.remove('active');
    setTimeout(() => {
        modal.style.display = 'none';
        setAddCardModalLocked(false);
        resetCardForm();
    }, 200);
}

function previewCardImage() {
    const input = document.getElementById('one-shot-image');
    const preview = document.getElementById('image-preview');
    
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = function(e) {
            preview.innerHTML = `<img src="${e.target.result}" alt="Preview">`;
            preview.classList.add('has-image');
            saveAddCardUiState({
                modalOpen: true,
                tabId: 'one-shot',
                cardName: document.getElementById('one-shot-name')?.value.trim() || '',
                categoryId: document.getElementById('one-shot-category')?.value || '1',
                replaceCardId: document.getElementById('replace-card-id')?.value || '',
                isReplacement: Boolean(document.getElementById('replace-card-id')?.value),
                previewHtml: preview.innerHTML,
                previewHasImage: true,
            });
        };
        reader.readAsDataURL(input.files[0]);
    } else {
        preview.innerHTML = '<div class="image-preview-placeholder">Upload an image to preview</div>';
        preview.classList.remove('has-image');
        saveAddCardUiState({
            modalOpen: true,
            tabId: 'one-shot',
            previewHtml: preview.innerHTML,
            previewHasImage: false,
        });
    }
}

// ============================================
// ONE-SHOT LEARNING (Updated for Add/Replace)
// ============================================

async function submitOneShotLearning() {
    const nameInput = document.getElementById('one-shot-name');
    const categorySelect = document.getElementById('one-shot-category');
    const imageInput = document.getElementById('one-shot-image');
    const resultDiv = document.getElementById('one-shot-result');
    const replaceCardId = document.getElementById('replace-card-id').value;
    
    const cardName = nameInput.value.trim();
    const categoryId = categorySelect.value;
    const imageFile = imageInput.files[0];
    
    if (!cardName || !imageFile) {
        resultDiv.style.display = 'block';
        resultDiv.style.background = '#FEE2E2';
        resultDiv.style.color = '#DC2626';
        resultDiv.innerHTML = '⚠️ Please fill all fields and upload an image.';
        return;
    }
    
    const isReplacement = replaceCardId !== '';
    resultDiv.style.display = 'block';
    resultDiv.style.background = '#FEF3C7';
    resultDiv.style.color = '#D97706';
    resultDiv.innerHTML = `⏳ ${isReplacement ? 'Updating' : 'Processing'} image and extracting features...`;
    setAddCardModalLocked(true);
    saveAddCardUiState({
        modalOpen: true,
        tabId: 'one-shot',
        isReplacement,
        replaceCardId,
        cardName,
        categoryId,
        resultHtml: resultDiv.innerHTML,
        resultBackground: resultDiv.style.background,
        resultColor: resultDiv.style.color,
        previewHtml: document.getElementById('image-preview')?.innerHTML || '',
        previewHasImage: document.getElementById('image-preview')?.classList.contains('has-image') || false,
    });
    
    try {
        const formData = new FormData();
        formData.append('card_name', cardName);
        formData.append('category_id', categoryId);
        formData.append('image', imageFile);
        
        if (isReplacement) {
            formData.append('replace_card_id', replaceCardId);
        }
        
        const response = await fetch(`${API_URL}/admin/one-shot-learn`, {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        
        if (data.status === 'success') {
            resultDiv.style.background = '#DCFCE7';
            resultDiv.style.color = '#10B981';
            
            // Show success with dual storage info
            let storageInfo = '';
            if (data.png_path && data.webp_path) {
                storageInfo = '<span class="result-subline">📸 Training: PNG | 🌐 Display: WebP</span>';
            }

            const variantsInfo = (typeof data.variants_generated === 'number')
                ? `<span class="result-subline">🧪 Variants generated: ${data.variants_generated}</span>`
                : '';

            const retrainInfo = data.cnn_retrain_message
                ? `<span class="result-subline">🧠 ORB Retrain: ${data.cnn_retrain_message}</span>`
                : '';

            const pipelineWarning = data.pipeline_warning
                ? `<span class="result-subline warning">⚠️ ${data.pipeline_warning}</span>`
                : '';

            resultDiv.innerHTML = `<div class="result-title">✅ ${data.message}</div><span class="result-subline">Card Code: ${data.card_code} | Features: ${data.features_extracted}</span>${storageInfo}${variantsInfo}${retrainInfo}${pipelineWarning}`;
            saveAddCardUiState({
                modalOpen: true,
                tabId: 'one-shot',
                isReplacement,
                replaceCardId,
                cardName,
                categoryId,
                resultHtml: resultDiv.innerHTML,
                resultBackground: resultDiv.style.background,
                resultColor: resultDiv.style.color,
            });
            
            // Keep modal open while ORB retraining runs; close only on completion.
            if (!data.cnn_retrain_started) {
                setTimeout(() => {
                    closeAddCardModal(true);
                    if (!isReplacement) {
                        setTimeout(() => smoothReloadPage(), 220);
                    }
                }, 2000);
            }
            
            // STATE-DRIVEN UPDATE: Sync both views via AppState
            if (typeof AppState !== 'undefined') {
                // If we have the full card data, use universalCardUpdate
                if (data.card) {
                    AppState.universalCardUpdate(isReplacement ? 'update' : 'add', data.card);
                } else {
                    // Fallback: force-refresh caches so newly added cards appear immediately.
                    if (typeof OptimizedAdmin !== 'undefined' && OptimizedAdmin.cache) {
                        OptimizedAdmin.cache.invalidate('assets');
                        OptimizedAdmin.cache.invalidate('cards');
                        OptimizedAdmin.cache.invalidate('counts');
                    }

                    // Reset AppState load guard and pull fresh data.
                    AppState.isLoaded = false;
                    AppState.cards = [];
                    AppState.categories = {};

                    // Reload everything from server
                    await AppState.loadAll();
                }
            } else {
                // Fallback for legacy mode
                loadCardGallery();
                loadAssetRepository();
            }

            if (data.cnn_retrain_started) {
                await monitorCnnRetrainProgress(resultDiv, !isReplacement);
            }
        } else {
            resultDiv.style.background = '#FEE2E2';
            resultDiv.style.color = '#DC2626';
            resultDiv.innerHTML = `❌ ${data.message}`;
            setAddCardModalLocked(false);
            clearAddCardUiState();
        }
        
    } catch (error) {
        console.error('One-shot learning error:', error);
        resultDiv.style.display = 'block';
        resultDiv.style.background = '#FEE2E2';
        resultDiv.style.color = '#DC2626';
        resultDiv.innerHTML = '❌ Error connecting to server.';
        setAddCardModalLocked(false);
        clearAddCardUiState();
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function monitorCnnRetrainProgress(resultDiv, shouldReloadOnSuccess = false) {
    const maxChecks = 120; // ~6 minutes at 3s interval
    let checks = 0;

    const statusId = 'cnn-retrain-live-status';
    let statusEl = document.getElementById(statusId);
    if (!statusEl) {
        resultDiv.insertAdjacentHTML('beforeend', `<span id="${statusId}" class="result-subline"></span>`);
        statusEl = document.getElementById(statusId);
    }

    saveAddCardUiState({
        modalOpen: true,
        tabId: 'one-shot',
        resultHtml: resultDiv.innerHTML,
        resultBackground: resultDiv.style.background,
        resultColor: resultDiv.style.color,
    });

    while (checks < maxChecks) {
        checks += 1;
        try {
            const response = await fetch(`${API_URL}/admin/cnn-training-status`);
            const data = await response.json();
            if (data.status !== 'success' || !data.training) {
                await sleep(3000);
                continue;
            }

            const t = data.training;
            const state = t.state || 'unknown';

            if (state === 'queued' || state === 'running') {
                resultDiv.style.background = '#FEF3C7';
                resultDiv.style.color = '#92400E';
                if (statusEl) statusEl.textContent = `⏳ ORB retraining ${state}...`;
                saveAddCardUiState({
                    modalOpen: true,
                    tabId: 'one-shot',
                    resultHtml: resultDiv.innerHTML,
                    resultBackground: resultDiv.style.background,
                    resultColor: resultDiv.style.color,
                });
                await sleep(3000);
                continue;
            }

            if (state === 'idle') {
                resultDiv.style.background = '#FEF3C7';
                resultDiv.style.color = '#92400E';
                if (statusEl) {
                    statusEl.textContent = '⚠️ Retraining is idle (no active job). Please click Add/Update again, then keep this modal open.';
                }
                setAddCardModalLocked(false);
                clearAddCardUiState();
                return;
            }

            if (state === 'completed') {
                resultDiv.style.background = '#DCFCE7';
                resultDiv.style.color = '#10B981';
                if (statusEl) statusEl.textContent = '✅ ORB retraining completed. Model updated.';
                setTimeout(() => {
                    closeAddCardModal(true);
                    if (shouldReloadOnSuccess) {
                        setTimeout(() => smoothReloadPage(), 220);
                    }
                }, 1200);
                clearAddCardUiState();
                return;
            }

            if (state === 'failed') {
                resultDiv.style.background = '#FEE2E2';
                resultDiv.style.color = '#B91C1C';
                const err = t.last_error ? String(t.last_error) : 'Unknown training error';
                if (statusEl) statusEl.textContent = `❌ ORB retraining failed: ${err}`;
                setAddCardModalLocked(false);
                clearAddCardUiState();
                return;
            }

            await sleep(3000);
        } catch (error) {
            console.error('ORB status polling error:', error);
            await sleep(3000);
        }
    }

    resultDiv.style.background = '#FEF3C7';
    resultDiv.style.color = '#92400E';
    if (statusEl) {
        statusEl.textContent = '⚠️ ORB retraining is still running. You can close this modal and check status later.';
    }
    setAddCardModalLocked(false);
    clearAddCardUiState();
}

// ============================================
// SYSTEM CONFIGURATION (With Sliders)
// ============================================

const configMetadata = {
    'orb_feature_count': { icon: '🔬', type: 'number', min: 100, max: 2000, step: 100 },
    'knn_k_value': { icon: '🔢', type: 'number', min: 1, max: 5, step: 1 },
    'knn_distance_threshold': { icon: '⚖️', type: 'slider', min: 0.5, max: 0.9, step: 0.05 },
    'cnn_confidence_threshold': { icon: '🧠', type: 'slider', min: 0.5, max: 0.95, step: 0.01 },
    'cnn_incremental_confidence_threshold': { icon: '🚀', type: 'slider', min: 0.5, max: 0.99, step: 0.01 },
    'cnn_focus_roi_scale': { icon: '🎯', type: 'slider', min: 0.5, max: 1.0, step: 0.05 },
    'hybrid_margin': { icon: '⚗️', type: 'slider', min: 0.02, max: 0.3, step: 0.01 },
    'min_confidence_score': { icon: '🎯', type: 'slider', min: 0.3, max: 0.9, step: 0.05 },
    'session_timeout_minutes': { icon: '⏱️', type: 'number', min: 5, max: 120, step: 5 },
    'webcam_fps': { icon: '📹', type: 'number', min: 15, max: 60, step: 5 },
    'roi_box_color': { icon: '🎨', type: 'color' },
    'enable_audio_feedback': { icon: '🔊', type: 'boolean' }
};

async function loadSystemConfig() {
    const container = document.getElementById('config-container');
    if (!container) return;
    
    try {
        const response = await fetch(`${API_URL}/admin/config`);
        const data = await response.json();
        
        if (data.status !== 'success' || !data.config) {
            container.innerHTML = `<div class="empty-state">
                <span class="empty-icon">⚙️</span>
                <strong>Unable to load configuration</strong>
                <small>Please refresh the page or check your connection</small>
            </div>`;
            return;
        }
        
        // Filter out locked configs
        const editableConfigs = data.config.filter(cfg => cfg.is_editable);
        
        container.innerHTML = editableConfigs.map(cfg => {
            const meta = configMetadata[cfg.config_key] || { icon: '⚙️', type: 'number', min: 0, max: 100, step: 1 };
            const value = parseFloat(cfg.config_value);
            
            if (!cfg.is_editable) {
                return `
                    <div class="config-card locked">
                        <div class="config-icon">${meta.icon}</div>
                        <div class="config-title">${formatConfigKey(cfg.config_key)}</div>
                        <p class="config-desc">${cfg.description}</p>
                        <div class="config-control">
                            <div class="value-display locked-value">
                                🔒 ${cfg.config_value}
                            </div>
                            <div class="lock-indicator">🔒 This setting is locked</div>
                        </div>
                    </div>
                `;
            }
            
            // Use slider for ratio/threshold values, number input for others
            if (meta.type === 'slider') {
                const percent = ((value - meta.min) / (meta.max - meta.min)) * 100;
                return `
                    <div class="config-card">
                        <div class="config-icon">${meta.icon}</div>
                        <div class="config-title">${formatConfigKey(cfg.config_key)}</div>
                        <p class="config-desc">${cfg.description}</p>
                        <div class="config-control">
                            <div class="slider-container">
                                <input type="range" 
                                       id="config-${cfg.config_key}"
                                       data-original="${value}"
                                       min="${meta.min}" 
                                       max="${meta.max}" 
                                       step="${meta.step}"
                                       value="${value}"
                                       style="--value: ${percent}%"
                                       oninput="updateSliderValue('${cfg.config_key}', this.value, ${meta.min}, ${meta.max})">
                                <div class="value-display" id="display-${cfg.config_key}">${cfg.config_value}</div>
                            </div>
                        </div>
                    </div>
                `;
            } else if (meta.type === 'boolean') {
                const isChecked = cfg.config_value === 'true' || cfg.config_value === '1';
                return `
                    <div class="config-card">
                        <div class="config-icon">${meta.icon}</div>
                        <div class="config-title">${formatConfigKey(cfg.config_key)}</div>
                        <p class="config-desc">${cfg.description}</p>
                        <div class="config-control">
                            <label class="toggle-switch">
                                <input type="checkbox" 
                                       id="config-${cfg.config_key}"
                                       data-original="${isChecked}"
                                       ${isChecked ? 'checked' : ''}
                                       onchange="updateToggleValue('${cfg.config_key}', this.checked)">
                                <span class="toggle-slider"></span>
                                <span class="toggle-label" id="display-${cfg.config_key}">${isChecked ? 'Enabled' : 'Disabled'}</span>
                            </label>
                        </div>
                    </div>
                `;
            } else if (meta.type === 'color') {
                return `
                    <div class="config-card">
                        <div class="config-icon">${meta.icon}</div>
                        <div class="config-title">${formatConfigKey(cfg.config_key)}</div>
                        <p class="config-desc">${cfg.description}</p>
                        <div class="config-control">
                            <div class="color-input-container">
                                <input type="color" 
                                       id="config-${cfg.config_key}"
                                       data-original="${cfg.config_value}"
                                       value="${cfg.config_value}"
                                       class="config-color-input"
                                       onchange="updateColorValue('${cfg.config_key}', this.value)">
                                <span class="color-value" id="display-${cfg.config_key}">${cfg.config_value}</span>
                            </div>
                        </div>
                    </div>
                `;
            } else {
                return `
                    <div class="config-card">
                        <div class="config-icon">${meta.icon}</div>
                        <div class="config-title">${formatConfigKey(cfg.config_key)}</div>
                        <p class="config-desc">${cfg.description}</p>
                        <div class="config-control">
                            <div class="number-input-container">
                                <button class="num-btn minus" onclick="adjustNumber('${cfg.config_key}', -${meta.step}, ${meta.min}, ${meta.max})">−</button>
                                <input type="number" 
                                       id="config-${cfg.config_key}"
                                       data-original="${value}"
                                       min="${meta.min}" 
                                       max="${meta.max}" 
                                       step="${meta.step}"
                                       value="${value}"
                                       class="config-number-input">
                                <button class="num-btn plus" onclick="adjustNumber('${cfg.config_key}', ${meta.step}, ${meta.min}, ${meta.max})">+</button>
                            </div>
                        </div>
                    </div>
                `;
            }
        }).join('');
        
    } catch (error) {
        console.error('Config load error:', error);
        container.innerHTML = '<div class="empty-state">Error loading configuration.</div>';
    }
}

function adjustNumber(configKey, delta, min, max) {
    const input = document.getElementById(`config-${configKey}`);
    if (!input) return;
    
    let newVal = parseFloat(input.value) + delta;
    newVal = Math.max(min, Math.min(max, newVal));
    input.value = newVal;
}

function updateSliderValue(configKey, value, min, max) {
    const display = document.getElementById(`display-${configKey}`);
    const slider = document.getElementById(`config-${configKey}`);
    
    if (display) display.textContent = value;
    
    // Update slider background gradient
    const percent = ((value - min) / (max - min)) * 100;
    if (slider) slider.style.setProperty('--value', `${percent}%`);
}

function updateToggleValue(configKey, isChecked) {
    const display = document.getElementById(`display-${configKey}`);
    if (display) display.textContent = isChecked ? 'Enabled' : 'Disabled';
}

function updateColorValue(configKey, colorValue) {
    const display = document.getElementById(`display-${configKey}`);
    if (display) display.textContent = colorValue;
}

function formatConfigKey(key) {
    const labels = {
        orb_feature_count: 'ORB Feature Count',
        knn_k_value: 'KNN K Value',
        knn_distance_threshold: 'KNN Distance Threshold',
        cnn_confidence_threshold: 'ORB Confidence Threshold',
        cnn_incremental_confidence_threshold: 'ORB Incremental Confidence Threshold',
        cnn_focus_roi_scale: 'ORB Focus ROI Scale',
        hybrid_margin: 'Hybrid Override Margin',
        min_confidence_score: 'Minimum Confidence Score',
        session_timeout_minutes: 'Session Timeout Minutes',
        webcam_fps: 'Webcam FPS',
        roi_box_color: 'ROI Box Color',
        enable_audio_feedback: 'Enable Audio Feedback',
        model_version: 'Model Version'
    };
    return labels[key] || key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

// Collect all changed configuration values
function getChangedConfigs() {
    const changes = [];
    
    // Check all config inputs for changes
    for (const key in configMetadata) {
        const input = document.getElementById(`config-${key}`);
        if (!input) continue;
        
        const originalValue = input.getAttribute('data-original');
        if (!originalValue) continue;
        
        let currentValue;
        if (input.type === 'checkbox') {
            currentValue = input.checked.toString();
        } else {
            currentValue = input.value;
        }
        
        // Compare string values
        if (originalValue !== currentValue) {
            changes.push({
                key: key,
                oldValue: originalValue,
                newValue: currentValue,
                displayName: formatConfigKey(key)
            });
        }
    }
    
    return changes;
}

// Show confirmation modal with changes
function showSaveConfirmation() {
    const changes = getChangedConfigs();
    
    if (changes.length === 0) {
        showToast('No changes to save', 'info');
        return;
    }
    
    const changesList = document.getElementById('configChangesList');
    changesList.innerHTML = changes.map(change => `
        <div class="config-change-item">
            <span class="key">${change.displayName}</span>
            <span class="value">${change.oldValue} → ${change.newValue}</span>
        </div>
    `).join('');
    
    const modal = document.getElementById('confirmationModal');
    modal.classList.add('active');
}

// Close confirmation modal and reset unsaved changes
function closeConfirmationModal() {
    const modal = document.getElementById('confirmationModal');
    modal.classList.remove('active');
    
    // Reset all inputs to their original values
    resetUnsavedChanges();
}

// Reset all config inputs to their original values
function resetUnsavedChanges() {
    for (const key in configMetadata) {
        const input = document.getElementById(`config-${key}`);
        if (!input) continue;
        
        const originalValue = input.getAttribute('data-original');
        if (!originalValue) continue;
        
        const meta = configMetadata[key];
        
        // Reset based on input type
        if (input.type === 'checkbox') {
            const shouldBeChecked = originalValue === 'true';
            input.checked = shouldBeChecked;
            updateToggleValue(key, shouldBeChecked);
        } else if (meta.type === 'slider') {
            input.value = originalValue;
            updateSliderValue(key, originalValue, meta.min, meta.max);
        } else if (meta.type === 'color') {
            input.value = originalValue;
            updateColorValue(key, originalValue);
        } else {
            input.value = originalValue;
        }
    }
}

// Handle clicking outside modal to close it
function handleModalBackdropClick(event) {
    if (event.target.id === 'confirmationModal') {
        closeConfirmationModal();
    }
}

// Confirm and save all config changes
async function confirmSaveAllConfig() {
    const changes = getChangedConfigs();
    
    if (changes.length === 0) {
        closeConfirmationModal();
        return;
    }
    
    const saveButton = document.querySelector('.btn-confirm-save');
    saveButton.disabled = true;
    saveButton.innerHTML = '<span>⏳</span><span>Saving...</span>';
    
    try {
        // Save all changes
        let successCount = 0;
        let failCount = 0;
        
        for (const change of changes) {
            try {
                const response = await fetch(`${API_URL}/admin/config`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        config_key: change.key,
                        config_value: change.newValue
                    })
                });
                
                const data = await response.json();
                
                if (data.status === 'success') {
                    successCount++;
                    // Update original value
                    const input = document.getElementById(`config-${change.key}`);
                    if (input) {
                        input.setAttribute('data-original', change.newValue);
                    }
                } else {
                    failCount++;
                    console.error(`Failed to save ${change.key}:`, data.message);
                }
            } catch (error) {
                failCount++;
                console.error(`Error saving ${change.key}:`, error);
            }
        }
        
        closeConfirmationModal();
        
        if (failCount === 0) {
            showToast(`Successfully saved ${successCount} settings!`, 'success');
        } else {
            showToast(`Saved ${successCount} settings, ${failCount} failed`, 'error');
        }
        
    } catch (error) {
        console.error('Config save error:', error);
        showToast('❌ Error saving configuration', 'error');
    } finally {
        saveButton.disabled = false;
        saveButton.innerHTML = '<span>💾</span><span>Confirm & Save</span>';
    }
}

// Legacy function - kept for compatibility but not used
async function saveConfig(configKey) {
    const input = document.getElementById(`config-${configKey}`);
    if (!input) {
        alert('❌ Configuration input not found');
        return;
    }
    
    // Handle different input types
    let newValue;
    if (input.type === 'checkbox') {
        newValue = input.checked ? 'true' : 'false';
    } else {
        newValue = input.value;
    }
    
    try {
        const response = await fetch(`${API_URL}/admin/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                config_key: configKey,
                config_value: newValue
            })
        });
        
        const data = await response.json();
        
        if (data.status === 'success') {
            // Show success animation
            const card = input.closest('.config-card');
            if (card) {
                card.style.borderColor = '#10B981';
                card.style.boxShadow = '0 0 20px rgba(16, 185, 129, 0.3)';
                
                setTimeout(() => {
                    card.style.borderColor = '';
                    card.style.boxShadow = '';
                }, 2000);
            }
            
            alert(`✅ ${data.message}`);
        } else {
            alert(`❌ ${data.message}`);
        }
        
    } catch (error) {
        console.error('Config save error:', error);
        alert('❌ Error saving configuration');
    }
}

// ============================================
// LOGOUT CONFIRMATION MODAL
// ============================================

function showLogoutModal() {
    const modal = document.getElementById('logoutModal');
    if (!modal) return;
    
    modal.style.display = 'flex';
    requestAnimationFrame(() => {
        modal.classList.add('active');
    });
}

function closeLogoutModal() {
    const modal = document.getElementById('logoutModal');
    if (!modal) return;
    
    modal.classList.remove('active');
    setTimeout(() => {
        modal.style.display = 'none';
    }, 200);
}

function handleLogoutModalBackdropClick(event) {
    if (event.target.id === 'logoutModal') {
        closeLogoutModal();
    }
}

function confirmLogout() {
    // Close modal first for smooth transition
    closeLogoutModal();
    
    // Redirect to logout
    setTimeout(() => {
        window.location.href = 'auth.php?action=logout';
    }, 200);
}
