import { DeviceRegistration, GridCell, Env } from './types';
import { MAX_DEVICE_RECORDS } from './abuse';

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

export interface Coverage {
  grids: GridCell[];
  /**
   * Records KV holds with no expiration — written before DEVICE_RECORD_TTL_SECONDS
   * existed. KV only sets a TTL at write time, so these are immortal until
   * something rewrites them.
   */
  legacy: DeviceRegistration[];
  /** True when the read stopped at MAX_DEVICE_RECORDS, so `grids` is not the whole picture. */
  truncated: boolean;
}

/**
 * Reads every `device:` record and groups it by grid cell.
 *
 * One KV get per record, all inside the single cron invocation, so the read is
 * hard-bounded: MAX_DEVICE_RECORDS is what the registration caps allow to
 * exist, and stopping there keeps a raced or pre-cap KV state from spending the
 * Free plan's 1,000 internal subrequests. Hitting the bound is loud, and it
 * suppresses the coverage reconcile so a partial read cannot be mistaken for
 * the truth.
 */
export async function readCoverage(env: Env): Promise<Coverage> {
  const gridMap = new Map<string, DeviceRegistration[]>();
  const legacy: DeviceRegistration[] = [];
  let read = 0;
  let truncated = false;

  let cursor: string | undefined;
  do {
    const list = await env.DEVICES.list({ prefix: 'device:', cursor });
    for (const key of list.keys) {
      if (read >= MAX_DEVICE_RECORDS) {
        truncated = true;
        break;
      }
      read += 1;

      const value = await env.DEVICES.get(key.name, 'json');
      if (!value) continue;
      const device = value as DeviceRegistration;
      if (key.expiration === undefined) legacy.push(device);

      const gridKey = toGridKey(device.lat, device.lon);
      const existing = gridMap.get(gridKey) || [];
      existing.push(device);
      gridMap.set(gridKey, existing);
    }
    cursor = truncated || list.list_complete ? undefined : list.cursor;
  } while (cursor);

  return {
    grids: Array.from(gridMap.entries()).map(([gridKey, devices]) => ({ gridKey, devices })),
    legacy,
    truncated,
  };
}
