// A stand-in for the Tauri backend (window.__TAURI_INTERNALS__), so the real
// frontend renders in headless Chromium. Loaded BEFORE the app's scripts.
// run.mjs sets window.__MOCK_CFG__ = { lang: "en" | "de" | "", scenario:
// "populated" | "firstrun" } first. "populated" is a PC in daily use (models
// downloaded, lists filled); "firstrun" is Settings::default() with nothing
// downloaded and every list empty.
// window.__MOCK__ lets a check look inside: calls (every command with its
// arguments), unknown (commands without a handler here), settings() (what
// save_settings stored last), emit(event, payload) (a backend event).
(() => {
  const CFG = window.__MOCK_CFG__ || { lang: "en", scenario: "populated" };
  const rich = CFG.scenario !== "firstrun";
  const de = CFG.lang === "de";
  const now = Date.now();
  const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

  const defaults = {
    microphone: "default", engine: "local", whisperModel: "small", groqApiKey: "", recordingMode: "toggle",
    hotkey: "CmdOrCtrl+Shift+Space", gpuBackend: "auto", language: "auto", uiLanguage: "", volume: 0.4, autostart: false,
    customPrompt: "", replacements: [], sendCommand: "off", history: "audio", pasteLastHotkey: "Alt+Shift+V",
    rewriteLastHotkey: "", freeGpuHotkey: "", whisperFlashAttn: "auto", muteAudio: false, aiCleanup: false,
    aiModel: "gemma-4-e4b", aiStyle: "polished", aiInstructions: "", aiRules: [], swissSpelling: false,
    aiOutputLanguage: "", editMode: true, screenContext: true, learnDictionary: true, fileSpeakers: "off",
    meetingHotkey: "", meetingReminderOff: false, meetingHeadphonesSeen: false, freeGpuForGames: false, idleUnloadMinutes: 0,
  };
  let settings = rich
    ? {
        ...defaults,
        uiLanguage: CFG.lang || "en",
        whisperModel: "large-v3-turbo-q8_0",
        recordingMode: "push-to-talk",
        autostart: true,
        customPrompt: "RudariFlow, Oggi, Proxmox, Tauri, Vercel, Payload CMS, Zürich, Stoimenov, Groq, Gemma, sarotool, Vencord",
        replacements: [
          { from: de ? "meine Mail" : "my email", to: "info@0ggi.ch" },
          { from: de ? "Signatur" : "signature", to: de ? "Freundliche Grüsse\nOggi\n0ggi.ch" : "Best regards\nOggi\n0ggi.ch" },
          { from: de ? "Datum heute" : "today's date", to: "{weekday}, {date}" },
        ],
        sendCommand: "enter",
        rewriteLastHotkey: "Alt+Shift+R",
        meetingHotkey: "Alt+Shift+M",
        muteAudio: true,
        aiCleanup: true,
        aiInstructions: de ? "Immer du, nie Sie. Keine Emojis." : "Always use du, never Sie. No emojis.",
        aiRules: [
          { app: "whatsapp", instructions: de ? "locker, klein geschrieben, kein Punkt am Ende" : "casual, lowercase, no period at the end", off: false, language: "de" },
          { app: "code", instructions: "", off: true, language: "en" },
          { app: "outlook", instructions: de ? "förmlich, ganze Sätze" : "formal, full sentences", off: false, language: "" },
        ],
        swissSpelling: true,
        fileSpeakers: "auto",
        meetingHeadphonesSeen: true,
        freeGpuForGames: true,
        idleUnloadMinutes: 30,
      }
    : { ...defaults, uiLanguage: CFG.lang || "" };

  const history = rich
    ? [
        { id: now - 4 * MIN, text: de ? "Kannst du mir bitte bis morgen Mittag die Offerte für den Umzug schicken? Danke dir." : "Could you send me the quote for the move by tomorrow noon? Thanks a lot.", durationMs: 6200, model: "large-v3-turbo-q8_0", hasAudio: true, raw: de ? "ähm kannst du mir bitte bis morgen mittag die offerte für den umzug schicken danke dir" : "um could you send me the quote for the move by tomorrow noon thanks a lot", app: "whatsapp.root" },
        { id: now - 19 * MIN, text: de ? "Der Build läuft durch, ich pushe gleich auf main und deploye danach mit der CLI." : "The build passes, I'll push to main in a moment and deploy with the CLI afterwards.", durationMs: 5400, model: "large-v3-turbo-q8_0", hasAudio: true, app: "code" },
        { id: now - 52 * MIN, text: de ? "Guten Tag Herr Keller\n\nVielen Dank für Ihre Anfrage. Gerne bestätige ich Ihnen den Termin am Donnerstag um 14 Uhr.\n\nFreundliche Grüsse\nOggi" : "Dear Mr Keller,\n\nThank you for your enquiry. I am happy to confirm the appointment on Thursday at 2 pm.\n\nBest regards\nOggi", durationMs: 14800, model: "large-v3-turbo-q8_0", hasAudio: true, raw: "guten tag herr keller vielen dank für ihre anfrage gerne bestätige ich ihnen den termin am donnerstag um 14 uhr", app: "olk" },
        { id: now - 2 * HOUR, text: de ? "Kurz und knapp: Termin am Donnerstag, 14 Uhr, bestätigt." : "In short: appointment Thursday, 2 pm, confirmed.", durationMs: 2100, model: "large-v3-turbo-q8_0", hasAudio: true, raw: "Dear Mr Keller, Thank you for your enquiry. I am happy to confirm the appointment on Thursday at 2 pm.", app: "olk", edit: de ? "kürzer" : "shorter" },
        { id: now - 5 * HOUR, text: de ? "Notiz an mich: Proxmox-Backup auf der Docker-VM prüfen und das Cloudflare-Tunnel-Zertifikat erneuern." : "Note to self: check the Proxmox backup on the Docker VM and renew the Cloudflare tunnel certificate.", durationMs: 7900, model: "large-v3-turbo-q8_0", hasAudio: true, app: "notepad" },
        { id: now - DAY - 2 * HOUR, text: de ? "Ja passt, bis später." : "Yes, that works, see you later.", durationMs: 1600, model: "small", hasAudio: false, app: "discord" },
        { id: now - DAY - 6 * HOUR, text: de ? "Die neue Preisseite ist online. Schau sie dir bitte auf dem Handy an und sag mir, ob die Tabelle sauber umbricht." : "The new pricing page is live. Please look at it on your phone and tell me whether the table wraps cleanly.", durationMs: 8300, model: "small", hasAudio: false, raw: "die neue preisseite ist online schau sie dir bitte auf dem handy an und sag mir ob die tabelle sauber umbricht", app: "chrome" },
        { id: now - 3 * DAY, text: de ? "Erinnerung: Monitor-Kabel tauschen." : "Reminder: swap the monitor cable.", durationMs: 2400, model: "small", hasAudio: false, app: "notepad" },
      ]
    : [];

  const aiModels = [
    { id: "gemma-4-e4b", label: "Gemma 4 E4B", bytes: 4977171584, downloaded: rich },
    { id: "gemma-4-12b", label: "Gemma 4 12B", bytes: 7121861440, downloaded: false },
    { id: "gemma-4-e2b", label: "Gemma 4 E2B", bytes: 3106738272, downloaded: rich },
  ];
  const whisperDownloaded = rich ? ["small", "medium", "large-v3-turbo-q8_0"] : [];

  // ── Meetings ──
  const M1 = "m-20261005-1400", M2 = "m-20261002-1000", MREC = "m-live";
  const p = (startMs, track, speaker, text) => ({ startMs, track, speaker, text });
  const paragraphs1 = [
    p(4000, "you", undefined, de ? "Gut, fangen wir an. Heute geht es um den Shop-Launch und die offenen Punkte beim Checkout." : "Right, let's start. Today is about the shop launch and the open points in the checkout."),
    p(15000, "others", 0, de ? "Der Checkout läuft auf Staging. Was noch fehlt, ist die Mehrwertsteuer-Anzeige im Warenkorb, das mache ich bis Mittwoch." : "The checkout works on staging. What is still missing is the VAT display in the cart, I'll do that by Wednesday."),
    p(41000, "others", 1, de ? "Bei den Produktfotos fehlen noch zwölf Stück. Der Fotograf liefert am Donnerstag." : "Twelve product photos are still missing. The photographer delivers on Thursday."),
    p(58000, "you", undefined, de ? "Dann verschieben wir den Launch auf den 14. Oktober. Ich informiere den Kunden heute noch." : "Then we move the launch to 14 October. I'll let the client know today."),
    p(79000, "others", 0, de ? "Einverstanden. Ich richte bis dahin auch die Firewall-Regel für die Filter-URLs ein, damit die Crawler nicht wieder das Build-Budget auffressen." : "Agreed. By then I'll also set up the firewall rule for the filter URLs so the crawlers don't eat the build budget again."),
    p(104000, "others", 1, de ? "Und ich prüfe die Übersetzungen der Kategorieseiten." : "And I'll check the translations of the category pages."),
    p(121000, "you", undefined, de ? "Perfekt. Nächster Termin in einer Woche, gleiche Zeit." : "Perfect. Next meeting in a week, same time."),
  ];
  const linesOf = (ps) => ps.map((x) => ({ startMs: x.startMs, endMs: x.startMs + 9000, track: x.track, speaker: x.speaker, text: x.text }));
  const meeting1 = {
    id: M1, title: de ? "Wochen-Sync sarotool Shop" : "Weekly sync: sarotool shop", startedAt: now - DAY - 3 * HOUR, utcOffsetMin: 120,
    lengthMs: 42 * MIN + 17_000, whisperModel: "large-v3-turbo-q8_0", language: de ? "de" : "en", state: "finished",
    lines: linesOf(paragraphs1), speakerNames: ["Marco", ""],
    notes: {
      summary: de
        ? "Der Shop-Launch wird auf den 14. Oktober verschoben, weil die Mehrwertsteuer-Anzeige im Warenkorb und zwölf Produktfotos fehlen. Der Checkout läuft auf Staging stabil."
        : "The shop launch moves to 14 October because the VAT display in the cart and twelve product photos are missing. The checkout is stable on staging.",
      decisions: de
        ? ["Launch neu am 14. Oktober", "Nächster Termin in einer Woche, gleiche Zeit"]
        : ["Launch moved to 14 October", "Next meeting in a week, same time"],
      actionItems: [
        { text: de ? "Marco: Mehrwertsteuer-Anzeige im Warenkorb bis Mittwoch" : "Marco: VAT display in the cart by Wednesday", done: true },
        { text: de ? "Marco: Firewall-Regel für Filter-URLs" : "Marco: firewall rule for the filter URLs", done: false },
        { text: de ? "Sprecher 2: Übersetzungen der Kategorieseiten prüfen" : "Speaker 2: check the category page translations", done: false },
        { text: de ? "Du: Kunden über das neue Datum informieren" : "You: tell the client about the new date", done: false },
      ],
    },
    audioDeleted: false,
  };
  const meeting2 = {
    id: M2, title: de ? "Meeting 2. Oktober 2026, 10:00" : "Meeting 2 October 2026, 10:00", startedAt: now - 4 * DAY, utcOffsetMin: 120,
    lengthMs: 18 * MIN + 5000, whisperModel: "small", language: "de", state: "interrupted", lines: linesOf(paragraphs1.slice(0, 3)),
    speakerNames: [], audioDeleted: false,
  };
  const meetingRec = {
    id: MREC, title: de ? "Meeting 6. Oktober 2026, 15:30" : "Meeting 6 October 2026, 15:30", startedAt: now - 3 * MIN - 12_000, utcOffsetMin: 120,
    lengthMs: 0, whisperModel: "large-v3-turbo-q8_0", language: "", state: "recording", lines: linesOf(paragraphs1.slice(0, 4)),
    speakerNames: [], audioDeleted: false,
  };
  const meetings = rich ? { [M1]: { meeting: meeting1, paragraphs: paragraphs1 }, [M2]: { meeting: meeting2, paragraphs: paragraphs1.slice(0, 3) }, [MREC]: { meeting: meetingRec, paragraphs: paragraphs1.slice(0, 4).map((x) => ({ ...x, speaker: undefined })) } } : {};
  const summaryOf = (m) => ({ id: m.id, title: m.title, startedAt: m.startedAt, utcOffsetMin: m.utcOffsetMin, lengthMs: m.lengthMs, state: m.state, audioDeleted: m.audioDeleted });
  let meetingStatus = { recording: null, finishing: [] };

  // ── Soundboard ──
  const cats = [{ id: "c1", name: "Memes" }, { id: "c2", name: de ? "Musik" : "Music" }, { id: "c3", name: "Gaming" }];
  const snd = (id, name, category, hotkey, durationMs, loop = false, volume = 1) => ({ id, name, file: `${id}.wav`, category, hotkey, volume, durationMs, loop });
  const board = {
    version: 3, enabled: rich, othersVolume: 0.8, meVolume: 0.5, layer: false,
    devices: { microphone: "", cable: "", headphones: "" },
    stopHotkey: rich ? "Numpad0" : "", soundHotkeys: true, toggleHotkey: rich ? "CmdOrCtrl+Numpad0" : "",
    window: { poppedOut: false, alwaysOnTop: false },
    categories: rich ? cats : [],
    sounds: rich
      ? [
          snd("s1", "Airhorn", "c1", "Numpad1", 2100),
          snd("s2", "Sad trombone", "c1", "Numpad2", 3800, false, 0.7),
          snd("s3", "Bruh", "c1", "Numpad3", 900),
          snd("s4", "Lo-fi loop", "c2", "", 94000, true, 0.4),
          snd("s5", "Victory fanfare", "c3", "Numpad5", 6400),
          snd("s6", "Windows XP shutdown", "", "CmdOrCtrl+Numpad9", 2900),
        ]
      : [],
  };
  const sbStatus = () => (rich ? { state: "on", cable: "CABLE Input (VB-Audio Virtual Cable)" } : { state: "off" });
  const sbDevices = rich
    ? {
        inputs: ["Microphone (Fast Track)", "Headset Microphone (Logitech PRO X)", "CABLE Output (VB-Audio Virtual Cable)"],
        outputs: ["Speakers (Realtek(R) Audio)", "Headphones (Logitech PRO X)", "CABLE Input (VB-Audio Virtual Cable)", "HP X27qc (NVIDIA High Definition Audio)"],
        automatic: { microphone: "Microphone (Fast Track)", cable: "CABLE Input (VB-Audio Virtual Cable)", headphones: "Headphones (Logitech PRO X)" },
      }
    : { inputs: ["Microphone (Realtek(R) Audio)"], outputs: ["Speakers (Realtek(R) Audio)"], automatic: { microphone: "Microphone (Realtek(R) Audio)", cable: null, headphones: "Speakers (Realtek(R) Audio)" } };

  const fileTranscript = () => {
    const segs = paragraphs1.map((x) => ({ startMs: x.startMs, endMs: x.startMs + 9000, text: x.text, speaker: x.track === "you" ? 0 : (x.speaker ?? 0) + 1 }));
    return { segments: segs, speakers: 3, language: de ? "de" : "en", durationMs: 172_000, elapsedMs: 8400 };
  };

  // ── Event plumbing ──
  const callbacks = new Map();
  let cbId = 1;
  const listeners = new Map(); // event -> [handlerId]
  const unknown = [];
  window.__MOCK__ = {
    unknown,
    /** Every command the page sent: { cmd, args }. */
    calls: [],
    emit(event, payload) {
      for (const id of listeners.get(event) || []) callbacks.get(id)?.({ event, id, payload });
    },
    ids: { M1, M2, MREC },
    meetingRecording() {
      meetingStatus = { recording: { id: MREC, title: meetingRec.title, startedAt: meetingRec.startedAt, warnings: [], paused: false }, finishing: [] };
      return meetingStatus;
    },
    settings: () => settings,
  };

  const clockFmt = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

  const handlers = {
    get_settings: () => JSON.parse(JSON.stringify(settings)),
    save_settings: (a) => { settings = a.settings; return null; },
    list_microphones: () => rich
      ? [{ name: "Microphone (Fast Track)", is_default: true }, { name: "Headset Microphone (Logitech PRO X)", is_default: false }, { name: "Microphone (HD Pro Webcam C920)", is_default: false }]
      : [{ name: "Microphone (Realtek(R) Audio)", is_default: true }],
    get_recording_state: () => "Ready",
    check_model_downloaded: (a) => whisperDownloaded.includes(a.modelSize),
    download_model: () => new Promise(() => {}),
    detect_gpus: () => [
      { gpu_index: 0, api: "Cuda", name: "NVIDIA GeForce RTX 5080", integrated: false, memory_mib: 16303 },
      { gpu_index: 1, api: "Vulkan", name: "NVIDIA GeForce RTX 5080", integrated: false, memory_mib: 16303 },
    ],
    game_free_state: () => false,
    unused_models: () => rich
      ? [
          { kind: "whisper", file: "ggml-medium.bin", bytes: 1533763059, partial: false, otherLinks: false },
          { kind: "ai", file: "gemma-4-E2B-it-Q4_K_M.gguf", bytes: 3106738272, partial: false, otherLinks: false },
          { kind: "whisper", file: "ggml-large-v3.bin.part", bytes: 412000000, partial: true, otherLinks: false },
        ]
      : [],
    history_list: () => history,
    ai_status: () => ({
      server: rich ? { state: "ready", device: "NVIDIA GeForce RTX 5080 (CUDA)" } : { state: "stopped" },
      installed: true, models: aiModels, downloading: null, gpuFreed: false, gameFreed: false,
    }),
    list_open_apps: () => ["chrome", "code", "discord", "explorer", "olk", "whatsapp.root"],
    learn_suggestions: () => rich ? [{ word: "Shiggy", heard: "Shiggi", count: 3 }, { word: "Temporal", heard: "temporäl", count: 1 }] : [],
    speaker_model_status: () => ({ downloaded: rich, runtime: true, downloading: false }),
    format_file_text: (a) => a.segments.map((s) => `${a.times ? `[${clockFmt(s.startMs)}] ` : ""}${a.names[s.speaker] ?? ""}: ${s.text}`).join("\n\n"),
    transcribe_file: () => fileTranscript(),
    summarize_text: () => meeting1.notes.summary + (de ? "\n\n- Launch neu am 14. Oktober\n- Mehrwertsteuer-Anzeige bis Mittwoch\n- Produktfotos am Donnerstag" : "\n\n- Launch moved to 14 October\n- VAT display by Wednesday\n- Product photos on Thursday"),
    soundboard_state: () => ({ board, status: sbStatus(), playing: rich && CFG.playing ? [{ id: "s4", posMs: 31000, durationMs: 94000 }] : [], missing: [], hotkeysTaken: [] }),
    soundboard_devices: () => sbDevices,
    meeting_state: () => ({ status: meetingStatus, meeting: null }),
    meeting_list: (a) => Object.values(meetings).filter((v) => v.meeting.id !== MREC || meetingStatus.recording).map((v) => summaryOf(v.meeting)).filter((s) => !a?.query || s.title.toLowerCase().includes(a.query.toLowerCase())).sort((x, y) => y.startedAt - x.startedAt),
    meeting_get: (a) => { const v = meetings[a.id]; if (!v) throw "no_meeting"; return JSON.parse(JSON.stringify(v)); },
    meeting_default_title: () => (de ? "Meeting 6. Oktober 2026, 15:30" : "Meeting 6 October 2026, 15:30"),
    "plugin:app|version": () => "0.17.0",
    "plugin:event|listen": (a) => { const l = listeners.get(a.event) || []; l.push(a.handler); listeners.set(a.event, l); return a.handler; },
    "plugin:event|unlisten": () => null,
    "plugin:dialog|open": () => (de ? "C:\\Users\\Oggi\\Downloads\\Kundengespräch Keller 2026-10-05.m4a" : "C:\\Users\\Oggi\\Downloads\\Client call Keller 2026-10-05.m4a"),
    "plugin:dialog|save": () => null,
    learn_resolve: (a) => (rich ? [{ word: "Shiggy", heard: "Shiggi", count: 3 }, { word: "Temporal", heard: "temporäl", count: 1 }].filter((s) => s.word !== a.word) : []),
  };
  // Commands that only do something in the real backend.
  for (const cmd of [
    "set_hotkey_paused", "change_hotkey", "copy_text", "diag_log", "set_autostart", "cancel_recording", "cancel_file", "ai_restart",
    "history_delete", "history_clear", "delete_unused_model", "export_file", "speaker_model_download", "dictionary_export",
    "soundboard_set_volumes", "soundboard_set_layer", "soundboard_remove", "soundboard_rename", "soundboard_set_category",
    "soundboard_set_sound_volume", "soundboard_set_sound_loop", "soundboard_set_hotkey", "soundboard_set_stop_hotkey",
    "soundboard_set_sound_hotkeys", "soundboard_set_toggle_hotkey", "soundboard_stop_all", "soundboard_category_rename",
    "soundboard_category_remove", "soundboard_pop_out", "soundboard_dock", "soundboard_set_always_on_top",
    "meeting_stop", "meeting_rename", "meeting_rename_speaker", "meeting_set_action_done", "meeting_delete", "meeting_finish",
    "meeting_write_notes", "meeting_play", "meeting_stop_playing", "meeting_quit",
    "plugin:window|start_dragging", "plugin:shell|open", "plugin:event|emit",
  ]) {
    handlers[cmd] = () => null;
  }

  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(cb, once) { const id = cbId++; callbacks.set(id, (v) => { if (once) callbacks.delete(id); return cb?.(v); }); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    convertFileSrc: (p) => p,
    async invoke(cmd, args) {
      window.__MOCK__.calls.push({ cmd, args: args || {} });
      const h = handlers[cmd];
      if (!h) { if (!unknown.includes(cmd)) unknown.push(cmd); return null; }
      return h(args || {});
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  // No sound from a check.
  window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
})();
