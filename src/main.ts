import { App, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { Credentials, Drive } from './drive';
import { Local } from './local';
import { FolderPicker } from './folder-picker';
import { SyncState, synchronize } from './engine';
import { excluded } from './model';
interface Settings { folderId: string; folderName: string; enabled: boolean }
const SECRET = 'existing-drive-sync-google';
export default class DriveSyncPlugin extends Plugin {
  settings: Settings = {folderId:'',folderName:'',enabled:false};
  private running = false; private stopped = false; private pending = false;
  private timer?: number; private status!: HTMLElement; private state!: SyncState;
  private deviceId = ''; private statePath = '';
  async onload(): Promise<void> {
    this.settings = {...this.settings,...await this.loadData()};
    this.deviceId = this.app.loadLocalStorage('existing-drive-sync-device') ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.app.saveLocalStorage('existing-drive-sync-device',this.deviceId);
    this.statePath = `.drive-sync-state/${this.deviceId}.json`;
    this.status = this.addStatusBarItem(); this.status.setText('Drive: ожидание');
    this.addSettingTab(new SettingsTab(this.app,this));
    this.addCommand({id:'sync-now',name:'Синхронизировать сейчас',callback:()=>void this.sync(true)});
    this.addRibbonIcon('refresh-cw','Синхронизировать Google Drive',()=>void this.sync(true));
    const changed = (path: string) => { if (!excluded(path,this.app.vault.configDir)) this.schedule(); };
    this.registerEvent(this.app.vault.on('create',file=>changed(file.path)));
    this.registerEvent(this.app.vault.on('modify',file=>changed(file.path)));
    this.registerEvent(this.app.vault.on('delete',file=>changed(file.path)));
    this.registerEvent(this.app.vault.on('rename',(file,old)=>{changed(file.path);changed(old);}));
    this.registerDomEvent(document,'visibilitychange',()=>{if (!document.hidden) this.schedule(500);});
    this.registerDomEvent(window,'focus',()=>this.schedule(500));
    this.registerDomEvent(window,'online',()=>this.schedule(500));
    this.registerInterval(window.setInterval(()=>{if (!document.hidden) this.schedule(500);},60_000));
    this.app.workspace.onLayoutReady(()=>this.schedule(1500));
  }
  onunload(): void { this.stopped = true; window.clearTimeout(this.timer); }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
  private schedule(delay=2500): void {
    if (this.stopped || !this.settings.enabled) return;
    if (this.running) {this.pending = true;return;}
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(()=>void this.sync(),delay);
  }
  private async loadState(rootId: string): Promise<void> {
    if (await this.app.vault.adapter.exists(this.statePath)) {
      const stored = JSON.parse(await this.app.vault.adapter.read(this.statePath));
      if (!stored || typeof stored.base !== 'object' || stored.base === null || typeof stored.rootId !== 'string')
        throw new Error('Повреждено состояние синхронизации. Не удаляйте его без резервной копии.');
      for (const item of Object.values(stored.base) as unknown[]) {
        const value = item as {hash?: unknown;id?: unknown};
        if (!value || typeof value.hash !== 'string' || !/^[a-f0-9]{32}$/.test(value.hash) || typeof value.id !== 'string')
          throw new Error('Повреждено состояние синхронизации.');
      }
      this.state = stored;
      this.state.base = Object.assign(Object.create(null),stored.base);
      if (this.state.rootId !== rootId) throw new Error('Папка Google Drive отличается от ранее подключённой. Для другой папки создайте отдельное локальное хранилище.');
    } else this.state = {rootId,base:Object.create(null)};
  }
  async sync(manual=false): Promise<void> {
    if (this.running || this.stopped) {if (this.running) this.pending = true;return;}
    if (!manual && !this.settings.enabled) return;
    if (!this.settings.folderId) {if(manual) new Notice('Укажите папку Google Drive в настройках плагина.');return;}
    this.running = true; this.pending = false; window.clearTimeout(this.timer);
    this.status.setText('Drive: синхронизация…');
    let succeeded = false;
    try {
      const credentials = this.credentials();
      const root = this.settings.folderId;
      await this.loadState(root);
      const remote = new Drive(credentials,root,this.app.vault.configDir);
      const save = async () => {
        if (!await this.app.vault.adapter.exists('.drive-sync-state')) await this.app.vault.adapter.mkdir('.drive-sync-state');
        await this.app.vault.adapter.write(this.statePath,JSON.stringify(this.state));
      };
      // Persist the root binding before the first write, even if initial sync is interrupted.
      await save();
      const result = await synchronize(new Local(this.app.vault),remote,this.state,save,
        message=>this.status.setText(`Drive: ${message}`));
      this.status.setText(`Drive: обновлено ${new Date().toLocaleTimeString()}`);
      if (manual || result.conflicts) new Notice(`Google Drive: отправлено ${result.uploaded}, загружено ${result.downloaded}, конфликтов ${result.conflicts}, удалений ${result.deleted}.`,8000);
      succeeded = true;
    } catch (error) {
      this.status.setText('Drive: ошибка — откройте синхронизацию');
      new Notice(error instanceof Error ? error.message : 'Ошибка синхронизации Google Drive.',10000);
      // Never log credentials, request bodies, or OAuth responses.
    } finally {
      this.running = false;
      if (succeeded && this.pending && !this.stopped) this.schedule(3000);
    }
  }
  private credentials(): Credentials {
    const text = this.app.secretStorage.getSecret(SECRET);
    if (!text) throw new Error('Сначала добавьте подключение Google в настройках плагина.');
    const value = JSON.parse(text) as Credentials;
    if (![value.clientId,value.clientSecret,value.refreshToken].every(v=>typeof v==='string' && v.length>0))
      throw new Error('Неполные данные подключения Google.');
    return value;
  }
  pickFolder(refresh:()=>void): void {
    try {
      const drive=new Drive(this.credentials(),'root',this.app.vault.configDir);
      new FolderPicker(this.app,(id,shared)=>drive.listFolders(id,shared),async folder=>{
        if(this.running) throw new Error('Дождитесь завершения синхронизации.');
        if(await this.app.vault.adapter.exists(this.statePath)){
          const stored=JSON.parse(await this.app.vault.adapter.read(this.statePath));
          if(stored.rootId!==folder.id) throw new Error('Этот локальный vault уже связан с другой папкой. Для другого хранилища создайте отдельный локальный vault.');
        }
        const previous={...this.settings};
        this.settings.folderId=folder.id;this.settings.folderName=folder.name;
        try {await this.saveSettings();} catch(error){this.settings=previous;throw error;}
        refresh();new Notice('Хранилище выбрано. Будут синхронизироваться все заметки, вложения и подпапки.');
      }).open();
    } catch(error){new Notice(error instanceof Error?error.message:'Не удалось открыть Google Drive.');}
  }
  isRunning(): boolean {return this.running;}
}
class SettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: DriveSyncPlugin) {super(app,plugin);}
  display(): void {
    const el = this.containerEl; el.empty();
    el.createEl('h2',{text:'Google Drive — существующее хранилище'});
    el.createEl('p',{text:'На iPhone используйте локальное хранилище без iCloud. Синхронизируются все обычные файлы и вложения. Настройки Obsidian, служебное состояние и резервные копии исключены.'});
    new Setting(el).setName('Хранилище в Google Drive')
      .setDesc(this.plugin.settings.folderId ? `Выбрано: ${this.plugin.settings.folderName || this.plugin.settings.folderId}. Синхронизируется весь vault.` : 'Выберите папку vault. Все её заметки, вложения и подпапки будут синхронизироваться целиком.')
      .addButton(button=>button.setButtonText('Выбрать папку').onClick(()=>this.plugin.pickFolder(()=>this.display())));
    let connection = '';
    new Setting(el).setName('Подключение Google').setDesc('Вставьте содержимое файла подключения, созданного командой npm run auth на компьютере. После сохранения поле очищается; данные хранятся в SecretStorage этого устройства.')
      .addTextArea(text=>{text.setPlaceholder('{"clientId": …, "clientSecret": …, "refreshToken": …}').onChange(value=>connection=value);text.inputEl.rows=3;text.inputEl.setAttribute('autocomplete','off');text.inputEl.setAttribute('spellcheck','false');})
      .addButton(button=>button.setButtonText('Сохранить подключение').onClick(()=>{
        if(this.plugin.isRunning()) {new Notice('Дождитесь завершения синхронизации.');return;}
        try {
          const value = JSON.parse(connection) as Credentials;
          if (![value.clientId,value.clientSecret,value.refreshToken].every(v=>typeof v==='string' && v.length>0)) throw new Error();
          this.app.secretStorage.setSecret(SECRET,JSON.stringify({clientId:value.clientId,clientSecret:value.clientSecret,refreshToken:value.refreshToken}));
          connection=''; this.display(); new Notice('Подключение сохранено на этом устройстве.');
        } catch {new Notice('Нужен JSON с clientId, clientSecret и refreshToken.');}
      }));
    new Setting(el).setName('Автоматическая синхронизация').setDesc('При открытии, возвращении в приложение, после правок и раз в минуту, пока приложение видно.')
      .addToggle(toggle=>toggle.setValue(this.plugin.settings.enabled).onChange(async enabled=>{this.plugin.settings.enabled=enabled;await this.plugin.saveSettings();if(enabled) void this.plugin.sync(true);}));
    new Setting(el).setName('Синхронизировать сейчас').setDesc('Первая синхронизация объединяет файлы. При различиях сохраняются обе версии.')
      .addButton(button=>button.setButtonText('Синхронизировать').setCta().onClick(()=>void this.plugin.sync(true)));
    el.createEl('p',{text:'Конфликты получают имя «… (conflict iPhone …)». Копии заменённых и удалённых локальных файлов находятся в .drive-sync-backups; удалённые облачные файлы — в корзине Google Drive. В закрытом приложении синхронизация не выполняется.'});
  }
}
