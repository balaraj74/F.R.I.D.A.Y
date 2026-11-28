# Windows voice installer for FRIDAY (counterpart of setup-local.sh). Safe to re-run.
#   -Part Stt|Tts|All     which half to install (the setup wizard runs them as separate steps)
#   -SttDevice cpu|gpu    cpu: Whisper base.en (smaller); gpu: Whisper small.en + CUDA build
#   -Tts edge|supertonic|none
#   -DryRun               print what would happen, download nothing
# Everything goes under %USERPROFILE%\.friday\voice. Nothing outside it is touched.
# Progress lines for the wizard start with ##  (##PROGRESS 40 text, ##SIZE 142, ##STEP text).
param(
    [ValidateSet('Stt', 'Tts', 'All')][string]$Part = 'All',
    [ValidateSet('cpu', 'gpu')][string]$SttDevice = 'cpu',
    [ValidateSet('edge', 'supertonic', 'none')][string]$Tts = 'edge',
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is much faster without the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocol]::Tls12

$WhisperTag = 'v1.7.6'
$Voice = Join-Path $env:USERPROFILE '.friday\voice'
$Whisper = Join-Path $Voice 'whisper.cpp'
$BinDir = Join-Path $Whisper 'build\bin'
$ModelDir = Join-Path $Whisper 'models'
$Models = Join-Path $Voice 'models'

function Say([string]$text) { Write-Output ('##STEP ' + $text) }
function Pct([int]$n, [string]$text) { Write-Output ('##PROGRESS ' + $n + ' ' + $text) }

function Get-File([string]$url, [string]$dest, [string]$sha256) {
    if ((Test-Path -LiteralPath $dest) -and ((Get-Item -LiteralPath $dest).Length -gt 0)) { return }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    $tmp = $dest + '.part'
    Write-Output ('Downloading ' + $url)
    if ($DryRun) { return }
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $tmp
    if ($sha256) {
        $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $tmp).Hash.ToLowerInvariant()
        if ($got -ne $sha256.ToLowerInvariant()) {
            Remove-Item -LiteralPath $tmp -Force
            throw ('Checksum mismatch for ' + $url)
        }
    }
    Move-Item -LiteralPath $tmp -Destination $dest -Force
}

# SHA-256 from the GitHub release metadata when the publisher provides it ("digest": "sha256:...").
function Get-AssetInfo([string]$namePattern) {
    $rel = Invoke-RestMethod -UseBasicParsing -Uri ('https://api.github.com/repos/ggml-org/whisper.cpp/releases/tags/' + $WhisperTag)
    foreach ($a in $rel.assets) {
        if ($a.name -like $namePattern) {
            $sum = ''
            if ($a.digest -and ($a.digest -like 'sha256:*')) { $sum = $a.digest.Substring(7) }
            return @{ Url = $a.browser_download_url; Sha = $sum; Name = $a.name }
        }
    }
    return $null
}

# Windows PowerShell 5.1 turns any stderr line from a native tool into an error under
# $ErrorActionPreference='Stop'. pip warns on stderr, so run native tools with 'Continue' and check
# $LASTEXITCODE afterwards.
function Invoke-Native([string]$exe, [string[]]$arguments) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $exe @arguments 2>&1 | ForEach-Object { Write-Output ([string]$_) } } finally { $ErrorActionPreference = $old }
}

function Install-Stt {
    Say 'Speech to text (whisper.cpp prebuilt)'
    $server = Join-Path $BinDir 'whisper-server.exe'
    $model = 'ggml-base.en.bin'
    $assetPattern = 'whisper-bin-x64.zip'
    if ($SttDevice -eq 'gpu') { $model = 'ggml-small.en.bin'; $assetPattern = 'whisper-cublas-*-bin-x64.zip' }
    Pct 5 'Looking up the Whisper release'
    if ($DryRun) { Write-Output ('dry run: would install ' + $assetPattern + ' and ' + $model); return }

    if (-not (Test-Path -LiteralPath $server)) {
        $asset = Get-AssetInfo $assetPattern
        if (-not $asset -and $SttDevice -eq 'gpu') { $asset = Get-AssetInfo 'whisper-bin-x64.zip' }
        if (-not $asset) { throw ('No Windows build found in whisper.cpp ' + $WhisperTag) }
        $zip = Join-Path $env:TEMP ('friday-' + $asset.Name)
        Pct 10 'Downloading the Whisper program'
        Get-File $asset.Url $zip $asset.Sha
        $stage = Join-Path $env:TEMP 'friday-whisper-stage'
        if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
        Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force
        $found = Get-ChildItem -LiteralPath $stage -Recurse -Filter 'whisper-server.exe' | Select-Object -First 1
        if (-not $found) { throw 'whisper-server.exe is not in the downloaded Whisper package' }
        New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
        Copy-Item -Path (Join-Path $found.DirectoryName '*') -Destination $BinDir -Recurse -Force
        Remove-Item -LiteralPath $stage -Recurse -Force
        Remove-Item -LiteralPath $zip -Force
    }
    Pct 40 ('Downloading the Whisper model (' + $model + ')')
    Get-File ('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/' + $model) (Join-Path $ModelDir $model) ''
    Pct 80 'Downloading the voice activity models'
    Get-File 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin' (Join-Path $ModelDir 'ggml-silero-v5.1.2.bin') ''
    Get-File 'https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx' (Join-Path $Models 'silero_vad.onnx') ''

    # Tells the HUD which model to load (the Linux layout always uses small.en).
    $meta = @{ model = $model; device = $SttDevice; tag = $WhisperTag } | ConvertTo-Json
    New-Item -ItemType Directory -Force -Path $Voice | Out-Null
    Set-Content -LiteralPath (Join-Path $Voice 'stt.json') -Value $meta -Encoding UTF8
    if (-not (Test-Path -LiteralPath $server)) { throw 'whisper-server.exe was not installed' }
    Pct 100 'Speech to text is ready'
}

function Find-Python {
    foreach ($cmd in @('py', 'python')) {
        $c = Get-Command $cmd -ErrorAction SilentlyContinue
        if ($c) { return $c.Source }
    }
    throw 'Python 3.11 or newer was not found. Run install.ps1 again.'
}

function Install-Supertonic {
    # Only for NVIDIA machines. The venv python is Scripts\python.exe on Windows.
    Say 'Supertonic voice (NVIDIA GPU)'
    $st = Join-Path $Voice 'supertonic'
    $venv = Join-Path $st 'venv'
    $py = Join-Path $venv 'Scripts\python.exe'
    if ($DryRun) { Write-Output ('dry run: would create ' + $venv + ' and install supertonic'); return }
    New-Item -ItemType Directory -Force -Path $st | Out-Null
    if (-not (Test-Path -LiteralPath $py)) {
        Pct 5 'Creating the Python environment'
        $base = Find-Python
        if ((Split-Path -Leaf $base) -like 'py*') { Invoke-Native $base @('-3.11', '-m', 'venv', $venv) } else { Invoke-Native $base @('-m', 'venv', $venv) }
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python virtual environment' }
    }
    Pct 15 'Installing Supertonic (about 400 MB)'
    Invoke-Native $py @('-m', 'pip', 'install', '--quiet', '--upgrade', 'pip')
    Invoke-Native $py @('-m', 'pip', 'install', '--quiet', 'supertonic', 'soundfile')
    if ($LASTEXITCODE -ne 0) { throw 'pip could not install supertonic' }
    Pct 50 'Installing the GPU runtime (about 2 GB)'
    Invoke-Native $py @('-m', 'pip', 'uninstall', '-y', 'onnxruntime') | Out-Null
    Invoke-Native $py @('-m', 'pip', 'install', '--quiet', 'onnxruntime-gpu[cuda,cudnn]')
    if ($LASTEXITCODE -ne 0) { throw 'pip could not install onnxruntime-gpu' }
    Pct 80 'Downloading the voice model'
    $stPath = $st -replace '\\', '/'
    Invoke-Native $py @('-c', ("from supertonic import TTS; TTS(model_dir='" + $stPath + "', auto_download=True)"))
    if ($LASTEXITCODE -ne 0) { throw 'The Supertonic model download failed' }
    Pct 100 'Supertonic is ready'
}

if ($Part -eq 'Stt' -or $Part -eq 'All') {
    if ($Tts -ne 'none') { Install-Stt }
}
if ($Part -eq 'Tts' -or $Part -eq 'All') {
    if ($Tts -eq 'supertonic') { Install-Supertonic }
    elseif ($Tts -eq 'edge') { Say 'Edge voice needs no download (uses node-edge-tts and an internet connection)' }
}
Write-Output 'Voice setup finished.'
