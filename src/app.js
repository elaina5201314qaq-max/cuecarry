'use strict';
(() => {
  const core = window.CueCarry;
  const slots = ['base', 'corrected', 'current'];
  const names = {base:'',corrected:'',current:''};
  const labels = {ready:'可直接迁移','already-applied':'新稿已有',conflict:'需要确认','not-found':'未定位'};
  const tickets = {base:0,corrected:0,current:0};
  const $ = (id) => document.getElementById(id);
  let plan = null, decisions = {}, filter = 'all', finalResult = null, page = 0;
  const pageSize = 12;
  const element = (tag, className, text) => {const el=document.createElement(tag); if(className)el.className=className; if(text!==undefined)el.textContent=text; return el;};
  function showError(message) {$('error').textContent=message; $('error').hidden=false; $('error').focus();}
  function invalidate() {
    plan=null; decisions={}; finalResult=null; $('review').hidden=true; $('empty-state').hidden=false;
    $('error').hidden=true; $('notice').hidden=true; $('preview').value='';
    $('download-srt').disabled=true; $('download-audit').disabled=true;
  }
  function reset() {slots.forEach(slot=>{tickets[slot]++;$('text-'+slot).value='';$('file-'+slot).value='';$('name-'+slot).textContent='未选择文件';names[slot]='';}); invalidate();}
  async function loadFile(slot,file) {
    if(!file)return;
    const ticket=++tickets[slot]; invalidate();
    $('text-'+slot).value=''; names[slot]=''; $('name-'+slot).textContent='等待有效的 UTF-8 SRT';
    if(file.size>5*1024*1024){showError('文件超过 5 MB。请拆分较大的字幕文件后再试。');return;}
    try {
      const data=await file.arrayBuffer();
      const value=new TextDecoder('utf-8',{fatal:true}).decode(data);
      if(ticket!==tickets[slot])return;
      $('text-'+slot).value=value; names[slot]=file.name; $('name-'+slot).textContent=file.name;
    } catch {if(ticket===tickets[slot])showError('无法读取文件。请确认它是 UTF-8 编码的 SRT；其他编码请先另存为 UTF-8。');}
  }
  slots.forEach(slot=>{
    $('file-'+slot).addEventListener('change',e=>loadFile(slot,e.target.files[0]));
    $('text-'+slot).addEventListener('input',()=>{tickets[slot]++;names[slot]='粘贴的字幕';$('name-'+slot).textContent='已粘贴内容';invalidate();});
    const zone=document.querySelector(`[data-slot="${slot}"] .drop-zone`);
    zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('dragging');});
    zone.addEventListener('dragleave',()=>zone.classList.remove('dragging'));
    zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('dragging');loadFile(slot,e.dataTransfer.files[0]);});
  });
  $('reset').addEventListener('click',reset);
  $('demo').addEventListener('click',()=>{
    reset(); slots.forEach(slot=>{$('text-'+slot).value=window.CueCarryDemo[slot];names[slot]='示例-'+slot+'.srt';$('name-'+slot).textContent=names[slot];});
    analyze(); $('notice').textContent='示例已载入：包含明确修订、重复短句、改写文字和未定位条目。请审阅后再导出。';$('notice').hidden=false;
  });
  function analyze() {
    invalidate();
    if(!core){showError('核心文件未加载。请确保 index.html 与 src 文件夹位于同一目录。');return;}
    try {
      const parsed={};
      slots.forEach((slot,i)=>{
        const text=$('text-'+slot).value;
        if(!text.trim())throw new Error(`请先导入 ${['A 旧识别稿','B 旧校对稿','C 新识别稿'][i]}。`);
        if(text.length>5*1024*1024)throw new Error('粘贴内容过大，请拆分后再试。');
        try {parsed[slot]=core.parseSrt(text);} catch(e){throw new Error(`${['A 旧识别稿','B 旧校对稿','C 新识别稿'][i]}：${e.message}`);}
        if(parsed[slot].length>5000)throw new Error('每份字幕最多支持 5000 条，请拆分后再试。');
      });
      plan=core.buildPlan(parsed.base,parsed.corrected,parsed.current); filter='all'; page=0;
      $('empty-state').hidden=true; $('review').hidden=false; render();
    } catch(e){showError(e.message);}
  }
  $('analyze').addEventListener('click',analyze);
  document.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{filter=button.dataset.filter;page=0;renderChanges();}));
  function unresolved() {return plan.changes.filter(c=>['conflict','not-found'].includes(c.status)&&!decisions[c.id]).length;}
  function setDecision(id,decision){decisions[id]=decision;render();}
  function actionButton(text,selected,handler){const b=element('button','button secondary'+(selected?' selected':''),text);b.type='button';b.setAttribute('aria-pressed',String(selected));b.addEventListener('click',handler);return b;}
  function render() {
    const counts={ready:0,conflict:0,'not-found':0,'already-applied':0};plan.changes.forEach(c=>counts[c.status]++);
    $('stats').replaceChildren(...Object.entries(counts).map(([key,count])=>{const card=element('div','stat '+(['conflict','not-found'].includes(key)?'attention':key==='already-applied'?'neutral':''));card.append(element('strong','',String(count)),element('span','',labels[key]));return card;}));
    const pending=unresolved();$('progress').textContent=`${plan.changes.length} 处修订 · ${pending} 处待确认`;
    renderChanges(); renderExport(pending);
  }
  function renderChanges() {
    if(!plan)return;
    document.querySelectorAll('[data-filter]').forEach(b=>{b.classList.toggle('active',b.dataset.filter===filter);b.setAttribute('aria-pressed',String(b.dataset.filter===filter));});
    const changes=plan.changes.filter(c=>filter==='all'||(filter==='attention'?['conflict','not-found'].includes(c.status):c.status===filter));
    $('changes').replaceChildren();
    if(!changes.length){$('changes').append(element('div','no-changes',plan.changes.length?'这个分类下没有修订。':'A 和 B 没有文字修改，可以直接导出 C。'));return;}
    page=Math.min(page,Math.max(0,Math.ceil(changes.length/pageSize)-1));
    for(const change of changes.slice(page*pageSize,(page+1)*pageSize)){
      const card=element('article','change');card.dataset.change=change.id;
      const top=element('div','change-top');top.append(element('span','muted',`旧稿第 ${change.oldIndex+1} 条`),element('span','badge '+change.status,labels[change.status]));
      card.append(top,element('p','change-reason',change.reason));
      const pair=element('div','text-pair');
      [['before','旧识别',change.before],['after','人工校对',change.after]].forEach(([cls,title,text])=>{const block=element('div','text-block '+cls);block.append(element('small','',title),element('p','cue-text',text));pair.append(block);});card.append(pair);
      const decision=decisions[change.id];
      if(Number.isInteger(change.targetIndex)){const cue=plan.current[change.targetIndex];card.append(element('p','destination',`对应新稿 #${cue.id} · ${cue.timingLine}\n${cue.text}`));}
      if(change.status==='ready'){
        const row=element('div','decision-row');row.append(actionButton('迁移这处校对',!decision||decision.action==='apply',()=>setDecision(change.id,{action:'apply'})),actionButton('保留新稿文字',decision?.action==='keep',()=>setDecision(change.id,{action:'keep'})));card.append(row);
      } else if(change.status!=='already-applied') {
        const label=element('label','target-picker','如果已确认对应关系，可以选择一条新稿字幕：');
        const select=element('select');select.setAttribute('aria-label',`旧稿第 ${change.oldIndex+1} 条的目标字幕`);
        const option=element('option','', '选择目标条目（相似候选不会自动应用）');option.value='';select.append(option);
        const candidateSet=new Set(change.candidates.map(c=>c.index));
        plan.current.forEach((cue,index)=>{const opt=element('option','',`${candidateSet.has(index)?'候选 · ':''}#${cue.id}  ${cue.text.replace(/\s+/g,' ').slice(0,72)}`);opt.value=String(index);select.append(opt);});
        if(decision?.action==='apply')select.value=String(decision.targetIndex);
        label.append(select);card.append(label);
        const row=element('div','decision-row');
        const apply=actionButton('将校对迁移到此条',decision?.action==='apply',()=>{if(select.value==='')return;setDecision(change.id,{action:'apply',targetIndex:Number(select.value)});});
        apply.disabled=select.value==='';select.addEventListener('change',()=>{
          apply.disabled=select.value==='';
          if(decisions[change.id]){
            delete decisions[change.id];
            row.querySelectorAll('[aria-pressed]').forEach(b=>{b.classList.remove('selected');b.setAttribute('aria-pressed','false');});
            const caption=card.querySelector('.decision-caption');if(caption)caption.textContent='目标已变化，请重新确认。';
            const pending=unresolved();$('progress').textContent=`${plan.changes.length} 处修订 · ${pending} 处待确认`;renderExport(pending);
          }
        });
        row.append(actionButton('不迁移，保留新稿',decision?.action==='keep',()=>setDecision(change.id,{action:'keep'})),apply);
        if(decision){const undo=element('button','button quiet','重新考虑');undo.addEventListener('click',()=>{delete decisions[change.id];render();});row.append(undo);}
        card.append(row);if(decision)card.append(element('p','decision-caption',decision.action==='keep'?'已确认：保留新稿，不添加旧句。':'已确认：将校对文字应用到所选条目。'));
      }
      $('changes').append(card);
    }
    if(changes.length>pageSize){
      const nav=element('nav','pagebar');nav.setAttribute('aria-label','修订分页');
      const previous=element('button','button secondary','上一页');previous.disabled=page===0;previous.addEventListener('click',()=>{page--;renderChanges();});
      const next=element('button','button secondary','下一页');next.disabled=(page+1)*pageSize>=changes.length;next.addEventListener('click',()=>{page++;renderChanges();});
      nav.append(previous,element('span','muted',`第 ${page+1} / ${Math.ceil(changes.length/pageSize)} 页`),next);$('changes').append(nav);
    }
  }
  function renderExport(pending) {
    finalResult=null;$('download-srt').disabled=true;$('download-audit').disabled=true;
    const status=$('export-status');status.classList.remove('good');
    try {
      const previewDecisions={...decisions};
      for(const c of plan.changes)if(['conflict','not-found'].includes(c.status)&&!previewDecisions[c.id])previewDecisions[c.id]={action:'keep'};
      const draft=core.applyDecisions(plan,previewDecisions);
      $('preview').value=core.serializeSrt(draft.cues);$('preview-state').textContent=pending?'（待审阅草稿）':'';
      if(pending){status.textContent=`还有 ${pending} 处修订需要确认。预览暂时保留这些位置的新稿文字，完成审阅后可导出。`;return;}
      finalResult=core.applyDecisions(plan,decisions);status.textContent='全部修订已处理，新时间轴已保留。';status.classList.add('good');$('download-srt').disabled=false;$('download-audit').disabled=false;
    } catch(e){$('preview').value='';status.textContent=e.message;}
  }
  function download(content,name,type) {const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  $('download-srt').addEventListener('click',()=>{if(!finalResult)return;const stem=(names.current||'subtitles').replace(/\.srt$/i,'').replace(/[\\/:*?"<>|]/g,'_');download(core.serializeSrt(finalResult.cues),stem+'-cuecarry.srt','application/x-subrip;charset=utf-8');});
  $('download-audit').addEventListener('click',()=>{if(!finalResult)return;download(JSON.stringify({schemaVersion:1,app:'CueCarry 0.1.0',createdAt:new Date().toISOString(),inputNames:{...names},currentCueCount:plan.current.length,changes:finalResult.audit},null,2)+'\n','cuecarry-migration.json','application/json;charset=utf-8');});
})();
