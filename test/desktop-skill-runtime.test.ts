import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSkillPackages} from '../src/skill-packages.ts';
import {desktopModelSend} from '../src/desktop-model.ts';
import {startTestServer} from './server-fixture.ts';

test('desktop reads globally imported SKILL and resources progressively in read-only across workspaces',async()=>{
  const root=await mkdtemp(fileURLToPath(new URL('../.verify-skill-runtime-',import.meta.url)));
  const home=path.join(root,'home'),source=path.join(root,'package'),one=path.join(root,'one'),two=path.join(root,'two');
  for(const p of [home,source,one,two,path.join(source,'references')])await mkdir(p,{recursive:true});
  await writeFile(path.join(source,'SKILL.md'),'---\nname: portable\ndescription: |\n  Design reusable interfaces.\n  Uses reference resources.\n---\nFULL_SKILL_SENTINEL Read references/ref.md before implementing.\n');
  await writeFile(path.join(source,'references','ref.md'),'RESOURCE_SENTINEL full reference\n');
  const service=createSkillPackages(home);await service.importPath(source);
  const requests:any[]=[];let step=0;
  const server=await startTestServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);requests.push(body);
    const args=step===0?{skill:'portable:portable'}:{skill:'portable:portable',path:'references/ref.md'};
    const message=step++<2?{role:'assistant',content:'',tool_calls:[{id:'skill-'+step,type:'function',function:{name:'skill_read',arguments:JSON.stringify(args)}}]}:{role:'assistant',content:'Read skill and reference'};
    res.end(JSON.stringify({model:'fixture',choices:[{message,finish_reason:'tool_calls' in message?'tool_calls':'stop'}]}));
  });
  const config={baseUrl:`http://127.0.0.1:${server.port}/v1`,model:'fixture',apiKey:'synthetic'};
  try{
    for(const workspaceRoot of [one,two]){
      step=0;const result=await desktopModelSend(home,'Design an interface',config,{},config,undefined,{workspaceRoot,permission:'read',check(){},async approve(){throw Error('readers require no write approval');}},undefined,{skills:[],tools:[],skillTools:await service.tools(),skillCatalog:await service.catalogPrompt()});
      assert.equal(result.error,undefined);assert.equal(result.content,'Read skill and reference');
      const first=requests.at(-3),last=requests.at(-1);
      assert.ok(first.messages.some((m:any)=>m.role==='system'&&m.content.includes('portable:portable')));
      assert.ok(!first.messages.some((m:any)=>m.content.includes('FULL_SKILL_SENTINEL')),'full skill not eagerly stuffed into catalogue');
      assert.ok(first.tools.some((t:any)=>t.function.name==='skill_read'));
      assert.ok(!first.tools.some((t:any)=>t.function.name==='run_command'||t.function.name.startsWith('mcp__')));
      assert.ok(last.messages.some((m:any)=>m.role==='tool'&&m.content.includes('FULL_SKILL_SENTINEL')));
      assert.ok(last.messages.some((m:any)=>m.role==='tool'&&m.content.includes('RESOURCE_SENTINEL')));
    }
    await service.enable('portable',false);assert.ok(!(await service.catalogPrompt()).includes('portable:portable'));
    step=0;const refused=await desktopModelSend(home,'Try disabled skill',config,{},config,undefined,{workspaceRoot:one,permission:'read',check(){},async approve(){return false;}},undefined,{skills:[],tools:[],skillTools:await service.tools(),skillCatalog:await service.catalogPrompt()});
    assert.ok(refused.transcript?.filter(t=>t.kind==='result').every(t=>t.kind==='result'&&t.isError),'disabled package stays unreadable even if the model guesses its id');
  }finally{await server.close();assert.ok(root.startsWith(fileURLToPath(new URL('../.verify-skill-runtime-',import.meta.url))));await rm(root,{recursive:true,force:true});}
});
