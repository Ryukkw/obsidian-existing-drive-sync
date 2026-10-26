import SparkMD5 from 'spark-md5';
export const hash = (data: ArrayBuffer): string => SparkMD5.ArrayBuffer.hash(data);
export interface FileInfo { hash: string; id?: string; etag?: string }
export interface Base { hash: string; id: string }
export type Index = Record<string, FileInfo>;
export type Action = 'equal' | 'upload' | 'download' | 'conflict' | 'delete-local' | 'delete-remote' | 'forget';
export function decide(local: FileInfo | undefined, remote: FileInfo | undefined, base: Base | undefined): Action {
  if (local && remote) {
    if (local.hash === remote.hash) return 'equal';
    if (!base) return 'conflict';
    if (local.hash === base.hash) return 'download';
    if (remote.hash === base.hash) return 'upload';
    return 'conflict';
  }
  if (local) return !base || local.hash !== base.hash ? 'upload' : 'delete-local';
  if (remote) return !base || remote.hash !== base.hash ? 'download' : 'delete-remote';
  return 'forget';
}
export function validPath(path: string): string {
  if (!path || path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..'))
    throw new Error(`Недопустимый путь: ${path}`);
  return path;
}
export function excluded(path: string, configDir: string): boolean {
  return [configDir, '.trash', '.git', '.drive-sync-backups', '.drive-sync-state'].some(p => path === p || path.startsWith(`${p}/`));
}
export function validateIndex(index: Index): void {
  const folded = new Map<string, string>();
  for (const path of Object.keys(index)) {
    validPath(path);
    const key = path.normalize('NFC').toLowerCase();
    if (folded.has(key)) throw new Error(`Несовместимые имена файлов: ${folded.get(key)} и ${path}`);
    folded.set(key, path);
  }
  for (const path of Object.keys(index)) {
    const parts = path.split('/'); parts.pop();
    while (parts.length) {
      const parent = parts.join('/').normalize('NFC').toLowerCase();
      if (folded.has(parent)) throw new Error(`Файл мешает созданию папки: ${path}`);
      parts.pop();
    }
  }
}
