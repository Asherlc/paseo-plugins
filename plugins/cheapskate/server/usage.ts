import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ProviderUsage } from "@getpaseo/plugin/server/provider";
import type { z } from "zod";
import type { usageSummary } from "../shared/usage";

export type UsageEntry = {
  providerId: string;
  modelId: string;
  usage?: ProviderUsage;
};

export type UsageRow = z.output<typeof usageSummary.output>["rows"][number];

export type UsageStore = {
  record(entry: UsageEntry): void;
  summary(): { rows: UsageRow[] };
  close(): void;
};

const add = (column: string) =>
  `COALESCE(usage_totals.${column} + excluded.${column}, usage_totals.${column}, excluded.${column})`;

/** All-time token totals for completed answering turns, stored beside the host's chat checkpoints. */
export function createUsageStore(): UsageStore {
  let database: DatabaseSync | undefined;

  function open() {
    if (database) return database;
    const sqlite = process.getBuiltinModule?.("node:sqlite") as typeof import("node:sqlite") | undefined;
    if (!sqlite?.DatabaseSync) {
      throw new Error("Token usage needs a Paseo runtime with node:sqlite. Update the daemon to record usage.");
    }
    const root = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "cheapskate");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = join(root, "usage.sqlite");
    const created = openSync(file, "a", 0o600);
    closeSync(created);
    chmodSync(file, 0o600);
    const db = new sqlite.DatabaseSync(file);
    try {
      db.exec(`PRAGMA busy_timeout = 2000;
        CREATE TABLE IF NOT EXISTS usage_totals (
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          input_tokens INTEGER,
          cached_input_tokens INTEGER,
          output_tokens INTEGER,
          completed_turns INTEGER NOT NULL,
          incomplete_turns INTEGER NOT NULL,
          PRIMARY KEY (provider_id, model_id)
        )`);
    } catch (error) {
      db.close();
      throw error;
    }
    database = db;
    return db;
  }

  return {
    record({ providerId, modelId, usage }) {
      const token = (value: number | undefined) =>
        typeof value === "number" && Number.isFinite(value) ? value : null;
      const inputTokens = token(usage?.inputTokens);
      const cachedInputTokens = token(usage?.cachedInputTokens);
      const outputTokens = token(usage?.outputTokens);
      // Cache and cost alone are not token coverage; only input and output decide it.
      const incomplete = inputTokens === null || outputTokens === null ? 1 : 0;
      open().prepare(`INSERT INTO usage_totals
        (provider_id, model_id, input_tokens, cached_input_tokens, output_tokens, completed_turns, incomplete_turns)
        VALUES (?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(provider_id, model_id) DO UPDATE SET
          input_tokens = ${add("input_tokens")},
          cached_input_tokens = ${add("cached_input_tokens")},
          output_tokens = ${add("output_tokens")},
          completed_turns = usage_totals.completed_turns + 1,
          incomplete_turns = usage_totals.incomplete_turns + excluded.incomplete_turns`)
        .run(providerId, modelId, inputTokens, cachedInputTokens, outputTokens, incomplete);
    },
    summary() {
      const rows = open().prepare(`SELECT provider_id, model_id, input_tokens, cached_input_tokens,
        output_tokens, completed_turns, incomplete_turns
        FROM usage_totals ORDER BY provider_id, model_id`).all();
      return {
        rows: rows.map((row) => ({
          providerId: String(row.provider_id),
          modelId: String(row.model_id),
          inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
          cachedInputTokens: row.cached_input_tokens === null ? null : Number(row.cached_input_tokens),
          outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
          completedTurns: Number(row.completed_turns),
          incompleteTurns: Number(row.incomplete_turns),
        })),
      };
    },
    close() {
      database?.close();
      database = undefined;
    },
  };
}
