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

# FB_ONLY lists exact absolute paths the caller just renamed, newline separated.
# When present nothing is scanned, so files the flow never touched (for example
# inside a `*.bak` directory) cannot be renamed by accident.
$onlyRaw = $env:FB_ONLY
if ([string]::IsNullOrWhiteSpace($onlyRaw)) {
    $candidates = @(if ($isLeaf) { @(Get-Item -LiteralPath $root) } else { Get-TreeFiles $root })
    $explicit = $isLeaf
}
else {
    $candidates = New-Object System.Collections.Generic.List[object]
    foreach ($line in $onlyRaw -split "`n") {
        $target = $line.Trim()
        if (-not $target) { continue }
        try {
            if (Test-Path -LiteralPath (Add-LongPathPrefix $target) -PathType Leaf) {
                $candidates.Add((Get-Item -LiteralPath (Add-LongPathPrefix $target)))
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
