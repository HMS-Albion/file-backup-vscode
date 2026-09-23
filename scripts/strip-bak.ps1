#Requires -Version 5.1
# Strips configured suffixes (e.g. .bak, .c, .c1) off file names: copy ->
# hash-verify -> delete. The path to process arrives in $env:FB_ROOT and the
# suffix list in $env:FB_SUFFIXES (comma separated, outermost first), so neither
# ever has to survive command-line quoting.

$ErrorActionPreference = 'Stop'

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
    restored  = @()
    conflicts = @()
    numbered  = @()
    undeleted = @()
    failed    = @()
}

$isLeaf = Test-Path -LiteralPath $root -PathType Leaf

function Get-CandidateFiles([string]$path) {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        return @(Get-Item -LiteralPath $path)
    }
    return @(Get-ChildItem -LiteralPath $path -File -Recurse -Force)
}

# FB_ONLY lists exact absolute paths the caller just renamed, newline separated.
# When present nothing is scanned, so files the flow never touched (for example
# inside a `*.bak` directory) cannot be renamed by accident.
$onlyRaw = $env:FB_ONLY
if ([string]::IsNullOrWhiteSpace($onlyRaw)) {
    $candidates = @(Get-CandidateFiles $root)
    $explicit = $isLeaf
}
else {
    $candidates = @()
    foreach ($line in $onlyRaw -split "`n") {
        $target = $line.Trim()
        if ($target -and (Test-Path -LiteralPath $target -PathType Leaf)) {
            $candidates += Get-Item -LiteralPath $target
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

foreach ($file in $candidates) {
    $name = $file.Name
    $isNumbered = $name -match $numberedPattern

    # A numbered name is only left alone while scanning a folder. When the caller
    # named that file explicitly, it is a deliberate choice and gets restored.
    if ($isNumbered -and -not $explicit) {
        $result.numbered += $name
        continue
    }
    if ($isNumbered) {
        $name = $name -replace '\.\d+$', ''
    }

    $targetName = Get-StrippedName $name
    if (-not $targetName -or $targetName -eq $name) {
        continue
    }

    $targetPath = Join-Path -Path $file.DirectoryName -ChildPath $targetName

    if (Test-Path -LiteralPath $targetPath) {
        $result.conflicts += $name
        continue
    }

    try {
        Copy-Item -LiteralPath $file.FullName -Destination $targetPath -Force

        $sourceHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
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
            Remove-Item -LiteralPath $file.FullName -Force
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
