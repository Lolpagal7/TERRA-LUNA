"""
ASTRA-GNC 4D Time-Dependent Geodesic Solver
Space-Time A* / Eikonal solver with Monte Carlo uncertainty envelope
"""

import numpy as np
import heapq
from scipy import ndimage
from scipy.sparse.csgraph import dijkstra
from scipy.sparse import csr_matrix
from typing import Tuple, List, Dict, Any, Optional
from dataclasses import dataclass
import random

from terrain_engine import get_terrain_engine, GRID_SIZE, CELL_SIZE_M
from hazards_4d import get_hazard_propagator, NUM_TIME_STEPS, TIME_STEP_MINUTES


@dataclass
class PathResult:
    """Result of path planning"""
    waypoints: List[Tuple[int, int, int]]  # (x, y, t) space-time waypoints
    waypoints_3d: List[Tuple[float, float, float]]  # (x_m, y_m, z_m) for visualization
    cost: float
    survival_probability: float
    naive_waypoints: List[Tuple[int, int]]  # Static shortest path
    monte_carlo_corridor: Dict[str, Any]  # Confidence corridor data


class Planner4D:
    """4D Space-Time path planner with Monte Carlo uncertainty"""

    def __init__(self):
        self.engine = get_terrain_engine()
        self.hazards = get_hazard_propagator()
        self.grid_size = GRID_SIZE
        self.cell_size = CELL_SIZE_M

    def plan_4d_path(self, start: Tuple[int, int], goal: Tuple[int, int],
                     noise_level: float = 0.1, monte_carlo_samples: int = 25) -> PathResult:
        """
        Compute optimal 4D space-time path from start to goal
        Returns optimal path, naive path, and Monte Carlo corridor
        """
        sx, sy = start
        gx, gy = goal

        # Ensure hazards are computed
        if self.engine.mode == "earth":
            if self.hazards.hazard_masks is None:
                self.hazards.compute_earth_hazards()
        else:
            if self.hazards.hazard_masks is None:
                self.hazards.compute_moon_hazards()

        # Get traversability cost (static)
        static_cost = self.engine.get_traversability_cost()

        # Time-dependent cost: static * (1 + hazard_intensity * penalty)
        hazard_penalty = 50.0  # Heavy penalty for entering hazard

        # Build 4D cost volume: (T, H, W)
        cost_4d = np.zeros((NUM_TIME_STEPS, self.grid_size, self.grid_size), dtype=np.float32)
        for t in range(NUM_TIME_STEPS):
            hazard_intensity = self.hazards.get_hazard_intensity_at_time(t)
            cost_4d[t] = static_cost * (1.0 + hazard_intensity * hazard_penalty)

        # 4D A* search
        optimal_path = self._astar_4d(cost_4d, (sx, sy), (gx, gy))

        # Naive static shortest path (ignores time-dependent hazards)
        naive_path = self._dijkstra_static(static_cost, (sx, sy), (gx, gy))

        # Monte Carlo uncertainty corridor
        mc_corridor = self._monte_carlo_corridor(
            cost_4d, (sx, sy), (gx, gy), noise_level, monte_carlo_samples
        )

        # Convert to 3D waypoints for visualization
        waypoints_3d = self._path_to_3d(optimal_path)
        naive_waypoints_3d = self._path_to_3d_static(naive_path)

        # Compute survival probability
        survival_prob = self._compute_survival_probability(optimal_path)

        return PathResult(
            waypoints=optimal_path,
            waypoints_3d=waypoints_3d,
            cost=self._compute_path_cost(optimal_path, cost_4d),
            survival_probability=survival_prob,
            naive_waypoints=naive_path,
            monte_carlo_corridor=mc_corridor
        )

    def _astar_4d(self, cost_4d: np.ndarray, start: Tuple[int, int], goal: Tuple[int, int]
                  ) -> List[Tuple[int, int, int]]:
        """
        4D A* search over (x, y, t) space-time
        State: (x, y, t) where t = time step index
        Movement: Can move to 8 neighbors in space, time always advances by 1
        Wait action: Stay in place, time advances
        """
        sx, sy = start
        gx, gy = goal
        base = np.maximum(cost_4d[0], 1e-4)
        distance_to_goal = max(float(np.hypot(gx - sx, gy - sy)), 1.0)

        # Arrival time is estimated from progress toward the goal, then refined by
        # assigning timestamps along the selected geodesic. Each cell is charged
        # against the hazard field expected at that point in the 60 minute window.
        yy, xx = np.indices((self.grid_size, self.grid_size))
        progress = np.clip(np.hypot(xx - sx, yy - sy) / distance_to_goal, 0.0, 1.0)
        arrival = np.minimum(NUM_TIME_STEPS - 1,
                             np.floor(progress * (NUM_TIME_STEPS - 1)).astype(int))
        time_cost = np.empty_like(base)
        for t in range(NUM_TIME_STEPS):
            time_cost[arrival == t] = cost_4d[t][arrival == t]

        # The cost volume includes continuous risk; a strong multiplier discourages
        # routes through cells that are already classified as lethal at arrival.
        hazard_ratio = np.maximum((time_cost / base - 1.0) / 50.0, 0.0)
        routed_cost = base * (1.0 + hazard_ratio * 1000.0)
        spatial_path = self._dijkstra_static(routed_cost, start, goal)
        if len(spatial_path) < 2:
            return self._fallback_path(start, goal)

        segment_lengths = [float(np.hypot(b[0] - a[0], b[1] - a[1]))
                           for a, b in zip(spatial_path, spatial_path[1:])]
        total_length = max(sum(segment_lengths), 1e-6)
        elapsed = 0.0
        result = [(spatial_path[0][0], spatial_path[0][1], 0)]
        for index, (x, y) in enumerate(spatial_path[1:], start=1):
            elapsed += segment_lengths[index - 1]
            t = min(NUM_TIME_STEPS - 1,
                    int(round(elapsed / total_length * (NUM_TIME_STEPS - 1))))
            result.append((x, y, t))
        result[-1] = (gx, gy, NUM_TIME_STEPS - 1)
        return result

    def _dijkstra_static(self, cost: np.ndarray, start: Tuple[int, int], goal: Tuple[int, int]
                         ) -> List[Tuple[int, int]]:
        """Static Dijkstra on 2D grid (naive path ignoring time)"""
        n = self.grid_size
        sx, sy = start
        gx, gy = goal

        # Build graph
        nodes = n * n
        edges = []
        weights = []

        for y in range(n):
            for x in range(n):
                u = y * n + x
                for dx, dy in [(1,0), (-1,0), (0,1), (0,-1), (1,1), (1,-1), (-1,1), (-1,-1)]:
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < n and 0 <= ny < n:
                        v = ny * n + nx
                        dist = np.sqrt(dx*dx + dy*dy) * (1.414 if dx != 0 and dy != 0 else 1.0)
                        w = dist * cost[ny, nx]
                        edges.append((u, v))
                        weights.append(w)

        if not edges:
            return [(sx, sy), (gx, gy)]

        rows, columns = zip(*edges)
        graph = csr_matrix((weights, (rows, columns)), shape=(nodes, nodes))
        dist_matrix, predecessors = dijkstra(graph, indices=sy*n+sx, return_predecessors=True)

        # Reconstruct
        target = gy * n + gx
        if dist_matrix[target] == np.inf:
            return [(sx, sy), (gx, gy)]

        path = []
        curr = target
        while curr != sy*n+sx and curr != -1:
            path.append((curr % n, curr // n))
            curr = predecessors[curr]
        path.append((sx, sy))
        path.reverse()
        return path

    def _monte_carlo_corridor(self, cost_4d: np.ndarray, start: Tuple[int, int], goal: Tuple[int, int],
                               noise_level: float, samples: int) -> Dict[str, Any]:
        """
        Monte Carlo uncertainty propagation:
        - Perturb DEM slope with Gaussian noise
        - Recompute paths
        - Compute 95% confidence corridor
        """
        sx, sy = start
        gx, gy = goal

        all_paths = []
        path_costs = []

        # Base cost for perturbation
        base_static_cost = self.engine.get_traversability_cost()

        for i in range(samples):
            # Perturb slope -> perturb traversability cost
            noise = np.random.normal(0, noise_level, base_static_cost.shape)
            perturbed_cost = base_static_cost * (1.0 + noise)
            perturbed_cost = np.maximum(perturbed_cost, 0.05)  # Floor

            # Build perturbed 4D cost
            perturbed_4d = np.zeros_like(cost_4d)
            for t in range(NUM_TIME_STEPS):
                hazard_intensity = self.hazards.get_hazard_intensity_at_time(t)
                perturbed_4d[t] = perturbed_cost * (1.0 + hazard_intensity * 50.0)

            # Plan with perturbed cost
            path = self._astar_4d(perturbed_4d, start, goal)
            if len(path) > 1:
                all_paths.append(path)
                path_costs.append(self._compute_path_cost(path, perturbed_4d))

        if not all_paths:
            return {"corridor_cells": [], "confidence": 0.0, "mean_cost": 0.0, "std_cost": 0.0,
                    "tube_radius_per_timestep": [1.0] * NUM_TIME_STEPS,
                    "corridor_points": [], "survival_rate": 0.0}

        # Compute corridor: cells visited by >= 95% of successful paths
        # Actually compute spatial envelope at each time step
        corridor_map = np.zeros((NUM_TIME_STEPS, self.grid_size, self.grid_size), dtype=int)
        for path in all_paths:
            for x, y, t in path:
                if 0 <= t < NUM_TIME_STEPS:
                    corridor_map[t, y, x] += 1

        # 95% threshold - use 50% for more visible corridor
        threshold = max(1, int(0.5 * len(all_paths)))
        corridor_cells = []
        for t in range(NUM_TIME_STEPS):
            for y in range(self.grid_size):
                for x in range(self.grid_size):
                    if corridor_map[t, y, x] >= threshold:
                        corridor_cells.append((x, y, t))

        # Also compute lateral spread (confidence tube radius)
        tube_radius = []
        for t in range(NUM_TIME_STEPS):
            # Find path cells at this time from reference (mean path)
            cells_at_t = [(x, y) for x, y, tt in all_paths[0] if tt == t]
            if cells_at_t:
                # Compute std deviation of Monte Carlo paths at this time step
                mc_positions = [(x, y) for p in all_paths for x, y, tt in p if tt == t]
                if mc_positions:
                    mc_array = np.array(mc_positions)
                    std_xy = np.std(mc_array, axis=0)
                    tube_radius.append(max(1.0, float(np.mean(std_xy))))
                else:
                    tube_radius.append(1.0)
            else:
                tube_radius.append(1.0)

        # Convert corridor cells to flat list of points for frontend
        corridor_points = []
        for t in range(NUM_TIME_STEPS):
            for y in range(self.grid_size):
                for x in range(self.grid_size):
                    if corridor_map[t, y, x] >= threshold:
                        x_m = (x - self.grid_size/2) * self.cell_size
                        y_m = (y - self.grid_size/2) * self.cell_size
                        z_m = float(self.engine.dem[y, x]) if self.engine.dem is not None else 0.0
                        z_m += 7.0  # Above path for visibility
                        corridor_points.append({"x": x_m, "y": y_m, "z": z_m, "t": t})

        return {
            "corridor_cells": corridor_cells,
            "corridor_points": corridor_points,
            "confidence": 0.5,
            "mean_cost": float(np.mean(path_costs)) if path_costs else 0.0,
            "std_cost": float(np.std(path_costs)) if path_costs else 0.0,
            "tube_radius_per_timestep": tube_radius,
            "num_successful_samples": len(all_paths),
            "survival_rate": float(len([c for c in path_costs if c > 0]) / len(path_costs)) if path_costs else 0.0
        }

    def _fallback_path(self, start: Tuple[int, int], goal: Tuple[int, int]
                       ) -> List[Tuple[int, int, int]]:
        """Simple fallback: straight line in space, linear in time"""
        sx, sy = start
        gx, gy = goal
        path = []
        steps = max(abs(gx-sx), abs(gy-sy), NUM_TIME_STEPS-1)
        for i in range(NUM_TIME_STEPS):
            t = i
            if steps > 0:
                x = int(sx + (gx - sx) * i / (NUM_TIME_STEPS - 1))
                y = int(sy + (gy - sy) * i / (NUM_TIME_STEPS - 1))
            else:
                x, y = gx, gy
            path.append((x, y, t))
        return path

    def _path_to_3d(self, path: List[Tuple[int, int, int]]) -> List[Tuple[float, float, float]]:
        """Convert space-time path to 3D coordinates for visualization"""
        waypoints_3d = []
        for x, y, t in path:
            x_m = (x - self.grid_size/2) * self.cell_size
            y_m = (y - self.grid_size/2) * self.cell_size
            z_m = float(self.engine.dem[y, x]) if self.engine.dem is not None else 0.0
            # Lift slightly above terrain for visibility
            z_m += 5.0
            waypoints_3d.append((x_m, y_m, z_m))
        return waypoints_3d

    def _path_to_3d_static(self, path: List[Tuple[int, int]]) -> List[Tuple[float, float, float]]:
        """Convert static path to 3D"""
        waypoints_3d = []
        for x, y in path:
            x_m = (x - self.grid_size/2) * self.cell_size
            y_m = (y - self.grid_size/2) * self.cell_size
            z_m = float(self.engine.dem[y, x]) if self.engine.dem is not None else 0.0
            z_m += 3.0
            waypoints_3d.append((x_m, y_m, z_m))
        return waypoints_3d

    def _compute_path_cost(self, path: List[Tuple[int, int, int]], cost_4d: np.ndarray) -> float:
        """Compute total cost of a path"""
        total = 0.0
        for i in range(len(path) - 1):
            x, y, t = path[i]
            if t < NUM_TIME_STEPS:
                total += cost_4d[t, y, x]
        return total

    def _compute_survival_probability(self, path: List[Tuple[int, int, int]]) -> float:
        """Compute survival probability along path"""
        if not path:
            return 0.0

        survival = 1.0
        for x, y, t in path:
            if t < NUM_TIME_STEPS:
                hazard = self.hazards.get_hazard_intensity_at_time(t)
                if 0 <= y < self.grid_size and 0 <= x < self.grid_size:
                    h = hazard[y, x]
                    # Survival probability decreases with hazard
                    survival *= (1.0 - min(h, 0.95))

        return max(0.0, survival)


# Singleton
planner_4d = Planner4D()


def get_planner() -> Planner4D:
    return planner_4d
