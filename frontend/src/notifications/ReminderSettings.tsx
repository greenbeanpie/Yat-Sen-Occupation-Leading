import { useEffect,useState } from 'react';
import { put,post } from '../api/client';
import type { components } from '../api/schema';
import { Badge,DataRows,Loading,Panel,ResourceNotice,useResource,type ActionContext } from '../components';
import { useSettingsDirty } from '../pages/settings-dirty';
export function ReminderSettings({context}:{context:ActionContext}) {
 const settings=useResource<components['schemas']['UserSettingsResponse']>('/notifications/settings',context.refresh,context.userId);
 const [timezone,setTimezone]=useState('');const [task,setTask]=useState<boolean|null>(null);const [interview,setInterview]=useState<boolean|null>(null);
 useEffect(()=>{if(settings.data){setTimezone(settings.data.timezone);setTask(settings.data.notifyTaskDue);setInterview(settings.data.notifyInterview);}},[settings.data]);
 useSettingsDirty(Boolean(settings.data && (timezone!==settings.data.timezone || task!==settings.data.notifyTaskDue || interview!==settings.data.notifyInterview)));
 return <Panel title="任务与面试提醒" description="保留原有任务到期和面试前提醒；投递方式在下方单独设置"><ResourceNotice error={settings.error}/>{settings.loading&&!settings.data&&<Loading/>}
  <label className="field"><span>用户时区</span><input value={timezone} onChange={event=>setTimezone(event.target.value)} placeholder="Asia/Shanghai"/></label>
  <label className="check-row"><input type="checkbox" checked={task??false} onChange={event=>setTask(event.target.checked)}/><span>任务到期提醒</span></label>
  <label className="check-row"><input type="checkbox" checked={interview??false} onChange={event=>setInterview(event.target.checked)}/><span>面试前提醒</span></label>
  <button className="btn primary" disabled={context.busy||task===null||interview===null} onClick={()=>void context.run(()=>put('/notifications/settings',{timezone:timezone.trim()||'Asia/Shanghai',notifyTaskDue:task,notifyInterview:interview}),'提醒设置已保存')}>保存提醒设置</button>
 </Panel>;
}

export function DemoReminderHistory({context}:{context:ActionContext}) {
 const notices=useResource<components['schemas']['NotificationListResponse']>('/notifications',context.refresh,context.userId);
 return <Panel title="演示提醒历史" description={`${notices.data?.unreadCount??0} 条未读；仅属于当前演示身份`}><ResourceNotice error={notices.error}/><DataRows items={notices.data?.items??[]} loading={notices.loading} empty="暂无演示提醒">{item=><article className="notification-row"><div className="row-title">{item.title}<Badge value={item.readAt?'已读':'未读'}/></div><p>{item.body}</p>{!item.readAt&&<button className="btn small secondary" onClick={()=>void context.run(()=>post(`/notifications/${item.id}/read`),'提醒已标记为已读')}>标记已读</button>}</article>}</DataRows></Panel>;
}
