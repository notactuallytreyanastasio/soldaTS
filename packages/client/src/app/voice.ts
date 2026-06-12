// WebRTC voice chat between the two HUMANS of an online match (goal node 522).
//
// Transport: the match's existing WebSocket relays opaque `voice` protocol
// frames (SDP descriptions + ICE candidates) VERBATIM to the opposite player
// — see packages/server/src/match.ts. The audio itself never touches the game
// server: it flows peer-to-peer over an RTCPeerConnection (STUN only, no
// TURN — a symmetric-NAT pair stays silent rather than relaying through us).
//
// Negotiation is the WHATWG "perfect negotiation" pattern: the POLITE peer
// (slot 2 / blue) rolls back on offer glare, the IMPOLITE peer (slot 1 / red)
// ignores the collision. Mic policy is OPEN MIC once getUserMedia is granted,
// with a click-to-mute pill (product decision with the user — not push-to-
// talk). A player who denies the mic still HEARS the opponent (recvonly).

export type VoiceState =
  | 'connecting' // pc negotiating / ICE gathering
  | 'live' // connected, mic transmitting
  | 'muted' // connected, mic muted by the player
  | 'mic-denied' // connected or connecting, but listen-only (no mic permission)
  | 'failed' // ICE failed (likely symmetric NAT) — match plays on, silent
  | 'off'; // disposed

/** Signaling payload shape carried inside the `voice` frame's JSON string. */
interface VoiceSignal {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit | null;
}

export interface VoiceChatOptions {
  /** Perfect-negotiation role: slot 2 (blue) is the polite peer. */
  polite: boolean;
  /** Send one opaque signaling string to the opposite player (via the WS). */
  sendSignal: (data: string) => void;
  /** Injection seam for tests; defaults to the real RTCPeerConnection. */
  createPeer?: (config: RTCConfiguration) => RTCPeerConnection;
  /** Injection seam for tests; defaults to navigator.mediaDevices. */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
}

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

export class VoiceChat {
  private readonly polite: boolean;
  private readonly sendSignal: (data: string) => void;
  private readonly createPeer: (config: RTCConfiguration) => RTCPeerConnection;
  private readonly requestMic: (c: MediaStreamConstraints) => Promise<MediaStream>;

  private pc: RTCPeerConnection | null = null;
  private mic: MediaStream | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private pill: HTMLDivElement | null = null;

  private state: VoiceState = 'connecting';
  private muted = false;
  private disposed = false;

  // Perfect-negotiation bookkeeping.
  private makingOffer = false;
  private ignoreOffer = false;

  constructor(opts: VoiceChatOptions) {
    this.polite = opts.polite;
    this.sendSignal = opts.sendSignal;
    this.createPeer = opts.createPeer ?? ((config): RTCPeerConnection => new RTCPeerConnection(config));
    this.requestMic =
      opts.getUserMedia ?? ((c): Promise<MediaStream> => navigator.mediaDevices.getUserMedia(c));
  }

  /** Current UI state (exposed for tests). */
  get voiceState(): VoiceState {
    return this.state;
  }

  /**
   * Ask for the mic and start negotiating. Safe to call exactly once, right
   * after the welcome (both players know their slot, the relay is live).
   */
  async start(): Promise<void> {
    if (this.disposed) return;
    this.mountPill();

    const pc = this.createPeer(ICE_CONFIG);
    this.pc = pc;

    pc.onnegotiationneeded = async (): Promise<void> => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription !== null) this.signal({ description: pc.localDescription });
      } catch (err) {
        console.warn('[voice] negotiation failed:', err);
      } finally {
        this.makingOffer = false;
      }
    };

    pc.onicecandidate = (e): void => {
      this.signal({ candidate: e.candidate?.toJSON() ?? null });
    };

    pc.ontrack = (e): void => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      this.playRemote(stream);
    };

    pc.onconnectionstatechange = (): void => {
      if (this.disposed) return;
      switch (pc.connectionState) {
        case 'connected':
          this.setState(this.micTrack === null ? 'mic-denied' : this.muted ? 'muted' : 'live');
          break;
        case 'failed':
          this.setState('failed');
          break;
        case 'connecting':
        case 'new':
          if (this.state !== 'mic-denied') this.setState('connecting');
          break;
        default:
          break; // 'disconnected'/'closed' transients keep the last state
      }
    };

    // Open mic (echoCancellation keeps the opponent's audio out of the
    // uplink; both players are typically on speakers next to gunfire).
    try {
      this.mic = await this.requestMic({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const track = this.mic.getAudioTracks()[0] ?? null;
      this.micTrack = track;
      if (track !== null) {
        pc.addTrack(track, this.mic);
      } else {
        pc.addTransceiver('audio', { direction: 'recvonly' });
        this.setState('mic-denied');
      }
    } catch {
      // Denied / no device: still negotiate a downlink so this player can
      // HEAR the opponent — and the pill says why they can't talk.
      pc.addTransceiver('audio', { direction: 'recvonly' });
      this.setState('mic-denied');
    }
  }

  /** Route one relayed signaling payload from the opposite player. */
  async onSignal(data: string): Promise<void> {
    const pc = this.pc;
    if (pc === null || this.disposed) return;
    let msg: VoiceSignal;
    try {
      msg = JSON.parse(data) as VoiceSignal;
    } catch {
      return; // malformed payloads are dropped, never fatal
    }

    try {
      if (msg.description !== undefined) {
        const offerCollision =
          msg.description.type === 'offer' &&
          (this.makingOffer || pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && offerCollision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(msg.description);
        if (msg.description.type === 'offer') {
          await pc.setLocalDescription();
          if (pc.localDescription !== null) this.signal({ description: pc.localDescription });
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

  /** Flip the mic. Returns the new muted flag (no-op without a mic). */
  toggleMute(): boolean {
    if (this.micTrack === null) return true;
    this.muted = !this.muted;
    this.micTrack.enabled = !this.muted;
    if (this.state === 'live' || this.state === 'muted') {
      this.setState(this.muted ? 'muted' : 'live');
    }
    return this.muted;
  }

  /** Tear everything down (match over / connection lost). Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.setState('off');
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    this.mic = null;
    this.micTrack = null;
    this.pc?.close();
    this.pc = null;
    this.remoteAudio?.remove();
    this.remoteAudio = null;
    this.pill?.remove();
    this.pill = null;
  }

  // --- internals -------------------------------------------------------------

  private signal(msg: VoiceSignal): void {
    if (this.disposed) return;
    this.sendSignal(JSON.stringify(msg));
  }

  private playRemote(stream: MediaStream): void {
    if (this.remoteAudio === null) {
      const el = document.createElement('audio');
      el.autoplay = true;
      // iOS: route through the media element inline, not fullscreen.
      el.setAttribute('playsinline', '');
      document.body.appendChild(el);
      this.remoteAudio = el;
    }
    this.remoteAudio.srcObject = stream;
    // The brain-picker click earlier satisfies the autoplay gesture rule, but
    // play() can still reject on some browsers — surface it, don't crash.
    void this.remoteAudio.play().catch((err) => console.warn('[voice] autoplay:', err));
  }

  private setState(s: VoiceState): void {
    this.state = s;
    this.renderPill();
  }

  /** The clickable status pill, styled to match the team banner. */
  private mountPill(): void {
    if (this.pill !== null || typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed',
      'bottom:12px',
      'left:12px',
      'z-index:30',
      'font:12px ui-monospace,Menlo,monospace',
      'letter-spacing:0.14em',
      'background:rgba(10,12,16,0.65)',
      'color:#9aa3b2',
      'padding:4px 10px',
      'border-radius:6px',
      'cursor:pointer',
      'user-select:none',
    ].join(';');
    el.addEventListener('click', () => this.toggleMute());
    document.body.appendChild(el);
    this.pill = el;
    this.renderPill();
  }

  private renderPill(): void {
    const el = this.pill;
    if (el === null) return;
    const [text, color] = {
      connecting: ['VOICE: CONNECTING…', '#9aa3b2'],
      live: ['🎤 VOICE LIVE — click to mute', '#9be07f'],
      muted: ['🔇 MUTED — click to talk', '#ffb347'],
      'mic-denied': ['VOICE: MIC BLOCKED — listen-only', '#ffb347'],
      failed: ['VOICE: UNAVAILABLE (NAT)', '#9aa3b2'],
      off: ['', ''],
    }[this.state] as [string, string];
    if (this.state === 'off') {
      el.remove();
      this.pill = null;
      return;
    }
    el.textContent = text;
    el.style.color = color;
  }
}
