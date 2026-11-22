"""
ASTRA-GNC 4D Spatio-Temporal Hazard Propagation
Time-dependent hazard evolution for Earth (flood/landslide) and Moon (shadow/thermal) modes
"""

import numpy as np
from scipy import ndimage
from typing import Tuple, List, Dict, Any
from terrain_engine import get_terrain_engine, G_EARTH, G_MOON


GRID_SIZE = 128
NUM_TIME_STEPS = 5  # T0 to T4 (0 to +60 minutes)
TIME_STEP_MINUTES = 15  # Each step = 15 minutes


class HazardPropagator4D:
    """4D hazard evolution engine"""

    def __init__(self):
        self.engine = get_terrain_engine()
        self.hazard_masks = None  # Shape: (T, H, W) - 0=safe, 1=hazard
        self.hazard_intensity = None  # Continuous hazard intensity
        self.soc_masks = None  # State of Charge for Moon mode
        self.shadow_masks = None  # Shadow masks for Moon mode

    def compute_earth_hazards(self, rainfall_mm_hr: float = 50.0,
                               landslide_susceptibility: float = 0.3) -> Tuple[np.ndarray, np.ndarray]:
        """
        Earth Mode: Reduced-order shallow-water inundation surrogate + landslide shear mask

        Flood propagation:
        - Water flows downhill following DEM gradient
        - River channel floods first, then spreads to floodplain
        - Bridges/roads submerge at specific water depths
        - 5 time steps: 0, 15, 30, 45, 60 minutes

        Landslide:
        - Slope-dependent shear failure
        - Triggered by rainfall saturation
        - Dynamic mask evolves with time
        """
        dem = self.engine.dem
        slope = self.engine.slope
        n = GRID_SIZE

        if dem is None:
            self.engine.generate_earth_terrain()
            dem = self.engine.dem
            slope = self.engine.slope

        # Identify river channel (lowest elevation path)
        river_mask = self._identify_river_channel(dem)

        # Flood simulation using simplified diffusion + advection
        # Water height above ground at each cell
        water_depth = np.zeros((NUM_TIME_STEPS, n, n), dtype=np.float32)

        # Initial condition: river at bankfull
        base_flow = rainfall_mm_hr / 1000.0 * 0.1  # Convert to m/s equivalent
        water_depth[0] = np.where(river_mask > 0.5, 0.5, 0.0)  # 0.5m initial in river

        # Flood propagation parameters
        diffusion_coeff = 0.5  # m^2/s lateral spread
        gravity_drive = 9.81 * 0.01  # Slope-driven flow component

        for t in range(1, NUM_TIME_STEPS):
            prev = water_depth[t-1].copy()
            curr = prev.copy()

            # Advection: water flows downhill
            dzdx, dzdy = np.gradient(dem, self.engine.cell_size)
            slope_mag = np.sqrt(dzdx**2 + dzdy**2) + 1e-6

            # Flow velocity proportional to slope and water depth
            vx = -gravity_drive * dzdx / slope_mag * np.sqrt(prev + 1e-3)
            vy = -gravity_drive * dzdy / slope_mag * np.sqrt(prev + 1e-3)

            # Simple upwind advection
            advected = self._advect_2d(prev, vx, vy, dt=TIME_STEP_MINUTES*60)

            # Diffusion (lateral spread)
            # Explicit 2-D diffusion is stable only when D*dt/dx² <= 1/4.
            # Cap the dimensionless step accordingly to avoid artificial blow-up.
            diffusion_step = min(
                diffusion_coeff * (TIME_STEP_MINUTES * 60) / (self.engine.cell_size ** 2),
                0.2
            )
            diffused = advected + diffusion_step * ndimage.laplace(advected, mode='reflect')

            # Rainfall source term
            rainfall_add = (rainfall_mm_hr / 1000.0) * (TIME_STEP_MINUTES / 60.0) * 0.3
            diffused += rainfall_add

            # Concentrated catchment runoff replenishes the channel between
            # snapshots; rainfall over the full basin is not applied as a flat
            # depth to every cell.
            channel_stage_gain = 0.08 + max(rainfall_mm_hr, 0.0) / 200.0
            diffused += river_mask * channel_stage_gain

            # Water cannot go below ground
            water_surface = dem + diffused
            # Find local minima - water pools
            water_depth[t] = np.maximum(0, diffused)

        # Combine explicit water depth with a terrain-constrained advancing
        # floodplain front measured from the river network. The front expands
        # faster under heavier rainfall and cannot cross high valley walls.
        river_distance, nearest_river = ndimage.distance_transform_edt(
            river_mask < 0.5, return_indices=True
        )
        nearest_river_elevation = dem[tuple(nearest_river)]
        relative_bank_height = np.maximum(dem - nearest_river_elevation, 0.0)
        flood_hazard = np.zeros_like(water_depth, dtype=np.float32)
        for t in range(NUM_TIME_STEPS):
            spread_radius = 1.0 + t * (0.5 + max(rainfall_mm_hr, 0.0) / 50.0)
            bank_stage = 15.0 + t * (5.0 + max(rainfall_mm_hr, 0.0) * 0.5)
            flood_hazard[t] = np.logical_or(
                water_depth[t] > 0.3,
                (river_distance <= spread_radius) & (relative_bank_height <= bank_stage)
            )
        flood_hazard = flood_hazard.astype(np.float32)

        # Bridge submergence: specific locations that become impassable
        # Bridges typically at river crossings on roads
        bridge_mask = self._identify_bridges(dem, river_mask)
        bridge_submerged = flood_hazard * bridge_mask

        # Landslide hazard: slope + saturation
        # Factor of safety decreases with rainfall
        saturation = np.minimum(1.0, np.cumsum(flood_hazard * 0.2, axis=0))
        slope_factor = slope / 45.0  # Normalize to critical angle ~45 deg
        landslide_hazard = (slope_factor * saturation * landslide_susceptibility > 0.4).astype(np.float32)

        # Combine hazards
        combined_hazard = np.maximum(flood_hazard, landslide_hazard)
        combined_hazard = np.maximum(combined_hazard, bridge_submerged)

        self.hazard_masks = combined_hazard
        front_intensity = flood_hazard * 0.45
        self.hazard_intensity = np.maximum(np.maximum(water_depth / 2.0, landslide_hazard), front_intensity)
        self.soc_masks = None
        self.shadow_masks = None

        return combined_hazard, self.hazard_intensity

    def _identify_river_channel(self, dem: np.ndarray) -> np.ndarray:
        """Identify main river channel as lowest elevation path"""
        n = dem.shape[0]
        # Vectorized D8 flow accumulation. The prior nested Python loops ran
        # once per cell for each new rainfall setting.
        flow_acc = np.ones_like(dem)
        yy, xx = np.indices((n, n))
        best_drop = np.zeros_like(dem)
        downstream = np.arange(n * n, dtype=np.int32).reshape(n, n)
        for di, dj in ((-1, -1), (-1, 0), (-1, 1), (0, -1),
                       (0, 1), (1, -1), (1, 0), (1, 1)):
            neighbor = np.roll(np.roll(dem, -di, axis=0), -dj, axis=1)
            valid = (yy + di >= 0) & (yy + di < n) & (xx + dj >= 0) & (xx + dj < n)
            drop = np.where(valid, dem - neighbor, 0.0)
            choose = drop > best_drop
            best_drop[choose] = drop[choose]
            downstream[choose] = ((yy + di) * n + (xx + dj))[choose]

        flowing = best_drop > 0
        for _ in range(3):
            additions = np.bincount(
                downstream[flowing].ravel(),
                weights=flow_acc[flowing].ravel() * 0.1,
                minlength=n * n,
            ).reshape(n, n)
            flow_acc += additions

        # River = high flow accumulation + low elevation
        contributing = flow_acc[flow_acc > 1]
        river_thresh = np.percentile(contributing, 95) if contributing.size else np.inf
        river_mask = (flow_acc > river_thresh) & (dem < np.percentile(dem, 30))

        return river_mask.astype(np.float32)

    def _identify_bridges(self, dem: np.ndarray, river_mask: np.ndarray) -> np.ndarray:
        """Identify likely bridge locations (road crossings over river)"""
        n = dem.shape[0]
        # Simple heuristic: cells where river crosses a "ridge" in transverse direction
        dzdx, dzdy = np.gradient(dem, self.engine.cell_size)
        flow_angle = np.arctan2(-dzdy, -dzdx)
        perp_angle = flow_angle + np.pi / 2
        di = np.rint(np.sin(perp_angle)).astype(np.int32)
        dj = np.rint(np.cos(perp_angle)).astype(np.int32)
        yy, xx = np.indices((n, n))
        plus_y, minus_y = yy + di, yy - di
        plus_x, minus_x = xx + dj, xx - dj
        valid = ((plus_y >= 0) & (plus_y < n) & (minus_y >= 0) & (minus_y < n) &
                 (plus_x >= 0) & (plus_x < n) & (minus_x >= 0) & (minus_x < n))
        plus = dem[np.clip(plus_y, 0, n - 1), np.clip(plus_x, 0, n - 1)]
        minus = dem[np.clip(minus_y, 0, n - 1), np.clip(minus_x, 0, n - 1)]
        return (river_mask > 0.5) & valid & (plus > dem + 5) & (minus > dem + 5)

    def _advect_2d(self, field: np.ndarray, vx: np.ndarray, vy: np.ndarray, dt: float) -> np.ndarray:
        """Simple semi-Lagrangian advection"""
        from scipy.ndimage import map_coordinates

        yy, xx = np.indices(field.shape, dtype=np.float32)
        x_src = xx - vx * dt / self.engine.cell_size
        y_src = yy - vy * dt / self.engine.cell_size
        # Match the former bilinear interpolation and preserve the field at
        # cells whose backtrace leaves the grid.
        inside = ((x_src >= 0) & (x_src < field.shape[1] - 1) &
                  (y_src >= 0) & (y_src < field.shape[0] - 1))
        result = map_coordinates(field, [y_src, x_src], order=1, mode="nearest", prefilter=False)
        return np.where(inside, result, field)

    def compute_moon_hazards(self, solar_azimuth_start: float = -90.0,
                              solar_azimuth_end: float = 90.0,
                              solar_elevation: float = 2.0) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
        """
        Moon Mode: Dynamic solar-azimuth ray-tracing for shadow evolution + SoC modeling

        - Solar azimuth sweeps from start to end across T0-T4
        - Very low solar elevation at South Pole (~2 degrees)
        - Ray-tracing from each cell to sun direction
        - Shadow mask: 1 = in shadow, 0 = illuminated
        - SoC: Drains in shadow, charges in sun
        """
        dem = self.engine.dem
        n = GRID_SIZE

        if dem is None:
            self.engine.generate_moon_terrain()
            dem = self.engine.dem

        # Sun direction vectors for each time step
        azimuths = np.linspace(np.radians(solar_azimuth_start),
                               np.radians(solar_azimuth_end), NUM_TIME_STEPS)
        elevation_rad = np.radians(solar_elevation)

        shadow_masks = np.zeros((NUM_TIME_STEPS, n, n), dtype=np.float32)
        soc_masks = np.zeros((NUM_TIME_STEPS, n, n), dtype=np.float32)

        # Initial SoC: 100% at landing site (assumed illuminated at T0)
        soc = np.full((n, n), 100.0, dtype=np.float32)

        # Battery params
        charge_rate = 5.0  # % per 15 min in sun
        drain_rate = 8.0   # % per 15 min in shadow (heater + compute)
        soc_min = 0.0
        soc_max = 100.0

        for t in range(NUM_TIME_STEPS):
            azimuth = azimuths[t]

            # Sun direction vector (pointing FROM sun TO surface)
            # Azimuth: 0 = North, 90 = East (standard math convention)
            # But lunar convention: azimuth from North, elevation from horizon
            sun_x = np.cos(elevation_rad) * np.sin(azimuth)   # East component
            sun_y = np.cos(elevation_rad) * np.cos(azimuth)   # North component
            sun_z = np.sin(elevation_rad)                      # Up component

            # Ray-trace shadows
            shadow = self._ray_trace_shadows(dem, sun_x, sun_y, sun_z)
            shadow_masks[t] = shadow

            # Update SoC
            if t == 0:
                # At T0, assume starting in sun at landing zone
                pass
            else:
                # SoC change based on previous shadow state
                soc = np.where(shadow_masks[t-1] > 0.5,
                              np.maximum(soc_min, soc - drain_rate),
                              np.minimum(soc_max, soc + charge_rate))

            soc_masks[t] = soc

        # Hazard = shadow (thermal/cold trap) + low SoC
        # Shadow hazard: permanently shadowed regions are extreme cold traps
        hazard = shadow_masks.copy()
        # Add SoC critical hazard
        hazard = np.maximum(hazard, (soc_masks < 20.0).astype(np.float32))

        self.shadow_masks = shadow_masks
        self.soc_masks = soc_masks
        self.hazard_masks = hazard
        self.hazard_intensity = np.maximum(shadow_masks, (100 - soc_masks) / 100.0)

        return hazard, shadow_masks, soc_masks

    def _ray_trace_shadows(self, dem: np.ndarray, sun_x: float, sun_y: float, sun_z: float) -> np.ndarray:
        """
        Ray-trace shadows on DEM using horizon method
        For each cell, march toward sun until hitting terrain or escaping
        """
        n = dem.shape[0]
        shadow = np.zeros((n, n), dtype=np.float32)

        # Trace all cell rays together. The previous per-cell Python loops took
        # millions of interpreter iterations for each solar snapshot.
        max_steps = int(n * 1.5)
        step_x = sun_x / max_steps * n
        step_y = sun_y / max_steps * n
        source_x, source_y = np.meshgrid(np.arange(n, dtype=np.float32), np.arange(n, dtype=np.float32))
        x = source_x.copy()
        y = source_y.copy()
        active = np.ones((n, n), dtype=bool)

        for step in range(1, max_steps):
            x += step_x
            y += step_y
            active &= (x >= 0) & (x < n - 1) & (y >= 0) & (y < n - 1)
            if not active.any():
                break

            xi = np.clip(x.astype(np.int32), 0, n - 2)
            yi = np.clip(y.astype(np.int32), 0, n - 2)
            fx = x - xi
            fy = y - yi
            z_terrain = (
                dem[yi, xi] * (1 - fx) * (1 - fy)
                + dem[yi, xi + 1] * fx * (1 - fy)
                + dem[yi + 1, xi] * (1 - fx) * fy
                + dem[yi + 1, xi + 1] * fx * fy
            )
            z_ray = dem + step * (step * sun_z * self.engine.cell_size / max_steps)
            hit = active & (z_ray <= z_terrain + 0.1)
            shadow[hit] = 1.0
            active &= ~hit

        return shadow

    def get_hazard_at_time(self, t: int) -> np.ndarray:
        """Get hazard mask at specific time step"""
        if self.hazard_masks is not None and 0 <= t < NUM_TIME_STEPS:
            return self.hazard_masks[t]
        return np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.float32)

    def get_hazard_intensity_at_time(self, t: int) -> np.ndarray:
        """Get continuous hazard intensity at time step"""
        if self.hazard_intensity is not None and 0 <= t < NUM_TIME_STEPS:
            return self.hazard_intensity[t]
        return np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.float32)

    def get_soc_at_time(self, t: int) -> np.ndarray:
        """Get State of Charge at time step (Moon mode)"""
        if self.soc_masks is not None and 0 <= t < NUM_TIME_STEPS:
            return self.soc_masks[t]
        return np.full((GRID_SIZE, GRID_SIZE), 100.0, dtype=np.float32)

    def get_shadow_at_time(self, t: int) -> np.ndarray:
        """Get shadow mask at time step (Moon mode)"""
        if self.shadow_masks is not None and 0 <= t < NUM_TIME_STEPS:
            return self.shadow_masks[t]
        return np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.float32)


# Singleton
hazard_propagator = HazardPropagator4D()


def get_hazard_propagator() -> HazardPropagator4D:
    return hazard_propagator
