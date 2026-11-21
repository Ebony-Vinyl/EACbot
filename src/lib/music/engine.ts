// The renderer's audio graph. Two <audio> elements alternate so a track change can
// cross-fade, and every source (Kugou, local, Jellyfin, a decoded DSF) arrives as a
// URL from the server's stream proxy, so there is exactly one code path here.
//
// The graph is: element → MediaElementSource → ten BiquadFilters → gain → analyser →
// destination. The analyser feeds the visualizer and the mascot's mouth; nothing
// else reads audio.
import { MUSIC_EQ_BAND_TYPES, MUSIC_EQ_Q, MUSIC_EQ_BANDS_HZ, type MusicEq, type MusicQuality, type MusicTrack } from "../../../shared/music.ts";

/** One decoder slot: an element and the nodes that belong to it. */
interface Voice {
  element: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  filters: BiquadFilterNode[];
  gain: GainNode;
  /** Which track this voice holds, so a stale `ended` from the other voice is ignored. */
  trackId: string | null;
}

export interface EngineEvents {
  /** The element started producing sound: the server hears `playing`. */
  onPlaying(trackId: string): void;
  onPaused(trackId: string): void;
  onBuffering(trackId: string): void;
  onEnded(trackId: string): void;
  onError(trackId: string, code: string, message: string): void;
  /** Position and duration, a few times a second while playing. */
  onProgress(positionSeconds: number, durationSeconds: number): void;
}

export interface EngineOptions {
  events: EngineEvents;
  /** The volume music drops to while speech holds the speaker, 0-100. */
  duckVolume?: number;
  crossfadeMs?: number;
}

export interface LoadRequest {
  track: MusicTrack;
  /** A URL from the server's stream proxy. */
  url: string;
  quality: MusicQuality;
  /** Where to start, in seconds; a quality change keeps the position. */
  startAt?: number;
  /** Whether to start playing as soon as the data allows. */
  autoplay: boolean;
}

export class MusicEngine {
  private context: AudioContext | null = null;
  private voices: Voice[] = [];
  private active = 0;
  private currentTrack: MusicTrack | null = null;
  private analyser: AnalyserNode | null = null;
  private masterGain: GainNode | null = null;
  private volume = 70;
  private rate = 1;
  private ducked = false;
  private readonly duckVolume: number;
  private readonly crossfadeMs: number;
  private fadeTimer: number | null = null;
  private progressTimer: number | null = null;
  private eq: MusicEq | null = null;
  /** True once the browser has refused an autoplay, so the UI can ask for a tap. */
  private needsGesture = false;

  constructor(private readonly options: EngineOptions) {
    this.duckVolume = options.duckVolume ?? 25;
    this.crossfadeMs = options.crossfadeMs ?? 0;
  }

  /** Must be called from a user gesture the first time; a browser refuses audio before one. */
  async unlock(): Promise<void> {
    this.context ??= new AudioContext();
    if (this.context.state === "suspended") await this.context.resume();
    if (!this.voices.length) this.build();
    this.needsGesture = false;
  }

  get gestureRequired(): boolean {
    return this.needsGesture;
  }

  /** The analyser the visualizer and the mascot read. */
  get analyserNode(): AnalyserNode | null {
    return this.analyser;
  }

  get audioContext(): AudioContext | null {
    return this.context;
  }

  private build(): void {
    const context = this.context;
    if (!context) return;
    this.masterGain = context.createGain();
    this.masterGain.gain.value = this.volume / 100;
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;
    this.masterGain.connect(this.analyser);
    this.analyser.connect(context.destination);

    for (let slot = 0; slot < 2; slot++) {
      const element = new Audio();
      element.preload = "auto";
      element.crossOrigin = "anonymous";
      // The element's own volume stays at 1: the graph's gain is the volume, so a
      // cross-fade and the person's volume do not fight each other.
      element.volume = 1;
      const source = context.createMediaElementSource(element);
      const filters = MUSIC_EQ_BANDS_HZ.map((frequency, index) => {
        const filter = context.createBiquadFilter();
        filter.type = MUSIC_EQ_BAND_TYPES[index] ?? "peaking";
        filter.frequency.value = frequency;
        filter.Q.value = MUSIC_EQ_Q;
        filter.gain.value = 0;
        return filter;
      });
      const gain = context.createGain();
      gain.gain.value = slot === 0 ? 1 : 0;
      let node: AudioNode = source;
      for (const filter of filters) {
        node.connect(filter);
        node = filter;
      }
      node.connect(gain);
      gain.connect(this.masterGain);
      this.wireElement(element, slot);
      this.voices.push({ element, source, filters, gain, trackId: null });
    }
  }

  private wireElement(element: HTMLAudioElement, slot: number): void {
    element.addEventListener("playing", () => {
      if (slot !== this.active) return;
      const trackId = this.voices[slot]?.trackId;
      if (!trackId) return;
      this.needsGesture = false;
      this.options.events.onPlaying(trackId);
      this.startProgress();
    });
    element.addEventListener("pause", () => {
      if (slot !== this.active) return;
      const trackId = this.voices[slot]?.trackId;
      if (trackId && !element.ended) this.options.events.onPaused(trackId);
    });
    element.addEventListener("waiting", () => {
      if (slot !== this.active) return;
      const trackId = this.voices[slot]?.trackId;
      if (trackId) this.options.events.onBuffering(trackId);
    });
    element.addEventListener("ended", () => {
      if (slot !== this.active) return;
      const trackId = this.voices[slot]?.trackId;
      if (trackId) this.options.events.onEnded(trackId);
    });
    element.addEventListener("error", () => {
      if (slot !== this.active) return;
      const trackId = this.voices[slot]?.trackId;
      const code = element.error?.code;
      const message = code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
        ? "the browser cannot decode this stream"
        : code === MediaError.MEDIA_ERR_NETWORK
        ? "the stream stopped arriving"
        : "the browser refused to play this stream";
      if (trackId) this.options.events.onError(trackId, "playback_failed", message);
    });
  }

  /** Loads a track into the idle voice and, when asked, cross-fades to it. */
  async load(request: LoadRequest): Promise<void> {
    this.context ??= new AudioContext();
    if (!this.voices.length) this.build();
    const context = this.context;
    const voices = this.voices;
    if (!context || voices.length < 2) return;

    const nextSlot = voices.length > 1 ? 1 - this.active : 0;
    const next = voices[nextSlot]!;
    const previous = voices[this.active]!;
    const sameTrack = previous.trackId === request.track.id;

    next.trackId = request.track.id;
    next.element.src = request.url;
    next.element.playbackRate = this.rate;
    next.element.load();
    if (request.startAt !== undefined && request.startAt > 0) {
      // Seek before play so the first sound is at the right place, not the start.
      const seek = () => {
        next.element.currentTime = request.startAt!;
        next.element.removeEventListener("loadedmetadata", seek);
      };
      next.element.addEventListener("loadedmetadata", seek);
    }

    const fade = sameTrack ? 0 : this.crossfadeMs;
    this.active = nextSlot;
    this.currentTrack = request.track;

    if (request.autoplay) {
      try {
        await next.element.play();
      } catch {
        // A browser without a gesture refuses play; the UI offers a tap rather than lying.
        this.needsGesture = true;
        this.options.events.onPaused(request.track.id);
        return;
      }
    }

    if (fade > 0) this.crossFade(previous, next, fade);
    else {
      next.gain.gain.value = 1;
      previous.gain.gain.value = 0;
      previous.element.pause();
    }
  }

  /** Ramps the outgoing voice down while the incoming one comes up. */
  private crossFade(from: Voice, to: Voice, ms: number): void {
    const context = this.context;
    if (!context) return;
    const now = context.currentTime;
    const seconds = ms / 1_000;
    to.gain.gain.cancelScheduledValues(now);
    to.gain.gain.setValueAtTime(0, now);
    to.gain.gain.linearRampToValueAtTime(1, now + seconds);
    from.gain.gain.cancelScheduledValues(now);
    from.gain.gain.setValueAtTime(from.gain.gain.value, now);
    from.gain.gain.linearRampToValueAtTime(0, now + seconds);
    if (this.fadeTimer !== null) window.clearTimeout(this.fadeTimer);
    this.fadeTimer = window.setTimeout(() => {
      from.element.pause();
      from.element.removeAttribute("src");
      from.trackId = null;
      this.fadeTimer = null;
    }, ms + 60);
  }

  play(): void {
    const voice = this.voices[this.active];
    if (!voice) return;
    void voice.element.play().catch(() => {
      this.needsGesture = true;
    });
  }

  pause(): void {
    for (const voice of this.voices) voice.element.pause();
  }

  seek(seconds: number): void {
    const voice = this.voices[this.active];
    if (!voice) return;
    voice.element.currentTime = Math.max(0, seconds);
  }

  setVolume(percent: number): void {
    this.volume = Math.min(Math.max(percent, 0), 100);
    this.applyGain();
  }

  /** Applies to both voices, so a cross-fade keeps the chosen speed. */
  setRate(rate: number): void {
    this.rate = Math.min(Math.max(rate, 0.5), 2);
    for (const voice of this.voices) voice.element.playbackRate = this.rate;
  }

  /** Speech took the speaker: drop to the duck volume. */
  duck(): void {
    this.ducked = true;
    this.applyGain();
  }

  unduck(): void {
    this.ducked = false;
    this.applyGain();
  }

  private applyGain(): void {
    const gain = this.masterGain;
    if (!gain) return;
    const target = (this.ducked ? Math.min(this.volume, this.duckVolume) : this.volume) / 100;
    const context = this.context;
    if (!context) {
      gain.gain.value = target;
      return;
    }
    // A short ramp rather than a jump, so a duck sounds like a dimmer, not a cut.
    gain.gain.cancelScheduledValues(context.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, context.currentTime);
    gain.gain.linearRampToValueAtTime(target, context.currentTime + 0.25);
  }

  /** Applies a ten-band curve; `enabled: false` flattens it. */
  setEq(eq: MusicEq): void {
    this.eq = eq;
    for (const voice of this.voices) {
      voice.filters.forEach((filter, index) => {
        filter.gain.value = eq.enabled ? (eq.gains[index] ?? 0) : 0;
      });
    }
  }

  get equalizer(): MusicEq | null {
    return this.eq;
  }

  get positionSeconds(): number {
    return this.voices[this.active]?.element.currentTime ?? 0;
  }

  get durationSeconds(): number {
    const duration = this.voices[this.active]?.element.duration ?? 0;
    return Number.isFinite(duration) ? duration : 0;
  }

  get currentTrackId(): string | null {
    return this.currentTrack?.id ?? null;
  }

  private startProgress(): void {
    if (this.progressTimer !== null) return;
    this.progressTimer = window.setInterval(() => {
      const voice = this.voices[this.active];
      if (!voice || voice.element.paused) return;
      const duration = Number.isFinite(voice.element.duration) ? voice.element.duration : 0;
      this.options.events.onProgress(voice.element.currentTime, duration);
    }, 250);
  }

  private stopProgress(): void {
    if (this.progressTimer !== null) window.clearInterval(this.progressTimer);
    this.progressTimer = null;
  }

  dispose(): void {
    this.stopProgress();
    if (this.fadeTimer !== null) window.clearTimeout(this.fadeTimer);
    for (const voice of this.voices) {
      voice.element.pause();
      voice.element.removeAttribute("src");
      voice.source.disconnect();
      for (const filter of voice.filters) filter.disconnect();
      voice.gain.disconnect();
    }
    this.voices = [];
    this.analyser?.disconnect();
    this.masterGain?.disconnect();
    void this.context?.close();
    this.context = null;
  }
}
