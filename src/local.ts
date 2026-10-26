import { Vault } from 'obsidian';
import { LocalStore } from './engine';
import { excluded, hash, Index, validPath } from './model';
export class Local implements LocalStore {
  constructor(private vault: Vault) {}
  async scan(): Promise<Index> {
    const index: Index = Object.create(null); const queue = [''];
    for (let i=0; i<queue.length; i++) {
      const listing = await this.vault.adapter.list(queue[i]);
      for (const folder of listing.folders) if (!excluded(folder,this.vault.configDir)) queue.push(validPath(folder));
      for (const path of listing.files) {
        validPath(path); if (excluded(path,this.vault.configDir)) continue;
        index[path] = {hash:hash(await this.read(path))};
      }
    }
    return index;
  }
  read(path: string): Promise<ArrayBuffer> { return this.vault.adapter.readBinary(validPath(path)); }
  private async check(path: string, expected?: string): Promise<void> {
    const exists = await this.vault.adapter.exists(path);
    if ((expected === undefined && exists) || (expected !== undefined && (!exists || hash(await this.read(path)) !== expected)))
      throw new Error(`Файл изменился на устройстве: ${path}. Повторите синхронизацию.`);
  }
  private async folders(path: string): Promise<void> {
    const parts = path.split('/'); parts.pop(); let current='';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!await this.vault.adapter.exists(current)) await this.vault.adapter.mkdir(current);
    }
  }
  async write(path: string, data: ArrayBuffer, expected?: string): Promise<void> {
    validPath(path); await this.folders(path); await this.check(path,expected);
    await this.vault.adapter.writeBinary(path,data);
  }
  async remove(path: string, expected: string): Promise<void> {
    await this.check(validPath(path),expected); await this.vault.adapter.remove(path);
  }
  async backup(path: string, data: ArrayBuffer): Promise<void> {
    const destination = `.drive-sync-backups/${Date.now()}-${Math.random().toString(36).slice(2,10)}/${validPath(path)}`;
    await this.folders(destination); await this.vault.adapter.writeBinary(destination,data);
  }
}
