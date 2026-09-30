# Cassiopeia browser host

`@haneoka/cassiopeia-host-web` supplies browser-owned media time, note sounds,
and pointer input for Cassiopeia. It does not choose a renderer or a chart.

- `MediaClock` wraps an `HTMLAudioElement` and exposes the advancing music
  timestamp in integer milliseconds.
- `NoteSoundPlayer` loads the Our Notes sound manifest, queues one sound per
  judgement type per frame, and manages the looping long-note cue.
- `OurNotesInput` maps pointer gestures to half-lane coordinates and stable
  pointer identities, including trace, flick, release, and cancel events.

## Build from a clean Git workspace

The host consumes unpublished Cassiopeia and Our Notes peers. The complete
example also uses the Three renderer, so link all four repositories locally:

```sh
mkdir cassiopeia-web-workspace
cd cassiopeia-web-workspace
git clone https://github.com/haneoka-gakuen/cassiopeia.git packages/cassiopeia
git clone https://github.com/haneoka-gakuen/cassiopeia-plugin-our-notes.git packages/our-notes
git clone https://github.com/haneoka-gakuen/cassiopeia-host-web.git packages/host-web
git clone https://github.com/haneoka-gakuen/cassiopeia-renderer-three.git packages/renderer
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - packages/*
linkWorkspacePackages: true
```

Install and build:

```sh
corepack enable
corepack prepare pnpm@11.14.0 --activate
pnpm install
pnpm --filter @haneoka/cassiopeia build
pnpm --filter @haneoka/cassiopeia-plugin-our-notes build
pnpm --filter @haneoka/cassiopeia-renderer-three build
pnpm --filter @haneoka/cassiopeia-host-web check
```

Use Node 24 or newer and serve the application over a browser origin that can
load the music and sound URLs.

## Complete host loop

This example wires the host to a Cassiopeia session and a renderer. `renderer`
is an `OurNotesRenderer`, `frames` is a `RenderFrameBuilder`, and `chart` is the
normalized chart created by the Our Notes rules service.

```ts
import { CASSIOPEIA_SESSION, CassiopeiaRuntime } from "@haneoka/cassiopeia";
import { createKernelPlugin } from "@haneoka/cassiopeia/plugin";
import {
  createOurNotesAssetManifest,
  createOurNotesPlugin,
  OUR_NOTES_RULES
} from "@haneoka/cassiopeia-plugin-our-notes";
import { createWebHostPlugin, WEB_HOST } from "@haneoka/cassiopeia-host-web";
import {
  createThreeRendererPlugin,
  THREE_RENDERER
} from "@haneoka/cassiopeia-renderer-three";

const canvas = document.querySelector<HTMLCanvasElement>("#stage");
if (!canvas) throw new Error("Add <canvas id=\"stage\"></canvas>");

const runtime = new CassiopeiaRuntime([
  createKernelPlugin(),
  createOurNotesPlugin(),
  createWebHostPlugin(),
  createThreeRendererPlugin()
]);
const rules = runtime.require(OUR_NOTES_RULES);
const assets = createOurNotesAssetManifest(
  { hud: await fetch("/release/our-notes/hud.json").then((response) => response.json()) },
  {
    asset: (sourcePath) => `/release/our-notes/assets/${sourcePath}`,
    runtime: (relativePath) => `/release/our-notes/runtime/${relativePath}`
  }
);
const renderer = runtime.require(THREE_RENDERER).create({ canvas, assets });
const chart = rules.parse(await fetch("/charts/song.ss.json").then((response) => response.json()));
const session = runtime.require(CASSIOPEIA_SESSION).create(chart, { mode: "play" });
const frames = rules.createFrameBuilder(chart, { particleSeed: 7 });
const host = runtime.require(WEB_HOST);
const clock = host.createClock("/audio/song.mp3", { volume: 0.8 });
const sounds = host.createNoteSounds(assets.noteSounds);

session.on("judgement", (event) => frames.addJudgement(event, event.judgedAtMs));
const input = host.createInput(
  canvas,
  {
    tap: (point) => point.lane >= 0 && session.tap(point.lane, point.timeMs, point.pointerId),
    move: (point) => point.lane >= 0 && session.trace(point.lane, point.timeMs, point.pointerId),
    flick: (point) => point.lane >= 0 && session.flick(
      point.lane,
      { dx: point.dx, dy: point.dy },
      point.timeMs,
      point.pointerId
    ),
    release: (point) => point.lane >= 0 && session.release(point.lane, point.timeMs, point.pointerId),
    cancel: (pointerId) => session.cancel(pointerId)
  },
  {
    laneAtClientPoint: (clientX, clientY) => renderer.clientPointToLane(clientX, clientY),
    eventTime: () => clock.timeMs
  }
);

await Promise.all([renderer.load(), sounds.unlock()]);
await clock.play();
let raf = 0;
const frame = (): void => {
  const timeMs = clock.timeMs;
  const snapshot = session.update(timeMs);
  renderer.render(frames.buildReusable(timeMs, snapshot));
  sounds.setLongLineActive(snapshot.activeLongLine, 0.8);
  sounds.flush(0.8);
  raf = requestAnimationFrame(frame);
};
frame();

// On route change or component unmount:
cancelAnimationFrame(raf);
input.destroy();
clock.destroy();
sounds.dispose();
renderer.dispose();
runtime.dispose();
```

The `assets` value in the example is the application-owned
`OurNotesAssetManifest`; build it with `rules.createAssets(media, resolver)` and
pass `assets.noteSounds` to `createNoteSounds`. The host only consumes the
manifest's sound URLs. It never selects game files.

`MediaClock.timeMs` is the gameplay clock. It remains stable across stalled
frames and follows the audio element's seeking and playback-rate changes. The
input adapter's `eventTime` callback maps each pointer event to that same clock.
Keep the callback timestamp-based; frame completion time introduces judgement
drift.

## API details

`new MediaClock(source?, options?)` accepts `volume`, `playbackRate`, `loop`, and
an injected `audioElement`. Use `play()`, `pause()`, `seek(timeMs)`, and
`destroy()` for transport and teardown. `new OurNotesInput(element, handlers,
options)` requires `laneAtClientPoint(clientX, clientY)` and optionally accepts
`eventTime`, `screenDpi`, and `flickDistanceCm`. `new NoteSoundPlayer(assets)`
loads lazily through `load()` or `unlock()` and must be disposed after the last
frame.

Browser audio and vibration permissions remain browser/host policy. Call
`sounds.unlock()` from a user gesture when the browser keeps `AudioContext`
suspended. The package synthesizes note sounds; it does not synthesize browser
vibration.

## License

The package is available under [MPL-2.0](LICENSE). Browser APIs and Three.js are
separate host dependencies. Game audio, note sounds, and release media retain
their source licenses.
