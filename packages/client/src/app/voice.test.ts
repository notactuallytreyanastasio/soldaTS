// VoiceChat signaling-glue tests (goal node 522) — fake RTCPeerConnection and
// getUserMedia through the constructor seams; no real WebRTC, no DOM. What's
// under test is OUR glue: offer kickoff, perfect-negotiation glare handling,
// candidate routing, listen-only fallback, mute, dispose.
import { describe, expect, it } from 'vitest';
import { VoiceChat } from './voice';

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
  onconnectionstatechange: (() => void) | null = null;

  signalingState = 'stable';
  connectionState = 'new';
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
    void this.onnegotiationneeded?.();
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
  voice: VoiceChat;
  pc: FakePc;
  sent: { description?: { type: string }; candidate?: unknown }[];
  track: FakeTrack;
}

function rig(opts: { polite?: boolean; denyMic?: boolean } = {}): Rig {
  const pc = new FakePc();
  const sent: Rig['sent'] = [];
  const track = new FakeTrack();
  const voice = new VoiceChat({
    polite: opts.polite ?? false,
    sendSignal: (data): void => {
      sent.push(JSON.parse(data) as Rig['sent'][number]);
    },
    createPeer: (): RTCPeerConnection => pc as unknown as RTCPeerConnection,
    getUserMedia: opts.denyMic === true
      ? (): Promise<MediaStream> => Promise.reject(new Error('NotAllowedError'))
      : (): Promise<MediaStream> =>
          Promise.resolve(new FakeStream([track]) as unknown as MediaStream),
  });
  return { voice, pc, sent, track };
}

describe('VoiceChat — startup', () => {
  it('adds the mic track and sends the kickoff offer', async () => {
    const { voice, pc, sent, track } = rig();
    await voice.start();
    expect(pc.addedTracks).toContain(track);
    expect(sent.some((m) => m.description?.type === 'offer')).toBe(true);
  });

  it('falls back to listen-only when the mic is denied', async () => {
    const { voice, pc } = rig({ denyMic: true });
    await voice.start();
    expect(pc.transceivers).toEqual(['recvonly']);
    expect(voice.voiceState).toBe('mic-denied');
  });
});

describe('VoiceChat — perfect negotiation', () => {
  it('answers an incoming offer', async () => {
    const { voice, pc, sent } = rig({ polite: true, denyMic: true });
    await voice.start();
    sent.length = 0;
    await voice.onSignal(JSON.stringify({ description: { type: 'offer', sdp: 'remote' } }));
    expect(pc.remoteDescriptions.map((d) => d.type)).toContain('offer');
    expect(sent.some((m) => m.description?.type === 'answer')).toBe(true);
  });

  it('IMPOLITE peer ignores a glared offer; POLITE peer accepts it', async () => {
    const impolite = rig({ polite: false });
    await impolite.voice.start(); // local offer pending -> signalingState not stable
    await impolite.voice.onSignal(
      JSON.stringify({ description: { type: 'offer', sdp: 'glare' } }),
    );
    expect(impolite.pc.remoteDescriptions).toHaveLength(0);

    const polite = rig({ polite: true });
    await polite.voice.start();
    await polite.voice.onSignal(JSON.stringify({ description: { type: 'offer', sdp: 'glare' } }));
    expect(polite.pc.remoteDescriptions.map((d) => d.type)).toContain('offer');
  });

  it('routes remote candidates and drops malformed payloads', async () => {
    const { voice, pc } = rig({ denyMic: true });
    await voice.start();
    await voice.onSignal(JSON.stringify({ candidate: { candidate: 'c1' } }));
    expect(pc.candidates).toHaveLength(1);
    await voice.onSignal('not json at all'); // must not throw
    expect(pc.candidates).toHaveLength(1);
  });
});

describe('VoiceChat — mute + dispose', () => {
  it('toggleMute flips the mic track', async () => {
    const { voice, track } = rig();
    await voice.start();
    expect(track.enabled).toBe(true);
    expect(voice.toggleMute()).toBe(true);
    expect(track.enabled).toBe(false);
    expect(voice.toggleMute()).toBe(false);
    expect(track.enabled).toBe(true);
  });

  it('dispose stops the mic, closes the pc, and is idempotent', async () => {
    const { voice, pc, track, sent } = rig();
    await voice.start();
    voice.dispose();
    expect(track.stopped).toBe(true);
    expect(pc.closed).toBe(true);
    expect(voice.voiceState).toBe('off');
    const sentBefore = sent.length;
    voice.dispose(); // second call: no throw, no new signals
    await voice.onSignal(JSON.stringify({ candidate: { candidate: 'late' } }));
    expect(sent.length).toBe(sentBefore);
  });
});
