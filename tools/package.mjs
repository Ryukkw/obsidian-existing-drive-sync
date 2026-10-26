import { mkdir, copyFile, writeFile, rm, cp, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const directory='dist/existing-drive-sync';
await mkdir(directory,{recursive:true});
for (const name of ['main.js','manifest.json','README.md']) await copyFile(name,`${directory}/${name}`);
await rm('dist/existing-drive-sync.zip',{force:true});
execFileSync('zip',['-qr','existing-drive-sync.zip','existing-drive-sync'],{cwd:'dist'});
const starter='dist/Drive Notes/.obsidian/plugins/existing-drive-sync';
await mkdir(starter,{recursive:true});
for (const name of ['main.js','manifest.json']) await copyFile(name,`${starter}/${name}`);

await writeFile('dist/Drive Notes/.obsidian/community-plugins.json',JSON.stringify(['existing-drive-sync']));
await rm('dist/Drive Notes/Начните здесь.md',{force:true});
await writeFile('dist/Drive Notes/START-HERE.md',`# Подключение заметок Google Drive

Если вы видите эту заметку, папка хранилища распаковалась.

1. Перенесите целиком папку Drive Notes в «Файлы → На моём iPhone → Obsidian».
2. Откройте Drive Notes в Obsidian.
3. Настройки → Сторонние плагины: разрешите их и включите Existing Drive Sync.
4. В настройках Existing Drive Sync сохраните подключение Google.
5. Нажмите «Выбрать папку», откройте папку своего vault и нажмите «Синхронизировать этот vault».
6. Удалите эту стартовую заметку, затем нажмите «Синхронизировать сейчас» и включите автоматическую синхронизацию.

Плагин уже находится в скрытой папке .obsidian. Приложение «Файлы» может не показывать её — копируйте всё хранилище целиком.

Вход Google в этой тестовой версии настраивается один раз через помощник на Mac; обычной кнопки «Войти в Google» пока нет. Полная инструкция входит в архив отдельным файлом INSTALL.txt.
`, 'utf8');
await copyFile('README.md','dist/INSTALL.txt');
for (const name of ['Drive-Notes-iPhone.zip','Drive-Notes-iPhone-visible.zip']) {
  await rm(`dist/${name}`,{force:true});
  execFileSync('zip',['-qr',name,'Drive Notes','INSTALL.txt'],{cwd:'dist'});
}
console.log('Готово: dist/existing-drive-sync.zip и dist/Drive-Notes-iPhone-visible.zip');

await rm('dist/1',{recursive:true,force:true});
await cp('dist/Drive Notes','dist/1',{recursive:true});
await writeFile('dist/1/START-HERE.md',`# Подключение Google Drive

Плагин уже установлен внутри этой папки 1, в скрытом каталоге .obsidian.

1. Закройте Obsidian на iPhone.
2. В «Файлы → На моём iPhone → Obsidian» переименуйте прежнюю пустую папку 1 в 1-backup.
3. Перенесите сюда целиком папку 1 из архива. Не кладите её внутрь 1-backup или другой папки 1.
4. Откройте Obsidian и хранилище 1.
5. Настройки → Сторонние плагины → разрешить → Existing Drive Sync → включить.
6. Настройте подключение Google, затем «Выбрать папку» → папка вашего vault на Google Drive → «Синхронизировать этот vault».
7. Удалите эту стартовую заметку до первой синхронизации.

Полная инструкция по подключению Google находится в INSTALL.txt рядом с папкой 1 в архиве.
`, 'utf8');
await rm('dist/Vault-1-iPhone.zip',{force:true});
execFileSync('zip',['-qr','Vault-1-iPhone.zip','1','INSTALL.txt'],{cwd:'dist'});
console.log('Также готов: dist/Vault-1-iPhone.zip');
// A separate flat archive makes both plugin files visible in iOS Files before installation.
execFileSync('python3',['-c',`import zipfile
with zipfile.ZipFile('dist/Drive-Sync-plugin-files.zip','w',zipfile.ZIP_DEFLATED) as archive:
    for name in ('main.js','manifest.json'):
        archive.write(name,name)
`]);
console.log('Видимые файлы плагина: dist/Drive-Sync-plugin-files.zip');

const releaseVersion=JSON.parse(await readFile('manifest.json','utf8')).version;
await copyFile('dist/existing-drive-sync.zip',`dist/existing-drive-sync-${releaseVersion}.zip`);
await rm('dist/1-ready.zip',{force:true});
execFileSync('zip',['-qr','1-ready.zip','1'],{cwd:'dist'});
