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

export const UsernameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{3,32}$/, "3-32 位字母、数字、下划线或连字符")
  .openapi("Username");

export const RegisterRequestSchema = z
  .object({
    username: UsernameSchema,
    invitationCode: z.string().regex(/^[A-Za-z0-9_-]{16}$/, "邀请码格式不正确"),
    email: z.string().trim().email().max(254).optional(),
    password: z.string().min(8, "至少 8 位").max(128),
    displayName: z.string().min(1).max(64).optional(),
  })
  .openapi("RegisterRequest");

export const CredentialLoginRequestSchema = z
  .object({ username: z.string().min(1).max(64), password: z.string().min(1).max(128) })
  .openapi("CredentialLoginRequest");

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
