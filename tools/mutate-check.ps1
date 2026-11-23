<#
.SYNOPSIS
  变异自检：故意改坏一处防护，确认测试真的会失败，再还原。

.DESCRIPTION
  用来证明"断言不是摆设"。流程：
    1. 要求工作区干净（否则 git checkout 会连未提交的修复一起吃掉——踩过）
    2. 把 From 替换成 To（注入变异）
    3. 跑测试，**必须失败**；通过了说明断言没覆盖到，等于假安全
    4. git checkout 还原，并校验原文回来
    5. 再跑一次测试，**必须通过**

.EXAMPLE
  pwsh -NoProfile -File tools/mutate-check.ps1 `
    -File lib/host.js `
    -From 'try { handleEvent(session, event) } catch (e) { log.warn(e) }' `
    -To   'handleEvent(session, event)'

.EXAMPLE
  # 只跑不改：确认当前工作区干净、测试全绿
  pwsh -NoProfile -File tools/mutate-check.ps1 -File lib/host.js -From 'x' -To 'y' -DryRun
#>
param(
  [Parameter(Mandatory = $true)][string]$File,
  [Parameter(Mandatory = $true)][string]$From,
  [Parameter(Mandatory = $true)][string]$To,
  [string]$Test = 'node tools/smoke-test.mjs',
  [string]$Repo = (Get-Location).Path,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$target = Join-Path $Repo $File

if (-not (Test-Path $target)) { Write-Output "MUTATE: 找不到 $target"; exit 2 }

# 1. 工作区必须干净：变异后靠 git checkout 还原，未提交的改动会被一起回滚
$dirty = git -C $Repo status --porcelain
if ($dirty -and -not $DryRun) {
  Write-Output 'MUTATE: 工作区不干净，先提交再跑变异（否则还原会吃掉未提交改动）'
  $dirty | ForEach-Object { Write-Output "  $_" }
  exit 3
}

if ($DryRun) {
  Write-Output "MUTATE: DryRun — 目标 $target / 测试命令 $Test"
  exit 0
}

$original = Get-Content $target -Raw
if (-not $original.Contains($From)) {
  Write-Output 'MUTATE: 锚点未命中，检查 -From 是否与源码逐字一致（含缩进与换行）'
  exit 4
}

Set-Content -Path $target -Value $original.Replace($From, $To) -Encoding utf8 -NoNewline
Write-Output 'MUTATE: 变异已注入'

$mutantFailed = $false
try {
  Invoke-Expression $Test | Out-Host
  if ($LASTEXITCODE -ne 0) { $mutantFailed = $true }
}
catch {
  $mutantFailed = $true
}

finally {
  git -C $Repo checkout -- $File
  $restored = (Get-Content $target -Raw).Contains($From)
  Write-Output "RESTORE: 原文已恢复 = $restored"
  if (-not $restored) {
    Write-Output 'MUTATE: 还原失败，请手工 git checkout 后重来'
    exit 5
  }
  $baselineOk = $false
  try {
    Invoke-Expression $Test | Out-Host
    if ($LASTEXITCODE -eq 0) { $baselineOk = $true }
  }
  catch { $baselineOk = $false }
}

if (-not $mutantFailed) {
  Write-Output 'MUTATE: 结论 = 变异后测试仍通过，说明这处防护没有被断言覆盖'
  exit 1
}
if (-not $baselineOk) {
  Write-Output 'MUTATE: 结论 = 还原后测试未全绿，基线本身有问题'
  exit 1
}
Write-Output 'MUTATE: 结论 = 变异后失败、还原后全绿，这条断言有效'
exit 0
