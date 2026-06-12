// WebRTC voice for the arena (goal node 522, mesh upgrade for the shared stage
// goal node 551). Everyone on the stage — the two players AND every spectator —
// can talk. Each participant keeps one RTCPeerConnection per OTHER participant
// (a full mesh, fine for the handful of people a personal-site arena draws),
// sharing one local mic across all of them.
//
// Signaling rides the match WebSocket as `voice` frames addressed by
// participant id: a frame carries the TARGET peer on the way up and the SENDER
// on the way back (the server rewrites it). Negotiation is the WHATWG "perfect
// negotiation" pattern, with politeness decided by id comparison so each pair
// agrees who yields on glare. Audio is peer-to-peer (STUN only); a symmetric-NAT
// pair just stays silent. Deny the mic and you still HEAR everyone (recvonly).

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

export interface VoiceMeshOptions {
  /** This client's stable participant id (from the welcome's yourId). */
  myId: number;
  /** Send one signaling payload to a specific peer (over the match WS). */
  sendSignal: (peerId: number, data: string) => void;
  /** Test seam; defaults to the real RTCPeerConnection. */
  createPeer?: (config: RTCConfiguration) => RTCPeerConnection;
  /** Test seam; defaults to navigator.mediaDevices.getUserMedia. */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
}

/** One peer-to-peer link (perfect negotiation against a single other id). */
class PeerLink {
  readonly pc: RTCPeerConnection;
  private makingOffer = false;
  private ignoreOffer = false;
  private remoteAudio: HTMLAudioElement | null = null;
  private closed = false;

  constructor(
    private readonly polite: boolean,
    private readonly sendSignal: (data: string) => void,
    createPeer: (c: RTCConfiguration) => RTCPeerConnection,
    micTrack: MediaStreamTrack | null,
    micStream: MediaStream | null,
  ) {
    const pc = createPeer(ICE_CONFIG);
    this.pc = pc;

    pc.onnegotiationneeded = async (): Promise<void> => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription !== null) this.sendSignal(JSON.stringify({ description: pc.localDescription }));
      } catch (err) {
        console.warn('[voice] negotiation failed:', err);
      } finally {
        this.makingOffer = false;
      }
    };
    pc.onicecandidate = (e): void => {
      this.sendSignal(JSON.stringify({ candidate: e.candidate?.toJSON() ?? null }));
    };
    pc.ontrack = (e): void => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      this.playRemote(stream);
    };

    if (micTrack !== null && micStream !== null) {
      pc.addTrack(micTrack, micStream);
    } else {
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }
  }

  async onSignal(data: string): Promise<void> {
    if (this.closed) return;
    let msg: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const pc = this.pc;
    try {
      if (msg.description !== undefined) {
        const collision =
          msg.description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(msg.description);
        if (msg.description.type === 'offer') {
          await pc.setLocalDescription();
          if (pc.localDescription !== null) this.sendSignal(JSON.stringify({ description: pc.localDescription }));
        }
      } else if (msg.candidate !== undefined && msg.candidate !== null) {
        try {
          await pc.addIceCandidate(msg.candidate);
        } catch (err) {
          if (!this.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.warn('[voice] signaling error:', err);
    }
  }

  private playRemote(stream: MediaStream): void {
    if (this.remoteAudio === null) {
      const el = document.createElement('audio');
      el.autoplay = true;
      el.setAttribute('playsinline', '');
      document.body.appendChild(el);
      this.remoteAudio = el;
    }
    this.remoteAudio.srcObject = stream;
    void this.remoteAudio.play().catch((err) => console.warn('[voice] autoplay:', err));
  }

  close(): void {
    this.closed = true;
    try {
      this.pc.close();
    } catch {
      /* already closed */
    }
    this.remoteAudio?.remove();
    this.remoteAudio = null;
  }
}

export type VoiceMeshState = 'connecting' | 'live' | 'muted' | 'mic-denied' | 'off';

export class VoiceMesh {
  private readonly myId: number;
  private readonly sendSignal: (peerId: number, data: string) => void;
  private readonly createPeer: (c: RTCConfiguration) => RTCPeerConnection;
  private readonly requestMic: (c: MediaStreamConstraints) => Promise<MediaStream>;

  private readonly links = new Map<number, PeerLink>();
  private mic: MediaStream | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private started = false;
  private muted = false;
  private disposed = false;
  private pill: HTMLDivElement | null = null;
  private state: VoiceMeshState = 'connecting';

  constructor(opts: VoiceMeshOptions) {
    this.myId = opts.myId;
    this.sendSignal = opts.sendSignal;
    this.createPeer = opts.createPeer ?? ((c): RTCPeerConnection => new RTCPeerConnection(c));
    this.requestMic =
      opts.getUserMedia ?? ((c): Promise<MediaStream> => navigator.mediaDevices.getUserMedia(c));
  }

  get voiceState(): VoiceMeshState {
    return this.state;
  }

  /** Acquire the mic once and mount the mute pill. Idempotent. */
  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    this.mountPill();
    try {
      this.mic = await this.requestMic({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.micTrack = this.mic.getAudioTracks()[0] ?? null;
      this.setState(this.micTrack === null ? 'mic-denied' : 'live');
    } catch {
      this.setState('mic-denied'); // listen-only
    }
  }

  /**
   * Reconcile the live peer set against the roster (a list of ALL participant
   * ids including this one). New peers get a link; departed peers are dropped.
   */
  setPeers(ids: readonly number[]): void {
    if (this.disposed) return;
    const want = new Set(ids.filter((id) => id !== this.myId));
    for (const id of want) {
      if (!this.links.has(id)) this.links.set(id, this.makeLink(id));
    }
    for (const id of [...this.links.keys()]) {
      if (!want.has(id)) {
        this.links.get(id)?.close();
        this.links.delete(id);
      }
    }
  }

  /** Route one relayed signaling payload from `fromId`. */
  async onSignal(fromId: number, data: string): Promise<void> {
    if (this.disposed || fromId === this.myId) return;
    let link = this.links.get(fromId);
    if (link === undefined) {
      link = this.makeLink(fromId);
      this.links.set(fromId, link);
    }
    await link.onSignal(data);
  }

  toggleMute(): boolean {
    if (this.micTrack === null) return true;
    this.muted = !this.muted;
    this.micTrack.enabled = !this.muted;
    this.setState(this.muted ? 'muted' : 'live');
    return this.muted;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.state = 'off';
    for (const link of this.links.values()) link.close();
    this.links.clear();
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    this.mic = null;
    this.micTrack = null;
    this.pill?.remove();
    this.pill = null;
  }

  private makeLink(peerId: number): PeerLink {
    // Lower id is impolite (initiates, ignores glare); higher id is polite.
    const polite = this.myId > peerId;
    return new PeerLink(
      polite,
      (data) => this.sendSignal(peerId, data),
      this.createPeer,
      this.micTrack,
      this.mic,
    );
  }

  private mountPill(): void {
    if (this.pill !== null || typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed',
      'bottom:12px',
      'left:12px',
      'z-index:40',
      'font:12px ui-monospace,Menlo,monospace',
      'letter-spacing:0.12em',
      'background:rgba(10,12,16,0.72)',
      'color:#9aa3b2',
      'padding:5px 11px',
      'border-radius:6px',
      'cursor:pointer',
      'user-select:none',
    ].join(';');
    el.addEventListener('click', () => this.toggleMute());
    document.body.appendChild(el);
    this.pill = el;
    this.renderPill();
  }

  private setState(s: VoiceMeshState): void {
    this.state = s;
    this.renderPill();
  }

  private renderPill(): void {
    const el = this.pill;
    if (el === null) return;
    const [text, color] = {
      connecting: ['VOICE: CONNECTING…', '#9aa3b2'],
      live: ['🎤 VOICE LIVE — click to mute', '#9be07f'],
      muted: ['🔇 MUTED — click to talk', '#ffb347'],
      'mic-denied': ['VOICE: MIC OFF — listen-only', '#ffb347'],
      off: ['', ''],
    }[this.state] as [string, string];
    el.textContent = text;
    el.style.color = color;
  }
}
