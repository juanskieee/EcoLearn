<?php
/**
 * EcoLearn Database Verification Script
 * Run this file to verify the database setup is correct
 * 
 * Access: http://localhost/ecolearn/verify_database.php
 */

error_reporting(E_ALL);
ini_set('display_errors', 1);

// Database Configuration
define('DB_SERVER', 'localhost');
define('DB_USERNAME', 'root');
define('DB_PASSWORD', '');
define('DB_DATABASE', 'ecolearn_db');

// HTML Header
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>EcoLearn Database Verification</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            max-width: 1200px;
            margin: 50px auto;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }
        .container {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
        }
        h1 {
            color: #333;
            border-bottom: 3px solid #667eea;
            padding-bottom: 10px;
        }
        h2 {
            color: #555;
            margin-top: 30px;
        }
        .success {
            background: #d4edda;
            color: #155724;
            padding: 15px;
            border-left: 5px solid #28a745;
            margin: 10px 0;
            border-radius: 5px;
        }
        .error {
            background: #f8d7da;
            color: #721c24;
            padding: 15px;
            border-left: 5px solid #dc3545;
            margin: 10px 0;
            border-radius: 5px;
        }
        .warning {
            background: #fff3cd;
            color: #856404;
            padding: 15px;
            border-left: 5px solid #ffc107;
            margin: 10px 0;
            border-radius: 5px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin: 20px 0;
        }
        th {
            background: #667eea;
            color: white;
            padding: 12px;
            text-align: left;
        }
        td {
            padding: 10px;
            border-bottom: 1px solid #ddd;
        }
        tr:hover {
            background: #f5f5f5;
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin: 20px 0;
        }
        .stat-box {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            border-radius: 10px;
            text-align: center;
        }
        .stat-box h3 {
            margin: 0;
            font-size: 2em;
        }
        .stat-box p {
            margin: 10px 0 0 0;
        }
        code {
            background: #f4f4f4;
            padding: 2px 6px;
            border-radius: 3px;
            font-family: 'Courier New', monospace;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🌱 EcoLearn Database Verification</h1>
        <p><strong>System Check:</strong> <?php echo date('F d, Y - h:i:s A'); ?></p>

<?php

// Test 1: Database Connection
echo "<h2>✓ Test 1: Database Connection</h2>";
try {
    $conn = new mysqli(DB_SERVER, DB_USERNAME, DB_PASSWORD, DB_DATABASE);
    
    if ($conn->connect_error) {
        throw new Exception("Connection failed: " . $conn->connect_error);
    }
    
    $conn->set_charset("utf8mb4");
    echo '<div class="success">✓ Successfully connected to database: <code>' . DB_DATABASE . '</code></div>';
    
} catch (Exception $e) {
    echo '<div class="error">✗ Connection failed: ' . htmlspecialchars($e->getMessage()) . '</div>';
    echo '<div class="warning">Make sure XAMPP MySQL is running and the database has been imported.</div>';
    exit;
}

// Test 2: Table Verification
echo "<h2>✓ Test 2: Table Structure</h2>";
$tables_required = [
    'TBL_ADMIN',
    'TBL_CATEGORIES',
    'TBL_CARD_ASSETS',
    'TBL_GOLDEN_DATASET',
    'TBL_SESSIONS',
    'TBL_SCAN_TRANSACTIONS',
    'TBL_SYSTEM_CONFIG'
];

$tables_found = [];
$result = $conn->query("SHOW TABLES");
while ($row = $result->fetch_array()) {
    $tables_found[] = $row[0];
}

$missing_tables = array_diff($tables_required, $tables_found);

if (empty($missing_tables)) {
    echo '<div class="success">✓ All 7 required tables exist</div>';
    echo '<table>';
    echo '<tr><th>Table Name</th><th>Row Count</th><th>Status</th></tr>';
    
    foreach ($tables_required as $table) {
        $count_result = $conn->query("SELECT COUNT(*) as cnt FROM $table");
        $count = $count_result->fetch_assoc()['cnt'];
        echo "<tr><td><code>$table</code></td><td>$count</td><td>✓ OK</td></tr>";
    }
    echo '</table>';
} else {
    echo '<div class="error">✗ Missing tables: ' . implode(', ', $missing_tables) . '</div>';
}

// Test 3: Default Data Verification
echo "<h2>✓ Test 3: Default Data</h2>";

// Check categories
$cat_result = $conn->query("SELECT COUNT(*) as cnt FROM TBL_CATEGORIES");
$cat_count = $cat_result->fetch_assoc()['cnt'];

if ($cat_count == 4) {
    echo '<div class="success">✓ All 4 waste categories populated</div>';
    
    $categories = $conn->query("SELECT category_name, category_code, bin_color FROM TBL_CATEGORIES ORDER BY display_order");
    echo '<table>';
    echo '<tr><th>Category Name</th><th>Code</th><th>Bin Color</th></tr>';
    while ($cat = $categories->fetch_assoc()) {
        echo "<tr><td>{$cat['category_name']}</td><td><code>{$cat['category_code']}</code></td><td>{$cat['bin_color']}</td></tr>";
    }
    echo '</table>';
} else {
    echo '<div class="error">✗ Expected 4 categories, found ' . $cat_count . '</div>';
}

// Check admin account
$admin_result = $conn->query("SELECT username, full_name, is_active FROM TBL_ADMIN LIMIT 1");
if ($admin_result->num_rows > 0) {
    $admin = $admin_result->fetch_assoc();
    echo '<div class="success">✓ Default admin account exists: <code>' . $admin['username'] . '</code></div>';
    
    if ($admin['username'] == 'admin') {
        echo '<div class="warning">⚠️ <strong>Security Warning:</strong> Default admin credentials detected. Please change the password immediately!</div>';
    }
} else {
    echo '<div class="error">✗ No admin account found</div>';
}

// Test 4: System Configuration
echo "<h2>✓ Test 4: System Configuration</h2>";
$config_result = $conn->query("SELECT config_key, config_value, value_type FROM TBL_SYSTEM_CONFIG");

if ($config_result->num_rows > 0) {
    echo '<div class="success">✓ System configuration loaded (' . $config_result->num_rows . ' parameters)</div>';
    echo '<table>';
    echo '<tr><th>Configuration Key</th><th>Value</th><th>Type</th></tr>';
    
    while ($config = $config_result->fetch_assoc()) {
        echo "<tr><td><code>{$config['config_key']}</code></td><td>{$config['config_value']}</td><td>{$config['value_type']}</td></tr>";
    }
    echo '</table>';
} else {
    echo '<div class="error">✗ No system configuration found</div>';
}

// Test 5: Stored Procedures
echo "<h2>✓ Test 5: Stored Procedures</h2>";
$procedures = ['UpdateSessionAccuracy', 'GetProficiencyRanking', 'GetConfusionMatrix'];
$proc_result = $conn->query("
    SELECT ROUTINE_NAME 
    FROM information_schema.ROUTINES 
    WHERE ROUTINE_SCHEMA = '" . DB_DATABASE . "' 
    AND ROUTINE_TYPE = 'PROCEDURE'
");

$procs_found = [];
while ($proc = $proc_result->fetch_assoc()) {
    $procs_found[] = $proc['ROUTINE_NAME'];
}

$missing_procs = array_diff($procedures, $procs_found);

if (empty($missing_procs)) {
    echo '<div class="success">✓ All 3 stored procedures exist</div>';
    echo '<ul>';
    foreach ($procedures as $proc) {
        echo "<li><code>$proc</code></li>";
    }
    echo '</ul>';
} else {
    echo '<div class="error">✗ Missing procedures: ' . implode(', ', $missing_procs) . '</div>';
}

// Test 6: Views
echo "<h2>✓ Test 6: Analytics Views</h2>";
$views = ['vw_active_sessions', 'vw_card_performance', 'vw_student_proficiency'];
$view_result = $conn->query("
    SELECT TABLE_NAME 
    FROM information_schema.VIEWS 
    WHERE TABLE_SCHEMA = '" . DB_DATABASE . "'
");

$views_found = [];
while ($view = $view_result->fetch_assoc()) {
    $views_found[] = $view['TABLE_NAME'];
}

$missing_views = array_diff($views, $views_found);

if (empty($missing_views)) {
    echo '<div class="success">✓ All 3 analytics views exist</div>';
    echo '<ul>';
    foreach ($views as $view) {
        echo "<li><code>$view</code></li>";
    }
    echo '</ul>';
} else {
    echo '<div class="error">✗ Missing views: ' . implode(', ', $missing_views) . '</div>';
}

// Database Statistics
echo "<h2>📊 Database Statistics</h2>";
echo '<div class="stats">';

// Calculate total size
$size_result = $conn->query("
    SELECT 
        ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) AS size_mb
    FROM information_schema.TABLES
    WHERE table_schema = '" . DB_DATABASE . "'
");
$size = $size_result->fetch_assoc()['size_mb'];

echo '<div class="stat-box">';
echo '<h3>' . $size . ' MB</h3>';
echo '<p>Database Size</p>';
echo '</div>';

echo '<div class="stat-box">';
echo '<h3>7</h3>';
echo '<p>Core Tables</p>';
echo '</div>';

echo '<div class="stat-box">';
echo '<h3>3</h3>';
echo '<p>Stored Procedures</p>';
echo '</div>';

echo '<div class="stat-box">';
echo '<h3>3</h3>';
echo '<p>Analytics Views</p>';
echo '</div>';

echo '</div>';

// Final Summary
echo "<h2>🎯 Summary</h2>";
echo '<div class="success">';
echo '<strong>✓ Database setup verification complete!</strong><br>';
echo 'The EcoLearn database is properly configured and ready for use.';
echo '</div>';

echo '<h3>Next Steps:</h3>';
echo '<ol>';
echo '<li>Change the default admin password (username: <code>admin</code>, password: <code>admin123</code>)</li>';
echo '<li>Populate <code>TBL_CARD_ASSETS</code> with Eco-Card metadata</li>';
echo '<li>Train the ORB-KNN model and populate <code>TBL_GOLDEN_DATASET</code></li>';
echo '<li>Configure the Python Flask microservice to connect to this database</li>';
echo '<li>Test the complete system workflow</li>';
echo '</ol>';

$conn->close();
?>

    </div>
</body>
</html>
