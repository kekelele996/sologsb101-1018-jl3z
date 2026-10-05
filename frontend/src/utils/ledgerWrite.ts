/**
 * 分摊留底的本地台账写入：镶嵌工位与髹涂工序台各写各的表。
 * 写入失败时只重试当前这一份（同一张表），不触碰、不回滚另一摊的留底。
 *
 * 纯前端单库：两摊本来就是两张独立的表，这里再用「单表事务 + 有限次重试」
 * 把「只退自己那份」的边界固定下来，调用方不要把两张表塞进同一个事务。
 */
import type { Table } from 'dexie';

export interface LedgerWriteOptions {
  /** 重试次数（不含首次执行），默认 2 */
  retries?: number;
  /** 每次重试前的退避（毫秒），默认 120ms */
  backoffMs?: number;
  /** 台账名，用于错误文案 */
  ledgerName?: string;
}

export interface LedgerWriteResult<T> {
  ok: boolean;
  /** 实际执行次数（首次 + 重试） */
  attempts: number;
  value?: T;
  error?: string;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 在单张表的事务里执行一次写入并带有限重试。
 * 注意：op 只能操作传入的这一张表（自己那份），不要在里面写另一摊的表。
 */
export async function writeOwnLedger<T>(
  table: Table,
  op: (txTable: Table) => Promise<T>,
  options: LedgerWriteOptions = {},
): Promise<LedgerWriteResult<T>> {
  const { retries = 2, backoffMs = 120, ledgerName = '本地台账' } = options;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      const value = await table.db.transaction('rw', table, () => op(table));
      return { ok: true, attempts: attempt, value };
    } catch (error) {
      lastError = error;
      if (attempt <= retries) await wait(backoffMs * attempt);
    }
  }

  return {
    ok: false,
    attempts: retries + 1,
    error: `${ledgerName}写入失败（已重试 ${retries} 次，另一摊留底未改动）：${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  };
}
