---
title: ASTRA-GNC Mission Control
emoji: 🛰️
colorFrom: gray
colorTo: gray
sdk: gradio
app_file: app.py
pinned: false
---

# ASTRA-GNC Mission Control

Full-stack terrain navigation and hazard simulation app. The Gradio Space hosts the prebuilt React interface and the FastAPI backend from the same origin.

The API is available at `/api/health`, `/api/terrain/presets`, and `/api/simulate`.

## Hugging Face Spaces deployment

This Space uses the **Gradio** SDK and runs on the free CPU tier. `app.py` mounts the existing FastAPI endpoints and wraps the prebuilt React interface in Gradio. The React app calls `/api/*` on the same Space origin, so it needs no separate backend URL.

Upload `README.md`, `app.py`, root `requirements.txt`, the full `backend/` folder, and `frontend/dist/` (including `index.html`, `assets/`, `earth.glb`, and `moon.glb`). Upload `frontend/` source and `public/` too if you want to keep the source alongside the deployed build; Space startup uses the files in `frontend/dist/`. Do not upload `.git/`, `frontend/node_modules/`, local `.env` files, virtual environments, or `__pycache__/`.

After the Space builds, open the Space URL and check `/api/health`; it should return `{"status":"NOMINAL", ...}`. Firebase mission saving remains optional and only activates when its Firebase web configuration is included in the frontend build.

## Firebase frontend

The React app uses Firebase Authentication (anonymous sessions) and Cloud Firestore to restore and save the latest mission inputs for that browser. It stores only the mode, waypoints, environment intensity, and uncertainty level; terrain rasters are recomputed by the API.

1. Copy `frontend/.env.example` to `frontend/.env.local` and fill in the Firebase web app config from **Project settings → General → Your apps**.
2. Enable **Anonymous** under **Authentication → Sign-in method** in Firebase Console.
3. Set the matching GitHub Actions repository variables (`VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_APP_ID`, and `VITE_FIREBASE_MESSAGING_SENDER_ID`) for Hosting builds.
4. Deploy the owner-only Firestore rules with `firebase deploy --only firestore:rules`.
5. If the API is deployed separately, set `VITE_API_BASE_URL` to its HTTPS base URL in `frontend/.env.local` and as a GitHub Actions repository variable. The API already allows the project's Firebase Hosting origins.
