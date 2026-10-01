import type { components } from '../api/schema';
export type AiProbeReport = components['schemas']['AiSettingsTestResponse'];
export type AiProbeRequest = components['schemas']['AiSettingsTestRequest'];
/** A synchronous single-flight gate. No key, form draft, prompt, or automatic retry is accepted. */
export function createAiProbeRunner(send: (body: AiProbeRequest)=>Promise<AiProbeReport>) {
  let pending: Promise<AiProbeReport>|null = null;
  return {
    get pending() { return pending !== null; },
    run(baseVersion: number): Promise<AiProbeReport> {
      if (pending) return pending;
      const body = { baseVersion, requestId: crypto.randomUUID() };
      const request = Promise.resolve().then(()=>send(body));
      pending = request;
      void request.then(()=>{if(pending===request)pending=null;},()=>{if(pending===request)pending=null;});
      return request;
    },
  };
}
