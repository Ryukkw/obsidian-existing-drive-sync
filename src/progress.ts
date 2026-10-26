import type { Action } from './model';
import type { Counts } from './engine';
export type ProgressEvent =
  | {kind:'scan'; source:'local'|'remote'; completed:number; path?:string}
  | {kind:'plan'; total:number}
  | {kind:'file'; path:string; action:Action; completed:number; total:number; counts:Counts};
export interface ProgressSnapshot {
  phase:'idle'|'preparing'|'scanning'|'syncing'|'done'|'error';
  completed:number;
  total?:number;
  localScanned:number;
  remoteScanned:number;
  path?:string;
  action?:Action;
  counts:Counts;
  startedAt?:number;
  finishedAt?:number;
  error?:string;
}
const emptyCounts = (): Counts => ({uploaded:0,downloaded:0,conflicts:0,deleted:0});
const initial = (): ProgressSnapshot => ({phase:'idle',completed:0,localScanned:0,remoteScanned:0,counts:emptyCounts()});
export class SyncProgress {
  private state = initial();
  private listeners = new Set<(state:ProgressSnapshot)=>void>();
  private generation = 0;
  snapshot(): ProgressSnapshot {return {...this.state,counts:{...this.state.counts}};}
  subscribe(listener:(state:ProgressSnapshot)=>void):()=>void {
    this.listeners.add(listener);this.notify(listener);
    return ()=>{this.listeners.delete(listener);};
  }
  private notify(listener:(state:ProgressSnapshot)=>void):void {
    // Rendering must not interrupt file transfers or checkpoint saves.
    try {listener(this.snapshot());} catch { /* The next update can redraw a surviving view. */ }
  }
  private emit():void {for(const listener of this.listeners)this.notify(listener);}
  begin():(event:ProgressEvent)=>void {
    const generation=++this.generation;
    this.state={...initial(),phase:'preparing',startedAt:Date.now()};this.emit();
    return event=>{
      if(generation!==this.generation || this.state.phase==='error' || this.state.phase==='done')return;
      if(event.kind==='scan'){
        this.state.phase='scanning';
        this.state[event.source==='local'?'localScanned':'remoteScanned']=event.completed;
        this.state.path=event.path;
      }else if(event.kind==='plan'){
        this.state.phase='syncing';this.state.total=event.total;this.state.completed=0;this.state.path=undefined;this.state.action=undefined;
      }else{
        this.state.phase='syncing';this.state.path=event.path;this.state.action=event.action;
        this.state.completed=event.completed;this.state.total=event.total;this.state.counts={...event.counts};
      }
      this.emit();
    };
  }
  finish(counts:Counts):void {
    this.state={...this.state,phase:'done',completed:this.state.total??0,counts:{...counts},path:undefined,action:undefined,finishedAt:Date.now()};this.emit();
  }
  fail(message:string):void {this.state={...this.state,phase:'error',error:message,finishedAt:Date.now()};this.emit();}
}
export function progressTitle(state:ProgressSnapshot):string {
  switch(state.phase){
    case 'idle':return 'Синхронизация ещё не запускалась';
    case 'preparing':return 'Подключение к Google Drive…';
    case 'scanning':return 'Проверяем файлы на устройстве и в Google Drive…';
    case 'syncing':return `Обработано ${state.completed} из ${state.total??0} файлов`;
    case 'done':return 'Синхронизация завершена';
    case 'error':return 'Синхронизация остановлена';
  }
}
export function progressPercent(state:ProgressSnapshot):number|undefined {
  if(state.phase==='done')return 100;
  if((state.phase!=='syncing'&&state.phase!=='error')||!state.total)return undefined;
  return Math.min(100,Math.max(0,Math.floor(state.completed/state.total*100)));
}
export function progressDetails(state:ProgressSnapshot):string {
  if(state.phase==='idle')return 'Нажмите «Синхронизировать», чтобы проверить заметки.';
  if(state.phase==='preparing')return 'Подготовка подключения и состояния синхронизации.';
  if(state.phase==='scanning')return `Найдено файлов: на устройстве ${state.localScanned}, в Google Drive ${state.remoteScanned}. Общее число уточняется.`;
  if(state.phase==='error')return state.error??'Не удалось завершить синхронизацию.';
  if(state.phase==='done')return `Обработано ${state.completed} файлов. Завершено в ${new Date(state.finishedAt!).toLocaleTimeString()}.`;
  const labels:Record<Action,string>={equal:'Проверяем файл',forget:'Сверяем удаление',upload:'Отправляем в Google Drive',download:'Скачиваем на устройство',conflict:'Сохраняем обе версии', 'delete-local':'Переносим удаление на устройство','delete-remote':'Переносим удаление в Google Drive'};
  return state.action?labels[state.action]:(state.total?'Начинаем обработку файлов…':'Изменений для передачи нет.');
}
