# Debian Mineflayer 挂机机器人

这是一个由 `systemd` 管理的 Mineflayer Minecraft 机器人。机器人进程不依赖 SSH 会话，SSH 断开后仍会继续运行；启用服务后，Debian 开机也会自动启动。状态查看使用纯终端命令 `mcbot`，不需要桌面或浏览器。当前部署基线为 Mineflayer `4.39.0` 和 Node.js 24 LTS（最低 Node.js 22）；未指定 `MC_VERSION` 时由 Mineflayer 自动探测协议版本。

## 一键引导安装

如果只想在全新 Debian 主机上输入一次命令完成安装，可以先下载 bootstrap 脚本，再运行它：

```bash
curl --proto '=https' --proto-redir '=https' -fsSL \
  https://raw.githubusercontent.com/JamesHardene/minecraft-mineflayer-bot/main/install-minecraft-bot-bootstrap.sh \
  -o install-minecraft-bot-bootstrap.sh
chmod +x install-minecraft-bot-bootstrap.sh
sudo ./install-minecraft-bot-bootstrap.sh
```

bootstrap 默认使用 GitHub 最新正式 Release（`MCBOT_RELEASE_TAG=latest`），会先收集服务器地址、端口、机器人用户名、认证方式、协议版本、服务器名称和插件登录密码，然后：

- 通过 GitHub Releases API 解析最新 Release；
- 从 GitHub 或 `MCBOT_GITHUB_MIRRORS` 镜像下载 `minecraft-bot-debian.zip`；
- 校验 Release 提供的 `.sha256`/`SHA256SUMS` 资产；
- 安全检查 ZIP 路径并解压到临时目录；
- 调用正式安装器完成 Node.js、Mineflayer、systemd 和配置安装。

如果要固定某个 Release：

```bash
sudo MCBOT_RELEASE_TAG=v1.0.0 ./install-minecraft-bot-bootstrap.sh
```

非交互安装可以通过环境变量提供服务器信息：

```bash
sudo env \
  MC_HOST=ali.mc9.city \
  MC_PORT=25565 \
  MC_USERNAME=Misaka \
  MC_AUTH=offline \
  MC_SERVER_NAME=ali.mc9.city \
  MCBOT_RELEASE_TAG=latest \
  ./install-minecraft-bot-bootstrap.sh
```

密码建议在交互模式下隐藏输入。若必须自动化传入，可使用短生命周期环境变量 `MC_LOGIN_PASSWORD`；不要把密码写入命令行参数。`MCBOT_NO_START=1` 可安装并启用开机自启但跳过本次启动。

bootstrap 要求 Release 提供 SHA-256 校验资产；如果 Release 没有校验资产，可以显式提供：

```bash
sudo env MCBOT_RELEASE_SHA256=64位SHA256值 \
  ./install-minecraft-bot-bootstrap.sh
```

## 快速安装

如果使用 GitHub Release 的一键引导脚本，推荐直接运行：

```bash
curl --proto '=https' --proto-redir '=https' -fsSL \
  https://raw.githubusercontent.com/JamesHardene/minecraft-mineflayer-bot/main/install-minecraft-bot-bootstrap.sh \
  -o install-minecraft-bot-bootstrap.sh
chmod +x install-minecraft-bot-bootstrap.sh
sudo ./install-minecraft-bot-bootstrap.sh
```

引导脚本默认解析最新正式 Release（`MCBOT_RELEASE_TAG=latest`），下载并校验部署 ZIP 后调用正式安装器。Release 必须提供 GitHub 资产 digest 或 `minecraft-bot-debian.zip.sha256`/`SHA256SUMS` 校验资产；没有可靠校验值时脚本会拒绝安装。也可以显式固定版本：

```bash
sudo MCBOT_RELEASE_TAG=v1.0.0 ./install-minecraft-bot-bootstrap.sh
```

引导脚本会隐藏读取服务器插件密码，密码不会拼进正式安装器命令行。非交互环境可使用 `MC_HOST`、`MC_PORT`、`MC_USERNAME`、`MC_AUTH`、`MC_VERSION`、`MC_SERVER_NAME` 和短生命周期 `MC_LOGIN_PASSWORD` 环境变量。镜像可通过 `MCBOT_GITHUB_MIRRORS` 追加，安装完成后 `MCBOT_NO_START=1` 可跳过本次启动但仍启用开机自启。

将整个目录复制到 Debian 主机后，以 root 或 sudo 运行：

离线模式服务器可以直接使用：

```bash
chmod +x install-minecraft-bot.sh
sudo ./install-minecraft-bot.sh \
  --offline \
  --host play.example.com \
  --port 25565 \
  --username BotName \
  --server-name "我的服务器"
```

Microsoft 账号则使用 `--auth microsoft`，例如：

```bash
sudo ./install-minecraft-bot.sh \
  --host play.example.com \
  --port 25565 \
  --username your-account@example.com \
  --auth microsoft \
  --server-name "我的服务器"
```

不传连接参数时，安装脚本会在交互终端中询问。安装完成后会：

- 创建专用系统用户 `minecraft-bot`。
- 将程序安装到 `/opt/minecraft-bot`。
- 将真实配置保存到 `/etc/minecraft-bot/minecraft-bot.env`，权限为 `0640`；重复安装默认保留已有配置，只有明确传入认证、版本或密码参数时才更新对应字段。
- 将 Microsoft 认证缓存和状态文件放在 `/var/lib/minecraft-bot`；认证缓存目录权限为 `0700`。
- 在 `/run/minecraft-bot/control.sock` 创建本机控制 socket，并设置为 `0660`。
- 通过 sudo 安装时把调用用户加入 `minecraft-bot` 组，重新登录后可直接发送聊天。
- 安装并启用 `/etc/systemd/system/minecraft-bot.service`。
- 安装全局终端命令 `/usr/local/bin/mcbot`。

如果只想安装和启用开机自启、稍后再启动：

```bash
sudo ./install-minecraft-bot.sh --no-start ...
sudoedit /etc/minecraft-bot/minecraft-bot.env
sudo systemctl start minecraft-bot.service
```

`--no-start` 只跳过本次启动，不会关闭开机自启；安装脚本仍会执行 `systemctl enable`。

## 认证模式

### Offline 离线登录

使用 `--offline` 或 `--auth offline`。此模式下 `MC_USERNAME` 是机器人在游戏中的用户名，不需要 Microsoft 邮箱、密码或设备码，也不会验证账号所有权。

目标服务器必须明确允许离线登录，通常需要服务端或代理配置 `online-mode=false`。白名单、登录插件和服务器侧权限规则仍然适用；离线用户名可能被冒用，只应连接自有或明确获授权的服务器。正版在线模式服务器通常会拒绝此连接，`MC_AUTH=offline` 不能绕过正版认证。

连接后可用以下命令确认状态：

```bash
mcbot once
sudo journalctl -u minecraft-bot.service -n 100 --no-pager
```

日志中应看到 `auth` 为 `offline`、`minecraft login completed` 和 `minecraft spawn completed`。离线模式不依赖 Microsoft 认证缓存。

### 服务器插件自动登录

如果服务器进入后要求通过登录插件执行 `/l 密码`，可以在安装时传入：

```bash
sudo ./install-minecraft-bot.sh \
  --offline \
  --host play.example.com \
  --username BotName \
  --password '你的服务器登录密码'
```

机器人在每次成功进入世界（`spawn`）后默认等待约 3 秒，然后发送 `/l 密码`。断线重连后会再次发送一次。该密码是服务器插件密码，不是 Microsoft 账号密码；只有服务器确实使用 `/l` 登录命令时才配置。Mineflayer 未指定 `MC_VERSION` 时会自动探测服务器协议；如果目标服务器需要固定协议，可在安装时传入 `--version 1.21.1`（或其他受支持版本），也可以写入 `MC_VERSION`。可在真实配置中调整 `MC_LOGIN_DELAY_SECONDS` 和 `MC_LOGIN_COMMAND`。

安装器会将密码写入 `/etc/minecraft-bot/minecraft-bot.env`，权限为 `root:minecraft-bot`、`0640`，通过 systemd 环境变量注入服务，不会写入 `ExecStart`、状态 JSON 或应用日志。注意：`--password '...'` 仍可能出现在 shell history、进程列表或审计记录中；更适合生产环境的方式是用 `sudoedit /etc/minecraft-bot/minecraft-bot.env` 直接维护 `MC_LOGIN_PASSWORD="你的密码"`，或在受控环境中通过 `MC_LOGIN_PASSWORD='你的密码'` 传给安装器；并避免公开该文件、认证缓存和日志。修改环境文件后执行 `sudo systemctl restart minecraft-bot.service` 即可生效。

未传 `--password` 且未设置非空 `MC_LOGIN_PASSWORD` 时不会自动发送登录命令；已有配置只有显式传入 `--password` 或非空环境变量才会更新密码。登录失败日志只记录命令名称和失败摘要，不记录密码。服务器插件、代理或审计系统仍可能记录或回显客户端发送的 `/l 密码`，请按目标服务器的日志策略保护相关日志。

### Microsoft 登录

`MC_AUTH=microsoft` 用于 Microsoft 账号。第一次启动时，Mineflayer 会在日志中显示设备登录提示。保持下面的日志命令运行并按提示完成登录：

```bash
sudo journalctl -u minecraft-bot.service -f
```

认证缓存由服务用户保存到 `/var/lib/minecraft-bot/auth`。不要把这个目录、真实环境文件或日志提交到仓库。

切换已有服务的认证模式时，编辑真实配置后重启：

```bash
sudoedit /etc/minecraft-bot/minecraft-bot.env
sudo systemctl restart minecraft-bot.service
```

重新运行安装器时，已有配置默认会保留；只有显式传入 `--username` 才会更新已有机器人的用户名，只有显式传入 `--offline` 或 `--auth microsoft|offline` 才会更新 `MC_AUTH`。修改已有用户名后，安装器会在服务重启时使用新值。切换到 offline 后，旧 Microsoft 缓存仍可能留在 `/var/lib/minecraft-bot/auth`，确认不再需要后再由管理员删除。

## `mcbot` 命令

```text
mcbot              显示状态后进入数字菜单（含编辑服务器配置）
mcbot once         单次打印状态，适合脚本和 SSH 查看
mcbot say "你好"   让机器人在 Minecraft 聊天频道发言
mcbot command list 发送 Minecraft 指令 `/list`
mcbot chat         进入持续聊天/指令控制台
mcbot start        启动 systemd 服务（权限不足时加 sudo）
mcbot stop         停止 systemd 服务（权限不足时加 sudo）
mcbot restart      重启 systemd 服务（权限不足时加 sudo）
mcbot logs         跟踪服务日志（权限不足时加 sudo）
mcbot help         查看命令帮助
```

直接输入 `mcbot` 时的菜单：

```text
1. 进入对话
2. 服务启停
3. 编辑服务器配置
4. 查看服务日志
5. 卸载
0. 退出
```

菜单 1 同时支持普通聊天和 Minecraft 指令：普通文本直接发送，`/` 开头的内容作为 Minecraft 指令发送。菜单 2 提供查看服务状态、开启、停止/中止和重启。菜单 3 可编辑服务器连接和登录配置，保存后会自动重启服务。停止使用 systemd 的优雅停止流程，不是强制杀进程。

这是单服务器模式，唯一运行配置文件是 `/etc/minecraft-bot/minecraft-bot.env`。菜单 3 可以修改服务器地址、端口、机器人用户名、认证模式、协议版本、服务器名称、登录插件密码、登录延迟、登录命令、重连和 Anti-AFK 参数。密码输入不会回显，回车保留旧密码，输入 `CLEAR` 清除密码；保存后会自动重启服务立即生效，不需要 `daemon-reload`。旧版本遗留的配置副本不会参与运行；确认不再需要后可由管理员手动清理。

### 让机器人发言和执行 Minecraft 指令

`mcbot say "大家好"` 会调用 Mineflayer 的聊天接口，其他玩家看到的就是机器人在 Minecraft 聊天框中说出这句话：

```bash
mcbot say "大家好，我正在挂机"
```

发送服务端指令：

```bash
mcbot command list
mcbot command "/say 机器人在线"
```

不要用 `mcbot command "/l 真实密码"` 手工登录；命令行参数会进入 shell 历史和终端输出，服务器插件自动登录应使用上面的 `MC_LOGIN_PASSWORD` 环境配置。两类普通控制命令只会通过本机 Unix socket 传给正在运行的 Mineflayer 进程，绝不会在 Debian shell 中执行。机器人不在线时命令会立即失败，不会延迟到重连后执行。

需要连续聊天时运行：

```bash
mcbot chat
```

进入后，每一行普通文本都会让机器人发言；以 `/` 开头的行会作为 Minecraft 指令发送。控制台还会显示服务器聊天和系统反馈，但不会自动生成回复。输入 `:status` 查看状态，`:help` 查看帮助，`:quit` 或 `:exit` 退出。

控制 socket 默认位于 `/run/minecraft-bot/control.sock`，权限为服务用户和 `minecraft-bot` 组可读写。安装脚本通过 `sudo` 执行时，会把 `SUDO_USER` 加入该组；重新登录或执行 `newgrp minecraft-bot` 后才能直接使用 `mcbot say`/`mcbot chat`。没有组权限时请使用 `sudo mcbot say "内容"`。

配置编辑菜单不会修改 `MCBOT_*` 路径、服务名称或 `MC_PROFILES_FOLDER` 等 systemd 固定字段；这些字段仍由服务单元维护。配置写入通过受控 helper 原子替换真实环境文件，不会执行任意 shell 命令或把密码放进进程参数。

状态面板包括：

- 机器人用户名和 UUID（服务器提供 UUID 时显示）。
- 连接状态、服务器名称、服务器地址。
- Mineflayer 当前可见的延迟和玩家数量；这不是服务端插件提供的精确在线总人数。
- 机器人所在世界、坐标、进程运行时间和当前连接运行时间。
- 重连次数、最后更新时间、最近错误或踢出原因。

Mineflayer 没有通用的客户端接口读取服务端真实 TPS/MSPT，当前机器人也不会伪造或估算这两个值；因此默认状态面板会直接隐藏 TPS/MSPT 行。CLI 兼容状态数据中已有的有效 `tps`/`mspt` 字段，后续若把受信任的服务器插件或监控接口接入状态写入流程，才会显示它们。

## GitHub 和 npm 网络探测

安装依赖前，脚本会对 GitHub 直连执行两次 HTTPS 探测，并尝试镜像。默认镜像包含：

```text
https://ghfast.top/https://github.com
```

直连耗时不超过 `MCBOT_GITHUB_MAX_LATENCY`（默认 2.5 秒）时优先使用直连；直连失败或质量较差时选择可用候选。选择结果写入 `/opt/minecraft-bot/.network.env`，不包含账号密码，也不会通过管道执行远程脚本。当前安装所需的 Node/Mineflayer 依赖来自 npm registry，所以实际下载回退由下面的 npm registry 探测负责；GitHub 选择结果供后续需要 GitHub 下载的扩展使用。

Mineflayer 实际通过 npm 安装，因此脚本还会探测：

- `https://registry.npmjs.org`
- `https://registry.npmmirror.com`

会选择可用的 registry 写入 `/opt/minecraft-bot/.npmrc`。可在网络环境特殊时追加候选：

```bash
sudo MCBOT_GITHUB_MIRRORS='https://ghfast.top/https://github.com,https://your-mirror.example/github' \
  MCBOT_NPM_REGISTRIES='https://registry.example.com' \
  ./install-minecraft-bot.sh ...
```

如果所有 npm registry 都无法访问，脚本会停止，不会生成一个缺少依赖的半安装服务。安装器在 npm 命令结束后还会执行 `require.resolve('mineflayer')` 验证；如果服务日志出现 `Cannot find module 'mineflayer'`，说明依赖没有完整安装，应先按下面的修复命令重新安装依赖，不要反复重启服务。

## 常用管理与排错

如果日志出现 `Cannot read package config /opt/minecraft-bot/node_modules/mineflayer/package.json: permission denied`，说明依赖是由 root 安装的，但 `umask 077` 让服务用户无法读取。先停止服务并修复依赖目录权限：

```bash
sudo systemctl stop minecraft-bot.service
sudo chown -R root:minecraft-bot /opt/minecraft-bot/node_modules
sudo find /opt/minecraft-bot/node_modules -type d -exec chmod 0755 {} +
sudo find /opt/minecraft-bot/node_modules -type f -exec chmod 0644 {} +
sudo -u minecraft-bot /usr/bin/node -e "require.resolve('mineflayer')"
sudo systemctl reset-failed minecraft-bot.service
sudo systemctl restart minecraft-bot.service
```

如果日志出现：

```text
Error: Cannot find module 'mineflayer'
```

说明依赖没有完整安装。先停止 systemd 的自动重启，再在程序目录重新安装生产依赖：

```bash
sudo systemctl stop minecraft-bot.service
cd /opt/minecraft-bot

sudo npm ci \
  --prefix /opt/minecraft-bot \
  --omit=dev \
  --no-audit \
  --no-fund \
  --engine-strict

sudo -u minecraft-bot sh -c 'cd /opt/minecraft-bot && /usr/bin/node -p "require.resolve(\\"mineflayer\\")"'
/usr/bin/node -p "process.version + \" / \" + require(\"/opt/minecraft-bot/node_modules/mineflayer/package.json\").version"
sudo systemctl restart minecraft-bot.service
```

如果默认 registry 访问失败，可以明确使用镜像重试：

```bash
sudo npm install \
  --prefix /opt/minecraft-bot \
  --omit=dev \
  --no-audit \
  --no-fund \
  --registry https://registry.npmmirror.com
```

确认依赖和版本已安装：

```bash
cd /opt/minecraft-bot
npm ls mineflayer --depth=0
node --version
npm --version
node -p "require('./node_modules/mineflayer/package.json').version"
sudo journalctl -u minecraft-bot.service -n 100 --no-pager
```

安装器现在会在 npm 命令结束后执行 `require.resolve('mineflayer')` 验证；如果验证失败，会在安装阶段停止，不会继续启动一个缺少依赖的服务。

正常情况下使用以下命令查看状态：

```bash
systemctl is-enabled minecraft-bot.service
systemctl is-active minecraft-bot.service
sudo systemctl status minecraft-bot.service
sudo journalctl -u minecraft-bot.service -n 100 --no-pager
sudo journalctl -u minecraft-bot.service -f
sudo mcbot once
```

机器人掉线后会使用带上限的指数退避重连，默认从 5 秒开始，最长 300 秒，并带少量随机抖动。服务进程收到 systemd 的停止信号时会退出；`Restart=always` 负责进程异常退出后的服务级恢复。机器人默认每 45 秒做一次轻量视角变化，可在配置中设置 `MC_ANTIAFK=false` 关闭。请确认这类挂机行为符合服务器规则；本项目不包含绕过反作弊或攻击服务器的逻辑。

### 修改配置

```bash
sudoedit /etc/minecraft-bot/minecraft-bot.env
sudo systemctl restart minecraft-bot.service
```

修改 Node.js 代码或依赖后，重新运行安装脚本即可；已有环境配置和认证缓存会保留。脚本会重新探测网络、确保 Node.js 24 LTS 可用并更新 Mineflayer 依赖。

### 协议版本迁移

新安装默认不写入 `MC_VERSION`，由 Mineflayer 自动探测。已有安装如果仍保存旧的固定版本，可使用：

```bash
sudo ./install-minecraft-bot.sh --no-start --version auto
sudo systemctl restart minecraft-bot.service
```

`--version auto` 会把 `MC_VERSION` 清空；也可以手动编辑配置文件，将其写成 `MC_VERSION=""`。如果服务器需要固定协议，再传入具体版本，例如 `--version 1.21.1`。

### 卸载

确认不再需要服务后，可以执行：

```bash
sudo systemctl disable --now minecraft-bot.service
sudo rm -f /etc/systemd/system/minecraft-bot.service /usr/local/bin/mcbot
sudo systemctl daemon-reload
sudo rm -rf /opt/minecraft-bot /etc/minecraft-bot /var/lib/minecraft-bot
sudo userdel minecraft-bot 2>/dev/null || true
sudo groupdel minecraft-bot 2>/dev/null || true
```

最后两行会删除服务用户及其认证缓存，请先确认需要保留的数据已经备份。

## 目标主机要求

建议使用 Debian 11/12 或兼容的 Debian 派生系统，具备：

- systemd、apt、curl 和可用的 HTTPS 出站网络。
- Node.js 22 或更高版本，推荐 Node.js 24 LTS。脚本会在 Node.js 缺失、版本低于 24 LTS 或 npm 缺失时配置 NodeSource 的签名软件源并安装 Node.js 24 LTS；不会使用 Node.js 20 安装 Mineflayer 4.39.0。
- Mineflayer 当前固定为 `4.39.0`，其运行要求为 Node.js `>=22`。部署包包含 `package-lock.json`，安装器会在 npm 安装后验证实际加载版本和依赖树。
- 未设置 `MC_VERSION` 时由 Mineflayer 自动探测服务器协议；如果目标服务器需要固定协议，可通过 `--version` 或 `MC_VERSION` 指定。
- 能够从选择的 npm registry 下载 Mineflayer 及其依赖。
