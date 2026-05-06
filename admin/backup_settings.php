<?php
require_once 'check_session.php';

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

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $settings = load_backup_settings($settingsFile);
    header('Content-Type: application/json');
    echo json_encode([
        'status' => 'success',
        'settings' => $settings
    ]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $rawInput = file_get_contents('php://input');
    $data = json_decode($rawInput, true);

    if (!is_array($data) || !array_key_exists('auto_backup_enabled', $data)) {
        header('Content-Type: application/json', true, 400);
        echo json_encode([
            'status' => 'error',
            'message' => 'Invalid payload'
        ]);
        exit;
    }

    $settings = load_backup_settings($settingsFile);
    $settings['auto_backup_enabled'] = (bool)$data['auto_backup_enabled'];

    if (!save_backup_settings($settingsFile, $settings)) {
        header('Content-Type: application/json', true, 500);
        echo json_encode([
            'status' => 'error',
            'message' => 'Unable to save settings'
        ]);
        exit;
    }

    header('Content-Type: application/json');
    echo json_encode([
        'status' => 'success',
        'settings' => $settings
    ]);
    exit;
}

header('Content-Type: application/json', true, 405);
echo json_encode([
    'status' => 'error',
    'message' => 'Method not allowed'
]);
exit;
?>