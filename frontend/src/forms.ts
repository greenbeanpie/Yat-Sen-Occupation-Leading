export interface FieldSpec {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  options?: { value: string; label: string }[];
  initialValue?: string;
  min?: string;
  max?: string;
  step?: string;
  rows?: number;
}

/**
 * 表单初始值。下拉框即使没有匹配的选项也会显示第一项，所以状态必须同步取第一项的值，
 * 否则界面显示“选项 A”，提交的却是空串。
 */
export function initialFormValues(fields: FieldSpec[]): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [
    field.name,
    field.initialValue ?? field.options?.[0]?.value ?? '',
  ]));
}
