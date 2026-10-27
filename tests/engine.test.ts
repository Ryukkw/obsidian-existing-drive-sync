import { describe, expect, it } from 'vitest';
import { decide, excluded, FileInfo, hash, Index, validateIndex, validPath } from '../src/model';
import { LocalStore, RemoteStore, synchronize, SyncState } from '../src/engine';
const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const info = (s: string,id='id'): FileInfo=>({hash:hash(bytes(s)),id,etag:s});
function fixture(localData: Record<string,string>,remoteData: Record<string,string>,base: Record<string,string>={}) {
  const local = new Map(Object.entries(localData).map(([p,s])=>[p,bytes(s)]));
  const remote = new Map(Object.entries(remoteData).map(([p,s])=>[p,bytes(s)]));
  const backups: string[]=[]; const trashed: string[]=[];
  const state: SyncState={rootId:'root',base:Object.fromEntries(Object.entries(base).map(([p,s])=>[p,{hash:hash(bytes(s)),id:p}]))};
  const scan=(data:Map<string,ArrayBuffer>):Index=>Object.fromEntries([...data].map(([p,b])=>[p,{hash:hash(b),id:p,etag:hash(b)}]));
  const l:LocalStore={scan:async()=>scan(local),read:async p=>local.get(p)!,
    write:async(p,data,expected)=>{
      if(expected===undefined ? local.has(p) : !local.has(p)||hash(local.get(p)!)!==expected) throw new Error('local race');
      local.set(p,data);
    },remove:async(p,expected)=>{if(hash(local.get(p)!)!==expected)throw new Error('local race');local.delete(p);},backup:async p=>{backups.push(p);}};
  const r:RemoteStore={scan:async()=>scan(remote),read:async f=>remote.get(f.id!)!,
    write:async(p,data,previous)=>{
      if(previous && hash(remote.get(p)!)!==previous.hash)throw new Error('remote race');
      if(!previous&&remote.has(p))throw new Error('remote race');
      remote.set(p,data);return scan(remote)[p];
    },remove:async f=>{if(hash(remote.get(f.id!)!)!==f.hash)throw new Error('remote race');trashed.push(f.id!);remote.delete(f.id!);}};
  let saves=0;
  return {local,remote,state,l,r,backups,trashed,run:()=>synchronize(l,r,state,async()=>{saves++;}),saves:()=>saves};
}
describe('three-way decisions',()=>{
  it.each([
    ['equal','a','a',undefined],['conflict','a','b',undefined],['download','a','b','a'],
    ['upload','b','a','a'],['conflict','b','c','a'],['upload','a',undefined,undefined],
    ['download',undefined,'a',undefined],['delete-local','a',undefined,'a'],
    ['delete-remote',undefined,'a','a'],['upload','b',undefined,'a'],
    ['download',undefined,'b','a'],['forget',undefined,undefined,'a'],
  ])('%s (local=%s remote=%s base=%s)',(action,l,r,b)=>{
    expect(decide(l?info(l):undefined,r?info(r):undefined,b?{hash:info(b).hash,id:'id'}:undefined)).toBe(action);
  });
});
describe('sync integration',()=>{
  it('merges first sync without deleting unrelated files and preserves binary attachments',async()=>{
    const f=fixture({'phone.md':'phone','image.png':'\u0000\u00ff'},{'desktop.md':'desktop'});
    await f.run(); expect([...f.local.keys()].sort()).toEqual([...f.remote.keys()].sort());
    expect(f.remote.get('image.png')).toEqual(bytes('\u0000\u00ff'));expect(f.trashed).toEqual([]);
  });
  it('does not transfer unchanged files twice',async()=>{
    const f=fixture({'a':'a'},{'a':'a'});await f.run();
    expect(await f.run()).toEqual({uploaded:0,downloaded:0,deleted:0,conflicts:0});
  });
  it('saves both versions locally and remotely on conflict',async()=>{
    const f=fixture({'notes/a.md':'phone'},{'notes/a.md':'desktop'},{'notes/a.md':'base'});
    const result=await f.run();expect(result.conflicts).toBe(1);expect(f.backups).toEqual(['notes/a.md']);
    expect(f.local.get('notes/a.md')).toEqual(bytes('desktop'));
    const copy=[...f.local.keys()].find(p=>p.includes('(conflict'))!;
    expect(f.local.get(copy)).toEqual(bytes('phone'));expect(f.remote.get(copy)).toEqual(bytes('phone'));
    expect((await f.run()).conflicts).toBe(0);
  });
  it('keeps local original if publishing conflict copy fails',async()=>{
    const f=fixture({'a':'phone'},{'a':'desktop'},{'a':'base'});
    f.r.write=async()=>{throw new Error('offline');};
    await expect(f.run()).rejects.toThrow('offline');expect(f.local.get('a')).toEqual(bytes('phone'));
  });
  it('propagates deletes with backups and trash',async()=>{
    const f=fixture({'deleted-remotely':'a'},{'deleted-locally':'b'},{'deleted-remotely':'a','deleted-locally':'b'});
    await f.run();expect(f.local.size).toBe(0);expect(f.remote.size).toBe(0);
    expect(f.backups).toEqual(['deleted-remotely']);expect(f.trashed).toEqual(['deleted-locally']);
  });
  it('preserves edits against an opposing deletion',async()=>{
    const f=fixture({'local':'new'},{'remote':'new'},{local:'old',remote:'old'});
    await f.run();expect(f.local.size).toBe(2);expect(f.remote.size).toBe(2);expect(f.trashed).toEqual([]);
  });
  it('does not mutate after a failed remote scan',async()=>{
    const f=fixture({'a':'a'},{},{'a':'a'});f.r.scan=async()=>{throw new Error('offline');};
    await expect(f.run()).rejects.toThrow('offline');expect(f.local.has('a')).toBe(true);expect(f.saves()).toBe(0);
  });
  it('does not overwrite a local edit made after scanning',async()=>{
    const f=fixture({'a':'old'},{'a':'cloud'},{'a':'old'});
    f.r.read=async()=>{f.local.set('a',bytes('typing'));return bytes('cloud');};
    await expect(f.run()).rejects.toThrow('local race');expect(f.local.get('a')).toEqual(bytes('typing'));
  });
  it('checkpoints completed work before a later network failure',async()=>{
    const f=fixture({'a':'a','b':'b'},{});const original=f.r.write;
    f.r.write=async(p,data,previous)=>{if(p==='b')throw new Error('offline');return original(p,data,previous);};
    await expect(f.run()).rejects.toThrow('offline');expect(f.state.base.a.hash).toBe(info('a').hash);expect(f.state.base.b).toBeUndefined();
    f.r.write=original;await f.run();expect(f.remote.size).toBe(2);
  });
  it('sends local edits before downloading unrelated remote files',async()=>{
    const f=fixture({'z-local.md':'local'},{'a-cloud.md':'cloud'});const events:string[]=[];
    const write=f.r.write;const read=f.r.read;
    f.r.write=async(...args)=>{events.push('upload');return write(...args);};
    f.r.read=async(...args)=>{events.push('download');return read(...args);};
    await f.run();expect(events).toEqual(['upload','download']);
  });
  it('uploads a renamed note before trashing its previous cloud path',async()=>{
    const f=fixture({'z-new.md':'note'},{'a-old.md':'note'},{'a-old.md':'note'});const events:string[]=[];
    const write=f.r.write;const remove=f.r.remove;
    f.r.write=async(...args)=>{events.push('upload');return write(...args);};
    f.r.remove=async(...args)=>{events.push('trash');return remove(...args);};
    await f.run();expect(events).toEqual(['upload','trash']);
  });
  it('handles a filename that matches an Object prototype key',async()=>{
    const f=fixture({'constructor':'hello'},{});await f.run();expect(f.remote.get('constructor')).toEqual(bytes('hello'));
  });
});
describe('paths',()=>{
  it.each(['../notes','/notes','a//b','a/../b','a\\b','a/./b','a\u0000b'])('rejects %s',path=>expect(()=>validPath(path)).toThrow());
  it('rejects case/Unicode collisions and file-folder collisions',()=>{
    expect(()=>validateIndex({'A.md':info('a'),'a.md':info('b')})).toThrow();
    expect(()=>validateIndex({'a':info('a'),'a/b.md':info('b')})).toThrow();
    expect(()=>validateIndex({'é':info('a'),'e\u0301':info('b')})).toThrow();
  });
  it('excludes configuration, recovery data and state, including custom config folder',()=>{
    for(const p of ['settings/a','.git/a','.trash/a','.drive-sync-state/a','.drive-sync-backups/a'])expect(excluded(p,'settings')).toBe(true);
    expect(excluded('notes/image.png','settings')).toBe(false);
  });
});
