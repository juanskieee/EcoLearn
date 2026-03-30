import argparse
import random
from pathlib import Path

import cv2
import numpy as np


VALID_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


# ---------------------------------------------------------------------------
# I/O helpers
# ---------------------------------------------------------------------------

def read_image(path: Path) -> np.ndarray | None:
    """Read image preserving alpha channel (BGRA for PNG, BGR for others)."""
    data = np.fromfile(str(path), dtype=np.uint8)
    if data.size == 0:
        return None
    img = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
    if img is None:
        return None
    # Normalise to BGRA so every downstream function can assume 4 channels
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
    elif img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
    return img  # always BGRA uint8


def write_image(path: Path, image: np.ndarray, ext: str = ".png"):
    """Write image; keeps alpha for PNG/WEBP, strips it for lossy formats."""
    path.parent.mkdir(parents=True, exist_ok=True)
    save_ext = path.suffix.lower() or ext
    if save_ext in {".jpg", ".jpeg", ".bmp"}:
        # Lossy formats don't support alpha — composite onto white
        image = flatten_alpha(image)
    ok, encoded = cv2.imencode(save_ext, image)
    if not ok:
        raise RuntimeError(f"Failed to encode image: {path}")
    encoded.tofile(str(path))


# ---------------------------------------------------------------------------
# Alpha utilities
# ---------------------------------------------------------------------------

def split_bgra(image: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return (bgr, alpha) pair. Alpha is float32 in [0,1]."""
    bgr = image[:, :, :3]
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


def warp_bgra(image: np.ndarray, m, dsize, flags=cv2.INTER_LINEAR, perspective=False) -> np.ndarray:
    """Warp all 4 channels correctly with BORDER_CONSTANT (transparent)."""
    bgr, alpha = split_bgra(image)
    warp_fn = cv2.warpPerspective if perspective else cv2.warpAffine
    w_bgr = warp_fn(bgr, m, dsize, flags=flags, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
    w_alpha = warp_fn(alpha, m, dsize, flags=flags, borderMode=cv2.BORDER_CONSTANT, borderValue=0.0)
    return merge_bgra(w_bgr, w_alpha)


# ---------------------------------------------------------------------------
# Augmentations (all BGRA-safe)
# ---------------------------------------------------------------------------

def rotate_image(image: np.ndarray, angle: float) -> np.ndarray:
    h, w = image.shape[:2]
    center = (w / 2, h / 2)
    m = cv2.getRotationMatrix2D(center, angle, 1.0)
    return warp_bgra(image, m, (w, h))


def adjust_brightness(image: np.ndarray, alpha: float, beta: float) -> np.ndarray:
    """Scale + shift only the colour channels; alpha mask is untouched."""
    def _fn(bgr):
        return cv2.convertScaleAbs(bgr, alpha=alpha, beta=beta)
    return apply_to_color(image, _fn)


def blur_image(image: np.ndarray, kernel_size: int) -> np.ndarray:
    """
    Gaussian blur with alpha-premultiplication so edges stay clean.
    Premultiply → blur → un-premultiply avoids dark halos on transparent edges.
    """
    bgr, alpha = split_bgra(image)
    # Premultiply
    pre = bgr.astype(np.float32) * alpha[..., None]
    pre_blur = cv2.GaussianBlur(pre, (kernel_size, kernel_size), 0)
    alpha_blur = cv2.GaussianBlur(alpha, (kernel_size, kernel_size), 0)
    # Un-premultiply safely
    eps = 1e-6
    out_bgr = np.where(alpha_blur[..., None] > eps, pre_blur / (alpha_blur[..., None] + eps), 0)
    out_bgr = np.clip(out_bgr, 0, 255).astype(np.uint8)
    return merge_bgra(out_bgr, alpha_blur)


def add_noise(image: np.ndarray, sigma: float) -> np.ndarray:
    """Add Gaussian noise only to visible (non-transparent) pixels."""
    bgr, alpha = split_bgra(image)
    noise = np.random.normal(0, sigma, bgr.shape).astype(np.float32)
    noisy = bgr.astype(np.float32) + noise * alpha[..., None]
    out_bgr = np.clip(noisy, 0, 255).astype(np.uint8)
    return merge_bgra(out_bgr, alpha)


def perspective_transform(image: np.ndarray, intensity: float = 0.08) -> np.ndarray:
    h, w = image.shape[:2]
    mx, my = int(w * intensity), int(h * intensity)
    src = np.float32([[0, 0], [w, 0], [0, h], [w, h]])
    dst = np.float32([
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
    def _fn(bgr):
        return cv2.filter2D(bgr, -1, k)
    return apply_to_color(image, _fn)


def defocus_blur(image: np.ndarray, radius: int = 4) -> np.ndarray:
    k = np.zeros((2 * radius + 1, 2 * radius + 1), dtype=np.float32)
    cv2.circle(k, (radius, radius), radius, 1, -1)
    k /= k.sum()
    def _fn(bgr):
        return cv2.filter2D(bgr, -1, k)
    return apply_to_color(image, _fn)


def flip_horizontal(image: np.ndarray) -> np.ndarray:
    return cv2.flip(image, 1)


def flip_vertical(image: np.ndarray) -> np.ndarray:
    return cv2.flip(image, 0)


def adjust_saturation(image: np.ndarray, scale: float) -> np.ndarray:
    """Scale saturation in HSV space; alpha is preserved."""
    def _fn(bgr):
        hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.float32)
        hsv[:, :, 1] = np.clip(hsv[:, :, 1] * scale, 0, 255)
        return cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)
    return apply_to_color(image, _fn)


def shift_hue(image: np.ndarray, shift: int) -> np.ndarray:
    """Rotate hue by `shift` degrees (0-180 in OpenCV HSV scale); alpha preserved."""
    def _fn(bgr):
        hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.int32)
        hsv[:, :, 0] = (hsv[:, :, 0] + shift) % 180
        return cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)
    return apply_to_color(image, _fn)


def sharpen(image: np.ndarray, strength: float = 1.0) -> np.ndarray:
    """Unsharp-mask style sharpen; `strength` scales the edge signal."""
    def _fn(bgr):
        blurred = cv2.GaussianBlur(bgr, (0, 0), 3)
        sharpened = cv2.addWeighted(bgr, 1 + strength, blurred, -strength, 0)
        return np.clip(sharpened, 0, 255).astype(np.uint8)
    return apply_to_color(image, _fn)


def scale_zoom(image: np.ndarray, factor: float) -> np.ndarray:
    """
    Zoom in (factor > 1) or out (factor < 1) while keeping canvas size.
    Zooming in crops the edges; zooming out reveals transparent padding.
    """
    h, w = image.shape[:2]
    center = (w / 2, h / 2)
    m = cv2.getRotationMatrix2D(center, 0, factor)
    return warp_bgra(image, m, (w, h))


def adjust_contrast(image: np.ndarray, factor: float) -> np.ndarray:
    """
    Stretch or compress contrast around the mid-point (128).
    factor > 1 = more contrast, factor < 1 = flat/washed out.
    """
    def _fn(bgr):
        out = (bgr.astype(np.float32) - 128) * factor + 128
        return np.clip(out, 0, 255).astype(np.uint8)
    return apply_to_color(image, _fn)


def rotate_arbitrary(image: np.ndarray, angle: float) -> np.ndarray:
    """Same as rotate_image but named separately for clarity in variant dict."""
    return rotate_image(image, angle)


# ---------------------------------------------------------------------------
# Variant set
# ---------------------------------------------------------------------------

def build_variants(base_image: np.ndarray) -> dict[str, np.ndarray]:
    """
    Create a large, aggressively-augmented variant set.
    All values are intentionally strong to stress-test model robustness.
    """
    return {
        # ── Geometry ─────────────────────────────────────────────────────────
        "original":          base_image,
        "flip_h":            flip_horizontal(base_image),
        "flip_v":            flip_vertical(base_image),
        "rot_45":            rotate_arbitrary(base_image,  45),
        "rot_90":            rotate_arbitrary(base_image,  90),
        "rot_135":           rotate_arbitrary(base_image, 135),
        "rot_180":           rotate_arbitrary(base_image, 180),
        "rot_225":           rotate_arbitrary(base_image, 225),
        "rot_270":           rotate_arbitrary(base_image, 270),
        "rot_315":           rotate_arbitrary(base_image, 315),
        "zoom_in_med":       scale_zoom(base_image, 1.30),
        "zoom_in_strong":    scale_zoom(base_image, 1.70),
        "zoom_out_med":      scale_zoom(base_image, 0.70),
        "zoom_out_strong":   scale_zoom(base_image, 0.45),
        "persp_med":         perspective_transform(base_image, intensity=0.12),
        "persp_strong":      perspective_transform(base_image, intensity=0.22),
        "persp_extreme":     perspective_transform(base_image, intensity=0.35),

        # ── Brightness / Exposure ─────────────────────────────────────────────
        "bright_med":        adjust_brightness(base_image, 1.45,  35),
        "bright_strong":     adjust_brightness(base_image, 1.85,  70),
        "bright_extreme":    adjust_brightness(base_image, 2.40, 110),
        "dark_med":          adjust_brightness(base_image, 0.65, -40),
        "dark_strong":       adjust_brightness(base_image, 0.40, -70),
        "dark_extreme":      adjust_brightness(base_image, 0.20, -110),

        # ── Contrast ──────────────────────────────────────────────────────────
        "contrast_high":     adjust_contrast(base_image, 2.0),
        "contrast_extreme":  adjust_contrast(base_image, 3.5),
        "contrast_low":      adjust_contrast(base_image, 0.4),
        "contrast_flat":     adjust_contrast(base_image, 0.15),

        # ── Colour ────────────────────────────────────────────────────────────
        "sat_high":          adjust_saturation(base_image, 2.0),
        "sat_extreme":       adjust_saturation(base_image, 4.0),
        "sat_low":           adjust_saturation(base_image, 0.35),
        "grayscale":         adjust_saturation(base_image, 0.0),
        "hue_30":            shift_hue(base_image,  30),
        "hue_60":            shift_hue(base_image,  60),
        "hue_90":            shift_hue(base_image,  90),
        "hue_120":           shift_hue(base_image, 120),

        # ── Sharpening ────────────────────────────────────────────────────────
        "sharpen_med":       sharpen(base_image, strength=1.5),
        "sharpen_strong":    sharpen(base_image, strength=3.5),
        "sharpen_extreme":   sharpen(base_image, strength=7.0),

        # ── Gaussian blur ─────────────────────────────────────────────────────
        "blur_mild":         blur_image(base_image,  5),
        "blur_med":          blur_image(base_image, 11),
        "blur_strong":       blur_image(base_image, 21),
        "blur_heavy":        blur_image(base_image, 35),
        "blur_extreme":      blur_image(base_image, 55),

        # ── Motion blur ───────────────────────────────────────────────────────
        "motion_h_med":      motion_blur(base_image, size=25,  angle=0),
        "motion_h_strong":   motion_blur(base_image, size=51,  angle=0),
        "motion_v_med":      motion_blur(base_image, size=25,  angle=90),
        "motion_v_strong":   motion_blur(base_image, size=51,  angle=90),
        "motion_d45_med":    motion_blur(base_image, size=21,  angle=45),
        "motion_d45_strong": motion_blur(base_image, size=45,  angle=45),
        "motion_d135_med":   motion_blur(base_image, size=21,  angle=135),
        "motion_d135_strong":motion_blur(base_image, size=45,  angle=135),

        # ── Defocus blur ──────────────────────────────────────────────────────
        "defocus_med":       defocus_blur(base_image, radius=8),
        "defocus_strong":    defocus_blur(base_image, radius=16),
        "defocus_extreme":   defocus_blur(base_image, radius=28),

        # ── Noise ─────────────────────────────────────────────────────────────
        "noise_mild":        add_noise(base_image, sigma=15),
        "noise_med":         add_noise(base_image, sigma=35),
        "noise_strong":      add_noise(base_image, sigma=65),
        "noise_extreme":     add_noise(base_image, sigma=100),
    }


# ---------------------------------------------------------------------------
# File iteration & main
# ---------------------------------------------------------------------------

def iter_images(input_dir: Path):
    for p in input_dir.rglob("*"):
        if p.is_file() and p.suffix.lower() in VALID_EXTENSIONS:
            yield p


def main():
    parser = argparse.ArgumentParser(
        description="Generate augmented image variants for model training (alpha-safe)."
    )
    parser.add_argument("--input-dir",  default=str(Path("..") / "assets_png"),
                        help="Source root folder containing class/category subfolders.")
    parser.add_argument("--output-dir", default=str(Path("..") / "assets_variants"),
                        help="Output root folder where variants will be saved.")
    parser.add_argument("--ext", default=".png",
                        choices=[".png", ".jpg", ".jpeg", ".webp"],
                        help="Output image extension.")
    parser.add_argument("--seed", type=int, default=42,
                        help="Random seed for reproducible perspective/noise variants.")
    args = parser.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)

    script_dir = Path(__file__).resolve().parent
    input_dir  = (script_dir / args.input_dir).resolve()
    output_dir = (script_dir / args.output_dir).resolve()

    if not input_dir.exists():
        raise FileNotFoundError(f"Input directory not found: {input_dir}")

    total_sources = total_written = 0

    for image_path in iter_images(input_dir):
        image = read_image(image_path)
        if image is None:
            print(f"[skip] unreadable: {image_path}")
            continue

        total_sources += 1
        rel_parent = image_path.parent.relative_to(input_dir)
        stem = image_path.stem

        variants = build_variants(image)
        for variant_name, variant_img in variants.items():
            out_name = f"{stem}__{variant_name}{args.ext}"
            out_path = output_dir / rel_parent / out_name
            write_image(out_path, variant_img, args.ext)
            total_written += 1

    print("=" * 60)
    print(f"Input : {input_dir}")
    print(f"Output: {output_dir}")
    print(f"Source images processed : {total_sources}")
    print(f"Variant images generated: {total_written}")
    print("=" * 60)


if __name__ == "__main__":
    main()