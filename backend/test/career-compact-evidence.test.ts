import { describe, expect, it } from 'vitest';
import { createSnapshot, extractAnnouncement, validateCandidate } from '../src/prototypes/career-announcement';
import { modelSourceLines, recoverCompactCandidate } from '../src/prototypes/career-evidence';
import expected from './fixtures/career-source/expected.json';

const metadata = { url: 'https://career.sysu.edu.cn/campus/view/id/997448', numericId: '997448', retrievedAt: '2026-10-01T12:40:00Z', originalDate: null, sourceExpiry: null, captureMethod: 'static-html-text' as const, partial: true };
const text = '招聘🧪\n\n语文教师\n学历：硕士及以上\n地点：广州\n数学教师\n学历：本科及以上\n地点：深圳\n简历投递截止：2026年11月22日\n过期时间：2026-11-30';
const compact = () => ({ schemaVersion: 2, title: { value: '招聘🧪', lines: [1, 1] }, employer: null, applicationDeadline: null, sharedRequirements: [], positions: [
  { title: { value: '语文教师', lines: [2, 2] }, sectionLines: [2, 4], degree: { value: '硕士及以上', lines: [3, 3] }, locations: [{ value: '广州', lines: [4, 4] }], requirements: null },
  { title: { value: '数学教师', lines: [5, 5] }, sectionLines: [5, 7], degree: { value: '本科及以上', lines: [6, 6] }, locations: [{ value: '深圳', lines: [7, 7] }], requirements: null },
], ambiguities: [] });

describe('compact model references and server-recovered evidence', () => {
  it('preserves UTF-16 original offsets and omitted blank lines, including distinct role facts', async () => {
    const source = await createSnapshot(metadata, text);
    expect(modelSourceLines(source)[1]).toEqual([2, '语文教师']);
    const result = validateCandidate(source, recoverCompactCandidate(source, compact()));
    expect(result.schemaVersion).toBe(1); expect(result.positions.map(role => role.degree?.value)).toEqual(['硕士及以上', '本科及以上']);
    expect(result.positions.map(role => role.location?.value)).toEqual(['广州', '深圳']);
    expect(result.title?.evidence).toEqual({ start: 0, end: 4, quote: '招聘🧪' });
    for (const role of result.positions) {
      expect(source.text.slice(role.section.start, role.section.end)).toBe(role.section.quote);
      expect(source.text.slice(role.degree!.evidence.start, role.degree!.evidence.end)).toBe(role.degree!.evidence.quote);
    }
  });
  it.each([[0, 1], [2, 1], [1, 99], [1.5, 2]])('rejects invalid line range %j before accepting evidence', async (first, last) => {
    const source = await createSnapshot(metadata, text), data = compact(); data.title!.lines = [first, last];
    expect(() => recoverCompactCandidate(source, data)).toThrow();
  });
  it('rejects conflicting extra quotes, fields and legacy verbose output', async () => {
    const source = await createSnapshot(metadata, text), data = compact();
    expect(() => recoverCompactCandidate(source, { ...data, sourceText: 'copied source' })).toThrow();
    expect(() => recoverCompactCandidate(source, { ...data, title: { ...data.title, quote: 'copied source' } })).toThrow();
    expect(() => recoverCompactCandidate(source, { ...data, title: { lines: [1, 1], value: null } })).toThrow();
    expect(() => recoverCompactCandidate(source, { ...data, schemaVersion: 1 })).toThrow();
  });
  it('still rejects fabrication, cross-role references and overlap after recovery', async () => {
    const source = await createSnapshot(metadata, text), fabricated = compact(); fabricated.positions[0]!.degree.value = '博士';
    expect(() => validateCandidate(source, recoverCompactCandidate(source, fabricated))).toThrow('Unsupported value');
    const mixed = compact(); mixed.positions[0]!.degree = { value: '本科及以上', lines: [6, 6] };
    expect(() => validateCandidate(source, recoverCompactCandidate(source, mixed))).toThrow('Cross-position');
    const overlap = compact(); overlap.positions[0]!.sectionLines = [2, 6];
    expect(() => validateCandidate(source, recoverCompactCandidate(source, overlap))).toThrow('Overlapping');
  });
  it('keeps unknowns null and separates real cutoff from website expiry', async () => {
    const source = await createSnapshot(metadata, text), data = compact();
    expect(validateCandidate(source, recoverCompactCandidate(source, data)).applicationDeadline).toBeNull();
    data.applicationDeadline = { value: '2026年11月22日', lines: [8, 8] } as never;
    expect(validateCandidate(source, recoverCompactCandidate(source, data)).applicationDeadline?.value).toBe('2026年11月22日');
    data.applicationDeadline = { value: '2026-11-30', lines: [9, 9] } as never;
    expect(() => validateCandidate(source, recoverCompactCandidate(source, data))).toThrow('deadline');
  });
  it('tolerates omitted source information and fills the entire fixed unknown checklist', async () => {
    const source = await createSnapshot(metadata, '公告标题：仅图片岗位公告\n正文：');
    const result = validateCandidate(source, recoverCompactCandidate(source, { schemaVersion: 2 }));
    expect(result.positions).toEqual([]); expect(result.recruitmentCount).toBeNull(); expect(result.salary).toBeNull();
    expect(result.applicationDeadline).toBeNull(); expect(result.applicationChannels).toBeNull();
    expect(Object.keys(result.information!)).toEqual(['title', 'employer', 'applicationDeadline', 'recruitmentCount', 'salary', 'applicationChannels', 'requiredMaterials', 'sharedRequirements']);
    expect(Object.values(result.information!).every(info => info.status === 'unknown' && info.facts.length === 0)).toBe(true);
    expect(result.missingInformation).toContain('招聘总人数：未提供/待核实'); expect(result.partial).toBe(true);
  });
  it('keeps a real title-year contradiction as two evidenced alternatives, not a chosen title', async () => {
    const source = await createSnapshot(metadata, '2026年教师招聘公告\n2027年教师招聘简章');
    const result = validateCandidate(source, recoverCompactCandidate(source, { schemaVersion: 2, title: { status: 'conflict', alternatives: [
      { value: '2026年教师招聘公告', lines: [1, 1] }, { value: '2027年教师招聘简章', lines: [2, 2] },
    ] } }));
    expect(result.title).toBeNull(); expect(result.information?.title.status).toBe('conflict'); expect(result.information?.title.facts).toHaveLength(2);
    expect(result.missingInformation).toContain('公告标题：信息冲突，待核实');
    expect(() => validateCandidate(source, recoverCompactCandidate(source, { schemaVersion: 2, title: { status: 'conflict', alternatives: [
      { value: '2026年教师招聘公告', lines: [1, 1] }, { value: '2026年教师招聘公告', lines: [1, 1] },
    ] } }))).toThrow('status/evidence');
  });
  it('does not accept website expiry as one purported deadline conflict alternative', async () => {
    const source = await createSnapshot(metadata, text);
    expect(() => validateCandidate(source, recoverCompactCandidate(source, { schemaVersion: 2, applicationDeadline: { status: 'conflict', alternatives: [
      { value: '2026年11月22日', lines: [8, 8] }, { value: '2026-11-30', lines: [9, 9] },
    ] } }))).toThrow('deadline');
  });
  it('supports independently evidenced typed lists and explicit partial at array limits, without cross-role mixing', async () => {
    const body = '单位教师招聘总计36名\n岗位：工程师5名\n学历：本科及以上\n计算机科学\n软件工程\n工作地：广州\n工作地：深圳\n工资：面议\n提交简历和成绩单\n官网报名';
    const source = await createSnapshot(metadata, body);
    const data = { schemaVersion: 2, recruitmentCount: { value: '36名', lines: [1, 1] }, applicationChannels: [{ value: '官网报名', lines: [10, 10] }], positions: [{
      title: { value: '工程师', lines: [2, 2] }, sectionLines: [2, 9], headcount: { value: '5名', lines: [2, 2] }, degree: { value: '本科及以上', lines: [3, 3] },
      majors: [{ value: '计算机科学', lines: [4, 4] }, { value: '软件工程', lines: [5, 5] }], locations: [{ value: '广州', lines: [6, 6] }, { value: '深圳', lines: [7, 7] }],
      salary: { value: '面议', lines: [8, 8] }, requiredMaterials: [{ value: '简历', lines: [9, 9] }, { value: '成绩单', lines: [9, 9] }],
    }] };
    const result = validateCandidate(source, recoverCompactCandidate(source, data));
    expect(result.positions[0]?.majors?.map(fact => fact.value)).toEqual(['计算机科学', '软件工程']);
    expect(result.positions[0]?.locations?.map(fact => fact.value)).toEqual(['广州', '深圳']); expect(result.positions[0]?.headcount?.value).toBe('5名');
    expect(result.recruitmentCount?.value).toBe('36名'); expect(result.salary).toBeNull();
    const capped = { ...data, positions: [{ ...data.positions[0], majors: Array.from({ length: 11 }, () => ({ value: '计算机科学', lines: [4, 4] })) }] };
    const partial = validateCandidate(source, recoverCompactCandidate(source, capped));
    expect(partial.positions[0]?.majors).toHaveLength(10); expect(partial.partial).toBe(true); expect(partial.truncatedFields?.join()).toContain('10项展示上限');
    const mixed = { ...data, salary: { value: '面议', lines: [8, 8] } };
    expect(() => validateCandidate(source, recoverCompactCandidate(source, mixed))).toThrow('announcement-wide');
  });
  it('produces a materially smaller nine-role JSON fixture without dropping source evidence from the review', async () => {
    const detail = expected.details.find(item => item.id === '997448')!;
    const source = await createSnapshot(metadata, detail.text), rows = modelSourceLines(source);
    const data = { schemaVersion: 2, title: null, employer: null, applicationDeadline: null, sharedRequirements: [], positions: [] as ReturnType<typeof compact>['positions'], ambiguities: ['公告标题2026与正文2027存在矛盾；网站过期时间不作为申请截止日期'] };
    const headings = rows.filter(([, line]) => /^（[一二三四五六七八九]）/.test(line));
    expect(headings).toHaveLength(9);
    for (let index = 0; index < headings.length; index++) {
      const [first, heading] = headings[index]!, last = (headings[index + 1]?.[0] ?? rows.find(([, line]) => /^三、/.test(line))![0]) - 1;
      const title = heading.match(/[语文数学英语物理化生政治历史地]+教师/)![0];
      const degreeRow = rows.find(([id, line]) => id >= first && id <= last && /^(?:硕士研究生|本科)及以上$/.test(line));
      data.positions.push({ title: { value: title, lines: [first, first] }, sectionLines: [first, last], degree: degreeRow ? { value: degreeRow[1], lines: [degreeRow[0], degreeRow[0]] } : null as never, locations: null as never, requirements: null });
    }
    const recovered = validateCandidate(source, recoverCompactCandidate(source, data));
    expect(recovered.positions).toHaveLength(9); expect(recovered.positions.every(role => role.location === null)).toBe(true);
    const verbose = { schemaVersion: 1, title: recovered.title, employer: recovered.employer, applicationDeadline: recovered.applicationDeadline,
      sharedRequirements: recovered.sharedRequirements, positions: recovered.positions.map(role => ({ title: role.title, section: role.section, location: role.location, degree: role.degree, requirements: role.requirements })), ambiguities: recovered.ambiguities };
    expect(JSON.stringify(data).length).toBeLessThan(JSON.stringify(verbose).length / 2);
    expect(JSON.stringify(data)).not.toContain('quote'); expect(recovered.positions[0]!.section.quote).toContain('岗位要求');
    let calls = 0;
    const result = await extractAnnouncement(source, { name: 'fixture-only', complete: async (_messages, options) => {
      calls++; expect(options).toMatchObject({ maxAttempts: 1, timeoutMs: 30000, rejectRedirects: true }); return JSON.stringify(data);
    } });
    expect(result.candidate).toEqual(recovered); expect(calls).toBe(1);
  });
});
