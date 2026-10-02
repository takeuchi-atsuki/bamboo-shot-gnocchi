let context: AudioContext | null = null;
let currentUtterance: SpeechSynthesisUtterance | null = null;

export function unlockAudio(): void {
  if (typeof AudioContext !== "undefined") {
    context ??= new AudioContext();
    if (context.state === "suspended") void context.resume();
  }
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

export function speak(text: string): void {
  if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ja-JP";
  utterance.rate = 1.05;
  utterance.pitch = 1.12;
  utterance.voice = window.speechSynthesis.getVoices().find((voice) => voice.lang.toLowerCase().startsWith("ja")) ?? null;
  // Keep the utterance alive until the browser finishes speaking (notably on Safari).
  currentUtterance = utterance;
  utterance.onend = utterance.onerror = () => {
    if (currentUtterance === utterance) currentUtterance = null;
  };
  window.speechSynthesis.speak(utterance);
}

export function stopSpeech(): void {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  currentUtterance = null;
}
