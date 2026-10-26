import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
const [clientPath, outputPath = 'google-drive.credentials.json'] = process.argv.slice(2);
if (!clientPath) {
  console.error('Использование: npm run auth -- /путь/к/client_secret.json [файл-подключения.credentials.json]');
  process.exit(1);
}
const parsed = JSON.parse(await readFile(clientPath,'utf8'));
const client = parsed.installed;
if (!client?.client_id || !client.client_secret) throw new Error('Нужен OAuth client типа Desktop app, скачанный в Google Cloud Console.');
const state = randomBytes(32).toString('hex');
const verifier = randomBytes(48).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
let busy = false;
const server = createServer(async (req,res)=>{
  const callback = new URL(req.url,'http://127.0.0.1');
  if (callback.pathname !== '/callback') {res.writeHead(404);res.end();return;}
  const incoming = callback.searchParams.get('state') ?? '';
  if (!/^[a-f0-9]{64}$/.test(incoming) || !timingSafeEqual(Buffer.from(incoming),Buffer.from(state))) {res.writeHead(403);res.end('Invalid state');return;}
  if (busy) {res.writeHead(409);res.end('Authorization already processing');return;}
  busy = true;
  try {
    const code = callback.searchParams.get('code');
    if (!code) throw new Error('Вход отменён или Google не предоставил доступ.');
    const response = await fetch('https://oauth2.googleapis.com/token',{method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({client_id:client.client_id,client_secret:client.client_secret,code,
        redirect_uri:redirect,grant_type:'authorization_code',code_verifier:verifier})});
    if (!response.ok) throw new Error(`Google OAuth: HTTP ${response.status}.`);
    const tokens = await response.json();
    if (!tokens.refresh_token) throw new Error('Google не вернул refresh token. Повторите вход с предоставлением доступа.');
    const destination = resolve(outputPath);
    await writeFile(destination,JSON.stringify({clientId:client.client_id,clientSecret:client.client_secret,refreshToken:tokens.refresh_token},null,2),{mode:0o600,flag:'wx'});
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    res.end('<!doctype html><meta charset="utf-8"><title>Готово</title><h1>Google подключён</h1><p>Вернитесь в терминал. Эту вкладку можно закрыть.</p>');
    console.log(`Подключение сохранено: ${destination}\nПеренесите файл на iPhone через AirDrop и вставьте его содержимое в настройки плагина. После импорта удалите переносную копию. Не отправляйте её в чат: она даёт доступ к Drive.`);
    clearTimeout(timeout);server.close();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Ошибка авторизации.');
    res.writeHead(400,{'Content-Type':'text/plain; charset=utf-8'});res.end('Не удалось завершить подключение. Подробности в терминале.');
    clearTimeout(timeout);server.close();process.exitCode=1;
  }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const redirect = `http://127.0.0.1:${server.address().port}/callback`;
const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
url.search = new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',
  scope:'https://www.googleapis.com/auth/drive',access_type:'offline',prompt:'consent',state,
  code_challenge:challenge,code_challenge_method:'S256'}).toString();
console.log('Открываю Google в браузере. Если вкладка не появилась, откройте ссылку:\n'+url);
const command = process.platform==='darwin' ? 'open' : process.platform==='win32' ? 'explorer.exe' : 'xdg-open';
spawn(command,[url.toString()],{stdio:'ignore'}).on('error',()=>{});
const timeout = setTimeout(()=>{console.error('Время ожидания входа истекло. Запустите команду повторно.');server.close();process.exitCode=1;},30*60_000);
