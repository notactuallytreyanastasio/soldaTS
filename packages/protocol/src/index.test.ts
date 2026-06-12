/**
 * Barrel-module tests for @soldat/protocol (src/index.ts).
 *
 * Everything downstream (client, server, netcode, arena) imports the protocol
 * through this single entry point. A dropped re-export here would break the
 * whole wire layer even with codec.ts/messages.ts individually green, so this
 * asserts (1) the runtime symbols all survive the barrel, (2) they are the
 * SAME references as the source modules, and (3) a consumer can round-trip a
 * message using only barrel imports.
 */
import { describe, it, expect } from "vitest";
import * as protocol from "./index";
import * as messagesModule from "./messages";
import * as codecModule from "./codec";
import {
  encodeMessage,
  decodeMessage,
  DecodeError,
  PROTOCOL_VERSION,
  ChatChannel,
  HandshakeResult,
  Posture,
  envelope,
  type Message,
} from "./index";

describe("@soldat/protocol barrel exports", () => {
  it("re-exports the messages module's runtime values", () => {
    expect(protocol.PROTOCOL_VERSION).toBe(2);
    expect(typeof protocol.envelope).toBe("function");
    // Enums survive as runtime objects.
    expect(protocol.ChatChannel).toBeDefined();
    expect(protocol.HandshakeResult).toBeDefined();
    expect(protocol.Posture).toBeDefined();
  });

  it("re-exports the codec module's runtime values", () => {
    expect(typeof protocol.encodeMessage).toBe("function");
    expect(typeof protocol.decodeMessage).toBe("function");
    expect(typeof protocol.DecodeError).toBe("function"); // class
  });

  it("barrel symbols are identical references to the source modules", () => {
    expect(protocol.encodeMessage).toBe(codecModule.encodeMessage);
    expect(protocol.decodeMessage).toBe(codecModule.decodeMessage);
    expect(protocol.DecodeError).toBe(codecModule.DecodeError);
    expect(protocol.PROTOCOL_VERSION).toBe(messagesModule.PROTOCOL_VERSION);
    expect(protocol.envelope).toBe(messagesModule.envelope);
    expect(protocol.ChatChannel).toBe(messagesModule.ChatChannel);
    expect(protocol.HandshakeResult).toBe(messagesModule.HandshakeResult);
    expect(protocol.Posture).toBe(messagesModule.Posture);
  });

  it("re-exports every runtime symbol of both source modules (no drops)", () => {
    for (const name of Object.keys(messagesModule)) {
      expect(name in protocol, `messages export '${name}'`).toBe(true);
    }
    for (const name of Object.keys(codecModule)) {
      expect(name in protocol, `codec export '${name}'`).toBe(true);
    }
  });

  it("envelope() stamps the protocol version", () => {
    const msg: Message = { kind: "chat", senderNum: 255, channel: ChatChannel.Command, text: "hi" };
    const env = envelope(msg);
    expect(env.version).toBe(PROTOCOL_VERSION);
    expect(env.message).toBe(msg);
  });

  it("a consumer can encode and decode a message using only barrel imports", () => {
    const msg: Message = {
      kind: "chat",
      senderNum: 1,
      channel: ChatChannel.Public,
      text: "barrel round-trip",
    };
    const decoded = decodeMessage(encodeMessage(msg));
    expect(decoded).toEqual(msg);
  });

  it("DecodeError from the barrel is what decodeMessage actually throws", () => {
    const junk = new ArrayBuffer(2); // too short for any envelope
    try {
      decodeMessage(junk);
      throw new Error("expected decodeMessage to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DecodeError);
    }
  });

  it("HandshakeResult enum carries the expected members", () => {
    // Spot-check the members the server/lobby actually branch on.
    expect(HandshakeResult.Ok).toBeDefined();
    expect(HandshakeResult.WrongVersion).toBeDefined();
    expect(HandshakeResult.Ok).not.toBe(HandshakeResult.WrongVersion);
  });
});
