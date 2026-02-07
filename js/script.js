// ============================================
// ECOLEARN - IMPROVED GAME LOGIC
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

// DOM Elements
const welcomeScreen = document.getElementById('welcome-screen');
const gameScreen = document.getElementById('game-screen');
const resultsScreen = document.getElementById('results-screen');

const studentNameInput = document.getElementById('student-name');
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
const confidenceContainer = document.getElementById('confidence-container');
const confidenceFill = document.getElementById('confidence-fill');
const confidencePercent = document.getElementById('confidence-percent');

const scanCountEl = document.getElementById('scan-count');
const correctCountEl = document.getElementById('correct-count');
const accuracyEl = document.getElementById('accuracy');

// Audio
const successSound = document.getElementById('success-sound');
const errorSound = document.getElementById('error-sound');

// ============================================
// UI INITIALIZATION AND HANDLERS
// ============================================

document.addEventListener('DOMContentLoaded', function() {
    initializeWelcomeScreen();
    loadSystemSettings(); // Load ROI color and other settings
});

// Load system settings from admin config
async function loadSystemSettings() {
    try {
        const response = await fetch(`${API_URL}/admin/config`);
        const data = await response.json();
        
        if (data.status === 'success' && data.config) {
            data.config.forEach(cfg => {
                // Apply ROI Box Color
                if (cfg.config_key === 'roi_box_color') {
                    const roiOverlay = document.querySelector('.roi-overlay');
                    if (roiOverlay) {
                        roiOverlay.style.borderColor = cfg.config_value;
                    }
                }
            });
        }
    } catch (error) {
        console.log('Using default settings');
    }
}

function initializeWelcomeScreen() {
    // Load preset nicknames
    loadPresetNicknames();
    
    // Set up mode selection handlers
    const modeRadios = document.querySelectorAll('input[name="learning-mode"]');
    modeRadios.forEach(radio => {
        radio.addEventListener('change', handleModeChange);
    });
}

async function loadPresetNicknames() {
    const presetSelect = document.getElementById('preset-nicknames');
    
    try {
        console.log('🔄 Loading preset nicknames...');
        const response = await fetch(`${API_URL}/admin/nicknames`);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        console.log('📝 Nicknames response:', data);
        
        if (data.status === 'success' && data.nicknames && data.nicknames.length > 0) {
            // Handle both object format (new) and string format (legacy)
            presetSelect.innerHTML = '<option value="">Choose a nickname...</option>' +
                data.nicknames.map(item => {
                    // If item is an object, extract nickname property; otherwise use as string
                    const nickname = typeof item === 'object' ? item.nickname : item;
                    return `<option value="${nickname}">${nickname}</option>`;
                }).join('');
            console.log(`✅ Loaded ${data.nicknames.length} nicknames`);
        } else {
            presetSelect.innerHTML = '<option value="">No nicknames available - contact admin</option>';
            console.log('⚠️ No nicknames found');
        }
    } catch (error) {
        console.error('❌ Failed to load preset nicknames:', error);
        presetSelect.innerHTML = '<option value="">Unable to load nicknames - contact admin</option>';
    }
}

function handleNicknameTypeChange(event) {
    // This function is no longer needed since we only have preset nicknames
}

function handleModeChange(event) {
    sessionMode = event.target.value;
    console.log('🎮 Mode selected:', sessionMode);
}

// Category Configuration
const categories = {
    'Compostable': {
        color: '#10B981',
        icon: '🌱',
        binColor: 'green',
        message: 'Great! This goes in the GREEN bin for composting!',
        mascot: 'assets/binbin_happy.png'
    },
    'Recyclable': {
        color: '#3B82F6',
        icon: '♻️',
        binColor: 'blue',
        message: 'Awesome! This goes in the BLUE bin for recycling!',
        mascot: 'assets/binbin_happy.png'
    },
    'Non-Recyclable': {
        color: '#EF4444',
        icon: '🗑️',
        binColor: 'red',
        message: 'This goes in the RED bin for non-recyclable waste.',
        mascot: 'assets/binbin_neutral.png'
    },
    'Special Waste': {
        color: '#F59E0B',
        icon: '⚠️',
        binColor: 'yellow',
        message: 'Careful! This goes in the YELLOW bin for special waste!',
        mascot: 'assets/binbin_warning.png'
    }
};

// ============================================
// INITIALIZATION
// ============================================

async function initCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video: { 
                width: { ideal: 1280 },
                height: { ideal: 720 }
            } 
        });
        video.srcObject = stream;
        console.log('✅ Camera initialized');
    } catch (err) {
        console.error('❌ Camera error:', err);
        alert('Camera access denied. Please allow camera access to use EcoLearn.');
    }
}

// ============================================
// GAME FLOW
// ============================================

async function startGame() {
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
    
    // Configure UI based on mode
    configureGameForMode(selectedMode);
    
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
            console.log(`✅ Session started: ${sessionId} (${sessionMode} mode)`);
            
            // Reset game state
            totalScans = 0;
            correctScans = 0;
            assessmentStep = 'scan';
            currentScanResult = null;
            
            // Transition to game
            welcomeScreen.classList.add('hidden');
            gameScreen.classList.remove('hidden');
            
            // Initialize camera
            await initCamera();
            
            // Set initial game state message
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
    const scoreDisplay = document.querySelector('.score-display');
    
    if (mode === 'instructional') {
        // Hide scores in instructional mode
        scoreDisplay.style.display = 'none';
    } else {
        // Show scores in assessment mode
        scoreDisplay.style.display = 'flex';
    }
}

function setInitialGameMessage() {
    if (sessionMode === 'instructional') {
        resultText.textContent = 'Ready to learn? Place a card in the camera and I\'ll help you sort it!';
        binbinImg.src = 'assets/binbin_neutral.png';
    } else {
        resultText.textContent = 'Assessment mode: Place a card in the camera to begin!';
        binbinImg.src = 'assets/binbin_neutral.png';
    }
}

async function endSession() {
    if (!confirm('Are you sure you want to finish learning?')) {
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/session/end`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        const data = await response.json();
        
        if (data.status === 'success') {
            // Show results
            showResults(data.stats);
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
    gameScreen.classList.add('hidden');
    resultsScreen.classList.remove('hidden');
    
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
}

// ============================================
// SCANNING & CLASSIFICATION
// ============================================

async function captureAndIdentify() {
    if (isScanning) return;
    
    isScanning = true;
    scanBtn.disabled = true;
    scanBtn.textContent = '🔄 Scanning...';
    
    // Visual feedback
    scanEffect.classList.add('active');
    setTimeout(() => scanEffect.classList.remove('active'), 1000);
    
    // Set thinking state
    resultText.textContent = "Hmm... let me think...";
    categoryDisplay.classList.add('hidden');
    confidenceContainer.classList.add('hidden');
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
            console.log('Classification result:', data);
            
            if (sessionMode === 'instructional') {
                handleInstructionalMode(data);
            } else {
                handleAssessmentMode(data);
            }
            
        } catch (err) {
            console.error('❌ Classification error:', err);
            showErrorFeedback({ reason: 'connection_error' });
        }
        
        isScanning = false;
        scanBtn.disabled = false;
        scanBtn.innerHTML = '<span class="btn-icon">📸</span><span class="btn-text">SCAN NOW</span>';
    }, 'image/jpeg', 0.95);
}

function handleInstructionalMode(data) {
    // In instructional mode, no scores are tracked, just learning feedback
    if (data.status === 'success') {
        // Log the successful scan for instructional mode
        logInstructionalScan(data);
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
            console.log('✅ Instructional scan logged');
        }
    } catch (error) {
        console.error('❌ Failed to log instructional scan:', error);
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
        }
    }
}

function showInstructionalFeedback(data) {
    const category = data.category;
    const config = categories[category];
    
    if (!config) {
        console.error('Unknown category:', category);
        return;
    }
    
    // Play success sound
    successSound.play().catch(e => console.log('Audio play failed:', e));
    
    // Animate Bin-Bin
    binbinImg.src = config.mascot;
    binbinImg.style.transform = "scale(1.15) rotate(5deg)";
    setTimeout(() => {
        binbinImg.style.transform = "scale(1) rotate(0deg)";
    }, 500);
    
    // Show result with educational message
    resultText.innerHTML = `<strong>It's a ${data.card_name}!</strong><br>${config.message}`;
    
    // Show category
    categoryName.textContent = category;
    categoryName.style.color = config.color;
    binIcon.textContent = config.icon;
    categoryDisplay.classList.remove('hidden');
    
    // Show confidence
    showConfidence(data.confidence);
}

function showAssessmentIdentification(data) {
    // Show the item but don't reveal the answer yet
    binbinImg.src = 'assets/binbin_neutral.png';
    resultText.innerHTML = `<strong>I see: ${data.card_name}</strong><br>Which category do you think this belongs to?`;
    
    // Hide the automatic category display
    categoryDisplay.classList.add('hidden');
    
    // Show assessment choices
    showAssessmentChoices();
}

function showAssessmentChoices() {
    // Create category choice buttons
    const choicesHtml = `
        <div class="assessment-choices">
            <h4>Choose the correct bin:</h4>
            <div class="choice-buttons">
                <button class="choice-btn" onclick="selectAssessmentChoice('Compostable')" data-category="Compostable">
                    🌱 Compostable
                </button>
                <button class="choice-btn" onclick="selectAssessmentChoice('Recyclable')" data-category="Recyclable">
                    ♻️ Recyclable
                </button>
                <button class="choice-btn" onclick="selectAssessmentChoice('Non-Recyclable')" data-category="Non-Recyclable">
                    🗑️ Non-Recyclable
                </button>
                <button class="choice-btn" onclick="selectAssessmentChoice('Special-Waste')" data-category="Special-Waste">
                    ⚠️ Special
                </button>
            </div>
        </div>
    `;
    
    // Add choices to the feedback panel
    const feedbackContent = document.querySelector('.feedback-content');
    
    // Remove existing choices if any
    const existingChoices = feedbackContent.querySelector('.assessment-choices');
    if (existingChoices) {
        existingChoices.remove();
    }
    
    feedbackContent.insertAdjacentHTML('beforeend', choicesHtml);
}

async function selectAssessmentChoice(selectedCategory) {
    if (!currentScanResult) return;
    
    const correctCategory = currentScanResult.category;
    
    try {
        // Submit assessment to backend
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
            const isCorrect = data.is_correct;
            
            // Update stats
            totalScans++;
            scanCountEl.textContent = totalScans;
            
            if (isCorrect) {
                correctScans++;
                correctCountEl.textContent = correctScans;
                showAssessmentCorrect(selectedCategory);
            } else {
                showAssessmentIncorrect(selectedCategory, correctCategory);
            }
            
            // Update accuracy
            const accuracy = totalScans > 0 ? Math.round((correctScans / totalScans) * 100) : 100;
            accuracyEl.textContent = accuracy + '%';
        } else {
            console.error('Assessment submit failed:', data.message);
            // Fall back to local handling
            const isCorrect = selectedCategory === correctCategory;
            if (isCorrect) {
                showAssessmentCorrect(selectedCategory);
            } else {
                showAssessmentIncorrect(selectedCategory, correctCategory);
            }
        }
        
    } catch (error) {
        console.error('❌ Assessment submit error:', error);
        // Fall back to local handling
        const isCorrect = selectedCategory === correctCategory;
        if (isCorrect) {
            showAssessmentCorrect(selectedCategory);
        } else {
            showAssessmentIncorrect(selectedCategory, correctCategory);
        }
    }
    
    // Reset for next scan
    setTimeout(() => {
        resetAssessmentState();
    }, 3000);
}

function showAssessmentCorrect(selectedCategory) {
    const config = categories[selectedCategory];
    
    // Play success sound
    successSound.play().catch(e => console.log('Audio play failed:', e));
    
    // Animate Bin-Bin
    binbinImg.src = config.mascot;
    binbinImg.style.transform = "scale(1.15) rotate(5deg)";
    setTimeout(() => {
        binbinImg.style.transform = "scale(1) rotate(0deg)";
    }, 500);
    
    resultText.innerHTML = `<strong>✅ Correct!</strong><br>Yes, this goes in the ${selectedCategory} bin!`;
    
    // Show the correct category
    categoryName.textContent = selectedCategory;
    categoryName.style.color = config.color;
    binIcon.textContent = config.icon;
    categoryDisplay.classList.remove('hidden');
    
    // Remove choices
    const choices = document.querySelector('.assessment-choices');
    if (choices) choices.remove();
}

function showAssessmentIncorrect(selectedCategory, correctCategory) {
    const correctConfig = categories[correctCategory];
    
    // Play error sound
    errorSound.play().catch(e => console.log('Audio play failed:', e));
    
    // Animate Bin-Bin
    binbinImg.src = 'assets/binbin_warning.png';
    binbinImg.style.transform = "scale(1.15) rotate(-5deg)";
    setTimeout(() => {
        binbinImg.style.transform = "scale(1) rotate(0deg)";
    }, 500);
    
    resultText.innerHTML = `<strong>❌ Not quite right!</strong><br>This should go in the <strong>${correctCategory}</strong> bin.`;
    
    // Show the correct category
    categoryName.textContent = correctCategory;
    categoryName.style.color = correctConfig.color;
    binIcon.textContent = correctConfig.icon;
    categoryDisplay.classList.remove('hidden');
    
    // Remove choices
    const choices = document.querySelector('.assessment-choices');
    if (choices) choices.remove();
}

function resetAssessmentState() {
    assessmentStep = 'scan';
    currentScanResult = null;
    
    // Reset UI
    resultText.textContent = "Ready for the next item? Place a card in the camera!";
    categoryDisplay.classList.add('hidden');
    binbinImg.src = 'assets/binbin_neutral.png';
    
    // Remove any remaining choices
    const choices = document.querySelector('.assessment-choices');
    if (choices) choices.remove();
}

function showSuccessFeedback(data) {
    // This function is now replaced by showInstructionalFeedback
    showInstructionalFeedback(data);
}

function showConfidence(confidence) {
    const confidenceValue = Math.round(confidence * 100);
    confidencePercent.textContent = confidenceValue + '%';
    confidenceFill.style.width = confidenceValue + '%';
    confidenceContainer.classList.remove('hidden');
}

function showErrorFeedback(data) {
    // Play error sound
    errorSound.play().catch(e => console.log('Audio play failed:', e));
    
    // Animate Bin-Bin
    binbinImg.src = 'assets/binbin_confused.png';
    binbinImg.style.transform = "scale(1.1) rotate(-10deg)";
    setTimeout(() => {
        binbinImg.style.transform = "scale(1) rotate(0deg)";
    }, 500);
    
    // Determine error message
    let message = '';
    
    if (data.reason === 'insufficient_features') {
        message = "I can't see the card clearly. Can you hold it still in the yellow box?";
    } else if (data.reason === 'low_confidence') {
        message = "Hmm, I'm not sure about this one. Try showing me a clearer card!";
    } else if (data.reason === 'connection_error') {
        message = "Oops! I lost connection. Is the server running?";
    } else {
        message = "I don't recognize that card. Make sure it's one of our eco-cards!";
    }
    
    resultText.textContent = message;
    
    // Speak feedback
    speak(message);
}

// ============================================
// SPEECH SYNTHESIS
// ============================================

function speak(text) {
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.9;
        utterance.pitch = 1.1;
        utterance.volume = 0.8;
        
        window.speechSynthesis.speak(utterance);
    }
}

// ============================================
// KEYBOARD SHORTCUTS
// ============================================

document.addEventListener('keydown', (e) => {
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

console.log('🌱 EcoLearn System Ready!');
console.log('📡 API URL:', API_URL);

// Check server connection
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

