import { describe, expect, it } from 'vitest';
import { CareerSourceError } from '../src/infra/career-source';
import { classifyCareerSourceError } from '../src/infra/career-source-errors';
describe('safe source fault classification, no network',()=>{
 it.each([
  [new CareerSourceError('Source access restricted (403); stopped',403),'source_forbidden','source_response'],
  [new CareerSourceError('Source access restricted (429); stopped',429),'source_rate_limited','source_response'],
  [new CareerSourceError('Source returned an access challenge; stopped',200),'source_challenge','source_response'],
  [new CareerSourceError('Source redirect rejected',302),'source_redirect','source_response'],
  [new CareerSourceError('Source HTTP 503; stopped',503),'source_http','source_response'],
  [new CareerSourceError('Source request timed out'),'source_timeout','source_response'],
  [new CareerSourceError('Source network request failed; stopped'),'source_network','source_response'],
  [new CareerSourceError('Unsupported source serialization'),'source_decode_error','source_decode'],
  [new CareerSourceError('No announcements found; source structure changed'),'source_parser_error','source_parse'],
  [new CareerSourceError('Decoded source exceeds size limit'),'source_size_limit','source_decode'],
  [new Error('secret-key/raw-html/prompt/stack'),'source_internal_error','source_end'],
 ] as const)('separates %s without leaking raw text',(error,code,stage)=>{
  const result=classifyCareerSourceError(error);expect(result).toMatchObject({code,stage});expect(result.message).not.toContain('secret-key');
  expect(result.message).toContain('冷却 15 分钟');
 });
});
