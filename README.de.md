<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/RudariFlow%20White%20No%20BG.png">
    <img src="assets/RudariFlow%20No%20BG.png" alt="RudariFlow" width="360">
  </picture>
</p>

<p align="center"><em><a href="README.md">English</a> · Deutsch</em></p>

# RudariFlow

Lokale Sprache-zu-Text Diktier-App für Windows, angetrieben von [whisper.cpp](https://github.com/ggml-org/whisper.cpp) mit GPU-Beschleunigung. Globaler Hotkey, Push-to-Talk oder Toggle-Modus, automatisches Einfügen des transkribierten Texts.

> **v0.5.1, Windows.** Ein Installer für jede GPU: NVIDIA GeForce RTX läuft über CUDA, AMD Radeon und Intel Arc über Vulkan, alles andere fällt auf die CPU zurück. Das Backend wird zur Laufzeit automatisch gewählt.

Vollständige Versionshistorie siehe [CHANGELOG.md](CHANGELOG.md).

Made by [oggi](https://0ggi.ch).

## Features

- Lokale Transkription via In-Process whisper-rs — keine Cloud nötig, kein Subprozess pro Diktat
- **Persistentes Modell:** beim ersten Gebrauch einmal geladen und für weitere Diktate wiederverwendet
- **Warmup beim Hotkey-Druck:** PTT-Druck lädt das Modell parallel vor, sodass es bereit ist, sobald du fertig gesprochen hast
- **Streaming-Partial-Transkripte:** Text erscheint im Overlay, sobald Whisper jedes Segment ausgibt
- **Auto-Backend-Erkennung:** NVIDIA CUDA wenn verfügbar, sonst Vulkan (AMD / Intel / NVIDIA), sonst CPU. Die Einstellungen zeigen die erkannten GPUs und erlauben, CUDA, Vulkan oder CPU zu erzwingen. Flash Attention ist bei CUDA an und bei Vulkan aus (auf einer RX 6800 doppelt so langsam); erzwingen mit `RUDARIFLOW_FLASH_ATTN=1` oder `=0`
- **Eigenes Vokabular:** Domain-Begriffe (Namen, Fachjargon, Abkürzungen) zur Erkennungs-Steuerung einfügen
- **No-Speech-Erkennung:** stumme Aufnahmen zeigen einen Hinweis statt nichts einzufügen
- **Clipboard-sicheres Einfügen:** dein vorheriger Zwischenablage-Inhalt wird vor dem Auto-Paste gesichert und danach wiederhergestellt; Diktate landen nicht im Windows-Zwischenablageverlauf (Win+V) und nicht in der Cloud-Zwischenablage
- **Ersetzungen:** sag einen kurzen Ausdruck, erhalte längeren Text, z. B. wird aus „meine Mail“ deine Adresse. Ganze Wörter, Groß-/Kleinschreibung egal; besteht ein Diktat nur aus dem Ausdruck, wird nur die Ersetzung eingefügt
- **Sprachbefehl „Abschicken“:** beende ein Diktat mit „Abschicken.“ (Englisch: „Send it.“) als eigenem Satz, und RudariFlow drückt nach dem Einfügen Enter oder Strg+Enter. Standardmäßig aus
- **Verlauf:** die letzten 200 Diktate bleiben auf deinem Computer, die letzten 50 mit Aufnahme. Kopieren, abspielen, löschen oder eine Aufnahme mit dem aktuellen Modell neu transkribieren. Lässt sich auf „Nur Text“ stellen oder ausschalten
- **Letztes Diktat einfügen:** ein zweites Tastenkürzel (Standard Alt+Umschalt+V) fügt dein letztes Diktat erneut ein
- **Andere Apps während der Aufnahme stummschalten:** Musik und Videos verstummen, während du diktierst, und kommen danach zurück (standardmäßig aus)
- **KI-Korrektur, komplett lokal:** ein Sprachmodell auf deinem PC entfernt Füllwörter, übernimmt gesprochene Korrekturen („Dienstag, nein, Mittwoch“), korrigiert Grammatik und Satzzeichen, macht Listen und glättet im Stil „Geschliffen“ deine Sätze. Es übersetzt nie und beantwortet nie, was du diktierst. Regeln pro App („kleingeschrieben in WhatsApp“, „formell in Outlook“, „keine KI in VS Code“) passen auf das Programm oder ein Wort im Fenstertitel und funktionieren so auch für Websites. Läuft mit Gemma 4 (standardmäßig E4B, wahlweise 12B oder E2B) in einem mitgelieferten llama.cpp-Server; das Modell wird einmal heruntergeladen (3 bis 7 GB), danach verlässt nichts deinen PC. Ist das Modell nicht bereit oder zu langsam, wird der reine Whisper-Text eingefügt. Standardmäßig aus
- Mehrere Whisper-Modelle wählbar: tiny → large-v3-turbo, mit Auto-Download bei Auswahl
- Sprachen: Auto-Erkennung oder eine der rund 100 Sprachen, die Whisper kann
- Push-to-Talk **und** Toggle-Modi
- Konfigurierbarer globaler Hotkey, auch Maus-Seitentasten (Maus 4 / Maus 5, allein oder mit Strg/Umschalt/Alt/Win). Eine belegte Seitentaste wird abgefangen und löst in anderen Programmen kein „Zurück“/„Vorwärts“ mehr aus
- Schwebende Aufnahme-Pille mit Live-Wellenform und Cancel-Button
- Auto-Einfügen via Tastatur-Simulation (kompatibel mit allen Anwendungen)
- System-Tray-Icon — X minimiert in den Tray statt Beenden
- Optional: mit Windows-Anmeldung starten
- UI in Deutsch und Englisch

## System-Voraussetzungen

- **OS:** Windows 10/11 x64
- **GPU (empfohlen), nur aktueller Treiber, keine zusätzliche Runtime:**
  - NVIDIA GeForce RTX 20 oder neuer: CUDA (Treiber 525 oder neuer)
  - AMD Radeon RX 6000 oder neuer (AMD Software: Adrenalin Edition): Vulkan
  - Intel Arc und andere Vulkan-1.2-GPUs: Vulkan
- **CPU-Fallback:** Funktioniert auch ohne nutzbare GPU, dann deutlich langsamer (~10-30×). Für CPU-Nutzer: small oder medium Modell empfohlen
- **RAM:** Das gewählte Whisper-Modell bleibt ab dem ersten Diktat resident. `large-v3-turbo` ≈ 1.6 GB, `small` ≈ 500 MB, `tiny` ≈ 80 MB.

## Installation (für Endbenutzer)

Lade die neueste `RudariFlow_x.y.z_x64-setup.exe` aus den [Releases](https://github.com/oggii/RudariFlow/releases) herunter und führe sie aus.

## Entwicklung

### Voraussetzungen

- [Rust](https://rustup.rs/) (MSVC toolchain auf Windows)
- [Node.js](https://nodejs.org/) ≥ 20
- Visual Studio Build Tools mit C++ workload (für `cargo build`)
- [CMake](https://cmake.org/) und [LLVM](https://llvm.org/) (libclang, für das bindgen von `whisper-rs-sys`)
- [Vulkan SDK](https://vulkan.lunarg.com/) (liefert `glslc` für die Vulkan-Shader von whisper.cpp; `VULKAN_SDK` muss gesetzt sein)
- [CUDA Toolkit 12.x](https://developer.nvidia.com/cuda-downloads) (12.8 empfohlen; Compiler und cuBLAS reichen, zum Bauen ist keine NVIDIA-GPU nötig)

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

# 3b. llama.cpp-Server für die KI-Korrektur holen (festgelegter Build, SHA-256 geprüft)
powershell -ExecutionPolicy Bypass -File scripts/setup-llama.ps1

# 4. Build-Pfad kurz halten: der verschachtelte Vulkan-Shader-Build von
#    whisper.cpp sprengt unter src-tauri\target das 260-Zeichen-Limit
$env:CARGO_TARGET_DIR = "C:\t\rf"
$env:CUDAARCHS = "75;80;86;89;120"   # RTX 20, 30, A-Serie, 40, 50

# 5. Dev-Modus starten
npm run tauri dev
```

Ohne CUDA Toolkit lässt sich ein reiner Vulkan-Build bauen:
`npm run tauri dev -- --no-default-features --features vulkan`.

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

- **KI-Korrektur:** [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server` (Release b11100, Vulkan-Build) als eigener Prozess auf 127.0.0.1 mit zufälligem Port und API-Schlüssel, in einem Job-Objekt, das ihn mit RudariFlow beendet; Gemma-4-Modelle (Apache-2.0) von Hugging Face. Ein eigener Prozess ist nötig, weil whisper-rs seine eigene ggml-Kopie in `rudariflow.exe` einbindet
- **Tauri 2** (Rust backend + Webview frontend)
- **Frontend:** Vanilla TypeScript + Vite
- **Audio capture:** [cpal](https://github.com/RustAudio/cpal) (Cross-platform low-level audio I/O)
- **Transkription:** In-Process [`whisper-rs`](https://github.com/tazz4843/whisper-rs) (whisper.cpp Rust-Bindings) gebaut mit `cuda`- und `vulkan`-Feature; das Backend wird zur Laufzeit aus der ggml-Geräteliste gewählt, mit Fallback auf CPU
- **Auto-Paste:** [enigo](https://github.com/enigo-rs/enigo) (Tastatur-Simulation)
- **Hotkey:** [tauri-plugin-global-shortcut](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/global-shortcut)
- **Autostart:** [tauri-plugin-autostart](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/autostart)

## Lizenz / Credits

RudariFlow ist unter der **[MIT-Lizenz](LICENSE)** veröffentlicht — frei zur Nutzung, Modifikation, Weiterverbreitung und Einbindung in proprietäre Projekte, mit Namensnennung.

Basiert auf der initialen Tauri-Vorlage von [albertshiney/typr](https://github.com/albertshiney/typr).
Verwendet [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) für die Transkription.

© 2026 [oggi](https://0ggi.ch).
