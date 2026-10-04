// Explicit opt-in diagnostic: synthetic data only; never prints credentials or executes tools.
const {app,safeStorage}=require('electron');
const path=require('node:path');
(async()=>{
  await app.whenReady();
  const [home,id,model]=process.argv.slice(2);
  if(!home||!id||!model)throw Error('Usage: electron scripts/probe-desktop-tools.cjs HOME PROVIDER MODEL');
  const {DesktopProviders}=await import('../src/desktop-providers.ts');
  const {probeDesktopTools}=await import('../src/desktop-tool-probe.ts');
  const config=await new DesktopProviders(path.resolve(home),safeStorage).resolve(id,model);
  console.log(JSON.stringify(await probeDesktopTools(config)));
  app.exit(0);
})().catch(()=>{console.error('Probe unavailable: configuration or OS credential context could not be opened. Use the client’s 检测工具 button; no credential fallback is attempted.');app.exit(1);});
