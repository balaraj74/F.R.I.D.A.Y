# FRIDAY installer for Windows 11 (PowerShell 5.1 or newer). ASCII only on purpose.
#
#   One line:   irm https://raw.githubusercontent.com/balaraj74/F.R.I.D.A.Y/main/install.ps1 | iex
#   From a clone: powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# What it does (safe to run again; never overwrites %USERPROFILE%\.friday or %USERPROFILE%\friday):
#   1. winget (user scope, no admin): Git, Node 22, Python 3.11, ffmpeg when missing
#   2. pnpm (npm global, in your profile)
#   3. FRIDAY source (clone or update), pnpm install, build
#   4. Start Menu shortcut, then opens the HUD with --setup (the setup wizard asks the rest)
# The installer is unsigned: Windows SmartScreen may warn. Choose "More info", then "Run anyway".
# Log: %USERPROFILE%\.friday\logs\install-<timestamp>.log (no secrets are written to it).
#
# Parameters (when run from a file):  -Dir <folder>  -Branch <name>  -DryRun  -NoLaunch
# With "irm | iex" use environment variables instead: FRIDAY_DIR, FRIDAY_BRANCH, FRIDAY_DRYRUN=1.
param(
    [string]$Dir = '',
    [string]$Branch = '',
    [switch]$DryRun,
    [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocol]::Tls12 } catch { }

$RepoUrl = 'https://github.com/balaraj74/F.R.I.D.A.Y.git'
if (-not $Branch) { if ($env:FRIDAY_BRANCH) { $Branch = $env:FRIDAY_BRANCH } else { $Branch = 'main' } }
if (-not $Dir) { if ($env:FRIDAY_DIR) { $Dir = $env:FRIDAY_DIR } else { $Dir = Join-Path $env:USERPROFILE 'F.R.I.D.A.Y' } }
if ($env:FRIDAY_DRYRUN -eq '1') { $DryRun = $true }
$PnpmVersion = '10.23.0'

$FridayHome = Join-Path $env:USERPROFILE '.friday'
$LogDir = Join-Path $FridayHome 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir ('install-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
$script:CurrentStep = 'starting'

function Log([string]$text) { Add-Content -LiteralPath $LogFile -Value ((Get-Date -Format 'o') + ' ' + $text) -Encoding UTF8 }
function Step([string]$name) { $script:CurrentStep = $name; Write-Host ''; Write-Host ('==> ' + $name) -ForegroundColor Cyan; Log ('STEP ' + $name) }
function Ok([string]$text) { Write-Host ('  OK  ' + $text) -ForegroundColor Green; Log ('ok ' + $text) }
function Warn([string]$text) { Write-Host ('  !   ' + $text) -ForegroundColor Yellow; Log ('warn ' + $text) }

# Run a program, append all its output to the log, throw when it exits with an error.
# Windows PowerShell 5.1 treats native stderr as an error under 'Stop', so use 'Continue' inside.
function Invoke-Logged([string]$exe, [string[]]$arguments, [string]$cwd) {
    if (-not $cwd) { $cwd = (Get-Location).Path }
    Log ('$ ' + $exe + ' ' + ($arguments -join ' '))
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    Push-Location -LiteralPath $cwd
    try {
        & $exe @arguments 2>&1 | ForEach-Object { Add-Content -LiteralPath $LogFile -Value ([string]$_) -Encoding UTF8 }
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
        $ErrorActionPreference = $old
    }
    if ($code -ne 0) { throw ($exe + ' exited with code ' + $code) }
}

# Output of a program as text, or '' when it is missing or fails.
function Get-Output([string]$exe, [string[]]$arguments) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { return ((& $exe @arguments 2>&1 | Out-String).Trim()) } catch { return '' } finally { $ErrorActionPreference = $old }
}

function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $npmBin = Join-Path $env:APPDATA 'npm'
    $env:Path = $machine + ';' + $user + ';' + $npmBin
}

function Has-Command([string]$name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

function Test-Node {
    if (-not (Has-Command 'node')) { return $false }
    $v = Get-Output 'node' @('--version')
    if ($v -match '^v(\d+)\.(\d+)') { return ([int]$Matches[1] -gt 22) -or (([int]$Matches[1] -eq 22) -and ([int]$Matches[2] -ge 19)) }
    return $false
}
function Test-Python {
    foreach ($exe in @('python', 'py')) {
        if (Has-Command $exe) {
            $v = Get-Output $exe @('--version')
            if ($v -match 'Python 3\.(\d+)') { if ([int]$Matches[1] -ge 11) { return $true } }
        }
    }
    return $false
}
function Test-Git { return (Has-Command 'git') }
function Test-Ffmpeg { return (Has-Command 'ffmpeg') }
function Test-Pnpm { return (Has-Command 'pnpm.cmd') }

# winget install in user scope. If the package needs administrator rights, ask first and name it.
function Install-WingetPackage([string]$label, [string]$id, [string]$version) {
    if (-not (Has-Command 'winget')) {
        throw ('winget is not available, so ' + $label + ' cannot be installed automatically. Install "App Installer" from the Microsoft Store, or install ' + $label + ' yourself, then run this again.')
    }
    $common = @('install', '--id', $id, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements')
    $args1 = $common + @('--scope', 'user')
    if ($version) { $args1 = $args1 + @('--version', $version) }
    try {
        Invoke-Logged 'winget' $args1 ''
        return
    } catch {
        Log ('winget user-scope install of ' + $label + ' failed: ' + $_.Exception.Message)
    }
    if ($version) {
        try { Invoke-Logged 'winget' ($common + @('--scope', 'user')) ''; return } catch { Log ('retry without version failed: ' + $_.Exception.Message) }
    }
    # Last resort: the package may need administrator rights. Ask before elevating.
    $answer = ''
    if ([Environment]::UserInteractive) {
        $answer = Read-Host ('  ' + $label + ' could not be installed without administrator rights. Allow Windows to ask for them? (y/N)')
    }
    if ($answer -notmatch '^[yY]') { throw ($label + ' needs administrator rights and was not installed. Install it yourself, then run this again.') }
    Invoke-Logged 'winget' $common ''
}

function Ensure-Tool([string]$label, [scriptblock]$test, [string]$id, [string]$version) {
    if (& $test) { Ok ($label + ' already installed'); return }
    if ($DryRun) { Warn ('dry run: would install ' + $label + ' with winget (' + $id + ')'); return }
    Write-Host ('  Installing ' + $label + '...')
    Install-WingetPackage $label $id $version
    Update-SessionPath
    if (-not (& $test)) { throw ($label + ' was installed but is not on PATH yet. Open a new PowerShell window and run this again.') }
    Ok ($label + ' installed')
}

try {
    Write-Host 'FRIDAY installer for Windows' -ForegroundColor Cyan
    Write-Host ('Log file: ' + $LogFile)
    if ($DryRun) { Write-Host 'Dry run: nothing will be installed or downloaded.' -ForegroundColor Yellow }
    Log ('PowerShell ' + $PSVersionTable.PSVersion.ToString() + ', profile ' + $env:USERPROFILE)
    Update-SessionPath

    Step 'Prerequisites (Git, Node 22, Python 3.11, ffmpeg)'
    Ensure-Tool 'Git' { Test-Git } 'Git.Git' ''
    Ensure-Tool 'Node.js 22' { Test-Node } 'OpenJS.NodeJS' '22.19.0'
    Ensure-Tool 'Python 3.11' { Test-Python } 'Python.Python.3.11' ''
    Ensure-Tool 'ffmpeg' { Test-Ffmpeg } 'Gyan.FFmpeg' ''

    Step 'pnpm'
    if (Test-Pnpm) { Ok 'pnpm already installed' }
    elseif ($DryRun) { Warn ('dry run: would run npm install -g pnpm@' + $PnpmVersion) }
    else {
        Invoke-Logged 'npm.cmd' @('install', '-g', ('pnpm@' + $PnpmVersion)) ''
        Update-SessionPath
        if (-not (Test-Pnpm)) { throw 'pnpm was installed but is not on PATH. Open a new PowerShell window and run this again.' }
        Ok 'pnpm installed'
    }

    Step 'FRIDAY source'
    $root = ''
    if ($PSScriptRoot -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'package.json')) -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'friday-hud'))) {
        $root = $PSScriptRoot
        Ok ('using the clone this script is in: ' + $root)
    } elseif (Test-Path -LiteralPath (Join-Path $Dir '.git')) {
        $root = $Dir
        if ($DryRun) { Warn ('dry run: would update ' + $root) }
        else {
            try { Invoke-Logged 'git' @('-C', $Dir, 'pull', '--ff-only') ''; Ok ('updated ' + $root) }
            catch { Warn ('could not update ' + $root + ' (local changes?); using it as it is') }
        }
    } else {
        $root = $Dir
        if ($DryRun) { Warn ('dry run: would clone ' + $RepoUrl + ' into ' + $root) }
        else {
            Invoke-Logged 'git' @('clone', '--depth', '1', '--branch', $Branch, $RepoUrl, $Dir) ''
            Ok ('cloned into ' + $root)
        }
    }

    Step 'Install dependencies and build (a few minutes the first time)'
    if ($DryRun) { Warn 'dry run: would run pnpm install --frozen-lockfile, pnpm build and the HUD build' }
    else {
        Invoke-Logged 'pnpm.cmd' @('install', '--frozen-lockfile') $root
        Ok 'dependencies installed'
        Invoke-Logged 'pnpm.cmd' @('build') $root
        Ok 'FRIDAY built'
        Invoke-Logged 'pnpm.cmd' @('build') (Join-Path $root 'friday-hud')
        Ok 'HUD built'
    }

    Step 'Start Menu shortcut'
    $hudDir = Join-Path $root 'friday-hud'
    $electron = Join-Path $hudDir 'node_modules\electron\dist\electron.exe'
    if ($DryRun) { Warn 'dry run: would create the Start Menu shortcut' }
    elseif (-not (Test-Path -LiteralPath $electron)) { throw ('The HUD program was not found at ' + $electron) }
    else {
        $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
        $lnk = Join-Path $programs 'FRIDAY.lnk'
        $shell = New-Object -ComObject WScript.Shell
        $sc = $shell.CreateShortcut($lnk)
        $sc.TargetPath = $electron
        $sc.Arguments = '"' + $hudDir + '"'
        $sc.WorkingDirectory = $hudDir
        $sc.Description = 'FRIDAY, your personal AI companion'
        $sc.Save()
        Ok ('shortcut: ' + $lnk)
    }

    Step 'Open FRIDAY setup'
    if ($DryRun -or $NoLaunch) { Warn 'not launching (dry run or -NoLaunch)' }
    else {
        Start-Process -FilePath $electron -ArgumentList @(('"' + $hudDir + '"'), '--setup') -WorkingDirectory $hudDir
        Ok 'the setup screen is opening'
    }
    Write-Host ''
    Write-Host 'Done. Your data in .friday and friday was not touched.' -ForegroundColor Green
    Write-Host ('Log: ' + $LogFile)
} catch {
    $reason = $_.Exception.Message
    Log ('FAILED at step "' + $script:CurrentStep + '": ' + $reason)
    Write-Host ''
    Write-Host ('Installation stopped at: ' + $script:CurrentStep) -ForegroundColor Red
    Write-Host ('Reason: ' + $reason) -ForegroundColor Red
    Write-Host ('The full output is in: ' + $LogFile)
    Write-Host 'You can run the same command again; finished steps are skipped.'
    if ($PSCommandPath) { exit 1 }
}
