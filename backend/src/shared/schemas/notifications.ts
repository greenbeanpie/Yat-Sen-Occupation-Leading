import { z } from "@hono/zod-openapi";
import { IsoDateTimeSchema, UuidSchema } from "./common";

/** 站内提醒（已发送的 reminder 即站内通知；不展示简历/面试反馈正文）。 */
export const NotificationSchema = z
  .object({
    id: UuidSchema,
    kind: z.string(),
    title: z.string(),
    body: z.string(),
    entity: z.string(),
    entityId: UuidSchema,
    fireAt: IsoDateTimeSchema,
    sentAt: IsoDateTimeSchema,
    readAt: IsoDateTimeSchema.nullish(),
  })
  .openapi("Notification");

export const NotificationListResponseSchema = z
  .object({ items: z.array(NotificationSchema), unreadCount: z.number().int() })
  .openapi("NotificationListResponse");

export const PushSubscriptionPayloadSchema = z
  .object({
    endpoint: z.string().url().max(1000),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  })
  .openapi("PushSubscriptionPayload");

export const PushSubscriptionSchema = z
  .object({
    id: UuidSchema,
    endpoint: z.string(),
    status: z.enum(["active", "expired"]),
    createdAt: IsoDateTimeSchema,
  })
  .openapi("PushSubscription");

export const VapidPublicKeySchema = z
  .object({ publicKey: z.string() })
  .openapi("VapidPublicKey");

export const ReminderSettingsSchema = z
  .object({
    notifyTaskDue: z.boolean().optional(),
    notifyInterview: z.boolean().optional(),
    timezone: z.string().max(60).optional(),
  })
  .openapi("ReminderSettings");
