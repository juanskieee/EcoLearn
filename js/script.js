// ============================================
// ECOLEARN - GAME LOGIC
// ============================================

const API_URL = 'http://localhost:5000';

// Game State
let sessionId = null;
let studentNickname = '';
let sessionMode = 'instructional'; // 'instructional' or 'assessment'
let totalScans = 0;
let correctScans = 0;
let isScanning = false;

// Assessment Mode State
let assessmentStep = 'scan'; // 'scan', 'identify', 'waiting'
let currentScanResult = null;
let assessmentQuestion = null;
let feedbackResetTimeout = null; // Track feedback timeout to cancel if needed
let instructionalResetTimeout = null; // Track instructional feedback timeout

// DOM Elements
const welcomeScreen = document.getElementById('welcome-screen');
const gameScreen = document.getElementById('game-screen');
const resultsScreen = document.getElementById('results-screen');
const studentDisplayName = document.getElementById('student-display-name');

const video = document.getElementById('webcam');
const canvas = document.getElementById('capture-canvas');
const binbinImg = document.getElementById('binbin-image');
const resultText = document.getElementById('result-text');
const categoryDisplay = document.getElementById('category-display');
const categoryName = document.getElementById('category-name');
const binIcon = document.getElementById('bin-icon');
const scanBtn = document.getElementById('scan-btn');
const scanEffect = document.getElementById('scan-effect');

const scanCountEl = document.getElementById('scan-count');
const correctCountEl = document.getElementById('correct-count');
const accuracyEl = document.getElementById('accuracy');
const binBadge = document.getElementById('bin-badge');
const binBadgeLabel = document.getElementById('bin-badge-label');
const confidenceKidsEl = document.getElementById('confidence-kids');
const scannedCardsListEl = document.getElementById('scanned-cards-list');

// Audio
const successSound = document.getElementById('success-sound');
const errorSound = document.getElementById('error-sound');

// ============================================
// UI INITIALIZATION
// ============================================

document.addEventListener('DOMContentLoaded', function() {
    initializeWelcomeScreen();
    loadSystemSettings();
    setupSessionEndOnUnload();
    restoreSessionIfExists();
    loadAudioViaFetch();
    loadAudioSettings();
});

// Session persistence - save/restore from localStorage
function saveSessionToStorage() {
    if (!sessionId) return;
    const sessionData = {
        sessionId: sessionId,
        studentNickname: studentNickname,
        sessionMode: sessionMode,
        totalScans: totalScans,
        correctScans: correctScans,
        scannedCardsHistory: scannedCardsHistory,
        timestamp: Date.now()
    };
    localStorage.setItem('ecolearn_session', JSON.stringify(sessionData));
}

function restoreSessionIfExists() {
    const savedSession = localStorage.getItem('ecolearn_session');
    if (!savedSession) return;
    
    try {
        const sessionData = JSON.parse(savedSession);
        if (Date.now() - sessionData.timestamp > 2 * 60 * 60 * 1000) {
            localStorage.removeItem('ecolearn_session');
            return;
        }
        
        sessionId = sessionData.sessionId;
        studentNickname = sessionData.studentNickname;
        sessionMode = sessionData.sessionMode;
        totalScans = sessionData.totalScans || 0;
        correctScans = sessionData.correctScans || 0;
        scannedCardsHistory = sessionData.scannedCardsHistory || [];
        
        studentDisplayName.textContent = studentNickname;
        scanCountEl.textContent = totalScans;
        correctCountEl.textContent = correctScans;
        
        if (scannedCardsListEl && scannedCardsHistory.length > 0) {
            scannedCardsListEl.innerHTML = scannedCardsHistory.map(function(c) {
                if (c.imgPath) {
                    return '<span class="scanned-card-chip" title="' + escapeHtml(c.name) + '"><img src="' + escapeHtml(c.imgPath) + '" alt="' + escapeHtml(c.name) + '"></span>';
                }
                return '';
            }).join('');
        }
        
        configureGameForMode(sessionMode);
        
        if (sessionMode === 'instructional') {
            gameScreen.classList.add('learn-mode');
        } else {
            gameScreen.classList.remove('learn-mode');
        }
        
        welcomeScreen.classList.add('hidden');
        gameScreen.classList.remove('hidden');
        loadLeaderboardForIndex('game', studentNickname);
        
        initCamera();
        setInitialGameMessage();
    } catch (error) {
        localStorage.removeItem('ecolearn_session');
    }
}

function clearSessionStorage() {
    localStorage.removeItem('ecolearn_session');
}

function setupSessionEndOnUnload() {
    // Only show warning on refresh if session is active
    window.addEventListener('beforeunload', function(e) {
        if (sessionId && !gameScreen.classList.contains('hidden')) {
            // Save session state so it can be restored
            saveSessionToStorage();
        }
    });
    
    // End session only when actually leaving the page (navigation away)
    window.addEventListener('pagehide', function() {
        // Session will be restored on page load if user refreshes
        // So we don't end it here
    });
}

// Load system settings from admin config
async function loadSystemSettings() {
    try {
        const response = await fetch(`${API_URL}/admin/config`);
        const data = await response.json();
        
        if (data.status === 'success' && data.config) {
            data.config.forEach(cfg => {
                // Apply ROI Box Color to corner brackets
                if (cfg.config_key === 'roi_box_color') {
                    document.querySelectorAll('.roi-corner').forEach(el => {
                        if (el) el.style.borderColor = cfg.config_value;
                    });
                }
            });
        }
    } catch (error) {
        console.log('Using default settings');
    }
}

function initializeWelcomeScreen() {
    const modeRadios = document.querySelectorAll('input[name="learning-mode"]');
    modeRadios.forEach(radio => {
        radio.addEventListener('change', handleModeChange);
    });
    
    // Load preset nicknames on welcome screen
    loadPresetNicknames();
}

async function loadPresetNicknames() {
    const presetSelect = document.getElementById('preset-nicknames');
    
    // Default nicknames as fallback
    const defaultNicknames = ['Alice', 'Bob', 'Charlie', 'Diana', 'Emma', 'Frank', 'Grace', 'Henry'];
    
    try {
        const response = await fetch(`${API_URL}/admin/nicknames`);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        let nicknamesToShow = [];
        
        // Use database nicknames if available, otherwise use defaults
        if (data.status === 'success' && data.nicknames && data.nicknames.length > 0) {
            nicknamesToShow = data.nicknames.map(item => 
                typeof item === 'object' ? item.nickname : item
            );
        } else {
            nicknamesToShow = defaultNicknames;
            console.log('No nicknames in database, using defaults');
        }
        
        presetSelect.innerHTML = '<option value="">Choose a nickname...</option>' +
            nicknamesToShow.map(nickname => 
                `<option value="${nickname}">${nickname}</option>`
            ).join('');
            
    } catch (error) {
        console.error('Failed to load nicknames:', error);
        // Use default nicknames on error
        presetSelect.innerHTML = '<option value="">Choose a nickname...</option>' +
            defaultNicknames.map(nickname => 
                `<option value="${nickname}">${nickname}</option>`
            ).join('');
    }
}

function handleModeChange(event) {
    sessionMode = event.target.value;
}

// Category Configuration
const categories = {
    'Compostable': {
        color: '#10B981',
        icon: '🌱',
        binColor: 'green',
        message: 'Great! This goes in the GREEN bin for composting!',
        shortMessage: 'Put in the GREEN bin!',
        mascot: 'assets/binbin_happy.png'
    },
    'Recyclable': {
        color: '#3B82F6',
        icon: '♻️',
        binColor: 'blue',
        message: 'Awesome! This goes in the BLUE bin for recycling!',
        shortMessage: 'Put in the BLUE bin!',
        mascot: 'assets/binbin_happy.png'
    },
    'Non-Recyclable': {
        color: '#EF4444',
        icon: '🗑️',
        binColor: 'red',
        message: 'This goes in the RED bin.',
        shortMessage: 'Put in the RED bin!',
        mascot: 'assets/binbin_neutral.png'
    },
    'Special Waste': {
        color: '#F59E0B',
        icon: '⚠️',
        binColor: 'yellow',
        message: 'Careful! This goes in the YELLOW bin!',
        shortMessage: 'Put in the YELLOW bin!',
        mascot: 'assets/binbin_warning.png'
    }
};

// Last N scanned cards for positive reinforcement (preschool)
const SCANNED_CARDS_MAX = 3;
let scannedCardsHistory = [];

// Category icon mapping
const categoryIcons = {
    'Compostable': 'assets/compostable_icon.png',
    'Recyclable': 'assets/recyclable_icon.png',
    'Non-Recyclable': 'assets/non_recyclable_icon.png',
    'Special Waste': 'assets/special_waste_icon.png'
};

// ============================================
// INITIALIZATION
// ============================================

function setCameraStatus(status, isError) {
    const liveIndicator = document.getElementById('live-status');
    if (!liveIndicator) return;
    
    // Show live indicator only when camera is live
    if (!isError && status.toLowerCase().indexOf('live') >= 0) {
        liveIndicator.style.display = 'block';
    } else {
        liveIndicator.style.display = 'none';
    }
}

async function initCamera() {
    setCameraStatus('Starting…', false);
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video: { 
                width: { ideal: 1280 },
                height: { ideal: 720 }
            } 
        });
        video.srcObject = stream;
        setCameraStatus('Live', false);
    } catch (err) {
        setCameraStatus('Camera unavailable', true);
        alert('Camera access denied. Please allow camera access to use EcoLearn.');
    }
}

// ============================================
// GAME FLOW
// ============================================

async function startGame() {
    // Stop any ongoing speech from previous session
    stopSpeech();
    
    // Get selected nickname from preset dropdown
    const presetSelect = document.getElementById('preset-nicknames');
    const name = presetSelect.value;
    
    if (!name) {
        alert('Please select a nickname from the list!');
        presetSelect.focus();
        return;
    }
    
    // Get selected mode
    const modeRadios = document.querySelectorAll('input[name="learning-mode"]');
    const selectedMode = Array.from(modeRadios).find(radio => radio.checked)?.value || 'instructional';
    
    studentNickname = name;
    sessionMode = selectedMode;
    studentDisplayName.textContent = name;
    scannedCardsHistory = [];
    if (scannedCardsListEl) scannedCardsListEl.innerHTML = '';

    // Start background music immediately (must be in user-gesture context)
    startBackgroundMusic();

    // Configure UI based on mode
    configureGameForMode(selectedMode);
    
    // Add learn-mode class to hide leaderboard in instructional mode
    if (selectedMode === 'instructional') {
        gameScreen.classList.add('learn-mode');
    } else {
        gameScreen.classList.remove('learn-mode');
    }
    
    // Start session
    try {
        const response = await fetch(`${API_URL}/session/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nickname: studentNickname,
                mode: sessionMode
            })
        });
        
        const data = await response.json();
        
        if (data.status === 'success') {
            sessionId = data.session_id;
            
            // Reset game state
            totalScans = 0;
            correctScans = 0;
            assessmentStep = 'scan';
            currentScanResult = null;
            
            saveSessionToStorage();
            
            // Transition to game
            welcomeScreen.classList.add('hidden');
            gameScreen.classList.remove('hidden');
            loadLeaderboardForIndex('game', studentNickname);

            await initCamera();
            
            setInitialGameMessage();
        } else {
            alert('Failed to start session. Please check if the server is running.');
        }
        
    } catch (err) {
        console.error('❌ Session start error:', err);
        alert('Cannot connect to server. Please make sure the Python server is running on port 5000.');
    }
}

function configureGameForMode(mode) {
    const headerLeftScore = document.querySelector('.header-left-score');
    
    if (mode === 'instructional') {
        // Hide scores in instructional mode
        if (headerLeftScore) headerLeftScore.style.display = 'none';
    } else {
        // Show scores in assessment mode
        if (headerLeftScore) headerLeftScore.style.display = 'flex';
    }
}

function setInitialGameMessage() {
    // Hide learn-mode elements initially
    const learnCardDisplay = document.getElementById('learn-card-display');
    const learnCatInfo = document.getElementById('learn-category-info');
    if (learnCardDisplay) learnCardDisplay.classList.add('hidden');
    if (learnCatInfo) learnCatInfo.classList.add('hidden');
    categoryDisplay.classList.add('hidden');
    
    if (sessionMode === 'instructional') {
        resultText.innerHTML = '<strong>LEARN MODE:</strong><br>Place a card and I\'ll tell you about it!';
        binbinImg.src = 'assets/binbin_neutral.png';
    } else {
        resultText.innerHTML = '<strong>TEST MODE:</strong><br>Place a card, then YOU choose which bin it belongs to!';
        binbinImg.src = 'assets/binbin_neutral.png';
    }
}

async function endSession() {
    // Show quit confirmation modal instead of browser confirm()
    showQuitModal();
}

function showQuitModal() {
    const modal = document.getElementById('quitModal');
    if (modal) {
        modal.classList.add('active');
    }
}

function closeQuitModal() {
    const modal = document.getElementById('quitModal');
    if (modal) {
        modal.classList.remove('active');
    }
}

function handleQuitModalBackdropClick(event) {
    if (event.target === event.currentTarget) {
        closeQuitModal();
    }
}

async function confirmQuit() {
    closeQuitModal();
    
    // Stop any ongoing speech
    stopSpeech();
    
    // Clear saved session
    clearSessionStorage();
    
    try {
        const response = await fetch(`${API_URL}/session/end`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        const data = await response.json();
        
        if (data.status === 'success') {
            // Show results
            showResults(data.stats);
        } else {
            // Backend error (e.g., no active session) - show results with local stats
            console.warn('Session end returned error:', data.message);
            showResults({
                total_scans: totalScans,
                correct_scans: correctScans,
                accuracy: totalScans > 0 ? Math.round((correctScans / totalScans) * 100) : 0
            });
        }
        
    } catch (err) {
        console.error('❌ Session end error:', err);
        // Show results anyway
        showResults({
            total_scans: totalScans,
            correct_scans: correctScans,
            accuracy: totalScans > 0 ? Math.round((correctScans / totalScans) * 100) : 0
        });
    }
}

function showResults(stats) {
    // Stop any ongoing speech
    stopSpeech();
    
    gameScreen.classList.add('hidden');
    resultsScreen.classList.remove('hidden');
    
    const learnResults = document.getElementById('learn-results');
    const testResults = document.getElementById('test-results');
    const resultsTitle = document.getElementById('results-title');
    
    if (sessionMode === 'instructional') {
        // Learn mode: show encouraging message, no stats/leaderboard
        learnResults.classList.remove('hidden');
        testResults.classList.add('hidden');
        resultsTitle.textContent = 'Great Exploring!';
        
        const learnMessage = document.getElementById('learn-results-message');
        const scanCount = stats.total_scans || 0;
        if (scanCount >= 10) {
            learnMessage.textContent = '🌟 Wow! You explored ' + scanCount + ' cards today! You\'re becoming a waste sorting expert!';
        } else if (scanCount >= 5) {
            learnMessage.textContent = '🌱 Great job! You explored ' + scanCount + ' cards! Keep learning about waste sorting!';
        } else if (scanCount > 0) {
            learnMessage.textContent = '👋 Nice start! You explored ' + scanCount + ' card' + (scanCount > 1 ? 's' : '') + '! Come back to learn more!';
        } else {
            learnMessage.textContent = '🌱 Thanks for visiting! Come back to explore waste sorting cards!';
        }
    } else {
        // Test mode: show full stats and leaderboard
        learnResults.classList.add('hidden');
        testResults.classList.remove('hidden');
        resultsTitle.textContent = 'Awesome!';
        
        document.getElementById('final-scans').textContent = stats.total_scans;
        document.getElementById('final-correct').textContent = stats.correct_scans;
        document.getElementById('final-accuracy').textContent = stats.accuracy + '%';
        
        // Personalized message
        const accuracy = stats.accuracy;
        let message = '';
        
        if (accuracy >= 90) {
            message = '🌟 You\'re an eco-champion! Amazing job!';
        } else if (accuracy >= 75) {
            message = '👍 Great work! You\'re getting really good at this!';
        } else if (accuracy >= 50) {
            message = '💪 Good effort! Keep practicing and you\'ll be a pro!';
        } else {
            message = '🌱 Nice try! Practice makes perfect. Try again!';
        }
        
        document.getElementById('results-message').textContent = message;
        loadLeaderboardForIndex('results', studentNickname);
    }
}

// ============================================
// LEADERBOARD (index.html welcome & results)
// ============================================

function getAccuracyColor(accuracy) {
    if (accuracy >= 90) return 'var(--color-green)';
    if (accuracy >= 75) return 'var(--color-blue)';
    if (accuracy >= 50) return 'var(--color-yellow)';
    return 'var(--color-red)';
}

async function loadLeaderboardForIndex(which, highlightNickname) {
    const containerIds = {
        game: 'game-leaderboard-list',
        results: 'results-leaderboard-list'
    };
    const containerId = containerIds[which];
    if (!containerId) return;
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = '<div class="leaderboard-loading">Loading…</div>';

    try {
        const response = await fetch(`${API_URL}/admin/student-proficiency`);
        const data = await response.json();

        if (data.status !== 'success' || !data.leaderboard || data.leaderboard.length === 0) {
            container.innerHTML = `
                <div class="leaderboard-empty-state">
                    <span class="empty-icon">🏆</span>
                    <span class="empty-title">No rankings yet!</span>
                    <span class="empty-subtitle">Complete a session in Test mode to be the first on the board!</span>
                </div>`;
            return;
        }

        const top = data.leaderboard.slice(0, 10);
        const rankDisplay = (rank) => (rank <= 3 ? ['🥇', '🥈', '🥉'][rank - 1] : rank);

        container.innerHTML = top.map(student => {
            const isHighlight = highlightNickname && student.nickname === highlightNickname;
            return `<div class="leaderboard-item${isHighlight ? ' highlight' : ''}" role="listitem">
                <span class="leaderboard-rank">${rankDisplay(student.rank)}</span>
                <span class="leaderboard-name">${escapeHtml(student.nickname)}</span>
                <span class="leaderboard-score" style="color:${getAccuracyColor(student.avg_accuracy)}">${student.avg_accuracy}%</span>
            </div>`;
        }).join('');
    } catch (err) {
        container.innerHTML = '<p class="leaderboard-empty">Could not load leaderboard.</p>';
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================
// SCANNING & CLASSIFICATION
// ============================================

async function captureAndIdentify() {
    if (isScanning) return;
    
    // Cancel any pending feedback reset (rapid scanning)
    if (feedbackResetTimeout) {
        clearTimeout(feedbackResetTimeout);
        feedbackResetTimeout = null;
    }
    if (instructionalResetTimeout) {
        clearTimeout(instructionalResetTimeout);
        instructionalResetTimeout = null;
    }
    
    isScanning = true;
    scanBtn.disabled = true;
    scanBtn.style.opacity = "0.6"; // Dim the button instead of changing text

    // Visual feedback
    scanEffect.classList.add('active');
    setTimeout(() => scanEffect.classList.remove('active'), 1000);
    
    // Set thinking state
    resultText.textContent = "Hmm... let me think...";
    categoryDisplay.classList.add('hidden');
    // Hide learn-mode elements while scanning
    const learnCardDisplay = document.getElementById('learn-card-display');
    const learnCatInfo = document.getElementById('learn-category-info');
    if (learnCardDisplay) learnCardDisplay.classList.add('hidden');
    if (learnCatInfo) learnCatInfo.classList.add('hidden');
    if (confidenceKidsEl) confidenceKidsEl.classList.add('hidden');
    binbinImg.style.transform = "scale(0.9) rotate(-5deg)";
    binbinImg.src = 'assets/binbin_neutral.png';
    
    // Crop to ROI (70% center)
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const cropW = vw * 0.70;
    const cropH = vh * 0.70;
    const startX = (vw - cropW) / 2;
    const startY = (vh - cropH) / 2;
    
    canvas.width = cropW;
    canvas.height = cropH;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, startX, startY, cropW, cropH, 0, 0, cropW, cropH);
    
    // Convert to blob
    canvas.toBlob(async (blob) => {
        const formData = new FormData();
        formData.append('image', blob, 'scan.jpg');
        
        try {
            const response = await fetch(`${API_URL}/classify`, {
                method: 'POST',
                body: formData
            });
            
            const data = await response.json();
            
            if (sessionMode === 'instructional') {
                handleInstructionalMode(data);
            } else {
                handleAssessmentMode(data);
            }
            
        } catch (err) {
            showErrorFeedback({ reason: 'connection_error' });
            // Re-enable on error
            isScanning = false;
            scanBtn.disabled = false;
            scanBtn.style.opacity = "1";
        } finally {
            // Only re-enable immediately in instructional mode
            // Assessment mode will re-enable after user answers via resetAssessmentState()
            if (sessionMode === 'instructional') {
                isScanning = false;
                scanBtn.disabled = false;
                scanBtn.style.opacity = "1";
            }
        }
    }, 'image/jpeg', 0.95);
}

function handleInstructionalMode(data) {
    // In instructional mode, backend auto-logs scan transactions in /classify
    if (data.status === 'success') {
        showInstructionalFeedback(data);
    } else {
        showErrorFeedback(data);
    }
}

async function logInstructionalScan(data) {
    if (!sessionId) return;
    
    try {
        const response = await fetch(`${API_URL}/assessment/submit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                selected_category: data.category, // In instructional mode, system answer is always "correct"
                correct_category: data.category,
                card_id: data.card_id,
                confidence: data.confidence
            })
        });
        
        if (response.ok) {
            // Scan logged successfully
        }
    } catch (error) {
        // Failed to log scan
    }
}

function handleAssessmentMode(data) {
    if (assessmentStep === 'scan') {
        // Step 1: Show what the system identified, then ask student to categorize
        if (data.status === 'success') {
            currentScanResult = data;
            showAssessmentIdentification(data);
            assessmentStep = 'identify';
        } else {
            showErrorFeedback(data);
            // Re-enable button on error
            isScanning = false;
            scanBtn.disabled = false;
            scanBtn.style.opacity = "1";
        }
    } else {
        // Ignore scan if already in identify mode (user scanned too quickly)
        console.log('Ignoring scan - already in identify mode');
        isScanning = false;
        scanBtn.disabled = false;
        scanBtn.style.opacity = "1";
    }
}

function addToScannedCards(cardName, icon, category) {
    if (!scannedCardsListEl || !cardName) return;
    const categoryFolder = category ? category.replace(/ /g, '-') : '';
    const cardFileName = (cardName || '').replace(/ /g, '_');
    const imgPath = categoryFolder ? ('assets/' + categoryFolder + '/' + cardFileName + '.webp') : '';
    scannedCardsHistory.unshift({ name: cardName, icon: icon || '✅', category: category || '', imgPath: imgPath });
    if (scannedCardsHistory.length > SCANNED_CARDS_MAX) scannedCardsHistory.pop();
    scannedCardsListEl.innerHTML = scannedCardsHistory.map(function(c) {
        if (c.imgPath) {
            return '<span class="scanned-card-chip" title="' + escapeHtml(c.name) + '"><img src="' + escapeHtml(c.imgPath) + '" alt="' + escapeHtml(c.name) + '"></span>';
        }
        return '';
    }).join('');
    
    saveSessionToStorage();
}

function showInstructionalFeedback(data) {
    const category = data.category;
    const config = categories[category];
    
    if (!config) return;
    
    successSound.play().catch(function() {});
    
    binbinImg.src = config.mascot;
    binbinImg.style.transform = "scale(1.15) rotate(5deg)";
    setTimeout(function() {
        binbinImg.style.transform = "scale(1) rotate(0deg)";
    }, 500);
    
    // Build friendly card name (replace underscores with spaces)
    const friendlyName = (data.card_name || 'card').replace(/_/g, ' ');
    
    // Show card name as educational info
    resultText.innerHTML = '<span class="result-card-name">It\'s a <strong>' + escapeHtml(friendlyName) + '</strong>!</span>';
    
    // Show eco-card image
    const learnCardDisplay = document.getElementById('learn-card-display');
    const learnCardImage = document.getElementById('learn-card-image');
    if (learnCardDisplay && learnCardImage) {
        // Build image path: assets/{Category}/{Card_Name}.webp
        const categoryFolder = category.replace(/ /g, '-'); // "Special Waste" -> "Special-Waste"
        // Ensure card filename uses underscores (file naming convention)
        const cardFileName = (data.card_name || 'card').replace(/ /g, '_');
        learnCardImage.src = 'assets/' + categoryFolder + '/' + cardFileName + '.webp';
        learnCardImage.alt = friendlyName;
        learnCardDisplay.classList.remove('hidden');
        // Add category class for colored border
        learnCardDisplay.className = 'learn-card-display cat-' + category.toLowerCase().replace(/ /g, '-');
    }
    
    // Show learn-mode category info (icon + label)
    const learnCatInfo = document.getElementById('learn-category-info');
    const learnCatIcon = document.getElementById('learn-category-icon');
    const learnCatName = document.getElementById('learn-category-name');
    if (learnCatInfo && learnCatName) {
        // Set icon next to card image
        if (learnCatIcon) {
            learnCatIcon.src = categoryIcons[category] || '';
        }
        learnCatName.textContent = category;
        learnCatName.style.color = config.color;
        learnCatInfo.classList.remove('hidden');
    }
    
    // Hide test-mode elements
    categoryDisplay.classList.add('hidden');
    if (confidenceKidsEl) confidenceKidsEl.classList.add('hidden');
    
    addToScannedCards(data.card_name, config.icon, category);
    
    // Speak it in Tagalog
    speak('Ito ay isang ' + friendlyName + '! Ilagay ito sa ' + category + '.');
    
    // Auto-reset to default after a delay
    instructionalResetTimeout = setTimeout(function() {
        resetInstructionalFeedback();
        instructionalResetTimeout = null;
    }, 20000); // 20 seconds
}

function resetInstructionalFeedback() {
    // Only reset if still in instructional mode and not currently scanning
    if (sessionMode !== 'instructional' || isScanning) return;
    
    const learnCardDisplay = document.getElementById('learn-card-display');
    const learnCatInfo = document.getElementById('learn-category-info');
    if (learnCardDisplay) learnCardDisplay.classList.add('hidden');
    if (learnCatInfo) learnCatInfo.classList.add('hidden');
    categoryDisplay.classList.add('hidden');
    if (confidenceKidsEl) confidenceKidsEl.classList.add('hidden');
    
    resultText.innerHTML = '<strong>LEARN MODE:</strong><br>Place a card and I\'ll tell you about it!';
    binbinImg.src = 'assets/binbin_neutral.png';
    binbinImg.style.transform = 'scale(1) rotate(0deg)';
}

function showAssessmentIdentification(data) {
    // Show the item but don't reveal the answer yet
    binbinImg.src = 'assets/binbin_neutral.png';
    resultText.innerHTML = `<strong>I see: ${escapeHtml(data.card_name)}</strong><br>Waiting for your answer...`;
    
    // Hide the automatic category display
    categoryDisplay.classList.add('hidden');
    
    // Show assessment modal
    showAssessmentModal(data.card_name);
}

function showAssessmentModal(cardName) {
    const modal = document.getElementById('assessmentModal');
    const itemNameEl = document.getElementById('assessment-item-name');
    const binbinEl = document.getElementById('assessment-binbin');
    const cardImgEl = document.getElementById('assessment-card-image');
    
    // Set card name in modal
    const friendlyName = (cardName || 'card').replace(/_/g, ' ');
    itemNameEl.innerHTML = '<strong>' + escapeHtml(friendlyName) + '</strong>';
    binbinEl.src = 'assets/binbin_neutral.png';
    
    // Show card image in modal
    if (cardImgEl && currentScanResult) {
        const categoryFolder = currentScanResult.category.replace(/ /g, '-');
        const cardFileName = (cardName || '').replace(/ /g, '_');
        cardImgEl.src = 'assets/' + categoryFolder + '/' + cardFileName + '.webp';
        cardImgEl.alt = friendlyName;
    }
    
    // Reset all choice states
    const choices = modal.querySelectorAll('.assessment-choice');
    choices.forEach(c => {
        c.classList.remove('choice-correct', 'choice-incorrect', 'choice-dimmed');
        c.style.pointerEvents = 'auto';
    });
    
    // Show modal
    modal.classList.add('active');
}

function closeAssessmentModal() {
    const modal = document.getElementById('assessmentModal');
    modal.classList.remove('active');
}

async function selectAssessmentChoice(selectedCategory) {
    if (!currentScanResult) return;
    
    const correctCategory = currentScanResult.category;
    const isCorrect = selectedCategory === correctCategory;
    
    // 1. Immediately flash result on modal choices
    const modal = document.getElementById('assessmentModal');
    const modalChoices = modal.querySelectorAll('.assessment-choice');
    const modalBinbin = document.getElementById('assessment-binbin');
    
    modalChoices.forEach(c => {
        const cat = c.getAttribute('onclick').match(/'([^']+)'/)[1];
        if (cat === selectedCategory && isCorrect) {
            c.classList.add('choice-correct');
        } else if (cat === selectedCategory && !isCorrect) {
            c.classList.add('choice-incorrect');
        } else if (cat === correctCategory && !isCorrect) {
            c.classList.add('choice-correct');
        } else {
            c.classList.add('choice-dimmed');
        }
        c.style.pointerEvents = 'none';
    });
    
    // Update modal Bin-Bin
    if (isCorrect) {
        modalBinbin.src = 'assets/binbin_happy.png';
        successSound.play().catch(function() {});
    } else {
        modalBinbin.src = 'assets/binbin_warning.png';
        errorSound.play().catch(function() {});
    }
    
    // 2. Submit to backend (fire-and-forget for UI speed)
    try {
        const response = await fetch(`${API_URL}/assessment/submit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                selected_category: selectedCategory,
                correct_category: correctCategory,
                card_id: currentScanResult.card_id,
                confidence: currentScanResult.confidence
            })
        });
        const data = await response.json();
        if (data.status === 'success') {
            // Assessment submitted successfully
        }
    } catch (error) {
        // Assessment submit failed
    }
    
    // 3. Update stats locally
    totalScans++;
    scanCountEl.textContent = totalScans;
    if (isCorrect) {
        correctScans++;
        correctCountEl.textContent = correctScans;
    }
    const accuracy = totalScans > 0 ? Math.round((correctScans / totalScans) * 100) : 100;
    if (accuracyEl) accuracyEl.textContent = accuracy + '%';
    saveSessionToStorage();
    
    // 4. After brief flash, close modal and show result in feedback card
    setTimeout(() => {
        closeAssessmentModal();
        
        if (isCorrect) {
            showAssessmentCorrect(selectedCategory);
        } else {
            showAssessmentIncorrect(selectedCategory, correctCategory);
        }
        
        // IMMEDIATELY re-enable scanning for next card (kids have short attention spans!)
        assessmentStep = 'scan';
        currentScanResult = null;
        isScanning = false;
        scanBtn.disabled = false;
        scanBtn.style.opacity = "1";
        
        // Keep feedback visible for 20 seconds, then reset UI
        feedbackResetTimeout = setTimeout(() => {
            resetAssessmentUI();
            feedbackResetTimeout = null;
        }, 20000);
    }, 1200);
}

function showAssessmentCorrect(selectedCategory) {
    const config = categories[selectedCategory];
    const friendlyName = currentScanResult ? (currentScanResult.card_name || 'card').replace(/_/g, ' ') : 'card';
    
    binbinImg.src = config.mascot;
    binbinImg.style.transform = "scale(1.15) rotate(5deg)";
    setTimeout(function() {
        binbinImg.style.transform = "scale(1) rotate(0deg)";
    }, 500);
    
    // Show result text
    resultText.innerHTML = '<span class="result-card-name"><strong class="result-big" style="color: var(--color-green);">Correct!</strong> It\'s a <strong>' + escapeHtml(friendlyName) + '</strong>!</span>';
    
    // Show eco-card image + category icon (same as learn mode)
    const learnCardDisplay = document.getElementById('learn-card-display');
    const learnCardImage = document.getElementById('learn-card-image');
    const learnCatIcon = document.getElementById('learn-category-icon');
    if (learnCardDisplay && learnCardImage && currentScanResult) {
        const categoryFolder = selectedCategory.replace(/ /g, '-');
        const cardFileName = (currentScanResult.card_name || 'card').replace(/ /g, '_');
        learnCardImage.src = 'assets/' + categoryFolder + '/' + cardFileName + '.webp';
        learnCardImage.alt = friendlyName;
        learnCardDisplay.classList.remove('hidden');
        learnCardDisplay.className = 'learn-card-display cat-' + selectedCategory.toLowerCase().replace(/ /g, '-');
    }
    // Set category icon
    if (learnCatIcon) learnCatIcon.src = categoryIcons[selectedCategory] || '';
    
    // Show category label
    const learnCatInfo = document.getElementById('learn-category-info');
    const learnCatName = document.getElementById('learn-category-name');
    if (learnCatInfo && learnCatName) {
        learnCatName.textContent = selectedCategory;
        learnCatName.style.color = config.color;
        learnCatInfo.classList.remove('hidden');
    }
    
    // Hide old test-mode elements
    categoryDisplay.classList.add('hidden');
    if (confidenceKidsEl) confidenceKidsEl.classList.add('hidden');
    
    if (currentScanResult && currentScanResult.card_name) addToScannedCards(currentScanResult.card_name, config.icon, selectedCategory);
}

function showAssessmentIncorrect(selectedCategory, correctCategory) {
    var correctConfig = categories[correctCategory];
    const friendlyName = currentScanResult ? (currentScanResult.card_name || 'card').replace(/_/g, ' ') : 'card';
    
    binbinImg.src = 'assets/binbin_warning.png';
    binbinImg.style.transform = "scale(1.15) rotate(-5deg)";
    setTimeout(function() {
        binbinImg.style.transform = "scale(1) rotate(0deg)";
    }, 500);
    
    // Show result text
    resultText.innerHTML = '<span class="result-card-name"><strong class="result-big" style="color: var(--color-red);">Not quite!</strong> It\'s a <strong>' + escapeHtml(friendlyName) + '</strong>.<br>It goes in <strong>' + escapeHtml(correctCategory) + '</strong>!</span>';
    
    // Show eco-card image + category icon (same as learn mode)
    const learnCardDisplay = document.getElementById('learn-card-display');
    const learnCardImage = document.getElementById('learn-card-image');
    const learnCatIcon = document.getElementById('learn-category-icon');
    if (learnCardDisplay && learnCardImage && currentScanResult) {
        const categoryFolder = correctCategory.replace(/ /g, '-');
        const cardFileName = (currentScanResult.card_name || 'card').replace(/ /g, '_');
        learnCardImage.src = 'assets/' + categoryFolder + '/' + cardFileName + '.webp';
        learnCardImage.alt = friendlyName;
        learnCardDisplay.classList.remove('hidden');
        learnCardDisplay.className = 'learn-card-display cat-' + correctCategory.toLowerCase().replace(/ /g, '-');
    }
    // Set category icon
    if (learnCatIcon) learnCatIcon.src = categoryIcons[correctCategory] || '';
    
    // Show category label
    const learnCatInfo = document.getElementById('learn-category-info');
    const learnCatName = document.getElementById('learn-category-name');
    if (learnCatInfo && learnCatName) {
        learnCatName.textContent = correctCategory;
        learnCatName.style.color = correctConfig.color;
        learnCatInfo.classList.remove('hidden');
    }
    
    // Hide old test-mode elements
    categoryDisplay.classList.add('hidden');
    if (confidenceKidsEl) confidenceKidsEl.classList.add('hidden');
    
    // Add to recent scans
    if (currentScanResult && currentScanResult.card_name) addToScannedCards(currentScanResult.card_name, correctConfig.icon, correctCategory);
}

function resetAssessmentState() {
    assessmentStep = 'scan';
    currentScanResult = null;
    
    // Re-enable scan button for next scan
    isScanning = false;
    scanBtn.disabled = false;
    scanBtn.style.opacity = "1";
    
    // Reset UI
    resetAssessmentUI();
}

function resetAssessmentUI() {
    // Only reset visual elements - don't touch button or scanning state
    // This is called after the 20-second feedback display
    
    // Hide learn-mode elements used for feedback
    const learnCardDisplay = document.getElementById('learn-card-display');
    const learnCatInfo = document.getElementById('learn-category-info');
    if (learnCardDisplay) learnCardDisplay.classList.add('hidden');
    if (learnCatInfo) learnCatInfo.classList.add('hidden');
    categoryDisplay.classList.add('hidden');
    if (confidenceKidsEl) confidenceKidsEl.classList.add('hidden');
    
    resultText.innerHTML = '<strong>TEST MODE:</strong><br>Place a card, then YOU choose which bin it belongs to!';
    binbinImg.src = 'assets/binbin_neutral.png';
    binbinImg.style.transform = 'scale(1) rotate(0deg)';
    
    // Ensure modal is closed
    closeAssessmentModal();
}

function showErrorFeedback(data) {
    // Play error sound
    errorSound.play().catch(e => console.log('Audio play failed:', e));
    
    // Hide learn-mode elements
    const learnCardDisplay = document.getElementById('learn-card-display');
    const learnCatInfo = document.getElementById('learn-category-info');
    if (learnCardDisplay) learnCardDisplay.classList.add('hidden');
    if (learnCatInfo) learnCatInfo.classList.add('hidden');
    categoryDisplay.classList.add('hidden');
    
    // Animate Bin-Bin
    binbinImg.src = 'assets/binbin_confused.png';
    binbinImg.style.transform = "scale(1.1) rotate(-10deg)";
    setTimeout(() => {
        binbinImg.style.transform = "scale(1) rotate(0deg)";
    }, 500);
    
    // Determine error message
    let message = '';
    
    if (data.reason === 'insufficient_features') {
        message = "Hindi ko makita nang malinaw ang card. Pakihold ito sa loob ng yellow box.";
    } else if (data.reason === 'low_confidence') {
        message = "Hmm, hindi ako sigurado dito. Subukan mong ipakita ang mas malinaw na card!";
    } else if (data.reason === 'connection_error') {
        message = "Naku! Nawala ang connection. Naka-on ba ang server?";
    } else {
        message = "Hindi ko nakikilala ang card na ito. Siguraduhing isa ito sa ating eco-cards!";
    }
    
    resultText.textContent = message;
    
    // Speak feedback
    speak(message);
}

// ============================================
// BACKGROUND MUSIC
// ============================================

const bgMusic = document.getElementById('background-music');
const BG_MUSIC_NORMAL_VOL = 0.3;  // Normal background volume
const BG_MUSIC_DUCK_VOL = 0.08;   // Ducked volume during speech
const BG_MUSIC_FADE_MS = 300;     // Fade duration in ms

// Load audio files via fetch + blob URL to prevent IDM from intercepting
function loadAudioViaFetch() {
    const audioMap = [
        { id: 'background-music', src: 'assets/background_music.mp3' },
        { id: 'success-sound', src: 'assets/success.mp3' },
        { id: 'error-sound', src: 'assets/error.mp3' }
    ];
    audioMap.forEach(function(item) {
        const el = document.getElementById(item.id);
        if (!el) return;
        fetch(item.src)
            .then(function(r) { return r.blob(); })
            .then(function(blob) {
                el.src = URL.createObjectURL(blob);
            })
            .catch(function(e) {
                console.log('Audio load fallback for ' + item.id + ':', e);
                el.src = item.src; // Fallback to direct src
            });
    });
}

function startBackgroundMusic() {
    if (!bgMusic) return;
    if (!bgMusic.paused) return; // Already playing
    bgMusic.volume = BG_MUSIC_NORMAL_VOL;
    bgMusic.play().catch(e => console.log('Background music autoplay blocked:', e));
}

// Auto-start music on first user interaction (any click/touch/key)
function initBackgroundMusicOnInteraction() {
    function handler() {
        startBackgroundMusic();
        document.removeEventListener('click', handler);
        document.removeEventListener('touchstart', handler);
        document.removeEventListener('keydown', handler);
    }
    document.addEventListener('click', handler);
    document.addEventListener('touchstart', handler);
    document.addEventListener('keydown', handler);
}
initBackgroundMusicOnInteraction();

// Mute states
let bgmMuted = false;
let sfxMuted = false;

// Load saved settings from localStorage
function loadAudioSettings() {
    const saved = localStorage.getItem('ecolearn_audio_settings');
    if (saved) {
        try {
            const settings = JSON.parse(saved);
            bgmMuted = settings.bgmMuted || false;
            sfxMuted = settings.sfxMuted || false;
            
            // Apply to audio elements
            if (bgMusic) bgMusic.muted = bgmMuted;
            if (successSound) successSound.muted = sfxMuted;
            if (errorSound) errorSound.muted = sfxMuted;
            
            // Update toggle checkboxes
            const bgmToggle = document.getElementById('toggle-bgm');
            const sfxToggle = document.getElementById('toggle-sfx');
            if (bgmToggle) bgmToggle.checked = !bgmMuted;
            if (sfxToggle) sfxToggle.checked = !sfxMuted;
        } catch (e) {
            console.log('Could not load audio settings:', e);
        }
    }
}

function saveAudioSettings() {
    localStorage.setItem('ecolearn_audio_settings', JSON.stringify({
        bgmMuted: bgmMuted,
        sfxMuted: sfxMuted
    }));
}

function toggleBGM(enabled) {
    bgmMuted = !enabled;
    if (bgMusic) {
        bgMusic.muted = bgmMuted;
    }
    saveAudioSettings();
}

function toggleSFX(enabled) {
    sfxMuted = !enabled;
    if (successSound) successSound.muted = sfxMuted;
    if (errorSound) errorSound.muted = sfxMuted;
    saveAudioSettings();
}

// Settings Modal
function openSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (modal) modal.classList.add('active');
}

function closeSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (modal) modal.classList.remove('active');
}

function handleSettingsBackdropClick(event) {
    if (event.target === event.currentTarget) closeSettingsModal();
}

function duckBackgroundMusic() {
    if (!bgMusic || bgMusic.paused) return;
    // Smooth fade down
    const fadeStep = (BG_MUSIC_NORMAL_VOL - BG_MUSIC_DUCK_VOL) / 10;
    let vol = bgMusic.volume;
    const fadeDown = setInterval(() => {
        vol -= fadeStep;
        if (vol <= BG_MUSIC_DUCK_VOL) {
            bgMusic.volume = BG_MUSIC_DUCK_VOL;
            clearInterval(fadeDown);
        } else {
            bgMusic.volume = vol;
        }
    }, BG_MUSIC_FADE_MS / 10);
}

function restoreBackgroundMusic() {
    if (!bgMusic || bgMusic.paused) return;
    // Smooth fade up
    const fadeStep = (BG_MUSIC_NORMAL_VOL - BG_MUSIC_DUCK_VOL) / 10;
    let vol = bgMusic.volume;
    const fadeUp = setInterval(() => {
        vol += fadeStep;
        if (vol >= BG_MUSIC_NORMAL_VOL) {
            bgMusic.volume = BG_MUSIC_NORMAL_VOL;
            clearInterval(fadeUp);
        } else {
            bgMusic.volume = vol;
        }
    }, BG_MUSIC_FADE_MS / 10);
}

// ============================================
// SPEECH SYNTHESIS (Tagalog via gTTS)
// ============================================

let currentTTSAudio = null;

function stopSpeech() {
    // Stop server-side gTTS audio
    if (currentTTSAudio) {
        currentTTSAudio.pause();
        currentTTSAudio.currentTime = 0;
        currentTTSAudio = null;
    }
    
    // Stop browser speech synthesis
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
    }
    
    // Restore background music volume
    restoreBackgroundMusic();
}

function speak(text) {
    // Stop any currently playing TTS audio
    if (currentTTSAudio) {
        currentTTSAudio.pause();
        currentTTSAudio = null;
        restoreBackgroundMusic();
    }
    
    if (!text) return;
    
    // Duck the background music
    duckBackgroundMusic();
    
    fetch(API_URL + '/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text, lang: 'tl' })
    })
    .then(response => {
        if (!response.ok) throw new Error('TTS failed');
        return response.json();
    })
    .then(data => {
        if (!data.audio) throw new Error('No audio data');
        // Decode base64 to audio blob
        const byteChars = atob(data.audio);
        const byteArray = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) {
            byteArray[i] = byteChars.charCodeAt(i);
        }
        const blob = new Blob([byteArray], { type: 'audio/mpeg' });
        const audioUrl = URL.createObjectURL(blob);
        currentTTSAudio = new Audio(audioUrl);
        currentTTSAudio.volume = 0.8;
        currentTTSAudio.play().catch(e => {
            console.log('TTS play failed:', e);
            restoreBackgroundMusic();
        });
        currentTTSAudio.onended = function() {
            URL.revokeObjectURL(audioUrl);
            currentTTSAudio = null;
            restoreBackgroundMusic();
        };
    })
    .catch(err => {
        console.warn('gTTS unavailable, falling back to browser TTS:', err);
        // Fallback to browser speech synthesis
        if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.rate = 0.9;
            utterance.pitch = 1.1;
            utterance.volume = 0.8;
            utterance.onend = function() { restoreBackgroundMusic(); };
            window.speechSynthesis.speak(utterance);
        } else {
            restoreBackgroundMusic();
        }
    });
}

// ============================================
// KEYBOARD SHORTCUTS
// ============================================

document.addEventListener('keydown', (e) => {
    // ESC to close quit modal
    if (e.code === 'Escape') {
        const quitModal = document.getElementById('quitModal');
        if (quitModal && quitModal.classList.contains('active')) {
            closeQuitModal();
            return;
        }
    }
    
    // Space or Enter to scan
    if ((e.code === 'Space' || e.code === 'Enter') && !welcomeScreen.classList.contains('hidden')) {
        e.preventDefault();
        if (studentNameInput.value.trim()) {
            startGame();
        }
    }
    
    // Space to scan during game
    if (e.code === 'Space' && !gameScreen.classList.contains('hidden')) {
        e.preventDefault();
        captureAndIdentify();
    }
});

// ============================================
// STARTUP
// ============================================

fetch(`${API_URL}/health`)
    .then(r => r.json())
    .then(data => {
        console.log('✅ Server Status:', data);
        if (!data.model_loaded) {
            console.warn('⚠️ Model not loaded on server!');
        }
    })
    .catch(err => {
        console.error('❌ Cannot connect to server:', err);
        console.log('Make sure Python server is running: python app_improved.py');
    });

