# 0Siri 러너 설치 — Windows 10·11 (PowerShell). 앱 설정 › 연결 › 모델 계정 › 내 PC 에서 이 줄을 복사해 PowerShell 에 붙인다:
#   & ([scriptblock]::Create((irm <서버>/install-runner.ps1))) <서버> <열쇠> <codex|claude>
# 하는 일: Node 22(winget) → 구독 CLI → 로그인 → %USERPROFILE%\.0siri 에 러너·실행 파일 → 새 창에서 시작.
# 열쇠는 %USERPROFILE%\.0siri\0siri-runner.cmd 에만 남는다(사용자 폴더 = 본인만 접근). 다시 설치하면 덮어쓴다.
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [Parameter(Mandatory = $true)][string]$Key,
  [ValidateSet("codex", "claude")][string]$Provider = "codex"
)
$WorkDir = Join-Path $HOME "0Siri"
$ErrorActionPreference = "Stop"
function Say($m) { Write-Host "[0Siri] $m" }
function Die($m) { Write-Host "[0Siri] 멈춤: $m" -ForegroundColor Red; throw $m }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}
function Node-Major {
  try { [int](& node -p "process.versions.node.split('.')[0]") } catch { 0 }
}

# npm 이 만드는 codex.ps1 은 기본 실행 정책(Restricted)에서 막힌다 — .cmd 쪽을 부른다
$spec = @{
  codex  = @{ Pkg = "@openai/codex"; Cli = "codex.cmd"; Login = @("login", "--device-auth"); Status = @("login", "status") }
  claude = @{ Pkg = "@anthropic-ai/claude-code"; Cli = "claude.cmd"; Login = @("auth", "login"); Status = @("auth", "status") }
}[$Provider]

# ---- 1. Node 22 이상 ----
if ((Node-Major) -lt 22) {
  Say "Node 22 를 설치합니다 (winget)"
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Die "winget 이 없습니다. https://nodejs.org 에서 Node 22 를 설치한 뒤 이 줄을 다시 실행하세요"
  }
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  Refresh-Path
  if ((Node-Major) -lt 22) { Die "Node 22 설치를 확인하지 못했습니다 — PowerShell 을 새로 열고 다시 실행하세요" }
}
Say "Node $(& node -v)"

# ---- 2. 구독 CLI ----
if (-not (Get-Command $spec.Cli -ErrorAction SilentlyContinue)) {
  Say "$($spec.Pkg) 를 설치합니다"
  & npm.cmd i -g $spec.Pkg
  Refresh-Path
}
if (-not (Get-Command $spec.Cli -ErrorAction SilentlyContinue)) { Die "$($spec.Cli) 명령을 찾지 못했습니다 — npm i -g $($spec.Pkg) 를 확인하세요" }

# ---- 3. 로그인 ----
& $spec.Cli @($spec.Status) *> $null
if ($LASTEXITCODE -ne 0) {
  Say "$($spec.Cli) 로그인 — 안내대로 진행하세요"
  & $spec.Cli @($spec.Login)
  if ($LASTEXITCODE -ne 0) { Die "로그인하지 못했습니다 — '$($spec.Cli) $($spec.Login -join ' ')' 를 직접 실행한 뒤 다시 설치하세요" }
}

# ---- 4. 러너와 실행 파일 ----
$dir = Join-Path $HOME ".0siri"
New-Item -ItemType Directory -Force -Path $dir, $WorkDir | Out-Null
Invoke-WebRequest -UseBasicParsing -Uri ($Server.TrimEnd("/") + "/osiri-runner.mjs") -OutFile (Join-Path $dir "osiri-runner.mjs")
$launcher = Join-Path $dir "0siri-runner.cmd"
# 경로는 %USERPROFILE% 로 쓴다 — 한글 사용자 이름이어도 cmd 파일은 ASCII 로 남아 인코딩이 깨지지 않는다
@"
@echo off
rem 0Siri runner. This file holds your key - do not share it.
title 0Siri runner
cd /d "%USERPROFILE%\0Siri"
node "%USERPROFILE%\.0siri\osiri-runner.mjs" "$Server" "$Key"
pause
"@ | Set-Content -Encoding ASCII -Path $launcher
Say "설치 끝: $launcher (작업 폴더 $WorkDir)"

# ---- 5. 시작 (새 창 — 그 창을 열어 두면 영시리가 이 PC 의 구독으로 답한다) ----
Start-Process -FilePath $launcher
Say "새 창에서 러너가 돌고 있습니다. 다음부터는 $launcher 를 두 번 누르면 됩니다"
