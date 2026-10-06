# -*- coding: utf-8 -*-
import io
def edit(p, pairs):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, (p, old[:60], s.count(old))
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)

edit("tool5/mock.js", [
(
'''    meetingRecording() {''',
'''    /** `n` more dictations in the history (for "Show all" and its pages). */
    addHistory(n) {
      for (let i = 0; i < n; i++) {
        history.push({ id: now - 4 * DAY - i * HOUR, text: `${de ? "Notiz" : "Note"} ${i + 1}: ${de ? "Bitte die Unterlagen bis Freitag schicken." : "Please send the documents by Friday."}`, durationMs: 3000 + i * 10, model: "small", hasAudio: false, app: i % 2 ? "olk" : "notepad" });
      }
    },
    meetingRecording() {'''),
(
'''    learn_resolve: (a) =>''',
'''    mic_meter_start: () => (rich ? "Microphone (Fast Track)" : "Microphone (Realtek(R) Audio)"),
    mic_meter_stop: () => null,
    learn_resolve: (a) =>'''),
])
