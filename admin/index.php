<?php
require_once 'check_session.php';
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="icon" type="image/x-icon" href="../assets/binbin.ico">
    <title>EcoLearn Admin Dashboard</title>
    <!-- Modular Admin CSS (clean, organized, no spaghetti) -->
    <link rel="stylesheet" href="../css/admin_base.css">
    <link rel="stylesheet" href="../css/admin_sidebar.css">
    <link rel="stylesheet" href="../css/admin_overview.css">
    <link rel="stylesheet" href="../css/admin_leaderboards.css">
    <link rel="stylesheet" href="../css/admin_matrix.css">
    <link rel="stylesheet" href="../css/admin_assets.css">
    <link rel="stylesheet" href="../css/admin_cards.css">
    <link rel="stylesheet" href="../css/admin_config.css">
    <link rel="stylesheet" href="../css/admin_nicknames.css">
    <link rel="stylesheet" href="../css/admin_modals.css">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;600;700&family=Poppins:wght@400;600;700&display=swap" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <!-- jsPDF for actual PDF file generation -->
    <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
</head>
<body>

    <div class="admin-wrapper">
        <nav class="sidebar">
            <div class="sidebar-header">
                <img src="../assets/logo.png" class="logo-icon" alt="EcoLearn Logo">
            </div>
            
            <ul class="nav-links">
                <li>
                    <a href="javascript:void(0)" class="nav-item active" onclick="showTab('overview')">
                        Overview
                    </a>
                </li>
                <li>
                    <a href="javascript:void(0)" class="nav-item" onclick="showTab('confusion-matrix')">
                        Confusion Matrix
                    </a>
                </li>
                <li>
                    <a href="javascript:void(0)" class="nav-item" onclick="showTab('leaderboard')">
                        Leaderboard
                    </a>
                </li>
                <li>
                    <a href="javascript:void(0)" class="nav-item" onclick="showTab('asset-repository')">
                        Asset Repository
                    </a>
                </li>
                <li>
                    <a href="javascript:void(0)" class="nav-item" onclick="showTab('one-shot')">
                        Card Manager
                    </a>
                </li>
                <li>
                    <a href="javascript:void(0)" class="nav-item" onclick="showTab('config')">
                        System Config
                    </a>
                </li>
                <li>
                    <a href="javascript:void(0)" class="nav-item" onclick="showTab('logs')">
                        Scan Logs
                    </a>
                </li>
                <li>
                    <a href="javascript:void(0)" class="nav-item" onclick="showTab('nicknames')">
                        Students
                    </a>
                </li>
            </ul>

            <div class="sidebar-footer">
                <a href="javascript:void(0)" class="btn-logout" onclick="showLogoutModal()">
                    Logout
                </a>
            </div>
        </nav>

        <!-- Leaf Divider Frame -->
        <img src="../assets/leaf_divider.png" class="sidebar-divider" alt="Decorative Leaf Divider">

        <main class="main-content">
            
                <header class="top-header">
                    <h1 id="page-title">Overview</h1>
                    <div class="user-profile">
                        <img src="../assets/admin.png" class="admin-badge" alt="Admin">
                    </div>
                </header>       

            <section id="overview" class="section-card scrollable tab-content active">
                <div class="stats-grid">
                    <div class="stat-card blue">
                        <div class="stat-icon"><img src="../assets/camera_icon.png" alt="Total Scans"></div>
                        <div class="stat-details">
                            <div class="stat-value" id="stat-total">0</div>
                            <div class="stat-label">Total Scans</div>
                        </div>
                    </div>
                    
                    <div class="stat-card green">
                        <div class="stat-icon"><img src="../assets/check_icon.png" alt="Accuracy"></div>
                        <div class="stat-details">
                            <div class="stat-value" id="stat-accuracy">0%</div>
                            <div class="stat-label">Accuracy</div>
                        </div>
                    </div>
                    
                    <div class="stat-card purple">
                        <div class="stat-icon"><img src="../assets/target_icon.png" alt="Active Cards"></div>
                        <div class="stat-details">
                            <div class="stat-value" id="stat-cards">46</div>
                            <div class="stat-label">Active Cards</div>
                        </div>
                    </div>
                    
                    <div class="stat-card yellow">
                        <div class="stat-icon"><img src="../assets/graduate_icon.png" alt="Sessions"></div>
                        <div class="stat-details">
                            <div class="stat-value" id="stat-sessions">0</div>
                            <div class="stat-label">Sessions</div>
                        </div>
                    </div>
                </div>

                <div class="charts-row">
                    <div class="chart-wrapper">
                        <h4>📈 Activity Trends</h4>
                        <div class="chart-container">
                            <canvas id="performanceChart"></canvas>
                        </div>
                    </div>
                    <div class="chart-wrapper">
                        <h4>🗂️ Category Distribution</h4>
                        <div class="chart-container chart-container--doughnut">
                            <canvas id="categoryChart"></canvas>
                        </div>
                    </div>
                </div>
            </section>

            <!-- CONFUSION MATRIX SECTION -->
            <section id="confusion-matrix" class="section-card scrollable tab-content">
                <div id="confusion-matrix-container" class="matrix-container">
                    <div class="loading-cell"><div class="spinner"></div> Loading matrix data...</div>
                </div>
                
                <div id="category-accuracy" class="category-accuracy-grid"></div>
            </section>

            <!-- STUDENT LEADERBOARD SECTION -->
            <section id="leaderboard" class="section-card scrollable tab-content">
                <div class="lb-layout">

                    <!-- Left: search header + table -->
                    <div class="lb-left">
                        <div class="lb-section-header">
                            <div class="lb-section-header-left">
                                <p class="lb-subtitle">Student proficiency rankings based on assessment scores.</p>
                            </div>
                            <div class="lb-section-header-right">
                                <div class="lb-search-container">
                                    <input type="text" 
                                           class="lb-search-input" 
                                           id="leaderboard-search" 
                                           placeholder="🔍 Search students..."
                                           oninput="searchLeaderboard(this.value)">
                                    <button class="lb-search-clear-btn hidden" 
                                            id="leaderboard-search-clear" 
                                            onclick="clearLeaderboardSearch()">
                                        ✕
                                    </button>
                                </div>
                            </div>
                        </div>

                        <div class="lb-table-wrapper" id="lb-table-wrapper">
                            <div class="table-responsive leaderboard-table-container">
                                <table class="modern-table">
                                    <thead>
                                        <tr>
                                            <th>Rank</th>
                                            <th>Nickname</th>
                                            <th>Sessions</th>
                                            <th>Total Scans</th>
                                            <th>Correct</th>
                                            <th>Avg Accuracy</th>
                                            <th>Best Score</th>
                                        </tr>
                                    </thead>
                                    <tbody id="leaderboard-body">
                                        <tr>
                                            <td colspan="7" class="loading-cell">
                                                <div class="spinner"></div> Loading leaderboard...
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>

                    <!-- Right: podium -->
                    <div class="lb-right">
                        <div class="lb-podium" id="lb-podium"></div>
                    </div>

                </div>
            </section>

            <!-- ASSET REPOSITORY SECTION -->
            <section id="asset-repository" class="section-card scrollable tab-content">                
                <div class="asset-category-list">
                    <div class="asset-category-row compostable">
                        <div class="category-info">
                            <div class="category-icon"><img src="../assets/compostable_icon.png" alt="Compostable"></div>
                            <div class="category-details">
                                <h4>Compostable</h4>
                                <p class="card-count" id="count-compostable">-- cards</p>
                                <p class="category-desc">Biodegradable organic waste • Green Bin</p>
                            </div>
                        </div>
                        <div class="category-actions">
                            <button class="btn-view" onclick="viewCategoryCards('Compostable')">View Cards</button>
                            <button class="btn-download" onclick="downloadCategoryPDF('Compostable')">Download All</button>
                        </div>
                    </div>
                    
                    <div class="asset-category-row recyclable">
                        <div class="category-info">
                            <div class="category-icon"><img src="../assets/recyclable_icon.png" alt="Recyclable"></div>
                            <div class="category-details">
                                <h4>Recyclable</h4>
                                <p class="card-count" id="count-recyclable">-- cards</p>
                                <p class="category-desc">Reusable materials • Blue Bin</p>
                            </div>
                        </div>
                        <div class="category-actions">
                            <button class="btn-view" onclick="viewCategoryCards('Recyclable')">View Cards</button>
                            <button class="btn-download" onclick="downloadCategoryPDF('Recyclable')">Download All</button>
                        </div>
                    </div>
                    
                    <div class="asset-category-row non-recyclable">
                        <div class="category-info">
                            <div class="category-icon"><img src="../assets/non_recyclable_icon.png" alt="Non-Recyclable"></div>
                            <div class="category-details">
                                <h4>Non-Recyclable</h4>
                                <p class="card-count" id="count-non-recyclable">-- cards</p>
                                <p class="category-desc">Residual waste • Red Bin</p>
                            </div>
                        </div>
                        <div class="category-actions">
                            <button class="btn-view" onclick="viewCategoryCards('Non-Recyclable')">View Cards</button>
                            <button class="btn-download" onclick="downloadCategoryPDF('Non-Recyclable')">Download All</button>
                        </div>
                    </div>
                    
                    <div class="asset-category-row special">
                        <div class="category-info">
                            <div class="category-icon"><img src="../assets/special_waste_icon.png" alt="Special Waste"></div>
                            <div class="category-details">
                                <h4>Special Waste</h4>
                                <p class="card-count" id="count-special">-- cards</p>
                                <p class="category-desc">Hazardous materials • Yellow Bin</p>
                            </div>
                        </div>
                        <div class="category-actions">
                            <button class="btn-view" onclick="viewCategoryCards('Special Waste')">View Cards</button>
                            <button class="btn-download" onclick="downloadCategoryPDF('Special Waste')">Download All</button>
                        </div>
                    </div>
                </div>
            </section>

            <!-- CARD MANAGER SECTION -->
            <section id="one-shot" class="section-card scrollable tab-content">
                <div class="card-manager-header">
                    <div class="card-manager-header-left">
                        <div class="filter-buttons">
                            <button class="filter-btn active" onclick="filterCardGallery('all')">All Cards</button>
                            <button class="filter-btn" onclick="filterCardGallery('Compostable')"><img src="../assets/compostable_icon.png" class="filter-btn-icon" alt="">Compostable</button>
                            <button class="filter-btn" onclick="filterCardGallery('Recyclable')"><img src="../assets/recyclable_icon.png" class="filter-btn-icon" alt="">Recyclable</button>
                            <button class="filter-btn" onclick="filterCardGallery('Non-Recyclable')"><img src="../assets/non_recyclable_icon.png" class="filter-btn-icon" alt="">Non-Recyclable</button>
                            <button class="filter-btn" onclick="filterCardGallery('Special Waste')"><img src="../assets/special_waste_icon.png" class="filter-btn-icon" alt="">Special Waste</button>
                         </div>
                    </div>
                    <div class="card-manager-header-right">
                            <div class="search-bar-container">
                            <input type="text" 
                                id="card-search" 
                                class="card-search-input" 
                                placeholder="🔍 Search cards by name..." 
                                oninput="searchCards(this.value)">
                            <button class="search-clear-btn hidden" 
                                    id="card-search-clear" 
                                    onclick="clearSearch()">
                                ✕
                            </button>
                        </div>
                        <button class="btn-add-new-card" onclick="openAddCardModal()">
                            Add New Card
                        </button>
                    </div>
                </div>
                <div id="card-gallery" class="card-gallery-new">
                </div>
            </section>

            <!-- SYSTEM CONFIGURATION SECTION -->
            <section id="config" class="section-card scrollable tab-content">
                <div class="config-header-row">
                    <div class="config-header-left">
                        <p class="config-subtitle">Modify ORB-KNN algorithm parameters without changing source code.</p>
                    </div>
                    <div class="config-warning-box">
                        <span class="warning-icon">⚠️</span>
                        <div class="warning-text">
                            <strong>Warning</strong>
                            <span>Changes affect accuracy and apply immediately after saving.</span>
                        </div>
                    </div>
                </div>
                
                <div id="config-container" class="config-grid">
                    <div class="loading-cell"><div class="spinner"></div> Loading configuration...</div>
                </div>
                
                <!-- General Save Button Section -->
                <div class="config-save-section">
                    <div class="config-save-info">
                        <div class="icon">💾</div>
                        <div class="text">
                            <h4>Save All Changes</h4>
                            <p>Apply all configuration changes at once</p>
                        </div>
                    </div>
                    <button class="btn-save-all-config" onclick="showSaveConfirmation()">
                        <span>Save All Settings</span>
                    </button>
                </div>
            </section>
            
            <!-- Confirmation Modal -->
            <div id="confirmationModal" class="confirmation-modal" onclick="handleModalBackdropClick(event)">
                <div class="confirmation-content" onclick="event.stopPropagation()">
                    <div class="confirmation-header">
                        <span class="icon">⚠️</span>
                        <h3>Confirm Changes</h3>
                    </div>
                    <div class="confirmation-body">
                        <p>You are about to save the following configuration changes:</p>
                        <div id="configChangesList" class="config-changes-list"></div>
                        <p class="config-changes-warning">
                            ⚠️ These changes will take effect immediately and may affect system behavior.
                        </p>
                    </div>
                    <div class="confirmation-actions">
                        <button class="btn-confirm-cancel" onclick="closeConfirmationModal()">Cancel</button>
                        <button class="btn-confirm-save" onclick="confirmSaveAllConfig()">
                            <span>Confirm & Save</span>
                        </button>
                    </div>
                </div>
            </div>

            <!-- Logout Confirmation Modal -->
            <div id="logoutModal" class="confirmation-modal" onclick="handleLogoutModalBackdropClick(event)">
                <div class="confirmation-content" onclick="event.stopPropagation()">
                    <div class="confirmation-header">
                        <span class="icon">🚪</span>
                        <h3>Confirm Logout</h3>
                    </div>
                    <div class="confirmation-body">
                        <p class="confirmation-text">
                            <strong>Are you sure you want to logout?</strong>
                        </p>
                        <p class="text-muted">
                            You will need to login again to access the admin dashboard.
                        </p>
                    </div>
                    <div class="confirmation-actions">
                        <button class="btn-confirm-cancel" onclick="closeLogoutModal()">Cancel</button>
                        <button class="btn-confirm-save danger" onclick="confirmLogout()">
                            <span>Logout</span>
                        </button>
                    </div>
                </div>
            </div>

            <section id="logs" class="section-card scrollable tab-content">
                <div class="logs-card">
                    <div class="logs-header">
                        <div class="logs-header-left">
                            <p class="logs-subtitle">Comprehensive overview of recent scan activity & system results</p>
                        </div>
                        <div class="logs-header-right">
                            <div class="logs-filter-pills">
                                <button class="logs-pill active" onclick="filterLogs('all', this)">All</button>
                                <button class="logs-pill" onclick="filterLogs('correct', this)">✅ Correct</button>
                                <button class="logs-pill" onclick="filterLogs('incorrect', this)">⚠️ Issues</button>
                            </div>
                        </div>
                    </div>

                    <div class="table-responsive logs-table-container">
                        <table class="modern-table">
                            <thead>
                                <tr>
                                    <th>Time</th>
                                    <th>Student</th>
                                    <th>Item Scanned</th>
                                    <th>Confidence</th>
                                    <th>Result</th>
                                </tr>
                            </thead>
                            <tbody id="logs-body">
                                <tr>
                                    <td colspan="5" class="loading-cell">
                                        <div class="spinner"></div> Loading data...
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </section>

            <section id="nicknames" class="section-card scrollable tab-content">
                <div class="nn-card">
                    <div class="nn-header">
                        <div class="nn-header-left">
                            <p class="nn-subtitle">Manage student nicknames for easy login</p>
                        </div>
                        <div class="nn-header-right">
                            <div class="nn-search-container">
                                <input type="text" 
                                       class="nn-search-input" 
                                       id="nickname-search" 
                                       placeholder="🔍 Search students..."
                                       oninput="searchNicknames(this.value)">
                                <button class="nn-search-clear-btn hidden" 
                                        id="nickname-search-clear" 
                                        onclick="clearNicknameSearch()">
                                    ✕
                                </button>
                            </div>
                            <button class="btn-add-student" onclick="openAddNicknameModal()">
                                Add Student
                            </button>
                        </div>
                    </div>

                    <div class="nickname-grid" id="nickname-list">
                    </div>
                </div>
            </section>

            <!-- Add Student Nickname Modal -->
            <div id="add-nickname-modal" class="add-card-modal">
                <div class="add-card-modal-content">
                    <div class="modal-header">
                        <h4>👤 Add Student Nickname</h4>
                        <button class="modal-close" onclick="closeAddNicknameModal()">✕</button>
                    </div>
                    <div class="one-shot-form">
                        <div class="form-group">
                            <label>📝 Student Nickname:</label>
                            <input type="text" id="modal-nickname-input" placeholder="e.g., Little Explorer, Green Hero" maxlength="30">
                            <small class="form-helper-text">Enter a fun, memorable name (max 30 characters)</small>
                        </div>
                        <button class="btn-add full-width" onclick="submitNickname()">
                            ✅ Add Student
                        </button>
                        <div id="nickname-result" class="result-message"></div>
                    </div>
                </div>
            </div>

            <!-- Remove Student Confirmation Modal -->
            <div id="remove-nickname-modal" class="confirmation-modal" onclick="handleRemoveNicknameBackdropClick(event)">
                <div class="confirmation-content" onclick="event.stopPropagation()">
                    <div class="confirmation-header">
                        <span class="icon">🗑️</span>
                        <h3>Remove Student</h3>
                    </div>
                    <div class="confirmation-body">
                        <p class="confirmation-text">
                            <strong>Are you sure you want to remove this student?</strong>
                        </p>
                        <p id="remove-nickname-name">
                            <!-- Nickname will be inserted here -->
                        </p>
                        <p class="text-muted">
                            This action cannot be undone.
                        </p>
                    </div>
                    <div class="confirmation-actions">
                        <button class="btn-confirm-cancel" onclick="closeRemoveNicknameModal()">Cancel</button>
                        <button class="btn-confirm-save danger" onclick="confirmRemoveNickname()">
                            <span>🗑️</span>
                            <span>Remove Student</span>
                        </button>
                    </div>
                </div>
            </div>

        </main>
    </div>

    <!-- Modal for viewing cards (placed outside admin-wrapper for full viewport positioning) -->
    <div id="cards-modal" class="cards-modal">
        <div class="modal-content">
            <div class="modal-header">
                <h4 id="modal-title">Cards</h4>
                <button class="modal-close" onclick="closeCardsModal()">✕</button>
            </div>
            <div id="modal-cards-grid" class="modal-cards-grid"></div>
        </div>
    </div>

    <!-- Add New Card Modal -->
    <div id="add-card-modal" class="add-card-modal">
        <div class="add-card-modal-content">
            <div class="modal-header">
                <h4 id="form-title">Add New Card</h4>
                <button class="modal-close" onclick="closeAddCardModal()">✕</button>
            </div>
            <div class="modal-body">
                <div class="one-shot-form">
                    <input type="hidden" id="replace-card-id" value="">
                    <div class="form-group">
                        <label>📝 Card Name:</label>
                        <input type="text" id="one-shot-name" placeholder="e.g., Coffee Sachet, Banana Peel" maxlength="50">
                        <small class="form-helper-text">Enter a descriptive name for the card</small>
                    </div>
                    <div class="form-group">
                        <label>🗂️ Waste Category:</label>
                        <select id="one-shot-category">
                            <option value="1">🌱 Compostable (Green Bin)</option>
                            <option value="2">♻️ Recyclable (Blue Bin)</option>
                            <option value="3">🗑️ Non-Recyclable (Red Bin)</option>
                            <option value="4">⚠️ Special Waste (Yellow Bin)</option>
                        </select>
                        <small class="form-helper-text">Select the correct waste classification</small>
                    </div>
                    <div class="form-group">
                        <label>📸 Card Image:</label>
                        <input type="file" id="one-shot-image" accept="image/*" onchange="previewCardImage()">
                        <div id="image-preview" class="image-preview">
                            <div class="image-preview-placeholder">Upload an image to preview</div>
                        </div>
                    </div>
                    <div class="modal-button-row" id="modal-buttons">
                        <button class="btn-confirm-cancel hidden" id="cancel-replace-btn" onclick="cancelCardEdit()">
                            Cancel
                        </button>
                        <button class="btn-add" id="submit-card-btn" onclick="submitOneShotLearning()">
                            🚀 <span id="submit-btn-text">Register New Card</span>
                        </button>
                    </div>
                    <div id="one-shot-result" class="result-message"></div>
                </div>
            </div>
        </div>
    </div>

    <script src="../js/admin_script.js"></script>
    <script src="../js/admin_optimized.js"></script>
</body>
</html>