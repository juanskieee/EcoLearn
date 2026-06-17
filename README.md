# EcoLearn: Interactive Environmental Education Platform

> A web-based waste classification and environmental education platform that uses ORB-KNN computer vision to identify waste in real time, paired with gamified feedback designed for preschool learners.

![Python](https://img.shields.io/badge/Python-3776AB?style=flat&logo=python&logoColor=white)
![TensorFlow](https://img.shields.io/badge/TensorFlow/Keras-FF6F00?style=flat&logo=tensorflow&logoColor=white)
![PHP](https://img.shields.io/badge/PHP-777BB4?style=flat&logo=php&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-4479A1?style=flat&logo=mysql&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat&logo=javascript&logoColor=black)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=flat&logo=css3&logoColor=white)

---

## Overview

EcoLearn bridges environmental science and early childhood education by combining a real-time waste classifier with an interactive, gamified learning experience. The platform uses the camera to capture waste items, classifies them using an ORB-KNN model, and rewards preschool users with points, characters, and animations to reinforce positive environmental habits.

The system also includes a full administrative dashboard for managing users, educational content, and platform data.

---

## Key Features

- **Real-Time Waste Classification** — Uses the device camera and an ORB-KNN model to identify and classify waste items on the spot.
- **Gamified Feedback** — Points, animations, and characters reward correct waste sorting, designed specifically for preschool-age learners.
- **Interactive Learning Modules** — Engaging educational content tailored for environmental awareness and sustainability.
- **User Authentication** — Secure login and session management to personalize the learning experience.
- **Administrative Dashboard** — Backend for administrators to manage users, content, and site settings.
- **Database Backup Utilities** — Built-in tools to ensure content safety and data integrity.

---

## Technical Implementation

| Layer | Technology |
|---|---|
| ML Model | ORB-KNN (converted to Keras/TensorFlow) |
| Backend | PHP (server-side scripting) |
| Database | MySQL |
| Frontend | HTML5, CSS3, JavaScript |
| Camera Access | JavaScript (MediaDevices API) |

### Architecture

- `converted_keras/` — Pre-trained ORB-KNN model converted to Keras format for web integration.
- `backend/` — Server-side processing logic and API endpoints.
- `admin/` — Administrative control panel including authentication (`auth.php`), session checks (`check_session.php`), and database utilities (`backup_db.php`).
- `css/` — Stylesheet assets.
- `js/` — Client-side logic including camera access and gamification interactions.
- `database/` — SQL schemas and database configuration.

---

## Project Structure

```
/
├── converted_keras/       # ORB-KNN model converted to Keras/TensorFlow
├── admin/                 # Admin panel (auth, session, backup utilities)
├── backend/               # Server-side PHP logic and API endpoints
├── css/                   # Stylesheets
├── js/                    # Client-side JavaScript and camera logic
├── database/              # SQL schema and database setup files
├── index.html             # Main entry point
└── .gitignore
```

---

## How It Works

1. **Point the camera** at a waste item using the device camera.
2. **The ORB-KNN model** captures and classifies the waste in real time.
3. **Gamified feedback** is triggered — preschool users receive points, animations, and character reactions based on correct waste sorting.
4. **Progress is tracked** and stored per user session for continued learning.

---

## How to Get Started

1. **Clone the repository** to your local server or development environment.
2. **Database setup** — Import the SQL schema from the `/database/` folder into your MySQL environment.
3. **Configure backend** — Update database connection settings in the backend PHP files.
4. **Model setup** — Ensure the `converted_keras/` model files are accessible to the backend classifier script.
5. **Access** — Open `index.html` in a browser or navigate to `admin/` for the administrative dashboard.

---

## Credits

Developed by **Juan Carlos Garcia** as part of an undergraduate thesis project.
