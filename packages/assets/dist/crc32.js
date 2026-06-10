// CRC32 used for .PMS map validation.
//
// This is NOT a standard CRC-32/IEEE finalized checksum. It is a faithful port
// of MapFile.pas's `crc32` helper, which OpenSoldat uses to derive TMapFile.Hash
// for client/server map-consistency checks.
//
// Characteristics (PORT: shared/MapFile.pas:110-154):
//   - Table: the standard CRC-32 *forward* (non-reflected) table generated from
//     polynomial 0x04C11DB7. Update consumes the HIGH byte of the running value
//     (`Result shr 24`) and shifts left — i.e. the big-endian / "MPEG-2" style
//     table, identical to the 256 entries in MapFile.pas:110-143.
//   - Seed: callers pass 5381 (MapFile.pas:449). There is no final XOR and no
//     bit reflection of input/output.
//   - Hashed bytes: the ENTIRE raw file buffer, from offset 0 to its full
//     length (MapFile.pas:449: `crc32(5381, @bf.Data[0], Length(bf.Data))`).
//   - Width: 32-bit unsigned (LongWord).
// PORT: shared/MapFile.pas:110-143 (CRCTable: array[0..255] of LongWord)
// Generated forward (non-reflected) from polynomial 0x04C11DB7.
function buildTable() {
    const table = new Uint32Array(256);
    const poly = 0x04c11db7;
    for (let n = 0; n < 256; n++) {
        let c = n << 24;
        for (let k = 0; k < 8; k++) {
            c = (c & 0x80000000) !== 0 ? ((c << 1) ^ poly) : (c << 1);
        }
        table[n] = c >>> 0;
    }
    return table;
}
const CRC_TABLE = buildTable();
/**
 * Update `crc` over `data[start..start+len)`.
 *
 * PORT: shared/MapFile.pas:145-154
 *   Result := CRCTable[Data^ xor ((Result shr 24) and $FF)] xor (Result shl 8)
 *
 * All arithmetic is forced unsigned 32-bit via `>>> 0`.
 */
export function crc32(crc, data, start = 0, len = data.length - start) {
    let result = crc >>> 0;
    for (let i = 0; i < len; i++) {
        const byte = data[start + i];
        if (byte === undefined) {
            // Mirror Pascal Move/FillChar: out-of-range reads contribute a zero byte.
            const idx = (result >>> 24) & 0xff;
            const entry = CRC_TABLE[idx] ?? 0;
            result = (entry ^ (result << 8)) >>> 0;
            continue;
        }
        const idx = (byte ^ ((result >>> 24) & 0xff)) & 0xff;
        const entry = CRC_TABLE[idx] ?? 0;
        result = (entry ^ (result << 8)) >>> 0;
    }
    return result >>> 0;
}
/** The seed OpenSoldat uses for map hashing. PORT: shared/MapFile.pas:449 */
export const PMS_CRC_SEED = 5381;
/** Convenience: hash a whole buffer with the .PMS seed. */
export function pmsHash(data) {
    return crc32(PMS_CRC_SEED, data);
}
//# sourceMappingURL=crc32.js.map