// VoiceMesh glue tests (goal node 522, mesh upgrade 551) — fake
// RTCPeerConnection + getUserMedia through the constructor seams; no real
// WebRTC, no DOM audio. Under test: mic acquisition, per-peer link reconcile
// (setPeers), perfect-negotiation politeness by id, targeted signaling, mute,
// and dispose.
import { describe, expect, it } from 'vitest';
import { VoiceMesh } from './voice';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

class FakeTrack {
  enabled = true;
  stopped = false;
  readonly kind = 'audio';
  stop(): void {
    this.stopped = true;
  }
}
class FakeStream {
  constructor(readonly tracks: FakeTrack[]) {}
  getAudioTracks(): FakeTrack[] {
    return this.tracks;
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

class FakePc {
  onnegotiationneeded: (() => Promise<void> | void) | null = null;
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  signalingState = 'stable';
  localDescription: { type: string; sdp: string } | null = null;
  addedTracks: unknown[] = [];
  transceivers: string[] = [];
  remoteDescriptions: { type: string }[] = [];
  candidates: unknown[] = [];
  closed = false;

  addTrack(track: unknown): void {
    this.addedTracks.push(track);
    void this.onnegotiationneeded?.();
  }
  addTransceiver(_kind: string, opts: { direction: string }): void {
    this.transceivers.push(opts.direction);
  }
  async setLocalDescription(): Promise<void> {
    const type = this.signalingState === 'have-remote-offer' ? 'answer' : 'offer';
    this.localDescription = { type, sdp: 'x' };
    this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(d: { type: string }): Promise<void> {
    this.remoteDescriptions.push(d);
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate(c: unknown): Promise<void> {
    this.candidates.push(c);
  }
  close(): void {
    this.closed = true;
  }
}

interface Rig {
  mesh: VoiceMesh;
  pcs: Map<string, FakePc>;
  sent: { to: number; data: string }[];
  track: FakeTrack;
}

function rig(myId: number, opts: { denyMic?: boolean } = {}): Rig {
  const pcs = new Map<string, FakePc>();
  let n = 0;
  const sent: Rig['sent'] = [];
  const track = new FakeTrack();
  const mesh = new VoiceMesh({
    myId,
    sendSignal: (to, data) => sent.push({ to, data }),
    createPeer: (): RTCPeerConnection => {
      const pc = new FakePc();
      pcs.set(String(n++), pc);
      return pc as unknown as RTCPeerConnection;
    },
    getUserMedia: opts.denyMic === true
      ? (): Promise<MediaStream> => Promise.reject(new Error('NotAllowedError'))
      : (): Promise<MediaStream> =>
          Promise.resolve(new FakeStream([track]) as unknown as MediaStream),
  });
  return { mesh, pcs, sent, track };
}

describe('VoiceMesh — startup + peers', () => {
  it('acquires the mic and opens a link per other peer, sending an offer', async () => {
    const { mesh, pcs, sent, track } = rig(1);
    await mesh.start();
    mesh.setPeers([1, 2, 3]); // self + two peers
    expect(pcs.size).toBe(2);
    for (const pc of pcs.values()) expect(pc.addedTracks).toContain(track);
    await flush(); // the offers go out in the async onnegotiationneeded
    expect(sent.some((m) => m.to === 2)).toBe(true);
    expect(sent.some((m) => m.to === 3)).toBe(true);
  });

  it('tears down a link when a peer leaves the roster', async () => {
    const { mesh, pcs } = rig(1);
    await mesh.start();
    mesh.setPeers([1, 2, 3]);
    const closedBefore = [...pcs.values()].filter((p) => p.closed).length;
    expect(closedBefore).toBe(0);
    mesh.setPeers([1, 2]); // peer 3 left
    expect([...pcs.values()].filter((p) => p.closed).length).toBe(1);
  });

  it('falls back to listen-only when the mic is denied', async () => {
    const { mesh, pcs } = rig(1, { denyMic: true });
    await mesh.start();
    expect(mesh.voiceState).toBe('mic-denied');
    mesh.setPeers([1, 2]);
    expect([...pcs.values()][0]!.transceivers).toEqual(['recvonly']);
  });
});

describe('VoiceMesh — negotiation + routing', () => {
  it('answers an incoming offer from a peer (creating the link on demand)', async () => {
    const { mesh, pcs, sent } = rig(5, { denyMic: true });
    await mesh.start();
    await mesh.onSignal(2, JSON.stringify({ description: { type: 'offer', sdp: 'r' } }));
    expect(pcs.size).toBe(1);
    expect([...pcs.values()][0]!.remoteDescriptions.map((d) => d.type)).toContain('offer');
    expect(sent.some((m) => m.to === 2 && m.data.includes('answer'))).toBe(true);
  });

  it('politeness goes by id — the higher id yields on glare', async () => {
    // myId 2 vs peer 5: 2 < 5 so this side is IMPOLITE and ignores a glare offer.
    const impolite = rig(2);
    await impolite.mesh.start();
    impolite.mesh.setPeers([2, 5]); // makes a local offer (signalingState != stable)
    await impolite.mesh.onSignal(5, JSON.stringify({ description: { type: 'offer', sdp: 'g' } }));
    expect([...impolite.pcs.values()][0]!.remoteDescriptions).toHaveLength(0);

    // myId 9 vs peer 5: 9 > 5 so POLITE — accepts the glare offer.
    const polite = rig(9);
    await polite.mesh.start();
    polite.mesh.setPeers([9, 5]);
    await polite.mesh.onSignal(5, JSON.stringify({ description: { type: 'offer', sdp: 'g' } }));
    expect([...polite.pcs.values()][0]!.remoteDescriptions.map((d) => d.type)).toContain('offer');
  });

  it('drops self-addressed and malformed signals without throwing', async () => {
    const { mesh } = rig(1, { denyMic: true });
    await mesh.start();
    await expect(mesh.onSignal(1, 'whatever')).resolves.toBeUndefined(); // self
    await expect(mesh.onSignal(2, 'not json')).resolves.toBeUndefined();
  });
});

describe('VoiceMesh — mute + dispose', () => {
  it('toggleMute flips the shared mic track for every peer', async () => {
    const { mesh, track } = rig(1);
    await mesh.start();
    mesh.setPeers([1, 2, 3]);
    expect(track.enabled).toBe(true);
    expect(mesh.toggleMute()).toBe(true);
    expect(track.enabled).toBe(false);
    expect(mesh.toggleMute()).toBe(false);
    expect(track.enabled).toBe(true);
  });

  it('dispose closes every link, stops the mic, and is idempotent', async () => {
    const { mesh, pcs, track } = rig(1);
    await mesh.start();
    mesh.setPeers([1, 2, 3]);
    mesh.dispose();
    expect([...pcs.values()].every((p) => p.closed)).toBe(true);
    expect(track.stopped).toBe(true);
    expect(mesh.voiceState).toBe('off');
    expect(() => mesh.dispose()).not.toThrow();
  });
});
