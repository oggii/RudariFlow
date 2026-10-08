// Questions that two parts of the window ask the backend at its start:
// asked once, and each part is given the same answer.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** How long the start waits for the backend's answers before the window
 *  goes on with what it has. Every question of the start answers at once in
 *  the backend (they return plain values); one that still does not answer
 *  must not leave Home on "Getting ready…" for ever. The same five seconds
 *  the setup gives the graphics cards (src/home.ts). An answer that comes
 *  later still lands. */
export const START_WAIT_MS = 5000;

/** Over once the start has waited that long: one clock for every part that
 *  waits for the start's answers (the status, Home, the Meetings page). */
export const startWaitOver = new Promise<void>((over) => window.setTimeout(over, START_WAIT_MS));

const asked = new Map<string, Promise<unknown>>();

/** The answer to `cmd`, asked once however many ask for it. For what does
 *  not change while the window is open (the graphics cards: looking at them
 *  probes CUDA and Vulkan and can take seconds). */
export function askOnce<A>(cmd: string): Promise<A> {
  let answer = asked.get(cmd);
  if (!answer) {
    answer = invoke<A>(cmd);
    asked.set(cmd, answer);
  }
  return answer as Promise<A>;
}

/** The start's answer to a question about a state that the backend also
 *  reports as an event. */
export interface StartState<A, E> {
  answer: A;
  /** What `event` said since the question was sent, as it stands when this
   *  is called; null: nothing. It is newer than `answer`. Someone who asks
   *  late (after wiring listeners of their own) may have missed it. */
  later(): { payload: E } | null;
}

const states = new Map<string, Promise<StartState<unknown, unknown>>>();

/** The state `cmd` answers, asked once at the start, with what `event` has
 *  said since. The event is listened for from before the question is sent
 *  (the two go out in that order, without waiting for the first: a round
 *  trip more would hold the start up). A part that has a listener of its
 *  own still lets that one win: an event it heard itself is the newest word. */
export function stateOnce<A, E>(cmd: string, event: string): Promise<StartState<A, E>> {
  let state = states.get(cmd);
  if (!state) {
    let said: { payload: E } | null = null;
    listen<E>(event, (e) => (said = { payload: e.payload })).catch((err) => console.error(`listening for ${event} failed:`, err));
    state = invoke<A>(cmd).then((answer) => ({ answer, later: () => said }));
    states.set(cmd, state);
  }
  return state as Promise<StartState<A, E>>;
}
