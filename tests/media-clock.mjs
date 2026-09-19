import assert from "node:assert/strict";
import { MediaClock } from "../dist/index.js";

class FakeAudio extends EventTarget {
  attributes = new Map();
  paused = true;
  ended = false;
  seeking = false;
  readyState = 0;
  currentTime = 0;
  duration = 120;
  error = null;
  volume = 1;
  playbackRate = 1;
  loop = false;
  preload = "";
  crossOrigin = null;

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  set src(value) {
    this.setAttribute("src", value);
  }

  get src() {
    return this.getAttribute("src") ?? "";
  }

  load() {}

  async play() {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
}

const audio = new FakeAudio();
const clock = new MediaClock("/music.ogg", { audioElement: audio });
clock.seek(0);
assert.equal(clock.timeMs, 0);

await clock.play();
assert.equal(clock.playing, true, "play event records an active media request");
assert.equal(clock.advancing, false, "play request alone must not claim an advancing clock");

audio.readyState = 2;
audio.dispatchEvent(new Event("playing"));
assert.equal(clock.advancing, true);
audio.currentTime = 0.9;
assert.equal(clock.timeMs, 900);

audio.readyState = 1;
audio.dispatchEvent(new Event("waiting"));
assert.equal(clock.advancing, false);
audio.currentTime = 4;
assert.equal(clock.timeMs, 900, "buffering keeps the last media-derived time without wall-clock synthesis");

audio.readyState = 2;
audio.currentTime = 1.2;
audio.dispatchEvent(new Event("playing"));
assert.equal(clock.timeMs, 1200);
clock.pause();
assert.equal(clock.advancing, false);
assert.equal(clock.timeMs, 1200);

clock.seek(5_500);
assert.equal(clock.timeMs, 5_500);
assert.equal(audio.currentTime, 5.5);

console.log("Media clock: request, advancing, buffering, pause, resume, and seek checks passed");
