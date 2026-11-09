#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077

fail() { printf '錯誤：%s\n' "$*" >&2; exit 1; }
usage() {
  printf '%s\n' \
    'bash scripts/manage.sh                              數字選單' \
    'bash scripts/manage.sh --dashboard [menu [DIRECTORY]|install DIRECTORY latest|...]' \
    'bash scripts/manage.sh --agent [--action install|reinstall|update|local|status|logs ...]' \
    '路由後的參數原樣傳給子入口；不自動 sudo，Agent 安裝／更新需自行以 root 執行。'
}
work=''
trap 'if [[ -n "$work" ]]; then rm -rf -- "$work"; fi' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
root=''
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
fi
run_menu() {
  local route="$1" relative entry url status
  shift
  case "$route" in
    dashboard) relative='scripts/dashboard.sh' ;;
    agent)
      relative='scripts/agent-menu.sh'
      printf '%s\n' 'Agent 安裝／更新需要 root；權限不足時請自行以 sudo bash manage.sh --agent 執行。' >&2
      ;;
  esac
  if [[ -n "$root" && -f "$root/$relative" && -r "$root/$relative" ]]; then
    entry="$root/$relative"
  else
    if [[ -z "$work" ]]; then
      work="$(mktemp -d "${TMPDIR:-/tmp}/xpayincus-manage.XXXXXXXX")" || fail '無法建立私人暫存目錄。'
    fi
    entry="$work/${route}.sh"
    url="https://raw.githubusercontent.com/XiaoLong-Taiwan/XPayincus/main/$relative"
    if command -v curl >/dev/null 2>&1; then
      if curl -q -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 60 --retry 2 -o "$entry" "$url"; then
        :
      else
        status=$?
        fail "HTTPS 下載失敗（curl exit=$status）：$url；請檢查 HTTP 狀態、DNS、TLS、代理及 repository 權限；403 不一定是限流。"
      fi
    elif command -v wget >/dev/null 2>&1; then
      if wget --no-config --https-only --timeout=60 --tries=3 -O "$entry" "$url"; then
        :
      else
        status=$?
        fail "HTTPS 下載失敗（wget exit=$status）：$url；請檢查 HTTP 狀態、DNS、TLS、代理及 repository 權限；403 不一定是限流。"
      fi
    else
      fail '下載子入口需要 curl 或 wget。'
    fi
    [[ -s "$entry" ]] || fail "HTTPS 下載得到空檔：$url"
  fi
  bash "$entry" "$@"
}
case "${1:-}" in
  --dashboard|--agent)
    route="${1#--}"
    shift
    run_menu "$route" "$@"
    exit "$?"
    ;;
  --help|-h) usage; exit 0 ;;
  '') (($# == 0)) || fail '無效的空參數。' ;;
  *) usage >&2; fail '未知參數；請使用 --dashboard 或 --agent。' ;;
esac
{ exec 8<>/dev/tty; } 2>/dev/null || fail '數字選單需要可用的 /dev/tty；無終端請使用 --dashboard 或 --agent 加子入口參數。'
while true; do
  printf '\nXPayincus\n1) Dashboard / Compose 選單\n2) Agent 選單\n0) 退出\n請選擇：' >&8
  IFS= read -r choice <&8 || exit 0
  case "$choice" in
    1) run_menu dashboard ;;
    2) run_menu agent ;;
    0) exit 0 ;;
    *) printf '請輸入 1、2 或 0。\n' >&8 ;;
  esac
done
