@echo off
REM ASTRA-GNC Mission Control - Startup Script (Windows)

setlocal enabledelayedexpansion

echo 🚀 Starting ASTRA-GNC Mission Control...
echo ========================================

REM Check if we're in the right directory
if not exist "backend" (
    echo Error: Must run from TERRA-LUNA root directory
    pause
    exit /b 1
)
if not exist "frontend" (
    echo Error: Must run from TERRA-LUNA root directory
    pause
    exit /b 1
)

REM Check dependencies
echo Checking dependencies...

where python >nul 2>nul
if %errorlevel% neq 0 (
    echo Error: python not found in PATH
    pause
    exit /b 1
)

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Error: node not found in PATH
    pause
    exit /b 1
)

where npm >nul 2>nul
if %errorlevel% neq 0 (
    echo Error: npm not found in PATH
    pause
    exit /b 1
)

echo ✓ Dependencies found

REM Setup Python virtual environment
echo Setting up Python backend...
cd backend

if not exist "venv" (
    echo Creating virtual environment...
    python -m venv venv
)

call venv\Scripts\activate.bat

echo Installing Python packages...
pip install -q --upgrade pip
pip install -q -r requirements.txt

echo ✓ Backend ready

REM Start backend in background
echo Starting FastAPI server on port 8000...
start "ASTRA-GNC Backend" cmd /k "call venv\Scripts\activate.bat && uvicorn main:app --host 0.0.0.0 --port 8000 --reload"

cd ..

REM Setup frontend
echo Setting up React frontend...
cd frontend

if not exist "node_modules" (
    echo Installing npm packages...
    npm install --silent
)

echo ✓ Frontend ready

REM Start frontend in background
echo Starting Vite dev server on port 5173...
start "ASTRA-GNC Frontend" cmd /k "npm run dev"

cd ..

REM Wait a moment for servers to start
timeout /t 3 /nobreak >nul

echo.
echo ========================================
echo ASTRA-GNC MISSION CONTROL ONLINE
echo ========================================
echo.
echo   Mission Control UI:     http://localhost:5173
echo   Backend API:            http://localhost:8000
echo   API Docs:               http://localhost:8000/docs
echo.
echo   Keyboard Shortcuts:
echo     SPACE        Play/Pause timeline
echo     LEFT/RIGHT   Scrub timeline
echo     M            Toggle Earth/Moon mode
echo     SHIFT+CLICK  Set waypoint on terrain
echo.
echo   Close the terminal windows to shutdown
echo.
pause