'use strict';

const fs = require('fs');
const net = require('net');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const statusFile = process.env.MCBOT_STATUS_FILE || '/var/lib/minecraft-bot/status.json';
const controlSocket = process.env.MCBOT_CONTROL_SOCKET || '/run/minecraft-bot/control.sock';
const serviceName = process.env.MCBOT_SERVICE_NAME || 'minecraft-bot.service';
const configAdmin = process.env.MCBOT_CONFIG_ADMIN || '/usr/local/sbin/mcbot-config';
const refreshMs = 2000;
let readlineInterface = null;
const controlTimeoutMs = 10000;
const noColor = Boolean(process.env.NO_COLOR) || !process.stdout.isTTY;

function paint(code, value) {
  return noColor ? value : `\u001b[${code}m${value}\u001b[0m`;
}

function readStatus() {
  try {
    const data = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('status file does not contain a JSON object');
    }
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        status: 'not_started',
        serverName: '-',
        serverAddress: '-',
        botUsername: '-',
        botUuid: null,
        lastError: 'status file does not exist; the service may not have started yet'
      };
    }
    return {
      status: 'read_error',
      serverName: '-',
      serverAddress: '-',
      botUsername: '-',
      lastError: error.message
    };
  }
}

function valueOrDash(value) {
  return value === undefined || value === null || value === '' ? '-' : String(value);
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '-';
  let seconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || parts.length) parts.push(`${hours}h`);
  if (minutes || parts.length) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function durationSince(iso, endIso = null) {
  if (!iso) return '-';
  const timestamp = Date.parse(iso);
  const endTimestamp = endIso ? Date.parse(endIso) : Date.now();
  if (!Number.isFinite(timestamp) || !Number.isFinite(endTimestamp) || endTimestamp < timestamp) return '-';
  return formatDuration(endTimestamp - timestamp);
}

function formatPosition(position) {
  if (!position || ![position.x, position.y, position.z].every((value) => Number.isFinite(Number(value)))) {
    return '-';
  }
  return `${Number(position.x).toFixed(2)}, ${Number(position.y).toFixed(2)}, ${Number(position.z).toFixed(2)}`;
}

function formatTime(iso) {
  if (!iso) return '-';
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : '-';
}

function statusLabel(status) {
  const labels = {
    starting: ['启动中', '33'],
    connecting: ['连接中', '33'],
    logged_in: ['已登录，等待出生点', '33'],
    online: ['在线', '32'],
    reconnecting: ['等待重连', '33'],
    offline: ['离线', '31'],
    kicked: ['被服务器踢出', '31'],
    error: ['错误', '31'],
    stopping: ['停止中', '33'],
    stopped: ['已停止', '90'],
    not_started: ['未启动', '90'],
    read_error: ['状态读取失败', '31']
  };
  const [label, color] = labels[status] || [valueOrDash(status), '37'];
  return paint(color, label);
}

function metricLine(label, value) {
  return `${paint('36', label.padEnd(14, ' '))}${valueOrDash(value)}`;
}

function render(status) {
  const lines = [];
  lines.push(paint('1;36', 'Mineflayer 机器人状态'));
  lines.push('');
  lines.push(metricLine('状态', statusLabel(status.status)));
  lines.push(metricLine('机器人用户名', status.botUsername));
  lines.push(metricLine('机器人 UUID', status.botUuid));
  lines.push(metricLine('服务器名称', status.serverName || status.host));
  lines.push(metricLine('服务器地址', status.serverAddress || (status.host ? `${status.host}:${status.port || 25565}` : null)));
  lines.push(metricLine('服务器延迟', status.latencyMs === null || status.latencyMs === undefined ? null : `${status.latencyMs} ms`));
  lines.push(metricLine('服务器人数', status.onlinePlayers === null || status.onlinePlayers === undefined ? null : `${status.onlinePlayers}（可见列表）`));
  lines.push(metricLine('所在世界', status.world));
  lines.push(metricLine('机器人坐标', formatPosition(status.position)));
  lines.push(metricLine('机器人运行时间', durationSince(status.startedAt)));
  lines.push(metricLine('连接运行时间', durationSince(status.connectedAt, status.disconnectedAt)));
  lines.push(metricLine('重连次数', status.reconnectAttempt));
  lines.push(metricLine('最后更新', formatTime(status.lastUpdateAt)));

  const tps = finite(status.tps ?? status.serverTps);
  const mspt = finite(status.mspt ?? status.serverMspt);
  if (tps !== null) lines.push(metricLine('服务器 TPS', tps));
  if (mspt !== null) lines.push(metricLine('服务器 MSPT', `${mspt} ms`));

  if (status.nextReconnectAt) lines.push(metricLine('下次重连', formatTime(status.nextReconnectAt)));
  if (status.kickedReason) lines.push(metricLine('踢出原因', status.kickedReason));
  if (status.lastError) lines.push(metricLine('最近错误', status.lastError));
  lines.push('');
  return lines.join('\n');
}

function printOnce() {
  process.stdout.write(`${render(readStatus())}\n`);
}

function watch() {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    printOnce();
    return;
  }

  const draw = () => {
    process.stdout.write('\u001b[2J\u001b[H');
    process.stdout.write(`${render(readStatus())}\n`);
  };
  const stop = () => {
    clearInterval(timer);
    if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\n');
  };
  const onKey = (chunk) => {
    if (chunk.toString().toLowerCase() === 'q' || chunk[0] === 3) {
      stop();
      process.exit(0);
    }
  };

  draw();
  const timer = setInterval(draw, refreshMs);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onKey);
  process.once('SIGINT', () => {
    stop();
    process.exit(0);
  });
}

function connectControl() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(controlSocket);
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      socket.destroy();
      reject(new Error(`连接控制 socket 超时：${controlSocket}`));
    }, controlTimeoutMs);

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.setEncoding('utf8');
      resolve(socket);
    });
    socket.once('error', fail);
  });
}

function sendControlRequest(socket, request) {
  socket.write(`${JSON.stringify(request)}\n`);
}

function parseControlLines(socket, onMessage) {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line));
      } catch (error) {
        onMessage({ ok: false, error: `控制响应不是有效 JSON：${error.message}` });
      }
    }
  });
}

async function oneShotControl(op, text) {
  const socket = await connectControl();
  return new Promise((resolve, reject) => {
    const requestId = `cli-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('等待机器人响应超时'));
    }, controlTimeoutMs);
    parseControlLines(socket, (message) => {
      if (message.id !== requestId) return;
      clearTimeout(timer);
      socket.end();
      if (message.ok) resolve(message);
      else reject(new Error(message.error || '机器人拒绝了请求'));
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    sendControlRequest(socket, { id: requestId, op, text });
  });
}

function printControlError(error) {
  process.stderr.write(`[mcbot] ${error.message}\n`);
  process.exitCode = 1;
}

async function sendChatOnce(text) {
  if (!text || !text.trim()) throw new Error('聊天内容不能为空');
  const response = await oneShotControl('say', text);
  process.stdout.write(`已发送：${response.text}\n`);
}

async function sendCommandOnce(command) {
  if (!command || !command.trim()) throw new Error('Minecraft 指令不能为空');
  const response = await oneShotControl('command', command);
  process.stdout.write(`已发送指令：${response.command}\n`);
}

function printChatHelp() {
  process.stdout.write('输入普通文本让机器人发言；以 / 开头的内容会作为 Minecraft 指令发送。\n');
  process.stdout.write(':status 查看状态，:help 查看帮助，:quit 或 :exit 退出。\n');
}

async function chatConsole() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('mcbot chat 需要交互式 TTY；请使用 mcbot say 或 mcbot command 发送单条内容');
  }

  const socket = await connectControl();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (readlineInterface) readlineInterface.close();
    socket.end();
  };

  const writeAsyncOutput = (text, color = null) => {
    const output = color ? paint(color, text) : text;
    if (!readlineInterface) {
      process.stdout.write(`${output}\n`);
      return;
    }
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(`${output}\n`);
    readlineInterface.prompt(true);
  };

  parseControlLines(socket, (message) => {
    if (message.event === 'message') {
      writeAsyncOutput(`[Minecraft] ${message.text}`, '33');
      return;
    }
    if (message.event === 'status') {
      writeAsyncOutput(`[状态] ${message.status.status}`, '90');
      return;
    }
    if (message.op === 'status' && message.ok) {
      writeAsyncOutput(render(message.status));
      return;
    }
    if ((message.op === 'say' || message.op === 'command') && message.ok) {
      writeAsyncOutput(`[已发送] ${message.text || message.command}`, '32');
      return;
    }
    if (message.id && message.ok === false) {
      writeAsyncOutput(`[错误] ${message.error || '请求失败'}`, '31');
    }
  });
  socket.on('close', () => {
    if (!closed) {
      process.stdout.write('\n控制连接已关闭。\n');
      process.exitCode = 1;
      closed = true;
      if (readlineInterface) readlineInterface.close();
    }
  });
  socket.on('error', (error) => {
    if (!closed) process.stderr.write(`[mcbot] 控制连接错误：${error.message}\n`);
  });

  readlineInterface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> '
  });

  sendControlRequest(socket, { id: 'subscribe', op: 'subscribe' });
  printChatHelp();
  readlineInterface.prompt();

  readlineInterface.on('line', (line) => {
    const input = line.trim();
    if (!input) {
      readlineInterface.prompt();
      return;
    }
    if (input === ':quit' || input === ':exit') {
      close();
      return;
    }
    if (input === ':help') {
      printChatHelp();
      readlineInterface.prompt();
      return;
    }
    if (input === ':status') {
      sendControlRequest(socket, { id: `status-${Date.now()}`, op: 'status' });
      return;
    }

    const request = input.startsWith('/')
      ? { id: `command-${Date.now()}`, op: 'command', text: input }
      : { id: `say-${Date.now()}`, op: 'say', text: input };
    sendControlRequest(socket, request);
  });
  readlineInterface.on('close', close);

  await new Promise((resolve) => {
    socket.once('close', resolve);
    process.once('SIGINT', () => {
      close();
      resolve();
    });
  });
}

function runSystemctl(action, extraArgs = []) {
  const command = process.getuid && process.getuid() === 0 ? 'systemctl' : 'sudo';
  const args = command === 'systemctl' ? [action, serviceName, ...extraArgs] : ['systemctl', action, serviceName, ...extraArgs];
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`systemctl ${action} failed`);
}

function runSystemctlCapture(action, extraArgs = []) {
  const command = process.getuid && process.getuid() === 0 ? 'systemctl' : 'sudo';
  const args = command === 'systemctl' ? [action, serviceName, ...extraArgs] : ['systemctl', action, serviceName, ...extraArgs];
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function promptLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

function promptSecret(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    const onData = (chunk) => {
      for (const code of chunk) {
        if (code === 3 || code === 13 || code === 10) {
          stdin.setRawMode(Boolean(wasRaw));
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(code === 3 ? '' : value);
          return;
        }
        if (code === 127 || code === 8) { value = value.slice(0, -1); continue; }
        if (code >= 32) value += String.fromCharCode(code);
      }
    };
    stdin.on('data', onData);
  });
}

function configAdminRequest(request) {
  const command = process.getuid && process.getuid() === 0 ? configAdmin : 'sudo';
  const args = command === configAdmin ? [] : [configAdmin];
  const result = spawnSync(command, args, { input: `${JSON.stringify(request)}\n`, encoding: 'utf8' });
  if (result.error) throw result.error;
  const line = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
  if (!line) throw new Error(result.stderr || '配置管理器没有返回结果');
  const response = JSON.parse(line);
  if (!response.ok) throw new Error(response.error || '配置更新失败');
  return response;
}

function printConfigSummary(values, passwordConfigured) {
  process.stdout.write(`服务器：${values.MC_SERVER_NAME || '-'}\n`);
  process.stdout.write(`地址：${values.MC_HOST || '-'}:${values.MC_PORT || '-'}\n`);
  process.stdout.write(`用户名：${values.MC_USERNAME || '-'}\n`);
  process.stdout.write(`认证：${values.MC_AUTH || '-'}\n`);
  process.stdout.write(`协议：${values.MC_VERSION || 'auto'}\n`);
  process.stdout.write(`插件密码：${passwordConfigured ? '已配置' : '未配置'}\n`);
}

async function editConfigMenu() {
  const current = configAdminRequest({ action: 'get' });
  const old = current.values;
  printConfigSummary(old, current.passwordConfigured);
  const value = async (key, label, fallback = '') => (await promptLine(`${label} [${old[key] || fallback}]：`)) || old[key] || fallback;
  const values = {};
  values.MC_HOST = await value('MC_HOST', '服务器地址');
  values.MC_PORT = await value('MC_PORT', '服务器端口', '25565');
  values.MC_USERNAME = await value('MC_USERNAME', '机器人用户名');
  values.MC_AUTH = (await value('MC_AUTH', '认证模式', 'offline')).toLowerCase();
  values.MC_VERSION = await value('MC_VERSION', '协议版本（auto 表示自动探测）', '');
  values.MC_SERVER_NAME = await value('MC_SERVER_NAME', '服务器名称', values.MC_HOST);
  values.MC_LOGIN_DELAY_SECONDS = await value('MC_LOGIN_DELAY_SECONDS', '登录延迟秒数', '3');
  values.MC_LOGIN_COMMAND = await value('MC_LOGIN_COMMAND', '登录命令', '/l');
  values.MC_RECONNECT_INITIAL_SECONDS = await value('MC_RECONNECT_INITIAL_SECONDS', '初始重连秒数', '5');
  values.MC_RECONNECT_MAX_SECONDS = await value('MC_RECONNECT_MAX_SECONDS', '最大重连秒数', '300');
  values.MC_RECONNECT_JITTER_SECONDS = await value('MC_RECONNECT_JITTER_SECONDS', '重连随机抖动秒数', '3');
  values.MC_STATUS_INTERVAL_SECONDS = await value('MC_STATUS_INTERVAL_SECONDS', '状态刷新间隔秒数', '3');
  values.MC_ANTIAFK = await value('MC_ANTIAFK', 'Anti-AFK [true/false]', 'true');
  values.MC_ANTIAFK_INTERVAL_SECONDS = await value('MC_ANTIAFK_INTERVAL_SECONDS', 'Anti-AFK 间隔秒数', '45');
  const password = await promptSecret('新服务器插件密码（回车保留，输入 CLEAR 清除）：');
  const passwordAction = password === 'CLEAR' ? 'clear' : password ? 'set' : undefined;
  const request = { action: 'update', values };
  if (passwordAction) { request.passwordAction = passwordAction; if (passwordAction === 'set') request.password = password; }
  const result = configAdminRequest(request);
  process.stdout.write('配置已保存，正在重启服务使修改立即生效。\n');
  try {
    runSystemctl('restart');
    process.stdout.write('服务已重启。\n');
  } catch (error) {
    process.stderr.write(`[mcbot] 配置已保存，但服务重启失败：${error.message}\n请执行 sudo systemctl restart minecraft-bot.service\n`);
  }
  return result;
}

function printServiceSummary() {
  const active = runSystemctlCapture('is-active');
  const enabled = runSystemctlCapture('is-enabled');
  process.stdout.write(`systemd 运行状态：${(active.stdout || active.stderr).trim() || 'unknown'}\n`);
  process.stdout.write(`开机自启状态：${(enabled.stdout || enabled.stderr).trim() || 'unknown'}\n`);
  printOnce();
}

async function serviceMenu() {
  while (true) {
    process.stdout.write('\n服务启停菜单\n1. 查看服务状态\n2. 开启服务\n3. 停止/中止服务\n4. 重启服务\n0. 返回\n');
    const choice = await promptLine('请选择：');
    try {
      if (choice === '0') return;
      if (choice === '1') printServiceSummary();
      else if (choice === '2') { runSystemctl('start'); process.stdout.write('服务启动命令已执行。\n'); }
      else if (choice === '3') { runSystemctl('stop'); process.stdout.write('服务停止命令已执行。\n'); }
      else if (choice === '4') { runSystemctl('restart'); process.stdout.write('服务重启命令已执行。\n'); }
      else process.stdout.write('无效选项。\n');
    } catch (error) { process.stderr.write(`[mcbot] ${error.message}\n`); }
  }
}

async function uninstallMenu() {
  const confirm = await promptLine('卸载将停止服务并删除程序、配置、状态和认证缓存。输入 UNINSTALL 确认：');
  if (confirm !== 'UNINSTALL') { process.stdout.write('已取消卸载。\n'); return; }
  const script = '/usr/local/sbin/mcbot-uninstall';
  const command = process.getuid && process.getuid() === 0 ? script : 'sudo';
  const args = command === script ? [] : [script];
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('卸载失败');
  process.exit(0);
}

async function mainMenu() {
  while (true) {
    printServiceSummary();
    process.stdout.write('\n主菜单\n1. 进入对话\n2. 服务启停\n3. 编辑服务器配置\n4. 查看服务日志\n5. 卸载\n0. 退出\n');
    const choice = await promptLine('请选择：');
    try {
      if (choice === '0') return;
      if (choice === '1') await chatConsole();
      else if (choice === '2') await serviceMenu();
      else if (choice === '3') await editConfigMenu();
      else if (choice === '4') followLogsBlocking();
      else if (choice === '5') await uninstallMenu();
      else process.stdout.write('无效选项。\n');
    } catch (error) { process.stderr.write(`[mcbot] ${error.message}\n`); }
  }
}

function serviceCommand(action) {
  const result = spawnSync('systemctl', [action, serviceName], { stdio: 'inherit' });
  if (result.error) {
    process.stderr.write(`无法执行 systemctl：${result.error.message}\n`);
    process.exitCode = 1;
  } else if (result.status !== 0) {
    process.exitCode = result.status || 1;
  }
}

function followLogs() {
  const child = spawn('journalctl', ['-u', serviceName, '-f', '--no-pager'], { stdio: 'inherit' });
  child.on('error', (error) => {
    process.stderr.write(`无法执行 journalctl：${error.message}\n`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    if (signal) process.exitCode = 1;
    else if (code) process.exitCode = code;
  });
}

function followLogsBlocking() {
  const result = spawnSync('journalctl', ['-u', serviceName, '-f', '--no-pager'], { stdio: 'inherit' });
  if (result.error) throw result.error;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'menu';
  const text = args.slice(1).join(' ');

  switch (command) {
    case 'menu':
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        printOnce();
        return;
      }
      await mainMenu();
      return;
    case 'watch':
      watch();
      return;
    case 'once':
    case 'status':
      printOnce();
      return;
    case 'say':
    case 'chat-once':
      await sendChatOnce(text);
      return;
    case 'command':
    case 'cmd':
      await sendCommandOnce(text);
      return;
    case 'chat':
    case 'console':
      await chatConsole();
      return;
    case 'start':
    case 'stop':
    case 'restart':
      serviceCommand(command);
      return;
    case 'logs':
      followLogs();
      return;
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write('用法：mcbot [once|say TEXT|command CMD|chat|start|stop|restart|logs|help]\n');
      process.stdout.write('无参数运行会进入数字菜单；菜单 1 同时支持普通聊天和 /Minecraft 指令。\n');
      return;
    default:
      process.stderr.write(`未知命令：${command}\n`);
      process.exitCode = 2;
  }
}

main().catch(printControlError);
