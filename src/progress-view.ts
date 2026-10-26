import { App, Modal } from 'obsidian';
import { progressDetails, progressPercent, progressTitle, SyncProgress } from './progress';
import type { ProgressSnapshot } from './progress';
export class ProgressView {
  readonly el:HTMLElement;
  private title:HTMLElement;
  private detail:HTMLElement;
  private bar:HTMLProgressElement;
  private counter:HTMLElement;
  private path:HTMLElement;
  private stats:HTMLElement;
  constructor(parent:HTMLElement){
    this.el=document.createElement('section');this.el.className='existing-drive-sync-progress';parent.appendChild(this.el);
    this.el.setAttribute('aria-label','Ход синхронизации Google Drive');
    this.title=this.el.appendChild(document.createElement('strong'));
    this.title.setAttribute('role','status');this.title.setAttribute('aria-live','polite');
    this.detail=this.el.appendChild(document.createElement('p'));
    this.bar=this.el.appendChild(document.createElement('progress'));this.bar.max=100;
    this.bar.setAttribute('aria-label','Обработано файлов');
    this.counter=this.el.appendChild(document.createElement('div'));
    this.path=this.el.appendChild(document.createElement('div'));this.path.className='existing-drive-sync-path';
    this.stats=this.el.appendChild(document.createElement('p'));this.stats.className='existing-drive-sync-stats';
  }
  update(state:ProgressSnapshot):void {
    this.el.dataset.phase=state.phase;
    this.el.setAttribute('aria-busy',String(['preparing','scanning','syncing'].includes(state.phase)));
    this.title.textContent=progressTitle(state);this.detail.textContent=progressDetails(state);
    const percent=progressPercent(state);
    this.bar.hidden=state.phase==='idle'||state.phase==='error';
    if(percent===undefined){this.bar.removeAttribute('value');this.bar.removeAttribute('aria-valuetext');}
    else{this.bar.value=percent;this.bar.setAttribute('aria-valuetext',`${state.completed} из ${state.total??0} файлов, ${percent}%`);}
    this.counter.textContent=percent===undefined?'':`${state.completed} / ${state.total??0} · ${percent}%`;
    this.path.textContent=state.path??'';this.path.hidden=!state.path;
    const c=state.counts;
    this.stats.textContent=`Отправлено: ${c.uploaded} · Загружено: ${c.downloaded} · Конфликтов: ${c.conflicts} · Удалений: ${c.deleted}`;
    this.stats.hidden=state.phase==='idle'||state.phase==='preparing'||state.phase==='scanning';
  }
}
export class ProgressModal extends Modal {
  private unsubscribe?:()=>void;
  private visible=false;
  show():void {if(!this.visible)this.open();}
  constructor(app:App,private progress:SyncProgress){super(app);}
  onOpen():void {
    this.visible=true;this.setTitle('Синхронизация Google Drive');
    const view=new ProgressView(this.contentEl);
    this.unsubscribe=this.progress.subscribe(state=>view.update(state));
    this.contentEl.createEl('p',{text:'Можно закрыть это окно и продолжить работу. Для синхронизации оставьте Obsidian открытым.'});
  }
  onClose():void {this.visible=false;this.unsubscribe?.();this.unsubscribe=undefined;this.contentEl.empty();}
}
