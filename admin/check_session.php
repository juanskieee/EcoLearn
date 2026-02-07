<?php
/**
 * EcoLearn - Session Check
 * Include this file at the top of protected admin pages
 */

session_start();

// Check if admin is logged in
if (!isset($_SESSION['admin_logged_in']) || $_SESSION['admin_logged_in'] !== true) {
    header("Location: login.php");
    exit();
}

// Optional: Check session timeout (30 minutes)
$session_timeout = 1800; // 30 minutes in seconds
if (isset($_SESSION['login_time']) && (time() - $_SESSION['login_time']) > $session_timeout) {
    session_unset();
    session_destroy();
    header("Location: login.php?error=timeout");
    exit();
}

// Update last activity time
$_SESSION['login_time'] = time();
?>
