import { DeviceRegistration, GridCell, Env } from './types';

// Round to ~1km grid cells to deduplicate weather API calls
const GRID_PRECISION = 2; // 0.01 degrees ~ 1.1km

export function toGridKey(lat: number, lon: number): string {
  const roundedLat = lat.toFixed(GRID_PRECISION);
  const roundedLon = lon.toFixed(GRID_PRECISION);
  return `${roundedLat},${roundedLon}`;
}

export function gridCenter(gridKey: string): { lat: number; lon: number } {
  const [lat, lon] = gridKey.split(',').map(Number);
  return { lat, lon };
}

// List all devices from KV grouped by grid cell
export async function getDevicesByGrid(env: Env): Promise<GridCell[]> {
  const gridMap = new Map<string, DeviceRegistration[]>();

  let cursor: string | undefined;
  do {
    const list = await env.DEVICES.list({ prefix: 'device:', cursor });
    for (const key of list.keys) {
      const value = await env.DEVICES.get(key.name, 'json');
      if (!value) continue;
      const device = value as DeviceRegistration;
      const gridKey = toGridKey(device.lat, device.lon);

      const existing = gridMap.get(gridKey) || [];
      existing.push(device);
      gridMap.set(gridKey, existing);
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  return Array.from(gridMap.entries()).map(([gridKey, devices]) => ({ gridKey, devices }));
}
