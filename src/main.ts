import { App, Notice, Plugin, PluginSettingTab, Setting, TextFileView } from 'obsidian';
import { Credentials, Drive } from './drive';
import { Local } from './local';
import { FolderPicker } from './folder-picker';
import { SyncState, synchronize } from './engine';
import { excluded } from './model';
import { SyncProgress, progressTitle } from './progress';
import { ProgressModal, ProgressView } from './progress-view';
import { ProgressBanner } from './progress-banner';
import { checkActive, SyncCancelledError } from './sync-control';
import { LifecycleSync } from './lifecycle-sync';
interface Settings { folderId: string; folderName: string; enabled: boolean }
const SECRET = 'existing-drive-sync-google';
export default class DriveSyncPlugin extends Plugin {
  settings: Settings = {folderId:'',folderName:'',enabled:false};
  private running = false; private stopped = false;
  private lifecycle!:LifecycleSync;
  private ready=false; private status!: HTMLElement; private state!: SyncState;
  private deviceId = ''; private statePath = '';
  readonly progress = new SyncProgress();
  private progressModal?:ProgressModal;
  private banner?:ProgressBanner;
  private syncController?:AbortController;
  async onload(): Promise<void> {
    this.settings = {...this.settings,...await this.loadData()};
    this.deviceId = this.app.loadLocalStorage('existing-drive-sync-device') ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.app.saveLocalStorage('existing-drive-sync-device',this.deviceId);
    this.statePath = `.drive-sync-state/${this.deviceId}.json`;
    this.lifecycle=new LifecycleSync({
      enabled:()=>this.settings.enabled&&Boolean(this.settings.folderId)&&Boolean(this.app.secretStorage.getSecret(SECRET)),
      saveEditors:()=>this.saveOpenEditors(),
      run:()=>this.performSync(),
      persistPending:value=>this.app.saveLocalStorage('existing-drive-sync-pending',value),
      onError:error=>{const report=this.progress.begin();this.progress.fail(error instanceof Error?error.message:'Не удалось сохранить заметки перед синхронизацией.',report.runId);},
    },this.app.loadLocalStorage('existing-drive-sync-pending')===true);
    this.status = this.addStatusBarItem(); this.status.setText('Drive: ожидание');
    this.addSettingTab(new SettingsTab(this.app,this));
    this.banner=new ProgressBanner(document.body,this.progress,()=>this.showProgress());
    this.register(()=>this.banner?.destroy());
    this.register(this.progress.subscribe(state=>this.status.setText(`Drive: ${progressTitle(state)}`)));
    this.addCommand({id:'show-sync-progress',name:'Показать ход синхронизации',callback:()=>this.showProgress()});
    this.addCommand({id:'sync-now',name:'Синхронизировать сейчас',callback:()=>void this.sync(true)});
    this.addRibbonIcon('refresh-cw','Синхронизировать Google Drive',()=>void this.sync(true));
    const changed = (path: string) => {
      if(!this.ready||excluded(path,this.app.vault.configDir))return;
      this.lifecycle.noteChange();
      if(document.hidden)void this.lifecycle.request('background');else this.lifecycle.schedule(1000);
    };
    this.registerEvent(this.app.vault.on('create',file=>changed(file.path)));
    this.registerEvent(this.app.vault.on('modify',file=>changed(file.path)));
    this.registerEvent(this.app.vault.on('delete',file=>changed(file.path)));
    this.registerEvent(this.app.vault.on('rename',(file,old)=>{changed(file.path);changed(old);}));
    this.registerEvent(this.app.workspace.on('editor-change',(_editor,info)=>{if(info.file)changed(info.file.path);}));
    this.registerDomEvent(document,'visibilitychange',()=>{
      if(!this.ready)return;
      void this.lifecycle.request(document.hidden?'background':'resume');
    });
    this.registerDomEvent(window,'pagehide',()=>{if(this.ready)void this.lifecycle.request('background');});
    this.registerDomEvent(window,'focus',()=>{if(this.ready)void this.lifecycle.request('resume');});
    this.registerDomEvent(window,'online',()=>{if(this.ready)void this.lifecycle.request('resume');});
    this.registerEvent(this.app.workspace.on('quit',tasks=>{tasks.add(()=>this.flushBeforeQuit());}));
    this.registerInterval(window.setInterval(()=>{if(this.ready&&!document.hidden)void this.lifecycle.request('poll');},60_000));
    this.app.workspace.onLayoutReady(()=>{
      if(this.stopped)return;
      this.ready=true;void this.lifecycle.request('startup');
    });
  }
  onunload(): void { this.stopped = true;this.lifecycle?.dispose();this.syncController?.abort();this.progress.dispose();this.progressModal?.close(); }
  private async saveOpenEditors():Promise<void> {
    if(this.stopped)return;
    const views:TextFileView[]=[];
    const seen=new Set<string>();
    this.app.workspace.iterateAllLeaves(leaf=>{
      const view=leaf.view;
      if(view instanceof TextFileView&&view.file&&!excluded(view.file.path,this.app.vault.configDir)&&!seen.has(view.file.path)){
        seen.add(view.file.path);views.push(view);
      }
    });
    for(const view of views){if(this.stopped)return;await view.save();}
  }
  private async flushBeforeQuit():Promise<void> {
    if(this.stopped||!this.ready)return;
    let timeout:ReturnType<typeof setTimeout>|undefined;
    // Desktop quit can wait through Tasks; iOS force quit can bypass this event entirely.
    try {
      await Promise.race([
        this.lifecycle.request('quit'),
        new Promise<void>(resolve=>{timeout=setTimeout(()=>{this.syncController?.abort();resolve();},8000);}),
      ]);
    }finally{clearTimeout(timeout);}
  }

  showProgress():void {
    this.progressModal??=new ProgressModal(this.app,this.progress);this.progressModal.show();
  }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
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
    if(this.stopped)return;
    if(manual&&!this.settings.folderId){new Notice('Укажите папку Google Drive в настройках плагина.');return;}
    if(manual&&this.lifecycle.busy){this.banner?.reveal();return;}
    await this.lifecycle.request(manual?'manual':'resume');
  }
  private async performSync():Promise<boolean> {
    if(this.stopped||!this.settings.folderId)return false;
    this.running=true;
    const controller=new AbortController();this.syncController=controller;
    const report=this.progress.begin();
    let succeeded = false;
    try {
      const credentials = this.credentials();
      const root = this.settings.folderId;
      await this.loadState(root);checkActive(controller.signal);
      const remote = new Drive(credentials,root,this.app.vault.configDir,undefined,controller.signal);
      const save = async () => {
        checkActive(controller.signal);
        if (!await this.app.vault.adapter.exists('.drive-sync-state')) {checkActive(controller.signal);await this.app.vault.adapter.mkdir('.drive-sync-state');}
        checkActive(controller.signal);
        await this.app.vault.adapter.write(this.statePath,JSON.stringify(this.state));
      };
      // Persist the root binding before the first write, even if initial sync is interrupted.
      await save();
      const result = await synchronize(new Local(this.app.vault,controller.signal),remote,this.state,save,
        report,controller.signal);
      this.running=false;
      this.progress.finish(result,report.runId);
      succeeded = true;
    } catch (error) {
      const message=error instanceof Error ? error.message : 'Ошибка синхронизации Google Drive.';
      this.running=false;
      if(!this.stopped && !(error instanceof SyncCancelledError))this.progress.fail(message,report.runId);
      // Never log credentials, request bodies, or OAuth responses.
    } finally {
      if(this.syncController===controller)this.syncController=undefined;
      this.running = false;
    }
    return succeeded;
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
        if(this.isRunning()) throw new Error('Дождитесь завершения синхронизации.');
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
  isRunning(): boolean {return this.running||this.lifecycle.busy;}
}
class SettingsTab extends PluginSettingTab {
  private stopProgress?:()=>void;
  hide():void {this.stopProgress?.();this.stopProgress=undefined;}
  constructor(app: App, private plugin: DriveSyncPlugin) {super(app,plugin);plugin.register(()=>this.hide());}
  display(): void {
    this.stopProgress?.();
    const el = this.containerEl; el.empty();
    el.createEl('h2',{text:'Google Drive — существующее хранилище'});
    const progressView=new ProgressView(el);
    this.stopProgress=this.plugin.progress.subscribe(state=>progressView.update(state));
    new Setting(el).setName('Ход синхронизации').setDesc('Текущий этап, обработанные файлы и результат последнего запуска.')
      .addButton(button=>button.setButtonText('Показать прогресс').onClick(()=>this.plugin.showProgress()));
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
    new Setting(el).setName('Автоматическая синхронизация').setDesc('Сразу при запуске и возвращении; через секунду после правок; немедленно при сворачивании. iOS может прервать отправку — следующий запуск повторит проверку.')
      .addToggle(toggle=>toggle.setValue(this.plugin.settings.enabled).onChange(async enabled=>{this.plugin.settings.enabled=enabled;await this.plugin.saveSettings();if(enabled) void this.plugin.sync(true);}));
    new Setting(el).setName('Синхронизировать сейчас').setDesc('Первая синхронизация объединяет файлы. При различиях сохраняются обе версии.')
      .addButton(button=>button.setButtonText('Синхронизировать').setCta().onClick(()=>void this.plugin.sync(true)));
    el.createEl('p',{text:'Конфликты получают имя «… (conflict iPhone …)». Копии заменённых и удалённых локальных файлов находятся в .drive-sync-backups; удалённые облачные файлы — в корзине Google Drive. При сворачивании плагин сохраняет открытые заметки и пробует отправить изменения. iOS может приостановить приложение; после следующего открытия проверка повторится.'});
  }
}
