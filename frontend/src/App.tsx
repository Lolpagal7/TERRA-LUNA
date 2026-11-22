/** ASTRA-GNC Mission Control - Main Application */

import { useEffect, useRef, useState } from 'react';
import { useProgress } from '@react-three/drei';
import { DigitalTwin } from './components/TerrainDigitalTwin';
import { LeftControlDock } from './components/LeftControlDock';
import { RightTelemetryDock } from './components/RightTelemetryDock';
import { useMissionStore } from './store/useMissionStore';
import { api } from './services/api';

function App() {
  const {
    simulationData, mode, sceneStage, startWaypoint, goalWaypoint,
    envIntensity, noiseLevel, isSimulating, setIsSimulating, setError, time, error,
    setMode, enterSurface, returnToOrbit,
  } = useMissionStore();
  const { active: assetsLoading, loaded: assetsLoaded, total: assetsTotal } = useProgress();
  const [startupLoading, setStartupLoading] = useState(true);
  const preparedRequest = useRef('');

  useEffect(() => {
    const assetsReady = !assetsLoading && (assetsTotal === 0 || assetsLoaded >= assetsTotal);
    if (assetsReady) setStartupLoading(false);
  }, [assetsLoading, assetsLoaded, assetsTotal]);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Shift+Click handled by DigitalTwin
      // Space to play/pause
      if (e.code === 'Space' && e.target === document.body) {
        e.preventDefault();
        useMissionStore.getState().togglePlayback();
      }
      // Left/Right arrows for timeline
      if (e.code === 'ArrowLeft') {
        e.preventDefault();
        const { time, setTimeStep } = useMissionStore.getState();
        setTimeStep(Math.max(0, time.current_step - 1));
      }
      if (e.code === 'ArrowRight') {
        e.preventDefault();
        const { time, setTimeStep } = useMissionStore.getState();
        setTimeStep(Math.min(4, time.current_step + 1));
      }
      // M to toggle mode
      if (e.key === 'm' || e.key === 'M') {
        const { mode, setMode } = useMissionStore.getState();
        setMode(mode === 'earth' ? 'moon' : 'earth');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Replan automatically after either waypoint or a mission parameter changes.
  useEffect(() => {
    if (sceneStage !== 'surface' || !startWaypoint || !goalWaypoint) return;
    const key = `${mode}|${startWaypoint.x},${startWaypoint.y}|${goalWaypoint.x},${goalWaypoint.y}|${envIntensity}|${noiseLevel}`;
    if (preparedRequest.current === key && simulationData) return;
    preparedRequest.current = key;

    let active = true;
    const timer = window.setTimeout(async () => {
      setIsSimulating(true);
      setError(null);
      try {
        const result = await api.simulate({
          mode,
          start: [startWaypoint.x, startWaypoint.y],
          goal: [goalWaypoint.x, goalWaypoint.y],
          env_intensity: envIntensity,
          noise_level: noiseLevel,
        });
        if (active) useMissionStore.getState().setSimulationData(result);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Live replanning failed');
      } finally {
        if (active) setIsSimulating(false);
      }
    }, 400);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [sceneStage, mode, startWaypoint, goalWaypoint, envIntensity, noiseLevel, simulationData, setError, setIsSimulating]);

  // Auto-play timeline
  useEffect(() => {
    if (!time.is_playing) return;

    const interval = setInterval(() => {
      const { time, setTimeStep, simulationData } = useMissionStore.getState();
      if (!simulationData) return;

      const nextStep = time.current_step + 1;
      if (nextStep >= 5) {
        useMissionStore.getState().togglePlayback();
      } else {
        setTimeStep(nextStep);
      }
    }, 1000 / time.playback_speed);

    return () => clearInterval(interval);
  }, [time.is_playing, time.playback_speed, simulationData]);

  return (
    <div className={`relative h-screen w-screen overflow-hidden bg-space mode-${mode} ${sceneStage === 'orbit' ? 'mode-space' : ''}`}>
      {sceneStage === 'surface' && mode === 'earth' && (
        <div className="pointer-events-none absolute inset-0 z-0 bg-[#e9e9e5]" aria-hidden="true" />
      )}
      <DigitalTwin data={simulationData} className="absolute inset-0 z-10 h-full w-full" />
      {/* Left Control Dock */}
      {sceneStage === 'surface' && (
        <div className="absolute inset-y-4 left-4 z-20 hidden w-64 xl:block">
          <LeftControlDock />
        </div>
      )}

      {/* Center: 3D Digital Twin */}
      <div className="pointer-events-none absolute inset-0">
        {/* Mode indicator overlay */}
        <div className="absolute top-3 left-1/2 z-10 max-w-[calc(100vw-1.5rem)] -translate-x-1/2">
          <div className="panel panel-glass px-4 py-2 shadow-glow-cyan">
            <div className="flex flex-wrap items-center justify-center gap-2">
              <div className={`w-2 h-2 rounded-full ${mode === 'earth' ? 'bg-green' : 'bg-amber'}`} />
              <span className="font-mono text-sm font-medium">
                {mode === 'earth' ? 'ASTRA-GNC // EARTH DISASTER MODE' : 'ASTRA-GNC // LUNAR ROVER MODE'}
              </span>
              <button
                onClick={() => setMode('earth')}
                aria-pressed={mode === 'earth'}
                className={`pointer-events-auto border-0 bg-transparent px-1 py-1 font-mono text-[10px] tracking-wider transition-colors hover:text-white hover:underline hover:underline-offset-4 ${mode === 'earth' ? 'text-white underline underline-offset-4' : 'text-white/55'}`}
              >EARTH</button>
              <button
                onClick={() => setMode('moon')}
                aria-pressed={mode === 'moon'}
                className={`pointer-events-auto border-0 bg-transparent px-1 py-1 font-mono text-[10px] tracking-wider transition-colors hover:text-white hover:underline hover:underline-offset-4 ${mode === 'moon' ? 'text-white underline underline-offset-4' : 'text-white/55'}`}
              >MOON</button>
              {sceneStage === 'surface' && (
                <button
                  className="pointer-events-auto ml-2 border border-black/15 bg-white px-2 py-1 font-mono text-[10px] tracking-wider text-black"
                  onClick={returnToOrbit}
                >
                  ORBIT VIEW
                </button>
              )}
            </div>
          </div>
        </div>

        {sceneStage === 'orbit' ? (
          <div className="pointer-events-auto absolute bottom-10 left-1/2 w-[min(92vw,34rem)] -translate-x-1/2 text-center">
            <button onClick={enterSurface} className="btn-primary px-5 py-3 text-xs tracking-[0.16em]">
              OPEN {mode === 'earth' ? 'HIMALAYAN FLOOD SIMULATION' : 'LUNAR TERRAIN SIMULATION'}
            </button>
            <div className="mt-2 font-mono text-[10px] tracking-[0.18em] text-white/55">SELECT THE BODY OR ENTER MISSION CONTROL</div>
          </div>
        ) : sceneStage === 'surface' && mode === 'moon' ? (
          <div className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 text-center">
            <div className="panel panel-glass px-4 py-2 font-mono text-[10px] tracking-[0.14em] text-text-secondary">
              {isSimulating
                ? 'LIVE SOLVER // REPLANNING FROM CURRENT WAYPOINTS'
                : simulationData
                  ? 'DYNAMIC 4D PLAN // CLICK TERRAIN TO UPDATE ROUTE'
                  : 'INITIALIZING TERRAIN AND 4D SOLVER'}
            </div>
          </div>
        ) : null}

        {/* Mobile controls */}
        {sceneStage === 'surface' && mode === 'moon' && (
          <div className="pointer-events-auto absolute bottom-4 left-4 right-4 z-20 panel panel-glass p-3 xl:hidden">
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={() => useMissionStore.getState().togglePlayback()}
              className="btn-primary flex-1 py-2 text-xs"
            >
              {useMissionStore.getState().time.is_playing ? '⏸' : '▶'}
            </button>
            <input
              type="range"
              min="0"
              max="4"
              step="1"
              value={useMissionStore.getState().time.current_step}
              onChange={(e) => useMissionStore.getState().setTimeStep(Number(e.target.value))}
              className="timeline-slider flex-1 max-w-xs"
            />
            <span className="font-mono text-xs text-cyan min-w-[4rem] text-center">
              T+{useMissionStore.getState().time.current_step * 15}min
            </span>
          </div>
          </div>
        )}
      </div>

      {/* Right Telemetry Dock */}
      {sceneStage === 'surface' && (
        <div className="absolute inset-y-4 right-4 z-20 hidden w-64 xl:block">
          <RightTelemetryDock />
        </div>
      )}

      {/* Error Toast */}
      {error && (
        <div className="fixed bottom-4 right-4 z-50 animate-slide-up">
          <div className="panel border-l-4 border-crimson p-4 max-w-sm shadow-glow-crimson">
            <div className="flex items-start gap-2">
              <span className="text-crimson font-mono">⚠</span>
              <span className="text-sm text-text-primary">{error}</span>
              <button
                onClick={() => setError(null)}
                className="ml-2 border border-black/15 bg-white px-1 text-black font-mono"
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      )}

      {(startupLoading || (sceneStage === 'surface' && !simulationData && isSimulating)) && (
        <div className="fixed inset-0 z-[100] grid place-items-center bg-[#030405]/90 px-6 backdrop-blur-md">
          <div className="w-full max-w-sm border border-white/20 bg-black/50 p-6 text-white shadow-[0_0_60px_rgba(255,255,255,0.08)]">
            <div className="mb-5 flex items-center justify-between font-mono text-[10px] tracking-[0.24em] text-white/55">
              <span>ASTRA // MISSION SYSTEMS</span>
              <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
            </div>
            <div className="font-mono text-lg tracking-[0.12em]">
              {sceneStage === 'surface' ? `BUILDING ${mode === 'earth' ? 'HIMALAYAN FLOOD' : 'LUNAR'} SIMULATION` : 'INITIALIZING MISSION VIEW'}
            </div>
            <p className="mt-2 min-h-10 font-mono text-xs leading-relaxed text-white/60">
              {assetsLoading
                ? `Loading 3D assets ${Math.round(assetsTotal ? (assetsLoaded / assetsTotal) * 100 : 0)}%`
                : isSimulating
                  ? 'Solving terrain, flood propagation, and route…'
                  : 'Preparing mission view…'}
            </p>
            <div className="mt-5 h-px overflow-hidden bg-white/15">
              <div className="h-full animate-loading-sweep bg-white/80" />
            </div>
            <div className="mt-3 flex justify-between font-mono text-[9px] tracking-[0.16em] text-white/35">
              <span>MODEL / TERRAIN / SOLVER</span><span>PLEASE WAIT</span>
            </div>
          </div>
        </div>
      )}

      {/* Keyboard shortcuts hint */}
      {sceneStage === 'surface' && mode === 'moon' && (
      <div className="fixed bottom-4 left-4 z-10 hidden md:block panel px-3 py-2 rounded opacity-50 hover:opacity-100 transition-opacity">
        <div className="font-mono text-xs text-text-dim grid grid-cols-2 gap-1">
          <span>SPACE</span><span className="text-right">Play/Pause</span>
          <span>←/→</span><span className="text-right">Timeline</span>
          <span>M</span><span className="text-right">Toggle Mode</span>
          <span>CLICK</span><span className="text-right">Next Waypoint</span>
          <span>SHIFT+CLICK</span><span className="text-right">Reset Start</span>
        </div>
      </div>
      )}
    </div>
  );
}

export default App;
