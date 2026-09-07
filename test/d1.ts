import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

/** Run the production migrations and SQL, including atomic D1 batches, against SQLite. */
export function sqliteDatabase(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  }
  function prepare(sql: string, values: unknown[] = []): D1PreparedStatement {
    const run = () => {
      const ordered: (string | number | null)[] = [];
      const query = sql.replace(/\?(\d+)/gu, (_, index) => {
        ordered.push(values[Number(index) - 1] as string | number | null);
        return "?";
      });
      return sqlite.prepare(query).all(...ordered);
    };
    return {
      executeSync: run,
      bind: (...bound: unknown[]) => prepare(sql, bound),
      first: async (column?: string) => {
        const row = run()[0];
        return row ? (column ? row[column] : row) : null;
      },
      all: async () => ({ results: run(), success: true, meta: {} }),
      run: async () => ({ results: run(), success: true, meta: {} }),
    } as unknown as D1PreparedStatement;
  }
  return {
    prepare,
    batch: async (statements: D1PreparedStatement[]) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push({ success: true, results: (statement as unknown as { executeSync: () => unknown }).executeSync(), meta: {} });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}
