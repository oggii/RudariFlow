// The Soundboard's backend: types of `soundboard_state` and the commands.
import { invoke } from "@tauri-apps/api/core";

export interface Category {
  id: string;
  name: string;
}

export interface Sound {
  id: string;
  name: string;
  file: string;
  /** A category id; "" = no category. */
  category: string;
  hotkey: string;
  volume: number;
  durationMs: number;
}

/** Device names; "" = automatic. */
export interface Devices {
  microphone: string;
  cable: string;
  headphones: string;
}

export interface Board {
  version: number;
  enabled: boolean;
  othersVolume: number;
  meVolume: number;
  layer: boolean;
  devices: Devices;
  stopHotkey: string;
  /** The sounds' hotkeys work (while on); off, they keep their keys but do nothing. */
  soundHotkeys: boolean;
  /** Turns `soundHotkeys` on and off; "" = none. */
  toggleHotkey: string;
  window: { poppedOut: boolean; alwaysOnTop: boolean };
  categories: Category[];
  sounds: Sound[];
}

export interface Problem {
  reason: "no_cable" | "no_device" | "not_connected" | "mic_is_cable" | "open_failed" | "lost";
  device: "microphone" | "cable" | "headphones";
  name: string;
  detail: string;
}

export type Status = { state: "off" } | { state: "on"; cable: string } | { state: "error"; problem: Problem };

export interface PlayingVoice {
  id: string;
  posMs: number;
  durationMs: number;
}

export interface BoardState {
  board: Board;
  status: Status;
  playing: PlayingVoice[];
  /** Sounds whose files were deleted by hand. */
  missing: string[];
  /** Sound ids, "stopSounds" and "toggleSoundHotkeys", whose hotkey another program owns. */
  hotkeysTaken: string[];
}

export interface DeviceChoices {
  inputs: string[];
  outputs: string[];
  automatic: { microphone: string | null; cable: string | null; headphones: string | null };
}

export interface AddResult {
  path: string;
  name: string;
  id: string | null;
  error: string | null;
}

/** The formats "Add sounds…" offers. */
export const EXTENSIONS = ["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "wma"];

export const api = {
  state: () => invoke<BoardState>("soundboard_state"),
  setEnabled: (enabled: boolean) => invoke<Status>("soundboard_set_enabled", { enabled }),
  devices: () => invoke<DeviceChoices>("soundboard_devices"),
  setDevices: (devices: Devices) => invoke<Status>("soundboard_set_devices", { devices }),
  setVolumes: (others: number, me: number) => invoke<void>("soundboard_set_volumes", { others, me }),
  setLayer: (layer: boolean) => invoke<void>("soundboard_set_layer", { layer }),
  add: (paths: string[]) => invoke<AddResult[]>("soundboard_add", { paths }),
  remove: (id: string) => invoke<void>("soundboard_remove", { id }),
  rename: (id: string, name: string) => invoke<void>("soundboard_rename", { id, name }),
  setCategory: (id: string, category: string) => invoke<void>("soundboard_set_category", { id, category }),
  setSoundVolume: (id: string, volume: number) => invoke<void>("soundboard_set_sound_volume", { id, volume }),
  setHotkey: (id: string, hotkey: string) => invoke<void>("soundboard_set_hotkey", { id, hotkey }),
  setStopHotkey: (hotkey: string) => invoke<void>("soundboard_set_stop_hotkey", { hotkey }),
  setSoundHotkeys: (enabled: boolean) => invoke<void>("soundboard_set_sound_hotkeys", { enabled }),
  setToggleHotkey: (hotkey: string) => invoke<void>("soundboard_set_toggle_hotkey", { hotkey }),
  play: (id: string) => invoke<boolean>("soundboard_play", { id }),
  stopAll: () => invoke<void>("soundboard_stop_all"),
  categoryAdd: (name: string) => invoke<string>("soundboard_category_add", { name }),
  categoryRename: (id: string, name: string) => invoke<void>("soundboard_category_rename", { id, name }),
  categoryRemove: (id: string) => invoke<void>("soundboard_category_remove", { id }),
  popOut: (focus: boolean) => invoke<void>("soundboard_pop_out", { focus }),
  dock: () => invoke<void>("soundboard_dock"),
  setAlwaysOnTop: (on: boolean) => invoke<void>("soundboard_set_always_on_top", { on }),
};
