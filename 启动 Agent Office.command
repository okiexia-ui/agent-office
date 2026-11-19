#!/bin/zsh
# 双击启动本机 Agent Office：工作台会在浏览器中打开。关闭这个窗口或按 Ctrl+C 即可停止。
# Double-click to start the local Agent Office. Close this window or press Ctrl+C to stop it.

cd "${0:A:h}" || exit 1
# Terminal may not load the shell profile; include the usual Node.js locations.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$PATH"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
  nvm use --silent >/dev/null 2>&1
fi

pause() {
  echo
  read -k 1 "?按任意键关闭这个窗口…"
  echo
}

if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。Agent Office 本地版需要 Node.js 22.19 或更新版本。"
  echo "请从 https://nodejs.org 安装长期支持版（LTS），或在终端运行：brew install node"
  pause
  exit 1
fi
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1)'; then
  echo "Agent Office 本地版需要 Node.js 22.19 或更新版本，当前是 $(node --version)。"
  echo "请从 https://nodejs.org 安装长期支持版（LTS），或在终端运行：brew upgrade node"
  pause
  exit 1
fi

# Dependencies are installed the first time, and again after an update changes them.
if [[ ! -f node_modules/.package-lock.json || package-lock.json -nt node_modules/.package-lock.json ]]; then
  echo "正在安装依赖（只在第一次和更新后需要，请保持联网）…"
  if ! npm ci --no-audit --no-fund; then
    echo "依赖安装失败。请检查网络后再双击一次。"
    pause
    exit 1
  fi
fi

echo "正在启动 Agent Office…  关闭这个窗口或按 Ctrl+C 停止。"
npm start
code=$?
# 130 is Ctrl+C. Keep the window open after a real error so the message can be read.
if [[ $code -ne 0 && $code -ne 130 ]]; then
  pause
fi
exit $code
