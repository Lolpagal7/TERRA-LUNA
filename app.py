"""Hugging Face Gradio entry point with the ASTRA-GNC API mounted alongside it."""

import os
import sys
from pathlib import Path

import gradio as gr
import uvicorn
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "frontend" / "dist"
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from main import app  # noqa: E402

# The React UI is prebuilt and included in the Space repo. It calls `/api/*`
# on this same origin; these mounts make its bundle/model files available.
app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="frontend-assets")
app.mount("/mission", StaticFiles(directory=DIST, html=True), name="mission-ui")

# The backend's standalone root page would otherwise take precedence over the
# Gradio mount. Keep all API routes and let Gradio own the Space landing page.
app.router.routes[:] = [
    route for route in app.router.routes
    if not (getattr(route, "path", None) == "/" and "GET" in getattr(route, "methods", set()))
]

with gr.Blocks() as demo:
    gr.HTML(
        """<style>
          html, body, .gradio-container { margin:0!important; padding:0!important; max-width:none!important; }
          .gradio-container { min-height:100vh!important; }
          footer { display:none!important; }
          #astra-mission { display:block; width:100%; height:100vh; border:0; background:#05080f; }
        </style>
        <iframe id="astra-mission" title="ASTRA-GNC Mission Control" src="/mission/"></iframe>"""
    )

app = gr.mount_gradio_app(app, demo, path="/")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "7860")))
