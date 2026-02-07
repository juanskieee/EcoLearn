-- ============================================================
-- ECOLEARN DATABASE SCHEMA
-- Based on Entity-Relationship Diagram (Figure 5)
-- An Interactive Waste Segregation Instructional Tool
-- ============================================================

-- Drop database if exists (for fresh installation)
DROP DATABASE IF EXISTS ecolearn_db;

-- Create database
CREATE DATABASE ecolearn_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Use the database
USE ecolearn_db;

-- ============================================================
-- TABLE 1: TBL_ADMIN
-- Stores encrypted administrator credentials and system control
-- ============================================================
CREATE TABLE TBL_ADMIN (
    admin_id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL COMMENT 'Encrypted using password_hash()',
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP NULL,
    is_active TINYINT(1) DEFAULT 1 COMMENT '1=Active, 0=Inactive',
    INDEX idx_username (username),
    INDEX idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Administrator authentication and profile';

-- ============================================================
-- TABLE 2: TBL_CATEGORIES
-- Defines the four waste classification streams per Municipal Ordinance No. 007-06
-- ============================================================
CREATE TABLE TBL_CATEGORIES (
    category_id INT AUTO_INCREMENT PRIMARY KEY,
    category_name VARCHAR(50) NOT NULL UNIQUE COMMENT 'Compostable, Recyclable, Non-Recyclable, Special Waste',
    category_code VARCHAR(20) NOT NULL UNIQUE COMMENT 'Short code: COMP, RECY, NREC, SPEC',
    description TEXT,
    bin_color VARCHAR(30) COMMENT 'Visual identifier: Green, Blue, Red, Yellow',
    display_order INT DEFAULT 0 COMMENT 'For UI sorting',
    is_active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_code (category_code),
    INDEX idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Waste classification categories per ordinance';

-- ============================================================
-- TABLE 3: TBL_CARD_ASSETS
-- Stores metadata for Standardized Printable Eco-Cards
-- ============================================================
CREATE TABLE TBL_CARD_ASSETS (
    card_id INT AUTO_INCREMENT PRIMARY KEY,
    category_id INT NOT NULL,
    card_name VARCHAR(100) NOT NULL COMMENT 'e.g., Plastic Bottle, Banana Peel',
    card_code VARCHAR(50) NOT NULL UNIQUE COMMENT 'Unique identifier: PB001, BP002',
    image_filename VARCHAR(255) NOT NULL COMMENT 'High-res image file for PDF generation',
    image_path VARCHAR(500) NOT NULL,
    description TEXT,
    pdf_generated TINYINT(1) DEFAULT 0 COMMENT 'Whether PDF template exists',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    is_active TINYINT(1) DEFAULT 1,
    FOREIGN KEY (category_id) REFERENCES TBL_CATEGORIES(category_id) ON DELETE RESTRICT ON UPDATE CASCADE,
    INDEX idx_category (category_id),
    INDEX idx_code (card_code),
    INDEX idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Printable Eco-Card asset registry';

-- ============================================================
-- TABLE 4: TBL_GOLDEN_DATASET
-- Stores binary ORB feature vectors for recognition (Universal Golden Dataset)
-- ============================================================
CREATE TABLE TBL_GOLDEN_DATASET (
    dataset_id INT AUTO_INCREMENT PRIMARY KEY,
    card_id INT NOT NULL,
    feature_vector LONGBLOB NOT NULL COMMENT 'Serialized ORB binary descriptors (NumPy array)',
    keypoints_data LONGBLOB COMMENT 'Serialized keypoint coordinates',
    feature_count INT COMMENT 'Number of detected ORB features',
    image_hash VARCHAR(64) COMMENT 'SHA-256 hash for deduplication',
    training_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    algorithm_version VARCHAR(20) DEFAULT 'ORB-KNN-v1.0',
    FOREIGN KEY (card_id) REFERENCES TBL_CARD_ASSETS(card_id) ON DELETE CASCADE ON UPDATE CASCADE,
    UNIQUE KEY unique_card_hash (card_id, image_hash),
    INDEX idx_card (card_id),
    INDEX idx_timestamp (training_timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='ORB feature vectors for KNN classification';

-- ============================================================
-- TABLE 5: TBL_SESSIONS
-- Tracks student learning sessions with metadata
-- ============================================================
CREATE TABLE TBL_SESSIONS (
    session_id INT AUTO_INCREMENT PRIMARY KEY,
    student_nickname VARCHAR(50) NOT NULL COMMENT 'Anonymous pseudonym for data privacy',
    session_mode ENUM('instructional', 'assessment') DEFAULT 'instructional',
    start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    end_time TIMESTAMP NULL,
    total_scans INT DEFAULT 0,
    correct_scans INT DEFAULT 0,
    accuracy_percentage DECIMAL(5,2) DEFAULT 0.00 COMMENT 'Calculated: (correct/total)*100',
    average_response_time DECIMAL(6,2) COMMENT 'In milliseconds',
    session_status ENUM('active', 'completed', 'abandoned', 'admin_preset') DEFAULT 'active',
    ip_address VARCHAR(45) COMMENT 'For audit trail',
    INDEX idx_nickname (student_nickname),
    INDEX idx_mode (session_mode),
    INDEX idx_status (session_status),
    INDEX idx_start (start_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Student session metadata for proficiency tracking';

-- ============================================================
-- TABLE 6: TBL_SCAN_TRANSACTIONS
-- Logs individual scan records during sessions
-- ============================================================
CREATE TABLE TBL_SCAN_TRANSACTIONS (
    transaction_id INT AUTO_INCREMENT PRIMARY KEY,
    session_id INT NOT NULL,
    card_id INT NOT NULL,
    predicted_category_id INT NOT NULL COMMENT 'What the system predicted',
    actual_category_id INT NOT NULL COMMENT 'Correct category from card metadata',
    is_correct TINYINT(1) GENERATED ALWAYS AS (predicted_category_id = actual_category_id) STORED,
    confidence_score DECIMAL(5,4) COMMENT 'KNN matching confidence (0-1)',
    response_time INT COMMENT 'Recognition latency in milliseconds',
    scan_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    feedback_given TINYINT(1) DEFAULT 0 COMMENT 'Whether Bin-Bin feedback was shown',
    FOREIGN KEY (session_id) REFERENCES TBL_SESSIONS(session_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (card_id) REFERENCES TBL_CARD_ASSETS(card_id) ON DELETE RESTRICT ON UPDATE CASCADE,
    FOREIGN KEY (predicted_category_id) REFERENCES TBL_CATEGORIES(category_id) ON DELETE RESTRICT ON UPDATE CASCADE,
    FOREIGN KEY (actual_category_id) REFERENCES TBL_CATEGORIES(category_id) ON DELETE RESTRICT ON UPDATE CASCADE,
    INDEX idx_session (session_id),
    INDEX idx_card (card_id),
    INDEX idx_correct (is_correct),
    INDEX idx_timestamp (scan_timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Individual scan transaction logs';

-- ============================================================
-- TABLE 7: TBL_SYSTEM_CONFIG
-- Stores dynamic system configuration without source code changes
-- ============================================================
CREATE TABLE TBL_SYSTEM_CONFIG (
    config_id INT AUTO_INCREMENT PRIMARY KEY,
    config_key VARCHAR(100) NOT NULL UNIQUE,
    config_value TEXT NOT NULL,
    value_type ENUM('string', 'integer', 'float', 'boolean', 'json') DEFAULT 'string',
    description TEXT,
    is_editable TINYINT(1) DEFAULT 1 COMMENT 'Whether admin can modify',
    last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    modified_by INT COMMENT 'Admin who last modified',
    FOREIGN KEY (modified_by) REFERENCES TBL_ADMIN(admin_id) ON DELETE SET NULL ON UPDATE CASCADE,
    INDEX idx_key (config_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Dynamic system configuration parameters';

-- ============================================================
-- INSERT DEFAULT DATA
-- ============================================================

-- Default Administrator (Password: admin123 - MUST BE CHANGED IN PRODUCTION)
INSERT INTO TBL_ADMIN (username, password_hash, full_name, email, is_active) VALUES
('admin', '$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'System Administrator', 'admin@ecolearn.local', 1);

-- Four Waste Categories (Per Municipal Ordinance No. 007-06, Section 66)
INSERT INTO TBL_CATEGORIES (category_name, category_code, description, bin_color, display_order, is_active) VALUES
('Compostable', 'COMP', 'Biodegradable organic waste including food scraps, garden waste, and paper products', 'Green', 1, 1),
('Recyclable', 'RECY', 'Materials that can be processed and reused: plastic bottles, metal cans, glass, clean paper', 'Blue', 2, 1),
('Non-Recyclable', 'NREC', 'Residual waste that cannot be composted or recycled: contaminated materials, mixed composites', 'Red', 3, 1),
('Special Waste', 'SPEC', 'Hazardous materials requiring special handling: batteries, electronics, medical waste, chemicals', 'Yellow', 4, 1);

-- System Configuration Defaults
INSERT INTO TBL_SYSTEM_CONFIG (config_key, config_value, value_type, description, is_editable) VALUES
('orb_feature_count', '500', 'integer', 'Number of ORB features to extract per image', 1),
('knn_k_value', '3', 'integer', 'K value for KNN classifier (number of neighbors)', 1),
('knn_distance_threshold', '0.75', 'float', 'Lowe ratio test threshold for feature matching', 1),
('model_version', 'ORB-KNN-v1.0', 'string', 'Current algorithm version identifier', 0),
('session_timeout_minutes', '30', 'integer', 'Auto-abandon sessions after N minutes of inactivity', 1),
('min_confidence_score', '0.60', 'float', 'Minimum confidence to accept a classification', 1),
('webcam_fps', '30', 'integer', 'Target frames per second for video capture', 1),
('roi_box_color', '#00FF00', 'string', 'Hex color code for scanning area overlay', 1),
('enable_audio_feedback', 'true', 'boolean', 'Whether Bin-Bin provides audio responses', 1),
('pdf_dpi', '300', 'integer', 'Resolution for generating printable Eco-Cards', 0);

-- ============================================================
-- STORED PROCEDURES FOR COMMON OPERATIONS
-- ============================================================

-- Procedure: Calculate Session Accuracy
DELIMITER //
CREATE PROCEDURE UpdateSessionAccuracy(IN p_session_id INT)
BEGIN
    UPDATE TBL_SESSIONS
    SET 
        total_scans = (SELECT COUNT(*) FROM TBL_SCAN_TRANSACTIONS WHERE session_id = p_session_id),
        correct_scans = (SELECT COUNT(*) FROM TBL_SCAN_TRANSACTIONS WHERE session_id = p_session_id AND is_correct = 1),
        accuracy_percentage = (
            SELECT ROUND((SUM(is_correct) / COUNT(*)) * 100, 2)
            FROM TBL_SCAN_TRANSACTIONS
            WHERE session_id = p_session_id
        ),
        average_response_time = (
            SELECT ROUND(AVG(response_time), 2)
            FROM TBL_SCAN_TRANSACTIONS
            WHERE session_id = p_session_id
        )
    WHERE session_id = p_session_id;
END //
DELIMITER ;

-- Procedure: Get Student Proficiency Ranking
DELIMITER //
CREATE PROCEDURE GetProficiencyRanking(IN p_mode VARCHAR(20))
BEGIN
    SELECT 
        student_nickname,
        COUNT(DISTINCT session_id) as total_sessions,
        AVG(accuracy_percentage) as avg_accuracy,
        AVG(average_response_time) as avg_speed,
        MAX(accuracy_percentage) as best_score,
        RANK() OVER (ORDER BY AVG(accuracy_percentage) DESC) as ranking
    FROM TBL_SESSIONS
    WHERE session_status = 'completed'
        AND (p_mode IS NULL OR session_mode = p_mode)
    GROUP BY student_nickname
    ORDER BY avg_accuracy DESC, avg_speed ASC;
END //
DELIMITER ;

-- Procedure: Generate Confusion Matrix Data
DELIMITER //
CREATE PROCEDURE GetConfusionMatrix(IN p_session_id INT)
BEGIN
    SELECT 
        ac.category_name as actual_category,
        pc.category_name as predicted_category,
        COUNT(*) as count
    FROM TBL_SCAN_TRANSACTIONS st
    JOIN TBL_CARD_ASSETS ca ON st.card_id = ca.card_id
    JOIN TBL_CATEGORIES ac ON st.actual_category_id = ac.category_id
    JOIN TBL_CATEGORIES pc ON st.predicted_category_id = pc.category_id
    WHERE st.session_id = p_session_id
    GROUP BY actual_category, predicted_category
    ORDER BY actual_category, predicted_category;
END //
DELIMITER ;

-- ============================================================
-- VIEWS FOR REPORTING AND ANALYTICS
-- ============================================================

-- View: Active Sessions Dashboard
CREATE VIEW vw_active_sessions AS
SELECT 
    s.session_id,
    s.student_nickname,
    s.session_mode,
    s.start_time,
    s.total_scans,
    s.correct_scans,
    s.accuracy_percentage,
    TIMESTAMPDIFF(MINUTE, s.start_time, NOW()) as duration_minutes,
    s.session_status
FROM TBL_SESSIONS s
WHERE s.session_status = 'active';

-- View: Card Recognition Performance
CREATE VIEW vw_card_performance AS
SELECT 
    ca.card_id,
    ca.card_name,
    c.category_name,
    COUNT(st.transaction_id) as total_scans,
    SUM(st.is_correct) as correct_classifications,
    ROUND((SUM(st.is_correct) / COUNT(*)) * 100, 2) as accuracy_rate,
    AVG(st.confidence_score) as avg_confidence,
    AVG(st.response_time) as avg_response_time_ms
FROM TBL_CARD_ASSETS ca
LEFT JOIN TBL_SCAN_TRANSACTIONS st ON ca.card_id = st.card_id
LEFT JOIN TBL_CATEGORIES c ON ca.category_id = c.category_id
GROUP BY ca.card_id, ca.card_name, c.category_name;

-- View: Student Proficiency Summary
CREATE VIEW vw_student_proficiency AS
SELECT 
    s.student_nickname,
    COUNT(DISTINCT s.session_id) as total_sessions,
    SUM(s.total_scans) as total_scans,
    SUM(s.correct_scans) as total_correct,
    ROUND(AVG(s.accuracy_percentage), 2) as overall_accuracy,
    ROUND(AVG(s.average_response_time), 2) as avg_response_time,
    MAX(s.accuracy_percentage) as best_session_accuracy,
    MIN(s.accuracy_percentage) as worst_session_accuracy
FROM TBL_SESSIONS s
WHERE s.session_status = 'completed'
GROUP BY s.student_nickname;

-- ============================================================
-- TRIGGERS FOR DATA INTEGRITY
-- ============================================================

-- Trigger: Auto-calculate session metrics after scan insert
DELIMITER //
CREATE TRIGGER trg_after_scan_insert
AFTER INSERT ON TBL_SCAN_TRANSACTIONS
FOR EACH ROW
BEGIN
    CALL UpdateSessionAccuracy(NEW.session_id);
END //
DELIMITER ;

-- Trigger: Update last_login for admin
DELIMITER //
CREATE TRIGGER trg_after_admin_login
BEFORE UPDATE ON TBL_ADMIN
FOR EACH ROW
BEGIN
    IF NEW.last_login IS NOT NULL AND OLD.last_login != NEW.last_login THEN
        SET NEW.last_login = CURRENT_TIMESTAMP;
    END IF;
END //
DELIMITER ;

-- ============================================================
-- INDEXES FOR OPTIMIZATION
-- ============================================================

-- Composite index for session analytics
CREATE INDEX idx_session_analytics ON TBL_SESSIONS(student_nickname, session_mode, session_status);

-- Composite index for transaction queries
CREATE INDEX idx_transaction_analysis ON TBL_SCAN_TRANSACTIONS(session_id, is_correct, scan_timestamp);

-- ============================================================
-- SECURITY AND CONSTRAINTS
-- ============================================================

-- Ensure category codes remain consistent
ALTER TABLE TBL_CATEGORIES 
ADD CONSTRAINT chk_category_code 
CHECK (category_code IN ('COMP', 'RECY', 'NREC', 'SPEC'));

-- Ensure accuracy percentage is valid
ALTER TABLE TBL_SESSIONS
ADD CONSTRAINT chk_accuracy_range
CHECK (accuracy_percentage BETWEEN 0 AND 100);

-- Ensure confidence score is normalized
ALTER TABLE TBL_SCAN_TRANSACTIONS
ADD CONSTRAINT chk_confidence_range
CHECK (confidence_score IS NULL OR (confidence_score BETWEEN 0 AND 1));

-- ============================================================
-- DATABASE SETUP COMPLETE
-- ============================================================

-- Display summary
SELECT 'EcoLearn Database Schema Created Successfully!' as Status;

-- ============================================================
-- INSERT SAMPLE DATA INTO TBL_CARD_ASSETS
-- ============================================================

-- CATEGORY 1: COMPOSTABLE (12 Items)
-- Folder: assets/Compostable/
INSERT INTO TBL_CARD_ASSETS (category_id, card_name, card_code, image_filename, image_path) VALUES 
(1, 'Pencil Shavings', 'COMP-001', 'Pencil_Shavings.webp', 'assets/Compostable/Pencil_Shavings.webp'),
(1, 'Vegetable Scraps', 'COMP-002', 'Vegetable_Scraps.webp', 'assets/Compostable/Vegetable_Scraps.webp'),
(1, 'Apple Core', 'COMP-003', 'Apple_Core.webp', 'assets/Compostable/Apple_Core.webp'),
(1, 'Banana Peel', 'COMP-004', 'Banana_Peel.webp', 'assets/Compostable/Banana_Peel.webp'),
(1, 'Chicken Bone', 'COMP-005', 'Chicken_Bone.webp', 'assets/Compostable/Chicken_Bone.webp'),
(1, 'Corn Cob', 'COMP-006', 'Corn_Cob.webp', 'assets/Compostable/Corn_Cob.webp'),
(1, 'Dried Leaves', 'COMP-007', 'Dried_Leaves.webp', 'assets/Compostable/Dried_Leaves.webp'),
(1, 'Egg Shell', 'COMP-008', 'Egg_Shell.webp', 'assets/Compostable/Egg_Shell.webp'),
(1, 'Fish Bone', 'COMP-009', 'Fish_Bone.webp', 'assets/Compostable/Fish_Bone.webp'),
(1, 'Leftover Rice', 'COMP-010', 'Leftover_Rice.webp', 'assets/Compostable/Leftover_Rice.webp'),
(1, 'Mango Peel', 'COMP-011', 'Mango_Peel.webp', 'assets/Compostable/Mango_Peel.webp'),
(1, 'Orange Peel', 'COMP-012', 'Orange_Peel.webp', 'assets/Compostable/Orange_Peel.webp');

-- CATEGORY 2: RECYCLABLE (12 Items)
-- Folder: assets/Recyclable/
INSERT INTO TBL_CARD_ASSETS (category_id, card_name, card_code, image_filename, image_path) VALUES 
(2, 'Glass Bottle', 'RECY-001', 'Glass_Bottle.webp', 'assets/Recyclable/Glass_Bottle.webp'),
(2, 'Newspaper', 'RECY-002', 'Newspaper.webp', 'assets/Recyclable/Newspaper.webp'),
(2, 'Plastic Bottle', 'RECY-003', 'Plastic_Bottle.webp', 'assets/Recyclable/Plastic_Bottle.webp'),
(2, 'Rubbing Alcohol', 'RECY-004', 'Rubbing_Alcohol.webp', 'assets/Recyclable/Rubbing_Alcohol.webp'),
(2, 'Shampoo Bottle', 'RECY-005', 'Shampoo_Bottle.webp', 'assets/Recyclable/Shampoo_Bottle.webp'),
(2, 'Tetra Packs', 'RECY-006', 'Tetra_Packs.webp', 'assets/Recyclable/Tetra_Packs.webp'),
(2, 'Tin Can', 'RECY-007', 'Tin_Can.webp', 'assets/Recyclable/Tin_Can.webp'),
(2, 'Toilet Paper Roll', 'RECY-008', 'Toilet_Paper_Roll.webp', 'assets/Recyclable/Toilet_Paper_Roll.webp'),
(2, 'White Paper', 'RECY-009', 'White_Paper.webp', 'assets/Recyclable/White_Paper.webp'),
(2, 'Aluminum Can', 'RECY-010', 'Aluminum_Can.webp', 'assets/Recyclable/Aluminum_Can.webp'),
(2, 'Brown Paper Bag', 'RECY-011', 'Brown_Paper_Bag.webp', 'assets/Recyclable/Brown_Paper_Bag.webp'),
(2, 'Cardboard Box', 'RECY-012', 'Cardboard_Box.webp', 'assets/Recyclable/Cardboard_Box.webp');

-- CATEGORY 3: NON-RECYCLABLE (12 Items)
-- Folder: assets/Non-Recyclable/
INSERT INTO TBL_CARD_ASSETS (category_id, card_name, card_code, image_filename, image_path) VALUES 
(3, 'Styrofoam Plate', 'NREC-001', 'Styrofoam_Plate.webp', 'assets/Non-Recyclable/Styrofoam_Plate.webp'),
(3, 'Tissue Paper', 'NREC-002', 'Tissue_Paper.webp', 'assets/Non-Recyclable/Tissue_Paper.webp'),
(3, '3in1 Coffee Sachet', 'NREC-003', '3in1_Coffee_Sachet.webp', 'assets/Non-Recyclable/3in1_Coffee_Sachet.webp'),
(3, 'Candy Wrapper', 'NREC-004', 'Candy_Wrapper.webp', 'assets/Non-Recyclable/Candy_Wrapper.webp'),
(3, 'Chips Wrapper', 'NREC-005', 'Chips_Wrapper.webp', 'assets/Non-Recyclable/Chips_Wrapper.webp'),
(3, 'Diaper', 'NREC-006', 'Diaper.webp', 'assets/Non-Recyclable/Diaper.webp'),
(3, 'Plastic Cup', 'NREC-007', 'Plastic_Cup.webp', 'assets/Non-Recyclable/Plastic_Cup.webp'),
(3, 'Plastic Fork', 'NREC-008', 'Plastic_Fork.webp', 'assets/Non-Recyclable/Plastic_Fork.webp'),
(3, 'Plastic Labo', 'NREC-009', 'Plastic_Labo.webp', 'assets/Non-Recyclable/Plastic_Labo.webp'),
(3, 'Plastic Spoon', 'NREC-010', 'Plastic_Spoon.webp', 'assets/Non-Recyclable/Plastic_Spoon.webp'),
(3, 'Plastic Straw', 'NREC-011', 'Plastic_Straw.webp', 'assets/Non-Recyclable/Plastic_Straw.webp'),
(3, 'Shampoo Sachet', 'NREC-012', 'Shampoo_Sachet.webp', 'assets/Non-Recyclable/Shampoo_Sachet.webp');

-- CATEGORY 4: SPECIAL WASTE (10 Items)
-- Folder: assets/Special-Waste/
INSERT INTO TBL_CARD_ASSETS (category_id, card_name, card_code, image_filename, image_path) VALUES 
(4, 'Face Mask', 'SPEC-001', 'Face_Mask.webp', 'assets/Special-Waste/Face_Mask.webp'),
(4, 'Insecticide Bottle', 'SPEC-002', 'Insecticide_Bottle.webp', 'assets/Special-Waste/Insecticide_Bottle.webp'),
(4, 'Lightbulb', 'SPEC-003', 'Lightbulb.webp', 'assets/Special-Waste/Lightbulb.webp'),
(4, 'Medicine Blister Pack', 'SPEC-004', 'Medicine_Blister _Pack.webp', 'assets/Special-Waste/Medicine_Blister _Pack.webp'),
(4, 'Nail Polish Bottle', 'SPEC-005', 'Nail_Polish_Bottle.webp', 'assets/Special-Waste/Nail_Polish_Bottle.webp'),
(4, 'Paint Container', 'SPEC-006', 'Paint_Container.webp', 'assets/Special-Waste/Paint_Container.webp'),
(4, 'Spray Paint Can', 'SPEC-007', 'Spraypaint_Can.webp', 'assets/Special-Waste/Spraypaint_Can.webp'),
(4, 'Battery', 'SPEC-008', 'Battery.webp', 'assets/Special-Waste/Battery.webp'),
(4, 'Broken Glass', 'SPEC-009', 'Broken_Glass.webp', 'assets/Special-Waste/Broken_Glass.webp'),
(4, 'Electronic Waste', 'SPEC-010', 'Electronic_Waste.webp', 'assets/Special-Waste/Electronic_Waste.webp');

-- ============================================================
-- PERFORMANCE INDEXES
-- These eliminate "Full Table Scans" for 10-20x faster queries
-- ============================================================

-- Card Assets: Gallery loading optimization
CREATE INDEX idx_active_category ON TBL_CARD_ASSETS (is_active, category_id);
CREATE INDEX idx_gallery_cover ON TBL_CARD_ASSETS (is_active, category_id, card_id, card_name, image_path);

-- Golden Dataset: Feature matching speed
CREATE INDEX idx_features_cover ON TBL_GOLDEN_DATASET (card_id, dataset_id);

-- Scan Transactions: Dashboard stats and confusion matrix
CREATE INDEX idx_logs_time_session ON TBL_SCAN_TRANSACTIONS (scan_timestamp, session_id);
CREATE INDEX idx_logs_correct ON TBL_SCAN_TRANSACTIONS (is_correct, card_id);
CREATE INDEX idx_logs_category ON TBL_SCAN_TRANSACTIONS (actual_category_id, predicted_category_id, is_correct);

-- Sessions: Leaderboard and proficiency queries
CREATE INDEX idx_session_nickname_mode ON TBL_SESSIONS (student_nickname, session_mode);
CREATE INDEX idx_session_accuracy ON TBL_SESSIONS (accuracy_percentage, correct_scans);

-- Config: Quick lookups
CREATE INDEX idx_config_active ON TBL_SYSTEM_CONFIG (is_editable, config_key);

-- ============================================================
-- END OF SCHEMA
-- EcoLearn Database v1.0 - Ready for deployment
-- ============================================================
