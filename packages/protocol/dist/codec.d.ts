import type { Message } from "./messages.js";
/** Reason a {@link decodeMessage} call failed. */
export type DecodeErrorKind = "version-mismatch" | "unknown-tag" | "truncated" | "invalid-enum" | "invalid-value";
/** Typed failure thrown by the codec. Never thrown by {@link encodeMessage}. */
export declare class DecodeError extends Error {
    readonly kind: DecodeErrorKind;
    constructor(kind: DecodeErrorKind, message: string);
}
/**
 * Serialize a {@link Message} into a framed ArrayBuffer.
 * Frame: [uint16 PROTOCOL_VERSION][uint8 kindTag][payload]. Total over every
 * valid Message; never throws {@link DecodeError}.
 */
export declare function encodeMessage(msg: Message): ArrayBuffer;
/**
 * Deserialize a framed ArrayBuffer back into a {@link Message}.
 * Throws {@link DecodeError} on version mismatch, unknown tag, truncation,
 * invalid enum, or trailing bytes.
 */
export declare function decodeMessage(buf: ArrayBuffer): Message;
//# sourceMappingURL=codec.d.ts.map