/**
 * Update `crc` over `data[start..start+len)`.
 *
 * PORT: shared/MapFile.pas:145-154
 *   Result := CRCTable[Data^ xor ((Result shr 24) and $FF)] xor (Result shl 8)
 *
 * All arithmetic is forced unsigned 32-bit via `>>> 0`.
 */
export declare function crc32(crc: number, data: Uint8Array, start?: number, len?: number): number;
/** The seed OpenSoldat uses for map hashing. PORT: shared/MapFile.pas:449 */
export declare const PMS_CRC_SEED = 5381;
/** Convenience: hash a whole buffer with the .PMS seed. */
export declare function pmsHash(data: Uint8Array): number;
//# sourceMappingURL=crc32.d.ts.map