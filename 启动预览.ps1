# 启动本地预览
#
# 用法：在文件资源管理器里右键本文件 → 使用 PowerShell 运行
#      或在 PowerShell 里： powershell -ExecutionPolicy Bypass -File "启动预览.ps1"
#
# 会启动一个静态服务器并打开浏览器；关掉这个窗口（或按 Ctrl+C）就停止。
# 线上版不需要这个脚本： https://forbitliang.github.io/webflow/

$ErrorActionPreference = 'Stop'
$dir  = $PSScriptRoot
$port = 8848
$url  = "http://127.0.0.1:$port/"

if (-not (Test-Path (Join-Path $dir 'index.html'))) { throw "找不到 index.html：$dir" }

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    Write-Host '没有找到 python。' -ForegroundColor Yellow
    Write-Host '可以改用 Node： npx --yes http-server -p 8848' -ForegroundColor Yellow
    Write-Host '或者直接双击 index.html（本项目是传统 script，file:// 下也能跑）。' -ForegroundColor Yellow
    exit 1
}

Set-Location $dir

Write-Host ''
Write-Host "  本地预览已启动： $url" -ForegroundColor Cyan
Write-Host "  线上版：         https://forbitliang.github.io/webflow/" -ForegroundColor DarkGray
Write-Host ''
Write-Host '  按 Ctrl+C 停止（或直接关掉这个窗口）' -ForegroundColor DarkGray
Write-Host ''

# 稍等一下再开浏览器，避免抢在服务器起来之前
Start-Job -ScriptBlock { Start-Sleep -Milliseconds 900; Start-Process $using:url } | Out-Null

& python -m http.server $port --bind 127.0.0.1
