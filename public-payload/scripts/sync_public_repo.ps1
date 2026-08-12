[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$DestinationRoot,
    [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$ExpectedRemote = 'https://github.com/ttttdiva/autocircle.git'
$PayloadName = 'public-payload'

function Run([string]$Exe, [string[]]$Arguments) {
    $value = @(& $Exe @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "$Exe failed: $($value -join ' ')" }
    return @($value)
}

function Root([string]$Path, [string]$Name) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "$Name is not a directory: $Path" }
    return [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path).TrimEnd('\', '/')
}

function SameOrNested([string]$A, [string]$B) {
    return $A.Equals($B, [StringComparison]::OrdinalIgnoreCase) -or
        $A.StartsWith($B + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function HashTree([string]$Root) {
    $result = @{}
    if (-not (Test-Path -LiteralPath $Root)) { return $result }
    Get-ChildItem -LiteralPath $Root -File -Recurse -Force | ForEach-Object {
        $relative = $_.FullName.Substring($Root.Length).TrimStart('\', '/').Replace('\', '/')
        $result[$relative] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }
    return $result
}

function SameHashes($A, $B) {
    if ($A.Count -ne $B.Count) { return $false }
    foreach ($key in $A.Keys) { if (-not $B.ContainsKey($key) -or $A[$key] -ne $B[$key]) { return $false } }
    return $true
}

function TestImageSignature([string]$Path, [byte[]]$Bytes) {
    $extension = [IO.Path]::GetExtension($Path).ToLowerInvariant()
    $isPng = $Bytes.Length -ge 8 -and ([BitConverter]::ToString($Bytes[0..7]) -eq '89-50-4E-47-0D-0A-1A-0A')
    if ($extension -eq '.png') { return $isPng }
    if ($extension -eq '.jpg' -or $extension -eq '.jpeg') { return $Bytes.Length -ge 3 -and $Bytes[0] -eq 0xFF -and $Bytes[1] -eq 0xD8 -and $Bytes[2] -eq 0xFF }
    if ($extension -eq '.gif') {
        if ($Bytes.Length -lt 6) { return $false }
        $header = [Text.Encoding]::ASCII.GetString($Bytes, 0, 6)
        return $header -eq 'GIF87a' -or $header -eq 'GIF89a'
    }
    if ($extension -eq '.webp') {
        return $Bytes.Length -ge 12 -and [Text.Encoding]::ASCII.GetString($Bytes, 0, 4) -eq 'RIFF' -and
            [Text.Encoding]::ASCII.GetString($Bytes, 8, 4) -eq 'WEBP'
    }
    if ($extension -eq '.ico') { return $Bytes.Length -ge 4 -and ([BitConverter]::ToString($Bytes[0..3]) -eq '00-00-01-00') }
    if ($extension -eq '.icns') {
        # The currently reviewed Tauri icon.icns is PNG-encoded despite its suffix; its committed hash is still mandatory.
        return $isPng -or ($Bytes.Length -ge 8 -and [Text.Encoding]::ASCII.GetString($Bytes, 0, 4) -eq 'icns')
    }
    return $false
}

function Scan([string]$Root, [string[]]$Paths, $AssetHashes) {
    $rules = @(
        @{ N='personal user'; P=('ponjo'+'rapi') },
        @{ N='Windows absolute path'; P='(?i)(?<![A-Za-z0-9_])(?!(?:C:[\\/]temp[\\/]result\.zip))\b[A-Z]:[\\/]' },
        @{ N='home path'; P='(?i)/(?:home|Users)/[^/\s"''<>]+/' },
        @{ N='private key'; P=('-----BE'+'GIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----') },
        @{ N='GitHub token'; P=('(?:g'+'hp|github_pat)_[A-Za-z0-9_]{20,}') },
        @{ N='API token'; P=('(?:s'+'k-[A-Za-z0-9_-]{20,}|AI'+'za[0-9A-Za-z_-]{30,}|x'+'ox[baprs]-[A-Za-z0-9-]{10,}|AK'+'IA[0-9A-Z]{16})') },
        @{ N='JWT'; P=('ey'+'J[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}') },
        @{ N='credential assignment'; P="(?im)(?:^|[,;{])\s*(?:[`"']?)(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|bearer|session|cookie)(?:[`"']?)\s*[:=]\s*(?:[`"'](?!\s*(?:none|null|dummy|example|placeholder|changeme)(?:[_-][^`"']*)?[`"'])[^`"'\r\n]{4,}[`"']|(?!\s*(?:none|null|dummy|example|placeholder|changeme)(?:[_-][^\s,;#}\]]*)?(?:\s|[,;#}\]]|$))(?!\s*(?:actual_api_key|downloader\.session)(?:\s|[,;#}\]]|$))[A-Za-z0-9_./+=@-]{8,}(?=\s|[,;#}\]]|$))" },
        @{ N='database URL'; P='(?i)\b(?:postgres(?:ql)?(?:\+[a-z0-9._-]+)?|mysql(?:\+[a-z0-9._-]+)?|mariadb(?:\+[a-z0-9._-]+)?|mongodb(?:\+srv)?|rediss?|mssql(?:\+[a-z0-9._-]+)?|sqlite(?:\+[a-z0-9._-]+)?):/{2,3}[^\s"''<>]+' }
    )
    $badExtensions = '(?i)\.(apk|aab|exe|dll|so|dylib|zip|7z|tar|gz|db|sqlite3?|pem|p12|pfx|key|pyc)$'
    $imageExtensions = '(?i)\.(png|jpe?g|gif|webp|ico|icns)$'
    $findings = @()
    foreach ($relative in $Paths) {
        if ($relative -match $badExtensions) { $findings += "$relative (binary/credential filename)"; continue }
        $file = Join-Path $Root $relative
        $bytes = [IO.File]::ReadAllBytes($file)
        if ($relative -match $imageExtensions) {
            if (-not $AssetHashes.ContainsKey($relative)) { $findings += "$relative (image missing exact SHA256 allowlist)"; continue }
            $actualHash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actualHash -ne $AssetHashes[$relative]) { $findings += "$relative (image SHA256 mismatch)"; continue }
            if (-not (TestImageSignature $relative $bytes)) { $findings += "$relative (invalid image signature)" }
            continue
        }
        if ($AssetHashes.ContainsKey($relative)) { $findings += "$relative (SHA256 allowlist is restricted to image assets)"; continue }
        if ($bytes -contains 0) { $findings += "$relative (binary content)"; continue }
        $text = [Text.Encoding]::UTF8.GetString($bytes)
        foreach ($rule in $rules) { if ([regex]::IsMatch($text, $rule.P)) { $findings += "$relative ($($rule.N))" } }
    }
    return @($findings | Sort-Object -Unique)
}

try {
    $source = Root $SourceRoot 'SourceRoot'; $destination = Root $DestinationRoot 'DestinationRoot'
    if ((SameOrNested $source $destination) -or (SameOrNested $destination $source)) { throw 'SourceRoot and DestinationRoot must be separate, non-nested paths.' }
    if (-not (Test-Path (Join-Path $source '.git') -PathType Container) -or -not (Test-Path (Join-Path $destination '.git') -PathType Container)) { throw 'Both paths must be Git working-tree roots.' }

    $remote = ([string](Run git @('-C',$destination,'remote','get-url','origin') | Select-Object -First 1)).Trim()
    if ($remote -ne $ExpectedRemote) { throw "Destination origin mismatch: $remote" }
    $dirty = @(Run git @('-C',$destination,'status','--porcelain'))
    if ($dirty.Count -gt 0) { throw 'Destination working tree is not clean.' }
    $visibility = ([string](Run gh @('api','repos/ttttdiva/autocircle','--jq','.visibility') | Select-Object -First 1)).Trim()
    if ($visibility -ne 'public') { throw "Destination repository is not confirmed public: $visibility" }
    Run git @('-C',$destination,'fetch','--prune','--quiet','origin') | Out-Null
    $currentBranch = ([string](Run git @('-C',$destination,'rev-parse','--abbrev-ref','HEAD') | Select-Object -First 1)).Trim()
    if ($currentBranch -eq 'HEAD') { throw 'Destination HEAD is detached.' }
    $remoteHead = @(Run git @('-C',$destination,'ls-remote','--symref','origin','HEAD')) | Where-Object { ([string]$_) -match '^ref:\s+refs/heads/([^\s]+)\s+HEAD$' } | Select-Object -First 1
    if (-not $remoteHead -or ([string]$remoteHead) -notmatch '^ref:\s+refs/heads/([^\s]+)\s+HEAD$') { throw 'Destination origin default branch could not be verified.' }
    $defaultBranch = $Matches[1]; $defaultRef = "origin/$defaultBranch"
    if ($currentBranch -ne $defaultBranch) { throw "Destination current branch '$currentBranch' is not origin default branch '$defaultBranch'." }
    $upstream = ([string](Run git @('-C',$destination,'rev-parse','--abbrev-ref','--symbolic-full-name','@{upstream}') | Select-Object -First 1)).Trim()
    if ($upstream -ne $defaultRef) { throw "Destination upstream '$upstream' is not '$defaultRef'." }
    $localHead = ([string](Run git @('-C',$destination,'rev-parse','HEAD') | Select-Object -First 1)).Trim()
    $originHead = ([string](Run git @('-C',$destination,'rev-parse',$defaultRef) | Select-Object -First 1)).Trim()
    if ($localHead -ne $originHead) { throw "Destination HEAD does not match fetched $defaultRef." }

    $manifestPath = 'scripts/public-sync-manifest.txt'
    $tracked = @(Run git @('-C',$source,'ls-tree','-r','--name-only','HEAD')) | ForEach-Object { ([string]$_).Replace('\','/') }
    if ($tracked -notcontains $manifestPath) { throw "$manifestPath must be committed in HEAD." }
    $manifestText = (Run git @('-C',$source,'show',"HEAD:$manifestPath")) -join "`n"
    $entries = @($manifestText -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') })
    $paths = @(); $assetHashes = @{}; $seenPaths = @{}
    foreach ($entry in $entries) {
        if ($entry -match '^sha256:([0-9a-fA-F]{64})\s+(.+)$') {
            $path = $Matches[2].Trim(); $assetHashes[$path] = $Matches[1].ToLowerInvariant()
        } elseif ($entry.StartsWith('sha256:', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Invalid SHA256 manifest entry: $entry"
        } else { $path = $entry }
        if ($seenPaths.ContainsKey($path)) { throw "Duplicate manifest path: $path" }
        $seenPaths[$path] = $true
        $paths += $path
    }
    $paths = @($paths | Sort-Object -Unique)
    if ($paths.Count -eq 0) { throw 'Public manifest is empty.' }
    foreach ($path in $paths) {
        if ([IO.Path]::IsPathRooted($path) -or $path.Contains('\') -or $path.Contains(':') -or
            @($path.Split('/') | Where-Object { $_ -eq '.' -or $_ -eq '..' }).Count -gt 0) { throw "Unsafe manifest path: $path" }
        if ($tracked -notcontains $path) { throw "Manifest path is not committed in HEAD: $path" }
    }

    $temp = Join-Path ([IO.Path]::GetTempPath()) ('caico-public-' + [guid]::NewGuid().ToString('N'))
    $archive = "$temp.tar"; New-Item -ItemType Directory -Path $temp | Out-Null
    try {
        Run git (@('-C',$source,'archive','--format=tar','--output',$archive,'HEAD','--') + $paths) | Out-Null
        Run tar @('-xf',$archive,'-C',$temp) | Out-Null
        $actual = @(Get-ChildItem $temp -File -Recurse | ForEach-Object { $_.FullName.Substring($temp.Length).TrimStart('\','/').Replace('\','/') } | Sort-Object)
        $unexpected = @($actual | Where-Object { $paths -notcontains $_ }); $missing = @($paths | Where-Object { $actual -notcontains $_ })
        if ($unexpected.Count -or $missing.Count) { throw "Archive/manifest mismatch. unexpected=$($unexpected -join ',') missing=$($missing -join ',')" }
        Write-Output "[candidates] $($paths.Count) committed manifest files"
        $paths | ForEach-Object { Write-Output "  INCLUDE $_" }
        Write-Output "[excluded] all uncommitted and all paths absent from exact manifest"
        $findings = @(Scan $temp $paths $assetHashes); Write-Output "[scan] $($findings.Count) findings"; $findings | ForEach-Object { Write-Output "  BLOCK $_" }
        if ($findings.Count) { throw 'Sensitive-data scan failed closed; destination was not changed.' }

        $before = HashTree (Join-Path $destination $PayloadName); $after = HashTree $temp
        $all = @($before.Keys + $after.Keys | Sort-Object -Unique); $changes = @()
        foreach ($p in $all) { if (-not $before.ContainsKey($p)) { $changes += "ADD $p" } elseif (-not $after.ContainsKey($p)) { $changes += "REMOVE $p" } elseif ($before[$p] -ne $after[$p]) { $changes += "CHANGE $p" } }
        Write-Output "[diff] $($changes.Count) changes"; $changes | ForEach-Object { Write-Output "  $_" }
        if (-not $Apply) { Write-Output '[result] dry-run; no destination changes.'; exit 0 }

        $next = Join-Path $destination ('.public-payload.next-' + [guid]::NewGuid().ToString('N'))
        $backup = Join-Path $destination ('.public-payload.backup-' + [guid]::NewGuid().ToString('N'))
        Copy-Item -LiteralPath $temp -Destination $next -Recurse
        if (-not (SameHashes (HashTree $next) $after)) { Remove-Item $next -Recurse -Force; throw 'Staged payload hash verification failed.' }
        $current = Join-Path $destination $PayloadName
        try {
            if (Test-Path $current) { Move-Item $current $backup }
            Move-Item $next $current
            if ($env:CAICO_SYNC_TEST_CORRUPT_AFTER_SWAP -eq '1') { Add-Content -LiteralPath (Get-ChildItem $current -File -Recurse | Select-Object -First 1).FullName -Value 'test-corruption' }
            if (-not (SameHashes (HashTree $current) $after)) { throw 'Installed payload hash verification failed.' }
            if (Test-Path $backup) { Remove-Item $backup -Recurse -Force }
        } catch {
            if (Test-Path $current) { Remove-Item $current -Recurse -Force }
            if (Test-Path $backup) { Move-Item $backup $current }
            if (Test-Path $next) { Remove-Item $next -Recurse -Force }
            throw
        }
        Write-Output '[result] public-payload atomically replaced and hashes verified.'
    } finally { if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }; if (Test-Path $archive) { Remove-Item $archive -Force } }
} catch { Write-Error $_.Exception.Message; exit 1 }
