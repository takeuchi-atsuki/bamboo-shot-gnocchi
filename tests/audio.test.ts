import test from "node:test";
import assert from "node:assert/strict";
import { playIntro, playRoundOpening } from "../src/client/audio.ts";

const spoken: string[] = [];
const frequencies: number[] = [];

class FakeUtterance {
  text: string;
  lang = "";
  rate = 1;
  pitch = 1;
  voice: object | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) { this.text = text; }
}

const audioParam = (track = false) => ({
  setValueAtTime(value: number) { if (track) frequencies.push(value); },
  exponentialRampToValueAtTime() {},
});

class FakeAudioContext {
  state = "running";
  currentTime = 0;
  destination = {};
  createOscillator() {
    return { type: "sine", frequency: audioParam(true), connect: (gain: object) => gain, start() {}, stop() {} };
  }
  createGain() {
    return { gain: audioParam(), connect: (destination: object) => destination };
  }
  resume() { return Promise.resolve(); }
}

Object.assign(globalThis, {
  AudioContext: FakeAudioContext,
  SpeechSynthesisUtterance: FakeUtterance,
  window: {
    SpeechSynthesisUtterance: FakeUtterance,
    speechSynthesis: {
      cancel() {},
      getVoices: () => [{ lang: "ja-JP" }],
      speak(utterance: FakeUtterance) {
        spoken.push(utterance.text);
        queueMicrotask(() => utterance.onend?.());
      },
    },
    setTimeout(callback: () => void, ms: number) {
      if (ms < 1000) queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
  },
});

async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("たけのこボタンで太鼓、掛け声、三味線、イェーイの順に鳴る", async () => {
  spoken.length = 0;
  frequencies.length = 0;
  playIntro();
  await settle();
  assert.deepEqual(spoken, ["ドン。たけのこニョッキー", "イェーイ！"]);
  assert.deepEqual(frequencies, [160, 220, 294, 196]);
});

test("初回の対戦開始で掛け声、三味線、掛け声、太鼓、ニョッキッキの順に鳴る", async () => {
  spoken.length = 0;
  frequencies.length = 0;
  playRoundOpening(true);
  await settle();
  assert.deepEqual(spoken, ["さあ、それではまいりましょう", "たけのこニョッキー", "たけのこ、たけのこ、ニョッキッキ！"]);
  assert.deepEqual(frequencies, [220, 294, 196, 160]);
});

test("次のラウンドは短いカウントダウン用の掛け声だけを鳴らす", async () => {
  spoken.length = 0;
  frequencies.length = 0;
  playRoundOpening(false);
  await settle();
  assert.deepEqual(spoken, ["たけのこ、たけのこ、ニョッキッキ！"]);
  assert.deepEqual(frequencies, []);
});
