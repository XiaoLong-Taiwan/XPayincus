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
    'bash deploy/compose/panel.sh setup https://pay.domain https://admin.domain admin@domain [nginx|cloudflare|external]  (同 init，只初始化)' \
    'bash deploy/compose/panel.sh update VERSION SHA256  (驗證 Release 並準備部署檔案；完成後另執行 up)' \
    'bash deploy/compose/panel.sh install [directory]  (預設目前目錄，必須為空目錄)' \
    'bash deploy/compose/panel.sh init https://pay.domain https://admin.domain admin@domain [nginx|cloudflare|external]' \
    'bash deploy/compose/panel.sh up [pull|build]  (預設 pull)' \
    'bash deploy/compose/panel.sh down|status' \
    'bash deploy/compose/panel.sh logs [init|db|api|user|admin|nginx|tunnel-origin|cloudflared]' \
    'bash deploy/compose/panel.sh export [/absolute/path/panel.dump]  (預設 ./backups)' \
    'bash deploy/compose/panel.sh import /absolute/path/panel.dump --confirm-replace-incudal'
}

case "$command_name" in
  help|-h|--help) usage; exit 0 ;;
  setup) command_name=init ;;
  update)
    (($# == 2)) || die 'update 需要固定 VERSION 與 Release Dashboard Compose 資產的可信 SHA256。'
    exec bash "$base/download.sh" update "$base" "$@"
    ;;
  install|init|up|down|status|logs|export|import) ;;
  *) usage; exit 2 ;;
esac

source_root="$(cd -- "$base/../.." && pwd -P)"
if [[ -d "$base/source" ]]; then source_root="$base/source"; fi
required_files=(package.json pnpm-lock.yaml pnpm-workspace.yaml client/package.json client/index.html client/vite.config.ts client/public/runtime-config.js client/src/utils/runtime-config.ts server/package.json server/tsconfig.json server/src/app.ts server/prisma.config.ts server/prisma/schema.prisma server/prisma/migrations/migration_lock.toml server/templates/install.sh server/templates/agent-install.sh server/templates/caddy.sh deploy/compose/Dockerfile deploy/compose/Dockerfile.dockerignore deploy/compose/api-entrypoint.sh deploy/compose/nginx.conf.template deploy/compose/web-entrypoint.sh)
check_sources() {
  local required_file
  for required_file in "${required_files[@]}"; do
    [[ -r "$source_root/$required_file" && -s "$source_root/$required_file" ]] || die "缺少或無法讀取必要檔案：$required_file；請使用完整面板原始碼。"
  done
}

if [[ "$command_name" == install ]]; then
  (($# <= 1)) || die 'install 最多接受一個目的目錄。'
  check_sources
  command -v tar >/dev/null || die '需要 GNU tar。'
  destination="${1:-.}"
  mkdir -p -- "$destination"
  destination="$(cd -- "$destination" && pwd -P)"
  [[ "$destination" != "$source_root" && "$destination" != "$source_root/"* ]] || die '安裝目的地必須位於來源樹之外，避免遞迴複製。'
  [[ -z "$(find "$destination" -mindepth 1 -maxdepth 1 -print -quit)" ]] || die '安裝目的地必須為空目錄，拒絕覆蓋來源或既有部署。'
  mkdir -m 700 -- "$destination/source"
  tar --exclude=node_modules --exclude=dist --exclude='.env*' --exclude=certs \
    --exclude=deploy/compose/.bootstrap \
    --exclude=deploy/compose/secrets --exclude=deploy/compose/backups --exclude=deploy/compose/tls \
    --exclude=deploy/compose/data --exclude=deploy/compose/config --exclude=deploy/compose/.state \
    --exclude=.git --exclude='*.log' --exclude='*.dump' \
    -C "$source_root" -cf - package.json pnpm-lock.yaml pnpm-workspace.yaml client server deploy/compose \
    | tar -C "$destination/source" -xf -
  for deployment_file in docker-compose.yml compose.yaml compose.build.yaml panel.sh download.sh README.md https-proxy.conf.example origin-entrypoint.sh edge-nginx.conf.template tunnel-nginx.conf.template; do
    cp -- "$base/$deployment_file" "$destination/$deployment_file"
  done
  if [[ -f "$base/.env.example" ]]; then cp -- "$base/.env.example" "$destination/.env.example"; fi
  if [[ -f "$base/compose.release.yaml" ]]; then cp -- "$base/compose.release.yaml" "$destination/compose.release.yaml"; fi
  printf '完整建置來源與部署入口已安裝：%s\n請進入該目錄，執行 bash panel.sh init 或放回原設定後匯入 DB。\n' "$destination"
  exit 0
fi

command -v flock >/dev/null || die '需要 Linux util-linux 的 flock。'
mkdir -p -- "$base/.state"
exec 9>"$base/.state/operation.lock"
flock -n 9 || die '另一個面板部署或資料庫操作正在進行。'

if [[ "$command_name" == init ]]; then
  (($# == 3 || $# == 4)) || die 'init 需要使用者 HTTPS origin、管理端 HTTPS origin、管理員電子郵件，以及可選的 nginx、cloudflare 或 external。'
  selected_profile="${4:-nginx}"
  case "$selected_profile" in
    nginx|cloudflare) ;;
    external) selected_profile='' ;;
    *) die '部署模式必須是 nginx、cloudflare 或 external。' ;;
  esac
  origin_pattern='^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$'
  [[ "$1" =~ $origin_pattern && "$2" =~ $origin_pattern ]] || die 'URL 必須是無路徑、無尾斜線的 HTTPS origin。'
  [[ "$1" != "$2" ]] || die '使用者與管理端必須使用不同 origin。'
  user_host="${1#https://}"
  admin_host="${2#https://}"
  [[ "${user_host%%:*}" != "${admin_host%%:*}" ]] || die '使用者與管理端必須使用不同 hostname，供反向代理分流。'
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
  build_context='../..'
  if [[ "$source_root" == "$base/source" ]]; then build_context='./source'; fi
  compose_files='docker-compose.yml'
  if [[ -f "$base/compose.release.yaml" ]]; then compose_files='compose.yaml:compose.release.yaml'; fi
  printf 'FRONTEND_URL=%s\nADMIN_FRONTEND_URL=%s\nADMIN_EMAIL=%s\nUSER_PORT=3000\nADMIN_PORT=3001\nCOMPOSE_PROFILES=%s\nCOMPOSE_FILE=%s\nBUILD_CONTEXT=%s\nHTTPS_PORT=443\nINCUDAL_RELEASE_REPOSITORY=\nINCUDAL_AGENT_RELEASE_REPOSITORY=\n' "$1" "$2" "$3" "$selected_profile" "$compose_files" "$build_context" >"$base/.env"
  if [[ "$selected_profile" == cloudflare ]]; then
    printf '%s\n' '請以安全編輯器將 Tunnel token 寫入 ./secrets/cloudflare_tunnel_token，再設定權限 600；不要把 token 放入 .env 或命令列。'
  elif [[ "$selected_profile" == nginx ]]; then
    printf '%s\n' '請準備 ./tls/user/ 與 ./tls/admin/ 的 fullchain.pem、privkey.pem，再啟動。'
  fi
  printf '設定與獨立密鑰已建立。管理員帳號：admin；密碼存於 %s/secrets/admin_password。請用安全方式讀取。\n' "$base"
  printf '%s\n' '若要匯入既有 DB，啟動前必須還原原 encryption_key、其他密鑰與憑證；新產生的加密金鑰無法解密舊資料。'
  exit 0
fi

[[ -f "$base/.env" ]] || die '請先執行 init。'
command -v docker >/dev/null || die '需要 Docker 與 Compose v2.20.0 以上。'
compose_entry="$base/docker-compose.yml"
if [[ -f "$base/compose.release.yaml" ]]; then compose_entry="$base/compose.yaml"; fi
if [[ "$command_name" == up && "${1:-pull}" == build ]]; then compose_entry="$base/compose.yaml"; fi
compose=(docker compose --project-name incudal-panel --project-directory "$base" --env-file "$base/.env" --file "$compose_entry")
if [[ "$source_root" == "$base/source" ]]; then
  export BUILD_CONTEXT=./source
fi
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

check_secrets() {
  local secret_name
  for secret_name in postgres_password jwt_secret cookie_secret encryption_key admin_password; do
    [[ -r "$base/secrets/$secret_name" && -s "$base/secrets/$secret_name" ]] || die "缺少、無法讀取或為空的 secret：$secret_name；請檢查原有配置，勿重新產生既有密鑰。"
  done
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
    (($# <= 1)) || die 'up 最多接受 pull 或 build。'
    deployment_mode="${1:-pull}"
    case "$deployment_mode" in
      pull) ;;
      build)
        check_sources
        compose+=(--file "$base/compose.build.yaml")
        ;;
      *) die 'up 模式必須為 pull 或 build。' ;;
    esac
    check_secrets
    "${compose[@]}" config --quiet
    configured_profiles="$(awk -F= '$1 == "COMPOSE_PROFILES" { print substr($0, index($0, "=") + 1) }' "$base/.env" | tr -d '\r')"
    configured_profiles="${COMPOSE_PROFILES-$configured_profiles}"
    case "$configured_profiles" in
      nginx)
        for tls_file in user/fullchain.pem user/privkey.pem admin/fullchain.pem admin/privkey.pem; do
          [[ -r "$base/tls/$tls_file" && -s "$base/tls/$tls_file" ]] || die "缺少或無法讀取 TLS 檔案：tls/$tls_file。"
        done
        ;;
      cloudflare)
        [[ -f "$base/secrets/cloudflare_tunnel_token" && -r "$base/secrets/cloudflare_tunnel_token" && -s "$base/secrets/cloudflare_tunnel_token" && ! -L "$base/secrets/cloudflare_tunnel_token" ]] || die '請先安全建立非空的 secrets/cloudflare_tunnel_token 一般檔案。'
        chmod 600 -- "$base/secrets/cloudflare_tunnel_token"
        ;;
      '') ;;
      *) die 'COMPOSE_PROFILES 僅接受 nginx、cloudflare 或空值；不可同時啟用兩種入口。' ;;
    esac
    if [[ "$deployment_mode" == build ]]; then
      "${compose[@]}" build api user admin
      "${compose[@]}" pull --ignore-buildable
    else
      "${compose[@]}" pull --policy always
    fi
    "${compose[@]}" stop user admin api
    "${compose[@]}" --profile nginx --profile cloudflare stop nginx tunnel-origin cloudflared
    "${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 300
    printf '%s\n' '面板已依 COMPOSE_PROFILES 啟動；請依 README 完成 HTTPS 與來源 IP 驗收。'
    ;;
  down)
    (($# == 0)) || die 'down 不接受額外參數。'
    "${compose[@]}" --profile nginx --profile cloudflare down
    ;;
  status)
    (($# == 0)) || die 'status 不接受額外參數。'
    "${compose[@]}" --profile nginx --profile cloudflare ps --all
    ;;
  logs)
    (($# <= 1)) || die 'logs 最多接受一個服務名稱。'
    if (($#)); then
      case "$1" in init|db|api|user|admin|nginx|tunnel-origin|cloudflared) ;; *) die '服務名稱必須是 init、db、api、user、admin、nginx、tunnel-origin 或 cloudflared。' ;; esac
    fi
    "${compose[@]}" logs --tail 100 "$@"
    ;;
  export)
    (($# <= 1)) || die 'export 最多接受一個備份絕對路徑。'
    if (($#)); then
      export_database "$1"
    else
      mkdir -p -- "$base/backups"
      export_database "$base/backups/panel-$(date -u +%Y%m%dT%H%M%SZ)-${RANDOM}.dump"
    fi
    ;;
  import)
    (($# == 2)) || die 'import 需要備份絕對路徑與 --confirm-replace-incudal。'
    [[ "$2" == --confirm-replace-incudal ]] || die '必須明確確認取代 incudal 資料庫。'
    [[ "$1" == /* && -f "$1" && -r "$1" && -s "$1" ]] || die '來源必須是可讀、非空的一般檔案絕對路徑。'
    mkdir -p -- "$base/backups"
    scratch="$(mktemp -d "$base/backups/.panel-import.XXXXXXXX")"
    cp -- "$1" "$scratch/source.dump"
    check_secrets
    "${compose[@]}" config --quiet
    printf '%s\n' '停止面板與 API；還原失敗將維持停機，請先排查後再執行 up。'
    "${compose[@]}" stop user admin api
    "${compose[@]}" up -d --wait --wait-timeout 300 db
    "${compose[@]}" exec -T db pg_restore --list <"$scratch/source.dump" >/dev/null || die '不是有效的 PostgreSQL custom/tar archive，面板維持停止。'
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
