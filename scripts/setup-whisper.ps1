# RudariFlow — fetch CUDA runtime DLLs needed by the in-process whisper-rs build
#
# Run once after cloning the repo:
#   powershell -ExecutionPolicy Bypass -File scripts/setup-whisper.ps1
#
# Downloads the upstream whisper.cpp cuBLAS 12.4 release zip (~436 MB) and
# extracts only the 5 CUDA runtime DLLs RudariFlow needs into
# src-tauri\binaries\cuda-runtime\. The whisper-cli.exe and other binaries
# from the zip are discarded — RudariFlow links whisper-rs in-process.

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$DestDir = Join-Path $RepoRoot "src-tauri\binaries\cuda-runtime"
$Url = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-cublas-12.4.0-bin-x64.zip"

$Required = @(
    "cudart64_12.dll",
    "cublas64_12.dll",
    "cublasLt64_12.dll",
    "nvrtc64_120_0.dll",
    "nvrtc-builtins64_124.dll"
)

$missing = $Required | Where-Object { -not (Test-Path (Join-Path $DestDir $_)) }
if (-not $missing) {
    Write-Host "All CUDA runtime DLLs already present in $DestDir — skipping." -ForegroundColor Green
    return
}

$Tmp = [System.IO.Path]::GetTempFileName() + ".zip"
Write-Host "Downloading $Url..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $Url -OutFile $Tmp -UseBasicParsing

$Extract = Join-Path $env:TEMP "rudariflow-cuda-runtime-extract"
if (Test-Path $Extract) { Remove-Item -Recurse -Force $Extract }
New-Item -ItemType Directory -Path $Extract | Out-Null

Write-Host "Extracting..." -ForegroundColor Cyan
Expand-Archive -Path $Tmp -DestinationPath $Extract -Force

New-Item -ItemType Directory -Path $DestDir -Force | Out-Null

foreach ($dll in $Required) {
    $src = Join-Path $Extract "Release\$dll"
    if (-not (Test-Path $src)) {
        Write-Error "Expected DLL not found in archive: $dll"
        exit 1
    }
    Copy-Item -Path $src -Destination $DestDir -Force
}

Remove-Item $Tmp -Force
Remove-Item $Extract -Recurse -Force

Write-Host "CUDA runtime DLLs installed to $DestDir" -ForegroundColor Green
