# RudariFlow — fetch whisper.cpp cuBLAS prebuilt for Windows
#
# Run once after cloning the repo:
#   powershell -ExecutionPolicy Bypass -File scripts/setup-whisper.ps1
#
# Downloads ~436 MB. Requires NVIDIA GPU + CUDA-capable driver to actually run
# transcriptions; the build itself doesn't need CUDA installed.

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$BinDir = Join-Path $RepoRoot "src-tauri\binaries\whisper"
$Url = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-cublas-12.4.0-bin-x64.zip"
$Tmp = [System.IO.Path]::GetTempFileName() + ".zip"

if (Test-Path (Join-Path $BinDir "whisper-cli.exe")) {
    Write-Host "whisper-cli.exe already present at $BinDir — skipping download." -ForegroundColor Green
    exit 0
}

Write-Host "Downloading whisper.cpp cuBLAS 12.4 ($Url)..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $Url -OutFile $Tmp -UseBasicParsing

$Extract = Join-Path $env:TEMP "rudariflow-whisper-extract"
if (Test-Path $Extract) { Remove-Item -Recurse -Force $Extract }
New-Item -ItemType Directory -Path $Extract | Out-Null

Write-Host "Extracting..." -ForegroundColor Cyan
Expand-Archive -Path $Tmp -DestinationPath $Extract -Force

New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
Copy-Item -Path (Join-Path $Extract "Release\*") -Destination $BinDir -Recurse -Force

Remove-Item $Tmp -Force
Remove-Item $Extract -Recurse -Force

if (Test-Path (Join-Path $BinDir "whisper-cli.exe")) {
    Write-Host "Done. whisper-cli.exe + DLLs installed to $BinDir" -ForegroundColor Green
} else {
    Write-Error "Setup failed — whisper-cli.exe not found after extraction."
    exit 1
}
