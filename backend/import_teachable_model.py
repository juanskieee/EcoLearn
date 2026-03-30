import argparse
import difflib
import re
from pathlib import Path

import mysql.connector


DB_CONFIG = {
    "host": "localhost",
    "user": "root",
    "password": "",
    "database": "ecolearn_db",
}


def normalize_label(text: str) -> str:
    text = text.strip().lower()
    text = text.replace("_", " ")
    text = re.sub(r"[^a-z0-9 ]+", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def read_teachable_labels(path: Path):
    labels = []
    with path.open("r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line:
                continue

            parts = line.split(maxsplit=1)
            if len(parts) != 2:
                raise ValueError(f"Invalid labels line: {line}")

            class_index = int(parts[0])
            class_name = parts[1].strip()
            labels.append((class_index, class_name))

    labels.sort(key=lambda x: x[0])
    return labels


def load_card_rows_from_db():
    conn = mysql.connector.connect(**DB_CONFIG)
    cursor = conn.cursor(dictionary=True)
    cursor.execute(
        """
        SELECT card_id, card_name, image_filename
        FROM TBL_CARD_ASSETS
        WHERE is_active = 1
        ORDER BY card_id
        """
    )
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    return rows


def build_candidate_maps(card_rows):
    exact = {}

    for row in card_rows:
        card_id = int(row["card_id"])
        candidates = {
            normalize_label(row["card_name"]),
            normalize_label(Path(row["image_filename"]).stem),
        }

        for cand in candidates:
            exact.setdefault(cand, []).append(card_id)

    return exact


def resolve_card_id(label_name, exact_map, card_rows):
    normalized = normalize_label(label_name)

    # First pass: exact normalized match.
    if normalized in exact_map and exact_map[normalized]:
        return exact_map[normalized][0], "exact"

    # Common class-name aliases and known misspellings.
    alias_map = {
        "medicine blister": "medicine blister pack",
        "insectiside bottle": "insecticide bottle",
    }
    alias = alias_map.get(normalized)
    if alias and alias in exact_map and exact_map[alias]:
        return exact_map[alias][0], "alias"

    # Fuzzy fallback based on card_name/image_filename stems.
    choices = []
    choice_to_card = {}
    for row in card_rows:
        card_id = int(row["card_id"])
        for candidate in (
            normalize_label(row["card_name"]),
            normalize_label(Path(row["image_filename"]).stem),
        ):
            choices.append(candidate)
            choice_to_card[candidate] = card_id

    best = difflib.get_close_matches(normalized, choices, n=1, cutoff=0.78)
    if best:
        b = best[0]
        return choice_to_card[b], f"fuzzy:{b}"

    return None, "unmapped"


def write_backend_labels(path: Path, mapped_rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in mapped_rows:
            f.write(f"{row['class_index']},{row['card_id']}\n")


def convert_h5_to_onnx(h5_path: Path, onnx_path: Path):
    # Delayed imports so mapping can still run without ML stack installed.
    import tensorflow as tf
    import tf2onnx

    model = tf.keras.models.load_model(str(h5_path), compile=False)
    input_shape = tuple(model.inputs[0].shape)

    spec = (tf.TensorSpec(input_shape, tf.float32, name="input"),)
    onnx_model, _ = tf2onnx.convert.from_keras(model, input_signature=spec, opset=13)

    onnx_path.parent.mkdir(parents=True, exist_ok=True)
    with onnx_path.open("wb") as f:
        f.write(onnx_model.SerializeToString())


def main():
    parser = argparse.ArgumentParser(
        description="Import Teachable Machine Keras export into EcoLearn backend models."
    )
    parser.add_argument(
        "--keras-model",
        default=str(Path("..") / "converted_keras" / "keras_model.h5"),
        help="Path to Teachable Machine keras_model.h5",
    )
    parser.add_argument(
        "--labels",
        default=str(Path("..") / "converted_keras" / "labels.txt"),
        help="Path to Teachable Machine labels.txt",
    )
    parser.add_argument(
        "--out-onnx",
        default=str(Path("models") / "waste_mobilenet.onnx"),
        help="Output ONNX model path (relative to backend/ by default)",
    )
    parser.add_argument(
        "--out-labels",
        default=str(Path("models") / "waste_labels.txt"),
        help="Output backend label-map path (relative to backend/ by default)",
    )
    parser.add_argument(
        "--skip-convert",
        action="store_true",
        help="Only build labels mapping; skip h5->onnx conversion",
    )
    args = parser.parse_args()

    root = Path(__file__).resolve().parent
    keras_path = (root / args.keras_model).resolve()
    labels_path = (root / args.labels).resolve()
    out_onnx = (root / args.out_onnx).resolve()
    out_labels = (root / args.out_labels).resolve()

    if not labels_path.exists():
        raise FileNotFoundError(f"labels.txt not found: {labels_path}")
    if not args.skip_convert and not keras_path.exists():
        raise FileNotFoundError(f"keras_model.h5 not found: {keras_path}")

    teachable_labels = read_teachable_labels(labels_path)
    card_rows = load_card_rows_from_db()
    exact_map = build_candidate_maps(card_rows)

    mapped = []
    unmapped = []
    for class_index, class_name in teachable_labels:
        card_id, method = resolve_card_id(class_name, exact_map, card_rows)
        if card_id is None:
            unmapped.append((class_index, class_name))
            continue

        mapped.append(
            {
                "class_index": class_index,
                "class_name": class_name,
                "card_id": card_id,
                "method": method,
            }
        )

    if unmapped:
        print("Unmapped label classes found. Please fix names or add aliases:")
        for class_index, class_name in unmapped:
            print(f"  - {class_index}: {class_name}")
        raise SystemExit(1)

    write_backend_labels(out_labels, mapped)
    print(f"OK labels mapped: {len(mapped)} classes -> {out_labels}")

    for row in mapped:
        print(
            f"  class {row['class_index']:>2} | {row['class_name']:<24} -> card_id {row['card_id']} ({row['method']})"
        )

    if args.skip_convert:
        print("Skipped ONNX conversion (--skip-convert).")
        return

    convert_h5_to_onnx(keras_path, out_onnx)
    print(f"OK ONNX written: {out_onnx}")
    print("Import complete.")


if __name__ == "__main__":
    main()
