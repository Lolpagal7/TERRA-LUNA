"""
ASTRA-GNC Mission Control - FastAPI Backend
Main API server with all endpoints for 4D Spatio-Temporal Navigation
"""

from fastapi import FastAPI, File, UploadFile, HTTPException, BackgroundTasks, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
from typing import List, Tuple, Optional, Dict, Any
from functools import wraps
from pathlib import Path
from threading import RLock
import numpy as np
import time
import json
import io

from terrain_engine import get_terrain_engine, TerrainEngine
from hazards_4d import get_hazard_propagator, HazardPropagator4D
from planner_4d import get_planner, Planner4D, PathResult
from dtn_telemetry import get_dtn_encoder, DTNTelemetryEncoder

app = FastAPI(
    title="ASTRA-GNC Mission Control API",
    description="4D Spatio-Temporal Digital Twin Navigation & Delay-Tolerant Edge Telemetry",
    version="1.0.0"
)

_simulation_lock = RLock()
_hazard_cache_key = None


def serialized_simulation(endpoint):
    """Protect singleton terrain/hazard state while keeping CPU work off-loop."""
    @wraps(endpoint)
    def wrapped(*args, **kwargs):
        with _simulation_lock:
            return endpoint(*args, **kwargs)
    return wrapped

# CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://astra-gnc.web.app",
        "https://astra-gnc.firebaseapp.com",
    ],
    allow_origin_regex=r"https://astra-gnc(?:--[a-z0-9-]+)?\.web\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Request/Response models
class SimulateRequest(BaseModel):
    mode: str = Field(..., description="Mode: 'earth' or 'moon'")
    start: List[int] = Field(..., description="Start coordinates [x, y]")
    goal: List[int] = Field(..., description="Goal coordinates [x, y]")
    env_intensity: float = Field(50.0, description="Rainfall mm/hr (earth) or solar azimuth range (moon)")
    noise_level: float = Field(0.1, description="Monte Carlo noise level (0-1)")


class SimulateResponse(BaseModel):
    success: bool
    mode: str
    grid_size: int
    cell_size: float
    gravity: float
    dem: List[List[float]]
    slope: List[List[float]]
    tri: List[List[float]]
    hazard_masks: List[List[List[float]]]
    hazard_intensity: List[List[List[float]]]
    optimal_path: List[List[int]]
    optimal_path_3d: List[Dict[str, float]]
    naive_path: List[List[int]]
    naive_path_3d: List[Dict[str, float]]
    monte_carlo_corridor: Dict[str, Any]
    survival_probability: float
    path_cost: float
    dtn_packet: Dict[str, Any]
    soc_masks: Optional[List[List[List[float]]]] = None
    shadow_masks: Optional[List[List[List[float]]]] = None


class MeshTransmitRequest(BaseModel):
    packet_hex: str
    target_node: str = "field_unit"


class MeshTransmitResponse(BaseModel):
    success: bool
    hops: List[Dict[str, Any]]
    delivery_time_ms: float
    receiver_status: Dict[str, Any]


class ReceiverStateResponse(BaseModel):
    last_packet: Optional[Dict[str, Any]]
    decoded_route: Optional[List[List[int]]]
    status: str
    battery_level: float
    signal_strength: float


# Global state for mesh simulation
mesh_state = {
    "receiver": {
        "last_packet": None,
        "decoded_route": None,
        "status": "STANDBY",
        "battery_level": 100.0,
        "signal_strength": 0.0
    },
    "relay_nodes": [
        {"id": "ORBITAL", "type": "satellite", "status": "ACTIVE", "latency_ms": 120},
        {"id": "GROUND_STATION", "type": "ground", "status": "ACTIVE", "latency_ms": 15},
        {"id": "MESH_GATEWAY", "type": "ble_lora", "status": "ACTIVE", "latency_ms": 50},
        {"id": "FIELD_UNIT", "type": "handheld", "status": "OFFLINE", "latency_ms": 0}
    ]
}


@app.get("/")
async def root():
    index_file = Path(__file__).resolve().parents[1] / "frontend" / "dist" / "index.html"
    if index_file.is_file():
        from fastapi.responses import FileResponse
        return FileResponse(index_file)
    return {
        "name": "ASTRA-GNC Mission Control API",
        "version": "1.0.0",
        "description": "4D Spatio-Temporal Digital Twin Navigation & DTN Telemetry",
        "endpoints": [
            "POST /api/simulate",
            "POST /api/upload-dem",
            "POST /api/mesh/transmit",
            "GET /api/mesh/receiver",
            "GET /api/health"
        ]
    }


@app.get("/api/health")
async def health_check():
    return {"status": "NOMINAL", "timestamp": time.time()}


@app.post("/api/simulate", response_model=SimulateResponse)
@serialized_simulation
def simulate(request: SimulateRequest, http_response: Response):
    """
    Main simulation endpoint: runs full 4D planning pipeline
    """
    start_time = time.perf_counter()

    try:
        # Validate mode
        if request.mode not in ["earth", "moon"]:
            raise HTTPException(status_code=400, detail="Mode must be 'earth' or 'moon'")

        # Validate coordinates
        sx, sy = request.start
        gx, gy = request.goal
        grid_size = 128

        if not (0 <= sx < grid_size and 0 <= sy < grid_size and
                0 <= gx < grid_size and 0 <= gy < grid_size):
            raise HTTPException(status_code=400, detail="Coordinates out of bounds (0-127)")

        # Get engine instances
        engine = get_terrain_engine()
        hazards = get_hazard_propagator()
        planner = get_planner()
        dtn = get_dtn_encoder()

        # Generate terrain once per mode, and reuse the hazard field when only
        # waypoints/noise change. This keeps live route edits inexpensive.
        global _hazard_cache_key
        if request.mode == "earth":
            if engine.dem is None or engine.mode != request.mode:
                engine.generate_earth_terrain()
            hazard_key = (request.mode, float(request.env_intensity))
            if hazard_key != _hazard_cache_key or hazards.hazard_masks is None:
                hazards.compute_earth_hazards(rainfall_mm_hr=request.env_intensity)
                _hazard_cache_key = hazard_key
        else:
            if engine.dem is None or engine.mode != request.mode:
                engine.generate_moon_terrain()
            solar_elevation = request.env_intensity if request.env_intensity > 0 else 2.0
            hazard_key = (request.mode, float(solar_elevation))
            if hazard_key != _hazard_cache_key or hazards.hazard_masks is None:
                hazards.compute_moon_hazards(
                    solar_azimuth_start=-90.0,
                    solar_azimuth_end=90.0,
                    solar_elevation=solar_elevation
                )
                _hazard_cache_key = hazard_key

        # Plan 4D path
        path_result = planner.plan_4d_path(
            start=(sx, sy),
            goal=(gx, gy),
            noise_level=request.noise_level,
            # Keep interactive route updates responsive in both modes.
            monte_carlo_samples=5
        )

        # Encode DTN packet
        soc_min = 100.0
        if request.mode == "moon":
            soc_masks = hazards.soc_masks
            if soc_masks is not None:
                soc_min = float(np.min(soc_masks))

        dtn_result = dtn.encode_trajectory(
            path_result,
            mode=request.mode,
            soc_min=soc_min
        )

        # Prepare response
        response = SimulateResponse(
            success=True,
            mode=request.mode,
            grid_size=grid_size,
            cell_size=engine.cell_size,
            gravity=engine.gravity,
            dem=engine.dem.tolist(),
            slope=engine.slope.tolist() if engine.slope is not None else [],
            tri=engine.tri.tolist() if engine.tri is not None else [],
            hazard_masks=hazards.hazard_masks.tolist() if hazards.hazard_masks is not None else [],
            hazard_intensity=hazards.hazard_intensity.tolist() if hazards.hazard_intensity is not None else [],
            optimal_path=[[x, y, t] for x, y, t in path_result.waypoints],
            optimal_path_3d=[{"x": x, "y": y, "z": (z - float(np.min(engine.dem))) * 0.2} for x, y, z in path_result.waypoints_3d],
            naive_path=[[x, y] for x, y in path_result.naive_waypoints],
            naive_path_3d=[{"x": x, "y": y, "z": (z - float(np.min(engine.dem))) * 0.2} for x, y, z in planner._path_to_3d_static(path_result.naive_waypoints)],
            monte_carlo_corridor=path_result.monte_carlo_corridor,
            survival_probability=path_result.survival_probability,
            path_cost=path_result.cost,
            dtn_packet=dtn_result,
            soc_masks=hazards.soc_masks.tolist() if hazards.soc_masks is not None else None,
            shadow_masks=hazards.shadow_masks.tolist() if hazards.shadow_masks is not None else None
        )

        http_response.headers["X-Processing-Time-Ms"] = f"{(time.perf_counter() - start_time) * 1000:.1f}"
        return response

    except HTTPException:
        raise
    except Exception as e:
        import logging
        logging.exception("ASTRA-GNC simulation failed")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.post("/api/upload-dem")
def upload_dem(file: UploadFile = File(...), mode: str = Form("earth")):
    """
    Upload and process a real GeoTIFF DEM
    """
    global _hazard_cache_key
    try:
        engine = get_terrain_engine()

        # Read file content
        content = file.file.read()

        # Save to temporary file for rasterio
        import tempfile
        import os

        with tempfile.NamedTemporaryFile(suffix='.tif', delete=False) as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        try:
            if mode not in ("earth", "moon"):
                raise HTTPException(status_code=400, detail="Mode must be 'earth' or 'moon'")
            with _simulation_lock:
                dem = engine.load_geotiff(tmp_path)
                engine.mode = mode
                engine.gravity = 9.81 if mode == "earth" else 1.62
                _hazard_cache_key = None
        finally:
            os.unlink(tmp_path)

        return {
            "success": True,
            "message": "DEM loaded successfully",
            "shape": dem.shape,
            "min_elevation": float(np.min(dem)),
            "max_elevation": float(np.max(dem)),
            "mean_elevation": float(np.mean(dem))
        }

    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.post("/api/mesh/transmit", response_model=MeshTransmitResponse)
async def mesh_transmit(request: MeshTransmitRequest):
    """
    Simulate DTN packet transmission through offline mesh network
    """
    try:
        dtn = get_dtn_encoder()

        # Decode packet to verify
        packet_bytes = bytes.fromhex(request.packet_hex)
        decoded = dtn.decode_packet(packet_bytes)

        if decoded is None:
            raise HTTPException(status_code=400, detail="Invalid packet format")

        # Simulate mesh relay hops
        hops = [
            {
                "node": "ORBITAL_RELAY",
                "type": "satellite",
                "protocol": "CCSDS-BPv7",
                "latency_ms": 120,
                "status": "FORWARDED",
                "snr_db": 12.5
            },
            {
                "node": "GROUND_STATION_INDIA",
                "type": "ground",
                "protocol": "TCPCL",
                "latency_ms": 15,
                "status": "FORWARDED",
                "snr_db": 25.0
            },
            {
                "node": "MESH_GATEWAY_BLE",
                "type": "ble_lora_gateway",
                "protocol": "LoRaWAN + BLE Mesh",
                "latency_ms": 50,
                "status": "FORWARDED",
                "snr_db": 8.2
            },
            {
                "node": "FIELD_UNIT_RESCUE_TEAM",
                "type": "handheld_receiver",
                "protocol": "BLE 5.0",
                "latency_ms": 5,
                "status": "DELIVERED",
                "snr_db": 15.0
            }
        ]

        # Update receiver state
        global mesh_state
        mesh_state["receiver"]["last_packet"] = {
            "timestamp": time.time(),
            "packet_hex": request.packet_hex,
            "packet_size": len(packet_bytes),
            "checksum": decoded.checksum
        }
        mesh_state["receiver"]["decoded_route"] = [[x, y, t] for x, y, t in decoded.waypoints]
        mesh_state["receiver"]["status"] = "ROUTE_RECEIVED"
        mesh_state["receiver"]["battery_level"] = 87.0
        mesh_state["receiver"]["signal_strength"] = -65  # dBm

        # Update relay statuses
        for node in mesh_state["relay_nodes"]:
            node["status"] = "ACTIVE"

        total_latency = sum(h["latency_ms"] for h in hops)

        return MeshTransmitResponse(
            success=True,
            hops=hops,
            delivery_time_ms=total_latency,
            receiver_status=mesh_state["receiver"]
        )

    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.get("/api/mesh/receiver", response_model=ReceiverStateResponse)
async def get_receiver_state():
    """
    Get current state of the field receiver (simulated disconnected handset)
    """
    global mesh_state
    return ReceiverStateResponse(**mesh_state["receiver"])


@app.get("/api/terrain/presets")
async def get_presets():
    """Get available terrain presets"""
    return {
        "presets": [
            {
                "id": "earth_kedarnath",
                "name": "Uttarakhand / Kedarnath Valley",
                "mode": "earth",
                "description": "Himalayan V-shaped gorge with river, tributaries, road corridor, landslide-prone flanks"
            },
            {
                "id": "moon_shackleton",
                "name": "Lunar South Pole — Shackleton Rim",
                "mode": "moon",
                "description": "Impact craters with raised rims, central peaks, boulder fields, PSRs"
            }
        ]
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
