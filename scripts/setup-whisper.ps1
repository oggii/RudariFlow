# RudariFlow - collect the GPU runtime DLLs bundled next to rudariflow.exe
#
# Run once after cloning the repo (and after changing CUDA versions):
#   powershell -ExecutionPolicy Bypass -File scripts/setup-whisper.ps1
#
# The release build links whisper.cpp with both the CUDA and the Vulkan backend.
# Both are load-time imports of rudariflow.exe, so the installer ships them next
# to the exe. On machines without an NVIDIA GPU the CUDA runtime loads, finds no
# device and RudariFlow uses Vulkan or the CPU instead.
#
# Sources:
#   CUDA runtime  - %CUDA_PATH%\bin of the installed CUDA Toolkit 12.x
#                   (falls back to the whisper.cpp cuBLAS 12.4 release zip)
#   Vulkan loader - vulkan-1.dll from System32 (Khronos loader, installed with
#                   the Vulkan SDK or any current GPU driver)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$DestDir = Join-Path $RepoRoot "src-tauri\binaries\gpu-runtime"
$FallbackUrl = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-cublas-12.4.0-bin-x64.zip"

$CudaDlls = @(
    "cudart64_12.dll",
    "cublas64_12.dll",
    "cublasLt64_12.dll"
)

New-Item -ItemType Directory -Path $DestDir -Force | Out-Null

# --- CUDA runtime -------------------------------------------------------------
$cudaBin = if ($env:CUDA_PATH) { Join-Path $env:CUDA_PATH "bin" } else { $null }
$haveToolkit = $cudaBin -and -not ($CudaDlls | Where-Object { -not (Test-Path (Join-Path $cudaBin $_)) })

if ($haveToolkit) {
    foreach ($dll in $CudaDlls) {
        Copy-Item -Path (Join-Path $cudaBin $dll) -Destination $DestDir -Force
    }
    Write-Host "CUDA runtime DLLs copied from $cudaBin" -ForegroundColor Green
} else {
    Write-Host "No CUDA Toolkit found via CUDA_PATH, downloading $FallbackUrl..." -ForegroundColor Cyan
    $Tmp = [System.IO.Path]::GetTempFileName() + ".zip"
    Invoke-WebRequest -Uri $FallbackUrl -OutFile $Tmp -UseBasicParsing
    $Extract = Join-Path $env:TEMP "rudariflow-cuda-runtime-extract"
    if (Test-Path $Extract) { Remove-Item -Recurse -Force $Extract }
    Expand-Archive -Path $Tmp -DestinationPath $Extract -Force
    foreach ($dll in $CudaDlls) {
        $src = Join-Path $Extract "Release\$dll"
        if (-not (Test-Path $src)) {
            Write-Error "Expected DLL not found in archive: $dll"
            exit 1
        }
        Copy-Item -Path $src -Destination $DestDir -Force
    }
    Remove-Item $Tmp -Force
    Remove-Item $Extract -Recurse -Force
    Write-Host "CUDA runtime DLLs extracted from the whisper.cpp release" -ForegroundColor Green
}

# --- Vulkan loader --------------------------------------------------------------
$vulkanLoader = Join-Path $env:SystemRoot "System32\vulkan-1.dll"
if (-not (Test-Path $vulkanLoader)) {
    Write-Error "vulkan-1.dll not found in System32. Install the Vulkan SDK (https://vulkan.lunarg.com/)."
    exit 1
}
Copy-Item -Path $vulkanLoader -Destination $DestDir -Force
Write-Host "Vulkan loader copied ($((Get-Item $vulkanLoader).VersionInfo.FileVersion))" -ForegroundColor Green

Write-Host "GPU runtime DLLs ready in $DestDir" -ForegroundColor Green
