import startUrl from "./sounds/start.wav";
import stopUrl from "./sounds/stop.wav";
import discardUrl from "./sounds/discard.wav";

const startA = new Audio(startUrl);
const stopA = new Audio(stopUrl);
const discardA = new Audio(discardUrl);

let volume = 0.4;

export function setVolume(v: number) {
  volume = Math.max(0, Math.min(1, v));
}

function play(a: HTMLAudioElement) {
  try {
    a.volume = volume;
    a.currentTime = 0;
    a.play().catch(() => { /* autoplay may fail before any user gesture */ });
  } catch {}
}

export const playStart = () => play(startA);
export const playStop = () => play(stopA);
export const playDiscard = () => play(discardA);
