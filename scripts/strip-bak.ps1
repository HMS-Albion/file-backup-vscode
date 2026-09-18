#Requires -Version 5.1
# Restores files from their .bak copies: copy -> hash-verify -> delete.
# The folder (or single file) to process arrives in $env:FB_ROOT, so no path
# ever has to survive command-line quoting.

$ErrorActionPreference = 'Stop'

$root = $env:FB_ROOT
if ([string]::IsNullOrWhiteSpace($root)) {
    throw 'FB_ROOT is not set'
}
if (-not (Test-Path -LiteralPath $root)) {
    throw "Path not found: $root"
}

$result = [pscustomobject]@{
    restored  = @()
    conflicts = @()
    numbered  = @()
    undeleted = @()
    failed    = @()
}

function Get-CandidateFiles([string]$path) {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        return @(Get-Item -LiteralPath $path)
    }
    return @(Get-ChildItem -LiteralPath $path -File -Recurse -Force)
}

# The whole tree is enumerated up front, so restoring a file cannot disturb iteration.
foreach ($file in Get-CandidateFiles $root) {
    $name = $file.Name

    if ($name -match '\.bak\.\d+$') {
        $result.numbered += $name
        continue
    }
    if ($name -notmatch '\.bak$') {
        continue
    }

    $targetPath = $file.FullName.Substring(0, $file.FullName.Length - 4)

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
