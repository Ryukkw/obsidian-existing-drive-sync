export type SyncTrigger='startup'|'resume'|'change'|'background'|'quit'|'manual'|'poll';
export interface LifecycleHooks {
  enabled():boolean;
  saveEditors():Promise<void>;
  run():Promise<boolean>;
  persistPending(pending:boolean):void;
  onError(error:unknown):void;
}
/** One queue shared by startup, edits, background transitions and explicit runs. */
export class LifecycleSync {
  private active?:Promise<void>;
  private timer?:ReturnType<typeof setTimeout>;
  private queued=false;
  private forced=false;
  private disposed=false;
  private revision=0;
  private pending:boolean;
  constructor(private hooks:LifecycleHooks,initialPending=false){this.pending=initialPending;}
  get busy():boolean{return this.active!==undefined;}
  get hasPending():boolean{return this.pending;}
  noteChange():void {
    if(this.disposed)return;
    this.revision++;this.setPending(true);
  }
  private setPending(value:boolean):void {this.pending=value;this.hooks.persistPending(value);}
  schedule(delay=1000):void {
    if(this.disposed||!this.hooks.enabled())return;
    clearTimeout(this.timer);
    if(this.active){this.queued=true;return;}
    this.timer=setTimeout(()=>{this.timer=undefined;void this.request('change');},delay);
  }
  request(trigger:SyncTrigger):Promise<void> {
    if(this.disposed||(!this.hooks.enabled()&&trigger!=='manual'))return Promise.resolve();
    clearTimeout(this.timer);this.timer=undefined;
    this.queued=true;this.forced ||= trigger==='manual';
    // Persist before asynchronous editor saves / network requests: iOS can suspend immediately.
    this.setPending(true);
    if(!this.active)this.active=this.drain();
    return this.active;
  }
  private async drain():Promise<void> {
    try {
      while(this.queued&&!this.disposed){
        const forced=this.forced;this.queued=false;this.forced=false;
        if(!forced&&!this.hooks.enabled())return;
        // Always yield once before invoking hooks, so the active promise exists even on a synchronous error.
        await Promise.resolve().then(()=>this.hooks.saveEditors());
        if(this.disposed||(!forced&&!this.hooks.enabled()))return;
        // Events caused by saving editors are already included in the scan about to start.
        this.queued=false;this.forced=false;
        const revision=this.revision;
        const success=await this.hooks.run();
        if(this.disposed)return;
        if(!success){this.queued=false;return;}
        if(revision===this.revision&&!this.queued)this.setPending(false);
        // Edits during a run get an immediate second pass, including while hidden.
        // No timer is required, since mobile background timers may be suspended.
      }
    }catch(error){
      this.setPending(true);this.queued=false;
      if(!this.disposed)this.hooks.onError(error);
    }finally{this.active=undefined;}
  }
  dispose():void {this.disposed=true;clearTimeout(this.timer);this.timer=undefined;this.queued=false;}
}
