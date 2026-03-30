from flask import Flask, request, jsonify, send_from_directory, Response
from flask_cors import CORS
from flask_compress import Compress
import cv2
import numpy as np
import mysql.connector
from mysql.connector import pooling
import pickle
import base64
from datetime import datetime
import hashlib
import os
import io
from gtts import gTTS

# --- CONFIGURATION ---
DB_CONFIG = {
    'host': 'localhost',
    'user': 'root',
    'password': '',
    'database': 'ecolearn_db'
}

# --- CONNECTION POOLING FOR FASTER DB ACCESS ---
# Pre-create connections to avoid connection overhead
try:
    db_pool = pooling.MySQLConnectionPool(
        pool_name="ecolearn_pool",
        pool_size=5,
        pool_reset_session=True,
        **DB_CONFIG
    )
    print("✅ Database connection pool created (5 connections)")
except Exception as e:
    print(f"⚠️ Connection pool failed, using direct connections: {e}")
    db_pool = None

# --- OPTIMIZED CONFIGURATION FOR BETTER ACCURACY ---
ORB_FEATURES = 1000      # Increased from 500 for more detailed feature detection
KNN_K = 2                # Standard for Lowe's Ratio Test
LOWE_RATIO = 0.65        # Stricter (was 0.70) - fewer false positives
MIN_MATCHES = 12         # Reduced from 15 for better sensitivity
CONFIDENCE_THRESHOLD = 0.60  # Minimum confidence to accept result
SESSION_TIMEOUT_MINUTES = 30
WEBCAM_FPS = 30
ROI_BOX_COLOR = '#00FF00'
ENABLE_AUDIO_FEEDBACK = True
MODEL_VERSION = 'ORB-KNN-v1.0'

# --- OPTIONAL CNN FALLBACK (for unavoidable blur) ---
CNN_MODEL_PATH = os.path.join(os.path.dirname(__file__), 'models', 'waste_mobilenet.onnx')
CNN_LABELS_PATH = os.path.join(os.path.dirname(__file__), 'models', 'waste_labels.txt')
CNN_INPUT_SIZE = (224, 224)
CNN_CONFIDENCE_THRESHOLD = 0.65
HYBRID_MARGIN = 0.10  # Minimum confidence gap to break ORB vs CNN disagreements

app = Flask(__name__)
CORS(app)

# --- GZIP COMPRESSION (70-90% smaller JSON responses) ---
Compress(app)
app.config['COMPRESS_MIMETYPES'] = ['text/html', 'text/css', 'text/javascript', 
                                     'application/json', 'application/javascript']
app.config['COMPRESS_LEVEL'] = 6  # Balance between speed and compression
app.config['COMPRESS_MIN_SIZE'] = 500  # Only compress responses > 500 bytes

# --- STATIC FILE CACHING (1 year for images) ---
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 31536000  # 1 year in seconds

# --- GLOBAL MEMORY ---
golden_dataset = []
card_metadata = {}
category_metadata = {}
current_session_id = None
current_session_mode = None
cnn_net = None
cnn_class_to_card_id = {}


def rebuild_orb_extractor():
    """Rebuild ORB extractor when dynamic feature settings change."""
    global orb
    orb = cv2.ORB_create(
        nfeatures=max(100, int(ORB_FEATURES)),
        scaleFactor=1.2,
        nlevels=8,
        edgeThreshold=15,
        firstLevel=0,
        WTA_K=2,
        scoreType=cv2.ORB_HARRIS_SCORE,
        patchSize=31,
        fastThreshold=20
    )


def _to_bool(value):
    return str(value).strip().lower() in ('1', 'true', 'yes', 'on')


def apply_config_value(config_key, config_value):
    """Apply one config key/value into runtime globals with safe casting."""
    global ORB_FEATURES, KNN_K, LOWE_RATIO, CONFIDENCE_THRESHOLD
    global SESSION_TIMEOUT_MINUTES, WEBCAM_FPS, ROI_BOX_COLOR, ENABLE_AUDIO_FEEDBACK, MODEL_VERSION

    if config_key == 'orb_feature_count':
        ORB_FEATURES = max(100, int(config_value))
        rebuild_orb_extractor()
    elif config_key == 'knn_k_value':
        # Lowe ratio test requires at least 2 neighbors.
        KNN_K = max(2, int(config_value))
    elif config_key == 'knn_distance_threshold':
        LOWE_RATIO = max(0.1, min(0.99, float(config_value)))
    elif config_key == 'min_confidence_score':
        CONFIDENCE_THRESHOLD = max(0.1, min(1.0, float(config_value)))
    elif config_key == 'session_timeout_minutes':
        SESSION_TIMEOUT_MINUTES = max(1, int(config_value))
    elif config_key == 'webcam_fps':
        WEBCAM_FPS = max(1, int(config_value))
    elif config_key == 'roi_box_color':
        ROI_BOX_COLOR = str(config_value)
    elif config_key == 'enable_audio_feedback':
        ENABLE_AUDIO_FEEDBACK = _to_bool(config_value)
    elif config_key == 'model_version':
        MODEL_VERSION = str(config_value)


def load_runtime_config_from_db():
    """Load dynamic settings from TBL_SYSTEM_CONFIG on startup."""
    try:
        conn = connect_db()
        cursor = conn.cursor(dictionary=True)
        cursor.execute("SELECT config_key, config_value FROM TBL_SYSTEM_CONFIG")
        rows = cursor.fetchall()

        for row in rows:
            try:
                apply_config_value(row['config_key'], row['config_value'])
            except Exception as cfg_err:
                print(f"⚠️ Skipping config '{row['config_key']}': {cfg_err}")

        cursor.close()
        conn.close()
        print("✅ Runtime config loaded from database")
    except Exception as e:
        print(f"⚠️ Runtime config load failed, using defaults: {e}")

def connect_db():
    """Get connection from pool for faster access"""
    if db_pool:
        try:
            return db_pool.get_connection()
        except Exception:
            pass
    return mysql.connector.connect(**DB_CONFIG)

def load_model():
    """Loads the database into RAM on startup (Warm Start)"""
    global golden_dataset, card_metadata, category_metadata
    
    print("🧠 Loading Universal Golden Dataset...")
    try:
        conn = connect_db()
        cursor = conn.cursor(dictionary=True)
        
        # Load Categories
        cursor.execute("SELECT category_id, category_name FROM TBL_CATEGORIES")
        for row in cursor.fetchall():
            category_metadata[row['category_id']] = row['category_name']
            
        # Load Card Names and metadata
        cursor.execute("SELECT card_id, card_name, category_id FROM TBL_CARD_ASSETS WHERE is_active = 1")
        for row in cursor.fetchall():
            card_metadata[row['card_id']] = {
                'name': row['card_name'],
                'category_id': row['category_id']
            }
            
        # Load Feature Vectors
        cursor.execute("SELECT card_id, feature_vector FROM TBL_GOLDEN_DATASET")
        rows = cursor.fetchall()
        
        golden_dataset = []
        for row in rows:
            features = pickle.loads(row['feature_vector'])
            golden_dataset.append({
                'card_id': row['card_id'],
                'features': features
            })
            
        print(f"✅ Model Loaded: {len(golden_dataset)} feature sets, {len(card_metadata)} unique cards")
        conn.close()
        return True
    except Exception as e:
        print(f"❌ Error loading model: {e}")
        return False


def load_cnn_model():
    """Loads optional ONNX CNN model and class mappings for hybrid fallback."""
    global cnn_net, cnn_class_to_card_id

    cnn_net = None
    cnn_class_to_card_id = {}

    if not os.path.exists(CNN_MODEL_PATH):
        print("ℹ️ CNN fallback disabled: model file not found")
        return False

    if not os.path.exists(CNN_LABELS_PATH):
        print("⚠️ CNN fallback disabled: labels file not found")
        return False

    try:
        net = cv2.dnn.readNetFromONNX(CNN_MODEL_PATH)
        class_map = {}

        with open(CNN_LABELS_PATH, 'r', encoding='utf-8') as f:
            for line in f:
                row = line.strip()
                if not row or row.startswith('#'):
                    continue

                # Format A: class_index,card_id
                # Format B: card_id (order becomes class index)
                parts = [p.strip() for p in row.split(',') if p.strip()]
                if len(parts) >= 2:
                    class_index = int(parts[0])
                    card_id = int(parts[1])
                else:
                    class_index = len(class_map)
                    card_id = int(parts[0])

                class_map[class_index] = card_id

        if not class_map:
            print("⚠️ CNN fallback disabled: empty labels mapping")
            return False

        cnn_net = net
        cnn_class_to_card_id = class_map
        print(f"✅ CNN fallback loaded: {len(cnn_class_to_card_id)} classes")
        return True
    except Exception as e:
        print(f"⚠️ CNN fallback disabled: {e}")
        cnn_net = None
        cnn_class_to_card_id = {}
        return False


def predict_waste_cnn(image_bgr):
    """Runs CNN fallback inference and returns ORB-compatible response shape."""
    if cnn_net is None or not cnn_class_to_card_id:
        return {"status": "unknown", "reason": "cnn_unavailable"}

    try:
        resized = cv2.resize(image_bgr, CNN_INPUT_SIZE)
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32)

        # Teachable Machine exports are commonly NHWC and can use different
        # normalization schemes depending on embedded preprocessing layers.
        # Try common variants and keep the highest-confidence prediction.
        input_variants = [
            np.expand_dims(rgb, axis=0),
            np.expand_dims(rgb / 255.0, axis=0),
            np.expand_dims((rgb / 127.5) - 1.0, axis=0),
        ]

        best_probs = None
        best_conf = -1.0
        for candidate in input_variants:
            try:
                cnn_net.setInput(candidate)
                raw = cnn_net.forward().flatten()
                if raw.size == 0:
                    continue

                raw = raw.astype(np.float64)

                # Teachable Machine exports may already output probabilities.
                raw_sum = float(np.sum(raw))
                if np.all(raw >= 0.0) and 0.98 <= raw_sum <= 1.02:
                    probs = raw / raw_sum
                else:
                    shifted = raw - np.max(raw)
                    exp_scores = np.exp(shifted)
                    denom = float(np.sum(exp_scores))
                    if denom <= 0.0:
                        continue
                    probs = exp_scores / denom

                conf = float(np.max(probs))

                if conf > best_conf:
                    best_conf = conf
                    best_probs = probs
            except Exception:
                continue

        if best_probs is None:
            return {"status": "unknown", "reason": "cnn_inference_failed"}

        probs = best_probs

        top_class = int(np.argmax(probs))
        confidence = float(probs[top_class])

        if confidence < CNN_CONFIDENCE_THRESHOLD:
            return {
                "status": "unknown",
                "reason": "cnn_low_confidence",
                "confidence": round(confidence, 2)
            }

        if top_class not in cnn_class_to_card_id:
            return {"status": "unknown", "reason": "cnn_unmapped_class"}

        card_id = cnn_class_to_card_id[top_class]
        card = card_metadata.get(card_id)
        if not card:
            return {"status": "unknown", "reason": "cnn_card_not_found"}

        category = category_metadata.get(card['category_id'])
        return {
            "status": "success",
            "card_id": card_id,
            "card_name": card['name'],
            "category": category,
            "category_id": card['category_id'],
            "matches": 0,
            "confidence": round(confidence, 2),
            "keypoints_detected": 0,
            "classifier": "cnn"
        }
    except Exception as e:
        return {"status": "unknown", "reason": f"cnn_error:{str(e)}"}

# --- BLUR DETECTION ---
def detect_blur(image_gray):
    """Returns Laplacian variance as plain Python float. Lower = blurrier."""
    return float(cv2.Laplacian(image_gray, cv2.CV_64F).var())

# --- FIXED PREPROCESSING PIPELINE ---
def preprocess_image(image_bgr, aggressive=False):
    """
    FIXED ORDER: Denoise → CLAHE → Sharpen (not sharpen-then-bilateral)
    aggressive=True uses stronger sharpening for blurry inputs
    """
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)

    # Step 1: Denoise FIRST (reduces noise before amplifying anything)
    denoised = cv2.fastNlMeansDenoising(gray, None, 10, 7, 21)

    # Step 2: CLAHE for contrast (works better on clean signal)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(denoised)

    # Step 3: Sharpen LAST (amplifies real edges, not noise)
    if aggressive:
        # Stronger unsharp mask for blurry images
        blurred = cv2.GaussianBlur(enhanced, (0, 0), 3)
        sharpened = cv2.addWeighted(enhanced, 2.5, blurred, -1.5, 0)
    else:
        kernel = np.array([[-1, -1, -1],
                           [-1,  9, -1],
                           [-1, -1, -1]])
        sharpened = cv2.filter2D(enhanced, -1, kernel)

    # Step 4: Bilateral to smooth noise introduced by sharpening
    result = cv2.bilateralFilter(sharpened, 9, 75, 75)
    return result

    """Advanced preprocessing pipeline for better feature detection"""
    
    # Convert to grayscale
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    
    # Apply adaptive histogram equalization for better contrast
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8,8))
    enhanced = clahe.apply(gray)
    
    # Denoise while preserving edges
    denoised = cv2.fastNlMeansDenoising(enhanced, None, 10, 7, 21)
    
    # Sharpen image to enhance features
    kernel = np.array([[-1,-1,-1],
                       [-1, 9,-1],
                       [-1,-1,-1]])
    sharpened = cv2.filter2D(denoised, -1, kernel)
    
    # Apply bilateral filter for edge preservation
    bilateral = cv2.bilateralFilter(sharpened, 9, 75, 75)
    
    return bilateral

def mask_white_background(image_bgr):
    """
    Blacks out large uniform white/near-white regions before ORB runs.
    This stops ORB from latching onto white paper/card backgrounds instead
    of the actual item drawn on the card.
    
    Works by: finding pixels above 200 brightness in all 3 channels,
    then eroding to keep only LARGE white blobs (actual background),
    not small white highlights that are part of the card art.
    """
    # Threshold: pixels where ALL channels > 200 are "white"
    white_mask = np.all(image_bgr > 200, axis=2).astype(np.uint8) * 255
    
    # Erode to remove small white areas (card art highlights are fine)
    # Only large connected white regions (paper background) get masked
    kernel = np.ones((40, 40), np.uint8)
    large_white = cv2.erode(white_mask, kernel, iterations=1)
    
    # Dilate back to recover the full region boundary
    large_white = cv2.dilate(large_white, np.ones((60, 60), np.uint8), iterations=1)
    
    # Black out those regions in the image
    result = image_bgr.copy()
    result[large_white > 0] = 0
    return result

# --- IMPROVED ORB-KNN ALGORITHM ---
orb = None
rebuild_orb_extractor()

bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)


def get_cnn_topk(image_bgr, top_k=3):
    """Returns top-k CNN card candidates as normalized scores in [0,1]."""
    if cnn_net is None or not cnn_class_to_card_id:
        return []

    try:
        resized = cv2.resize(image_bgr, CNN_INPUT_SIZE)
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32)

        input_variants = [
            np.expand_dims(rgb, axis=0),
            np.expand_dims(rgb / 255.0, axis=0),
            np.expand_dims((rgb / 127.5) - 1.0, axis=0),
        ]

        best_probs = None
        best_conf = -1.0
        for candidate in input_variants:
            try:
                cnn_net.setInput(candidate)
                raw = cnn_net.forward().flatten()
                if raw.size == 0:
                    continue

                raw = raw.astype(np.float64)

                raw_sum = float(np.sum(raw))
                if np.all(raw >= 0.0) and 0.98 <= raw_sum <= 1.02:
                    probs = raw / raw_sum
                else:
                    shifted = raw - np.max(raw)
                    exp_scores = np.exp(shifted)
                    denom = float(np.sum(exp_scores))
                    if denom <= 0.0:
                        continue
                    probs = exp_scores / denom

                conf = float(np.max(probs))

                if conf > best_conf:
                    best_conf = conf
                    best_probs = probs
            except Exception:
                continue

        if best_probs is None:
            return []

        probs = best_probs

        top_indices = np.argsort(probs)[::-1][:top_k]
        candidates = []
        for idx in top_indices:
            class_index = int(idx)
            card_id = cnn_class_to_card_id.get(class_index)
            if card_id is None:
                continue
            candidates.append({
                'card_id': card_id,
                'score': float(probs[class_index])
            })
        return candidates
    except Exception:
        return []


def get_orb_topk(image_bgr, top_k=3):
    """Returns top-k ORB card candidates as normalized scores in [0,1]."""
    if not golden_dataset:
        return []

    gray_raw = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    blur_score = float(cv2.Laplacian(gray_raw, cv2.CV_64F).var())
    is_blurry = blur_score < 100
    lowe_ratio = 0.75 if is_blurry else LOWE_RATIO

    masked = mask_white_background(image_bgr)
    preprocessed = preprocess_image(masked, aggressive=is_blurry)
    kp, des = orb.detectAndCompute(preprocessed, None)
    if des is None or len(kp) < 8:
        return []

    votes = {}
    for data in golden_dataset:
        card_id = data['card_id']
        train_des = data['features']
        if train_des is None or len(train_des) < 2:
            continue
        try:
            k_neighbors = max(2, int(KNN_K))
            matches = bf.knnMatch(des, train_des, k=k_neighbors)
            good = 0
            for pair in matches:
                if len(pair) < 2:
                    continue
                m, n = pair[0], pair[1]
                if m.distance < lowe_ratio * n.distance:
                    good += 1
            votes[card_id] = votes.get(card_id, 0) + good
        except Exception:
            continue

    if not votes:
        return []

    sorted_votes = sorted(votes.items(), key=lambda x: x[1], reverse=True)[:top_k]
    max_vote = max(v for _, v in sorted_votes) if sorted_votes else 1
    return [
        {
            'card_id': card_id,
            'score': float(vote_count / max_vote) if max_vote > 0 else 0.0,
            'matches': int(vote_count)
        }
        for card_id, vote_count in sorted_votes
    ]


def predict_waste_top3(image_bgr, top_k=3):
    """Hybrid top-k ranking using ORB and CNN confidence fusion."""
    gray_raw = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    blur_score = float(cv2.Laplacian(gray_raw, cv2.CV_64F).var())
    is_blurry = blur_score < 100

    orb_candidates = get_orb_topk(image_bgr, top_k=top_k)
    cnn_candidates = get_cnn_topk(image_bgr, top_k=top_k)

    # Weight CNN higher when blurry; ORB higher when not blurry.
    orb_weight = 0.35 if is_blurry else 0.55
    cnn_weight = 0.65 if is_blurry else 0.45

    merged = {}

    for c in orb_candidates:
        card_id = c['card_id']
        merged[card_id] = merged.get(card_id, {
            'card_id': card_id,
            'orb_score': 0.0,
            'cnn_score': 0.0,
            'matches': 0
        })
        merged[card_id]['orb_score'] = float(c['score'])
        merged[card_id]['matches'] = int(c.get('matches', 0))

    for c in cnn_candidates:
        card_id = c['card_id']
        merged[card_id] = merged.get(card_id, {
            'card_id': card_id,
            'orb_score': 0.0,
            'cnn_score': 0.0,
            'matches': 0
        })
        merged[card_id]['cnn_score'] = float(c['score'])

    ranked = []
    for card_id, entry in merged.items():
        card = card_metadata.get(card_id)
        if not card:
            continue
        hybrid_score = entry['orb_score'] * orb_weight + entry['cnn_score'] * cnn_weight
        ranked.append({
            'card_id': card_id,
            'card_name': card['name'],
            'category_id': card['category_id'],
            'category': category_metadata.get(card['category_id']),
            'hybrid_score': round(float(hybrid_score), 4),
            'orb_score': round(float(entry['orb_score']), 4),
            'cnn_score': round(float(entry['cnn_score']), 4),
            'matches': int(entry['matches'])
        })

    ranked.sort(key=lambda x: x['hybrid_score'], reverse=True)
    return {
        'status': 'success' if ranked else 'unknown',
        'blur_score': round(float(blur_score), 1),
        'is_blurry': bool(is_blurry),
        'top_candidates': ranked[:top_k],
        'fusion_weights': {
            'orb': orb_weight,
            'cnn': cnn_weight
        }
    }

def predict_waste(image_bgr):
    """
    Enhanced ORB-KNN with blur detection, adaptive preprocessing, and multi-scale retry.
    """
    if not golden_dataset:
        return {"status": "error", "message": "Model not loaded"}

    start_time = datetime.now()

    # --- Blur detection ---
    gray_raw = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    blur_score = detect_blur(gray_raw)
    # FIXED — cast both to plain Python types
    blur_score = float(cv2.Laplacian(gray_raw, cv2.CV_64F).var())
    is_blurry = bool(blur_score < 100)

    # --- Adaptive thresholds ---
    min_matches = 8 if is_blurry else MIN_MATCHES          # Relax for blur
    confidence_threshold = 0.45 if is_blurry else CONFIDENCE_THRESHOLD
    lowe_ratio = 0.75 if is_blurry else LOWE_RATIO         # More permissive matching

    # --- Try multiple preprocessing strengths ---
    scales_to_try = [1.0, 1.5, 0.75] if is_blurry else [1.0]
    preprocess_modes = [True, False] if is_blurry else [False]  # aggressive first if blurry

    best_result = None
    best_match_count = 0
    orb_success_result = None

    for aggressive in preprocess_modes:
        masked_image = mask_white_background(image_bgr)
        preprocessed = preprocess_image(masked_image, aggressive=aggressive)

        for scale in scales_to_try:
            if scale != 1.0:
                h, w = preprocessed.shape[:2]
                scaled = cv2.resize(preprocessed, (int(w * scale), int(h * scale)))
            else:
                scaled = preprocessed

            kp, des = orb.detectAndCompute(scaled, None)

            if des is None or len(kp) < 8:
                continue

            votes = {}
            for data in golden_dataset:
                card_id = data['card_id']
                train_des = data['features']
                if train_des is None or len(train_des) < 2:
                    continue
                try:
                    k_neighbors = max(2, int(KNN_K))
                    matches = bf.knnMatch(des, train_des, k=k_neighbors)
                    good_matches = []
                    for pair in matches:
                        if len(pair) >= 2:
                            m, n = pair[0], pair[1]
                            if m.distance < lowe_ratio * n.distance:
                                good_matches.append(m)
                    if card_id not in votes:
                        votes[card_id] = 0
                    votes[card_id] += len(good_matches)
                except Exception:
                    continue

            if not votes:
                continue

            candidate_id = max(votes, key=votes.get)
            candidate_count = votes[candidate_id]

            if candidate_count > best_match_count:
                best_match_count = candidate_count
                confidence = min(candidate_count / (min_matches * 3), 1.0)
                best_result = (candidate_id, confidence, len(kp))

            # Early exit if confident enough
            if best_match_count >= min_matches * 2:
                break

        if best_match_count >= min_matches * 2:
            break

    response_time = (datetime.now() - start_time).total_seconds() * 1000

    if best_result is None or best_match_count < min_matches:
        orb_unknown = {
            "status": "unknown",
            "reason": "insufficient_features",
            "blur_score": round(blur_score, 1),
            "is_blurry": is_blurry,
            "matches": best_match_count,
            "classifier": "orb"
        }
        if is_blurry and cnn_net is not None:
            cnn_result = predict_waste_cnn(image_bgr)
            if cnn_result.get('status') == 'success':
                cnn_result['response_time'] = round(response_time, 2)
                cnn_result['blur_score'] = round(blur_score, 1)
                cnn_result['is_blurry'] = is_blurry
                cnn_result['classifier'] = 'cnn_fallback'
                return cnn_result
        return orb_unknown

    best_card_id, confidence, kp_count = best_result

    if confidence >= confidence_threshold:
        card = card_metadata.get(best_card_id)
        if card:
            category = category_metadata.get(card['category_id'])
            orb_success_result = {
                "status": "success",
                "card_id": best_card_id,
                "card_name": card['name'],
                "category": category,
                "category_id": card['category_id'],
                "matches": best_match_count,
                "confidence": round(confidence, 2),
                "response_time": round(response_time, 2),
                "keypoints_detected": kp_count,
                "blur_score": round(blur_score, 1),
                "is_blurry": is_blurry,
                "classifier": "orb"
            }

    # If image is blurry (or ORB confidence is low), give CNN a chance.
    if (is_blurry or orb_success_result is None) and cnn_net is not None:
        cnn_result = predict_waste_cnn(image_bgr)
        if cnn_result.get('status') == 'success':
            cnn_result['response_time'] = round(response_time, 2)
            cnn_result['blur_score'] = round(blur_score, 1)
            cnn_result['is_blurry'] = is_blurry

            if orb_success_result is None:
                cnn_result['classifier'] = 'cnn_fallback'
                return cnn_result

            if orb_success_result['card_id'] == cnn_result['card_id']:
                merged_conf = round((orb_success_result['confidence'] + cnn_result['confidence']) / 2.0, 2)
                orb_success_result['confidence'] = merged_conf
                orb_success_result['classifier'] = 'hybrid_consensus'
                return orb_success_result

            if cnn_result['confidence'] >= orb_success_result['confidence'] + HYBRID_MARGIN:
                cnn_result['classifier'] = 'hybrid_cnn_override'
                return cnn_result

            if orb_success_result['confidence'] >= cnn_result['confidence'] + HYBRID_MARGIN:
                orb_success_result['classifier'] = 'hybrid_orb_override'
                return orb_success_result

            return {
                "status": "unknown",
                "reason": "hybrid_conflict",
                "blur_score": round(blur_score, 1),
                "is_blurry": is_blurry,
                "orb_card_id": orb_success_result['card_id'],
                "orb_confidence": orb_success_result['confidence'],
                "cnn_card_id": cnn_result['card_id'],
                "cnn_confidence": cnn_result['confidence'],
                "classifier": "hybrid"
            }

    if orb_success_result is not None:
        return orb_success_result

    return {
        "status": "unknown",
        "matches": best_match_count,
        "confidence": round(confidence, 2),
        "blur_score": round(blur_score, 1),
        "is_blurry": is_blurry,
        "reason": "low_confidence",
        "classifier": "orb"
    }

# --- API ROUTES ---
@app.route('/classify', methods=['POST'])
def classify():
    """Main classification endpoint (CNN-only mode)."""
    try:
        start_time = datetime.now()
        file = request.files['image']
        npimg = np.fromfile(file, np.uint8)
        img = cv2.imdecode(npimg, cv2.IMREAD_COLOR)
        
        if img is None:
            return jsonify({"status": "error", "message": "Invalid image"})
        
        result = predict_waste_cnn(img)

        response_time = (datetime.now() - start_time).total_seconds() * 1000
        result['response_time'] = round(response_time, 2)
        result['classifier'] = 'cnn_only'
        
        # Don't auto-log in assessment mode - wait for user choice
        if current_session_id and result['status'] == 'success':
            # Auto-log for instructional mode only
            # Assessment mode will call /assessment/submit separately
            if current_session_mode == 'instructional':
                log_scan_transaction(result)
        
        return jsonify(result)
        
    except Exception as e:
        print(f"❌ Classification error: {e}")
        return jsonify({"status": "error", "message": str(e)})


@app.route('/classify/top3', methods=['POST'])
def classify_top3():
    """Returns top-3 CNN-only candidates."""
    try:
        file = request.files['image']
        npimg = np.fromfile(file, np.uint8)
        img = cv2.imdecode(npimg, cv2.IMREAD_COLOR)

        if img is None:
            return jsonify({"status": "error", "message": "Invalid image"})

        candidates = get_cnn_topk(img, top_k=3)
        ranked = []
        for c in candidates:
            card = card_metadata.get(c['card_id'])
            if not card:
                continue
            ranked.append({
                'card_id': c['card_id'],
                'card_name': card['name'],
                'category_id': card['category_id'],
                'category': category_metadata.get(card['category_id']),
                'cnn_score': round(float(c['score']), 4)
            })

        result = {
            'status': 'success' if ranked else 'unknown',
            'classifier': 'cnn_only',
            'top_candidates': ranked
        }
        return jsonify(result)
    except Exception as e:
        print(f"❌ Top3 classification error: {e}")
        return jsonify({"status": "error", "message": str(e)})

@app.route('/assessment/submit', methods=['POST'])
def submit_assessment():
    """Submit assessment answer for scoring"""
    global current_session_id
    
    if not current_session_id:
        return jsonify({"status": "error", "message": "No active session"})
    
    try:
        data = request.json
        selected_category = data.get('selected_category')
        correct_category = data.get('correct_category')
        card_id = data.get('card_id')
        confidence = data.get('confidence', 0.0)
        
        is_correct = selected_category == correct_category
        
        conn = connect_db()
        cursor = conn.cursor()
        
        # Log the assessment transaction
        sql = """INSERT INTO TBL_SCAN_TRANSACTIONS 
                (session_id, card_id, predicted_category_id, actual_category_id, 
                confidence_score, response_time, scan_timestamp)
                VALUES (%s, %s, 
                    (SELECT category_id FROM TBL_CATEGORIES WHERE category_name = %s),
                    (SELECT category_id FROM TBL_CATEGORIES WHERE category_name = %s),
                    %s, 0, NOW())"""
        
        cursor.execute(sql, (
            current_session_id,
            card_id,
            selected_category,
            correct_category,
            confidence
        ))
        
        # Update session stats  
        update_sql = """UPDATE TBL_SESSIONS 
                       SET total_scans = total_scans + 1,
                           correct_scans = correct_scans + %s
                       WHERE session_id = %s"""
        
        cursor.execute(update_sql, (1 if is_correct else 0, current_session_id))
        
        conn.commit()
        cursor.close()
        conn.close()
        
        return jsonify({
            "status": "success",
            "is_correct": is_correct,
            "correct_category": correct_category
        })
        
    except Exception as e:
        print(f"❌ Assessment submit error: {e}")
        return jsonify({"status": "error", "message": str(e)})

@app.route('/session/start', methods=['POST'])
def start_session():
    """Start a new student session"""
    global current_session_id, current_session_mode
    
    try:
        data = request.json
        nickname = data.get('nickname', 'Guest')
        mode = data.get('mode', 'instructional')
        
        conn = connect_db()
        cursor = conn.cursor()
        
        sql = """INSERT INTO TBL_SESSIONS 
                (student_nickname, session_mode, start_time, session_status) 
                VALUES (%s, %s, NOW(), 'active')"""
        
        cursor.execute(sql, (nickname, mode))
        conn.commit()
        
        current_session_id = cursor.lastrowid
        current_session_mode = mode
        
        cursor.close()
        conn.close()
        
        return jsonify({
            "status": "success",
            "session_id": current_session_id,
            "nickname": nickname
        })
        
    except Exception as e:
        print(f"❌ Session start error: {e}")
        return jsonify({"status": "error", "message": str(e)})

@app.route('/session/end', methods=['POST'])
def end_session():
    """End current session"""
    global current_session_id, current_session_mode
    
    if not current_session_id:
        return jsonify({"status": "error", "message": "No active session"})
    
    try:
        conn = connect_db()
        cursor = conn.cursor()
        
        # Update session
        sql = """UPDATE TBL_SESSIONS 
                SET end_time = NOW(), session_status = 'completed'
                WHERE session_id = %s"""
        
        cursor.execute(sql, (current_session_id,))
        conn.commit()
        
        # Get session stats
        cursor.execute("""
            SELECT total_scans, correct_scans, accuracy_percentage 
            FROM TBL_SESSIONS WHERE session_id = %s
        """, (current_session_id,))
        
        stats = cursor.fetchone()
        
        cursor.close()
        conn.close()
        
        session_id = current_session_id
        current_session_id = None
        current_session_mode = None
        
        return jsonify({
            "status": "success",
            "session_id": session_id,
            "stats": {
                "total_scans": stats[0] if stats else 0,
                "correct_scans": stats[1] if stats else 0,
                "accuracy": stats[2] if stats else 0
            }
        })
        
    except Exception as e:
        print(f"❌ Session end error: {e}")
        return jsonify({"status": "error", "message": str(e)})

def log_scan_transaction(result):
    """Log scan to database"""
    try:
        conn = connect_db()
        cursor = conn.cursor()
        
        sql = """INSERT INTO TBL_SCAN_TRANSACTIONS 
                (session_id, card_id, predicted_category_id, actual_category_id, 
                confidence_score, response_time, scan_timestamp)
                VALUES (%s, %s, %s, %s, %s, %s, NOW())"""
        
        cursor.execute(sql, (
            current_session_id,
            result['card_id'],
            result['category_id'],
            result['category_id'],  # Assuming correct for now
            result['confidence'],
            result['response_time']
        ))
        
        # Update session stats
        cursor.execute("""
            UPDATE TBL_SESSIONS 
            SET total_scans = total_scans + 1,
                correct_scans = correct_scans + 1
            WHERE session_id = %s
        """, (current_session_id,))
        
        conn.commit()
        cursor.close()
        conn.close()
        
    except Exception as e:
        print(f"⚠️ Logging error: {e}")

@app.route('/admin/stats', methods=['GET'])
def get_admin_stats():
    """Returns analytics for Admin Dashboard"""
    try:
        conn = connect_db()
        cursor = conn.cursor(dictionary=True)
        
        # Total scans
        cursor.execute("SELECT COUNT(*) as count FROM TBL_SCAN_TRANSACTIONS")
        total_scans = cursor.fetchone()['count']
        
        # Calculate accuracy
        cursor.execute("""
            SELECT 
                SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) as correct,
                COUNT(*) as total
            FROM TBL_SCAN_TRANSACTIONS
        """)
        result = cursor.fetchone()
        accuracy = round((result['correct'] / result['total'] * 100), 1) if result['total'] > 0 else 0
        
        # Total sessions
        cursor.execute("SELECT COUNT(*) as count FROM TBL_SESSIONS WHERE session_status = 'completed'")
        total_sessions = cursor.fetchone()['count']
        
        # Recent logs with nickname
        cursor.execute("""
            SELECT 
                t.transaction_id, 
                t.scan_timestamp, 
                c.card_name, 
                cat.category_name, 
                t.confidence_score,
                t.is_correct,
                s.student_nickname,
                c.image_path
            FROM TBL_SCAN_TRANSACTIONS t
            JOIN TBL_CARD_ASSETS c ON t.card_id = c.card_id
            JOIN TBL_CATEGORIES cat ON c.category_id = cat.category_id
            LEFT JOIN TBL_SESSIONS s ON t.session_id = s.session_id
            ORDER BY t.scan_timestamp DESC 
            LIMIT 15
        """)
        logs = cursor.fetchall()
        
        formatted_logs = []
        for log in logs:
            formatted_logs.append({
                "id": log['transaction_id'],
                "time": log['scan_timestamp'].strftime("%H:%M:%S"),
                "card": log['card_name'],
                "category": log['category_name'],
                "confidence": int(log['confidence_score'] * 100),
                "correct": bool(log['is_correct']),
                "nickname": log['student_nickname'] or 'Guest',
                "image_path": log['image_path'] or ''
            })
        
        cursor.close()
        conn.close()
        
        return jsonify({
            "total_scans": total_scans,
            "accuracy": accuracy,
            "total_sessions": total_sessions,
            "recent_logs": formatted_logs
        })
        
    except Exception as e:
        print(f"❌ Admin stats error: {e}")
        return jsonify({"status": "error", "message": str(e)})

@app.route('/admin/nicknames', methods=['GET'])
def get_admin_nicknames():
    """Get list of unique nicknames with stats for admin management"""
    try:
        conn = connect_db()
        cursor = conn.cursor(dictionary=True)
        
        # Get nicknames with session stats
        cursor.execute("""
            SELECT 
                student_nickname as nickname,
                COUNT(CASE WHEN session_status = 'completed' THEN 1 END) as sessions,
                ROUND(AVG(CASE WHEN session_status = 'completed' THEN accuracy_percentage END), 0) as accuracy,
                MAX(CASE WHEN session_status = 'completed' THEN start_time END) as last_active,
                MIN(start_time) as created_at
            FROM TBL_SESSIONS 
            WHERE student_nickname IS NOT NULL 
            AND student_nickname != '' 
            AND student_nickname != 'Guest'
            GROUP BY student_nickname
            ORDER BY student_nickname ASC
        """)
        
        nicknames = cursor.fetchall()
        
        # Convert to proper format
        nickname_list = []
        for nick in nicknames:
            nickname_list.append({
                'nickname': nick['nickname'],
                'sessions': nick['sessions'] or 0,
                'accuracy': int(nick['accuracy']) if nick['accuracy'] else None,
                'last_active': nick['last_active'].isoformat() if nick['last_active'] else None,
                'created_at': nick['created_at'].isoformat() if nick['created_at'] else None
            })
        
        cursor.close()
        conn.close()
        
        return jsonify({
            "status": "success",
            "nicknames": nickname_list
        })
        
    except Exception as e:
        print(f"❌ Admin nicknames error: {e}")
        return jsonify({"status": "error", "message": str(e)})

@app.route('/admin/nicknames', methods=['POST'])
def add_admin_nickname():
    """Add a new nickname to the pre-fill list"""
    try:
        data = request.json
        nickname = data.get('nickname', '').strip()
        
        if not nickname or len(nickname) < 2:
            return jsonify({"status": "error", "message": "Nickname must be at least 2 characters"})
        
        conn = connect_db()
        cursor = conn.cursor()
        
        # Create a preset entry - session_mode is NULL since student will choose when playing
        sql = """INSERT INTO TBL_SESSIONS 
                (student_nickname, session_mode, start_time, session_status) 
                VALUES (%s, NULL, NOW(), 'admin_preset')"""
        
        cursor.execute(sql, (nickname,))
        conn.commit()
        
        cursor.close()
        conn.close()
        
        return jsonify({
            "status": "success",
            "message": "Nickname added successfully"
        })
        
    except Exception as e:
        print(f"❌ Admin add nickname error: {e}")
        return jsonify({"status": "error", "message": str(e)})

@app.route('/admin/nicknames/<nickname>', methods=['DELETE'])
def delete_admin_nickname(nickname):
    """Delete ALL sessions for a nickname (removes student completely)"""
    try:
        if not nickname or len(nickname) < 2:
            return jsonify({"status": "error", "message": "Invalid nickname"})
        
        conn = connect_db()
        cursor = conn.cursor()
        
        # First delete all scan transactions for this student's sessions
        cursor.execute("""
            DELETE st FROM TBL_SCAN_TRANSACTIONS st
            INNER JOIN TBL_SESSIONS s ON st.session_id = s.session_id
            WHERE s.student_nickname = %s
        """, (nickname,))
        
        # Then delete all sessions for this nickname
        cursor.execute("""
            DELETE FROM TBL_SESSIONS 
            WHERE student_nickname = %s
        """, (nickname,))
        
        deleted_count = cursor.rowcount
        conn.commit()
        
        cursor.close()
        conn.close()
        
        if deleted_count > 0:
            return jsonify({
                "status": "success",
                "message": f"Student '{nickname}' and all their data removed successfully"
            })
        else:
            return jsonify({
                "status": "error",
                "message": f"Student '{nickname}' not found"
            })
        
    except Exception as e:
        print(f"❌ Admin delete nickname error: {e}")
        return jsonify({"status": "error", "message": str(e)})

@app.route('/health', methods=['GET'])
def health_check():
    """System health check"""
    return jsonify({
        "status": "healthy",
        "model_version": MODEL_VERSION,
        "model_loaded": len(golden_dataset) > 0,
        "cnn_loaded": cnn_net is not None,
        "cnn_classes": len(cnn_class_to_card_id),
        "cards_loaded": len(card_metadata),
        "categories": len(category_metadata),
        "active_session": current_session_id is not None,
        "runtime_config": {
            "orb_feature_count": ORB_FEATURES,
            "knn_k_value": KNN_K,
            "knn_distance_threshold": LOWE_RATIO,
            "min_confidence_score": CONFIDENCE_THRESHOLD,
            "session_timeout_minutes": SESSION_TIMEOUT_MINUTES,
            "webcam_fps": WEBCAM_FPS,
            "roi_box_color": ROI_BOX_COLOR,
            "enable_audio_feedback": ENABLE_AUDIO_FEEDBACK
        }
    })

# ============================================================
# ADVANCED ADMIN FEATURES (From Thesis Proposal)
# ============================================================

@app.route('/admin/confusion-matrix', methods=['GET'])
def get_confusion_matrix():
    """
    Confusion Matrix - Visualizes algorithm performance by comparing
    Actual Class against Predicted Class to identify error patterns
    (As defined in Definition of Terms - Technical Terms)
    """
    try:
        conn = connect_db()
        cursor = conn.cursor(dictionary=True)
        
        # Get confusion matrix data
        cursor.execute("""
            SELECT 
                actual_cat.category_name as actual_category,
                pred_cat.category_name as predicted_category,
                COUNT(*) as count
            FROM TBL_SCAN_TRANSACTIONS t
            JOIN TBL_CATEGORIES actual_cat ON t.actual_category_id = actual_cat.category_id
            JOIN TBL_CATEGORIES pred_cat ON t.predicted_category_id = pred_cat.category_id
            GROUP BY t.actual_category_id, t.predicted_category_id
            ORDER BY actual_cat.display_order, pred_cat.display_order
        """)
        matrix_data = cursor.fetchall()
        
        # Get all categories for matrix structure
        cursor.execute("SELECT category_name FROM TBL_CATEGORIES WHERE is_active = 1 ORDER BY display_order")
        categories = [row['category_name'] for row in cursor.fetchall()]
        
        # Build matrix structure
        matrix = {}
        for cat in categories:
            matrix[cat] = {c: 0 for c in categories}
        
        for row in matrix_data:
            if row['actual_category'] in matrix and row['predicted_category'] in matrix[row['actual_category']]:
                matrix[row['actual_category']][row['predicted_category']] = row['count']
        
        # Calculate per-category accuracy
        category_stats = []
        for cat in categories:
            total = sum(matrix[cat].values())
            correct = matrix[cat][cat]
            accuracy = round((correct / total * 100), 1) if total > 0 else 0
            category_stats.append({
                "category": cat,
                "total": total,
                "correct": correct,
                "accuracy": accuracy
            })
        
        cursor.close()
        conn.close()
        
        return jsonify({
            "status": "success",
            "categories": categories,
            "matrix": matrix,
            "category_stats": category_stats
        })
        
    except Exception as e:
        print(f"❌ Confusion matrix error: {e}")
        return jsonify({"status": "error", "message": str(e)})

@app.route('/admin/config', methods=['GET'])
def get_system_config():
    """
    Get current system configuration from TBL_SYSTEM_CONFIG
    Allows administrators to view ORB-KNN parameters
    """
    try:
        conn = connect_db()
        cursor = conn.cursor(dictionary=True)
        
        cursor.execute("""
            SELECT config_key, config_value, value_type, description, is_editable
            FROM TBL_SYSTEM_CONFIG
            ORDER BY config_key
        """)
        configs = cursor.fetchall()
        
        cursor.close()
        conn.close()
        
        return jsonify({
            "status": "success",
            "config": configs
        })
        
    except Exception as e:
        print(f"❌ Config get error: {e}")
        return jsonify({"status": "error", "message": str(e)})

@app.route('/admin/config', methods=['POST'])
def update_system_config():
    """
    Update system configuration - allows tuning ORB-KNN parameters
    without modifying source code (as per TBL_SYSTEM_CONFIG design)
    """
    global ORB_FEATURES, KNN_K, LOWE_RATIO, MIN_MATCHES, CONFIDENCE_THRESHOLD
    
    try:
        data = request.json
        config_key = data.get('config_key')
        config_value = data.get('config_value')
        
        conn = connect_db()
        cursor = conn.cursor(dictionary=True)
        
        # Check if config is editable
        cursor.execute("SELECT is_editable FROM TBL_SYSTEM_CONFIG WHERE config_key = %s", (config_key,))
        result = cursor.fetchone()
        
        if not result:
            return jsonify({"status": "error", "message": "Configuration key not found"})
        
        if not result['is_editable']:
            return jsonify({"status": "error", "message": "This configuration is locked and cannot be modified"})
        
        # Update the config
        cursor.execute("""
            UPDATE TBL_SYSTEM_CONFIG 
            SET config_value = %s, last_modified = NOW()
            WHERE config_key = %s
        """, (config_value, config_key))
        
        conn.commit()
        
        # Apply changes to runtime variables
        apply_config_value(config_key, config_value)
        
        cursor.close()
        conn.close()
        
        return jsonify({
            "status": "success",
            "message": f"Configuration '{config_key}' updated to '{config_value}'"
        })
        
    except Exception as e:
        print(f"❌ Config update error: {e}")
        return jsonify({"status": "error", "message": str(e)})

@app.route('/admin/asset-repository', methods=['GET'])
def get_asset_repository():
    """
    Asset Repository - Lists all Standardized Printable Eco-Cards
    As defined: "A built-in system module that stores high-resolution 
    digital templates of the Eco-Cards for PDF generation"
    """
    try:
        conn = connect_db()
        cursor = conn.cursor(dictionary=True)
        
        cursor.execute("""
            SELECT 
                c.card_id,
                c.card_name,
                c.card_code,
                c.image_filename,
                c.image_path,
                c.description,
                c.pdf_generated,
                c.is_active,
                cat.category_name,
                cat.bin_color
            FROM TBL_CARD_ASSETS c
            JOIN TBL_CATEGORIES cat ON c.category_id = cat.category_id
            WHERE c.is_active = 1
            ORDER BY cat.display_order, c.card_name
        """)
        cards = cursor.fetchall()
        
        # Group by category
        by_category = {}
        for card in cards:
            cat_name = card['category_name']
            if cat_name not in by_category:
                by_category[cat_name] = {
                    "bin_color": card['bin_color'],
                    "cards": []
                }
            by_category[cat_name]["cards"].append({
                "card_id": card['card_id'],
                "card_name": card['card_name'],
                "card_code": card['card_code'],
                "image_path": card['image_path'],
                "pdf_generated": bool(card['pdf_generated'])
            })
        
        cursor.close()
        conn.close()
        
        return jsonify({
            "status": "success",
            "total_cards": len(cards),
            "categories": by_category
        })
        
    except Exception as e:
        print(f"❌ Asset repository error: {e}")
        return jsonify({"status": "error", "message": str(e)})

# ============================================
# PERFORMANCE-OPTIMIZED ENDPOINTS
# For Low-Mid End Laptop (Sub-second response)
# ============================================

@app.route('/admin/asset-counts', methods=['GET'])
def get_asset_counts_fast():
    """
    FAST ENDPOINT - Returns only card counts per category
    Lightweight response for quick UI updates
    """
    try:
        conn = connect_db()
        cursor = conn.cursor(dictionary=True)
        
        cursor.execute("""
            SELECT 
                cat.category_name,
                COUNT(c.card_id) as count
            FROM TBL_CATEGORIES cat
            LEFT JOIN TBL_CARD_ASSETS c ON cat.category_id = c.category_id AND c.is_active = 1
            WHERE cat.is_active = 1
            GROUP BY cat.category_id, cat.category_name
            ORDER BY cat.display_order
        """)
        counts = cursor.fetchall()
        
        total = sum(c['count'] for c in counts)
        
        cursor.close()
        conn.close()
        
        response = jsonify({
            "status": "success",
            "total_cards": total,
            "counts": {c['category_name']: c['count'] for c in counts}
        })
        
        # Add cache headers for browser caching
        response.headers['Cache-Control'] = 'public, max-age=10'
        return response
        
    except Exception as e:
        print(f"❌ Fast counts error: {e}")
        return jsonify({"status": "error", "message": str(e)})

@app.route('/admin/cards-minimal', methods=['GET'])
def get_cards_minimal():
    """
    FAST ENDPOINT - Returns minimal card data for gallery
    Only essential fields: id, name, category, image_path
    """
    try:
        conn = connect_db()
        cursor = conn.cursor(dictionary=True)
        
        cursor.execute("""
            SELECT 
                c.card_id,
                c.card_name,
                c.image_path,
                cat.category_name,
                cat.bin_color
            FROM TBL_CARD_ASSETS c
            JOIN TBL_CATEGORIES cat ON c.category_id = cat.category_id
            WHERE c.is_active = 1
            ORDER BY cat.display_order, c.card_name
        """)
        cards = cursor.fetchall()
        
        cursor.close()
        conn.close()
        
        response = jsonify({
            "status": "success",
            "cards": cards
        })
        
        # Add cache headers
        response.headers['Cache-Control'] = 'public, max-age=10'
        return response
        
    except Exception as e:
        print(f"❌ Minimal cards error: {e}")
        return jsonify({"status": "error", "message": str(e)})

@app.route('/admin/generate-pdf/<int:card_id>', methods=['GET'])
def generate_card_pdf(card_id):
    """
    PDF Generation for individual Eco-Card (4x5 inch, 300 DPI)
    Returns the card image path for printing
    """
    try:
        conn = connect_db()
        cursor = conn.cursor(dictionary=True)
        
        cursor.execute("""
            SELECT 
                c.card_id, c.card_name, c.card_code, c.image_path,
                cat.category_name, cat.bin_color
            FROM TBL_CARD_ASSETS c
            JOIN TBL_CATEGORIES cat ON c.category_id = cat.category_id
            WHERE c.card_id = %s
        """, (card_id,))
        
        card = cursor.fetchone()
        
        if not card:
            return jsonify({"status": "error", "message": "Card not found"})
        
        # Mark as PDF generated
        cursor.execute("UPDATE TBL_CARD_ASSETS SET pdf_generated = 1 WHERE card_id = %s", (card_id,))
        conn.commit()
        
        cursor.close()
        conn.close()
        
        return jsonify({
            "status": "success",
            "card": {
                "card_id": card['card_id'],
                "card_name": card['card_name'],
                "card_code": card['card_code'],
                "image_path": card['image_path'],
                "category": card['category_name'],
                "bin_color": card['bin_color'],
                "print_size": "4x5 inches",
                "dpi": 300
            }
        })
        
    except Exception as e:
        print(f"❌ PDF generation error: {e}")
        return jsonify({"status": "error", "message": str(e)})

@app.route('/admin/student-proficiency', methods=['GET'])
def get_student_proficiency():
    """
    Comparative Performance Dashboard - Ranks student proficiency
    based on assessment scores using pseudonyms (nicknames)
    """
    try:
        conn = connect_db()
        cursor = conn.cursor(dictionary=True)
        
        cursor.execute("""
            SELECT 
                student_nickname,
                COUNT(*) as total_sessions,
                SUM(total_scans) as total_scans,
                SUM(correct_scans) as total_correct,
                ROUND(AVG(accuracy_percentage), 1) as avg_accuracy,
                MAX(accuracy_percentage) as best_accuracy,
                MAX(end_time) as last_session
            FROM TBL_SESSIONS
            WHERE session_status = 'completed'
            AND student_nickname != 'Guest'
            AND session_mode = 'assessment'
            GROUP BY student_nickname
            ORDER BY avg_accuracy DESC, total_scans DESC
        """)
        
        students = cursor.fetchall()
        
        # Add rank
        leaderboard = []
        for idx, student in enumerate(students, 1):
            leaderboard.append({
                "rank": idx,
                "nickname": student['student_nickname'],
                "sessions": student['total_sessions'],
                "total_scans": student['total_scans'] or 0,
                "correct": student['total_correct'] or 0,
                "avg_accuracy": student['avg_accuracy'] or 0,
                "best_accuracy": student['best_accuracy'] or 0,
                "last_session": student['last_session'].strftime("%Y-%m-%d") if student['last_session'] else "N/A"
            })
        
        cursor.close()
        conn.close()
        
        return jsonify({
            "status": "success",
            "leaderboard": leaderboard
        })
        
    except Exception as e:
        print(f"❌ Proficiency error: {e}")
        return jsonify({"status": "error", "message": str(e)})

@app.route('/admin/one-shot-learn', methods=['POST'])
def one_shot_learning():
    """
    One-Shot Learning - Allows admin to register a new Eco-Card
    or update an existing card by scanning it once, without extensive retraining
    (As defined in Technical Terms)
    
    DUAL IMAGE STORAGE SYSTEM:
    - PNG saved to assets_png/{category}/ for high-quality training/retraining
    - WebP saved to assets/{category}/ for fast frontend display
    - Training uses PNG for better feature extraction (more keypoints/details)
    - System remains plug-and-play and portable
    """
    try:
        if 'image' not in request.files:
            return jsonify({"status": "error", "message": "No image provided"})
        
        card_name = request.form.get('card_name')
        category_id = request.form.get('category_id')
        replace_card_id = request.form.get('replace_card_id')  # For card replacement
        
        if not card_name or not category_id:
            return jsonify({"status": "error", "message": "Card name and category required"})
        
        # Category folder mapping
        CATEGORY_FOLDERS = {
            '1': 'Compostable',
            '2': 'Recyclable', 
            '3': 'Non-Recyclable',
            '4': 'Special-Waste'
        }
        
        category_folder = CATEGORY_FOLDERS.get(str(category_id), 'Compostable')
        
        # Process the uploaded image (keep as high quality for training)
        file = request.files['image']
        npimg = np.fromfile(file, np.uint8)
        img = cv2.imdecode(npimg, cv2.IMREAD_COLOR)
        
        if img is None:
            return jsonify({"status": "error", "message": "Invalid image"})
        
        # Extract ORB features from the original HIGH-QUALITY image (PNG quality)
        # This ensures better keypoints and feature detection for training
        preprocessed = preprocess_image(img)
        kp, des = orb.detectAndCompute(preprocessed, None)
        
        if des is None or len(kp) < 15:
            return jsonify({
                "status": "error", 
                "message": "Insufficient features detected. Please use a clearer image."
            })
        
        conn = connect_db()
        cursor = conn.cursor()
        
        is_replacement = replace_card_id and replace_card_id.strip()
        
        # Generate sanitized filename from card name
        safe_name = card_name.replace(' ', '_').replace('-', '_')
        safe_name = ''.join(c for c in safe_name if c.isalnum() or c == '_')
        
        # Base directory for assets
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        
        # Define paths for both PNG (training) and WebP (display)
        png_folder = os.path.join(base_dir, 'assets_png', category_folder)
        webp_folder = os.path.join(base_dir, 'assets', category_folder)
        
        # Ensure directories exist
        os.makedirs(png_folder, exist_ok=True)
        os.makedirs(webp_folder, exist_ok=True)
        
        png_filename = f"{safe_name}.png"
        webp_filename = f"{safe_name}.webp"
        
        png_full_path = os.path.join(png_folder, png_filename)
        webp_full_path = os.path.join(webp_folder, webp_filename)
        
        # Database paths (relative to htdocs)
        png_db_path = f"assets_png/{category_folder}/{png_filename}"
        webp_db_path = f"assets/{category_folder}/{webp_filename}"
        
        if is_replacement:
            # Update existing card
            card_id = int(replace_card_id)
            
            # Get old image paths to clean up
            cursor.execute("SELECT image_path, card_code FROM TBL_CARD_ASSETS WHERE card_id = %s", (card_id,))
            old_result = cursor.fetchone()
            old_image_path = old_result[0] if old_result else None
            card_code = old_result[1] if old_result else f"{safe_name[:3].upper()}{datetime.now().strftime('%H%M%S')}"
            
            # Save PNG (high quality for training)
            cv2.imwrite(png_full_path, img, [cv2.IMWRITE_PNG_COMPRESSION, 1])
            print(f"📸 Saved training PNG: {png_full_path}")
            
            # Convert and save WebP (optimized for display)
            cv2.imwrite(webp_full_path, img, [cv2.IMWRITE_WEBP_QUALITY, 85])
            print(f"🌐 Saved display WebP: {webp_full_path}")
            
            # Update card metadata with WebP path for display
            cursor.execute("""
                UPDATE TBL_CARD_ASSETS 
                SET card_name = %s, 
                    category_id = %s,
                    image_filename = %s,
                    image_path = %s,
                    description = %s,
                    updated_at = NOW()
                WHERE card_id = %s
            """, (
                card_name, 
                category_id,
                webp_filename,
                webp_db_path,
                f"Updated via One-Shot Learning: {card_name} (PNG training source: {png_db_path})",
                card_id
            ))
            
            # Update feature vector (trained from high-quality PNG)
            feature_blob = pickle.dumps(des)
            image_hash = hashlib.sha256(img.tobytes()).hexdigest()
            
            cursor.execute("""
                UPDATE TBL_GOLDEN_DATASET 
                SET feature_vector = %s,
                    feature_count = %s,
                    image_hash = %s,
                    last_update = NOW()
                WHERE card_id = %s
            """, (feature_blob, len(kp), image_hash, card_id))
            
            # Update in-memory dataset
            for idx, item in enumerate(golden_dataset):
                if item['card_id'] == card_id:
                    golden_dataset[idx]['features'] = des
                    break
            
            if card_id in card_metadata:
                card_metadata[card_id]['name'] = card_name
                card_metadata[card_id]['category_id'] = int(category_id)
            
            conn.commit()
            cursor.close()
            conn.close()
            
            print(f"✅ Card updated: {card_name} | Features: {len(kp)} | PNG: {png_db_path} | WebP: {webp_db_path}")
            
            return jsonify({
                "status": "success",
                "message": f"Card '{card_name}' updated successfully",
                "card_id": card_id,
                "card_code": card_code,
                "features_extracted": len(kp),
                "png_path": png_db_path,
                "webp_path": webp_db_path,
                "image_path": webp_db_path  # For display
            })
            
        else:
            # Create new card
            card_code = f"{safe_name[:3].upper()}{datetime.now().strftime('%H%M%S')}"
            
            # Save PNG (high quality for training)
            cv2.imwrite(png_full_path, img, [cv2.IMWRITE_PNG_COMPRESSION, 1])
            print(f"📸 Saved training PNG: {png_full_path}")
            
            # Convert and save WebP (optimized for display)
            cv2.imwrite(webp_full_path, img, [cv2.IMWRITE_WEBP_QUALITY, 85])
            print(f"🌐 Saved display WebP: {webp_full_path}")
            
            # Insert card asset with WebP path for display
            cursor.execute("""
                INSERT INTO TBL_CARD_ASSETS 
                (category_id, card_name, card_code, image_filename, image_path, description)
                VALUES (%s, %s, %s, %s, %s, %s)
            """, (
                category_id, 
                card_name, 
                card_code,
                webp_filename,
                webp_db_path,
                f"One-shot learned card: {card_name} (PNG training source: {png_db_path})"
            ))
            
            new_card_id = cursor.lastrowid
            
            # Store feature vector (trained from high-quality PNG)
            feature_blob = pickle.dumps(des)
            image_hash = hashlib.sha256(img.tobytes()).hexdigest()
            
            cursor.execute("""
                INSERT INTO TBL_GOLDEN_DATASET 
                (card_id, feature_vector, feature_count, image_hash, algorithm_version)
                VALUES (%s, %s, %s, %s, 'ORB-KNN-v1.0')
            """, (new_card_id, feature_blob, len(kp), image_hash))
            
            conn.commit()
            
            # Update in-memory dataset
            golden_dataset.append({
                'card_id': new_card_id,
                'features': des
            })
            card_metadata[new_card_id] = {
                'name': card_name,
                'category_id': int(category_id)
            }
            
            cursor.close()
            conn.close()
            
            print(f"✅ New card registered: {card_name} | Features: {len(kp)} | PNG: {png_db_path} | WebP: {webp_db_path}")
            
            return jsonify({
                "status": "success",
                "message": f"Card '{card_name}' registered successfully via One-Shot Learning",
                "card_id": new_card_id,
                "card_code": card_code,
                "features_extracted": len(kp),
                "png_path": png_db_path,
                "webp_path": webp_db_path,
                "image_path": webp_db_path  # For display
            })
        
    except Exception as e:
        print(f"❌ One-shot learning error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)})

@app.route('/admin/cards/<int:card_id>', methods=['DELETE'])
def delete_card(card_id):
    """Soft-delete a card: deactivate it and remove from the recognition dataset.
    Soft-delete preserves foreign-key integrity with TBL_SCAN_TRANSACTIONS."""
    try:
        conn = connect_db()
        cursor = conn.cursor()

        # Fetch card info
        cursor.execute("""
            SELECT ca.card_name, ca.image_path
            FROM TBL_CARD_ASSETS ca
            WHERE ca.card_id = %s AND ca.is_active = 1
        """, (card_id,))
        card = cursor.fetchone()

        if not card:
            cursor.close()
            conn.close()
            return jsonify({"status": "error", "message": "Card not found or already deleted"})

        card_name, image_path = card

        # Soft-delete: deactivate in TBL_CARD_ASSETS
        cursor.execute("UPDATE TBL_CARD_ASSETS SET is_active = 0 WHERE card_id = %s", (card_id,))

        # Hard-delete from TBL_GOLDEN_DATASET (no FK restriction here)
        cursor.execute("DELETE FROM TBL_GOLDEN_DATASET WHERE card_id = %s", (card_id,))

        conn.commit()
        cursor.close()
        conn.close()

        # Remove from in-memory recognition dataset
        global golden_dataset, card_metadata
        golden_dataset = [item for item in golden_dataset if item['card_id'] != card_id]
        if card_id in card_metadata:
            del card_metadata[card_id]

        # Delete image files
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        if image_path:
            webp_full = os.path.join(base_dir, image_path)
            if os.path.exists(webp_full):
                os.remove(webp_full)
                print(f"🗑️ Removed WebP: {webp_full}")
            # Derive PNG training image path (assets/ -> assets_png/, .webp -> .png)
            png_rel = image_path.replace('assets/', 'assets_png/', 1)
            png_rel = png_rel.rsplit('.', 1)[0] + '.png'
            png_full = os.path.join(base_dir, png_rel)
            if os.path.exists(png_full):
                os.remove(png_full)
                print(f"🗑️ Removed PNG: {png_full}")

        print(f"🗑️ Card deleted: {card_name} (ID: {card_id})")
        return jsonify({"status": "success", "message": f"Card '{card_name}' deleted successfully"})

    except Exception as e:
        print(f"❌ Card delete error: {e}")
        return jsonify({"status": "error", "message": str(e)})

@app.route('/admin/card-performance', methods=['GET'])
def get_card_performance():
    """
    Card Performance Analytics - Identifies which Eco-Cards 
    have low recognition accuracy for targeted retraining
    """
    try:
        conn = connect_db()
        cursor = conn.cursor(dictionary=True)
        
        cursor.execute("""
            SELECT 
                c.card_id,
                c.card_name,
                cat.category_name,
                COUNT(t.transaction_id) as total_scans,
                SUM(CASE WHEN t.is_correct = 1 THEN 1 ELSE 0 END) as correct_scans,
                ROUND(AVG(t.confidence_score) * 100, 1) as avg_confidence,
                ROUND(AVG(t.response_time), 0) as avg_response_time
            FROM TBL_CARD_ASSETS c
            JOIN TBL_CATEGORIES cat ON c.category_id = cat.category_id
            LEFT JOIN TBL_SCAN_TRANSACTIONS t ON c.card_id = t.card_id
            WHERE c.is_active = 1
            GROUP BY c.card_id, c.card_name, cat.category_name
            ORDER BY (correct_scans / NULLIF(total_scans, 0)) ASC, total_scans DESC
        """)
        
        cards = cursor.fetchall()
        
        performance = []
        for card in cards:
            total = card['total_scans'] or 0
            correct = card['correct_scans'] or 0
            accuracy = round((correct / total * 100), 1) if total > 0 else 0
            
            performance.append({
                "card_id": card['card_id'],
                "card_name": card['card_name'],
                "category": card['category_name'],
                "total_scans": total,
                "correct_scans": correct,
                "accuracy": accuracy,
                "avg_confidence": card['avg_confidence'] or 0,
                "avg_response_time": card['avg_response_time'] or 0,
                "needs_retraining": accuracy < 80 and total >= 5
            })
        
        cursor.close()
        conn.close()
        
        return jsonify({
            "status": "success",
            "cards": performance
        })
        
    except Exception as e:
        print(f"❌ Card performance error: {e}")
        return jsonify({"status": "error", "message": str(e)})

# ============================================================
# STATIC FILE SERVING WITH AGGRESSIVE CACHING
# Serves images with 1-year cache + WebP support
# Thumbnails for gallery, full images for PDF generation
# ============================================================

@app.route('/assets/<path:filename>')
def serve_assets(filename):
    """
    Serve static assets with aggressive caching.
    Browser will cache for 1 year - no more repeat downloads!
    Auto-serves WebP when browser supports it.
    """
    # Assets are in ../assets relative to backend/
    assets_dir = os.path.join(os.path.dirname(__file__), '..', 'assets')
    
    # Check if browser accepts WebP and WebP version exists
    if 'image/webp' in request.headers.get('Accept', ''):
        webp_filename = os.path.splitext(filename)[0] + '.webp'
        webp_path = os.path.join(assets_dir, webp_filename)
        if os.path.exists(webp_path):
            response = send_from_directory(assets_dir, webp_filename)
            response.headers['Content-Type'] = 'image/webp'
            response.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
            response.headers['Vary'] = 'Accept'
            return response
    
    # Serve original file with caching
    response = send_from_directory(assets_dir, filename)
    response.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
    return response

@app.route('/assets/thumb/<path:filename>')
def serve_thumbnail(filename):
    """
    Serve optimized thumbnails for gallery (120x150, WebP).
    Much smaller than full images = faster gallery loading!
    Falls back to full image if thumbnail doesn't exist.
    """
    assets_dir = os.path.join(os.path.dirname(__file__), '..', 'assets')
    
    # Extract category folder and filename
    parts = filename.split('/')
    if len(parts) >= 2:
        category = parts[0]
        img_name = parts[1]
        thumb_name = os.path.splitext(img_name)[0] + '_thumb.webp'
        thumb_path = os.path.join(assets_dir, category, 'thumbs', thumb_name)
        
        if os.path.exists(thumb_path):
            response = send_from_directory(
                os.path.join(assets_dir, category, 'thumbs'), 
                thumb_name
            )
            response.headers['Content-Type'] = 'image/webp'
            response.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
            return response
    
    # Fallback to regular asset serving
    return serve_assets(filename)

# ============================================
# TEXT-TO-SPEECH (Tagalog) via gTTS
# ============================================

@app.route('/tts', methods=['POST'])
def text_to_speech():
    """
    Generate Tagalog speech audio from text using Google TTS.
    Returns MP3 audio stream.
    """
    try:
        if not ENABLE_AUDIO_FEEDBACK:
            return jsonify({"status": "disabled", "message": "Audio feedback is disabled"}), 403

        data = request.get_json()
        text = data.get('text', '')
        lang = data.get('lang', 'tl')  # Default to Tagalog
        
        if not text:
            return jsonify({"error": "No text provided"}), 400
        
        # Generate speech
        tts = gTTS(text=text, lang=lang, slow=False)
        
        # Write to memory buffer
        audio_buffer = io.BytesIO()
        tts.write_to_fp(audio_buffer)
        audio_buffer.seek(0)
        
        # Return as base64 JSON to prevent IDM from intercepting
        audio_b64 = base64.b64encode(audio_buffer.read()).decode('utf-8')
        return jsonify({
            'status': 'success',
            'audio': audio_b64
        })
    except Exception as e:
        print(f"❌ TTS Error: {e}")
        return jsonify({"error": str(e)}), 500

@app.after_request
def add_cache_headers(response):
    """Add cache headers to all responses"""
    # Don't cache API responses that change frequently
    if request.path.startswith('/admin/') or request.path == '/scan':
        response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    # Cache static files aggressively
    elif request.path.endswith(('.css', '.js', '.png', '.jpg', '.jpeg', '.webp', '.gif')):
        response.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
    return response

if __name__ == '__main__':
    print("🚀 Starting EcoLearn Recognition Engine...")
    print("📦 Gzip compression: ENABLED")
    print("🖼️ Image caching: 1 YEAR")
    if load_model():
        load_runtime_config_from_db()
        load_cnn_model()
        print("✅ System Ready!")
        app.run(host='0.0.0.0', port=5000, debug=True)
    else:
        print("❌ Failed to start - Model loading error")