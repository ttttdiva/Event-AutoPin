[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$DestinationRoot,
    [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$ExpectedRemote = 'https://github.com/ttttdiva/Event-AutoPin.git'
$ExpectedRepository = 'ttttdiva/Event-AutoPin'
$LegacyPayloadName = 'public-payload'
$TransactionPrefix = '.event-autopin-sync.'
$DependencyChecker = 'scripts/check_public_dependency_closure.py'

function Run([string]$Exe, [string[]]$Arguments) {
    $value = @(& $Exe @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "$Exe failed: $($value -join ' ')" }
    return @($value)
}

# `git archive` currently does not expose the --pathspec-from-file options that
# are available on commands such as git add and git checkout.  Keep the probe in
# one place so a future Git version can opt in without making the normal path
# invocation depend on a command-line-size assumption.
function SupportsArchivePathspecFile([string]$Repository) {
    $help = @(& git @('-C', $Repository, 'archive', '-h') 2>&1)
    $text = ($help -join "`n")
    return $text -match '(?m)--pathspec-from-file(?:[= <])' -and
        $text -match '(?m)--pathspec-file-nul(?:\s|$)'
}

function LiteralPathspec([string]$Path) {
    # Manifest entries are exact repository paths.  Literal magic prevents a
    # filename containing `*`, `?`, `[`, a leading `!`, or a leading `:` from
    # being interpreted as a Git glob/pathspec expression.
    return ":(literal)$Path"
}

function NewArchivePathspecFile([string]$Path, [string[]]$Pathspecs) {
    # A BOM would be interpreted as part of the first path by Git.  NUL is used
    # as the separator so spaces and other non-newline characters remain exact;
    # manifest parsing itself rejects newline-containing entries.
    $utf8NoBom = [Text.UTF8Encoding]::new($false)
    $content = (($Pathspecs -join [char]0) + [char]0)
    [IO.File]::WriteAllText($Path, $content, $utf8NoBom)
}

function ExtractArchive([string]$Archive, [string]$Destination) {
    # Windows' inbox tar.exe decodes Git's UTF-8 pax names using the active code
    # page and can fail with "Invalid empty pathname" for Japanese paths.  Git's
    # ZIP writer records UTF-8 names, and Expand-Archive preserves them without
    # invoking an external tar implementation.
    try {
        Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
    } catch {
        throw "Expand-Archive failed: $($_.Exception.Message)"
    }
}

function SplitArchivePathspecs([string[]]$Pathspecs) {
    # cmd.exe (and a number of Git-for-Windows launchers) impose an ~8K command
    # line limit even though CreateProcess accepts more.  Leave headroom for
    # -C/source, output and fixed git archive arguments.  A path longer than the
    # budget is rejected rather than silently falling back to a broad archive.
    $maxArgumentChars = 6000
    $fixedChars = 256
    $chunks = @()
    $chunk = @()
    $length = $fixedChars
    foreach ($pathspec in $Pathspecs) {
        $nextLength = $length + $pathspec.Length + 1
        if ($chunk.Count -gt 0 -and $nextLength -gt $maxArgumentChars) {
            $chunks += ,@($chunk)
            $chunk = @()
            $length = $fixedChars
            $nextLength = $length + $pathspec.Length + 1
        }
        if ($nextLength -gt $maxArgumentChars) {
            throw "Manifest path is too long for a safe git archive invocation: $pathspec"
        }
        $chunk += $pathspec
        $length = $nextLength
    }
    if ($chunk.Count -gt 0) { $chunks += ,@($chunk) }
    return @($chunks)
}

function ArchiveManifest([string]$Repository, [string]$Archive, [string]$TempRoot, [string[]]$Paths) {
    $pathspecs = @($Paths | ForEach-Object { LiteralPathspec $_ })
    $pathspecFile = "$TempRoot.pathspec"
    $archiveFiles = @()
    try {
        NewArchivePathspecFile $pathspecFile $pathspecs
        if (SupportsArchivePathspecFile $Repository) {
            # Keep this branch for Git implementations that add the options in
            # the future.  The NUL-delimited file is UTF-8/no-BOM and therefore
            # safe for spaces, Unicode, and pathspec metacharacters.
            $archiveFiles += $Archive
            Run git @('-C', $Repository, 'archive', '--format=zip', '--output', $Archive,
                "--pathspec-from-file=$pathspecFile", '--pathspec-file-nul', 'HEAD') | Out-Null
        } else {
            # Git 2.50 (including the current Git for Windows) rejects those
            # options for archive.  Archive bounded literal-pathspec chunks;
            # each invocation stays below cmd.exe's limit while preserving the
            # exact-manifest behavior of the original single invocation.
            $chunks = @(SplitArchivePathspecs $pathspecs)
            $archiveIndex = 0
            foreach ($chunk in $chunks) {
                $chunkArchive = if ($archiveIndex -eq 0) { $Archive } else { "$TempRoot-$archiveIndex.zip" }
                $archiveFiles += $chunkArchive
                Run git (@('-C', $Repository, 'archive', '--format=zip', '--output', $chunkArchive,
                    'HEAD', '--') + $chunk) | Out-Null
                $archiveIndex++
            }
        }
        foreach ($archiveFile in $archiveFiles) {
                ExtractArchive $archiveFile $TempRoot
        }
    } finally {
        if (Test-Path -LiteralPath $pathspecFile) { Remove-Item -LiteralPath $pathspecFile -Force }
        foreach ($archiveFile in $archiveFiles) {
            if (Test-Path -LiteralPath $archiveFile) { Remove-Item -LiteralPath $archiveFile -Force }
        }
    }
}

function Root([string]$Path, [string]$Name) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "$Name is not a directory: $Path" }
    return [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path).TrimEnd('\', '/')
}

function SameOrNested([string]$A, [string]$B) {
    return $A.Equals($B, [StringComparison]::OrdinalIgnoreCase) -or
        $A.StartsWith($B + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Sha256Hash([string]$Path) {
    # Use the .NET primitives directly so hashing remains available in both
    # Windows PowerShell 5.1 and PowerShell 7, even when the utility module is
    # not installed or auto-loaded. FileStream takes the path literally (no
    # wildcard expansion) and accepts the extended paths used by long trees.
    $stream = $null
    $algorithm = $null
    try {
        $stream = [System.IO.FileStream]::new(
            $Path,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read,
            4096,
            [System.IO.FileOptions]::SequentialScan
        )
        $algorithm = [System.Security.Cryptography.SHA256]::Create()
        $bytes = $algorithm.ComputeHash($stream)
        # BitConverter emits the same uppercase hex representation as the
        # previous hash implementation; callers that compare manifest entries
        # normalize to lowercase explicitly.
        return [BitConverter]::ToString($bytes).Replace('-', '').ToUpperInvariant()
    } finally {
        if ($null -ne $algorithm) { $algorithm.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function HashTree([string]$Root) {
    $result = @{}
    if (-not (Test-Path -LiteralPath $Root)) { return $result }
    Get-ChildItem -LiteralPath $Root -File -Recurse -Force | ForEach-Object {
        $relative = $_.FullName.Substring($Root.Length).TrimStart('\', '/').Replace('\', '/')
        $result[$relative] = Sha256Hash $_.FullName
    }
    return $result
}

function SameHashes($A, $B) {
    if ($A.Count -ne $B.Count) { return $false }
    foreach ($key in $A.Keys) { if (-not $B.ContainsKey($key) -or $A[$key] -ne $B[$key]) { return $false } }
    return $true
}

function HashPaths([string]$Root, [string[]]$Paths) {
    $result = @{}
    foreach ($relative in $Paths) {
        $file = Join-Path $Root $relative
        if (Test-Path -LiteralPath $file -PathType Leaf) {
            $result[$relative] = Sha256Hash $file
        }
    }
    return $result
}

function IsProtectedRootPath([string]$Path) {
    $normalized = $Path.Replace('\', '/').TrimStart('/')
    $first = @($normalized.Split('/'))[0]
    return $normalized.Equals('latest.json', [StringComparison]::OrdinalIgnoreCase) -or
        $first.Equals('.git', [StringComparison]::OrdinalIgnoreCase) -or
        $first.Equals('.github', [StringComparison]::OrdinalIgnoreCase) -or
        $first.Equals('release', [StringComparison]::OrdinalIgnoreCase) -or
        $first.Equals('releases', [StringComparison]::OrdinalIgnoreCase) -or
        $first.Equals($LegacyPayloadName, [StringComparison]::OrdinalIgnoreCase) -or
        $first.StartsWith($TransactionPrefix, [StringComparison]::OrdinalIgnoreCase)
}

function AssertSafeManagedPath([string]$Path, [string]$Label) {
    if ([IO.Path]::IsPathRooted($Path) -or $Path.Contains('\') -or $Path.Contains(':') -or
        @($Path.Split('/') | Where-Object { $_ -eq '.' -or $_ -eq '..' }).Count -gt 0) {
        throw "Unsafe $Label path: $Path"
    }
    if (IsProtectedRootPath $Path) { throw "Protected root path cannot be managed by ${Label}: $Path" }
}

function ReadManifestPaths([string]$Text, [string]$Label) {
    $paths = @()
    $seen = @{}
    $entries = @($Text -split "`r?`n" | ForEach-Object { $_.Trim() } |
        Where-Object { $_ -and -not $_.StartsWith('#') })
    foreach ($entry in $entries) {
        if ($entry -match '^sha256:([0-9a-fA-F]{64})\s+(.+)$') {
            $path = $Matches[2].Trim()
        } elseif ($entry.StartsWith('sha256:', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Invalid SHA256 entry in ${Label}: $entry"
        } else {
            $path = $entry
        }
        AssertSafeManagedPath $path $Label
        if ($seen.ContainsKey($path)) { throw "Duplicate path in ${Label}: $path" }
        $seen[$path] = $true
        $paths += $path
    }
    if ($paths.Count -eq 0) { throw "$Label is empty." }
    return @($paths | Sort-Object -Unique)
}

function RemoveEmptyParents([string]$Path, [string]$Boundary) {
    $directory = Split-Path -Parent $Path
    while ($directory -and -not $directory.Equals($Boundary, [StringComparison]::OrdinalIgnoreCase)) {
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) { break }
        if (@(Get-ChildItem -LiteralPath $directory -Force).Count -gt 0) { break }
        Remove-Item -LiteralPath $directory -Force
        $directory = Split-Path -Parent $directory
    }
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
            $actualHash = (Sha256Hash $file).ToLowerInvariant()
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
    $pushRemote = ([string](Run git @('-C',$destination,'remote','get-url','--push','origin') | Select-Object -First 1)).Trim()
    if ($pushRemote -ne $ExpectedRemote) { throw "Destination push URL mismatch: $pushRemote" }
    $dirty = @(Run git @('-C',$destination,'status','--porcelain'))
    if ($dirty.Count -gt 0) { throw 'Destination working tree is not clean.' }
    $visibility = ([string](Run gh @('api',"repos/$ExpectedRepository",'--jq','.visibility') | Select-Object -First 1)).Trim()
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
    # Disable Git's C-style quoting so committed Unicode filenames remain the
    # exact manifest paths that are later passed to git archive.
    $tracked = @(Run git @('-C',$source,'-c','core.quotePath=false','ls-tree','-r','--name-only','HEAD')) | ForEach-Object { ([string]$_).Replace('\','/') }
    if ($tracked -notcontains $manifestPath) { throw "$manifestPath must be committed in HEAD." }
    $manifestText = (Run git @('-C',$source,'show',"HEAD:$manifestPath")) -join "`n"
    # Preserve the native path-safety diagnostics before invoking the deeper
    # Python module-closure checker.
    ReadManifestPaths $manifestText 'manifest' | Out-Null
    if ($tracked -notcontains $DependencyChecker) {
        throw "$DependencyChecker must be committed in HEAD."
    }
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if (-not $pythonCommand) { $pythonCommand = Get-Command python3 -ErrorAction SilentlyContinue }
    if (-not $pythonCommand) {
        throw 'Python 3 is required for the fail-closed public dependency gate.'
    }
    $checkerTemp = Join-Path ([IO.Path]::GetTempPath()) ('event-autopin-checker-' + [guid]::NewGuid().ToString('N'))
    $checkerArchive = "$checkerTemp.zip"
    New-Item -ItemType Directory -Path $checkerTemp | Out-Null
    try {
        # Execute the checker bytes committed at the same revision as the
        # manifest and sources.  A modified working-tree checker must never be
        # able to approve a dependency omission from HEAD.
        ArchiveManifest $source $checkerArchive $checkerTemp @($DependencyChecker)
        $committedChecker = Join-Path $checkerTemp $DependencyChecker
        if (-not (Test-Path -LiteralPath $committedChecker -PathType Leaf)) {
            throw "$DependencyChecker could not be extracted from HEAD."
        }
        $dependencyOutput = @(& $pythonCommand.Source $committedChecker `
            '--repository' $source '--revision' 'HEAD' '--manifest' $manifestPath 2>&1)
        $dependencyExit = $LASTEXITCODE
        $dependencyOutput | ForEach-Object { Write-Output ([string]$_) }
        if ($dependencyExit -ne 0) {
            throw 'Public dependency closure failed closed; destination was not changed.'
        }
    } finally {
        if (Test-Path -LiteralPath $checkerTemp) { Remove-Item -LiteralPath $checkerTemp -Recurse -Force }
    }
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
    if ($paths -notcontains $manifestPath) {
        throw "$manifestPath must include itself so the destination keeps its exact managed-file manifest."
    }
    foreach ($path in $paths) {
        AssertSafeManagedPath $path 'manifest'
        if ($tracked -notcontains $path) { throw "Manifest path is not committed in HEAD: $path" }
    }

    $destinationTracked = @(Run git @('-C',$destination,'-c','core.quotePath=false','ls-tree','-r','--name-only','HEAD')) |
        ForEach-Object { ([string]$_).Replace('\','/') }
    $rootManifestPath = $manifestPath
    $legacyManifestPath = "$LegacyPayloadName/$manifestPath"
    $oldPaths = @()
    $legacyMigration = $false
    if (($destinationTracked -contains $rootManifestPath) -and ($destinationTracked -contains $legacyManifestPath)) {
        throw 'Destination contains both root and legacy public manifests; refusing an ambiguous migration.'
    }
    if ($destinationTracked -contains $legacyManifestPath) {
        $legacyManifestText = (Run git @('-C',$destination,'show',"HEAD:$legacyManifestPath")) -join "`n"
        $oldPaths = @(ReadManifestPaths $legacyManifestText 'legacy manifest')
        $legacyTracked = @($destinationTracked | Where-Object { $_.StartsWith("$LegacyPayloadName/") } |
            ForEach-Object { $_.Substring($LegacyPayloadName.Length + 1) } | Sort-Object -Unique)
        $legacyMissing = @($oldPaths | Where-Object { $legacyTracked -notcontains $_ })
        $legacyExtra = @($legacyTracked | Where-Object { $oldPaths -notcontains $_ })
        if ($legacyMissing.Count -or $legacyExtra.Count) {
            throw "Legacy payload/manifest mismatch. extra=$($legacyExtra -join ',') missing=$($legacyMissing -join ',')"
        }
        $legacyMigration = $true
    } elseif ($destinationTracked -contains $rootManifestPath) {
        $oldManifestText = (Run git @('-C',$destination,'show',"HEAD:$rootManifestPath")) -join "`n"
        $oldPaths = @(ReadManifestPaths $oldManifestText 'destination manifest')
    } elseif (Test-Path -LiteralPath (Join-Path $destination $LegacyPayloadName)) {
        throw 'Legacy public-payload exists without a committed exact manifest.'
    }

    $temp = Join-Path ([IO.Path]::GetTempPath()) ('event-autopin-public-' + [guid]::NewGuid().ToString('N'))
    $archive = "$temp.zip"; New-Item -ItemType Directory -Path $temp | Out-Null
    try {
        ArchiveManifest $source $archive $temp $paths
        $actual = @(Get-ChildItem $temp -File -Recurse | ForEach-Object { $_.FullName.Substring($temp.Length).TrimStart('\','/').Replace('\','/') } | Sort-Object)
        $unexpected = @($actual | Where-Object { $paths -notcontains $_ }); $missing = @($paths | Where-Object { $actual -notcontains $_ })
        if ($unexpected.Count -or $missing.Count) { throw "Archive/manifest mismatch. unexpected=$($unexpected -join ',') missing=$($missing -join ',')" }
        Write-Output "[candidates] $($paths.Count) committed manifest files"
        $paths | ForEach-Object { Write-Output "  INCLUDE $_" }
        Write-Output "[excluded] all uncommitted and all paths absent from exact manifest"
        $findings = @(Scan $temp $paths $assetHashes); Write-Output "[scan] $($findings.Count) findings"; $findings | ForEach-Object { Write-Output "  BLOCK $_" }
        if ($findings.Count) { throw 'Sensitive-data scan failed closed; destination was not changed.' }

        $legacyRoot = Join-Path $destination $LegacyPayloadName
        if ($legacyMigration) {
            $before = HashTree $legacyRoot
            Write-Output '[migration] validated legacy public-payload; it will be replaced by manifest files at repository root.'
        } else {
            $before = HashPaths $destination @($oldPaths + $paths | Sort-Object -Unique)
        }
        $after = HashTree $temp
        $all = @($before.Keys + $after.Keys | Sort-Object -Unique); $changes = @()
        foreach ($p in $all) { if (-not $before.ContainsKey($p)) { $changes += "ADD $p" } elseif (-not $after.ContainsKey($p)) { $changes += "REMOVE $p" } elseif ($before[$p] -ne $after[$p]) { $changes += "CHANGE $p" } }
        Write-Output "[diff] $($changes.Count) changes"; $changes | ForEach-Object { Write-Output "  $_" }
        if (-not $Apply) { Write-Output '[result] dry-run; no destination changes.'; exit 0 }

        $transactionId = [guid]::NewGuid().ToString('N')
        $next = Join-Path $destination ($TransactionPrefix + 'next-' + $transactionId)
        $backup = Join-Path $destination ($TransactionPrefix + 'backup-' + $transactionId)
        $rootBackup = Join-Path $backup 'root'
        New-Item -ItemType Directory -Path $next | Out-Null
        Get-ChildItem -LiteralPath $temp -Force | Copy-Item -Destination $next -Recurse -Force
        if (-not (SameHashes (HashTree $next) $after)) { Remove-Item $next -Recurse -Force; throw 'Staged root hash verification failed.' }

        $affectedPaths = @($oldPaths + $paths | Sort-Object -Unique)
        foreach ($relative in $affectedPaths) {
            $target = Join-Path $destination $relative
            if (Test-Path -LiteralPath $target -PathType Container) { throw "Managed file path collides with a directory: $relative" }
            $parent = Split-Path -Parent $target
            while ($parent -and -not $parent.Equals($destination, [StringComparison]::OrdinalIgnoreCase)) {
                if (Test-Path -LiteralPath $parent -PathType Leaf) { throw "Managed file parent collides with a file: $relative" }
                $parent = Split-Path -Parent $parent
            }
        }

        $latestPath = Join-Path $destination 'latest.json'
        if (Test-Path -LiteralPath $latestPath -PathType Container) { throw 'Protected latest.json is unexpectedly a directory.' }
        $latestExisted = Test-Path -LiteralPath $latestPath -PathType Leaf
        $latestHash = if ($latestExisted) { Sha256Hash $latestPath } else { $null }
        $movedPaths = @()
        $installedPaths = @()
        $legacyMoved = $false
        $preserveBackup = $false
        try {
            if ($env:EVENT_AUTOPIN_SYNC_TEST_FAIL_PRE_SWAP -eq '1' -or $env:CAICO_SYNC_TEST_FAIL_PRE_SWAP -eq '1') { throw 'test pre-swap failure' }
            New-Item -ItemType Directory -Path $rootBackup -Force | Out-Null
            foreach ($relative in $affectedPaths) {
                $target = Join-Path $destination $relative
                if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { continue }
                $backupFile = Join-Path $rootBackup $relative
                New-Item -ItemType Directory -Path (Split-Path -Parent $backupFile) -Force | Out-Null
                Move-Item -LiteralPath $target -Destination $backupFile
                $movedPaths += $relative
            }
            if ($legacyMigration) {
                $legacyBackup = Join-Path $backup $LegacyPayloadName
                Move-Item -LiteralPath $legacyRoot -Destination $legacyBackup
                $legacyMoved = $true
            }
            foreach ($relative in $paths) {
                $stagedFile = Join-Path $next $relative
                $target = Join-Path $destination $relative
                New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
                Move-Item -LiteralPath $stagedFile -Destination $target
                $installedPaths += $relative
            }
            # Keep the legacy test switch for compatibility with existing harnesses while
            # exposing the Event AutoPin name to new callers.
            if ($env:EVENT_AUTOPIN_SYNC_TEST_CORRUPT_AFTER_SWAP -eq '1' -or $env:CAICO_SYNC_TEST_CORRUPT_AFTER_SWAP -eq '1') {
                Add-Content -LiteralPath (Join-Path $destination $installedPaths[0]) -Value 'test-corruption'
            }
            if (-not (SameHashes (HashPaths $destination $paths) $after)) { throw 'Installed root hash verification failed.' }
            $stalePaths = @($oldPaths | Where-Object { $paths -notcontains $_ })
            foreach ($relative in $stalePaths) {
                if (Test-Path -LiteralPath (Join-Path $destination $relative)) { throw "Stale managed path remains after install: $relative" }
            }
            if ($legacyMigration -and (Test-Path -LiteralPath $legacyRoot)) { throw 'Legacy public-payload remains after root migration.' }
            if (-not (Test-Path -LiteralPath (Join-Path $destination '.git'))) { throw 'Protected .git disappeared during sync.' }
            $latestStillExists = Test-Path -LiteralPath $latestPath -PathType Leaf
            $latestStillHash = if ($latestStillExists) { Sha256Hash $latestPath } else { $null }
            if ($latestStillExists -ne $latestExisted -or $latestStillHash -ne $latestHash) { throw 'Protected latest.json changed during sync.' }
        } catch {
            $installError = $_.Exception.Message
            try {
                foreach ($relative in $installedPaths) {
                    $target = Join-Path $destination $relative
                    if (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target -Force }
                    RemoveEmptyParents $target $destination
                }
                if ($env:EVENT_AUTOPIN_SYNC_TEST_FAIL_ROLLBACK -eq '1') { throw 'test rollback failure' }
                foreach ($relative in $movedPaths) {
                    $backupFile = Join-Path $rootBackup $relative
                    $target = Join-Path $destination $relative
                    if (Test-Path -LiteralPath $backupFile -PathType Leaf) {
                        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
                        Move-Item -LiteralPath $backupFile -Destination $target
                    }
                }
                if ($legacyMoved) { Move-Item -LiteralPath (Join-Path $backup $LegacyPayloadName) -Destination $legacyRoot }
                if (Test-Path -LiteralPath $next) { Remove-Item -LiteralPath $next -Recurse -Force }
                $rolledBack = if ($legacyMigration) { HashTree $legacyRoot } else { HashPaths $destination $affectedPaths }
                if (-not (SameHashes $rolledBack $before)) { throw 'Rollback hash verification failed.' }
                if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
            } catch {
                $preserveBackup = $true
                throw "Synchronization failed: $installError Rollback failed: $($_.Exception.Message) Backup retained at: $backup"
            }
            throw $installError
        }
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
        if (Test-Path -LiteralPath $next) { Remove-Item -LiteralPath $next -Recurse -Force }
        foreach ($relative in $affectedPaths) { RemoveEmptyParents (Join-Path $destination $relative) $destination }
        Write-Output '[result] repository root synchronized and hashes verified; .git and latest.json preserved.'
    } finally {
        if ($next -and (Test-Path -LiteralPath $next)) { Remove-Item -LiteralPath $next -Recurse -Force }
        if (-not $preserveBackup -and $backup -and (Test-Path -LiteralPath $backup)) {
            Remove-Item -LiteralPath $backup -Recurse -Force
        }
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
        if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
        $pathspecFile = "$temp.pathspec"
        if (Test-Path -LiteralPath $pathspecFile) { Remove-Item -LiteralPath $pathspecFile -Force }
    }
} catch { Write-Error $_.Exception.Message; exit 1 }
