/** ASTRA-GNC Right Telemetry Dock - Live GNC & DTN Subsystems */

import React, { useCallback, useEffect, useState } from 'react';
import { useMissionStore } from '@/store/useMissionStore';
import { api } from '@/services/api';
import type { ReceiverState, MeshTransmitResponse } from '@/types';

export const RightTelemetryDock: React.FC = () => {
  const {
    telemetry, dtnPacket, meshReceiver, setMeshReceiver,
    meshTransmitting, setMeshTransmitting, meshHops, setMeshHops,
    simulationData, mode
  } = useMissionStore();

  const [hexDumpLines, setHexDumpLines] = useState<string[]>([]);
  const [transmitProgress, setTransmitProgress] = useState(0);
  const [showReceiverModal, setShowReceiverModal] = useState(false);

  // Update hex dump when packet changes
  useEffect(() => {
    if (dtnPacket?.packet_hex) {
      const hex = dtnPacket.packet_hex;
      const lines: string[] = [];
      for (let i = 0; i < hex.length; i += 32) {
        const chunk = hex.slice(i, i + 32);
        const offset = (i / 2).toString(16).padStart(4, '0');
        const bytes = chunk.match(/.{2}/g)?.join(' ') || '';
        const ascii = chunk.match(/.{2}/g)?.map(b => {
          const c = parseInt(b, 16);
          return c >= 32 && c <= 126 ? String.fromCharCode(c) : '.';
        }).join('') || '';
        lines.push(`${offset}  ${bytes.padEnd(47)}  ${ascii}`);
      }
      setHexDumpLines(lines);
    }
  }, [dtnPacket]);

  // Poll receiver state
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const state = await api.getReceiverState();
        setMeshReceiver(state);
      } catch {
        const current = useMissionStore.getState().meshReceiver;
        if (current.status !== 'BACKEND LINK DOWN') {
          setMeshReceiver({ ...current, status: 'BACKEND LINK DOWN' });
        }
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [setMeshReceiver]);

  const handleTransmit = useCallback(async () => {
    if (!dtnPacket?.packet_hex) return;

    setMeshTransmitting(true);
    setMeshHops([
      { node: 'ORBITAL_RELAY', status: 'pending' },
      { node: 'GROUND_STATION_INDIA', status: 'pending' },
      { node: 'MESH_GATEWAY_BLE', status: 'pending' },
      { node: 'FIELD_UNIT_RESCUE_TEAM', status: 'pending' },
    ]);
    setTransmitProgress(0);

    // Animate hops
    const hopNodes = ['ORBITAL_RELAY', 'GROUND_STATION_INDIA', 'MESH_GATEWAY_BLE', 'FIELD_UNIT_RESCUE_TEAM'];
    for (let i = 0; i < hopNodes.length; i++) {
      await new Promise(r => setTimeout(r, 500));
      setMeshHops(useMissionStore.getState().meshHops.map((h, idx) => ({
        ...h,
        status: idx < i ? 'complete' : idx === i ? 'active' : 'pending'
      })));
      setTransmitProgress((i + 1) / hopNodes.length * 100);
    }

    try {
      const response = await api.meshTransmit({ packet_hex: dtnPacket.packet_hex, target_node: 'field_unit' });
      if (response.success) {
        setMeshHops(useMissionStore.getState().meshHops.map(h => ({ ...h, status: 'complete' })));
        setTransmitProgress(100);
        setShowReceiverModal(true);
      }
    } catch (err) {
      console.error('Transmit error:', err);
      setMeshHops(useMissionStore.getState().meshHops.map(h => ({ ...h, status: 'pending' })));
    } finally {
      setMeshTransmitting(false);
      setTimeout(() => setTransmitProgress(0), 2000);
    }
  }, [dtnPacket, setMeshTransmitting, setMeshHops, setMeshReceiver]);

  const formatHex = (hex: string) => {
    return hex.match(/.{2}/g)?.join(' ') || '';
  };

  return (
    <div className="panel h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-panel-border flex items-center justify-between gap-2">
        <h2 className="section-title mb-0 min-w-0 text-[9px] leading-tight tracking-[0.1em]">LIVE GNC & DTN</h2>
        <span className={`status-indicator shrink-0 text-[8px] leading-tight ${meshReceiver.status === 'ROUTE_RECEIVED' ? 'status-nominal' : 'status-warning'}`}>
          {meshReceiver.status}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        {/* Subsystem Metrics Cards */}
        <div>
          <label className="section-title">SUBSYSTEM METRICS</label>
          <div className="grid min-w-0 grid-cols-2 gap-2">
            <MetricCard
              label="MAX TERRAIN GRADIENT"
              value={`${telemetry.max_gradient.toFixed(1)}°`}
              unit="DEG"
              color="crimson"
              threshold={mode === 'earth' ? 35 : 25}
              current={telemetry.max_gradient}
            />
            <MetricCard
              label="GRAVITY CONSTANT"
              value={telemetry.gravity.toFixed(2)}
              unit="m/s²"
              color="cyan"
            />
            <MetricCard
              label="BATTERY SoC / SURVIVAL"
              value={`${telemetry.battery_soc.toFixed(0)}%`}
              unit={`MARGIN: ${telemetry.survival_margin.toFixed(0)}%`}
              color={telemetry.survival_margin > 70 ? 'green' : telemetry.survival_margin > 40 ? 'amber' : 'crimson'}
            />
            <MetricCard
              label="POSITIONING"
              value={mode === 'moon' ? 'VIO' : 'NAVIC L5+S'}
              unit={mode === 'moon' ? 'VISUAL ODOMETRY' : 'CEP 1.8m'}
              color="green"
              isText={true}
            />
            <MetricCard
              label="PATH SURVIVAL"
              value={telemetry.path_survival}
              unit={telemetry.path_survival === 'NOMINAL' ? 'ASTRA-GNC OPTIMAL' : 'NAIVE COMPROMISED'}
              color={telemetry.path_survival === 'NOMINAL' ? 'green' : 'crimson'}
              isText={true}
            />
            <MetricCard
              label="DTN PACKET SIZE"
              value={`${dtnPacket?.packet_bytes || 0} B`}
              unit={`RATIO ${dtnPacket?.compression_ratio?.toFixed(0) || 0}:1`}
              color={dtnPacket && dtnPacket.packet_bytes < 500 ? 'green' : 'crimson'}
            />
          </div>
        </div>

        {/* DTN Semantic Compression Panel */}
        <div>
          <label className="section-title flex items-center justify-between">
            <span>DTN SEMANTIC COMPRESSION</span>
            {dtnPacket && (
              <span className={`status-indicator ${dtnPacket.packet_bytes < 500 ? 'status-nominal' : 'status-critical'}`}>
                {dtnPacket.packet_bytes} / 500 B
              </span>
            )}
          </label>

          <div className="panel-border p-4 rounded space-y-3 font-mono text-xs">
            <div className="grid grid-cols-2 gap-2 text-text-secondary">
              <div>
                <span className="text-text-dim">RAW RASTER:</span>
                <span className="text-cyan ml-2">{dtnPacket?.raw_size_estimate_bytes ? (dtnPacket.raw_size_estimate_bytes / 1e6).toFixed(1) : '0'} MB</span>
              </div>
              <div>
                <span className="text-text-dim">DTN PACKET:</span>
                <span className="text-green ml-2">{dtnPacket?.packet_bytes || 0} BYTES</span>
              </div>
              <div>
                <span className="text-text-dim">COMPRESSION:</span>
                <span className="text-amber ml-2">{dtnPacket?.compression_ratio?.toFixed(0) || 0}:1</span>
              </div>
              <div>
                <span className="text-text-dim">CHECKSUM:</span>
                <span className="text-text-primary ml-2">0x{dtnPacket?.checksum?.toString(16).toUpperCase().padStart(4, '0') || '0000'}</span>
              </div>
            </div>

            {/* Hex Dump */}
            <div className="panel p-3 rounded max-h-48 overflow-auto border border-panel-border/50">
              <div className="hex-dump text-[10px] leading-tight font-mono">
                {hexDumpLines.map((line, i) => (
                  <div key={i} className="select-all">
                    <span className="offset">{line.slice(0, 5)}</span>
                    <span className="byte">{line.slice(5, 52)}</span>
                    <span className="ascii">{line.slice(52)}</span>
                  </div>
                ))}
                {!hexDumpLines.length && (
                  <div className="text-text-dim text-center py-8">No packet generated — run simulation first</div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Mesh Relay Panel */}
        <div>
          <label className="section-title flex items-center justify-between">
            <span>MESH RELAY NETWORK</span>
            {meshTransmitting && (
              <span className="status-indicator status-warning animate-blink">
                TRANSMITTING {transmitProgress.toFixed(0)}%
              </span>
            )}
          </label>

          <div className="space-y-2">
            {[
              { id: 'ORBITAL_RELAY', label: 'ORBITAL RELAY', type: 'SATELLITE', protocol: 'CCSDS-BPv7' },
              { id: 'GROUND_STATION_INDIA', label: 'GROUND STATION', type: 'INDIA DSN', protocol: 'TCPCL' },
              { id: 'MESH_GATEWAY_BLE', label: 'MESH GATEWAY', type: 'BLE/LoRa', protocol: 'LoRaWAN+BLE' },
              { id: 'FIELD_UNIT_RESCUE_TEAM', label: 'FIELD UNIT', type: 'HANDHELD', protocol: 'BLE 5.0' },
            ].map((node, i) => {
              const hop = meshHops.find(h => h.node === node.id);
              const status = hop?.status || 'pending';
              return (
                <div key={node.id} className={`mesh-node ${status === 'complete' ? 'active' : status === 'active' ? 'pending' : ''}`}>
                  <div className={`w-2 h-2 rounded-full ${status === 'complete' ? 'bg-green' : status === 'active' ? 'bg-amber animate-pulse' : 'bg-text-dim'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs text-text-primary">{node.label}</div>
                    <div className="font-sans text-[10px] text-text-dim">{node.type} • {node.protocol}</div>
                  </div>
                  <div className="font-mono text-xs text-text-dim">
                    {status === 'complete' ? '✓ DELIVERED' : status === 'active' ? '▶ ACTIVE' : '○ STANDBY'}
                  </div>
                </div>
              );
            })}
          </div>

          <button
            onClick={handleTransmit}
            disabled={meshTransmitting || !dtnPacket?.packet_hex}
            className="btn-primary w-full mt-4 py-3 font-mono glow-cyan"
          >
            {meshTransmitting ? 'TRANSMITTING...' : 'TRANSMIT DTN PACKET (OFFLINE MESH)'}
          </button>
        </div>

        {/* Field Receiver Terminal */}
        <div>
          <label className="section-title">FIELD RECEIVER TERMINAL</label>
          <div className="panel p-4 rounded">
            <div className="flex items-center justify-between mb-3">
              <span className="font-mono text-xs text-text-secondary">DISCONNECTED HANDSET</span>
              <div className="flex items-center gap-2">
                <div className="w-16 h-3 bg-panel-border rounded-full overflow-hidden">
                  <div
                    className="h-full bg-green rounded-full transition-all"
                    style={{ width: `${meshReceiver.battery_level}%` }}
                  />
                </div>
                <span className="font-mono text-xs text-green">{meshReceiver.battery_level.toFixed(0)}%</span>
              </div>
            </div>

            <div className="space-y-2 text-xs font-mono">
              <div className="flex justify-between">
                <span className="text-text-dim">STATUS:</span>
                <span className={meshReceiver.status === 'ROUTE_RECEIVED' ? 'text-green' : 'text-amber'}>
                  {meshReceiver.status}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-dim">SIGNAL:</span>
                <span className="text-cyan">{meshReceiver.signal_strength} dBm</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-dim">LAST PKT:</span>
                <span className="text-text-primary">
                  {meshReceiver.last_packet
                    ? new Date(meshReceiver.last_packet.timestamp * 1000).toLocaleTimeString()
                    : 'NEVER'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-dim">ROUTE:</span>
                <span className={meshReceiver.decoded_route ? 'text-green' : 'text-text-dim'}>
                  {meshReceiver.decoded_route ? `${meshReceiver.decoded_route.length} WAYPOINTS` : 'NO ROUTE'}
                </span>
              </div>
            </div>

            {meshReceiver.decoded_route && meshReceiver.decoded_route.length > 0 && (
              <div className="mt-3 p-3 bg-space/50 rounded border border-panel-border/50 max-h-32 overflow-auto">
                <div className="font-mono text-[10px] text-text-dim mb-1">DECODED TRAJECTORY (x, y, t):</div>
                <div className="font-mono text-[10px] text-cyan">
                  {meshReceiver.decoded_route.slice(0, 10).map((wp, i) =>
                    `${i}: [${wp[0].toString().padStart(3)}, ${wp[1].toString().padStart(3)}, T${wp[2]}]`
                  ).join('\n')}
                  {meshReceiver.decoded_route.length > 10 && '\n...'}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Receiver Modal */}
      {showReceiverModal && (
        <ReceiverModal
          receiver={meshReceiver}
          onClose={() => setShowReceiverModal(false)}
        />
      )}
    </div>
  );
};

interface MetricCardProps {
  label: string;
  value: string;
  unit: string;
  color: string;
  threshold?: number;
  current?: number;
  isText?: boolean;
}

const MetricCard: React.FC<MetricCardProps> = ({
  label, value, unit, color, threshold, current, isText
}) => {
  const isWarning = threshold !== undefined && current !== undefined && current > threshold;

  return (
    <div className={`metric-card min-w-0 overflow-hidden p-2 metric-card-${color} ${isWarning ? 'border-l-crimson' : ''}`}>
      <div className="telemetry-label break-words">{label}</div>
      <div className="telemetry-value break-words text-text-primary" style={{ color: isText ? undefined : `var(--${color})`, overflowWrap: 'anywhere' }}>
        {value}
      </div>
      {unit && <div className="mt-1 break-words font-mono text-[9px] leading-tight text-text-dim">{unit}</div>}
      {threshold !== undefined && current !== undefined && (
        <div className="mt-3 h-0.5 bg-panel-border rounded-full overflow-hidden">
          <div
            className="h-full transition-all"
            style={{
              width: `${Math.min(100, (current / (threshold * 1.5)) * 100)}%`,
              backgroundColor: isWarning ? 'var(--crimson)' : `var(--${color})`
            }}
          />
        </div>
      )}
    </div>
  );
};

interface ReceiverModalProps {
  receiver: ReceiverState;
  onClose: () => void;
}

const ReceiverModal: React.FC<ReceiverModalProps> = ({ receiver, onClose }) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-space/90 backdrop-blur-sm" onClick={onClose}>
      <div className="panel w-full max-w-2xl max-h-[80vh] overflow-hidden m-4 animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className="p-4 border-b border-panel-border flex items-center justify-between">
          <h3 className="font-mono text-lg text-cyan">FIELD RECEIVER TERMINAL — OFFLINE DECODE</h3>
          <button onClick={onClose} className="btn-ghost p-1">✕</button>
        </div>

        <div className="p-4 overflow-auto">
          <div className="grid grid-cols-3 gap-4 mb-4 text-center">
            <div className="panel-border p-3 rounded">
              <div className="font-mono text-xs text-text-dim">BATTERY</div>
              <div className="font-mono text-2xl text-green">{receiver.battery_level.toFixed(0)}%</div>
            </div>
            <div className="panel-border p-3 rounded">
              <div className="font-mono text-xs text-text-dim">SIGNAL</div>
              <div className="font-mono text-2xl text-cyan">{receiver.signal_strength} dBm</div>
            </div>
            <div className="panel-border p-3 rounded">
              <div className="font-mono text-xs text-text-dim">STATUS</div>
              <div className="font-mono text-xl text-green">{receiver.status}</div>
            </div>
          </div>

          {receiver.last_packet && (
            <div className="panel-border p-3 rounded mb-4">
              <div className="font-mono text-xs text-text-dim mb-2">LAST PACKET RECEIVED</div>
              <div className="font-mono text-xs text-cyan">Size: {receiver.last_packet.packet_size} bytes</div>
              <div className="font-mono text-xs text-cyan">Checksum: 0x{receiver.last_packet.checksum.toString(16).toUpperCase().padStart(4, '0')}</div>
              <div className="font-mono text-xs text-text-dim">Time: {new Date(receiver.last_packet.timestamp * 1000).toLocaleString()}</div>
            </div>
          )}

          {receiver.decoded_route && receiver.decoded_route.length > 0 ? (
            <div className="panel-border p-3 rounded max-h-64 overflow-auto">
              <div className="font-mono text-xs text-text-dim mb-2">DECODED 4D TRAJECTORY</div>
              <div className="font-mono text-[10px] text-cyan leading-relaxed">
                {receiver.decoded_route.map((wp, i) =>
                  `${i.toString().padStart(3)}: X=${wp[0].toString().padStart(3)} Y=${wp[1].toString().padStart(3)} T=${wp[2]}`
                ).join('\n')}
              </div>
            </div>
          ) : (
            <div className="panel-border p-8 rounded text-center text-text-dim">
              No route decoded — transmit packet from Mission Control
            </div>
          )}

          <div className="mt-4 p-3 bg-space/50 rounded border border-panel-border/50">
            <div className="font-mono text-xs text-text-dim mb-1">OPERATIONAL NOTES</div>
            <ul className="font-sans text-xs text-text-secondary space-y-1 ml-4 list-disc">
              <li>Route stored in non-volatile memory</li>
              <li>Dead-reckoning navigation active</li>
              <li>Next mesh window: T+{Math.ceil((Date.now() / 60000) / 15) * 15} min</li>
              <li>Emergency beacon: ARMED</li>
            </ul>
          </div>
        </div>

        <div className="p-4 border-t border-panel-border flex justify-end">
          <button onClick={onClose} className="btn-primary">ACKNOWLEDGE</button>
        </div>
      </div>
    </div>
  );
};

export default RightTelemetryDock;
