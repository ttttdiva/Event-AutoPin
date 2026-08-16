[CmdletBinding()]
param(
    [string]$OutputName = "EventAutoPin.exe"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-ProjectRoot {
    return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function Assert-DesktopExeNotRunning {
    $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessName -in @('EventAutoPin', 'Event AutoPin')
    })
    if ($running.Count -gt 0) {
        $pids = ($running | ForEach-Object { $_.Id }) -join ', '
        throw "EventAutoPin.exe が起動中です (PID: $pids)。終了してから再ビルドしてください。"
    }
}

function Find-TauriBuiltExe {
    param(
        [Parameter(Mandatory = $true)]
        [string]$DesktopDir
    )

    $releaseDir = Join-Path $DesktopDir "src-tauri\target\release"
    if (-not (Test-Path -LiteralPath $releaseDir -PathType Container)) {
        return $null
    }

    $preferredNames = @(
        "Event AutoPin.exe",
        "EventAutoPin.exe",
        "event-autopin-desktop.exe"
    )
    foreach ($name in $preferredNames) {
        $candidate = Join-Path $releaseDir $name
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return Get-Item -LiteralPath $candidate
        }
    }

    $newest = Get-ChildItem -LiteralPath $releaseDir -Filter *.exe -File |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($null -ne $newest) {
        return $newest
    }
    return $null
}

function Install-BuiltDesktopExe {
    param(
        [Parameter(Mandatory = $true)]
        [System.IO.FileInfo]$Source,
        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    $destinationDir = Split-Path -Parent $Destination
    if (-not (Test-Path -LiteralPath $destinationDir -PathType Container)) {
        throw "配置先ディレクトリが見つかりません: $destinationDir"
    }
    if ($Source.Length -le 0) {
        throw "Tauri build成果物が空です: $($Source.FullName)"
    }

    $temporary = Join-Path $destinationDir (".$OutputName.$PID.tmp")
    try {
        Copy-Item -LiteralPath $Source.FullName -Destination $temporary -Force
        $copied = Get-Item -LiteralPath $temporary
        if ($copied.Length -ne $Source.Length -or $copied.Length -le 0) {
            throw "exeコピー後のサイズ検証に失敗しました"
        }
        Move-Item -LiteralPath $temporary -Destination $Destination -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }

    $installed = Get-Item -LiteralPath $Destination -ErrorAction Stop
    if ($installed.Length -le 0) {
        throw "配置されたexeが空です: $Destination"
    }
    return $installed
}

$projectRoot = Get-ProjectRoot
$desktopDir = Join-Path $projectRoot "desktop-app"
$destination = Join-Path $projectRoot $OutputName

if (-not (Test-Path -LiteralPath $desktopDir -PathType Container)) {
    throw "desktop-app が見つかりません: $desktopDir"
}

Assert-DesktopExeNotRunning

Push-Location $desktopDir
try {
    Write-Host "=== npm install ==="
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install に失敗しました (exit=$LASTEXITCODE)" }

    Write-Host "=== Tauri release build (raw) ==="
    npm run tauri:build:raw
    if ($LASTEXITCODE -ne 0) { throw "Tauri build に失敗しました (exit=$LASTEXITCODE)" }
}
finally {
    Pop-Location
}

$source = Find-TauriBuiltExe -DesktopDir $desktopDir
if ($null -eq $source) {
    $releaseDir = Join-Path $desktopDir "src-tauri\target\release"
    throw @(
        "Tauri build成果物が見つかりません。"
        "release 配下に exe がありません: $releaseDir"
        "debug だけビルドした場合は npm run tauri:build:raw ではなく npm run tauri:build を使ってください。"
    ) -join ' '
}

Write-Host ("=== 配置: {0} -> {1} ===" -f $source.FullName, $destination)
$installed = Install-BuiltDesktopExe -Source $source -Destination $destination
Write-Host ("完了: {0} ({1:N0} bytes, source={2})" -f $installed.FullName, $installed.Length, $source.Name)
