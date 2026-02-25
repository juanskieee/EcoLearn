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
    
    // ESC key to close modals
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const confirmModal = document.getElementById('confirmationModal');
            const logoutModal = document.getElementById('logoutModal');
            const removeNicknameModal = document.getElementById('remove-nickname-modal');
            const addNicknameModal = document.getElementById('add-nickname-modal');
            
            if (removeNicknameModal && removeNicknameModal.classList.contains('active')) {
                closeRemoveNicknameModal();
            } else if (addNicknameModal && addNicknameModal.style.display === 'flex') {
                closeAddNicknameModal();
            } else if (logoutModal && logoutModal.classList.contains('active')) {
                closeLogoutModal();
            } else if (confirmModal && confirmModal.classList.contains('active')) {
                closeConfirmationModal();
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

function showTab(tabId) {
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
    }
    
    // Add active to clicked nav item
    if (event && event.target) {
        const navItem = event.target.closest('.nav-item');
        if (navItem) navItem.classList.add('active');
    }

    // Update top-header title based on active tab
    const tabTitles = {
        'overview':         'Overview',
        'confusion-matrix': 'Confusion Matrix',
        'leaderboard':      'Leaderboard',
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

    // Re-trigger popIn animation on the top-header
    const header = document.querySelector('.top-header');
    if (header) {
        header.style.animation = 'none';
        header.offsetHeight; // force reflow
        header.style.animation = '';
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
    
    if (!logs || logs.length === 0) {
        tbody.innerHTML = `<tr>
            <td colspan="5" class="empty-state-cell">
                <div class="table-empty-state">
                    <span class="empty-icon">📋</span>
                    <span class="empty-text">No recent scans found</span>
                    <span class="empty-hint">Scans will appear here when students start scanning</span>
                </div>
            </td>
        </tr>`;
        return;
    }
    
    tbody.innerHTML = logs.map(log => `
        <tr>
            <td>${new Date(log.time).toLocaleTimeString()}</td>
            <td>${log.nickname || 'Guest'}</td>
            <td><strong>${log.card}</strong> <span style="font-size:0.8em; color:#888">(${log.category})</span></td>
            <td>${log.confidence}%</td>
            <td>
                ${log.correct 
                    ? '<span class="badge-correct">Correct</span>' 
                    : '<span class="badge-error">Error</span>'}
            </td>
        </tr>
    `).join('');
}

function filterLogs(filterType, btnElement) {
    // UI toggle
    document.querySelectorAll('.pill').forEach(b => b.classList.remove('active'));
    btnElement.classList.add('active');
    
    // Logic
    let filtered = allLogs;
    if (filterType === 'correct') filtered = allLogs.filter(l => l.correct);
    if (filterType === 'incorrect') filtered = allLogs.filter(l => !l.correct);
    
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
                            <span class="tag-name">👤 ${student.nickname || student}</span>
                            <span class="tag-stats">
                                <span class="stat-chip sessions">📊 ${student.sessions || 0} session${student.sessions !== 1 ? 's' : ''}</span>
                                <span class="stat-chip accuracy">🎯 ${student.accuracy ? student.accuracy + '%' : '0 accuracy'}</span>
                                <span class="stat-chip created">🕗 ${createdTime || 'N/A'}</span>
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
                        <div class="tag-info">
                            <span class="tag-name">👤 ${name}</span>
                            <span class="tag-stats">
                                <span class="stat-chip sessions">📊 0 sessions</span>
                                <span class="stat-chip accuracy">🎯 N/A</span>
                                <span class="stat-chip created">🕗 N/A</span>
                                <span class="stat-chip new">✨ New</span>
                            </span>
                        </div>
                        <span class="remove" data-action="remove">×</span>
                    </div>
                `).join('');
            }
        } else {
            list.innerHTML = '<div class="empty-state">No students added yet<br><small style="font-size: 0.85rem; opacity: 0.7;">Click "Add Student" to get started</small></div>';
        }
    } catch (e) {
        console.error(e);
        const list = document.getElementById('nickname-list');
        if (list) {
            list.innerHTML = '<div class="empty-state">Error loading students<br><small style="font-size: 0.85rem; opacity: 0.7;">Please refresh the page</small></div>';
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
            emptyState.innerHTML = 'No students match your search<br><small style="font-size: 0.85rem; opacity: 0.7;">Try different keywords</small>';
            list.appendChild(emptyState);
        }
        emptyState.style.display = 'block';
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
    if (rows.length === 0 || (rows.length === 1 && rows[0].querySelector('.table-empty-state'))) {
        return;
    }
    
    const term = searchTerm.toLowerCase().trim();
    let visibleCount = 0;
    
    rows.forEach(row => {
        // Skip empty state rows
        if (row.querySelector('.table-empty-state') || row.querySelector('.empty-state-cell')) {
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
                    <div class="table-empty-state">
                        <span class="empty-icon">🔍</span>
                        <span class="empty-text">No students match "${searchTerm}"</span>
                        <span class="empty-hint">Try different keywords</span>
                    </div>
                </td>
            `;
            tbody.appendChild(emptyRow);
        } else {
            emptyRow.querySelector('.empty-text').textContent = `No students match "${searchTerm}"`;
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
        'Compostable':    '#10B981',
        'Recyclable':     '#3B82F6',
        'Non-Recyclable': '#EF4444',
        'Special Waste':  '#F59E0B'
    };
    const bgColors = labels.map(l => colors[l] || '#94A3B8');
    const borderColors = bgColors.map(c => c);

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
            container.innerHTML = '<div class="empty-state">No classification data available yet.</div>';
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
        container.innerHTML = '<div class="empty-state">Error loading confusion matrix.</div>';
    }
}

function getCategoryColor(category) {
    const colors = {
        'Compostable': '#10B981',
        'Recyclable': '#3B82F6',
        'Non-Recyclable': '#EF4444',
        'Special Waste': '#F59E0B'
    };
    return colors[category] || '#888';
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
            if (podium) podium.innerHTML = '';
            tbody.innerHTML = `<tr>
                <td colspan="7" class="empty-state-cell">
                    <div class="table-empty-state">
                        <span class="empty-icon">🏆</span>
                        <span class="empty-text">No rankings yet</span>
                        <span class="empty-hint">Students need to complete sessions in Assessment Mode to appear on the leaderboard</span>
                    </div>
                </td>
            </tr>`;
            return;
        }

        const lb = data.leaderboard;

        // ---- Podium (top 3) ----
        if (podium) {
            // order: 1st | 2nd | 3rd  top-to-bottom vertical column
            const slots = [
                { data: lb[0], rank: 1, medal: '🥇', cls: 'lb-podium-gold',   baseCls: 'lb-base-1' },
                { data: lb[1], rank: 2, medal: '🥈', cls: 'lb-podium-silver', baseCls: 'lb-base-2' },
                { data: lb[2], rank: 3, medal: '🥉', cls: 'lb-podium-bronze', baseCls: 'lb-base-3' },
            ];
            podium.innerHTML = slots.map(slot => {
                if (!slot.data) return `<div class="lb-podium-slot ${slot.cls}"><div class="lb-podium-card empty">—</div><div class="lb-podium-base ${slot.baseCls}">${slot.rank}${slot.rank===1?'st':slot.rank===2?'nd':'rd'}</div></div>`;
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

        // ---- Table (rank 4+) ----
        const rest = lb.slice(3);
        if (rest.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:1.5rem;color:#558B2F;font-weight:600;">Top 3 shown at the podium</td></tr>`;
        } else {
            tbody.innerHTML = rest.map(student => `
                <tr>
                    <td class="rank-cell">${student.rank}</td>
                    <td><strong>${student.nickname}</strong></td>
                    <td>${student.sessions}</td>
                    <td>${student.total_scans}</td>
                    <td>${student.correct}</td>
                    <td>
                        <div class="lb-acc-bar-wrap">
                            <div class="lb-acc-bar-fill" style="width:${student.avg_accuracy}%;background:${getAccuracyColor(student.avg_accuracy)}"></div>
                            <span class="lb-acc-label">${student.avg_accuracy}%</span>
                        </div>
                    </td>
                    <td><span class="accuracy-badge" style="background:${getAccuracyColor(student.best_accuracy)}">${student.best_accuracy}%</span></td>
                </tr>`).join('');
        }

    } catch (error) {
        console.error('Leaderboard error:', error);
        tbody.innerHTML = `<tr>
            <td colspan="7" class="empty-state-cell">
                <div class="table-empty-state">
                    <span class="empty-icon">⚠️</span>
                    <span class="empty-text">Error loading leaderboard</span>
                    <span class="empty-hint">Please refresh the page or check your connection</span>
                </div>
            </td>
        </tr>`;
    }
}

function getAccuracyColor(accuracy) {
    if (accuracy >= 90) return '#10B981';
    if (accuracy >= 75) return '#3B82F6';
    if (accuracy >= 50) return '#F59E0B';
    return '#EF4444';
}

// ============================================
// ASSET REPOSITORY (PDF Generation)
// NOTE: loadAssetRepository() and viewCategoryCards() are
// OVERRIDDEN by admin_optimized.js for better performance
// ============================================

let assetData = null; // Used by PDF generation

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
                <div class="modal-header">
                    <h4 id="download-modal-title">Download</h4>
                    <button class="modal-close" onclick="closeDownloadConfirmModal()">✕</button>
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
        const binColor = data.categories[category].bin_color;
        const { jsPDF } = window.jspdf;
        
        // Create PDF - 4x5 inches in points (1 inch = 72 points)
        const pdf = new jsPDF({
            orientation: 'portrait',
            unit: 'in',
            format: [4, 5]
        });
        
        // Process each card
        for (let i = 0; i < cards.length; i++) {
            const card = cards[i];
            
            if (i > 0) {
                pdf.addPage([4, 5]);
            }
            
            // Draw card border
            pdf.setDrawColor(51, 51, 51);
            pdf.setLineWidth(0.02);
            pdf.roundedRect(0.1, 0.1, 3.8, 4.8, 0.15, 0.15, 'S');
            
            // Load and add image
            try {
                const imgData = await loadImageAsBase64('/' + card.image_path);
                if (imgData) {
                    pdf.addImage(imgData, 'JPEG', 0.5, 0.3, 3, 2.5, undefined, 'FAST');
                }
            } catch (e) {
                console.warn('Image load failed for:', card.card_name);
            }
            
            // Add card name (centered below image)
            pdf.setFontSize(18);
            pdf.setFont('helvetica', 'bold');
            pdf.setTextColor(51, 51, 51);
            const nameLines = pdf.splitTextToSize(card.card_name, 3.2);
            pdf.text(nameLines, 2, 3.2, { align: 'center' });
            
            // Add EcoLearn branding at bottom
            pdf.setFontSize(8);
            pdf.setTextColor(150, 150, 150);
            pdf.text('EcoLearn Eco-Card', 2, 4.7, { align: 'center' });
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
            
            // Create PDF - 4x5 inches (thesis requirement)
            const pdf = new jsPDF({
                orientation: 'portrait',
                unit: 'in',
                format: [4, 5]
            });
            
            // Draw card border
            pdf.setDrawColor(51, 51, 51);
            pdf.setLineWidth(0.02);
            pdf.roundedRect(0.1, 0.1, 3.8, 4.8, 0.15, 0.15, 'S');
            
            // Load and add image
            try {
                const imgData = await loadImageAsBase64('/' + data.card.image_path);
                if (imgData) {
                    pdf.addImage(imgData, 'JPEG', 0.5, 0.3, 3, 2.5, undefined, 'FAST');
                }
            } catch (e) {
                console.warn('Image load failed');
            }
            
            // Add card name (centered below image)
            pdf.setFontSize(18);
            pdf.setFont('helvetica', 'bold');
            pdf.setTextColor(51, 51, 51);
            const nameLines = pdf.splitTextToSize(data.card.card_name, 3.2);
            pdf.text(nameLines, 2, 3.2, { align: 'center' });
            
            // Add EcoLearn branding at bottom
            pdf.setFontSize(8);
            pdf.setTextColor(150, 150, 150);
            pdf.text('EcoLearn Eco-Card', 2, 4.7, { align: 'center' });
            
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
function loadImageAsBase64(imagePath) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            // Resize to max 300px for faster PDF (4x5 inch print at 75dpi)
            const maxSize = 300;
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
            resolve(canvas.toDataURL('image/jpeg', 0.7)); // Lower quality for speed
        };
        img.onerror = () => resolve(null);
        img.src = imagePath;
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
        'Compostable': '🌱',
        'Recyclable': '♻️',
        'Non-Recyclable': '🗑️',
        'Special Waste': '⚠️'
    };
    return icons[category] || '📦';
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
                <button class="preview-close" onclick="closeCardPreview()">✕</button>
                <div class="preview-image">
                    <img id="preview-modal-img" src="" alt="">
                </div>
                <div class="preview-info">
                    <h3 id="preview-modal-name"></h3>
                    <p id="preview-modal-category"></p>
                    <div class="preview-actions">
                        <button class="btn-replace" id="preview-modal-replace-btn">
                            🔄 Replace This Card
                        </button>
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
    categoryEl.innerHTML = `<span style="color: ${getCategoryColor(category)}">${getCategoryIcon(category)} ${category}</span>`;
    replaceBtn.onclick = () => {
        closeCardPreview();
        selectCardForReplacement(cardId, cardName, category, imagePath);
    };
    
    // Show modal immediately
    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('active'));
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
    document.getElementById('form-title').innerHTML = '➕ Add New Card';
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
}

function cancelCardEdit() {
    // Close the modal first, then reset form after it's hidden
    const modal = document.getElementById('add-card-modal');
    modal.classList.remove('active');
    setTimeout(() => {
        modal.style.display = 'none';
        resetCardForm();
    }, 200);
}

function openAddCardModal() {
    const modal = document.getElementById('add-card-modal');
    // Reset form when opening fresh
    resetCardForm();
    modal.style.display = 'flex';
    requestAnimationFrame(() => {
        modal.classList.add('active');
    });
}

function closeAddCardModal() {
    const modal = document.getElementById('add-card-modal');
    modal.classList.remove('active');
    setTimeout(() => {
        modal.style.display = 'none';
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
        };
        reader.readAsDataURL(input.files[0]);
    } else {
        preview.innerHTML = '<div class="image-preview-placeholder">Upload an image to preview</div>';
        preview.classList.remove('has-image');
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
                storageInfo = `<br><small style="opacity: 0.7;">📸 Training: PNG | 🌐 Display: WebP</small>`;
            }
            resultDiv.innerHTML = `✅ ${data.message}<br><small style="opacity: 0.8;">Card Code: ${data.card_code} | Features: ${data.features_extracted}</small>${storageInfo}`;
            
            // Close modal after showing success
            setTimeout(() => {
                closeAddCardModal();
            }, 2000);
            
            // STATE-DRIVEN UPDATE: Sync both views via AppState
            if (typeof AppState !== 'undefined') {
                // If we have the full card data, use universalCardUpdate
                if (data.card) {
                    AppState.universalCardUpdate(isReplacement ? 'update' : 'add', data.card);
                } else {
                    // Fallback: reload everything from server
                    await AppState.loadAll();
                }
            } else {
                // Fallback for legacy mode
                loadCardGallery();
                loadAssetRepository();
            }
        } else {
            resultDiv.style.background = '#FEE2E2';
            resultDiv.style.color = '#DC2626';
            resultDiv.innerHTML = `❌ ${data.message}`;
        }
        
    } catch (error) {
        console.error('One-shot learning error:', error);
        resultDiv.style.display = 'block';
        resultDiv.style.background = '#FEE2E2';
        resultDiv.style.color = '#DC2626';
        resultDiv.innerHTML = '❌ Error connecting to server.';
    }
}

// ============================================
// SYSTEM CONFIGURATION (With Sliders)
// ============================================

const configMetadata = {
    'orb_feature_count': { icon: '🔬', type: 'number', min: 100, max: 2000, step: 100 },
    'knn_k_value': { icon: '🔢', type: 'number', min: 1, max: 5, step: 1 },
    'knn_distance_threshold': { icon: '⚖️', type: 'slider', min: 0.5, max: 0.9, step: 0.05 },
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
            container.innerHTML = '<div class="empty-state">Unable to load configuration.</div>';
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
    return key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
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
