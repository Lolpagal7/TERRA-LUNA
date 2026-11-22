/** ASTRA-GNC Frontend Type Definitions */

export type Mode = 'earth' | 'moon';

export interface Coordinates {
  x: number;
  y: number;
}

export interface Waypoint3D {
  x: number;
  y: number;
  z: number;
}

export interface SimulateRequest {
  mode: Mode;
  start: [number, number];
  goal: [number, number];
  env_intensity: number;
  noise_level: number;
}

export interface SimulateResponse {
  success: boolean;
  mode: Mode;
  grid_size: number;
  cell_size: number;
  gravity: number;
  dem: number[][];
  slope: number[][];
  tri: number[][];
  hazard_masks: number[][][];
  hazard_intensity: number[][][];
  optimal_path: [number, number, number][];
  optimal_path_3d: Waypoint3D[];
  naive_path: [number, number][];
  naive_path_3d: Waypoint3D[];
  monte_carlo_corridor: MonteCarloCorridor;
  survival_probability: number;
  path_cost: number;
  dtn_packet: DTNPacketInfo;
  soc_masks?: number[][][];
  shadow_masks?: number[][][];
}

export interface MonteCarloCorridor {
  corridor_cells: [number, number, number][];
  confidence: number;
  mean_cost: number;
  std_cost: number;
  tube_radius_per_timestep: number[];
  num_successful_samples: number;
}

export interface DTNPacketInfo {
  packet_bytes: number;
  packet_hex: string;
  compression_ratio: number;
  raw_size_estimate_bytes: number;
  waypoint_count: number;
  hazard_bounds_count: number;
  encoding_time_ms: number;
  mode: string;
  checksum: number;
}

export interface MeshTransmitRequest {
  packet_hex: string;
  target_node: string;
}

export interface MeshHop {
  node: string;
  type: string;
  protocol: string;
  latency_ms: number;
  status: string;
  snr_db: number;
}

export interface MeshTransmitResponse {
  success: boolean;
  hops: MeshHop[];
  delivery_time_ms: number;
  receiver_status: ReceiverState;
}

export interface ReceiverState {
  last_packet: PacketInfo | null;
  decoded_route: [number, number, number][] | null;
  status: string;
  battery_level: number;
  signal_strength: number;
}

export interface PacketInfo {
  timestamp: number;
  packet_hex: string;
  packet_size: number;
  checksum: number;
}

export interface TerrainPreset {
  id: string;
  name: string;
  mode: Mode;
  description: string;
}

export interface TelemetryMetrics {
  max_gradient: number;
  gravity: number;
  battery_soc: number;
  survival_margin: number;
  positioning_lock: string;
  path_survival: 'NOMINAL' | 'COMPROMISED' | 'NAIVE_COMPROMISED';
}

export interface LayerVisibility {
  slope_heatmap: boolean;
  monte_carlo_tube: boolean;
  naive_path: boolean;
  wireframe: boolean;
  contours: boolean;
}

export interface TimeState {
  current_step: number;
  is_playing: boolean;
  playback_speed: number;
}

export const NUM_TIME_STEPS = 5;
export const GRID_SIZE = 128;
export const CELL_SIZE_M = 10.0;