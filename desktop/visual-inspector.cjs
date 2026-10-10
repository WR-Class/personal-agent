// Host-only CDP adapter. Preview pages never receive an IPC bridge or arbitrary host execution.
const {randomUUID}=require('node:crypto');
const EDITABLE=new Set(('display position top right bottom left width height min-width max-width min-height max-height margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left box-sizing flex-direction flex-wrap align-items justify-content gap row-gap column-gap grid-template-columns grid-template-rows opacity border-radius color background-color border-color border-width border-style font-family font-size font-weight line-height letter-spacing text-align transform box-shadow visibility overflow z-index').split(' '));
function createInspector(win,view,source,isCurrent=()=>true){
  const wc=view.webContents,debug=wc.debugger;let epoch=randomUUID(),selected=null,known=new Set(),picking=false;
  const send=(data)=>{if(!win.isDestroyed()&&isCurrent())win.webContents.send('workspace:inspect',{viewId:wc.id,...data});};
  const reset=()=>{epoch=randomUUID();selected=null;known.clear();send({kind:'reset'});};
  wc.on('did-start-navigation',(_e,_url,inPlace,main)=>{if(main&&!inPlace)reset();});
  debug.on('detach',()=>{picking=false;reset();});
  async function ready(){if(!debug.isAttached())debug.attach('1.3');await debug.sendCommand('DOM.enable');await debug.sendCommand('CSS.enable');await debug.sendCommand('Overlay.enable');}
  function guard(token){if(!isCurrent()||wc.isDestroyed()||token!==epoch)throw Error('所选页面已变化，请重新选择元素');}
  async function snapshot(backendNodeId){
    const token=epoch;await ready();const {object}=await debug.sendCommand('DOM.resolveNode',{backendNodeId});
    if(!object.objectId)throw Error('元素已失效');
    try{const r=await debug.sendCommand('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:`function(){if(this.nodeType!==1||!this.isConnected)return null;const r=this.getBoundingClientRect(),s=getComputedStyle(this);return {tag:this.localName,html:this.outerHTML.slice(0,8000),styles:Object.fromEntries(Array.from(s).map(k=>[k,s.getPropertyValue(k)])),rect:{x:r.x,y:r.y,width:r.width,height:r.height}};}`,returnByValue:true});guard(token);if(!r.result.value)throw Error('元素已失效');selected=backendNodeId;known.add(backendNodeId);return {...r.result.value,token,node:backendNodeId,source:source||wc.getURL().slice(0,1000),editable:[...EDITABLE]};}
    finally{await debug.sendCommand('Runtime.releaseObject',{objectId:object.objectId}).catch(()=>{});}
  }
  async function tree(){await ready();const token=epoch;const {root}=await debug.sendCommand('DOM.getDocument',{depth:4,pierce:false});guard(token);let count=0;known.clear();
    function walk(n,depth=0){if(++count>300)return null;if(n.nodeType!==1)return (n.children||[]).flatMap(c=>walk(c,depth)||[]);known.add(n.backendNodeId);const a=n.attributes||[],id=a.indexOf('id'),cl=a.indexOf('class');return {node:n.backendNodeId,label:n.localName+(id>=0?'#'+a[id+1]:'')+(cl>=0?'.'+a[cl+1].split(/\s+/).slice(0,3).join('.'):''),expandable:n.childNodeCount>0,children:(n.children||[]).flatMap(c=>walk(c,depth+1)||[])};}
    return {token,nodes:walk(root),editable:[...EDITABLE]};
  }
  debug.on('message',async(_e,method,p)=>{if(method!=='Overlay.inspectNodeRequested'||!picking)return;picking=false;try{await debug.sendCommand('Overlay.setInspectMode',{mode:'none',highlightConfig:{}});const data=await snapshot(p.backendNodeId);const image=await wc.capturePage();send({kind:'selected',data,image:image.toDataURL()});}catch(error){send({kind:'error',error:error.message});}});
  return {
    async open(){const data=await tree();send({kind:'editor',data});return data;},
    async pick(){await ready();picking=true;await debug.sendCommand('Overlay.setInspectMode',{mode:'searchForNode',highlightConfig:{showInfo:true,contentColor:{r:40,g:190,b:140,a:0.25},borderColor:{r:40,g:160,b:110,a:1}}});wc.focus();return {selecting:true};},
    async action(p){
      if(p.command==='tree')return tree();
      if(p.command==='children'){guard(p.token);if(!known.has(p.node))throw Error('元素不属于本次检查');const {node}=await debug.sendCommand('DOM.describeNode',{backendNodeId:p.node,depth:1});const nodes=(node.children||[]).filter(n=>n.nodeType===1).slice(0,100).map(n=>{known.add(n.backendNodeId);return {node:n.backendNodeId,label:n.localName,children:[],expandable:n.childNodeCount>0};});return {token:epoch,nodes};}
      if(p.command==='cancel'){picking=false;if(debug.isAttached())await debug.sendCommand('Overlay.setInspectMode',{mode:'none',highlightConfig:{}});return null;}
      guard(p.token);if(!Number.isSafeInteger(p.node)||!known.has(p.node))throw Error('元素不属于本次检查');
      if(p.command==='select')return snapshot(p.node);
      if(p.command!=='style'||p.node!==selected||!EDITABLE.has(p.property)||typeof p.value!=='string'||p.value.length>200||/[;{}<>]|url\s*\(|expression\s*\(|@import/i.test(p.value))throw Error('不支持的样式修改');
      const token=epoch;const {object}=await debug.sendCommand('DOM.resolveNode',{backendNodeId:p.node});
      try{const r=await debug.sendCommand('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:`function(k,v){if(!this.isConnected)return false;if(v&&!CSS.supports(k,v))return false;if(v)this.style.setProperty(k,v);else this.style.removeProperty(k);return true;}`,arguments:[{value:p.property},{value:p.value}],returnByValue:true});guard(token);if(r.result.value!==true)throw Error('CSS值无效或元素已移除');return snapshot(p.node);}finally{await debug.sendCommand('Runtime.releaseObject',{objectId:object.objectId}).catch(()=>{});}
    },
  };
}
module.exports={createInspector};
