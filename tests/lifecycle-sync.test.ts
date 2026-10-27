import { afterEach, describe, expect, it, vi } from 'vitest';
import { LifecycleSync } from '../src/lifecycle-sync';
function deferred<T=void>() {
  let resolve!:(value:T|PromiseLike<T>)=>void;
  const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};
}
function setup(initialPending=false){
  let enabled=true;
  const hooks={enabled:()=>enabled,saveEditors:vi.fn(async()=>{}),run:vi.fn(async()=>true),persistPending:vi.fn<(value:boolean)=>void>(),onError:vi.fn()};
  return {hooks,scheduler:new LifecycleSync(hooks,initialPending),setEnabled:(value:boolean)=>{enabled=value;}};
}
afterEach(()=>vi.useRealTimers());
describe('startup and background sync',()=>{
  it('starts immediately after startup request, without a debounce timer',async()=>{
    vi.useFakeTimers();const {scheduler,hooks}=setup();
    await scheduler.request('startup');expect(hooks.saveEditors).toHaveBeenCalledTimes(1);expect(hooks.run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);expect(scheduler.hasPending).toBe(false);
  });
  it('saves editors before the network pass and persists pending work before either finishes',async()=>{
    const {scheduler,hooks}=setup();const gate=deferred();hooks.saveEditors.mockImplementation(()=>gate.promise);
    const task=scheduler.request('background');
    expect(hooks.persistPending).toHaveBeenCalledWith(true);expect(hooks.run).not.toHaveBeenCalled();
    await Promise.resolve();expect(hooks.saveEditors).toHaveBeenCalledOnce();expect(hooks.run).not.toHaveBeenCalled();
    gate.resolve();await task;expect(hooks.run).toHaveBeenCalledOnce();expect(hooks.persistPending).toHaveBeenLastCalledWith(false);
  });
  it('flushes a scheduled edit immediately when the app becomes hidden',async()=>{
    vi.useFakeTimers();const {scheduler,hooks}=setup();scheduler.noteChange();scheduler.schedule(1000);
    expect(hooks.run).not.toHaveBeenCalled();await scheduler.request('background');
    expect(hooks.run).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(2000);expect(hooks.run).toHaveBeenCalledTimes(1);
  });
  it('coalesces visibilitychange and pagehide before the scan starts',async()=>{
    const {scheduler,hooks}=setup();await Promise.all([scheduler.request('background'),scheduler.request('background')]);
    expect(hooks.run).toHaveBeenCalledTimes(1);
  });
  it('never overlaps runs and immediately sends edits made during an active pass',async()=>{
    vi.useFakeTimers();const {scheduler,hooks}=setup();const gate=deferred<boolean>();const started=deferred();let inFlight=0;let maximum=0;let calls=0;
    hooks.run.mockImplementation(async()=>{started.resolve();inFlight++;maximum=Math.max(maximum,inFlight);const result=++calls===1?await gate.promise:true;inFlight--;return result;});
    const task=scheduler.request('startup');await started.promise;
    expect(hooks.run).toHaveBeenCalledTimes(1);scheduler.noteChange();scheduler.schedule(1000);gate.resolve(true);
    await task;expect(hooks.run).toHaveBeenCalledTimes(2);expect(maximum).toBe(1);expect(vi.getTimerCount()).toBe(0);expect(scheduler.hasPending).toBe(false);
  });
  it('a hide/quit request waits for the current pass and its immediate follow-up',async()=>{
    const {scheduler,hooks}=setup();const first=deferred<boolean>();const second=deferred<boolean>();const started=deferred();
    hooks.run.mockImplementationOnce(()=>{started.resolve();return first.promise;}).mockImplementationOnce(()=>second.promise);
    const startup=scheduler.request('startup');await started.promise;
    let ended=false;const quit=scheduler.request('quit').then(()=>{ended=true;});
    first.resolve(true);await Promise.resolve();await Promise.resolve();await Promise.resolve();
    expect(ended).toBe(false);second.resolve(true);await Promise.all([startup,quit]);expect(ended).toBe(true);expect(hooks.run).toHaveBeenCalledTimes(2);
  });
  it('keeps pending work after a network failure and retries on the next foreground request',async()=>{
    const {scheduler,hooks}=setup(true);hooks.run.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await scheduler.request('background');expect(scheduler.hasPending).toBe(true);expect(hooks.persistPending).not.toHaveBeenCalledWith(false);
    await scheduler.request('resume');expect(scheduler.hasPending).toBe(false);expect(hooks.run).toHaveBeenCalledTimes(2);
  });
  it('persists editor-save failures and does not upload an older on-disk version',async()=>{
    const {scheduler,hooks}=setup();hooks.saveEditors.mockRejectedValueOnce(new Error('save failed'));
    await scheduler.request('background');expect(hooks.run).not.toHaveBeenCalled();expect(scheduler.hasPending).toBe(true);expect(hooks.onError).toHaveBeenCalledOnce();
  });
  it('honors disabled automatic sync while keeping manual sync available',async()=>{
    const {scheduler,hooks,setEnabled}=setup();setEnabled(false);scheduler.noteChange();
    await scheduler.request('startup');await scheduler.request('background');expect(hooks.run).not.toHaveBeenCalled();
    await scheduler.request('manual');expect(hooks.run).toHaveBeenCalledTimes(1);
  });
  it('does not start another network pass if the plugin unloads during editor saving',async()=>{
    const {scheduler,hooks}=setup();const gate=deferred();hooks.saveEditors.mockImplementation(()=>gate.promise);
    const task=scheduler.request('background');scheduler.dispose();gate.resolve();await task;expect(hooks.run).not.toHaveBeenCalled();expect(scheduler.hasPending).toBe(true);
  });
  it('does not lose pending work when disposed during an active run',async()=>{
    const {scheduler,hooks}=setup();const gate=deferred<boolean>();const started=deferred();hooks.run.mockImplementation(()=>{started.resolve();return gate.promise;});
    const task=scheduler.request('startup');await started.promise;scheduler.noteChange();scheduler.dispose();gate.resolve(true);await task;
    expect(scheduler.hasPending).toBe(true);expect(hooks.persistPending).not.toHaveBeenCalledWith(false);
  });
});
