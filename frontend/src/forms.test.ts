import { describe, expect, it } from 'vitest';
import { initialFormValues, type FieldSpec } from './forms';

describe('表单初始值', () => {
  it('下拉框没有显式初始值时取第一个选项，避免显示第一项却提交空串', () => {
    const fields: FieldSpec[] = [
      { name: 'portfolioId', label: '选择求职组合', required: true, options: [
        { value: 'portfolio-a', label: '8 小时 · 2 个岗位' },
        { value: 'portfolio-b', label: '6 小时 · 1 个岗位' },
      ] },
    ];
    expect(initialFormValues(fields)).toEqual({ portfolioId: 'portfolio-a' });
  });

  it('显式初始值优先，且可用于表达“未设置”', () => {
    const fields: FieldSpec[] = [
      { name: 'degree', label: '学历', options: [
        { value: '', label: '未设置' },
        { value: 'bachelor', label: '本科' },
      ], initialValue: 'bachelor' },
      { name: 'location', label: '期望地点', options: [{ value: '', label: '不限' }] },
    ];
    expect(initialFormValues(fields)).toEqual({ degree: 'bachelor', location: '' });
  });

  it('普通输入框默认空串，数字约束原样保留给浏览器校验', () => {
    const fields: FieldSpec[] = [
      { name: 'weeklyTimeBudgetHours', label: '每周求职时间（小时）', type: 'number', min: '0.5', max: '80', step: '0.5' },
    ];
    expect(initialFormValues(fields)).toEqual({ weeklyTimeBudgetHours: '' });
    expect(fields[0]).toMatchObject({ min: '0.5', step: '0.5' });
  });
});
