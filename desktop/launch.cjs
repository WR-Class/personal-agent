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

if (require.main === module) {
  try {
    const config = launchOptions();
    const child = spawn(config.executable, config.args, config.options);
    child.once('error', error => { console.error('Desktop launch failed:', error.message); process.exitCode = 1; });
    child.once('exit', (code, signal) => {
      if (signal || code !== 0) console.error(`Desktop exited: ${signal || code}`);
      process.exitCode = code === 0 ? 0 : 1;
    });
  } catch (error) {
    console.error('Desktop launch failed:', error.message);
    process.exitCode = 1;
  }
}
module.exports = { launchOptions };
