/** ASTRA-GNC Mission Control State Store */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  Mode, SimulateResponse, TelemetryMetrics, LayerVisibility,
  TimeState, ReceiverState, DTNPacketInfo, MonteCarloCorridor
} from '@/types';

interface MissionState {
  // Mode & Configuration
  mode: Mode;
  setMode: (mode: Mode) => void;
  sceneStage: 'orbit' | 'surface';
  enterSurface: () => void;
  returnToOrbit: () => void;

  // Simulation Data
  simulationData: SimulateResponse | null;
  setSimulationData: (data: SimulateResponse) => void;
  clearSimulation: () => void;

  // Terrain & Visualization
  demTexture: HTMLCanvasElement | null;
  setDemTexture: (canvas: HTMLCanvasElement | null) => void;

  // Layer Visibility
  layers: LayerVisibility;
  toggleLayer: (layer: keyof LayerVisibility) => void;
  setLayer: (layer: keyof LayerVisibility, value: boolean) => void;

  // Time Control
  time: TimeState;
  setTimeStep: (step: number) => void;
  togglePlayback: () => void;
  setPlaybackSpeed: (speed: number) => void;

  // Waypoints (click-to-set)
  startWaypoint: { x: number; y: number } | null;
  goalWaypoint: { x: number; y: number } | null;
  setStartWaypoint: (wp: { x: number; y: number } | null) => void;
  setGoalWaypoint: (wp: { x: number; y: number } | null) => void;
  clearWaypoints: () => void;
  clickMode: 'start' | 'goal' | null;
  setClickMode: (mode: 'start' | 'goal' | null) => void;
  nextWaypointTarget: 'start' | 'goal';
  setNextWaypointTarget: (target: 'start' | 'goal') => void;

  // Telemetry
  telemetry: TelemetryMetrics;
  updateTelemetry: (metrics: Partial<TelemetryMetrics>) => void;

  // DTN & Mesh
  dtnPacket: DTNPacketInfo | null;
  setDtnPacket: (packet: DTNPacketInfo | null) => void;
  meshReceiver: ReceiverState;
  setMeshReceiver: (receiver: ReceiverState) => void;
  meshTransmitting: boolean;
  setMeshTransmitting: (transmitting: boolean) => void;
  meshHops: Array<{ node: string; status: 'pending' | 'active' | 'complete' }>;
  setMeshHops: (hops: Array<{ node: string; status: 'pending' | 'active' | 'complete' }>) => void;

  // Monte Carlo Corridor
  mcCorridor: MonteCarloCorridor | null;
  setMcCorridor: (corridor: MonteCarloCorridor | null) => void;

  // UI State
  isSimulating: boolean;
  setIsSimulating: (simulating: boolean) => void;
  error: string | null;
  setError: (error: string | null) => void;

  // Settings
  envIntensity: number;
  setEnvIntensity: (value: number) => void;
  noiseLevel: number;
  setNoiseLevel: (value: number) => void;
  showReceiverPanel: boolean;
  setShowReceiverPanel: (show: boolean) => void;
}

const defaultLayers: LayerVisibility = {
  slope_heatmap: true,
  monte_carlo_tube: true,
  naive_path: true,
  wireframe: false,
  contours: true,
};

const defaultTelemetry: TelemetryMetrics = {
  max_gradient: 0,
  gravity: 9.81,
  battery_soc: 100,
  survival_margin: 100,
  positioning_lock: 'SEARCHING',
  path_survival: 'NOMINAL',
};

const defaultTime: TimeState = {
  current_step: 0,
  is_playing: false,
  playback_speed: 1.0,
};

const defaultReceiver: ReceiverState = {
  last_packet: null,
  decoded_route: null,
  status: 'STANDBY',
  battery_level: 100,
  signal_strength: 0,
};

export const useMissionStore = create<MissionState>()(
  persist(
    (set, get) => ({
      // Mode
      mode: 'earth',
      setMode: (mode) => set((state) => mode === state.mode ? {} : {
        mode,
        sceneStage: 'orbit',
        simulationData: null,
        startWaypoint: null,
        goalWaypoint: null,
        clickMode: null,
        nextWaypointTarget: 'start',
        time: defaultTime,
        isSimulating: false,
        envIntensity: mode === 'earth' ? 50 : 2,
        telemetry: defaultTelemetry,
        dtnPacket: null,
        mcCorridor: null,
      }),
      sceneStage: 'orbit',
      enterSurface: () => set((state) => ({
        sceneStage: 'surface',
        startWaypoint: state.startWaypoint ?? { x: 22, y: 28 },
        goalWaypoint: state.goalWaypoint ?? { x: 105, y: 98 },
        nextWaypointTarget: 'start',
        error: null,
      })),
      returnToOrbit: () => set({
        sceneStage: 'orbit',
        simulationData: null,
        startWaypoint: null,
        goalWaypoint: null,
        clickMode: null,
        nextWaypointTarget: 'start',
        time: defaultTime,
        isSimulating: false,
        error: null,
        telemetry: defaultTelemetry,
        dtnPacket: null,
        mcCorridor: null,
      }),

      // Simulation
      simulationData: null,
      setSimulationData: (data) => {
        if (data) {
          const telemetry: TelemetryMetrics = {
            max_gradient: Math.max(...data.slope.flat()),
            gravity: data.gravity,
            battery_soc: data.mode === 'moon'
              ? Math.min(...(data.soc_masks?.[0]?.flat() ?? [100]))
              : 100,
            survival_margin: data.survival_probability * 100,
            positioning_lock: data.mode === 'earth' ? 'NAVIC L5+S CEP 1.8m' : 'VISUAL-INERTIAL ODOMETRY',
            path_survival: data.survival_probability > 0.7 ? 'NOMINAL' : 'COMPROMISED',
          };
          set({
            simulationData: data,
            telemetry,
            mcCorridor: data.monte_carlo_corridor,
            dtnPacket: data.dtn_packet,
            time: { ...get().time, current_step: 0 },
          });
        }
      },
      clearSimulation: () => set({
        simulationData: null,
        mcCorridor: null,
        dtnPacket: null,
        startWaypoint: null,
        goalWaypoint: null,
      }),

      // DEM Texture
      demTexture: null,
      setDemTexture: (canvas) => set({ demTexture: canvas }),

      // Layers
      layers: defaultLayers,
      toggleLayer: (layer) => set((state) => ({
        layers: { ...state.layers, [layer]: !state.layers[layer] }
      })),
      setLayer: (layer, value) => set((state) => ({
        layers: { ...state.layers, [layer]: value }
      })),

      // Time
      time: defaultTime,
      setTimeStep: (step) => set((state) => ({
        time: { ...state.time, current_step: Math.max(0, Math.min(4, step)) }
      })),
      togglePlayback: () => set((state) => ({
        time: { ...state.time, is_playing: !state.time.is_playing }
      })),
      setPlaybackSpeed: (speed) => set((state) => ({
        time: { ...state.time, playback_speed: speed }
      })),

      // Waypoints
      startWaypoint: null,
      goalWaypoint: null,
      clickMode: null,
      nextWaypointTarget: 'start',
      setStartWaypoint: (wp) => set({ startWaypoint: wp }),
      setGoalWaypoint: (wp) => set({ goalWaypoint: wp }),
      clearWaypoints: () => set({ startWaypoint: null, goalWaypoint: null, nextWaypointTarget: 'start' }),
      setClickMode: (mode) => set({ clickMode: mode }),
      setNextWaypointTarget: (target) => set({ nextWaypointTarget: target }),

      // Telemetry
      telemetry: defaultTelemetry,
      updateTelemetry: (metrics) => set((state) => ({
        telemetry: { ...state.telemetry, ...metrics }
      })),

      // DTN & Mesh
      dtnPacket: null,
      setDtnPacket: (packet) => set({ dtnPacket: packet }),
      meshReceiver: defaultReceiver,
      setMeshReceiver: (receiver) => set({ meshReceiver: receiver }),
      meshTransmitting: false,
      setMeshTransmitting: (transmitting) => set({ meshTransmitting: transmitting }),
      meshHops: [],
      setMeshHops: (hops) => set({ meshHops: hops }),

      // Monte Carlo
      mcCorridor: null,
      setMcCorridor: (corridor) => set({ mcCorridor: corridor }),

      // UI State
      isSimulating: false,
      setIsSimulating: (simulating) => set({ isSimulating: simulating }),
      error: null,
      setError: (error) => set({ error }),

      // Settings
      envIntensity: 50,
      setEnvIntensity: (value) => set({ envIntensity: Math.max(0, Math.min(200, value)) }),
      noiseLevel: 0.1,
      setNoiseLevel: (value) => set({ noiseLevel: Math.max(0, Math.min(1, value)) }),
      showReceiverPanel: false,
      setShowReceiverPanel: (show) => set({ showReceiverPanel: show }),
    }),
    {
      name: 'astra-gnc-mission',
      partialize: (state) => ({
        mode: state.mode,
        layers: state.layers,
        envIntensity: state.envIntensity,
        noiseLevel: state.noiseLevel,
      }),
    }
  )
);
