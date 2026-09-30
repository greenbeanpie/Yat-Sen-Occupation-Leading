-- 0002: 真实账号凭据（PLAN.md 2.1 注册/登录）。演示身份保留 userId 直登，is_demo 用于会话标注。
ALTER TABLE users ADD COLUMN username TEXT;
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;

-- 用户名全局唯一（可空：演示身份无用户名）。
CREATE UNIQUE INDEX idx_users_username ON users (username) WHERE username IS NOT NULL;

-- 迁移时存量用户全部是演示身份。
UPDATE users SET is_demo = 1;
