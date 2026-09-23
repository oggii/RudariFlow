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
# ggml-cpu-*.dll variants cover PCs without a usable GPU.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Build = "b11100"
$Zip = "llama-$Build-bin-win-vulkan-x64.zip"
$Sha256 = "2b1af3fb7a5da5b499871782f590b20caa92c3acf917baaab2da99eae9df4e88"
$Url = "https://github.com/ggml-org/llama.cpp/releases/download/$Build/$Zip"
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
$zipPath = Join-Path $Work $Zip

function Get-Sha256($path) { (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLower() }

if (-not (Test-Path $zipPath) -or (Get-Sha256 $zipPath) -ne $Sha256) {
    Write-Host "Downloading $Zip ..."
    Invoke-WebRequest -Uri $Url -OutFile $zipPath -UseBasicParsing
}
$hash = Get-Sha256 $zipPath
if ($hash -ne $Sha256) {
    throw "SHA-256 mismatch for ${Zip}: got $hash, expected $Sha256"
}

$unpacked = Join-Path $Work "unpacked"
if (Test-Path $unpacked) { Remove-Item -Recurse -Force $unpacked }
Expand-Archive -Path $zipPath -DestinationPath $unpacked

if (Test-Path $DestDir) { Remove-Item -Recurse -Force $DestDir }
New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
foreach ($file in $Files) {
    Copy-Item -Path (Join-Path $unpacked $file) -Destination $DestDir
}
Get-ChildItem -Path $unpacked -Filter "ggml-cpu-*.dll" | Copy-Item -Destination $DestDir
Invoke-WebRequest -Uri $LicenseUrl -OutFile (Join-Path $DestDir "LICENSE-llama.cpp") -UseBasicParsing

$megabytes = (Get-ChildItem $DestDir | Measure-Object -Property Length -Sum).Sum / 1MB
Write-Host ("llama.cpp {0} ready in {1} ({2:N0} MB)" -f $Build, $DestDir, $megabytes) -ForegroundColor Green
