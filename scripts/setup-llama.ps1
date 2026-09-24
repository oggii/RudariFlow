# RudariFlow - fetch the llama.cpp server bundled for AI cleanup
#
# Run once after cloning the repo (and after changing the pinned build):
#   powershell -ExecutionPolicy Bypass -File scripts/setup-llama.ps1
#
# Downloads the pinned llama.cpp Windows Vulkan build, checks its SHA-256 and
# copies the files llama-server needs to src-tauri\binaries\llama\. The
# installer ships them in a llama\ folder next to rudariflow.exe. The server
# runs as its own process: whisper-rs links its own copy of ggml into
# rudariflow.exe, and two copies cannot share one process.
#
# Vulkan runs on AMD, NVIDIA and Intel GPUs with the normal driver; the
# ggml-cpu-*.dll variants cover PCs without a usable GPU. The CUDA backend
# (ggml-cuda.dll from the same tag's CUDA 13.4 build) goes next to them:
# llama-server loads the backends in its folder, so on NVIDIA it offers CUDA
# too, and RudariFlow takes it (Gemma 4 E4B on an RTX 5080: long dictations
# 174 to 186 ms instead of 238 to 279, short ones about as fast). It uses the
# CUDA 13 runtime shipped next to rudariflow.exe for Whisper
# (scripts/setup-whisper.ps1); where CUDA does not load (no NVIDIA card,
# driver older than 580) llama-server keeps Vulkan.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Build = "b11100"
$Zip = "llama-$Build-bin-win-vulkan-x64.zip"
$Sha256 = "2b1af3fb7a5da5b499871782f590b20caa92c3acf917baaab2da99eae9df4e88"
$Url = "https://github.com/ggml-org/llama.cpp/releases/download/$Build/$Zip"
$CudaZip = "llama-$Build-bin-win-cuda-13.4-x64.zip"
$CudaSha256 = "8f562cce3076f595a126f41068abf4798b2471f58d9ed4b04bc3e784e7a9251b"
$CudaUrl = "https://github.com/ggml-org/llama.cpp/releases/download/$Build/$CudaZip"
# The release zip has no llama.cpp licence file; take it from the same tag.
$LicenseUrl = "https://raw.githubusercontent.com/ggml-org/llama.cpp/$Build/LICENSE"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$DestDir = Join-Path $RepoRoot "src-tauri\binaries\llama"
$Work = Join-Path ([IO.Path]::GetTempPath()) "rudariflow-llama-$Build"

$Files = @(
    "llama-server.exe",
    "llama-server-impl.dll",
    "llama-common.dll",
    "llama.dll",
    "mtmd.dll",
    "ggml.dll",
    "ggml-base.dll",
    "ggml-vulkan.dll",
    "libomp.dll",
    "LICENSE-LLVM-OpenMP"
)

New-Item -ItemType Directory -Path $Work -Force | Out-Null
function Get-Sha256($path) { (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLower() }

# A release zip in $Work, downloaded unless already there, SHA-256 checked;
# returns the folder it is unpacked to.
function Get-Pinned($name, $url, $sha256) {
    $path = Join-Path $Work $name
    if (-not (Test-Path $path) -or (Get-Sha256 $path) -ne $sha256) {
        Write-Host "Downloading $name ..."
        Invoke-WebRequest -Uri $url -OutFile $path -UseBasicParsing
    }
    $hash = Get-Sha256 $path
    if ($hash -ne $sha256) {
        throw "SHA-256 mismatch for ${name}: got $hash, expected $sha256"
    }
    $dir = Join-Path $Work ([IO.Path]::GetFileNameWithoutExtension($name))
    if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
    Expand-Archive -Path $path -DestinationPath $dir
    $dir
}

$unpacked = Get-Pinned $Zip $Url $Sha256
$cudaUnpacked = Get-Pinned $CudaZip $CudaUrl $CudaSha256

# Emptied rather than deleted: an Explorer window or a shell in the folder
# would block deleting the folder itself.
New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
Get-ChildItem -Path $DestDir | Remove-Item -Recurse -Force
foreach ($file in $Files) {
    Copy-Item -Path (Join-Path $unpacked $file) -Destination $DestDir
}
Get-ChildItem -Path $unpacked -Filter "ggml-cpu-*.dll" | Copy-Item -Destination $DestDir
Copy-Item -Path (Join-Path $cudaUnpacked "ggml-cuda.dll") -Destination $DestDir
Invoke-WebRequest -Uri $LicenseUrl -OutFile (Join-Path $DestDir "LICENSE-llama.cpp") -UseBasicParsing

$megabytes = (Get-ChildItem $DestDir | Measure-Object -Property Length -Sum).Sum / 1MB
Write-Host ("llama.cpp {0} ready in {1} ({2:N0} MB)" -f $Build, $DestDir, $megabytes) -ForegroundColor Green
