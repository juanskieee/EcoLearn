<?php
require_once 'check_session.php';

$host = 'localhost';
$username = 'root';
$password = '';
$database = 'ecolearn_db';

$rootDir = realpath(__DIR__ . '/..');
$backupDir = $rootDir . DIRECTORY_SEPARATOR . 'database' . DIRECTORY_SEPARATOR . 'backups';
$settingsFile = $backupDir . DIRECTORY_SEPARATOR . 'backup_settings.json';

if (!is_dir($backupDir)) {
    mkdir($backupDir, 0775, true);
}

function load_backup_settings($settingsFile) {
    if (!file_exists($settingsFile)) {
        return [
            'auto_backup_enabled' => false,
            'last_backup_at' => null,
            'last_backup_file' => null
        ];
    }

    $raw = file_get_contents($settingsFile);
    if ($raw === false) {
        return [
            'auto_backup_enabled' => false,
            'last_backup_at' => null,
            'last_backup_file' => null
        ];
    }

    $data = json_decode($raw, true);
    if (!is_array($data)) {
        return [
            'auto_backup_enabled' => false,
            'last_backup_at' => null,
            'last_backup_file' => null
        ];
    }

    $data['auto_backup_enabled'] = isset($data['auto_backup_enabled']) ? (bool)$data['auto_backup_enabled'] : false;
    $data['last_backup_at'] = $data['last_backup_at'] ?? null;
    $data['last_backup_file'] = $data['last_backup_file'] ?? null;

    return $data;
}

function save_backup_settings($settingsFile, $settings) {
    $payload = json_encode($settings, JSON_PRETTY_PRINT);
    if ($payload === false) {
        return false;
    }

    return file_put_contents($settingsFile, $payload, LOCK_EX) !== false;
}

$conn = new mysqli($host, $username, $password, $database);

if ($conn->connect_error) {
    header('Content-Type: application/json', true, 500);
    echo json_encode([
        'status' => 'error',
        'message' => 'Database connection failed'
    ]);
    exit;
}

$tables = [];
$result = $conn->query("SHOW TABLES");
if ($result) {
    while ($row = $result->fetch_row()) {
        $tables[] = $row[0];
    }
}

$sql = "-- Database Backup for EcoLearn\n";
$sql .= "-- Generated: " . date("Y-m-d H:i:s") . "\n\n";

foreach ($tables as $table) {
    $result = $conn->query("SELECT * FROM `$table`");
    if (!$result) {
        continue;
    }
    $numColumns = $result->field_count;

    $sql .= "DROP TABLE IF EXISTS `$table`;\n";
    $createTableResult = $conn->query("SHOW CREATE TABLE `$table`");
    if ($createTableResult) {
        $createTableRow = $createTableResult->fetch_row();
        $sql .= $createTableRow[1] . ";\n\n";
    }

    while ($row = $result->fetch_row()) {
        $sql .= "INSERT INTO `$table` VALUES(";
        for ($j = 0; $j < $numColumns; $j++) {
            $row[$j] = $row[$j] ?? '';
            $row[$j] = $conn->real_escape_string($row[$j]);
            $sql .= "'" . $row[$j] . "'";
            if ($j < ($numColumns - 1)) {
                $sql .= ', ';
            }
        }
        $sql .= ");\n";
    }
    $sql .= "\n\n";
}

$conn->close();

$filename = 'ecolearn_backup_' . date("Y-m-d_H-i-s") . '.sql';
$filePath = $backupDir . DIRECTORY_SEPARATOR . $filename;

if (file_put_contents($filePath, $sql, LOCK_EX) === false) {
    header('Content-Type: application/json', true, 500);
    echo json_encode([
        'status' => 'error',
        'message' => 'Unable to write backup file'
    ]);
    exit;
}

$settings = load_backup_settings($settingsFile);
$settings['last_backup_at'] = date('c');
$settings['last_backup_file'] = $filename;
save_backup_settings($settingsFile, $settings);

$mode = isset($_GET['mode']) ? $_GET['mode'] : 'json';
if ($mode === 'download') {
    header('Content-Type: application/octet-stream');
    header('Content-Transfer-Encoding: Binary');
    header('Content-disposition: attachment; filename="' . $filename . '"');
    readfile($filePath);
    exit;
}

$relativePath = 'database/backups/' . $filename;
header('Content-Type: application/json');
echo json_encode([
    'status' => 'success',
    'backup_file' => $filename,
    'backup_path' => $relativePath,
    'last_backup_at' => $settings['last_backup_at']
]);
exit;
?>