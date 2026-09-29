/** 统一错误：code 可被前端识别，details 定位到字段。 */
export type ErrorDetail = { field: string; issue: string };

export class AppError extends Error {
  status: number;
  code: string;
  details?: ErrorDetail[];
  /** 409 冲突时携带服务器当前记录 */
  server?: unknown;

  constructor(status: number, code: string, message: string, details?: ErrorDetail[], server?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.server = server;
  }
}

export const unauthorized = (message = "未登录或会话已过期") => new AppError(401, "unauthorized", message);
export const forbidden = (message = "没有执行该操作的权限") => new AppError(403, "forbidden", message);
export const notFound = (message = "资源不存在") => new AppError(404, "not_found", message);
export const invalidRequest = (details: ErrorDetail[], message = "请求参数有误") =>
  new AppError(422, "invalid_request", message, details);
export const conflict = (message: string, server: unknown) =>
  new AppError(409, "version_conflict", message, undefined, server);
export const syncRequired = (message: string) => new AppError(409, "sync_required", message);
export const unprocessableFile = (message: string) => new AppError(422, "unprocessable_file", message);
export const operationFailed = (message: string) => new AppError(500, "operation_failed", message);
export const quoteRejected = (message: string) => new AppError(422, "quote_rejected", message);
export const notImplemented = () => new AppError(501, "not_implemented", "该端点尚未实现");

export function errorBody(err: AppError) {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
      ...(err.server !== undefined ? { server: err.server } : {}),
    },
  };
}
