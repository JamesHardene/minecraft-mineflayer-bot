#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP_DIR=/opt/minecraft-bot
CONFIG_DIR=/etc/minecraft-bot
CONFIG_FILE="$CONFIG_DIR/minecraft-bot.env"
DATA_DIR=/var/lib/minecraft-bot
SERVICE_NAME=minecraft-bot.service
SERVICE_USER=minecraft-bot
SERVICE_GROUP=minecraft-bot
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME"

NO_START=0
HOST_ARG=''
PORT_ARG=''
USERNAME_ARG=''
USERNAME_ARG_SET=0
AUTH_ARG=''
AUTH_ARG_SET=0
VERSION_ARG=''
VERSION_ARG_SET=0
PASSWORD_ARG=''
PASSWORD_ARG_SET=0
SERVER_NAME_ARG=''

info() { printf '[mcbot] %s\n' "$*"; }
warn() { printf '[mcbot] 警告：%s\n' "$*" >&2; }
die() { printf '[mcbot] 错误：%s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
用法：sudo ./install-minecraft-bot.sh [选项]

选项：
  --host HOST             Minecraft 服务器地址
  --port PORT             Minecraft 服务器端口，默认 25565
  --username NAME         机器人账号名或 Microsoft 账号
  --auth MODE             microsoft 或 offline，默认 offline
  --offline               --auth offline 的快捷写法
  --version VERSION       Mineflayer 协议版本；省略时自动探测，使用 auto 清除固定版本
  --password PASSWORD     入服后发送 /l PASSWORD；仅保存到受限配置文件
  --server-name NAME      状态面板显示的服务器名称
  --no-start              安装并启用开机自启，但不立即启动服务
  -h, --help              显示帮助

网络探测环境变量：
  MCBOT_GITHUB_MIRRORS    逗号分隔的 GitHub 镜像 URL
  MCBOT_NPM_REGISTRIES    逗号分隔的 npm registry URL
  MCBOT_GITHUB_MAX_LATENCY 直连 GitHub 的质量阈值（秒），默认 2.5
USAGE
}

while (($# > 0)); do
  case "$1" in
    --host)
      (($# >= 2)) || die "--host 需要参数"
      HOST_ARG=$2
      shift 2
      ;;
    --port)
      (($# >= 2)) || die "--port 需要参数"
      PORT_ARG=$2
      shift 2
      ;;
    --username)
      (($# >= 2)) || die "--username 需要参数"
      USERNAME_ARG=$2
      USERNAME_ARG_SET=1
      shift 2
      ;;
    --auth)
      (($# >= 2)) || die "--auth 需要参数"
      AUTH_ARG=$2
      AUTH_ARG_SET=1
      shift 2
      ;;
    --offline)
      AUTH_ARG='offline'
      AUTH_ARG_SET=1
      shift
      ;;
    --version)
      (($# >= 2)) || die "--version 需要参数"
      VERSION_ARG=$2
      VERSION_ARG_SET=1
      shift 2
      ;;
    --password)
      (($# >= 2)) || die "--password 需要参数"
      PASSWORD_ARG=$2
      PASSWORD_ARG_SET=1
      shift 2
      ;;
    --server-name)
      (($# >= 2)) || die "--server-name 需要参数"
      SERVER_NAME_ARG=$2
      shift 2
      ;;
    --no-start)
      NO_START=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "未知选项：$1；使用 --help 查看帮助"
      ;;
  esac
done

[[ "$(id -u)" -eq 0 ]] || die "请使用 root 或 sudo 运行此脚本"
if [[ "$AUTH_ARG_SET" -eq 1 ]]; then
  AUTH_ARG=${AUTH_ARG,,}
  [[ "$AUTH_ARG" == 'offline' || "$AUTH_ARG" == 'microsoft' ]] || die '--auth/--offline 只能是 offline 或 microsoft'
fi
if [[ "$VERSION_ARG_SET" -eq 1 && "${VERSION_ARG,,}" == 'auto' ]]; then
  VERSION_ARG=''
fi
if [[ "$PASSWORD_ARG_SET" -eq 1 ]]; then
  [[ -n "$PASSWORD_ARG" ]] || die '--password 不能为空'
  # Bash 参数和变量无法携带 NUL；这里检查可由 shell 传递的换行和回车。
  [[ "$PASSWORD_ARG" != *$'\n'* && "$PASSWORD_ARG" != *$'\r'* ]] || die '--password 不能包含换行或回车'
  [[ "${#PASSWORD_ARG}" -le 256 ]] || die '--password 最多 256 个字符'
  [[ "${PASSWORD_ARG//[[:space:]]/}" != '' ]] || die '--password 不能全是空白'
fi
[[ -r /etc/os-release ]] || die "找不到 /etc/os-release，无法确认系统类型"
# shellcheck disable=SC1091
. /etc/os-release
if [[ "${ID:-}" != debian && "${ID_LIKE:-}" != *debian* ]]; then
  warn "当前系统不是 Debian 或 Debian 派生系统，脚本仍会继续，但未做兼容性保证"
fi

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
required_sources=(
  package.json
  package-lock.json
  src/bot.js
  src/status-cli.js
  src/config-admin.js
  deploy/minecraft-bot.service
  .env.example
)
for source in "${required_sources[@]}"; do
  [[ -f "$SCRIPT_DIR/$source" ]] || die "缺少源文件：$SCRIPT_DIR/$source"
done

APT_UPDATED=0
apt_install() {
  command -v apt-get >/dev/null 2>&1 || die "找不到 apt-get，无法自动安装依赖"
  if [[ "$APT_UPDATED" -eq 0 ]]; then
    info '更新 apt 软件包索引'
    apt-get update
    APT_UPDATED=1
  fi
  DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
}

if ! command -v curl >/dev/null 2>&1 || [[ ! -f /etc/ssl/certs/ca-certificates.crt ]]; then
  apt_install curl ca-certificates
fi

NODE_MIN_MAJOR=22
NODE_LTS_MAJOR=24
NODE_SOURCE_KEYRING=/etc/apt/keyrings/nodesource.gpg
NODE_SOURCE_LIST=/etc/apt/sources.list.d/nodesource.list

install_node_lts() {
  local key_temp
  info "配置 Node.js ${NODE_LTS_MAJOR} LTS 软件源"
  apt_install ca-certificates curl gnupg
  install -d -m 0755 /etc/apt/keyrings
  key_temp=$(mktemp)
  if ! curl --proto '=https' --proto-redir '=https' -fsSL \
    https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    -o "$key_temp"; then
    rm -f "$key_temp"
    die '无法下载 NodeSource 签名密钥'
  fi
  if ! gpg --dearmor --yes --output "$NODE_SOURCE_KEYRING" "$key_temp"; then
    rm -f "$key_temp"
    die '无法生成 NodeSource APT 签名密钥环'
  fi
  rm -f "$key_temp"
  chmod 0644 "$NODE_SOURCE_KEYRING"
  printf 'deb [signed-by=%s] https://deb.nodesource.com/node_%s.x nodistro main\n' \
    "$NODE_SOURCE_KEYRING" "$NODE_LTS_MAJOR" > "$NODE_SOURCE_LIST"
  chmod 0644 "$NODE_SOURCE_LIST"
  info "更新 NodeSource 软件包索引"
  apt-get update
  APT_UPDATED=1
  info "安装或更新 Node.js ${NODE_LTS_MAJOR} LTS（自带 npm）"
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
}

read_node_major() {
  local binary=$1
  [[ -x "$binary" ]] || { printf '0'; return; }
  "$binary" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0'
}

NODE_BIN=$(command -v node || true)
NPM_BIN=$(command -v npm || true)
node_major=$(read_node_major "$NODE_BIN")
if [[ -z "$NODE_BIN" || "$node_major" -lt "$NODE_LTS_MAJOR" || -z "$NPM_BIN" ]]; then
  install_node_lts
  hash -r 2>/dev/null || true
  NODE_BIN=$(command -v node || true)
  NPM_BIN=$(command -v npm || true)
  if [[ -x /usr/bin/node && "$(read_node_major /usr/bin/node)" -ge "$NODE_LTS_MAJOR" ]]; then
    NODE_BIN=/usr/bin/node
    NPM_BIN=/usr/bin/npm
  fi
  [[ -n "$NODE_BIN" ]] || die '安装后仍找不到 node'
  [[ -n "$NPM_BIN" ]] || die '安装后仍找不到 npm'
  node_major=$(read_node_major "$NODE_BIN")
fi
if [[ -x /usr/bin/node && "$(read_node_major /usr/bin/node)" -ge "$NODE_MIN_MAJOR" ]]; then
  NODE_BIN=/usr/bin/node
  NPM_BIN=/usr/bin/npm
  node_major=$(read_node_major "$NODE_BIN")
fi
[[ "$node_major" -ge "$NODE_MIN_MAJOR" ]] || die "需要 Node.js ${NODE_MIN_MAJOR} 或更高版本，当前版本不足"
NODE_EXEC_PATH=$($NODE_BIN -p 'process.execPath' 2>/dev/null || true)
[[ -x "$NODE_EXEC_PATH" ]] || die "Node.js 可执行文件不可用：$NODE_EXEC_PATH"
NODE_BIN_DIR=$(dirname "$NODE_EXEC_PATH")
export PATH="$NODE_BIN_DIR:$PATH"
if [[ -x "$NODE_BIN_DIR/npm" ]]; then
  NPM_BIN="$NODE_BIN_DIR/npm"
else
  NPM_BIN=$(command -v npm || true)
fi
NPM_VERSION=$($NPM_BIN --version 2>/dev/null || true)
[[ -x "$NPM_BIN" && -n "$NPM_VERSION" ]] || die "npm 可执行文件不可用：$NPM_BIN"
NODE_VERSION=$($NODE_EXEC_PATH --version 2>/dev/null || true)
[[ -n "$NODE_VERSION" ]] || die '无法读取 Node.js 版本'
info "使用 Node.js $NODE_VERSION（$NODE_EXEC_PATH）和 npm $NPM_VERSION（$NPM_BIN）"

command -v systemctl >/dev/null 2>&1 || die '找不到 systemctl；请在使用 systemd 的 Debian 主机上运行'
command -v useradd >/dev/null 2>&1 || die '找不到 useradd'
command -v usermod >/dev/null 2>&1 || die '找不到 usermod'
command -v groupadd >/dev/null 2>&1 || die '找不到 groupadd'
command -v getent >/dev/null 2>&1 || die '找不到 getent'

if systemctl cat "$SERVICE_NAME" >/dev/null 2>&1; then
  info "停止已有 $SERVICE_NAME 以便安全更新 Node.js 和依赖"
  systemctl stop "$SERVICE_NAME" || true
fi

if ! getent group "$SERVICE_GROUP" >/dev/null; then
  groupadd --system "$SERVICE_GROUP"
fi
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --gid "$SERVICE_GROUP" --home-dir "$DATA_DIR" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
else
  usermod --append --groups "$SERVICE_GROUP" "$SERVICE_USER"
fi

CALLER_USER=${SUDO_USER:-}
if [[ -n "$CALLER_USER" && "$CALLER_USER" != 'root' ]] && id "$CALLER_USER" >/dev/null 2>&1; then
  usermod --append --groups "$SERVICE_GROUP" "$CALLER_USER"
  info "已将 $CALLER_USER 加入 $SERVICE_GROUP 组；重新登录或执行 newgrp $SERVICE_GROUP 后可直接使用聊天控制"
fi

install -d -o root -g root -m 0755 "$APP_DIR" "$APP_DIR/src" "$APP_DIR/deploy"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0755 "$DATA_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0700 "$DATA_DIR/auth"
install -d -o root -g "$SERVICE_GROUP" -m 0750 "$CONFIG_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0700 "$DATA_DIR/auth"

for source in "${required_sources[@]}"; do
  destination="$APP_DIR/$source"
  if [[ "$SCRIPT_DIR/$source" != "$destination" ]]; then
    install -o root -g root -m 0644 "$SCRIPT_DIR/$source" "$destination"
  fi
done
chmod 0755 "$APP_DIR/src" "$APP_DIR/deploy"
rm -f "$APP_DIR/src/profile-admin.js" /usr/local/sbin/mcbot-admin

cat > /usr/local/sbin/mcbot-config <<EOF_CONFIG
#!/usr/bin/env bash
set -Eeuo pipefail
exec "$NODE_EXEC_PATH" "$APP_DIR/src/config-admin.js"
EOF_CONFIG
chown root:root /usr/local/sbin/mcbot-config
chmod 0750 /usr/local/sbin/mcbot-config

cat > /usr/local/sbin/mcbot-uninstall <<'EOF_UNINSTALL'
#!/usr/bin/env bash
set -Eeuo pipefail
systemctl disable --now minecraft-bot.service 2>/dev/null || true
rm -f /etc/systemd/system/minecraft-bot.service /usr/local/bin/mcbot /usr/local/sbin/mcbot-admin /usr/local/sbin/mcbot-config /usr/local/sbin/mcbot-uninstall /opt/minecraft-bot/src/profile-admin.js
systemctl daemon-reload
rm -rf /opt/minecraft-bot /etc/minecraft-bot /var/lib/minecraft-bot
userdel minecraft-bot 2>/dev/null || true
groupdel minecraft-bot 2>/dev/null || true
EOF_UNINSTALL
chmod 0750 /usr/local/sbin/mcbot-uninstall

valid_https_url() {
  local url=$1
  [[ "$url" == https://* ]] || return 1
  [[ "$url" != *$'\n'* && "$url" != *$'\r'* && "$url" != *[[:space:]]* ]] || return 1
}

probe_url() {
  local url=$1
  local best_time=''
  local best_code=''
  local attempt result http_code total
  for attempt in 1 2; do
    result=$(curl --proto '=https' --proto-redir '=https' -LfsS --connect-timeout 5 --max-time 15 -o /dev/null -w '%{http_code} %{time_total}' "$url" 2>/dev/null || true)
    http_code=${result%% *}
    total=${result#* }
    if [[ "$http_code" =~ ^[23][0-9][0-9]$ && "$total" != "$result" ]]; then
      if [[ -z "$best_time" ]] || awk -v candidate="$total" -v current="$best_time" 'BEGIN { exit !(candidate < current) }'; then
        best_time=$total
        best_code=$http_code
      fi
    fi
  done
  [[ -n "$best_time" ]] && printf '%s %s\n' "$best_time" "$best_code"
}

append_csv_candidates() {
  local csv=$1
  local item
  [[ -n "$csv" ]] || return 0
  IFS=',' read -r -a csv_items <<< "$csv"
  for item in "${csv_items[@]}"; do
    item="${item#"${item%%[![:space:]]*}"}"
    item="${item%"${item##*[![:space:]]}"}"
    item=${item%/}
    if [[ -n "$item" ]] && valid_https_url "$item"; then
      printf '%s\n' "$item"
    elif [[ -n "$item" ]]; then
      warn "忽略无效的 HTTPS 候选：$item"
    fi
  done
}

# Probe GitHub before npm installation. The selected URL is recorded for future downloads.
GITHUB_MAX_LATENCY=${MCBOT_GITHUB_MAX_LATENCY:-2.5}
[[ "$GITHUB_MAX_LATENCY" =~ ^[0-9]+([.][0-9]+)?$ ]] || die 'MCBOT_GITHUB_MAX_LATENCY 必须是数字（单位：秒）'
GITHUB_CANDIDATES=("https://github.com" "https://ghfast.top/https://github.com")
if [[ -n "${MCBOT_GITHUB_MIRRORS:-}" ]]; then
  while IFS= read -r candidate; do GITHUB_CANDIDATES+=("$candidate"); done < <(append_csv_candidates "$MCBOT_GITHUB_MIRRORS")
fi

info '检测 GitHub 直连和镜像连通性'
github_direct_time=''
github_direct_url='https://github.com'
github_best_url=''
github_best_time=''
github_best_mirror_url=''
github_best_mirror_time=''
for candidate in "${GITHUB_CANDIDATES[@]}"; do
  valid_https_url "$candidate" || { warn "忽略无效的 GitHub 候选：$candidate"; continue; }
  result=$(probe_url "$candidate" || true)
  if [[ -n "$result" ]]; then
    time_value=${result%% *}
    code_value=${result#* }
    info "GitHub 候选 $candidate：HTTP $code_value，最低耗时 ${time_value}s"
    if [[ "$candidate" == "$github_direct_url" ]]; then
      github_direct_time=$time_value
    else
      if [[ -z "$github_best_mirror_time" ]] || awk -v candidate="$time_value" -v current="$github_best_mirror_time" 'BEGIN { exit !(candidate < current) }'; then
        github_best_mirror_url=$candidate
        github_best_mirror_time=$time_value
      fi
    fi
    if [[ -z "$github_best_time" ]] || awk -v candidate="$time_value" -v current="$github_best_time" 'BEGIN { exit !(candidate < current) }'; then
      github_best_url=$candidate
      github_best_time=$time_value
    fi
  else
    warn "GitHub 候选不可用：$candidate"
  fi
done

if [[ -n "$github_direct_time" ]] && awk -v candidate="$github_direct_time" -v limit="$GITHUB_MAX_LATENCY" 'BEGIN { exit !(candidate <= limit) }'; then
  GITHUB_BASE_URL=$github_direct_url
  info "GitHub 直连质量可接受，使用 $GITHUB_BASE_URL"
elif [[ -n "$github_best_mirror_url" ]]; then
  GITHUB_BASE_URL=$github_best_mirror_url
  warn "GitHub 直连不可用或质量较差，切换到镜像 $GITHUB_BASE_URL"
elif [[ -n "$github_best_url" ]]; then
  GITHUB_BASE_URL=$github_best_url
  warn "GitHub 镜像不可用，保留可访问的直连地址 $GITHUB_BASE_URL"
else
  GITHUB_BASE_URL=''
  warn 'GitHub 直连和镜像均不可用；本次安装没有依赖 GitHub 下载，继续探测 npm registry'
fi

NPM_CANDIDATES=("https://registry.npmjs.org" "https://registry.npmmirror.com")
if [[ -n "${MCBOT_NPM_REGISTRIES:-}" ]]; then
  while IFS= read -r candidate; do NPM_CANDIDATES+=("$candidate"); done < <(append_csv_candidates "$MCBOT_NPM_REGISTRIES")
fi

info '检测 npm registry 连通性'
NPM_REGISTRY=''
NPM_BEST_TIME=''
NPM_AVAILABLE_REGISTRIES=()
for candidate in "${NPM_CANDIDATES[@]}"; do
  candidate=${candidate%/}
  valid_https_url "$candidate" || { warn "忽略无效的 npm registry：$candidate"; continue; }
  result=$(probe_url "$candidate/mineflayer" || true)
  if [[ -n "$result" ]]; then
    time_value=${result%% *}
    code_value=${result#* }
    info "npm 候选 $candidate：HTTP $code_value，最低耗时 ${time_value}s"
    NPM_AVAILABLE_REGISTRIES+=("$candidate")
    if [[ -z "$NPM_BEST_TIME" ]] || awk -v candidate="$time_value" -v current="$NPM_BEST_TIME" 'BEGIN { exit !(candidate < current) }'; then
      NPM_REGISTRY=$candidate
      NPM_BEST_TIME=$time_value
    fi
  else
    warn "npm registry 不可用：$candidate"
  fi
done
[[ -n "$NPM_REGISTRY" ]] || die '所有 npm registry 均不可用，安装停止；请检查网络后重试'

write_npmrc() {
  cat > "$APP_DIR/.npmrc" <<EOF_NPMRC
registry=$NPM_REGISTRY
fund=false
audit=true
EOF_NPMRC
  chmod 0644 "$APP_DIR/.npmrc"
}

write_npmrc
cat > "$APP_DIR/.network.env" <<EOF_NETWORK
# Generated by install-minecraft-bot.sh; no credentials are stored here.
GITHUB_BASE_URL=$GITHUB_BASE_URL
NPM_REGISTRY=$NPM_REGISTRY
EOF_NETWORK
chmod 0644 "$APP_DIR/.network.env"

install_npm_dependencies() {
  local npm_action=$1
  local registry
  local attempted=''
  local succeeded=0
  for registry in "$NPM_REGISTRY" "${NPM_AVAILABLE_REGISTRIES[@]}"; do
    [[ -n "$registry" && "$registry" != "$attempted" ]] || continue
    attempted=$registry
    NPM_REGISTRY=$registry
    write_npmrc
    info "使用 npm registry 安装依赖：$registry"
    if (umask 022; "$NPM_BIN" --userconfig "$APP_DIR/.npmrc" --registry "$registry" "$npm_action" --omit=dev --prefix "$APP_DIR" --no-audit --no-fund --engine-strict); then
      succeeded=1
      break
    fi
    warn "npm 从 $registry 安装失败，尝试下一个候选"
  done
  [[ "$succeeded" -eq 1 ]] || return 1
  {
    printf '# Generated by install-minecraft-bot.sh; no credentials are stored here.\n'
    printf 'GITHUB_BASE_URL=%s\n' "$GITHUB_BASE_URL"
    printf 'NPM_REGISTRY=%s\n' "$NPM_REGISTRY"
  } > "$APP_DIR/.network.env"
}

if ! install_npm_dependencies ci; then
  warn 'npm ci 失败，可能是旧部署的 lockfile 与 package.json 不一致；改用 npm install 更新依赖锁定文件'
  install_npm_dependencies install || die '所有可用 npm registry 都安装失败'
fi

MINEFLAYER_VERSION=$(
  cd "$APP_DIR" && "$NODE_EXEC_PATH" -p "require('mineflayer/package.json').version" 2>/dev/null || true
)
[[ "$MINEFLAYER_VERSION" == '4.39.0' ]] ||
  die "Mineflayer 版本验证失败：期望 4.39.0，实际为 ${MINEFLAYER_VERSION:-未安装}"

if ! (cd "$APP_DIR" && "$NODE_EXEC_PATH" -e "require.resolve('mineflayer')"); then
  die 'npm 安装命令返回成功，但仍无法加载 mineflayer；请检查 node_modules、npm registry 和磁盘空间后重试'
fi
if ! (cd "$APP_DIR" && "$NPM_BIN" --userconfig "$APP_DIR/.npmrc" ls mineflayer --depth=0 >/dev/null); then
  die 'Mineflayer 依赖树校验失败；请检查 npm ls mineflayer --depth=0 的输出后重试'
fi

chown -R root:"$SERVICE_GROUP" "$APP_DIR/node_modules"
find "$APP_DIR/node_modules" -type d -exec chmod 0755 {} +
find "$APP_DIR/node_modules" -type f -exec chmod 0644 {} +

write_env_value() {
  local key=$1
  local value=$2
  value=${value//$'\r'/}
  value=${value//$'\n'/}
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '%s="%s"\n' "$key" "$value"
}

validate_single_line() {
  [[ "$1" != *$'\n'* && "$1" != *$'\r'* ]] || die '配置值不能包含换行'
}

validate_password_value() {
  local value=$1
  [[ -n "$value" ]] || die '--password/MC_LOGIN_PASSWORD 不能为空'
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die '--password/MC_LOGIN_PASSWORD 不能包含换行'
  [[ "${#value}" -le 256 ]] || die '--password/MC_LOGIN_PASSWORD 最多 256 个字符'
  [[ "${value//[[:space:]]/}" != '' ]] || die '--password/MC_LOGIN_PASSWORD 不能全是空白'
}

update_env_key() {
  local file=$1
  local key=$2
  local value=$3
  local temp rendered line found=0
  temp=$(mktemp "${file}.tmp.XXXXXX") || die "无法创建配置临时文件：$file"
  rendered=$(write_env_value "$key" "$value")
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$key="* ]]; then
      if [[ "$found" -eq 0 ]]; then
        printf '%s\n' "$rendered" >> "$temp"
        found=1
      fi
    else
      printf '%s\n' "$line" >> "$temp"
    fi
  done < "$file"
  if [[ "$found" -eq 0 ]]; then
    printf '%s\n' "$rendered" >> "$temp"
  fi
  chmod 0640 "$temp"
  mv -f "$temp" "$file"
}

has_nonempty_config_value() {
  local key=$1
  awk -F= -v key="$key" '
    $1 == key {
      value = substr($0, index($0, "=") + 1)
      if (value != "" && value != "\"\"") found = 1
    }
    END { exit(found ? 0 : 1) }
  ' "$CONFIG_FILE"
}

if [[ ! -f "$CONFIG_FILE" ]]; then
  HOST_VALUE=${HOST_ARG:-${MC_HOST:-}}
  PORT_VALUE=${PORT_ARG:-${MC_PORT:-25565}}
  USERNAME_VALUE=${USERNAME_ARG:-${MC_USERNAME:-}}
  AUTH_VALUE=${AUTH_ARG:-${MC_AUTH:-offline}}
  if [[ "$VERSION_ARG_SET" -eq 1 ]]; then
    VERSION_VALUE=$VERSION_ARG
  elif [[ "${MC_VERSION+x}" == x ]]; then
    VERSION_VALUE=$MC_VERSION
  else
    VERSION_VALUE=''
  fi
  [[ "${VERSION_VALUE,,}" == 'auto' ]] && VERSION_VALUE=''
  if [[ "$PASSWORD_ARG_SET" -eq 1 ]]; then
    PASSWORD_VALUE=$PASSWORD_ARG
  elif [[ "${MC_LOGIN_PASSWORD+x}" == x ]]; then
    PASSWORD_VALUE=$MC_LOGIN_PASSWORD
  else
    PASSWORD_VALUE=''
  fi
  SERVER_NAME_VALUE=${SERVER_NAME_ARG:-${MC_SERVER_NAME:-}}

  if [[ -t 0 ]]; then
    [[ -n "$HOST_VALUE" ]] || read -r -p 'Minecraft 服务器地址：' HOST_VALUE
    [[ -n "$USERNAME_VALUE" ]] || read -r -p '机器人账号名或 Microsoft 账号：' USERNAME_VALUE
    if [[ -z "$PORT_ARG" && -z "${MC_PORT:-}" ]]; then read -r -p '端口 [25565]：' PORT_VALUE; PORT_VALUE=${PORT_VALUE:-25565}; fi
    if [[ -z "$AUTH_ARG" && -z "${MC_AUTH:-}" ]]; then read -r -p '认证模式 [offline/microsoft]（默认 offline）：' AUTH_VALUE; AUTH_VALUE=${AUTH_VALUE:-offline}; fi
    if [[ -z "$SERVER_NAME_VALUE" ]]; then read -r -p '服务器名称（默认使用地址）：' SERVER_NAME_VALUE; fi
  fi

  [[ -n "$HOST_VALUE" ]] || die '缺少服务器地址；请使用 --host 或交互式输入'
  [[ -n "$USERNAME_VALUE" ]] || die '缺少机器人账号；请使用 --username 或交互式输入'
  SERVER_NAME_VALUE=${SERVER_NAME_VALUE:-$HOST_VALUE}
  AUTH_VALUE=${AUTH_VALUE,,}
  [[ "$AUTH_VALUE" == 'offline' || "$AUTH_VALUE" == 'microsoft' ]] || die '--auth 只能是 offline 或 microsoft'
  [[ "$PORT_VALUE" =~ ^[0-9]+$ && "$PORT_VALUE" -ge 1 && "$PORT_VALUE" -le 65535 ]] || die '--port 必须是 1 到 65535 的整数'
  for value in "$HOST_VALUE" "$USERNAME_VALUE" "$AUTH_VALUE" "$VERSION_VALUE" "$SERVER_NAME_VALUE"; do validate_single_line "$value"; done

  {
    write_env_value MC_HOST "$HOST_VALUE"
    write_env_value MC_PORT "$PORT_VALUE"
    write_env_value MC_USERNAME "$USERNAME_VALUE"
    write_env_value MC_AUTH "$AUTH_VALUE"
    write_env_value MC_VERSION "$VERSION_VALUE"
    write_env_value MC_SERVER_NAME "$SERVER_NAME_VALUE"
    write_env_value MC_LOGIN_DELAY_SECONDS '3'
    write_env_value MC_LOGIN_COMMAND '/l'
    if [[ -n "$PASSWORD_VALUE" ]]; then
      validate_password_value "$PASSWORD_VALUE"
      write_env_value MC_LOGIN_PASSWORD "$PASSWORD_VALUE"
    fi
    write_env_value MC_RECONNECT_INITIAL_SECONDS '5'
    write_env_value MC_RECONNECT_MAX_SECONDS '300'
    write_env_value MC_RECONNECT_JITTER_SECONDS '3'
    write_env_value MC_STATUS_INTERVAL_SECONDS '3'
    write_env_value MC_ANTIAFK 'true'
    write_env_value MC_ANTIAFK_INTERVAL_SECONDS '45'
    write_env_value MCBOT_DATA_DIR "$DATA_DIR"
    write_env_value MCBOT_STATUS_FILE "$DATA_DIR/status.json"
    write_env_value MCBOT_CONTROL_SOCKET '/run/minecraft-bot/control.sock'
    write_env_value MCBOT_CONTROL_MAX_TEXT '256'
    write_env_value MC_PROFILES_FOLDER "$DATA_DIR/auth"
  } > "$CONFIG_FILE"
  info "已创建配置文件：$CONFIG_FILE"
else
  grep -Eq '^MC_HOST=' "$CONFIG_FILE" || die "$CONFIG_FILE 缺少 MC_HOST"
  grep -Eq '^MC_USERNAME=' "$CONFIG_FILE" || die "$CONFIG_FILE 缺少 MC_USERNAME"
  if [[ "$USERNAME_ARG_SET" -eq 1 ]]; then
    [[ -n "$USERNAME_ARG" ]] || die '--username 不能为空'
    validate_single_line "$USERNAME_ARG"
    update_env_key "$CONFIG_FILE" MC_USERNAME "$USERNAME_ARG"
    info '已按明确参数更新 MC_USERNAME'
  fi
  if [[ "$AUTH_ARG_SET" -eq 1 ]]; then
    update_env_key "$CONFIG_FILE" MC_AUTH "$AUTH_ARG"
    info "已按明确参数更新 MC_AUTH=$AUTH_ARG"
  fi
  if [[ "$VERSION_ARG_SET" -eq 1 ]]; then
    validate_single_line "$VERSION_ARG"
    update_env_key "$CONFIG_FILE" MC_VERSION "$VERSION_ARG"
    if [[ -n "$VERSION_ARG" ]]; then
      info "已按明确参数更新 MC_VERSION"
    else
      info '已清除 MC_VERSION，启动时将自动探测协议版本'
    fi
  fi
  if [[ "$PASSWORD_ARG_SET" -eq 1 ]]; then
    validate_password_value "$PASSWORD_ARG"
    update_env_key "$CONFIG_FILE" MC_LOGIN_PASSWORD "$PASSWORD_ARG"
    info '已更新服务器插件登录密码（密码不会输出）'
  elif [[ "${MC_LOGIN_PASSWORD+x}" == x && -n "${MC_LOGIN_PASSWORD:-}" ]]; then
    validate_password_value "$MC_LOGIN_PASSWORD"
    update_env_key "$CONFIG_FILE" MC_LOGIN_PASSWORD "$MC_LOGIN_PASSWORD"
    info '已按环境变量更新服务器插件登录密码（密码不会输出）'
  fi
  if ! grep -q '^MC_LOGIN_DELAY_SECONDS=' "$CONFIG_FILE"; then
    printf '\nMC_LOGIN_DELAY_SECONDS="3"\n' >> "$CONFIG_FILE"
  fi
  if ! grep -q '^MC_LOGIN_COMMAND=' "$CONFIG_FILE"; then
    printf 'MC_LOGIN_COMMAND="/l"\n' >> "$CONFIG_FILE"
  fi
  if ! grep -q '^MCBOT_CONTROL_SOCKET=' "$CONFIG_FILE"; then
    printf '\nMCBOT_CONTROL_SOCKET="/run/minecraft-bot/control.sock"\n' >> "$CONFIG_FILE"
  fi
  if ! grep -q '^MCBOT_CONTROL_MAX_TEXT=' "$CONFIG_FILE"; then
    printf '\nMCBOT_CONTROL_MAX_TEXT="256"\n' >> "$CONFIG_FILE"
  fi

  info "保留已有配置文件：$CONFIG_FILE"
fi
chown root:"$SERVICE_GROUP" "$CONFIG_FILE"
chmod 0640 "$CONFIG_FILE"

sed \
  -e "s|^WorkingDirectory=.*$|WorkingDirectory=$APP_DIR|" \
  -e "s|^EnvironmentFile=.*$|EnvironmentFile=-$CONFIG_FILE|" \
  -e "s|^Environment=HOME=.*$|Environment=HOME=$DATA_DIR|" \
  -e "s|^Environment=MCBOT_DATA_DIR=.*$|Environment=MCBOT_DATA_DIR=$DATA_DIR|" \
  -e "s|^Environment=MCBOT_STATUS_FILE=.*$|Environment=MCBOT_STATUS_FILE=$DATA_DIR/status.json|" \
  -e "s|^Environment=MCBOT_CONTROL_SOCKET=.*$|Environment=MCBOT_CONTROL_SOCKET=/run/minecraft-bot/control.sock|" \
  -e "s|^ExecStart=.*$|ExecStart=$NODE_EXEC_PATH $APP_DIR/src/bot.js|" \
  -e "s|^ReadWritePaths=.*$|ReadWritePaths=$DATA_DIR /run/minecraft-bot|" \
  "$SCRIPT_DIR/deploy/minecraft-bot.service" > "$SERVICE_FILE"
chmod 0644 "$SERVICE_FILE"

cat > /usr/local/bin/mcbot <<EOF_MCBOT
#!/usr/bin/env bash
export MCBOT_STATUS_FILE="\${MCBOT_STATUS_FILE:-$DATA_DIR/status.json}"
export MCBOT_CONTROL_SOCKET="\${MCBOT_CONTROL_SOCKET:-/run/minecraft-bot/control.sock}"
export MCBOT_CONFIG_ADMIN="\${MCBOT_CONFIG_ADMIN:-/usr/local/sbin/mcbot-config}"
exec "$NODE_EXEC_PATH" "$APP_DIR/src/status-cli.js" "\$@"
EOF_MCBOT
chmod 0755 /usr/local/bin/mcbot

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
if [[ "$NO_START" -eq 0 ]]; then
  systemctl restart "$SERVICE_NAME"
  info '服务已启动'
else
  info '按 --no-start 要求未立即启动服务'
fi

info '安装完成'
printf '\n'
printf '状态面板：mcbot\n'
printf '单次状态：mcbot once\n'
printf '机器人发言：mcbot say "你好"\n'
printf 'Minecraft 指令：mcbot command list\n'
printf '交互聊天：mcbot chat\n'
if has_nonempty_config_value MC_LOGIN_PASSWORD; then
  printf '服务器插件自动登录：已配置（密码不会显示）\n'
else
  printf '服务器插件自动登录：未配置\n'
fi
printf '日志跟踪：mcbot logs\n'
printf '服务状态：systemctl status %s\n' "$SERVICE_NAME"
printf '配置文件：%s\n' "$CONFIG_FILE"
