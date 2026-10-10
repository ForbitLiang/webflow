# flow —— 一键发布到 GitHub Pages
#
# 用法：在你自己的 PowerShell 里运行本脚本（不要在这个 AI 沙箱里跑，沙箱没有外网）：
#     powershell -ExecutionPolicy Bypass -File "发布到GitHub.ps1"
#
# 脚本会：初始化本地仓库 → 创建公开仓库 → 推送代码 → 打印开启 GitHub Pages 的步骤
#
# 仓库名是 webflow，所以线上地址是：https://forbitliang.github.io/webflow/
# 注意：本项目所有资源都是相对路径，部署在子路径 /webflow/ 下也能正常工作，无需改动。

$ErrorActionPreference = 'Stop'
$user = 'ForbitLiang'
$repo = 'webflow'
$dir  = $PSScriptRoot

function Push-Repo {
    git remote set-url origin "https://github.com/$user/$repo.git"
    git push -u origin main
    if ($LASTEXITCODE -eq 0) { return }
    Write-Host ''
    Write-Host '推送被拒绝：远程仓库已有旧历史，与本地不一致。' -ForegroundColor Yellow
    $ans = Read-Host '要强制覆盖远程历史吗？输入 y 继续（会把旧提交从分支上移除）'
    if ($ans -eq 'y') {
        git push -u --force origin main
    } else {
        Write-Host '已取消。更彻底的做法：在 GitHub 上删除该仓库后重新运行本脚本。' -ForegroundColor Yellow
    }
}

if (-not (Test-Path (Join-Path $dir 'index.html'))) { throw "找不到 index.html：$dir" }
Set-Location $dir

Write-Host ''
Write-Host "=== flow · 发布到 $user/$repo ===" -ForegroundColor Cyan

# 0) 确认 git 身份（只写进本仓库的 .git/config，不动全局配置）
if (-not (git config --local user.name))  { git config --local user.name  $user }
if (-not (git config --local user.email)) { git config --local user.email "$user@users.noreply.github.com" }

# 1) 该目录若还不是 git 仓库，则初始化
if (-not (Test-Path (Join-Path $dir '.git'))) {
    Write-Host '[0/4] 初始化本地仓库'
    git init -q
    git branch -M main 2>$null
}

# 2) 有未提交的改动就提交掉
git add -A
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
    Write-Host '[0/4] 提交改动'
    git commit -q -m "flow: 程序化水景 + 程序化音景 + 多页白板（$(Get-Date -Format 'yyyy-MM-dd HH:mm')）"
} else {
    Write-Host '[0/4] 没有需要提交的改动'
}

$gh = Get-Command gh -ErrorAction SilentlyContinue

if ($gh) {
    Write-Host '[1/4] 检测到 GitHub CLI'
    gh auth status *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Host '      需要先登录 GitHub（会打开浏览器）…'
        gh auth login
    }
    Write-Host '[2/4] 创建/更新仓库并推送'
    gh repo view "$user/$repo" *> $null
    if ($LASTEXITCODE -ne 0) {
        gh repo create "$user/$repo" --public --source . --remote origin --push
    } else {
        Push-Repo
    }
} else {
    Write-Host '[1/4] 未安装 GitHub CLI（gh）'
    Write-Host '      请先在浏览器里创建一个空仓库：'
    Write-Host '        https://github.com/new' -ForegroundColor Yellow
    Write-Host "        仓库名：$repo    可见性：Public    不要勾选 Add a README / .gitignore / license"
    Read-Host '      准备好后回到这里按回车继续（推送时会弹浏览器让你登录 GitHub）'
    Write-Host '[2/4] 推送代码'
    Push-Repo
}

Write-Host '[3/4] 完成！接下来开启 GitHub Pages（只需一次）' -ForegroundColor Green
Write-Host ''
Write-Host '  1) 打开：' -NoNewline
Write-Host "https://github.com/$user/$repo/settings/pages" -ForegroundColor Yellow
Write-Host '  2) Source 选 “Deploy from a branch”'
Write-Host '     Branch 选 “main”，目录选 “/ (root)”，点 Save'
Write-Host '  3) 等 1 分钟左右，访问：' -NoNewline
Write-Host "https://$($user.ToLower()).github.io/$repo/" -ForegroundColor Yellow
Write-Host ''
Write-Host '[4/4] 以后每次改完，只要 git add/commit/push，网站会自动更新。' -ForegroundColor Green
