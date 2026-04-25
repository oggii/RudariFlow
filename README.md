# RudariFlow

Lokale Sprache-zu-Text Diktier-App für Windows, angetrieben von [whisper.cpp](https://github.com/ggml-org/whisper.cpp) mit NVIDIA-GPU-Beschleunigung. Globaler Hotkey, Push-to-Talk oder Toggle-Modus, automatisches Einfügen des transkribierten Texts.

> **v0.1.0 — Windows + NVIDIA GPU only.** Mac/AMD/Intel-Support folgt in 0.2.0.

Made by [oggi](https://0ggi.ch).

## Features

- Lokale Transkription via whisper.cpp (cuBLAS) — keine Cloud nötig
- NVIDIA-GPU-Beschleunigung (CUDA 12.4)
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
- **GPU:** NVIDIA mit CUDA-fähigem Treiber (für GPU-Beschleunigung)
- **Hinweis:** Erstmaliger Lauf JIT-kompiliert CUDA-Kernels für deine GPU (~30-60s einmalig)

## Installation (für Endbenutzer)

Lade die neueste `RudariFlow_x.y.z_x64-setup.exe` aus den [Releases](https://github.com/oggii/RudariFlow/releases) herunter und führe sie aus.

## Entwicklung

### Voraussetzungen

- [Rust](https://rustup.rs/) (MSVC toolchain auf Windows)
- [Node.js](https://nodejs.org/) ≥ 20
- Visual Studio Build Tools mit C++ workload (für `cargo build`)

### Setup

```powershell
# 1. Repo klonen
git clone https://github.com/oggii/RudariFlow.git
cd RudariFlow

# 2. Frontend-Dependencies
npm install

# 3. whisper.cpp + CUDA-DLLs herunterladen (~436 MB)
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
- **Transcription:** whisper.cpp als externer Sidecar-Prozess (`whisper-cli.exe`), mitgeliefert als Resource
- **Auto-Paste:** [enigo](https://github.com/enigo-rs/enigo) (Tastatur-Simulation)
- **Hotkey:** [tauri-plugin-global-shortcut](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/global-shortcut)
- **Autostart:** [tauri-plugin-autostart](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/autostart)

## Lizenzen / Credits

Basiert auf der initialen Tauri-Vorlage von [albertshiney/typr](https://github.com/albertshiney/typr).
Verwendet [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) für die Transkription.

App © 2026 oggi. Alle Rechte vorbehalten.
