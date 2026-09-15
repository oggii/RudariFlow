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
- **Clipboard-sicheres Einfügen:** dein vorheriger Zwischenablage-Inhalt wird vor dem Auto-Paste gesichert und danach wiederhergestellt
- Mehrere Whisper-Modelle wählbar: tiny → large-v3-turbo, mit Auto-Download bei Auswahl
- Sprachen: Auto-Erkennung oder fest 14 Sprachen (DE, EN, FR, IT, ES, …)
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

### Benchmark

```powershell
cd src-tauri
cargo run --release --example bench -- "$env:APPDATA\com.rudariflow.app\ggml-large-v3-turbo.bin" pfad\zu\16khz-mono.wav
```

Misst Modell-Ladezeit und Transkription auf der ersten GPU mit und ohne Flash Attention sowie auf CPU.

## Architektur

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
