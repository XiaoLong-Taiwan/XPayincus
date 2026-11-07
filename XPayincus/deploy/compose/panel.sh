set -Eeuo pipefail
set +x
umask 077

base="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
command_name="${1:-help}"
if (($#)); then shift; fi

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

usage() {
  printf '%s\n' \
    'bash deploy/compose/panel.sh init https://pay.domain https://admin.domain admin@domain' \
    'bash deploy/compose/panel.sh up|down|status' \
    'bash deploy/compose/panel.sh logs [db|api|user|admin]' \
    'bash deploy/compose/panel.sh export /absolute/path/panel.dump' \
    'bash deploy/compose/panel.sh import /absolute/path/panel.dump --confirm-replace-incudal'
}

case "$command_name" in
  help|-h|--help) usage; exit 0 ;;
  init|up|down|status|logs|export|import) ;;
  *) usage; exit 2 ;;
esac

command -v flock >/dev/null || die '需要 Linux util-linux 的 flock。'
mkdir -p -- "$base/.state"
exec 9>"$base/.state/operation.lock"
flock -n 9 || die '另一個面板部署或資料庫操作正在進行。'

if [[ "$command_name" == init ]]; then
  (($# == 3)) || die 'init 需要使用者 HTTPS origin、管理端 HTTPS origin、管理員電子郵件。'
  origin_pattern='^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$'
  [[ "$1" =~ $origin_pattern && "$2" =~ $origin_pattern ]] || die 'URL 必須是無路徑、無尾斜線的 HTTPS origin。'
  [[ "$1" != "$2" ]] || die '使用者與管理端必須使用不同 origin。'
  [[ "$3" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || die '電子郵件格式不支援。'
  [[ ! -e "$base/.env" && ! -L "$base/.env" && ! -e "$base/secrets" && ! -L "$base/secrets" ]] || die '已有設定或 secrets，拒絕覆蓋。'
  command -v openssl >/dev/null || die '需要 openssl。'
  mkdir -m 700 -- "$base/secrets"
  openssl rand -hex 32 >"$base/secrets/postgres_password"
  for secret_name in jwt_secret cookie_secret encryption_key admin_password; do
    secret_value="$(openssl rand -base64 48 | tr -d '\n')"
    printf 'Aa1!%s\n' "$secret_value" >"$base/secrets/$secret_name"
  done
  unset secret_value
  printf 'FRONTEND_URL=%s\nADMIN_FRONTEND_URL=%s\nADMIN_EMAIL=%s\nUSER_PORT=8080\nADMIN_PORT=8081\n' "$1" "$2" "$3" >"$base/.env"
  printf '%s\n' '設定與獨立密鑰已建立。管理員帳號：admin；密碼存於 deploy/compose/secrets/admin_password。請用安全方式讀取。'
  exit 0
fi

[[ -f "$base/.env" ]] || die '請先執行 init。'
command -v docker >/dev/null || die '需要 Docker 與 Compose v2。'
compose=(docker compose --project-name incudal-panel --env-file "$base/.env" --file "$base/compose.yaml")
if [[ -e "$base/compose.release.yaml" || -L "$base/compose.release.yaml" ]]; then
  [[ -f "$base/compose.release.yaml" && -r "$base/compose.release.yaml" && -s "$base/compose.release.yaml" ]] || die 'compose.release.yaml 必須是可讀、非空的一般檔案。'
  compose+=(--file "$base/compose.release.yaml")
fi
scratch=''
cleanup() {
  if [[ -n "$scratch" ]]; then rm -rf -- "$scratch"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

dump_database() {
  "${compose[@]}" exec -T db sh -eu -c '
    export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"
    exec pg_dump --host=127.0.0.1 --username=incudal --dbname=incudal --format=custom --no-owner --no-acl
  '
}

export_database() {
  local destination="$1" parent filename
  [[ "$destination" == /* ]] || die '備份目的地必須是絕對路徑。'
  parent="$(dirname -- "$destination")"
  filename="$(basename -- "$destination")"
  [[ -d "$parent" && ! -e "$destination" && ! -L "$destination" ]] || die '目的目錄必須存在，且不得覆蓋既有檔案。'
  scratch="$(mktemp -d "$parent/.panel-export.XXXXXXXX")"
  if ! dump_database >"$scratch/archive"; then die '匯出失敗，未產生目的備份。'; fi
  [[ -s "$scratch/archive" ]] || die '匯出結果為空，拒絕保留。'
  ln -- "$scratch/archive" "$parent/$filename" || die '無法原子建立備份，未覆蓋目的檔案。'
  rm -rf -- "$scratch"
  scratch=''
  printf '已匯出：%s\n' "$destination"
}

case "$command_name" in
  up)
    (($# == 0)) || die 'up 不接受額外參數。'
    for required_file in package.json pnpm-lock.yaml pnpm-workspace.yaml client/package.json client/index.html client/vite.config.ts server/package.json server/tsconfig.json server/src/app.ts server/prisma.config.ts server/prisma/schema.prisma server/prisma/migrations/migration_lock.toml server/templates/install.sh server/templates/agent-install.sh server/templates/caddy.sh deploy/compose/Dockerfile deploy/compose/Dockerfile.dockerignore deploy/compose/api-entrypoint.sh deploy/compose/nginx.conf.template; do
      [[ -r "$base/../../$required_file" && -s "$base/../../$required_file" ]] || die "缺少或無法讀取必要檔案：$required_file；請使用完整面板原始碼。"
    done
    for secret_name in postgres_password jwt_secret cookie_secret encryption_key admin_password; do
      [[ -r "$base/secrets/$secret_name" && -s "$base/secrets/$secret_name" ]] || die "缺少、無法讀取或為空的 secret：$secret_name；請檢查原有配置，勿重新產生既有密鑰。"
    done
    "${compose[@]}" config --quiet
    "${compose[@]}" build
    "${compose[@]}" stop user admin api
    "${compose[@]}" up -d --wait --wait-timeout 300
    printf '%s\n' '面板已啟動。HTTPS 與真實來源 IP 請依 README 設定宿主機反向代理。'
    ;;
  down)
    (($# == 0)) || die 'down 不接受額外參數。'
    "${compose[@]}" down
    ;;
  status)
    (($# == 0)) || die 'status 不接受額外參數。'
    "${compose[@]}" ps --all
    ;;
  logs)
    (($# <= 1)) || die 'logs 最多接受一個服務名稱。'
    if (($#)); then
      case "$1" in db|api|user|admin) ;; *) die '服務名稱必須是 db、api、user 或 admin。' ;; esac
    fi
    "${compose[@]}" logs --tail 100 "$@"
    ;;
  export)
    (($# == 1)) || die 'export 需要一個備份絕對路徑。'
    export_database "$1"
    ;;
  import)
    (($# == 2)) || die 'import 需要備份絕對路徑與 --confirm-replace-incudal。'
    [[ "$2" == --confirm-replace-incudal ]] || die '必須明確確認取代 incudal 資料庫。'
    [[ "$1" == /* && -f "$1" && -r "$1" && -s "$1" ]] || die '來源必須是可讀、非空的一般檔案絕對路徑。'
    mkdir -p -- "$base/backups"
    scratch="$(mktemp -d "$base/backups/.panel-import.XXXXXXXX")"
    cp -- "$1" "$scratch/source.dump"
    "${compose[@]}" exec -T db pg_restore --list <"$scratch/source.dump" >/dev/null || die '不是有效的 PostgreSQL custom/tar archive，尚未停止面板。'
    printf '%s\n' '停止面板與 API；還原失敗將維持停機，請先排查後再執行 up。'
    "${compose[@]}" stop user admin api
    safety_backup="$base/backups/before-import-$(date -u +%Y%m%dT%H%M%SZ)-${RANDOM}.dump"
    if ! dump_database >"$scratch/before.dump"; then die '還原前備份失敗，拒絕匯入，面板維持停止。'; fi
    [[ -s "$scratch/before.dump" ]] || die '還原前備份為空，拒絕匯入。'
    ln -- "$scratch/before.dump" "$safety_backup" || die '無法保留還原前備份，拒絕匯入。'
    printf '還原前備份：%s\n' "$safety_backup"
    "${compose[@]}" exec -T db sh -eu -c '
      export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"
      exec pg_restore --host=127.0.0.1 --username=incudal --dbname=incudal --clean --if-exists --single-transaction --exit-on-error --no-owner --no-acl
    ' <"$scratch/source.dump" || die '匯入失敗；資料庫交易已回滾，面板維持停止。'
    printf '%s\n' '資料庫已匯入；面板維持停止。請確認密鑰、憑證與程式版本相容後執行 up。'
    ;;
esac
