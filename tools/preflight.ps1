<#
.SYNOPSIS
  复制模板后的一次性自检：找出还带着模板占位值的地方。

.DESCRIPTION
  补 `publish-precheck` 抓不到的那类残留——占位名、模板文案、patch id 与包名不一致。
  只在“刚复制出来的新插件”上跑；直接对模板目录跑会报一堆 ERROR，属预期。

.EXAMPLE
  pwsh -NoProfile -File tools/preflight.ps1
  pwsh -NoProfile -File tools/preflight.ps1 -Dir plugins\dsh-notify-chime
#>
param(
  [string]$Dir = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
$errors = @()
$warns = @()

function Read-Text ($path) {
  if (-not (Test-Path $path)) { return $null }
  return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
}

$pkgRaw = Read-Text (Join-Path $Dir 'package.json')
if ($null -eq $pkgRaw) { Write-Output "PREFLIGHT: 找不到 package.json（-Dir $Dir）"; exit 2 }
$pkg = $pkgRaw | ConvertFrom-Json

# ── 包身份 ────────────────────────────────────────────────────────────
if ($pkg.name -eq 'dsh-plugin-example') { $errors += 'package.json 的 name 还是模板占位 `dsh-plugin-example`' }
if ($pkg.name -match '^@local/') { $errors += 'name 不能带 `@local/` scope' }
if ($pkg.private -eq $true) { $errors += 'private 必须去掉（或设为 false）才能发布' }
if ($pkg.description -match '插件模板') { $errors += 'package.json 的 description 还是模板文案' }
if (-not $pkg.repository) { $warns += '缺 repository 字段（publish-precheck 会 WARN）' }
if ($pkg.author -match 'dixie_with_heart') { $warns += 'author 仍是模板作者，确认要保留还是替换' }

# ── locale 文案 ───────────────────────────────────────────────────────
$zh = Read-Text (Join-Path $Dir 'locale\zh.json')
if ($zh) {
  try {
    $zhJson = $zh | ConvertFrom-Json
    if ($zhJson.meta.title -eq '示例插件') { $errors += 'locale/zh.json 的 title 还是「示例插件」' }
    if ($zhJson.meta.description -match '插件模板') { $errors += 'locale/zh.json 的 description 还是模板文案' }
  } catch { $errors += 'locale/zh.json 不是合法 JSON' }
}
$en = Read-Text (Join-Path $Dir 'locale\en.json')
if ($en) {
  try {
    $enJson = $en | ConvertFrom-Json
    if ($enJson.meta.title -match '^Example Plugin$') { $errors += 'locale/en.json 的 title 还是 Example Plugin' }
  } catch { $errors += 'locale/en.json 不是合法 JSON' }
}

# ── patch 与包名一致 ──────────────────────────────────────────────────
$patch = Read-Text (Join-Path $Dir 'cordis.patch.yml')
if ($patch) {
  if ($patch -match '@local/') { $warns += 'cordis.patch.yml 注释里仍带 `@local/`' }
  $m = [regex]::Match($patch, '(?m)^\s+-\s*id:\s*(\S+)\s*$')
  if ($m.Success -and $m.Groups[1].Value -ne $pkg.name) {
    $errors += "patch 行 id（$($m.Groups[1].Value)）与包名（$($pkg.name)）不一致"
  }
}

# ── 文档残留 ──────────────────────────────────────────────────────────
$readme = Read-Text (Join-Path $Dir 'README.md')
if ($readme) {
  if ($readme -match 'dsh-plugin-example') { $warns += 'README 仍含模板占位名 dsh-plugin-example' }
  if ($readme -match '替换清单') { $warns += 'README 仍保留模板的「替换清单」章节，交付前考虑删掉' }
}

# ── 输出 ──────────────────────────────────────────────────────────────
Write-Output "PREFLIGHT: $Dir"
foreach ($e in $errors) { Write-Output "  ERROR  $e" }
foreach ($w in $warns) { Write-Output "  WARN   $w" }
Write-Output ("  汇总：{0} ERROR / {1} WARN" -f $errors.Count, $warns.Count)
if ($errors.Count -gt 0) { exit 1 }
exit 0
