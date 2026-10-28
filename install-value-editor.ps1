# install-value-editor.ps1
# Install MToolValueEditor as a standalone MZ plugin into a game.
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\install-value-editor.ps1 -GameDir "E:\Games\SomeGame"

param(
    [Parameter(Mandatory = $true)][string]$GameDir,
    [string]$ModDir = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host "[install] $m" -ForegroundColor Cyan }
function Fail($m) { Write-Host "[error] $m" -ForegroundColor Red; exit 1 }

$pluginSrc    = Join-Path $ModDir 'MToolValueEditor.js'
$pluginsJs    = Join-Path $GameDir 'js\plugins.js'
$pluginDstDir = Join-Path $GameDir 'js\plugins'
$pluginDst    = Join-Path $pluginDstDir 'MToolValueEditor.js'

if (-not (Test-Path -LiteralPath $pluginSrc))    { Fail "plugin source not found: $pluginSrc" }
if (-not (Test-Path -LiteralPath $pluginsJs))    { Fail "not a valid MZ game (missing js\plugins.js): $GameDir" }
if (-not (Test-Path -LiteralPath $pluginDstDir)) { Fail "missing js\plugins directory: $pluginDstDir" }

# 1) backup plugins.js
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak = "$pluginsJs.bak-before-mte-$stamp"
Copy-Item -LiteralPath $pluginsJs -Destination $bak
Info "backup created: $bak"

# 2) copy plugin file
Copy-Item -LiteralPath $pluginSrc -Destination $pluginDst -Force
Info "plugin copied to: $pluginDst"

# 2.1) copy config file (so the game is fully self-contained)
$cfgSrc = Join-Path $ModDir 'MToolValueEditor.config.json'
$cfgDst = Join-Path $pluginDstDir 'MToolValueEditor.config.json'
if (Test-Path -LiteralPath $cfgSrc) {
    Copy-Item -LiteralPath $cfgSrc -Destination $cfgDst -Force
    Info "config copied to: $cfgDst"
}

# 3) register in plugins.js (idempotent)
$txt = [System.IO.File]::ReadAllText($pluginsJs)
if ($txt -match '"name"\s*:\s*"MToolValueEditor"') {
    Info "already registered in plugins.js, skip"
} else {
    $closeBracket = $txt.LastIndexOf(']')
    if ($closeBracket -lt 0) { Fail "cannot parse plugins.js (no closing bracket)" }
    $lastBrace = $txt.LastIndexOf('}', $closeBracket)
    if ($lastBrace -lt 0) { Fail "cannot parse plugins.js (no last object)" }

    $insert = ',{"name":"MToolValueEditor","status":true,"description":"In-game value editor (F9)","parameters":{}}'
    $newTxt = $txt.Substring(0, $lastBrace + 1) + $insert + $txt.Substring($lastBrace + 1)
    [System.IO.File]::WriteAllText($pluginsJs, $newTxt, (New-Object System.Text.UTF8Encoding($false)))
    Info "registered MToolValueEditor in plugins.js"
}

# 4) validate JSON
$final = [System.IO.File]::ReadAllText($pluginsJs)
$open  = $final.IndexOf('[')
$close = $final.LastIndexOf(']')
if ($open -lt 0 -or $close -lt $open) { Fail "plugins.js structure invalid" }
$jsonPart = $final.Substring($open, $close - $open + 1)
try {
    $arr = $jsonPart | ConvertFrom-Json
} catch {
    Copy-Item -LiteralPath $bak -Destination $pluginsJs -Force
    Fail "JSON validation failed, rolled back: $($_.Exception.Message)"
}

$hit = $arr | Where-Object { $_.name -eq 'MToolValueEditor' }
if (-not $hit) {
    Copy-Item -LiteralPath $bak -Destination $pluginsJs -Force
    Fail "registration not effective, rolled back"
}

Info "OK: plugins.js has $($arr.Count) plugins, MToolValueEditor status=$($hit.status)"
Info "Done. Restart the game, then press F9 to open the panel."
Info "Uninstall: delete js\plugins\MToolValueEditor.js and remove its entry from plugins.js."
