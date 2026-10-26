import { progressDetails, progressPercent } from './progress';
import type { ProgressSnapshot, SyncProgress } from './progress';
export class ProgressBanner {
  readonly el:HTMLElement;
  private button:HTMLButtonElement;
  private icon:HTMLElement;
  private title:HTMLElement;
  private counter:HTMLElement;
  private detail:HTMLElement;
  private bar:HTMLProgressElement;
  private unsubscribe:()=>void;
  private timer?:ReturnType<typeof setTimeout>;
  private runId=-1;
  private dismissed=false;
  private latest?:ProgressSnapshot;
  constructor(parent:HTMLElement,progress:SyncProgress,onOpen:()=>void){
    const doc=parent.ownerDocument;
    this.el=doc.createElement('aside');this.el.className='existing-drive-sync-banner';this.el.hidden=true;
    this.el.setAttribute('aria-label','Синхронизация Google Drive');parent.appendChild(this.el);
    this.button=this.el.appendChild(doc.createElement('button'));this.button.type='button';this.button.className='existing-drive-sync-banner-main';
    this.button.setAttribute('aria-label','Показать подробности синхронизации');this.button.addEventListener('click',onOpen);
    this.icon=this.button.appendChild(doc.createElement('span'));this.icon.className='existing-drive-sync-banner-icon';this.icon.setAttribute('aria-hidden','true');
    const content=this.button.appendChild(doc.createElement('span'));content.className='existing-drive-sync-banner-content';
    const heading=content.appendChild(doc.createElement('span'));heading.className='existing-drive-sync-banner-heading';
    this.title=heading.appendChild(doc.createElement('span'));this.title.className='existing-drive-sync-banner-title';this.title.setAttribute('role','status');this.title.setAttribute('aria-live','polite');
    this.counter=heading.appendChild(doc.createElement('span'));this.counter.className='existing-drive-sync-banner-counter';
    this.detail=content.appendChild(doc.createElement('span'));this.detail.className='existing-drive-sync-banner-detail';
    this.bar=content.appendChild(doc.createElement('progress'));this.bar.max=100;this.bar.setAttribute('aria-label','Прогресс синхронизации');
    const close=this.el.appendChild(doc.createElement('button'));close.type='button';close.className='existing-drive-sync-banner-close';close.textContent='×';close.setAttribute('aria-label','Скрыть панель синхронизации');
    close.addEventListener('click',()=>{this.dismissed=true;this.el.hidden=true;});
    this.unsubscribe=progress.subscribe(state=>this.update(state));
  }
  reveal():void {this.dismissed=false;if(this.latest)this.update(this.latest);}
  destroy():void {this.unsubscribe();clearTimeout(this.timer);this.el.remove();}
  private update(state:ProgressSnapshot):void {
    this.latest=state;
    if(state.runId!==this.runId){this.runId=state.runId;this.dismissed=false;}
    clearTimeout(this.timer);
    const running=['preparing','scanning','syncing'].includes(state.phase);
    this.el.dataset.phase=state.phase;this.el.setAttribute('aria-busy',String(running));
    this.el.hidden=state.phase==='idle'||this.dismissed;
    this.icon.textContent=running?'':state.phase==='done'?'✓':'!';
    const percent=progressPercent(state);
    const c=state.counts;
    if(state.phase==='preparing'){this.title.textContent='Google Drive';this.detail.textContent='Подключение…';}
    else if(state.phase==='scanning'){this.title.textContent='Проверяем файлы';this.detail.textContent=`На устройстве: ${state.localScanned} · Drive: ${state.remoteScanned}`;}
    else if(state.phase==='syncing'){this.title.textContent=`Google Drive${percent===undefined?'':` · ${percent}%`}`;this.detail.textContent=state.path?`${progressDetails(state)} · ${state.path}`:'Проверяем изменения…';}
    else if(state.phase==='done'){this.title.textContent='Синхронизировано';this.detail.textContent=`Загружено ${c.downloaded} · Отправлено ${c.uploaded}${c.conflicts?` · Конфликтов ${c.conflicts}`:''}`;}
    else{this.title.textContent='Ошибка последнего запуска';this.detail.textContent=state.error??'Нажмите, чтобы посмотреть подробности.';}
    this.detail.title=this.detail.textContent??'';
    this.counter.textContent=state.total===undefined?'':`${state.completed}/${state.total}`;
    this.bar.hidden=!running;
    if(percent===undefined)this.bar.removeAttribute('value');else this.bar.value=percent;
    if(state.phase==='done')this.timer=setTimeout(()=>{this.el.hidden=true;},5000);
  }
}
