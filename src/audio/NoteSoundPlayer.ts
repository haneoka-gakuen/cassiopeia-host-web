import { NoteDirection, NoteOperateType, NoteSimulateJudgement } from "@haneoka/cassiopeia";
import type { JudgementEvent } from "@haneoka/cassiopeia";

/** Structurally accepts the game manifest and smaller standalone-host manifests. */
export type NoteSoundAssetKey =
  | "good"
  | "great"
  | "perfect"
  | "flick"
  | "flickDirection"
  | "slide"
  | "just"
  | "trace"
  | `type${number}`;

export interface NoteSoundAssetLayer {
  url: string;
  gain: number;
  /** Authored waveform loop boundaries in seconds, before browser resampling. */
  loopStartSeconds?: number;
  loopEndSeconds?: number;
}

export type NoteSoundAsset = string | ReadonlyArray<NoteSoundAssetLayer>;
export type NoteSoundAssetManifest = Readonly<Partial<Record<NoteSoundAssetKey, NoteSoundAsset>>>;

export interface NoteSoundPlayerOptions {
  /** A caller-owned context is reused and remains open after this player is disposed. */
  audioContext?: AudioContext;
  /** Bind music lifecycle so pause, seek and buffering stop SE immediately. */
  mediaElement?: HTMLMediaElement;
}

interface DecodedLayer {
  buffer: AudioBuffer;
  gain: number;
  loopStartSeconds?: number;
  loopEndSeconds?: number;
}

interface PlayingLayer {
  source: AudioBufferSourceNode;
  gain: GainNode;
  layerGain: number;
}

function normalizedVolume(volume: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 0.7));
}

function layerGain(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

const FLICK_TYPES = new Set<NoteOperateType>([
  NoteOperateType.Flick,
  NoteOperateType.SlideBeginFlick,
  NoteOperateType.SlideEndFlick,
  NoteOperateType.GuideBeginFlick,
]);
const TRACE_TYPES = new Set<NoteOperateType>([
  // GetTapSeType returns LiveNoteSeType.SlideConnect (10) for operate type
  // 21; MasterLiveNoteSe maps both 9 and 10 to the same default_trace sound
  // ID.
  NoteOperateType.SlideConnection,
  NoteOperateType.Trace,
  NoteOperateType.SlideBeginTrace,
  NoteOperateType.SlideConnectionTrace,
  NoteOperateType.SlideEndTrace,
  NoteOperateType.GuideBeginTrace,
  NoteOperateType.GuideEndTrace,
]);
const NATIVE_SOUND_TYPE_ORDER: ReadonlyArray<NoteSoundAssetKey> = [
  "good",
  "great",
  "perfect",
  "flick",
  "flickDirection",
  "slide",
  "just",
  "trace",
];

/** LiveSoundPlayer.GetJudgementSeType/GetTapSeType. */
export function noteSoundForJudgement(event: Pick<JudgementEvent, "judgement" | "note">): NoteSoundAssetKey | null {
  if (
    event.judgement !== NoteSimulateJudgement.Good &&
    event.judgement !== NoteSimulateJudgement.Great &&
    event.judgement !== NoteSimulateJudgement.Perfect &&
    event.judgement !== NoteSimulateJudgement.Just
  ) {
    return null;
  }
  if (FLICK_TYPES.has(event.note.operateType)) {
    return event.note.direction === NoteDirection.Normal ? "flick" : "flickDirection";
  }
  if (TRACE_TYPES.has(event.note.operateType)) return "trace";
  if (event.judgement === NoteSimulateJudgement.Good) return "good";
  if (event.judgement === NoteSimulateJudgement.Great) return "great";
  if (event.judgement === NoteSimulateJudgement.Just) return "just";
  if (event.judgement !== NoteSimulateJudgement.Perfect) return null;
  return "perfect";
}

/**
 * PlayNoteSeFromLaneState uses a bool[type] cache while visiting notes, then
 * plays every marked type once after the visit. Keeping this queue separate
 * also makes the same-frame de-duplication testable without WebAudio.
 */
export class NoteSoundFrameQueue {
  private readonly queued = new Set<NoteSoundAssetKey>();

  queue(event: Pick<JudgementEvent, "judgement" | "note">): void {
    const key = noteSoundForJudgement(event);
    if (key) this.queued.add(key);
  }

  clear(): void {
    this.queued.clear();
  }

  take(target: NoteSoundAssetKey[] = []): NoteSoundAssetKey[] {
    target.length = 0;
    for (const key of NATIVE_SOUND_TYPE_ORDER) if (this.queued.has(key)) target.push(key);
    this.queued.clear();
    return target;
  }
}

function layersOf(asset: NoteSoundAsset): ReadonlyArray<NoteSoundAssetLayer> {
  return typeof asset === "string" ? [{ url: asset, gain: 1 }] : asset;
}

export class NoteSoundPlayer {
  private context?: AudioContext;
  private loadPromise?: Promise<void>;
  private loadAttempts = 0;
  private loaded = false;
  private readonly decodedBuffers = new Map<string, AudioBuffer>();
  private readonly buffers = new Map<NoteSoundAssetKey, ReadonlyArray<DecodedLayer>>();
  private readonly sources = new Map<AudioBufferSourceNode, GainNode>();
  private longSources: PlayingLayer[] = [];
  private readonly frameQueue = new NoteSoundFrameQueue();
  private readonly frameSoundKeys: NoteSoundAssetKey[] = [];
  private loadController?: AbortController;
  private mediaElement?: HTMLMediaElement;
  private mediaWaiting = false;
  private disposed = false;

  constructor(
    private readonly assets: NoteSoundAssetManifest,
    private readonly options: NoteSoundPlayerOptions = {},
  ) {
    this.context = options.audioContext;
    this.context?.addEventListener("statechange", this.onContextStateChange);
    this.bindMedia(options.mediaElement);
    if (typeof window !== "undefined") window.addEventListener("pagehide", this.stopAll);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  /** Every layer of each supplied cue is required; retries reuse successful URL decodes. */
  load(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.loadPromise) return this.loadPromise;
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: "interactive" });
      this.context.addEventListener("statechange", this.onContextStateChange);
    }
    const context = this.context;
    const controller = new AbortController();
    this.loadController = controller;
    const cache = this.loadAttempts++ === 0 ? "force-cache" : "reload";
    const decodedByUrl = new Map<string, Promise<AudioBuffer | null>>();
    const missing = new Set<NoteSoundAssetKey>();
    const decode = (url: string): Promise<AudioBuffer | null> => {
      const cached = this.decodedBuffers.get(url);
      if (cached) return Promise.resolve(cached);
      const existing = decodedByUrl.get(url);
      if (existing) return existing;
      const pending = (async () => {
        try {
          const response = await fetch(url, { cache, signal: controller.signal });
          if (!response.ok) return null;
          const buffer = await context.decodeAudioData(await response.arrayBuffer());
          if (this.disposed) return null;
          this.decodedBuffers.set(url, buffer);
          return buffer;
        } catch {
          return null;
        }
      })();
      decodedByUrl.set(url, pending);
      return pending;
    };
    this.loadPromise = Promise.all(
      (Object.keys(this.assets) as NoteSoundAssetKey[]).map(async (key) => {
        const asset = this.assets[key];
        if (asset === undefined) return;
        const layers = layersOf(asset);
        const decoded = await Promise.all(
          layers.map(async (layer) => {
            const buffer = await decode(layer.url);
            return buffer ? { ...layer, buffer, gain: layerGain(layer.gain) } : null;
          }),
        );
        const available = decoded.filter((layer): layer is NonNullable<typeof layer> => layer !== null);
        if (this.disposed) return;
        if (available.length > 0 && available.length === layers.length) {
          this.buffers.set(key, available);
        } else {
          this.buffers.delete(key);
          missing.add(key);
        }
      }),
    )
      .then(() => {
        if (this.disposed) return;
        if (missing.size > 0)
          throw new Error(`Note sound resources could not be loaded: ${[...missing].join(", ")}`);
        if (this.buffers.size === 0) throw new Error("No note sound resources could be loaded");
        this.loaded = true;
      })
      .catch((error: unknown) => {
        this.loadPromise = undefined;
        throw error;
      })
      .finally(() => {
        if (this.loadController === controller) this.loadController = undefined;
      });
    return this.loadPromise;
  }

  async unlock(): Promise<void> {
    const loading = this.load();
    await Promise.all([
      loading,
      this.context && this.context.state !== "running" && this.context.state !== "closed"
        ? this.context.resume()
        : undefined,
    ]);
  }

  queue(event: Pick<JudgementEvent, "judgement" | "note">): void {
    if (!this.disposed) this.frameQueue.queue(event);
  }

  clearQueue(): void {
    this.frameQueue.clear();
  }

  /** Flush once per rendered lane-state frame, matching the native bool[type] cache. */
  flush(volume: number): void {
    const keys = this.frameQueue.take(this.frameSoundKeys);
    if (!this.canPlay()) return;
    const startAt = this.context!.currentTime;
    for (const key of keys) this.playAt(key, volume, startAt);
  }

  /** Play an explicitly selected cue; judgement routing remains frame-deduplicated. */
  play(key: NoteSoundAssetKey, volume: number): void {
    if (this.canPlay()) this.playAt(key, volume, this.context!.currentTime);
  }

  private playAt(key: NoteSoundAssetKey, volume: number, startAt: number): void {
    const context = this.context!;
    for (const layer of this.buffers.get(key) ?? []) {
      const source = context.createBufferSource();
      const gain = context.createGain();
      gain.gain.value = normalizedVolume(volume) * layer.gain;
      source.buffer = layer.buffer;
      source.connect(gain).connect(context.destination);
      source.addEventListener(
        "ended",
        () => {
          source.disconnect();
          gain.disconnect();
          this.sources.delete(source);
        },
        { once: true },
      );
      this.sources.set(source, gain);
      source.start(startAt);
    }
  }

  /**
   * Keep one logical Long cue while any line is active. Unequal layers share
   * an onset, then preserve their independent authored waveform intervals.
   */
  setLongLineActive(active: boolean, volume: number): void {
    if (!active || !this.canPlay()) {
      this.stopLongLine();
      return;
    }
    const masterVolume = normalizedVolume(volume);
    if (this.longSources.length) {
      for (const node of this.longSources) node.gain.gain.value = masterVolume * node.layerGain;
      return;
    }
    const context = this.context!;
    const startAt = context.currentTime;
    this.longSources = (this.buffers.get("slide") ?? []).map((layer) => {
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = layer.buffer;
      source.loop = true;
      const start = layer.loopStartSeconds ?? 0;
      const end = layer.loopEndSeconds ?? layer.buffer.duration;
      if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start) {
        source.loopStart = start;
        source.loopEnd = Math.min(end, layer.buffer.duration);
        if (source.loopStart >= source.loopEnd) {
          source.loopStart = 0;
          source.loopEnd = layer.buffer.duration;
        }
      }
      gain.gain.value = masterVolume * layer.gain;
      source.connect(gain).connect(context.destination);
      source.start(startAt);
      return { source, gain, layerGain: layer.gain };
    });
  }

  stopLongLine(): void {
    const nodes = this.longSources;
    this.longSources = [];
    for (const { source, gain } of nodes) this.stopSource(source, gain);
  }

  /** Stop immediately, including pending frame sounds, on transport boundaries. */
  readonly stopAll = (): void => {
    this.clearQueue();
    this.stopLongLine();
    for (const [source, gain] of this.sources) this.stopSource(source, gain);
    this.sources.clear();
  };

  bindMedia(mediaElement?: HTMLMediaElement): void {
    for (const type of MEDIA_STOP_EVENTS) this.mediaElement?.removeEventListener(type, this.stopAll);
    this.mediaElement?.removeEventListener("waiting", this.onMediaWaiting);
    this.mediaElement?.removeEventListener("stalled", this.onMediaWaiting);
    this.mediaElement?.removeEventListener("playing", this.onMediaReady);
    this.mediaElement?.removeEventListener("canplay", this.onMediaReady);
    this.stopAll();
    this.mediaWaiting = false;
    this.mediaElement = this.disposed ? undefined : mediaElement;
    for (const type of MEDIA_STOP_EVENTS) this.mediaElement?.addEventListener(type, this.stopAll);
    this.mediaElement?.addEventListener("waiting", this.onMediaWaiting);
    this.mediaElement?.addEventListener("stalled", this.onMediaWaiting);
    this.mediaElement?.addEventListener("playing", this.onMediaReady);
    this.mediaElement?.addEventListener("canplay", this.onMediaReady);
  }

  private canPlay(): boolean {
    const media = this.mediaElement;
    return (
      !this.disposed &&
      this.loaded &&
      this.context?.state === "running" &&
      (typeof document === "undefined" || document.visibilityState !== "hidden") &&
      (!media ||
        (!this.mediaWaiting &&
          !media.error &&
          !media.paused &&
          !media.ended &&
          !media.seeking &&
          media.readyState >= 3))
    );
  }

  private readonly onMediaWaiting = (event: Event): void => {
    this.mediaWaiting = event.type === "waiting" || (this.mediaElement?.readyState ?? 0) < 3;
    this.stopAll();
  };

  private readonly onMediaReady = (): void => {
    this.mediaWaiting = false;
  };

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") this.stopAll();
  };

  private readonly onContextStateChange = (): void => {
    if (this.context?.state !== "running") this.stopAll();
  };

  private stopSource(source: AudioBufferSourceNode, gain: GainNode): void {
    try {
      source.stop();
    } catch {
      // The backend may already have stopped this source.
    }
    source.disconnect();
    gain.disconnect();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadController?.abort();
    this.loadController = undefined;
    this.bindMedia();
    if (typeof window !== "undefined") window.removeEventListener("pagehide", this.stopAll);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.context?.removeEventListener("statechange", this.onContextStateChange);
    this.buffers.clear();
    this.decodedBuffers.clear();
    if (!this.options.audioContext) void this.context?.close();
    this.context = undefined;
  }
}

const MEDIA_STOP_EVENTS = ["pause", "ended", "seeking", "emptied", "error"] as const;
