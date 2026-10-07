// A stand-in for the Tauri backend (window.__TAURI_INTERNALS__), so the real
// frontend renders in headless Chromium. Loaded BEFORE the app's scripts.
// run.mjs sets window.__MOCK_CFG__ = { lang: "en" | "de" | "", scenario:
// "populated" | "firstrun" } first. "populated" is a PC in daily use (models
// downloaded, lists filled); "firstrun" is Settings::default() with nothing
// downloaded and every list empty.
// window.__MOCK__ lets a check look inside: calls (every command with its
// arguments), unknown (commands without a handler here), settings() (what
// save_settings stored last), emit(event, payload) (a backend event).
// A check also steers what the page cannot: finishDownload(kind) and
// failDownload(kind, why) end a model download ("speech" or "ai"), which
// waits until then; meter is the setup's microphone (open, opens, device,
// delay, delays, fail, cap, swap, timeOut(), lose()); window is the
// window's own state (visible, minimized; delay: it answers that late;
// broken: it does not answer);
// keep({ mics, window, gpus }) sets the microphones Windows lists, the
// window's state and how detect_gpus answers ("never", or after that many
// ms), also for the next start of the page; saveDelay makes save_settings
// take that long, as a busy backend does; speech is laid over what
// speech_status answers (a model that did not load: { downloaded: true,
// load: "failed" }); answerDelay makes every answer take that many ms on
// its way back (the command itself arrives at once), as over a busy IPC:
// what the page does between a question and its answer then has the time
// to go wrong.
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
  const whisperBytes = { tiny: 75e6, base: 142e6, small: 466e6, medium: 1.5e9, "large-v3": 2.9e9, "large-v3-turbo": 1.5e9, "large-v3-turbo-q8_0": 870e6, "large-v3-turbo-q5_0": 574e6 };
  /** A model that was just downloaded loads for a moment, as in the app. */
  let loadingUntil = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** What a check set for this start of the page and the next ones (the session's). */
  const kept = JSON.parse(sessionStorage.getItem("ui-check-mock") || "{}");

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
    /** `n` more dictations in the history (for "Show all" and its pages). */
    addHistory(n) {
      for (let i = 0; i < n; i++) {
        history.push({ id: now - 4 * DAY - i * HOUR, text: `${de ? "Notiz" : "Note"} ${i + 1}: ${de ? "Bitte die Unterlagen bis Freitag schicken." : "Please send the documents by Friday."}`, durationMs: 3000 + i * 10, model: "small", hasAudio: false, app: i % 2 ? "olk" : "notepad" });
      }
    },
    meetingRecording() {
      meetingStatus = { recording: { id: MREC, title: meetingRec.title, startedAt: meetingRec.startedAt, warnings: [], paused: false }, finishing: [] };
      return meetingStatus;
    },
    settings: () => settings,
    keep(patch) {
      Object.assign(kept, patch);
      sessionStorage.setItem("ui-check-mock", JSON.stringify(kept));
    },
    /** The window itself, as the page asks it (is_visible, is_minimized). */
    window: { visible: true, minimized: false, delay: 0, broken: false, ...kept.window },
    /** save_settings takes this many ms: what is sent with it in one go arrives before the save is done. */
    saveDelay: 0,
    /** Laid over the speech model's state; null: as the settings and the downloads have it. */
    speech: null,
    /** Every answer (and every refusal) is this many ms on its way back to the page. */
    answerDelay: 0,
    finishDownload: (kind = "speech") => downloads[kind]?.finish(),
    failDownload: (kind = "speech", why = "error sending request") => downloads[kind]?.fail(why),
  };

  // ── Model downloads ──
  // A download waits until a check ends it: finish() reports the rest of
  // the way to 100 % and then answers the command, fail() refuses it. Left
  // alone it never ends.
  const downloads = {};
  const download = (kind, event, total, done) =>
    new Promise((resolve, reject) => {
      downloads[kind] = {
        async finish() {
          delete downloads[kind];
          for (const percent of [25, 50, 75, 100]) {
            window.__MOCK__.emit(event, { downloaded: (total * percent) / 100, total, percent });
            await sleep(25);
          }
          done();
          resolve(null);
        },
        fail(why) {
          delete downloads[kind];
          reject(why);
        },
      };
    });

  // ── The setup's microphone meter ──
  // Like the backend's: a start is counted when it arrives, opens the
  // microphone that is saved at that moment (Windows' default one when it is
  // "default" or gone) after `delay` ms, and answers "stopped" when a stop or
  // a newer start arrived meanwhile, or with `fail` when that is set. While
  // it is open a level goes out ten times a second, and `device` is the
  // microphone that is open. After `cap` ms (the backend's two minutes) it
  // closes by itself without a word; timeOut() is that limit now, and the
  // window closed to the tray. lose() is the microphone unplugged: one last
  // level of 0.
  // Every call is a request of its own, so two that are sent in one go can
  // arrive swapped. `swap` = "stop" or "start" does that once: the next
  // start arrives only after the next stop, or after the next start, that
  // the page sends behind it. `delays` are the times the next starts take
  // to open, in the order they arrive (then `delay` again); `opens` counts
  // how often the microphone was opened.
  const meter = {
    open: false,
    opens: 0,
    device: "",
    delay: 0,
    delays: [],
    fail: null,
    cap: 120_000,
    swap: null,
    held: null,
    run: 0,
    timer: null,
    capTimer: null,
    close() {
      meter.open = false;
      meter.device = "";
      clearInterval(meter.timer);
      clearTimeout(meter.capTimer);
    },
    timeOut() {
      meter.run++;
      meter.close();
    },
    lose() {
      meter.close();
      window.__MOCK__.emit("mic-level", 0);
    },
    /** A call of this kind has arrived: the start it overtook arrives now. */
    overtaken(kind) {
      const held = meter.held;
      if (held?.after !== kind) return;
      meter.held = null;
      held.go();
    },
  };
  window.__MOCK__.meter = meter;

  const clockFmt = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

  const handlers = {
    get_settings: () => JSON.parse(JSON.stringify(settings)),
    save_settings: async (a) => {
      if (window.__MOCK__.saveDelay) await sleep(window.__MOCK__.saveDelay);
      settings = a.settings;
      // The backend reports the speech model again after a change.
      setTimeout(() => window.__MOCK__.emit("speech-status", handlers.speech_status()), 0);
      return null;
    },
    speech_status: () => {
      const downloaded = whisperDownloaded.includes(settings.whisperModel);
      const local = settings.engine === "local";
      const loaded = local && downloaded && Date.now() >= loadingUntil;
      return {
        engine: settings.engine, model: settings.whisperModel, downloaded,
        load: loaded ? "loaded" : local && downloaded ? "loading" : "unloaded", freed: false, cloudKey: !!settings.groqApiKey,
        device: loaded ? "NVIDIA GeForce RTX 5080 (CUDA)" : "",
        ...window.__MOCK__.speech,
      };
    },
    list_microphones: () => kept.mics ?? (rich
      ? [{ name: "Microphone (Fast Track)", is_default: true }, { name: "Headset Microphone (Logitech PRO X)", is_default: false }, { name: "Microphone (HD Pro Webcam C920)", is_default: false }]
      : [{ name: "Microphone (Realtek(R) Audio)", is_default: true }]),
    get_recording_state: () => "Ready",
    check_model_downloaded: (a) => whisperDownloaded.includes(a.modelSize),
    download_model: (a) =>
      download("speech", "download-progress", whisperBytes[a.modelSize] ?? 466e6, () => {
        whisperDownloaded.push(a.modelSize);
        // The backend loads the model and says so, as after every change.
        loadingUntil = Date.now() + 300;
        setTimeout(() => window.__MOCK__.emit("speech-status", handlers.speech_status()), 0);
        setTimeout(() => window.__MOCK__.emit("speech-status", handlers.speech_status()), 320);
      }),
    detect_gpus: async () => {
      // A driver that hangs never answers; a slow one answers late.
      if (kept.gpus === "never") await new Promise(() => {});
      if (kept.gpus) await sleep(kept.gpus);
      return [
        { gpu_index: 0, api: "Cuda", name: "NVIDIA GeForce RTX 5080", integrated: false, memory_mib: 16303 },
        { gpu_index: 1, api: "Vulkan", name: "NVIDIA GeForce RTX 5080", integrated: false, memory_mib: 16303 },
      ];
    },
    game_free_state: () => false,
    unused_models: () => rich
      ? [
          { kind: "whisper", file: "ggml-medium.bin", bytes: 1533763059, partial: false, otherLinks: false },
          { kind: "ai", file: "gemma-4-E2B-it-Q4_K_M.gguf", bytes: 3106738272, partial: false, otherLinks: false },
          { kind: "whisper", file: "ggml-large-v3.bin.part", bytes: 412000000, partial: true, otherLinks: false },
        ]
      : [],
    history_list: () => history,
    history_delete: (a) => {
      const at = history.findIndex((h) => h.id === a.id);
      if (at >= 0) history.splice(at, 1);
      return null;
    },
    ai_status: () => ({
      // On a new PC the AI runs once its model is there and AI cleanup is on.
      server: rich || (settings.aiCleanup && aiModels.some((m) => m.id === settings.aiModel && m.downloaded)) ? { state: "ready", device: "NVIDIA GeForce RTX 5080 (CUDA)" } : { state: "stopped" },
      installed: true, models: aiModels, downloading: downloads.ai ? settings.aiModel : null, gpuFreed: false, gameFreed: false,
    }),
    ai_download_model: (a) => {
      // One at a time, as in the backend.
      if (downloads.ai) throw "A download is already running";
      const model = aiModels.find((m) => m.id === a.id);
      return download("ai", "ai-download-progress", model.bytes, () => (model.downloaded = true));
    },
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
    mic_meter_start: () => {
      // The start as it arrives at the backend.
      const arrive = () =>
        new Promise((resolve, reject) => {
          const run = ++meter.run;
          meter.close();
          // The microphone that is saved now; Windows' default one when it is "default" or not there.
          const mics = handlers.list_microphones();
          const device = (mics.find((m) => m.name === settings.microphone) ?? mics.find((m) => m.is_default) ?? mics[0])?.name;
          setTimeout(() => {
            if (run !== meter.run) return reject("stopped");
            if (meter.fail) return reject(meter.fail);
            if (!device) return reject("No default input device found");
            meter.open = true;
            meter.opens++;
            meter.device = device;
            let i = 0;
            meter.timer = setInterval(() => window.__MOCK__.emit("mic-level", 0.3 + 0.2 * Math.sin(i++ / 2)), 100);
            meter.capTimer = setTimeout(() => run === meter.run && meter.timeOut(), meter.cap);
            resolve(device);
          }, meter.delays.shift() ?? meter.delay);
        });
      // Swapped with the call that follows it: on its way until that one has arrived.
      if (meter.swap && !meter.held) {
        return new Promise((resolve, reject) => {
          meter.held = { after: meter.swap, go: () => arrive().then(resolve, reject) };
          meter.swap = null;
        });
      }
      const answer = arrive();
      meter.overtaken("start");
      return answer;
    },
    mic_meter_stop: () => {
      meter.run++;
      meter.close();
      meter.overtaken("stop");
      return null;
    },
    "plugin:window|is_visible": async () => {
      const win = window.__MOCK__.window;
      if (win.delay) await sleep(win.delay);
      if (win.broken) throw "the window does not answer";
      return win.visible;
    },
    "plugin:window|is_minimized": () => window.__MOCK__.window.minimized,
    learn_resolve: (a) => (rich ? [{ word: "Shiggy", heard: "Shiggi", count: 3 }, { word: "Temporal", heard: "temporäl", count: 1 }].filter((s) => s.word !== a.word) : []),
  };
  // Commands that only do something in the real backend.
  for (const cmd of [
    "set_hotkey_paused", "change_hotkey", "copy_text", "diag_log", "set_autostart", "cancel_recording", "cancel_file", "ai_restart",
    "history_clear", "delete_unused_model", "export_file", "speaker_model_download", "dictionary_export",
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
      const late = window.__MOCK__.answerDelay;
      if (!late) return h(args || {});
      // The command has arrived and is done; its answer is late.
      try {
        const answer = await h(args || {});
        await sleep(late);
        return answer;
      } catch (e) {
        await sleep(late);
        throw e;
      }
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  // No sound from a check.
  window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
})();
