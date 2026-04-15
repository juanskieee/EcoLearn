"""
generate_variants.py
────────────────────
Generate augmented image variants for model training (alpha-safe).

Improvements over v1:
  • Parallel processing via ProcessPoolExecutor (--workers)
  • New augmentations: cutout, JPEG artifacts, elastic distortion,
        (color-preserving variants only)
  • --variants  → run only a named subset of augmentations
  • --skip-existing → resume interrupted runs without re-writing
  • --workers   → control parallelism
  • --config    → YAML/JSON file to override augmentation parameters
  • Progress bar via tqdm
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import cv2
import numpy as np

try:
    from tqdm import tqdm
except ImportError:  # graceful fallback if tqdm not installed
    def tqdm(it, **kwargs):  # type: ignore[misc]
        total = kwargs.get("total")
        desc  = kwargs.get("desc", "")
        print(f"{desc} ({total} items)…", flush=True)
        return it

try:
    import yaml
    _YAML_AVAILABLE = True
except ImportError:
    _YAML_AVAILABLE = False


VALID_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


# ─────────────────────────────────────────────────────────────────────────────
# Eco-Card template framing (optional)
#
# This mirrors the layout used in js/admin_script.js drawEcoCardToPdfAt():
#  - 4×5 inch card, white background
#  - dark border
#  - light-gray image panel
#  - footer divider + two lines of text
#
# We render to pixels (default 800×1000) so the training data matches
# the “card framing” users see when scanning printed Eco-Cards.
# ─────────────────────────────────────────────────────────────────────────────


def _fit_into_box(image_bgra: np.ndarray, box_w: int, box_h: int) -> np.ndarray:
    """Resize image to fit within (box_w, box_h) preserving aspect ratio."""
    h, w = image_bgra.shape[:2]
    if h <= 0 or w <= 0 or box_w <= 0 or box_h <= 0:
        return image_bgra

    scale = min(box_w / w, box_h / h)
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    interp = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_CUBIC
    return cv2.resize(image_bgra, (new_w, new_h), interpolation=interp)


def _alpha_paste(dst_bgra: np.ndarray, src_bgra: np.ndarray, x: int, y: int) -> None:
    """Alpha-composite src onto dst at (x, y). In-place on dst."""
    if dst_bgra.ndim != 3 or dst_bgra.shape[2] != 4:
        raise ValueError("dst_bgra must be BGRA")
    if src_bgra.ndim != 3 or src_bgra.shape[2] != 4:
        raise ValueError("src_bgra must be BGRA")

    H, W = dst_bgra.shape[:2]
    h, w = src_bgra.shape[:2]
    if w <= 0 or h <= 0:
        return

    x1 = max(0, x)
    y1 = max(0, y)
    x2 = min(W, x + w)
    y2 = min(H, y + h)
    if x2 <= x1 or y2 <= y1:
        return

    sx1 = x1 - x
    sy1 = y1 - y
    sx2 = sx1 + (x2 - x1)
    sy2 = sy1 + (y2 - y1)

    dst_roi = dst_bgra[y1:y2, x1:x2].astype(np.float32)
    src_roi = src_bgra[sy1:sy2, sx1:sx2].astype(np.float32)

    a = (src_roi[:, :, 3:4] / 255.0)
    inv_a = 1.0 - a
    dst_roi[:, :, :3] = src_roi[:, :, :3] * a + dst_roi[:, :, :3] * inv_a
    dst_roi[:, :, 3:4] = np.clip(src_roi[:, :, 3:4] + dst_roi[:, :, 3:4] * inv_a, 0, 255)

    dst_bgra[y1:y2, x1:x2] = np.clip(dst_roi, 0, 255).astype(np.uint8)


def frame_as_ecocard(
    content_bgra: np.ndarray,
    title: str = "EcoLearn Eco-Card",
    subtitle: str = "Scan to identify and sort correctly",
    out_size: tuple[int, int] = (800, 1000),
) -> np.ndarray:
    """Render a full Eco-Card template image with the content inserted."""
    out_w, out_h = int(out_size[0]), int(out_size[1])
    out_w = max(128, out_w)
    out_h = max(160, out_h)

    # Create solid white background (opaque).
    canvas = np.full((out_h, out_w, 4), (255, 255, 255, 255), dtype=np.uint8)

    # Convert inches → pixels using width as reference (4 inches wide).
    px_per_in = out_w / 4.0
    def px(v_in: float) -> int:
        return int(round(v_in * px_per_in))

    # Card border (approximate rounded rectangles with plain rectangles).
    border_color = (51, 51, 51, 255)
    panel_fill = (247, 247, 247, 255)
    divider_color = (220, 220, 220, 255)

    # Main border rectangle: origin+(0.1,0.1), size (3.8,4.8)
    bx = px(0.10)
    by = px(0.10)
    bw = px(3.80)
    bh = px(4.80)
    cv2.rectangle(canvas, (bx, by), (bx + bw, by + bh), border_color, thickness=max(1, px(0.022)))

    # Image panel: origin+(0.35,0.35), size (3.3,3.48)
    px0 = px(0.35)
    py0 = px(0.35)
    pw = px(3.30)
    ph = px(3.48)
    cv2.rectangle(canvas, (px0, py0), (px0 + pw, py0 + ph), panel_fill, thickness=-1)

    # Content placement: origin+(0.5,0.5), size (3,3.1)
    ix = px(0.50)
    iy = px(0.50)
    iw = px(3.00)
    ih = px(3.10)

    placed = _fit_into_box(content_bgra, iw, ih)
    phh, pww = placed.shape[:2]
    ox = ix + (iw - pww) // 2
    oy = iy + (ih - phh) // 2
    _alpha_paste(canvas, placed, ox, oy)

    # Footer divider line: y=4.28, x 0.45→3.55
    y_div = px(4.28)
    x1 = px(0.45)
    x2 = px(3.55)
    cv2.line(canvas, (x1, y_div), (x2, y_div), divider_color, thickness=max(1, px(0.01)))

    # Footer text (OpenCV uses BGR; ignore alpha for text rendering)
    canvas_bgr = np.ascontiguousarray(canvas[:, :, :3])
    text_color_title = (90, 90, 90)
    text_color_sub = (145, 145, 145)
    cx = px(2.00)

    # Heuristic font scaling for the chosen canvas size.
    # Aim to visually match 9pt/7pt PDF text at ~200 dpi.
    title_scale = max(0.45, out_w / 1000.0)
    sub_scale = max(0.38, out_w / 1200.0)
    title_th = 2
    sub_th = 1

    def _center_text(text: str, y: int, scale: float, thickness: int, color: tuple[int, int, int]):
        (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, thickness)
        tx = max(0, min(out_w - 1, int(cx - tw / 2)))
        ty = max(th + 2, min(out_h - 2, y))
        cv2.putText(canvas_bgr, text, (tx, ty), cv2.FONT_HERSHEY_SIMPLEX, scale, color, thickness, cv2.LINE_AA)

    _center_text(title, px(4.56), title_scale, title_th, text_color_title)
    _center_text(subtitle, px(4.76), sub_scale, sub_th, text_color_sub)

    canvas[:, :, :3] = canvas_bgr
    return canvas


# ─────────────────────────────────────────────────────────────────────────────
# Default augmentation parameters  (overridable via --config)
# ─────────────────────────────────────────────────────────────────────────────

DEFAULT_PARAMS: dict = {
    "zoom_in_med":        {"factor": 1.30},
    "zoom_in_strong":     {"factor": 1.70},
    "zoom_out_med":       {"factor": 0.70},
    "zoom_out_strong":    {"factor": 0.45},
    "persp_med":          {"intensity": 0.12},
    "persp_strong":       {"intensity": 0.22},
    "persp_extreme":      {"intensity": 0.35},
    "bright_strong":      {"alpha": 1.85, "beta":  70},
    "dark_med":           {"alpha": 0.65, "beta": -40},
    "dark_strong":        {"alpha": 0.40, "beta": -70},
    "dark_extreme":       {"alpha": 0.20, "beta": -110},
    "contrast_high":      {"factor": 2.0},
    "contrast_extreme":   {"factor": 3.5},
    "contrast_low":       {"factor": 0.4},
    "contrast_flat":      {"factor": 0.15},
    "sat_high":           {"scale": 2.0},
    "sat_low":            {"scale": 0.35},
    "sharpen_med":        {"strength": 1.5},
    "sharpen_strong":     {"strength": 3.5},
    "sharpen_extreme":    {"strength": 7.0},
    "blur_mild":          {"kernel_size":  5},
    "blur_med":           {"kernel_size": 11},
    "blur_strong":        {"kernel_size": 21},
    "blur_heavy":         {"kernel_size": 35},
    "blur_extreme":       {"kernel_size": 55},
    "motion_h_med":       {"size": 25, "angle":   0},
    "motion_h_strong":    {"size": 51, "angle":   0},
    "motion_v_med":       {"size": 25, "angle":  90},
    "motion_v_strong":    {"size": 51, "angle":  90},
    "motion_d45_med":     {"size": 21, "angle":  45},
    "motion_d45_strong":  {"size": 45, "angle":  45},
    "motion_d135_med":    {"size": 21, "angle": 135},
    "motion_d135_strong": {"size": 45, "angle": 135},
    "defocus_med":        {"radius":  8},
    "defocus_strong":     {"radius": 16},
    "defocus_extreme":    {"radius": 28},
    "noise_mild":         {"sigma": 15},
    "noise_med":          {"sigma": 35},
    "noise_strong":       {"sigma": 65},
    "noise_extreme":      {"sigma": 100},
    # ── new augmentations ────────────────────────────────────────────────────
    "cutout_sm":          {"n_holes": 4,  "hole_size": 0.08},
    "cutout_med":         {"n_holes": 6,  "hole_size": 0.14},
    "cutout_lg":          {"n_holes": 8,  "hole_size": 0.22},
    "jpeg_q40":           {"quality": 40},
    "jpeg_q20":           {"quality": 20},
    "jpeg_q10":           {"quality": 10},
    "elastic_soft":       {"alpha": 40,  "sigma": 6},
    "elastic_med":        {"alpha": 80,  "sigma": 6},
    "elastic_strong":     {"alpha": 150, "sigma": 8},
}


# ─────────────────────────────────────────────────────────────────────────────
# I/O helpers
# ─────────────────────────────────────────────────────────────────────────────

def read_image(path: Path) -> np.ndarray | None:
    """Read image preserving alpha channel (always returns BGRA uint8)."""
    data = np.fromfile(str(path), dtype=np.uint8)
    if data.size == 0:
        return None
    img = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
    if img is None:
        return None
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
    elif img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
    return img


def write_image(path: Path, image: np.ndarray, ext: str = ".png") -> None:
    """Write image; keeps alpha for PNG/WEBP, composites onto white for lossy."""
    path.parent.mkdir(parents=True, exist_ok=True)
    save_ext = path.suffix.lower() or ext
    if save_ext in {".jpg", ".jpeg", ".bmp"}:
        image = flatten_alpha(image)
    ok, encoded = cv2.imencode(save_ext, image)
    if not ok:
        raise RuntimeError(f"Failed to encode image: {path}")
    encoded.tofile(str(path))


def load_config(config_path: Path) -> dict:
    """Load YAML or JSON parameter overrides."""
    text = config_path.read_text()
    if config_path.suffix.lower() in {".yaml", ".yml"}:
        if not _YAML_AVAILABLE:
            raise ImportError("PyYAML is required for YAML configs: pip install pyyaml")
        return yaml.safe_load(text)
    return json.loads(text)


# ─────────────────────────────────────────────────────────────────────────────
# Alpha utilities
# ─────────────────────────────────────────────────────────────────────────────

def split_bgra(image: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return (bgr, alpha_float32) where alpha is in [0, 1]."""
    bgr   = image[:, :, :3]
    alpha = image[:, :, 3].astype(np.float32) / 255.0
    return bgr, alpha


def merge_bgra(bgr: np.ndarray, alpha_f32: np.ndarray) -> np.ndarray:
    """Recombine bgr + float32 alpha → BGRA uint8."""
    a = np.clip(alpha_f32 * 255, 0, 255).astype(np.uint8)
    return cv2.merge([bgr[:, :, 0], bgr[:, :, 1], bgr[:, :, 2], a])


def flatten_alpha(image: np.ndarray, bg: tuple = (255, 255, 255)) -> np.ndarray:
    """Composite BGRA onto a solid background; returns BGR uint8."""
    bgr, alpha = split_bgra(image)
    bg_arr = np.full_like(bgr, bg[::-1], dtype=np.float32)  # RGB→BGR
    out = bgr.astype(np.float32) * alpha[..., None] + bg_arr * (1 - alpha[..., None])
    return np.clip(out, 0, 255).astype(np.uint8)


def apply_to_color(image: np.ndarray, fn) -> np.ndarray:
    """Apply fn only to the BGR channels; pass alpha through unchanged."""
    bgr, alpha = split_bgra(image)
    return merge_bgra(fn(bgr), alpha)


def warp_bgra(image: np.ndarray, m, dsize, flags=cv2.INTER_LINEAR,
              perspective: bool = False) -> np.ndarray:
    """Warp all 4 channels with BORDER_CONSTANT (transparent fill)."""
    bgr, alpha = split_bgra(image)
    warp_fn = cv2.warpPerspective if perspective else cv2.warpAffine
    w_bgr   = warp_fn(bgr,   m, dsize, flags=flags,
                      borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
    w_alpha = warp_fn(alpha, m, dsize, flags=flags,
                      borderMode=cv2.BORDER_CONSTANT, borderValue=0.0)
    return merge_bgra(w_bgr, w_alpha)


# ─────────────────────────────────────────────────────────────────────────────
# Augmentations — original
# ─────────────────────────────────────────────────────────────────────────────

def rotate_image(image: np.ndarray, angle: float) -> np.ndarray:
    h, w   = image.shape[:2]
    center = (w / 2, h / 2)
    m      = cv2.getRotationMatrix2D(center, angle, 1.0)
    return warp_bgra(image, m, (w, h))


def adjust_brightness(image: np.ndarray, alpha: float, beta: float) -> np.ndarray:
    def _fn(bgr):
        return cv2.convertScaleAbs(bgr, alpha=alpha, beta=beta)
    return apply_to_color(image, _fn)


def blur_image(image: np.ndarray, kernel_size: int) -> np.ndarray:
    """Gaussian blur with alpha-premultiplication to avoid dark halo edges."""
    bgr, alpha = split_bgra(image)
    pre        = bgr.astype(np.float32) * alpha[..., None]
    pre_blur   = cv2.GaussianBlur(pre,   (kernel_size, kernel_size), 0)
    alpha_blur = cv2.GaussianBlur(alpha, (kernel_size, kernel_size), 0)
    eps        = 1e-6
    out_bgr    = np.where(alpha_blur[..., None] > eps,
                          pre_blur / (alpha_blur[..., None] + eps), 0)
    return merge_bgra(np.clip(out_bgr, 0, 255).astype(np.uint8), alpha_blur)


def add_noise(image: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian noise only on visible (non-transparent) pixels."""
    bgr, alpha = split_bgra(image)
    noise      = np.random.normal(0, sigma, bgr.shape).astype(np.float32)
    noisy      = bgr.astype(np.float32) + noise * alpha[..., None]
    return merge_bgra(np.clip(noisy, 0, 255).astype(np.uint8), alpha)


def perspective_transform(image: np.ndarray, intensity: float = 0.08) -> np.ndarray:
    h, w   = image.shape[:2]
    mx, my = int(w * intensity), int(h * intensity)
    src    = np.float32([[0, 0], [w, 0], [0, h], [w, h]])
    dst    = np.float32([
        [random.randint(0, mx),     random.randint(0, my)],
        [w - random.randint(0, mx), random.randint(0, my)],
        [random.randint(0, mx),     h - random.randint(0, my)],
        [w - random.randint(0, mx), h - random.randint(0, my)],
    ])
    m = cv2.getPerspectiveTransform(src, dst)
    return warp_bgra(image, m, (w, h), perspective=True)


def _motion_kernel(size: int, angle: float) -> np.ndarray:
    kernel = np.zeros((size, size), dtype=np.float32)
    kernel[(size - 1) // 2, :] = 1.0
    m = cv2.getRotationMatrix2D((size / 2 - 0.5, size / 2 - 0.5), angle, 1.0)
    kernel = cv2.warpAffine(kernel, m, (size, size))
    return kernel / kernel.sum()


def motion_blur(image: np.ndarray, size: int = 15, angle: float = 0) -> np.ndarray:
    k = _motion_kernel(size, angle)
    return apply_to_color(image, lambda bgr: cv2.filter2D(bgr, -1, k))


def defocus_blur(image: np.ndarray, radius: int = 4) -> np.ndarray:
    k = np.zeros((2 * radius + 1, 2 * radius + 1), dtype=np.float32)
    cv2.circle(k, (radius, radius), radius, 1, -1)
    k /= k.sum()
    return apply_to_color(image, lambda bgr: cv2.filter2D(bgr, -1, k))


def flip_horizontal(image: np.ndarray) -> np.ndarray:
    return cv2.flip(image, 1)


def flip_vertical(image: np.ndarray) -> np.ndarray:
    return cv2.flip(image, 0)


def adjust_saturation(image: np.ndarray, scale: float) -> np.ndarray:
    def _fn(bgr):
        hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.float32)
        hsv[:, :, 1] = np.clip(hsv[:, :, 1] * scale, 0, 255)
        return cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)
    return apply_to_color(image, _fn)


def shift_hue(image: np.ndarray, shift: int) -> np.ndarray:
    def _fn(bgr):
        hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.int32)
        hsv[:, :, 0] = (hsv[:, :, 0] + shift) % 180
        return cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)
    return apply_to_color(image, _fn)


def sharpen(image: np.ndarray, strength: float = 1.0) -> np.ndarray:
    def _fn(bgr):
        blurred   = cv2.GaussianBlur(bgr, (0, 0), 3)
        sharpened = cv2.addWeighted(bgr, 1 + strength, blurred, -strength, 0)
        return np.clip(sharpened, 0, 255).astype(np.uint8)
    return apply_to_color(image, _fn)


def scale_zoom(image: np.ndarray, factor: float) -> np.ndarray:
    h, w   = image.shape[:2]
    center = (w / 2, h / 2)
    m      = cv2.getRotationMatrix2D(center, 0, factor)
    return warp_bgra(image, m, (w, h))


def adjust_contrast(image: np.ndarray, factor: float) -> np.ndarray:
    def _fn(bgr):
        out = (bgr.astype(np.float32) - 128) * factor + 128
        return np.clip(out, 0, 255).astype(np.uint8)
    return apply_to_color(image, _fn)


# ─────────────────────────────────────────────────────────────────────────────
# Augmentations — new
# ─────────────────────────────────────────────────────────────────────────────

def cutout(image: np.ndarray, n_holes: int = 4, hole_size: float = 0.10) -> np.ndarray:
    """
    Random Erasing / Cutout: zero out n_holes rectangular regions.
    hole_size is a fraction of the shorter image dimension.
    Transparent pixels are left untouched.
    """
    out        = image.copy()
    h, w       = image.shape[:2]
    side       = int(min(h, w) * hole_size)
    side       = max(side, 1)
    _, alpha   = split_bgra(image)

    for _ in range(n_holes):
        cx = random.randint(0, w - 1)
        cy = random.randint(0, h - 1)
        x1, x2 = max(cx - side // 2, 0), min(cx + side // 2, w)
        y1, y2 = max(cy - side // 2, 0), min(cy + side // 2, h)
        # Only erase where pixel is visible
        mask = alpha[y1:y2, x1:x2] > 0.01
        out[y1:y2, x1:x2, :3][mask] = 0
    return out


def jpeg_artifacts(image: np.ndarray, quality: int = 30) -> np.ndarray:
    """
    Simulate JPEG compression artifacts by encode→decode at low quality.
    Alpha channel is preserved (JPEG itself doesn't support it).
    """
    bgr, alpha = split_bgra(image)
    encode_params = [cv2.IMWRITE_JPEG_QUALITY, quality]
    ok, buf = cv2.imencode(".jpg", bgr, encode_params)
    if not ok:
        return image
    decoded = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    return merge_bgra(decoded, alpha)


def elastic_distortion(image: np.ndarray, alpha: float = 80,
                       sigma: float = 6) -> np.ndarray:
    """
    Elastic deformation: random displacement field smoothed with Gaussian.
    alpha controls intensity, sigma controls smoothness.
    """
    h, w = image.shape[:2]
    rng  = np.random.default_rng()

    dx = rng.uniform(-1, 1, (h, w)).astype(np.float32) * alpha
    dy = rng.uniform(-1, 1, (h, w)).astype(np.float32) * alpha
    dx = cv2.GaussianBlur(dx, (0, 0), sigma)
    dy = cv2.GaussianBlur(dy, (0, 0), sigma)

    xs, ys = np.meshgrid(np.arange(w), np.arange(h))
    map_x  = np.clip(xs + dx, 0, w - 1).astype(np.float32)
    map_y  = np.clip(ys + dy, 0, h - 1).astype(np.float32)

    bgr, alpha_ch = split_bgra(image)
    w_bgr   = cv2.remap(bgr,      map_x, map_y, cv2.INTER_LINEAR,
                        borderMode=cv2.BORDER_REFLECT_101)
    w_alpha = cv2.remap(alpha_ch, map_x, map_y, cv2.INTER_LINEAR,
                        borderMode=cv2.BORDER_REFLECT_101)
    return merge_bgra(w_bgr, w_alpha)


def channel_shuffle(image: np.ndarray) -> np.ndarray:
    """Randomly permute the B, G, R channels; alpha is preserved."""
    bgr, alpha = split_bgra(image)
    order      = list(range(3))
    random.shuffle(order)
    shuffled   = bgr[:, :, order]
    return merge_bgra(shuffled, alpha)


def channel_drop(image: np.ndarray, channel: int = 0) -> np.ndarray:
    """Zero out one BGR channel (0=B, 1=G, 2=R); alpha preserved."""
    out = image.copy()
    out[:, :, channel] = 0
    return out


def color_jitter(image: np.ndarray,
                 b_range: tuple = (0.8, 1.2),
                 c_range: tuple = (0.8, 1.2),
                 s_range: tuple = (0.8, 1.2)) -> np.ndarray:
    """
    Random color jitter: brightness, contrast, and saturation applied
    in a random order, each with a random factor drawn from its range.
    """
    b = random.uniform(*b_range)
    c = random.uniform(*c_range)
    s = random.uniform(*s_range)

    ops = [
        lambda img: adjust_brightness(img, alpha=b, beta=0),
        lambda img: adjust_contrast(img, factor=c),
        lambda img: adjust_saturation(img, scale=s),
    ]
    random.shuffle(ops)
    for op in ops:
        image = op(image)
    return image


# ─────────────────────────────────────────────────────────────────────────────
# Variant registry
# ─────────────────────────────────────────────────────────────────────────────

def build_variants(base_image: np.ndarray,
                   params: dict | None = None,
                   selected: set[str] | None = None) -> dict[str, np.ndarray]:
    """
    Build the full augmented variant set.

    Args:
        base_image: Source BGRA image.
        params:     Per-variant parameter overrides (merged with DEFAULT_PARAMS).
        selected:   If provided, only include these variant names.
    """
    p = {**DEFAULT_PARAMS, **(params or {})}

    def _p(name: str) -> dict:
        return p.get(name, {})

    all_variants: dict[str, np.ndarray] = {
        # ── Identity ──────────────────────────────────────────────────────────
        "original":           base_image,

        # ── Geometry ──────────────────────────────────────────────────────────
        "flip_h":             flip_horizontal(base_image),
        "flip_v":             flip_vertical(base_image),
        "rot_45":             rotate_image(base_image,  45),
        "rot_90":             rotate_image(base_image,  90),
        "rot_135":            rotate_image(base_image, 135),
        "rot_180":            rotate_image(base_image, 180),
        "rot_225":            rotate_image(base_image, 225),
        "rot_270":            rotate_image(base_image, 270),
        "rot_315":            rotate_image(base_image, 315),
        "zoom_in_med":        scale_zoom(base_image, **_p("zoom_in_med")),
        "zoom_in_strong":     scale_zoom(base_image, **_p("zoom_in_strong")),
        "zoom_out_med":       scale_zoom(base_image, **_p("zoom_out_med")),
        "zoom_out_strong":    scale_zoom(base_image, **_p("zoom_out_strong")),
        "persp_med":          perspective_transform(base_image, **_p("persp_med")),
        "persp_strong":       perspective_transform(base_image, **_p("persp_strong")),
        "persp_extreme":      perspective_transform(base_image, **_p("persp_extreme")),

        # ── Brightness / Exposure ─────────────────────────────────────────────
        "bright_strong":      adjust_brightness(base_image, **_p("bright_strong")),
        "dark_med":           adjust_brightness(base_image, **_p("dark_med")),
        "dark_strong":        adjust_brightness(base_image, **_p("dark_strong")),
        "dark_extreme":       adjust_brightness(base_image, **_p("dark_extreme")),

        # ── Contrast ──────────────────────────────────────────────────────────
        "contrast_high":      adjust_contrast(base_image, **_p("contrast_high")),
        "contrast_extreme":   adjust_contrast(base_image, **_p("contrast_extreme")),
        "contrast_low":       adjust_contrast(base_image, **_p("contrast_low")),
        "contrast_flat":      adjust_contrast(base_image, **_p("contrast_flat")),

        # ── Colour ────────────────────────────────────────────────────────────
        "sat_high":           adjust_saturation(base_image, **_p("sat_high")),
        "sat_low":            adjust_saturation(base_image, **_p("sat_low")),

        # ── Sharpening ────────────────────────────────────────────────────────
        "sharpen_med":        sharpen(base_image, **_p("sharpen_med")),
        "sharpen_strong":     sharpen(base_image, **_p("sharpen_strong")),
        "sharpen_extreme":    sharpen(base_image, **_p("sharpen_extreme")),

        # ── Gaussian blur ─────────────────────────────────────────────────────
        "blur_mild":          blur_image(base_image, **_p("blur_mild")),
        "blur_med":           blur_image(base_image, **_p("blur_med")),
        "blur_strong":        blur_image(base_image, **_p("blur_strong")),
        "blur_heavy":         blur_image(base_image, **_p("blur_heavy")),
        "blur_extreme":       blur_image(base_image, **_p("blur_extreme")),

        # ── Motion blur ───────────────────────────────────────────────────────
        "motion_h_med":       motion_blur(base_image, **_p("motion_h_med")),
        "motion_h_strong":    motion_blur(base_image, **_p("motion_h_strong")),
        "motion_v_med":       motion_blur(base_image, **_p("motion_v_med")),
        "motion_v_strong":    motion_blur(base_image, **_p("motion_v_strong")),
        "motion_d45_med":     motion_blur(base_image, **_p("motion_d45_med")),
        "motion_d45_strong":  motion_blur(base_image, **_p("motion_d45_strong")),
        "motion_d135_med":    motion_blur(base_image, **_p("motion_d135_med")),
        "motion_d135_strong": motion_blur(base_image, **_p("motion_d135_strong")),

        # ── Defocus blur ──────────────────────────────────────────────────────
        "defocus_med":        defocus_blur(base_image, **_p("defocus_med")),
        "defocus_strong":     defocus_blur(base_image, **_p("defocus_strong")),
        "defocus_extreme":    defocus_blur(base_image, **_p("defocus_extreme")),

        # ── Noise ─────────────────────────────────────────────────────────────
        "noise_mild":         add_noise(base_image, **_p("noise_mild")),
        "noise_med":          add_noise(base_image, **_p("noise_med")),
        "noise_strong":       add_noise(base_image, **_p("noise_strong")),
        "noise_extreme":      add_noise(base_image, **_p("noise_extreme")),

        # ── Cutout / Random Erasing ───────────────────────────────────────────
        "cutout_sm":          cutout(base_image, **_p("cutout_sm")),
        "cutout_med":         cutout(base_image, **_p("cutout_med")),
        "cutout_lg":          cutout(base_image, **_p("cutout_lg")),

        # ── JPEG compression ──────────────────────────────────────────────────
        "jpeg_q40":           jpeg_artifacts(base_image, **_p("jpeg_q40")),
        "jpeg_q20":           jpeg_artifacts(base_image, **_p("jpeg_q20")),
        "jpeg_q10":           jpeg_artifacts(base_image, **_p("jpeg_q10")),

        # ── Elastic distortion ────────────────────────────────────────────────
        "elastic_soft":       elastic_distortion(base_image, **_p("elastic_soft")),
        "elastic_med":        elastic_distortion(base_image, **_p("elastic_med")),
        "elastic_strong":     elastic_distortion(base_image, **_p("elastic_strong")),
    }

    if selected:
        unknown = selected - all_variants.keys()
        if unknown:
            print(f"[warn] unknown variant name(s) ignored: {', '.join(sorted(unknown))}",
                  file=sys.stderr)
        return {k: v for k, v in all_variants.items() if k in selected}

    return all_variants


# ─────────────────────────────────────────────────────────────────────────────
# Worker function (runs in a subprocess)
# ─────────────────────────────────────────────────────────────────────────────

def _process_one(args_tuple: tuple) -> tuple[bool, str, int]:
    """
    Process a single source image.  Designed to run in a worker process.

    Returns (success, path_str, n_written).
    """
    (image_path_str, input_dir_str, output_dir_str, ext,
     seed, params, selected, skip_existing, frame_ecocard, frame_width, frame_height) = args_tuple

    image_path = Path(image_path_str)
    input_dir  = Path(input_dir_str)
    output_dir = Path(output_dir_str)

    # Each worker re-seeds with image-specific seed for reproducibility
    img_seed = seed ^ hash(image_path_str) & 0xFFFFFFFF
    random.seed(img_seed)
    np.random.seed(img_seed % (2**32))

    rel_parent   = image_path.parent.relative_to(input_dir)
    stem         = image_path.stem
    variant_keys = list(build_variants(
        np.zeros((4, 4, 4), dtype=np.uint8), params=params, selected=selected
    ).keys())

    # ── Skip entire image if every expected variant file already exists ────────
    if skip_existing:
        all_exist = all(
            (output_dir / rel_parent / f"{stem}__{name}{ext}").exists()
            for name in variant_keys
        )
        if all_exist:
            return True, image_path_str, 0

    image = read_image(image_path)
    if image is None:
        return False, image_path_str, 0

    if frame_ecocard:
        image = frame_as_ecocard(
            image,
            title="EcoLearn Eco-Card",
            subtitle="Scan to identify and sort correctly",
            out_size=(int(frame_width), int(frame_height)),
        )

    variants  = build_variants(image, params=params, selected=selected)
    n_written = 0

    for variant_name, variant_img in variants.items():
        out_name = f"{stem}__{variant_name}{ext}"
        out_path = output_dir / rel_parent / out_name
        if skip_existing and out_path.exists():
            continue
        write_image(out_path, variant_img, ext)
        n_written += 1

    return True, image_path_str, n_written


# ─────────────────────────────────────────────────────────────────────────────
# File iteration
# ─────────────────────────────────────────────────────────────────────────────

def iter_images(input_dir: Path):
    for p in input_dir.rglob("*"):
        if p.is_file() and p.suffix.lower() in VALID_EXTENSIONS:
            yield p


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Generate augmented image variants for model training (alpha-safe).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--input-dir",  default=str(Path("..") / "assets_png"),
                        help="Source root folder containing class/category subfolders.")
    parser.add_argument("--single-image", default=None,
                        help="Generate variants for just one image (path must be inside --input-dir).")
    parser.add_argument("--output-dir", default=str(Path("..") / "assets_variants"),
                        help="Output root folder where variants will be saved.")
    parser.add_argument("--ext", default=".png",
                        choices=[".png", ".jpg", ".jpeg", ".webp"],
                        help="Output image extension.")
    parser.add_argument("--seed", type=int, default=42,
                        help="Base random seed for reproducible results.")
    parser.add_argument("--workers", type=int, default=4,
                        help="Number of parallel worker processes.")
    parser.add_argument("--variants", default=None,
                        help="Comma-separated list of variant names to generate. "
                             "Omit to generate all variants.")
    parser.add_argument("--skip-existing", action="store_true",
                        help="Skip output files that already exist (resume mode).")
    parser.add_argument("--config", default=None,
                        help="Path to a YAML or JSON file with parameter overrides.")
    parser.add_argument("--frame-ecocard", action="store_true",
                        help="Wrap each source image in the Eco-Card template before augmenting.")
    parser.add_argument("--frame-size", default="800x1000",
                        help="Output size for Eco-Card framing as WxH pixels (used with --frame-ecocard).")
    parser.add_argument("--list-variants", action="store_true",
                        help="Print all available variant names and exit.")
    args = parser.parse_args()

    # ── List mode ─────────────────────────────────────────────────────────────
    if args.list_variants:
        dummy  = np.zeros((4, 4, 4), dtype=np.uint8)
        names  = list(build_variants(dummy).keys())
        print("\n".join(names))
        return

    # ── Config ────────────────────────────────────────────────────────────────
    params: dict = {}
    if args.config:
        params = load_config(Path(args.config))
        print(f"[config] loaded overrides from {args.config}")

    # ── Variant filter ────────────────────────────────────────────────────────
    selected: set[str] | None = None
    if args.variants:
        selected = {v.strip() for v in args.variants.split(",") if v.strip()}
        print(f"[variants] restricting to: {', '.join(sorted(selected))}")

    # ── Paths ─────────────────────────────────────────────────────────────────
    script_dir = Path(__file__).resolve().parent
    input_dir  = (script_dir / args.input_dir).resolve()
    output_dir = (script_dir / args.output_dir).resolve()

    if not input_dir.exists():
        raise FileNotFoundError(f"Input directory not found: {input_dir}")

    if args.single_image:
        raw_single = Path(args.single_image)
        candidates: list[Path]
        if raw_single.is_absolute():
            candidates = [raw_single]
        else:
            # Try common bases so users can pass paths relative to:
            #  - current working directory
            #  - --input-dir root
            #  - backend/ script directory
            candidates = [
                Path.cwd() / raw_single,
                input_dir / raw_single,
                script_dir / raw_single,
            ]

        single_path: Path | None = None
        tried: list[str] = []
        for c in candidates:
            try:
                c_resolved = c.resolve()
            except Exception:
                continue
            tried.append(str(c_resolved))
            if c_resolved.exists() and c_resolved.is_file():
                single_path = c_resolved
                break

        if single_path is None:
            raise FileNotFoundError(
                "Single image not found. Tried:\n  - " + "\n  - ".join(tried)
            )
        if single_path.suffix.lower() not in VALID_EXTENSIONS:
            raise ValueError(f"Single image must be one of {sorted(VALID_EXTENSIONS)}: {single_path}")
        try:
            single_path.relative_to(input_dir)
        except Exception:
            raise ValueError(
                "--single-image must be inside --input-dir so category folders are preserved. "
                f"Got: {single_path} (input-dir: {input_dir})"
            )
        image_paths = [single_path]
    else:
        image_paths = list(iter_images(input_dir))
    if not image_paths:
        print("[warn] No images found in input directory.")
        return

    frame_width = 800
    frame_height = 1000
    if args.frame_ecocard:
        try:
            raw = str(args.frame_size).lower().replace(" ", "")
            w_str, h_str = raw.split("x", 1)
            frame_width = max(128, int(w_str))
            frame_height = max(160, int(h_str))
        except Exception:
            raise ValueError("Invalid --frame-size. Use WxH like 800x1000")

    # ── Build worker task list ────────────────────────────────────────────────
    tasks = [
        (str(p), str(input_dir), str(output_dir),
         args.ext, args.seed, params, selected, args.skip_existing,
         args.frame_ecocard, frame_width, frame_height)
        for p in image_paths
    ]

    total_sources = total_written = total_failed = 0

    # ── Parallel execution ────────────────────────────────────────────────────
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(_process_one, t): t[0] for t in tasks}
        pbar = tqdm(as_completed(futures), total=len(futures),
                    desc="Augmenting", unit="img")
        for future in pbar:
            success, path_str, n_written = future.result()
            if success:
                total_sources += 1
                total_written += n_written
            else:
                total_failed  += 1
                print(f"\n[skip] unreadable: {path_str}", file=sys.stderr)
            if hasattr(pbar, "set_postfix"):
                pbar.set_postfix(written=total_written, failed=total_failed)

    # ── Summary ───────────────────────────────────────────────────────────────
    print("=" * 60)
    print(f"Input  : {input_dir}")
    print(f"Output : {output_dir}")
    print(f"Workers: {args.workers}")
    print(f"Source images processed : {total_sources}")
    print(f"Variant images generated: {total_written}")
    if total_failed:
        print(f"Failed / unreadable     : {total_failed}")
    print("=" * 60)


if __name__ == "__main__":
    main()