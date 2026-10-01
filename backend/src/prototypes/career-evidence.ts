import { z } from 'zod';
import type { Candidate, Snapshot } from './career-announcement';

const Lines = z.tuple([z.number().int().positive(), z.number().int().positive()]);
const Fact = z.object({ value: z.string().min(1).max(500), lines: Lines }).strict();
const Slot = z.union([Fact, z.object({ status: z.literal('unknown') }).strict(),
  z.object({ status: z.literal('conflict'), alternatives: z.array(Fact).min(2).max(3) }).strict()]).nullable();
const ArraySlot = z.array(Slot).max(100).nullable();
/** Fixed internal fields; omitted fields are unknown, never invented. */
export const CompactAnnouncementCandidate = z.object({
  schemaVersion: z.literal(2), title: Slot.default(null), employer: Slot.default(null), applicationDeadline: Slot.default(null),
  recruitmentCount: Slot.default(null), salary: Slot.default(null), applicationChannels: ArraySlot.default(null), requiredMaterials: ArraySlot.default(null),
  sharedRequirements: ArraySlot.default(null),
  positions: z.array(z.object({ title: Slot.default(null), sectionLines: Lines,
    locations: ArraySlot.default(null), degree: Slot.default(null), headcount: Slot.default(null),
    majors: ArraySlot.default(null), salary: Slot.default(null), requiredMaterials: ArraySlot.default(null), requirements: ArraySlot.default(null),
  }).strict()).max(50).default([]),
  ambiguities: z.array(z.string().min(1).max(500)).max(30).default([]),
}).strict();

interface SourceLine { id: number; text: string; start: number; end: number }
function catalogue(source: Snapshot): SourceLine[] {
  const lines: SourceLine[] = [];
  let offset = 0;
  for (const text of source.text.split('\n')) {
    // Keep original offsets and text; omit empty display rows, not their source bytes.
    if (text.trim()) lines.push({ id: lines.length + 1, text, start: offset, end: offset + text.length });
    offset += text.length + 1;
  }
  if (!lines.length || lines.length > 4000) throw new Error('Source line catalogue exceeds limit');
  return lines;
}
export function modelSourceLines(source: Snapshot): [number, string][] {
  return catalogue(source).map(line => [line.id, line.text]);
}

/** Derive exact evidence from immutable source, never from generated quotes or offsets. */
export function recoverCompactCandidate(source: Snapshot, data: unknown): Candidate {
  const compact = CompactAnnouncementCandidate.parse(data), lines = catalogue(source);
  const span = (ids: z.infer<typeof Lines>) => {
    const [first, last] = ids;
    const start = lines[first - 1], end = lines[last - 1];
    if (!start || !end || last < first) throw new Error('Invalid source line range');
    const quote = source.text.slice(start.start, end.end);
    if (!quote || quote.length > 2000 || source.text.slice(start.start, start.end) !== start.text
      || source.text.slice(end.start, end.end) !== end.text) throw new Error('Source evidence range mismatch');
    return { start: start.start, end: end.end, quote };
  };
  type EvidenceFact = NonNullable<Candidate['title']>;
  type Information = NonNullable<Candidate['information']>['title'];
  const fact = (item: z.infer<typeof Fact>): EvidenceFact => ({ value: item.value, evidence: span(item.lines) });
  const information = (slot: z.infer<typeof Slot>): Information => {
    if (!slot || ('status' in slot && slot.status === 'unknown')) return { status: 'unknown', facts: [] };
    if ('status' in slot) return { status: 'conflict', facts: slot.alternatives.map(fact) };
    return { status: 'known', facts: [fact(slot)] };
  };
  const truncatedFields: string[] = [];
  const arrayInformation = (slots: z.infer<typeof ArraySlot>, label: string, max = 10): Information => {
    if (!slots?.length) return { status: 'unknown', facts: [] };
    if (slots.length >= max) truncatedFields.push(`${label}（已达${max}项展示上限，完整性待核对）`);
    const rows = slots.slice(0, max).map(information), facts = rows.flatMap(row => row.facts).slice(0, 30);
    if (rows.some(row => row.status === 'unknown')) truncatedFields.push(`${label}（含未知条目）`);
    if (!facts.length) return { status: 'unknown', facts: [] };
    return { status: rows.some(row => row.status === 'conflict') ? 'conflict' : 'known', facts };
  };
  const known = (info: Information) => info.status === 'known' ? info.facts[0]! : null;
  const knownArray = (info: Information) => info.status === 'known' ? info.facts : null;
  const global = {
    title: information(compact.title), employer: information(compact.employer), applicationDeadline: information(compact.applicationDeadline),
    recruitmentCount: information(compact.recruitmentCount), salary: information(compact.salary),
    applicationChannels: arrayInformation(compact.applicationChannels, '公告：申请渠道'), requiredMaterials: arrayInformation(compact.requiredMaterials, '公告：申请材料'),
    sharedRequirements: arrayInformation(compact.sharedRequirements, '公告：共同要求', 30),
  };
  const missingInformation: string[] = [];
  const markMissing = (info: Record<string, Information>, labels: Record<string, string>, prefix = '') => {
    for (const [field, item] of Object.entries(info)) if (item.status !== 'known') missingInformation.push(`${prefix}${labels[field]}：${item.status === 'conflict' ? '信息冲突，待核实' : '未提供/待核实'}`);
  };
  markMissing(global, { title: '公告标题', employer: '用人单位', applicationDeadline: '申请截止日期', recruitmentCount: '招聘总人数', salary: '公告薪资待遇', applicationChannels: '申请渠道', requiredMaterials: '申请材料', sharedRequirements: '共同要求' });
  const positions = compact.positions.map((position, index) => {
    const prefix = `岗位${index + 1}：`;
    const info = { title: information(position.title), locations: arrayInformation(position.locations, prefix + '工作地点'),
      degree: information(position.degree), headcount: information(position.headcount), salary: information(position.salary),
      majors: arrayInformation(position.majors, prefix + '专业要求'), requiredMaterials: arrayInformation(position.requiredMaterials, prefix + '申请材料'),
      requirements: arrayInformation(position.requirements, prefix + '岗位要求', 30) };
    markMissing(info, { title: '岗位名称', locations: '工作地点', degree: '学历', headcount: '招聘人数', majors: '专业要求', salary: '薪资待遇', requiredMaterials: '申请材料', requirements: '岗位要求' }, prefix);
    return { title: known(info.title), section: span(position.sectionLines), location: known(info.locations), locations: knownArray(info.locations),
      degree: known(info.degree), headcount: known(info.headcount), salary: known(info.salary), majors: knownArray(info.majors), requiredMaterials: knownArray(info.requiredMaterials),
      requirements: knownArray(info.requirements), information: info };
  });
  if (!positions.length) missingInformation.push('岗位分组：未提供/待核实（可能仅图片或未提取）');
  return { schemaVersion: 1, title: known(global.title), employer: known(global.employer), applicationDeadline: known(global.applicationDeadline),
    recruitmentCount: known(global.recruitmentCount), salary: known(global.salary), applicationChannels: knownArray(global.applicationChannels), requiredMaterials: knownArray(global.requiredMaterials),
    sharedRequirements: knownArray(global.sharedRequirements) ?? [], positions, ambiguities: compact.ambiguities,
    information: global, missingInformation, partial: source.metadata.partial || truncatedFields.length > 0,
    truncatedFields,
  };
}
