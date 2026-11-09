#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
prompt() {
  [ -r /dev/tty ] && [ -w /dev/tty ] || fail '互動操作需要 /dev/tty；可用 --action 與參數執行。'
  IFS= read -r -p "$2" "$1" </dev/tty || fail '輸入取消'
}
action=''
panel=''
version='latest'
binary=''
token_file=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --action|--panel-url|--version|--binary|--token-file)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail '參數缺少值'
      case "$1" in
        --action) action="$2" ;; --panel-url) panel="$2" ;; --version) version="$2" ;;
        --binary) binary="$2" ;; --token-file) token_file="$2" ;;
      esac
      shift 2 ;;
    --help|-h)
      printf '%s\n' 'agent-menu.sh [--action install|reinstall|update|local|status|logs] [--panel-url ORIGIN] [--version latest|vSemVer] [--binary FILE] [--token-file FILE]'
      exit 0 ;;
    *) fail '未知參數' ;;
  esac
done
if [ -z "$action" ]; then
  printf '%s\n' '1) 新裝 Agent' '2) 僅重裝 Agent（保留設定）' '3) 更新 Agent 至最新穩定版' '4) 本地 binary 重裝' '5) Agent 狀態' '6) Agent 日誌' '0) 返回'
  prompt choice '請選擇：'
  case "$choice" in 1) action=install ;; 2) action=reinstall ;; 3) action=update ;; 4) action=local ;; 5) action=status ;; 6) action=logs ;; 0) exit 0 ;; *) fail '無效選項' ;; esac
fi
case "$action" in
  status) exec systemctl --no-pager status incudal-agent ;;
  logs) exec journalctl --no-pager -u incudal-agent -n 100 ;;
  install|reinstall|update|local) ;;
  *) fail '無效操作' ;;
esac
[ "$(id -u)" = 0 ] || fail '請以 root 執行安裝或更新'
args=()
if [ "$action" != install ]; then
  [ -z "$panel$token_file" ] || fail '重裝不接受新地址或 TOKEN'
  config="${INCUDAL_CONFIG_FILE:-/etc/incudal-agent/config.yaml}"
  [ -f "$config" ] && [ ! -L "$config" ] || fail '找不到既有 Agent 設定'
  panel="$(sed -nE 's/^panel_url: "([^"\\]+)"$/\1/p' "$config")"
  args+=(--reinstall)
else
  [ -n "$panel" ] || prompt panel 'Panel URL: '
  args+=(--panel-url "$panel")
  [ -z "$token_file" ] || args+=(--token-file "$token_file")
fi
[[ "$panel" =~ ^https?://([a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(:[0-9]{1,5})?/?$ ]] || fail '面板地址須為無帳密、路徑及查詢的 HTTP(S) origin'
if [ "$action" = local ]; then
  [ -n "$binary" ] || prompt binary '本地未壓縮 binary 路徑：'
  args+=(--binary "$binary")
elif [ -n "$binary" ]; then
  fail '--binary 僅適用 local'
fi
args+=(--version "$version")
work="$(mktemp -d)"
trap 'rm -f "$work/agent-install.sh"; rmdir "$work"' EXIT
url="${panel%/}/api/agent/install.sh"
if command -v curl >/dev/null 2>&1; then
  curl -q -fsS --proto '=http,https' --connect-timeout 10 --max-time 60 --retry 2 -o "$work/agent-install.sh" "$url"
elif command -v wget >/dev/null 2>&1; then
  wget --no-config --max-redirect=0 --timeout=60 --tries=3 -O "$work/agent-install.sh" "$url"
else
  fail '需要 curl 或 wget'
fi
bash "$work/agent-install.sh" "${args[@]}"
