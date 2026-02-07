import cv2
import numpy as np
import mysql.connector
import pickle
import os
import hashlib
from datetime import datetime

# --- CONFIGURATION ---
DB_CONFIG = {
    'host': 'localhost',
    'user': 'root',
    'password': '',
    'database': 'ecolearn_db'
}

# Point this to your XAMPP htdocs folder
BASE_DIR = r"C:/xampp/htdocs"

# Enhanced ORB parameters (must match app_improved.py)
ORB_FEATURES = 1000
AUGMENT_COUNT = 8  # More variations for better accuracy

def connect_db():
    return mysql.connector.connect(**DB_CONFIG)

# ============================================
# ENHANCED AUGMENTATION PIPELINE
# ============================================

def rotate_image(image, angle):
    """Rotate image by specified angle"""
    (h, w) = image.shape[:2]
    center = (w // 2, h // 2)
    M = cv2.getRotationMatrix2D(center, angle, 1.0)
    return cv2.warpAffine(image, M, (w, h), borderMode=cv2.BORDER_REPLICATE)

def adjust_brightness(image, alpha=1.0, beta=0):
    """Adjust brightness and contrast"""
    return cv2.convertScaleAbs(image, alpha=alpha, beta=beta)

def add_noise(image, amount=10):
    """Add Gaussian noise to simulate poor lighting"""
    noise = np.random.normal(0, amount, image.shape).astype(np.uint8)
    return cv2.add(image, noise)

def blur_image(image, kernel_size=3):
    """Apply slight blur to simulate motion"""
    return cv2.GaussianBlur(image, (kernel_size, kernel_size), 0)

def perspective_transform(image, intensity=0.1):
    """Apply slight perspective distortion"""
    h, w = image.shape[:2]
    
    # Define random perspective transformation
    pts1 = np.float32([[0, 0], [w, 0], [0, h], [w, h]])
    
    # Add random offset
    offset = int(w * intensity)
    pts2 = np.float32([
        [np.random.randint(0, offset), np.random.randint(0, offset)],
        [w - np.random.randint(0, offset), np.random.randint(0, offset)],
        [np.random.randint(0, offset), h - np.random.randint(0, offset)],
        [w - np.random.randint(0, offset), h - np.random.randint(0, offset)]
    ])
    
    M = cv2.getPerspectiveTransform(pts1, pts2)
    return cv2.warpPerspective(image, M, (w, h), borderMode=cv2.BORDER_REPLICATE)

def augment_image(base_image):
    """
    Generate multiple augmented versions of the image
    This improves recognition under various conditions
    """
    variations = []
    
    # 1. Original
    variations.append(("original", base_image))
    
    # 2. Rotations (important for cards held at different angles)
    for angle in [90, 180, 270]:
        rotated = rotate_image(base_image, angle)
        variations.append((f"rot_{angle}", rotated))
    
    # 3. Brightness variations (for different lighting)
    bright = adjust_brightness(base_image, 1.3, 20)
    variations.append(("bright", bright))
    
    dark = adjust_brightness(base_image, 0.7, -20)
    variations.append(("dark", dark))
    
    # 4. Slight blur (for motion/camera focus issues)
    blurred = blur_image(base_image, 3)
    variations.append(("blur", blurred))
    
    # 5. Noise (for low-quality camera)
    noisy = add_noise(base_image, 8)
    variations.append(("noise", noisy))
    
    return variations

# ============================================
# MAIN TRAINING PIPELINE
# ============================================

# Category folder mapping for PNG paths
CATEGORY_FOLDERS = {
    1: 'Compostable',
    2: 'Recyclable',
    3: 'Non-Recyclable',
    4: 'Special-Waste'
}

def get_png_training_path(card_name, category_id, webp_path):
    """
    Get the PNG path for training (higher quality features).
    Falls back to webp_path if PNG doesn't exist.
    
    DUAL IMAGE SYSTEM:
    - assets_png/{category}/ contains high-quality PNGs for training
    - assets/{category}/ contains optimized WebPs for display
    """
    category_folder = CATEGORY_FOLDERS.get(category_id, 'Compostable')
    
    # Try to find matching PNG file
    # Method 1: Derive from card name
    safe_name = card_name.replace(' ', '_').replace('-', '_')
    safe_name = ''.join(c for c in safe_name if c.isalnum() or c == '_')
    png_path = os.path.join(BASE_DIR, 'assets_png', category_folder, f"{safe_name}.png")
    
    if os.path.exists(png_path):
        return png_path
    
    # Method 2: Convert webp path to png path
    if webp_path:
        # assets/Compostable/Apple_Core.webp -> assets_png/Compostable/Apple_Core.png
        png_from_webp = webp_path.replace('assets/', 'assets_png/').replace('.webp', '.png').replace('.jpg', '.png')
        full_png_path = os.path.join(BASE_DIR, png_from_webp.replace("/", os.sep))
        if os.path.exists(full_png_path):
            return full_png_path
    
    # Fallback: Use the original webp/jpg path
    return os.path.join(BASE_DIR, webp_path.replace("/", os.sep)) if webp_path else None

def train_system():
    """
    Train the EcoLearn system with enhanced feature extraction.
    
    USES PNG FILES FOR TRAINING:
    - PNGs have better quality and more keypoints/features
    - WebPs are used for display only (faster loading)
    - System remains plug-and-play and portable
    """
    print("=" * 60)
    print("🚀 ECOLEARN ENHANCED TRAINING SYSTEM")
    print("    Using PNG files for high-quality feature extraction")
    print("=" * 60)
    
    try:
        conn = connect_db()
        cursor = conn.cursor(dictionary=True)
        
        # 1. Safety: Clear old training data
        print("\n🧹 Cleaning old training data...")
        cursor.execute("SET FOREIGN_KEY_CHECKS = 0")
        cursor.execute("TRUNCATE TABLE TBL_GOLDEN_DATASET")
        cursor.execute("SET FOREIGN_KEY_CHECKS = 1")
        conn.commit()
        print("✅ Old data cleared")
        
        # 2. Fetch active cards
        cursor.execute("""
            SELECT card_id, card_name, category_id, image_path 
            FROM TBL_CARD_ASSETS 
            WHERE is_active = 1 
            ORDER BY category_id, card_id
        """)
        cards = cursor.fetchall()
        
        print(f"\n📋 Found {len(cards)} active cards to train")
        
        # 3. Initialize ORB detector with optimized parameters
        orb = cv2.ORB_create(
            nfeatures=ORB_FEATURES,
            scaleFactor=1.2,
            nlevels=8,
            edgeThreshold=15,
            firstLevel=0,
            WTA_K=2,
            scoreType=cv2.ORB_HARRIS_SCORE,
            patchSize=31,
            fastThreshold=20
        )
        
        total_variations = 0
        successful_cards = 0
        failed_cards = []
        
        print("\n" + "=" * 60)
        print("PROCESSING CARDS:")
        print("=" * 60)
        
        # 4. Process each card
        for idx, card in enumerate(cards, 1):
            card_id = card['card_id']
            name = card['card_name']
            category_id = card['category_id']
            webp_path = card['image_path']
            
            # Get PNG path for training (higher quality features)
            # Falls back to WebP if PNG doesn't exist
            full_path = get_png_training_path(name, category_id, webp_path)
            
            # Determine if using PNG or fallback
            using_png = full_path and 'assets_png' in full_path
            
            print(f"\n[{idx}/{len(cards)}] Processing: {name}")
            print(f"    {'📸 PNG' if using_png else '🌐 WebP'}: {full_path}")
            
            if not full_path or not os.path.exists(full_path):
                # Last resort: try direct webp path
                full_path = os.path.join(BASE_DIR, webp_path.replace("/", os.sep)) if webp_path else None
                if not full_path or not os.path.exists(full_path):
                    print(f"    ❌ FILE NOT FOUND - Skipping")
                    failed_cards.append((name, "File not found"))
                    continue
            
            # Load image in grayscale
            img = cv2.imread(full_path, cv2.IMREAD_GRAYSCALE)
            if img is None:
                print(f"    ❌ INVALID IMAGE - Skipping")
                failed_cards.append((name, "Invalid image"))
                continue
            
            # Generate augmented versions
            augmented_images = augment_image(img)
            print(f"    📸 Generated {len(augmented_images)} variations")
            
            card_feature_count = 0
            
            # Extract features from each variation
            for var_name, aug_img in augmented_images:
                # Detect keypoints and compute descriptors
                keypoints, descriptors = orb.detectAndCompute(aug_img, None)
                
                if descriptors is None or len(keypoints) < 10:
                    print(f"    ⚠️  {var_name}: Too few features ({len(keypoints) if keypoints else 0})")
                    continue
                
                # Serialize features
                features_blob = pickle.dumps(descriptors)
                
                # Create unique hash
                hash_input = f"{name}_{var_name}_{len(keypoints)}_{datetime.now().isoformat()}"
                image_hash = hashlib.md5(hash_input.encode()).hexdigest()
                
                # Insert into database
                sql = """INSERT INTO TBL_GOLDEN_DATASET 
                         (card_id, feature_vector, feature_count, image_hash, algorithm_version) 
                         VALUES (%s, %s, %s, %s, %s)"""
                
                cursor.execute(sql, (
                    card_id, 
                    features_blob, 
                    len(keypoints), 
                    image_hash,
                    'ORB-1000-v2'
                ))
                
                card_feature_count += 1
                total_variations += 1
            
            if card_feature_count > 0:
                print(f"    ✅ Success: {card_feature_count}/{len(augmented_images)} variations saved")
                successful_cards += 1
            else:
                print(f"    ❌ Failed: No valid features extracted")
                failed_cards.append((name, "No features extracted"))
        
        # Commit all changes
        conn.commit()
        
        # 5. Summary Report
        print("\n" + "=" * 60)
        print("TRAINING COMPLETE!")
        print("=" * 60)
        print(f"✅ Successfully trained: {successful_cards}/{len(cards)} cards")
        print(f"📊 Total feature sets: {total_variations}")
        print(f"📈 Average per card: {total_variations // successful_cards if successful_cards > 0 else 0}")
        
        if failed_cards:
            print(f"\n⚠️  Failed cards ({len(failed_cards)}):")
            for card_name, reason in failed_cards:
                print(f"   - {card_name}: {reason}")
        
        print("\n🎉 Database successfully populated!")
        print("=" * 60)
        
    except mysql.connector.Error as err:
        print(f"\n🚨 DATABASE ERROR: {err}")
        
    except Exception as e:
        print(f"\n🚨 UNEXPECTED ERROR: {e}")
        import traceback
        traceback.print_exc()
        
    finally:
        if 'cursor' in locals():
            cursor.close()
        if 'conn' in locals():
            conn.close()

# ============================================
# VERIFICATION FUNCTION
# ============================================

def verify_training():
    """Verify that training was successful"""
    try:
        conn = connect_db()
        cursor = conn.cursor(dictionary=True)
        
        # Check total feature sets
        cursor.execute("SELECT COUNT(*) as count FROM TBL_GOLDEN_DATASET")
        total = cursor.fetchone()['count']
        
        # Check unique cards
        cursor.execute("SELECT COUNT(DISTINCT card_id) as count FROM TBL_GOLDEN_DATASET")
        unique = cursor.fetchone()['count']
        
        # Check average features per variation
        cursor.execute("SELECT AVG(feature_count) as avg FROM TBL_GOLDEN_DATASET")
        avg_features = cursor.fetchone()['avg']
        
        print("\n" + "=" * 60)
        print("VERIFICATION REPORT")
        print("=" * 60)
        print(f"Total feature sets in database: {total}")
        print(f"Unique cards trained: {unique}")
        print(f"Average features per set: {avg_features:.1f}")
        print("=" * 60)
        
        cursor.close()
        conn.close()
        
        return total > 0
        
    except Exception as e:
        print(f"Verification failed: {e}")
        return False

# ============================================
# MAIN EXECUTION
# ============================================

if __name__ == "__main__":
    print("\n🌱 EcoLearn Enhanced Training Script")
    print("This will train the system with improved accuracy\n")
    
    # Confirm before proceeding
    response = input("⚠️  This will clear existing training data. Continue? (yes/no): ")
    
    if response.lower() == 'yes':
        train_system()
        
        # Verify
        if verify_training():
            print("\n✅ Training verified successfully!")
            print("You can now run: python app.py")
        else:
            print("\n❌ Training verification failed!")
    else:
        print("Training cancelled.")