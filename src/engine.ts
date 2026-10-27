import { checkActive, SyncCancelledError } from './sync-control';
import type { ProgressEvent } from './progress';
import { Base, decide, FileInfo, hash, Index, validateIndex } from './model';
export interface LocalStore {
  scan(report?:(completed:number,path?:string)=>void): Promise<Index>;
  read(path: string): Promise<ArrayBuffer>;
  write(path: string, data: ArrayBuffer, expected?: string): Promise<void>;
  remove(path: string, expected: string): Promise<void>;
  backup(path: string, data: ArrayBuffer): Promise<void>;
}
export interface RemoteStore {
  scan(report?:(completed:number,path?:string)=>void): Promise<Index>;
  read(file: FileInfo): Promise<ArrayBuffer>;
  write(path: string, data: ArrayBuffer, previous?: FileInfo): Promise<FileInfo>;
  remove(file: FileInfo): Promise<void>;
}
export interface SyncState { base: Record<string, Base>; rootId: string; lastSuccess?: string }
export interface Counts { uploaded: number; downloaded: number; conflicts: number; deleted: number }
export async function synchronize(local: LocalStore, remote: RemoteStore, state: SyncState,
  save: () => Promise<void>, report: (event: ProgressEvent) => void = () => {}, signal?:AbortSignal): Promise<Counts> {
  // Complete both scans before any writes: a partial/failed listing is never treated as deletion.
  report({kind:'scan',source:'local',completed:0});
  report({kind:'scan',source:'remote',completed:0});
  checkActive(signal);
  let scanFailed=false;let firstScanError:unknown;
  const scan=async (source:'local'|'remote',store:LocalStore|RemoteStore):Promise<Index>=>{
    try {
      return await store.scan((completed,path)=>{
        checkActive(signal);if(scanFailed)throw new SyncCancelledError();
        report({kind:'scan',source,completed,path});
      });
    }catch(error){if(!scanFailed){scanFailed=true;firstScanError=error;}throw error;}
  };
  // Wait for both scanners to settle before publishing an error or starting another run.
  const scans=await Promise.allSettled([scan('local',local),scan('remote',remote)]);
  if(scanFailed)throw firstScanError;
  if(scans[0].status!=='fulfilled'||scans[1].status!=='fulfilled')throw new Error('Не удалось проверить файлы.');
  const [li,ri]=[scans[0].value,scans[1].value];
  checkActive(signal);
  const active=async <T>(operation:()=>Promise<T>):Promise<T>=>{
    checkActive(signal);const value=await operation();checkActive(signal);return value;
  };
  validateIndex(li); validateIndex(ri); validateIndex({...li, ...ri});
  const result: Counts = {uploaded: 0, downloaded: 0, conflicts: 0, deleted: 0};
  const own = <T>(record: Record<string,T>, key: string): T | undefined => Object.prototype.hasOwnProperty.call(record,key) ? record[key] : undefined;
  // Send local edits before spending the remaining foreground/background window on downloads.
  const priority={upload:0,conflict:1,'delete-remote':2,download:3,'delete-local':4,equal:5,forget:5};
  const rank=(path:string)=>priority[decide(own(li,path),own(ri,path),own(state.base,path))];
  const paths = [...new Set([...Object.keys(li), ...Object.keys(ri), ...Object.keys(state.base)])].sort().sort((a,b)=>rank(a)-rank(b));
  report({kind:'plan',total:paths.length});
  for (const [position, path] of paths.entries()) {
    checkActive(signal);
    const l = own(li,path), r = own(ri,path), base = own(state.base,path);
    const action = decide(l, r, base);
    report({kind:'file',path,action,completed:position,total:paths.length,counts:{...result}});
    if (action === 'equal') state.base[path] = {hash: r!.hash, id: r!.id!};
    if (action === 'forget') delete state.base[path];
    if (action === 'upload') {
      const data = await active(()=>local.read(path));
      if (hash(data) !== l!.hash) throw new Error(`Файл изменён во время синхронизации: ${path}. Повторите синхронизацию.`);
      const uploaded = await active(()=>remote.write(path, data, r));
      state.base[path] = {hash: uploaded.hash, id: uploaded.id!}; result.uploaded++;
    }
    if (action === 'download') {
      const data = await active(()=>remote.read(r!));
      if (l) {const original=await active(()=>local.read(path));await active(()=>local.backup(path,original));}
      await active(()=>local.write(path, data, l?.hash));
      state.base[path] = {hash: r!.hash, id: r!.id!}; result.downloaded++;
    }
    if (action === 'conflict') {
      // Keep the original remote version; publish a uniquely named local version on the next pass.
      const localData = await active(()=>local.read(path));
      if (hash(localData) !== l!.hash) throw new Error(`Файл изменён: ${path}`);
      const data = await active(()=>remote.read(r!));
      const dot = path.lastIndexOf('.'), slash = path.lastIndexOf('/');
      const split = dot > slash ? dot : path.length;
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const conflict = `${path.slice(0, split)} (conflict iPhone ${suffix})${path.slice(split)}`;
      await active(()=>local.write(conflict, localData));
      await active(()=>local.backup(path, localData));
      // Upload the copy before replacing the original. Failure leaves the local original intact.
      const uploaded = await active(()=>remote.write(conflict, localData));
      state.base[conflict] = {hash: uploaded.hash, id: uploaded.id!};
      await active(()=>local.write(path, data, l!.hash));
      state.base[path] = {hash: r!.hash, id: r!.id!}; result.conflicts++;
    }
    if (action === 'delete-local') {
      const original=await active(()=>local.read(path));await active(()=>local.backup(path,original));
      await active(()=>local.remove(path, l!.hash)); delete state.base[path]; result.deleted++;
    }
    if (action === 'delete-remote') {
      // A last-moment server edit must not be trashed by a stale local deletion.
      await active(()=>remote.remove(r!)); delete state.base[path]; result.deleted++;
    }
    // Each completed action is checkpointed. Network failure preserves unfinished work.
    await save();
    report({kind:'file',path,action,completed:position+1,total:paths.length,counts:{...result}});
  }
  checkActive(signal);
  state.lastSuccess = new Date().toISOString(); await save();
  return result;
}
