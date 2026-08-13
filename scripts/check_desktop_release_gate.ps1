[CmdletBinding()]
param(
    [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$PublicRoot,
    [string]$PublicRepository = 'ttttdiva/Event-AutoPin',
    [string]$Base = '',
    [string]$Target = 'HEAD',
    [switch]$FailOnMismatch
)

$ErrorActionPreference = 'Stop'

function Run([string]$Exe, [string[]]$Arguments) {
    $value = @(& $Exe @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "$Exe failed: $($value -join ' ')" }
    return @($value)
}

function ResolveRoot([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "$Label is not a directory: $Path" }
    return [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path).TrimEnd('\', '/')
}

function GitText([string]$Repository, [string]$Revision, [string]$Path) {
    return (Run git @('-C', $Repository, 'show', "${Revision}:$Path")) -join "`n"
}

function JsonVersion([string]$Text, [string]$Path) {
    try { return ([string](ConvertFrom-Json $Text).version).Trim() }
    catch { throw "Unable to parse version from ${Path}: $($_.Exception.Message)" }
}

function PackageVersion([string]$Repository, [string]$Revision) {
    return JsonVersion (GitText $Repository $Revision 'desktop-app/package.json') 'desktop-app/package.json'
}

function TauriVersion([string]$Repository, [string]$Revision) {
    try { return ([string](ConvertFrom-Json (GitText $Repository $Revision 'desktop-app/src-tauri/tauri.conf.json')).package.version).Trim() }
    catch { throw "Unable to parse desktop-app/src-tauri/tauri.conf.json: $($_.Exception.Message)" }
}

function CargoVersion([string]$Repository, [string]$Revision) {
    $cargo = GitText $Repository $Revision 'desktop-app/src-tauri/Cargo.toml'
    if ($cargo -notmatch '(?ms)^\[package\]\s.*?^version\s*=\s*"([^"]+)"') {
        throw 'Unable to parse [package] version from desktop-app/src-tauri/Cargo.toml.'
    }
    return $Matches[1]
}

function DefaultBase([string]$Repository) {
    $upstream = @(& git -C $Repository rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>$null)
    if ($LASTEXITCODE -eq 0 -and $upstream) { return ([string]$upstream[0]).Trim() }
    foreach ($candidate in @('origin/main', 'origin/master', 'HEAD~1')) {
        & git -C $Repository rev-parse --verify --quiet $candidate 2>$null
        if ($LASTEXITCODE -eq 0) { return $candidate }
    }
    throw 'Desktop release comparison base could not be resolved.'
}

function ComparePublicDesktop([string]$Source, [string]$Public, [string]$Revision) {
    $manifestPath = 'scripts/public-sync-manifest.txt'
    $manifestText = GitText $Source $Revision $manifestPath
    $desktopPaths = @($manifestText -split "`r?`n" | ForEach-Object {
        $entry = $_.Trim()
        if (-not $entry -or $entry.StartsWith('#')) { return }
        if ($entry -match '^sha256:[0-9a-fA-F]{64}\s+(.+)$') { $entry = $Matches[1].Trim() }
        if ($entry.StartsWith('desktop-app/')) { $entry }
    } | Sort-Object -Unique)
    if (-not $desktopPaths.Count) { throw 'No desktop paths were found in the public manifest.' }
    $different = @()
    $publicDesktopPaths = @(Run git @('-C', $Public, '-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'desktop-app')) |
        ForEach-Object { ([string]$_).Replace('\', '/') }
    $different += @($publicDesktopPaths | Where-Object { $desktopPaths -notcontains $_ })
    foreach ($path in $desktopPaths) {
        $publicTracked = @(& git -C $Public cat-file -e "HEAD:$path" 2>$null)
        if ($LASTEXITCODE -ne 0) { $different += $path; continue }
        $sourceHash = ([string](Run git @('-C', $Source, 'rev-parse', "$Revision`:$path") | Select-Object -First 1)).Trim()
        $publicHash = ([string](Run git @('-C', $Public, 'rev-parse', "HEAD:$path") | Select-Object -First 1)).Trim()
        if ($sourceHash -ne $publicHash) { $different += $path }
    }
    return @($different)
}

try {
    $source = ResolveRoot $SourceRoot 'SourceRoot'
    if (-not (Test-Path -LiteralPath (Join-Path $source '.git'))) { throw 'SourceRoot must be a Git working tree.' }
    if (-not $Base) { $Base = DefaultBase $source }

    $changed = @(Run git @('-C', $source, '-c', 'core.quotePath=false', 'diff', '--name-only', "$Base..$Target")) |
        ForEach-Object { ([string]$_).Replace('\', '/') }
    $desktopChanged = @($changed | Where-Object {
        $_ -match '^desktop-app/(?:src/|src-tauri/|index\.html$|package(?:-lock)?\.json$|vite\.config\.ts$|tsconfig\.json$)'
    })
    $sourcePackageVersion = PackageVersion $source $Target
    $basePackageVersion = PackageVersion $source $Base
    $sourceTauriVersion = TauriVersion $source $Target
    $sourceCargoVersion = CargoVersion $source $Target
    $mismatches = @()
    if ($sourcePackageVersion -ne $sourceTauriVersion -or $sourcePackageVersion -ne $sourceCargoVersion) {
        $mismatches += "private desktop versions disagree: package=$sourcePackageVersion tauri=$sourceTauriVersion cargo=$sourceCargoVersion"
    }
    if ($desktopChanged.Count) {
        try {
            if ([version]$sourcePackageVersion -le [version]$basePackageVersion) {
                $mismatches += "desktop source changed without a version increase: base=$basePackageVersion target=$sourcePackageVersion"
            }
        } catch {
            $mismatches += "desktop version is not comparable: base=$basePackageVersion target=$sourcePackageVersion"
        }
    }

    $publicSourceChanged = $false
    $latestVersion = ''
    $releaseTag = "desktop-v$sourcePackageVersion"
    $expectedAsset = 'EventAutoPin.exe'
    if ($PublicRoot) {
        $public = ResolveRoot $PublicRoot 'PublicRoot'
        if (-not (Test-Path -LiteralPath (Join-Path $public '.git'))) { throw 'PublicRoot must be a Git working tree.' }
        $expectedRemote = "https://github.com/$PublicRepository.git"
        $publicRemote = ([string](Run git @('-C', $public, 'remote', 'get-url', 'origin') | Select-Object -First 1)).Trim()
        if ($publicRemote -ne $expectedRemote) {
            $mismatches += "public origin mismatch: expected=$expectedRemote actual=$publicRemote"
        }
        $publicVersions = @(
            (PackageVersion $public 'HEAD')
            (TauriVersion $public 'HEAD')
            (CargoVersion $public 'HEAD')
        )
        if (@($publicVersions | Sort-Object -Unique).Count -ne 1) {
            $mismatches += "public desktop versions disagree: $($publicVersions -join ',')"
        }
        if ($publicVersions[0] -ne $sourcePackageVersion) {
            $mismatches += "private/public desktop version mismatch: private=$sourcePackageVersion public=$($publicVersions[0])"
        }
        $sourceDifferences = @(ComparePublicDesktop $source $public $Target)
        $publicSourceChanged = $sourceDifferences.Count -gt 0
        if ($publicSourceChanged) {
            $mismatches += "private/public desktop source mismatch: $($sourceDifferences -join ',')"
        }
        try {
            $latest = ConvertFrom-Json (GitText $public 'HEAD' 'latest.json')
        } catch { throw "Unable to parse public latest.json: $($_.Exception.Message)" }
        $latestVersion = ([string]$latest.desktop.version).Trim()
        $latestUrl = ([string]$latest.desktop.url).Trim()
        if ($latestVersion -ne $sourcePackageVersion) {
            $mismatches += "latest.json desktop version mismatch: source=$sourcePackageVersion latest=$latestVersion"
        }
        $expectedUrl = "https://github.com/$PublicRepository/releases/download/$releaseTag/$expectedAsset"
        if ($latestUrl -ne $expectedUrl) {
            $mismatches += "latest.json desktop URL mismatch: expected=$expectedUrl actual=$latestUrl"
        }
    }

    $ghCommand = Get-Command gh -ErrorAction SilentlyContinue
    if ($ghCommand) {
        $releaseOutput = @(& gh @('api', "repos/$PublicRepository/releases/tags/$releaseTag", '--jq', '.assets[].name') 2>&1)
        if ($LASTEXITCODE -ne 0) {
            $mismatches += "GitHub Release $releaseTag could not be verified: $($releaseOutput -join ' ')"
        } else {
            $assetNames = @($releaseOutput | ForEach-Object { ([string]$_).Trim() })
            if ($assetNames -notcontains $expectedAsset) {
                $mismatches += "GitHub Release $releaseTag is missing $expectedAsset"
            }
        }
    } elseif ($FailOnMismatch) {
        $mismatches += 'gh is required to verify the published desktop release asset'
    }

    "BASE=$Base"
    "TARGET=$Target"
    "DESKTOP_CHANGED=$($desktopChanged.Count -gt 0)"
    "PUBLIC_SOURCE_MISMATCH=$publicSourceChanged"
    "VERSION=$sourcePackageVersion"
    "BASE_VERSION=$basePackageVersion"
    "LATEST_VERSION=$latestVersion"
    "RELEASE_TAG=$releaseTag"
    "EXPECTED_ASSET=$expectedAsset"
    "MISMATCH_COUNT=$($mismatches.Count)"
    if ($desktopChanged.Count) { 'DESKTOP_FILES:'; $desktopChanged | ForEach-Object { "- $_" } }
    if ($mismatches.Count) { 'MISMATCHES:'; $mismatches | ForEach-Object { "- $_" } }
    if ($FailOnMismatch -and $mismatches.Count) { exit 1 }
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
