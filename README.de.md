<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/RudariFlow%20White%20No%20BG.png">
    <img src="assets/RudariFlow%20No%20BG.png" alt="RudariFlow" width="360">
  </picture>
</p>

<p align="center"><em><a href="README.md">English</a> · Deutsch</em></p>

# RudariFlow

Lokale Sprache-zu-Text Diktier-App für Windows, angetrieben von [whisper.cpp](https://github.com/ggml-org/whisper.cpp) mit GPU-Beschleunigung. Globaler Hotkey, Push-to-Talk oder Toggle-Modus, automatisches Einfügen des transkribierten Texts.

> **v0.11.0, Windows.** Neu: KI-Korrektur über CUDA auf NVIDIA (lange Diktate auf einer RTX 5080 etwa 30 % schneller), Zeitmarken in Dateien, die auch nach Pausen stimmen, Namen aus dem Wörterbuch auch in langen Dateien richtig geschrieben, keine abgeschnittenen Diktate mehr durch eine prellende Maustaste, ein Leerzeichen zwischen zwei Diktaten nacheinander, und Diktate behalten ihre KI-Korrektur, während eine Datei zusammengefasst wird. Seit 0.10: Audio- und Videodateien transkribieren, mit KI-Zusammenfassung (Tab Dateien), das letzte Diktat per Stimme umschreiben, ein Wörterbuch, das aus deinen Korrekturen lernt, eine Sprache pro App, Textbausteine mit Datum und Uhrzeit, lange Diktate, die schon während des Sprechens transkribiert werden, ein PC-Check, der die schnellste Einstellung wählt, und Maus-Seitentasten für jeden Hotkey. Seit 0.9: KI-Korrektur etwa 30 % schneller, Large v3 Turbo q8. Seit 0.8: Wörter auf dem Bildschirm helfen bei Namen und Fachbegriffen. Seit 0.6: Bearbeiten per Stimme, „Schreiben in“, lokale KI-Korrektur mit Regeln pro App, Wörterbuch, Verlauf, Ersetzungen und der Befehl „Abschicken“ (siehe [Changelog](CHANGELOG.md)). Ein Installer für jede GPU: NVIDIA GeForce GTX 16 / RTX läuft über CUDA (Treiber 580 oder neuer), AMD Radeon, Intel Arc und ältere NVIDIA-Karten über Vulkan, alles andere fällt auf die CPU zurück. Das Backend wird zur Laufzeit automatisch gewählt.

Vollständige Versionshistorie siehe [CHANGELOG.md](CHANGELOG.md).

Made by [oggi](https://0ggi.ch).

## Features

- Lokale Transkription via In-Process whisper-rs — keine Cloud nötig, kein Subprozess pro Diktat
- **Persistentes Modell:** beim Start der App geladen und für weitere Diktate wiederverwendet (im Akkubetrieb nach 10 Minuten ohne Diktat entladen)
- **Warmup beim Hotkey-Druck:** ist das Modell nicht geladen, lädt der Hotkey es parallel, sodass es bereit ist, sobald du fertig gesprochen hast
- **Streaming-Partial-Transkripte:** Text erscheint im Overlay, sobald Whisper jedes Segment ausgibt
- **Auto-Backend-Erkennung:** NVIDIA CUDA wenn verfügbar, sonst Vulkan (AMD / Intel / NVIDIA), sonst CPU. Die Einstellungen zeigen die erkannten GPUs und erlauben, CUDA, Vulkan oder CPU zu erzwingen. Flash Attention ist bei CUDA an und bei Vulkan aus (auf einer RX 6800 doppelt so langsam); erzwingen mit `RUDARIFLOW_FLASH_ATTN=1` oder `=0`
- **PC-Check** (Tab Engine): misst Whisper auf jeder GPU mit Flash Attention an und aus, behält die schnellste Einstellung und liefert einen Bericht zum Kopieren, für Hardware, auf der RudariFlow nie getestet wurde
- **Wörterbuch:** eigener Tab für Namen, Marken und Fachbegriffe. Wörter einzeln hinzufügen oder eine Liste einfügen (Kommas oder eines pro Zeile). Whisper bekommt sie als Prompt, der Text übernimmt ihre genaue Schreibweise, auch wenn Whisper sie leicht anders hört („github“ wird zu „GitHub“, „Grüß'n shop“ zu „Grüssen-Shop“), und die KI-Korrektur erhält die Liste ebenfalls. Ein Schalter für Schweizer Rechtschreibung schreibt ss statt ß. Importieren und Exportieren bringen die Liste als einfache Textdatei auf einen anderen PC. **Lernt aus deinen Korrekturen:** korrigierst du direkt nach dem Diktieren einen Namen von Hand, wird das Wort im Tab Wörterbuch zum Hinzufügen oder Verwerfen vorgeschlagen (gespeichert wird nur das korrigierte Wort, nie dein Text)
- **No-Speech-Erkennung:** stumme Aufnahmen zeigen einen Hinweis statt nichts einzufügen
- **Clipboard-sicheres Einfügen:** dein vorheriger Zwischenablage-Inhalt wird vor dem Auto-Paste gesichert und danach wiederhergestellt; Diktate landen nicht im Windows-Zwischenablageverlauf (Win+V) und nicht in der Cloud-Zwischenablage
- **Ersetzungen:** sag einen kurzen Ausdruck, erhalte längeren Text, z. B. wird aus „meine Mail“ deine Adresse. Ganze Wörter, Groß-/Kleinschreibung egal; besteht ein Diktat nur aus dem Ausdruck, wird nur die Ersetzung eingefügt. Textbausteine können `{date}`, `{time}`, `{weekday}`, `{year}` und `{iso_date}` enthalten
- **Sprachbefehl „Abschicken“:** beende ein Diktat mit „Abschicken.“ (Englisch: „Send it.“) als eigenem Satz, und RudariFlow drückt nach dem Einfügen Enter oder Strg+Enter. Standardmäßig aus
- **Verlauf:** die letzten 200 Diktate bleiben auf deinem Computer, die letzten 50 mit Aufnahme. Kopieren, abspielen, löschen oder eine Aufnahme mit dem aktuellen Modell neu transkribieren. Lässt sich auf „Nur Text“ stellen oder ausschalten
- **Letztes Diktat einfügen:** ein zweites Tastenkürzel (Standard Alt+Umschalt+V) fügt dein letztes Diktat erneut ein
- **Letztes Diktat umschreiben:** ein drittes Tastenkürzel markiert dein letztes Diktat im Feld, und was du danach sagst, ändert es wie beim Bearbeiten per Stimme („kürzer“, „förmlicher“)
- **Andere Apps während der Aufnahme stummschalten:** Musik und Videos verstummen, während du diktierst, und kommen danach zurück (standardmäßig aus)
- **Wörter auf dem Bildschirm:** Namen und Begriffe im Fenster, in das du diktierst (der Name in einer E-Mail, eine Marke auf einer Website, Bezeichner im Editor), helfen Whisper und der KI bei der Schreibweise. Wird lokal beim Drücken des Hotkeys gelesen, nie gespeichert
- **Bearbeiten per Stimme:** Text in einer beliebigen App markieren, Hotkey halten und sagen, was sich ändern soll („kürzer“, „förmlicher“, „auf Türkisch“, „lösch das“), oder den neuen Wortlaut sprechen; das lokale Modell schreibt die Markierung an Ort und Stelle um, Strg+Z macht es rückgängig. Terminals, Adressleisten und Passwortfelder bleiben unberührt
- **KI-Korrektur, komplett lokal:** ein Sprachmodell auf deinem PC entfernt Füllwörter, übernimmt gesprochene Korrekturen („Dienstag, nein, Mittwoch“), korrigiert Grammatik und Satzzeichen, macht Listen und glättet im Stil „Geschliffen“ deine Sätze. Es behält die gesprochene Sprache und beantwortet nie, was du diktierst; stellst du bei „Schreiben in“ eine Sprache ein, schreibt es jedes Diktat in dieser Sprache und übersetzt, wenn du beim Sprechen die Sprache wechselst. Regeln pro App („kleingeschrieben in WhatsApp“, „formell in Outlook“, „keine KI in VS Code“) passen auf das Programm oder ein Wort im Fenstertitel, funktionieren so auch für Websites und können die Sprache festlegen, auf die Whisper in dieser App hört. Läuft mit Gemma 4 (standardmäßig E4B, wahlweise 12B oder E2B) in einem mitgelieferten llama.cpp-Server; das Modell wird einmal heruntergeladen (3 bis 7 GB), danach verlässt nichts deinen PC. Ist das Modell nicht bereit oder zu langsam, wird der reine Whisper-Text eingefügt. Standardmäßig aus
- Mehrere Whisper-Modelle wählbar: tiny → large-v3-turbo, mit Auto-Download bei Auswahl. Large v3 Turbo q8 lieferte auf 49 Testaufnahmen denselben Text wie Turbo, 18 % schneller und mit halbem Speicher
- Sprachen: Auto-Erkennung oder eine der rund 100 Sprachen, die Whisper kann
- **Lange Diktate in Teilen:** alle 29 s wird in einer Pause ein Teil abgeschnitten und transkribiert, während du weitersprichst, nach dem Loslassen bleibt nur der Rest
- **Dateien transkribieren** (Tab Dateien): eine Audio- oder Videodatei aufs Fenster ziehen (MP3, M4A, WAV, FLAC, WhatsApp-Sprachnachrichten, MP4, MOV, MKV, WebM), der Text erscheint Minute für Minute, mit Zeitmarken und Kopieren; Export als PDF, Word (.docx) oder Text, mit oder ohne Zeitmarken und der Zusammenfassung oben, wenn eine angezeigt wird, oder als Untertitel (.srt, .vtt), immer mit Zeitmarken; Sprecher trennen (Automatisch oder 2 bis 8, Namen, die du einmal festlegst; ein Sprechermodell mit 45 MB wird beim ersten Gebrauch heruntergeladen und läuft auf der CPU, etwa 3,5 % der Audiolänge auf einem Ryzen 9 7900X, 8 Threads); das lokale KI-Modell fasst ihn zusammen (Kernpunkte, nächste Schritte), die Zusammenfassung lässt sich ausblenden, damit der Text mehr Platz hat. Etwa 40-fache Echtzeit auf einer RX 6800. Diktieren geht weiter, während eine Datei läuft
- **Fenster anpassbar:** lässt sich in der Größe ändern und maximieren, nie kleiner als 900×600, und merkt sich Größe und Position
- Push-to-Talk **und** Toggle-Modi
- Konfigurierbare globale Hotkeys, auch Maus-Seitentasten (Maus 4 / Maus 5, allein oder mit Strg/Umschalt/Alt/Win) für alle drei Hotkeys, sodass eine Taste zwei Aufgaben haben kann (Maus 5 diktiert, Umschalt+Maus 5 schreibt um). Eine belegte Seitentaste wird abgefangen und löst in anderen Programmen kein „Zurück“/„Vorwärts“ mehr aus. Strg+A, C, V, X, Z, Y und S werden abgelehnt, weil sie sonst in keinem Programm mehr funktionieren
- Schwebende Aufnahme-Pille mit Live-Wellenform und Cancel-Button
- Auto-Einfügen via Tastatur-Simulation (kompatibel mit allen Anwendungen)
- System-Tray-Icon — X minimiert in den Tray statt Beenden
- Optional: mit Windows-Anmeldung starten
- UI in Deutsch und Englisch

## System-Voraussetzungen

- **OS:** Windows 10/11 x64
- **GPU (empfohlen), nur aktueller Treiber, keine zusätzliche Runtime:**
  - NVIDIA GeForce GTX 16 / RTX 20 oder neuer: CUDA (Treiber 580 oder neuer; mit älterem Treiber und auf älteren NVIDIA-Karten Vulkan)
  - AMD Radeon RX 6000 oder neuer (AMD Software: Adrenalin Edition): Vulkan
  - Intel Arc und andere Vulkan-1.2-GPUs: Vulkan
  - Mit integrierter und dedizierter GPU wird die dedizierte genutzt.
- **CPU-Fallback:** Funktioniert auch ohne nutzbare GPU, dann deutlich langsamer (~10-30×). Für CPU-Nutzer: small oder medium Modell empfohlen
- **RAM:** Das gewählte Whisper-Modell lädt beim Start und bleibt resident. `large-v3-turbo` ≈ 1.6 GB, `small` ≈ 500 MB, `tiny` ≈ 80 MB. Im Akkubetrieb werden die Modelle nach 10 Minuten ohne Diktat entladen und beim nächsten Hotkey wieder geladen.
- **KI-Korrektur (optional):** läuft auf derselben Karte wie Whisper, mit dem normalen Treiber: über CUDA auf NVIDIA GeForce GTX 16 / RTX 20 und neuer (Treiber 580 oder neuer), über Vulkan auf AMD, Intel und älteren NVIDIA-Karten. Das Standardmodell belegt etwa 3,6 GB Grafikspeicher zusätzlich zu Whisper und etwa 3,3 GB RAM. Gemessen: etwa 0,3 s pro Diktat auf einer AMD Radeon RX 6800 (Vulkan), etwa 0,09 s auf einer NVIDIA GeForce RTX 5080 (CUDA).

## Installation (für Endbenutzer)

Lade die neueste `RudariFlow_x.y.z_x64-setup.exe` aus den [Releases](https://github.com/oggii/RudariFlow/releases) herunter und führe sie aus.

## Entwicklung

### Voraussetzungen

- [Rust](https://rustup.rs/) (MSVC toolchain auf Windows)
- [Node.js](https://nodejs.org/) ≥ 20
- Visual Studio Build Tools mit C++ workload (für `cargo build`)
- [CMake](https://cmake.org/) und [LLVM](https://llvm.org/) (libclang, für das bindgen von `whisper-rs-sys`)
- [Vulkan SDK](https://vulkan.lunarg.com/) (liefert `glslc` für die Vulkan-Shader von whisper.cpp; `VULKAN_SDK` muss gesetzt sein)
- [CUDA Toolkit 13.x](https://developer.nvidia.com/cuda-downloads) (13.4, die Version des mitgelieferten llama.cpp-CUDA-Backends; Compiler und cuBLAS reichen, zum Bauen ist keine NVIDIA-GPU nötig)

### Setup

```powershell
# 1. Repo klonen
git clone https://github.com/oggii/RudariFlow.git
cd RudariFlow

# 2. Frontend-Dependencies
npm install

# 3. GPU-Runtime-DLLs einsammeln, die neben der exe ausgeliefert werden
#    (CUDA-Runtime aus CUDA_PATH, Vulkan-Loader aus System32)
powershell -ExecutionPolicy Bypass -File scripts/setup-whisper.ps1

# 3b. llama.cpp-Server für die KI-Korrektur holen: Vulkan-Build und sein
#     CUDA-Backend (festgelegte Builds, SHA-256 geprüft)
powershell -ExecutionPolicy Bypass -File scripts/setup-llama.ps1

# 3c. whisper-rs-sys entpacken und die whisper.cpp-Patches aus patches\ anwenden
powershell -ExecutionPolicy Bypass -File scripts/setup-whisper-patch.ps1

# 3d. sherpa-onnx-Runtime für die Sprechertrennung holen (festgelegte Version, SHA-256 geprüft)
powershell -ExecutionPolicy Bypass -File scripts/setup-speakers.ps1

# 4. Build-Pfad kurz halten: der verschachtelte Vulkan-Shader-Build von
#    whisper.cpp sprengt unter src-tauri\target das 260-Zeichen-Limit (und
#    auch unter C:\t\rf, ausser lange Pfade sind in Windows aktiviert)
$env:CARGO_TARGET_DIR = "C:\r"
$env:CUDAARCHS = "75;80;86;89;120"   # RTX 20, 30, A-Serie, 40, 50

# 5. Dev-Modus starten
npm run tauri dev
```

Ohne CUDA Toolkit lässt sich ein reiner Vulkan-Build bauen:
`npm run tauri dev -- --no-default-features --features vulkan`.

`cargo run`, Beispiele und Dev-Builds brauchen `src-tauri\binaries\sherpa-onnx\lib` im PATH
für die Sprechertrennung (der Installer legt die DLLs neben die exe).

### Production Build

```powershell
npm run tauri build
```

Erzeugt (unter `CARGO_TARGET_DIR`):
- `release/rudariflow.exe` (portable, braucht die DLLs aus Schritt 3 daneben)
- `release/bundle/nsis/RudariFlow_x.y.z_x64-setup.exe` (Installer)
- `release/bundle/msi/RudariFlow_x.y.z_x64_en-US.msi`

### Testdaten getrennt von der installierten App

Einstellungen, Modelle und Verlauf liegen in `%APPDATA%\com.rudariflow.app`. Damit ein Dev-Build neben einer installierten RudariFlow deren Daten nicht anfasst, einen anderen Ordner angeben:

```powershell
$env:RUDARIFLOW_DATA_DIR = "C:\t\rf-test-data"
```

### Benchmark

```powershell
cd src-tauri
cargo run --release --example bench -- "$env:APPDATA\com.rudariflow.app\ggml-large-v3-turbo.bin" pfad\zu\16khz-mono.wav
```

Misst Modell-Ladezeit und Transkription auf der ersten GPU mit und ohne Flash Attention sowie auf CPU.

## Architektur

- **KI-Korrektur:** [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server` (Release b11100: der Vulkan-Build plus das CUDA-13.4-Backend `ggml-cuda.dll`, das die für Whisper mitgelieferte CUDA-Laufzeit nutzt) als eigener Prozess auf 127.0.0.1 mit zufälligem Port und API-Schlüssel, in einem Job-Objekt, das ihn mit RudariFlow beendet; Gemma-4-Modelle (Apache-2.0) von Hugging Face. Ein eigener Prozess ist nötig, weil whisper-rs seine eigene ggml-Kopie in `rudariflow.exe` einbindet
- **Tauri 2** (Rust backend + Webview frontend)
- **Frontend:** Vanilla TypeScript + Vite
- **Audio capture:** [cpal](https://github.com/RustAudio/cpal) (Cross-platform low-level audio I/O)
- **Transkription:** In-Process [`whisper-rs`](https://github.com/tazz4843/whisper-rs) (whisper.cpp Rust-Bindings) gebaut mit `cuda`- und `vulkan`-Feature; das Backend wird zur Laufzeit aus der ggml-Geräteliste gewählt, mit Fallback auf CPU
- **Dateien:** Windows Media Foundation liest Audio- und Videodateien; Ogg Opus (WhatsApp-Sprachnachrichten), das Windows nicht öffnen kann, läuft über [libopus](https://opus-codec.org) mit den Crates `opus` und `ogg`
- **Sprecher:** [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) v1.12.9 (Pyannote-Segmentierung 3.0, 3D-Speaker ERes2Net), dynamisch gelinkte DLLs, die `rudariflow.exe` delay-lädt
- **Export:** Word über docx-rs, PDF über WebView2s PrintToPdf
- **Auto-Paste:** [enigo](https://github.com/enigo-rs/enigo) (Tastatur-Simulation)
- **Hotkey:** [tauri-plugin-global-shortcut](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/global-shortcut)
- **Autostart:** [tauri-plugin-autostart](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/autostart)

## Lizenz / Credits

RudariFlow ist unter der **[MIT-Lizenz](LICENSE)** veröffentlicht — frei zur Nutzung, Modifikation, Weiterverbreitung und Einbindung in proprietäre Projekte, mit Namensnennung.

Basiert auf der initialen Tauri-Vorlage von [albertshiney/typr](https://github.com/albertshiney/typr).
Verwendet [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) für die Transkription.

© 2026 [oggi](https://0ggi.ch).
