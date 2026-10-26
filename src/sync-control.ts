export class SyncCancelledError extends Error {
  constructor(){super('Синхронизация отменена при выгрузке плагина.');this.name='SyncCancelledError';}
}
export function checkActive(signal?:AbortSignal):void {
  if(signal?.aborted)throw new SyncCancelledError();
}
