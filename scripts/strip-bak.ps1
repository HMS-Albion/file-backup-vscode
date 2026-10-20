#Requires -Version 5.1
# Strips configured suffixes (e.g. .bak, .c, .c1) off file names: copy ->
# hash-verify -> delete. The path to process arrives in $env:FB_ROOT and the
# suffix list in $env:FB_SUFFIXES (comma separated, outermost first), so neither
# ever has to survive command-line quoting.

$ErrorActionPreference = 'Stop'

# Report Chinese paths legibly instead of mojibake when stdout is piped.
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
}
catch {
}

function Add-LongPathPrefix([string]$path) {
    # PowerShell 5.1 sits on .NET Framework, which trips the legacy MAX_PATH
    # limit; the extended prefix removes it for absolute drive paths only.
    if ($path -like '\\?\*') { return $path }
    if ($path.Length -lt 240) { return $path }
    if ($path -match '^[A-Za-z]:\\') { return '\\?\' + $path }
    return $path
}

$root = $env:FB_ROOT
if ([string]::IsNullOrWhiteSpace($root)) {
    throw 'FB_ROOT is not set'
}
if (-not (Test-Path -LiteralPath $root)) {
    throw "Path not found: $root"
}

$suffixList = $env:FB_SUFFIXES
if ([string]::IsNullOrWhiteSpace($suffixList)) {
    $suffixList = '.bak'
}
$suffixes = @($suffixList.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })

$escaped = @($suffixes | ForEach-Object { [regex]::Escape($_) })
$numberedPattern = '(' + ($escaped -join '|') + ')\.\d+$'

$result = [pscustomobject]@{
    restored       = @()
    conflicts      = @()
    numbered       = @()
    undeleted      = @()
    failed         = @()
    unreadableDirs = @()
}

$isLeaf = Test-Path -LiteralPath $root -PathType Leaf

# One unreadable or over-long directory must not abort the whole tree, so walk it
# by hand with a stack and collect the failures instead of throwing.
function Get-TreeFiles([string]$start) {
    $found = New-Object System.Collections.Generic.List[object]
    $stack = New-Object System.Collections.Generic.Stack[string]
    $stack.Push((Add-LongPathPrefix $start))

    while ($stack.Count -gt 0) {
        $current = $stack.Pop()
        try {
            $items = @(Get-ChildItem -LiteralPath $current -Force -ErrorAction Stop)
        }
        catch {
            $result.unreadableDirs += $_.Exception.Message
            continue
        }

        foreach ($item in $items) {
            if ($item.PSIsContainer) {
                $stack.Push((Add-LongPathPrefix $item.FullName))
            }
            else {
                $found.Add($item)
            }
        }
    }

    return $found
}

# Candidate collection has three modes, picked by the environment:
#   FB_MAP  — exact "<from><TAB><to>" ledger written by the round trip; nothing is guessed.
#   FB_ONLY — exact list of paths, but the target name is still derived from the suffixes.
#   neither — scan the tree under FB_ROOT.
# Whichever mode runs, every candidate is normalised to {Item, TargetPath}, where a null
# TargetPath means "work the target name out from the suffixes yourself".

$onlyRaw = $env:FB_ONLY
$mapRaw = $env:FB_MAP
$mapMode = -not [string]::IsNullOrWhiteSpace($mapRaw)
$candidates = New-Object System.Collections.Generic.List[object]

if ($mapMode) {
    foreach ($line in $mapRaw -split "`n") {
        if (-not $line.Trim()) { continue }
        $parts = $line -split "`t"
        if ($parts.Count -lt 2) {
            $result.failed += "FB_MAP 行缺少制表符: $line"
            continue
        }
        # Only the first tab separates the two paths; a tab inside a file name
        # stays part of the name.
        $from = $parts[0].Trim()
        $to = ($parts[1..($parts.Count - 1)] -join "`t").Trim()
        try {
            $probe = Add-LongPathPrefix $from
            if (Test-Path -LiteralPath $probe -PathType Leaf) {
                $candidates.Add([pscustomobject]@{ Item = (Get-Item -LiteralPath $probe); Path = $probe; TargetPath = (Add-LongPathPrefix $to) })
            }
            else {
                $result.unreadableDirs += "映射里的路径已不存在: $from"
            }
        }
        catch {
            $result.unreadableDirs += $_.Exception.Message
        }
    }
    $explicit = $true
}
elseif ([string]::IsNullOrWhiteSpace($onlyRaw)) {
    foreach ($f in @(if ($isLeaf) { @(Get-Item -LiteralPath $root) } else { Get-TreeFiles $root })) {
        $candidates.Add([pscustomobject]@{ Item = $f; Path = $f.FullName; TargetPath = $null })
    }
    $explicit = $isLeaf
}
else {
    foreach ($line in $onlyRaw -split "`n") {
        $target = $line.Trim()
        if (-not $target) { continue }
        try {
            $probe = Add-LongPathPrefix $target
            if (Test-Path -LiteralPath $probe -PathType Leaf) {
                $candidates.Add([pscustomobject]@{ Item = (Get-Item -LiteralPath $probe); Path = $probe; TargetPath = $null })
            }
            else {
                $result.unreadableDirs += "白名单里的路径已不存在: $target"
            }
        }
        catch {
            $result.unreadableDirs += $_.Exception.Message
        }
    }
    $explicit = $true
}


# Removes each configured suffix at most once, in list order:
# "notes.txt.c.bak" -> "notes.txt", but "legacy.c" keeps its real extension
# because the .c suffix slot was already spent on the appended one.
function Get-StrippedName([string]$name) {
    $working = $name

    foreach ($s in $suffixes) {
        if ($working.EndsWith($s)) {
            $working = $working.Substring(0, $working.Length - $s.Length)
        }
    }

    if (-not $working) {
        return $name
    }

    return $working
}

foreach ($candidate in $candidates) {
    $file = $candidate.Item
    $name = $file.Name
    $isNumbered = $name -match $numberedPattern

    # A numbered name is only left alone while scanning a folder. When the caller
    # named that file explicitly, it is a deliberate choice and gets restored.
    if ($isNumbered -and -not $explicit) {
        $result.numbered += $name
        continue
    }
    if ($isNumbered -and -not $mapMode) {
        $name = $name -replace '\.\d+$', ''
    }

    # FB_MAP carries the exact destination, so a file that legitimately ends in one
    # of our suffixes (`report.c1`) keeps its name instead of being over-stripped.
    $targetPath = $candidate.TargetPath
    if (-not $targetPath) {
        $targetName = Get-StrippedName $name
        if (-not $targetName -or $targetName -eq $name) {
            continue
        }
        $targetPath = Join-Path -Path $file.DirectoryName -ChildPath $targetName
    }

    if (Test-Path -LiteralPath $targetPath) {
        $result.conflicts += $name
        continue
    }

    try {
        Copy-Item -LiteralPath $candidate.Path -Destination $targetPath -Force

        $sourceHash = (Get-FileHash -LiteralPath $candidate.Path -Algorithm SHA256).Hash
        $targetHash = (Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash

        if ($sourceHash -ne $targetHash) {
            Remove-Item -LiteralPath $targetPath -Force -ErrorAction SilentlyContinue
            $result.failed += $name
            continue
        }

        $restored = Get-Item -LiteralPath $targetPath
        $restored.LastWriteTime = $file.LastWriteTime
        $result.restored += $restored.Name

        try {
            Remove-Item -LiteralPath $candidate.Path -Force
        }
        catch {
            $result.undeleted += $name
        }
    }
    catch {
        Remove-Item -LiteralPath $targetPath -Force -ErrorAction SilentlyContinue
        $result.failed += $name
    }
}

ConvertTo-Json -InputObject $result -Compress -Depth 3
