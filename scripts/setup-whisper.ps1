# RudariFlow - collect the GPU runtime DLLs bundled next to rudariflow.exe
#
# Run once after cloning the repo (and after changing CUDA versions):
#   powershell -ExecutionPolicy Bypass -File scripts/setup-whisper.ps1
#
# The release build links whisper.cpp with both the CUDA and the Vulkan backend.
# Both are load-time imports of rudariflow.exe, so the installer ships them next
# to the exe. On machines without an NVIDIA GPU (or with a driver older than
# CUDA 13 needs, 580) the CUDA runtime loads, finds no device and RudariFlow
# uses Vulkan or the CPU instead. The AI's CUDA backend (llama\ggml-cuda.dll)
# uses the same DLLs.
#
# Sources:
#   CUDA runtime  - %CUDA_PATH%\bin\x64 (or \bin) of the installed CUDA Toolkit
#                   13.x (falls back to the pinned llama.cpp CUDA 13.4 runtime
#                   zip, the one its ggml-cuda.dll is built against)
#   Vulkan loader - vulkan-1.dll from System32 (Khronos loader, installed with
#                   the Vulkan SDK or any current GPU driver)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$DestDir = Join-Path $RepoRoot "src-tauri\binaries\gpu-runtime"
$FallbackZip = "cudart-llama-bin-win-cuda-13.4-x64.zip"
$FallbackUrl = "https://github.com/ggml-org/llama.cpp/releases/download/b11100/$FallbackZip"
$FallbackSha256 = "738f8c251ac22b70c3ae6f83a10cf222725df0395246a2cf58f32bdb85fbe668"

$CudaDlls = @(
    "cudart64_13.dll",
    "cublas64_13.dll",
    "cublasLt64_13.dll"
)

New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
# The CUDA 12 runtime of builds before 0.11 is no longer used.
Get-ChildItem -Path $DestDir -Filter "*64_12.dll" | Remove-Item -Force

# --- CUDA runtime -------------------------------------------------------------
# CUDA 13 keeps its DLLs in bin\x64, CUDA 12 had them in bin.
$cudaBin = $null
if ($env:CUDA_PATH) {
    $cudaBin = @("bin\x64", "bin") | ForEach-Object { Join-Path $env:CUDA_PATH $_ } |
        Where-Object { $dir = $_; -not ($CudaDlls | Where-Object { -not (Test-Path (Join-Path $dir $_)) }) } |
        Select-Object -First 1
}

if ($cudaBin) {
    foreach ($dll in $CudaDlls) {
        Copy-Item -Path (Join-Path $cudaBin $dll) -Destination $DestDir -Force
    }
    Write-Host "CUDA runtime DLLs copied from $cudaBin" -ForegroundColor Green
} else {
    Write-Host "No CUDA 13 Toolkit found via CUDA_PATH, downloading $FallbackUrl..." -ForegroundColor Cyan
    $Tmp = Join-Path ([IO.Path]::GetTempPath()) $FallbackZip
    Invoke-WebRequest -Uri $FallbackUrl -OutFile $Tmp -UseBasicParsing
    $hash = (Get-FileHash -Path $Tmp -Algorithm SHA256).Hash.ToLower()
    if ($hash -ne $FallbackSha256) {
        throw "SHA-256 mismatch for ${FallbackZip}: got $hash, expected $FallbackSha256"
    }
    $Extract = Join-Path $env:TEMP "rudariflow-cuda-runtime-extract"
    if (Test-Path $Extract) { Remove-Item -Recurse -Force $Extract }
    Expand-Archive -Path $Tmp -DestinationPath $Extract -Force
    foreach ($dll in $CudaDlls) {
        $src = Join-Path $Extract $dll
        if (-not (Test-Path $src)) {
            Write-Error "Expected DLL not found in archive: $dll"
            exit 1
        }
        Copy-Item -Path $src -Destination $DestDir -Force
    }
    Remove-Item $Tmp -Force
    Remove-Item $Extract -Recurse -Force
    Write-Host "CUDA runtime DLLs extracted from the llama.cpp release" -ForegroundColor Green
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
