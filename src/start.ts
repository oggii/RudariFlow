// Questions that two parts of the window ask the backend at its start:
// asked once, and each part is given the same answer.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
