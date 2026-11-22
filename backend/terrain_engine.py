"""
ASTRA-GNC Terrain Engine
Multi-domain terrain generation and topographic feature extraction
Supports: Real GeoTIFF DEMs, Procedural Earth (Himalayan Valley), Procedural Moon (Shackleton Rim)
"""

import numpy as np
from scipy import ndimage
from typing import Tuple, Optional, Dict, Any
import struct
import zlib


# Physical constants
G_EARTH = 9.81  # m/s^2
G_MOON = 1.62   # m/s^2

GRID_SIZE = 128
CELL_SIZE_M = 10.0  # 10m per cell = 1.28km x 1.28km domain


class TerrainEngine:
    """Core terrain generation and analysis engine"""

    def __init__(self, grid_size: int = GRID_SIZE, cell_size: float = CELL_SIZE_M):
        self.grid_size = grid_size
        self.cell_size = cell_size
        self.dem = None
        self.slope = None
        self.tri = None
        self.curvature = None
        self.gravity = G_EARTH
        self.mode = "earth"
        self.custom_dem = False

    def generate_earth_terrain(self, seed: int = 42) -> np.ndarray:
        """
        Generate ultra-realistic Himalayan Kedarnath Valley terrain:
        - Steep V-shaped river gorge
        - Winding river channel with tributaries
        - Road corridor along valley wall
        - Landslide-prone steep flanks
        """
        np.random.seed(seed)
        n = self.grid_size

        # Base elevation: valley floor at ~3000m, peaks at ~6000m
        x = np.linspace(-1, 1, n)
        y = np.linspace(-1, 1, n)
        X, Y = np.meshgrid(x, y)

        # Main valley: V-shaped gorge running diagonally
        valley_center = 0.3 * X - 0.2 * Y  # Diagonal valley axis
        valley_width = 0.15 + 0.1 * np.abs(X)  # Widens downstream
        valley_depth = 1.0 - np.exp(-valley_center**2 / (2 * valley_width**2))

        # River channel (deeper incision)
        river_path = 0.15 * np.sin(3 * X) + 0.1 * np.sin(5 * Y)
        river_mask = np.exp(-(Y - river_path)**2 / (2 * 0.02**2))

        # Major ridges on either side
        ridge_left = 0.8 * np.exp(-(Y + 0.4 - 0.2*X)**2 / (2 * 0.15**2))
        ridge_right = 0.7 * np.exp(-(Y - 0.5 + 0.15*X)**2 / (2 * 0.12**2))

        # Tributary gullies
        gully1 = 0.3 * np.exp(-(X + 0.5)**2 / (2 * 0.08**2)) * np.exp(-(Y + 0.2)**2 / (2 * 0.3**2))
        gully2 = 0.25 * np.exp(-(X - 0.6)**2 / (2 * 0.06**2)) * np.exp(-(Y - 0.3)**2 / (2 * 0.25**2))

        # Road corridor (slightly flattened path on left valley wall)
        road_path = -0.35 + 0.1 * X
        road_mask = np.exp(-(Y - road_path)**2 / (2 * 0.015**2))

        # Fractal detail for realism
        detail = self._fractal_noise(n, octaves=4, persistence=0.5, scale=0.05)

        # Combine all features (normalized 0-1)
        terrain = (
            0.6 * valley_depth +           # Main valley
            0.25 * river_mask +            # River incision
            0.4 * ridge_left +             # Left ridge
            0.35 * ridge_right +           # Right ridge
            0.2 * gully1 +                 # Tributary 1
            0.15 * gully2 +                # Tributary 2
            -0.1 * road_mask +             # Road cut (slight depression)
            0.1 * detail                   # Fractal detail
        )

        # Normalize and scale to meters (3000m - 6000m)
        terrain = (terrain - terrain.min()) / (terrain.max() - terrain.min())
        dem = 3000 + terrain * 3000

        # Ensure river is lowest
        dem = dem - 50 * river_mask

        self.dem = dem.astype(np.float32)
        self.mode = "earth"
        self.gravity = G_EARTH
        self.custom_dem = False
        self._compute_topographic_features()

        return self.dem

    def generate_moon_terrain(self, seed: int = 123) -> np.ndarray:
        """
        Generate ultra-realistic Lunar South Pole (Shackleton Rim) terrain:
        - Impact craters with raised rims and central peaks
        - Boulder fields
        - Permanently Shadowed Regions (PSRs) in deep crater floors
        - High-frequency regolith texture
        """
        np.random.seed(seed)
        n = self.grid_size

        x = np.linspace(-1, 1, n)
        y = np.linspace(-1, 1, n)
        X, Y = np.meshgrid(x, y)

        # Base elevation: -2000m to +2000m relative to datum
        terrain = np.zeros((n, n))

        # Major craters (Shackleton-like)
        craters = [
            # (cx, cy, radius, depth, rim_height, central_peak)
            (0.0, 0.0, 0.35, -1.0, 0.15, 0.3),    # Shackleton (center, PSR)
            (-0.5, -0.4, 0.22, -0.7, 0.1, 0.15),  # Secondary
            (0.45, 0.35, 0.18, -0.6, 0.08, 0.1),  # Tertiary
            (-0.3, 0.6, 0.15, -0.5, 0.06, 0.08),  # Small
            (0.6, -0.2, 0.12, -0.4, 0.05, 0.05),  # Small
        ]

        for cx, cy, r, depth, rim_h, peak_h in craters:
            dist = np.sqrt((X - cx)**2 + (Y - cy)**2)
            # Crater profile: raised rim, deep floor, central peak
            crater_profile = np.zeros_like(dist)

            # Rim (raised)
            rim_mask = (dist < r) & (dist > r * 0.7)
            crater_profile[rim_mask] = rim_h * np.sin(np.pi * (dist[rim_mask] - r*0.7) / (r*0.3))

            # Floor (deep)
            floor_mask = dist <= r * 0.7
            crater_profile[floor_mask] = depth * (1 - (dist[floor_mask] / (r*0.7))**2)

            # Central peak
            peak_mask = dist < r * 0.15
            crater_profile[peak_mask] += peak_h * (1 - (dist[peak_mask] / (r*0.15))**2)

            terrain += crater_profile

        # Boulder fields (high frequency roughness)
        boulder_field = self._fractal_noise(n, octaves=6, persistence=0.6, scale=0.02)
        terrain += 0.08 * boulder_field

        # Large-scale basin topography
        basin = -0.3 * np.exp(-(X**2 + Y**2) / (2 * 0.8**2))
        terrain += basin

        # Normalize and scale to lunar elevations (-3000m to +1000m relative)
        terrain = (terrain - terrain.min()) / (terrain.max() - terrain.min())
        dem = -3000 + terrain * 4000

        # Keep the Shackleton PSR as a crater basin. The former 500x
        # exaggeration turned tiny DEM differences into a towering spike,
        # which distorted both the lunar mesh and route costs.
        shackleton_dist = np.sqrt(X**2 + Y**2)
        psr_mask = shackleton_dist < 0.25
        psr_floor = dem[psr_mask].min()
        dem[psr_mask] = -3000 + (dem[psr_mask] - psr_floor) * 0.5

        self.dem = dem.astype(np.float32)
        self.mode = "moon"
        self.gravity = G_MOON
        self.custom_dem = False
        self._compute_topographic_features()

        return self.dem

    def _fractal_noise(self, n: int, octaves: int = 4, persistence: float = 0.5, scale: float = 0.1) -> np.ndarray:
        """Generate fractal Brownian motion noise for terrain detail"""
        noise = np.zeros((n, n))
        amplitude = 1.0
        frequency = scale

        for _ in range(octaves):
            # Generate smooth noise at this frequency
            sample_freq = max(2, int(n * frequency))
            small_noise = np.random.randn(sample_freq, sample_freq)
            # Upsample with cubic interpolation
            from scipy.ndimage import zoom
            zoom_factor = n / sample_freq
            smooth_noise = zoom(small_noise, zoom_factor, order=3)

            # Crop/pad to exact size
            if smooth_noise.shape[0] > n:
                smooth_noise = smooth_noise[:n, :n]
            elif smooth_noise.shape[0] < n:
                pad = n - smooth_noise.shape[0]
                smooth_noise = np.pad(smooth_noise, ((0, pad), (0, pad)), mode='wrap')

            noise += amplitude * smooth_noise
            amplitude *= persistence
            frequency *= 2

        return noise

    def load_geotiff(self, filepath: str) -> np.ndarray:
        """Load real single-band elevation GeoTIFF using rasterio"""
        import rasterio
        from rasterio.warp import reproject, Resampling
        from rasterio.enums import Resampling as ResamplingEnum

        with rasterio.open(filepath) as src:
            # Read first band
            dem = src.read(1).astype(np.float32)

            # Handle nodata
            if src.nodata is not None:
                dem[dem == src.nodata] = np.nan

            # Resample to target grid size if needed
            if dem.shape != (self.grid_size, self.grid_size):
                # Create target transform
                target_transform = src.transform * src.transform.scale(
                    src.width / self.grid_size,
                    src.height / self.grid_size
                )

                target_dem = np.empty((self.grid_size, self.grid_size), dtype=np.float32)
                reproject(
                    source=dem,
                    destination=target_dem,
                    src_transform=src.transform,
                    src_crs=src.crs,
                    dst_transform=target_transform,
                    dst_crs=src.crs,
                    resampling=Resampling.bilinear
                )
                dem = target_dem

            # Fill NaN with interpolation
            if np.any(np.isnan(dem)):
                from scipy.interpolate import griddata
                valid = ~np.isnan(dem)
                if np.any(valid):
                    points = np.argwhere(valid)
                    values = dem[valid]
                    xi = np.indices(dem.shape).reshape(2, -1).T
                    dem = griddata(points, values, xi, method='linear', fill_value=np.nanmean(values))
                    dem = dem.reshape(self.grid_size, self.grid_size)

            self.dem = dem.astype(np.float32)
            self._compute_topographic_features()
            self.custom_dem = True
            return self.dem

    def _compute_topographic_features(self):
        """Compute slope, TRI, and curvature from DEM gradients"""
        if self.dem is None:
            return

        # Gradients (dz/dx, dz/dy) in m/m
        dzdx, dzdy = np.gradient(self.dem, self.cell_size)

        # Slope in degrees
        slope_rad = np.arctan(np.sqrt(dzdx**2 + dzdy**2))
        self.slope = np.degrees(slope_rad).astype(np.float32)

        # Terrain Ruggedness Index (TRI) - mean absolute difference from center
        kernel = np.ones((3, 3))
        kernel[1, 1] = 0
        dem_padded = np.pad(self.dem, 1, mode='edge')
        tri_sum = np.zeros_like(self.dem)

        for i in range(3):
            for j in range(3):
                if i == 1 and j == 1:
                    continue
                tri_sum += np.abs(dem_padded[i:i+self.grid_size, j:j+self.grid_size] - self.dem)

        self.tri = (tri_sum / 8.0).astype(np.float32)

        # Curvature (profile + plan)
        d2zdx2, d2zdxdy = np.gradient(dzdx, self.cell_size)
        d2zdydx, d2zdy2 = np.gradient(dzdy, self.cell_size)

        # Profile curvature (along slope direction)
        slope_mag = np.sqrt(dzdx**2 + dzdy**2) + 1e-10
        profile_curv = (dzdx**2 * d2zdx2 + 2*dzdx*dzdy*d2zdxdy + dzdy**2 * d2zdy2) / (slope_mag**2)

        # Plan curvature (perpendicular to slope)
        plan_curv = (dzdy**2 * d2zdx2 - 2*dzdx*dzdy*d2zdxdy + dzdx**2 * d2zdy2) / (slope_mag**2)

        self.curvature = (profile_curv + plan_curv).astype(np.float32)

    def get_traversability_cost(self, slope_threshold_earth: float = 35.0,
                                 slope_threshold_moon: float = 25.0) -> np.ndarray:
        """
        Compute gravity-scaled traversability cost map
        Higher cost = harder to traverse
        """
        if self.slope is None:
            self._compute_topographic_features()

        # Base cost from slope
        if self.mode == "earth":
            threshold = slope_threshold_earth
            g_scale = self.gravity / G_EARTH
        else:
            threshold = slope_threshold_moon
            g_scale = self.gravity / G_MOON

        # Normalized slope cost (0 to 1, then exponential)
        slope_norm = np.clip(self.slope / threshold, 0, 2.0)
        slope_cost = np.exp(slope_norm * 2.0) - 1.0  # Exponential penalty

        # TRI cost (roughness penalty)
        tri_norm = self.tri / (np.max(self.tri) + 1e-6)
        tri_cost = 1.0 + 2.0 * tri_norm

        # Curvature cost (concave/convex penalties)
        curv_norm = np.abs(self.curvature) / (np.max(np.abs(self.curvature)) + 1e-6)
        curv_cost = 1.0 + 1.5 * curv_norm

        # Combine with gravity scaling
        total_cost = (slope_cost * tri_cost * curv_cost) * g_scale

        # Add small base cost for movement
        total_cost += 0.1

        return total_cost.astype(np.float32)

    def get_state(self) -> Dict[str, Any]:
        """Return current terrain state for API"""
        return {
            "dem": self.dem.tolist() if self.dem is not None else None,
            "slope": self.slope.tolist() if self.slope is not None else None,
            "tri": self.tri.tolist() if self.tri is not None else None,
            "curvature": self.curvature.tolist() if self.curvature is not None else None,
            "gravity": self.gravity,
            "mode": self.mode,
            "grid_size": self.grid_size,
            "cell_size": self.cell_size
        }


# Singleton instance
terrain_engine = TerrainEngine()


def get_terrain_engine() -> TerrainEngine:
    return terrain_engine
