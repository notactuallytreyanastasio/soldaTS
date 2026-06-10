import { type PmsMap } from './pms-types';
/** Thrown when the buffer is not a valid / supported .PMS file. */
export declare class PmsParseError extends Error {
    constructor(message: string);
}
/**
 * Parse a .PMS file from a raw buffer and validate its CRC32.
 * PORT: shared/MapFile.pas:271-451 (LoadMapFile).
 */
export declare function loadPms(buffer: ArrayBuffer): PmsMap;
//# sourceMappingURL=pms-loader.d.ts.map