import { describe, expect, it } from 'vitest';
import { progressDetails, progressPercent, progressTitle, SyncProgress } from '../src/progress';
import { synchronize } from '../src/engine';
import type { Counts, LocalStore, RemoteStore, SyncState } from '../src/engine';
import { hash } from '../src/model';
const zero:Counts={uploaded:0,downloaded:0,conflicts:0,deleted:0};
const bytes=new TextEncoder().encode('note').buffer as ArrayBuffer;
const file={id:'file',hash:hash(bytes),etag:'etag'};
function stores(){
  const local:LocalStore={scan:async()=>({'a.md':file}),read:async()=>bytes,write:async()=>{},remove:async()=>{},backup:async()=>{}};
  const remote:RemoteStore={scan:async()=>({}),read:async()=>bytes,write:async()=>file,remove:async()=>{}};
  const state:SyncState={rootId:'root',base:Object.create(null)};
  return {local,remote,state};
}
describe('progress tracking',()=>{
  it('does not invent a percentage while discovering files',()=>{
    const progress=new SyncProgress();const report=progress.begin();
    report({kind:'scan',source:'local',completed:7,path:'local.md'});
    report({kind:'scan',source:'remote',completed:12,path:'remote.md'});
    expect(progressPercent(progress.snapshot())).toBeUndefined();
    expect(progress.snapshot()).toMatchObject({phase:'scanning',localScanned:7,remoteScanned:12});
    expect(progressDetails(progress.snapshot())).toContain('на устройстве 7, в Google Drive 12');
  });
  it('uses checkpointed files, rather than the number of started operations, for its percentage',()=>{
    const progress=new SyncProgress();const report=progress.begin();
    report({kind:'plan',total:4});
    report({kind:'file',path:'a.md',action:'download',completed:1,total:4,counts:{...zero,downloaded:1}});
    expect(progressPercent(progress.snapshot())).toBe(25);
    expect(progressTitle(progress.snapshot())).toBe('Обработано 1 из 4 файлов');
    expect(progressDetails(progress.snapshot())).toBe('Скачиваем на устройство');
  });
  it('retains partial completion, current path and counters on failure',()=>{
    const progress=new SyncProgress();const report=progress.begin();
    report({kind:'file',path:'b.md',action:'upload',completed:1,total:2,counts:{...zero,uploaded:1}});
    progress.fail('offline');
    expect(progress.snapshot()).toMatchObject({phase:'error',completed:1,total:2,path:'b.md',counts:{uploaded:1},error:'offline'});
    expect(progressPercent(progress.snapshot())).toBe(50);
    expect(progressDetails(progress.snapshot())).toBe('offline');
    report({kind:'scan',source:'remote',completed:999});
    expect(progress.snapshot().phase).toBe('error');
  });
  it('ignores late scan notifications from a previous run',()=>{
    const progress=new SyncProgress();const old=progress.begin();progress.fail('offline');
    const next=progress.begin();next({kind:'plan',total:10});
    old({kind:'scan',source:'remote',completed:999});
    expect(progress.snapshot()).toMatchObject({phase:'syncing',total:10,remoteScanned:0});
  });
  it('ignores a late terminal error or completion from a superseded run',()=>{
    const progress=new SyncProgress();const old=progress.begin();const current=progress.begin();
    current({kind:'plan',total:3});
    progress.fail('stale error',old.runId);progress.finish(zero,old.runId);
    expect(progress.snapshot()).toMatchObject({phase:'syncing',total:3,runId:current.runId});
    expect(progress.snapshot().error).toBeUndefined();
  });
  it('does not keep reporting a previous error during a fresh run',()=>{
    const progress=new SyncProgress();progress.begin();progress.fail('network');
    const current=progress.begin();current({kind:'scan',source:'remote',completed:2});
    expect(progressTitle(progress.snapshot())).toContain('Проверяем');
    expect(progress.snapshot().error).toBeUndefined();
  });
  it('invalidates an unloaded plugin session before its outstanding requests finish',()=>{
    const progress=new SyncProgress();const report=progress.begin();progress.dispose();
    report({kind:'plan',total:999});progress.fail('late',report.runId);progress.finish(zero,report.runId);
    expect(progress.snapshot().phase).toBe('preparing');
    expect(progress.snapshot().error).toBeUndefined();
  });
  it('allows a successful empty vault without division by zero',()=>{
    const progress=new SyncProgress();const report=progress.begin();report({kind:'plan',total:0});
    expect(progressPercent(progress.snapshot())).toBeUndefined();progress.finish(zero);
    expect(progressPercent(progress.snapshot())).toBe(100);expect(progress.snapshot().completed).toBe(0);
    expect(progressDetails(progress.snapshot())).not.toContain('NaN');
  });
  it('detaches subscribers and keeps observer failures out of the sync engine',()=>{
    const progress=new SyncProgress();let calls=0;
    const unsubscribe=progress.subscribe(()=>calls++);
    progress.subscribe(()=>{throw new Error('closed view');});
    const report=progress.begin();unsubscribe();const old=calls;
    expect(()=>report({kind:'plan',total:1})).not.toThrow();expect(calls).toBe(old);
  });
  it('returns snapshots without exposing mutable counters to UI code',()=>{
    const progress=new SyncProgress();progress.subscribe(value=>{value.counts.uploaded=999;});
    progress.begin();expect(progress.snapshot().counts.uploaded).toBe(0);
  });
});
describe('progress from the actual sync engine',()=>{
  it('advances only after the file checkpoint is saved and finishes after the final save',async()=>{
    const {local,remote,state}=stores();const progress=new SyncProgress();const report=progress.begin();
    let release!:()=>void;let checkpointReached!:()=>void;let saves=0;
    const reached=new Promise<void>(resolve=>checkpointReached=resolve);
    const gate=new Promise<void>(resolve=>release=resolve);
    const run=synchronize(local,remote,state,async()=>{if(++saves===1){checkpointReached();await gate;}},report);
    await reached;
    expect(progress.snapshot()).toMatchObject({phase:'syncing',completed:0,total:1});
    expect(progressPercent(progress.snapshot())).toBe(0);
    release();const counts=await run;
    expect(saves).toBe(2);expect(progress.snapshot().phase).toBe('syncing');
    progress.finish(counts);
    expect(progress.snapshot()).toMatchObject({phase:'done',completed:1,total:1,counts:{uploaded:1}});
  });
  it('does not mark a failed checkpoint as processed',async()=>{
    const {local,remote,state}=stores();const progress=new SyncProgress();const report=progress.begin();
    await expect(synchronize(local,remote,state,async()=>{throw new Error('disk full');},report)).rejects.toThrow('disk full');
    progress.fail('disk full');expect(progress.snapshot()).toMatchObject({phase:'error',completed:0,total:1});
  });
  it('waits for the other scanner to settle before returning an error',async()=>{
    const {local,remote,state}=stores();let release!:()=>void;let started!:()=>void;
    const pending=new Promise<void>(resolve=>release=resolve);const ready=new Promise<void>(resolve=>started=resolve);
    local.scan=async()=>{throw new Error('local error');};
    remote.scan=async()=>{started();await pending;return {};};
    let finished=false;
    const run=synchronize(local,remote,state,async()=>{}).catch(error=>{finished=true;throw error;});
    await ready;await Promise.resolve();expect(finished).toBe(false);
    release();await expect(run).rejects.toThrow('local error');
  });
  it('cancels an old download on plugin unload before it can replace a local file',async()=>{
    const {local,remote,state}=stores();const controller=new AbortController();let writes=0;
    local.scan=async()=>({});remote.scan=async()=>({'a.md':file});
    remote.read=async()=>{controller.abort();return bytes;};local.write=async()=>{writes++;};
    await expect(synchronize(local,remote,state,async()=>{},()=>{},controller.signal)).rejects.toThrow('выгрузке');
    expect(writes).toBe(0);expect(state.base['a.md']).toBeUndefined();
  });
  it('reports a failed scan with no manufactured transfer plan',async()=>{
    const {local,remote,state}=stores();const progress=new SyncProgress();const report=progress.begin();
    remote.scan=async report=>{report?.(3,'cloud.md');throw new Error('403');};
    await expect(synchronize(local,remote,state,async()=>{},report)).rejects.toThrow('403');
    progress.fail('403');expect(progress.snapshot()).toMatchObject({phase:'error',remoteScanned:3,completed:0});
    expect(progress.snapshot().total).toBeUndefined();
  });
});
