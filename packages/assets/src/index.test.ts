import { describe, expect, it } from 'vitest';

import * as assets from './index';
import { crc32, PMS_CRC_SEED, pmsHash } from './crc32';
import { loadPms, PmsParseError } from './pms-loader';
import {
  MAX_COLLIDERS,
  MAX_CONNECTIONS,
  MAX_POLYS,
  MAX_PROPS,
  MAX_SECTOR,
  MAX_SPAWNPOINTS,
  MAX_WAYPOINTS,
  PolyType,
  SpawnTeam,
  WaypointAction,
} from './pms-types';

// The barrel has no logic of its own; these tests pin the public API surface
// so an accidental export removal or rename is caught.

describe('@soldat/assets barrel exports', () => {
  it('re-exports the crc32 module by identity', () => {
    expect(assets.crc32).toBe(crc32);
    expect(assets.pmsHash).toBe(pmsHash);
    expect(assets.PMS_CRC_SEED).toBe(PMS_CRC_SEED);
  });

  it('re-exports the loader by identity', () => {
    expect(assets.loadPms).toBe(loadPms);
    expect(assets.PmsParseError).toBe(PmsParseError);
  });

  it('re-exports the pms-types runtime values by identity', () => {
    expect(assets.PolyType).toBe(PolyType);
    expect(assets.SpawnTeam).toBe(SpawnTeam);
    expect(assets.WaypointAction).toBe(WaypointAction);
    expect(assets.MAX_POLYS).toBe(MAX_POLYS);
    expect(assets.MAX_SECTOR).toBe(MAX_SECTOR);
    expect(assets.MAX_PROPS).toBe(MAX_PROPS);
    expect(assets.MAX_COLLIDERS).toBe(MAX_COLLIDERS);
    expect(assets.MAX_SPAWNPOINTS).toBe(MAX_SPAWNPOINTS);
    expect(assets.MAX_WAYPOINTS).toBe(MAX_WAYPOINTS);
    expect(assets.MAX_CONNECTIONS).toBe(MAX_CONNECTIONS);
  });

  it('exports work end-to-end through the barrel (pmsHash === crc32 with seed)', () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(assets.pmsHash(data)).toBe(assets.crc32(assets.PMS_CRC_SEED, data));
  });
});
