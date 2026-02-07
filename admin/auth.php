<?php
/**
 * EcoLearn - Admin Authentication System
 * Handles login, logout, and session management
 */

session_start();

// Database configuration
$host = 'localhost';
$dbname = 'ecolearn_db';
$db_username = 'root';
$db_password = '';

try {
    $pdo = new PDO("mysql:host=$host;dbname=$dbname", $db_username, $db_password);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
} catch(PDOException $e) {
    die("Database connection failed: " . $e->getMessage());
}

// Handle login request
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['username']) && isset($_POST['password'])) {
    
    $username = trim($_POST['username']);
    $password = trim($_POST['password']);
    
    // Validate input
    if (empty($username) || empty($password)) {
        header("Location: login.php?error=empty");
        exit();
    }
    
    // Query the database for the admin user
    $stmt = $pdo->prepare("SELECT * FROM TBL_ADMIN WHERE username = :username LIMIT 1");
    $stmt->bindParam(':username', $username);
    $stmt->execute();
    
    $admin = $stmt->fetch(PDO::FETCH_ASSOC);
    
    // Verify user exists and password is correct
    if ($admin && password_verify($password, $admin['password_hash'])) {
        // Successful login
        $_SESSION['admin_logged_in'] = true;
        $_SESSION['admin_id'] = $admin['admin_id'];
        $_SESSION['admin_username'] = $admin['username'];
        $_SESSION['admin_full_name'] = $admin['full_name'] ?? 'Administrator';
        $_SESSION['login_time'] = time();
        
        // Redirect to dashboard
        header("Location: index.php");
        exit();
    } else {
        // Invalid credentials
        header("Location: login.php?error=invalid");
        exit();
    }
}

// Handle logout request
if (isset($_GET['action']) && $_GET['action'] === 'logout') {
    session_unset();
    session_destroy();
    header("Location: login.php?error=logout");
    exit();
}

// If direct access, redirect to login
header("Location: login.php");
exit();
?>
