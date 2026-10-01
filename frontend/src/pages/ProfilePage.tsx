import { useState } from 'react';
import { Check, FileUp, Pencil, Trash2, Upload } from 'lucide-react';
import { api, del, get, pollOperation, post, put } from '../api/client';
import type { components } from '../api/schema';
import { ActionForm, Badge, DataRows, JsonPreview, Loading, PageHead, Panel, ResourceNotice, useResource } from '../components';
import type { ActionContext } from '../components';
import { cacheKey, cacheValue, readCached, withOfflineQueue } from '../offline';
import { platform } from '../platform';

type Profile = components['schemas']['Profile'];
type Experience = components['schemas']['Experience'];
type EvidenceBundle = components['schemas']['EvidenceBundle'];
type DocumentRecord = components['schemas']['Document'];
type ParseDraft = components['schemas']['ParseDraft'];

const EXPERIENCE_KINDS = [
  { value: 'project', label: '项目' },
  { value: 'internship', label: '实习' },
  { value: 'research', label: '研究' },
  { value: 'competition', label: '竞赛' },
  { value: 'other', label: '其他' },
];

const RESUME_ACCEPT = '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function ProfilePage({ context }: { context: ActionContext }) {
  const profileResource = useResource<Profile>('/profile', context.refresh, context.userId);
  const evidenceResource = useResource<EvidenceBundle>('/evidence', context.refresh, context.userId);
  const [file, setFile] = useState<File | null>(null);
  const [document, setDocument] = useState<DocumentRecord | null>(null);
  const [draft, setDraft] = useState<ParseDraft | null>(null);
  const [confirmedByStudent, setConfirmedByStudent] = useState(false);
  const profile = profileResource.data;
  const evidence = evidenceResource.data;

  async function chooseResume() {
    const picked = await platform.files.pickFile({ accept: RESUME_ACCEPT });
    if (picked) setFile(picked);
  }

  async function saveProfile(values: Record<string, string>) {
    if (!profile) return false;
    const payload: components['schemas']['ProfilePayload'] = {
      targetRoles: csv(values.targetRoles),
      industries: csv(values.industries),
      graduationYear: values.graduationYear ? Number(values.graduationYear) : null,
      degree: values.degree ? values.degree as NonNullable<Profile['degree']> : null,
      preferredLocations: csv(values.preferredLocations),
      weeklyTimeBudgetHours: values.weeklyTimeBudgetHours ? Number(values.weeklyTimeBudgetHours) : null,
    };
    const entityId = profile.id || crypto.randomUUID();
    return context.run(() => withOfflineQueue(
      () => put('/profile', { ...payload, baseVersion: profile.version }),
      { userId: context.userId, entity: 'profile', entityId, baseVersion: profile.version, action: 'upsert', payload },
      async () => {
        const local: Profile = {
          ...profile,
          ...payload,
          id: entityId,
          version: profile.version + 1,
          createdAt: profile.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await cacheValue(cacheKey(context.userId, 'api:/profile'), local);
      },
    ), '画像已保存；网络不可用时已写入本机队列');
  }

  async function submitResume() {
    if (!file) return;
    await context.run(async () => {
      const form = new FormData();
      form.append('file', file);
      const uploaded = await api<DocumentRecord>('/documents', { method: 'POST', body: form });
      setDocument(uploaded);
      setDraft(null);
      setConfirmedByStudent(false);
      const accepted = await post<components['schemas']['AcceptedResponse']>(`/documents/${uploaded.id}/parse`);
      const operation = await pollOperation(accepted.operationId);
      const parsed = await get<ParseDraft>(`/documents/${uploaded.id}/draft`);
      setDraft(parsed);
      setFile(null);
      if (operation.status === 'succeeded') setDocument(uploaded);
    }, '解析草稿已就绪，请逐项核对后再确认');
  }

  async function confirmResume() {
    if (!document || !draft || !confirmedByStudent) return;
    const saved = await context.run(
      () => post(`/documents/${document.id}/confirm`, { confirm: true }),
      '你已确认解析结果并加入画像',
    );
    if (saved) {
      setDraft(null);
      setDocument(null);
      setConfirmedByStudent(false);
    }
  }

  return <>
    <PageHead kicker="求职资料" title="你的求职资料" description="画像和经历可以离线修改。技能证据必须关联经历原文，并由你确认。"/>
    <div className="two-col profile-columns">
      <Panel title="求职偏好" description="画像更新后，旧匹配快照会被视为过期">
        {profileResource.loading && !profile && <Loading/>}
        <ResourceNotice error={profileResource.error}/>
        {profile && <ActionForm
          disabled={context.busy}
          label="保存画像"
          onSubmit={saveProfile}
          fields={[
            { name: 'targetRoles', label: '目标岗位（逗号分隔）', initialValue: profile.targetRoles.join(', ') },
            { name: 'industries', label: '目标行业（逗号分隔）', initialValue: profile.industries.join(', ') },
            { name: 'graduationYear', label: '毕业年份', type: 'number', min: '2000', max: '2100', initialValue: stringValue(profile.graduationYear) },
            { name: 'degree', label: '学历', options: [
              { value: '', label: '未设置' }, { value: 'associate', label: '大专' },
              { value: 'bachelor', label: '本科' }, { value: 'master', label: '硕士' }, { value: 'phd', label: '博士' },
            ], initialValue: profile.degree ?? '' },
            { name: 'preferredLocations', label: '期望地点（逗号分隔）', initialValue: profile.preferredLocations.join(', ') },
            // Step is measured from `min`, so a non-matching min rejects whole
            // numbers such as 8 while the browser blocks the save silently.
            { name: 'weeklyTimeBudgetHours', label: '每周求职时间（小时）', type: 'number', min: '0.5', max: '80', step: '0.5', initialValue: stringValue(profile.weeklyTimeBudgetHours) },
          ]}
        />}
        {profile && <p className="muted">当前版本：{profile.version || '尚未保存'} · 偏好未填写时不会被当作匹配通过。</p>}
      </Panel>

      <Panel title="简历导入" description="有文本层的 PDF 或 DOCX；任意文件只展示服务端真实解析结果">
        <button type="button" className="upload-box" disabled={context.busy} onClick={() => void chooseResume()}>
          <FileUp size={22}/>
          <b>{file?.name ?? '选择 PDF 或 DOCX 简历'}</b>
          <small>单文件最大 10 MB；扫描件和加密文件需手动录入</small>
        </button>
        <button className="btn primary" disabled={!file || context.busy} onClick={() => void submitResume()}>
          <Upload size={16}/>上传并解析
        </button>
        {document && !draft && <p className="muted">文档状态：{document.status}。解析失败时请查看服务端错误，再手动补充经历。</p>}
        {draft && <div className="draft-review">
          <div className="row-title">解析草稿 <Badge value={draft.status}/></div>
          <p>下面是后端返回的候选内容。逐条核对来源，不确认的内容不会进入正式画像。</p>
          <JsonPreview value={draft.result}/>
          <label className="check-row"><input type="checkbox" checked={confirmedByStudent} onChange={(event) => setConfirmedByStudent(event.target.checked)}/><span>我已核对以上内容，确认写入画像</span></label>
          <button className="btn primary" disabled={!confirmedByStudent || context.busy || draft.status !== 'ready'} onClick={() => void confirmResume()}>
            <Check size={16}/>确认解析结果
          </button>
        </div>}
      </Panel>
    </div>

    <div className="two-col">
      <Panel title="经历" description="编辑时带上服务端版本；离线新增和修改会在同步中心排队">
        <ResourceNotice error={evidenceResource.error}/>

        <DataRows items={evidence?.experiences ?? []} loading={evidenceResource.loading} empty="还没有经历。手动补充经历后，才能将技能和岗位差距与原文关联。">
          {(experience) => <ExperienceCard experience={experience} context={context} bundle={evidence!}/>}
        </DataRows>
        <ActionForm
          disabled={context.busy}
          label="添加经历"
          onSubmit={(values) => createExperience(values, evidence, context)}
          fields={experienceFields()}
        />
      </Panel>

      <Panel title="技能证据" description="引用必须命中经历原文；状态不会根据模型推断自动变成已确认">
        <DataRows items={evidence?.skills ?? []} loading={evidenceResource.loading} empty="还没有技能。先添加技能，再关联一条经历引用。">
          {(skill) => <div className="row-main"><div className="row-title">{skill.name}<Badge value="已记录"/></div><small>技能 ID：{skill.id}</small></div>}
        </DataRows>
        <ActionForm
          compact
          disabled={context.busy}
          label="添加技能"
          onSubmit={(values) => context.run(() => post('/evidence/skills', { name: values.name.trim() }), '技能已添加')}
          fields={[{ name: 'name', label: '技能名称', required: true, placeholder: '例如：SQL' }]}
        />
        <ActionForm
          disabled={context.busy || !evidence?.experiences.length || !evidence.skills.length}
          label="添加引用"
          onSubmit={(values) => context.run(() => post('/evidence/links', {
            skillId: values.skillId,
            experienceId: values.experienceId,
            quote: values.quote.trim(),
            status: 'pending',
          }), '引用已保存为待确认证据')}
          fields={[
            { name: 'skillId', label: '关联技能', required: true, options: (evidence?.skills ?? []).map((skill) => ({ value: skill.id, label: skill.name })) },
            { name: 'experienceId', label: '关联经历', required: true, options: (evidence?.experiences ?? []).map((experience) => ({ value: experience.id, label: `${experience.title} · ${experience.organization}` })) },
            { name: 'quote', label: '经历原文摘录', type: 'textarea', required: true, rows: 3, placeholder: '复制经历描述中的原句' },
          ]}
        />
        {(evidence?.links ?? []).map((link) => {
          const skill = evidence?.skills.find((candidate) => candidate.id === link.skillId);
          const experience = evidence?.experiences.find((candidate) => candidate.id === link.experienceId);
          return <article className="quote-card" key={link.id}>
            <div className="row-title">{skill?.name ?? '技能'} · {experience?.title ?? '经历'} <Badge value={link.status}/></div>
            <blockquote>{link.quote}</blockquote>
            {link.status === 'pending' && <div className="button-row">
              <button className="btn small primary" onClick={() => void context.run(() => put(`/evidence/links/${link.id}`, { status: 'confirmed' }), '证据已确认')}>确认</button>
              <button className="btn small secondary" onClick={() => void context.run(() => put(`/evidence/links/${link.id}`, { status: 'missing_evidence' }), '已标记缺少证据')}>缺少证据</button>
            </div>}
          </article>;
        })}
      </Panel>
    </div>
  </>;
}

function experienceFields(experience?: Experience) {
  return [
    { name: 'title', label: '经历标题', required: true, initialValue: experience?.title ?? '' },
    { name: 'organization', label: '组织 / 公司', initialValue: experience?.organization ?? '' },
    { name: 'kind', label: '类型', options: EXPERIENCE_KINDS, initialValue: experience?.kind ?? 'project' },
    { name: 'startDate', label: '开始日期', type: 'date', initialValue: experience?.startDate ?? '' },
    { name: 'endDate', label: '结束日期', type: 'date', initialValue: experience?.endDate ?? '' },
    { name: 'description', label: '经历原文描述', type: 'textarea', required: true, rows: 5, initialValue: experience?.description ?? '' },
  ];
}

function ExperienceCard({ experience, context, bundle }: { experience: Experience; context: ActionContext; bundle: EvidenceBundle }) {
  const [editing, setEditing] = useState(false);
  async function save(values: Record<string, string>) {
    const payload = experiencePayload(values);
    const saved = await context.run(() => withOfflineQueue(
      () => put(`/evidence/experiences/${experience.id}`, { ...payload, baseVersion: experience.version }),
      { userId: context.userId, entity: 'experience', entityId: experience.id, baseVersion: experience.version, action: 'upsert', payload },
      async () => updateEvidenceCache(context.userId, bundle, (current) => ({
        ...current,
        experiences: current.experiences.map((row) => row.id === experience.id ? { ...row, ...payload, version: row.version + 1 } : row),
      })),
    ), '经历已更新；离线修改已保存在本机队列');
    if (saved) setEditing(false);
    return saved;
  }

  async function remove() {
    await context.run(() => del(`/evidence/experiences/${experience.id}`), '经历已删除');
  }

  return <article className="experience-card">
    {editing ? <>
      <ActionForm disabled={context.busy} label="保存经历" onSubmit={save} fields={experienceFields(experience)}/>
      <button className="btn small secondary" onClick={() => setEditing(false)}>取消编辑</button>
    </> : <>
      <div className="row-title">{experience.title}<span className="muted">· {experience.organization || '未填写组织'}</span></div>
      <p>{experience.description}</p>
      <small>{experience.startDate ?? '日期未填写'} – {experience.endDate ?? '至今'} · {kindLabel(experience.kind)}</small>
      <div className="button-row">
        <button className="btn small secondary" onClick={() => setEditing(true)}><Pencil size={14}/>编辑</button>
        <button className="btn small danger" onClick={() => void remove()}><Trash2 size={14}/>删除</button>
        <button className="btn small secondary" disabled={!bundle.skills.length} onClick={() => setEditing(false)} title="请在右侧技能证据面板添加引用">查看证据面板</button>
      </div>
    </>}
  </article>;
}

async function createExperience(values: Record<string, string>, bundle: EvidenceBundle | null, context: ActionContext) {
  const payload = experiencePayload(values);
  const localId = crypto.randomUUID();
  const saved = await context.run(() => withOfflineQueue(
    () => post('/evidence/experiences', payload),
    { userId: context.userId, entity: 'experience', entityId: localId, baseVersion: 0, action: 'upsert', payload },
    async () => {
      if (!bundle) return;
      const now = new Date().toISOString();
      const local: Experience = {
        ...payload,
        organization: payload.organization ?? '',
        kind: payload.kind ?? 'project',
        id: localId,
        version: 0,
        userId: context.userId,
        deleted: false,
        createdAt: now,
        updatedAt: now,
      };
      await updateEvidenceCache(context.userId, bundle, (current) => ({ ...current, experiences: [local, ...current.experiences] }));
    },
  ), '经历已添加；离线新增已保存到本机队列');
  return saved;
}

function experiencePayload(values: Record<string, string>): components['schemas']['ExperiencePayload'] {
  return {
    title: values.title.trim(),
    organization: values.organization.trim(),
    kind: (values.kind || 'project') as components['schemas']['ExperiencePayload']['kind'],
    startDate: values.startDate || null,
    endDate: values.endDate || null,
    description: values.description.trim(),
  };
}

async function updateEvidenceCache(userId: string, bundle: EvidenceBundle, update: (current: EvidenceBundle) => EvidenceBundle) {
  const key = cacheKey(userId, 'api:/evidence');
  const cached = await readCached<EvidenceBundle>(key) ?? bundle;
  await cacheValue(key, update(cached));
}

function csv(value: string) {
  return value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
}

function stringValue(value: string | number | null | undefined) {
  return value == null ? '' : String(value);
}

function kindLabel(value: string) {
  return EXPERIENCE_KINDS.find((kind) => kind.value === value)?.label ?? value;
}
