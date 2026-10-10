import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm, link } from 'node:fs/promises';
import { createSkillPackages } from '../src/skill-packages.ts';

async function fixture() {
  await mkdir(path.resolve('.test-artifacts'), { recursive: true });
  const root = await mkdtemp(path.resolve('.test-artifacts/skill-packages-'));
  const source = path.join(root, 'source'), home = path.join(root, 'home');
  await mkdir(path.join(source, '.trae-plugin'), { recursive: true });
  await mkdir(path.join(source, 'skills', 'example', 'references'), { recursive: true });
  await mkdir(path.join(source, 'assets'), { recursive: true });
  await writeFile(path.join(source, '.trae-plugin', 'plugin.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', skills: './skills/', license: 'UNLICENSED' }));
  await writeFile(path.join(source, 'skills', 'example', 'SKILL.md'), '---\nname: example\ndescription: >-\n  Design interfaces\n  with references.\n---\n\nRead references/guide.md and ../../assets/shared.txt.\n');
  await writeFile(path.join(source, 'skills', 'example', 'references', 'guide.md'), 'RESOURCE_SENTINEL\nsecond\n');
  await writeFile(path.join(source, 'assets', 'shared.txt'), 'SHARED_ASSET');
  return { root, source, home, service: createSkillPackages(home) };
}
test('verified package metadata distinguishes plugins and only offers supported sanitized connector templates',async()=>{
 const f=await fixture();try{
  await writeFile(path.join(f.source,'.mcp.json'),JSON.stringify({mcpServers:{github:{type:'http',url:'https://api.githubcopilot.com/mcp/',headers:{Authorization:'Bearer ${connector.github.ACCESS_TOKEN}'}},custom:{type:'stdio',command:'ignored'}}}));
  await writeFile(path.join(f.source,'.app.json'),JSON.stringify({apps:{github:{id:'original-host'}}}));
  const imported=await f.service.importPath(f.source),p=(await f.service.plugins())[0]!;assert.equal(p.kind,'plugin');assert.equal(p.connectors.length,2);assert.equal(p.connectors[0]!.supported,true);assert.equal(p.connectors[0]!.needsToken,true);assert.equal(p.connectors[1]!.supported,false);assert.ok(p.compatibility.some(x=>x.includes('app')));assert.ok(!JSON.stringify(p).includes('ACCESS_TOKEN'));assert.equal((await createSkillPackages(f.home).plugins())[0]!.connectors[0]!.serverId,p.connectors[0]!.serverId);
  assert.deepEqual(await f.service.plugins(false),await f.service.plugins());
  await writeFile(path.join(imported.directory,'fixture','1.0.0','assets','shared.txt'),'tampered resource');
  assert.equal((await f.service.plugins(false))[0]!.id,'fixture','advisory display does not scan resource payloads');
  await assert.rejects(f.service.plugins(),/改变/);await assert.rejects(f.service.catalogPrompt(),/改变/);
  await writeFile(path.join(imported.directory,'fixture','1.0.0','.mcp.json'),'{}');await assert.rejects(f.service.plugins(false),/改变/);await assert.rejects(f.service.plugins(),/改变/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
// Tiny stored-ZIP fixture writer. Production always uses the installed yauzl decoder.
function crc32(data: Buffer) { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function zip(entries: [string, string][]) {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, content] of entries) {
    const n = Buffer.from(name), b = Buffer.from(content), h = Buffer.alloc(30), c = Buffer.alloc(46), crc = crc32(b);
    h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc, 14); h.writeUInt32LE(b.length, 18); h.writeUInt32LE(b.length, 22); h.writeUInt16LE(n.length, 26);
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(b.length, 20); c.writeUInt32LE(b.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    local.push(h, n, b); central.push(c, n); offset += h.length + n.length + b.length;
  }
  const end = Buffer.alloc(22), cd = Buffer.concat(central); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

test('package import preserves YAML metadata and full resources, globally enables and provides bounded narrow reads', async () => {
  const f = await fixture();
  try {
    const result = await f.service.importPath(f.source); assert.equal(result.packages.length, 1);
    const p = result.packages[0]!; assert.equal(p.id, 'fixture'); assert.equal(p.enabled, true); assert.equal(p.files, 4);
    assert.equal(p.skills[0]!.description, 'Design interfaces with references.');
    assert.equal(await readFile(path.join(result.directory, 'fixture', '1.0.0', 'assets/shared.txt'), 'utf8'), 'SHARED_ASSET');
    assert.match(await f.service.catalogPrompt(), /fixture:example/); assert.equal(JSON.stringify(result).includes('hashes'), false);
    const tools = await f.service.tools(), read = tools.find(t => t.name === 'skill_read')!, list = tools.find(t => t.name === 'skill_list_files')!;
    assert.equal(read.readOnly, true);
    for (const workspaceRoot of [path.join(f.root, 'workspace-a'), path.join(f.root, 'workspace-b')]) {
      const r = await read.execute({ skill: 'fixture:example', path: 'references/guide.md', offset: 1, limit: 1 }, { workspaceRoot });
      assert.equal(r.isError, undefined); assert.equal(JSON.parse(r.content).content, 'RESOURCE_SENTINEL');
      assert.match(JSON.parse(r.content).absolutePath, /plugins/);
    }
    assert.match((await read.execute({ skill: 'fixture:example', path: '../../assets/shared.txt' }, { workspaceRoot: f.root })).content, /SHARED_ASSET/);
    assert.match((await list.execute({ skill: 'fixture:example' }, { workspaceRoot: f.root })).content, /references\/guide.md/);
    assert.equal((await read.execute({ skill: 'fixture:example', path: '../../../registry.json' }, { workspaceRoot: f.root })).isError, true);
    await f.service.enable('fixture', false); assert.equal(await f.service.catalogPrompt(), '');
    assert.equal((await read.execute({ skill: 'fixture:example' }, { workspaceRoot: f.root })).isError, true);
    await f.service.enable('fixture', true); assert.equal((await createSkillPackages(f.home).list()).packages[0]!.enabled, true);
    await f.service.remove('fixture'); assert.equal((await f.service.list()).packages.length, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('ZIP and single-file imports work; traversal, duplicate paths and incompatible replacements leave registry untouched', async () => {
  const f = await fixture();
  const body = '---\nname: zipped\ndescription: "Quoted: YAML description"\n---\nUse refs/info.txt.\n';
  try {
    const file = path.join(f.root, 'skill.zip');
    await writeFile(file, zip([['wrapper/SKILL.md', body], ['wrapper/refs/info.txt', 'ZIP_RESOURCE']]));
    const added = await f.service.importPath(file); assert.equal(added.packages[0]!.id, 'zipped'); assert.equal(added.packages[0]!.files, 2);
    const rev = added.revision;
    for (const names of [['../escape.txt', 'SKILL.md'], ['SKILL.md', 'skill.md'], ['refs/NUL.txt', 'SKILL.md'], ['refs/file:stream', 'SKILL.md']]) {
      await writeFile(file, zip(names.map(n => [n, body]))); await assert.rejects(f.service.importPath(file)); assert.equal((await f.service.list()).revision, rev);
    }
    const single = path.join(f.root, 'SKILL.md'); await writeFile(single, body);
    await assert.rejects(f.service.importPath(single), /同名插件/);
    await f.service.remove('zipped'); await f.service.importPath(single);
    assert.equal((await f.service.list()).packages[0]!.files, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('hardlinks, literal credentials, malformed YAML and oversized payloads fail before installation', async () => {
  const f = await fixture();
  try {
    const original = path.join(f.source, 'assets/shared.txt'), linked = path.join(f.source, 'assets/link.txt');
    await link(original, linked); await assert.rejects(f.service.importPath(f.source), /链接/); await rm(linked);
    const config = path.join(f.source, '.mcp.json');
    await writeFile(config, JSON.stringify({ mcpServers: { github: { headers: { Authorization: 'Bearer PRIVATE_TEST_TOKEN' } } } }));
    await assert.rejects(f.service.importPath(f.source), /凭据/); assert.equal((await f.service.list()).packages.length, 0);
    await writeFile(config, JSON.stringify({ mcpServers: { github: { headers: { Authorization: 'Bearer ${connector.github.ACCESS_TOKEN}' } } } }));
    const good = await f.service.importPath(f.source); assert.equal(good.packages[0]!.warnings.length, 2);
    await f.service.remove('fixture');
    const skill = path.join(f.source, 'skills/example/SKILL.md');
    await writeFile(skill, '---\nname: x\nname: y\ndescription: bad\n---\n'); await assert.rejects(f.service.importPath(f.source), /YAML/);
    await writeFile(skill, 'x'.repeat(256 * 1024 + 1)); await assert.rejects(f.service.importPath(f.source), /256 KiB/);
    assert.equal((await f.service.list()).packages.length, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('post-import resource changes revoke actual reads and enabling; aborted calls never return content', async () => {
  const f = await fixture();
  try {
    await f.service.importPath(f.source);
    const read = (await f.service.tools())[0]!, controller = new AbortController(); controller.abort();
    await assert.rejects(read.execute({ skill: 'fixture:example' }, { workspaceRoot: f.root, signal: controller.signal }));
    await writeFile(path.join(f.home, 'plugins/fixture/1.0.0/assets/shared.txt'), 'tampered');
    assert.equal((await read.execute({ skill: 'fixture:example' }, { workspaceRoot: f.root })).isError, true);
    await assert.rejects(f.service.catalogPrompt(), /改变/); await f.service.enable('fixture', false); await assert.rejects(f.service.enable('fixture', true), /改变/);
    assert.equal((await f.service.list()).packages[0]!.enabled, false);
    await f.service.remove('fixture'); await f.service.importPath(f.source);
    assert.match(await f.service.catalogPrompt(), /fixture:example/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
