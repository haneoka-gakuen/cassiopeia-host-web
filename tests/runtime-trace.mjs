import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ASSIST_AREA_OFFSET_TABLES,
  ASSIST_TIMING_TABLES,
  ChartSession,
  judge,
  JudgeTiming,
  JudgementAreaOffsetType,
  MusicTimeAnchor,
  MusicSyncTimeCache,
  nativeJudgementAreaOffsetX,
  normalizeEventRealtimeMs,
  normalizePlaybackRate,
  NoteJudgementType,
  NoteSimulateJudgement,
} from "@haneoka/cassiopeia";
import { OurNotesInput } from "../dist/index.js";
import { RenderFrameBuilder } from "@haneoka/cassiopeia-plugin-our-notes";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = join(root, "fixtures", "runtime");
const capture = process.argv.includes("--capture");
const requested = process.argv.slice(2).filter((argument) => argument !== "--capture");

assert.deepStrictEqual(
  {
    None: NoteSimulateJudgement.None,
    Wait: NoteSimulateJudgement.Wait,
    Miss: NoteSimulateJudgement.Miss,
    Bad: NoteSimulateJudgement.Bad,
    Good: NoteSimulateJudgement.Good,
    Great: NoteSimulateJudgement.Great,
    Perfect: NoteSimulateJudgement.Perfect,
    Just: NoteSimulateJudgement.Just,
    Pass: NoteSimulateJudgement.Pass,
  },
  { None: -1, Wait: 0, Miss: 1, Bad: 2, Good: 3, Great: 4, Perfect: 5, Just: 6, Pass: 7 },
  "NoteSimulateJudgement numeric contract changed",
);

assert.deepStrictEqual(
  ASSIST_TIMING_TABLES.map((table) => Object.values(table).reduce((count, windows) => count + windows.length, 0)),
  [39, 39, 39, 39, 39, 39],
  "Assist timing profile is incomplete",
);
assert.deepStrictEqual(
  ASSIST_AREA_OFFSET_TABLES.map((table) => Object.keys(table).length),
  [9, 9, 9, 9, 9, 9],
  "Assist hit-area profile is incomplete",
);
assert.deepStrictEqual(judge(NoteJudgementType.Normal, 130, 0), {
  judgement: NoteSimulateJudgement.Miss,
  timing: JudgeTiming.Late,
});
assert.deepStrictEqual(judge(NoteJudgementType.Normal, 130, 5), {
  judgement: NoteSimulateJudgement.Bad,
  timing: JudgeTiming.Late,
});
assert.deepStrictEqual(
  judge(NoteJudgementType.SlideBegin, 130, 5),
  judge(NoteJudgementType.SlideBegin, 130, 0),
  "Level-five SlideBegin keeps its dedicated fallback profile",
);
assert.equal(nativeJudgementAreaOffsetX(JudgementAreaOffsetType.Default, 4, 0), 1);
assert.equal(nativeJudgementAreaOffsetX(JudgementAreaOffsetType.Default, 4, 5), 1.5);

const rateAnchor = new MusicTimeAnchor();
rateAnchor.sample(-0.001, 100.999, 2);
assert.equal(rateAnchor.timeAt(99.999, 0), -3, "Negative pre-roll uses floor quantization at 2x");
assert.equal(rateAnchor.timeAt(101.001, 0), 1, "Realtime deltas follow the active playback rate");
assert.equal(normalizePlaybackRate(Number.NaN), 1);
assert.equal(normalizePlaybackRate(0), 1);
assert.equal(normalizePlaybackRate(0.1), 0.25);
assert.equal(normalizePlaybackRate(8), 4);

function normalizeJudgement(event) {
  return {
    noteId: event.note.id,
    judgement: event.judgement,
    timing: event.timing,
    diffMs: event.diffMs,
    judgedAtMs: event.judgedAtMs,
    combo: event.combo,
    maxCombo: event.maxCombo,
    score: event.score,
    scoreDelta: event.scoreDelta,
    life: event.life,
  };
}

function normalizeSnapshot(snapshot) {
  return {
    timeMs: snapshot.timeMs,
    durationMs: snapshot.durationMs,
    activeLongLine: snapshot.activeLongLine,
    combo: snapshot.combo,
    fullCombo: snapshot.fullCombo ?? null,
    allPerfect: snapshot.allPerfect ?? null,
    perfectCombo: snapshot.perfectCombo,
    maxCombo: snapshot.maxCombo,
    score: snapshot.score,
    life: snapshot.life,
    processed: snapshot.processed,
    total: snapshot.total,
    lastJudgementNoteId: snapshot.lastJudgement?.note.id ?? null,
    lastSkillIndex: snapshot.lastSkill?.index ?? null,
    callChangeIndex: snapshot.callChange?.index ?? null,
    feverState: snapshot.feverState,
    feverSectionIndex: snapshot.feverSection?.index ?? null,
  };
}

function pointerExitEvents(type) {
  const listeners = new Map();
  const callbacks = [];
  const element = {
    style: { touchAction: "auto" },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    getBoundingClientRect() {
      return { left: 0, top: 0 };
    },
    setPointerCapture() {},
  };
  const windowStub = { addEventListener() {}, removeEventListener() {} };
  const documentStub = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  const hadWindow = Object.hasOwn(globalThis, "window");
  const hadDocument = Object.hasOwn(globalThis, "document");
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = windowStub;
  globalThis.document = documentStub;
  let input;
  try {
    input = new OurNotesInput(
      element,
      {
        tap: (point) => callbacks.push({ type: "tap", timeMs: point.timeMs }),
        move: (point) => callbacks.push({ type: "move", timeMs: point.timeMs }),
        release: (point) => callbacks.push({ type: "release", timeMs: point.timeMs, x: point.x, lane: point.lane }),
        flick: (point) => callbacks.push({ type: "flick", timeMs: point.timeMs }),
        cancel: (pointerId) => callbacks.push({ type: "cancel", pointerId }),
      },
      {
        eventTime: (event) => event.timeStamp,
        laneAtClientPoint: (clientX) => clientX / 10,
        screenDpi: 96,
        flickDistanceCm: 0.1,
      },
    );
    const dispatch = (type, clientX, timeStamp) => {
      listeners.get(type)?.({
        type,
        pointerId: 7,
        pointerType: "touch",
        clientX,
        clientY: 0,
        timeStamp,
        cancelable: true,
        preventDefault() {},
      });
    };
    dispatch("pointerdown", 0, 10);
    // This displacement exceeds the flick threshold, separating Ended's final
    // flick sample from Canceled's release-only path.
    dispatch(type, 100, 11);
  } finally {
    input?.destroy();
    if (hadWindow) globalThis.window = previousWindow;
    else Reflect.deleteProperty(globalThis, "window");
    if (hadDocument) globalThis.document = previousDocument;
    else Reflect.deleteProperty(globalThis, "document");
  }
  return callbacks;
}

function listen(session, trace) {
  session.on("judgement", (event) => trace.events.push({ type: "judgement", ...normalizeJudgement(event) }));
  session.on("skill", (event) =>
    trace.events.push({ type: "skill", index: event.index, tick: event.tick, timeMs: event.timeMs }),
  );
  session.on("fever", (event) =>
    trace.events.push({ type: "fever", sectionIndex: event.section.index, state: event.state, timeMs: event.timeMs }),
  );
  session.on("callChange", (event) =>
    trace.events.push({
      type: "callChange",
      index: event.index,
      tick: event.tick,
      timeMs: event.timeMs,
      rhythms: [...event.rhythms],
    }),
  );
  session.on("update", () => trace.events.push({ type: "update" }));
  session.on("reset", () => trace.events.push({ type: "reset" }));
}

function perform(session, action, trace) {
  switch (action.op) {
    case "update":
      session.update(action.timeMs);
      break;
    case "finish":
      session.finish(action.timeMs);
      break;
    case "tap":
      session.tap(action.lane, action.timeMs, action.pointerId);
      break;
    case "flick":
      session.flick(action.lane, action.vector, action.timeMs, action.pointerId);
      break;
    case "release":
      session.release(action.lane, action.timeMs, action.pointerId);
      break;
    case "trace":
      session.trace(action.lane, action.timeMs, action.pointerId);
      break;
    case "simulate": {
      const note = session.chart.notes.find((candidate) => candidate.id === action.noteId);
      assert.ok(note, `Runtime trace references unknown note ${String(action.noteId)}`);
      const apply = Reflect.get(session, "apply");
      assert.equal(typeof apply, "function", "ChartSession test hook apply must remain callable");
      assert.equal(apply.length, 4, "ChartSession test hook apply signature changed");
      Reflect.apply(apply, session, [
        note,
        action.judgement,
        action.timing ?? 0,
        action.diffMs ?? 0,
        action.timeMs ?? note.timeMs,
      ]);
      break;
    }
    case "clockSample":
      trace.clock.sample(action.musicTimeMs, action.realtimeMs, action.playbackRate);
      break;
    case "clockTime":
      trace.events.push({
        type: "clockTime",
        timeMs: trace.clock.timeAt(action.realtimeMs, action.fallbackMusicTimeMs),
      });
      break;
    case "normalizeRealtime":
      trace.events.push({
        type: "normalizedRealtime",
        realtimeMs: normalizeEventRealtimeMs(action.timeStamp, action.currentRealtimeMs, action.timeOriginMs),
      });
      break;
    case "cancelInput":
      trace.events.push(...pointerExitEvents("pointercancel").map((event) => ({ type: "input", ...event })));
      break;
    case "endInput":
      trace.events.push(...pointerExitEvents("pointerup").map((event) => ({ type: "input", ...event })));
      break;
    case "syncSoundInfo":
      trace.syncTime.setSoundInfo(action.available);
      break;
    case "syncRead":
      trace.events.push({
        type: "syncTime",
        timeMs: trace.syncTime.read(action.playbackUsable, action.sampledTimeMs),
      });
      break;
    case "syncSeek":
      trace.events.push({ type: "syncTime", timeMs: trace.syncTime.seek(action.timeMs) });
      break;
    case "seek":
      session.reset(action.timeMs);
      break;
    case "reset":
      session.reset(action.timeMs ?? 0);
      break;
    case "setOffset":
      session.setOffset(action.milliseconds);
      break;
    case "cancel":
      session.cancel(action.pointerId);
      break;
    default:
      throw new TypeError(`Unsupported runtime trace action: ${String(action.op)}`);
  }
}

function validateFixture(fixture, path) {
  assert.equal(fixture.format, "RuntimeTraceV1", `${path}: unsupported format`);
  assert.equal(fixture.version, 1, `${path}: unsupported version`);
  assert.ok(Array.isArray(fixture.cases) && fixture.cases.length > 0, `${path}: cases must be a non-empty array`);
  const ids = new Set();
  for (const testCase of fixture.cases) {
    assert.equal(typeof testCase.id, "string", `${path}: every case needs an id`);
    assert.ok(!ids.has(testCase.id), `${path}: duplicate case id ${testCase.id}`);
    ids.add(testCase.id);
    assert.ok(testCase.chart && typeof testCase.chart === "object", `${path}#${testCase.id}: chart is required`);
    assert.ok(Array.isArray(testCase.steps) && testCase.steps.length > 0, `${path}#${testCase.id}: steps are required`);
  }
}

async function fixturePaths() {
  if (requested.length) return requested.map((path) => resolve(root, path));
  return (await readdir(fixtureDirectory))
    .filter((name) => name.endsWith(".json") && !name.endsWith(".schema.json"))
    .sort()
    .map((name) => join(fixtureDirectory, name));
}

async function verifyConcurrentHudResults() {
  const fixture = JSON.parse(await readFile(join(fixtureDirectory, "session-boundaries.runtime-trace.json"), "utf8"));
  const chart = structuredClone(fixture.cases[0].chart);
  chart.notes = chart.notes.slice(0, 2);
  chart.notes[0].timeMs = 1000;
  chart.notes[0].pos = 0;
  chart.notes[0].size = 4;
  chart.notes[1].timeMs = 1000;
  chart.notes[1].pos = 20;
  chart.notes[1].size = 4;
  chart.durationMs = 2000;
  const session = new ChartSession(chart, { mode: "play" });
  const builder = new RenderFrameBuilder(chart, { particleSeed: 1 });
  session.on("judgement", (event) => builder.addJudgement(event, 1000));
  assert.ok(session.tap(2, 1000, 1));
  assert.ok(session.tap(22, 1000, 2));
  const frame = builder.build(1000, session.snapshot(), { judgeResultPosition: "lane" });
  assert.deepStrictEqual(
    frame.hud?.judgements?.map(({ id, laneCenter, judgement }) => ({ id, laneCenter, judgement })),
    [
      { id: 0, laneCenter: 2, judgement: "just" },
      { id: 1, laneCenter: 22, judgement: "just" },
    ],
    "A simultaneous chord must retain one HUD result per lane slot",
  );
  assert.equal(builder.build(1300, session.snapshot()).hud?.judgements?.length, 0);
}

await verifyConcurrentHudResults();

let caseCount = 0;
let stepCount = 0;
for (const path of await fixturePaths()) {
  const fixture = JSON.parse(await readFile(path, "utf8"));
  validateFixture(fixture, path);
  const capturedCases = [];
  for (const testCase of fixture.cases) {
    const session = new ChartSession(testCase.chart, { mode: testCase.mode, ...testCase.options });
    const trace = { events: [], clock: new MusicTimeAnchor(), syncTime: new MusicSyncTimeCache() };
    listen(session, trace);
    const capturedSteps = [];
    for (const [index, step] of testCase.steps.entries()) {
      trace.events.length = 0;
      perform(session, step.action, trace);
      const actual = { events: [...trace.events], snapshot: normalizeSnapshot(session.snapshot()) };
      const location = `${path}#${testCase.id}/steps/${index}${step.label ? ` (${step.label})` : ""}`;
      if (!capture) assert.deepStrictEqual(actual, step.expect, location);
      capturedSteps.push({ ...step, expect: actual });
      stepCount++;
    }
    capturedCases.push({ ...testCase, steps: capturedSteps });
    caseCount++;
  }
  if (capture) process.stdout.write(`${JSON.stringify({ ...fixture, cases: capturedCases }, null, 2)}\n`);
}

if (!capture) console.log(`RuntimeTraceV1: ${caseCount} cases, ${stepCount} steps passed.`);
