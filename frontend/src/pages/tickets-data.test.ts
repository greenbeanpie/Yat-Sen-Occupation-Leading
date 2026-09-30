import { describe, expect, it } from 'vitest';
import { mergeTicketRecords, ticketStatuses, ticketStatusLabel } from './tickets-data';

describe('ticket records and status labels', () => {
  it('has a Chinese label for every supported status', () => {
    expect(ticketStatuses.map(option => ticketStatusLabel(option.value))).toEqual(['待处理', '处理中', '等待用户回复', '已解决', '已关闭']);
  });

  it('appends additional list pages without duplicates', () => {
    expect(mergeTicketRecords([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }])).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  });

  it('prepends older messages while preserving newer copies and chronological order', () => {
    expect(mergeTicketRecords([{ id: 'old', body: 'first' }, { id: 'shared', body: 'old copy' }], [{ id: 'shared', body: 'current copy' }, { id: 'new', body: 'latest' }])).toEqual([
      { id: 'old', body: 'first' }, { id: 'shared', body: 'current copy' }, { id: 'new', body: 'latest' },
    ]);
  });
});
