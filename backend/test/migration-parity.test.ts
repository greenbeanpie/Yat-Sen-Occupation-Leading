import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { MIGRATION_0001 } from "../src/infra/db/schema";

describe("历史增量迁移与当前 schema 一致", () => {
  it("0001+0002+0003 得到相同表、列、索引，并保留旧用户", () => {
    const migrated = new DatabaseSync(":memory:"); const current = new DatabaseSync(":memory:");
    const dir = resolve("migrations"); const files = readdirSync(dir).filter(name => name.endsWith(".sql")).sort();
    migrated.exec(readFileSync(resolve(dir, files[0]!), "utf8"));
    migrated.exec("INSERT INTO users (id,role,display_name,created_at,updated_at) VALUES ('existing','student','Existing','2026','2026')");
    for (const file of files.slice(1)) migrated.exec(readFileSync(resolve(dir, file), "utf8"));
    current.exec(MIGRATION_0001);
    const schema = (db: DatabaseSync) => db.prepare("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => ({ ...row, columns: row.type === "table" ? db.prepare(`PRAGMA table_info(${row.name})`).all().map(column => ({ name: column.name, type: column.type, notnull: column.notnull, pk: column.pk })).sort((a,b)=>String(a.name).localeCompare(String(b.name))) : [] }));
    expect(schema(migrated)).toEqual(schema(current)); expect(migrated.prepare("SELECT display_name FROM users WHERE id='existing'").get()).toMatchObject({ display_name: "Existing" });
    migrated.close(); current.close();
  });
});

// Fail closed before changing legacy accounts or their credentials.
describe("canonical username migration conflicts", () => {
  it("aborts on legacy case collisions without merging accounts", () => {
    const database = new DatabaseSync(":memory:");
    for (const file of readdirSync(resolve("migrations")).filter(file => file.endsWith(".sql") && file < "0004").sort()) database.exec(readFileSync(resolve("migrations", file), "utf8"));
    database.exec("INSERT INTO users (id,role,display_name,username,password_hash,created_at,updated_at) VALUES ('one','student','One','Alice','hash-one','2026','2026'),('two','student','Two','alice','hash-two','2026','2026')");
    expect(() => database.exec(readFileSync(resolve("migrations/0004_invitation_registration.sql"), "utf8"))).toThrow();
    expect(database.prepare("SELECT id,password_hash FROM users ORDER BY id").all()).toEqual([{ id: "one", password_hash: "hash-one" }, { id: "two", password_hash: "hash-two" }]);
    database.close();
  });
});
