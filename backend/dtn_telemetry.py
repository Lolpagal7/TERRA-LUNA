"""
ASTRA-GNC CCSDS-Inspired Delay-Tolerant Networking (DTN) Telemetry Encoder
Binary packet compression with delta-quantization + zlib for sub-500-byte transmission
"""

import struct
import zlib
import numpy as np
from typing import List, Tuple, Dict, Any, Optional
from dataclasses import dataclass
import time

from planner_4d import get_planner, PathResult


@dataclass
class DTNPacket:
    """Decoded DTN packet structure"""
    version: int
    timestamp: int
    mode: int  # 0=earth, 1=moon
    start_x: int
    start_y: int
    goal_x: int
    goal_y: int
    num_waypoints: int
    waypoints: List[Tuple[int, int, int]]  # (x, y, t)
    hazard_bounds: List[Tuple[int, int, int, int]]  # (min_x, min_y, max_x, max_y) per timestep
    soc_min: float  # For moon mode
    checksum: int


class DTNTelemetryEncoder:
    """CCSDS-inspired DTN packet encoder/decoder"""

    # Packet format constants
    VERSION = 1
    MAX_PACKET_SIZE = 500  # bytes
    HEADER_FORMAT = '<BIBBBBBBB'  # version, timestamp, mode, start/goal coordinates, waypoint count, spare
    HEADER_SIZE = struct.calcsize(HEADER_FORMAT)

    # Quantization parameters
    COORD_BITS = 7  # 0-127 for 128x128 grid
    TIME_BITS = 3   # 0-4 for 5 time steps
    HAZARD_BOUND_BITS = 7  # Same as coords

    def __init__(self):
        self.last_packet_bytes: Optional[bytes] = None
        self.last_packet_hex: str = ""
        self.transmission_log: List[Dict[str, Any]] = []

    def encode_trajectory(self, path_result: PathResult, mode: str = "earth",
                          soc_min: float = 100.0) -> Dict[str, Any]:
        """
        Encode 4D trajectory + hazard metadata into sub-500-byte DTN packet

        Compression strategy:
        1. Delta-encoding of waypoints (relative to previous)
        2. Variable-bit quantization (7 bits per coordinate)
        3. Hazard bounding boxes instead of full masks
        4. zlib compression of packed binary
        """
        start_time = time.time()

        # Extract waypoints
        waypoints = path_result.waypoints  # List of (x, y, t)
        naive_waypoints = path_result.naive_waypoints

        # Compute hazard bounding boxes per timestep (much smaller than full masks)
        hazard_bounds = self._compute_hazard_bounds(mode)

        # Build binary packet
        packet_bytes = self._pack_binary(
            waypoints, hazard_bounds, mode, soc_min
        )

        # Compress with zlib
        compressed = zlib.compress(packet_bytes, level=9)

        # Verify size constraint
        if len(compressed) > self.MAX_PACKET_SIZE:
            # Fallback: reduce precision, remove naive path
            compressed = self._pack_binary_compressed(
                waypoints, hazard_bounds, mode, soc_min
            )

        self.last_packet_bytes = compressed
        self.last_packet_hex = compressed.hex().upper()

        # Compute metrics
        raw_raster_size = 128 * 128 * 5 * 4  # 5 timesteps * 4 bytes/float = ~327KB
        # Actually for full hazard + DEM + paths ~ 1.2MB
        raw_size_estimate = 128 * 128 * 4 * 6  # ~400KB for demo

        compression_ratio = raw_size_estimate / len(compressed) if len(compressed) > 0 else 0

        result = {
            "packet_bytes": len(compressed),
            "packet_hex": self.last_packet_hex,
            "compression_ratio": compression_ratio,
            "raw_size_estimate_bytes": raw_size_estimate,
            "waypoint_count": len(waypoints),
            "hazard_bounds_count": len(hazard_bounds),
            "encoding_time_ms": (time.time() - start_time) * 1000,
            "mode": mode,
            "checksum": self._compute_checksum(compressed)
        }

        # Log transmission
        self.transmission_log.append({
            "timestamp": time.time(),
            "packet_size": len(compressed),
            "mode": mode,
            "checksum": result["checksum"]
        })

        return result

    def _compute_hazard_bounds(self, mode: str) -> List[Tuple[int, int, int, int]]:
        """Compute bounding boxes of hazard regions per timestep"""
        from hazards_4d import get_hazard_propagator

        hazards = get_hazard_propagator()
        bounds = []

        for t in range(5):
            hazard_mask = hazards.get_hazard_at_time(t)
            hazard_cells = np.argwhere(hazard_mask > 0.5)

            if len(hazard_cells) > 0:
                min_y, min_x = hazard_cells.min(axis=0)
                max_y, max_x = hazard_cells.max(axis=0)
                bounds.append((int(min_x), int(min_y), int(max_x), int(max_y)))
            else:
                bounds.append((0, 0, 0, 0))  # No hazard

        return bounds

    def _pack_binary(self, waypoints: List[Tuple[int, int, int]],
                     hazard_bounds: List[Tuple[int, int, int, int]],
                     mode: str, soc_min: float) -> bytes:
        """Pack data into binary format (uncompressed)"""
        mode_id = 0 if mode == "earth" else 1

        # Header
        timestamp = int(time.time())
        start_x, start_y, _ = waypoints[0] if waypoints else (0, 0, 0)
        goal_x, goal_y, _ = waypoints[-1] if waypoints else (0, 0, 0)
        num_waypoints = min(len(waypoints), 255)

        header = struct.pack(self.HEADER_FORMAT,
                            self.VERSION,
                            timestamp & 0xFFFFFFFF,
                            mode_id,
                            start_x,
                            start_y,
                            goal_x,
                            goal_y,
                            num_waypoints,
                            0)  # spare

        # Waypoint deltas (delta-encoded)
        wp_data = bytearray()
        prev_x, prev_y, prev_t = start_x, start_y, 0

        for i, (x, y, t) in enumerate(waypoints[:num_waypoints]):
            dx = x - prev_x
            dy = y - prev_y
            dt = t - prev_t

            # Quantize to signed 7-bit (-64 to +63)
            dx = max(-64, min(63, dx))
            dy = max(-64, min(63, dy))
            dt = max(0, min(7, dt))

            # Pack: dx(7) + dy(7) + dt(3) = 17 bits -> 3 bytes (24 bits)
            packed = ((dx & 0x7F) << 10) | ((dy & 0x7F) << 3) | (dt & 0x07)
            wp_data.extend(((packed >> 16) & 0xFF, (packed >> 8) & 0xFF, packed & 0xFF))

            prev_x, prev_y, prev_t = x, y, t

        # Hazard bounds (4 coords per timestep * 5 timesteps = 20 coords)
        hazard_data = bytearray()
        for min_x, min_y, max_x, max_y in hazard_bounds:
            for coord in [min_x, min_y, max_x, max_y]:
                hazard_data.append(coord & 0xFF)

        # SoC min (1 byte, 0-100)
        soc_byte = int(max(0, min(100, soc_min)))

        # Combine
        payload = header + wp_data + hazard_data + struct.pack('B', soc_byte)

        # Add checksum
        checksum = self._compute_checksum(payload)
        payload += struct.pack('H', checksum)

        return bytes(payload)

    def _pack_binary_compressed(self, waypoints: List[Tuple[int, int, int]],
                                 hazard_bounds: List[Tuple[int, int, int, int]],
                                 mode: str, soc_min: float) -> bytes:
        """More aggressive compression for size-constrained fallback"""
        # Use only key waypoints (every 2nd or 3rd)
        stride = max(1, len(waypoints) // 40)  # Max ~40 waypoints
        key_waypoints = waypoints[::stride]

        mode_id = 0 if mode == "earth" else 1
        timestamp = int(time.time())
        start_x, start_y, _ = waypoints[0] if waypoints else (0, 0, 0)
        goal_x, goal_y, _ = waypoints[-1] if waypoints else (0, 0, 0)
        num_waypoints = min(len(key_waypoints), 63)  # 6 bits

        # Compact header: version(3) | mode(1) | num_wp(6) | start_x(7) | start_y(7) | goal_x(7) | goal_y(7) = 38 bits ~ 5 bytes
        # Simplified: use struct
        header = struct.pack('<BBBBHHHH',
                            (self.VERSION << 5) | (mode_id << 4) | (num_waypoints >> 2),
                            ((num_waypoints & 0x3) << 6) | (start_x & 0x3F),
                            start_y & 0x7F,
                            goal_x & 0x7F,
                            goal_y & 0x7F,
                            timestamp & 0xFFFF,
                            int(soc_min * 2.55),  # 0-255
                            0)  # spare

        # Delta-encoded waypoints with 4-bit deltas (-8 to +7)
        wp_data = bytearray()
        prev_x, prev_y, prev_t = start_x, start_y, 0

        for x, y, t in key_waypoints[:num_waypoints]:
            dx = max(-8, min(7, x - prev_x))
            dy = max(-8, min(7, y - prev_y))
            dt = max(0, min(3, t - prev_t))

            # Pack into 1 byte: dx(4) | dy(4) -- dt in separate nibble if needed
            packed = ((dx & 0xF) << 4) | (dy & 0xF)
            wp_data.append(packed)
            if dt > 0:
                wp_data.append(dt << 6)  # High bits for dt

            prev_x, prev_y, prev_t = x, y, t

        # Hazard bounds: just min/max per timestep (4 bytes * 5 = 20 bytes)
        hazard_data = bytearray()
        for min_x, min_y, max_x, max_y in hazard_bounds:
            hazard_data.extend(struct.pack('BBBB', min_x, min_y, max_x, max_y))

        payload = header + wp_data + hazard_data
        checksum = self._compute_checksum(payload)
        payload += struct.pack('H', checksum)

        return zlib.compress(bytes(payload), level=9)

    def _compute_checksum(self, data: bytes) -> int:
        """CRC16-CCITT checksum"""
        crc = 0xFFFF
        for byte in data:
            crc ^= byte << 8
            for _ in range(8):
                if crc & 0x8000:
                    crc = (crc << 1) ^ 0x1021
                else:
                    crc <<= 1
                crc &= 0xFFFF
        return crc

    def decode_packet(self, packet_bytes: bytes) -> Optional[DTNPacket]:
        """Decode DTN packet from bytes"""
        try:
            # Decompress if needed
            if len(packet_bytes) < 200:  # Likely compressed
                try:
                    packet_bytes = zlib.decompress(packet_bytes)
                except:
                    pass

            if len(packet_bytes) < self.HEADER_SIZE + 2:
                return None

            # Verify checksum
            payload = packet_bytes[:-2]
            received_checksum = struct.unpack('H', packet_bytes[-2:])[0]
            if self._compute_checksum(payload) != received_checksum:
                return None

            # Parse header
            header = struct.unpack(self.HEADER_FORMAT, payload[:self.HEADER_SIZE])
            version, timestamp, mode, start_x, start_y, goal_x, goal_y, num_wp, spare = header

            # Parse waypoints
            waypoints = []
            wp_data = payload[self.HEADER_SIZE:]
            prev_x, prev_y, prev_t = start_x, start_y, 0
            offset = 0

            for _ in range(num_wp):
                if offset + 3 > len(wp_data):
                    break
                # 3 bytes per waypoint
                b1, b2, b3 = wp_data[offset], wp_data[offset+1], wp_data[offset+2]
                offset += 3

                packed = (b1 << 16) | (b2 << 8) | b3
                dx = (packed >> 10) & 0x7F
                dy = (packed >> 3) & 0x7F
                dt = packed & 0x07

                # Sign extend 7-bit
                if dx & 0x40: dx -= 128
                if dy & 0x40: dy -= 128

                x = prev_x + dx
                y = prev_y + dy
                t = prev_t + dt

                waypoints.append((x, y, t))
                prev_x, prev_y, prev_t = x, y, t

            # Parse hazard bounds
            hazard_bounds = []
            for _ in range(5):
                if offset + 4 > len(wp_data):
                    break
                min_x, min_y, max_x, max_y = wp_data[offset:offset+4]
                offset += 4
                hazard_bounds.append((min_x, min_y, max_x, max_y))

            soc_min = wp_data[offset] / 2.55 if offset < len(wp_data) else 100.0

            return DTNPacket(
                version=version,
                timestamp=timestamp,
                mode=mode,
                start_x=start_x,
                start_y=start_y,
                goal_x=goal_x,
                goal_y=goal_y,
                num_waypoints=num_wp,
                waypoints=waypoints,
                hazard_bounds=hazard_bounds,
                soc_min=soc_min,
                checksum=received_checksum
            )

        except Exception as e:
            print(f"Decode error: {e}")
            return None

    def get_transmission_status(self) -> Dict[str, Any]:
        """Get current transmission status for UI"""
        return {
            "last_packet_size": len(self.last_packet_bytes) if self.last_packet_bytes else 0,
            "last_packet_hex": self.last_packet_hex,
            "transmission_count": len(self.transmission_log),
            "last_transmission": self.transmission_log[-1] if self.transmission_log else None,
            "max_packet_size": self.MAX_PACKET_SIZE,
            "compression_achieved": len(self.last_packet_bytes) < self.MAX_PACKET_SIZE if self.last_packet_bytes else False
        }


# Singleton
dtn_encoder = DTNTelemetryEncoder()


def get_dtn_encoder() -> DTNTelemetryEncoder:
    return dtn_encoder
