$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$cursorDir = Join-Path $root ".cursor"
if (-not (Test-Path $cursorDir)) { Write-Error "Source not found: $cursorDir"; exit 1 }

$pairs = @(
    @{ From = "skills"; ToClaude = ".claude\skills"; ToTrae = ".trae\skills" },
    @{ From = "rules"; ToClaude = ".claude\rules"; ToTrae = ".trae\rules" },
    @{ From = "agents"; ToClaude = ".claude\agents"; ToTrae = ".trae\agents" },
    @{ From = "commands"; ToClaude = ".claude\commands"; ToTrae = ".trae\commands" }
)

$totalCopiedFiles = 0
$totalSyncedGroups = 0
$startTime = Get-Date

foreach ($pair in $pairs) {
    $src = Join-Path $cursorDir $pair.From
    if (-not (Test-Path $src)) { Write-Host "Skip (missing): $src"; continue }

    $srcFiles = @(Get-ChildItem -Path $src -Recurse -File -ErrorAction SilentlyContinue)
    $srcFileCount = $srcFiles.Count
    if ($srcFileCount -eq 0) {
        Write-Host "Skip (empty): $src"
        continue
    }

    foreach ($targetRel in $pair.ToClaude, $pair.ToTrae) {
        $target = Join-Path $root $targetRel
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        Write-Host "Copy .cursor\$($pair.From) ($srcFileCount files) -> $targetRel"
        Copy-Item -Path (Join-Path $src "*") -Destination $target -Recurse -Force
        $totalCopiedFiles += $srcFileCount
    }
    $totalSyncedGroups++
}

$elapsed = (Get-Date) - $startTime
Write-Host ""
Write-Host "Sync complete."
Write-Host "Synced groups: $totalSyncedGroups / $($pairs.Count)"
Write-Host "Total copied files (including both targets): $totalCopiedFiles"
Write-Host ("Elapsed: {0:n2}s" -f $elapsed.TotalSeconds)
Write-Host "Covered paths: .cursor/skills, .cursor/rules, .cursor/agents, .cursor/commands -> .claude + .trae"
Write-Host 'Note: .claude/ 与 .trae/ 已在 .gitignore 中，仅为本地副本；删除后随时可重新运行本脚本生成。'
Write-Host 'Note: runtime 注入源为 agents/rules/、.xrk/skills/、agents/workspace/；IDE 技能源为 .cursor/。'
