/** ASTRA-GNC 3D Terrain Digital Twin - React Three Fiber */

import React, { useRef, useEffect, useMemo, useState, Suspense } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  OrbitControls, Html, Stars, useGLTF
} from '@react-three/drei';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import * as THREE from 'three';
import type { SimulateResponse, Waypoint3D, Mode, LayerVisibility } from '@/types';
import { useMissionStore } from '@/store/useMissionStore';

// ============================================================================
// TERRAIN MESH COMPONENT
// ============================================================================

interface TerrainMeshProps {
  dem: number[][];
  slope: number[][];
  hazardMasks: number[][][];
  hazardIntensity: number[][][];
  mode: Mode;
  timeStep: number;
  showSlopeHeatmap: boolean;
  showWireframe: boolean;
  showContours: boolean;
  gridSize: number;
  cellSize: number;
  onTerrainClick: (x: number, y: number, shiftKey: boolean) => void;
}

const TerrainMesh: React.FC<TerrainMeshProps> = ({
  dem, slope, hazardMasks, hazardIntensity, mode, timeStep,
  showSlopeHeatmap, showWireframe, showContours, gridSize, cellSize, onTerrainClick
}) => {
  const meshRef = useRef<THREE.Mesh | null>(null);
  const geometryRef = useRef<THREE.BufferGeometry | null>(null);
  const materialRef = useRef<THREE.Material | null>(null);
  const waterRef = useRef<THREE.Mesh | null>(null);

  // Build terrain geometry
  useEffect(() => {
    if (!dem.length) return;

    const geometry = new THREE.BufferGeometry();
    const vertices: number[] = [];
    const colors: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    const elevations = dem.flat();
    const minElevation = Math.min(...elevations);
    const maxElevation = Math.max(...elevations);

    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const px = (x - gridSize / 2) * cellSize;
        const py = (y - gridSize / 2) * cellSize;
        const pz = (dem[y][x] - minElevation) * 0.2;

        vertices.push(px, py, pz);
        uvs.push(x / (gridSize - 1), y / (gridSize - 1));

        // Base color from elevation
        const elevNorm = (dem[y][x] - minElevation) / (maxElevation - minElevation + 1e-6);

        if (mode === 'earth') {
          // Earth: green/brown elevation ramp
          if (showSlopeHeatmap && slope[y][x] > 0) {
            const slopeNorm = Math.min(slope[y][x] / 45, 1);
            const gray = 0.08 + slopeNorm * 0.32;
            colors.push(gray, gray, gray);
          } else {
            const gray = 0.07 + elevNorm * 0.3;
            colors.push(gray, gray, gray);
          }
        } else {
          // Moon: grayscale with subtle color
          if (showSlopeHeatmap && slope[y][x] > 0) {
            const slopeNorm = Math.min(slope[y][x] / 35, 1);
            const gray = 0.16 + slopeNorm * 0.68;
            colors.push(gray, gray, gray);
          } else {
            const gray = 0.14 + elevNorm * 0.44;
            colors.push(gray, gray, gray);
          }
        }
      }
    }

    // Indices for triangles
    for (let y = 0; y < gridSize - 1; y++) {
      for (let x = 0; x < gridSize - 1; x++) {
        const a = y * gridSize + x;
        const b = y * gridSize + x + 1;
        const c = (y + 1) * gridSize + x;
        const d = (y + 1) * gridSize + x + 1;
        indices.push(a, b, d, d, c, a);
      }
    }

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    geometryRef.current?.dispose();
    geometryRef.current = geometry;

    // Material
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      wireframe: showWireframe,
      transparent: mode === 'earth',
      opacity: mode === 'earth' ? 0.92 : 1,
      side: THREE.DoubleSide,
      roughness: mode === 'moon' ? 0.9 : 0.7,
      metalness: 0.0,
      flatShading: false,
    });
    (materialRef.current as THREE.Material | null)?.dispose();
    materialRef.current = material;
    if (meshRef.current) {
      meshRef.current.geometry = geometry;
      meshRef.current.material = material;
    }
  }, [dem, slope, mode, showSlopeHeatmap, showWireframe, gridSize, cellSize]);

  // Update water/flood plane for Earth mode
  useEffect(() => {
    // Earth flooding is rendered as a DEM-draped mask in HazardOverlay.
    if (waterRef.current) waterRef.current.visible = false;
  }, [mode]);

  // Shadow plane for Moon mode
  useEffect(() => {
    if (waterRef.current && mode === 'moon') {
      waterRef.current.visible = false; // No water on moon
    }
  }, [mode]);

  return (
    <group>
      {/* Terrain */}
      <mesh
        ref={meshRef}
        receiveShadow
        castShadow
        onClick={(event) => {
          event.stopPropagation();
          onTerrainClick(event.point.x, event.point.y, event.nativeEvent.shiftKey);
        }}
        onPointerOver={() => { document.body.style.cursor = 'crosshair'; }}
        onPointerOut={() => { document.body.style.cursor = ''; }}
      />

      {/* Water / Flood Plane (Earth mode) */}
      <mesh
        ref={waterRef}
        visible={false}
        position={[0, 0, 0]}
        receiveShadow
      >
        <planeGeometry args={[gridSize * cellSize, gridSize * cellSize]} />
        <meshStandardMaterial
          color="#168BFF"
          transparent
          opacity={0.16}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>

      {/* Contour Lines */}
      {showContours && <ContourLines dem={dem} gridSize={gridSize} cellSize={cellSize} mode={mode} />}
    </group>
  );
};

// ============================================================================
// CONTOUR LINES
// ============================================================================

const ContourLines: React.FC<{
  dem: number[][];
  gridSize: number;
  cellSize: number;
  mode: Mode;
}> = ({ dem, gridSize, cellSize, mode }) => {
  const lineRef = useRef<THREE.LineSegments | null>(null);

  useEffect(() => {
    if (!dem.length) return;

    const geometry = new THREE.BufferGeometry();
    const positions: number[] = [];
    const colors: number[] = [];

    const contourInterval = mode === 'earth' ? 100 : 50; // meters
    const minZ = Math.min(...dem.flat());
    const maxZ = Math.max(...dem.flat());

    for (let level = Math.ceil(minZ / contourInterval) * contourInterval;
         level <= maxZ; level += contourInterval) {
      // Marching squares for contour lines
      for (let y = 0; y < gridSize - 1; y++) {
        for (let x = 0; x < gridSize - 1; x++) {
          const v00 = dem[y][x];
          const v10 = dem[y][x + 1];
          const v01 = dem[y + 1][x];
          const v11 = dem[y + 1][x + 1];

          const px = (x - gridSize / 2) * cellSize;
          const py = (y - gridSize / 2) * cellSize;
          const px1 = (x + 1 - gridSize / 2) * cellSize;
          const py1 = (y + 1 - gridSize / 2) * cellSize;

          // Check edges for contour crossings
          const edges = [
            { v0: v00, v1: v10, x0: px, y0: py, x1: px1, y1: py },
            { v0: v10, v1: v11, x0: px1, y0: py, x1: px1, y1: py1 },
            { v0: v11, v1: v01, x0: px1, y0: py1, x1: px, y1: py1 },
            { v0: v01, v1: v00, x0: px, y0: py1, x1: px, y1: py },
          ];

          const intersections: { x: number; y: number }[] = [];

          for (const edge of edges) {
            if ((edge.v0 - level) * (edge.v1 - level) < 0) {
              const t = (level - edge.v0) / (edge.v1 - edge.v0);
              intersections.push({
                x: edge.x0 + t * (edge.x1 - edge.x0),
                y: edge.y0 + t * (edge.y1 - edge.y0),
              });
            }
          }

          if (intersections.length === 2) {
            const [a, b] = intersections;
            const z = (level - minZ) * 0.2 + 1;
            positions.push(a.x, a.y, z);
            positions.push(b.x, b.y, z);
            const col = mode === 'earth' ? [0.58, 0.58, 0.58] : [0.72, 0.72, 0.72];
            colors.push(...col, ...col);
          }
        }
      }
    }

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    });

    if (lineRef.current) {
      lineRef.current.geometry.dispose();
      lineRef.current.geometry = geometry;
      lineRef.current.material = material;
    }
  }, [dem, gridSize, cellSize, mode]);

  return (
    <lineSegments ref={lineRef} />
  );
};

// ============================================================================
// HAZARD OVERLAY (Flood/Shadow)
// ============================================================================

interface HazardOverlayProps {
  dem: number[][];
  hazardMasks: number[][][];
  hazardIntensity: number[][][];
  mode: Mode;
  timeStep: number;
  gridSize: number;
  cellSize: number;
}

const HazardOverlay: React.FC<HazardOverlayProps> = ({
  dem, hazardMasks, hazardIntensity, mode, timeStep, gridSize, cellSize
}) => {
  const meshRef = useRef<THREE.Points | null>(null);
  const floodMeshRef = useRef<THREE.Mesh | null>(null);

  useEffect(() => {
    if (!hazardMasks.length || timeStep >= hazardMasks.length) {
      if (meshRef.current) meshRef.current.visible = false;
      if (floodMeshRef.current) floodMeshRef.current.visible = false;
      return;
    }

    const hazard = hazardMasks[timeStep];
    const intensity = hazardIntensity[timeStep];

    if (mode === 'earth') {
      if (meshRef.current) meshRef.current.visible = false;
      if (!floodMeshRef.current) return;
      const minElevation = Math.min(...dem.flat());
      const positions: number[] = [];
      const uvs: number[] = [];
      const indices: number[] = [];
      for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
          const elevation = dem[y]?.[x] ?? minElevation;
          positions.push(
            (x - gridSize / 2) * cellSize,
            (y - gridSize / 2) * cellSize,
            (elevation - minElevation) * 0.2 + 2.5,
          );
          uvs.push(x / (gridSize - 1), y / (gridSize - 1));
          if (x < gridSize - 1 && y < gridSize - 1) {
            const a = y * gridSize + x;
            const b = a + 1;
            const c = a + gridSize;
            const d = c + 1;
            indices.push(a, b, d, d, c, a);
          }
        }
      }

      const source = document.createElement('canvas');
      source.width = gridSize;
      source.height = gridSize;
      const sourceContext = source.getContext('2d');
      if (!sourceContext) return;
      const mask = sourceContext.createImageData(gridSize, gridSize);
      for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
          if (hazard[y][x] <= 0.5) continue;
          const index = (y * gridSize + x) * 4;
          mask.data[index] = 18;
          mask.data[index + 1] = 115;
          mask.data[index + 2] = 238;
          mask.data[index + 3] = Math.round(150 + Math.min(1, intensity[y][x]) * 90);
        }
      }
      sourceContext.putImageData(mask, 0, 0);
      const smooth = document.createElement('canvas');
      smooth.width = gridSize * 4;
      smooth.height = gridSize * 4;
      const smoothContext = smooth.getContext('2d');
      if (!smoothContext) return;
      smoothContext.imageSmoothingEnabled = true;
      smoothContext.filter = 'blur(1.5px)';
      smoothContext.drawImage(source, 0, 0, smooth.width, smooth.height);

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      const texture = new THREE.CanvasTexture(smooth);
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      });
      if (floodMeshRef.current) {
        floodMeshRef.current.geometry.dispose();
        const currentMaterial = floodMeshRef.current.material as THREE.MeshBasicMaterial;
        currentMaterial.map?.dispose();
        currentMaterial.dispose();
        floodMeshRef.current.geometry = geometry;
        floodMeshRef.current.material = material;
        floodMeshRef.current.visible = true;
      }
      return;
    }

    if (floodMeshRef.current) floodMeshRef.current.visible = false;

    const geometry = new THREE.BufferGeometry();
    const positions: number[] = [];
    const colors: number[] = [];
    const alphas: number[] = [];
    const indices: number[] = [];
    const minElevation = Math.min(...dem.flat());

    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        if (hazard[y][x] > 0.5) {
          const px = (x - gridSize / 2) * cellSize;
          const py = (y - gridSize / 2) * cellSize;
          const pz = ((dem[y]?.[x] ?? minElevation) - minElevation) * 0.2 + intensity[y][x] * 3 + 2;

          positions.push(px, py, pz);
          alphas.push(intensity[y][x]);

          // Lunar shadow cells stay near-black against the dark surface.
          colors.push(0.08, 0.08, 0.08);
        }
      }
    }

    if (positions.length === 0) {
      if (meshRef.current) meshRef.current.visible = false;
      return;
    }

    // Moon hazards remain sparse points; Earth flood uses a smoothed draped mesh.
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute('alpha', new THREE.Float32BufferAttribute(alphas, 1));

    const material = new THREE.PointsMaterial({
      size: cellSize * 0.9,
      vertexColors: true,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      sizeAttenuation: false,
    });

    if (meshRef.current) {
      meshRef.current.geometry.dispose();
      meshRef.current.geometry = geometry;
      meshRef.current.material = material;
      meshRef.current.visible = true;
    }
  }, [hazardMasks, hazardIntensity, mode, timeStep, gridSize, cellSize]);

  return (
    <>
      <points ref={meshRef} visible={false} />
      <mesh ref={floodMeshRef} visible={false} />
    </>
  );
};

// ============================================================================
// TRAJECTORY TUBE (Optimal Path)
// ============================================================================

interface TrajectoryTubeProps {
  waypoints: Waypoint3D[];
  color: string;
  dashed?: boolean;
  tubeRadius?: number;
  visible?: boolean;
}

const TrajectoryTube: React.FC<TrajectoryTubeProps> = ({
  waypoints, color, dashed = false, tubeRadius = 8, visible = true
}) => {
  const meshRef = useRef<THREE.Mesh | null>(null);

  useEffect(() => {
    if (!waypoints.length || !visible) {
      if (meshRef.current) meshRef.current.visible = false;
      return;
    }

    // Create catmull-rom curve
    const points = waypoints.map(w => new THREE.Vector3(w.x, w.y, w.z));
    // Centripetal interpolation keeps the rendered rover route close to the
    // planned waypoints around tight crater turns.
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    curve.closed = false;

    // Tube geometry
    const geometry = new THREE.TubeGeometry(curve, waypoints.length * 4, tubeRadius, 8, false);

    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      transparent: true,
      opacity: dashed ? 0.4 : 0.8,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    if (dashed) {
      // Dashed effect via line instead
      material.opacity = 0.35;
    }

    if (meshRef.current) {
      meshRef.current.geometry.dispose();
      meshRef.current.geometry = geometry;
      meshRef.current.material = material;
      meshRef.current.visible = true;
    }
  }, [waypoints, color, dashed, tubeRadius, visible]);

  return <mesh ref={meshRef} visible={visible} />;
};

// ============================================================================
// MONTE CARLO CORRIDOR
// ============================================================================

interface MonteCarloCorridorProps {
  corridorCells: [number, number, number][];
  gridSize: number;
  cellSize: number;
  dem: number[][];
  visible: boolean;
}

const MonteCarloCorridor: React.FC<MonteCarloCorridorProps> = ({
  corridorCells, gridSize, cellSize, dem, visible
}) => {
  const meshRef = useRef<THREE.Points | null>(null);

  useEffect(() => {
    if (!corridorCells.length || !visible || !dem.length) {
      if (meshRef.current) meshRef.current.visible = false;
      return;
    }

    const geometry = new THREE.BufferGeometry();
    const positions: number[] = [];
    const colors: number[] = [];

    for (const [x, y, t] of corridorCells) {
      const px = (x - gridSize / 2) * cellSize;
      const py = (y - gridSize / 2) * cellSize;
      const pz = ((dem[y]?.[x] ?? 0) - Math.min(...dem.flat())) * 0.2 + 15;

      positions.push(px, py, pz);
      // Cyan with transparency based on time step
      const alpha = 0.15 + (t / 4) * 0.1;
      colors.push(0.82, 0.82, 0.82, alpha);
    }

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));

    const material = new THREE.PointsMaterial({
      size: cellSize * 0.6,
      vertexColors: true,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      sizeAttenuation: false,
      blending: THREE.AdditiveBlending,
    });

    if (meshRef.current) {
      meshRef.current.geometry.dispose();
      meshRef.current.geometry = geometry;
      meshRef.current.material = material;
      meshRef.current.visible = true;
    }
  }, [corridorCells, gridSize, cellSize, dem, visible]);

  return <points ref={meshRef} visible={visible} />;
};

// ============================================================================
// ROVER / RESCUE VEHICLE MARKER
// ============================================================================

interface VehicleMarkerProps {
  position: Waypoint3D | null;
  mode: Mode;
  visible: boolean;
}

const VehicleMarker: React.FC<VehicleMarkerProps> = ({ position, mode, visible }) => {
  const groupRef = useRef<THREE.Group | null>(null);
  const timeRef = useRef(0);

  useFrame((state, delta) => {
    if (groupRef.current && visible) {
      timeRef.current += delta;
      // Subtle hover animation
      groupRef.current.position.z = (position?.z ?? 0) + Math.sin(timeRef.current * 2) * 0.5;
      // Rotate
      groupRef.current.rotation.z = timeRef.current * 0.5;
    }
  });

  if (!position || !visible) return null;

  return (
    <group ref={groupRef} position={[position.x, position.y, position.z]}>
      {mode === 'earth' ? (
        // Rescue helicopter/vehicle
        <group>
          <mesh castShadow receiveShadow>
            <boxGeometry args={[12, 8, 4]} />
            <meshStandardMaterial color="#D0D0D0" emissive="#B0B0B0" emissiveIntensity={0.12} />
          </mesh>
          <mesh castShadow receiveShadow position={[0, 0, -6]}>
            <cylinderGeometry args={[2, 2, 12, 8]} />
            <meshStandardMaterial color="#333" />
          </mesh>
        </group>
      ) : (
        // Lunar rover
        <group>
          <mesh castShadow receiveShadow>
            <boxGeometry args={[14, 10, 6]} />
            <meshStandardMaterial color="#CCCCCC" roughness={0.8} metalness={0.2} />
          </mesh>
          {/* Wheels */}
          {[-7, 7].map(x => [-5, 5].map(y => (
            <mesh key={`${x},${y}`} castShadow receiveShadow position={[x, y, -6]}>
              <cylinderGeometry args={[3, 3, 2, 12]} />
              <meshStandardMaterial color="#111" roughness={0.9} />
            </mesh>
          ))).flat()}
          {/* Solar panel */}
          <mesh position={[0, 0, 8]}>
            <planeGeometry args={[16, 12]} />
            <meshStandardMaterial color="#555555" side={THREE.DoubleSide} metalness={0.5} roughness={0.3} />
          </mesh>
          {/* Antenna */}
          <mesh position={[6, 0, 10]}>
            <cylinderGeometry args={[0.5, 0.5, 15, 6]} />
            <meshStandardMaterial color="#A0A0A0" />
          </mesh>
        </group>
      )}
    </group>
  );
};

// ============================================================================
// WAYPOINT MARKERS (Start/Goal)
// ============================================================================

interface WaypointMarkerProps {
  position: { x: number; y: number } | null;
  dem: number[][];
  gridSize: number;
  cellSize: number;
  type: 'start' | 'goal';
  visible: boolean;
}

const WaypointMarker: React.FC<WaypointMarkerProps> = ({
  position, dem, gridSize, cellSize, type, visible
}) => {
  if (!position || !visible || !dem.length) return null;

  const z = ((dem[position.y]?.[position.x] ?? 0) - Math.min(...dem.flat())) * 0.2;
  const px = (position.x - gridSize / 2) * cellSize;
  const py = (position.y - gridSize / 2) * cellSize;

  return (
    <group position={[px, py, z + 20]}>
      <mesh>
        <sphereGeometry args={[6, 16, 16]} />
        <meshBasicMaterial
          color={type === 'start' ? '#F5F5F5' : '#929292'}
          transparent
          opacity={0.9}
        />
      </mesh>
      <Html position={[0, 0, 15]} center>
        <div className="font-mono text-xs text-center px-2 py-1 rounded bg-space/90 border border-cyan/50">
          {type === 'start' ? 'SOS / LANDING' : 'SAFE ZONE / TARGET'}
        </div>
      </Html>
      {/* Pulsing ring */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[8, 12, 32]} />
        <meshBasicMaterial
          color={type === 'start' ? '#F5F5F5' : '#929292'}
          transparent
          opacity={0.5}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
};

// ============================================================================
// ORBITAL ENTRY + LIVE DIGITAL TWIN
// ============================================================================

interface DigitalTwinProps {
  data: SimulateResponse | null;
  className?: string;
}

// ASTRA's orbital entry uses the user's Earth model from Radiant Wars.
const EARTH_MODEL_URL = '/earth.glb';
const MOON_MODEL_URL = '/moon.glb';
useGLTF.preload(EARTH_MODEL_URL);

const EarthModel: React.FC<{ onEnter: () => void; zoomed: boolean }> = ({ onEnter, zoomed }) => {
  const model = useGLTF(EARTH_MODEL_URL) as unknown as {
    nodes: Record<string, THREE.Mesh>;
    materials: Record<string, THREE.Material>;
  };
  const groupRef = useRef<THREE.Group | null>(null);
  useFrame((_, delta) => {
    if (groupRef.current && !zoomed) groupRef.current.rotation.z += delta * 0.035;
  });

  return (
    <group
      ref={groupRef}
      onClick={(event) => { event.stopPropagation(); onEnter(); }}
      onPointerOver={() => { document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { document.body.style.cursor = ''; }}
    >
      <mesh castShadow receiveShadow geometry={model.nodes.Object_4.geometry} material={model.materials.material_0} scale={14.79} />
      <mesh castShadow receiveShadow geometry={model.nodes.Object_6.geometry} material={model.materials.material_1} scale={15.128} />
    </group>
  );
};

const EarthFallback: React.FC<{ onEnter: () => void }> = ({ onEnter }) => (
  <mesh onClick={(event) => { event.stopPropagation(); onEnter(); }}>
    <sphereGeometry args={[15, 48, 48]} />
    <meshStandardMaterial color="#9aa9b7" roughness={0.82} metalness={0.08} />
  </mesh>
);

const MoonGlobe: React.FC<{ onEnter: () => void; zoomed: boolean }> = ({ onEnter, zoomed }) => {
  const { scene } = useGLTF(MOON_MODEL_URL);
  const groupRef = useRef<THREE.Group | null>(null);
  const moon = useMemo(() => {
    const clone = scene.clone(true);
    clone.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(clone);
    const size = bounds.getSize(new THREE.Vector3());
    const largestDimension = Math.max(size.x, size.y, size.z) || 1;
    clone.scale.multiplyScalar(30 / largestDimension);
    clone.updateMatrixWorld(true);
    bounds.setFromObject(clone);
    clone.position.sub(bounds.getCenter(new THREE.Vector3()));
    clone.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
    return clone;
  }, [scene]);

  useFrame((_, delta) => {
    if (groupRef.current && !zoomed) groupRef.current.rotation.y += delta * 0.025;
  });

  return (
    <group
      ref={groupRef}
      onClick={(event) => { event.stopPropagation(); onEnter(); }}
      onPointerOver={() => { document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { document.body.style.cursor = ''; }}
    >
      <primitive object={moon} />
    </group>
  );
};

const OrbitEntry: React.FC<{ mode: Mode; zoomed: boolean; onEnter: () => void }> = ({ mode, zoomed, onEnter }) => (
  <>
    <color attach="background" args={[zoomed && mode === 'earth' ? '#e9e9e5' : '#030405']} />
    {!(zoomed && mode === 'earth') && <Stars radius={120} depth={90} count={3600} factor={3.2} saturation={0} fade speed={0.12} />}
    <ambientLight intensity={0.45} />
    <directionalLight position={[-45, -15, 30]} intensity={2.4} />
    {mode === 'earth' ? (
      <Suspense fallback={<EarthFallback onEnter={onEnter} />}>
        <EarthModel onEnter={onEnter} zoomed={zoomed} />
      </Suspense>
    ) : <MoonGlobe onEnter={onEnter} zoomed={zoomed} />}
  </>
);

const CameraTransition: React.FC<{
  data: SimulateResponse | null;
  mode: Mode;
  sceneStage: 'orbit' | 'surface';
  setCameraReady: React.Dispatch<React.SetStateAction<boolean>>;
}> = ({ data, mode, sceneStage, setCameraReady }) => {
  const { camera } = useThree();
  const destination = useRef(new THREE.Vector3(0, 0, 42));
  const arrived = useRef(false);
  const hasTerrain = sceneStage === 'surface' && data !== null;
  const gridSize = data?.grid_size ?? 128;
  const cellSize = data?.cell_size ?? 10;

  useEffect(() => {
    const halfExtent = hasTerrain ? (gridSize * cellSize) / 2 : 0;
    destination.current.set(
      0,
      hasTerrain ? -halfExtent * (mode === 'earth' ? 1.2 : 1.5) : 0,
      hasTerrain ? halfExtent * (mode === 'earth' ? 0.8 : 1.0) : (sceneStage === 'surface' ? 23 : 42),
    );
    arrived.current = false;
    setCameraReady(false);
  }, [hasTerrain, gridSize, cellSize, mode, sceneStage, setCameraReady]);

  useFrame((_, delta) => {
    if (arrived.current) return;
    camera.up.set(0, 0, 1);
    camera.position.lerp(destination.current, 1 - Math.exp(-delta * 1.35));
    camera.lookAt(0, 0, 0);
    if (!arrived.current && camera.position.distanceTo(destination.current) < 1.5) {
      arrived.current = true;
      setCameraReady(true);
    }
  });

  return null;
};

export const DigitalTwin: React.FC<DigitalTwinProps> = ({ data, className }) => {
  const {
    time, layers, mode, sceneStage, startWaypoint, goalWaypoint,
    setStartWaypoint, setGoalWaypoint, clickMode, setClickMode, enterSurface, setNextWaypointTarget,
  } = useMissionStore();
  const [cameraReady, setCameraReady] = useState(false);

  const handleTerrainClick = (worldX: number, worldY: number, shiftKey: boolean) => {
    if (!data) return;
    const x = Math.max(0, Math.min(data.grid_size - 1, Math.round(worldX / data.cell_size + data.grid_size / 2)));
    const y = Math.max(0, Math.min(data.grid_size - 1, Math.round(worldY / data.cell_size + data.grid_size / 2)));
    const state = useMissionStore.getState();
    const target = state.clickMode ?? (shiftKey ? 'start' : state.nextWaypointTarget);
    if (target === 'start') setStartWaypoint({ x, y });
    else setGoalWaypoint({ x, y });
    if (target === 'start') setNextWaypointTarget('goal');
    if (state.clickMode) setClickMode(null);
  };

  return (
    <Canvas
      className={className}
      camera={{ position: [0, 0, 42], fov: 50, near: 0.1, far: 5000 }}
      gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true, logarithmicDepthBuffer: true }}
      onCreated={({ gl }) => {
        gl.shadowMap.enabled = true;
        gl.shadowMap.type = THREE.PCFSoftShadowMap;
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.0;
      }}
    >
      <CameraTransition
        data={data}
        mode={mode}
        sceneStage={sceneStage}
        setCameraReady={setCameraReady}
      />
      <Suspense fallback={<LoadingFallback />}>
        {sceneStage === 'surface' && data ? (
          <SceneContent
            data={data}
            timeStep={time.current_step}
            layers={layers}
            mode={mode}
            startWaypoint={startWaypoint}
            goalWaypoint={goalWaypoint}
            setClickMode={setClickMode}
            onTerrainClick={handleTerrainClick}
          />
        ) : (
          <OrbitEntry mode={mode} zoomed={sceneStage === 'surface'} onEnter={enterSurface} />
        )}
      </Suspense>

      <EffectComposer>
        <Bloom
          intensity={sceneStage === 'orbit' ? 1.2 : mode === 'moon' ? 0.85 : 0.16}
          luminanceThreshold={sceneStage === 'orbit' ? 0.3 : mode === 'moon' ? 0.72 : 0.92}
          luminanceSmoothing={0.9}
          mipmapBlur
        />
      </EffectComposer>

      {sceneStage === 'surface' && data && (
        <>
          <OrbitControls
            enabled={cameraReady && sceneStage === 'surface'}
            enableDamping
            dampingFactor={0.05}
            enablePan
            minZoom={0.5}
            maxZoom={10}
            minPolarAngle={0}
            maxPolarAngle={Math.PI / 2 - 0.05}
          />
          <fog attach="fog" args={[mode === 'earth' ? 0xF4F4F1 : 0x050608, 100, 3000]} />
        </>
      )}
    </Canvas>
  );
};

// ============================================================================
// SCENE CONTENT
// ============================================================================

interface SceneContentProps {
  data: SimulateResponse;
  timeStep: number;
  layers: LayerVisibility;
  mode: Mode;
  startWaypoint: { x: number; y: number } | null;
  goalWaypoint: { x: number; y: number } | null;
  setClickMode: (mode: 'start' | 'goal' | null) => void;
  onTerrainClick: (x: number, y: number, shiftKey: boolean) => void;
}

const SceneContent: React.FC<SceneContentProps> = ({
  data, timeStep, layers, mode, startWaypoint, goalWaypoint, setClickMode, onTerrainClick
}) => {
  const { dem, slope, hazard_masks, hazard_intensity, optimal_path_3d, naive_path_3d,
          monte_carlo_corridor, grid_size, cell_size } = data;

  const isEarth = mode === 'earth';

  // Lighting based on mode
  const sunAngle = isEarth ? Math.PI / 4 : (timeStep / 4) * Math.PI / 2 - Math.PI / 4;
  const halfExtent = grid_size * cell_size / 2;
  const lightPosition: [number, number, number] = [
    Math.sin(sunAngle) * 2000,
    Math.cos(sunAngle) * 2000,
    1500
  ];

  return (
    <>
      <color attach="background" args={[isEarth ? '#e9e9e5' : '#050608']} />
      {!isEarth && <Stars radius={900} depth={120} count={1800} factor={2.5} saturation={0} fade speed={0.2} />}
      {/* Lighting */}
      <ambientLight intensity={isEarth ? 0.4 : 0.15} color="#ffffff" />
      <directionalLight
        position={lightPosition}
        intensity={isEarth ? 1.2 : 2.5}
        color={isEarth ? "#E5E5E5" : "#FFFFFF"}
        castShadow
        shadow-mapSize-width={4096}
        shadow-mapSize-height={4096}
        shadow-camera-near={100}
        shadow-camera-far={4000}
        shadow-camera-left={-halfExtent * 1.5}
        shadow-camera-right={halfExtent * 1.5}
        shadow-camera-top={halfExtent * 1.5}
        shadow-camera-bottom={-halfExtent * 1.5}
        shadow-bias={-0.0005}
      />

      {/* Hemisphere light for fill */}
      <hemisphereLight intensity={0.3} groundColor={isEarth ? "#303030" : "#111111"} />

      {/* Terrain */}
      <TerrainMesh
        dem={dem}
        slope={slope}
        hazardMasks={hazard_masks}
        hazardIntensity={hazard_intensity}
        mode={mode}
        timeStep={timeStep}
        showSlopeHeatmap={layers.slope_heatmap}
        showWireframe={layers.wireframe}
        showContours={layers.contours}
        gridSize={grid_size}
        cellSize={cell_size}
        onTerrainClick={onTerrainClick}
      />

      {/* Hazard Overlay */}
      <HazardOverlay
        dem={dem}
        hazardMasks={hazard_masks}
        hazardIntensity={hazard_intensity}
        mode={mode}
        timeStep={timeStep}
        gridSize={grid_size}
        cellSize={cell_size}
      />

      {/* Monte Carlo Corridor */}
      {layers.monte_carlo_tube && monte_carlo_corridor?.corridor_cells?.length && (
        <MonteCarloCorridor
          corridorCells={monte_carlo_corridor.corridor_cells}
          gridSize={grid_size}
          cellSize={cell_size}
          dem={dem}
          visible={true}
        />
      )}

      {/* Naive Path (Dashed Red) */}
      {layers.naive_path && naive_path_3d.length > 0 && (
        <TrajectoryTube
          waypoints={naive_path_3d}
          color={isEarth ? '#55585B' : '#8D8D8D'}
          dashed={true}
          tubeRadius={5}
          visible={true}
        />
      )}

      {/* Optimal Path (Cyan Tube) */}
      {optimal_path_3d.length > 0 && (
        <TrajectoryTube
          waypoints={optimal_path_3d}
          color={isEarth ? '#17191B' : '#F2F2F2'}
          tubeRadius={8}
          visible={true}
        />
      )}

      {/* Vehicle Marker at current time step */}
      {optimal_path_3d.length > timeStep && (
        <VehicleMarker
          position={optimal_path_3d[timeStep]}
          mode={mode}
          visible={true}
        />
      )}

      {/* Start/Goal Markers */}
      <WaypointMarker
        position={startWaypoint}
        dem={dem}
        gridSize={grid_size}
        cellSize={cell_size}
        type="start"
        visible={!!startWaypoint}
      />
      <WaypointMarker
        position={goalWaypoint}
        dem={dem}
        gridSize={grid_size}
        cellSize={cell_size}
        type="goal"
        visible={!!goalWaypoint}
      />

      {/* Grid Helper */}
      <group>
        <gridHelper args={[grid_size * cell_size, cell_size, isEarth ? '#9A9A98' : '#454545', isEarth ? '#C8C8C4' : '#171717']} position={[0, 0, -10]} />
      </group>

      {/* Axis Labels */}
      <Html position={[-halfExtent, 0, 50]} center>
        <span className="font-mono text-xs text-text-dim">WEST</span>
      </Html>
      <Html position={[halfExtent, 0, 50]} center>
        <span className="font-mono text-xs text-text-dim">EAST</span>
      </Html>
      <Html position={[0, -halfExtent, 50]} center>
        <span className="font-mono text-xs text-text-dim">SOUTH</span>
      </Html>
      <Html position={[0, halfExtent, 50]} center>
        <span className="font-mono text-xs text-text-dim">NORTH</span>
      </Html>
    </>
  );
};

const halfExtent = 640; // 128 * 10 / 2

// ============================================================================
// LOADING FALLBACK
// ============================================================================

const LoadingFallback: React.FC = () => (
  <Html center>
    <div className="text-center p-8">
      <div className="text-2xl font-mono text-cyan mb-4 animate-pulse">LOADING TERRAIN...</div>
      <div className="text-text-dim">Initializing 4D Digital Twin</div>
    </div>
  </Html>
);

export default DigitalTwin;
