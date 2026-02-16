<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🌱 EcoLearn - Admin Login</title>
    <link rel="stylesheet" href="../css/admin_style.css">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;600;700&family=Poppins:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
        body {
            font-family: 'Fredoka', 'Poppins', sans-serif;
        }

        .login-wrapper {
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            overflow: hidden;
        }

        .login-card {
            background: white;
            border: 3px solid var(--color-border);
            border-radius: 24px;
            padding: 3rem 2.5rem;
            max-width: 480px;
            width: 90%;
            box-shadow: 0 8px 0 var(--color-border), 0 12px 40px rgba(0, 0, 0, 0.1);
            position: relative;
            z-index: 10;
        }

        .login-header {
            text-align: center;
            margin-bottom: 2rem;
        }

        .login-logo {
            font-size: 5rem;
            margin-bottom: 1rem;
            display: inline-block;
            animation: float 3s ease-in-out infinite;
        }

        @keyframes float {
            0%, 100% { transform: translateY(0) rotate(0deg); }
            50% { transform: translateY(-10px) rotate(5deg); }
        }

        .login-header h1 {
            font-family: 'Fredoka', sans-serif;
            font-size: 2.5rem;
            color: var(--color-text);
            margin-bottom: 0.25rem;
            font-weight: 700;
            letter-spacing: -0.5px;
        }

        .login-header p {
            color: var(--color-text-light);
            font-size: 1rem;
            font-weight: 600;
        }

        .login-form {
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
        }

        .form-group {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }

        .form-group label {
            font-weight: 700;
            color: var(--color-text);
            font-size: 1rem;
            font-family: 'Fredoka', sans-serif;
        }

        .input-wrapper {
            position: relative;
        }

        .input-icon {
            position: absolute;
            left: 1.2rem;
            top: 50%;
            transform: translateY(-50%);
            font-size: 1.4rem;
            z-index: 1;
        }

        .form-input {
            width: 100%;
            padding: 0.9rem 1rem;
            border: 3px solid var(--color-border);
            border-radius: 16px;
            font-family: 'Poppins', sans-serif;
            font-size: 1rem;
            font-weight: 600;
            transition: all 0.2s;
            background: #FAFAFA;
            box-shadow: 0 2px 0 var(--color-border);
        }

        .password-wrapper {
            position: relative;
        }

        .password-toggle {
            position: absolute;
            right: 1rem;
            top: 50%;
            transform: translateY(-50%);
            cursor: pointer;
            font-size: 1.3rem;
            user-select: none;
            opacity: 0.6;
            transition: opacity 0.2s;
        }

        .password-toggle:hover {
            opacity: 1;
        }

        .form-input:focus {
            outline: none;
            border-color: var(--color-green);
            background: white;
            box-shadow: 0 2px 0 var(--color-green), 0 0 0 4px rgba(88, 204, 2, 0.1);
            transform: translateY(-1px);
        }

        .form-input::placeholder {
            color: #999;
            font-weight: 500;
        }

        .btn-login {
            background: var(--color-green);
            color: white;
            border: none;
            padding: 0.9rem 2rem;
            border-radius: 16px;
            font-weight: 700;
            font-size: 1rem;
            font-family: 'Fredoka', sans-serif;
            cursor: pointer;
            transition: all 0.1s;
            box-shadow: 0 4px 0 #46a302;
            margin-top: 0.5rem;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            position: relative;
        }

        .btn-login:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 0 #46a302;
        }

        .btn-login:active {
            transform: translateY(4px);
            box-shadow: none;
        }

        .error-message {
            background: #FEE2E2;
            color: #991B1B;
            padding: 0.6rem 0.9rem;
            border-radius: 10px;
            border: 2px solid #FCA5A5;
            font-weight: 600;
            font-size: 0.85rem;
            text-align: center;
            display: none;
            animation: slideIn 0.3s ease;
            font-family: 'Fredoka', sans-serif;
            margin-bottom: 0.5rem;
        }

        .error-message.show {
            display: block;
        }

        .error-message.success {
            background: #DCFCE7;
            color: #065F46;
            border-color: #86EFAC;
        }

        .forgot-link {
            text-align: right;
            margin-top: 0.5rem;
        }

        .forgot-link a {
            color: var(--color-text-light);
            text-decoration: none;
            font-size: 0.85rem;
            font-weight: 600;
            transition: color 0.2s;
        }

        .forgot-link a:hover {
            color: var(--color-green);
        }

        .back-link {
            text-align: center;
            margin-top: 1.5rem;
        }

        .back-link a {
            color: var(--color-green);
            text-decoration: none;
            font-weight: 700;
            font-size: 1rem;
            font-family: 'Fredoka', sans-serif;
            transition: all 0.2s;
            display: inline-block;
        }

        .back-link a:hover {
            color: #46a302;
            transform: translateX(-5px);
        }

        @keyframes slideIn {
            from {
                opacity: 0;
                transform: translateY(-10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
    </style>
</head>
<body>
    <div class="animated-background">
        <div class="floating-leaf leaf-1">🍃</div>
        <div class="floating-leaf leaf-2">🌿</div>
        <div class="floating-leaf leaf-3">♻️</div>
        <div class="floating-leaf leaf-4">🌱</div>
    </div>

    <div class="login-wrapper">
        <div class="login-card">
            <div class="login-header">
                <div class="login-logo">🌱</div>
                <h1>EcoLearn</h1>
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
