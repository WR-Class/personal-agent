/* Native, text-only implementation of the agent-states handoff. No HTML from models. */
(function (global) {
  'use strict';
  const LABEL={idle:'空闲',thinking:'思考中',running:'执行中',streaming:'正在输出',done:'完成',failed:'失败',stopped:'已停止'};
  const LIVE=new Set(['thinking','running','streaming']);
  const GLYPH={done:'✓',failed:'✕',stopped:'■',running:'',queued:''};
  function defaultOpen(step,turnState){
    if(step.status==='running')return true;
    if(step.status==='failed')return true;
    if(step.status==='stopped')return false;
    if(turnState==='failed')return false;
    return step.kind==='conclusion';
  }
  function el(tag,cls,text){const n=document.createElement(tag);n.className=cls;if(text!==undefined)n.textContent=text;return n;}
  class AgentTurn {
    constructor({mount,name='Personal Agent',historical=false}={}){
      this.root=el('section','agent-turn msg msg--agent');this.root.setAttribute('aria-label',name);
      this.body=el('div','agent-turn__body msg-body');this.head=el('header','agent-turn__head');
      const state=el('span','agent-turn__state');this.dot=el('i','agent-turn__dot');this.dot.setAttribute('aria-hidden','true');this.label=el('span','agent-turn__label');state.append(this.dot,this.label);state.setAttribute('role','status');
      this.head.append(el('span','agent-turn__name',name),state);this.body.append(this.head);
      this.root.append(el('span','agent-turn__avatar','P'),this.body);mount?.append(this.root);
      this.steps=[];this.started=historical?null:performance.now();this.elapsed=null;this.setState('idle');
    }
    setState(state,info={}){
      if(!Object.hasOwn(LABEL,state))throw Error('Unknown agent state');
      this.root.dataset.state=state;this.root.dataset.interruptible=String(LIVE.has(state));
      this.dot.hidden=state==='idle';
      if(!LIVE.has(state)&&state!=='idle'&&this.elapsed===null&&this.started!==null)this.elapsed=((performance.now()-this.started)/1000).toFixed(1)+'s';
      const bits=[LABEL[state]];
      if(!LIVE.has(state)&&state!=='idle')bits.push(this.elapsed??'耗时未记录',info.tokens??this.tokens??'用量未报告');
      if(info.tokens)this.tokens=info.tokens;
      if(info.note)bits.push(info.note);
      this.label.textContent=bits.join(' · ');this.refold();return this;
    }
    refold(){for(const c of this.steps)c.applyFold();}
    step({name='工具',kind='log',status='queued',thinking=false}={}){
      const turn=this,prefix=thinking?'agent-think':'agent-tool';
      const root=el('div',prefix+(thinking?' live-process':' tool-card')),button=el('button',prefix+'__head'),summary=el('span',thinking?'agent-think__name':'agent-tool__name',name),glyph=el('span','agent-tool__glyph'),time=el('span','agent-tool__time');
      button.type='button';button.append(el('i','agent-chevron'),summary,el('span','agent-tool__spacer'),glyph,time);
      const body=el('div',prefix+'__body');root.append(button,body);this.body.append(root);
      const step={kind,status,userSet:false};let began=performance.now(),userOpen,ended;
      const card={root,details:root,summary,body,button,step,name,
        applyFold(){const open=step.status==='running'||(step.userSet?userOpen:defaultOpen(step,turn.root.dataset.state));root.dataset.open=String(open);button.setAttribute('aria-expanded',String(open));},
        setOpen(value,byUser=false){if(byUser){step.userSet=true;userOpen=!!value;}card.applyFold();},
        update(next,label){if(next==='running'&&step.status!=='running'){began=performance.now();ended=undefined;}step.status=next;root.dataset.status=next;root.dataset.kind=kind;glyph.textContent=GLYPH[next]??'';if(label!==undefined)summary.textContent=label;
          if(['done','failed','stopped'].includes(next)&&ended===undefined)ended=performance.now();
          time.textContent=turn.started===null?'':(((ended??performance.now())-began)/1000).toFixed(1)+'s';card.applyFold();},
        append(text){body.append(el('pre','',String(text)));},
      };
      button.addEventListener('click',()=>{if(step.status!=='running')card.setOpen(root.dataset.open!=='true',true);});
      root.agentCard=card;this.steps.push(card);card.update(status);return card;
    }
    answer(text=''){
      const box=el('div','agent-answer'),content=el('div','agent-answer__text message-content',text);box.dataset.streaming='false';box.append(content);this.body.append(box);content.agentTurn=this;return content;
    }
    stream(content,text,active){content.textContent=text;const box=content.closest('.agent-answer');if(!box)return;box.dataset.streaming=String(active);if(active){const caret=el('i','agent-answer__caret');caret.setAttribute('aria-hidden','true');content.append(caret);}}
    alert(text,level='error'){if(!this.alertNode){this.alertNode=el('div','agent-alert');this.alertNode.setAttribute('role','status');this.body.append(this.alertNode);}this.alertNode.dataset.level=level;this.alertNode.textContent=text;}
    finish(state,info={}){
      for(const c of this.steps)if(['running','queued'].includes(c.step.status))c.update(state==='done'?'done':state==='idle'?'queued':state);
      for(const answer of this.root.querySelectorAll('.agent-answer'))answer.dataset.streaming='false';
      for(const caret of this.root.querySelectorAll('.agent-answer__caret'))caret.remove();
      this.setState(state,info);
    }
    actions(content){
      this.copyContent=content;if(this.actionsNode)return;const row=el('div','agent-actions');
      const copy=el('button','agent-act');copy.type='button';
      const label=text=>{copy.title=text;copy.setAttribute('aria-label',text);};label('复制答复');
      copy.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
      copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(this.copyContent.textContent);label('已复制');}catch{label('复制失败，请重试');}});
      row.append(copy);this.actionsNode=row;this.body.append(row);
    }
  }
  global.AgentTurn=AgentTurn;global.AgentTurnPolicy={defaultOpen,LABEL,LIVE,GLYPH};
})(window);
