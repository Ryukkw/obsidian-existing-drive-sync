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
  save: () => Promise<void>, report: (event: ProgressEvent) => void = () => {}): Promise<Counts> {
  // Complete both scans before any writes: a partial/failed listing is never treated as deletion.
  report({kind:'scan',source:'local',completed:0});
  report({kind:'scan',source:'remote',completed:0});
  const [li, ri] = await Promise.all([
    local.scan((completed,path)=>report({kind:'scan',source:'local',completed,path})),
    remote.scan((completed,path)=>report({kind:'scan',source:'remote',completed,path})),
  ]);
  validateIndex(li); validateIndex(ri); validateIndex({...li, ...ri});
  const result: Counts = {uploaded: 0, downloaded: 0, conflicts: 0, deleted: 0};
  const paths = [...new Set([...Object.keys(li), ...Object.keys(ri), ...Object.keys(state.base)])].sort();
  report({kind:'plan',total:paths.length});
  for (const [position, path] of paths.entries()) {
    const own = <T>(record: Record<string,T>, key: string): T | undefined => Object.prototype.hasOwnProperty.call(record,key) ? record[key] : undefined;
    const l = own(li,path), r = own(ri,path), base = own(state.base,path);
    const action = decide(l, r, base);
    report({kind:'file',path,action,completed:position,total:paths.length,counts:{...result}});
    if (action === 'equal') state.base[path] = {hash: r!.hash, id: r!.id!};
    if (action === 'forget') delete state.base[path];
    if (action === 'upload') {
      const data = await local.read(path);
      if (hash(data) !== l!.hash) throw new Error(`Файл изменён во время синхронизации: ${path}. Повторите синхронизацию.`);
      const uploaded = await remote.write(path, data, r);
      state.base[path] = {hash: uploaded.hash, id: uploaded.id!}; result.uploaded++;
    }
    if (action === 'download') {
      const data = await remote.read(r!);
      if (l) await local.backup(path, await local.read(path));
      await local.write(path, data, l?.hash);
      state.base[path] = {hash: r!.hash, id: r!.id!}; result.downloaded++;
    }
    if (action === 'conflict') {
      // Keep the original remote version; publish a uniquely named local version on the next pass.
      const localData = await local.read(path);
      if (hash(localData) !== l!.hash) throw new Error(`Файл изменён: ${path}`);
      const data = await remote.read(r!);
      const dot = path.lastIndexOf('.'), slash = path.lastIndexOf('/');
      const split = dot > slash ? dot : path.length;
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const conflict = `${path.slice(0, split)} (conflict iPhone ${suffix})${path.slice(split)}`;
      await local.write(conflict, localData);
      await local.backup(path, localData);
      // Upload the copy before replacing the original. Failure leaves the local original intact.
      const uploaded = await remote.write(conflict, localData);
      state.base[conflict] = {hash: uploaded.hash, id: uploaded.id!};
      await local.write(path, data, l!.hash);
      state.base[path] = {hash: r!.hash, id: r!.id!}; result.conflicts++;
    }
    if (action === 'delete-local') {
      await local.backup(path, await local.read(path));
      await local.remove(path, l!.hash); delete state.base[path]; result.deleted++;
    }
    if (action === 'delete-remote') {
      // A last-moment server edit must not be trashed by a stale local deletion.
      await remote.remove(r!); delete state.base[path]; result.deleted++;
    }
    // Each completed action is checkpointed. Network failure preserves unfinished work.
    await save();
    report({kind:'file',path,action,completed:position+1,total:paths.length,counts:{...result}});
  }
  state.lastSuccess = new Date().toISOString(); await save();
  return result;
}
