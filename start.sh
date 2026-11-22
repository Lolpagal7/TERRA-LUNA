#!/bin/bash
# ASTRA-GNC Mission Control - Startup Script (Linux/macOS)

set -e

echo "🚀 Starting ASTRA-GNC Mission Control..."
echo "========================================"

# Colors for output
GREEN='\033[0;32m'
CYAN='\033[0;36m'
AMBER='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if we're in the right directory
if [ ! -d "backend" ] || [ ! -d "frontend" ]; then
    echo -e "${RED}Error: Must run from TERRA-LUNA root directory${NC}"
    exit 1
fi

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check dependencies
echo -e "${CYAN}Checking dependencies...${NC}"

if ! command_exists python3; then
    echo -e "${RED}Error: python3 not found${NC}"
    exit 1
fi

if ! command_exists node; then
    echo -e "${RED}Error: node not found${NC}"
    exit 1
fi

if ! command_exists npm; then
    echo -e "${RED}Error: npm not found${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Dependencies found${NC}"

# Setup Python virtual environment
echo -e "${CYAN}Setting up Python backend...${NC}"
cd backend

if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

source venv/bin/activate

echo "Installing Python packages..."
pip install -q --upgrade pip
pip install -q -r requirements.txt

echo -e "${GREEN}✓ Backend ready${NC}"

# Start backend in background
echo -e "${CYAN}Starting FastAPI server on port 8000...${NC}"
uvicorn main:app --host 0.0.0.0 --port 8000 --reload &
BACKEND_PID=$!

cd ..

# Setup frontend
echo -e "${CYAN}Setting up React frontend...${NC}"
cd frontend

if [ ! -d "node_modules" ]; then
    echo "Installing npm packages..."
    npm install --silent
fi

echo -e "${GREEN}✓ Frontend ready${NC}"

# Start frontend in background
echo -e "${CYAN}Starting Vite dev server on port 5173...${NC}"
npm run dev &
FRONTEND_PID=$!

cd ..

# Wait a moment for servers to start
sleep 3

echo ""
echo -e "${GREEN}========================================"
echo -e "ASTRA-GNC MISSION CONTROL ONLINE"
echo -e "========================================${NC}"
echo ""
echo -e "  ${CYAN}Mission Control UI:${NC}     http://localhost:5173"
echo -e "  ${CYAN}Backend API:${NC}             http://localhost:8000"
echo -e "  ${CYAN}API Docs:${NC}                http://localhost:8000/docs"
echo ""
echo -e "  ${AMBER}Keyboard Shortcuts:${NC}"
echo -e "    SPACE        Play/Pause timeline"
echo -e "    ← / →        Scrub timeline"
echo -e "    M            Toggle Earth/Moon mode"
echo -e "    SHIFT+CLICK  Set waypoint on terrain"
echo ""
echo -e "  ${RED}Press Ctrl+C to shutdown${NC}"
echo ""

# Trap Ctrl+C to kill both processes
trap "echo -e '\n${AMBER}Shutting down...${NC}'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" INT

# Wait for processes
wait $BACKEND_PID $FRONTEND_PID