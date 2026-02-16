<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>EcoLearn - Admin Login</title>
    <link rel="icon" type="image/x-icon" href="../assets/binbin.ico">
    <link rel="stylesheet" href="../css/admin_style.css">
    <link rel="stylesheet" href="../css/admin_login_styles.css">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;600;700&family=Poppins:wght@400;600;700&display=swap" rel="stylesheet">
</head>
<body>

    <div class="login-wrapper">
        <div class="login-card">
            <img src="../assets/leafframe.png" class="login-frame-overlay" alt="Leaf Frame">
            <div class="login-header">
                <img src="../assets/logo.png" class="login-logo" alt="EcoLearn Logo">
                <p>Admin Dashboard</p>
            </div>

            <div id="errorMessage" class="error-message" style="display: none;"></div>

            <form class="login-form" method="POST" action="auth.php" onsubmit="return validateLogin()">
                <div class="form-group">
                    <label for="username">USERNAME</label>
                    <div class="input-wrapper">
                        <input 
                            type="text" 
                            id="username" 
                            name="username" 
                            class="form-input" 
                            placeholder="Enter your username"
                            required
                            autocomplete="username"
                        >
                    </div>
                </div>

                <div class="form-group">
                    <label for="password">PASSWORD</label>
                    <div class="input-wrapper password-wrapper">
                        <input 
                            type="password" 
                            id="password" 
                            name="password" 
                            class="form-input" 
                            placeholder="Enter your password"
                            required
                            autocomplete="current-password"
                        >
                        <span class="password-toggle" onclick="togglePassword()">👁️</span>
                    </div>
                    <div class="forgot-link">
                        <a href="#" onclick="showForgotMessage(event)">Forgot Password?</a>
                    </div>
                </div>

                <button type="submit" class="btn-login">
                    Login
                </button>
            </form>

            <div class="back-link">
                <a href="../index.html">← Back to Student Portal</a>
            </div>
        </div>
    </div>

    <script>
        const urlParams = new URLSearchParams(window.location.search);
        const error = urlParams.get('error');
        
        if (error) {
            const errorMessage = document.getElementById('errorMessage');
            if (error === 'invalid') {
                errorMessage.textContent = '❌ Invalid credentials';
                errorMessage.style.display = 'block';
            } else if (error === 'empty') {
                errorMessage.textContent = '⚠️ Fill all fields';
                errorMessage.style.display = 'block';
            }
            errorMessage.classList.add('show');
            window.history.replaceState({}, document.title, window.location.pathname);
        }

        function validateLogin() {
            const username = document.getElementById('username').value.trim();
            const password = document.getElementById('password').value.trim();
            const errorMessage = document.getElementById('errorMessage');

            if (!username || !password) {
                errorMessage.textContent = '⚠️ Fill all fields';
                errorMessage.style.display = 'block';
                errorMessage.classList.add('show');
                return false;
            }
            return true;
        }

        function togglePassword() {
            const passwordInput = document.getElementById('password');
            const toggleIcon = document.querySelector('.password-toggle');
            
            if (passwordInput.type === 'password') {
                passwordInput.type = 'text';
                toggleIcon.textContent = '🙈';
            } else {
                passwordInput.type = 'password';
                toggleIcon.textContent = '👁️';
            }
        }

        function showForgotMessage(event) {
            event.preventDefault();
            const errorMessage = document.getElementById('errorMessage');
            errorMessage.classList.remove('success');
            errorMessage.style.background = '#DBEAFE';
            errorMessage.style.color = '#1E40AF';
            errorMessage.style.borderColor = '#93C5FD';
            errorMessage.textContent = 'ℹ️ Contact system admin for password reset';
            errorMessage.style.display = 'block';
            errorMessage.classList.add('show');
        }
    </script>
</body>
</html>
