<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/RudariFlow%20White%20No%20BG.png">
    <img src="assets/RudariFlow%20No%20BG.png" alt="RudariFlow" width="360">
  </picture>
</p>

<p align="center"><em><a href="README.md">English</a> · Deutsch</em></p>

# RudariFlow

Lokale Sprache-zu-Text Diktier-App für Windows, angetrieben von [whisper.cpp](https://github.com/ggml-org/whisper.cpp) mit NVIDIA-GPU-Beschleunigung. Globaler Hotkey, Push-to-Talk oder Toggle-Modus, automatisches Einfügen des transkribierten Texts.

> **v0.4.0 — Windows.** In-Process whisper-rs-Backend mit persistentem Modell, Warmup beim Hotkey-Druck und Streaming-Partial-Transkripten. NVIDIA-GPU für Beschleunigung empfohlen, CPU-Fallback für AMD/Intel/no-GPU. Mac/Linux folgen.

Vollständige Versionshistorie siehe [CHANGELOG.md](CHANGELOG.md).

Made by [oggi](https://0ggi.ch).

## Features

- Lokale Transkription via In-Process whisper-rs — keine Cloud nötig, kein Subprozess pro Diktat
- **Persistentes Modell:** beim ersten Gebrauch einmal geladen und für weitere Diktate wiederverwendet
- **Warmup beim Hotkey-Druck:** PTT-Druck lädt das Modell parallel vor, sodass es bereit ist, sobald du fertig gesprochen hast
- **Streaming-Partial-Transkripte:** Text erscheint im Overlay, sobald Whisper jedes Segment ausgibt
- **Auto-Backend-Erkennung:** NVIDIA CUDA wenn verfügbar, sonst CPU-Fallback
- **Eigenes Vokabular:** Domain-Begriffe (Namen, Fachjargon, Abkürzungen) zur Erkennungs-Steuerung einfügen
- **No-Speech-Erkennung:** stumme Aufnahmen zeigen einen Hinweis statt nichts einzufügen
- **Clipboard-sicheres Einfügen:** dein vorheriger Zwischenablage-Inhalt wird vor dem Auto-Paste gesichert und danach wiederhergestellt
- Mehrere Whisper-Modelle wählbar: tiny → large-v3-turbo, mit Auto-Download bei Auswahl
- Sprachen: Auto-Erkennung oder fest 14 Sprachen (DE, EN, FR, IT, ES, …)
- Push-to-Talk **und** Toggle-Modi
- Konfigurierbarer globaler Hotkey
- Schwebende Aufnahme-Pille mit Live-Wellenform und Cancel-Button
- Auto-Einfügen via Tastatur-Simulation (kompatibel mit allen Anwendungen)
- System-Tray-Icon — X minimiert in den Tray statt Beenden
- Optional: mit Windows-Anmeldung starten
- UI in Deutsch und Englisch

## System-Voraussetzungen

- **OS:** Windows 10/11 x64
- **GPU (empfohlen):** NVIDIA mit CUDA-fähigem Treiber für volle Geschwindigkeit
- **CPU-Fallback:** Funktioniert auch ohne GPU bzw. mit AMD/Intel — dann deutlich langsamer (~10-30×). Für CPU-Nutzer: small oder medium Modell empfohlen
- **Hinweis:** Erstmaliger Lauf je Modell auf neuer GPU JIT-kompiliert CUDA-Kernels (~30-60s einmalig)
- **RAM:** Das gewählte Whisper-Modell bleibt ab dem ersten Diktat resident. `large-v3-turbo` ≈ 1.6 GB, `small` ≈ 500 MB, `tiny` ≈ 80 MB.

## Installation (für Endbenutzer)

Lade die neueste `RudariFlow_x.y.z_x64-setup.exe` aus den [Releases](https://github.com/oggii/RudariFlow/releases) herunter und führe sie aus.

## Entwicklung

### Voraussetzungen

- [Rust](https://rustup.rs/) (MSVC toolchain auf Windows)
- [Node.js](https://nodejs.org/) ≥ 20
- Visual Studio Build Tools mit C++ workload (für `cargo build`)
- CUDA Toolkit 12.x (zum Kompilieren von `whisper-rs` mit dem `cuda`-Feature erforderlich)

### Setup

```powershell
# 1. Repo klonen
git clone https://github.com/oggii/RudariFlow.git
cd RudariFlow

# 2. Frontend-Dependencies
npm install

# 3. CUDA-Runtime-DLLs herunterladen (~80 MB)
powershell -ExecutionPolicy Bypass -File scripts/setup-whisper.ps1

# 4. Dev-Modus starten
npm run tauri dev
```

### Production Build

```powershell
npm run tauri build
```

Erzeugt:
- `src-tauri/target/release/rudariflow.exe` (portable)
- `src-tauri/target/release/bundle/nsis/RudariFlow_x.y.z_x64-setup.exe` (Installer)
- `src-tauri/target/release/bundle/msi/RudariFlow_x.y.z_x64_en-US.msi`

## Architektur

- **Tauri 2** (Rust backend + Webview frontend)
- **Frontend:** Vanilla TypeScript + Vite
- **Audio capture:** [cpal](https://github.com/RustAudio/cpal) (Cross-platform low-level audio I/O)
- **Transkription:** In-Process [`whisper-rs`](https://github.com/tazz4843/whisper-rs) (whisper.cpp Rust-Bindings) mit `cuda`-Feature; Runtime-Fallback auf CPU
- **Auto-Paste:** [enigo](https://github.com/enigo-rs/enigo) (Tastatur-Simulation)
- **Hotkey:** [tauri-plugin-global-shortcut](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/global-shortcut)
- **Autostart:** [tauri-plugin-autostart](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/autostart)

## Lizenz / Credits

RudariFlow ist unter der **[MIT-Lizenz](LICENSE)** veröffentlicht — frei zur Nutzung, Modifikation, Weiterverbreitung und Einbindung in proprietäre Projekte, mit Namensnennung.

Basiert auf der initialen Tauri-Vorlage von [albertshiney/typr](https://github.com/albertshiney/typr).
Verwendet [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) für die Transkription.

© 2026 [oggi](https://0ggi.ch).
