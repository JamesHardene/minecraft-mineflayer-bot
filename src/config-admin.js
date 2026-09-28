'use strict';

const fs = require('fs');
const path = require('path');

const configFile = '/etc/minecraft-bot/minecraft-bot.env';
const serviceGroup = 'minecraft-bot';
const lockFile = `${configFile}.lock`;
const editableKeys = [
  'MC_HOST', 'MC_PORT', 'MC_USERNAME', 'MC_AUTH', 'MC_VERSION', 'MC_SERVER_NAME',
  'MC_LOGIN_DELAY_SECONDS', 'MC_LOGIN_COMMAND', 'MC_RECONNECT_INITIAL_SECONDS',
  'MC_RECONNECT_MAX_SECONDS', 'MC_RECONNECT_JITTER_SECONDS', 'MC_STATUS_INTERVAL_SECONDS',
  'MC_ANTIAFK', 'MC_ANTIAFK_INTERVAL_SECONDS'
];
const pathKeys = new Set([
  'MCBOT_DATA_DIR', 'MCBOT_STATUS_FILE', 'MCBOT_CONTROL_SOCKET', 'MCBOT_CONTROL_MAX_TEXT',
  'MCBOT_SERVICE_NAME', 'MC_PROFILES_FOLDER'
]);

function fail(message) { throw new Error(message); }
function parseEnv(content) {
  const values = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\([\\"])/g, '$1');
    }
    values[match[1]] = value;
  }
  return values;
}
function quoteEnv(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '')}"`;
}
function validateSingleLine(name, value, required = false) {
  if (required && !String(value || '').trim()) fail(`${name} is required`);
  if (/[\r\n\u0000]/.test(String(value || ''))) fail(`${name} cannot contain newlines or NUL`);
}
function integer(name, value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) fail(`${name} must be an integer between ${minimum} and ${maximum}`);
  return String(number);
}
function boolean(name, value) {
  if (!/^(true|false|1|0|yes|no|on|off)$/i.test(String(value))) fail(`${name} must be true or false`);
  return /^(true|1|yes|on)$/i.test(String(value)) ? 'true' : 'false';
}
function validate(values) {
  validateSingleLine('MC_HOST', values.MC_HOST, true);
  validateSingleLine('MC_USERNAME', values.MC_USERNAME, true);
  validateSingleLine('MC_SERVER_NAME', values.MC_SERVER_NAME || '');
  values.MC_PORT = integer('MC_PORT', values.MC_PORT || '25565', 1, 65535);
  values.MC_AUTH = String(values.MC_AUTH || 'offline').toLowerCase();
  if (!['offline', 'microsoft'].includes(values.MC_AUTH)) fail('MC_AUTH must be offline or microsoft');
  validateSingleLine('MC_VERSION', values.MC_VERSION || '');
  if (String(values.MC_VERSION).toLowerCase() === 'auto') values.MC_VERSION = '';
  values.MC_LOGIN_DELAY_SECONDS = integer('MC_LOGIN_DELAY_SECONDS', values.MC_LOGIN_DELAY_SECONDS || '3', 0, 60);
  values.MC_RECONNECT_INITIAL_SECONDS = integer('MC_RECONNECT_INITIAL_SECONDS', values.MC_RECONNECT_INITIAL_SECONDS || '5', 1, 3600);
  values.MC_RECONNECT_MAX_SECONDS = integer('MC_RECONNECT_MAX_SECONDS', values.MC_RECONNECT_MAX_SECONDS || '300', 5, 86400);
  values.MC_RECONNECT_JITTER_SECONDS = integer('MC_RECONNECT_JITTER_SECONDS', values.MC_RECONNECT_JITTER_SECONDS || '3', 0, 300);
  values.MC_STATUS_INTERVAL_SECONDS = integer('MC_STATUS_INTERVAL_SECONDS', values.MC_STATUS_INTERVAL_SECONDS || '3', 1, 60);
  values.MC_ANTIAFK_INTERVAL_SECONDS = integer('MC_ANTIAFK_INTERVAL_SECONDS', values.MC_ANTIAFK_INTERVAL_SECONDS || '45', 10, 3600);
  values.MC_ANTIAFK = boolean('MC_ANTIAFK', values.MC_ANTIAFK === undefined ? 'true' : values.MC_ANTIAFK);
  const command = String(values.MC_LOGIN_COMMAND || '/l').trim();
  if (!/^\/[^\s\r\n\u0000]{1,63}$/.test(command)) fail('MC_LOGIN_COMMAND must be a short slash command');
  values.MC_LOGIN_COMMAND = command;
}
function writeAtomic(values) {
  let lock;
  try {
    lock = fs.openSync(lockFile, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') fail('配置文件正在被其他操作修改，请稍后重试');
    throw error;
  }
  try {
    const lines = [];
    const keys = new Set(Object.keys(values));
    for (const key of keys) {
      if (pathKeys.has(key) || editableKeys.includes(key) || key === 'MC_LOGIN_PASSWORD') lines.push(`${key}=${quoteEnv(values[key])}`);
    }
    const temp = `${configFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o640 });
    try {
      const group = require('child_process').execFileSync('getent', ['group', serviceGroup], { encoding: 'utf8' }).trim().split(':')[2];
      if (group) fs.chownSync(temp, 0, Number(group));
    } catch {}
    fs.chmodSync(temp, 0o640);
    fs.renameSync(temp, configFile);
  } finally {
    fs.closeSync(lock);
    try { fs.unlinkSync(lockFile); } catch {}
  }
}
function response(values) {
  return {
    ok: true,
    values: Object.fromEntries(editableKeys.filter((key) => key !== 'MC_LOGIN_PASSWORD').map((key) => [key, values[key] ?? ''])),
    passwordConfigured: Boolean(values.MC_LOGIN_PASSWORD)
  };
}
function main(request) {
  if (!request || !['get', 'update'].includes(request.action)) fail('action must be get or update');
  if (!fs.existsSync(configFile)) fail(`config file does not exist: ${configFile}`);
  const values = parseEnv(fs.readFileSync(configFile, 'utf8'));
  if (request.action === 'get') return response(values);
  const input = request.values;
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('values must be an object');
  for (const key of Object.keys(input)) {
    if (!editableKeys.includes(key)) fail(`field is not editable: ${key}`);
    values[key] = String(input[key]);
  }
  if (request.passwordAction === 'set') {
    const password = String(request.password || '');
    if (!password || /[\r\n\u0000]/.test(password) || password.length > 256 || password.trim().length === 0) fail('MC_LOGIN_PASSWORD is invalid');
    values.MC_LOGIN_PASSWORD = password;
  } else if (request.passwordAction === 'clear') {
    delete values.MC_LOGIN_PASSWORD;
  }
  validate(values);
  writeAtomic(values);
  return response(values);
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try { process.stdout.write(`${JSON.stringify(main(JSON.parse(input || '{}')))}\n`); }
  catch (error) { process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`); process.exitCode = 1; }
});
