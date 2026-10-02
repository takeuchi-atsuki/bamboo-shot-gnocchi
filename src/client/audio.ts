let context: AudioContext | null = null;
let currentUtterance: SpeechSynthesisUtterance | null = null;
let finishUtterance: (() => void) | null = null;
let sequence = 0;

export function unlockAudio(): void {
  if (typeof AudioContext === "undefined") return;
  context ??= new AudioContext();
  if (context.state === "suspended") void context.resume();
}

export function tone(frequency = 392, duration = 0.12): void {
  if (!context || context.state !== "running") return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, context.currentTime);
  gain.gain.setValueAtTime(0.001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + duration);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + duration);
}

function pluck(frequency: number, start: number): void {
  if (!context) return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.2, start);
  gain.gain.exponentialRampToValueAtTime(0.001, start + 0.35);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.36);
}

export function shamisen(): void {
  if (!context || context.state !== "running") return;
  const start = context.currentTime;
  pluck(220, start);
  pluck(294, start + 0.18);
  pluck(196, start + 0.36);
}

export function taiko(): void {
  if (!context || context.state !== "running") return;
  const start = context.currentTime;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(160, start);
  oscillator.frequency.exponentialRampToValueAtTime(65, start + 0.22);
  gain.gain.setValueAtTime(0.35, start);
  gain.gain.exponentialRampToValueAtTime(0.001, start + 0.32);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.33);
}

function cancelUtterance(): void {
  if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  finishUtterance?.();
}

function say(text: string): Promise<void> {
  if (typeof window === "undefined" || !("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
    return Promise.resolve();
  }
  cancelUtterance();
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ja-JP";
    utterance.rate = 1.12;
    utterance.pitch = 1.12;
    utterance.voice = window.speechSynthesis.getVoices().find((voice) => voice.lang.toLowerCase().startsWith("ja")) ?? null;
    currentUtterance = utterance;
    const timeout = window.setTimeout(done, 4500);
    function done() {
      window.clearTimeout(timeout);
      if (currentUtterance === utterance) {
        currentUtterance = null;
        finishUtterance = null;
      }
      resolve();
    }
    finishUtterance = done;
    utterance.onend = done;
    utterance.onerror = done;
    window.speechSynthesis.speak(utterance);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function speak(text: string): void {
  stopSpeech();
  void say(text);
}

export function stopSpeech(): void {
  sequence += 1;
  cancelUtterance();
}

export function playIntro(): void {
  stopSpeech();
  const current = sequence;
  unlockAudio();
  taiko();
  void (async () => {
    await say("ドン。たけのこニョッキー");
    if (sequence !== current) return;
    shamisen();
    await delay(650);
    if (sequence !== current) return;
    await say("イェーイ！");
  })();
}

export function playRoundOpening(first: boolean): void {
  stopSpeech();
  const current = sequence;
  unlockAudio();
  void (async () => {
    if (first) {
      await say("さあ、それではまいりましょう");
      if (sequence !== current) return;
      shamisen();
      await delay(650);
      if (sequence !== current) return;
      await say("たけのこニョッキー");
      if (sequence !== current) return;
      taiko();
      await delay(350);
      if (sequence !== current) return;
    }
    await say("たけのこ、たけのこ、ニョッキッキ！");
  })();
}
