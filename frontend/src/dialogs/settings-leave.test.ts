import { afterEach, expect, it, vi } from 'vitest';
import { requestSettingsLeave, type SettingsLeaveRequest } from './settings-leave';
afterEach(()=>vi.unstubAllGlobals());
it('waits for a page decision before permitting logout and treats cancellation as a veto',async()=>{
 const target=new EventTarget();vi.stubGlobal('window',target);let decide!:(value:boolean)=>void;
 target.addEventListener('settings-before-leave',event=>{(event as CustomEvent<SettingsLeaveRequest>).detail.waitUntil(new Promise(resolve=>{decide=resolve;}));});
 let writes=0;const action=requestSettingsLeave().then(allowed=>{if(allowed)writes++;});await Promise.resolve();expect(writes).toBe(0);decide(false);await action;expect(writes).toBe(0);
 const retry=requestSettingsLeave().then(allowed=>{if(allowed)writes++;});decide(true);await retry;expect(writes).toBe(1);
});
it('preserves immediate vetoes and fails closed on rejected decisions',async()=>{
 const target=new EventTarget();vi.stubGlobal('window',target);const veto=(event:Event)=>event.preventDefault();target.addEventListener('settings-before-leave',veto);expect(await requestSettingsLeave()).toBe(false);target.removeEventListener('settings-before-leave',veto);
 target.addEventListener('settings-before-leave',event=>{(event as CustomEvent<SettingsLeaveRequest>).detail.waitUntil(Promise.reject(new Error('cancelled')));});expect(await requestSettingsLeave()).toBe(false);
});
