#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPO=${MCBOT_GITHUB_REPO:-JamesHardene/minecraft-mineflayer-bot}
RELEASE_TAG=${MCBOT_RELEASE_TAG:-latest}
RELEASE_SHA256=${MCBOT_RELEASE_SHA256:-}
ASSET_NAME=minecraft-bot-debian.zip
WORK_DIR=''

info() { printf '[mcbot-bootstrap] %s\n' "$*"; }
warn() { printf '[mcbot-bootstrap] 警告：%s\n' "$*" >&2; }
die() { printf '[mcbot-bootstrap] 错误：%s\n' "$*" >&2; exit 1; }
cleanup() {
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
    rm -rf -- "$WORK_DIR"
  fi
}
trap cleanup EXIT

command -v id >/dev/null 2>&1 || die '找不到 id'
[[ "$(id -u)" -eq 0 ]] || die '请使用 root 或 sudo 运行此脚本'
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die 'MCBOT_GITHUB_REPO 格式无效'

valid_https_url() {
  local url=$1
  [[ "$url" == https://* ]] || return 1
  [[ "$url" != *$'\n'* && "$url" != *$'\r'* && "$url" != *[[:space:]]* ]]
}

validate_single_line() {
  local name=$1
  local value=$2
  [[ -n "$value" ]] || die "$name 不能为空"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "$name 不能包含换行或回车"
}

validate_password() {
  local value=$1
  [[ -z "$value" ]] && return 0
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die '密码不能包含换行或回车'
  [[ "${#value}" -le 256 ]] || die '密码最多 256 个字符'
  [[ "${value//[[:space:]]/}" != '' ]] || die '密码不能全是空白'
}

prompt_value() {
  local variable=$1
  local label=$2
  local default=$3
  local value=${!variable:-}
  if [[ -z "$value" ]]; then
    if [[ -n "$default" ]]; then
      read -r -p "$label [$default]：" value
      value=${value:-$default}
    else
      read -r -p "$label：" value
    fi
  fi
  printf -v "$variable" '%s' "$value"
}

prompt_password() {
  if [[ "${MC_LOGIN_PASSWORD+x}" == x ]]; then
    return 0
  fi
  if [[ ! -t 0 ]]; then
    MC_LOGIN_PASSWORD=''
    return 0
  fi
  read -r -s -p '服务器插件登录密码（回车跳过）：' MC_LOGIN_PASSWORD
  printf '\n'
}

ensure_tools() {
  local missing=()
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  command -v unzip >/dev/null 2>&1 || missing+=(unzip)
  command -v sha256sum >/dev/null 2>&1 || missing+=(coreutils)
  command -v awk >/dev/null 2>&1 || missing+=(awk)
  command -v sed >/dev/null 2>&1 || missing+=(sed)
  if ((${#missing[@]})); then
    command -v apt-get >/dev/null 2>&1 || die "缺少工具：${missing[*]}；请先安装后重试"
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates unzip coreutils gawk sed
  fi
}

resolve_release() {
  local api_url json tag asset_url checksum_url
  if [[ "$RELEASE_TAG" != 'latest' ]]; then
    validate_single_line 'MCBOT_RELEASE_TAG' "$RELEASE_TAG"
    [[ "$RELEASE_TAG" =~ ^[A-Za-z0-9._-]+$ ]] || die 'MCBOT_RELEASE_TAG 格式无效'
    RELEASE_API_TAG=$RELEASE_TAG
    return
  fi
  api_url="https://api.github.com/repos/${REPO}/releases/latest"
  valid_https_url "$api_url" || die 'GitHub API 地址无效'
  json=$(curl --proto '=https' --proto-redir '=https' -fsSL --retry 3 --connect-timeout 10 --max-time 30 \
    -H 'Accept: application/vnd.github+json' -H 'User-Agent: minecraft-bot-bootstrap' "$api_url") ||
    die '无法获取 GitHub latest Release；可设置 MCBOT_RELEASE_TAG 固定版本后重试'
  tag=$(printf '%s' "$json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  [[ -n "$tag" ]] || die 'GitHub latest Release 缺少 tag_name'
  [[ "$tag" != *'/'* && "$tag" != *'..'* ]] || die 'GitHub Release tag 无效'
  RELEASE_API_TAG=$tag
  asset_url="https://ghfast.top/https://github.com/${REPO}/releases/download/${RELEASE_API_TAG}/${ASSET_NAME}"
  info "发现最新 Release：$RELEASE_API_TAG"
}

resolve_checksum_asset() {
  local api_url json name url digest
  [[ -n "$RELEASE_SHA256" ]] && return 0
  api_url="https://api.github.com/repos/${REPO}/releases/tags/${RELEASE_API_TAG}"
  valid_https_url "$api_url" || die 'GitHub Release API 地址无效'
  json=$(curl --proto '=https' --proto-redir '=https' -fsSL --retry 3 --connect-timeout 10 --max-time 30 \
    -H 'Accept: application/vnd.github+json' -H 'User-Agent: minecraft-bot-bootstrap' "$api_url") ||
    die '无法获取 Release 资产清单；请设置 MCBOT_RELEASE_SHA256 后重试'
  digest=$(printf '%s' "$json" | awk -v target="$ASSET_NAME" '
    /"name"[[:space:]]*:/ { in_asset = ($0 ~ "\\\"" target "\\\"") }
    in_asset && /"digest"[[:space:]]*:/ {
      if (match($0, /sha256:[0-9A-Fa-f]{64}/)) { print substr($0, RSTART + 7, 64); exit }
    }
    in_asset && /^[[:space:]]*}/ { in_asset = 0 }
  ')
  if [[ "$digest" =~ ^[0-9A-Fa-f]{64}$ ]]; then
    RELEASE_SHA256=$digest
    return 0
  fi
  name=$(printf '%s' "$json" | sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\(minecraft-bot-debian\.zip\.sha256\|SHA256SUMS\)".*/\1/p' | head -n 1)
  [[ -n "$name" ]] || die 'Release 没有 checksum 资产，请设置 MCBOT_RELEASE_SHA256'
  url="https://github.com/${REPO}/releases/download/${RELEASE_API_TAG}/${name}"
  RELEASE_SHA256=$(curl --proto '=https' --proto-redir '=https' -fsSL --retry 3 --connect-timeout 10 --max-time 30 "$url") ||
    die '无法下载 Release checksum 资产'
  RELEASE_SHA256=$(printf '%s\n' "$RELEASE_SHA256" | awk -v target="$ASSET_NAME" '
    $0 ~ target && $0 ~ /^[[:space:]]*[0-9A-Fa-f]{64}/ { match($0, /[0-9A-Fa-f]{64}/); print substr($0, RSTART, 64); exit }
    NR == 1 && $0 ~ /^[[:space:]]*[0-9A-Fa-f]{64}/ { print substr($0, 1, 64); exit }
  ')
  [[ -n "$RELEASE_SHA256" ]] || die 'checksum 资产中没有有效 SHA-256'
}

download_asset() {
  local candidate result
  local candidates=("https://ghfast.top/https://github.com/${REPO}/releases/download/${RELEASE_API_TAG}/${ASSET_NAME}")
  if [[ -n "${MCBOT_GITHUB_MIRRORS:-}" ]]; then
    local item
    IFS=',' read -r -a mirrors <<< "$MCBOT_GITHUB_MIRRORS"
    for item in "${mirrors[@]}"; do
      item="${item%/}"
      [[ -n "$item" ]] && candidates+=("$item/${REPO}/releases/download/${RELEASE_API_TAG}/${ASSET_NAME}")
    done
  fi
  for candidate in "${candidates[@]}"; do
    valid_https_url "$candidate" || continue
    info "下载部署包：$candidate"
    if curl --proto '=https' --proto-redir '=https' -fL --retry 3 --connect-timeout 10 --max-time 180 \
      -o "$WORK_DIR/$ASSET_NAME" "$candidate"; then
      return 0
    fi
    warn "下载失败，尝试下一个地址"
  done
  return 1
}

check_zip_paths() {
  local entry
  while IFS= read -r entry; do
    [[ "$entry" == minecraft-bot/* ]] || die "ZIP 根目录异常：$entry"
    [[ "$entry" != /* && "$entry" != *'../'* && "$entry" != *'/..'* ]] || die "ZIP 包含路径穿越：$entry"
  done < <(unzip -Z1 "$WORK_DIR/$ASSET_NAME")
}

check_required_files() {
  local file
  local files=(
    install-minecraft-bot.sh package.json package-lock.json
    src/bot.js src/status-cli.js src/config-admin.js
    deploy/minecraft-bot.service .env.example
  )
  for file in "${files[@]}"; do
    [[ -f "$WORK_DIR/minecraft-bot/$file" ]] || die "ZIP 缺少必需文件：$file"
  done
}

main() {
  ensure_tools
  prompt_value MC_HOST 'Minecraft 服务器地址' ''
  prompt_value MC_PORT 'Minecraft 服务器端口' '25565'
  prompt_value MC_USERNAME '机器人用户名或 Microsoft 账号' ''
  prompt_value MC_AUTH '认证模式（offline/microsoft）' 'offline'
  prompt_value MC_VERSION '协议版本（留空自动探测）' ''
  prompt_value MC_SERVER_NAME '服务器名称' "$MC_HOST"
  prompt_password

  validate_single_line MC_HOST "$MC_HOST"
  validate_single_line MC_USERNAME "$MC_USERNAME"
  validate_single_line MC_AUTH "$MC_AUTH"
  validate_single_line MC_PORT "$MC_PORT"
  validate_single_line MC_SERVER_NAME "$MC_SERVER_NAME"
  validate_password "$MC_LOGIN_PASSWORD"
  [[ "$MC_PORT" =~ ^[0-9]+$ && "$MC_PORT" -ge 1 && "$MC_PORT" -le 65535 ]] || die '端口必须是 1 到 65535 的整数'
  MC_AUTH=${MC_AUTH,,}
  [[ "$MC_AUTH" == offline || "$MC_AUTH" == microsoft ]] || die '认证模式必须是 offline 或 microsoft'
  [[ "$MC_VERSION" == 'auto' ]] && MC_VERSION=''

  WORK_DIR=$(mktemp -d)
  chmod 0700 "$WORK_DIR"
  resolve_release
  resolve_checksum_asset
  [[ "$RELEASE_SHA256" =~ ^[0-9A-Fa-f]{64}$ ]] || die 'Release SHA-256 无效'
  download_asset || die '所有 GitHub/镜像下载地址均失败'
  printf '%s  %s\n' "$RELEASE_SHA256" "$WORK_DIR/$ASSET_NAME" | sha256sum -c - || die '部署包 SHA-256 校验失败'
  check_zip_paths
  unzip -q "$WORK_DIR/$ASSET_NAME" -d "$WORK_DIR"
  check_required_files
  chmod +x "$WORK_DIR/minecraft-bot/install-minecraft-bot.sh"

  local args=(--host "$MC_HOST" --port "$MC_PORT" --username "$MC_USERNAME" --auth "$MC_AUTH" --server-name "$MC_SERVER_NAME")
  [[ -n "$MC_VERSION" ]] && args+=(--version "$MC_VERSION")
  if [[ "${MCBOT_NO_START:-0}" == '1' ]]; then args+=(--no-start); fi
  info '开始调用正式安装器'
  if [[ -n "$MC_LOGIN_PASSWORD" ]]; then
    MC_LOGIN_PASSWORD="$MC_LOGIN_PASSWORD" "$WORK_DIR/minecraft-bot/install-minecraft-bot.sh" "${args[@]}"
  else
    "$WORK_DIR/minecraft-bot/install-minecraft-bot.sh" "${args[@]}"
  fi
  unset MC_LOGIN_PASSWORD
  info '引导安装完成'
}

main "$@"
