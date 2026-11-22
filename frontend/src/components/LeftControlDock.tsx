/** ASTRA-GNC Left Control Dock - GNC Mission Parameters */

import React from 'react';
import { useMissionStore } from '@/store/useMissionStore';
import { api } from '@/services/api';
import type { Mode } from '@/types';

export const LeftControlDock: React.FC = () => {
  const {
    mode, setMode, layers, toggleLayer,
    time, setTimeStep, togglePlayback, setPlaybackSpeed,
    startWaypoint, goalWaypoint,
    clickMode, setClickMode,
    envIntensity, setEnvIntensity, noiseLevel, setNoiseLevel,
    isSimulating, setIsSimulating, setError,
    simulationData
  } = useMissionStore();

  const handleDemUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsSimulating(true);
    try {
      await api.uploadDem(file, mode);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'DEM upload failed');
    } finally {
      setIsSimulating(false);
    }
  };

  return (
    <div className="panel h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-panel-border flex items-center justify-between gap-2">
        <h2 className="section-title mb-0 text-[10px]">GNC MISSION PARAMETERS</h2>
        <span className={`status-indicator shrink-0 text-[9px] leading-tight ${mode === 'earth' ? 'status-nominal' : 'status-warning'}`}>
          {mode === 'earth' ? 'EARTH / 03-04' : 'MOON / 05'}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        {/* World Toggle */}
        <div>
          <label className="section-title">OPERATIONAL DOMAIN</label>
          <div className="mode-toggle">
            <input
              type="radio"
              name="mode"
              value="earth"
              checked={mode === 'earth'}
              onChange={() => setMode('earth')}
              id="mode-earth"
            />
            <input
              type="radio"
              name="mode"
              value="moon"
              checked={mode === 'moon'}
              onChange={() => setMode('moon')}
              id="mode-moon"
            />
            <label htmlFor="mode-earth" className={mode === 'earth' ? 'text-black' : 'text-black/55'}>
              EARTH
              <br />
              <span className="text-[9px] text-black/55">HIMALAYAS</span>
            </label>
            <label htmlFor="mode-moon" className={mode === 'moon' ? 'text-black' : 'text-black/55'}>
              MOON
              <br />
              <span className="text-[9px] text-black/55">LUNAR SOUTH</span>
            </label>
            <div className="thumb" />
          </div>
          <div className="mt-2 flex justify-between text-xs font-mono text-text-dim">
            <span>g = {mode === 'earth' ? '9.81' : '1.62'} m/s²</span>
            <span>{mode === 'earth' ? 'NAVIC L5+S' : 'VIO NAV'}</span>
          </div>
        </div>

        {/* Environment Intensity */}
        <div>
          <label className="section-title flex items-center justify-between">
            <span>{mode === 'earth' ? 'RAINFALL INTENSITY' : 'SOLAR ELEVATION'}</span>
            <span className="text-cyan font-mono text-sm">{envIntensity}{mode === 'earth' ? ' mm/hr' : '°'}</span>
          </label>
          <input
            type="range"
            min={mode === 'earth' ? '0' : '0.5'}
            max={mode === 'earth' ? '200' : '10'}
            step={mode === 'earth' ? '5' : '0.5'}
            value={envIntensity}
            onChange={(e) => setEnvIntensity(Number(e.target.value))}
            className="timeline-slider"
          />
          <div className="flex justify-between text-xs text-text-dim mt-1">
            <span>{mode === 'earth' ? 'Drizzle' : 'Polar Night'}</span>
            <span>{mode === 'earth' ? 'Cloudburst' : 'Peak Sun'}</span>
          </div>
        </div>

        {/* Sensor Noise */}
        <div>
          <label className="section-title flex items-center justify-between">
            <span>MONTE CARLO NOISE (σ)</span>
            <span className="text-cyan font-mono text-sm">{(noiseLevel * 100).toFixed(0)}%</span>
          </label>
          <input
            type="range"
            min="0"
            max="0.5"
            step="0.01"
            value={noiseLevel}
            onChange={(e) => setNoiseLevel(Number(e.target.value))}
            className="timeline-slider"
          />
          <div className="flex justify-between text-xs text-text-dim mt-1">
            <span>Deterministic</span>
            <span>High Uncertainty</span>
          </div>
        </div>

        {/* 4D Timeline Scrubber */}
        <div>
          <label className="section-title flex items-center justify-between">
            <span>4D TIMELINE</span>
            <span className="text-cyan font-mono text-sm">
              T+{time.current_step * 15}min
            </span>
          </label>
          <input
            type="range"
            min="0"
            max="4"
            step="1"
            value={time.current_step}
            onChange={(e) => setTimeStep(Number(e.target.value))}
            className="timeline-slider"
          />
          <div className="mt-2 grid grid-cols-[1fr_auto] items-center gap-2">
            <div className="flex min-w-0 gap-2">
              <button
                onClick={togglePlayback}
                className="btn-primary min-w-0 px-2 py-1.5 text-[10px] leading-tight"
                disabled={!simulationData}
              >
                {time.is_playing ? '⏸ PAUSE' : '▶ PLAY'}
              </button>
              <select
                value={time.playback_speed}
                onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
                className="min-w-0 bg-panel-border border border-panel-border/50 text-text-primary font-mono text-[10px] px-1.5 py-1.5 rounded"
              >
                <option value={0.5}>0.5×</option>
                <option value={1.0}>1.0×</option>
                <option value={2.0}>2.0×</option>
                <option value={4.0}>4.0×</option>
              </select>
            </div>
          </div>
          <div className="mt-2 flex justify-between gap-1">
              {[0, 1, 2, 3, 4].map(t => (
                <button
                  key={t}
                  onClick={() => setTimeStep(t)}
                  className={`h-7 min-w-0 flex-1 rounded font-mono text-[10px] transition-all ${
                    time.current_step === t
                      ? 'bg-white text-black font-bold'
                      : 'bg-white text-black/70 hover:bg-white'
                  }`}
                >
                  T{t}
                </button>
              ))}
          </div>
          <div className="flex justify-between text-[9px] text-text-dim mt-1">
            <span>T+0 MIN</span>
            <span>T+60 MIN</span>
          </div>
        </div>

        {/* Layer Toggles */}
        <div>
          <label className="section-title">VISUALIZATION LAYERS</label>
          <div className="space-y-2">
            {[
              { key: 'slope_heatmap', label: 'SLOPE HEATMAP', desc: 'Traversability gradient', color: 'crimson' },
              { key: 'monte_carlo_tube', label: 'MONTE CARLO TUBE', desc: '95% confidence corridor', color: 'cyan' },
              { key: 'naive_path', label: 'NAIVE PATH', desc: 'Static shortest path (comparison)', color: 'amber' },
              { key: 'contours', label: 'TOPO CONTOURS', desc: 'Elevation isolines', color: 'green' },
              { key: 'wireframe', label: 'WIREFRAME MESH', desc: 'Terrain topology', color: 'text-dim' },
            ].map(({ key, label, desc, color }) => (
              <label key={key} className="layer-toggle">
                <input
                  type="checkbox"
                  checked={layers[key as keyof typeof layers]}
                  onChange={() => toggleLayer(key as keyof typeof layers)}
                />
                <span className="indicator" style={{ borderColor: `var(--${color})` }} />
                <div className="flex-1">
                  <div className="font-mono text-[10px] leading-tight text-text-primary">{label}</div>
                  <div className="font-sans text-[9px] leading-tight text-text-dim">{desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Waypoint Controls */}
        <div>
          <label className="section-title">WAYPOINT CONTROL</label>
          <div className="space-y-3">
            <div className="panel-border p-3 rounded">
              <div className="flex items-center gap-2 mb-2">
                <span className="w-2 h-2 rounded-full bg-green" />
                <span className="font-mono text-xs text-green">START / SOS / LANDING</span>
              </div>
              <div className="font-mono text-sm">
                {startWaypoint
                  ? `X: ${startWaypoint.x.toString().padStart(3, ' ')}  Y: ${startWaypoint.y.toString().padStart(3, ' ')}`
                  : 'CLICK TERRAIN TO SET START'}
              </div>
            </div>
            <div className="panel-border p-3 rounded">
              <div className="flex items-center gap-2 mb-2">
                <span className="w-2 h-2 rounded-full bg-crimson" />
                <span className="font-mono text-[10px] leading-tight text-crimson">GOAL / SAFE ZONE</span>
              </div>
              <div className="font-mono text-sm">
                {goalWaypoint
                  ? `X: ${goalWaypoint.x.toString().padStart(3, ' ')}  Y: ${goalWaypoint.y.toString().padStart(3, ' ')}`
                  : 'NEXT TERRAIN CLICK SETS GOAL'}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setClickMode('start')}
                className="btn-primary min-w-0 flex-1 px-1.5 text-[9px] leading-tight"
                disabled={isSimulating}
              >
                CLICK TO SET START
              </button>
              <button
                onClick={() => setClickMode('goal')}
                className="btn-danger min-w-0 flex-1 px-1.5 text-[9px] leading-tight"
                disabled={isSimulating}
              >
                CLICK TO SET GOAL
              </button>
            </div>
            {clickMode && (
              <div className="text-center text-xs text-amber animate-blink">
                CLICK THE TERRAIN TO SET {clickMode.toUpperCase()}...
              </div>
            )}
          </div>
        </div>

        {/* Live replanning status */}
        <div className="pt-4 border-t border-panel-border">
          <div className={`font-mono text-xs tracking-wider ${isSimulating ? 'text-amber animate-pulse' : 'text-text-primary'}`}>
            {isSimulating ? 'LIVE SOLVER // REPLANNING' : simulationData ? 'LIVE SOLVER // ROUTE CURRENT' : 'LIVE SOLVER // WAITING FOR WAYPOINTS'}
          </div>
          <div className="text-xs text-text-dim mt-2 leading-relaxed">
            Click once for START and again for GOAL. Each new point or physics change reruns the 4D solver.
          </div>
        </div>

        {/* GeoTIFF Upload */}
        <div className="pt-4 border-t border-panel-border">
          <label className="section-title">REAL DEM UPLOAD</label>
          <input
            type="file"
            accept=".tif,.tiff,.geotiff"
            onChange={handleDemUpload}
            className="w-full text-xs text-text-dim file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-xs file:font-mono file:bg-cyan/20 file:text-cyan hover:file:bg-cyan/30"
          />
          <div className="text-xs text-text-dim mt-1">
            Single-band elevation GeoTIFF • Auto-resampled to 128×128
          </div>
        </div>
      </div>
    </div>
  );
};

