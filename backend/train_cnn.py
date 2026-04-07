"""
train_cnn.py
------------
Fine-tune an EcoLearn CNN model using MobileNetV2 (ImageNet weights),
then export ONNX + label map.

Workflow:
1) Read active cards from DB.
2) Build per-card training samples from assets_variants (fallback: assets_png).
3) Fine-tune MobileNetV2 in two phases:
   a) Head-only warm-up  (backbone frozen)
   b) Full fine-tune     (backbone unfrozen, BN layers frozen)
4) Export updated .h5, .onnx, and models/waste_labels.txt mapping.

Key changes vs. previous version:
- Uses tf.keras.applications.MobileNetV2 directly (ImageNet weights guaranteed).
- Preprocessing uses the official mobilenet_v2.preprocess_input (→ [-1, 1]).
- Head is grafted with GlobalAveragePooling2D + Dropout, not a fragile layer-index hack.
- Data augmentation added to training pipeline.
- Architecture is logged to the manifest for traceability.
"""

from __future__ import annotations

import argparse
import json
import random
import os
import sys
from datetime import datetime
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import mysql.connector
import numpy as np
import tensorflow as tf
import tf2onnx
import cv2

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DB_CONFIG = {
    "host": "localhost",
    "user": "root",
    "password": "",
    "database": "ecolearn_db",
}

VALID_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
# tf.io.decode_image in this environment does not support WebP reliably.
TF_DECODABLE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp", ".gif"}

# MobileNetV2 expects 224x224 by default; override with --img-size if needed.
MOBILENET_DEFAULT_SIZE = 224

AUTOTUNE = tf.data.AUTOTUNE


class TeeStream:
    """Writes output to both console and file."""

    def __init__(self, *streams):
        self.streams = streams

    def write(self, data):
        for s in self.streams:
            s.write(data)
        return len(data)

    def flush(self):
        for s in self.streams:
            s.flush()


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class CardRow:
    card_id: int
    card_name: str
    category_name: str
    image_filename: str
    image_path: str


@dataclass
class DatasetBundle:
    train_paths: list[str]
    train_labels: list[int]
    val_paths: list[str]
    val_labels: list[int]
    class_names: list[str]
    class_to_card_id: list[int]


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

def connect_db():
    return mysql.connector.connect(**DB_CONFIG)


def load_active_cards(include_card_ids: set[int] | None = None) -> list[CardRow]:
    conn = connect_db()
    cursor = conn.cursor(dictionary=True)
    if include_card_ids:
        placeholders = ",".join(["%s"] * len(include_card_ids))
        sql = f"""
            SELECT ca.card_id, ca.card_name, ca.image_filename, c.category_name
                   , ca.image_path
            FROM TBL_CARD_ASSETS ca
            JOIN TBL_CATEGORIES c ON c.category_id = ca.category_id
            WHERE ca.is_active = 1 AND ca.card_id IN ({placeholders})
            ORDER BY ca.card_id
        """
        cursor.execute(sql, tuple(sorted(include_card_ids)))
    else:
        cursor.execute(
            """
            SELECT ca.card_id, ca.card_name, ca.image_filename, c.category_name
                   , ca.image_path
            FROM TBL_CARD_ASSETS ca
            JOIN TBL_CATEGORIES c ON c.category_id = ca.category_id
            WHERE ca.is_active = 1
            ORDER BY ca.card_id
            """
        )
    rows = cursor.fetchall()
    cursor.close()
    conn.close()

    return [
        CardRow(
            card_id=int(row["card_id"]),
            card_name=str(row["card_name"]),
            category_name=str(row["category_name"]),
            image_filename=str(row["image_filename"]),
            image_path=str(row.get("image_path") or ""),
        )
        for row in rows
    ]


# ---------------------------------------------------------------------------
# File discovery
# ---------------------------------------------------------------------------

def make_stem_candidates(card: CardRow) -> list[str]:
    filename_stem = Path(card.image_filename).stem
    card_name_underscore = card.card_name.replace(" ", "_")
    card_name_safe = "".join(
        ch for ch in card_name_underscore if ch.isalnum() or ch == "_"
    )
    seen: set[str] = set()
    out: list[str] = []
    for c in [filename_stem, card_name_underscore, card_name_safe]:
        if c and c not in seen:
            seen.add(c)
            out.append(c)
    return out


def find_card_samples(card: CardRow, variants_root: Path, png_root: Path, project_root: Path) -> list[Path]:
    category_dir = variants_root / card.category_name
    files: list[Path] = []

    if category_dir.exists():
        for stem in make_stem_candidates(card):
            for p in category_dir.glob(f"{stem}__*"):
                if p.is_file() and p.suffix.lower() in TF_DECODABLE_EXTENSIONS:
                    files.append(p)

    if files:
        return sorted(set(files))

    # Fallback: single PNG from assets_png.
    png_category_dir = png_root / card.category_name
    for stem in make_stem_candidates(card):
        p = png_category_dir / f"{stem}.png"
        if p.exists():
            return [p]

    # Fallback: use exact DB image_path only if TensorFlow can decode it.
    if card.image_path:
        db_file = (project_root / card.image_path).resolve()
        if (
            db_file.exists()
            and db_file.is_file()
            and db_file.suffix.lower() in TF_DECODABLE_EXTENSIONS
        ):
            return [db_file]

        # Try equivalent assets_png path when DB points to assets/ filename.
        if card.image_path.startswith("assets/"):
            png_rel = card.image_path.replace("assets/", "assets_png/", 1)
            png_rel = str(Path(png_rel).with_suffix(".png"))
            db_png_file = (project_root / png_rel).resolve()
            if db_png_file.exists() and db_png_file.is_file() and db_png_file.suffix.lower() in VALID_EXTENSIONS:
                return [db_png_file]

    return []


# ---------------------------------------------------------------------------
# Dataset splitting
# ---------------------------------------------------------------------------

def stratified_split(
    file_paths: list[str],
    labels: list[int],
    val_ratio: float,
    seed: int,
) -> tuple[list[str], list[int], list[str], list[int]]:
    rng = random.Random(seed)
    by_class: dict[int, list[str]] = {}
    for p, y in zip(file_paths, labels):
        by_class.setdefault(y, []).append(p)

    train_paths, train_labels, val_paths, val_labels = [], [], [], []

    for cls, cls_paths in by_class.items():
        cls_paths = cls_paths[:]
        rng.shuffle(cls_paths)

        if len(cls_paths) <= 1:
            train_paths.extend(cls_paths)
            train_labels.extend([cls] * len(cls_paths))
        else:
            n_val = max(1, min(int(round(len(cls_paths) * val_ratio)), len(cls_paths) - 1))
            val_paths.extend(cls_paths[:n_val])
            val_labels.extend([cls] * n_val)
            train_paths.extend(cls_paths[n_val:])
            train_labels.extend([cls] * (len(cls_paths) - n_val))

    return train_paths, train_labels, val_paths, val_labels


def class_weights_from_labels(labels: Iterable[int]) -> dict[int, float]:
    counts = Counter(labels)
    total = sum(counts.values())
    n_classes = len(counts)
    return {cls: float(total / (n_classes * cnt)) for cls, cnt in counts.items()}


def is_valid_training_image(path: Path) -> bool:
    """Fast sanity check to reject empty/corrupted files before tf.data."""
    try:
        if not path.exists() or not path.is_file():
            return False
        if path.suffix.lower() not in TF_DECODABLE_EXTENSIONS:
            return False
        if path.stat().st_size <= 0:
            return False

        raw = np.fromfile(str(path), dtype=np.uint8)
        if raw.size == 0:
            return False
        img = cv2.imdecode(raw, cv2.IMREAD_COLOR)
        return img is not None and img.size > 0
    except Exception:
        return False


# ---------------------------------------------------------------------------
# TF preprocessing  — uses the OFFICIAL MobileNetV2 preprocess_input
# Input pixels are uint8 [0,255]; output is float32 in [-1, 1].
# ---------------------------------------------------------------------------

def preprocess_image(path: tf.Tensor, label: tf.Tensor, img_size: int):
    data = tf.io.read_file(path)
    img = tf.io.decode_image(data, channels=3, expand_animations=False)
    img = tf.image.resize(img, [img_size, img_size], method=tf.image.ResizeMethod.BILINEAR)
    img = tf.cast(img, tf.float32)
    # Official MobileNetV2 preprocessor: scales to [-1, 1]
    img = tf.keras.applications.mobilenet_v2.preprocess_input(img)
    return img, label


# Instantiated once at module level; reused by every augment_image call.
# Creating Keras layers inside a tf.data.map lambda causes retracing overhead.
_random_rotation = tf.keras.layers.RandomRotation(factor=0.042)  # ±15°


def augment_image(img: tf.Tensor, label: tf.Tensor) -> tuple[tf.Tensor, tf.Tensor]:
    """Light augmentation applied only during training."""
    img = tf.image.random_flip_left_right(img)
    img = tf.image.random_flip_up_down(img)
    # Brightness / contrast shifts stay within MobileNet's [-1, 1] range.
    img = tf.image.random_brightness(img, max_delta=0.15)
    img = tf.image.random_contrast(img, lower=0.8, upper=1.2)
    img = tf.clip_by_value(img, -1.0, 1.0)
    # Random rotation ±15° — layer reused, not re-instantiated per call.
    img = tf.expand_dims(img, 0)
    img = _random_rotation(img, training=True)
    img = tf.squeeze(img, 0)
    return img, label


def build_tf_dataset(
    paths: list[str],
    labels: list[int],
    img_size: int,
    batch_size: int,
    training: bool,
    apply_augmentation: bool,
) -> tf.data.Dataset:
    ds = tf.data.Dataset.from_tensor_slices((paths, labels))

    if training:
        ds = ds.shuffle(buffer_size=max(256, len(paths)), reshuffle_each_iteration=True)

    ds = ds.map(
        lambda p, y: preprocess_image(p, y, img_size=img_size),
        num_parallel_calls=AUTOTUNE,
    )

    # Keep training running even if a late bad file slips through.
    ds = ds.apply(tf.data.experimental.ignore_errors())

    if training and apply_augmentation:
        ds = ds.map(augment_image, num_parallel_calls=AUTOTUNE)

    return ds.batch(batch_size).prefetch(AUTOTUNE)


# ---------------------------------------------------------------------------
# Dataset bundle
# ---------------------------------------------------------------------------

def build_dataset_bundle(
    cards: list[CardRow],
    variants_root: Path,
    png_root: Path,
    project_root: Path,
    val_ratio: float,
    seed: int,
    max_samples_per_class: int | None = None,
    focus_card_id: int | None = None,
    focus_max_samples: int | None = None,
) -> DatasetBundle:
    class_names: list[str] = []
    class_to_card_id: list[int] = []
    all_paths: list[str] = []
    all_labels: list[int] = []
    missing_cards: list[CardRow] = []

    for class_idx, card in enumerate(cards):
        class_names.append(card.card_name)
        class_to_card_id.append(card.card_id)

        samples = find_card_samples(
            card,
            variants_root=variants_root,
            png_root=png_root,
            project_root=project_root,
        )
        if not samples:
            missing_cards.append(card)
            continue

        valid_all = [p for p in samples if is_valid_training_image(p)]
        if not valid_all:
            missing_cards.append(card)
            continue

        invalid_count = len(samples) - len(valid_all)
        valid_samples = valid_all[:]

        # Speed-up mode: cap per-class samples for older cards while keeping
        # full (or separately capped) samples for the newly added focus card.
        cap: int | None = max_samples_per_class
        if focus_card_id is not None and card.card_id == focus_card_id:
            cap = focus_max_samples

        if cap is not None and cap > 0 and len(valid_samples) > cap:
            rng = random.Random(seed ^ card.card_id)
            valid_samples = sorted(rng.sample(valid_samples, cap))
            print(f"[info] sampled {cap} files for card '{card.card_name}'")

        sampled_out = len(valid_all) - len(valid_samples)
        if invalid_count > 0:
            print(f"[warn] invalid files={invalid_count} for card '{card.card_name}'")
        if sampled_out > 0:
            print(f"[info] sampled_out={sampled_out} for card '{card.card_name}'")

        for p in valid_samples:
            all_paths.append(str(p))
            all_labels.append(class_idx)

    if missing_cards:
        names = ", ".join(f"{c.card_name}(id={c.card_id})" for c in missing_cards[:8])
        extra = f" ... +{len(missing_cards) - 8} more" if len(missing_cards) > 8 else ""
        raise RuntimeError(
            "Missing training images for active cards. "
            "Generate variants first or ensure assets_png exists. "
            f"Examples: {names}{extra}"
        )

    if not all_paths:
        raise RuntimeError("No training samples found.")

    train_paths, train_labels, val_paths, val_labels = stratified_split(
        all_paths, all_labels, val_ratio=val_ratio, seed=seed
    )

    return DatasetBundle(
        train_paths=train_paths,
        train_labels=train_labels,
        val_paths=val_paths,
        val_labels=val_labels,
        class_names=class_names,
        class_to_card_id=class_to_card_id,
    )


# ---------------------------------------------------------------------------
# Model — MobileNetV2 with a proper classification head
# ---------------------------------------------------------------------------

def build_mobilenet_model(
    num_classes: int,
    img_size: int,
    dropout_rate: float = 0.3,
    weights_path: str | None = None,
) -> tf.keras.Model:
    """
    Build a MobileNetV2 transfer-learning model.

    Architecture:
        MobileNetV2 backbone (ImageNet weights, top excluded)
        → GlobalAveragePooling2D
        → Dropout(dropout_rate)
        → Dense(num_classes, softmax)   ← EcoLearn classification head

    weights_path: optional path to a locally cached MobileNetV2 .h5 weights file.
    Falls back to downloading "imagenet" weights if not provided, but will raise
    a clear error on offline machines rather than a cryptic connection failure.
    """
    if weights_path:
        weights: str | None = weights_path
        print(f"[backbone] Loading weights from local path: {weights_path}")
    else:
        weights = "imagenet"
        print("[backbone] Downloading ImageNet weights (requires internet access).")
        print("           To run offline, download weights manually and pass --imagenet-weights-path.")

    def _build_backbone():
        return tf.keras.applications.MobileNetV2(
            input_shape=(img_size, img_size, 3),
            include_top=False,
            weights=weights,
        )

    try:
        backbone = _build_backbone()
    except Exception as exc:
        # Common issue on Windows: interrupted download leaves truncated cache file.
        if weights == "imagenet" and ("truncated file" in str(exc).lower() or "unable to synchronously open file" in str(exc).lower()):
            try:
                keras_cache = os.path.join(os.path.expanduser("~"), ".keras", "models")
                cache_file = os.path.join(
                    keras_cache,
                    f"mobilenet_v2_weights_tf_dim_ordering_tf_kernels_1.0_{img_size}_no_top.h5",
                )
                if os.path.exists(cache_file):
                    os.remove(cache_file)
                    print(f"[warn] removed corrupted ImageNet cache file: {cache_file}")
                backbone = _build_backbone()
            except Exception:
                raise RuntimeError(
                    "Failed to load MobileNetV2 weights after cache repair. "
                    "On offline machines, download the weights file from:\n"
                    "  https://storage.googleapis.com/tensorflow/keras-applications/mobilenet_v2/\n"
                    "Then pass: --imagenet-weights-path /path/to/mobilenet_v2_weights.h5\n"
                    f"Original error: {exc}"
                ) from exc
        else:
            raise RuntimeError(
                "Failed to load MobileNetV2 weights. "
                "On offline machines, download the weights file from:\n"
                "  https://storage.googleapis.com/tensorflow/keras-applications/mobilenet_v2/\n"
                "Then pass: --imagenet-weights-path /path/to/mobilenet_v2_weights.h5\n"
                f"Original error: {exc}"
            ) from exc

    backbone.trainable = False      # freeze for head-only warm-up phase

    inputs = tf.keras.Input(shape=(img_size, img_size, 3), name="input")
    x = backbone(inputs, training=False)
    x = tf.keras.layers.GlobalAveragePooling2D(name="gap")(x)
    x = tf.keras.layers.Dropout(dropout_rate, name="dropout")(x)
    outputs = tf.keras.layers.Dense(num_classes, activation="softmax", name="ecolearn_head")(x)

    return tf.keras.Model(inputs=inputs, outputs=outputs, name="ecolearn_mobilenetv2")


def get_backbone(model: tf.keras.Model) -> tf.keras.Model:
    """
    Return the MobileNetV2 backbone sub-model regardless of its Keras-assigned
    name. Keras names the backbone after the input size (e.g. 'mobilenetv2_1.00_224'
    for 224px, 'mobilenetv2_1.00_192' for 192px), so a hardcoded string breaks
    when --img-size differs from the default. We locate it by type instead.
    """
    for layer in model.layers:
        if isinstance(layer, tf.keras.Model) and layer.name.startswith("mobilenetv2"):
            return layer
    raise RuntimeError(
        "Could not find MobileNetV2 backbone in model. "
        f"Layer names present: {[l.name for l in model.layers]}"
    )


def set_trainable_phase(model: tf.keras.Model, phase: str) -> None:
    """
    phase="head_only"  → backbone frozen, head trains.
    phase="fine_tune"  → full model trains, BatchNorm layers stay frozen
                         (updating BN stats on a small dataset causes instability).
    """
    backbone = get_backbone(model)

    if phase == "head_only":
        backbone.trainable = False
        return

    if phase == "fine_tune":
        backbone.trainable = True
        for layer in backbone.layers:
            if isinstance(layer, tf.keras.layers.BatchNormalization):
                layer.trainable = False
        return

    raise ValueError(f"Unknown trainable phase: {phase!r}")


def compile_model(model: tf.keras.Model, lr: float) -> None:
    model.compile(
        optimizer=tf.keras.optimizers.Adam(learning_rate=lr),
        loss=tf.keras.losses.SparseCategoricalCrossentropy(),
        metrics=["accuracy"],
    )


# ---------------------------------------------------------------------------
# Export helpers
# ---------------------------------------------------------------------------

def export_onnx(model: tf.keras.Model, out_onnx: Path, img_size: int) -> None:
    spec = (tf.TensorSpec((None, img_size, img_size, 3), tf.float32, name="input"),)
    onnx_model, _ = tf2onnx.convert.from_keras(model, input_signature=spec, opset=13)
    out_onnx.parent.mkdir(parents=True, exist_ok=True)
    out_onnx.write_bytes(onnx_model.SerializeToString())


def write_labels_map(path: Path, class_to_card_id: list[int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for class_idx, card_id in enumerate(class_to_card_id):
            f.write(f"{class_idx},{card_id}\n")


def write_training_manifest(
    path: Path,
    bundle: DatasetBundle,
    args_dict: dict,
    backbone_weights_source: str,
) -> None:
    payload = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "backbone": "MobileNetV2",
        "backbone_weights": backbone_weights_source,
        "class_count": len(bundle.class_names),
        "train_samples": len(bundle.train_paths),
        "val_samples": len(bundle.val_paths),
        "preprocessing": "mobilenet_v2.preprocess_input ([-1, 1])",
        "augmentation": ["random_flip_lr", "random_flip_ud", "random_brightness", "random_contrast", "random_rotation_15deg"],
        "class_to_card_id": [
            {
                "class_index": i,
                "card_id": int(card_id),
                "card_name": bundle.class_names[i],
            }
            for i, card_id in enumerate(bundle.class_to_card_id)
        ],
        "args": args_dict,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fine-tune MobileNetV2 for EcoLearn and export ONNX + labels."
    )
    parser.add_argument("--variants-dir", default=str(Path("..") / "assets_variants"))
    parser.add_argument("--png-dir",      default=str(Path("..") / "assets_png"))
    parser.add_argument("--out-keras",    default=str(Path("models") / "waste_mobilenet_finetuned.h5"))
    parser.add_argument("--out-onnx",     default=str(Path("models") / "waste_mobilenet.onnx"))
    parser.add_argument("--out-labels",   default=str(Path("models") / "waste_labels.txt"))
    parser.add_argument("--out-manifest", default=str(Path("models") / "training_manifest.json"))
    parser.add_argument("--img-size",        type=int,   default=MOBILENET_DEFAULT_SIZE)
    parser.add_argument("--batch-size",      type=int,   default=16)
    parser.add_argument("--head-epochs",     type=int,   default=6)
    parser.add_argument("--finetune-epochs", type=int,   default=8)
    parser.add_argument("--val-ratio",       type=float, default=0.15)
    parser.add_argument("--seed",            type=int,   default=42)
    parser.add_argument("--head-lr",         type=float, default=1e-3)
    parser.add_argument("--finetune-lr",     type=float, default=2e-4)
    parser.add_argument("--dropout",         type=float, default=0.3,
                        help="Dropout rate before the classification head.")
    parser.add_argument("--trainer-augment", action="store_true",
                        help="Apply additional random augmentation inside tf.data pipeline.")
    parser.add_argument("--max-samples-per-class", type=int, default=0,
                        help="Cap samples per class for faster retraining. 0 means no cap.")
    parser.add_argument("--focus-card-id", type=int, default=0,
                        help="Card ID to prioritize during incremental retraining.")
    parser.add_argument("--focus-max-samples", type=int, default=0,
                        help="Optional cap for focus card samples. 0 means no cap.")
    parser.add_argument("--imagenet-weights-path", default=None,
                        help="Path to a locally cached MobileNetV2 weights .h5 file. "
                             "Use this for offline/air-gapped machines. "
                             "If omitted, weights are downloaded from the internet.")
    parser.add_argument("--include-card-ids", default="",
                        help="Comma-separated card IDs to train on (incremental model mode).")
    parser.add_argument("--log-file", default=str(Path("models") / "cnn_retrain_last.log"),
                        help="Optional run log file path. Use empty string to disable.")
    args = parser.parse_args()

    # Reproducibility
    random.seed(args.seed)
    np.random.seed(args.seed)
    tf.random.set_seed(args.seed)

    root = Path(__file__).resolve().parent
    variants_dir = (root / args.variants_dir).resolve()
    png_dir      = (root / args.png_dir).resolve()
    out_keras    = (root / args.out_keras).resolve()
    out_onnx     = (root / args.out_onnx).resolve()
    out_labels   = (root / args.out_labels).resolve()
    out_manifest = (root / args.out_manifest).resolve()

    # If run manually from terminal, mirror output into log file as well.
    # When run from app.py, stdout is already redirected to the same file.
    if args.log_file:
        out_log = (root / args.log_file).resolve()
        out_log.parent.mkdir(parents=True, exist_ok=True)
        if sys.stdout.isatty() and sys.stderr.isatty():
            log_handle = open(out_log, 'w', encoding='utf-8')
            log_handle.write(f"[{datetime.now().isoformat(timespec='seconds')}] Starting train_cnn.py\n")
            log_handle.write(f"command={' '.join(sys.argv)}\n")
            log_handle.flush()
            sys.stdout = TeeStream(sys.__stdout__, log_handle)
            sys.stderr = TeeStream(sys.__stderr__, log_handle)

    if not variants_dir.exists():
        raise FileNotFoundError(f"Variants directory not found: {variants_dir}")

    # Load cards & build dataset
    include_card_ids: set[int] | None = None
    if args.include_card_ids.strip():
        include_card_ids = {
            int(x.strip()) for x in args.include_card_ids.split(",") if x.strip()
        }

    cards = load_active_cards(include_card_ids=include_card_ids)
    if not cards:
        raise RuntimeError("No active cards found in database.")

    max_samples_per_class = args.max_samples_per_class if args.max_samples_per_class > 0 else None
    focus_card_id = args.focus_card_id if args.focus_card_id > 0 else None
    focus_max_samples = args.focus_max_samples if args.focus_max_samples > 0 else None

    bundle = build_dataset_bundle(
        cards=cards,
        variants_root=variants_dir,
        png_root=png_dir,
        project_root=root.parent,
        val_ratio=args.val_ratio,
        seed=args.seed,
        max_samples_per_class=max_samples_per_class,
        focus_card_id=focus_card_id,
        focus_max_samples=focus_max_samples,
    )

    print("=" * 72)
    print("EcoLearn CNN Trainer  —  MobileNetV2 (ImageNet)")
    print(f"Active cards      : {len(cards)}")
    print(f"Train samples     : {len(bundle.train_paths)}")
    print(f"Validation samples: {len(bundle.val_paths)}")
    print(f"Num classes       : {len(bundle.class_names)}")
    print(f"Image size        : {args.img_size}x{args.img_size}")
    print("=" * 72)

    train_ds = build_tf_dataset(
        bundle.train_paths, bundle.train_labels,
        img_size=args.img_size,
        batch_size=args.batch_size,
        training=True,
        apply_augmentation=bool(args.trainer_augment),
    )
    val_ds = build_tf_dataset(
        bundle.val_paths, bundle.val_labels,
        img_size=args.img_size,
        batch_size=args.batch_size,
        training=False,
        apply_augmentation=False,
    )

    class_weights = class_weights_from_labels(bundle.train_labels)

    # Build model from scratch using real MobileNetV2
    model = build_mobilenet_model(
        num_classes=len(bundle.class_to_card_id),
        img_size=args.img_size,
        dropout_rate=args.dropout,
        weights_path=args.imagenet_weights_path,
    )
    model.summary()

    callbacks = [
        tf.keras.callbacks.EarlyStopping(
            monitor="val_loss", patience=4, restore_best_weights=True
        ),
        tf.keras.callbacks.ReduceLROnPlateau(
            monitor="val_loss", factor=0.5, patience=2, min_lr=1e-6
        ),
    ]

    # Only pass validation_data if we actually have val samples.
    # All classes having exactly 1 sample produces an empty val set.
    fit_val_data = val_ds if bundle.val_paths else None
    if fit_val_data is None:
        print("[warning] No validation samples — EarlyStopping/ReduceLROnPlateau disabled.")
        callbacks = []

    # Phase 1: train head only (backbone frozen)
    if args.head_epochs > 0:
        print("\n[phase 1/2] Head-only warm-up (backbone frozen)")
        set_trainable_phase(model, "head_only")
        compile_model(model, lr=args.head_lr)
        model.fit(
            train_ds,
            validation_data=fit_val_data,
            epochs=args.head_epochs,
            class_weight=class_weights,
            callbacks=callbacks,
            verbose=1,
        )

    # Phase 2: fine-tune full model (BN layers remain frozen)
    if args.finetune_epochs > 0:
        print("\n[phase 2/2] Full fine-tune (backbone unfrozen, BN frozen)")
        set_trainable_phase(model, "fine_tune")
        compile_model(model, lr=args.finetune_lr)
        model.fit(
            train_ds,
            validation_data=fit_val_data,
            epochs=args.finetune_epochs,
            class_weight=class_weights,
            callbacks=callbacks,
            verbose=1,
        )

    # Final evaluation — guard against empty val set (all classes had 1 sample)
    if bundle.val_paths:
        eval_loss, eval_acc = model.evaluate(val_ds, verbose=0)
        print(f"\nValidation loss : {eval_loss:.4f}")
        print(f"Validation acc  : {eval_acc:.4f}")
    else:
        print("\n[warning] No validation samples available — skipping final evaluation.")
        print("          Add more images per class (≥2) to enable validation.")

    # Save outputs
    out_keras.parent.mkdir(parents=True, exist_ok=True)
    model.save(str(out_keras))
    print(f"Saved Keras model : {out_keras}")

    export_onnx(model, out_onnx=out_onnx, img_size=args.img_size)
    print(f"Saved ONNX model  : {out_onnx}")

    write_labels_map(out_labels, bundle.class_to_card_id)
    print(f"Saved labels map  : {out_labels}")

    args_dict = vars(args).copy()
    args_dict["variants_dir"] = str(variants_dir)
    args_dict["png_dir"] = str(png_dir)
    if args.imagenet_weights_path:
        backbone_weights_source = f"local:{Path(args.imagenet_weights_path).resolve()}"
    else:
        backbone_weights_source = "imagenet_download"

    write_training_manifest(
        out_manifest,
        bundle,
        args_dict=args_dict,
        backbone_weights_source=backbone_weights_source,
    )
    print(f"Saved manifest    : {out_manifest}")

    print("\nTraining pipeline complete.")


if __name__ == "__main__":
    main()