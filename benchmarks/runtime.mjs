import { RenderFrameBuilder } from "@haneoka/cassiopeia-plugin-our-notes";
import {
  ChartSession,
  JudgementAreaOffsetType,
  NoteDirection,
  NoteJudgementType,
  NoteLineEaseType,
  NoteOperateType,
} from "@haneoka/cassiopeia";

const TAP_COUNT = 8_000;
const HOLD_COUNT = 80;
const HOLD_POINT_COUNT = 20;
const FRAME_RATE = 120;
const FRAME_STEP_MS = 1_000 / FRAME_RATE;

function note(id, timeMs, overrides = {}) {
  return {
    id,
    tick: Math.round(timeMs * 0.96),
    timeMs,
    beat: timeMs / 500,
    pos: id % 24,
    size: 1,
    laneX: 0,
    width: 1 / 12,
    operateType: NoteOperateType.Normal,
    judgementType: NoteJudgementType.Normal,
    judgementAreaOffsetType: JudgementAreaOffsetType.Default,
    direction: NoteDirection.Normal,
    critical: false,
    judged: true,
    visible: true,
    lineIds: [],
    slideAlong: false,
    indexInLine: null,
    easeL: null,
    easeR: null,
    ...overrides,
  };
}

function fixture() {
  const notes = Array.from({ length: TAP_COUNT }, (_, id) => note(id, id * 10));
  const lines = [];
  let nextNoteId = TAP_COUNT;

  for (let lineId = 0; lineId < HOLD_COUNT; lineId++) {
    const noteIds = [];
    const startTimeMs = lineId * 700;
    for (let index = 0; index < HOLD_POINT_COUNT; index++) {
      const id = nextNoteId++;
      const isStart = index === 0;
      const isEnd = index === HOLD_POINT_COUNT - 1;
      noteIds.push(id);
      notes.push(
        note(id, startTimeMs + index * 300, {
          pos: (lineId * 3 + index) % 21,
          size: 3,
          operateType: isStart
            ? NoteOperateType.SlideBegin
            : isEnd
              ? NoteOperateType.SlideEnd
              : NoteOperateType.SlideConnection,
          judgementType: isStart
            ? NoteJudgementType.SlideBegin
            : isEnd
              ? NoteJudgementType.SlideEnd
              : NoteJudgementType.None,
          judgementAreaOffsetType: isStart
            ? JudgementAreaOffsetType.SlideBegin
            : isEnd
              ? JudgementAreaOffsetType.SlideEnd
              : JudgementAreaOffsetType.Slide,
          lineIds: [lineId],
          indexInLine: index,
          easeL: NoteLineEaseType.EaseIn,
          easeR: NoteLineEaseType.EaseOut,
        }),
      );
    }
    lines.push({ id: lineId, kind: "long", critical: false, noteIds });
  }

  notes.sort((left, right) => left.timeMs - right.timeMs || left.id - right.id);
  const durationMs = Math.max(...notes.map((item) => item.timeMs)) + 1_000;
  return {
    version: 1,
    bpmChanges: [],
    signatureChanges: [],
    timeScaleChanges: [],
    notes,
    lines,
    timeline: { skills: [], fever: [], callChanges: [] },
    durationMs,
  };
}

function run(chart) {
  const session = new ChartSession(chart, { mode: "watch" });
  const frames = Math.ceil(chart.durationMs / FRAME_STEP_MS);
  const started = process.hrtime.bigint();
  let sessionChecksum = 0;

  for (let frame = 0; frame < frames; frame++) {
    const snapshot = session.updateReusable(frame * FRAME_STEP_MS);
    sessionChecksum += snapshot.processed + snapshot.combo + snapshot.score;
  }
  const sessionEnded = process.hrtime.bigint();

  session.reset(0);
  const builder = new RenderFrameBuilder(chart);
  let frameChecksum = 0;
  for (let frame = 0; frame < frames; frame++) {
    const timeMs = frame * FRAME_STEP_MS;
    const snapshot = session.updateReusable(timeMs);
    const rendered = builder.buildReusable(timeMs, snapshot, {
      noteSpeed: 12,
      effects: false,
    });
    frameChecksum += rendered.notes.length + rendered.holds.length + rendered.simultaneousLines.length;
  }
  const ended = process.hrtime.bigint();

  return {
    frames,
    sessionNanoseconds: Number(sessionEnded - started),
    frameNanoseconds: Number(ended - sessionEnded),
    sessionChecksum,
    frameChecksum,
  };
}

function median(values) {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
}

const chart = fixture();
run(chart);
const samples = [run(chart), run(chart), run(chart)];
const frames = samples[0].frames;
const sessionNanoseconds = median(samples.map((sample) => sample.sessionNanoseconds));
const frameNanoseconds = median(samples.map((sample) => sample.frameNanoseconds));
const checksums = new Set(samples.map((sample) => `${sample.sessionChecksum}:${sample.frameChecksum}`));
if (checksums.size !== 1) throw new Error("runtime benchmark produced a non-deterministic checksum");

console.log(
  JSON.stringify(
    {
      schema: "org.haneoka.cassiopeia.runtime-benchmark",
      schemaVersion: 1,
      workload: {
        frameRate: FRAME_RATE,
        frames,
        notes: chart.notes.length,
        holds: chart.lines.length,
      },
      median: {
        sessionNanosecondsPerFrame: Math.round(sessionNanoseconds / frames),
        frameNanosecondsPerFrame: Math.round(frameNanoseconds / frames),
      },
      checksum: [...checksums][0],
    },
    null,
    2,
  ),
);
