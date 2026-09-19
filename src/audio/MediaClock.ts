import { MusicSyncTimeCache } from "@haneoka/cassiopeia";
import { normalizePlaybackRate } from "@haneoka/cassiopeia";

export interface MediaClockOptions {
  volume?: number;
  playbackRate?: number;
  loop?: boolean;
  /** Test/host injection point; production defaults to a new Audio element. */
  audioElement?: HTMLAudioElement;
}

/** Audio-element backed clock. Rendering always reads the media clock, never frame deltas. */
export class MediaClock extends EventTarget {
  readonly audio: HTMLAudioElement;
  private readonly syncTime = new MusicSyncTimeCache();

  constructor(source?: string, options: MediaClockOptions = {}) {
    super();
    this.audio = options.audioElement ?? new Audio();
    this.audio.preload = "auto";
    this.audio.crossOrigin = "anonymous";
    this.audio.volume = options.volume ?? 0.8;
    this.audio.playbackRate = normalizePlaybackRate(options.playbackRate ?? 1);
    this.audio.loop = options.loop ?? false;
    if (source) this.source = source;
    for (const type of [
      "play",
      "playing",
      "pause",
      "waiting",
      "stalled",
      "canplay",
      "ended",
      "timeupdate",
      "durationchange",
      "error",
    ] as const) {
      this.audio.addEventListener(type, () => {
        if (
          (type === "pause" || type === "ended" || type === "timeupdate") &&
          Number.isFinite(this.audio.currentTime)
        ) {
          this.syncTime.read(true, this.audio.currentTime * 1000);
        }
        this.dispatchEvent(new Event(type));
      });
    }
  }

  get source(): string {
    return this.audio.getAttribute("src") ?? "";
  }

  set source(value: string) {
    if (this.audio.getAttribute("src") === value) return;
    if (value) this.audio.src = value;
    else this.audio.removeAttribute("src");
    this.syncTime.setSoundInfo(Boolean(value));
    this.audio.load();
  }

  get timeMs(): number {
    const playbackUsable = this.advancing && Number.isFinite(this.audio.currentTime);
    return this.syncTime.read(playbackUsable, this.audio.currentTime * 1000);
  }

  get durationMs(): number {
    return Number.isFinite(this.audio.duration) ? this.audio.duration * 1000 : 0;
  }

  get playing(): boolean {
    return !this.audio.paused && !this.audio.ended;
  }

  /** True only when the media clock can currently advance gameplay time. */
  get advancing(): boolean {
    return (
      !this.audio.paused &&
      !this.audio.ended &&
      !this.audio.seeking &&
      // HAVE_CURRENT_DATA is 2. Keeping the numeric threshold makes injected
      // test media usable outside a browser global environment.
      this.audio.readyState >= 2
    );
  }

  get volume(): number {
    return this.audio.volume;
  }

  set volume(value: number) {
    this.audio.volume = Math.max(0, Math.min(1, value));
  }

  get rate(): number {
    return this.audio.playbackRate;
  }

  set rate(value: number) {
    this.audio.playbackRate = normalizePlaybackRate(value, this.audio.playbackRate);
  }

  get loop(): boolean {
    return this.audio.loop;
  }

  set loop(value: boolean) {
    this.audio.loop = value;
  }

  async play(): Promise<void> {
    await this.audio.play();
  }

  pause(): void {
    this.audio.pause();
  }

  seek(timeMs: number): void {
    if (!this.source) return;
    const maximum = this.durationMs || Number.POSITIVE_INFINITY;
    const target = Math.max(0, Math.min(maximum, timeMs));
    this.audio.currentTime = target / 1000;
    this.syncTime.seek(target);
  }

  destroy(): void {
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.syncTime.setSoundInfo(false);
    this.audio.load();
  }
}
