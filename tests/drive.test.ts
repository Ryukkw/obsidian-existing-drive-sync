import { describe, expect, it } from 'vitest';
import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { Drive } from '../src/drive';
import { hash } from '../src/model';
const data=new TextEncoder().encode('test').buffer as ArrayBuffer;
const credentials={clientId:'test-client',clientSecret:'secret',refreshToken:'refresh'};
const file={id:'a',title:'a.md',mimeType:'text/markdown',etag:'etag',md5Checksum:hash(data)};
const folder={id:'root',title:'notes',mimeType:'application/vnd.google-apps.folder',etag:'root-etag'};
const reply=(json:unknown,status=200,headers:Record<string,string>={},arrayBuffer=data)=>({json,status,headers,arrayBuffer,text:JSON.stringify(json)}) as RequestUrlResponse;
function setup(handler:(p:RequestUrlParam)=>RequestUrlResponse|Promise<RequestUrlResponse>) {
  const calls:RequestUrlParam[]=[];
  const drive=new Drive(credentials,'root','.obsidian',async p=>{
    calls.push(p);
    if(p.url==='https://oauth2.googleapis.com/token')return reply({access_token:'access',expires_in:3600});
    expect(p.headers?.Authorization).toBe('Bearer access');
    return handler(p);
  });
  return {drive,calls};
}
describe('Drive transport',()=>{
  it('follows listing pagination and skips config and device state',async()=>{
    const {drive,calls}=setup(p=>{
      if(p.url.includes('/files/root?'))return reply(folder);
      if(new URL(p.url).searchParams.has('pageToken'))return reply({items:[{...file,id:'b',title:'b.md'}]});
      return reply({nextPageToken:'next',items:[file,{...folder,id:'config',title:'.obsidian'},{...folder,id:'state',title:'.drive-sync-state'}]});
    });
    expect(Object.keys(await drive.scan())).toEqual(['a.md','b.md']);
    expect(calls.filter(p=>p.url.includes('/token'))).toHaveLength(1);
  });
  it('browses only folders, includes every page and sorts by name',async()=>{
    const {drive,calls}=setup(p=>{
      const query=new URL(p.url).searchParams;
      expect(query.get('q')).toBe("'parent-id' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'");
      expect(query.get('fields')).toBe('nextPageToken,items(id,title)');
      if(query.has('pageToken'))return reply({items:[{id:'a',title:'Alpha'}]});
      return reply({items:[{id:'z',title:'Zulu'}],nextPageToken:'next'});
    });
    expect(await drive.listFolders('parent-id')).toEqual([{id:'a',name:'Alpha'},{id:'z',name:'Zulu'}]);
    expect(calls.every(p=>!p.method||p.method==='GET'||p.url.endsWith('/token'))).toBe(true);
  });
  it('lists shared folders without limiting them to My Drive root',async()=>{
    const {drive}=setup(p=>{
      expect(new URL(p.url).searchParams.get('q')).toBe("sharedWithMe = true and trashed = false and mimeType = 'application/vnd.google-apps.folder'");
      return reply({items:[{id:'shared-vault',title:'Vault'}]});
    });
    expect(await drive.listFolders('root',true)).toEqual([{id:'shared-vault',name:'Vault'}]);
  });
  it('does not silently show a partial folder selection after a later page fails',async()=>{
    const {drive}=setup(p=>new URL(p.url).searchParams.has('pageToken')?reply({},403):reply({items:[{id:'a',title:'Vault'}],nextPageToken:'next'}));
    await expect(drive.listFolders()).rejects.toThrow('403');
  });
  it('refuses duplicate names rather than choosing a random Drive file',async()=>{
    const {drive}=setup(p=>p.url.includes('/files/root?')?reply(folder):reply({items:[file,{...file,id:'b'}]}));
    await expect(drive.scan()).rejects.toThrow('одинаковые имена');
  });
  it('fails closed on access errors instead of presenting an empty folder',async()=>{
    const {drive}=setup(()=>reply({},403));await expect(drive.scan()).rejects.toThrow('403');
  });
  it('verifies downloaded binary checksums',async()=>{
    const {drive}=setup(()=>reply({},200,{},new ArrayBuffer(2)));
    await expect(drive.read({id:'a',etag:'etag',hash:file.md5Checksum})).rejects.toThrow('Контрольная сумма');
  });
  it('downloads unchanged content when media and metadata ETags differ (Drive regression)',async()=>{
    const {drive,calls}=setup(p=>p.headers?.['If-Match'] ? reply({},412) : reply({},200,{etag:'different-media-etag'},data));
    expect(await drive.read({id:'a',etag:'etag',hash:file.md5Checksum})).toEqual(data);
    expect(calls.at(-1)?.headers?.['If-Match']).toBeUndefined();
  });
  it('refuses to trash a file edited after the scan',async()=>{
    const {drive,calls}=setup(()=>reply({...file,etag:'new-etag'}));
    await expect(drive.remove({id:'a',etag:'etag',hash:file.md5Checksum})).rejects.toThrow('изменился');
    expect(calls.some(p=>p.url.endsWith('/trash'))).toBe(false);
  });
  it('uses the trash and conditional mutation, never permanent delete',async()=>{
    const {drive,calls}=setup(p=>p.url.endsWith('/trash')?reply({}):reply(file));
    await drive.remove({id:'a',etag:'etag',hash:file.md5Checksum});
    const last=calls.at(-1)!;expect(last.method).toBe('POST');expect(last.url.endsWith('/trash')).toBe(true);expect(last.headers?.['If-Match']).toBe('etag');
  });
  it('rejects a precondition failure',async()=>{
    const {drive}=setup(()=>reply({},412));
    await expect(drive.read({id:'a',etag:'etag',hash:file.md5Checksum})).rejects.toThrow('изменился');
  });
  it('creates a new file by resumable upload and validates result',async()=>{
    const {drive,calls}=setup(p=>{
      if(p.url.includes('/files/root?'))return reply(folder);
      if(p.url.includes('/files?')&&!p.url.includes('/upload/'))return reply({items:[]});
      if(p.url.includes('uploadType=resumable'))return reply({},200,{Location:'https://www.googleapis.com/session'});
      if(p.url.endsWith('/session'))return reply(file,201);
      throw new Error(`Unexpected URL ${p.url}`);
    });
    await drive.scan();expect(await drive.write('a.md',data)).toEqual({id:'a',etag:'etag',hash:hash(data)});
    expect(calls.at(-1)?.headers?.['Content-Range']).toBe('bytes 0-3/4');
  });
  it('stops an upload when the remote file changes before its final chunk',async()=>{
    let reads=0;
    const {drive,calls}=setup(p=>{
      if(p.url.includes('/files/a?')&&!p.url.includes('/upload/'))return reply(++reads===1?file:{...file,etag:'changed'});
      if(p.url.includes('uploadType=resumable'))return reply({},200,{location:'https://www.googleapis.com/session'});
      throw new Error('Unexpected upload');
    });
    await expect(drive.write('a.md',data,{id:'a',etag:'etag',hash:hash(data)})).rejects.toThrow('изменился');
    expect(calls.some(p=>p.url.endsWith('/session'))).toBe(false);
  });
  it('uploads a multi-chunk attachment without changing its bytes',async()=>{
    const large=new Uint8Array(1024*1024+13);large.fill(255);large[1024*1024]=7;
    const content=large.buffer;const accepted:ArrayBuffer[]=[];
    const {drive}=setup(p=>{
      if(p.url.includes('/files?')&&!p.url.includes('/upload/'))return reply({items:[]});
      if(p.url.includes('uploadType=resumable'))return reply({},200,{location:'https://www.googleapis.com/session'});
      if(p.url.endsWith('/session')){
        accepted.push(p.body as ArrayBuffer);
        if(accepted.length===1){expect(p.headers?.['Content-Range']).toBe(`bytes 0-1048575/${content.byteLength}`);return reply({},308,{range:'bytes=0-1048575'});}
        expect(p.headers?.['Content-Range']).toBe(`bytes 1048576-1048588/${content.byteLength}`);
        return reply({...file,md5Checksum:hash(content)},200);
      }
      throw new Error('Unexpected URL');
    });
    expect((await drive.write('large.bin',content)).hash).toBe(hash(content));
    const joined=new Uint8Array(content.byteLength);let offset=0;
    for(const part of accepted){joined.set(new Uint8Array(part),offset);offset+=part.byteLength;}
    expect(joined).toEqual(large);
  });
  it('uploads an empty note without skipping the final request',async()=>{
    const empty=new ArrayBuffer(0);
    const {drive,calls}=setup(p=>{
      if(p.url.includes('/files?')&&!p.url.includes('/upload/'))return reply({items:[]});
      if(p.url.includes('uploadType=resumable'))return reply({},200,{location:'https://www.googleapis.com/session'});
      if(p.url.endsWith('/session'))return reply({...file,md5Checksum:hash(empty)},201);
      throw new Error('Unexpected URL');
    });
    expect((await drive.write('empty.md',empty)).hash).toBe(hash(empty));
    expect(calls.at(-1)?.headers?.['Content-Range']).toBe('bytes */0');
  });
  it('does not retry an ambiguous create response',async()=>{
    const {drive,calls}=setup(p=>{
      if(p.url.includes('/files/root?'))return reply(folder);
      if(p.url.includes('/files?')&&!p.url.includes('/upload/'))return reply({items:[]});
      return reply({},503);
    });
    await drive.scan();await expect(drive.write('a.md',data)).rejects.toThrow('503');
    expect(calls.filter(p=>p.method==='POST'&&p.url.includes('uploadType'))).toHaveLength(1);
  });
});
