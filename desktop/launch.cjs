const path = require('node:path');
const { spawn } = require('node:child_process');

// An explicit runtime override is a development workaround, not an ACL repair.
function launchOptions(env = process.env, args = process.argv.slice(2)) {
  const executable = env.PERSONAL_AGENT_ELECTRON || require('electron');
  if (!path.isAbsolute(executable)) throw new Error('PERSONAL_AGENT_ELECTRON must be an absolute executable path');
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete childEnv[key];
  }
  const root = path.resolve(__dirname, '..');
  return { executable, args: [root, ...args], options: { cwd: root, env: childEnv, stdio: 'inherit', shell: false } };
}

// STATUS_BREAKPOINT is not a unique diagnosis: report evidence to check, never relax security.
function exitDiagnostic(code, signal, platform = process.platform) {
  if (signal) return `Desktop exited: ${signal}`;
  if (code === 0) return '';
  const status = platform === 'win32' && Number.isInteger(code) ? code >>> 0 : null;
  const hex = status === null ? '' : ` (0x${status.toString(16).padStart(8, '0').toUpperCase()})`;
  const hint = status === 0x80000003
    ? '\nWindows STATUS_BREAKPOINT: this code alone does not identify the cause. Check the Electron executable and parent directory integrity labels (icacls). An inherited Low label caused this on one verified installation. Do not disable the sandbox or reset workspace permissions automatically; see docs/ELECTRON_STARTUP.md.'
    : '';
  return `Desktop exited: ${code}${hex}${hint}`;
}

if (require.main === module) {
  try {
    const config = launchOptions();
    const child = spawn(config.executable, config.args, config.options);
    child.once('error', error => { console.error('Desktop launch failed:', error.message); process.exitCode = 1; });
    child.once('exit', (code, signal) => {
      const diagnostic = exitDiagnostic(code, signal);
      if (diagnostic) console.error(diagnostic);
      process.exitCode = code === 0 ? 0 : 1;
    });
  } catch (error) {
    console.error('Desktop launch failed:', error.message);
    process.exitCode = 1;
  }
}
module.exports = { launchOptions, exitDiagnostic };
