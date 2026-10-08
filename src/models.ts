// The speech models: their names and download sizes in one place (the
// dropdown in Settings, Home's "loaded" card and the first run use them).
// Pure (tests/unit/models.test.ts).
import { sizeText } from "./size.ts";

export interface SpeechModel {
  /** The id in the settings and the file name: ggml-<id>.bin. */
  id: string;
  name: string;
  /** Download size in MB. */
  mb: number;
  /** i18n key of the model's one line: under the dropdown for the chosen
   *  one, and for every model in the list behind the row's "More". */
  note: string;
}

export const SPEECH_MODELS: SpeechModel[] = [
  { id: "tiny", name: "Tiny", mb: 75, note: "model_note_tiny" },
  { id: "base", name: "Base", mb: 142, note: "model_note_base" },
  { id: "small", name: "Small", mb: 466, note: "model_note_small" },
  { id: "medium", name: "Medium", mb: 1500, note: "model_note_medium" },
  { id: "large-v3", name: "Large v3", mb: 2900, note: "model_note_large_v3" },
  { id: "large-v3-turbo", name: "Large v3 Turbo", mb: 1500, note: "model_note_turbo" },
  { id: "large-v3-turbo-q8_0", name: "Large v3 Turbo q8", mb: 870, note: "model_note_q8" },
  { id: "large-v3-turbo-q5_0", name: "Large v3 Turbo q5", mb: 574, note: "model_note_q5" },
];

/** The model with this id; an id this table does not know keeps its id as its name. */
export function speechModel(id: string): SpeechModel {
  return SPEECH_MODELS.find((m) => m.id === id) ?? { id, name: id, mb: 0, note: "" };
}

/** "466 MB", "1.5 GB": the one way a size is written (src/size.ts). */
export function modelSize(mb: number): string {
  return sizeText(mb * 1e6);
}

/** The speech model a save stores: the dropdown's only once that model is
 *  known to be on disk. The dropdown is on a model before that is known:
 *  while it is looked for, while it downloads, and for a moment after its
 *  download failed. A save in between (another setting was changed, or an
 *  earlier choice finishes) keeps the model that was saved last. Stored
 *  sooner, a download that then fails would leave the settings on a model
 *  that is missing. `unverified`: the dropdown's model is not the one last
 *  known to be there. */
export function modelToSave(chosen: string, saved: string, unverified: boolean): string {
  return unverified && saved ? saved : chosen;
}

/** What the dropdown and the first run show: "Large v3 Turbo q8 · 870 MB". */
export function modelLabel(id: string): string {
  const model = speechModel(id);
  return model.mb > 0 ? `${model.name} · ${modelSize(model.mb)}` : model.name;
}
