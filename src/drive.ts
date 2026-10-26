import { requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { excluded, FileInfo, hash, Index, validPath } from './model';
import { RemoteStore } from './engine';
export interface DriveFolder { id: string; name: string }
export interface Credentials { clientId: string; clientSecret: string; refreshToken: string }
interface DriveFile { id: string; title: string; mimeType: string; etag: string; md5Checksum?: string; labels?: {trashed?: boolean} }
const API = 'https://www.googleapis.com/drive/v2';
const FIELDS = 'id,title,mimeType,etag,md5Checksum,labels/trashed';
const FOLDER = 'application/vnd.google-apps.folder';
export class Drive implements RemoteStore {
  private token = ''; private expires = 0;
  private folders = new Map<string, string>();
  constructor(private credentials: Credentials, private root: string, private configDir: string,
    private transport: (params: RequestUrlParam) => Promise<RequestUrlResponse> = requestUrl) { this.folders.set('', this.root); }
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.expires) return this.token;
    const response = await this.transport({url:'https://oauth2.googleapis.com/token', method:'POST',
      contentType:'application/x-www-form-urlencoded', throw:false,
      body: new URLSearchParams({client_id:this.credentials.clientId, client_secret:this.credentials.clientSecret,
        refresh_token:this.credentials.refreshToken, grant_type:'refresh_token'}).toString()});
    if (response.status !== 200) throw new Error('Не удалось обновить вход Google. Повторите авторизацию (OAuth-приложение в режиме Testing может терять доступ через 7 дней).');
    this.token = response.json.access_token;
    this.expires = Date.now() + Math.max(0, Number(response.json.expires_in) - 60) * 1000;
    return this.token;
  }
  private async request(params: RequestUrlParam): Promise<RequestUrlResponse> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const token = await this.accessToken();
      const response = await this.transport({...params, throw:false, headers:{...params.headers, Authorization:`Bearer ${token}`}});
      if (response.status === 401 && attempt === 0) { this.token = ''; continue; }
      // Retry only reads: retrying creates after an ambiguous response can duplicate Drive files.
      if ((params.method ?? 'GET') === 'GET' && (response.status === 429 || response.status >= 500) && attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt)); continue;
      }
      if (response.status === 412) throw new Error('Файл в Google Drive изменился во время синхронизации. Повторите синхронизацию.');
      if (response.status >= 400) throw new Error(`Google Drive: HTTP ${response.status}. Синхронизация остановлена; проверьте подключение и права доступа.`);
      return response;
    }
    throw new Error('Google Drive временно недоступен.');
  }
  private async metadata(id: string): Promise<DriveFile> {
    return (await this.request({url:`${API}/files/${encodeURIComponent(id)}?fields=${FIELDS}`})).json;
  }
  private async children(parent: string): Promise<DriveFile[]> {
    const result: DriveFile[] = []; let page = '';
    do {
      const query = new URLSearchParams({q:`'${parent.replace(/'/g, "\\'")}' in parents and trashed = false`,
        maxResults:'1000', fields:`nextPageToken,items(${FIELDS})`});
      if (page) query.set('pageToken', page);
      const response = (await this.request({url:`${API}/files?${query}`})).json;
      result.push(...(response.items ?? [])); page = response.nextPageToken ?? '';
    } while (page);
    return result;
  }
  async listFolders(parent = 'root', shared = false): Promise<DriveFolder[]> {
    const result: DriveFolder[] = []; let page = '';
    const scope = shared ? 'sharedWithMe = true' : `'${parent.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' in parents`;
    do {
      const query = new URLSearchParams({q:`${scope} and trashed = false and mimeType = '${FOLDER}'`,
        maxResults:'1000',fields:'nextPageToken,items(id,title)'});
      if (page) query.set('pageToken',page);
      const response = (await this.request({url:`${API}/files?${query}`})).json;
      for (const folder of response.items ?? []) {
        if (typeof folder.id !== 'string' || typeof folder.title !== 'string') throw new Error('Google вернул неполные данные папки.');
        result.push({id:folder.id,name:folder.title});
      }
      page = response.nextPageToken ?? '';
    } while (page);
    return result.sort((a,b)=>a.name.localeCompare(b.name,'ru') || a.id.localeCompare(b.id));
  }
  async scan(): Promise<Index> {
    const root = await this.metadata(this.root);
    if (root.mimeType !== FOLDER || root.labels?.trashed) throw new Error('Выбранная папка Google Drive недоступна.');
    const result: Index = Object.create(null); this.folders.clear(); this.folders.set('', this.root);
    const queue = [{id:this.root, path:''}]; const visited = new Set<string>();
    for (let i = 0; i < queue.length; i++) {
      const parent = queue[i];
      if (visited.has(parent.id)) throw new Error('Повторная папка в Google Drive.');
      visited.add(parent.id);
      const names = new Set<string>();
      for (const file of await this.children(parent.id)) {
        if (file.title.includes('/')) throw new Error(`В имени файла Google Drive есть /: ${file.title}`);
        const path = validPath(parent.path ? `${parent.path}/${file.title}` : file.title);
        if (excluded(path, this.configDir)) continue;
        const key = file.title.normalize('NFC').toLowerCase();
        if (names.has(key)) throw new Error(`В Google Drive одинаковые имена: ${path}. Устраните дубликат перед синхронизацией.`);
        names.add(key);
        if (file.mimeType === FOLDER) { this.folders.set(path, file.id); queue.push({id:file.id,path}); }
        else {
          if (!file.md5Checksum || !file.etag) throw new Error(`Неподдерживаемый файл Google Drive: ${path}. Ярлыки и Google Docs нужно убрать из папки заметок или экспортировать в обычные файлы.`);
          result[path] = {id:file.id, etag:file.etag, hash:file.md5Checksum};
        }
      }
    }
    return result;
  }
  async read(file: FileInfo): Promise<ArrayBuffer> {
    // Drive metadata and media have different ETags. A metadata If-Match on alt=media
    // rejects unchanged files with HTTP 412. Verify the downloaded bytes against the
    // scanned checksum instead; writes and trash operations retain their preconditions.
    const response = await this.request({url:`${API}/files/${encodeURIComponent(file.id!)}?alt=media`});
    if (hash(response.arrayBuffer) !== file.hash) throw new Error('Контрольная сумма загруженного файла не совпала. Повторите синхронизацию.');
    return response.arrayBuffer;
  }
  private async unchanged(file: FileInfo): Promise<void> {
    const current = await this.metadata(file.id!);
    if (current.etag !== file.etag || current.md5Checksum !== file.hash || current.labels?.trashed)
      throw new Error('Файл изменился в Google Drive. Повторите синхронизацию.');
  }
  private async ensureFolder(path: string): Promise<string> {
    if (this.folders.has(path)) return this.folders.get(path)!;
    const split = path.lastIndexOf('/');
    const parent = await this.ensureFolder(split < 0 ? '' : path.slice(0, split));
    const name = path.slice(split + 1);
    const matches = (await this.children(parent)).filter(f => f.title.normalize('NFC').toLowerCase() === name.normalize('NFC').toLowerCase());
    if (matches.length) {
      if (matches.length !== 1 || matches[0].mimeType !== FOLDER || matches[0].title !== name) throw new Error(`Конфликт имени папки: ${path}`);
      this.folders.set(path, matches[0].id); return matches[0].id;
    }
    const file = (await this.request({url:`${API}/files`, method:'POST', contentType:'application/json',
      body:JSON.stringify({title:name,mimeType:FOLDER,parents:[{id:parent}]})})).json;
    this.folders.set(path, file.id); return file.id;
  }
  async write(path: string, data: ArrayBuffer, previous?: FileInfo): Promise<FileInfo> {
    validPath(path);
    if (previous) await this.unchanged(previous);
    const slash = path.lastIndexOf('/');
    const parent = await this.ensureFolder(slash < 0 ? '' : path.slice(0, slash));
    if (!previous && (await this.children(parent)).some(f => f.title.normalize('NFC').toLowerCase() === path.slice(slash+1).normalize('NFC').toLowerCase()))
      throw new Error(`Файл уже появился в Google Drive: ${path}. Повторите синхронизацию.`);
    // A lost upload response is reconciled by content and path on the next complete scan.
    const endpoint = previous ? `/${encodeURIComponent(previous.id!)}` : '';
    const init = await this.request({url:`https://www.googleapis.com/upload/drive/v2/files${endpoint}?uploadType=resumable&fields=${FIELDS}`,
      method:previous ? 'PUT' : 'POST', contentType:'application/json',
      headers:{'X-Upload-Content-Type':'application/octet-stream','X-Upload-Content-Length':String(data.byteLength), ...(previous ? {'If-Match':previous.etag!} : {})},
      body:JSON.stringify(previous ? {} : {title:path.slice(slash+1),parents:[{id:parent}],mimeType:'application/octet-stream'})});
    const location = Object.entries(init.headers).find(([key]) => key.toLowerCase() === 'location')?.[1];
    if (!location || !location.startsWith('https://www.googleapis.com/')) throw new Error('Google не вернул адрес загрузки.');
    // 1 MiB chunks keep the network request bounded. An interrupted session is reconciled on next sync.
    const chunk = 1024 * 1024;
    let final: DriveFile | undefined;
    for (let offset = 0; offset < data.byteLength || (offset === 0 && data.byteLength === 0); offset += chunk) {
      if (previous) await this.unchanged(previous);
      const end = Math.min(offset + chunk, data.byteLength);
      const response = await this.request({url:location,method:'PUT',contentType:'application/octet-stream',
        headers:{'Content-Range':data.byteLength ? `bytes ${offset}-${end-1}/${data.byteLength}` : 'bytes */0',
          ...(previous ? {'If-Match':previous.etag!} : {})},body:data.slice(offset, end)});
      if (end < data.byteLength) {
        if (response.status !== 308) throw new Error('Неожиданный ответ при загрузке вложения.');
        const range = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'range')?.[1];
        if (range !== `bytes=0-${end-1}`) throw new Error('Google принял неполный блок. Повторите синхронизацию.');
      } else {
        if (response.status !== 200 && response.status !== 201) throw new Error('Google не подтвердил завершение загрузки.');
        final = response.json;
      }
      if (!data.byteLength) break;
    }
    if (!final?.id || !final.etag || final.md5Checksum !== hash(data)) throw new Error('Google не подтвердил контрольную сумму файла.');
    return {id:final.id,etag:final.etag,hash:final.md5Checksum};
  }
  async remove(file: FileInfo): Promise<void> {
    await this.unchanged(file);
    await this.request({url:`${API}/files/${encodeURIComponent(file.id!)}/trash`,method:'POST',headers:{'If-Match':file.etag!}});
  }
}
