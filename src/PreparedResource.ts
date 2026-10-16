export interface PresentationResourcePort {
  readJson(url: string, signal: AbortSignal): Promise<unknown>;
  resolveUrl(url: string, signal: AbortSignal): Promise<string>;
}

export const browserPresentationResources: PresentationResourcePort = {
  async readJson(url, signal) {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`presentation-resource:${response.status}`);
    return response.json();
  },
  async resolveUrl(url, signal) {
    signal.throwIfAborted();
    return url;
  },
};

/** One host owner's cancellable preload. A failed attempt can be retried. */
export class PreparedResource<T> {
  private readonly controller = new AbortController();
  private pending?: Promise<T>;
  private value?: T;
  private prepared = false;

  constructor(private readonly prepare: (signal: AbortSignal) => Promise<T>) {}

  load(owner: AbortSignal): Promise<T> {
    const signal = AbortSignal.any([owner, this.controller.signal]);
    signal.throwIfAborted();
    if (this.prepared) return Promise.resolve(this.value!);
    if (this.pending)
      return this.pending.then((value) => {
        signal.throwIfAborted();
        return value;
      });
    const pending = Promise.resolve()
      .then(() => this.prepare(signal))
      .then((value) => {
        signal.throwIfAborted();
        this.value = value;
        this.prepared = true;
        return value;
      });
    this.pending = pending;
    void pending.catch(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    return pending;
  }

  dispose(): void {
    this.controller.abort();
    this.value = undefined;
    this.prepared = false;
    this.pending = undefined;
  }
}
