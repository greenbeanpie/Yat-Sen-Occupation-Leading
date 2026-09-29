import { z } from "@hono/zod-openapi";
import { UuidSchema, IsoDateTimeSchema } from "./common";

export const DemoUserSchema = z
  .object({ id: UuidSchema, role: z.enum(["student", "admin"]), displayName: z.string() })
  .openapi("DemoUser");

export const SessionResponseSchema = z
  .object({
    authenticated: z.boolean(),
    user: z
      .object({
        id: UuidSchema,
        role: z.enum(["student", "admin"]),
        displayName: z.string(),
        timezone: z.string(),
        demo: z.boolean(),
      })
      .nullish(),
    demoUsers: z.array(DemoUserSchema).nullish(),
    capabilities: z
      .object({
        push: z.boolean(),
        offline: z.boolean(),
        demoMode: z.boolean(),
      })
      .nullish(),
  })
  .openapi("SessionResponse");

export const LoginRequestSchema = z
  .object({ userId: UuidSchema })
  .openapi("LoginRequest");

export const UserSettingsSchema = z
  .object({
    timezone: z.string().optional(),
    notifyTaskDue: z.boolean().optional(),
    notifyInterview: z.boolean().optional(),
  })
  .openapi("UserSettings");

export const UserSettingsResponseSchema = z
  .object({
    timezone: z.string(),
    notifyTaskDue: z.boolean(),
    notifyInterview: z.boolean(),
    updatedAt: IsoDateTimeSchema,
  })
  .openapi("UserSettingsResponse");
