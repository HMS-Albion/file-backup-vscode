#Requires -Version 5.1
# Renames files. The instruction list arrives in $env:FB_RENAMES, one
# "<from><TAB><to>" pair per line, and the result comes back as a single JSON
# object on stdout:
#
#   { "renamed": [ { "from": "...", "to": "..." } ], "failed": [ { "file": "...", "reason": "..." } ] }
#
# Every rename is isolated: one locked file must not cost the rest of the tree.
# Paths never travel on the command line, so names with spaces or shell
# metacharacters cannot break the invocation.
#
# The messages below are deliberately ASCII. PowerShell 5.1 decodes a script
# without a byte-order mark using the system ANSI code page, which turns
# non-ASCII literals into mojibake and can even break the quoting. The caller
# (src/transform.ts) maps these codes back to readable Chinese.

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

$result = [pscustomobject]@{
    renamed = @()
    failed  = @()
}

$raw = $env:FB_RENAMES
if ([string]::IsNullOrWhiteSpace($raw)) {
    # Nothing to do is a valid answer, not an error.
    ConvertTo-Json -InputObject $result -Compress -Depth 3
    exit 0
}

foreach ($line in $raw -split "`n") {
    if (-not $line.Trim()) { continue }

    $parts = $line -split "`t"
    if ($parts.Count -lt 2) {
        $result.failed += [pscustomobject]@{ file = $line.Trim(); reason = 'malformed-instruction' }
        continue
    }

    $from = $parts[0].Trim()
    $to = ($parts[1..($parts.Count - 1)] -join "`t").Trim()

    try {
        $source = Add-LongPathPrefix $from
        $target = Add-LongPathPrefix $to

        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            $result.failed += [pscustomobject]@{ file = $from; reason = 'source-missing' }
            continue
        }

        if (Test-Path -LiteralPath $target) {
            # A taken name is a conflict the caller has to know about, never a
            # file to destroy.
            $result.failed += [pscustomobject]@{ file = $from; reason = 'target-taken' }
            continue
        }

        Move-Item -LiteralPath $source -Destination $target -ErrorAction Stop
        $result.renamed += [pscustomobject]@{ from = $from; to = $to }
    }
    catch {
        # The .NET exception text is not guaranteed to survive the pipe as
        # readable text, so only a stable code is reported.
        $result.failed += [pscustomobject]@{ file = $from; reason = 'move-failed' }
    }
}

ConvertTo-Json -InputObject $result -Compress -Depth 3
