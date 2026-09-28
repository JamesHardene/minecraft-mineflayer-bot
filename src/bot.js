'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const mineflayer = require('mineflayer');

const dataDir = process.env.MCBOT_DATA_DIR || '/var/lib/minecraft-bot';
const statusFile = process.env.MCBOT_STATUS_FILE || path.join(dataDir, 'status.json');
const controlSocket = process.env.MCBOT_CONTROL_SOCKET || '/run/minecraft-bot/control.sock';
const controlLineLimit = 8192;

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function integerEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function secondsEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  const value = Number(raw === undefined || raw === '' ? fallback : raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum} seconds`);
  }
  return value * 1000;
}

function passwordArgument() {
  const args = process.argv.slice(2);
  const prefix = '--password=';
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = args.indexOf('--password');
  if (index === -1) return undefined;
  if (index + 1 >= args.length) throw new Error('--password requires a value');
  return args[index + 1];
}

function validateLoginPassword(value) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error('MC_LOGIN_PASSWORD must be a string');
  if (value.length > 256) throw new Error('MC_LOGIN_PASSWORD must be at most 256 characters');
  if (/[\r\n\u0000]/.test(value)) {
    throw new Error('MC_LOGIN_PASSWORD cannot contain newlines or NUL characters');
  }
  if (value.trim().length === 0) throw new Error('MC_LOGIN_PASSWORD cannot be blank');
  return value;
}

function validateLoginCommand(value) {
  const command = String(value || '/l').trim();
  if (!command.startsWith('/') || command.length > 64 || /[\r\n\u0000\s]/.test(command)) {
    throw new Error('MC_LOGIN_COMMAND must be a short slash command such as /l');
  }
  return command;
}

function booleanEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

let sensitivePassword = null;

function redactSensitive(value) {
  let text = String(value || '');
  if (sensitivePassword) text = text.split(sensitivePassword).join('[REDACTED]');
  return text;
}

function redactValue(value) {
  if (typeof value === 'string') return redactSensitive(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  }
  return value;
}

function cleanReason(reason) {
  if (reason === undefined || reason === null) return null;
  let value;
  if (typeof reason === 'string') value = reason;
  else {
    try {
      value = JSON.stringify(reason);
    } catch {
      value = String(reason);
    }
  }
  return redactSensitive(value);
}

const cliPassword = passwordArgument();
const configuredPassword = process.env.MC_LOGIN_PASSWORD !== undefined
  ? process.env.MC_LOGIN_PASSWORD
  : cliPassword;
const configuredVersion = (process.env.MC_VERSION || '').trim();

const config = {
  host: required('MC_HOST'),
  port: integerEnv('MC_PORT', 25565, 1, 65535),
  username: required('MC_USERNAME'),
  auth: (process.env.MC_AUTH || 'offline').trim().toLowerCase(),
  version: configuredVersion.toLowerCase() === 'auto' || !configuredVersion ? false : configuredVersion,
  serverName: (process.env.MC_SERVER_NAME || process.env.MC_HOST || '').trim(),
  reconnectInitialMs: secondsEnv('MC_RECONNECT_INITIAL_SECONDS', 5, 1, 3600),
  reconnectMaxMs: secondsEnv('MC_RECONNECT_MAX_SECONDS', 300, 5, 86400),
  reconnectJitterMs: secondsEnv('MC_RECONNECT_JITTER_SECONDS', 3, 0, 300),
  statusIntervalMs: secondsEnv('MC_STATUS_INTERVAL_SECONDS', 3, 1, 60),
  antiAfk: booleanEnv('MC_ANTIAFK', true),
  antiAfkIntervalMs: secondsEnv('MC_ANTIAFK_INTERVAL_SECONDS', 45, 10, 3600),
  profilesFolder: process.env.MC_PROFILES_FOLDER || path.join(dataDir, 'auth'),
  controlMaxText: integerEnv('MCBOT_CONTROL_MAX_TEXT', 256, 32, 4096),
  loginPassword: validateLoginPassword(configuredPassword),
  loginDelayMs: secondsEnv('MC_LOGIN_DELAY_SECONDS', 3, 0, 60),
  loginCommand: validateLoginCommand(process.env.MC_LOGIN_COMMAND || '/l')
};

if (!['offline', 'microsoft'].includes(config.auth)) {
  throw new Error('MC_AUTH must be offline or microsoft');
}

sensitivePassword = config.loginPassword;

const state = {
  schemaVersion: 2,
  processPid: process.pid,
  status: 'starting',
  botUsername: config.username,
  botUuid: null,
  serverName: config.serverName,
  host: config.host,
  port: config.port,
  serverAddress: `${config.host}:${config.port}`,
  auth: config.auth,
  startedAt: new Date().toISOString(),
  connectedAt: null,
  disconnectedAt: null,
  lastUpdateAt: null,
  nextReconnectAt: null,
  reconnectAttempt: 0,
  latencyMs: null,
  onlinePlayers: null,
  visiblePlayers: [],
  world: null,
  position: null,
  lastError: null,
  kickedReason: null
};

let bot = null;
let reconnectTimer = null;
let loginTimer = null;
const loginHandledBots = new WeakSet();
let statusTimer = null;
let antiAfkTimer = null;
let controlServer = null;
const controlClients = new Set();
let stopping = false;
let statusWriteWarningShown = false;

function log(level, message, details = {}) {
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...details
  };
  process.stdout.write(`${JSON.stringify(redactValue(entry))}\n`);
}

function writeStatus() {
  state.lastUpdateAt = new Date().toISOString();
  const directory = path.dirname(statusFile);
  const temporaryFile = `${statusFile}.${process.pid}.tmp`;

  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(temporaryFile, `${JSON.stringify(redactValue(state), null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o644
    });
    fs.chmodSync(temporaryFile, 0o644);
    fs.renameSync(temporaryFile, statusFile);
    statusWriteWarningShown = false;
  } catch (error) {
    try {
      if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
    } catch {
      // Keep the original write error as the useful diagnostic.
    }
    if (!statusWriteWarningShown) {
      log('warn', 'could not write status file', { error: error.message, statusFile });
      statusWriteWarningShown = true;
    }
  }
}

function readPlayers() {
  if (!bot || !bot.players) return [];
  return Object.values(bot.players)
    .map((player) => player && player.username)
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function readLatency() {
  const candidates = [
    bot && bot.player && bot.player.ping,
    bot && bot.players && bot.players[bot.username] && bot.players[bot.username].ping,
    bot && bot.ping,
    bot && bot._client && bot._client.latency
  ];
  for (const candidate of candidates) {
    const value = finiteNumber(candidate);
    if (value !== null && value >= 0) return Math.round(value);
  }
  return null;
}

function updateTelemetry() {
  if (!bot) {
    writeStatus();
    return;
  }

  const players = readPlayers();
  const position = bot.entity && bot.entity.position;
  const dimension = bot.game && (bot.game.dimension || bot.game.level_name);

  state.botUsername = bot.username || config.username;
  state.botUuid = (bot.player && bot.player.uuid)
    || (bot.entity && bot.entity.uuid)
    || (bot.players && bot.players[state.botUsername] && bot.players[state.botUsername].uuid)
    || state.botUuid;
  state.latencyMs = readLatency();
  state.onlinePlayers = players.length;
  state.visiblePlayers = players.slice(0, 100);
  state.world = dimension || state.world || null;
  state.position = position
    ? {
        x: Number(position.x.toFixed(2)),
        y: Number(position.y.toFixed(2)),
        z: Number(position.z.toFixed(2))
      }
    : state.position;

  writeStatus();
}

function reconnectDelayMs(attempt) {
  const exponent = Math.min(Math.max(attempt - 1, 0), 10);
  const base = Math.min(config.reconnectMaxMs, config.reconnectInitialMs * (2 ** exponent));
  const jitter = config.reconnectJitterMs > 0
    ? Math.floor(Math.random() * (config.reconnectJitterMs + 1))
    : 0;
  return Math.min(config.reconnectMaxMs, base + jitter);
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;

  const delay = reconnectDelayMs(Math.max(state.reconnectAttempt, 1));
  state.status = 'reconnecting';
  state.nextReconnectAt = new Date(Date.now() + delay).toISOString();
  writeStatus();
  log('info', 'scheduled reconnect', {
    delaySeconds: Math.ceil(delay / 1000),
    attempt: state.reconnectAttempt
  });

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function controlId(request) {
  return typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
}

function sendControl(client, payload) {
  if (!client.socket.destroyed) {
    client.socket.write(`${JSON.stringify(redactValue(payload))}\n`);
  }
}

function controlResponse(client, request, payload) {
  sendControl(client, {
    id: controlId(request),
    ...payload
  });
}

function validateControlText(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('text is required');
  }
  if (value.length > config.controlMaxText) {
    throw new Error(`text is too long; maximum is ${config.controlMaxText} characters`);
  }
  if (/[\r\n\u0000]/.test(value)) {
    throw new Error('text cannot contain newlines or NUL characters');
  }
  if (value.trim().length === 0) {
    throw new Error('text cannot be blank');
  }
  return value;
}

function requireOnline() {
  if (!bot || state.status !== 'online') {
    throw new Error(`bot is not online (status: ${state.status})`);
  }
}

function sendMinecraftText(text) {
  requireOnline();
  bot.chat(text);
}

function normalizeCommand(value) {
  const command = validateControlText(value).trim();
  const normalized = command.startsWith('/') ? command : `/${command}`;
  if (normalized === '/') throw new Error('Minecraft command cannot be empty');
  return normalized;
}

function statusSnapshot() {
  return redactValue(JSON.parse(JSON.stringify(state)));
}

function broadcastControlEvent(payload) {
  for (const client of controlClients) {
    if (client.subscribed) sendControl(client, payload);
  }
}

function clearLoginTimer() {
  if (loginTimer) {
    clearTimeout(loginTimer);
    loginTimer = null;
  }
}

function scheduleServerLogin(currentBot) {
  clearLoginTimer();
  if (!config.loginPassword || loginHandledBots.has(currentBot)) return;
  loginHandledBots.add(currentBot);

  loginTimer = setTimeout(() => {
    loginTimer = null;
    if (stopping || bot !== currentBot || state.status !== 'online') return;
    try {
      currentBot.chat(`${config.loginCommand} ${config.loginPassword}`);
      log('info', 'server login command sent', { command: config.loginCommand });
    } catch (error) {
      log('warn', 'server login command failed', { command: config.loginCommand, error: error.message });
    }
  }, config.loginDelayMs);
}

function handleControlRequest(client, request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    sendControl(client, { id: null, ok: false, error: 'request must be a JSON object' });
    return;
  }

  const operation = request.op || request.action;
  try {
    if (operation === 'say' || operation === 'chat') {
      const text = validateControlText(request.text);
      if (text.trimStart().startsWith('/')) {
        throw new Error('chat text starting with / is a Minecraft command; use command instead');
      }
      sendMinecraftText(text);
      controlResponse(client, request, { ok: true, op: 'say', text });
      return;
    }

    if (operation === 'command') {
      const command = normalizeCommand(request.text !== undefined ? request.text : request.command);
      sendMinecraftText(command);
      controlResponse(client, request, { ok: true, op: 'command', command });
      return;
    }

    if (operation === 'status') {
      controlResponse(client, request, { ok: true, op: 'status', status: statusSnapshot() });
      return;
    }

    if (operation === 'subscribe') {
      client.subscribed = true;
      controlResponse(client, request, { ok: true, op: 'subscribe', status: statusSnapshot() });
      return;
    }

    controlResponse(client, request, { ok: false, error: `unknown operation: ${operation || '(missing)'}` });
  } catch (error) {
    controlResponse(client, request, { ok: false, error: error.message });
  }
}

function handleControlConnection(socket) {
  const client = { socket, subscribed: false, buffer: '' };
  controlClients.add(client);
  socket.setEncoding('utf8');

  socket.on('data', (chunk) => {
    client.buffer += chunk;
    if (client.buffer.length > controlLineLimit) {
      sendControl(client, { id: null, ok: false, error: 'control request is too large' });
      socket.destroy();
      return;
    }

    let newlineIndex;
    while ((newlineIndex = client.buffer.indexOf('\n')) !== -1) {
      const line = client.buffer.slice(0, newlineIndex).replace(/\r$/, '');
      client.buffer = client.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        handleControlRequest(client, JSON.parse(line));
      } catch (error) {
        sendControl(client, { id: null, ok: false, error: `invalid JSON request: ${error.message}` });
      }
    }
  });

  socket.on('close', () => controlClients.delete(client));
  socket.on('error', (error) => log('debug', 'control socket client error', { error: error.message }));
}

function removeControlSocket() {
  try {
    const info = fs.lstatSync(controlSocket);
    if (!info.isSocket()) {
      throw new Error(`control socket path exists and is not a socket: ${controlSocket}`);
    }
    fs.unlinkSync(controlSocket);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function startControlServer() {
  try {
    removeControlSocket();
    controlServer = net.createServer(handleControlConnection);
    controlServer.on('error', (error) => {
      state.lastError = redactSensitive(`control socket error: ${error.message}`);
      writeStatus();
      log('error', 'control socket server error', { error: error.message, controlSocket });
      stopping = true;
      process.exitCode = 1;
      stopControlServer();
      process.exit(1);
    });
    controlServer.listen(controlSocket, () => {
      try {
        fs.chmodSync(controlSocket, 0o660);
        log('info', 'control socket listening', { controlSocket });
      } catch (error) {
        log('error', 'could not set control socket permissions', { error: error.message, controlSocket });
      }
    });
  } catch (error) {
    state.lastError = redactSensitive(`control socket could not start: ${error.message}`);
    writeStatus();
    log('error', 'control socket could not start', { error: error.message, controlSocket });
    process.exitCode = 1;
    process.exit(1);
  }
}

function stopControlServer() {
  for (const client of controlClients) client.socket.destroy();
  controlClients.clear();
  if (controlServer) {
    controlServer.close();
    controlServer = null;
  }
  try {
    const info = fs.lstatSync(controlSocket);
    if (info.isSocket()) fs.unlinkSync(controlSocket);
  } catch (error) {
    if (error.code !== 'ENOENT') log('warn', 'could not remove control socket', { error: error.message });
  }
}

function attachBotEvents(currentBot) {
  currentBot.on('login', () => {
    if (bot !== currentBot) return;
    state.botUsername = currentBot.username || config.username;
    state.botUuid = (currentBot.player && currentBot.player.uuid) || state.botUuid;
    state.status = 'logged_in';
    state.lastError = null;
    writeStatus();
    log('info', 'minecraft login completed', {
      username: state.botUsername,
      uuid: state.botUuid
    });
  });

  currentBot.on('spawn', () => {
    if (bot !== currentBot) return;
    state.status = 'online';
    state.connectedAt = new Date().toISOString();
    state.disconnectedAt = null;
    state.nextReconnectAt = null;
    state.reconnectAttempt = 0;
    state.lastError = null;
    state.kickedReason = null;
    updateTelemetry();
    scheduleServerLogin(currentBot);
    broadcastControlEvent({ event: 'status', status: statusSnapshot() });
    log('info', 'minecraft spawn completed');
  });

  currentBot.on('messagestr', (message, position, jsonMessage, sender, verified) => {
    if (bot !== currentBot) return;
    const text = redactSensitive(String(message || '').replace(/[\r\n]+/g, ' ')).slice(0, config.controlMaxText);
    if (!text) return;
    const event = {
      event: 'message',
      text,
      position: typeof position === 'string' ? position : null,
      sender: typeof sender === 'string' ? sender : null,
      verified: Boolean(verified)
    };
    broadcastControlEvent(event);
    log('info', 'minecraft message received', event);
  });

  currentBot.on('kicked', (reason) => {
    if (bot !== currentBot) return;
    clearLoginTimer();
    state.status = 'kicked';
    state.kickedReason = cleanReason(reason);
    writeStatus();
    broadcastControlEvent({ event: 'status', status: statusSnapshot() });
    log('warn', 'minecraft server kicked the bot', { reason: state.kickedReason });
  });

  currentBot.on('error', (error) => {
    if (bot !== currentBot) return;
    clearLoginTimer();
    state.status = 'error';
    state.lastError = redactSensitive(error && error.message ? error.message : String(error));
    writeStatus();
    broadcastControlEvent({ event: 'status', status: statusSnapshot() });
    log('error', 'minecraft client error', { error: state.lastError });
  });

  currentBot.on('end', (reason) => {
    if (bot !== currentBot) return;
    clearLoginTimer();
    bot = null;
    state.disconnectedAt = new Date().toISOString();
    state.connectedAt = null;
    state.latencyMs = null;
    state.onlinePlayers = null;
    state.visiblePlayers = [];
    state.world = null;
    state.position = null;
    if (!stopping) {
      state.status = 'offline';
    } else {
      state.status = 'stopped';
    }
    writeStatus();
    broadcastControlEvent({ event: 'status', status: statusSnapshot() });
    log('info', 'minecraft connection ended', { reason: cleanReason(reason) });
    scheduleReconnect();
  });
}

function connect() {
  if (stopping) return;
  clearLoginTimer();

  state.status = 'connecting';
  state.nextReconnectAt = null;
  state.reconnectAttempt += 1;
  writeStatus();
  broadcastControlEvent({ event: 'status', status: statusSnapshot() });
  log('info', 'connecting to minecraft server', {
    host: config.host,
    port: config.port,
    username: config.username,
    auth: config.auth,
    attempt: state.reconnectAttempt
  });

  let currentBot;
  try {
    currentBot = mineflayer.createBot({
      host: config.host,
      port: config.port,
      username: config.username,
      auth: config.auth,
      version: config.version,
      profilesFolder: config.profilesFolder
    });
  } catch (error) {
    state.status = 'error';
    state.lastError = redactSensitive(error.message);
    writeStatus();
    log('error', 'could not create minecraft client', { error: error.message });
    scheduleReconnect();
    return;
  }

  bot = currentBot;
  attachBotEvents(currentBot);
}

function antiAfkTick() {
  if (!config.antiAfk || !bot || state.status !== 'online' || !bot.entity) return;

  const yaw = Number(bot.entity.yaw || 0) + Math.PI / 6;
  const pitch = Number(bot.entity.pitch || 0);
  try {
    const result = bot.look(yaw, pitch, true);
    if (result && typeof result.catch === 'function') {
      result.catch((error) => log('debug', 'anti-AFK look update failed', { error: error.message }));
    }
  } catch (error) {
    log('debug', 'anti-AFK look update failed', { error: error.message });
  }
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (statusTimer) clearInterval(statusTimer);
  if (antiAfkTimer) clearInterval(antiAfkTimer);
  clearLoginTimer();
  stopControlServer();

  state.status = 'stopping';
  writeStatus();
  log('info', 'stopping minecraft bot', { signal });

  if (!bot) {
    state.status = 'stopped';
    writeStatus();
    process.exit(0);
    return;
  }

  const forceExitTimer = setTimeout(() => process.exit(0), 5000);
  forceExitTimer.unref();
  try {
    bot.quit('service stopping');
  } catch (error) {
    log('warn', 'minecraft client quit failed', { error: error.message });
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  log('fatal', 'uncaught exception', { error: error.stack || error.message });
  state.status = 'error';
  state.lastError = redactSensitive(error.message);
  writeStatus();
  stopControlServer();
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  log('fatal', 'unhandled promise rejection', { error: error && error.stack ? error.stack : String(error) });
  state.status = 'error';
  state.lastError = redactSensitive(error && error.message ? error.message : String(error));
  writeStatus();
  stopControlServer();
  process.exit(1);
});

writeStatus();
startControlServer();
statusTimer = setInterval(updateTelemetry, config.statusIntervalMs);
antiAfkTimer = setInterval(antiAfkTick, config.antiAfkIntervalMs);
connect();
