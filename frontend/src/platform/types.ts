/**
 * 平台能力接口。PLAN.md 第 4 节要求把文件选择、通知、网络状态和本地存储
 * 与界面隔离：浏览器实现见 browser.ts，后续 Tauri 客户端只需提供同形状实现。
 */

export interface FilePickerOptions {
  /** 与 input[accept] 相同的取值，例如 ".pdf,.docx" */
  accept: string;
}

export interface PlatformFilePicker {
  /** 打开系统文件选择器；用户取消时返回 null。 */
  pickFile(options: FilePickerOptions): Promise<File | null>;
}

export type NotificationPermissionState = 'unsupported' | 'default' | 'granted' | 'denied';

export interface PlatformNotifications {
  /** 当前环境是否具备通知能力；不支持时界面保留站内提醒。 */
  permission(): NotificationPermissionState;
  /** 只有用户主动触发订阅时才调用。 */
  requestPermission(): Promise<NotificationPermissionState>;
}

export interface PlatformNetwork {
  isOnline(): boolean;
  /** 返回取消订阅函数。 */
  subscribe(listener: (online: boolean) => void): () => void;
}

export interface PlatformStorage {
  read<T>(key: string): Promise<T | undefined>;
  write(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface WorkbenchPlatform {
  readonly kind: 'browser' | 'tauri';
  readonly files: PlatformFilePicker;
  readonly notifications: PlatformNotifications;
  readonly network: PlatformNetwork;
  readonly storage: PlatformStorage;
}
