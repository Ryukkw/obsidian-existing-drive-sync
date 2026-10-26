import { App, Modal, Notice, Setting } from 'obsidian';
import { DriveFolder } from './drive';
interface Location { id: string; name: string; shared?: boolean }
export class FolderPicker extends Modal {
  private trail: Location[] = [];
  private generation = 0;
  private closed = false;
  constructor(app: App, private list: (id:string,shared:boolean)=>Promise<DriveFolder[]>,
    private select: (folder:DriveFolder)=>Promise<void>) { super(app); }
  onOpen(): void { this.closed = false; this.setTitle('Выберите хранилище в Google Drive');void this.navigate([{id:'root',name:'Мой диск'}]); }
  onClose(): void { this.closed = true;this.generation++;this.contentEl.empty(); }
  private async navigate(trail: Location[]): Promise<void> {
    const generation = ++this.generation;
    this.trail=trail;this.contentEl.empty();
    this.contentEl.createEl('p',{text:trail.map(p=>p.name).join(' / ')});
    this.contentEl.createEl('p',{text:'Загрузка папок…'});
    try {
      const current=trail[trail.length-1];
      const folders=await this.list(current.id,Boolean(current.shared));
      if (this.closed || generation!==this.generation) return;
      this.render(folders);
    } catch(error) {
      if (this.closed || generation!==this.generation) return;
      this.contentEl.empty();
      this.contentEl.createEl('p',{text:error instanceof Error?error.message:'Не удалось загрузить папки.'});
      new Setting(this.contentEl).addButton(b=>b.setButtonText('Повторить').onClick(()=>void this.navigate(trail)))
        .addButton(b=>b.setButtonText('Назад').onClick(()=>void this.navigate(trail.length>1?trail.slice(0,-1):[{id:'root',name:'Мой диск'}])));
    }
  }
  private render(folders: DriveFolder[]): void {
    const el=this.contentEl;el.empty();
    const current=this.trail[this.trail.length-1];
    el.createEl('p',{text:this.trail.map(p=>p.name).join(' / ')});
    el.createEl('p',{text:'Выберите папку самого vault — все заметки, вложения и подпапки в ней будут синхронизироваться целиком.'});
    const controls=new Setting(el);
    controls.addButton(b=>b.setButtonText('Мой диск').onClick(()=>void this.navigate([{id:'root',name:'Мой диск'}])));
    controls.addButton(b=>b.setButtonText('Доступные мне').onClick(()=>void this.navigate([{id:'shared',name:'Доступные мне',shared:true}])));
    if(this.trail.length>1) controls.addButton(b=>b.setButtonText('Назад').onClick(()=>void this.navigate(this.trail.slice(0,-1))));
    // Require a specific vault folder rather than accepting the whole account root.
    if(this.trail.length>1) new Setting(el).setName(current.name)
      .addButton(b=>b.setButtonText('Синхронизировать этот vault').setCta().onClick(async()=>{
        b.setDisabled(true);
        try {await this.select({id:current.id,name:this.trail.map(p=>p.name).join(' / ')});this.close();}
        catch(error){new Notice(error instanceof Error?error.message:'Не удалось сохранить выбор.');b.setDisabled(false);}
      }));
    let filter=''; const listing=el.createDiv();
    const draw=()=>{
      listing.empty();
      const visible=folders.filter(f=>f.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
      if(!visible.length) listing.createEl('p',{text:folders.length?'Нет папок с таким именем.':'Вложенных папок нет.'});
      const names=new Set<string>(), duplicates=new Set<string>();
      for(const f of folders){if(names.has(f.name))duplicates.add(f.name);names.add(f.name);}
      for(const folder of visible){
        const row=new Setting(listing).setName(folder.name);
        if(duplicates.has(folder.name))row.setDesc(`ID: ${folder.id}`);
        row.addButton(b=>b.setButtonText('Открыть').onClick(()=>void this.navigate([...this.trail,{id:folder.id,name:folder.name}])));
      }
    };
    const search=new Setting(el).setName('Найти папку в этом разделе').addSearch(input=>input.onChange(value=>{filter=value;draw();}));
    el.insertBefore(search.settingEl,listing);draw();
  }
}
