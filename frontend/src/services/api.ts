/** ASTRA-GNC API Service */

import axios, { AxiosInstance } from 'axios';
import type {
  SimulateRequest, SimulateResponse, Mode,
  MeshTransmitRequest, MeshTransmitResponse,
  ReceiverState, TerrainPreset
} from '@/types';

const API_BASE = '/api';

class ApiService {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: API_BASE,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Let each action surface its own recoverable error in the interface.
    this.client.interceptors.response.use((response) => response);
  }

  async simulate(request: SimulateRequest): Promise<SimulateResponse> {
    const response = await this.client.post<SimulateResponse>('/simulate', request, { timeout: 30000 });
    return response.data;
  }

  async uploadDem(file: File, mode: Mode): Promise<{ success: boolean; message: string; shape: number[] }> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('mode', mode);
    const response = await this.client.post('/upload-dem', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  }

  async meshTransmit(request: MeshTransmitRequest): Promise<MeshTransmitResponse> {
    const response = await this.client.post<MeshTransmitResponse>('/mesh/transmit', request);
    return response.data;
  }

  async getReceiverState(): Promise<ReceiverState> {
    const response = await this.client.get<ReceiverState>('/mesh/receiver');
    return response.data;
  }

  async getPresets(): Promise<{ presets: TerrainPreset[] }> {
    const response = await this.client.get('/terrain/presets');
    return response.data;
  }

  async healthCheck(): Promise<{ status: string }> {
    const response = await this.client.get('/health');
    return response.data;
  }
}

export const api = new ApiService();
