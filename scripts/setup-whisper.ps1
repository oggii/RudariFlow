# RudariFlow — fetch whisper.cpp prebuilt backends for Windows
#
# Run once after cloning the repo:
#   powershell -ExecutionPolicy Bypass -File scripts/setup-whisper.ps1
#
# Downloads two backends:
#   * cuBLAS 12.4 — NVIDIA GPU acceleration (~436 MB)
#   * CPU        — fallback for AMD / Intel / no-GPU systems (~25 MB)
#
# At runtime RudariFlow auto-detects which backend works on the user's machine.

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$BinRoot = Join-Path $RepoRoot "src-tauri\binaries"

$Backends = @(
    @{
        Name = "whisper-cuda"
        Url = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-cublas-12.4.0-bin-x64.zip"
    },
    @{
        Name = "whisper-cpu"
        Url = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-bin-x64.zip"
    }
)

foreach ($b in $Backends) {
    $Dir = Join-Path $BinRoot $b.Name
    $Cli = Join-Path $Dir "whisper-cli.exe"
    if (Test-Path $Cli) {
        Write-Host "[$($b.Name)] whisper-cli.exe already present — skipping." -ForegroundColor Green
        continue
    }

    $Tmp = [System.IO.Path]::GetTempFileName() + ".zip"
    Write-Host "[$($b.Name)] Downloading $($b.Url)..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $b.Url -OutFile $Tmp -UseBasicParsing

    $Extract = Join-Path $env:TEMP "rudariflow-extract-$($b.Name)"
    if (Test-Path $Extract) { Remove-Item -Recurse -Force $Extract }
    New-Item -ItemType Directory -Path $Extract | Out-Null

    Write-Host "[$($b.Name)] Extracting..." -ForegroundColor Cyan
    Expand-Archive -Path $Tmp -DestinationPath $Extract -Force

    New-Item -ItemType Directory -Path $Dir -Force | Out-Null
    Copy-Item -Path (Join-Path $Extract "Release\*") -Destination $Dir -Recurse -Force

    Remove-Item $Tmp -Force
    Remove-Item $Extract -Recurse -Force

    if (Test-Path $Cli) {
        Write-Host "[$($b.Name)] Installed to $Dir" -ForegroundColor Green
    } else {
        Write-Error "[$($b.Name)] Setup failed — whisper-cli.exe not found after extraction."
        exit 1
    }
}

Write-Host "All backends ready." -ForegroundColor Green
