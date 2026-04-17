// ============================================
// ECOLEARN - GAME LOGIC
// ============================================

const API_URL = 'http://localhost:5000';
const RESULTS_REDIRECT_KEY = 'ecolearn_results_redirect';

// Game State
let sessionId = null;
let studentNickname = '';
let sessionMode = 'instructional'; // 'instructional' or 'assessment'
let totalScans = 0;
let correctScans = 0;
let isScanning = false;
let assessmentTimerHandle = null;
let assessmentRemainingSeconds = 60;
let pendingTimeUpStats = null;
let skipSessionPersistOnUnload = false;

// Learn Mode: 10-card subset counter
let learnCardsExplored = 0;
const LEARN_CARD_TARGET = 10;

// Assessment Mode State
let assessmentStep = 'scan'; // 'scan' | 'identify'
let currentScanResult = null;
let assessmentPromptStartedAt = 0;
let feedbackResetTimeout = null;
let instructionalResetTimeout = null;
let scanUnlockTimeout = null;
let lastErrorFeedbackAt = 0;
let lastErrorReason = '';

const SCAN_COOLDOWN_MS = 500;
const ERROR_FEEDBACK_COOLDOWN_MS = 500;
const CAMERA_ROI_RATIO = 0.50;

const SYSTEM_CONFIG = {
    orb_feature_count: 1000,
    knn_k_value: 2,
    knn_distance_threshold: 0.65,
    min_confidence_score: 0.6,
    session_timeout_minutes: 30,
    webcam_fps: 30,
    roi_box_color: '#00FF00',
    enable_audio_feedback: true,
    assessment_timer_seconds: 60
};

let inactivityTimeout = null;
let inactivityHandlersBound = false;
let tutorialState = null;

const tutorialStepsByMode = {
    instructional: [
        {
            target: '.guide-card',
            title: 'Meet the Categories',
            text: 'Hi! I am Bin-Bin. This guide shows all four waste types. We will use these colors while we play.'
        },
        {
            target: '.camera-display',
            bubblePosition: 'top',
            title: 'Place the Card Here',
            text: 'Hold your eco-card inside the green box so I can read it clearly.'
        },
        {
            target: '#scan-btn',
            title: 'Tap Scan',
            text: 'Press SCAN when your card is ready. I will explain where it belongs and why.'
        },
        {
            target: '.feedback-card',
            title: 'Watch My Feedback',
            text: 'This panel shows the card result, category icon, and my helpful tips.'
        }
    ],
    assessment: [
        {
            target: '.leaderboard-card',
            title: 'Score Challenge',
            text: 'Welcome to Test mode! Try to climb the leaderboard with accurate sorting.'
        },
        {
            targets: ['#test-timer-wrap', '#test-timer', '.score-board'],
            title: 'Beat the Timer',
            text: 'You have limited time. Keep scanning and answering quickly.'
        },
        {
            target: '.camera-display',
            bubblePosition: 'top',
            title: 'Scan the Card',
            text: 'Center your card in the camera frame, then scan to start each question.'
        },
        {
            target: '.feedback-card',
            title: 'Check the Result',
            text: 'After you answer, this panel shows if you are correct and explains the right category.'
        }
    ]
};

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
let testTimerEl = document.getElementById('test-timer');
let testTimerWrap = document.getElementById('test-timer-wrap');
const learnCardCounterWrap = document.getElementById('learn-card-counter-wrap');
const learnCardCounterDivider = document.getElementById('learn-card-counter-divider');
const learnCardCountEl = document.getElementById('learn-card-count');
const binBadge = document.getElementById('bin-badge');
const binBadgeLabel = document.getElementById('bin-badge-label');
const confidenceKidsEl = document.getElementById('confidence-kids');
const scannedCardsListEl = document.getElementById('scanned-cards-list');

// Audio
const successSound = document.getElementById('success-sound');
const errorSound = document.getElementById('error-sound');
const startupOverlay = document.getElementById('startup-overlay');
const startupOverlayText = document.getElementById('startup-overlay-text');

// ============================================
// UI INITIALIZATION
// ============================================

document.addEventListener('DOMContentLoaded', async function() {
    await waitForBackendStartup();
    ensureAssessmentTimerUi();
    applyRoiOverlayGeometry();
    initializeWelcomeScreen();
    await loadSystemSettings();
    const restoredToResults = restoreResultsIfNeeded();
    if (restoredToResults) {
        loadAudioViaFetch();
        loadAudioSettings();
        return;
    }
    setupSessionEndOnUnload();
    setupSessionInactivityHandlers();
    restoreSessionIfExists();
    loadAudioViaFetch();
    loadAudioSettings();
});

async function waitForBackendStartup() {
    if (!startupOverlay) return;

    startupOverlay.classList.remove('hidden');
    let attempts = 0;

    while (true) {
        attempts += 1;
        try {
            if (startupOverlayText) {
                if (attempts <= 5) {
                    startupOverlayText.textContent = 'Starting recognition engine for first-time setup.';
                } else {
                    startupOverlayText.textContent = 'Still preparing model files. Please wait...';
                }
            }

            const response = await fetch(`${API_URL}/health`, { cache: 'no-store' });
            if (response.ok) {
                startupOverlay.classList.add('hidden');
                return;
            }
        } catch (error) {
            // Keep waiting while backend boots.
        }

        await new Promise((resolve) => setTimeout(resolve, 1500));
    }
}

function restoreResultsIfNeeded() {
    const raw = sessionStorage.getItem(RESULTS_REDIRECT_KEY);
    if (!raw) return false;

    try {
        const payload = JSON.parse(raw);
        sessionStorage.removeItem(RESULTS_REDIRECT_KEY);

        sessionMode = payload.sessionMode || 'assessment';
        studentNickname = payload.studentNickname || '';
        if (studentDisplayName && studentNickname) {
            studentDisplayName.textContent = studentNickname;
        }

        welcomeScreen.classList.add('hidden');
        gameScreen.classList.add('hidden');
        resultsScreen.classList.remove('hidden');

        const stats = payload.stats || {
            total_scans: 0,
            correct_scans: 0,
            accuracy: 0
        };
        showResults(stats);
        return true;
    } catch (error) {
        sessionStorage.removeItem(RESULTS_REDIRECT_KEY);
        return false;
    }
}

function smoothReloadToResults(stats) {
    skipSessionPersistOnUnload = true;
    sessionStorage.setItem(RESULTS_REDIRECT_KEY, JSON.stringify({
        stats: stats,
        sessionMode: sessionMode,
        studentNickname: studentNickname
    }));

    document.body.classList.add('is-reloading');
    setTimeout(function() {
        location.reload();
    }, 300);
}

function restartGame() {
    skipSessionPersistOnUnload = true;
    closeTimeUpModal();
    sessionStorage.removeItem(RESULTS_REDIRECT_KEY);
    clearSessionStorage();
    pendingTimeUpStats = null;
    sessionId = null;
    document.body.classList.add('is-reloading');
    setTimeout(function() {
        location.reload();
    }, 250);
}

function ensureAssessmentTimerUi() {
    const scoreBoard = document.querySelector('.score-board');
    if (!scoreBoard) return;

    testTimerWrap = document.getElementById('test-timer-wrap');
    testTimerEl = document.getElementById('test-timer');

    if (!testTimerWrap || !testTimerEl) {
        const divider = document.createElement('div');
        divider.className = 'score-divider';

        const wrap = document.createElement('div');
        wrap.className = 'score-item';
        wrap.id = 'test-timer-wrap';
        wrap.style.display = 'none';

        const value = document.createElement('span');
        value.className = 'score-value';
        value.id = 'test-timer';
        value.textContent = '01:00';

        const label = document.createElement('span');
        label.className = 'score-label';
        label.textContent = 'Timer';

        wrap.appendChild(value);
        wrap.appendChild(label);
        scoreBoard.appendChild(divider);
        scoreBoard.appendChild(wrap);

        testTimerWrap = wrap;
        testTimerEl = value;
    }
}

function applyRoiOverlayGeometry() {
    const roiBox = document.querySelector('.roi-box');
    if (!roiBox) return;

    const ratio = Math.max(0.3, Math.min(0.9, CAMERA_ROI_RATIO));
    const sizePct = ratio * 100;
    const offsetPct = (100 - sizePct) / 2;

    roiBox.style.width = `${sizePct}%`;
    roiBox.style.height = `${sizePct}%`;
    roiBox.style.left = `${offsetPct}%`;
    roiBox.style.top = `${offsetPct}%`;
}

// Session persistence - save/restore from localStorage
function saveSessionToStorage() {
    if (!sessionId) return;
    const sessionData = {
        sessionId: sessionId,
        studentNickname: studentNickname,
        sessionMode: sessionMode,
        totalScans: totalScans,
        correctScans: correctScans,
        learnCardsExplored: learnCardsExplored,
        assessmentRemainingSeconds: assessmentRemainingSeconds,
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
        learnCardsExplored = Math.max(0, parseInt(sessionData.learnCardsExplored, 10) || 0);
        assessmentRemainingSeconds = Number.isFinite(sessionData.assessmentRemainingSeconds)
            ? sessionData.assessmentRemainingSeconds
            : Math.max(10, parseInt(SYSTEM_CONFIG.assessment_timer_seconds, 10) || 60);
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

        updateLearnCardCounter();
        
        if (sessionMode === 'instructional') {
            gameScreen.classList.add('learn-mode');
            stopAssessmentTimer();
        } else {
            gameScreen.classList.remove('learn-mode');
            if (sfxMuted) {
                sfxMuted = false;
                saveAudioSettings();
            }
            applyAudioFeedbackPolicy();
            warmupAssessmentSfx();
            const sfxToggle = document.getElementById('toggle-sfx');
            if (sfxToggle) sfxToggle.checked = true;
            updateAssessmentTimerDisplay();
            startAssessmentTimer();
        }
        
        welcomeScreen.classList.add('hidden');
        gameScreen.classList.remove('hidden');
        loadLeaderboardForIndex('game', studentNickname);
        
        initCamera();
        resetSessionInactivityTimer();
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
        if (skipSessionPersistOnUnload) {
            return;
        }
        if (sessionId && !gameScreen.classList.contains('hidden')) {
            // Save session state so it can be restored
            saveSessionToStorage();
        }
    });
    
    // End session only when actually leaving the page
    window.addEventListener('pagehide', function() {
        // Session state is saved in beforeunload; restore on next page load
    });
}

// Load system settings from admin config
async function loadSystemSettings() {
    try {
        const response = await fetch(`${API_URL}/admin/config`);
        const data = await response.json();
        
        if (data.status === 'success' && data.config) {
            data.config.forEach(cfg => {
                SYSTEM_CONFIG[cfg.config_key] = parseConfigValue(cfg.config_value, cfg.value_type);

                // Apply ROI Box Color to corner brackets
                if (cfg.config_key === 'roi_box_color') {
                    document.querySelectorAll('.roi-corner').forEach(el => {
                        if (el) el.style.borderColor = cfg.config_value;
                    });
                }
            });

            applyAudioFeedbackPolicy();
            resetSessionInactivityTimer();
        }
    } catch (error) {
        console.log('Using default settings');
    }
}

function parseConfigValue(value, valueType) {
    if (valueType === 'integer') {
        const parsed = parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    if (valueType === 'float') {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    if (valueType === 'boolean') {
        return String(value).toLowerCase() === 'true' || String(value) === '1';
    }

    return value;
}

function setupSessionInactivityHandlers() {
    if (inactivityHandlersBound) return;

    ['pointerdown', 'keydown', 'touchstart'].forEach(function(eventName) {
        document.addEventListener(eventName, resetSessionInactivityTimer, { passive: true });
    });

    inactivityHandlersBound = true;
}

function clearSessionInactivityTimer() {
    if (inactivityTimeout) {
        clearTimeout(inactivityTimeout);
        inactivityTimeout = null;
    }
}

function resetSessionInactivityTimer() {
    clearSessionInactivityTimer();

    if (!sessionId || gameScreen.classList.contains('hidden')) {
        return;
    }

    const timeoutMinutes = Math.max(1, parseInt(SYSTEM_CONFIG.session_timeout_minutes, 10) || 30);
    inactivityTimeout = setTimeout(autoEndSessionForInactivity, timeoutMinutes * 60 * 1000);
}

async function autoEndSessionForInactivity() {
    if (!sessionId || gameScreen.classList.contains('hidden')) return;

    stopSpeech();
    clearSessionStorage();

    try {
        const response = await fetch(`${API_URL}/session/end`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();

        if (data.status === 'success') {
            showResults(data.stats);
        } else {
            showResults({
                total_scans: totalScans,
                correct_scans: correctScans,
                accuracy: totalScans > 0 ? Math.round((correctScans / totalScans) * 100) : 0
            });
        }
    } catch (err) {
        console.error('❌ Auto session end error:', err);
        showResults({
            total_scans: totalScans,
            correct_scans: correctScans,
            accuracy: totalScans > 0 ? Math.round((correctScans / totalScans) * 100) : 0
        });
    } finally {
        clearSessionInactivityTimer();
        alert('Session ended due to inactivity. Start a new session when ready.');
    }
}

function isAudioFeedbackEnabled() {
    return !!SYSTEM_CONFIG.enable_audio_feedback;
}

function applyAudioFeedbackPolicy() {
    if (!isAudioFeedbackEnabled()) {
        stopSpeech();
    }

    if (successSound) successSound.muted = sfxMuted;
    if (errorSound) errorSound.muted = sfxMuted;
}

function playSfx(soundEl) {
    if (!soundEl || sfxMuted) return;
    // In assessment mode, always keep right/wrong answer SFX available.
    if (sessionMode !== 'assessment' && !isAudioFeedbackEnabled()) return;
    if (!soundEl.src && soundEl.id === 'success-sound') soundEl.src = 'assets/success.mp3';
    if (!soundEl.src && soundEl.id === 'error-sound') soundEl.src = 'assets/error.mp3';
    soundEl.muted = false;
    soundEl.volume = 1;
    soundEl.currentTime = 0;
    soundEl.play().catch(function() {});
}

function warmupAssessmentSfx() {
    [successSound, errorSound].forEach(function(soundEl) {
        if (!soundEl) return;
        if (!soundEl.src && soundEl.id === 'success-sound') soundEl.src = 'assets/success.mp3';
        if (!soundEl.src && soundEl.id === 'error-sound') soundEl.src = 'assets/error.mp3';
        const wasMuted = soundEl.muted;
        soundEl.muted = true;
        soundEl.play().then(function() {
            soundEl.pause();
            soundEl.currentTime = 0;
            soundEl.muted = wasMuted;
        }).catch(function() {
            soundEl.muted = wasMuted;
        });
    });
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

const categoryReasonTagalog = {
    'Compostable': 'nabubulok ito',
    'Recyclable': 'puwede pa itong i-recycle',
    'Non-Recyclable': 'hindi ito puwedeng i-recycle o i-compost',
    'Special Waste': 'may delikadong sangkap ito'
};

function getCategoryReasonTagalog(category) {
    return categoryReasonTagalog[category] || 'ito ang tamang paraan ng waste segregation para sa kaligtasan ng kapaligiran';
}

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
        const fps = Math.max(1, parseInt(SYSTEM_CONFIG.webcam_fps, 10) || 30);
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video: { 
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: fps, max: fps }
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
    learnCardsExplored = 0;
    updateLearnCardCounter();

    // Start background music immediately (must be in user-gesture context)
    startBackgroundMusic();

    // Configure UI based on mode
    configureGameForMode(selectedMode);
    
    // Add learn-mode class to hide leaderboard in instructional mode
    if (selectedMode === 'instructional') {
        gameScreen.classList.add('learn-mode');
    } else {
        gameScreen.classList.remove('learn-mode');
        if (sfxMuted) {
            sfxMuted = false;
            saveAudioSettings();
        }
        applyAudioFeedbackPolicy();
        warmupAssessmentSfx();
        const sfxToggle = document.getElementById('toggle-sfx');
        if (sfxToggle) sfxToggle.checked = true;
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
            assessmentRemainingSeconds = Math.max(10, parseInt(SYSTEM_CONFIG.assessment_timer_seconds, 10) || 60);
            
            saveSessionToStorage();
            
            // Transition to game
            welcomeScreen.classList.add('hidden');
            gameScreen.classList.remove('hidden');
            loadLeaderboardForIndex('game', studentNickname);

            await initCamera();
            resetSessionInactivityTimer();

            if (sessionMode === 'assessment') {
                updateAssessmentTimerDisplay();
                startAssessmentTimer();
            } else {
                stopAssessmentTimer();
            }
            
            setInitialGameMessage();
            await maybeStartModeTutorial();
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
    ensureAssessmentTimerUi();

    const scanItem = scanCountEl ? scanCountEl.closest('.score-item') : null;
    const correctItem = correctCountEl ? correctCountEl.closest('.score-item') : null;
    const scanDivider = scanItem ? scanItem.nextElementSibling : null;
    const correctDivider = correctItem ? correctItem.nextElementSibling : null;
    const timerDivider = testTimerWrap ? testTimerWrap.previousElementSibling : null;
    
    if (mode === 'instructional') {
        // Learn Mode: show 10-card counter in the same score-board style
        if (headerLeftScore) headerLeftScore.style.display = 'flex';

        if (scanItem) scanItem.style.display = 'none';
        if (scanDivider && scanDivider.classList.contains('score-divider')) scanDivider.style.display = 'none';
        if (correctItem) correctItem.style.display = 'none';
        if (correctDivider && correctDivider.classList.contains('score-divider')) correctDivider.style.display = 'none';
        if (testTimerWrap) testTimerWrap.style.display = 'none';
        if (timerDivider && timerDivider.classList.contains('score-divider')) timerDivider.style.display = 'none';

        if (learnCardCounterDivider) learnCardCounterDivider.style.display = 'none';
        if (learnCardCounterWrap) learnCardCounterWrap.style.display = 'block';
        updateLearnCardCounter();
        stopAssessmentTimer();
    } else {
        // Show scores in assessment mode
        if (headerLeftScore) headerLeftScore.style.display = 'flex';
        if (scanItem) scanItem.style.display = 'block';
        if (scanDivider && scanDivider.classList.contains('score-divider')) scanDivider.style.display = 'block';
        if (correctItem) correctItem.style.display = 'block';
        if (correctDivider && correctDivider.classList.contains('score-divider')) correctDivider.style.display = 'block';
        if (testTimerWrap) testTimerWrap.style.display = 'block';
        if (timerDivider && timerDivider.classList.contains('score-divider')) timerDivider.style.display = 'block';
        if (learnCardCounterDivider) learnCardCounterDivider.style.display = 'none';
        if (learnCardCounterWrap) learnCardCounterWrap.style.display = 'none';
        updateAssessmentTimerDisplay();
    }
}

function updateLearnCardCounter() {
    if (!learnCardCountEl) return;
    const explored = Math.max(0, Math.min(LEARN_CARD_TARGET, parseInt(learnCardsExplored, 10) || 0));
    learnCardCountEl.textContent = `${explored}/${LEARN_CARD_TARGET}`;
}

async function shouldRunTutorialForCurrentPlayer() {
    if (!studentNickname || !sessionId) return false;

    try {
        const response = await fetch(`${API_URL}/tutorial/should-show`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nickname: studentNickname,
                mode: sessionMode,
                current_session_id: sessionId
            })
        });

        const data = await response.json();
        return data.status === 'success' && !!data.should_show;
    } catch (error) {
        return false;
    }
}

async function maybeStartModeTutorial() {
    const shouldShow = await shouldRunTutorialForCurrentPlayer();
    if (!shouldShow) return;
    const modeKey = sessionMode === 'assessment' ? 'assessment' : 'instructional';
    const steps = tutorialStepsByMode[modeKey] || [];
    if (!steps.length) return;

    startCinematicTutorial(steps);
}

function startCinematicTutorial(steps) {
    if (!Array.isArray(steps) || !steps.length) return;
    if (tutorialState && tutorialState.active) return;

    stopSpeech();
    const wasAssessmentTimerRunning = !!assessmentTimerHandle;
    if (sessionMode === 'assessment') {
        stopAssessmentTimer();
    }

    const overlay = createTutorialOverlay();
    const bubbleTitle = overlay.querySelector('[data-tutorial-title]');
    const bubbleText = overlay.querySelector('[data-tutorial-text]');
    const stepCounter = overlay.querySelector('[data-tutorial-step]');
    const bubblePanel = overlay.querySelector('.tutorial-binbin-bubble');
    const btnPrev = overlay.querySelector('[data-tutorial-prev]');
    const btnNext = overlay.querySelector('[data-tutorial-next]');
    const btnSkip = overlay.querySelector('[data-tutorial-skip]');

    tutorialState = {
        active: true,
        steps: steps,
        currentIndex: 0,
        overlay: overlay,
        highlightedEl: null,
        spotlightCutout: overlay.querySelector('[data-tutorial-cutout]'),
        spotlightRing: overlay.querySelector('[data-tutorial-ring]'),
        pausedAssessmentTimer: wasAssessmentTimerRunning
    };

    document.body.classList.add('tutorial-active');

    const finishTutorial = () => {
        if (!tutorialState || !tutorialState.active) return;

        const state = tutorialState;
        if (state.highlightedEl) {
            state.highlightedEl.classList.remove('tutorial-spotlight');
        }
        if (state.spotlightCutout) {
            state.spotlightCutout.classList.remove('is-visible');
        }
        if (state.spotlightRing) {
            state.spotlightRing.classList.remove('is-visible');
        }

        if (state.overlay && state.overlay.parentNode) {
            state.overlay.parentNode.removeChild(state.overlay);
        }

        document.body.classList.remove('tutorial-active');
        tutorialState = null;

        if (sessionMode === 'assessment' && state.pausedAssessmentTimer && !gameScreen.classList.contains('hidden')) {
            startAssessmentTimer();
        }
    };

    const goToStep = (newIndex) => {
        if (!tutorialState || !tutorialState.active) return;

        if (newIndex < 0) newIndex = 0;
        if (newIndex >= tutorialState.steps.length) {
            finishTutorial();
            return;
        }

        if (tutorialState.highlightedEl) {
            tutorialState.highlightedEl.classList.remove('tutorial-spotlight');
        }

        tutorialState.currentIndex = newIndex;
        const step = tutorialState.steps[newIndex];
        const targetEl = resolveTutorialTarget(step);

        tutorialState.highlightedEl = targetEl || null;
        if (targetEl) {
            targetEl.classList.add('tutorial-spotlight');
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
            positionTutorialSpotlight(tutorialState.spotlightCutout, tutorialState.spotlightRing, targetEl);
            setTimeout(function() {
                if (tutorialState && tutorialState.active && tutorialState.highlightedEl === targetEl) {
                    positionTutorialSpotlight(tutorialState.spotlightCutout, tutorialState.spotlightRing, targetEl);
                }
            }, 260);
        } else {
            if (tutorialState.spotlightCutout) {
                tutorialState.spotlightCutout.classList.remove('is-visible');
            }
            if (tutorialState.spotlightRing) {
                tutorialState.spotlightRing.classList.remove('is-visible');
            }
        }

        bubbleTitle.textContent = step.title || 'Quick Tour';
        bubbleText.textContent = step.text || '';
        stepCounter.textContent = 'Step ' + (newIndex + 1) + ' of ' + tutorialState.steps.length;

        if (bubblePanel) {
            bubblePanel.classList.remove('tutorial-bubble-top', 'tutorial-bubble-bottom');
            bubblePanel.classList.add(step.bubblePosition === 'top' ? 'tutorial-bubble-top' : 'tutorial-bubble-bottom');
        }

        btnPrev.disabled = newIndex === 0;
        btnNext.textContent = (newIndex === tutorialState.steps.length - 1) ? 'Finish' : 'Next';
    };

    btnPrev.addEventListener('click', function() {
        goToStep(tutorialState.currentIndex - 1);
    });
    btnNext.addEventListener('click', function() {
        goToStep(tutorialState.currentIndex + 1);
    });
    btnSkip.addEventListener('click', finishTutorial);

    goToStep(0);
}

function isElementVisibleForTutorial(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (!style) return false;
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return el.getClientRects && el.getClientRects().length > 0;
}

function resolveTutorialTarget(step) {
    if (!step) return null;

    const selectors = [];
    if (Array.isArray(step.targets)) {
        selectors.push.apply(selectors, step.targets);
    }
    if (step.target) {
        selectors.push(step.target);
    }

    for (let i = 0; i < selectors.length; i++) {
        const selector = selectors[i];
        if (!selector) continue;
        let el = document.querySelector(selector);
        if (selector === '#test-timer' && el) {
            const wrap = el.closest('#test-timer-wrap');
            if (wrap) {
                el = wrap;
            }
        }
        if (isElementVisibleForTutorial(el)) {
            return el;
        }
    }

    return null;
}

function positionTutorialSpotlight(cutout, ring, targetEl) {
    if (!targetEl) return;
    const rect = targetEl.getBoundingClientRect();
    const cutoutPad = 4;
    const ringPad = 8;

    if (cutout) {
        cutout.style.left = Math.max(0, rect.left - cutoutPad) + 'px';
        cutout.style.top = Math.max(0, rect.top - cutoutPad) + 'px';
        cutout.style.width = Math.max(24, rect.width + cutoutPad * 2) + 'px';
        cutout.style.height = Math.max(24, rect.height + cutoutPad * 2) + 'px';
        cutout.classList.add('is-visible');
    }

    if (ring) {
        ring.style.left = Math.max(0, rect.left - ringPad) + 'px';
        ring.style.top = Math.max(0, rect.top - ringPad) + 'px';
        ring.style.width = Math.max(24, rect.width + ringPad * 2) + 'px';
        ring.style.height = Math.max(24, rect.height + ringPad * 2) + 'px';
        ring.classList.add('is-visible');
    }
}

function createTutorialOverlay() {
    const existing = document.getElementById('cinematic-tutorial-overlay');
    if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
    }

    const overlay = document.createElement('div');
    overlay.id = 'cinematic-tutorial-overlay';
    overlay.className = 'cinematic-tutorial-overlay';
    overlay.innerHTML = `
        <div class="tutorial-dim-layer"></div>
        <div class="tutorial-focus-cutout" data-tutorial-cutout aria-hidden="true"></div>
        <div class="tutorial-spotlight-ring" data-tutorial-ring aria-hidden="true"></div>
        <div class="tutorial-binbin-bubble" role="dialog" aria-live="polite" aria-label="Bin-Bin Tutorial">
            <div class="tutorial-binbin-avatar-wrap">
                <img src="assets/binbin_happy.png" alt="Bin-Bin" class="tutorial-binbin-avatar">
            </div>
            <div class="tutorial-bubble-content">
                <p class="tutorial-bubble-step" data-tutorial-step>Step 1 of 1</p>
                <h3 class="tutorial-bubble-title" data-tutorial-title>Quick Tour</h3>
                <p class="tutorial-bubble-text" data-tutorial-text></p>
                <div class="tutorial-bubble-actions">
                    <button type="button" class="tutorial-btn tutorial-btn-secondary" data-tutorial-prev>Back</button>
                    <button type="button" class="tutorial-btn tutorial-btn-ghost" data-tutorial-skip>Skip</button>
                    <button type="button" class="tutorial-btn tutorial-btn-primary" data-tutorial-next>Next</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    return overlay;
}

function updateAssessmentTimerDisplay() {
    if (!testTimerEl) return;
    const safeSeconds = Math.max(0, Math.floor(assessmentRemainingSeconds));
    const mins = Math.floor(safeSeconds / 60);
    const secs = safeSeconds % 60;
    testTimerEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    testTimerEl.classList.toggle('timer-warning', safeSeconds <= 10);
}

function startAssessmentTimer() {
    if (sessionMode !== 'assessment' || !sessionId) return;
    stopAssessmentTimer();
    updateAssessmentTimerDisplay();
    assessmentTimerHandle = setInterval(() => {
        assessmentRemainingSeconds -= 1;
        updateAssessmentTimerDisplay();
        saveSessionToStorage();

        if (assessmentRemainingSeconds <= 0) {
            stopAssessmentTimer();
            forceEndSessionByTimer();
        }
    }, 1000);
}

function stopAssessmentTimer() {
    if (assessmentTimerHandle) {
        clearInterval(assessmentTimerHandle);
        assessmentTimerHandle = null;
    }
}

async function forceEndSessionByTimer() {
    if (!sessionId || gameScreen.classList.contains('hidden')) return;

    stopSpeech();
    clearSessionStorage();

    try {
        const response = await fetch(`${API_URL}/session/end`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();

        if (data.status === 'success') {
            pendingTimeUpStats = data.stats;
        } else {
            pendingTimeUpStats = {
                total_scans: totalScans,
                correct_scans: correctScans,
                accuracy: totalScans > 0 ? Math.round((correctScans / totalScans) * 100) : 0
            };
        }
    } catch (err) {
        console.error('❌ Timer session end error:', err);
        pendingTimeUpStats = {
            total_scans: totalScans,
            correct_scans: correctScans,
            accuracy: totalScans > 0 ? Math.round((correctScans / totalScans) * 100) : 0
        };
    } finally {
        clearSessionInactivityTimer();
        showTimeUpModal();
    }
}

function showTimeUpModal() {
    forceDismissStaleTutorialOverlay();
    const modal = document.getElementById('timeUpModal');
    if (modal) modal.classList.add('active');
}

function closeTimeUpModal() {
    const modal = document.getElementById('timeUpModal');
    if (modal) modal.classList.remove('active');
}

function forceDismissStaleTutorialOverlay() {
    // Safety: if the cinematic tutorial overlay ever gets stuck (e.g., due to an
    // exception during cleanup), it can sit above everything with a huge z-index
    // and block modals. When we need a modal, force-clear that state.
    try {
        const overlay = document.getElementById('cinematic-tutorial-overlay');
        if (overlay && overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
        }

        if (tutorialState && tutorialState.highlightedEl) {
            tutorialState.highlightedEl.classList.remove('tutorial-spotlight');
        }

        document.body.classList.remove('tutorial-active');
        if (tutorialState && tutorialState.active) {
            tutorialState = null;
        }
    } catch (e) {
        // Swallow all errors; modal display must still proceed.
    }
}

function showRepeatScanModal(cardName) {
    forceDismissStaleTutorialOverlay();
    let modal = document.getElementById('repeatScanModal');
    if (!modal) {
        modal = createRepeatScanModal();
    }
    if (!modal) return;
    if (modal.classList.contains('active')) return;

    const mainTextEl = document.getElementById('repeat-scan-main-text');
    const friendlyName = (cardName || '').toString().replace(/_/g, ' ').trim();
    if (mainTextEl) {
        mainTextEl.textContent = friendlyName
            ? `You already scanned "${friendlyName}".`
            : 'You already scanned that card.';
    }

    modal.classList.add('active');
}

function createRepeatScanModal() {
    try {
        const wrapper = document.createElement('div');
        wrapper.id = 'repeatScanModal';
        wrapper.className = 'quit-modal';
        wrapper.addEventListener('click', handleRepeatScanModalBackdropClick);
        wrapper.innerHTML = `
            <div class="quit-modal-content">
                <img src="assets/leafframe.png" class="quit-frame-overlay" alt="Leaf Frame">
                <div class="quit-modal-header">
                    <h3>Already scanned!</h3>
                </div>
                <div class="quit-modal-body">
                    <p class="quit-modal-main-text">
                        <strong id="repeat-scan-main-text">You already scanned that card.</strong>
                    </p>
                    <p class="quit-modal-sub-text">Please pick a different eco-card.</p>
                </div>
                <div class="quit-modal-actions">
                    <button type="button" class="btn-quit-confirm">OK</button>
                </div>
            </div>
        `;

        const content = wrapper.querySelector('.quit-modal-content');
        if (content) {
            content.addEventListener('click', function(event) {
                event.stopPropagation();
            });
        }

        const okBtn = wrapper.querySelector('.btn-quit-confirm');
        if (okBtn) {
            okBtn.addEventListener('click', closeRepeatScanModal);
        }

        document.body.appendChild(wrapper);
        return wrapper;
    } catch (e) {
        return null;
    }
}

function closeRepeatScanModal() {
    const modal = document.getElementById('repeatScanModal');
    if (modal) modal.classList.remove('active');
}

function handleRepeatScanModalBackdropClick(event) {
    if (event.target === event.currentTarget) {
        closeRepeatScanModal();
    }
}

function handleTimeUpModalBackdropClick(event) {
    if (event.target === event.currentTarget) {
        confirmTimeUpProceed();
    }
}

function confirmTimeUpProceed() {
    closeTimeUpModal();
    sessionId = null;
    const stats = pendingTimeUpStats || {
        total_scans: totalScans,
        correct_scans: correctScans,
        accuracy: totalScans > 0 ? Math.round((correctScans / totalScans) * 100) : 0
    };
    smoothReloadToResults(stats);
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
    } finally {
        clearSessionInactivityTimer();
        stopAssessmentTimer();
    }
}

function showResults(stats) {
    // Stop any ongoing speech
    stopSpeech();
    stopAssessmentTimer();
    
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
        const learnCountEl = document.getElementById('learn-results-count');
        const scanCount = stats.total_scans || 0;
        const exploredCount = Math.max(0, Math.min(LEARN_CARD_TARGET, parseInt(scanCount, 10) || 0));
        if (learnCountEl) {
            learnCountEl.textContent = `Eco-cards explored: ${exploredCount}/${LEARN_CARD_TARGET}`;
        }
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

function getProficiencyScore(student) {
    const scans = Number(student.total_scans || 0);
    const correct = Number(student.correct || 0);
    if (Number.isFinite(student.proficiency_score)) {
        return Number(student.proficiency_score);
    }
    if (Number.isFinite(student.avg_accuracy)) {
        return Number(student.avg_accuracy);
    }
    return scans > 0 ? (correct * 100) / scans : 0;
}

function renderLeaderboardPodium(topStudents, highlightNickname) {
    if (!topStudents || topStudents.length === 0) return '';

    const byRank = {
        1: topStudents[0] || null,
        2: topStudents[1] || null,
        3: topStudents[2] || null
    };

    const slotOrder = [2, 1, 3];
    const slotClassByRank = {
        1: 'lb-podium-gold',
        2: 'lb-podium-silver',
        3: 'lb-podium-bronze'
    };
    const medalByRank = { 1: '🥇', 2: '🥈', 3: '🥉' };

    return `<div class="lb-podium">${slotOrder.map(rank => {
        const student = byRank[rank];
        if (!student) {
            return `<div class="lb-podium-slot ${slotClassByRank[rank]} lb-podium-empty"><div class="lb-podium-card"><div class="lb-podium-name">No player yet</div><div class="lb-podium-score">--</div></div><div class="lb-podium-base lb-base-${rank}">#${rank}</div></div>`;
        }

        const score = getProficiencyScore(student);
        const isHighlight = highlightNickname && student.nickname === highlightNickname;
        return `<div class="lb-podium-slot ${slotClassByRank[rank]}${isHighlight ? ' highlight' : ''}">
            <div class="lb-podium-card">
                <div class="lb-podium-medal">${medalByRank[rank]}</div>
                <div class="lb-podium-name">${escapeHtml(student.nickname || 'Guest')}</div>
                <div class="lb-podium-score" style="color:${getAccuracyColor(score)}">${Math.round(score)}%</div>
                <div class="lb-podium-meta">${Number(student.correct || 0)} / ${Number(student.total_scans || 0)} correct</div>
            </div>
            <div class="lb-podium-base lb-base-${rank}">#${rank}</div>
        </div>`;
    }).join('')}</div>`;
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

        const podiumSource = data.leaderboard.slice(0, 3);
        const podiumHtml = renderLeaderboardPodium(podiumSource, highlightNickname);

        if (which === 'results') {
            container.innerHTML = podiumHtml;
            return;
        }

        const rest = data.leaderboard.slice(3, 20);

        const listHtml = rest.map(student => {
            const score = getProficiencyScore(student);
            const isHighlight = highlightNickname && student.nickname === highlightNickname;
            return `<div class="leaderboard-item${isHighlight ? ' highlight' : ''}" role="listitem">
                <span class="leaderboard-rank">#${student.rank}</span>
                <span class="leaderboard-name">${escapeHtml(student.nickname || 'Guest')}</span>
                <span class="leaderboard-meta">${Number(student.correct || 0)}/${Number(student.total_scans || 0)}</span>
                <span class="leaderboard-score" style="color:${getAccuracyColor(score)}">${Math.round(score)}%</span>
            </div>`;
        }).join('');

        container.innerHTML = `
            ${podiumHtml}
            <div class="leaderboard-mini-list">${listHtml || '<div class="leaderboard-rest-empty">No additional players yet. More rankings will appear here.</div>'}</div>
        `;
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

    const repeatScanModal = document.getElementById('repeatScanModal');
    if (repeatScanModal && repeatScanModal.classList.contains('active')) {
        return;
    }

    stopSpeech();
    stopSfx();
    
    if (feedbackResetTimeout) { clearTimeout(feedbackResetTimeout); feedbackResetTimeout = null; }
    if (instructionalResetTimeout) { clearTimeout(instructionalResetTimeout); instructionalResetTimeout = null; }
    if (scanUnlockTimeout) { clearTimeout(scanUnlockTimeout); scanUnlockTimeout = null; }
    
    isScanning = true;
    scanBtn.disabled = true;
    scanBtn.style.opacity = "0.6";

    // ============================================
    // FREEZE FRAME: pause the live video so the
    // exact moment of the button press is captured,
    // not a frame that arrived later during JS delay
    // ============================================
    video.pause();

    // Visual feedback
    scanEffect.classList.add('active');
    setTimeout(() => scanEffect.classList.remove('active'), 1000);
    
    resultText.textContent = "Hmm... let me think...";
    categoryDisplay.classList.add('hidden');
    const learnCardDisplay = document.getElementById('learn-card-display');
    const learnCatInfo = document.getElementById('learn-category-info');
    if (learnCardDisplay) learnCardDisplay.classList.add('hidden');
    if (learnCatInfo) learnCatInfo.classList.add('hidden');
    if (confidenceKidsEl) confidenceKidsEl.classList.add('hidden');
    binbinImg.style.transform = "scale(0.9) rotate(-5deg)";
    binbinImg.src = 'assets/binbin_neutral.png';
    
    // ============================================
    // TIGHT ROI: 50% center crop of the frozen frame
    // This cuts out the surrounding table/background
    // that was causing white-region false matches.
    // The dashed ROI box in the UI should visually
    // match this 50% zone so kids know where to hold
    // the card.
    // ============================================
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const cropW = Math.floor(vw * CAMERA_ROI_RATIO);
    const cropH = Math.floor(vh * CAMERA_ROI_RATIO);
    const startX = Math.floor((vw - cropW) / 2);
    const startY = Math.floor((vh - cropH) / 2);
    
    canvas.width = cropW;
    canvas.height = cropH;
    const ctx = canvas.getContext('2d');
    // The webcam element is mirrored in CSS for a natural UX. Canvas capture does NOT
    // include CSS transforms, so we mirror here to ensure the model sees what the
    // user sees (and what Teachable Machine's preview typically trains on).
    ctx.save();
    ctx.translate(cropW, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, startX, startY, cropW, cropH, 0, 0, cropW, cropH);
    ctx.restore();

    // Resume live feed AFTER capture so user sees camera unfreeze
    video.play();
    
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
            scheduleScanUnlock(SCAN_COOLDOWN_MS);
        } finally {
            if (sessionMode === 'instructional') {
                scheduleScanUnlock(SCAN_COOLDOWN_MS);
            }
        }
    }, 'image/jpeg', 0.95);
}

function handleInstructionalMode(data) {
    if (data.status === 'success') {
        showInstructionalFeedback(data);
    } else {
        showErrorFeedback(data);
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
            assessmentPromptStartedAt = 0;
            showErrorFeedback(data);
            // Re-enable button on error
            scheduleScanUnlock(SCAN_COOLDOWN_MS);
        }
    } else {
        // Ignore scan if already in identify mode (user scanned too quickly)
        console.log('Ignoring scan - already in identify mode');
        scheduleScanUnlock(0);
    }
}

function unlockScanButton() {
    isScanning = false;
    scanBtn.disabled = false;
    scanBtn.style.opacity = "1";
}

function scheduleScanUnlock(delayMs) {
    if (scanUnlockTimeout) {
        clearTimeout(scanUnlockTimeout);
        scanUnlockTimeout = null;
    }

    scanUnlockTimeout = setTimeout(() => {
        unlockScanButton();
        scanUnlockTimeout = null;
    }, Math.max(0, delayMs || 0));
}

function stopSfx() {
    [successSound, errorSound].forEach(sound => {
        if (!sound) return;
        sound.pause();
        sound.currentTime = 0;
    });
}

function sanitizeCardFileStem(cardName) {
    if (!cardName) return 'card';
    const normalized = String(cardName).replace(/ /g, '_').replace(/-/g, '_');
    const safe = normalized.replace(/[^A-Za-z0-9_]/g, '');
    return safe || 'card';
}

function resolveCardImagePath(result) {
    if (result && result.image_path) return result.image_path;
    const category = result && result.category ? result.category : '';
    const categoryFolder = category ? category.replace(/ /g, '-') : '';
    const cardFileName = sanitizeCardFileStem(result && result.card_name ? result.card_name : 'card');
    return categoryFolder ? ('assets/' + categoryFolder + '/' + cardFileName + '.webp') : '';
}

function addToScannedCards(cardName, icon, category, imagePath) {
    if (!scannedCardsListEl || !cardName) return;
    const fallbackResult = { card_name: cardName, category: category, image_path: imagePath || '' };
    const imgPath = resolveCardImagePath(fallbackResult);
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
    const reasonTl = getCategoryReasonTagalog(category);
    
    if (!config) return;
    
    playSfx(successSound);
    
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
        learnCardImage.src = resolveCardImagePath(data);
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
    
    addToScannedCards(data.card_name, config.icon, category, data.image_path);

    // Learn Mode protocol: count explored eco-cards up to 10.
    const previousLearnCount = Math.max(0, parseInt(learnCardsExplored, 10) || 0);
    learnCardsExplored = Math.min(LEARN_CARD_TARGET, previousLearnCount + 1);
    updateLearnCardCounter();
    saveSessionToStorage();

    // Auto-end the session once the student completes the 10/10 Learn target,
    // mirroring the Test mode behavior when the timer expires.
    if (previousLearnCount < LEARN_CARD_TARGET && learnCardsExplored >= LEARN_CARD_TARGET) {
        forceEndSessionByTimer();
        return;
    }
    
    // Speak concise reason-based feedback in Tagalog
    speak('Ang ' + friendlyName + ' ay kabilang sa ' + category + ' dahil ' + reasonTl + '. Very good!');
    
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

    // Start latency timer once the student is asked to choose a category.
    assessmentPromptStartedAt = performance.now();
    
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
        cardImgEl.src = resolveCardImagePath(currentScanResult);
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
    const decisionLatencyMs = assessmentPromptStartedAt > 0
        ? Math.max(0, Math.round(performance.now() - assessmentPromptStartedAt))
        : 0;
    const scanLatencyMs = Number.isFinite(Number(currentScanResult.response_time))
        ? Math.max(0, Math.round(Number(currentScanResult.response_time)))
        : 0;
    const responseLatencyMs = decisionLatencyMs + scanLatencyMs;
    
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
        playSfx(successSound);
    } else {
        modalBinbin.src = 'assets/binbin_warning.png';
        playSfx(errorSound);
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
                confidence: currentScanResult.confidence,
                response_time: responseLatencyMs
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
        assessmentPromptStartedAt = 0;
        scheduleScanUnlock(0);
        
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
    const reasonTl = getCategoryReasonTagalog(selectedCategory);
    
    binbinImg.src = config.mascot;
    playSfx(successSound);
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

    speak('Tama! Ang ' + friendlyName + ' ay kabilang sa ' + selectedCategory + ' dahil ' + reasonTl + '. Very good!');
    
    if (currentScanResult && currentScanResult.card_name) addToScannedCards(currentScanResult.card_name, config.icon, selectedCategory);
}

function showAssessmentIncorrect(selectedCategory, correctCategory) {
    const correctConfig = categories[correctCategory];
    const friendlyName = currentScanResult ? (currentScanResult.card_name || 'card').replace(/_/g, ' ') : 'card';
    const reasonTl = getCategoryReasonTagalog(correctCategory);
    
    binbinImg.src = 'assets/binbin_warning.png';
    playSfx(errorSound);
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

    speak('Hindi pa tama. Ang ' + friendlyName + ' ay kabilang sa ' + correctCategory + ' dahil ' + reasonTl + '. Subukan ulit!');
    
    // Add to recent scans
    if (currentScanResult && currentScanResult.card_name) addToScannedCards(currentScanResult.card_name, correctConfig.icon, correctCategory);
}

function resetAssessmentState() {
    assessmentStep = 'scan';
    currentScanResult = null;
    
    // Re-enable scan button for next scan
    scheduleScanUnlock(0);
    
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
    assessmentPromptStartedAt = 0;
    
    // Ensure modal is closed
    closeAssessmentModal();
}

function showErrorFeedback(data) {
    const rawReason = data && data.reason ? data.reason : 'unknown';
    const reason = String(rawReason).trim().toLowerCase();
    const now = Date.now();
    const shouldThrottleAudio = (reason === lastErrorReason) && ((now - lastErrorFeedbackAt) < ERROR_FEEDBACK_COOLDOWN_MS);

    if (sessionMode === 'instructional' && reason === 'already_scanned') {
        showRepeatScanModal(data && data.card_name ? data.card_name : '');
    }

    if (!shouldThrottleAudio) {
        stopSfx();
        playSfx(errorSound);
        lastErrorFeedbackAt = now;
        lastErrorReason = reason;
    }
    
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
    
    if (reason === 'insufficient_features') {
        message = "Hindi ko makita nang malinaw ang card. Pakihold ito sa loob ng box.";
    } else if (reason === 'already_scanned') {
        message = "Nascan mo na ang card na iyan! Pumili ng ibang card.";
    } else if (reason === 'not_in_subset') {
        message = "Hindi kasama ang card na iyan. Pumili ng ibang eco-card.";
    } else if (reason === 'low_confidence' || reason === 'orb_low_confidence' || reason === 'incremental_orb_low_confidence') {
        message = "Hmm, hindi ako sigurado dito. Subukan mong ipakita ang mas malinaw na card!";
    } else if (reason === 'ambiguous_match') {
        message = "Magkahawig ang nakita ko. Pakiharap ang card nang mas diretso para mas malinaw.";
    } else if (reason === 'connection_error') {
        message = "Naku! Nawala ang connection. Naka-on ba ang server?";
    } else {
        message = "Hindi ko nakikilala ang card na ito. Siguraduhing isa ito sa ating eco-cards!";
    }
    
    resultText.textContent = message;
    
    // Speak feedback
    if (!shouldThrottleAudio) {
        speak(message);
    }
}

// ============================================
// BACKGROUND MUSIC
// ============================================

const bgMusic = document.getElementById('background-music');
const BG_MUSIC_NORMAL_VOL = 0.3;  // Normal background volume
const BG_MUSIC_DUCK_VOL = 0.03;   // Ducked volume during speech
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
            applyAudioFeedbackPolicy();
            
            // Update toggle checkboxes
            const bgmToggle = document.getElementById('toggle-bgm');
            const sfxToggle = document.getElementById('toggle-sfx');
            if (bgmToggle) bgmToggle.checked = !bgmMuted;
            if (sfxToggle) sfxToggle.checked = !sfxMuted;
        } catch (e) {
            console.log('Could not load audio settings:', e);
        }
    } else {
        applyAudioFeedbackPolicy();
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
    applyAudioFeedbackPolicy();
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

function getPreferredFemaleVoice() {
    if (!('speechSynthesis' in window)) return null;
    const voices = window.speechSynthesis.getVoices() || [];
    if (!voices.length) return null;

    // Prefer Tagalog female voices first, then common female English voices.
    const femaleNameHint = /(female|woman|zira|hazel|susan|aria|jenny|sara|hedda|katja|samantha)/i;
    const tagalogVoices = voices.filter(v => /^tl(-|$)/i.test(v.lang));
    const englishVoices = voices.filter(v => /^en(-|$)/i.test(v.lang));

    return (
        tagalogVoices.find(v => femaleNameHint.test(v.name)) ||
        englishVoices.find(v => femaleNameHint.test(v.name)) ||
        tagalogVoices[0] ||
        englishVoices[0] ||
        voices[0]
    );
}

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
    if (sessionMode !== 'assessment' && !isAudioFeedbackEnabled()) return;

    // Stop any currently playing TTS audio
    if (currentTTSAudio) {
        currentTTSAudio.pause();
        currentTTSAudio = null;
        restoreBackgroundMusic();
    }
    
    if (!text) return;
    
    // Duck the background music
    duckBackgroundMusic();

    const assessmentSpeechRate = sessionMode === 'assessment' ? 1.35 : 1.1;
    
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
        currentTTSAudio.playbackRate = assessmentSpeechRate;
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
            const preferredVoice = getPreferredFemaleVoice();
            utterance.rate = sessionMode === 'assessment' ? 1.35 : 1.1;
            utterance.pitch = 1.2;
            utterance.volume = 0.8;
            if (preferredVoice) {
                utterance.voice = preferredVoice;
                utterance.lang = preferredVoice.lang;
            } else {
                utterance.lang = 'en-US';
            }
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
    if (tutorialState && tutorialState.active && e.code === 'Escape') {
        const skipBtn = tutorialState.overlay ? tutorialState.overlay.querySelector('[data-tutorial-skip]') : null;
        if (skipBtn) {
            skipBtn.click();
            return;
        }
    }

    // ESC closes the quit modal
    if (e.code === 'Escape') {
        const quitModal = document.getElementById('quitModal');
        if (quitModal && quitModal.classList.contains('active')) {
            closeQuitModal();
            return;
        }

        const repeatModal = document.getElementById('repeatScanModal');
        if (repeatModal && repeatModal.classList.contains('active')) {
            closeRepeatScanModal();
            return;
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
