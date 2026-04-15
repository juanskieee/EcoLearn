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
import json
import os
import io
import sys
import subprocess
import threading
import random
from pathlib import Path
from gtts import gTTS

# Avoid UnicodeEncodeError on some Windows consoles (e.g., cp1252) when printing
# status markers like ✅/⚠️.
try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

# Compatibility shim for loading legacy NumPy pickles across module path changes.
try:
    import numpy.core.numeric as _np_numeric
    import numpy.core.multiarray as _np_multiarray
    import numpy.core.umath as _np_umath

    sys.modules.setdefault('numpy._core.numeric', _np_numeric)
    sys.modules.setdefault('numpy._core.multiarray', _np_multiarray)
    sys.modules.setdefault('numpy._core.umath', _np_umath)
except Exception:
    pass

try:
    from generate_variants import build_variants as gv_build_variants
    from generate_variants import read_image as gv_read_image
    from generate_variants import write_image as gv_write_image
except Exception:
    gv_build_variants = None
    gv_read_image = None
    gv_write_image = None

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
MODEL_VERSION = 'ORB-KNN-v2.0'

# --- OPTIONAL ORB FALLBACK (for unavoidable blur) ---
ORB_MODEL_PATH = os.path.join(os.path.dirname(__file__), 'models', 'waste_mobilenet.onnx')
ORB_LABELS_PATH = os.path.join(os.path.dirname(__file__), 'models', 'waste_labels.txt')
ORB_IMPORT_MARKER_PATH = os.path.join(os.path.dirname(__file__), 'models', '.teachable_import.done.json')
ORB_INCREMENTAL_MODEL_PATH = os.path.join(os.path.dirname(__file__), 'models', 'waste_incremental.onnx')
ORB_INCREMENTAL_LABELS_PATH = os.path.join(os.path.dirname(__file__), 'models', 'waste_incremental_labels.txt')
ORB_INPUT_SIZE = (224, 224)
ORB_CONFIDENCE_THRESHOLD = 0.65
ORB_INCREMENTAL_CONFIDENCE_THRESHOLD = 0.85
ORB_FOCUS_ROI_SCALE = 0.80  # Secondary center crop to suppress background noise.
HYBRID_MARGIN = 0.10  # Minimum confidence gap to break ORB vs fallback disagreements


def ensure_default_orb_model_assets() -> bool:
    """
    Auto-import Teachable Machine export when ONNX assets are missing.
    This removes the need to run import_teachable_model.py manually.
    """
    if os.path.exists(ORB_MODEL_PATH) and os.path.exists(ORB_LABELS_PATH):
        if not os.path.exists(ORB_IMPORT_MARKER_PATH):
            try:
                marker_payload = {
                    'imported_at': datetime.now().isoformat(timespec='seconds'),
                    'source': 'existing_onnx',
                    'onnx_path': ORB_MODEL_PATH,
                    'labels_path': ORB_LABELS_PATH,
                }
                with open(ORB_IMPORT_MARKER_PATH, 'w', encoding='utf-8') as mf:
                    json.dump(marker_payload, mf, indent=2)
            except Exception:
                pass
        return True

    backend_dir = os.path.dirname(__file__)
    converted_dir = os.path.abspath(os.path.join(backend_dir, '..', 'converted_keras'))
    keras_path = os.path.join(converted_dir, 'keras_model.h5')
    labels_path = os.path.join(converted_dir, 'labels.txt')

    if not (os.path.exists(keras_path) and os.path.exists(labels_path)):
        print("ℹ️ Auto-import skipped: converted_keras model/labels not found")
        return False

    print("ℹ️ ONNX model/labels missing. Auto-importing from converted_keras...")
    cmd = [
        sys.executable,
        'import_teachable_model.py',
        '--keras-model', os.path.join('..', 'converted_keras', 'keras_model.h5'),
        '--labels', os.path.join('..', 'converted_keras', 'labels.txt'),
        '--out-onnx', os.path.join('models', 'waste_mobilenet.onnx'),
        '--out-labels', os.path.join('models', 'waste_labels.txt'),
    ]

    try:
        proc = subprocess.run(
            cmd,
            cwd=backend_dir,
            capture_output=True,
            text=True,
            timeout=600,
            check=False,
        )
        if proc.returncode == 0:
            try:
                marker_payload = {
                    'imported_at': datetime.now().isoformat(timespec='seconds'),
                    'source': 'converted_keras_auto_import',
                    'keras_path': keras_path,
                    'labels_path': labels_path,
                    'onnx_path': ORB_MODEL_PATH,
                    'backend_labels_path': ORB_LABELS_PATH,
                }
                with open(ORB_IMPORT_MARKER_PATH, 'w', encoding='utf-8') as mf:
                    json.dump(marker_payload, mf, indent=2)
            except Exception as marker_err:
                print(f"⚠️ Could not write import marker: {marker_err}")
            print("✅ Auto-import complete: ONNX and label map generated")
            return os.path.exists(ORB_MODEL_PATH) and os.path.exists(ORB_LABELS_PATH)

        print("⚠️ Auto-import failed; startup will continue without fallback model")
        if proc.stdout:
            print(proc.stdout.strip())
        if proc.stderr:
            print(proc.stderr.strip())
        return False
    except Exception as e:
        print(f"⚠️ Auto-import exception: {e}")
        return False

SYSTEM_CONFIG_DEFAULTS = [
    ('orb_feature_count', '1000', 'integer', 'Number of ORB features to extract per image', 1),
    ('knn_k_value', '2', 'integer', 'K value for KNN classifier (fixed to 2 for Lowe ratio test)', 0),
    ('knn_distance_threshold', '0.65', 'float', 'Lowe ratio test threshold for feature matching', 1),
    ('orb_confidence_threshold', '0.65', 'float', 'Minimum confidence for base ORB fallback prediction', 1),
    ('orb_incremental_confidence_threshold', '0.85', 'float', 'Minimum confidence for incremental ORB prediction', 1),
    ('orb_focus_roi_scale', '0.80', 'float', 'Center crop scale used before ORB inference (0.5 to 1.0)', 1),
    ('hybrid_margin', '0.10', 'float', 'Confidence gap required for ORB override in hybrid mode', 1),
    ('model_version', 'ORB-KNN-v2.0', 'string', 'Current algorithm version identifier', 0),
    ('session_timeout_minutes', '30', 'integer', 'Auto-abandon sessions after N minutes of inactivity', 1),
    ('min_confidence_score', '0.60', 'float', 'Minimum confidence to accept a classification', 1),
    ('webcam_fps', '30', 'integer', 'Target frames per second for video capture', 1),
    ('roi_box_color', '#00FF00', 'string', 'Hex color code for scanning area overlay', 1),
    ('enable_audio_feedback', 'true', 'boolean', 'Whether Bin-Bin provides audio responses', 1),
    ('pdf_dpi', '300', 'integer', 'Resolution for generating printable Eco-Cards', 0),
]

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
current_session_subset_card_ids = set()
current_session_scanned_card_ids = set()
session_subset_lock = threading.Lock()
SESSION_CARD_SUBSET_SIZE = 10
orb_fallback_net = None
orb_fallback_class_to_card_id = {}
incremental_orb_net = None
incremental_orb_class_to_card_id = {}
incremental_allowed_card_ids = set()
training_status_lock = threading.Lock()
training_status = {
    'state': 'idle',
    'started_at': None,
    'ended_at': None,
    'last_error': None,
    'last_log_path': None,
    'last_trigger': None,
    'last_card_id': None,
    'last_card_name': None,
}


def _update_training_status(**kwargs):
    with training_status_lock:
        training_status.update(kwargs)


def get_training_status_snapshot():
    with training_status_lock:
        return dict(training_status)


def select_random_card_subset(card_ids: list[int], subset_size: int) -> set[int]:
    """Pick a random subset of active card IDs for a session."""
    unique_ids: list[int] = []
    seen: set[int] = set()
    for cid in card_ids:
        try:
            cid_int = int(cid)
        except (TypeError, ValueError):
            continue
        if cid_int in seen:
            continue
        seen.add(cid_int)
        unique_ids.append(cid_int)

    if subset_size <= 0 or len(unique_ids) <= subset_size:
        return set(unique_ids)
    return set(random.sample(unique_ids, subset_size))


def generate_variants_for_card(png_full_path: str, variants_category_dir: str, stem: str) -> int:
    """Generate all variants for a single card image into assets_variants/category."""
    if gv_build_variants is None or gv_read_image is None or gv_write_image is None:
        raise RuntimeError("generate_variants.py helpers unavailable")

    image = gv_read_image(Path(png_full_path))
    if image is None:
        raise RuntimeError(f"Failed to read PNG for variant generation: {png_full_path}")

    variants = gv_build_variants(image)
    os.makedirs(variants_category_dir, exist_ok=True)

    written = 0
    for variant_name, variant_img in variants.items():
        out_path = Path(variants_category_dir) / f"{stem}__{variant_name}.png"
        gv_write_image(out_path, variant_img, ext='.png')
        written += 1
    return written


def cleanup_variants_for_card(card_id: int | None, card_name: str | None) -> int:
    """Remove generated one-shot variants after retraining completes."""
    if card_id is None:
        return 0

    conn = None
    cursor = None
    deleted = 0
    try:
        conn = connect_db()
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            """
            SELECT c.category_name
            FROM TBL_CARD_ASSETS ca
            JOIN TBL_CATEGORIES c ON c.category_id = ca.category_id
            WHERE ca.card_id = %s
            LIMIT 1
            """,
            (card_id,),
        )
        row = cursor.fetchone()
        if not row:
            return 0

        category_name = str(row['category_name'])
        safe_name = (card_name or '').replace(' ', '_').replace('-', '_')
        safe_name = ''.join(ch for ch in safe_name if ch.isalnum() or ch == '_')
        if not safe_name:
            return 0

        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        variants_dir = Path(base_dir) / 'assets_variants' / category_name
        if not variants_dir.exists():
            return 0

        for ext in ('png', 'jpg', 'jpeg', 'webp', 'bmp'):
            for p in variants_dir.glob(f"{safe_name}__*.{ext}"):
                try:
                    p.unlink()
                    deleted += 1
                except Exception:
                    pass
        return deleted
    except Exception as e:
        print(f"⚠️ Variant cleanup failed for card_id={card_id}: {e}")
        return deleted
    finally:
        try:
            if cursor:
                cursor.close()
            if conn:
                conn.close()
        except Exception:
            pass


def decode_uploaded_image_to_bgr(file_storage):
    """Decode uploaded image and flatten alpha onto white to avoid black backgrounds."""
    raw = file_storage.read()
    if not raw:
        return None

    npbuf = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(npbuf, cv2.IMREAD_UNCHANGED)
    if img is None:
        return None

    if img.ndim == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)

    if img.shape[2] == 4:
        bgr = img[:, :, :3].astype(np.float32)
        alpha = (img[:, :, 3].astype(np.float32) / 255.0)[..., None]
        bg = np.full_like(bgr, 255.0)
        flat = bgr * alpha + bg * (1.0 - alpha)
        return np.clip(flat, 0, 255).astype(np.uint8)

    return img[:, :, :3]


def decode_uploaded_image_keep_alpha(file_storage):
    """Decode uploaded image as-is so alpha can be preserved when saving assets."""
    raw = file_storage.read()
    if not raw:
        return None

    npbuf = np.frombuffer(raw, dtype=np.uint8)
    return cv2.imdecode(npbuf, cv2.IMREAD_UNCHANGED)


def to_bgr_for_ml(img):
    """Convert decoded image to BGR for ORB/fallback processing while handling alpha safely."""
    if img is None:
        return None

    if img.ndim == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)

    if img.shape[2] == 4:
        bgr = img[:, :, :3].astype(np.float32)
        alpha = (img[:, :, 3].astype(np.float32) / 255.0)[..., None]
        bg = np.full_like(bgr, 255.0)
        flat = bgr * alpha + bg * (1.0 - alpha)
        return np.clip(flat, 0, 255).astype(np.uint8)

    return img[:, :, :3]


def _run_orb_training_job(trigger: str, card_id: int | None, card_name: str | None):
    backend_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(backend_dir)
    log_path = os.path.join(backend_dir, 'models', 'orb_retrain_last.log')
    os.makedirs(os.path.dirname(log_path), exist_ok=True)

    _update_training_status(
        state='running',
        started_at=datetime.now().isoformat(timespec='seconds'),
        ended_at=None,
        last_error=None,
        last_log_path=log_path,
        last_trigger=trigger,
        last_card_id=card_id,
        last_card_name=card_name,
    )

    # Prefer explicit override, then project .venv, then current interpreter.
    env_python = os.environ.get('ECOLEARN_TRAIN_PYTHON')
    venv_python = os.path.join(project_root, '.venv', 'Scripts', 'python.exe')
    if env_python and os.path.exists(env_python):
        python_exe = env_python
    elif os.path.exists(venv_python):
        python_exe = venv_python
    else:
        python_exe = sys.executable

    cmd = [python_exe, '-u', 'train_orb.py']

    # Fast incremental retraining profile after one-shot add/replace.
    if trigger in {'card_add', 'card_replace'}:
        incremental_ids = get_incremental_card_ids()
        if not incremental_ids:
            _update_training_status(
                state='completed',
                ended_at=datetime.now().isoformat(timespec='seconds'),
                last_error=None,
            )
            print('ℹ️ No incremental cards found; skipping incremental ORB retrain')
            return

        training_ids = list(incremental_ids)
        if len(training_ids) == 1:
            anchor_id = get_anchor_card_id(set(training_ids))
            if anchor_id is not None:
                training_ids.append(anchor_id)
                print(f"ℹ️ Added anchor card_id={anchor_id} for one-class incremental training")

        cmd.extend([
            '--img-size', '224',
            '--batch-size', '24',
            '--head-epochs', '1',
            '--finetune-epochs', '0',
            '--max-samples-per-class', '12',
            '--focus-max-samples', '48',
            '--include-card-ids', ','.join(str(x) for x in training_ids),
            '--out-keras', 'models/waste_incremental_finetuned.h5',
            '--out-onnx', 'models/waste_incremental.onnx',
            '--out-labels', 'models/waste_incremental_labels.txt',
            '--out-manifest', 'models/training_manifest_incremental.json',
        ])
        if card_id is not None:
            cmd.extend(['--focus-card-id', str(card_id)])
    try:
        with open(log_path, 'w', encoding='utf-8') as logf:
            logf.write(f"[{datetime.now().isoformat(timespec='seconds')}] Starting ORB retrain\n")
            logf.write(f"trigger={trigger} card_id={card_id} card_name={card_name}\n")
            logf.write(f"python_executable={python_exe}\n")
            logf.write(f"command={' '.join(cmd)}\n")
            logf.flush()

            proc = subprocess.run(
                cmd,
                cwd=backend_dir,
                stdout=logf,
                stderr=subprocess.STDOUT,
                check=False,
            )
            logf.write(f"\n[{datetime.now().isoformat(timespec='seconds')}] Finished with exit_code={proc.returncode}\n")
            logf.flush()

        if proc.returncode != 0:
            _update_training_status(
                state='failed',
                ended_at=datetime.now().isoformat(timespec='seconds'),
                last_error=f"train_orb.py exited with code {proc.returncode}",
            )
            print(f"❌ ORB retrain failed (code {proc.returncode}). See log: {log_path}")
            return

        if trigger in {'card_add', 'card_replace'}:
            reloaded = load_incremental_orb_model()
        else:
            reloaded = load_orb_model()
            load_incremental_orb_model()
        if not reloaded:
            _update_training_status(
                state='failed',
                ended_at=datetime.now().isoformat(timespec='seconds'),
                last_error='Training finished but ORB reload failed',
            )
            print("❌ ORB retrain completed but model reload failed")
            return

        if trigger in {'card_add', 'card_replace'}:
            removed = cleanup_variants_for_card(card_id, card_name)
            if removed > 0:
                print(f"🧹 Cleaned up {removed} generated variant files for card_id={card_id}")

        _update_training_status(
            state='completed',
            ended_at=datetime.now().isoformat(timespec='seconds'),
            last_error=None,
        )
        print("✅ ORB retrain completed and model reloaded")
    except Exception as e:
        _update_training_status(
            state='failed',
            ended_at=datetime.now().isoformat(timespec='seconds'),
            last_error=str(e),
        )
        try:
            with open(log_path, 'a', encoding='utf-8') as logf:
                logf.write(f"\n[{datetime.now().isoformat(timespec='seconds')}] Exception: {e}\n")
        except Exception:
            pass
        print(f"❌ ORB retrain exception: {e}")


def maybe_start_orb_retrain(trigger: str, card_id: int | None, card_name: str | None) -> tuple[bool, str]:
    snap = get_training_status_snapshot()
    if snap.get('state') == 'running':
        return False, 'ORB retraining already running'

    thread = threading.Thread(
        target=_run_orb_training_job,
        args=(trigger, card_id, card_name),
        daemon=True,
    )
    _update_training_status(
        state='queued',
        started_at=None,
        ended_at=None,
        last_error=None,
        last_trigger=trigger,
        last_card_id=card_id,
        last_card_name=card_name,
    )
    thread.start()
    return True, 'ORB retraining started in background'


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
    global ORB_CONFIDENCE_THRESHOLD, ORB_INCREMENTAL_CONFIDENCE_THRESHOLD, ORB_FOCUS_ROI_SCALE, HYBRID_MARGIN

    if config_key == 'orb_feature_count':
        ORB_FEATURES = max(100, int(config_value))
        rebuild_orb_extractor()
    elif config_key == 'knn_k_value':
        # Lowe ratio test requires at least 2 neighbors.
        KNN_K = max(2, int(config_value))
    elif config_key == 'knn_distance_threshold':
        LOWE_RATIO = max(0.1, min(0.99, float(config_value)))
    elif config_key == 'orb_confidence_threshold':
        ORB_CONFIDENCE_THRESHOLD = max(0.1, min(1.0, float(config_value)))
    elif config_key == 'orb_incremental_confidence_threshold':
        ORB_INCREMENTAL_CONFIDENCE_THRESHOLD = max(0.1, min(1.0, float(config_value)))
    elif config_key == 'orb_focus_roi_scale':
        ORB_FOCUS_ROI_SCALE = max(0.3, min(1.0, float(config_value)))
    elif config_key == 'hybrid_margin':
        HYBRID_MARGIN = max(0.0, min(0.5, float(config_value)))
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


def ensure_system_config_defaults():
    """Seed missing config keys without overwriting existing admin-tuned values."""
    conn = connect_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("SELECT config_key FROM TBL_SYSTEM_CONFIG")
    existing = {row['config_key'] for row in cursor.fetchall()}

    missing = [cfg for cfg in SYSTEM_CONFIG_DEFAULTS if cfg[0] not in existing]
    if missing:
        cursor.executemany(
            """
            INSERT INTO TBL_SYSTEM_CONFIG (config_key, config_value, value_type, description, is_editable)
            VALUES (%s, %s, %s, %s, %s)
            """,
            missing,
        )
        conn.commit()

    cursor.close()
    conn.close()


def load_runtime_config_from_db():
    """Load dynamic settings from TBL_SYSTEM_CONFIG on startup."""
    try:
        ensure_system_config_defaults()
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
        cursor.execute("SELECT card_id, card_name, category_id, image_path FROM TBL_CARD_ASSETS WHERE is_active = 1")
        for row in cursor.fetchall():
            card_metadata[row['card_id']] = {
                'name': row['card_name'],
                'category_id': row['category_id'],
                'image_path': row.get('image_path') or ''
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


def maybe_auto_run_training_if_needed() -> bool:
    """
    Auto-run train_database.py on startup when cards exist but no feature sets are loaded.
    Returns True if training ran successfully, otherwise False.
    """
    try:
        if len(golden_dataset) > 0:
            print("ℹ️ Auto-train skipped: feature dataset already loaded")
            return True

        if len(card_metadata) == 0:
            print("ℹ️ Auto-train skipped: no active cards found")
            return True

        print("⚙️ Auto-train triggered: no ORB features found; running train_database.py...")
        backend_dir = os.path.dirname(__file__)
        cmd = [sys.executable, 'train_database.py']
        proc = subprocess.run(
            cmd,
            cwd=backend_dir,
            input='yes\n',
            capture_output=True,
            text=True,
            timeout=1800,
            check=False,
        )

        if proc.returncode != 0:
            print("⚠️ Auto-train failed; startup will continue")
            if proc.stdout:
                print(proc.stdout.strip())
            if proc.stderr:
                print(proc.stderr.strip())
            return False

        if proc.stdout:
            print(proc.stdout.strip())

        reloaded = load_model()
        if reloaded and len(golden_dataset) > 0:
            print(f"✅ Auto-train completed: loaded {len(golden_dataset)} feature sets")
            return True

        print("⚠️ Auto-train finished but no feature sets were loaded")
        return False
    except Exception as e:
        print(f"⚠️ Auto-train exception: {e}")
        return False


def load_orb_model():
    """Loads optional ONNX ORB-fallback model and class mappings for hybrid fallback."""
    global orb_fallback_net, orb_fallback_class_to_card_id

    orb_fallback_net = None
    orb_fallback_class_to_card_id = {}

    if not os.path.exists(ORB_MODEL_PATH):
        print("ℹ️ ORB fallback disabled: model file not found")
        return False

    if not os.path.exists(ORB_LABELS_PATH):
        print("⚠️ ORB fallback disabled: labels file not found")
        return False

    try:
        net = cv2.dnn.readNetFromONNX(ORB_MODEL_PATH)
        class_map = {}

        with open(ORB_LABELS_PATH, 'r', encoding='utf-8') as f:
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
            print("⚠️ ORB fallback disabled: empty labels mapping")
            return False

        orb_fallback_net = net
        orb_fallback_class_to_card_id = class_map
        print(f"✅ ORB fallback loaded: {len(orb_fallback_class_to_card_id)} classes")
        return True
    except Exception as e:
        print(f"⚠️ ORB fallback disabled: {e}")
        orb_fallback_net = None
        orb_fallback_class_to_card_id = {}
        return False


def get_incremental_card_ids() -> list[int]:
    """Returns active cards created/updated via one-shot flow for incremental model."""
    try:
        conn = connect_db()
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            """
            SELECT card_id
            FROM TBL_CARD_ASSETS
            WHERE is_active = 1
              AND (
                description LIKE '%One-shot learned card%'
                OR description LIKE '%One-Shot Learning%'
              )
            ORDER BY card_id
            """
        )
        rows = cursor.fetchall()
        cursor.close()
        conn.close()
        return [int(r['card_id']) for r in rows]
    except Exception as e:
        print(f"⚠️ Failed to fetch incremental card IDs: {e}")
        return []


def get_anchor_card_id(exclude_ids: set[int]) -> int | None:
    """Pick one active non-incremental card as anchor for one-class training."""
    try:
        conn = connect_db()
        cursor = conn.cursor(dictionary=True)

        if exclude_ids:
            placeholders = ','.join(['%s'] * len(exclude_ids))
            sql = f"""
                SELECT card_id
                FROM TBL_CARD_ASSETS
                WHERE is_active = 1 AND card_id NOT IN ({placeholders})
                ORDER BY card_id
                LIMIT 1
            """
            cursor.execute(sql, tuple(sorted(exclude_ids)))
        else:
            cursor.execute(
                """
                SELECT card_id
                FROM TBL_CARD_ASSETS
                WHERE is_active = 1
                ORDER BY card_id
                LIMIT 1
                """
            )

        row = cursor.fetchone()
        cursor.close()
        conn.close()
        return int(row['card_id']) if row else None
    except Exception as e:
        print(f"⚠️ Failed to fetch anchor card: {e}")
        return None


def load_incremental_orb_model():
    """Loads incremental ONNX model trained only on one-shot cards."""
    global incremental_orb_net, incremental_orb_class_to_card_id, incremental_allowed_card_ids

    incremental_orb_net = None
    incremental_orb_class_to_card_id = {}
    incremental_allowed_card_ids = set(get_incremental_card_ids())

    if not os.path.exists(ORB_INCREMENTAL_MODEL_PATH):
        print('ℹ️ Incremental ORB disabled: model file not found')
        return False

    if not os.path.exists(ORB_INCREMENTAL_LABELS_PATH):
        print('ℹ️ Incremental ORB disabled: labels file not found')
        return False

    try:
        net = cv2.dnn.readNetFromONNX(ORB_INCREMENTAL_MODEL_PATH)
        class_map = {}

        with open(ORB_INCREMENTAL_LABELS_PATH, 'r', encoding='utf-8') as f:
            for line in f:
                row = line.strip()
                if not row or row.startswith('#'):
                    continue

                parts = [p.strip() for p in row.split(',') if p.strip()]
                if len(parts) >= 2:
                    class_index = int(parts[0])
                    card_id = int(parts[1])
                else:
                    class_index = len(class_map)
                    card_id = int(parts[0])

                class_map[class_index] = card_id

        incremental_orb_net = net
        incremental_orb_class_to_card_id = class_map
        print(f"✅ Incremental ORB loaded: {len(incremental_orb_class_to_card_id)} classes")
        return True
    except Exception as e:
        print(f"⚠️ Incremental ORB disabled: {e}")
        incremental_orb_net = None
        incremental_orb_class_to_card_id = {}
        return False


def crop_center_roi(image_bgr, scale=0.8):
    """Returns a centered *square* crop for ORB fallback inference.

    Teachable Machine's preview commonly center-crops to a square before resizing.
    Keeping the original aspect ratio (e.g., 16:9) and then resizing to 224x224
    stretches the object and can significantly reduce CNN accuracy.
    """
    if image_bgr is None or image_bgr.size == 0:
        return image_bgr

    h, w = image_bgr.shape[:2]
    if h < 8 or w < 8:
        return image_bgr

    s = max(0.35, min(1.0, float(scale)))

    # Allow callers to explicitly disable extra cropping.
    # This is useful when the frontend already sends a tight ROI.
    if s >= 0.999:
        return image_bgr

    side = int(min(h, w) * s)
    side = max(8, min(side, min(h, w)))

    start_x = max(0, (w - side) // 2)
    start_y = max(0, (h - side) // 2)
    end_x = min(w, start_x + side)
    end_y = min(h, start_y + side)

    if end_x - start_x < 8 or end_y - start_y < 8:
        return image_bgr

    return image_bgr[start_y:end_y, start_x:end_x]


def predict_waste_orb_fallback(image_bgr, allowed_card_ids: set[int] | None = None):
    """Runs ORB fallback inference and returns ORB-compatible response shape.

    When allowed_card_ids is provided, the prediction is constrained to those card IDs.
    """
    if orb_fallback_net is None or not orb_fallback_class_to_card_id:
        return {"status": "unknown", "reason": "orb_unavailable"}

    try:
        # The frontend can already send a tight ROI; applying another crop may over-zoom.
        # Evaluate both: configured crop, and no extra crop.
        crop_scales = [float(ORB_FOCUS_ROI_SCALE), 1.0]
        crop_scales = [s for i, s in enumerate(crop_scales) if s not in crop_scales[:i]]

        best_probs = None
        best_conf = -1.0

        for crop_scale in crop_scales:
            focused = crop_center_roi(image_bgr, scale=crop_scale)
            resized = cv2.resize(focused, ORB_INPUT_SIZE)
            rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32)

            # Teachable Machine exports are commonly NHWC and can use different
            # normalization schemes depending on embedded preprocessing layers.
            # Try common variants and keep the highest-confidence prediction.
            input_variants = [
                np.expand_dims(rgb, axis=0),
                np.expand_dims(rgb / 255.0, axis=0),
                np.expand_dims((rgb / 127.5) - 1.0, axis=0),
            ]

            for candidate in input_variants:
                try:
                    orb_fallback_net.setInput(candidate)
                    raw = orb_fallback_net.forward().flatten()
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
            return {"status": "unknown", "reason": "orb_inference_failed"}

        probs = best_probs

        if allowed_card_ids:
            best_class = None
            best_conf = -1.0
            for class_idx, conf in enumerate(probs.tolist()):
                card_id_candidate = orb_fallback_class_to_card_id.get(int(class_idx))
                if card_id_candidate in allowed_card_ids and float(conf) > best_conf:
                    best_conf = float(conf)
                    best_class = int(class_idx)

            if best_class is None:
                return {"status": "unknown", "reason": "not_in_subset"}

            top_class = best_class
            confidence = best_conf
        else:
            top_class = int(np.argmax(probs))
            confidence = float(probs[top_class])

        if confidence < ORB_CONFIDENCE_THRESHOLD:
            return {
                "status": "unknown",
                "reason": "orb_low_confidence",
                "confidence": round(confidence, 2)
            }

        if top_class not in orb_fallback_class_to_card_id:
            return {"status": "unknown", "reason": "orb_unmapped_class"}

        card_id = orb_fallback_class_to_card_id[top_class]
        card = card_metadata.get(card_id)
        if not card:
            return {"status": "unknown", "reason": "orb_card_not_found"}

        category = category_metadata.get(card['category_id'])
        return {
            "status": "success",
            "card_id": card_id,
            "card_name": card['name'],
            "image_path": card.get('image_path', ''),
            "category": category,
            "category_id": card['category_id'],
            "matches": 0,
            "confidence": round(confidence, 2),
            "keypoints_detected": 0,
            "classifier": "orb_fallback"
        }
    except Exception as e:
        return {"status": "unknown", "reason": f"orb_fallback_error:{str(e)}"}


def predict_waste_incremental_orb(image_bgr, allowed_card_ids: set[int] | None = None):
    """Runs incremental ORB first for one-shot classes only.

    When allowed_card_ids is provided, the prediction is constrained to those card IDs.
    """
    if incremental_orb_net is None or not incremental_orb_class_to_card_id:
        return {"status": "unknown", "reason": "incremental_orb_unavailable"}

    try:
        crop_scales = [float(ORB_FOCUS_ROI_SCALE), 1.0]
        crop_scales = [s for i, s in enumerate(crop_scales) if s not in crop_scales[:i]]

        best_probs = None
        best_conf = -1.0

        for crop_scale in crop_scales:
            focused = crop_center_roi(image_bgr, scale=crop_scale)
            resized = cv2.resize(focused, ORB_INPUT_SIZE)
            rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32)

            input_variants = [
                np.expand_dims(rgb, axis=0),
                np.expand_dims(rgb / 255.0, axis=0),
                np.expand_dims((rgb / 127.5) - 1.0, axis=0),
            ]

            for candidate in input_variants:
                try:
                    incremental_orb_net.setInput(candidate)
                    raw = incremental_orb_net.forward().flatten()
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
            return {"status": "unknown", "reason": "incremental_orb_inference_failed"}

        probs = best_probs
        if allowed_card_ids:
            best_class = None
            best_conf = -1.0
            for class_idx, conf in enumerate(probs.tolist()):
                card_id_candidate = incremental_orb_class_to_card_id.get(int(class_idx))
                if card_id_candidate in allowed_card_ids and float(conf) > best_conf:
                    best_conf = float(conf)
                    best_class = int(class_idx)

            if best_class is None:
                return {"status": "unknown", "reason": "not_in_subset"}

            top_class = best_class
            confidence = best_conf
        else:
            top_class = int(np.argmax(probs))
            confidence = float(probs[top_class])

        if confidence < ORB_INCREMENTAL_CONFIDENCE_THRESHOLD:
            return {
                "status": "unknown",
                "reason": "incremental_orb_low_confidence",
                "confidence": round(confidence, 2),
            }

        if top_class not in incremental_orb_class_to_card_id:
            return {"status": "unknown", "reason": "incremental_orb_unmapped_class"}

        card_id = incremental_orb_class_to_card_id[top_class]
        if card_id not in incremental_allowed_card_ids:
            return {"status": "unknown", "reason": "incremental_anchor_class"}
        card = card_metadata.get(card_id)
        if not card:
            return {"status": "unknown", "reason": "incremental_orb_card_not_found"}

        category = category_metadata.get(card['category_id'])
        return {
            "status": "success",
            "card_id": card_id,
            "card_name": card['name'],
            "image_path": card.get('image_path', ''),
            "category": category,
            "category_id": card['category_id'],
            "matches": 0,
            "confidence": round(confidence, 2),
            "keypoints_detected": 0,
            "classifier": "incremental_orb",
        }
    except Exception as e:
        return {"status": "unknown", "reason": f"incremental_orb_error:{str(e)}"}

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


def get_orb_fallback_topk(image_bgr, top_k=3):
    """Returns top-k ORB-fallback card candidates as normalized scores in [0,1]."""
    if orb_fallback_net is None or not orb_fallback_class_to_card_id:
        return []

    try:
        crop_scales = [float(ORB_FOCUS_ROI_SCALE), 1.0]
        crop_scales = [s for i, s in enumerate(crop_scales) if s not in crop_scales[:i]]

        best_probs = None
        best_conf = -1.0

        for crop_scale in crop_scales:
            focused = crop_center_roi(image_bgr, scale=crop_scale)
            resized = cv2.resize(focused, ORB_INPUT_SIZE)
            rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32)

            input_variants = [
                np.expand_dims(rgb, axis=0),
                np.expand_dims(rgb / 255.0, axis=0),
                np.expand_dims((rgb / 127.5) - 1.0, axis=0),
            ]

            for candidate in input_variants:
                try:
                    orb_fallback_net.setInput(candidate)
                    raw = orb_fallback_net.forward().flatten()
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
            card_id = orb_fallback_class_to_card_id.get(class_index)
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
    """Hybrid top-k ranking using ORB and fallback confidence fusion."""
    gray_raw = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    blur_score = float(cv2.Laplacian(gray_raw, cv2.CV_64F).var())
    is_blurry = blur_score < 100

    orb_candidates = get_orb_topk(image_bgr, top_k=top_k)
    orb_fallback_candidates = get_orb_fallback_topk(image_bgr, top_k=top_k)

    # Weight fallback higher when blurry; ORB higher when not blurry.
    orb_weight = 0.35 if is_blurry else 0.55
    orb_fallback_weight = 0.65 if is_blurry else 0.45

    merged = {}

    for c in orb_candidates:
        card_id = c['card_id']
        merged[card_id] = merged.get(card_id, {
            'card_id': card_id,
            'orb_score': 0.0,
            'orb_fallback_score': 0.0,
            'matches': 0
        })
        merged[card_id]['orb_score'] = float(c['score'])
        merged[card_id]['matches'] = int(c.get('matches', 0))

    for c in orb_fallback_candidates:
        card_id = c['card_id']
        merged[card_id] = merged.get(card_id, {
            'card_id': card_id,
            'orb_score': 0.0,
            'orb_fallback_score': 0.0,
            'matches': 0
        })
        merged[card_id]['orb_fallback_score'] = float(c['score'])

    ranked = []
    for card_id, entry in merged.items():
        card = card_metadata.get(card_id)
        if not card:
            continue
        hybrid_score = entry['orb_score'] * orb_weight + entry['orb_fallback_score'] * orb_fallback_weight
        ranked.append({
            'card_id': card_id,
            'card_name': card['name'],
            'category_id': card['category_id'],
            'category': category_metadata.get(card['category_id']),
            'hybrid_score': round(float(hybrid_score), 4),
            'orb_score': round(float(entry['orb_score']), 4),
            'orb_fallback_score': round(float(entry['orb_fallback_score']), 4),
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
            'orb_fallback': orb_fallback_weight
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
        if is_blurry and orb_fallback_net is not None:
            orb_fallback_result = predict_waste_orb_fallback(image_bgr)
            if orb_fallback_result.get('status') == 'success':
                orb_fallback_result['response_time'] = round(response_time, 2)
                orb_fallback_result['blur_score'] = round(blur_score, 1)
                orb_fallback_result['is_blurry'] = is_blurry
                orb_fallback_result['classifier'] = 'orb_fallback'
                return orb_fallback_result
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

    # If image is blurry (or ORB confidence is low), give fallback a chance.
    if (is_blurry or orb_success_result is None) and orb_fallback_net is not None:
        orb_fallback_result = predict_waste_orb_fallback(image_bgr)
        if orb_fallback_result.get('status') == 'success':
            orb_fallback_result['response_time'] = round(response_time, 2)
            orb_fallback_result['blur_score'] = round(blur_score, 1)
            orb_fallback_result['is_blurry'] = is_blurry

            if orb_success_result is None:
                orb_fallback_result['classifier'] = 'orb_fallback'
                return orb_fallback_result

            if orb_success_result['card_id'] == orb_fallback_result['card_id']:
                merged_conf = round((orb_success_result['confidence'] + orb_fallback_result['confidence']) / 2.0, 2)
                orb_success_result['confidence'] = merged_conf
                orb_success_result['classifier'] = 'hybrid_consensus'
                return orb_success_result

            if orb_fallback_result['confidence'] >= orb_success_result['confidence'] + HYBRID_MARGIN:
                orb_fallback_result['classifier'] = 'hybrid_orb_fallback_override'
                return orb_fallback_result

            if orb_success_result['confidence'] >= orb_fallback_result['confidence'] + HYBRID_MARGIN:
                orb_success_result['classifier'] = 'hybrid_orb_override'
                return orb_success_result

            return {
                "status": "unknown",
                "reason": "hybrid_conflict",
                "blur_score": round(blur_score, 1),
                "is_blurry": is_blurry,
                "orb_card_id": orb_success_result['card_id'],
                "orb_confidence": orb_success_result['confidence'],
                "orb_fallback_card_id": orb_fallback_result['card_id'],
                "orb_fallback_confidence": orb_fallback_result['confidence'],
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
    """Main classification endpoint (fallback-only mode)."""
    try:
        start_time = datetime.now()
        file = request.files['image']
        img = decode_uploaded_image_to_bgr(file)
        
        if img is None:
            return jsonify({"status": "error", "message": "Invalid image"})
        
        # Dual-model routing: incremental model first, then base model fallback.
        # NOTE: We do not restrict the model's candidate space here; we enforce the
        # Learn Mode 10-card subset as a post-check below to avoid suppressing
        # confidence scores.
        result = predict_waste_incremental_orb(img)
        if result.get('status') != 'success':
            result = predict_waste_orb_fallback(img)

        response_time = (datetime.now() - start_time).total_seconds() * 1000
        result['response_time'] = round(response_time, 2)
        result['classifier'] = result.get('classifier', 'orb_fallback_only')
        
        # Don't auto-log in assessment mode - wait for user choice
        if current_session_id and result['status'] == 'success':
            # Auto-log for instructional mode only
            # Assessment mode will call /assessment/submit separately
            if current_session_mode == 'instructional':
                card_id = result.get('card_id')
                try:
                    card_id = int(card_id)
                except (TypeError, ValueError):
                    card_id = None

                with session_subset_lock:
                    scanned = current_session_scanned_card_ids

                    if card_id is not None and card_id in scanned:
                        return jsonify({
                            "status": "unknown",
                            "reason": "already_scanned",
                            "message": "Card already scanned in this session",
                            "card_id": card_id,
                            "card_name": result.get('card_name', ''),
                        })

                    if card_id is not None:
                        scanned.add(card_id)

                log_scan_transaction(result)
        
        return jsonify(result)
        
    except Exception as e:
        print(f"❌ Classification error: {e}")
        return jsonify({"status": "error", "message": str(e)})


@app.route('/classify/top3', methods=['POST'])
def classify_top3():
    """Returns top-3 fallback-only candidates."""
    try:
        file = request.files['image']
        npimg = np.fromfile(file, np.uint8)
        img = cv2.imdecode(npimg, cv2.IMREAD_COLOR)

        if img is None:
            return jsonify({"status": "error", "message": "Invalid image"})

        candidates = get_orb_fallback_topk(img, top_k=3)
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
                'orb_fallback_score': round(float(c['score']), 4)
            })

        result = {
            'status': 'success' if ranked else 'unknown',
            'classifier': 'orb_fallback_only',
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
        response_time_raw = data.get('response_time', 0)

        try:
            response_time = int(round(float(response_time_raw)))
        except (TypeError, ValueError):
            response_time = 0
        response_time = max(0, min(response_time, 600000))
        
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
                    %s, %s, NOW())"""
        
        cursor.execute(sql, (
            current_session_id,
            card_id,
            selected_category,
            correct_category,
            confidence,
            response_time
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
            "correct_category": correct_category,
            "response_time": response_time
        })
        
    except Exception as e:
        print(f"❌ Assessment submit error: {e}")
        return jsonify({"status": "error", "message": str(e)})

@app.route('/session/start', methods=['POST'])
def start_session():
    """Start a new student session"""
    global current_session_id, current_session_mode
    global current_session_subset_card_ids, current_session_scanned_card_ids
    
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

        # Learn Mode protocol: enforce no-repeat scans within the session.
        with session_subset_lock:
            if mode == 'instructional':
                current_session_subset_card_ids = set()
            else:
                current_session_subset_card_ids = set()
            current_session_scanned_card_ids = set()
        
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
    global current_session_subset_card_ids, current_session_scanned_card_ids
    
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

        with session_subset_lock:
            current_session_subset_card_ids = set()
            current_session_scanned_card_ids = set()
        
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

@app.route('/tutorial/should-show', methods=['POST'])
def tutorial_should_show():
    """Return whether tutorial should be shown for nickname + mode based on DB history."""
    try:
        data = request.json or {}
        nickname = str(data.get('nickname', '')).strip()
        mode = str(data.get('mode', 'instructional')).strip()
        current_session_id = data.get('current_session_id')

        if not nickname:
            return jsonify({"status": "success", "should_show": False})

        conn = connect_db()
        cursor = conn.cursor()

        query = """
            SELECT COUNT(*)
            FROM TBL_SESSIONS
            WHERE student_nickname = %s
              AND session_mode = %s
              AND session_status != 'admin_preset'
        """
        params = [nickname, mode]

        if current_session_id is not None:
            query += " AND session_id != %s"
            params.append(current_session_id)

        cursor.execute(query, tuple(params))
        row = cursor.fetchone()
        prior_sessions = int(row[0]) if row and row[0] is not None else 0

        cursor.close()
        conn.close()

        return jsonify({
            "status": "success",
            "should_show": prior_sessions == 0,
            "prior_sessions": prior_sessions
        })
    except Exception as e:
        print(f"❌ Tutorial should-show error: {e}")
        return jsonify({"status": "error", "message": str(e), "should_show": False})

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
        "orb_fallback_loaded": orb_fallback_net is not None,
        "orb_fallback_classes": len(orb_fallback_class_to_card_id),
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
        ensure_system_config_defaults()
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
    global ORB_CONFIDENCE_THRESHOLD, ORB_INCREMENTAL_CONFIDENCE_THRESHOLD, ORB_FOCUS_ROI_SCALE, HYBRID_MARGIN
    
    try:
        ensure_system_config_defaults()
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
                COALESCE(SUM(total_scans), 0) as total_scans,
                COALESCE(SUM(correct_scans), 0) as total_correct,
                ROUND((COALESCE(SUM(correct_scans), 0) * 100.0) / NULLIF(COALESCE(SUM(total_scans), 0), 0), 1) as proficiency_score,
                MAX(accuracy_percentage) as best_accuracy,
                MAX(end_time) as last_session
            FROM TBL_SESSIONS
            WHERE session_status = 'completed'
            AND student_nickname != 'Guest'
            AND session_mode = 'assessment'
            GROUP BY student_nickname
            ORDER BY proficiency_score DESC, total_correct DESC, total_scans DESC
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
                "proficiency_score": student['proficiency_score'] or 0,
                "avg_accuracy": student['proficiency_score'] or 0,
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


@app.route('/admin/proficiency-reports', methods=['GET'])
def get_proficiency_reports():
    """Student proficiency reports endpoint for Objective 1e Admin page."""
    try:
        reports, summary = _collect_proficiency_reports()

        return jsonify({
            "status": "success",
            "reports": reports,
            "summary": summary,
        })
    except Exception as e:
        print(f"❌ Proficiency reports error: {e}")
        return jsonify({"status": "error", "message": str(e)})


def _collect_proficiency_reports():
    conn = connect_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute(
        """
        SELECT
            student_nickname,
            COUNT(*) AS total_sessions,
            SUM(total_scans) AS total_scans,
            SUM(correct_scans) AS total_correct,
            ROUND(AVG(accuracy_percentage), 1) AS avg_accuracy,
            MAX(accuracy_percentage) AS best_accuracy,
            COALESCE(MAX(end_time), MAX(start_time)) AS last_session,
            SUM(CASE WHEN session_status = 'active' THEN 1 ELSE 0 END) AS in_progress_sessions
        FROM TBL_SESSIONS
        WHERE session_status IN ('completed', 'active')
          AND session_mode = 'assessment'
          AND student_nickname IS NOT NULL
          AND student_nickname NOT IN ('', 'Guest')
        GROUP BY student_nickname
        ORDER BY avg_accuracy DESC, total_scans DESC
        """
    )

    rows = cursor.fetchall()
    cursor.close()
    conn.close()

    reports = []
    for idx, row in enumerate(rows, 1):
        reports.append({
            "rank": idx,
            "nickname": row['student_nickname'],
            "sessions": int(row['total_sessions'] or 0),
            "total_scans": int(row['total_scans'] or 0),
            "correct": int(row['total_correct'] or 0),
            "avg_accuracy": float(row['avg_accuracy'] or 0),
            "best_accuracy": float(row['best_accuracy'] or 0),
            "last_session": row['last_session'].strftime("%Y-%m-%d") if row['last_session'] else "N/A",
            "in_progress_sessions": int(row['in_progress_sessions'] or 0),
        })

    total_students = len(reports)
    summary = {
        "total_students": total_students,
        "total_sessions": sum(r['sessions'] for r in reports),
        "total_scans": sum(r['total_scans'] for r in reports),
        "average_accuracy": round((sum(r['avg_accuracy'] for r in reports) / total_students) if total_students else 0.0, 2),
    }
    return reports, summary


def _pdf_escape_text(text: str) -> str:
    return str(text).replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')


def _build_minimal_proficiency_pdf(reports, summary):
    # Minimal single-page PDF fallback (A4 landscape-ish content area)
    lines = []
    lines.append('BT /F1 16 Tf 40 560 Td (EcoLearn Student Proficiency Report) Tj ET')
    lines.append(f"BT /F1 10 Tf 40 542 Td ({_pdf_escape_text('Generated: ' + datetime.now().strftime('%Y-%m-%d %H:%M:%S'))}) Tj ET")
    summary_text = (
        f"Students: {summary['total_students']}   Sessions: {summary['total_sessions']}   "
        f"Total Scans: {summary['total_scans']}   Avg Accuracy: {summary['average_accuracy']}%"
    )
    lines.append(f"BT /F1 10 Tf 40 526 Td ({_pdf_escape_text(summary_text)}) Tj ET")

    header = '#   Nickname                  Sessions  Scans  Correct  Avg%  Best%  Last Session'
    lines.append(f"BT /F1 9 Tf 40 505 Td ({_pdf_escape_text(header)}) Tj ET")

    y = 490
    for row in reports[:28]:
        row_text = (
            f"{str(row['rank']).ljust(3)} {str(row['nickname'])[:24].ljust(24)} "
            f"{str(row['sessions']).rjust(8)} {str(row['total_scans']).rjust(6)} "
            f"{str(row['correct']).rjust(8)} {str(row['avg_accuracy']).rjust(5)}% "
            f"{str(row['best_accuracy']).rjust(5)}% {str(row['last_session'])}"
        )
        lines.append(f"BT /F1 9 Tf 40 {y} Td ({_pdf_escape_text(row_text)}) Tj ET")
        y -= 14

    if not reports:
        lines.append('BT /F1 10 Tf 40 470 Td (No proficiency data available yet.) Tj ET')

    stream = '\n'.join(lines).encode('latin-1', 'replace')

    objects = []
    objects.append(b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n")
    objects.append(b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n")
    objects.append(b"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n")
    objects.append(b"4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n")
    objects.append(
        b"5 0 obj << /Length " + str(len(stream)).encode('ascii') + b" >> stream\n" + stream + b"\nendstream endobj\n"
    )

    pdf = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for obj in objects:
        offsets.append(len(pdf))
        pdf.extend(obj)

    xref_start = len(pdf)
    pdf.extend(f"xref\n0 {len(offsets)}\n".encode('ascii'))
    pdf.extend(b"0000000000 65535 f \n")
    for off in offsets[1:]:
        pdf.extend(f"{off:010d} 00000 n \n".encode('ascii'))

    pdf.extend(
        f"trailer << /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref_start}\n%%EOF".encode('ascii')
    )
    return bytes(pdf)


@app.route('/admin/proficiency-reports/pdf', methods=['GET'])
def export_proficiency_reports_pdf():
    """Generate printable student proficiency report as PDF."""
    try:
        reports, summary = _collect_proficiency_reports()

        pdf_bytes = None
        try:
            import importlib
            pagesizes = importlib.import_module('reportlab.lib.pagesizes')
            canvas_module = importlib.import_module('reportlab.pdfgen.canvas')
            A4 = pagesizes.A4
            landscape = pagesizes.landscape
            rl_canvas = canvas_module

            buffer = io.BytesIO()
            pdf = rl_canvas.Canvas(buffer, pagesize=landscape(A4))
            page_width, page_height = landscape(A4)

            def draw_header(y):
                pdf.setFont("Helvetica-Bold", 14)
                pdf.drawString(36, y, "EcoLearn Student Proficiency Report")
                pdf.setFont("Helvetica", 10)
                pdf.drawString(36, y - 14, f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
                pdf.drawString(36, y - 28, f"Students: {summary['total_students']}   Sessions: {summary['total_sessions']}   Total Scans: {summary['total_scans']}   Avg Accuracy: {summary['average_accuracy']}%")

            columns = [
                ("#", 24),
                ("Nickname", 170),
                ("Sessions", 60),
                ("Scans", 55),
                ("Correct", 55),
                ("Avg%", 55),
                ("Best%", 55),
                ("Last Session", 80),
                ("In Progress", 75),
            ]

            x0 = 36
            y = page_height - 48
            draw_header(y)
            y -= 52

            def draw_table_header(y_pos):
                pdf.setFont("Helvetica-Bold", 9)
                x = x0
                for name, width in columns:
                    pdf.drawString(x, y_pos, name)
                    x += width
                pdf.line(x0, y_pos - 3, x0 + sum(w for _, w in columns), y_pos - 3)

            draw_table_header(y)
            y -= 16

            pdf.setFont("Helvetica", 9)
            for row in reports:
                if y < 44:
                    pdf.showPage()
                    y = page_height - 48
                    draw_header(y)
                    y -= 52
                    draw_table_header(y)
                    y -= 16
                    pdf.setFont("Helvetica", 9)

                values = [
                    str(row['rank']),
                    str(row['nickname'])[:35],
                    str(row['sessions']),
                    str(row['total_scans']),
                    str(row['correct']),
                    f"{row['avg_accuracy']}%",
                    f"{row['best_accuracy']}%",
                    str(row['last_session']),
                    str(row['in_progress_sessions']),
                ]

                x = x0
                for (value, (_, width)) in zip(values, columns):
                    pdf.drawString(x, y, value)
                    x += width
                y -= 14

            if not reports:
                pdf.setFont("Helvetica", 10)
                pdf.drawString(x0, y, "No proficiency data available yet.")

            pdf.save()
            pdf_bytes = buffer.getvalue()
            buffer.close()
        except Exception:
            pdf_bytes = _build_minimal_proficiency_pdf(reports, summary)

        filename = f"EcoLearn_Student_Proficiency_Report_{datetime.now().strftime('%Y-%m-%d')}.pdf"
        return Response(
            pdf_bytes,
            mimetype='application/pdf',
            headers={
                'Content-Disposition': f'attachment; filename={filename}',
                'Content-Length': str(len(pdf_bytes)),
            },
        )
    except Exception as e:
        print(f"❌ Proficiency PDF export error: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500

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
        
        # Decode once: keep alpha for saved card assets, convert separately for ML features.
        file = request.files['image']
        img_saved = decode_uploaded_image_keep_alpha(file)
        img = to_bgr_for_ml(img_saved)
        
        if img is None or img_saved is None:
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
            cv2.imwrite(png_full_path, img_saved, [cv2.IMWRITE_PNG_COMPRESSION, 1])
            print(f"📸 Saved training PNG: {png_full_path}")
            
            # Convert and save WebP (optimized for display)
            cv2.imwrite(webp_full_path, img_saved, [cv2.IMWRITE_WEBP_QUALITY, 85])
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
                card_metadata[card_id]['image_path'] = webp_db_path
            
            conn.commit()
            cursor.close()
            conn.close()
            
            print(f"✅ Card updated: {card_name} | Features: {len(kp)} | PNG: {png_db_path} | WebP: {webp_db_path}")

            variants_generated = 0
            retrain_started = False
            retrain_msg = 'ORB retraining was not started'
            pipeline_warning = None
            try:
                variants_dir = os.path.join(base_dir, 'assets_variants', category_folder)
                variants_generated = generate_variants_for_card(png_full_path, variants_dir, safe_name)
                retrain_started, retrain_msg = maybe_start_orb_retrain(
                    trigger='card_replace',
                    card_id=card_id,
                    card_name=card_name,
                )
            except Exception as pipeline_err:
                pipeline_warning = f"Card updated, but pipeline failed: {pipeline_err}"
                print(f"⚠️ {pipeline_warning}")
            
            return jsonify({
                "status": "success",
                "message": f"Card '{card_name}' updated successfully",
                "card_id": card_id,
                "card_code": card_code,
                "features_extracted": len(kp),
                "variants_generated": variants_generated,
                "png_path": png_db_path,
                "webp_path": webp_db_path,
                "image_path": webp_db_path,  # For display
                "orb_retrain_started": retrain_started,
                "orb_retrain_message": retrain_msg,
                "orb_retrain_status_url": "/admin/orb-training-status",
                "pipeline_warning": pipeline_warning,
            })
            
        else:
            # Create new card
            card_code = f"{safe_name[:3].upper()}{datetime.now().strftime('%H%M%S')}"
            
            # Save PNG (high quality for training)
            cv2.imwrite(png_full_path, img_saved, [cv2.IMWRITE_PNG_COMPRESSION, 1])
            print(f"📸 Saved training PNG: {png_full_path}")
            
            # Convert and save WebP (optimized for display)
            cv2.imwrite(webp_full_path, img_saved, [cv2.IMWRITE_WEBP_QUALITY, 85])
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
                'category_id': int(category_id),
                'image_path': webp_db_path
            }
            
            cursor.close()
            conn.close()
            
            print(f"✅ New card registered: {card_name} | Features: {len(kp)} | PNG: {png_db_path} | WebP: {webp_db_path}")

            variants_generated = 0
            retrain_started = False
            retrain_msg = 'ORB retraining was not started'
            pipeline_warning = None
            try:
                variants_dir = os.path.join(base_dir, 'assets_variants', category_folder)
                variants_generated = generate_variants_for_card(png_full_path, variants_dir, safe_name)
                retrain_started, retrain_msg = maybe_start_orb_retrain(
                    trigger='card_add',
                    card_id=new_card_id,
                    card_name=card_name,
                )
            except Exception as pipeline_err:
                pipeline_warning = f"Card added, but pipeline failed: {pipeline_err}"
                print(f"⚠️ {pipeline_warning}")
            
            return jsonify({
                "status": "success",
                "message": f"Card '{card_name}' registered successfully via One-Shot Learning",
                "card_id": new_card_id,
                "card_code": card_code,
                "features_extracted": len(kp),
                "variants_generated": variants_generated,
                "png_path": png_db_path,
                "webp_path": webp_db_path,
                "image_path": webp_db_path,  # For display
                "orb_retrain_started": retrain_started,
                "orb_retrain_message": retrain_msg,
                "orb_retrain_status_url": "/admin/orb-training-status",
                "pipeline_warning": pipeline_warning,
            })
        
    except Exception as e:
        print(f"❌ One-shot learning error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)})


@app.route('/admin/orb-training-status', methods=['GET'])
def orb_training_status():
    """Returns latest ORB retraining job state for Admin UI polling."""
    return jsonify({
        "status": "success",
        "training": get_training_status_snapshot(),
    })


@app.route('/admin/orb-retrain', methods=['POST'])
def admin_trigger_orb_retrain():
    """Manual retrain trigger for Admin tools."""
    started, msg = maybe_start_orb_retrain(
        trigger='manual_admin',
        card_id=None,
        card_name=None,
    )
    return jsonify({
        "status": "success" if started else "busy",
        "message": msg,
        "training": get_training_status_snapshot(),
    })

@app.route('/admin/cards/<int:card_id>', methods=['DELETE'])
def delete_card(card_id):
    """Soft-delete a card: deactivate it and remove from the recognition dataset.
    Soft-delete preserves foreign-key integrity with TBL_SCAN_TRANSACTIONS."""
    try:
        conn = connect_db()
        cursor = conn.cursor()

        # Fetch card info
        cursor.execute("""
            SELECT ca.card_name, ca.image_path, ca.image_filename
            FROM TBL_CARD_ASSETS ca
            WHERE ca.card_id = %s AND ca.is_active = 1
        """, (card_id,))
        card = cursor.fetchone()

        if not card:
            cursor.close()
            conn.close()
            return jsonify({"status": "error", "message": "Card not found or already deleted"})

        card_name, image_path, image_filename = card

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

            # Remove all generated variants for this card.
            # Match by stems from DB image filename/path and sanitized card name.
            path_obj = Path(image_path)
            category_folder = path_obj.parent.name if path_obj.parent else ''
            variants_dir = Path(base_dir) / 'assets_variants' / category_folder

            stem_candidates = set()
            if path_obj.stem:
                stem_candidates.add(path_obj.stem)
            if image_filename:
                stem_candidates.add(Path(image_filename).stem)

            safe_name = card_name.replace(' ', '_').replace('-', '_')
            safe_name = ''.join(c for c in safe_name if c.isalnum() or c == '_')
            if safe_name:
                stem_candidates.add(safe_name)

            removed_variants = 0
            if variants_dir.exists() and stem_candidates:
                variant_exts = {'.png', '.jpg', '.jpeg', '.webp', '.bmp'}
                for stem in stem_candidates:
                    for p in variants_dir.glob(f"{stem}__*"):
                        try:
                            if p.is_file() and p.suffix.lower() in variant_exts:
                                p.unlink()
                                removed_variants += 1
                        except Exception:
                            continue

            if removed_variants > 0:
                print(f"🗑️ Removed variants: {removed_variants} file(s) for card stem(s) {sorted(stem_candidates)}")

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
    # Don't aggressively cache admin dashboard scripts; they change often.
    elif request.path.startswith('/js/admin'):
        response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    # Cache static files aggressively
    elif request.path.endswith(('.css', '.js', '.png', '.jpg', '.jpeg', '.webp', '.gif')):
        response.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
    return response

if __name__ == '__main__':
    print("🚀 Starting EcoLearn Recognition Engine...")
    print("📦 Gzip compression: ENABLED")
    print("🖼️  Image caching: 1 YEAR")
    if load_model():
        load_runtime_config_from_db()
        maybe_auto_run_training_if_needed()
        ensure_default_orb_model_assets()
        load_orb_model()
        load_incremental_orb_model()
        print("✅ System Ready!")
        app.run(host='0.0.0.0', port=5000, debug=True)
    else:
        print("❌ Failed to start - Model loading error")